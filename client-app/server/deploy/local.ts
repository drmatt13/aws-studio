import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import { readProjectCompose } from "aws-studio/compose-services";
import { setTimeout as delay } from "node:timers/promises";
import type { DockerView, JobView, LocalRunView, ManagedProcessView, ServiceView } from "../../shared/deploy";
import type { Runner, Tools } from "./process";
import { readLocalClientUrl } from "aws-studio/cli/local-client.mts";
import { LocalDatabaseReadiness } from "./database-readiness";
import { assertComposeContainerOwnership, composeProjectName as effectiveComposeProjectName, parseComposeOwnershipLabels } from "aws-studio/cli/compose-project-ownership.mjs";
import { writeDeploymentRecordAtomic } from "aws-studio/cli/deployment-artifact";
import { EvaluatorPool } from "../evaluator/pool";
import { hashEditableFiles, sha256 } from "../files";

/**
 * Local development, as Docker records it: the Compose project's containers by
 * label (which needs no root .env, unlike `compose ps`), what the exported files
 * on this machine point at, and whether Studio started the stack.
 *
 * Containers and their support processes belong to the checkout. Studio
 * observes their existing owner rather than making browser state authoritative.
 */

interface RunRecord {
  readonly profile: string;
  readonly deployment: string;
  readonly account?: string;
  readonly region?: string;
  readonly startedAt: string;
  /** Compose project captured before compute starts; absent in legacy records. */
  readonly project?: string;
  /** Durable user intent: recovery must never undo an accepted stop. */
  readonly stopped?: boolean;
}

/** Safe, actionable lifecycle refusal; no private CLI output is attached. */
export class LocalRuntimeConflict extends Error {
  readonly status = 409;
  constructor(message: string, readonly ownership = false) { super(message); }
}

const isActiveContainerState = (state: string) => ["running", "restarting", "paused", "removing"].includes(state);

/**
 * Database-tier services. Their restart policies (`restart: unless-stopped`) make Docker bring
 * them back on its own after an engine restart, so their being up says nothing about whether a
 * local runtime session exists. Only application compute (API/WebSocket servers, the invocation
 * runner, framework services, runner work) is a session; stopping the runtime still stops these.
 */
const INFRASTRUCTURE_SERVICES: ReadonlySet<string> = new Set(["postgres", "pgadmin", "prisma-verify"]);
export const isInfrastructureService = (name: string | undefined): boolean => name !== undefined && INFRASTRUCTURE_SERVICES.has(name);

/** A detached worker must not forget watch/client jobs still owned by the Studio host. */
export function persistedLocalHolder(stateDirectory: string, lock: string): JobView | undefined {
  const kinds = lock === "local" ? ["local-start", "local-stop", "local-restart", "local-attach-watch"]
    : lock === "local-watch" || lock === "local-client" ? [lock] : [];
  if (!kinds.length) return undefined;
  const directory = path.join(stateDirectory, "jobs");
  if (!existsSync(directory)) return undefined;
  for (const file of readdirSync(directory).filter(file => file.endsWith(".json"))) {
    let value: { id?: unknown; kind?: unknown; status?: unknown };
    try { value = JSON.parse(readFileSync(path.join(directory, file), "utf8")); } catch { throw new LocalRuntimeConflict("Local operation evidence is unreadable. Open Studio and check local runtime before changing development resources."); }
    if (value.status === "running" && typeof value.kind === "string" && kinds.includes(value.kind) && typeof value.id === "string")
      return { id: value.id, kind: value.kind as JobView["kind"], status: "running", title: "Local runtime", params: {}, startedAt: "", lastSeq: 0 };
  }
  return undefined;
}

/** As packages/aws-studio/src/local/paths.ts names the Compose project. */
export function composeProjectName(root: string, env: NodeJS.ProcessEnv): string {
  return effectiveComposeProjectName(root, env);
}

/** Services something else waits on to finish: migrations, seeds. Exited 0 is their success. */
function oneShotServices(root: string): Set<string> {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner && typeof inner === "object" && (inner as { condition?: unknown }).condition === "service_completed_successfully") found.add(key);
      visit(inner);
    }
  };
  try { visit(readProjectCompose(root)); } catch { /* Compose reports its own source errors. */ }
  const generated = path.join(root, "docker-compose.services.yml");
  if (existsSync(generated)) {
    try { visit(parseYaml(readFileSync(generated, "utf8"), { merge: true, maxAliasCount: -1 })); } catch { /* Compose reports its own file's errors. */ }
  }
  return found;
}

interface PsLine { ID: string; Names: string; State: string; Status: string; Ports?: string; Labels?: string }

function labels(text: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) result[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return result;
}

function parseServices(output: string, oneShots: ReadonlySet<string>): (ServiceView & { readonly id: string })[] {
  const services: (ServiceView & { id: string })[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: PsLine;
    try { line = JSON.parse(raw) as PsLine; } catch { continue; }
    const tags = labels(line.Labels);
    const name = tags["com.docker.compose.service"] ?? line.Names;
    const health = /\(healthy\)/.test(line.Status) ? "healthy" : /\(unhealthy\)/.test(line.Status) ? "unhealthy" : /health: starting/.test(line.Status) ? "starting" : undefined;
    const exit = /Exited \((-?\d+)\)/.exec(line.Status);
    services.push({
      id: line.ID, name, container: line.Names, containerId: line.ID, state: line.State, oneShot: oneShots.has(name), ports: line.Ports ?? "",
      ...(health ? { health } : {}),
      ...(exit ? { exitCode: Number(exit[1]) } : {}),
    });
  }
  return services.sort((a, b) => Number(a.oneShot) - Number(b.oneShot) || a.name.localeCompare(b.name));
}

export class LocalEnvironment {
  /** Export can change the per-developer project; never retain the old name. */
  get configuredProject(): string { return effectiveComposeProjectName(this.root, this.env, this.exportDirectory); }
  get project(): string { return this.runRecord()?.project ?? this.configuredProject; }
  private readonly recordFile: string;
  private readonly databaseReadiness: LocalDatabaseReadiness;
  private disabled?: { readonly revision: string; readonly promise: Promise<ReadonlySet<string>> };

  constructor(
    private readonly root: string,
    private readonly tools: Tools,
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
    /** Where export writes the root .env and resources (the repository root, unless a test says otherwise). */
    readonly exportDirectory: string,
    private readonly stateDirectory: string,
    private readonly disabledServices?: () => ReadonlySet<string>,
    /** Only the checkout runtime owner may repair shared capture metadata. */
    private readonly canRepairProject = false,
  ) {
    this.recordFile = path.join(stateDirectory, "local", "run.json");
    this.databaseReadiness = new LocalDatabaseReadiness(root, tools, run, env);
  }

  runRecord(): RunRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(this.recordFile, "utf8"));
      if (!value || typeof value.profile !== "string" || typeof value.deployment !== "string" || typeof value.startedAt !== "string") return undefined;
      return { profile: value.profile, deployment: value.deployment, startedAt: value.startedAt,
        ...(typeof value.project === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value.project) ? { project: value.project } : {}),
        ...(typeof value.account === "string" ? { account: value.account } : {}),
        ...(typeof value.region === "string" ? { region: value.region } : {}),
        ...(value.stopped === true ? { stopped: true } : {}) };
    } catch { return undefined; }
  }

  writeRunRecord(record: RunRecord): void {
    mkdirSync(path.dirname(this.recordFile), { recursive: true });
    const canonicalFile = path.join(realpathSync(path.dirname(this.recordFile)), path.basename(this.recordFile));
    writeDeploymentRecordAtomic(canonicalFile, { ...record, project: record.project ?? this.configuredProject });
  }

  markStopped(): void {
    const record = this.runRecord();
    if (record?.stopped) return;
    this.writeRunRecord({ ...(record ?? { profile: "", deployment: "", startedAt: new Date().toISOString() }), stopped: true });
  }

  clearRunRecord(): void {
    rmSync(this.recordFile, { force: true });
  }

  exported(): LocalRunView["exported"] & { readonly at?: number } {
    const file = path.join(this.exportDirectory, ".env");
    const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
    return {
      ...(values.LOCAL_FRAMEWORK_DEPLOYMENT ? { deployment: values.LOCAL_FRAMEWORK_DEPLOYMENT } : {}),
      ...(values.LOCAL_FRAMEWORK_ACCOUNT ? { account: values.LOCAL_FRAMEWORK_ACCOUNT } : {}),
      ...(values.LOCAL_AWS_REGION ? { region: values.LOCAL_AWS_REGION } : {}),
      client: existsSync(path.join(this.exportDirectory, "client-app", ".env.development.local")),
      ...(existsSync(file) ? { at: statSync(file).mtimeMs } : {}),
    };
  }

  /** The origin the web client serves, from the development inputs. */
  appUrl(): string {
    return readLocalClientUrl(this.root, this.env).origin;
  }

  private settingsProblem(): string | undefined {
    const record = this.runRecord();
    const exported = this.exported();
    return record?.deployment && (record.deployment !== exported.deployment || record.account !== undefined && record.account !== exported.account || record.region !== undefined && record.region !== exported.region)
      ? "Local settings differ from the running runtime's captured destination. Restore those settings before reconnecting; existing containers and data are preserved." : undefined;
  }

  /** Compute can survive a checkout losing its ignored exports (a reclone); it cannot be reconnected without them. */
  setupProblem(): string | undefined {
    return [".env", ".framework/local/resources.json", "client-app/.env.development.local"].some(file => !existsSync(path.join(this.exportDirectory, file)))
      ? "This checkout needs local development settings. Stop local runtime, then start it again to generate settings from your Development deployment. Existing database data is preserved."
      : undefined;
  }

  /** Only an intentionally disabled framework launcher may count as exited successfully. */
  private async disabledServiceIds(services: readonly ServiceView[] = []): Promise<ReadonlySet<string>> {
    if (this.disabledServices) return this.disabledServices();
    const generated = path.join(this.root, "docker-compose.services.yml");
    if (!existsSync(generated) || !services.some(service => !service.oneShot && service.state === "exited" && service.exitCode === 0)) return new Set();
    let declarations: { services?: Record<string, { command?: unknown }> };
    try { declarations = parseYaml(readFileSync(generated, "utf8")); } catch { return new Set(); }
    const launchers = new Set(Object.entries(declarations?.services ?? {}).filter(([, value]) => Array.isArray(value.command)
      && value.command.includes("node_modules/aws-studio/scripts/run-service.ts")).map(([name]) => name));
    if (!services.some(service => launchers.has(service.name) && service.state === "exited" && service.exitCode === 0)) return new Set();
    const inputs = this.env.FRAMEWORK_INPUTS_FILE ?? path.join(this.root, "cdk-app", ".env.dev");
    const revision = () => sha256(JSON.stringify([hashEditableFiles(this.root), existsSync(inputs) ? sha256(readFileSync(inputs, "utf8")) : ""]));
    const current = revision();
    if (this.disabled?.revision === current) return this.disabled.promise;
    const promise = (async () => {
      const pool = new EvaluatorPool(this.root);
      try {
        const model = (await pool.evaluate()).dev;
        if (model.status !== "ok" || model.stale || revision() !== current) return new Set<string>();
        return new Set(model.targets.filter(target => target.kind === "service" && !target.lanes.local).map(target => target.id));
      } catch { return new Set<string>(); }
      finally { await pool.dispose(); }
    })();
    this.disabled = { revision: current, promise };
    return promise;
  }

  async services(): Promise<(ServiceView & { readonly id: string })[]> {
    const project = this.project;
    const listed = await this.run(this.tools.docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{json .}}"], this.env), { timeoutMs: 15_000 });
    if (listed.code !== 0) throw new Error("Could not read this checkout's local containers. Check Docker and try again.");
    const services = parseServices(listed.stdout, oneShotServices(this.root));
    await this.assertComposeOwnership(services.map(service => service.id), project);
    const disabled = await this.disabledServiceIds(services);
    return services.map(service =>
      disabled.has(service.name) && service.state === "exited" && service.exitCode === 0 ? { ...service, disabledByDeploy: true as const } : service);
  }

  /** Every active container in this checkout, including paused/partial runner work and database infrastructure. What a stop acts on. */
  async activeContainers(compose?: readonly (ServiceView & { readonly id: string })[], scope: "all" | "compute" = "all"): Promise<{ readonly id: string; readonly state: string }[]> {
    if (compose === undefined) await this.discoverProject({ watch: { running: false }, client: { running: false } });
    const project = this.project;
    const active = new Map<string, { id: string; state: string }>();
    const counted = (service: string | undefined) => scope === "all" || !isInfrastructureService(service);
    for (const label of [`com.docker.compose.project=${project}`, `com.matts-aws-framework.project=${project}`]) {
      if (compose && label.startsWith("com.docker.compose.project=")) {
        await this.assertComposeOwnership(compose.map(service => service.id), project);
        for (const service of compose) if (isActiveContainerState(service.state) && counted(service.name)) active.set(service.id, { id: service.id, state: service.state });
        continue;
      }
      const listed = await this.run(this.tools.docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{json .}}"], this.env), { timeoutMs: 15_000 });
      if (listed.code !== 0) throw new LocalRuntimeConflict("Could not inspect this checkout's local containers. Check Docker before changing development resources.");
      const composeIds: string[] = [];
      for (const line of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        let container: { ID?: unknown; State?: unknown; Labels?: unknown };
        try { container = JSON.parse(line); } catch { throw new LocalRuntimeConflict("Local container status is unreadable. Check Docker before changing development resources."); }
        if (typeof container.ID !== "string" || typeof container.State !== "string" || !["created", "running", "restarting", "paused", "removing", "exited", "dead"].includes(container.State)) throw new LocalRuntimeConflict("Local container status is unavailable. Check Docker before changing development resources.");
        if (isActiveContainerState(container.State) && counted(labels(typeof container.Labels === "string" ? container.Labels : undefined)["com.docker.compose.service"])) active.set(container.ID, { id: container.ID, state: container.State });
        if (label.startsWith("com.docker.compose.project=")) composeIds.push(container.ID);
      }
      if (label.startsWith("com.docker.compose.project=")) await this.assertComposeOwnership(composeIds, project);
    }
    if (this.project !== project) throw new LocalRuntimeConflict("The local Compose project changed during observation. Refresh local runtime before acting on containers.");
    return [...active.values()];
  }

  /** Active application compute only: the measure of whether a runtime session exists. */
  activeCompute(compose?: readonly (ServiceView & { readonly id: string })[]): Promise<{ readonly id: string; readonly state: string }[]> {
    return this.activeContainers(compose, "compute");
  }

  /** Refuse same-name containers started from another checkout, even if stopped. */
  private async assertComposeOwnership(ids: readonly string[], project: string, checkCurrent = true): Promise<void> {
    if (ids.length) {
      const observed = await this.run(this.tools.docker(["inspect", "--format", "{{json .Config.Labels}}", ...ids], this.env), { timeoutMs: 15_000 });
      if (observed.code !== 0) throw new LocalRuntimeConflict("Local Compose container ownership could not be verified. Check Docker before using local runtime.");
      const metadata = parseComposeOwnershipLabels(observed.stdout, ids.length);
      try { assertComposeContainerOwnership(this.root, project, metadata); }
      catch (error) {
        const identified = metadata.every(labels => ["com.docker.compose.project", "com.docker.compose.project.working_dir", "com.docker.compose.project.config_files"]
          .every(key => typeof labels[key] === "string" && labels[key].trim().length > 0));
        throw new LocalRuntimeConflict(error instanceof Error ? error.message : "Local Compose ownership could not be verified.", identified);
      }
    }
    if (checkCurrent && this.project !== project) throw new LocalRuntimeConflict("The local Compose project changed during observation. Refresh local runtime before acting on containers.");
  }

  /** Consider the configured project only after proving a stale capture has no active work. */
  private async discoverProject(managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }): Promise<void> {
    const record = this.runRecord();
    const candidate = this.configuredProject;
    if (!record?.project || record.project === candidate || managed.watch.running || managed.client.running) return;
    const activeHolder = () => ["local", "local-watch", "local-client"].some(lock => persistedLocalHolder(this.stateDirectory, lock));
    if (activeHolder()) return;
    const captured = await this.services();
    if ((await this.activeCompute(captured)).length) return;
    const listed = await this.run(this.tools.docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${candidate}`, "--format", "{{json .}}"], this.env), { timeoutMs: 15_000 });
    if (listed.code !== 0) throw new LocalRuntimeConflict("Could not inspect the configured local Compose project. Check Docker and try again.");
    const services = parseServices(listed.stdout, oneShotServices(this.root));
    await this.assertComposeOwnership(services.map(service => service.id), candidate, false);
    if (!services.some(service => isActiveContainerState(service.state) && !isInfrastructureService(service.name))) return;
    if (activeHolder() || this.configuredProject !== candidate || JSON.stringify(this.runRecord()) !== JSON.stringify(record)) return;
    if (record.stopped) throw new LocalRuntimeConflict("Local runtime was intentionally stopped, but the newly configured checkout project has active containers. Inspect those containers before changing development resources; automatic recovery remains stopped.");
    if (!this.canRepairProject) throw new LocalRuntimeConflict("The configured checkout runtime is active. Wait for its owner to reconnect before changing development resources.");
    // All readers, including fresh operation workers and Studio's log cache,
    // need the same proven checkout identity. Repair the existing capture once,
    // without carrying an unrelated AWS destination into the discovered runtime.
    this.writeRunRecord({ project: candidate, profile: "", deployment: "", startedAt: new Date().toISOString() });
  }

  /** Every active container of this project; stopped/created containers and volumes are kept. */
  async containerIds(): Promise<string[]> {
    let compose: (ServiceView & { readonly id: string })[];
    try { compose = await this.services(); }
    catch (error) {
      if (error instanceof LocalRuntimeConflict) throw error;
      throw new LocalRuntimeConflict("Could not inspect this checkout's local containers. Check Docker before stopping local runtime.");
    }
    const active = await this.activeContainers(compose);
    if (active.length && !compose.length) throw new LocalRuntimeConflict("Runner work is active without Compose checkout provenance. Inspect its exact container IDs in Docker and stop only the work you recognize. Studio will not stop unverified containers by project name.");
    return active.map(container => container.id);
  }

  async assertStopped(docker: DockerView, managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }): Promise<void> {
    if (managed.watch.running || managed.client.running) throw new LocalRuntimeConflict("Stop local runtime before changing development resources.");
    if (docker.engine === "unknown") throw new LocalRuntimeConflict("Local runtime status is unavailable. Check Docker and stop local runtime before changing development resources.");
    if (docker.engine !== "running") return;
    // The switch and this guard share one definition of "on": restart-policy database containers are not a session.
    if ((await this.activeCompute()).length) throw new LocalRuntimeConflict("Stop local runtime before changing development resources.");
  }

  private async startedAt(ids: readonly string[]): Promise<Map<string, number>> {
    const started = new Map<string, number>();
    if (!ids.length) return started;
    const inspected = await this.run(this.tools.docker(["inspect", "--format", "{{.Id}}|{{.State.StartedAt}}", ...ids], this.env), { timeoutMs: 15_000 });
    if (inspected.code !== 0) throw new Error("Could not verify when the local containers started. Check Docker and try again.");
    for (const line of inspected.stdout.split(/\r?\n/)) {
      const [id, time] = line.trim().split("|");
      if (id && time) {
        const match = ids.find((short) => id.startsWith(short));
        if (match) started.set(match, Date.parse(time));
      }
    }
    return started;
  }

  /** Compose resolves generated includes and operator overrides; only names and lifecycle are retained. */
  private async expectedServices(disabled: ReadonlySet<string>): Promise<Map<string, { readonly oneShot: boolean }>> {
    const result = await this.run(this.tools.docker(["compose", "config", "--format", "json"], { ...this.env, COMPOSE_PROFILES: "" }, this.root), { timeoutMs: 15_000 });
    const message = "Could not read the local Compose configuration. Check the exported development settings and Compose files, then try again.";
    if (result.code !== 0) throw new Error(message);
    let configuration: { services?: Record<string, any> };
    try { configuration = JSON.parse(result.stdout); } catch { throw new Error(message); }
    if (!configuration?.services || typeof configuration.services !== "object" || Array.isArray(configuration.services)) throw new Error(message);
    const defaults = Object.entries(configuration.services).filter(([name, service]) => service && typeof service === "object"
      && !(Array.isArray(service.profiles) && service.profiles.length) && service.scale !== 0 && service.deploy?.replicas !== 0 && !disabled.has(name));
    const oneShots = new Set<string>();
    for (const [, service] of defaults) for (const [dependency, requirement] of Object.entries(service.depends_on ?? {})) {
      if (requirement && typeof requirement === "object" && (requirement as { condition?: string }).condition === "service_completed_successfully") oneShots.add(dependency);
    }
    return new Map(defaults.map(([name]) => [name, { oneShot: oneShots.has(name) }]));
  }

  async view(docker: DockerView, managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }): Promise<LocalRunView> {
    const exported = this.exported();
    let observationProblem: string | undefined = docker.engine === "unknown" ? docker.problem ?? "Could not determine whether Docker is running. Check Docker and try again." : undefined;
    let ownershipConflict: string | undefined;
    const failedObservation = (error: unknown) => {
      if (error instanceof LocalRuntimeConflict && error.ownership) ownershipConflict = error.message;
      observationProblem = error instanceof LocalRuntimeConflict ? error.message : "Could not read this checkout's local containers. Check Docker and try again.";
      return [];
    };
    if (docker.engine === "running") await this.discoverProject(managed).catch(failedObservation);
    const services = docker.engine === "running" && !observationProblem ? await this.services().catch(failedObservation) : [];
    const activeContainerCount = docker.engine === "unknown" || observationProblem ? undefined : docker.engine !== "running" ? 0 : await this.activeCompute(services).then(containers => containers.length).catch((error) => {
      observationProblem = error instanceof LocalRuntimeConflict ? error.message : "Could not inspect all of this checkout's local containers. Check Docker and try again.";
      return undefined;
    });
    // A session exists only while application compute does. Support processes and Docker-revived
    // database containers without compute are leftovers of a session that ended (a Docker restart).
    const engaged = Boolean(activeContainerCount);
    const running = engaged ? services.filter((service) => isActiveContainerState(service.state) && !service.oneShot && !isInfrastructureService(service.name)) : [];
    // Application compute started before the latest export may use previous AWS outputs.
    // Database infrastructure can survive an export: Compose reconciles its own settings,
    // and retaining those containers does not make fresh application compute stale.
    const started = engaged && exported.at !== undefined ? await this.startedAt(running.map((service) => service.id)).catch(() => {
      observationProblem = "Could not verify when the local containers started. Check Docker and try again.";
      return new Map<string, number>();
    }) : new Map<string, number>();
    const restartNeeded = running.filter((service) => (started.get(service.id) ?? Infinity) < exported.at! - 1000).map((service) => service.name);
    const record = this.runRecord();
    const settingsProblem = this.settingsProblem();
    const setupProblem = engaged ? this.setupProblem() : undefined;
    const { at: _at, ...files } = exported;
    const blocked = (message: string) => ({ state: "blocked" as const, observedAt: new Date().toISOString(), message });
    let readiness: NonNullable<LocalRunView["readiness"]> = observationProblem ? blocked(observationProblem)
      : this.project !== this.configuredProject ? blocked("App name changed while a development binding is captured. Stop local runtime before starting the newly configured project; the current project's containers and data are preserved.")
      : !engaged ? { state: "stopped", observedAt: new Date().toISOString(), message: "Local services are stopped." }
      : setupProblem ? blocked(setupProblem)
      : settingsProblem ? blocked(settingsProblem)
      : restartNeeded.length ? { ...blocked("Local settings changed after these containers started. Restart local runtime to use the current development outputs."), remedy: "restart" as const }
      : await this.readiness(services, managed);
    // A persisted stop intent forbids automatic reconnection, so waiting for support processes is a stall.
    if (readiness.state === "starting" && record?.stopped) readiness = { ...readiness, progressing: false,
      ...(readiness.waiting === "support" ? { message: "Studio will not reconnect this runtime because it was intentionally stopped. Stop local runtime to clear it, then start it again." } : {}) };
    return {
      project: this.project,
      ...(activeContainerCount !== undefined ? { activeContainerCount } : {}),
      docker,
      services: services.map(({ id: _id, ...service }) => service),
      watch: managed.watch,
      client: managed.client,
      exported: files,
      startedBy: !engaged ? "none" : record?.deployment ? "studio" : "outside",
      ...(record?.profile ? { profile: record.profile } : {}),
      ...(record?.deployment && engaged ? { binding: record } : {}),
      ...(observationProblem ? { observationProblem } : {}),
      ...(ownershipConflict ? { ownershipConflict } : {}),
      ...(engaged ? { appUrl: this.appUrl() } : {}),
      restartNeeded,
      readiness,
    };
  }

  /** Observation, not an inference from a successful process launch. */
  async readiness(services: readonly ServiceView[], managed: { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }, checkClient = true) {
    const disabled = await this.disabledServiceIds(services);
    // The launcher exits successfully when Deploy is off. Keep genuine startup
    // failures visible, even for a currently disabled declaration.
    services = services.filter(service => !(disabled.has(service.name) && service.state === "exited" && service.exitCode === 0));
    const observedAt = new Date().toISOString();
    // `progressing` separates services that are coming up (running, restarting, support processes
    // reconnecting) from a startup that has stalled (missing or never-started services).
    const result = (state: "ready" | "starting" | "blocked" | "stopped", message: string, wait?: { readonly progressing: boolean; readonly waiting: "compute" | "support" }) => ({ state, observedAt, message, ...wait });
    if (!services.some(service => isActiveContainerState(service.state)) && !managed.client.running && !managed.watch.running) return result("stopped", "Local services are stopped.");
    let expected: Map<string, { readonly oneShot: boolean }>;
    try { expected = await this.expectedServices(disabled); }
    catch (error) { return result("blocked", error instanceof Error ? error.message : "Could not read the local Compose configuration."); }
    // Profiled maintenance containers do not establish compute readiness. A
    // disabled declaration's genuine failed launcher remains actionable.
    services = services.filter(service => expected.has(service.name) || disabled.has(service.name))
      .map(service => ({ ...service, oneShot: expected.get(service.name)?.oneShot ?? service.oneShot }));
    const failed = services.filter(service => service.health === "unhealthy" || service.oneShot && service.exitCode !== undefined && service.exitCode !== 0 || !service.oneShot && service.state === "exited");
    if (failed.length) return result("blocked", `Needs attention: ${failed.map(service => service.name).join(", ")}. Open its logs. Startup initializes only proven empty local storage. Inspect existing database issues and review migrations in Database.`);
    const missing = [...expected.keys()].filter(name => !services.some(service => service.name === name));
    if (missing.length) return result("starting", `Waiting for local containers: ${missing.join(", ")}. Startup is incomplete while required services are missing.`, { progressing: false, waiting: "compute" });
    const unready = services.filter(service => service.oneShot ? service.state !== "exited" || service.exitCode !== 0 : service.state !== "running" || service.health === "starting");
    if (!services.length || unready.length) return result("starting", "Waiting for local services, source watch and web client.", { progressing: services.length > 0 && unready.every(service => service.state === "running" || service.state === "restarting"), waiting: "compute" });
    const postgres = services.find(service => service.name === "postgres");
    const verification = services.find(service => service.name === "prisma-verify");
    if (postgres && verification) {
      const problem = await this.databaseReadiness.problem(postgres.container, verification.container);
      if (problem) return { ...result("blocked", problem), remedy: "restart" as const };
    }
    if (!checkClient) return result("ready", "The existing containers and database prerequisite are ready.");
    if (!managed.watch.running || !managed.client.running) return result("starting", "Waiting for the source watcher and web client to reconnect.", { progressing: true, waiting: "support" });
    try {
      const response = await fetch(this.appUrl(), { signal: AbortSignal.timeout(1500), redirect: "manual" });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 400) return result("ready", "Services are running and the web client is reachable. Authentication and application behavior require their own checks.");
    } catch { /* A process can exist before binding its HTTP port. */ }
    return result("starting", "Containers started; waiting for the web client to answer HTTP requests.", { progressing: true, waiting: "support" });
  }

  /** Reconnection observes existing compute only; it never repairs containers or storage. */
  async assertRecoverable(): Promise<void> {
    if (this.runRecord()?.stopped) throw new LocalRuntimeConflict("Local runtime was intentionally stopped. Start development explicitly to run it again.");
    if (this.project !== this.configuredProject) throw new LocalRuntimeConflict("App name changed while this checkout's runtime remains active. Stop local runtime before starting it under the new name.");
    const services = await this.services();
    // Docker-revived database containers are not a session to rejoin.
    if (!services.some(service => isActiveContainerState(service.state) && !isInfrastructureService(service.name))) throw new LocalRuntimeConflict("There are no active Compose services to reconnect. Start development explicitly.");
    const setupProblem = this.setupProblem();
    if (setupProblem) throw new LocalRuntimeConflict(setupProblem);
    const settingsProblem = this.settingsProblem();
    if (settingsProblem) throw new LocalRuntimeConflict(settingsProblem);
    const exported = this.exported();
    const running = services.filter(service => isActiveContainerState(service.state) && !service.oneShot && !isInfrastructureService(service.name));
    if (exported.at !== undefined) {
      const started = await this.startedAt(running.map(service => service.id));
      if (running.some(service => (started.get(service.id) ?? Infinity) < exported.at! - 1000))
        throw new LocalRuntimeConflict("Local settings changed after these containers started. Restore their original settings or explicitly restart development before reconnecting.");
    }
    const readiness = await this.readiness(services, { watch: { running: true }, client: { running: true } }, false);
    if (readiness.state !== "ready") throw new LocalRuntimeConflict(readiness.message);
  }

  async waitUntilReady(signal: AbortSignal, managed: () => { readonly watch: ManagedProcessView; readonly client: ManagedProcessView }, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + Math.max(100, Math.min(120_000, timeoutMs));
    while (!signal.aborted) {
      const processes = managed();
      if (!processes.watch.running || !processes.client.running) throw new Error("A local support process stopped before readiness was confirmed. Inspect Source watch and Web client in Activity, then check again to reconnect. Containers and data are preserved.");
      const state = await this.readiness(await this.services(), processes);
      if (state.state === "ready") return;
      if (state.state === "blocked") throw new Error(state.message);
      if (Date.now() >= deadline) throw new Error(`${state.message} Startup is not confirmed. Services already started remain running; inspect their logs before restarting.`);
      await delay(500, undefined, { signal });
    }
    throw new Error("Readiness check stopped. Services already started remain running.");
  }

  async logs(service: string, tail = 300): Promise<string> {
    const match = (await this.services()).find((entry) => entry.name === service || entry.container === service);
    if (!match) throw Object.assign(new Error(`${service} is not a container of ${this.project}.`), { status: 404 });
    const result = await this.run(this.tools.docker(["logs", "--tail", String(tail), "--timestamps", match.id], this.env), { timeoutMs: 20_000 });
    // docker logs writes the container's stderr to its own stderr.
    return `${result.stdout}${result.stderr}`.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }
}

import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { OperationsClient } from "../operations/client";
import { privateValues, RUNNER_KINDS } from "../operations/adapter";
import { isLocalProcessKind, LOCAL_PROCESS_KINDS } from "../../shared/operations";
import { deriveRuntimeLifecycle, runtimeOperationKind } from "../../shared/local-lifecycle";
import { listAwsProfiles } from "aws-studio/cli/aws-profiles";
import { isAwsProfileName } from "../../shared/aws-connections";
import { repositoryTargets } from "aws-studio/deploy/node";
import type { DeployOverview, DriftView, JobView, LocalRunView, ManagedProcessView, OperationRequest, PrerequisiteView } from "../../shared/deploy";
import { JobManager } from "./jobs";
import { LocalEnvironment } from "./local";
import { AwsObserver, type Observation } from "./observe";
import { PlanStore, TeardownStore } from "./plans";
import { Preferences } from "./preferences";
import { probeDockerStatus, probePrerequisites } from "./prereqs";
import { DockerStatus } from "../machine/docker";
import { withDockerStatus } from "../../shared/machine";
import { runCommand, Tools, type Runner } from "./process";
import { assertDevelopmentRuntimeStopped, buildOperation, changesDevelopmentResources, exportDirectory, managedSpec, OperationError, type ManagedCommands, type OperationContext, type RepositoryTarget } from "./registry";
import type { AwsConnectionsService } from "../aws-connections/service";
import { StackInspector } from "./stack-inspection";
import type { StackInspectionRequest } from "../../shared/stack-inspection";

/**
 * Deploy & Run's server side: the observers, the operation registry and the
 * jobs, behind one object the routes call.
 */

/**
 * How long compute must stay positively absent before a session's leftover support processes are
 * retired. It spans a `docker compose up` recreating containers outside Studio; an explicit
 * Start or a development-resource change retires them immediately.
 */
const SESSION_END_GRACE_MS = 3000;
/**
 * Compute warming with no operation to bound it (a host that restarted mid-start, a web client that
 * never answers) is starting only for so long. It exceeds the 60s container start period and the
 * 60s readiness timeout of a start or reconnect, and is not a wait the user can act on.
 */
const WARMUP_LIMIT_MS = 120_000;

export interface DeployServiceOptions {
  /** The checkout owner reconciles existing containers and missing support processes. */
  readonly observeExistingContainers?: boolean;
  /** Independent tooling owns the checkout until its outcome is known. */
  readonly runtimeBlocked?: () => boolean;
  /** Production Studio uses the independent runner. Injected legacy service tests opt out. */
  readonly operations?: boolean;
  readonly disabledLocalServices?: () => ReadonlySet<string>;
  readonly run?: Runner;
  readonly env?: NodeJS.ProcessEnv;
  /** Where jobs, plans, preferences and the local run record live (default .cache/framework-studio). */
  readonly stateDirectory?: string;
  /** The programs behind the source watch and the web client, replaced in tests. */
  readonly managed?: ManagedCommands;
}

export class DeployService {
  readonly tools: Tools;
  readonly jobs: JobManager;
  readonly plans: PlanStore;
  readonly teardowns: TeardownStore;
  readonly local: LocalEnvironment;
  readonly observer: AwsObserver;
  readonly stackInspector: StackInspector;
  readonly preferences: Preferences;
  private readonly run: Runner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly drift = new Map<string, DriftView>();
  private prerequisites?: { at: number; promise: Promise<PrerequisiteView[]> };
  readonly dockerStatus: DockerStatus;
  private readonly context: OperationContext;
  private connections?: Pick<AwsConnectionsService, "catalog" | "check" | "startAuthentication">;
  private readonly operationsClient?: OperationsClient;
  private readonly runtimeHost: boolean;
  private readonly state: string;
  private operationViews: JobView[] = [];
  private readonly operationVersions = new Map<string, string>();
  private readonly operationCursors = new Map<string, number>();
  private readonly operationEventCursors = new Map<string, number>();
  private operationPoll?: NodeJS.Timeout;
  private operationRefresh?: Promise<JobView[]>;
  private disposed = false;
  private operationStatusUnknown = true;
  private admissions = Promise.resolve();
  private readonly observeExistingContainers: boolean;
  private readonly runtimeBlocked: () => boolean;
  private recoveryAdmission?: Promise<void>;
  private recoveryAttempt?: string;
  private recoveryFailure?: string;
  private recoveryHealthySince?: number;
  private sessionEndedAt?: number;
  private warmingSince?: number;
  private logsAttempt?: string;
  private localRead?: Promise<LocalRunView>;

  constructor(readonly root: string, private readonly broadcast: (event: string, data: unknown) => void, options: DeployServiceOptions = {}) {
    this.runtimeHost = options.operations === true && options.observeExistingContainers === true;
    this.observeExistingContainers = options.observeExistingContainers === true;
    this.runtimeBlocked = options.runtimeBlocked ?? (() => false);
    this.env = options.env ?? process.env;
    this.run = options.run ?? runCommand;
    this.tools = new Tools(root, this.env);
    this.dockerStatus = new DockerStatus(() => probeDockerStatus(this.tools, this.run, this.env), status => this.broadcast("machine-docker", status));
    // FRAMEWORK_STUDIO_STATE_DIRECTORY keeps a test run's jobs and plans apart from yours.
    const state = options.stateDirectory ?? (this.env.FRAMEWORK_STUDIO_STATE_DIRECTORY ? path.resolve(this.env.FRAMEWORK_STUDIO_STATE_DIRECTORY) : path.join(root, ".cache", "framework-studio"));
    this.state = state;
    this.jobs = new JobManager({ directory: path.join(state, "jobs"), restore: !this.runtimeHost, emit: (event, data) => {
      if (event === "deploy-job" && (data as JobView).status !== "running") {
        const profile = (data as JobView).params.profile;
        this.observer.invalidate(typeof profile === "string" ? profile : undefined);
        this.stackInspector?.invalidate();
      }
      broadcast(event, data);
      if (event === "deploy-job") broadcast("operation-job", data);
      if (event === "deploy-log") broadcast("operation-log", data);
    } });
    if (options.operations) {
      this.operationsClient = new OperationsClient(root, state, this.env);
      this.operationPoll = setInterval(() => { void this.refreshOperations().catch(() => {}); }, 500);
      this.operationPoll.unref();
      void this.refreshOperations().catch(() => {});
    }
    this.plans = new PlanStore(state, root, this.env);
    this.teardowns = new TeardownStore(state);
    this.local = new LocalEnvironment(root, this.tools, this.run, this.env, exportDirectory(root, this.env), state, options.disabledLocalServices,
      this.observeExistingContainers && !this.runtimeHost);
    this.observer = new AwsObserver(this.tools, this.run, this.env);
    this.stackInspector = new StackInspector(this.tools, this.run, this.env);
    this.preferences = new Preferences(state);
    this.context = {
      root, tools: this.tools, env: this.env, run: this.run, exportDirectory: this.local.exportDirectory,
      jobs: this.jobs, plans: this.plans, teardowns: this.teardowns, local: this.local, observer: this.observer,
      profiles: () => this.observer.profiles(),
      targets: () => this.targets(),
      probeDocker: () => this.dockerStatus.read(true).then(status => status.docker),
      managed: options.managed ?? {},
      startManaged: (kind, profile) => this.jobs.holder(kind) ?? this.jobs.start({
        ...managedSpec(this.context, kind, profile),
        ...(kind === "local-logs" ? { outputSecrets: () => privateValues(root, state, undefined, this.env) } : {}),
      }),
      stopManaged: async () => {
        const running = LOCAL_PROCESS_KINDS.map((lock) => this.jobs.holder(lock)).filter((job): job is JobView => Boolean(job));
        for (const job of running) this.jobs.cancel(job.id);
        await Promise.all(running.map((job) => this.jobs.wait(job.id)));
      },
      setDrift: (deployment, view) => { this.drift.set([view.account, view.region, deployment].join("|"), view); },
      followStacks: (job, profile, deployment, region) => this.follow(job, profile, deployment, region),
      changed: (profile, deployment) => {
        this.observer.invalidate(profile);
        this.stackInspector.invalidate();
        this.prerequisites = undefined;
        this.dockerStatus.invalidate();
        if (!this.disposed) void this.dockerStatus.read(true).catch(() => {});
        this.broadcast("deploy-changed", { profile: profile ?? null, deployment: deployment ?? null });
      },
    };
    if (this.observeExistingContainers) void this.localStatus().catch(() => {});
  }

  private reconcileRuntime(local: LocalRunView, force: boolean): Promise<void> {
    if (this.recoveryAdmission) return this.recoveryAdmission;
    const admitted = this.admissions.then(async () => {
      if (this.disposed || this.runtimeBlocked()) return;
      await this.reapEndedSession(local);
      if (this.local.runRecord()?.stopped || local.observationProblem || !local.activeContainerCount) return;
      // A fresh clone can share Docker's surviving containers while its ignored
      // exports are absent. Explicit startup prepares those files; observation
      // must not turn expected setup into a failed recovery job or retry loop.
      if (this.local.setupProblem()) {
        this.recoveryAttempt = undefined; this.recoveryFailure = undefined; this.recoveryHealthySince = undefined;
        return;
      }
      if (this.jobs.holder("local") || this.jobs.running().some(job => !isLocalProcessKind(job.kind))) return;
      // Reconnect only when compute is ready and just its support processes are missing. Compute that is
      // warming or blocked is observed instead: a reconnect cannot succeed there and would only leave a
      // failed job in Activity. Its output is still followed, read-only, once provenance is verified.
      const readiness = local.readiness;
      const attachable = readiness?.state === "ready" || readiness?.state === "starting" && readiness.waiting === "support";
      if (!attachable) {
        // One follower start per observed container generation: a follower that exits at once cannot become a restart loop.
        const observed = JSON.stringify([local.project, local.services.map(service => [service.containerId ?? service.container, service.state, service.health, service.exitCode])]);
        if (!this.jobs.holder("local-logs") && (force || this.logsAttempt !== observed)) {
          this.logsAttempt = observed;
          this.context.startManaged("local-logs", this.local.runRecord()?.profile ?? "");
        }
        return;
      }
      const generation = JSON.stringify([local.project, this.local.runRecord()?.startedAt,
        local.services.map(service => [service.containerId ?? service.container, service.state, service.health, service.exitCode]),
        // Support-process/HTTP readiness is changed by recovery itself. Only
        // actual container, database or settings blockers change its evidence.
        local.restartNeeded, local.readiness?.state === "blocked" ? local.readiness.message : undefined]);
      if (this.jobs.holder("local-watch") && this.jobs.holder("local-client") && this.jobs.holder("local-logs")) {
        if (local.readiness?.state === "ready") {
          // A process can exit just after its launch was accepted. Keep this
          // recovery attempt until the existing observations prove stability,
          // so a repeatedly crashing watcher cannot become a restart loop.
          if (!this.recoveryAttempt || this.recoveryAttempt !== generation) {
            this.recoveryAttempt = undefined; this.recoveryFailure = undefined; this.recoveryHealthySince = undefined;
          } else {
            // HTTP can become ready after a reconnect timed out. Proven readiness clears
            // that failure, while retaining the attempt until it has stayed healthy.
            this.recoveryFailure = undefined;
            this.recoveryHealthySince ??= Date.now();
            if (Date.now() - this.recoveryHealthySince >= 5000) {
              this.recoveryAttempt = undefined; this.recoveryHealthySince = undefined;
            }
          }
        }
        return;
      }
      // A failed recovery gets one attempt per observed runtime generation. An
      // explicit Check again may retry; ordinary observation never spins failures.
      if (!force && this.recoveryAttempt === generation) {
        if (this.recoveryHealthySince !== undefined) this.recoveryFailure = "A local support process stopped just after reconnecting. Inspect its Activity logs, then retry recovery. Existing containers and data are preserved.";
        return;
      }
      this.recoveryAttempt = generation;
      this.recoveryFailure = undefined;
      this.recoveryHealthySince = undefined;
      const spec = await buildOperation(this.context, { kind: "local-attach-watch", params: {} });
      if (this.disposed || this.local.runRecord()?.stopped || this.runtimeBlocked()) return;
      this.jobs.start({ ...spec, onSettled: job => {
        spec.onSettled?.(job);
        if (job.status === "succeeded") this.recoveryHealthySince = Date.now();
        else if (!this.local.runRecord()?.stopped) this.recoveryFailure = job.summary ?? "Could not reconnect the local runtime. Inspect Activity and check again.";
      } });
    });
    this.admissions = admitted.then(() => {}, () => {});
    this.recoveryAdmission = admitted.catch(error => {
      this.recoveryFailure = error instanceof Error ? error.message : "Could not reconnect the local runtime.";
    }).finally(() => { this.recoveryAdmission = undefined; });
    return this.recoveryAdmission;
  }

  /** The deployments this repository intends, as cdk-app/cdk.json names them: the dev stage first. */
  targets(): RepositoryTarget[] {
    return this.listTargets().targets;
  }

  private listTargets(): { targets: RepositoryTarget[]; problem?: string } {
    try {
      return {
        targets: repositoryTargets(this.root).map((entry) => ({
          name: entry.name, mode: entry.mode, origin: entry.origin,
          ...(entry.stage ? { stage: entry.stage } : {}), ...(entry.appId ? { appId: entry.appId } : {}), ...(entry.deployAs ? { deployAs: entry.deployAs } : {}),
          ...(entry.account ? { account: entry.account } : {}), ...(entry.region ? { region: entry.region } : {}), ...(entry.inputs ? { inputs: entry.inputs } : {}),
        })),
      };
    } catch (error) {
      // The CLI refuses the same configuration; say why rather than show an empty list.
      return { targets: [], problem: error instanceof Error ? error.message : String(error) };
    }
  }

  private probe(force: boolean) {
    if (!force && this.prerequisites && Date.now() - this.prerequisites.at < 15_000) return this.prerequisites.promise;
    const promise = probePrerequisites(this.tools, this.run, this.env, this.root, this.dockerStatus.read(force))
      .then(result => result.prerequisites.filter(check => check.id !== "docker" && check.id !== "compose"));
    this.prerequisites = { at: Date.now(), promise };
    return promise;
  }

  private managed(lock: "local-watch" | "local-client"): ManagedProcessView {
    const running = this.jobs.holder(lock);
    if (running) return { running: true, jobId: running.id };
    const last = this.jobs.list().find((job) => job.kind === lock);
    return last ? { running: false, jobId: last.id, exitCode: last.exitCode ?? null, ...(last.status === "failed" && last.summary ? { summary: last.summary } : {}) } : { running: false };
  }

  private clearSessionEvidence(): void {
    this.recoveryAttempt = undefined;
    this.recoveryFailure = undefined;
    this.recoveryHealthySince = undefined;
    this.logsAttempt = undefined;
    this.warmingSince = undefined;
  }

  /**
   * The watcher, web client and log follower belong to a session. Once its compute is positively gone
   * (Docker restarted, every container stopped) they have nothing to serve, and a stranded web client
   * would hold a stale environment and the client port. The host owns them, so the host retires them.
   * Never on unknown observations, and never during an operation of its own.
   */
  private async reapEndedSession(local: LocalRunView): Promise<void> {
    const ended = !local.observationProblem && local.docker.engine !== "unknown" && local.activeContainerCount === 0
      && !this.jobs.holder("local");
    if (ended) this.clearSessionEvidence();
    if (!ended || !LOCAL_PROCESS_KINDS.some(kind => this.jobs.holder(kind))) { this.sessionEndedAt = undefined; return; }
    this.sessionEndedAt ??= Date.now();
    if (Date.now() - this.sessionEndedAt < SESSION_END_GRACE_MS) return;
    this.sessionEndedAt = undefined;
    try { await this.context.stopManaged(); } catch { /* The next observation retries; the verdict is already off. */ }
  }

  /** The same retirement, decided from a fresh Docker read, for callers that act on the user's explicit intent. */
  private async retireEndedSession(): Promise<void> {
    if (this.jobs.holder("local") || !LOCAL_PROCESS_KINDS.some(kind => this.jobs.holder(kind))) return;
    const engine = (await this.dockerStatus.read()).docker.engine;
    if (engine === "unknown" || engine === "running" && (await this.local.activeCompute()).length) return;
    await this.context.stopManaged();
  }

  /** Local observations do not trigger AWS discovery or machine prerequisite probes. */
  async localStatus(force = false) {
    if (this.runtimeHost) return this.operationsClient!.localStatus(force);
    if (this.localRead) return this.localRead;
    this.localRead = this.readLocalStatus(force).finally(() => { this.localRead = undefined; });
    return this.localRead;
  }

  private async readLocalStatus(force: boolean): Promise<LocalRunView> {
    const machine = await this.dockerStatus.read(force);
    const local = await this.local.view(machine.docker, { watch: this.managed("local-watch"), client: this.managed("local-client") });
    if (this.observeExistingContainers) await this.reconcileRuntime(local, force);
    const holder = this.jobs?.holder("local");
    const operation = runtimeOperationKind(holder);
    const recovering = operation === "local-attach-watch";
    const recovery = this.local.runRecord?.()?.stopped ? undefined : recovering
      ? { state: "reconnecting" as const, message: "Reconnecting to this checkout's existing containers, source watcher and web client." }
      : this.recoveryFailure ? { state: "failed" as const, message: this.recoveryFailure } : undefined;
    const view = { ...local, ...(recovery ? { recovery } : {}) };
    // One verdict, from the host that owns the processes and operations, for every tab and page load.
    let lifecycle = deriveRuntimeLifecycle(view, operation);
    // Only an operation bounds a start. Warming observed without one gets a ceiling instead of an eternal "Starting…".
    if (lifecycle === "starting" && !operation) {
      this.warmingSince ??= Date.now();
      const limit = Number(this.env.FRAMEWORK_LOCAL_WARMUP_LIMIT_MS ?? WARMUP_LIMIT_MS);
      if (Date.now() - this.warmingSince >= (Number.isFinite(limit) && limit > 0 ? limit : WARMUP_LIMIT_MS)) lifecycle = "attention";
    } else this.warmingSince = undefined;
    return { ...view, ...(operation && holder ? { operation: { kind: operation, id: holder.id } } : {}), ...(lifecycle ? { lifecycle } : {}) };
  }

  async overview(force = false): Promise<DeployOverview> {
    const [prerequisites, profiles, machine] = await Promise.all([this.probe(force), this.observer.profiles(force), this.dockerStatus.read(force)]);
    const local = await this.localStatus(force);
    const { targets, problem } = this.listTargets();
    return withDockerStatus({ targets, ...(problem ? { targetsProblem: problem } : {}), prerequisites, local, jobs: await this.listOperations(), preferences: this.preferences.read(), profiles }, machine);
  }

  async requireProfile(name: unknown): Promise<string> {
    if (!isAwsProfileName(name) || !this.profiles().some((entry) => entry.name === name)) throw new OperationError(400, "Choose a profile from your AWS configuration.");
    return name;
  }

  profiles() { return listAwsProfiles(this.env); }

  setConnections(service: Pick<AwsConnectionsService, "catalog" | "check" | "startAuthentication">) { this.connections = service; }

  async authenticate(profile: unknown) {
    if (!this.connections) throw new OperationError(409, "Open AWS profile configuration to connect. Restart Studio if it is unavailable.");
    return this.connections.startAuthentication({ profile: await this.requireProfile(profile) });
  }

  async identity(profile: string, force: boolean): Promise<Observation<{ context: import("../../shared/deploy").AccountContext }>> {
    if (!this.connections) return this.observer.identity(profile, force);
    const observation = await this.connections.check(profile, force);
    if (observation.state === "connected" && observation.identity) return { ok: true, value: { context: { profile, ...observation.identity, region: observation.region.value ?? "" } } };
    const code = observation.problem?.code;
    const kind = code === "expired" || code === "no-credentials" || code === "missing-cli" || code === "denied" || code === "throttled" ? code : code === "profile" || code === "configuration" ? "profile" : "failed";
    return { ok: false, problem: { kind, message: observation.problem?.message ?? "The selected AWS identity is unverified. Open connection diagnostics." } };
  }

  discover(profile: string, region: string | undefined, force: boolean): Promise<Observation<unknown>> {
    return this.observer.discover(profile, region, force);
  }

  status(profile: string, deployment: string, region: string | undefined, force: boolean): Promise<Observation<unknown>> {
    return this.observer.status(profile, deployment, region, force);
  }

  inspectStack(request: StackInspectionRequest, force: boolean) {
    const target = this.targets().find(target => target.name === request.deployment);
    if (!target || target.mode !== request.mode || target.account && target.account !== request.account || target.region && target.region !== request.region) throw new OperationError(409, "Choose a declared deployment and its configured account, region, and mode before inspecting a stack.");
    return this.stackInspector.inspect(request, force, { appId: target.appId, stage: target.stage });
  }

  async teardown(profile: string, deployment: string, mode: "dev" | "prod", region: string | undefined, retainFailed = false, disableProtection = false) {
    const observation = await this.observer.teardown(profile, deployment, mode, region, retainFailed, disableProtection);
    return observation.ok ? { ok: true as const, value: this.teardowns.save(observation.value) } : observation;
  }

  /** Plans, with any a running job is still writing kept out of the clean-up. */
  async listPlans() {
    await this.refreshOperations();
    const active = new Set(this.activeJobs().map((job) => job.planId).filter((key): key is string => Boolean(key)));
    return this.plans.list((key) => active.has(key));
  }

  driftReport(deployment: string, account?: string, region?: string): DriftView | null {
    if (this.operationsClient && account && region) {
      const key = createHash("sha256").update(JSON.stringify([account, region, deployment])).digest("hex");
      try { return JSON.parse(readFileSync(path.join(this.state, "operations", `drift-${key}.json`), "utf8")) as DriftView; } catch { return null; }
    }
    return account && region ? this.drift.get([account, region, deployment].join("|")) ?? null : null;
  }

  perform(request: OperationRequest): Promise<JobView> {
    if (this.disposed) return Promise.reject(new OperationError(503, "Studio has stopped accepting operations."));
    if (!request || typeof request.kind !== "string") return Promise.reject(new OperationError(400, "An operation has a kind."));
    if (this.runtimeHost && !RUNNER_KINDS.has(request.kind) && request.kind !== "aws-login") {
      return this.operationsClient!.localPerform(request).then(job => this.publishOperationReceipt(job));
    }
    if (request?.kind === "local-stop") this.local.markStopped();
    const admitted = this.admissions.then(() => this.performAdmitted(request));
    this.admissions = admitted.then(() => {}, () => {});
    return admitted;
  }

  private async performAdmitted(request: OperationRequest): Promise<JobView> {
    if (this.disposed) throw new OperationError(503, "Studio has stopped accepting operations.");
    if (!request || typeof request.kind !== "string") throw new OperationError(400, "An operation has a kind.");
    if (["local-start", "local-restart", "local-attach-watch", "deps-install"].includes(request.kind) && this.runtimeBlocked())
      throw new OperationError(409, "Independent work still owns this checkout. Wait for it before changing the local runtime.");
    const localOperation = this.jobs.holder("local");
    if (request.kind === "local-stop" && localOperation && ["local-start", "local-restart", "local-attach-watch"].includes(localOperation.kind)) {
      this.jobs.cancel(localOperation.id);
      await this.jobs.wait(localOperation.id);
      this.local.markStopped();
    } else if (localOperation?.kind === request.kind && ["local-start", "local-restart", "local-attach-watch", "local-stop"].includes(request.kind)
      && (request.kind === "local-stop" || request.kind === "local-attach-watch" || localOperation.params.deployment === request.params?.deployment && localOperation.params.profile === request.params?.profile)) return localOperation;
    if (request.kind === "docker-start") {
      const running = this.jobs.holder("docker");
      if (running) return running;
    }
    if (request.kind === "aws-login") throw new OperationError(400, "Authentication uses AWS connection management. Open Configure AWS profiles.");
    if (this.operationsClient && RUNNER_KINDS.has(request.kind)) {
      if (this.jobs.running().some(job => !isLocalProcessKind(job.kind))) throw new OperationError(409, "A local workspace operation is running. Wait for it before starting independent work.");
      if (changesDevelopmentResources(this.context, request)) {
        // The switch reads off once compute is gone; leftover support processes must not make the guard disagree.
        await this.retireEndedSession();
        await assertDevelopmentRuntimeStopped(this.context);
      }
      const job = await this.operationsClient.submit(request);
      return this.publishOperationReceipt(job);
    }
    if (this.operationsClient && ["local-start", "local-restart", "local-attach-watch", "deps-install"].includes(request.kind)) {
      if ((await this.refreshOperations()).some(job => job.status === "running" || job.execution === "lost" || job.outcome === "uncertain")) throw new OperationError(409, "Independent work still owns this checkout. Inspect its outcome before changing local dependencies or exports.");
    }
    let admittedRequest = request;
    // Only application compute is a session to join. Database containers Docker revived after a restart,
    // and the watcher/client of the session that died with it, are retired or reused by a real start.
    if (request.kind === "local-start" && !this.local.runRecord()?.stopped) await this.retireEndedSession();
    if (request.kind === "local-start" && !this.local.runRecord()?.stopped
      && (this.jobs.holder("local-watch") || this.jobs.holder("local-client")
        || (await this.dockerStatus.read()).docker.engine === "running" && (await this.local.activeCompute()).length)) {
      const binding = this.local.runRecord();
      if (binding?.deployment && (["deployment", "profile", "account", "region"] as const).some(key => request.params?.[key] && binding[key] && request.params[key] !== binding[key]))
        throw new OperationError(409, "This checkout already has an active runtime for another destination. Inspect Local runtime; starting again cannot retarget existing containers.");
      // A stale browser can submit Start after another tab finished startup.
      // Starting an already active checkout is an attach, never another export/build.
      if (localOperation?.kind === "local-attach-watch") return localOperation;
      admittedRequest = { kind: "local-attach-watch", params: {} };
    }
    const spec = await buildOperation(this.context, admittedRequest);
    try {
      const accepted = this.jobs.start(spec);
      // A new explicit session owns its own recovery evidence. A stale Start converted
      // to an attach keeps the current generation's bounded recovery guard.
      if (spec.kind === "local-start" || spec.kind === "local-restart") this.clearSessionEvidence();
      return accepted;
    } catch (error) {
      // A refused start leaves no half-made plan directory behind.
      if (spec.planId && spec.kind === "deploy-plan") this.plans.removeUnfinished(spec.planId);
      throw error;
    }
  }

  activeJobs(): JobView[] { return [...this.jobs.running(), ...this.operationViews.filter(job => job.status === "running" || job.execution === "lost" || job.outcome === "uncertain")]; }
  hasUnobservedOperations(): boolean { return Boolean(this.operationsClient) && this.operationStatusUnknown; }

  /** Keep an acknowledged operation visible even if the following observation fails. */
  private publishOperationReceipt(job: JobView): JobView {
    this.operationViews = [job, ...this.operationViews.filter(entry => entry.id !== job.id)];
    this.broadcast("operation-job", job);
    this.broadcast("deploy-job", job);
    void this.refreshOperations().catch(() => {});
    return job;
  }

  async listOperations(): Promise<JobView[]> {
    const operations = await this.refreshOperations();
    return [...operations, ...this.jobs.list()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async cancelOperation(id: string): Promise<JobView> {
    if (this.jobs.get(id)) return this.jobs.cancel(id);
    if (!this.operationsClient) throw new OperationError(404, "No such operation.");
    const job = await this.operationsClient.cancel(id);
    return this.publishOperationReceipt(job);
  }

  async operationLog(id: string, after = 0) {
    if (this.jobs.get(id)) return this.jobs.log(id, after);
    if (!this.operationsClient) throw new OperationError(404, "No such operation.");
    return this.operationsClient.log(id, after);
  }

  async frameworkCheck(requestKey?: string) {
    const started = Date.now();
    const accepted = await this.perform({ kind: "framework-check", params: {}, requestKey });
    let job = accepted;
    let output = "";
    let cursor = 0;
    while (!this.disposed) {
      const page = await this.operationLog(job.id, cursor);
      job = page.job;
      if (page.lines.length) {
        cursor = page.lines.at(-1)!.seq;
        output = (output + page.lines.map(line => line.text).join("\n") + "\n").slice(-256 * 1024);
      }
      if (job.status !== "running" && cursor >= job.lastSeq) return { command: "framework:check", exitCode: job.exitCode ?? null, output, durationMs: Date.now() - started };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new OperationError(503, "Studio stopped observing; the framework check continues in Activity.");
  }

  private refreshOperations(): Promise<JobView[]> {
    if (!this.operationsClient || this.disposed) return Promise.resolve(this.operationViews);
    if (this.operationRefresh) return this.operationRefresh;
    this.operationRefresh = (async () => {
      const observed = await this.operationsClient!.list();
      if (this.disposed) return observed;
      // An earlier discovery response must not erase an acceptance/cancellation receipt
      // acknowledged while that read was in flight. History is retained in this version.
      const known = new Map(this.operationViews.map(job => [job.id, job]));
      const phase = { accepted: 0, dispatching: 1, running: 2, finished: 3, lost: 3 };
      for (const job of observed) {
        const previous = known.get(job.id);
        if (previous && (previous.lastSeq > job.lastSeq || previous.status !== "running" && job.status === "running" || phase[previous.execution ?? "accepted"] > phase[job.execution ?? "accepted"])) continue;
        known.set(job.id, previous?.cancelRequested ? { ...job, cancelRequested: true } : job);
      }
      const jobs = [...known.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      this.operationViews = jobs;
      this.operationStatusUnknown = false;
      for (const job of jobs) {
        const version = JSON.stringify(job);
        const changed = this.operationVersions.get(job.id) !== version;
        if (changed) {
          this.operationVersions.set(job.id, version);
          // Subscribers may refresh as soon as a terminal job arrives. Drop
          // pre-completion AWS evidence before publishing either event.
          if (job.status !== "running") {
            this.observer.invalidate(typeof job.params.profile === "string" ? job.params.profile : undefined);
            this.stackInspector.invalidate();
          }
          this.broadcast("operation-job", job);
          this.broadcast("deploy-job", job);
          if (job.status !== "running") this.broadcast("deploy-changed", { deployment: job.deployment, profile: job.params.profile });
        }
        if (job.execution && (changed || job.status === "running")) {
          let cursor = this.operationEventCursors.get(job.id) ?? 0;
          let page;
          do {
            page = await this.operationsClient!.events(job.id, cursor);
            for (const entry of page.events) {
              if (!this.disposed) this.broadcast(entry.event, entry.data);
              cursor = entry.seq;
            }
            this.operationEventCursors.set(job.id, cursor);
          } while (page.events.length && cursor < page.lastSeq);
        }
        const cursor = this.operationCursors.get(job.id);
        if (cursor === undefined) { this.operationCursors.set(job.id, job.lastSeq); continue; }
        if (cursor < job.lastSeq) {
          const { lines } = await this.operationsClient!.log(job.id, cursor);
          if (this.disposed) return jobs;
          if (lines.length) {
            this.operationCursors.set(job.id, lines.at(-1)!.seq);
            this.broadcast("operation-log", { id: job.id, lines });
            this.broadcast("deploy-log", { id: job.id, lines });
          }
        }
      }
      return jobs;
    })().catch(error => { this.operationStatusUnknown = true; throw error; }).finally(() => { this.operationRefresh = undefined; });
    return this.operationRefresh;
  }

  private follow(job: string, profile: string, deployment: string, region: string | undefined): () => void {
    const statuses = new Map<string, string>();
    let baseline = true;
    let observedContext: { account?: string; region?: string } = { region };
    const prefix = `${deployment}-`;
    const short = (stack: unknown) => String(stack ?? "").startsWith(prefix) ? String(stack).slice(prefix.length) : String(stack ?? "");
    const watch = this.observer.watch(profile, deployment, region, (line) => {
      if (line.type === "context") {
        observedContext = (line.context as { account?: string; region?: string } | undefined) ?? observedContext;
      } else if (line.type === "stacks") {
        const stacks = (line.stacks as { name?: string; status?: string; reason?: string }[] | undefined) ?? [];
        for (const stack of stacks) {
          if (!stack.name || statuses.get(stack.name) === stack.status) continue;
          if (!baseline || stack.status?.endsWith("_IN_PROGRESS")) this.jobs.note(job, `CloudFormation · ${short(stack.name)} ${stack.status}`);
          statuses.set(stack.name, String(stack.status));
        }
        baseline = false;
        this.broadcast("deploy-stacks", { deployment, profile, ...observedContext, stacks });
      } else if (line.type === "event") {
        const event = line.event as { logicalId?: string; status?: string; reason?: string; type?: string } | undefined;
        if (event && event.logicalId !== line.stack) {
          this.jobs.note(job, `CloudFormation · ${short(line.stack)} · ${event.logicalId} ${event.status}${event.reason ? ` — ${event.reason}` : ""}`, /FAILED/.test(event.status ?? "") ? "err" : "info");
        }
        this.broadcast("deploy-event", { deployment, profile, ...observedContext, stack: line.stack, event });
      }
    });
    return () => {
      // One last look, so the page ends on what AWS holds.
      setTimeout(() => watch.stop(), 1500).unref();
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.operationPoll) clearInterval(this.operationPoll);
    this.operationsClient?.close();
    await this.localRead?.catch(() => {});
    this.observer.dispose();
    await this.jobs.dispose();
  }
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { identityAlive, isExecutionIdentity, processIdentity, sameUser } from "aws-studio/source/identity";
import { assertWindowsPrivatePath } from "aws-studio/cli/windows-security";
import type { ExecutionIdentity, JobLogLine, JobView, OperationRecord, OperationRequest } from "../../shared/operations";
import { isLocalProcessKind, OPERATIONS_VERSION } from "../../shared/operations";
import { callIpc, LOCAL_RUNTIME_CAPABILITY, OperationsError, privateEndpoint, type CoordinatorInfo } from "./ipc";
import { projectSynthesisSummary } from "./summaries";
import { needsTeardownProjection, projectTeardownOutcome } from "./teardown-outcome";
import type { LocalRunView } from "../../shared/deploy";

const loader = pathToFileURL(createRequire(path.join(__dirname, "../../package.json")).resolve("tsx")).href;
const coordinator = path.join(__dirname, "coordinator.ts");
const runtimeUpgrades = new Map<string, Promise<void>>();
const upgradeBlocked = () => new OperationsError(409, "The running operations host needs an update for local runtime reconnection. Finish or reconcile its active or uncertain operations, then check again. Existing work and containers were preserved.");
const blocksHostUpgrade = (job: JobView) => !job || typeof job.kind !== "string" || !["running", "succeeded", "failed", "cancelled", "interrupted"].includes(job.status)
  || job.status === "running" && !isLocalProcessKind(job.kind)
  || job.execution === "lost" && job.outcome !== "confirmed" || job.outcome === "uncertain";

function privatePath(file: string, directory = false): void {
  const stat = lstatSync(file);
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.isSymbolicLink()
    || typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw upgradeBlocked();
  if (process.platform === "win32") assertWindowsPrivatePath(file);
}

/** Read the existing singleton's complete execution identity; a ping PID alone is insufficient. */
function legacyOwner(directory: string, pid: number): ExecutionIdentity {
  const file = path.join(directory, "coordinator.sqlite");
  privatePath(file);
  const lease = new DatabaseSync(file, { readOnly: true });
  try {
    const row = lease.prepare("SELECT identity FROM owner WHERE singleton=1").get();
    const identity: unknown = row && JSON.parse(String(row.identity));
    if (!isExecutionIdentity(identity) || identity.pid !== pid || !sameUser(identity)) throw upgradeBlocked();
    return identity;
  } finally { lease.close(); }
}

/** A durable claim prevents separate Studio processes from signalling the same draining owner twice. */
function signalLegacyOwner(directory: string, owner: ExecutionIdentity): void {
  const file = path.join(directory, "coordinator.sqlite");
  privatePath(file);
  // Node implements SIGTERM as unconditional termination on Windows. A running
  // legacy host has no authenticated drain endpoint, so neither its lease nor a
  // durable signal claim can authorize a graceful handoff on that platform.
  if (process.platform === "win32") throw new OperationsError(409, "This older operations host cannot be refreshed gracefully on Windows. Inspect its active and uncertain work before an explicit host restart, then retry. The existing host, containers and operation journals were preserved.");
  const lease = new DatabaseSync(file);
  let signal = false;
  try {
    lease.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
    const row = lease.prepare("SELECT identity FROM owner WHERE singleton=1").get();
    const encodedOwner = JSON.stringify(owner);
    if (!row || JSON.stringify(JSON.parse(String(row.identity))) !== encodedOwner) throw upgradeBlocked();
    const alive = identityAlive(owner);
    if (alive === undefined) throw upgradeBlocked();
    lease.exec("CREATE TABLE IF NOT EXISTS runtime_upgrades (owner TEXT PRIMARY KEY, claimant TEXT NOT NULL)");
    if (alive && !lease.prepare("SELECT 1 FROM runtime_upgrades WHERE owner=?").get(encodedOwner)) {
      // Commit intent before sending. A claimant crash cannot authorize another
      // signal against a still-live owner: that previous delivery is uncertain.
      lease.prepare("INSERT INTO runtime_upgrades (owner,claimant) VALUES (?,?)").run(encodedOwner, JSON.stringify(processIdentity(randomUUID())));
      signal = true;
    }
    lease.exec("COMMIT");
  } catch (error) { try { lease.exec("ROLLBACK"); } catch { /* Preserve the original refusal. */ } throw error; }
  finally { lease.close(); }
  if (signal) try { process.kill(owner.pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/** Closing a Studio client closes observation only, never the coordinator or workers. */
export class OperationsClient {
  readonly root: string;
  readonly state: string;
  private starting?: Promise<CoordinatorInfo>;
  private closed = false;
  private socket?: string;

  constructor(root: string, state: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.root = realpathSync(root);
    mkdirSync(path.resolve(state), { recursive: true, mode: 0o700 });
    this.state = realpathSync(state);
  }

  private endpoint(): string { return this.socket ??= privateEndpoint(this.root, this.state).socket; }

  private async connected(): Promise<CoordinatorInfo> {
    const info = await callIpc<CoordinatorInfo>(this.endpoint(), "/ping", undefined, process.platform === "win32" ? 5000 : 1000);
    if (info.version !== OPERATIONS_VERSION || info.root !== this.root || info.state !== this.state) {
      throw new OperationsError(409, "The running operations coordinator belongs to another protocol or workspace. Preserve running operations before upgrading it.");
    }
    return info;
  }

  private async ensure(): Promise<CoordinatorInfo> {
    if (this.closed) throw new OperationsError(503, "This operations observer is closed.");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try { return await this.connected(); } catch (error) {
        if (error instanceof OperationsError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "")) throw error;
      }
      let launchError: Error | undefined;
      const child = spawn(process.execPath, ["--import", loader, coordinator, this.root, this.state], {
        cwd: this.root, env: this.env, detached: true, stdio: "ignore", windowsHide: true,
      });
      child.once("error", error => { launchError = error; });
      child.unref();
      // Another Studio may launch simultaneously. The SQLite coordinator lease chooses one.
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw new OperationsError(503, "The operations coordinator could not be started.");
        await new Promise(resolve => setTimeout(resolve, 100));
        try { return await this.connected(); } catch (error) {
          if (error instanceof OperationsError && error.status === 409) throw error;
        }
      }
      throw new OperationsError(503, "The independent operations coordinator did not start. Check private state permissions and the installed Node runtime; existing operations were not restarted.");
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async ensureRuntime(): Promise<void> {
    const info = await this.ensure();
    if (info.localRuntime === LOCAL_RUNTIME_CAPABILITY) return;
    if (info.localRuntime !== undefined && info.localRuntime !== 1) throw new OperationsError(409, "The running operations host advertises an unsupported local runtime capability. Preserve its active sessions and use a compatible Studio version.");
    const endpoint = privateEndpoint(this.root, this.state);
    let upgrading = runtimeUpgrades.get(endpoint.socket);
    if (!upgrading) {
      upgrading = this.refreshLegacyHost(info, endpoint.directory).finally(() => { runtimeUpgrades.delete(endpoint.socket); });
      runtimeUpgrades.set(endpoint.socket, upgrading);
    }
    await upgrading;
    if ((await this.ensure()).localRuntime !== LOCAL_RUNTIME_CAPABILITY) throw upgradeBlocked();
  }

  /** Refresh only an idle, authenticated older owner; independent workers are never signalled. */
  private async refreshLegacyHost(info: CoordinatorInfo, directory: string): Promise<void> {
    let owner: ExecutionIdentity;
    try {
      const current = await this.connected();
      if (current.localRuntime === LOCAL_RUNTIME_CAPABILITY) return;
      if (current.localRuntime !== undefined && current.localRuntime !== 1) throw upgradeBlocked();
      if (current.pid !== info.pid) throw upgradeBlocked();
      owner = legacyOwner(directory, info.pid);
      if (identityAlive(owner) === false) return;
      // Capability 1 also owns local jobs outside the independent journal. Its
      // watcher/client/log subscriptions can close gracefully and reconnect, but
      // a start, stop or other operation must keep its current owner.
      if (current.localRuntime === 1) {
        const jobs = await callIpc<JobView[]>(this.endpoint(), "/operations");
        if (!Array.isArray(jobs) || jobs.some(blocksHostUpgrade)) throw upgradeBlocked();
      }
      const operations = path.join(this.state, "operations");
      privatePath(operations, true);
      const file = path.join(operations, "operations.sqlite");
      privatePath(file);
      const db = new DatabaseSync(file);
      try {
        db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
        const binding = db.prepare("SELECT workspace FROM workspace_binding WHERE singleton=1").get();
        if (binding?.workspace !== this.root) throw upgradeBlocked();
        for (const row of db.prepare("SELECT view FROM operations").all()) {
          const job = JSON.parse(String(row.view)) as JobView;
          // Only settled work or a confirmed lost execution permits host replacement.
          if (!["succeeded", "failed", "cancelled", "interrupted"].includes(job.status)
            || !["finished", "lost"].includes(job.execution ?? "")
            || job.outcome === "uncertain" || job.execution === "lost" && job.outcome !== "confirmed") throw upgradeBlocked();
        }
        // Recheck local admission from its durable jobs without awaiting IPC while
        // holding the writer lock: the old host's maintenance tick may need that
        // same lock before it can answer. Job acceptance writes these files first.
        if (current.localRuntime === 1) {
          const jobs = path.join(this.state, "jobs");
          let files: string[];
          try { files = readdirSync(jobs); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
          for (const file of files.filter(file => file.endsWith(".json")))
            if (blocksHostUpgrade(JSON.parse(readFileSync(path.join(jobs, file), "utf8")) as JobView)) throw upgradeBlocked();
        }
        // The existing writer transaction excludes independent acceptance. Verify
        // the lease and fresh native process identity immediately before signalling.
        if (JSON.stringify(legacyOwner(directory, info.pid)) !== JSON.stringify(owner)) throw upgradeBlocked();
        const alive = identityAlive(owner);
        if (alive === undefined) throw upgradeBlocked();
        if (alive) signalLegacyOwner(directory, owner);
      } finally { try { db.exec("ROLLBACK"); } finally { db.close(); } }
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      // Another Studio process can finish the same handoff while this client
      // waits for the existing writer lock. Never signal a changed lease owner.
      try { if ((await this.connected()).localRuntime === LOCAL_RUNTIME_CAPABILITY) return; } catch { /* Preserve the original refusal. */ }
      throw error instanceof OperationsError ? error : upgradeBlocked();
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const alive = identityAlive(owner!);
      if (alive === false) return;
      if (alive === undefined) throw upgradeBlocked();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new OperationsError(409, "The verified idle operations host did not stop for its update. Inspect that host before retrying; existing containers and operation journals were preserved.");
  }

  private async call<T>(route: string, body?: unknown, runtime = false): Promise<T> {
    if (runtime) await this.ensureRuntime(); else await this.ensure();
    try { return await callIpc<T>(this.endpoint(), route, body); }
    catch (error) {
      // A coordinator can exit between the observational ping and this read.
      // Mutations keep their own request-key retry rules in submit().
      if (body !== undefined || error instanceof OperationsError || !["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (runtime) await this.ensureRuntime(); else await this.ensure();
      return callIpc<T>(this.endpoint(), route);
    }
  }

  ping(): Promise<CoordinatorInfo> { return this.call("/ping"); }
  localStatus(force = false): Promise<LocalRunView> { return this.call(`/local/status${force ? "?force=1" : ""}`, undefined, true); }
  async localPerform(request: OperationRequest): Promise<JobView> {
    // The host serializes lifecycle admissions. A lost mutation response is not
    // replayed: the next status/Activity read discovers its accepted job.
    const intent = { ...request, requestKey: request.requestKey ?? randomUUID() };
    // A capability-1 host already supports stop, including cancelling startup.
    // Preserve that escape while its active operation postpones the upgrade.
    if (request.kind === "local-stop" && (await this.ensure()).localRuntime === 1)
      return callIpc(this.endpoint(), "/local/perform", intent);
    return this.call("/local/perform", intent, true);
  }
  async list(): Promise<JobView[]> {
    if (this.closed) throw new OperationsError(503, "This operations observer is closed.");
    // Acceptance is durable before dispatch. A checkout with no database has no
    // independent work to observe, so map polling need not start a coordinator.
    const directory = path.join(this.state, "operations");
    try { lstatSync(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    try { lstatSync(path.join(directory, "operations.sqlite")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new OperationsError(503, "Operations storage exists without its database. Preserve the remaining evidence and inspect it before starting another operation.");
      throw error;
    }
    return Promise.all((await this.call<JobView[]>("/operations")).map(job => this.project(job)));
  }
  private async project(job: JobView, record?: OperationRecord): Promise<JobView> {
    const view = projectSynthesisSummary(this.state, job);
    if (!needsTeardownProjection(view)) return view;
    const accepted = record ?? await this.call<OperationRecord | null>(`/operations/${encodeURIComponent(job.id)}`);
    return accepted && accepted.view.id === view.id ? projectTeardownOutcome(this.state, { ...accepted, view }) : view;
  }
  async get(id: string): Promise<OperationRecord | undefined> {
    const record = await this.call<OperationRecord | null>(`/operations/${encodeURIComponent(id)}`);
    return record ? { ...record, view: await this.project(record.view, record) } : undefined;
  }
  async log(id: string, after = 0): Promise<{ job: JobView; lines: JobLogLine[] }> {
    const page = await this.call<{ job: JobView; lines: JobLogLine[] }>(`/operations/${encodeURIComponent(id)}/log?after=${Math.max(0, Math.floor(after))}`);
    return { ...page, job: await this.project(page.job) };
  }
  events(id: string, after = 0): Promise<{ events: { seq: number; event: string; data: unknown }[]; lastSeq: number }> { return this.call(`/operations/${encodeURIComponent(id)}/events?after=${Math.max(0, Math.floor(after))}`); }
  cancel(id: string): Promise<JobView> { return this.call(`/operations/${encodeURIComponent(id)}/cancel`, {}); }
  async submit(request: OperationRequest): Promise<JobView> {
    const intent = { ...request, requestKey: request.requestKey ?? randomUUID() };
    try { return await this.call("/submit", intent); } catch (error) {
      // Retry only transport loss, with the identical key. Domain errors are never retried.
      if (error instanceof OperationsError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT"].includes(code ?? "")) throw error;
      return this.call("/submit", intent);
    }
  }
  close(): void { this.closed = true; }
}

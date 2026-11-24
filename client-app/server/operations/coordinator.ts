import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { OPERATIONS_VERSION, type ExecutionIdentity, type JobView, type OperationRequest } from "../../shared/operations";
import { prepareIntent, reconcileOutcome, validateRequest } from "./adapter";
import { processIdentity, identityAlive, observeExecutions } from "aws-studio/source/identity";
import { closeIpcAuthentication, ipcAuthentication, isNamedPipe, LOCAL_RUNTIME_CAPABILITY, OperationsError, privateEndpoint, secureSocket, type AuthenticatedIpcRequest } from "./ipc";
import { assertWindowsPrivatePath } from "aws-studio/cli/windows-security";
import { canonicalRequest, OperationStore } from "./store";
import { DeployService, type DeployServiceOptions } from "../deploy/service";
import { isLocalProcessKind } from "../../shared/operations";

const LOCAL_KINDS = new Set(["local-start", "local-stop", "local-restart", "local-attach-watch", "deps-install", "docker-start"]);

const loader = pathToFileURL(createRequire(path.join(__dirname, "../../package.json")).resolve("tsx")).href;
const worker = path.join(__dirname, "worker.ts");

/** A transaction protects stale-socket recovery from competing coordinator startups. */
function coordinatorLease(directory: string): (() => void) | undefined {
  const file = path.join(directory, "coordinator.sqlite");
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe coordinator lease file.");
    if (process.platform === "win32") assertWindowsPrivatePath(file);
  }
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL)");
  let identity: ExecutionIdentity;
  try { identity = processIdentity(randomUUID()); } catch (error) { db.close(); throw error; }
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT identity FROM owner WHERE singleton=1").get() as { identity: string } | undefined;
    if (row) {
      const previous = JSON.parse(row.identity) as ExecutionIdentity;
      if (identityAlive(previous) !== false) { db.exec("ROLLBACK"); db.close(); return undefined; }
    }
    db.prepare("INSERT OR REPLACE INTO owner (singleton,identity) VALUES (1,?)").run(JSON.stringify(identity));
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* No transaction. */ } db.close(); throw error; }
  return () => {
    try { db.prepare("DELETE FROM owner WHERE singleton=1 AND identity=?").run(JSON.stringify(identity)); } finally { db.close(); }
  };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 96 * 1024) throw new OperationsError(413, "The operation intent is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestIntent(value: unknown): OperationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperationsError(400, "Name an operation.");
  const request = value as OperationRequest;
  if (Object.keys(value).some(key => !["kind", "params", "requestKey"].includes(key))) throw new OperationsError(400, "Unsupported operation request field.");
  if (typeof request.kind !== "string" || !request.params || typeof request.params !== "object" || Array.isArray(request.params)) throw new OperationsError(400, "An operation names its kind and parameters.");
  if (typeof request.requestKey !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(request.requestKey)) throw new OperationsError(400, "Supply a stable operation request key.");
  if (Object.values(request.params).some(value => value !== undefined && typeof value !== "string" && typeof value !== "boolean")) throw new OperationsError(400, "Operation parameters must be named strings or booleans.");
  return { kind: request.kind, params: request.params, requestKey: request.requestKey };
}

export async function startCoordinator(rootInput: string, stateInput: string, options: { readonly runtime?: DeployServiceOptions } = {}): Promise<{ close(): Promise<void> }> {
  process.umask(0o077);
  mkdirSync(path.resolve(stateInput), { recursive: true, mode: 0o700 });
  const root = realpathSync(rootInput), state = realpathSync(stateInput);
  const endpoint = privateEndpoint(root, state);
  const authentication = ipcAuthentication(endpoint.socket, `operations:${OPERATIONS_VERSION}`);
  const release = coordinatorLease(endpoint.directory);
  if (!release) throw new OperationsError(409, "An operations coordinator already owns this workspace.");
  let store: OperationStore;
  try { store = new OperationStore(path.join(state, "operations")); } catch (error) { release(); throw error; }
  try { store.bindWorkspace(root); } catch (error) { store.close(); release(); throw error; }
  let closing = false;
  let lastRequest = Date.now();
  let closeRunner: () => Promise<void> = async () => {};
  let submissions = Promise.resolve();
  let storageProblem: unknown;
  let admittingIndependent = false;
  // The existing checkout host owns local support processes too. Studio clients
  // can disappear without taking the watcher, client or their output pipes down.
  const runtimeBlocked = () => admittingIndependent || Boolean(storageProblem) || store.list().some(job => job.status === "running" || job.execution === "lost" || job.outcome === "uncertain");
  let runtime: DeployService | undefined;
  const localRuntime = () => runtime ??= new DeployService(root, () => {}, { ...options.runtime, stateDirectory: state, operations: false,
    observeExistingContainers: true, runtimeBlocked });
  let runtimeActive = false;
  let runtimeObservedAt = 0;
  const dispatch = (job: JobView) => {
    if (job.execution !== "accepted") return;
    const token = store.dispatch(job.id);
    if (!token) return;
    try {
      const child = spawn(process.execPath, ["--import", loader, worker, root, state, job.id, token], { cwd: root, env: process.env, stdio: "ignore", detached: true, windowsHide: true });
      child.once("error", () => {
        try { store.update(job.id, { execution: "lost", status: "interrupted", outcome: "uncertain", summary: "The worker could not be started. Inspect recorded dispatch evidence before another operation.", recovery: "Inspect the operation and its domain journal; this attempt will not be dispatched again." }); }
        catch (error) { storageProblem = error; }
      });
      child.unref();
    } catch (error) { storageProblem = error; }
  };
  let reconciling = false;
  const reconcile = async () => {
    if (closing || reconciling) return;
    reconciling = true;
    try {
      const owners = store.list().filter(job => job.execution === "running").map(job => store.get(job.id)!.owner!);
      const observe = await observeExecutions(owners);
      if (closing) return;
      store.reconcile(observe);
      const jobs = store.list();
      for (const job of jobs) {
        dispatch(job);
        if (job.execution === "lost" && job.outcome === "uncertain") {
          const recovered = reconcileOutcome(store.get(job.id)!, state);
          if (recovered?.outcome === "confirmed" && recovered.summary) store.reconcileConfirmed(job.id, { outcome: "confirmed", summary: recovered.summary, recovery: recovered.recovery });
        }
      }
      storageProblem = undefined;
      // Reuse this host's existing maintenance tick. Recovery has no browser
      // lifetime and does not add a second supervisor or a polling process.
      if ((runtime || existsSync(path.join(root, "docker-compose.yml"))) && Date.now() - runtimeObservedAt >= 5000) {
        runtimeObservedAt = Date.now();
        try {
          const local = await localRuntime().localStatus();
          runtimeActive = Boolean(local.activeContainerCount || local.watch.running || local.client.running || local.observationProblem);
        } catch { runtimeActive = true; }
      }
      if (Date.now() - lastRequest > 60_000 && !runtimeActive && !runtime?.jobs.running().length
        && !jobs.some(job => ["accepted", "dispatching", "running"].includes(job.execution ?? ""))) void closeRunner();
    } catch (error) { storageProblem = error; }
    finally { reconciling = false; }
  };
  const respond = (response: ServerResponse, status: number, result: unknown, authenticated?: AuthenticatedIpcRequest) => {
    const text = JSON.stringify(result), encoded = authenticated ? authenticated.encodeResponse(text) : text;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...authenticated?.responseHeaders(status, encoded) });
    response.end(encoded);
  };
  const server = createServer((request, response) => {
    let authenticated: AuthenticatedIpcRequest | undefined;
    void (async () => {
      const text = await body(request);
      authenticated = authentication.authenticateRequest(request, text);
      if (Buffer.byteLength(authenticated.body) > 64 * 1024) throw new OperationsError(413, "The operation intent is too large.");
      lastRequest = Date.now();
      if (request.headers["x-operations-version"] !== String(OPERATIONS_VERSION)) throw new OperationsError(409, "Operations protocol mismatch.");
      const url = new URL(request.url ?? "/", "http://local");
      if (request.method === "GET" && url.pathname === "/ping") return { version: OPERATIONS_VERSION, pid: process.pid, root, state, localRuntime: LOCAL_RUNTIME_CAPABILITY };
      if (storageProblem) throw new OperationsError(503, "Operation storage or recovery is unavailable. Preserve its files; no uncertain work will be restarted.");
      if (request.method === "GET" && url.pathname === "/local/status") return localRuntime().localStatus(url.searchParams.get("force") === "1");
      if (request.method === "POST" && url.pathname === "/local/perform") {
        let value: unknown;
        try { value = JSON.parse(authenticated.body); } catch { throw new OperationsError(400, "An operation request must be JSON."); }
        const intent = requestIntent(value);
        if (!LOCAL_KINDS.has(intent.kind)) throw new OperationsError(400, "This is not a local runtime operation.");
        // Record stop intent before joining either admission queue. An earlier
        // discovery may be awaiting Docker and must not start processes afterward.
        if (intent.kind === "local-stop") localRuntime().local.markStopped();
        let result!: JobView;
        const submitted = submissions.then(async () => {
          if (closing) throw new OperationsError(503, "The checkout host is stopping.");
          result = await localRuntime().perform(intent);
        });
        submissions = submitted.then(() => {}, () => {});
        await submitted;
        return result;
      }
      if (request.method === "GET" && url.pathname === "/operations") return [...store.list(), ...(runtime?.jobs.list() ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (request.method === "POST" && url.pathname === "/submit") {
        let value: unknown;
        try { value = JSON.parse(authenticated.body); } catch { throw new OperationsError(400, "An operation request must be JSON."); }
        const intent = requestIntent(value);
        validateRequest(intent);
        let result!: JobView;
        const submitted = submissions.then(async () => {
          if (closing) throw new OperationsError(503, "The coordinator is stopping; retry this request key after reconnecting.");
          const previous = store.findRequest(intent.requestKey!);
          if (previous) {
            if (canonicalRequest(previous.intent.request) !== canonicalRequest(intent)) throw new OperationsError(409, "This request key already identifies different operation intent.");
            result = previous.view;
            return;
          }
          admittingIndependent = true;
          try {
            if (runtime?.jobs.running().some(job => !isLocalProcessKind(job.kind))) throw new OperationsError(409, "A local workspace operation is running. Wait for it before starting independent work.");
            const prepared = await prepareIntent(root, state, intent);
            result = store.accept(prepared, intent.requestKey!);
            dispatch(result);
            result = store.get(result.id)!.view;
          } finally { admittingIndependent = false; }
        });
        submissions = submitted.then(() => {}, () => {});
        await submitted;
        return result;
      }
      const match = /^\/operations\/([A-Za-z0-9-]+)(?:\/(log|events|cancel))?$/.exec(url.pathname);
      if (!match) throw new OperationsError(404, "No such operations endpoint.");
      const [, id, action] = match;
      if (request.method === "GET" && !action) return store.get(id!) ?? null;
      if (request.method === "GET" && (action === "log" || action === "events")) {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new OperationsError(400, "Replay cursors are nonnegative sequence numbers.");
        if (runtime?.jobs.get(id!)) return action === "events" ? { events: [], lastSeq: 0 } : runtime.operationLog(id!, after);
        return action === "events" ? store.events(id!, after) : store.log(id!, after, 1000);
      }
      if (request.method === "POST" && action === "cancel") return runtime?.jobs.get(id!) ? runtime.cancelOperation(id!) : store.requestCancel(id!);
      throw new OperationsError(405, "Unsupported operations request method.");
    })().then(result => respond(response, 200, result, authenticated), error => {
      // Private input values and adapter exceptions must not leak through generic IPC errors.
      const status = typeof error?.status === "number" && error.status >= 400 && error.status <= 599 ? error.status : 503;
      respond(response, status, { error: status < 500 ? String(error.message) : "The operations runner could not durably complete this request. Existing operation evidence was preserved; inspect it before retrying a mutation." }, authenticated);
    });
  });
  try {
    if (!isNamedPipe(endpoint.socket) && existsSync(endpoint.socket)) {
      const stat = lstatSync(endpoint.socket);
      if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unsafe operations socket.");
      // Only the SQLite lease owner can remove an abandoned socket.
      unlinkSync(endpoint.socket);
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socket, resolve); });
    secureSocket(endpoint.socket);
    await reconcile();
  } catch (error) { server.close(); await runtime?.dispose(); closeIpcAuthentication(endpoint.socket); store.close(); release(); throw error; }
  const interval = setInterval(reconcile, 1000);
  closeRunner = async () => {
    if (closing) return;
    closing = true;
    clearInterval(interval);
    await submissions;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime?.dispose();
    closeIpcAuthentication(endpoint.socket);
    store.close();
    // Closing this server removes its socket before releasing singleton ownership.
    release();
  };
  return { close: closeRunner };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const [root, state] = process.argv.slice(2);
  if (!root || !state) process.exitCode = 2;
  else void startCoordinator(root, state).then(coordinator => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void coordinator.close().then(() => process.exit(0)); });
  }, error => {
    // A concurrently launched coordinator owns the endpoint; this contender exits.
    process.exitCode = error instanceof OperationsError && error.status === 409 ? 0 : 1;
  });
}

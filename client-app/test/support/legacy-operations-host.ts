import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { OPERATIONS_VERSION, type JobView, type OperationIntent } from "../../shared/operations";
import { processIdentity } from "aws-studio/source/identity";
import { closeIpcAuthentication, ipcAuthentication, privateEndpoint, secureSocket } from "../../server/operations/ipc";
import { OperationStore } from "../../server/operations/store";

const [root, state, mode] = process.argv.slice(2) as [string, string, string];
process.umask(0o077);
mkdirSync(state, { recursive: true });
const endpoint = privateEndpoint(root, state);
const store = new OperationStore(path.join(state, "operations"));
store.bindWorkspace(root);
if (mode === "active" || mode === "uncertain") {
  const intent: OperationIntent = { version: 1, workspace: root, request: { kind: "framework-check", params: {} }, locks: ["source"],
    view: { kind: "framework-check", title: "Legacy fixture operation", params: {} } };
  const job = store.accept(intent, "legacy-fixture-operation");
  if (mode === "uncertain") store.update(job.id, { status: "interrupted", execution: "lost", outcome: "uncertain" });
}
const identity = processIdentity(randomUUID());
const lease = new DatabaseSync(path.join(endpoint.directory, "coordinator.sqlite"));
lease.exec("CREATE TABLE owner (singleton INTEGER PRIMARY KEY, identity TEXT NOT NULL)");
lease.prepare("INSERT INTO owner VALUES (1,?)").run(JSON.stringify(mode === "stale-owner" ? { ...identity, started: identity.started + " stale" } : identity));
const authentication = ipcAuthentication(endpoint.socket, `operations:${OPERATIONS_VERSION}`);
const runtimeJobs: JobView[] = mode === "runtime-support" ? ["local-watch", "local-client", "local-logs"].map(kind => ({
  id: `fixture-${kind}`, kind: kind as JobView["kind"], title: "Existing runtime support process", params: {}, status: "running", startedAt: new Date().toISOString(), lastSeq: 0,
})) : mode === "runtime-active" || mode === "runtime-uncertain" ? [{
  id: "fixture-local-start", kind: "local-start", title: "Existing local startup", params: {}, startedAt: new Date().toISOString(), lastSeq: 0,
  ...(mode === "runtime-active" ? { status: "running" as const } : { status: "interrupted" as const, execution: "lost" as const, outcome: "uncertain" as const }),
}] : [];
const server = createServer((request, response) => {
  void (async () => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const auth = authentication.authenticateRequest(request, text);
    if (request.url === "/operations" && mode === "runtime-late-active") {
      mkdirSync(path.join(state, "jobs"), { recursive: true });
      writeFileSync(path.join(state, "jobs", "fixture-local-start.json"), JSON.stringify({
        id: "fixture-local-start", kind: "local-start", status: "running", title: "Just accepted startup", params: {}, startedAt: new Date().toISOString(), lastSeq: 0,
      }));
    }
    let stopped: JobView | undefined;
    if (request.url === "/local/perform" && mode.startsWith("runtime-") && JSON.parse(auth.body).kind === "local-stop") {
      stopped = { id: "fixture-local-stop", kind: "local-stop", title: "Stopped existing runtime", params: {}, status: "succeeded", startedAt: new Date().toISOString(), lastSeq: 0 };
      runtimeJobs.splice(0, runtimeJobs.length, stopped);
    }
    const payload = request.url === "/ping" ? { version: OPERATIONS_VERSION, pid: process.pid, root: mode === "foreign" ? root + "-foreign" : root, state, ...(mode === "unsupported" ? { localRuntime: 999 } : mode.startsWith("runtime-") ? { localRuntime: 1 } : {}) }
      : request.url === "/operations" ? [...store.list(), ...runtimeJobs] : stopped ?? { error: "No such operations endpoint." };
    const status = request.url === "/ping" || request.url === "/operations" || stopped ? 200 : 404;
    const encoded = auth.encodeResponse(JSON.stringify(payload));
    response.writeHead(status, { "content-type": "application/json", ...auth.responseHeaders(status, encoded) });
    response.end(encoded);
  })().catch(() => { response.writeHead(503); response.end(); });
});
server.listen(endpoint.socket, () => secureSocket(endpoint.socket));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  const close = () => server.close(() => { writeFileSync(path.join(state, "graceful-close"), "closed\n"); closeIpcAuthentication(endpoint.socket); store.close(); lease.close(); process.exit(0); });
  if (mode === "runtime-draining") setTimeout(close, 750);
  else close();
});

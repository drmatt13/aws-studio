import assert from "./support/assert";
import { test } from "node:test";
import { deriveRuntimeLifecycle, runtimeOperationKind } from "../shared/local-lifecycle";
import type { LocalRunView } from "../shared/deploy";

type Input = Parameters<typeof deriveRuntimeLifecycle>[0];
const at = "2026-11-10T00:00:00Z";
const view = (patch: Partial<Input> = {}): Input => ({
  docker: { engine: "running", desktop: true }, activeContainerCount: 3, restartNeeded: [],
  readiness: { state: "ready", observedAt: at, message: "Ready" }, ...patch,
});

test("a runtime is exactly off, starting, running or stopping, whatever the browser did", () => {
  assert.equal(deriveRuntimeLifecycle(view()), "running");
  assert.equal(deriveRuntimeLifecycle(view({ activeContainerCount: 0, readiness: { state: "stopped", observedAt: at, message: "" } })), "off");
  assert.equal(deriveRuntimeLifecycle(view({ readiness: { state: "starting", observedAt: at, message: "Waiting", progressing: true } })), "starting");
  assert.equal(deriveRuntimeLifecycle(view(), "local-stop"), "stopping");
  for (const kind of ["local-start", "local-restart", "local-attach-watch"] as const) assert.equal(deriveRuntimeLifecycle(view({ activeContainerCount: 0 }), kind), "starting");
});

test("a host operation outranks what the containers look like at that instant", () => {
  assert.equal(deriveRuntimeLifecycle(view({ activeContainerCount: 0, readiness: { state: "stopped", observedAt: at, message: "" } }), "local-start"), "starting");
  assert.equal(deriveRuntimeLifecycle(view({ activeContainerCount: 0 }), "local-stop"), "stopping");
  assert.equal(deriveRuntimeLifecycle(view({ observationProblem: "Docker is unreadable" }), "local-stop"), "stopping");
});

test("Docker going away, or only Docker-revived infrastructure surviving, is simply off", () => {
  // activeContainerCount counts application compute; restart-policy infrastructure is not a session.
  assert.equal(deriveRuntimeLifecycle(view({ docker: { engine: "stopped", desktop: true }, activeContainerCount: 0 })), "off");
  assert.equal(deriveRuntimeLifecycle(view({ activeContainerCount: 0, readiness: { state: "blocked", observedAt: at, message: "Needs attention: api" } })), "off");
});

test("what cannot be observed is unknown, never off", () => {
  assert.equal(deriveRuntimeLifecycle(view({ observationProblem: "Could not read containers", activeContainerCount: undefined })), undefined);
  assert.equal(deriveRuntimeLifecycle(view({ docker: { engine: "unknown", desktop: true }, activeContainerCount: undefined })), undefined);
});

test("live compute that is stalled or unhealthy needs attention instead of pretending to start or run", () => {
  assert.equal(deriveRuntimeLifecycle(view({ readiness: { state: "blocked", observedAt: at, message: "Needs attention: api" } })), "attention");
  assert.equal(deriveRuntimeLifecycle(view({ readiness: { state: "starting", observedAt: at, message: "Waiting for local containers: api", progressing: false } })), "attention");
  assert.equal(deriveRuntimeLifecycle(view({ recovery: { state: "failed", message: "Port is occupied" } })), "attention");
  assert.equal(deriveRuntimeLifecycle(view({ restartNeeded: ["api"] })), "attention");
  assert.equal(deriveRuntimeLifecycle(view({ activeContainerCount: 1, readiness: { state: "stopped", observedAt: at, message: "" } })), "attention", "runner work without Compose services still has to be stopped");
});

test("reconnecting and warm-up are starting; a missing readiness verdict never claims running", () => {
  assert.equal(deriveRuntimeLifecycle(view({ recovery: { state: "reconnecting", message: "Reconnecting" } })), "starting");
  assert.equal(deriveRuntimeLifecycle(view({ readiness: { state: "starting", observedAt: at, message: "Waiting" } })), "starting", "progress is assumed unless the host proves a stall");
  assert.equal(deriveRuntimeLifecycle(view({ readiness: undefined })), "attention");
});

test("the host operation kind names an in-flight local operation and nothing else", () => {
  const job = (kind: string, status = "running") => ({ kind, status }) as never;
  assert.equal(runtimeOperationKind(job("local-start")), "local-start");
  assert.equal(runtimeOperationKind(job("local-stop")), "local-stop");
  assert.equal(runtimeOperationKind(job("local-restart")), "local-restart");
  assert.equal(runtimeOperationKind(job("local-attach-watch")), "local-attach-watch");
  assert.equal(runtimeOperationKind(job("local-watch")), undefined, "supervised support processes are not operations");
  assert.equal(runtimeOperationKind(undefined), undefined);
});

// Compile-time contract: the server ships the verdict to every tab on LocalRunView.
const _shape: Pick<LocalRunView, "lifecycle" | "operation"> = { lifecycle: "off", operation: { kind: "local-start", id: "job" } };
void _shape;

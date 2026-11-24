import assert from "./support/assert";
import { test } from "node:test";
import type { JobView, LocalRunView, StatusView, StackView } from "../shared/deploy";
import { localRuntimeActive, mergeLocalRuntime, runtimePresentation, runtimeStartEligibility, runtimeStepCaption, runtimeVisible } from "../src/deploy/local-runtime-state";
import { LOCAL_START_STEPS, LOCAL_STOP_STEPS } from "../shared/operations";

const destination = { deployment: "example-dev", profile: "dev", account: "123456789012", region: "us-east-1" };
const local: LocalRunView = {
  project: "example", docker: { engine: "running", desktop: true },
  services: [{ name: "api", container: "example-api", state: "running", health: "healthy", oneShot: false, ports: "" }],
  watch: { running: true }, client: { running: true }, exported: { ...destination, client: true },
  binding: { ...destination, startedAt: "2026-11-05T00:00:00Z" },
  readiness: { state: "ready", observedAt: "2026-11-05T00:00:01Z", message: "Ready" },
  startedBy: "studio", profile: "dev", restartNeeded: [], activeContainerCount: 1, lifecycle: "running",
};
/** What the checkout host reports for each lifecycle; the browser only presents it. */
const hostView = (lifecycle: NonNullable<LocalRunView["lifecycle"]>, patch: Partial<LocalRunView> = {}): LocalRunView => ({ ...local, lifecycle, ...patch });
const off = hostView("off", { services: [], activeContainerCount: 0, watch: { running: false }, client: { running: false }, startedBy: "none", binding: undefined,
  readiness: { state: "stopped", observedAt: "2026-11-05T00:00:04Z", message: "Stopped" } });
const job: JobView = { id: "start", kind: "local-start", title: "Start development", params: destination, status: "running", startedAt: "2026-11-05T00:00:00Z", lastSeq: 0 };

test("the switch shows exactly what the checkout host reports: off, starting, running, stopping", () => {
  assert.equal(runtimePresentation({ local }).label, "Running");
  assert.equal(runtimePresentation({ local: off }).label, "Stopped");
  assert.equal(runtimePresentation({ local: hostView("starting") }).label, "Starting…");
  assert.equal(runtimePresentation({ local: hostView("stopping") }).label, "Stopping…");
  const cliRuntime = { ...local, profile: undefined, binding: undefined, startedBy: "outside" as const };
  assert.equal(runtimePresentation({ local: cliRuntime }).label, "Running", "verified local health does not require Studio or AWS metadata");
  assert.deepEqual(runtimePresentation({ local: off }), { active: false, ready: false, busy: false, label: "Stopped", phase: undefined, on: false });
  assert.deepEqual(runtimePresentation({ local }), { active: true, ready: true, busy: false, label: "Running", phase: undefined, on: true });
});

test("no setup, partial, recovery or reconnect vocabulary: those conditions resolve to starting, needs attention or stopped", () => {
  const labels = new Set<string>();
  for (const view of [
    off, local, hostView("starting"), hostView("stopping"), hostView("attention"),
    hostView("attention", { recovery: { state: "failed", message: "Client port is occupied." } }),
    hostView("starting", { recovery: { state: "reconnecting", message: "Resuming web client." } }),
    hostView("attention", { readiness: { state: "blocked", observedAt: "2026-11-10T00:00:00Z", message: "This checkout needs local development settings." } }),
    hostView("attention", { restartNeeded: ["api"] }),
  ]) labels.add(runtimePresentation({ local: view }).label);
  assert.deepEqual([...labels].sort(), ["Needs attention", "Running", "Starting…", "Stopped", "Stopping…"]);
});

test("reconnecting is starting and stays stoppable; a runtime that needs attention stays on and stoppable", () => {
  const reconnecting = runtimePresentation({ local: hostView("starting", { recovery: { state: "reconnecting", message: "Resuming web client." } }) });
  assert.equal(reconnecting.label, "Starting…"); assert.equal(reconnecting.ready, false); assert.equal(reconnecting.busy, false); assert.equal(reconnecting.on, true); assert.equal(reconnecting.phase, "starting");
  const resuming = runtimePresentation({ local, job: { ...job, kind: "local-attach-watch" } });
  assert.equal(resuming.label, "Starting…"); assert.equal(resuming.busy, false);
  const attention = runtimePresentation({ local: hostView("attention", { recovery: { state: "failed", message: "Client port is occupied." } }) });
  assert.equal(attention.label, "Needs attention"); assert.equal(attention.ready, false); assert.equal(attention.busy, false); assert.equal(attention.on, true); assert.equal(attention.active, true);
  const conflict = runtimePresentation({ local: { ...local, lifecycle: undefined, ownershipConflict: "This Compose project belongs to another checkout.", observationProblem: "Cannot inspect local runtime." }, problem: "Cannot inspect local runtime." });
  assert.equal(conflict.label, "Ownership conflict"); assert.equal(conflict.ready, false);
});

test("any tab sees an operation another tab started, from the host alone", () => {
  // No job list has loaded in this tab and nothing was submitted here.
  const starting = runtimePresentation({ local: hostView("starting", { operation: { kind: "local-start", id: "other-tab" } }) });
  assert.deepEqual(starting, { active: true, ready: false, busy: true, label: "Starting…", phase: "starting", on: true });
  const stopping = runtimePresentation({ local: hostView("stopping", { operation: { kind: "local-stop", id: "other-tab" } }) });
  assert.deepEqual(stopping, { active: true, ready: false, busy: true, label: "Stopping…", phase: "stopping", on: true });
  // The host starts from nothing: containers are not up yet, so the switch must already be on.
  const booting = runtimePresentation({ local: { ...off, lifecycle: "starting", operation: { kind: "local-start", id: "other-tab" } } });
  assert.equal(booting.label, "Starting…"); assert.equal(booting.on, true); assert.equal(booting.busy, true);
});

test("a freshly loaded page reads a running session as running and a dead one as stopped, with nothing remembered", () => {
  assert.equal(runtimePresentation({ local }).label, "Running");
  assert.equal(runtimePresentation({ local }).ready, true);
  assert.equal(runtimePresentation({ local: off }).label, "Stopped");
  assert.equal(runtimePresentation({ local: off }).on, false, "off means the switch is off");
  assert.equal(runtimePresentation({}).label, "Checking…", "before the first observation nothing is claimed");
  const legacy = { ...off, lifecycle: undefined };
  assert.equal(runtimePresentation({ local: legacy }).label, "Checking…", "an older host without a verdict cannot confirm Stopped");
  assert.equal(runtimePresentation({ local: { ...legacy, operation: { kind: "local-start", id: "starting" } } }).label, "Starting…");
});

test("launch acceptance never advertises a running runtime, and failure returns to a plain stopped", () => {
  const starting = hostView("starting");
  assert.deepEqual(runtimePresentation({ local: starting, job }), { active: true, ready: false, busy: true, label: "Starting…", phase: "starting", on: true });
  const failed = runtimePresentation({ local: off, job: { ...job, status: "failed" } });
  assert.equal(failed.label, "Stopped", "a failed start leaves the runtime off; Details and Activity say why"); assert.equal(failed.on, false); assert.equal(failed.active, false);
  const partial = runtimePresentation({ local: hostView("attention"), job: { ...job, status: "failed" } });
  assert.equal(partial.label, "Needs attention"); assert.equal(partial.on, true); assert.equal(partial.phase, undefined);
  const stopping = runtimePresentation({ local, job: { ...job, kind: "local-stop" } });
  assert.equal(stopping.label, "Stopping…"); assert.equal(stopping.on, true); assert.equal(stopping.phase, "stopping");
  const warming = runtimePresentation({ local: starting, job: { ...job, status: "succeeded" } });
  assert.equal(warming.label, "Starting…", "a finished command whose services are still coming up is starting");
  assert.equal(warming.phase, "starting"); assert.equal(warming.busy, false, "and can still be stopped"); assert.equal(warming.ready, false);
  const succeeded = { ...job, status: "succeeded" as const };
  const settling = runtimePresentation({ local: off, job: succeeded, unobserved: true });
  assert.equal(settling.label, "Starting…", "an observation read before the start finished does not report it stopped");
  assert.equal(settling.phase, "starting"); assert.equal(settling.busy, false); assert.equal(settling.on, true);
  assert.equal(runtimePresentation({ local, job: succeeded, unobserved: true }).label, "Starting…", "nor running before it is seen");
  assert.equal(runtimePresentation({ local: off, job: succeeded }).label, "Stopped", "a newer observation is believed");
  const drained = runtimePresentation({ local, job: { ...succeeded, kind: "local-stop" }, unobserved: true });
  assert.equal(drained.label, "Stopping…", "a finished stop never flashes back to running"); assert.equal(drained.phase, "stopping"); assert.equal(drained.ready, false);
  assert.equal(runtimePresentation({ local, job: { ...succeeded, kind: "local-stop" } }).label, "Running", "until the runtime is observed");
  assert.equal(runtimePresentation({ local: off, job: { ...succeeded, status: "failed" }, unobserved: true }).label, "Stopped");
  assert.equal(runtimePresentation({ local, job: { ...succeeded, kind: "local-stop" }, unobserved: true, problem: "Docker is unreadable" }).label, "Status unavailable");
  assert.equal(runtimePresentation({ local, job: { ...job, kind: "local-restart" } }).ready, false);
});

test("the switch narrates the running step and falls back to a plain verb", () => {
  const at = (label: string, kind: JobView["kind"] = "local-start"): JobView => ({ ...job, kind, steps: [
    { label: LOCAL_START_STEPS.verify, status: "done" }, { label, status: "running" }] });
  assert.equal(runtimeStepCaption(at(LOCAL_START_STEPS.database)), "Preparing database…");
  assert.equal(runtimeStepCaption(at(LOCAL_START_STEPS.environment)), "Generating client environment…");
  assert.equal(runtimeStepCaption(at(LOCAL_START_STEPS.containers)), "Starting containers…");
  assert.equal(runtimeStepCaption(at("Export example-dev's outputs")), "Exporting outputs…");
  assert.equal(runtimeStepCaption(at(LOCAL_STOP_STEPS.containers, "local-stop")), "Stopping containers…");
  assert.equal(runtimeStepCaption(at("An unknown future step")), undefined);
  assert.equal(runtimeStepCaption({ ...at(LOCAL_START_STEPS.database), status: "failed" }), undefined, "only a running job narrates");
  const starting = hostView("starting");
  assert.equal(runtimePresentation({ local: starting, job: at(LOCAL_START_STEPS.client) }).label, "Starting web client…");
  assert.equal(runtimePresentation({ local: starting, job: at("An unknown future step") }).label, "Starting…");
  assert.equal(runtimePresentation({ local, job: at(LOCAL_STOP_STEPS.client, "local-stop") }).label, "Stopping web client…");
  assert.equal(runtimePresentation({ local, job: at(LOCAL_START_STEPS.database), submitting: "local-stop" }).label, "Stopping…",
    "a submitted stop never shows the previous job's step");
});

test("a failed observation clears live status while retaining evidence for explanation", () => {
  const unavailable = runtimePresentation({ local, problem: "Docker is unavailable" });
  assert.equal(unavailable.label, "Status unavailable"); assert.equal(unavailable.ready, false); assert.equal(unavailable.on, true); assert.equal(unavailable.active, true);
  assert.equal(runtimePresentation({}).label, "Checking…");
  assert.equal(localRuntimeActive(local), true);
  assert.equal(localRuntimeActive(off), false, "Docker-revived infrastructure and leftover support processes are not a session");
  assert.equal(localRuntimeActive(hostView("starting")), true);
  assert.equal(localRuntimeActive(hostView("attention")), true, "a runtime that needs attention still has to be stoppable");
  assert.equal(localRuntimeActive({ ...local, lifecycle: undefined }), false, "no verdict is never engagement on its own");
  assert.equal(localRuntimeActive(undefined), false);
  const unknown = mergeLocalRuntime(local, { ...off, lifecycle: undefined, observationProblem: "Could not read Docker." });
  assert.equal(localRuntimeActive(unknown), true, "unknown observations preserve the need to stop");
  assert.equal(runtimePresentation({ local: unknown, problem: unknown.observationProblem }).ready, false);
  assert.equal(localRuntimeActive(mergeLocalRuntime(unknown, off)), false, "a successful off observation clears retained activity");
  const conflict = mergeLocalRuntime(local, { ...off, lifecycle: undefined, observationProblem: "Ownership conflict", ownershipConflict: "Another checkout owns this project." });
  assert.equal(runtimePresentation({ local: conflict, problem: conflict.observationProblem }).label, "Ownership conflict",
    "retained activity never hides a newly confirmed ownership conflict");
});

test("unknown observations retain engagement without keeping a finished operation busy", () => {
  const unknown: LocalRunView = { ...off, lifecycle: undefined, activeContainerCount: undefined,
    observationProblem: "Docker status is unavailable." };
  for (const kind of ["local-start", "local-stop"] as const) {
    const inFlight = hostView(kind === "local-stop" ? "stopping" : "starting", { operation: { kind, id: job.id } });
    const retained = mergeLocalRuntime(inFlight, unknown);
    assert.equal(retained.operation, undefined, "the host no longer reports this operation running");
    const finished = { ...job, kind, status: "failed" as const };
    const existingTab = runtimePresentation({ local: retained, problem: retained.observationProblem, job: finished });
    const newTab = runtimePresentation({ local: unknown, problem: unknown.observationProblem, job: finished });
    assert.equal(existingTab.label, newTab.label, "both tabs report the unavailable status");
    assert.equal(existingTab.label, "Status unavailable");
    assert.equal(existingTab.busy, false, "a failed stop can be retried instead of remaining disabled");
    assert.equal(existingTab.phase, undefined);
    assert.equal(existingTab.active, true, "last-known engagement keeps Stop available");
    assert.equal(existingTab.on, true);
    assert.equal(existingTab.ready, false);
    const nextOperation = hostView("stopping", { operation: { kind: "local-stop", id: "retry-stop" },
      observationProblem: unknown.observationProblem });
    const retrying = runtimePresentation({ local: mergeLocalRuntime(retained, nextOperation), problem: unknown.observationProblem });
    assert.equal(retrying.label, "Stopping…", "a current host operation still reports its transition");
    assert.equal(retrying.busy, true);
    assert.equal(localRuntimeActive(mergeLocalRuntime(retained, off)), false, "a confirmed shutdown clears engagement");
  }
});

const stack: StackView = { name: "example-dev-Core", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "example-dev", mode: "dev" } };
const status: StatusView = {
  deployment: "example-dev", context: { ...destination, arn: "arn:aws:iam::123456789012:role/developer" },
  targets: [], deployments: [], unrecognized: [], unreadable: [], records: {}, observedAt: "2026-11-05T00:00:01Z",
  detail: { name: "example-dev", mode: "dev", account: destination.account, region: destination.region, stacks: [stack], contracts: [2],
    state: { kind: "ready", stacks: [stack] }, events: [], changeSets: [], local: { compatible: true, exported: { client: true, fresh: true } } },
};
const eligibility = { scope: { repository: "/fixture", sourceRevision: "one", generation: "one", mode: "dev" as const, ...destination },
  target: { name: "example-dev", mode: "dev" as const, account: destination.account, region: destination.region },
  availability: "available", status, retained: false, fetching: false, local, operationsKnown: true };

test("the map hides idle local runtime until the selected development deployment is verified", () => {
  assert.equal(runtimeVisible({ ...eligibility, engaged: false }), true);
  for (const input of [
    { ...eligibility, status: undefined },
    { ...eligibility, retained: true },
    { ...eligibility, availability: "missing-profile" },
    { ...eligibility, problem: { kind: "failed" as const, message: "AWS unavailable" } },
    { ...eligibility, status: { ...status, deployment: "another-app-dev" } },
    { ...eligibility, status: { ...status, context: { ...status.context, account: "999999999999" } } },
    ...(["absent", "in-progress", "failed", "rolled-back"] as const).map(kind => ({ ...eligibility,
      status: { ...status, detail: { ...status.detail!, state: { ...status.detail!.state, kind } } } as StatusView })),
  ]) assert.equal(runtimeVisible({ ...input, engaged: false }), false);
  const absent = { ...eligibility, status: { ...status, detail: { ...status.detail!, state: { kind: "absent" } } } as StatusView };
  assert.equal(runtimeVisible({ ...absent, engaged: true }), false, "confirmed absence hides the runtime card");
  assert.equal(runtimeVisible({ ...eligibility, status: undefined, engaged: true }), true, "active local work remains stoppable when AWS is unavailable");
});

test("only a positively verified complete compatible dev deployment enables startup", () => {
  assert.equal(runtimeStartEligibility(eligibility).blocked, false);
  for (const input of [
    { ...eligibility, scope: { ...eligibility.scope, profile: undefined } },
    { ...eligibility, status: undefined }, { ...eligibility, retained: true },
    { ...eligibility, availability: "unavailable-profile" },
    { ...eligibility, status: { ...status, detail: undefined } },
    { ...eligibility, status: { ...status, context: { ...status.context, account: "999999999999" } } },
    ...(["absent", "in-progress", "failed", "rolled-back"] as const).map(kind => ({ ...eligibility,
      status: { ...status, detail: { ...status.detail!, state: { ...status.detail!.state, kind } } } as StatusView })),
    { ...eligibility, status: { ...status, detail: { ...status.detail!, local: { compatible: false, exported: { client: true, fresh: true } } } } },
    { ...eligibility, status: { ...status, detail: { ...status.detail!, stacks: [{ ...stack, health: "in-progress" as StackView["health"] }] } } },
    { ...eligibility, status: { ...status, detail: { ...status.detail!, stacks: [{ ...stack, status: "UPDATE_IN_PROGRESS" }] } } },
  ]) assert.equal(runtimeStartEligibility(input).blocked, true);
});

test("unknown host state and pending or uncertain operations never enable startup", () => {
  for (const input of [{ ...eligibility, local: undefined }, { ...eligibility, local: { ...off, lifecycle: undefined } }, { ...eligibility, localProblem: "Docker is unreadable" },
    { ...eligibility, operationsKnown: false }, { ...eligibility, work: { ...job, kind: "deploy-apply" as const } },
    { ...eligibility, work: { ...job, status: "failed" as const, execution: "lost" as const } }])
    assert.equal(runtimeStartEligibility(input).blocked, true);
});

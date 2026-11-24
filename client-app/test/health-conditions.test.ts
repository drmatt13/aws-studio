import assert from "./support/assert";
import test from "node:test";
import type { Diagnostic, Mode, ModeModel } from "../shared/model";
import type { SourceWatchState } from "../shared/watch";
import { healthAgentPrompt, healthConditions, healthIndicator, type HealthInputs } from "../src/health/conditions";

const healthyModel = (mode: Mode): ModeModel => ({ mode, status: "ok", targets: [{}], routes: [], resources: [], edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 1 } as unknown as ModeModel);
const models = (dev: Partial<ModeModel> = {}, prod: Partial<ModeModel> = {}) => ({ dev: { ...healthyModel("dev"), ...dev }, prod: { ...healthyModel("prod"), ...prod } });
const inputs = (overrides: Partial<HealthInputs> = {}): HealthInputs => ({ models: models(), sourceProblems: [], sourceWatch: undefined, repositoryRoot: "/repo", ...overrides });
const loadError: Diagnostic = {
  severity: "error", stage: "load",
  message: 'Transform failed with 1 error:\n/repo/framework-config/tasks/worker-task.ts:12:19: ERROR: Expected identifier but found ","',
  location: { file: "framework-config/tasks/worker-task.ts", line: 12, column: 19 },
};
const stale = { status: "error", stale: true, diagnostics: [loadError] } as const;
const watch = (status: SourceWatchState["status"]): SourceWatchState => ({ status, checkedAt: "2026-11-06T12:00:00.000Z", pollIntervalMs: 5000, problems: [{ path: "framework-config", code: "EMFILE" }] });
const capability = (condition: { capabilities: readonly { state: string; name: string }[] }, state: string) => condition.capabilities.filter(item => item.state === state).map(item => item.name).join(" ");

test("a healthy repository has no conditions and a calm indicator", () => {
  assert.deepEqual(healthConditions(inputs()), []);
  assert.equal(healthIndicator([]).severity, "healthy");
});

test("one failure reported by both modes is one condition with one finding", () => {
  const [condition, ...rest] = healthConditions(inputs({ models: models(stale, stale) }));
  assert.deepEqual(rest, []);
  assert.equal(condition!.id, "configuration");
  assert.equal(condition!.severity, "error");
  assert.equal(condition!.findings.length, 1);
  assert.deepEqual(condition!.findings[0]!.modes, ["dev", "prod"]);
});

test("a failure in the mode not being viewed still counts, because the server refuses edits for either", () => {
  const [condition] = healthConditions(inputs({ models: models({}, stale) }));
  assert.equal(condition?.id, "configuration");
  assert.deepEqual(condition?.findings[0]?.modes, ["prod"]);
});

test("the finding reads as the error itself, without transformer wrapping or absolute paths", () => {
  const [condition] = healthConditions(inputs({ models: models(stale, stale) }));
  assert.equal(condition!.findings[0]!.summary, 'Expected identifier but found ","');
  assert.deepEqual(condition!.findings[0]!.location, loadError.location);
});

test("a missing module reads as its first line, keeping the import stack as detail", () => {
  const message = "Cannot find module './nope'\nRequire stack:\n- /repo/framework-config/a.ts\n- /repo/framework.config.ts";
  const [condition] = healthConditions(inputs({ models: models({ ...stale, diagnostics: [{ severity: "error", stage: "load", message }] }) }));
  assert.equal(condition!.findings[0]!.summary, "Cannot find module './nope'");
  assert.equal(condition!.findings[0]!.detail, "Require stack:\n- framework-config/a.ts\n- framework.config.ts");
});

test("a finding's stage is kept where it adds something, and dropped where the title already says it", () => {
  const validation: Diagnostic = { severity: "error", stage: "validate", message: "Two routes claim /orders." };
  assert.equal(healthConditions(inputs({ models: models({ status: "error", diagnostics: [validation] }) }))[0]!.findings[0]!.stage, "validate");
  assert.equal(healthConditions(inputs({ models: models(stale, stale) }))[0]!.findings[0]!.stage, undefined);
});

test("a stale view is named as the last loaded version and says when that was", () => {
  const [condition] = healthConditions(inputs({ models: models(stale, stale), lastLoadedAt: "2026-11-06T14:14:00" }));
  assert.equal(condition!.showsLastLoaded, true);
  assert.match(condition!.explanation, /last loaded at 2:14\sPM/);
  assert.match(capability(condition!, "last-loaded"), /Map/);
});

test("the last loaded time is omitted rather than guessed when this tab never saw a good load", () => {
  const [condition] = healthConditions(inputs({ models: models(stale, stale) }));
  assert.match(condition!.explanation, /last loaded[,.]/);
  assert.doesNotMatch(condition!.explanation, /\d:\d\d/);
});

test("capabilities separate what is refused from what keeps working", () => {
  const [condition] = healthConditions(inputs({ models: models(stale, stale) }));
  assert.match(capability(condition!, "paused"), /Inspector/);
  assert.match(capability(condition!, "paused"), /Add to application/);
  assert.match(capability(condition!, "working"), /Activity/);
  assert.match(capability(condition!, "working"), /Database/);
  assert.match(capability(condition!, "working"), /local runtime/i);
  assert.doesNotMatch(capability(condition!, "paused"), /Deploy|Database|Activity/, "the server does not refuse these");
  assert.match(capability(condition!, "caution"), /Synthesize/);
});

test("validation errors keep the map current and never claim it is the last loaded version", () => {
  const diagnostics: Diagnostic[] = [{ severity: "error", stage: "validate", message: "Two routes claim /orders.", entity: "lambda:orders" }];
  const [condition] = healthConditions(inputs({ models: models({ status: "error", diagnostics }, { status: "error", diagnostics }) }));
  assert.equal(condition!.severity, "error");
  assert.equal(condition!.showsLastLoaded, false);
  assert.equal(capability(condition!, "last-loaded"), "");
  assert.match(capability(condition!, "paused"), /Inspector/);
  assert.equal(condition!.findings[0]!.entity, "lambda:orders");
});

test("a first load that fails says there is no earlier version to show", () => {
  const failed = { status: "error", targets: [], diagnostics: [loadError] } as const;
  const [condition] = healthConditions(inputs({ models: models(failed, failed) }));
  assert.equal(condition!.showsLastLoaded, false);
  assert.match(condition!.explanation, /no earlier version/i);
});

test("a polling watcher is a warning that keeps its interval, evidence and recovery action", () => {
  const [condition] = healthConditions(inputs({ sourceWatch: watch("polling") }));
  assert.equal(condition!.id, "source-watch");
  assert.equal(condition!.severity, "warning");
  assert.match(condition!.explanation, /every 5s/);
  assert.equal(condition!.action, "reload-source");
  assert.deepEqual(condition!.findings.map(item => item.summary), ["framework-config: EMFILE"]);
  assert.equal(capability(condition!, "paused"), "", "polling refuses nothing");
});

test("an unavailable watcher is reported as unknown freshness rather than interrupted polling", () => {
  const [condition] = healthConditions(inputs({ sourceWatch: watch("unavailable") }));
  assert.equal(condition!.title, "Source freshness is unknown");
  assert.doesNotMatch(condition!.explanation, /every 5s/);
});

test("a running watcher raises nothing", () => {
  assert.deepEqual(healthConditions(inputs({ sourceWatch: { ...watch("watching"), problems: [] } })), []);
});

test("a failed refresh leads, keeps the server's message, and offers a retry", () => {
  const conditions = healthConditions(inputs({ models: models(stale, stale), sourceWatch: watch("polling"), refreshFailure: "Network request failed" }));
  assert.deepEqual(conditions.map(item => item.id), ["connection", "configuration", "source-watch"]);
  assert.equal(conditions[0]!.action, "retry-refresh");
  assert.equal(conditions[0]!.findings[0]!.summary, "Network request failed");
  assert.equal(conditions[0]!.askAgent, false, "the agent runs on the same server");
});

test("warnings and source problems are notes that never raise a toast", () => {
  const diagnostics: Diagnostic[] = [{ severity: "warning", stage: "cloud-edges", message: "A queue has no consumer." }];
  const [condition] = healthConditions(inputs({ models: models({ diagnostics }, { diagnostics }), sourceProblems: ["A declaration file could not be indexed."] }));
  assert.equal(condition!.id, "notes");
  assert.equal(condition!.severity, "notice");
  assert.equal(condition!.raised, undefined);
  assert.equal(condition!.findings.length, 2);
});

test("a warning shown beside a load failure stays a note, not a second alarm", () => {
  const warning: Diagnostic = { severity: "warning", stage: "cloud-edges", message: "A queue has no consumer." };
  const conditions = healthConditions(inputs({ models: models({ ...stale, diagnostics: [loadError, warning] }) }));
  assert.deepEqual(conditions.map(item => item.id), ["configuration", "notes"]);
});

test("the indicator reports the most severe condition by file and line, and counts the rest", () => {
  const indicator = healthIndicator(healthConditions(inputs({ models: models(stale, stale), sourceWatch: watch("polling") })));
  assert.equal(indicator.severity, "error");
  assert.equal(indicator.label, "worker-task.ts:12");
  assert.equal(indicator.additional, 1);
  assert.equal(indicator.showsLastLoaded, true);
  assert.match(indicator.description, /worker-task\.ts line 12/);
  assert.match(indicator.description, /Editing is paused/);
});

test("the indicator falls back to a plain label when the failure has no location", () => {
  const diagnostics: Diagnostic[] = [{ severity: "error", stage: "load", message: "Snapshot refresh failed (EIO)." }];
  const indicator = healthIndicator(healthConditions(inputs({ models: models({ ...stale, diagnostics }) })));
  assert.equal(indicator.label, "Configuration error");
});

test("the agent prompt carries each location and error but never an absolute path", () => {
  const [condition] = healthConditions(inputs({ models: models(stale, stale) }));
  const prompt = healthAgentPrompt(condition!);
  assert.match(prompt, /framework-config\/tasks\/worker-task\.ts:12:19/);
  assert.match(prompt, /Expected identifier but found ","/);
  assert.doesNotMatch(prompt, /\/repo\//);
});

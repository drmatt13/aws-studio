import assert from "./support/assert";
import { test } from "node:test";
import { projectModel } from "../server/model/project";
import type { FrameworkConfig } from "aws-studio/config";
import type { ModeModel, ModelEdge, ModelResource, ModelTarget, Snapshot, SourceIndex } from "../shared/model";
import type { TriggerCapability } from "../shared/triggers";
import { accessConnectionExists, configuredAccessOptions, permissionAccessOptions } from "../src/access-options";

const base = (): ModeModel => projectModel({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
  http: { "/caller": { directory: "compute/http/caller", methods: ["GET"] } }, webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {} } as FrameworkConfig, { mode: "prod" });
const caller = base().targets[0]!;
const model = (extra: Partial<ModeModel> = {}): ModeModel => ({ ...base(), resources: [], edges: [], ...extra });
const source = (capabilities: readonly TriggerCapability[] = []): SourceIndex => ({ entities: {}, editability: {}, catalog: {}, links: {}, problems: [],
  cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, triggerCapabilities: capabilities });
const snapshot = (dev: ModeModel, prod = dev, capabilities: readonly TriggerCapability[] = []): Pick<Snapshot, "models" | "source"> => ({ models: { dev, prod }, source: source(capabilities) });
const resource = (path: string, extra: Partial<ModelResource> = {}): ModelResource => ({ id: `resource:${path}`, path: path.split("."), kind: "member", absent: false, ...extra });
const capability = (path: string, type: string): TriggerCapability => ({ resource: `resource:${path}`, stack: `resource:${path.split(".")[0]}`, name: path.split(".").at(-1)!,
  location: { file: "stack.ts", line: 1, column: 1, start: 0, end: 10 }, owned: true, adapters: [], canonicalTypes: [type] });
const target = (ref: string, kind: ModelTarget["kind"], extra: Partial<ModelTarget> = {}): ModelTarget => ({ ...caller, ref, id: ref.split(":")[1]!, title: ref.split(":")[1]!, kind, role: kind === "lambda" ? "event" : kind, ...extra });
const edge = (relation: ModelEdge["relation"], to: string, context?: ModelEdge["permissionContext"]): ModelEdge => ({
  id: `${relation}:${caller.ref}->${to}`, relation, from: caller.ref, to, label: "authored label", provenance: "declared", permissionContext: context,
});

test("configured grant choices use canonical CDK types, service names and artwork", () => {
  const cases = [
    ["data.uploads", "aws-s3:IBucket", "bucket", "write"],
    ["data.jobs", "aws-sqs:Queue", "queue", "send"],
    ["data.records", "aws-dynamodb:TableV2", "table", "read"],
    ["data.notifications", "aws-sns:ITopic", "topic", "publish"],
    ["data.events", "aws-events:IEventBus", "bus", "publish"],
  ] as const;
  const current = model({ resources: cases.map(([path]) => resource(path)) });
  const options = configuredAccessOptions(caller, snapshot(current, current, cases.map(([path, type]) => capability(path, type))));
  assert.equal(options.filter(option => option.actions.length).length, cases.length);
  for (const [path, , icon, method] of cases) {
    const option = options.find(option => option.id === `resource:${path}`)!;
    assert.equal(option.title, path);
    assert.equal(option.icon, icon);
    assert.match(option.subtitle, /^Amazon /);
    assert.ok(option.definition?.actions.some(action => action.id === method));
    assert.deepEqual(option.actions[0]!.edit, { kind: "connection", target: caller.ref, connection: "resourceAccess", enabled: true, destination: `resource:${path}`, actions: [] });
    assert.equal(option.definition!.limits.includes("objectPrefix"), icon === "bucket");
  }
});

test("unsupported native services explain source ownership without inferring permissions from names", () => {
  const resources = [resource("data.secret", { typeText: "ISecret" }), resource("data.looksLikeBucket", { typeText: "Bucket" }), resource("data.count", { typeText: "number" })];
  const current = model({ resources });
  const options = configuredAccessOptions(caller, snapshot(current, current, [capability("data.secret", "aws-secretsmanager:ISecret")]));
  for (const item of resources) {
    const option = options.find(option => option.id === item.id)!;
    assert.match(option.reason!, /No supported grant method.*manual IAM/);
    assert.deepEqual(option.actions, []);
  }
  assert.equal(options.some(option => option.id.startsWith("island:")), false);
});

test("uninstantiated stack resources remain selectable with a separate readiness warning", () => {
  const current = model({ resources: [resource("unused", { kind: "stack", stackUsage: { status: "unreferenced", sites: [] } }), resource("unused.bucket")] });
  const option = configuredAccessOptions(caller, snapshot(current, current, [capability("unused.bucket", "aws-s3:Bucket")])).find(option => option.id === "resource:unused.bucket")!;
  assert.equal(option.reason, undefined);
  assert.match(option.warning!, /not created in application\.ts/);
  assert.equal(option.actions[0]?.edit.connection, "resourceAccess");
  const stack = configuredAccessOptions(caller, snapshot(current, current, [capability("unused.bucket", "aws-s3:Bucket")])).find(option => option.id === "resource:unused")!;
  assert.equal(stack.browseOnly, true);
  assert.equal(stack.icon, "stack");
});

test("both modes contribute destinations and existing cloud permissions", () => {
  const queue = resource("data.jobs", { absent: true });
  const workflow = target("workflow:nightly", "workflow");
  const dev = model({ mode: "dev", resources: [queue] });
  const prod = model({ resources: [{ ...queue, absent: false }], targets: [caller, workflow],
    edges: [edge("startsWorkflow", workflow.ref), edge("grant", queue.id, { kind: "native", method: "grantSendMessages", arguments: [] })] });
  const options = configuredAccessOptions(caller, snapshot(dev, prod, [capability("data.jobs", "aws-sqs:Queue")]));
  assert.equal(options.filter(option => option.id === queue.id).length, 1);
  const queueOption = options.find(option => option.id === queue.id)!;
  assert.match(queueOption.subtitle, /Production only/);
  assert.ok(queueOption.definition?.actions.some(action => action.id === "send"));
  assert.equal(queueOption.reason, undefined, "new scoped rules remain available alongside existing native grants");
  assert.equal(accessConnectionExists({ kind: "connection", target: caller.ref, connection: "grant", enabled: true, destination: queue.id, grant: "grantSendMessages" }, snapshot(dev, prod)), true);
  const workflowOption = options.find(option => option.id === workflow.ref)!;
  assert.match(workflowOption.warning!, /unavailable.*local caller/, "cross-mode calls explain readiness independently of duplicate detection");
  assert.equal(workflowOption.reason, "Already configured.");
  assert.equal(workflowOption.actions[0]!.existing, true);
});

test("permission picker includes unfinished bindings and structural blockers but no unrelated map items or empty stacks", () => {
  const worker = target("task:worker", "task", { lanes: { ...caller.lanes, deploy: "cloud-only", local: false, cloud: true } });
  const workflow = target("workflow:nightly", "workflow");
  const service = target("service:web", "service");
  const event = target("lambda:event", "lambda");
  const current = model({ targets: [caller, event, worker, workflow, service], resources: [
    resource("data", { kind: "stack" }), resource("data.jobs", { parent: "resource:data" }),
    resource("empty", { kind: "stack" }), resource("empty.count", { parent: "resource:empty", nativeKind: "value" }),
    resource("region", { kind: "input" }), resource("token", { kind: "secret" }),
  ] });
  const state = snapshot(current, current, [capability("data.jobs", "aws-sqs:Queue")]);
  const options = permissionAccessOptions(event, state);
  assert.ok(options.some(option => option.id === "resource:data"));
  assert.ok(options.some(option => option.id === "resource:data.jobs"));
  assert.ok(options.some(option => option.id === "resource:token"));
  assert.ok(options.some(option => option.id === caller.ref && option.invokeTarget));
  assert.equal(options.find(option => option.id === worker.ref)!.reason, undefined);
  assert.match(options.find(option => option.id === worker.ref)!.warning!, /local caller/);
  assert.match(options.find(option => option.id === workflow.ref)!.reason!, /built before the orchestration stack/);
  assert.ok(options.every(option => !option.id.startsWith("island:") && ![service.ref, "resource:region", "resource:empty", "resource:empty.count"].includes(option.id)));
});

test("native duplicate matching retains method, exact scope and destination", () => {
  const bucket = resource("data.uploads");
  const current = model({ resources: [bucket], edges: [edge("grant", bucket.id, { kind: "native", method: "grantRead", arguments: ["uploads/*"] })] });
  const state = snapshot(current, current, [capability("data.uploads", "aws-s3:Bucket")]);
  const option = configuredAccessOptions(caller, state)[0]!;
  assert.equal(option.reason, undefined, "other object scopes remain selectable");
  const edit = { kind: "connection", target: caller.ref, connection: "grant", enabled: true, destination: bucket.id, grant: "grantRead" } as const;
  assert.equal(accessConnectionExists({ ...edit, scope: "uploads/*" }, state), true);
  assert.equal(accessConnectionExists({ ...edit, scope: "other/*" }, state), false);
  assert.equal(accessConnectionExists({ ...edit, scope: "" }, state), false);
  assert.equal(accessConnectionExists({ ...edit, grant: "grantWrite", scope: "uploads/*" }, state), false);
});

test("an agent calling its own tool explains the complete cycle in either picker direction", () => {
  const agent = target("agent:assistant", "agent"), tool = target("lambda:lookup", "lambda", { role: "tool" });
  const current = model({ targets: [agent, tool], edges: [
    { ...edge("usesGateway", "gateway:agentcore:tools"), from: agent.ref },
    { ...edge("usesTool", tool.ref), from: "gateway:agentcore:tools" },
  ] });
  const state = snapshot(current);
  const option = permissionAccessOptions(tool, state).find(item => item.id === agent.ref)!;
  assert.match(option.reason!, /lambda:lookup → agent:assistant → gateway:agentcore:tools → lambda:lookup/);
  assert.equal(configuredAccessOptions(tool, state, agent.ref)[0]!.reason, option.reason);
});

test("invocation bindings target declared workloads while Lambda IAM stays explicit", () => {
  const task = target("task:worker", "task"), workflow = target("workflow:nightly", "workflow"), agent = target("agent:assistant", "agent"), tool = target("lambda:lookup", "lambda", { role: "tool" });
  const current = model({ targets: [caller, task, workflow, agent, tool] });
  const state = snapshot(current);
  const options = configuredAccessOptions(caller, state);
  assert.deepEqual(options.filter(option => option.actions.length).map(option => option.actions[0]!.edit.connection).sort(), ["invokesAgent", "runsTask", "startsWorkflow"]);
  const agentOptions = configuredAccessOptions(agent, state);
  assert.equal(agentOptions.some(option => option.id === agent.ref), false, "self invocation is not suggested");
  assert.equal(agentOptions.find(option => option.id === tool.ref)!.invokeTarget, tool.ref, "Lambda invoke is an explicit IAM rule, separate from gateway/runtime bindings");
  assert.deepEqual(agentOptions.find(option => option.id === tool.ref)!.actions, []);
  assert.deepEqual(configuredAccessOptions(workflow, state), [], "workflow steps use their own editor");
});

test("database connection follows managed database and event replay eligibility", () => {
  const database = resource("data.database", { frameworkManaged: "database" });
  const current = model({ resources: [database], managedDatabase: { id: "application", resource: database.id, networkId: "application", subnet: "isolated", engine: "postgres", databaseName: "app", settings: {} as never, authored: {} } });
  const state = snapshot(model({ mode: "dev" }), current);
  const option = configuredAccessOptions(caller, state)[0]!;
  assert.equal(option.id, database.id);
  assert.equal(option.actions[0]!.edit.connection, "database");
  assert.equal(option.reason, undefined);
  assert.deepEqual(configuredAccessOptions(target("agent:assistant", "agent"), state).filter(option => option.actions.length), []);
  const event = target("lambda:event", "lambda");
  assert.match(configuredAccessOptions(event, state).find(option => option.id === database.id)!.reason!, /Enable local replay/);
  assert.equal(configuredAccessOptions({ ...event, compute: { ...caller.compute, localReplay: true } as ModelTarget["compute"] }, state).find(option => option.id === database.id)!.reason, undefined);
  const connected = snapshot(model({ mode: "dev" }), { ...current, edges: [edge("database", database.id)] });
  assert.equal(configuredAccessOptions(caller, connected).find(option => option.id === database.id)!.reason, "Already configured.");
});

test("user-pool identifiers are one managed option, absent for agents and tools", () => {
  const pool = resource("identity.pool");
  const current = model({ resources: [pool] }), state = snapshot(current, current, [capability("identity.pool", "aws-cognito:IUserPool")]);
  const options = configuredAccessOptions(caller, state).filter(option => option.configuration);
  assert.equal(options.length, 1);
  assert.equal(options[0]!.id, "framework:userPool");
  assert.equal(options[0]!.actions[0]!.edit.connection, "userPool");
  assert.deepEqual(configuredAccessOptions(target("agent:assistant", "agent"), state).filter(option => option.configuration), []);
  assert.deepEqual(configuredAccessOptions(target("lambda:tool", "lambda", { role: "tool" }), state).filter(option => option.configuration), []);
  assert.deepEqual(configuredAccessOptions(caller, snapshot(model())).filter(option => option.actions.length), []);
});

test("input and secret delivery produce framework edits while allowing multiple variable mappings", () => {
  const input = resource("config.region", { kind: "input", fromEnv: "REGION" }), secret = resource("token", { kind: "secret", fromEnv: "API_TOKEN" });
  const current = model({ resources: [input, secret], targets: [{ ...caller, environment: [{ name: "REGION", value: { kind: "reference", resource: input.id, display: "region" } }] }] });
  const state = snapshot(current);
  const options = configuredAccessOptions(caller, state);
  assert.equal(options.find(option => option.id === input.id)!.actions[0]!.variable, true);
  assert.equal(options.find(option => option.id === input.id)!.reason, undefined);
  assert.equal(options.find(option => option.id === secret.id)!.actions[0]!.label, "Read secret");
  const taskOptions = configuredAccessOptions(target("task:worker", "task"), state);
  assert.equal(taskOptions.find(option => option.id === secret.id)!.actions[0]!.label, "Load secret at startup");
  const edit = options.find(option => option.id === input.id)!.actions[0]!.edit;
  assert.equal(accessConnectionExists({ ...edit, variable: "REGION" }, state), true);
  assert.equal(accessConnectionExists({ ...edit, variable: "ALTERNATE_REGION" }, state), false);
});

test("configuration-only input groups and native values never become permission destinations", () => {
  const current = model({ resources: [resource("settings", { kind: "group" }), resource("settings.region", { kind: "input" }), resource("native.flag", { nativeKind: "value", typeText: "string" }), resource("secret", { kind: "secret" })] });
  const options = configuredAccessOptions(caller, snapshot(current));
  assert.equal(options.find(item => item.id === "resource:settings")?.configuration, true);
  assert.equal(options.find(item => item.id === "resource:native.flag")?.configuration, true);
  assert.equal(options.some(item => item.id === "island:inputs"), false);
  const permissionOptions = options.filter(item => !item.configuration);
  assert.ok(permissionOptions.some(item => item.id === "resource:secret"));
  assert.equal(permissionOptions.some(item => item.id === "resource:settings" || item.id === "resource:settings.region" || item.id === "resource:native.flag"), false);
});

test("permission catalog prioritizes usable services and calls before secrets and inputs", () => {
  const current = model({ targets: [caller, target("workflow:zWorkflow", "workflow")], resources: [
    resource("aInput", { kind: "input" }), resource("bSecret", { kind: "secret" }), resource("zStorage.bucket"), resource("aUnused", { kind: "stack", stackUsage: { status: "unreferenced", sites: [] } }), resource("aUnused.bucket"),
  ] });
  const options = configuredAccessOptions(caller, snapshot(current, current, [capability("zStorage.bucket", "aws-s3:Bucket"), capability("aUnused.bucket", "aws-s3:Bucket")]));
  const ids = options.filter(option => option.actions.length).map(option => option.id);
  assert.ok(ids.indexOf("resource:zStorage.bucket") < ids.indexOf("resource:bSecret"));
  assert.ok(ids.indexOf("workflow:zWorkflow") < ids.indexOf("resource:bSecret"));
  assert.ok(ids.indexOf("resource:aUnused.bucket") < ids.indexOf("resource:bSecret"));
  assert.ok(ids.indexOf("resource:bSecret") < ids.indexOf("resource:aInput"));
});

test("destination-filtered access preserves complete catalog eligibility and actions across modes", () => {
  const database = resource("data.database", { frameworkManaged: "database" });
  const current = model({
    targets: [caller, target("task:worker", "task"), target("workflow:nightly", "workflow"), target("agent:assistant", "agent"), target("lambda:lookup", "lambda", { role: "tool" })],
    resources: [resource("data.queue"), resource("data.bucket"), resource("identity.pool"), resource("region", { kind: "input" }), resource("token", { kind: "secret" }), database],
    edges: [edge("grant", "resource:data.queue", { kind: "native", method: "grantSendMessages", arguments: [] })],
    managedDatabase: { id: "application", resource: database.id, networkId: "application", subnet: "isolated", engine: "postgres", databaseName: "app", settings: {} as never, authored: {} },
  });
  const dev = model({ mode: "dev", resources: [resource("devOnly", { kind: "input" })] });
  const state = snapshot(dev, current, [capability("data.queue", "aws-sqs:Queue"), capability("data.bucket", "aws-s3:Bucket"), capability("identity.pool", "aws-cognito:IUserPool")]);
  for (const consumer of current.targets) {
    const all = configuredAccessOptions(consumer, state);
    for (const id of [...current.targets.map(item => item.ref), ...current.resources.map(item => item.id), "resource:devOnly", "framework:userPool", "resource:missing"])
      assert.deepEqual(configuredAccessOptions(consumer, state, id), all.filter(option => option.id === id), `${consumer.ref} → ${id}`);
  }
});

test("destination-filtered access skips unrelated resource action generation", () => {
  const selected = resource("data.queue"), unrelated = resource("data.other");
  const unrelatedCapability = { ...capability("data.other", "aws-s3:Bucket"), get canonicalTypes(): readonly string[] { throw new Error("Unrelated resource types must not be read for a fixed destination"); } };
  const current = model({ resources: [selected, unrelated] });
  const state = snapshot(current, current, [capability("data.queue", "aws-sqs:Queue"), unrelatedCapability]);
  assert.equal(configuredAccessOptions(caller, state, selected.id)[0]?.id, selected.id);
  assert.deepEqual(configuredAccessOptions(caller, state, "resource:missing"), []);
});

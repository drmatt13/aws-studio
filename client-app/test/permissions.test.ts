import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineFrameworkConfig, defineInputs, defineStacks, input, stack, targetArn, trigger, type FrameworkConfig } from "aws-studio/config";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import { projectModel } from "../server/model/project";
import type { ModeModel, ModelEdge, ModelTarget, Relation } from "../shared/model";
import { authorizationLabel, authorizationSummary, withConnectionAuthorizations } from "../shared/permissions";
import { grantOptions } from "../shared/grants";
import { aggregateConnections } from "../src/connections";
import { connectionVisible } from "../src/scene/connections";
import { CATEGORY_LABEL, edgeCategory, type EdgeCategory } from "../src/lookup";
import { connectionSignature } from "../server/edits/batch";
import { planConnection } from "../server/edits/connections";
import type { ModelAgentCoreGateway } from "../shared/gateways";
import type { StudioState } from "../server/snapshot";

const base = () => projectModel({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: { "/caller": { directory: "compute/caller", methods: ["GET"] } }, webSocket: {}, events: {}, services: {}, tasks: {}, workflows: {} } as FrameworkConfig, { mode: "prod" });
const target = (ref: string, kind: ModelTarget["kind"] = "lambda", extra: Partial<ModelTarget> = {}): ModelTarget => ({ ...base().targets[0]!, ref, id: ref.split(":")[1]!, kind, role: kind === "lambda" ? "http" : kind, ...extra });
const edge = (relation: ModelEdge["relation"], context?: ModelEdge["permissionContext"], extra: Partial<ModelEdge> = {}): ModelEdge => ({ id: "test", relation, from: "lambda:caller", to: "resource:store.data", label: "An authored label", provenance: "declared", permissionContext: context, ...extra });
const gateway: ModelAgentCoreGateway = { id: "gateway:agentcore:arithmetic", title: "arithmetic", protocol: "agentcore", key: "arithmetic", origin: 'gateways["arithmetic"]', tools: ["tool"], consumers: ["agent:assistant"], constructId: "Arithmetic", constructIdPinned: false, lanes: base().targets[0]!.lanes };
function describe(item: ModelEdge, targets: readonly ModelTarget[] = [target("lambda:caller")], mode: "dev" | "prod" = "prod") {
  return withConnectionAuthorizations({ ...base(), mode, targets, gateways: [gateway], edges: [item] }).edges[0]!;
}

test("database IAM describes writer, readers and direct access; local enrichment removes AWS grants", () => {
  const source = edge("database", { kind: "database", connection: "direct", readers: true });
  const cloud = describe(source);
  assert.equal(cloud.label, source.label);
  assert.equal(cloud.authorization!.operation, "Connect PostgreSQL directly");
  assert.equal(cloud.authorization!.grants.length, 2);
  assert.deepEqual(cloud.authorization!.grants[0]!.actions, ["rds-db:connect"]);
  assert.match(cloud.authorization!.grants[0]!.scope, /direct writer.*app_user/);
  assert.ok(cloud.authorization!.notes.some(note => note.includes("retains writer")));
  const local = describe({ ...cloud, to: "local:postgres" }, undefined, "dev");
  assert.equal(local.authorization!.kind, "local");
  assert.deepEqual(local.authorization!.grants, []);
  assert.equal(local.label, source.label, "presentation preserves authored labels and descriptions");
});

test("permission facts preserve route, input, scope and callback labels as connection identity", () => {
  const cases = [
    edge("routes", undefined, { from: "route:http:/caller", to: "lambda:caller", label: "/api/caller" }),
    edge("routes", undefined, { from: "route:webSocket:customAction", to: "lambda:caller", label: "customAction" }),
    edge("env", { kind: "secret", delivery: "arn" }, { label: "API_KEY_ARN" }),
    edge("secret", { kind: "secret", delivery: "startup" }, { label: "SERVICE_TOKEN" }),
    edge("grant", { kind: "native", method: "grantRead", arguments: ["tenant/*"] }, { label: 'grantRead("tenant/*")' }),
    edge("database", { kind: "database", connection: "application", readers: true }, { label: "database + readers" }),
    edge("step", { kind: "step", target: "task", callback: true }, { label: "runTask (callback)" }),
    edge("integration", { kind: "integration", service: "table", operations: ["get", "put"] }, { label: "get, put" }),
  ];
  for (const source of cases) {
    const result = describe(source);
    assert.equal(result.authorization!.kind, "iam", source.label);
    assert.equal(result.label, source.label);
  }
});

test("hover permission summaries are secondary and bounded while build state stays in details", () => {
  const route = describe(edge("routes", undefined, { to: "lambda:caller" }));
  assert.equal(authorizationLabel(route.authorization!), "IAM grant");
  assert.equal(authorizationLabel({ ...route.authorization!, state: "not-built" }), "IAM grant");
  assert.deepEqual(authorizationSummary(route.authorization!), ["IAM: lambda:InvokeFunction"]);
  assert.deepEqual(authorizationSummary({ ...route.authorization!, state: "not-built" }), ["IAM: lambda:InvokeFunction"]);
  const grant = route.authorization!.grants[0]!;
  const summary = authorizationSummary({ ...route.authorization!, grants: [
    { ...grant, actions: ["ecs:RunTask", "ecs:TagResource", "iam:PassRole"] },
    { ...grant, actions: ["ecs:RunTask", "ecs:DescribeTasks", "ecs:StopTask"] },
  ] });
  assert.equal(summary.length, 1);
  assert.equal(summary[0], "IAM: ecs:RunTask, ecs:TagResource, iam:PassRole, +2 more");
  for (const kind of ["local", "user-token", "unknown"] as const) {
    assert.deepEqual(authorizationSummary({ ...route.authorization!, kind, grants: [] }), []);
  }
  const native = describe(edge("grant", { kind: "native", method: "grantRead", arguments: ["tenant/*"] }));
  assert.deepEqual(authorizationSummary(native.authorization!), ['IAM: grantRead("tenant/*")']);
});

test("secret ARN and startup injection distinguish task role from execution role; ordinary reads grant nothing", () => {
  const targets = [target("task:caller", "task")];
  const startup = describe(edge("secret", { kind: "secret", delivery: "startup" }, { from: "task:caller" }), targets);
  const arn = describe(edge("env", { kind: "secret", delivery: "arn" }, { from: "task:caller" }), targets);
  assert.match(startup.authorization!.grants[0]!.principal, /ECS execution role/);
  assert.match(arn.authorization!.grants[0]!.principal, /ECS task role/);
  assert.deepEqual(arn.authorization!.grants[0]!.actions, ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]);
  assert.equal(describe(edge("env", undefined, { label: "grantRead is just text" })).authorization, undefined);
});

test("invocation capabilities include RunTask, scoped PassRole, workflow waits and reverse callback permission", () => {
  const item = describe(edge("step", { kind: "step", target: "task", callback: true }, { from: "workflow:parent", to: "task:worker" }), [target("workflow:parent", "workflow"), target("task:worker", "task")]);
  const grants = item.authorization!.grants;
  assert.ok(grants.some(grant => grant.actions?.includes("ecs:RunTask") && grant.conditions?.some(condition => condition.includes("ecs:cluster"))));
  assert.ok(grants.some(grant => grant.actions?.includes("iam:PassRole") && grant.conditions?.some(condition => condition.includes("ecs-tasks.amazonaws.com"))));
  assert.ok(grants.some(grant => grant.actions?.includes("ecs:StopTask")));
  assert.equal(grants.find(grant => grant.actions?.includes("states:SendTaskSuccess"))?.principalEntity, "task:worker");
  const child = describe(edge("step", { kind: "step", target: "workflow", callback: false }));
  assert.ok(child.authorization!.grants.some(grant => grant.actions?.includes("states:StopExecution")));
});

test("authenticated agents use user tokens; service agents and tools retain their IAM paths", () => {
  const source = edge("invokesAgent", undefined, { to: "agent:assistant" });
  const targets = [target("lambda:caller"), target("agent:assistant", "agent", { auth: true })];
  assert.equal(describe(source, targets).authorization!.kind, "user-token");
  assert.deepEqual(describe(source, targets.map(item => ({ ...item, auth: false }))).authorization!.grants[0]!.actions, ["bedrock-agentcore:InvokeAgentRuntime"]);
  const invoke = describe(edge("usesGateway", undefined, { from: "agent:assistant", to: gateway.id }), targets);
  assert.deepEqual(invoke.authorization!.grants[0]!.actions, ["bedrock-agentcore:InvokeGateway"]);
  assert.equal(invoke.authorization!.grants[0]!.principalEntity, "agent:assistant");
  const tool = describe(edge("usesTool", undefined, { from: gateway.id, to: "lambda:tool" }), targets);
  assert.equal(tool.authorization!.grants.length, 1);
  assert.deepEqual(tool.authorization!.grants[0]!.actions, ["lambda:InvokeFunction"]);
  assert.equal(tool.authorization!.grants[0]!.principalEntity, gateway.id);
  assert.match(tool.authorization!.grants[0]!.principal, /Gateway execution role/);
});

test("pull triggers reverse IAM principal; push triggers use resource policies and S3 EventBridge delivery uses Events", () => {
  const targets = [target("lambda:consumer")];
  const pull = describe(edge("trigger", { kind: "trigger", adapter: "sqs" }, { from: "resource:store.queue", to: "lambda:consumer" }), targets);
  assert.equal(pull.authorization!.grants[0]!.principalEntity, "lambda:consumer");
  assert.equal(pull.authorization!.grants[0]!.via, "grantConsumeMessages()");
  for (const [adapter, principal] of [["sns", "sns.amazonaws.com"], ["cognito", "cognito-idp.amazonaws.com"], ["s3", "s3.amazonaws.com"]]) {
    const result = describe(edge("trigger", { kind: "trigger", adapter }, { to: "lambda:consumer" }), targets);
    assert.equal(result.authorization!.grants[0]!.principal, principal);
    assert.equal(result.authorization!.grants[0]!.policy, "Resource policy");
  }
  const bus = describe(edge("trigger", { kind: "trigger", adapter: "s3", delivery: "eventbridge" }, { to: "lambda:consumer" }), targets);
  assert.equal(bus.authorization!.grants[0]!.principal, "events.amazonaws.com");
  assert.equal(describe(edge("grant", { kind: "trigger-dlq", adapter: "sns" })).authorization!.grants[0]!.principal, "sns.amazonaws.com");
});

test("native helpers retain scope without inventing action lists; custom integration and CDK references stay explicit unknowns", () => {
  const item = describe(edge("grant", { kind: "native", method: "grantRead", arguments: ["tenant/*"] }));
  assert.equal(item.authorization!.grants[0]!.actions, undefined);
  assert.equal(item.authorization!.grants[0]!.via, 'grantRead("tenant/*")');
  const table = describe(edge("integration", { kind: "integration", service: "table", operations: ["get", "put"] }));
  assert.deepEqual(table.authorization!.grants.map(grant => grant.via), ["grantReadData()", "grantWriteData()"]);
  assert.equal(describe(edge("integration", { kind: "integration", service: "aws", operations: ["custom"] })).authorization!.kind, "unknown");
  assert.equal(describe(edge("cdk")).authorization!.kind, "unknown");
  const http = describe(edge("integration", { kind: "integration", service: "httpConnection", operations: ["invoke"] }));
  assert.equal(http.authorization!.grants.length, 3);
  assert.deepEqual(http.authorization!.grants[0]!.actions, ["states:InvokeHTTPEndpoint"]);
  assert.ok(http.authorization!.grants[0]!.conditions?.some(condition => condition.includes("states:HTTPEndpoint")));
});

test("connection filters describe purpose across every relation and delivery context", () => {
  const purposes: Readonly<Record<EdgeCategory, readonly Relation[]>> = {
    routes: ["routes", "authorizes", "trigger"],
    inputs: ["deployWhen", "env", "supplies", "maps", "secret"],
    interactions: ["grant", "database", "manageConnections", "localReplay", "completesCallback", "runsTask", "startsWorkflow", "invokesAgent", "usesGateway", "usesTool", "step", "integration"],
    structure: ["contains", "cdk"],
  };
  assert.deepEqual(Object.values(CATEGORY_LABEL), ["Routes and events", "Environment and secrets", "Resource interactions", "Resource structure"]);
  for (const [category, relations] of Object.entries(purposes)) {
    for (const relation of relations) assert.equal(edgeCategory(edge(relation)), category, relation);
  }
  assert.equal(edgeCategory(edge("cdk", { kind: "subscription", protocol: "sqs" })), "routes");
  assert.equal(edgeCategory(edge("grant", { kind: "trigger-dlq", adapter: "sns" })), "routes");
  assert.equal(edgeCategory(edge("grant", { kind: "failure" })), "routes");
});

test("group filters check all relationship categories across modes and preserve inspected context", () => {
  const plain = edge("env", undefined, { id: "a" });
  const grant = edge("grant", { kind: "native", method: "grantRead", arguments: [] }, { id: "z" });
  const call = edge("integration", { kind: "integration", service: "table", operations: ["get"] }, { id: "prod-only" });
  const prod = withConnectionAuthorizations({ ...base(), edges: [plain, grant, call] });
  const dev: ModeModel = { ...prod, mode: "dev", edges: [plain] };
  const groups = aggregateConnections(prod, [dev]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every(group => group.members.length === 1));
  const group = groups.find(group => group.edge.id === grant.id)!;
  assert.deepEqual(group.categories, ["interactions"]);
  const read = groups.find(group => group.edge.id === plain.id)!;
  assert.equal(connectionVisible(read, new Set(["interactions"])), false, "grants do not reveal environment reads");
  assert.equal(connectionVisible(group, new Set(["inputs"])), false, "reads do not reveal grants");
  for (const selected of [group, aggregateConnections(dev, [prod]).find(group => group.edge.id === grant.id)!]) {
    assert.deepEqual(selected.categories, group.categories, "other-environment relationships remain filterable");
    for (const category of group.categories) assert.equal(connectionVisible(selected, new Set([category])), true, category);
    assert.equal(connectionVisible(selected, new Set(["routes", "structure"])), false);
    assert.equal(connectionVisible(selected, new Set()), false);
    assert.equal(connectionVisible(selected), true);
    for (const selection of [selected.id, selected.from, selected.to]) assert.equal(connectionVisible(selected, new Set(), selection), true);
  }
  const ghost = aggregateConnections({ ...dev, edges: [] }, [prod]).find(group => group.edge.id === grant.id)!;
  assert.equal(ghost.otherLens, "prod");
  assert.equal(connectionVisible(ghost, new Set(["interactions"])), true, "union-topology ghost links remain filterable");
  assert.equal(connectionSignature({ edges: [grant] }), connectionSignature({ edges: [describe(grant)] }));
});

test("adding IAM details does not change a grouped connection's representative", () => {
  const plain = edge("env", undefined, { id: "a" });
  const secretArn = edge("env", { kind: "secret", delivery: "arn" }, { id: "z" });
  const source = { ...base(), edges: [plain, secretArn] };
  assert.equal(aggregateConnections(source)[0]!.edge.id, plain.id);
  assert.equal(aggregateConnections(withConnectionAuthorizations(source))[0]!.edge.id, plain.id);
});

test("projection creates typed secret/native/schedule/WebSocket facts directly from declarations", () => {
  const stacks = defineStacks({ data: stack<{ bucket: IBucket; queue: IQueue }>() });
  const inputs = defineInputs({ key: input.secret("EXAMPLE_KEY") });
  const config = defineFrameworkConfig({ inputs, stacks, services: [],
    defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: [{ "/read": { directory: "compute/read", methods: ["GET"], environment: { KEY_ARN: inputs.key.arn }, cloud: { bindings: [stacks.data.bucket.grantRead("tenant/*")] } } }],
    webSocket: [{ send: { directory: "compute/send", cloud: { manageConnections: true } } }],
    events: [{ tick: { directory: "compute/tick", triggers: [trigger.schedule({ id: "timer", expression: "rate(1 hour)", accepts: "schedule" })] } }],
  });
  const model = projectModel(config, { mode: "prod" });
  assert.equal(model.edges.find(item => item.label === "KEY_ARN")?.authorization?.operation, "Read secret");
  assert.equal(model.edges.find(item => item.relation === "grant")?.authorization?.grants[0]?.via, 'grantRead("tenant/*")');
  assert.equal(model.edges.find(item => item.relation === "manageConnections")?.authorization?.grants[0]?.actions?.[0], "execute-api:ManageConnections");
  const schedule = model.targets.find(item => item.id === "tick")!.authorizations!.find(item => item.authorization.operation === "Invoke on schedule")!;
  assert.match(schedule.authorization.grants[0]!.principal, /Scheduler execution role/);
  assert.equal(model.edges.some(item => item.from.startsWith("schedule:")), false, "resourceless schedules do not create phantom graph nodes");
  const dev = projectModel(config, { mode: "dev" });
  assert.equal(dev.edges.find(item => item.relation === "grant")?.authorization?.state, "not-built");
});

test("explicit IAM references create source-backed graph edges and retain deny conditions without duplicate anonymous rules", () => {
  const stacks = defineStacks({ data: stack<{ bucket: IBucket }>() });
  const config = defineFrameworkConfig({ stacks, defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: [{ "/caller": { directory: "compute/caller", methods: ["GET"], cloud: { access: [
      { actions: ["s3:GetObject", "lambda:InvokeFunction"], resources: [{ resource: stacks.data.bucket.bucketArn, suffix: "/tenant/*" }, targetArn("lambda:other" as never)], effect: "Deny", conditions: { Bool: { "aws:SecureTransport": false } } },
      { actions: ["bedrock-mantle:CallWithBearerToken"], resources: ["*"] },
    ] } } }, { "/other": { directory: "compute/other", methods: ["GET"] } }], webSocket: [], events: [], services: [],
  });
  const model = projectModel(config, { mode: "prod" });
  const edges = model.edges.filter(edge => edge.permissionContext?.kind === "iamPolicy");
  assert.deepEqual(edges.map(edge => edge.to).sort(), ["lambda:other", "resource:data.bucket"]);
  assert.ok(edges.every(edge => edge.authorization?.statement?.effect === "Deny"));
  assert.ok(edges.every(edge => edge.authorization?.grants[0]?.conditions?.join().includes("aws:SecureTransport")));
  const caller = model.targets.find(target => target.ref === "lambda:caller")!;
  assert.equal(caller.authorizations?.filter(row => !row.connection && row.authorization.operation === "Explicit IAM policy").length, 1, "only the literal external scope needs an anonymous authorization row");
  assert.deepEqual(caller.access[0]!.statement?.resources[0], { kind: "catalog", resource: "resource:data.bucket", attribute: "bucketArn", suffix: "/tenant/*" });
});

test("grant choices and backend refuse mismatched methods, arbitrary IAM and unsupported scopes", () => {
  for (const [type, method] of [["aws-dynamodb:ITable", "grantReadData"], ["aws-sns:ITopic", "grantPublish"], ["aws-events:IEventBus", "grantPutEventsTo"]]) assert.ok(grantOptions([type!]).some(option => option.method === method));
  assert.equal(grantOptions(["app:SomethingNamedBucket"]).length, 0);
  const model = { ...base(), resources: [{ id: "resource:store.data", path: ["store", "data"], kind: "member", absent: false }] };
  const state = { snapshot: { models: { dev: model, prod: model }, source: { permissionCapabilities: [{ resource: "resource:store.data", category: "resource", canonicalTypes: ["aws-dynamodb:ITable"], grants: [{method:"grantReadData",parameters:[]}] }] } } } as unknown as StudioState;
  const intent = { kind: "connection", target: "lambda:caller", connection: "grant", destination: "resource:store.data", enabled: true } as const;
  assert.throws(() => planConnection("unused", state, { ...intent, grant: "grantRead" }, new Map()), /discovered grant/);
  assert.throws(() => planConnection("unused", state, { ...intent, grant: "grantReadData", scope: "arbitrary/*" }, new Map()), /discovered CDK signature/);
});

test("native grant creation dynamically writes the supported helper and refreshes its authorization facts", () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "permission-writer-"));
  const file = path.join(root, "framework.config.ts");
  writeFileSync(path.join(root, "stacks.ts"), 'import { defineStacks, stack } from "aws-studio/config"; export const stacks = defineStacks({ store: stack<unknown>() });');
  writeFileSync(file, 'import { defineFrameworkConfig } from "aws-studio/config"; import { stacks } from "./stacks"; export default defineFrameworkConfig({ stacks, http: [{ "/caller": { directory: "compute/caller", methods: ["GET"] } }], webSocket: [], events: [], services: [] });');
  try {
    for (const [type, grant] of [["aws-dynamodb:ITable", "grantReadData"], ["aws-sns:ITopic", "grantPublish"], ["aws-events:IEventBus", "grantPutEventsTo"]] as const) {
      const resource = { id: "resource:store.data", path: ["store", "data"], kind: "member", absent: false };
      const model = { ...base(), resources: [resource] };
      const state = { snapshot: { models: { dev: model, prod: model }, source: { permissionCapabilities: [{ resource: resource.id, category: "resource", canonicalTypes: [type], grants: [{method:grant,parameters:[]}] }] } } } as unknown as StudioState;
      const overrides = new Map<string, string>();
      planConnection(root, state, { kind: "connection", target: "lambda:caller", connection: "grant", destination: resource.id, enabled: true, grant }, overrides);
      assert.ok(overrides.get(file)?.includes(`.${grant}()`), grant);
      assert.match(overrides.get(file)!, /cloud:.*bindings:/);
      assert.equal(describe(edge("grant", { kind: "native", method: grant, arguments: [] })).authorization?.kind, "iam");
    }
  } finally { rmSync(root, { recursive: true }); }
});


test("target permissions retain edge multiplicity, principal membership and ordered implicit policies", () => {
  const worker = target("task:worker", "task", {
    permissionSources: [
      { relation: "integration", peer: "table", label: "first", context: { kind: "integration", service: "table", operations: ["get"] } },
      { relation: "integration", peer: "table", label: "unknown" },
      { relation: "integration", peer: "table", label: "second", context: { kind: "integration", service: "table", operations: ["put"] } },
    ],
    access: [{ actions: ["s3:GetObject"], resources: ["first"] }, { actions: ["s3:PutObject"], resources: ["second"] }],
  });
  const model = { ...base(), gateways: [gateway], targets: [target("workflow:parent", "workflow"), worker, target("agent:assistant", "agent"), target("lambda:tool")], edges: [
    edge("env", undefined, { id: "ignored", from: worker.ref }),
    edge("step", { kind: "step", target: "task", callback: true }, { id: "duplicate", from: "workflow:parent", to: worker.ref }),
    edge("usesGateway", undefined, { id: "gateway", from: "agent:assistant", to: gateway.id }),
    edge("usesTool", undefined, { id: "tool", from: gateway.id, to: "lambda:tool" }),
    edge("runsTask", undefined, { id: "self", from: worker.ref, to: worker.ref }),
    edge("completesCallback", undefined, { id: "duplicate", from: worker.ref }),
    edge("trigger", { kind: "trigger", adapter: "sqs" }, { id: "incoming", from: "resource:queue", to: "lambda:tool" }),
  ] };
  const result = withConnectionAuthorizations(model);
  assert.deepEqual(result.targets.map(item => item.authorizations!.filter(row => row.connection).map(row => row.connection)), [
    ["duplicate"], ["duplicate", "self", "duplicate"], ["gateway"], ["tool", "incoming"],
  ]);
  const rows = result.targets[1]!.authorizations!;
  assert.deepEqual(rows.map(row => row.authorization.operation), ["Launch ECS task", "Launch ECS task", "Complete workflow callback", "get · table", "put · table", "Explicit IAM policy", "Explicit IAM policy"]);
  assert.ok(rows.slice(3).every(row => !("connection" in row)));
  assert.deepEqual(rows.slice(-2).map(row => row.authorization.grants[0]!.scope), ["first", "second"]);
  Object.assign(worker, { permissionSources: [], access: [] });
  Object.assign(model, { edges: [] });
  assert.ok(withConnectionAuthorizations(model).targets.every(item => item.authorizations!.length === 0));
  assert.equal(rows.length, 7, "earlier output remains independent of the next call");
});

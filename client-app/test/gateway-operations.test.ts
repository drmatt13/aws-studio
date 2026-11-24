import assert from "./support/assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineFrameworkConfig, defineInputs, input, stack, cdk, type FrameworkConfigInput } from "aws-studio/config";
import { readDraftEdits } from "../server/server";
import { planGatewayOperation } from "../server/edits/gateways";
import { projectModel } from "../server/model/project";
import { buildSourceIndex } from "../server/source";
import { withConnectionEvidence } from "../server/source/evidence";
import { planCreation } from "../server/edits/creation";
import { readCreationRequest } from "../shared/creation";
import { readGatewayOperation } from "../shared/gateway-operations";
import type { StudioState } from "../server/snapshot";

const repository = path.resolve(__dirname, "../..");
const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const resources = defineInputs({ flag: input.value("enabled").enum("enabled", "disabled") });
const fixtureConfig = (extra: Partial<FrameworkConfigInput> = {}) => defineFrameworkConfig({ defaults, inputs: resources, http: [], webSocket: [], events: [], services: [], tools: [{ first: {}, second: {} }], gateways: [{ primary: { tools: ["first"] }, secondary: { tools: ["first", "second"] }, empty: {} }], agents: [{ assistant: { gateways: ["secondary", "primary"] } }], ...extra });
function fixture() {
  mkdirSync(path.join(repository, ".cache/framework-studio"), { recursive: true });
  const root = mkdtempSync(path.join(repository, ".cache/framework-studio/gateway-"));
  mkdirSync(path.join(root, "framework-config/workloads"), { recursive: true });
  const write = (file: string, text: string) => writeFileSync(path.join(root, file), text);
  write("framework.config.ts", `import { defineFrameworkConfig } from "aws-studio/config";
import { gateways } from "./framework-config/workloads/gateways";
import { agents } from "./framework-config/workloads/agents";
import { tools } from "./framework-config/workloads/tools";
import { resources as inputs } from "./framework-config/inputs";
export default defineFrameworkConfig({ inputs: inputs, defaults: ${JSON.stringify(defaults)}, http: [], webSocket: [], events: [], services: [], agents: [agents], tools: [tools], gateways: [gateways] });
`);
  write("framework-config/inputs.ts", 'import { defineInputs, input, stack, cdk } from "aws-studio/config"; export const resources = defineInputs({ flag: input.value("enabled").enum("enabled", "disabled") });\n');
  write("framework-config/workloads/gateways.ts", 'export const gateways = { primary: { tools: ["first"] }, secondary: { tools: ["first", "second"] }, empty: {} };\n');
  write("framework-config/workloads/agents.ts", 'export const agents = { assistant: { gateways: ["secondary", "primary"] } };\n');
  write("framework-config/workloads/tools.ts", 'export const tools = { first: {}, second: {} };\n');
  const models = { dev: projectModel(fixtureConfig(), { mode: "dev" }), prod: projectModel(fixtureConfig(), { mode: "prod" }) };
  const built = buildSourceIndex(root, models.dev);
  const state = { snapshot: { models, source: built.index }, built } as unknown as StudioState;
  return { root, state, write, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("Gateway requests accept ordered arrays and reject extra settings, duplicates and obsolete direct tools", () => {
  const operations = [
    { kind: "agentGateways", target: "agent:assistant", gateways: ["secondary", "primary"] },
    { kind: "gatewayTools", gateway: "gateway:agentcore:primary", tools: [] },
    { kind: "gatewayDeploy", gateway: "gateway:agentcore:primary", value: { when: { resource: "resource:flag", equals: "enabled" } } },
    { kind: "removeGateway", gateway: "gateway:agentcore:empty" },
  ];
  assert.deepEqual(readDraftEdits(operations), operations);
  for (const edit of [
    { ...operations[0], gateways: ["primary", "primary"] },
    { ...operations[1], tools: ["lambda:first"] },
    { ...operations[2], value: { when: { resource: "resource:flag", equals: "enabled", expression: "private-do-not-reflect" } } },
    { ...operations[3], file: "private-do-not-reflect" },
  ]) assert.throws(() => readGatewayOperation(edit), error => error instanceof Error && !error.message.includes("private-do-not-reflect"));
  assert.throws(() => readDraftEdits([{ kind: "connection", target: "agent:assistant", connection: "tool", destination: "lambda:first", enabled: true }]));
  assert.throws(() => readCreationRequest({ kind: "agent", id: "new-agent", tools: ["first"] }), /unsupported/);
});

test("projection separates agent invocation from Gateway Lambda authorization and retains empty APIs", () => {
  const model = projectModel(fixtureConfig(), { mode: "prod" });
  const selected = model.targets.find(target => target.ref === "agent:assistant")!;
  assert.deepEqual(selected.compute.kind === "agent" && selected.compute.gateways, ["secondary", "primary"]);
  assert.ok(selected.environment.some(entry => entry.name === "FRAMEWORK_AGENTCORE_ADAPTER" && entry.via === "agentcore" && entry.value.kind === "reference" && entry.value.display.includes("secondary, primary")));
  assert.equal(model.gateways?.filter(gateway => gateway.protocol === "agentcore").length, 3);
  const firstHop = model.edges.filter(edge => edge.relation === "usesGateway");
  assert.deepEqual(firstHop.map(edge => edge.to), ["gateway:agentcore:secondary", "gateway:agentcore:primary"]);
  assert.ok(firstHop.every(edge => edge.authorization?.grants.length === 1 && edge.authorization.grants[0]!.actions?.includes("bedrock-agentcore:InvokeGateway")));
  const secondHop = model.edges.filter(edge => edge.relation === "usesTool");
  assert.equal(secondHop.length, 3);
  assert.ok(secondHop.every(edge => edge.from.startsWith("gateway:agentcore:") && edge.authorization?.grants[0]?.principalEntity === edge.from && edge.authorization.grants[0].actions?.includes("lambda:InvokeFunction")));
  assert.ok(!model.edges.some(edge => edge.from === selected.ref && edge.to.startsWith("lambda:")));
  assert.deepEqual(model.targets.find(target => target.id === "first")!.lanes.derivedFrom, ["gateway:agentcore:primary", "gateway:agentcore:secondary"]);
});

test("Gateway-only deployment conditions expose catalog dependencies and mode outcomes", () => {
  const config = fixtureConfig({ agents: [], gateways: [{ conditional: { tools: [], deploy: { when: { resource: resources.flag, equals: "enabled" } } } }] });
  const model = projectModel(config, { mode: "dev", inputs: { dev: { holds: () => true }, prod: { holds: () => false } } });
  const gateway = model.gateways!.find(gateway => gateway.protocol === "agentcore")!;
  assert.deepEqual([gateway.lanes.local, gateway.lanes.cloud, gateway.lanes.dev, gateway.lanes.prod], [true, true, false, false]);
  assert.ok(model.edges.some(edge => edge.relation === "deployWhen" && edge.from === "resource:flag" && edge.to === gateway.id));
  assert.ok(model.resources.some(resource => resource.id === "resource:flag"));
});

test("literal Gateway source lists expose editability and source evidence; ordered edits preserve other settings", () => {
  const current = fixture();
  try {
    assert.equal(current.state.built.index.editability["gateway:agentcore:primary"]?.tools?.kind, "literal");
    assert.equal(current.state.built.index.editability["agent:assistant"]?.gateways?.kind, "literal");
    const model = withConnectionEvidence(current.root, current.state.snapshot.models.dev, current.state.built.index, current.state.built.catalog);
    assert.ok(model.edges.filter(edge => edge.relation === "usesGateway" || edge.relation === "usesTool").every(edge => edge.evidence?.some(evidence => evidence.role === "declared")));
    const changes = new Map<string, string>();
    planGatewayOperation(current.root, current.state, { kind: "agentGateways", target: "agent:assistant", gateways: ["primary", "secondary"] }, changes);
    planGatewayOperation(current.root, current.state, { kind: "gatewayTools", gateway: "gateway:agentcore:primary", tools: ["second", "first"] }, changes);
    assert.match(changes.get(path.join(current.root, "framework-config/workloads/agents.ts"))!, /\["primary","secondary"\]/);
    assert.match(changes.get(path.join(current.root, "framework-config/workloads/gateways.ts"))!, /primary: \{ tools: \["second","first"\] \}/);
    planGatewayOperation(current.root, current.state, { kind: "gatewayDeploy", gateway: "gateway:agentcore:empty", value: { when: { resource: "resource:flag", equals: "enabled" } } }, changes);
    const declared = changes.get(path.join(current.root, "framework-config/workloads/gateways.ts"))!;
    assert.match(declared, /deploy: \{ when: \{ resource: inputs\["flag"\], equals: "enabled" \} \}/);
    assert.match(declared, /import \{ resources as inputs \} from "\.\.\/inputs"/);
    assert.match(readFileSync(path.join(current.root, "framework-config/workloads/agents.ts"), "utf8"), /\["secondary", "primary"\]/, "planning leaves saved source untouched");
  } finally { current.dispose(); }
});

test("Gateway removal checks consumers; list writers reject computed, commented and missing references", () => {
  const current = fixture();
  try {
    assert.throws(() => planGatewayOperation(current.root, current.state, { kind: "removeGateway", gateway: "gateway:agentcore:primary" }, new Map()), /Disconnect agents/);
    const changes = new Map<string, string>();
    planGatewayOperation(current.root, current.state, { kind: "removeGateway", gateway: "gateway:agentcore:empty" }, changes);
    assert.ok(!changes.get(path.join(current.root, "framework-config/workloads/gateways.ts"))!.includes("empty:"));
    assert.throws(() => planGatewayOperation(current.root, current.state, { kind: "agentGateways", target: "agent:assistant", gateways: ["missing"] }, new Map()), /existing/);
    assert.throws(() => planGatewayOperation(current.root, current.state, { kind: "gatewayTools", gateway: "gateway:agentcore:empty", tools: ["missing"] }, new Map()), /existing/);
    for (const array of ['[...shared]', '["first" /* keep */]']) {
      current.write("framework-config/workloads/gateways.ts", `export const gateways = { primary: { tools: ${array} }, empty: {} };\n`);
      assert.throws(() => planGatewayOperation(current.root, current.state, { kind: "gatewayTools", gateway: "gateway:agentcore:primary", tools: [] }, new Map()), /computed or commented/);
    }
  } finally { current.dispose(); }
});

test("Gateway creation reuses section registration and never scaffolds Lambda or authored environment files", () => {
  const current = fixture();
  try {
    const proposal = planCreation(current.root, current.state, readCreationRequest({ kind: "gateway", id: "new-gateway", tools: [] }));
    assert.equal(proposal.expected.select, "gateway:agentcore:new-gateway");
    assert.deepEqual(proposal.expected.gateways, [proposal.expected.select]);
    assert.match(proposal.overrides.get(path.join(current.root, "framework-config/workloads/gateways.ts"))!, /["']?new-gateway["']?:/);
    assert.ok([...proposal.overrides.keys()].every(file => path.relative(current.root, file).split(path.sep)[0] === "framework-config"));
    assert.ok(![...proposal.overrides.keys()].some(file => /(?:[\\/]compute[\\/]|\.env\.)/.test(file)));
  } finally { current.dispose(); }
});

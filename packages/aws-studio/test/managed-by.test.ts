import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig, defineNetwork, defineInputs, defineStacks, getFrameworkTargets, getGateways,
  input, stack, cdk, validateManagedBy, workflow, succeed, isCdkResource, isResourceReference,
} from "aws-studio/config";

const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } } } as const;
type Data = { readonly bucket: { readonly node: { readonly id: string; readonly path: string }; readonly bucketName: string }; readonly endpoint: string };

test("managedBy accepts only the two owners and leaves developer as the default", () => {
  assert.equal(validateManagedBy(undefined), undefined);
  assert.equal(validateManagedBy("framework"), "framework");
  assert.equal(validateManagedBy("developer"), "developer");
  for (const value of ["Framework", "platform", true, null, {}]) assert.throws(() => validateManagedBy(value, "inputs.x"), /inputs\.x: managedBy must be "framework" or "developer"/);
});

test("inputs, stacks and constructs keep declared ownership through catalog finalization", () => {
  const inputs = defineInputs({
    secret: input.secret("SECRET", { managedBy: "framework" }),
    setting: input.fromEnv("SETTING", { managedBy: "framework", tags: { area: "auth" } }).default("x"),
    value: input.value("public", { managedBy: "developer" }),
    plain: input.fromEnv("PLAIN"),
  });
  assert.equal(inputs.secret.managedBy, "framework");
  assert.equal(inputs.secret.arn.managedBy, "framework", "a secret's projections are the same declaration");
  assert.equal(inputs.setting.managedBy, "framework");
  assert.deepEqual(inputs.setting.tags, { area: "auth" });
  assert.equal(inputs.value.managedBy, "developer");
  assert.equal(inputs.plain.managedBy, undefined);
  assert.throws(() => input.fromEnv("BAD", { managedBy: "nobody" as never }), /managedBy must be/);

  const stacks = defineStacks({ data: stack<Data>({ managedBy: "framework", members: { bucket: { tags: { area: "x" } } } }), own: stack<Data>(), table: cdk<Data["bucket"]>({ managedBy: "framework" }) });
  assert.equal(stacks.data.managedBy, "framework");
  assert.equal(stacks.own.managedBy, undefined);
  assert.equal(stacks.table.managedBy, "framework");
  // Members follow their stack, so reading the field never mints a member or an attribute.
  assert.equal(stacks.data.bucket.managedBy, undefined);
  assert.ok(isCdkResource(stacks.data.bucket));
  assert.equal((stacks.own as unknown as Record<string, unknown>).managedBy, undefined);
  assert.ok(!isResourceReference((stacks.table as unknown as Record<string, unknown>).managedBy));
  assert.throws(() => stack<Data>({ members: { bucket: { managedBy: "framework" } as never } }), /member bucket declares managedBy.*set managedBy on the stack\(\) entry/);
});

test("workload ownership is per declaration, agreed by shared routes and never inherited from defaults", () => {
  const route = { directory: "compute/http/shared", methods: ["GET"], managedBy: "framework" } as const;
  const config = defineFrameworkConfig({ defaults, http: [{ "/first": route }, { "/second": route }, { "/own": { directory: "compute/http/own", methods: ["GET"] } }], webSocket: [], services: [], events: [] });
  const targets = getFrameworkTargets(config);
  assert.equal(targets.find(target => target.id === "shared")!.managedBy, "framework");
  assert.equal(targets.find(target => target.id === "own")!.managedBy, undefined);
  assert.throws(() => defineFrameworkConfig({ defaults, http: [{ "/first": route }, { "/second": { ...route, managedBy: "developer" } }], webSocket: [], services: [], events: [] }), /conflicting managedBy/);
  assert.throws(() => defineFrameworkConfig({ defaults: { ...defaults, managedBy: "framework" } as never, http: [], webSocket: [], services: [], events: [] }), /defaults\.managedBy is not supported/);
  assert.throws(() => defineFrameworkConfig({ defaults: { ...defaults, http: { managedBy: "framework" } } as never, http: [], webSocket: [], services: [], events: [] }), /defaults\.http\.managedBy is not supported/);
});

test("networks, workflows and AgentCore gateways carry declared ownership", () => {
  assert.equal(defineNetwork({ id: "one", cidr: "10.0.0.0/16", zones: 2, managedBy: "framework" }).managedBy, "framework");
  assert.equal(defineNetwork({ id: "two", cidr: "10.1.0.0/16", zones: 2 }).managedBy, undefined);
  assert.throws(() => defineNetwork({ id: "bad", cidr: "10.2.0.0/16", zones: 2, managedBy: "x" as never }), /managedBy must be/);
  const graph = workflow(() => succeed(), { timeoutSeconds: 30, managedBy: "framework" });
  const config = defineFrameworkConfig({ defaults, http: [], webSocket: [], services: [], events: [], workflows: [{ billing: graph }], tools: [], gateways: [{ "billing-gateway": { tools: [], managedBy: "framework" } }] });
  assert.equal(getFrameworkTargets(config).find(target => target.kind === "workflow")!.managedBy, "framework");
  assert.equal(getGateways(config)[0]!.managedBy, "framework");
});

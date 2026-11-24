import assert from "node:assert/strict";
import test from "node:test";
import { defineFrameworkConfig, defineNetwork, definePrivateHostedZone, getFrameworkTargets, assertPrivateDnsLocalExecution, privateRecordName, type PrivateDnsRecord, type FrameworkPrivateHostedZone } from "aws-studio/config";
import { invokeLocalNodeLambda, LocalLambdaExecutor, resolveLocalServiceUrl } from "aws-studio/local";

const a = defineNetwork({ id: "a", cidr: "10.20.0.0/16", zones: 2 });
const b = defineNetwork({ id: "b", cidr: "10.21.0.0/16", zones: 2 });
const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } } } as const;
const record: PrivateDnsRecord = { id: "api", name: "api", type: "A", target: { kind: "ecs-internal-alb", service: "orders" } };
const zone = (extra: Partial<Parameters<typeof definePrivateHostedZone>[0]> = {}) => definePrivateHostedZone({ id: "internal", name: "internal.parity.test", vpcs: [a], records: [record], ...extra });
function config(zones: readonly FrameworkPrivateHostedZone[], auth = false) {
  return defineFrameworkConfig({ defaults, networks: [a, b], privateHostedZones: zones,
    http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], vpc: a } }],
    services: [{ "/orders/*": { directory: "compute/services/orders", methods: ["GET"], ...(auth ? { auth: true as const } : {}), cloud: { vpc: a } } }], events: [], webSocket: [],
  });
}

test("private zones use valid unregistered names, stable identities and multiple VPC associations", () => {
  const declared = zone({ name: "INTERNAL.PARITY.TEST.", vpcs: [a, b] });
  assert.equal(declared.name, "internal.parity.test");
  assert.equal(declared.cloud.constructId, "InternalPrivateHostedZoneStack");
  assert.equal(declared.records[0]!.enabled, true);
  assert.deepEqual(declared.records[0]!.allowFrom, []);
  assert.equal(config([declared]).privateHostedZones?.[0], declared);
  assert.equal(privateRecordName(declared.name, "@"), declared.name);
  assert.equal(privateRecordName(declared.name, "api.internal.parity.test."), "api.internal.parity.test");
  assert.equal(privateRecordName(declared.name, "api.internal.parity.test"), "api.internal.parity.test");
  assert.ok(Object.isFrozen(declared) && Object.isFrozen(declared.vpcs) && Object.isFrozen(declared.records));
});

test("private DNS rejects unsupported records, duplicate names, invalid namespaces and unregistered VPC identities", () => {
  for (const name of ["https://internal.test", "internal.test:80", "*.internal.test", "bad/name.test", ".internal.test", "localhost"]) assert.throws(() => zone({ name }));
  assert.throws(() => zone({ vpcs: [] }), /at least one/);
  assert.throws(() => zone({ records: [{ ...record, type: "CNAME" } as never] }), /A alias/);
  assert.throws(() => zone({ records: [record, { ...record, id: "second" }] }), /duplicate A record/);
  assert.throws(() => zone({ records: [{ ...record, name: "other.test." }] }), /outside private zone/);
  const otherA = defineNetwork({ id: "a", cidr: a.cidr, zones: 2 });
  assert.throws(() => config([zone({ vpcs: [otherA] })]), /same declaration/);
  assert.throws(() => config([zone(), zone({ id: "other" })]), /cannot associate two/);
  assert.doesNotThrow(() => config([zone(), zone({ id: "other", vpcs: [b], records: [] })]));
});

test("endpoint capabilities validate grants independently of DNS visibility and protect API authorizers", () => {
  const granted = zone({ records: [{ ...record, allowFrom: ["lambda:caller"] }] });
  assert.doesNotThrow(() => config([granted]));
  assert.throws(() => config([granted], true), /bypass.*authorizer/);
  assert.doesNotThrow(() => config([zone()], true), "an alias grants no ingress around an authenticated API");
  assert.throws(() => config([zone({ records: [{ ...record, target: { kind: "ecs-internal-alb", service: "missing" } }] })]), /declared ECS service/);
  assert.throws(() => config([zone({ records: [{ ...record, allowFrom: ["lambda:missing"] }] })]), /same VPC/);
});

test("unqualified private DNS execution fails closed and non-DNS workloads preserve their existing lane", () => {
  const configured = config([zone()]);
  assert.throws(() => assertPrivateDnsLocalExecution(configured, "lambda:caller", getFrameworkTargets(configured)), /local execution is not available/);
  assert.throws(() => assertPrivateDnsLocalExecution(configured, "service:orders", getFrameworkTargets(configured)), /no host-network fallback/);
  const disabled = config([zone({ enabled: false })]);
  assert.doesNotThrow(() => assertPrivateDnsLocalExecution(disabled, "lambda:caller", getFrameworkTargets(disabled)));
  const ordinary = config([]);
  assert.doesNotThrow(() => assertPrivateDnsLocalExecution(ordinary, "lambda:caller", getFrameworkTargets(ordinary)));
});

test("normal local execution entry points refuse private DNS before loading a handler or selecting a host endpoint", async () => {
  const configured = config([zone()]);
  const options = { repositoryRoot: process.cwd() };
  const executor = new LocalLambdaExecutor({ config: configured, ...options, pool: null });
  try {
    await assert.rejects(executor.invoke("lambda:caller", {}), /private DNS local execution is not available/);
    await assert.rejects(invokeLocalNodeLambda(configured, "lambda:caller", {}, options), /private DNS local execution is not available/);
    assert.throws(() => resolveLocalServiceUrl(configured, "service:orders", options.repositoryRoot), /private DNS local execution is not available/);
  } finally {
    await executor.close();
  }
});

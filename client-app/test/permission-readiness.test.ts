import assert from "./support/assert";
import test from "node:test";
import { assertCloudEdgesResolvable, defineFrameworkConfig, defineNetwork, defineInputs, input, runsTask, validateFrameworkConfig, withDeferredInvocationAvailability, type DeploySetting } from "aws-studio/config";
import { projectModel } from "../server/model/project";
import { withPermissionReadiness } from "../shared/permission-readiness";
import { withLocalDatabases } from "../server/database";
import { withConnectionAuthorizations } from "../shared/permissions";
import type { LocalDatabase } from "../shared/database";
import type { ModeModel, ModelEdge, ModelResource, SourceIndex, SourceLocation } from "../shared/model";
import { aggregateConnections, missingConnectionInput } from "../src/connections";
import { targetIssues, resourceIssues } from "../src/issues";
import { invocationAccessReason } from "../shared/workload-operations";

function model(): ModeModel {
  const base = projectModel(defineFrameworkConfig({ defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"] } }], webSocket: [], events: [], services: [] }), { mode: "prod" });
  const stack: ModelResource = { id: "resource:storage", path: ["storage"], kind: "stack", absent: false, stackClass: "Storage", stackUsage: { status: "unreferenced", sites: [] } };
  const bucket: ModelResource = { id: "resource:storage.files", path: ["storage", "files"], kind: "member", parent: stack.id, absent: false };
  const edge: ModelEdge = { id: "read-files", from: "lambda:caller", to: bucket.id, relation: "grant", label: "Read objects", provenance: "declared", permissionContext: { kind: "resourceAccess", actions: ["read"] } };
  return { ...base, resources: [stack, bucket], edges: [edge] };
}

test("disconnected declarations stay source-valid while permission edges, callers and resources carry readiness errors", () => {
  const before = model(), after = withPermissionReadiness(before);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.diagnostics, before.diagnostics);
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.code, "stack-not-constructed");
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.blocksDeployment, true);
  assert.ok(after.targets[0]!.readinessIssues?.length);
  assert.ok(after.resources.every(resource => resource.readinessIssues?.length));
  assert.ok(targetIssues(after.targets[0]!).some(issue => issue.severity === "error"));
  assert.ok(resourceIssues(after.resources[0]!).some(issue => issue.title === "Not created in application.ts"));
  const connection = aggregateConnections(after)[0]!;
  assert.equal(missingConnectionInput(connection), true, "readiness errors use the map's error presentation and filter");
  assert.equal(before.edges[0]!.readinessIssues, undefined, "projection does not mutate source data");
});

test("fresh construction evidence clears saved connection readiness without removing access", () => {
  const disconnected = withPermissionReadiness(model());
  const connected = withPermissionReadiness({ ...disconnected, resources: disconnected.resources.map(resource => resource.kind === "stack" ? { ...resource, stackUsage: { ...resource.stackUsage!, status: "referenced" as const } } : resource) });
  assert.equal(connected.edges.length, 1);
  assert.equal(connected.edges[0]!.readinessIssues, undefined);
  assert.deepEqual(connected.targets[0]!.readinessIssues, []);
  assert.deepEqual(connected.resources[0]!.readinessIssues, []);
  assert.deepEqual(connected.readinessIssues, []);
});

test("unknown construction is an explicit warning and local-only callers retain editable readiness information", () => {
  const base = model();
  const unknown = withPermissionReadiness({ ...base, resources: base.resources.map(resource => resource.kind === "stack" ? { ...resource, stackUsage: { ...resource.stackUsage!, status: "unknown" as const } } : resource) });
  assert.equal(unknown.resources[0]!.readinessIssues?.[0]?.severity, "warning");
  assert.equal(unknown.resources[0]!.readinessIssues?.[0]?.blocksDeployment, false);
  assert.ok(unknown.edges[0]!.readinessIssues?.some(issue => issue.code === "construction-unknown"));
  assert.ok(unknown.targets[0]!.readinessIssues?.some(issue => issue.severity === "warning"));
  const local = withPermissionReadiness({ ...base, mode: "dev", targets: base.targets.map(target => ({ ...target, lanes: { ...target.lanes, dev: false } })) });
  assert.equal(local.edges[0]!.readinessIssues?.[0]?.blocksDeployment, false);
  assert.equal(local.status, "ok");
});

test("saved workload ARN references flag undeployed targets separately from source validity", () => {
  const base = model(), caller = base.targets[0]!;
  const unavailable = { ...caller, ref: "lambda:undeployed", id: "undeployed", title: "Undeployed", lanes: { ...caller.lanes, prod: false } };
  const after = withPermissionReadiness({ ...base, targets: [caller, unavailable], edges: [{ ...base.edges[0]!, to: unavailable.ref, permissionContext: { kind: "iamPolicy", index: 0, statement: { actions: ["lambda:InvokeFunction"], resources: [{ kind: "target", target: unavailable.ref }] } } }] });
  assert.equal(after.status, "ok");
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.code, "resource-unavailable");
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.blocksDeployment, true);
  assert.ok(after.targets.every(target => target.readinessIssues?.length));
});

function replayDatabase(mode: "dev" | "prod"): ModeModel {
  const base = model(), caller = base.targets[0]!;
  if (caller.compute.kind !== "lambda") throw new Error("Expected a Lambda fixture.");
  const stack: ModelResource = { id: "resource:rds", path: ["rds"], kind: "stack", absent: mode === "dev", stackUsage: { status: "referenced", sites: [] } };
  const database: ModelResource = { id: "resource:rds.database", path: ["rds", "database"], kind: "member", parent: stack.id, absent: mode === "dev" };
  return { ...base, mode, resources: [stack, database],
    targets: [{ ...caller, role: "event", lanes: { ...caller.lanes, local: true, dev: true, prod: true }, compute: { ...caller.compute, localReplay: true } }],
    edges: [{ id: "database:lambda:caller->resource:rds.database#0", from: caller.ref, to: database.id, relation: "database", provenance: "declared", label: "database", permissionContext: { kind: "database", connection: "application", readers: false } }],
  };
}

test("replay database connections belong to local PostgreSQL in dev and RDS only in prod", () => {
  const postgres: LocalDatabase = { id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image: "postgres:16", volumes: [], enabled: true, source: { file: "docker-compose.yml", line: 1, column: 1, start: 0, end: 1 } };
  const declared = withPermissionReadiness(replayDatabase("dev"));
  assert.deepEqual(declared.readinessIssues, [], "the AWS replay capture function does not require development RDS");
  const dev = withPermissionReadiness(withConnectionAuthorizations(withLocalDatabases(declared, [postgres])));
  assert.deepEqual(dev.edges.map(edge => edge.to), [postgres.id]);
  assert.equal(dev.edges[0]!.authorization?.kind, "local");
  assert.deepEqual(dev.edges[0]!.authorization?.grants, []);
  assert.deepEqual(dev.targets[0]!.readinessIssues, []);
  assert.deepEqual(withLocalDatabases(dev, [postgres]).edges, dev.edges, "refreshes retain the local connection without recreating the RDS edge");
  const prod = withPermissionReadiness(withConnectionAuthorizations(withLocalDatabases(replayDatabase("prod"), [postgres])));
  assert.deepEqual(prod.edges.map(edge => edge.to), ["resource:rds.database"]);
  assert.equal(prod.edges[0]!.authorization?.kind, "iam");
  assert.deepEqual(prod.readinessIssues, []);
  const connection = aggregateConnections(dev, [dev, prod]).find(item => item.members.some(member => member.edge.to === "resource:rds.database"))!;
  assert.deepEqual(connection.availability, { dev: false, prod: true });
  assert.equal(connection.members[0]!.models.dev, undefined);
  assert.equal(missingConnectionInput(connection), false, "a production-only connection is not an error in the development union view");
});

test("actual development AWS database callers still require an available database", () => {
  const before = replayDatabase("dev");
  const after = withPermissionReadiness({ ...before, targets: before.targets.map(target => ({ ...target, compute: target.compute.kind === "lambda" ? { ...target.compute, localReplay: undefined } : target.compute })) });
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.code, "resource-unavailable");
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.blocksDeployment, true);
});

test("event-to-task bindings remain editable source while strict development synthesis refuses missing task construction", () => {
  const network = defineNetwork({ id: "application", cidr: "10.0.0.0/16", zones: 2 });
  const config = defineFrameworkConfig({ networks: [network], defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: [], webSocket: [], services: [],
    events: [{ caller: { directory: "compute/events/caller", cloud: { bindings: [runsTask("worker")] } } }],
    tasks: [{ worker: { directory: "compute/tasks/worker", cloud: { vpc: network } } }],
  });
  const dev = projectModel(config, { mode: "dev" }), prod = projectModel(config, { mode: "prod" });
  assert.equal(dev.status, "ok", "source validity does not imply deployment readiness");
  assert.deepEqual(dev.diagnostics.filter(issue => issue.severity === "error"), []);
  assert.ok(dev.edges.find(edge => edge.relation === "runsTask")?.readinessIssues?.some(issue => issue.blocksDeployment));
  assert.equal(prod.status, "ok");
  assert.deepEqual(prod.readinessIssues, []);
  assert.equal(invocationAccessReason(dev.targets.find(target => target.ref === "lambda:caller")!, dev.targets.find(target => target.ref === "task:worker")!, [dev, prod]), undefined);
  assert.throws(() => assertCloudEdgesResolvable(config, "dev"), /does not build/);
  assert.doesNotThrow(() => assertCloudEdgesResolvable(config, "prod"));
});

test("Studio retains incompatible invocation lanes and conditions with line errors while execution validation stays strict", () => {
  const network = defineNetwork({ id: "application", cidr: "10.0.0.0/16", zones: 2 });
  const inputs = defineInputs({ enabled: input.value("yes") });
  const conditional: DeploySetting = { when: { resource: inputs.enabled, equals: "yes" } };
  for (const [callerDeploy, workerDeploy] of [["both", "local-only"], ["both", "cloud-only"], ["local-only", "cloud-only"], ["cloud-only", "local-only"], ["both", conditional], [conditional, { when: { resource: inputs.enabled, equals: "no" } }]] as const) {
    const makeConfig = () => defineFrameworkConfig({ inputs, networks: [network], defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
      http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], deploy: callerDeploy, cloud: { bindings: [runsTask("worker")] } } }],
      tasks: [{ worker: { directory: "compute/tasks/worker", deploy: workerDeploy, cloud: { vpc: network } } }], webSocket: [], events: [], services: [],
    });
    assert.throws(makeConfig, /lane|identical condition/);
    const config = withDeferredInvocationAvailability(makeConfig);
    for (const mode of ["dev", "prod"] as const) for (const holds of [true, false]) {
      const projected = projectModel(config, { mode, inputs: { dev: { holds: () => holds }, prod: { holds: () => holds } } });
      assert.equal(projected.status, "ok");
      const connection = projected.edges.find(edge => edge.relation === "runsTask")!;
      assert.ok(connection.readinessIssues?.some(issue => issue.severity === "error"));
      assert.ok(projected.targets.every(target => target.readinessIssues?.length));
      assert.equal(missingConnectionInput(aggregateConnections(projected).find(group => group.members.some(member => member.edge.id === connection.id))!), true);
      const caller = projected.targets.find(target => target.ref === "lambda:caller")!, worker = projected.targets.find(target => target.ref === "task:worker")!;
      assert.equal(invocationAccessReason(caller, worker, [projected]), undefined);
    }
    assert.throws(() => validateFrameworkConfig(config), /lane|identical condition/);
    assert.throws(() => assertCloudEdgesResolvable(config, "prod"), /lane|identical condition/);
    const aligned = { ...config, tasks: { ...config.tasks, worker: { ...config.tasks!.worker, deploy: callerDeploy } } };
    assert.doesNotThrow(() => validateFrameworkConfig(aligned));
    const fixed = projectModel(aligned, { mode: "prod", inputs: { dev: { holds: () => true }, prod: { holds: () => true } } });
    assert.deepEqual(fixed.edges.find(edge => edge.relation === "runsTask")?.readinessIssues ?? [], [], "aligning deployment clears the line error without removing the binding");
  }
});

test("inspection availability scope restores strict checks after nested scopes and failures", () => {
  const network = defineNetwork({ id: "application", cidr: "10.0.0.0/16", zones: 2 });
  const makeConfig = (binding = "worker") => defineFrameworkConfig({ networks: [network], defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
    http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], cloud: { bindings: [runsTask(binding as never)] } } }],
    tasks: [{ worker: { directory: "compute/tasks/worker", deploy: "local-only", cloud: { vpc: network } } }], webSocket: [], events: [], services: [],
  });
  withDeferredInvocationAvailability(() => {
    withDeferredInvocationAvailability(() => makeConfig());
    assert.doesNotThrow(() => makeConfig());
    assert.throws(() => makeConfig("missing"), /not declared/);
  });
  assert.throws(() => makeConfig(), /lane/);
  assert.throws(() => withDeferredInvocationAvailability(() => { throw new Error("inspection failed"); }), /inspection failed/);
  assert.throws(() => makeConfig(), /lane/);
});

const at: SourceLocation = { file: "cdk-app/lib/app/storage.ts", line: 1, column: 1, start: 0, end: 1 };
function linkedSource(links: SourceIndex["links"] = {}, analysis: NonNullable<SourceIndex["linkAnalysis"]> = { complete: true, groups: [], unknown: [] }): SourceIndex {
  return { entities: {}, editability: {}, links, linkAnalysis: analysis, catalog: { "resource:storage": { stackLocation: at } }, problems: [], cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] } };
}
function constructed(): ModeModel {
  const before = model();
  return { ...before, resources: before.resources.map(resource => resource.kind === "stack" ? { ...resource, stackUsage: { status: "referenced", sites: [at] } } : resource) };
}

test("constructed but unlinked public resources retain saved access and located readiness errors", () => {
  const before = constructed(), after = withPermissionReadiness(before, linkedSource());
  assert.equal(after.status, "ok");
  assert.deepEqual(after.diagnostics, before.diagnostics);
  assert.equal(after.edges.length, 1);
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.code, "resource-not-linked");
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.blocksDeployment, true);
  assert.ok(after.targets.every(target => target.readinessIssues?.some(issue => issue.code === "resource-not-linked")));
  assert.ok(after.resources.every(resource => resource.readinessIssues?.some(issue => issue.code === "resource-not-linked")));
  assert.equal(missingConnectionInput(aggregateConnections(after)[0]!), true);
  const local = withPermissionReadiness({ ...before, mode: "dev", targets: before.targets.map(target => ({ ...target, lanes: { ...target.lanes, dev: false } })) }, linkedSource());
  assert.equal(local.edges[0]!.readinessIssues?.[0]?.blocksDeployment, false);
});

test("exact links and public stack group links clear missing-link readiness without prefix collisions", () => {
  const before = constructed();
  for (const source of [linkedSource({ "storage.files": [at] }), linkedSource({ storage: [at] }, { complete: true, groups: ["storage"], unknown: [] })]) {
    const after = withPermissionReadiness(before, source);
    assert.deepEqual(after.readinessIssues, []);
    assert.equal(after.edges.length, 1);
  }
  const sibling = withPermissionReadiness(before, linkedSource({ "storage.filesArchive": [at] }));
  assert.equal(sibling.edges[0]!.readinessIssues?.[0]?.code, "resource-not-linked");
  const detached = withPermissionReadiness(model(), linkedSource({ storage: [at] }, { complete: true, groups: ["storage"], unknown: [] }));
  assert.equal(detached.edges[0]!.readinessIssues?.[0]?.code, "stack-not-constructed", "a link in an unconstructed class is not deployment evidence");
});

test("custom and incomplete link analysis is a warning, scoped to affected catalog paths or owning stacks", () => {
  const before = constructed();
  for (const analysis of [
    { complete: true, groups: [], unknown: [{ path: "storage", source: at, reason: "Computed stack selection." }] },
    { complete: true, groups: [], unknown: [{ source: at, reason: "Unresolved constructor parameter." }] },
    { complete: false, groups: [], unknown: [] },
  ]) {
    const after = withPermissionReadiness(before, linkedSource({}, analysis));
    assert.equal(after.edges[0]!.readinessIssues?.[0]?.code, "link-unknown");
    assert.equal(after.edges[0]!.readinessIssues?.[0]?.severity, "warning");
    assert.equal(after.edges[0]!.readinessIssues?.[0]?.blocksDeployment, false);
    assert.ok(after.targets[0]!.readinessIssues?.some(issue => issue.code === "link-unknown"));
  }
  const unrelated = linkedSource({}, { complete: true, groups: [], unknown: [{ path: "other", source: at, reason: "Custom code for another reference." }, { source: { ...at, file: "cdk-app/lib/app/other.ts" }, reason: "Unresolved other constructor." }] });
  const after = withPermissionReadiness(before, { ...unrelated, catalog: { ...unrelated.catalog, "resource:other": { stackLocation: { ...at, file: "cdk-app/lib/app/other.ts" } } } });
  assert.equal(after.edges[0]!.readinessIssues?.[0]?.code, "resource-not-linked");
});

test("standalone native declarations require exact links while authored inputs do not", () => {
  const before = constructed(), edge = before.edges[0]!;
  const native: ModelResource = { id: "resource:jobs", path: ["jobs"], kind: "construct", absent: false };
  const standalone = { ...before, resources: [native], edges: [{ ...edge, to: native.id }] };
  const missing = withPermissionReadiness(standalone, linkedSource());
  assert.equal(missing.edges[0]!.readinessIssues?.[0]?.code, "resource-not-linked");
  assert.ok(missing.resources[0]!.readinessIssues?.length);
  assert.deepEqual(withPermissionReadiness(standalone, linkedSource({ jobs: [at] })).readinessIssues, []);
  const input = { ...native, id: "resource:region", path: ["region"], kind: "input" as const };
  assert.deepEqual(withPermissionReadiness({ ...before, resources: [input], edges: [{ ...edge, to: input.id }] }, linkedSource()).readinessIssues, []);
});

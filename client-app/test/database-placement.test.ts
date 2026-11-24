import { copyStudioTestProject, sourceFixtureCheckpoint } from "./support/source-fixture";
import assert from "./support/assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { planDatabasePlacement } from "../server/edits/database";
import { databaseConsumers, type DatabasePlacementEdit } from "../shared/managed-database";

let fixture: string;
let builder: SnapshotBuilder;
let edits: EditService;
before(async () => {
  fixture = copyStudioTestProject("database-");
  mkdirSync(path.join(fixture, "framework-config/networks/database-relocation"), { recursive: true });
  writeFileSync(path.join(fixture, "framework-config/networks/database-relocation/index.ts"), 'import { defineNetwork } from "aws-studio/config"; export const destinationVpc = defineNetwork({ id: "database-relocation", cloud: { constructId: "DatabaseRelocationStack" }, cidr: "10.77.0.0/16", zones: 2, egressOnlyInternetGateway: true });');
  const configFile = path.join(fixture, "framework.config.ts");
  const config = readFileSync(configFile, "utf8");
  assert.match(config, /networks:\s*\[/, "the starter has a literal network registry");
  writeFileSync(configFile, 'import { destinationVpc } from "./framework-config/networks/database-relocation";\n' + config.replace(/networks:\s*\[/, "networks: [destinationVpc, "));
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
});
let restoreSource: () => Promise<void>;
beforeEach(() => { restoreSource = sourceFixtureCheckpoint(fixture, builder); });
afterEach(async () => { await restoreSource(); });

after(async () => { await builder?.dispose(); if (fixture) rmSync(fixture, { recursive: true, force: true }); });
const state = () => builder.current!;
const relocation = (): DatabasePlacementEdit => ({ kind: "databasePlacement", database: state().snapshot.models.dev.managedDatabase!.id, vpc: "database-relocation", subnet: "isolated" });

test("database placement coordinates all consumers, preserves database contracts, with exact source bytes", async () => {
  const baseline = state().snapshot;
  const database = baseline.models.dev.managedDatabase!;
  const consumers = databaseConsumers(Object.values(baseline.models), database.id);
  assert.ok(consumers.length > 0);
  const compose = readFileSync(path.join(fixture, "docker-compose.yml"), "utf8");
  const native = readFileSync(path.join(fixture, "cdk-app/lib/app/rds-stack.ts"), "utf8");
  const databaseFile = path.join(fixture, "framework-config/databases/application.ts");
  const sourceBeforePlan = readFileSync(databaseFile);
  const plan = await edits.planBatch([relocation()], baseline.revision);
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.ok(plan.changes.every(change => change.file.startsWith("framework-config/")));
  assert.ok(plan.impact.some(message => message.includes("does not copy data")));
  const originals = new Map(plan.changes.map(change => [change.file, readFileSync(path.join(fixture, change.file), "utf8")]));
  assert.deepEqual(readFileSync(databaseFile), sourceBeforePlan, "planning never writes source");
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  for (const mode of ["dev", "prod"] as const) {
    const model = state().snapshot.models[mode];
    assert.equal(model.managedDatabase!.networkId, "database-relocation");
    assert.equal(model.managedDatabase!.resource, database.resource);
    assert.equal(model.managedDatabase!.databaseName, database.databaseName);
    assert.deepEqual(model.managedDatabase!.settings, database.settings);
    for (const consumer of consumers) {
      const before = baseline.models[mode].targets.find(target => target.ref === consumer.target)!;
      const after = model.targets.find(target => target.ref === consumer.target)!;
      assert.equal(after.constructId, before.constructId);
      assert.ok(after.placement.kind === "vpc" && after.placement.networkId === "database-relocation");
      assert.equal(after.placement.subnet, before.placement.kind === "vpc" ? before.placement.subnet : undefined);
      assert.deepEqual(after.environment, before.environment);
      assert.deepEqual(after.access, before.access);
    }
  }
  assert.deepEqual(state().snapshot.models.dev.localServices, baseline.models.dev.localServices);
  assert.equal(readFileSync(path.join(fixture, "docker-compose.yml"), "utf8"), compose);
  assert.equal(readFileSync(path.join(fixture, "cdk-app/lib/app/rds-stack.ts"), "utf8"), native);
  await restoreSource();
  for (const [file, text] of originals) assert.equal(readFileSync(path.join(fixture, file), "utf8"), text);
  await restoreSource();
});

test("unsafe or competing placement edits are refused before any file is written", async () => {
  const file = path.join(fixture, "framework-config/databases/application.ts");
  const before = readFileSync(file, "utf8");
  await assert.rejects(edits.planBatch([{ ...relocation(), vpc: "missing" }], state().snapshot.revision), /registered/);
  const consumer = databaseConsumers(Object.values(state().snapshot.models), relocation().database)[0]!;
  await assert.rejects(edits.planBatch([relocation(), { kind: "placement", target: consumer.target, vpc: "database-relocation", subnet: "private" }], state().snapshot.revision), /already includes/);
  for (const text of [before.replace("vpc: applicationVpc", "vpc: chooseVpc()"), before.replace("subnet: \"isolated\"", "subnet: computedSubnet"), before.replace("vpc: applicationVpc", "vpc: applicationVpc, vpc: applicationVpc")]) {
    assert.notEqual(text, before);
    assert.throws(() => planDatabasePlacement(fixture, state(), relocation(), new Map([[file, text]])), /computed|unique|source|snapshot/);
  }
  assert.equal(readFileSync(file, "utf8"), before);
  const taskFile = path.join(fixture, "framework-config/workloads/tasks.ts");
  const taskBefore = readFileSync(taskFile, "utf8");
  const migration = taskBefore.indexOf('"db-migrate":');
  for (const text of [taskBefore.replace("cloud: { vpc: applicationVpc }", "cloud: computedCloud"), taskBefore.slice(0, migration) + taskBefore.slice(migration).replace("vpc: applicationVpc", "vpc: (/* retain network rationale */ applicationVpc)")]) {
    assert.notEqual(text, taskBefore);
    assert.throws(() => planDatabasePlacement(fixture, state(), relocation(), new Map([[taskFile, text]])), /computed|comment/);
  }
  assert.equal(readFileSync(taskFile, "utf8"), taskBefore);
});

test("subnet and policy drafts compose in one database file without moving consumers", async () => {
  const database = state().snapshot.models.dev.managedDatabase!;
  const targets = state().snapshot.models.dev.targets;
  const plan = await edits.planBatch([
    { kind: "database", database: database.id, settings: { ...database.authored, multiAz: true } },
    { kind: "databasePlacement", database: database.id, vpc: database.networkId, subnet: "private" },
  ], state().snapshot.revision);
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  assert.deepEqual(plan.changes.map(change => change.file), ["framework-config/databases/application.ts"]);
  const before = readFileSync(path.join(fixture, plan.changes[0]!.file), "utf8");
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  assert.equal(state().snapshot.models.prod.managedDatabase!.subnet, "private");
  assert.equal(state().snapshot.models.prod.managedDatabase!.settings.multiAz, true);
  assert.deepEqual(state().snapshot.models.dev.targets.map(target => target.placement), targets.map(target => target.placement));
  await restoreSource();
  assert.equal(readFileSync(path.join(fixture, plan.changes[0]!.file), "utf8"), before);
});

test("post-apply consumer placement mismatches roll back the complete coordinated edit", async () => {
  const plan = await edits.planBatch([relocation()], state().snapshot.revision);
  assert.ok(plan.ok, JSON.stringify(plan.preflight));
  const originals = new Map(plan.changes.map(change => [change.file, readFileSync(path.join(fixture, change.file), "utf8")]));
  const ref = databaseConsumers(Object.values(state().snapshot.models), relocation().database)[0]!.target;
  const originalPlacement = state().snapshot.models.dev.targets.find(target => target.ref === ref)!.placement;
  const refresh = builder.refresh.bind(builder);
  let corrupt = true;
  builder.refresh = async () => {
    const actual = await refresh();
    if (!corrupt) return actual;
    corrupt = false;
    return { ...actual, snapshot: { ...actual.snapshot, models: { ...actual.snapshot.models, dev: { ...actual.snapshot.models.dev, targets: actual.snapshot.models.dev.targets.map(target => target.ref === ref ? { ...target, placement: originalPlacement } : target) } } } };
  };
  try {
    const result = await edits.applyBatch(plan.planId);
    assert.equal(result.status, "reverted", result.message);
    for (const [file, text] of originals) assert.equal(readFileSync(path.join(fixture, file), "utf8"), text);
  } finally { builder.refresh = refresh; }
});

import assert from "./support/assert";
import { before, after, beforeEach, afterEach, test } from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { writeSourceChange } from "aws-studio/source/io";
import { createSnapshotFixture, sourceFixtureCheckpoint } from "./support/source-fixture";
import { readDraftEdits } from "../server/server";
import type { PrivateZoneSettings } from "../shared/private-dns";
import { readPrivateZoneEdit } from "../shared/private-dns";
import { readCreationRequest } from "../shared/creation";

const repository = path.resolve(__dirname, "../..");
let fixture: ReturnType<typeof createSnapshotFixture>, builder: SnapshotBuilder, editor: EditService;
let restore: () => Promise<void>;
const settings: PrivateZoneSettings = { name: "internal.parity.test", enabled: true, vpcIds: ["application"], records: [] };
before(async () => {
  fixture = createSnapshotFixture();
  builder = new SnapshotBuilder(fixture.root);
  editor = new EditService(fixture.root, builder);
  await builder.refresh();
});
beforeEach(() => { restore = sourceFixtureCheckpoint(fixture.root, builder); });
afterEach(async () => { await restore(); });
after(async () => { await builder?.dispose(); fixture?.dispose(); });
const current = () => builder.current!.snapshot;

test("private zone HTTP contract rejects paths, injected endpoint data, unsupported records and missing associations", () => {
  const valid = { kind: "privateZone", operation: "create", id: "internal", settings } as const;
  assert.equal(readDraftEdits([valid])[0]!.kind, "privateZone");
  for (const invalid of [
    { ...valid, file: "cdk-app/lib/application.ts" },
    { ...valid, settings: { ...settings, vpcIds: [] } },
    { ...valid, settings: { ...settings, name: "https://evil.test/path" } },
    { ...valid, settings: { ...settings, records: [{ id: "api", name: "api", type: "CNAME", target: { kind: "ecs-internal-alb", service: "example-service" } }] } },
    { ...valid, settings: { ...settings, records: [{ id: "api", name: "api", type: "A", target: { kind: "ecs-internal-alb", service: "example-service", url: "http://localhost:8090" } }] } },
  ]) assert.throws(() => readPrivateZoneEdit(invalid));
});

test("reviewed private-zone creation, editing, VPC sharing, records and removal round-trip through authoritative TypeScript", async () => {
  const vpc = readCreationRequest({ kind: "vpc", id: "dns-secondary", name: "DNS secondary", description: "", cidr: "10.73.0.0/16", zones: 2, nat: false, ipv6: true, s3: true, dynamodb: true, endpoints: [] });
  const vpcPlan = await editor.planBatch([{ kind: "create", request: vpc }], current().revision);
  assert.equal(vpcPlan.ok, true, JSON.stringify(vpcPlan.preflight));
  assert.equal((await editor.applyBatch(vpcPlan.planId)).status, "applied");
  const networkFile = path.join(fixture.root, "framework-config/networks/application.ts");
  const networkBefore = readFileSync(networkFile, "utf8");
  const rootBefore = readFileSync(path.join(fixture.root, "framework.config.ts"), "utf8");
  const plan = await editor.planBatch([{ kind: "privateZone", operation: "create", id: "fixture-internal", settings }], current().revision);
  assert.equal(plan.ok, true, JSON.stringify(plan.preflight));
  assert.equal(readFileSync(path.join(fixture.root, "framework.config.ts"), "utf8"), rootBefore, "review writes no source");
  assert.equal(existsSync(path.join(fixture.root, "framework-config/private-dns/fixture-internal.ts")), false);
  assert.equal(plan.changes.length, 2);
  const applied = await editor.applyBatch(plan.planId);
  assert.equal(applied.status, "applied", applied.message);
  for (const mode of ["dev", "prod"] as const) assert.equal(current().models[mode].privateHostedZones?.find(zone => zone.id === "fixture-internal")?.name, settings.name);
  assert.equal(readFileSync(networkFile, "utf8"), networkBefore, "existing S3/DynamoDB, gateways and network identities are preserved");

  const updated: PrivateZoneSettings = { ...settings, name: "services.parity.test", vpcIds: ["application", "dns-secondary"], records: [{ id: "api", name: "api", type: "A", target: { kind: "ecs-internal-alb", service: "example-service" }, enabled: false, allowFrom: [] }] };
  const edit = await editor.planBatch([{ kind: "privateZone", operation: "update", id: "fixture-internal", settings: updated }], current().revision);
  assert.equal(edit.ok, true, JSON.stringify(edit.preflight));
  assert.equal((await editor.applyBatch(edit.planId)).status, "applied");
  const zone = current().models.prod.privateHostedZones?.find(zone => zone.id === "fixture-internal");
  assert.equal(zone?.records.find(record => record.id === "api")?.target.kind, "ecs-internal-alb");
  assert.equal(zone?.localStatus, "unsupported");
  assert.deepEqual(zone?.vpcIds, ["application", "dns-secondary"]);
  await assert.rejects(editor.planBatch([{ kind: "removeNetwork", network: "dns-secondary" }], current().revision), /referenced/);
  const file = path.join(fixture.root, "framework-config/private-dns/fixture-internal.ts");
  assert.match(readFileSync(file, "utf8"), /definePrivateHostedZone/);
  assert.doesNotMatch(readFileSync(file, "utf8"), /127\.0\.0\.1|localhost|host\.docker/);

  const zoneSource = readFileSync(file, "utf8");
  writeFileSync(file, `import "../networks/application";\n${zoneSource}`);
  await builder.refresh();
  await assert.rejects(editor.planBatch([{ kind: "privateZone", operation: "remove", id: "fixture-internal" }], current().revision), /other code/);
  assert.match(readFileSync(file, "utf8"), /import "\.\.\/networks\/application";/, "removal preserves side-effect imports for deliberate source editing");
  writeFileSync(file, zoneSource);
  await builder.refresh();

  const remove = await editor.planBatch([{ kind: "privateZone", operation: "remove", id: "fixture-internal" }], current().revision);
  assert.equal(remove.ok, true, JSON.stringify(remove.preflight));
  const removed = await editor.applyBatch(remove.planId);
  assert.equal(removed.status, "applied", removed.message);
  assert.equal(existsSync(file), false);
  assert.equal(current().models.prod.privateHostedZones?.some(zone => zone.id === "fixture-internal"), false);
});

test("a concurrent source edit expires private DNS review, and failed multi-file application restores the original source", async () => {
  const file = path.join(fixture.root, "framework.config.ts");
  const before = readFileSync(file, "utf8");
  const edit = { kind: "privateZone", operation: "create", id: "fixture-conflict", settings } as const;
  const stale = await editor.planBatch([edit], current().revision);
  writeFileSync(file, `${before}\n// independently authored\n`);
  await assert.rejects(editor.applyBatch(stale.planId), /changed/);
  assert.match(readFileSync(file, "utf8"), /independently authored/);
  writeFileSync(file, before); await builder.refresh();
  let writes = 0;
  const failing = new EditService(fixture.root, builder, (root, file, original, next) => {
    if (++writes === 2) throw new Error("fixture write failure");
    writeSourceChange(root, file, original, next);
  });
  const plan = await failing.planBatch([edit], current().revision);
  const result = await failing.applyBatch(plan.planId);
  assert.equal(result.status, "reverted", result.message);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(existsSync(path.join(fixture.root, "framework-config/private-dns/fixture-conflict.ts")), false);
});

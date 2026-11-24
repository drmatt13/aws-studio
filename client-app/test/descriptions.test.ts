import { createSnapshotFixture } from "./support/source-fixture";
import assert from "./support/assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseDescriptions, renameRouteDescriptions, rewriteDescription } from "../server/descriptions";
import { SnapshotBuilder } from "../server/snapshot";
import { connectionDescriptionId, DESCRIPTION_FILE, descriptionEntityIds } from "../shared/descriptions";
import type { Snapshot } from "../shared/model";
import { buildScene } from "../src/scene/build";

let snapshotFixture: ReturnType<typeof createSnapshotFixture>;
let builder: SnapshotBuilder;
let snapshot: Snapshot;
before(async () => { snapshotFixture = createSnapshotFixture(); builder = new SnapshotBuilder(snapshotFixture.root); snapshot = (await builder.refresh()).snapshot; });
after(async () => { await builder?.dispose(); snapshotFixture?.dispose(); });

test("map identities preserve authored descriptions and support adding notes to undocumented entities", () => {
  assert.equal(snapshot.descriptions.problem, undefined);
  const source = readFileSync(path.join(snapshotFixture.root, DESCRIPTION_FILE), "utf8");
  assert.deepEqual(snapshot.descriptions.values, parseDescriptions(source).values);
  assert.ok(snapshot.descriptions.values["gateway:http"]?.trim());
  assert.ok(snapshot.descriptions.values["lambda:graphql-api"]?.trim());
  const ids = descriptionEntityIds(Object.values(snapshot.models));
  const fixtureGuidance = new Map<string, string>();
  for (const model of Object.values(snapshot.models)) {
    const scene = buildScene(model);
    for (const prop of scene.props) fixtureGuidance.set(prop.id, prop.caption.join(" ").trim());
    for (const item of [...scene.nodes, ...scene.islands, ...scene.props]) {
      assert.ok(ids.has(item.id), `editable: ${item.id}`);
    }
    for (const edge of model.edges) assert.ok(ids.has(connectionDescriptionId(edge)), `editable connection: ${edge.id}`);
  }
  const undocumented = [...ids].find(id => !id.startsWith("connection-description:")
    && !Object.hasOwn(snapshot.descriptions.values, id) && !fixtureGuidance.get(id));
  assert.ok(undocumented, "the partially documented fixture has an editable entity without a note");
  const description = "A description for the previously undocumented entity.";
  const edited = parseDescriptions(rewriteDescription(source, undocumented, description));
  assert.deepEqual({ ...edited.values }, { ...snapshot.descriptions.values, [undocumented]: description });
});

test("connection notes follow named relationships across graph ordering and environment detail changes", () => {
  const edge = snapshot.models.dev.edges.find((edge) => edge.relation === "env")!;
  assert.equal(connectionDescriptionId(edge), connectionDescriptionId({ ...edge, id: "different-ordinal#3", detail: "Production reference", provenance: "derived" }));
  assert.notEqual(connectionDescriptionId(edge), connectionDescriptionId({ ...edge, label: "ANOTHER_MAPPING" }));
  assert.notEqual(connectionDescriptionId(edge), connectionDescriptionId({ ...edge, from: edge.to, to: edge.from }));
});

test("conditional deployment keeps its existing description key when its direction changes", () => {
  const condition = snapshot.models.dev.edges.find(edge => edge.relation === "deployWhen")!;
  assert.ok(condition);
  assert.ok(condition.from.startsWith("resource:"));
  const historical = `connection-description:${JSON.stringify([condition.relation, condition.to, condition.from, condition.label, condition.attachment ?? null])}`;
  assert.equal(connectionDescriptionId(condition), historical);
});

test("replay bucket connections retain notes authored against their owning stack", () => {
  const replay = snapshot.models.dev.edges.find(edge => edge.relation === "localReplay")!;
  assert.ok(replay.to.endsWith(".bucket"));
  assert.equal(connectionDescriptionId(replay), connectionDescriptionId({ ...replay, to: replay.to.slice(0, -".bucket".length) }));
});

test("literal edits preserve comments and safely round trip text that resembles code", () => {
  const original = '// preserve header\nexport const descriptions = {\n  // keep comment\n  "lambda:one": "before", // keep inline\n} satisfies Record<string, string>;\n';
  const value = 'Quotes " and \' with \\ paths\r\nNew line\t${process.exit()} `ticks` 😺';
  const after = rewriteDescription(original, "lambda:one", value);
  assert.equal(parseDescriptions(after).values["lambda:one"], value);
  assert.equal(after, original.replace('"before"', JSON.stringify(value)));
  const inserted = rewriteDescription(after, "lambda:two", value);
  assert.equal(parseDescriptions(inserted).values["lambda:two"], value);
  assert.ok(inserted.includes('// keep inline'));
  const empty = rewriteDescription('export const descriptions = {\n // keep this\n};', "lambda:new", value);
  assert.ok(empty.includes('// keep this'));
  assert.equal(parseDescriptions(empty).values["lambda:new"], value);
});

test("computed, duplicate and invalid descriptions are refused without executing source", () => {
  for (const text of ['export const descriptions = { ...other };', 'export const descriptions = { x: run() };', 'export const descriptions = { x: "a", x: "b" };', 'export const descriptions = { x: `a${run()}` };', 'export const descriptions = {']) assert.throws(() => parseDescriptions(text));
  assert.throws(() => rewriteDescription('export const descriptions = {};', "lambda:new", "x".repeat(8001)), /at most/);
  assert.throws(() => rewriteDescription('export const descriptions = {};', "lambda:new", "\0"), /null/);
});

test("route description renames support swaps, preserve prose and reject unrelated collisions", () => {
  const source = 'export const descriptions = { "route:http:/a": "A", "route:http:/b": "B" };';
  const swap = renameRouteDescriptions(source, [{ before: "/a", after: "/b" }, { before: "/b", after: "/a" }]);
  assert.equal(parseDescriptions(swap).values["route:http:/b"], "A");
  assert.equal(parseDescriptions(swap).values["route:http:/a"], "B");
  assert.throws(() => renameRouteDescriptions(source, [{ before: "/a", after: "/b" }]), /already exists/);
});

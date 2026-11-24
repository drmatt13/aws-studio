import { createSnapshotFixture } from "./support/source-fixture";
import assert from "./support/assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseDeclaredSchema, readDeclaredSchema, readLocalDatabases, withLocalDatabases } from "../server/database";
import { SnapshotBuilder } from "../server/snapshot";
import { watchRepository } from "../server/watch";
import { buildScene } from "../src/scene/build";
import { schemaLayout, TABLE_WIDTH } from "../src/schema-layout";
import type { Snapshot } from "../shared/model";

let root: string;
let fixture: ReturnType<typeof createSnapshotFixture>;
let builder: SnapshotBuilder;
let snapshot: Snapshot;
before(async () => { fixture = createSnapshotFixture(); root = fixture.root; builder = new SnapshotBuilder(root); snapshot = (await builder.refresh()).snapshot; });
after(async () => { await builder?.dispose(); fixture?.dispose(); });

test("the real declared schema exposes mapped columns, keys, indexes and the owning FK", () => {
  const schema = snapshot.schema;
  assert.deepEqual(schema.problems, []);
  assert.deepEqual(schema.tables.map(table => table.table), ["users", "projects", "project_members", "tasks"]);
  assert.ok(schema.tables.every(table => table.rows?.exposed && table.rows.sentence.trim()), "the starter's authored Access Graph exposes rules for every table");
  const project = schema.tables.find((table) => table.model === "Project")!;
  assert.equal(project.columns.find((column) => column.name === "ownerId")?.column, "owner_id");
  assert.ok(!project.columns.some((column) => column.name === "owner"), "relation fields are not storage columns");
  assert.ok(project.indexes.some((index) => index.name === "projects_owner_id_idx"));
  const membership = schema.tables.find(table => table.model === "ProjectMember")!;
  assert.deepEqual(membership.indexes.find(index => index.kind === "primary")?.fields, ["projectId", "userId"]);
  const relation = schema.relations.find(relation => relation.from === project.id && relation.name === "owner")!;
  assert.equal(relation.from, project.id);
  assert.equal(relation.to, "schema:public.User");
  assert.equal(relation.cardinality, "N:1");
  assert.equal(relation.onDelete, "Cascade");
  const text = readFileSync(path.join(root, schema.file), "utf8");
  assert.match(text.slice(relation.source.start, relation.source.end), /owner\s+User\s+@relation/);
  assert.equal(text.slice(0, relation.source.start).split("\n").length, relation.source.line);
});

test("the diagram carries each column's authored protection and ignores a directive inside a string", () => {
  const schema = parseDeclaredSchema(`// use prisma-8
/// @access(read: id == auth.id)
model User {
  id Uuid @id
  notes Note[]
}
/// @access(read: authorId == auth.id)
model Note {
  id       Uuid   @id
  authorId Uuid
  /// @access(readonly)
  title    String
  body     String @default("/// @access(serverOnly)")
  /// @access(serverOnly)
  secret   String
  author   User   @relation(fields: [authorId], references: [id])
}
`);
  assert.deepEqual(schema.tables[1]!.columns.map((column) => [column.name, column.access]), [["id", undefined], ["authorId", undefined], ["title", "read-only"], ["body", undefined], ["secret", "server-only"]]);
});

test("diagram relationship access includes named inverse rules and their declaring endpoints", () => {
  const source = `/// @access(read: id == auth.id || sentItems.read && sentItems.active == true || receivedItems.read)
model User {
  id Uuid @id
  sentItems Item[] @relation("ItemAuthor")
  receivedItems Item[] @relation("ItemReader")
}
/// @access(read: authorId == auth.id)
model Item {
  id Uuid @id
  active Boolean
  authorId Uuid
  readerId Uuid
  author User @relation("ItemAuthor", fields: [authorId], references: [id])
  reader User @relation("ItemReader", fields: [readerId], references: [id])
  body String @default("/// @access(read: x)")
}`;
  const schema = parseDeclaredSchema(source);
  assert.deepEqual(schema.problems, []);
  assert.equal(schema.relations.length, 2, "access rules annotate existing FK connectors");
  const author = schema.relations.find((relation) => relation.name === "author")!;
  const reader = schema.relations.find((relation) => relation.name === "reader")!;
  assert.equal(author.from, "schema:public.Item");
  assert.equal(author.to, "schema:public.User");
  assert.deepEqual(author.access?.map(({ kind, side, field, filter }) => ({ kind, side, field, filter })), [
    { kind: "owner", side: "from", field: "author", filter: undefined },
    { kind: "via", side: "to", field: "sentItems", filter: "active: true" },
  ]);
  assert.deepEqual(reader.access?.map(({ kind, side, field }) => ({ kind, side, field })), [
    { kind: "via", side: "to", field: "receivedItems" },
  ]);
  for (const access of [...author.access!, ...reader.access!]) {
    assert.match(source.slice(access.source.start, access.source.end), new RegExp(`^${access.field}\\s`));
    assert.equal(source.slice(0, access.source.start).split("\n").length, access.source.line);
  }
});

test("diagram relationship access matches implicit inverse fields and named self-relations", () => {
  const schema = parseDeclaredSchema(`/// @access(read: id == auth.id || items.read)
model User {
  id Uuid @id
  items Item[]
}
/// @access(read: parent.read || children.read && children.active == true)
model Item {
  id Uuid @id
  personId Uuid
  person User @relation(fields: [personId], references: [id])
  parentId Uuid?
  parent Item? @relation("ItemTree", fields: [parentId], references: [id])
  children Item[] @relation("ItemTree")
  unrelatedId Uuid?
  unrelated Item? @relation("ItemOther", fields: [unrelatedId], references: [id])
  others Item[] @relation("ItemOther")
  active Boolean
}`);
  const person = schema.relations.find((relation) => relation.name === "person")!;
  const parent = schema.relations.find((relation) => relation.name === "parent")!;
  assert.deepEqual(person.access?.map(({ kind, side, field }) => ({ kind, side, field })), [
    { kind: "via", side: "to", field: "items" },
  ]);
  assert.deepEqual(parent.access?.map(({ kind, side, field, filter }) => ({ kind, side, field, filter })), [
    { kind: "via", side: "from", field: "parent", filter: undefined },
    { kind: "via", side: "to", field: "children", filter: "active: true" },
  ]);
  assert.equal(schema.relations.find((relation) => relation.name === "unrelated")?.access, undefined);
});

for (const [style, owningPrefix, inversePrefix] of [
  ["named", "name: ", "name: "],
  ["named owning and positional inverse", "name: ", ""],
  ["positional owning and named inverse", "", "name: "],
] as const) test(`diagram relationship access matches ${style} relation arguments`, () => {
  const schema = parseDeclaredSchema(`/// @access(read: id == auth.id || sentItems.read && sentItems.active == true || receivedItems.read && receivedItems.active == false)
model User {
  id Uuid @id
  sentItems Item[] @relation(${inversePrefix}"ItemAuthor")
  receivedItems Item[] @relation(${inversePrefix}"ItemReader")
}
/// @access(read: authorId == auth.id || readerId == auth.id)
model Item {
  id Uuid @id
  authorId Uuid
  readerId Uuid
  active Boolean
  author User @relation(${owningPrefix}"ItemAuthor", fields: [authorId], references: [id])
  reader User @relation(${owningPrefix}"ItemReader", fields: [readerId], references: [id])
}`);
  assert.deepEqual(schema.problems, []);
  assert.deepEqual(schema.relations.map(({ name, access }) => ({ name,
    access: access?.map(({ side, field, kind, filter }) => ({ side, field, kind, filter })),
  })), [
    { name: "author", access: [
      { side: "from", field: "author", kind: "owner", filter: undefined },
      { side: "to", field: "sentItems", kind: "via", filter: "active: true" },
    ] },
    { name: "reader", access: [
      { side: "from", field: "reader", kind: "owner", filter: undefined },
      { side: "to", field: "receivedItems", kind: "via", filter: "active: false" },
    ] },
  ]);
});

test("diagram relationship access leaves ambiguous unnamed inverses unassociated", () => {
  const schema = parseDeclaredSchema(`/// @access(read: id == auth.id || first.read || second.read)
model User {
  id Uuid @id
  first Item[]
  second Item[]
}
/// @access(read: authenticated)
model Item {
  id Uuid @id
  personId Uuid
  person User @relation(fields: [personId], references: [id])
}`);
  assert.equal(schema.relations[0]?.access, undefined);
});

test("Prisma syntax handles comments, multiline composite keys, namespaces, enums and self references", () => {
  const schema = parseDeclaredSchema(`// use prisma-8
// model Fake { id String }
enum Status {
  OPEN
  CLOSED
}
namespace sales {
  model Tenant {
    first Uuid
    second Uuid
    @@id([first, second])
  }
  model Entry {
    id Uuid @id
    first Uuid?
    second Uuid?
    owner Tenant? @relation(
      fields: [first, second],
      references: [first, second],
      onDelete: SetNull
    )
    parentId Uuid?
    parent Entry? @relation(fields: [parentId], references: [id])
    status Status @default(OPEN)
    label String @default("model NotATable { and // comment }")
    @@index([first, second], unique: true)
    @@map("entries")
  }
}`);
  assert.deepEqual(schema.problems, []);
  assert.equal(schema.tables.length, 2);
  assert.deepEqual(schema.enums[0]?.values, ["OPEN", "CLOSED"]);
  const relation = schema.relations.find((relation) => relation.name === "owner")!;
  assert.equal(relation.to, "schema:sales.Tenant");
  assert.equal(relation.cardinality, "1:1");
  assert.equal(relation.nullable, true);
  assert.deepEqual(relation.fields, ["first", "second"]);
  assert.equal(relation.onDelete, "SetNull");
  assert.equal(schema.relations.find((relation) => relation.name === "parent")?.from, "schema:sales.Entry");
  const layout = schemaLayout(schema);
  assert.equal(layout.edges.length, 2);
  for (const table of layout.tables) {
    assert.ok(table.x + TABLE_WIDTH <= layout.width);
    assert.ok(table.y + table.height <= layout.height);
  }
});

test("malformed PSL reports diagnostics instead of displaying an incomplete schema", () => {
  const schema = parseDeclaredSchema('model Broken {\n id Uuid @id\n owner User @relation(fields: [\n');
  assert.ok(schema.problems.length > 0);
  assert.deepEqual(schema.tables, []);
  assert.deepEqual(schema.relations, []);
});

test("partial uniqueness does not imply one-to-one, and unresolved FKs produce notes", () => {
  const schema = parseDeclaredSchema(`model Owner {
  id Uuid @id
}
model Item {
  id Uuid @id
  ownerId Uuid
  owner Owner @relation(fields: [ownerId], references: [id])
  broken Owner @relation(fields: [missing], references: [id])
  external other:public.Shared @relation(fields: [ownerId], references: [id])
  @@index([ownerId], unique: true, where: "id IS NOT NULL")
}`);
  assert.equal(schema.relations.length, 1);
  assert.equal(schema.relations[0]?.cardinality, "N:1");
  assert.equal(schema.tables.find((table) => table.model === "Item")?.columns.find((column) => column.name === "ownerId")?.unique, false);
  assert.ok(schema.problems.some((problem) => problem.includes("unresolved")));
  assert.ok(schema.problems.some((problem) => problem.includes("outside")));
});

test("local database projection never exposes Compose credentials and reports YAML errors safely", () => {
  const fixture = mkdtempSync(path.join(root, ".cache/framework-studio/database-"));
  try {
    writeFileSync(path.join(fixture, "docker-compose.yml"), `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: never-show-this-value
    volumes: [postgres_data:/var/lib/postgresql/data]
`);
    const projection = readLocalDatabases(fixture);
    assert.equal(projection.services[0]?.image, "postgres:16");
    assert.deepEqual(projection.services[0]?.volumes, ["postgres_data"]);
    assert.ok(!JSON.stringify(projection).includes("never-show-this-value"));
    writeFileSync(path.join(fixture, "docker-compose.yml"), 'services: [invalid\n POSTGRES_PASSWORD: never-show-this-value');
    const failed = readLocalDatabases(fixture);
    assert.equal(failed.services.length, 0);
    assert.ok(failed.problems.length);
    assert.ok(!JSON.stringify(failed).includes("never-show-this-value"));
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("local execution connects to PostgreSQL; production retains its RDS binding", () => {
  const dev = snapshot.models.dev;
  const prod = snapshot.models.prod;
  assert.equal(dev.localServices?.[0]?.enabled, true);
  assert.equal(prod.localServices?.[0]?.enabled, false);
  const source = dev.localServices![0]!.source;
  const compose = readFileSync(path.join(root, source.file), "utf8");
  assert.equal(compose.slice(source.start, source.end), "postgres");
  assert.ok(source.start > compose.indexOf("services:\n"), "source opens the service, not an earlier dependency anchor");
  assert.ok(dev.edges.some((edge) => edge.from === "lambda:graphql-api" && edge.to === "local:postgres"));
  assert.ok(!dev.edges.some((edge) => edge.relation === "database" && edge.from === "lambda:graphql-api" && edge.to === "resource:rds.database"));
  const replay = "lambda:cognito-post-confirmation-trigger";
  assert.ok(dev.edges.some(edge => edge.relation === "database" && edge.from === replay && edge.to === "local:postgres"));
  assert.ok(!dev.edges.some(edge => edge.relation === "database" && edge.from === replay && edge.to === "resource:rds.database"));
  assert.ok(prod.edges.some(edge => edge.relation === "database" && edge.from === replay && edge.to === "resource:rds.database"));
  assert.deepEqual(dev.targets.find(target => target.ref === replay)!.readinessIssues, []);
  assert.ok(prod.edges.some((edge) => edge.from === "lambda:graphql-api" && edge.to === "resource:rds.database"));
  assert.ok(!prod.edges.some((edge) => edge.to === "local:postgres"));
  for (const model of [dev, prod]) {
    const scene = buildScene(model);
    assert.equal(scene.nodes.find((node) => node.id === "local:postgres")?.presence, model.mode === "dev" ? "built" : "other");
    assert.equal(scene.islands.some((island) => island.id === "island:local"), false, "the local database has no island of its own");
  }
  assert.deepEqual(withLocalDatabases(dev, dev.localServices!).edges, dev.edges, "stale model reprojection keeps stable edge ids");
});

test("a workload executing both locally and in development AWS retains both database connections", () => {
  const prod = snapshot.models.prod;
  const model = { ...prod, mode: "dev" as const, targets: prod.targets.map((target) => target.ref === "lambda:graphql-api" ? { ...target, lanes: { ...target.lanes, local: true, dev: true } } : target) };
  const projected = withLocalDatabases(model, snapshot.models.dev.localServices!);
  const destinations = projected.edges.filter((edge) => edge.from === "lambda:graphql-api" && edge.relation === "database").map((edge) => edge.to);
  assert.deepEqual(destinations.sort(), ["local:postgres", "resource:rds.database"]);
});

test("schema reading follows contract edits without generation, and the watcher sees atomic replacements", async () => {
  const fixture = mkdtempSync(path.join(root, ".cache/framework-studio/database-"));
  const directory = path.join(fixture, "packages/database/prisma");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "contract.prisma");
  writeFileSync(file, 'model One {\n id Uuid @id\n}\n');
  const before = readDeclaredSchema(fixture);
  let stop = () => {};
  try {
    const changed = new Promise<readonly string[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Contract watcher did not refresh")), 10000);
      stop = watchRepository(fixture, (files) => { clearTimeout(timeout); resolve(files); }, 10);
    });
    // Let the native watcher attach to the newly created fixture directory.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { renameSync } = await import("node:fs");
    writeFileSync(path.join(directory, "replacement.tmp"), 'model Two {\n id Uuid @id\n}\n');
    renameSync(path.join(directory, "replacement.tmp"), file);
    assert.ok((await changed).includes("packages/database/prisma/contract.prisma"));
    const after = readDeclaredSchema(fixture);
    assert.notEqual(before.hash, after.hash);
    assert.equal(after.tables[0]?.model, "Two");
  } finally { stop(); rmSync(fixture, { recursive: true, force: true }); }
});

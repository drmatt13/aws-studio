import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseDeclaredSchema } from "../server/database";
import {
  canonicalPrisma, diffPrisma, diffSdl, fingerprint, normalizeSdl, parseReviewRecord,
  sdlFingerprint, sdlSurface, serializeReviewRecord,
} from "aws-studio/contract-chain/core";
import type { GraphQLChainReviewRecord } from "aws-studio/contract-chain/graphql-chain";

const prisma = `// use prisma-8
enum State {
  OPEN
  CLOSED
}
model User {
  id Uuid @id
  projects Project[] @relation("projects")
}
model Project {
  id Uuid @id
  ownerId Uuid
  owner User @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  name String @default("a  b // still a string") @map("physical_name")
  state State @default(OPEN)
  updatedAt temporal.timestamptzString(6, onCreate: now, onUpdate: now)
  @@map("projects")
}
`;

const sdl = `
  directive @tag(name: String! = "one") repeatable on FIELD_DEFINITION
  enum State { OPEN CLOSED }
  interface Node { id: ID! }
  type User implements Node { id: ID! }
  type Project implements Node {
    id: ID!
    name: String! @deprecated(reason: "old")
    state: State!
  }
  union Result = Project | User
  input Filter { state: State = OPEN }
  type Query { project(id: ID!, filter: Filter): Project }
`;

test("Prisma review identity ignores layout, comments, index and physical mapping edits", () => {
  const before = canonicalPrisma(prisma);
  assert.deepEqual(before.diagnostics, []);
  const edits = [
    `// one more comment\n${prisma}`,
    prisma.replace("(6, onCreate: now, onUpdate: now)", "( 6 , onCreate : now , onUpdate : now )"),
    prisma.replace('@@map("projects")', '@@index([ownerId], unique: true)\n  @@map("different_table")'),
    prisma.replace('@map("physical_name")', '@map("other_name")'),
    prisma.replace("OPEN\n  CLOSED", "CLOSED\n  OPEN"),
  ];
  for (const source of edits) {
    const after = canonicalPrisma(source);
    assert.deepEqual(after.diagnostics, []);
    assert.equal(fingerprint(after.models), fingerprint(before.models));
    assert.deepEqual(diffPrisma(before.models, after.models), []);
  }
});

test("Prisma diffs name only the changed model and retain the optional storage type", () => {
  const before = canonicalPrisma(prisma), after = canonicalPrisma(prisma.replace("  state State", "  dueDate TimestamptzString(6)?\n  state State"));
  assert.deepEqual(after.diagnostics, []);
  const changes = diffPrisma(before.models, after.models);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "Project.dueDate");
  assert.equal(changes[0].change, "added");
  assert.equal(changes[0].subject, "Project");
  assert.match(changes[0].after!, /TimestamptzString\(6\)/);
  assert.match(changes[0].after!, /optional/);
  assert.equal(fingerprint(before.models.User), fingerprint(after.models.User));
  const removed = diffPrisma(after.models, before.models);
  assert.equal(removed[0].change, "removed");
});

test("Prisma canonicalization preserves string meaning and owns relation back-reference evidence", () => {
  const before = canonicalPrisma(prisma);
  const changedLiteral = canonicalPrisma(prisma.replace('a  b // still a string', 'a b // still a string'));
  assert.notEqual(fingerprint(before.models), fingerprint(changedLiteral.models));
  assert.deepEqual(Object.keys(before.models.User.relations), ["projects"]);
  assert.equal(before.models.User.relations.projects.multiplicity, "many");
  const changedBackref = canonicalPrisma(prisma.replace("projects Project[]", "projects Project?"));
  assert.equal(diffPrisma(before.models, changedBackref.models)[0].path, "User.projects");
  const changedDelete = canonicalPrisma(prisma.replace("onDelete: Cascade", "onDelete: Restrict"));
  assert.equal(diffPrisma(before.models, changedDelete.models)[0].path, "Project.owner");
});

test("enum changes flag their referencing model and unsupported/syntactically broken PSL cannot be green", () => {
  const before = canonicalPrisma(prisma), after = canonicalPrisma(prisma.replace("  CLOSED", "  CLOSED\n  PAUSED"));
  assert.equal(fingerprint(before.models.User), fingerprint(after.models.User));
  assert.match(diffPrisma(before.models, after.models)[0].path, /Project \(enum State\)/);
  assert.ok(canonicalPrisma("model Broken {\n id String\n").diagnostics.some(item => item.code === "PRISMA_SYNTAX"));
  assert.ok(canonicalPrisma(`${prisma}\ntypes {\n Label = String\n}\n`).diagnostics.length);
  assert.ok(canonicalPrisma(prisma.replace("references: [id]", "references: [missing]")).diagnostics.length);
  assert.ok(canonicalPrisma(prisma.replace("fields: [ownerId], references: [id]", "fields: dynamic(), references: dynamic()")).diagnostics.length);
  assert.ok(canonicalPrisma(prisma.replace("  name String", "  id String\n  name String")).diagnostics.length);
});

test("review projection shares one parser pass without changing the database diagram projection", () => {
  const ordinary = parseDeclaredSchema(prisma);
  let calls = 0;
  const withReview = parseDeclaredSchema(prisma, undefined, review => { calls++; assert.ok(review.models.Project); });
  assert.equal(calls, 1);
  assert.deepEqual(withReview, ordinary);
  assert.ok(!ordinary.tables.find(table => table.model === "User")!.columns.some(column => column.name === "projects"));
});

test("the real application contract produces complete reviewed shapes without emitted artifacts", () => {
  const text = readFileSync(path.join(testProjectRoot, "packages/database/prisma/contract.prisma"), "utf8");
  const result = canonicalPrisma(text);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.keys(result.models), ["Project", "ProjectMember", "Task", "User"]);
  assert.equal(result.models.Project.relations.owner.target, "User");
  assert.equal(result.models.ProjectMember.relations.project.target, "Project");
  assert.equal(result.models.User.fields.updatedAt.type, "temporal.timestamptzString(6,onCreate:now,onUpdate:now)");
  assert.equal(result.models.Task.fields.completedAt.access, "read-only");
  assert.equal(result.models.Task.fields.internalNotes.access, "server-only");
});

test("normalized SDL and reviewed surface identity ignore comments, layout and declaration order", () => {
  const before = sdlSurface(sdl);
  assert.equal(normalizeSdl(sdl), normalizeSdl(`# heading\n${sdl.replace("OPEN CLOSED", "CLOSED OPEN")}`));
  assert.equal(sdlFingerprint(before), fingerprint(normalizeSdl(sdl)));
  assert.equal(sdlFingerprint(before), sdlFingerprint(sdlSurface(`# heading\n${sdl}`)));
  assert.deepEqual(diffSdl(before, sdlSurface(`# heading\n${sdl}`)), []);
});

test("SDL diffs cover field and argument signatures, inputs, enums, unions and directives", () => {
  const before = sdlSurface(sdl);
  const changes = diffSdl(before, sdlSurface(sdl
    .replace("    name: String!", "    dueDate: String\n    name: String")
    .replace("id: ID!, filter", "id: String!, filter")
    .replace("state: State = OPEN", "state: State = CLOSED")
    .replace("OPEN CLOSED", "OPEN CLOSED PAUSED")
    .replace("Project | User", "Project")
    .replace('name: String! = "one"', 'name: String! = "two"')));
  const paths = changes.map(change => change.path);
  for (const expected of ["Project.dueDate", "Project.name", "Query.project", "Filter.state", "State.PAUSED", "Result.User", "@tag"]) assert.ok(paths.includes(expected), expected);
  assert.equal(changes.find(change => change.path === "Project.dueDate")!.change, "added");
  assert.equal(changes.find(change => change.path === "Result.User")!.change, "removed");
});

test("an access protection is review identity, diffed on its own, and round-trips through the review record", () => {
  const governed = prisma.replace("model User {", "/// @access(read: id == auth.id)\nmodel User {").replace("model Project {", "/// @access(read: ownerId == auth.id)\nmodel Project {");
  const before = canonicalPrisma(governed);
  const readOnly = governed.replace("  name String", "  /// @access(readonly)\n  name String");
  const after = canonicalPrisma(readOnly);
  assert.equal(after.models.Project.fields.name.access, "read-only");
  assert.ok(!("access" in before.models.Project.fields.name), "a field without a setting keeps its previous identity");
  assert.equal(fingerprint(before.models.User), fingerprint(after.models.User));
  assert.deepEqual(diffPrisma(before.models, after.models).map(diff => [diff.path, diff.change, diff.before, diff.after]),
    [["Project.name (access)", "changed", "managed in app code", "read-only"]]);
  assert.deepEqual(diffPrisma(after.models, canonicalPrisma(readOnly.replace("@access(readonly)", "@access(serverOnly)")).models).map(diff => diff.after), ["server-only"]);
  const record: GraphQLChainReviewRecord = { version: 1, prisma: { models: after.models }, client: sdlSurface(sdl) };
  assert.deepEqual(parseReviewRecord(serializeReviewRecord(record)), JSON.parse(serializeReviewRecord(record)));
  const forged = JSON.parse(serializeReviewRecord(record));
  forged.prisma.models.Project.fields.name.access = "public";
  assert.throws(() => parseReviewRecord(JSON.stringify(forged)), /invalid field access/);
});

test("SDL surface preserves custom roots, schema descriptions and deprecation semantics", () => {
  const custom = '"Schema description" schema { query: Root } type Root { value: String }';
  assert.equal(sdlFingerprint(sdlSurface(custom)), fingerprint(normalizeSdl(custom)));
  const before = sdlSurface(sdl);
  assert.notEqual(sdlFingerprint(before), sdlFingerprint(sdlSurface(sdl.replace('reason: "old"', 'reason: "new"'))));
  assert.throws(() => sdlSurface("type Broken { missing: Missing }"));
});

test("review record round-trip and serialization are deterministic and preserve only review evidence", () => {
  const models = canonicalPrisma(prisma).models;
  const record: GraphQLChainReviewRecord = { version: 1, prisma: { models }, client: sdlSurface(sdl) };
  const bytes = serializeReviewRecord(record);
  assert.deepEqual(parseReviewRecord(bytes), JSON.parse(bytes));
  assert.equal(serializeReviewRecord(parseReviewRecord(bytes)), bytes);
  assert.equal(serializeReviewRecord({ client: record.client, prisma: { models: { User: models.User, Project: models.Project } }, version: 1 }), bytes);
  assert.ok(bytes.endsWith("\n"));
  assert.ok(!bytes.includes('"hash"'));
  assert.ok(!bytes.includes('"timestamp"'));
  assert.equal(serializeReviewRecord({ version: 1, prisma: null, client: null }), '{\n  "client": null,\n  "prisma": null,\n  "version": 1\n}\n');
});

test("record parser refuses corrupt versions, feature decisions and malformed saved SDL/model evidence", () => {
  const record: GraphQLChainReviewRecord = { version: 1, prisma: { models: canonicalPrisma(prisma).models }, client: sdlSurface(sdl) };
  assert.throws(() => parseReviewRecord("{"), /Invalid graphql-chain.review.json/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, version: 4 })), /unsupported version/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, expose: ["Project.name"] })), /unexpected or missing keys/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, client: { ...record.client, schemaDefinition: "type Query { ok: Boolean }" } })), /schema definition/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, prisma: { models: { Project: { fields: {} } } } })), /missing keys/);
  assert.throws(() => parseReviewRecord('{"version":1,"prisma":{"models":{"__proto__":{}}},"client":null}'), /entry name/);
});

test("version two bindings round-trip without treating hashes as validation assertions", () => {
  const record: GraphQLChainReviewRecord = { version: 2, prisma: { models: canonicalPrisma(prisma).models }, client: sdlSurface(sdl), bindings: { api: "a".repeat(64), client: { inputs: "b".repeat(64), upstream: "c".repeat(64) } } };
  assert.deepEqual(parseReviewRecord(serializeReviewRecord(record)), JSON.parse(JSON.stringify(record)));
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, bindings: { api: "passed", client: null } })), /invalid review binding/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, bindings: { ...record.bindings, passed: true } })), /unexpected or missing keys/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, client: null })), /requires its reviewed SDL/);
});

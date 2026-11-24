import assert from "node:assert/strict";
import { test } from "node:test";
import { readClientAccess as readCore, type AccessModules } from "../client-access.js";
import { createAccessRuntime } from "../access-runtime.js";

/** The enforcement core's own text form; see test/client-access.test.ts. */
const readClientAccess = (source: string, modules?: AccessModules) => readCore(source, modules, { legacy: true });

const source = `
enum Rank {
  // @access edit(LEAD)
  ROOT = "ROOT" // @access read-only
  LEAD = "LEAD"
  READER = "READER"
}
model Person {
  id String @id
  email String @unique
  seats Seat[]
}
model Group {
  // @access read(member)
  id String @id
  name String
  seats Seat[] // @access members(active: true)
}
model Seat {
  // @access create(edit)
  id String @id
  personId String
  groupId String
  rank Rank? // @access role write(edit, !owner, active: true)
  active Boolean
  secret String // @access server-only
  person Person @relation(fields: [personId], references: [id]) // @access owner
  group Group @relation(fields: [groupId], references: [id]) // @access via(member)
}
`;
function harness(text = source) {
  const parsed = readClientAccess(text);
  assert.deepEqual(parsed.problems, []);
  const seats = [
    { id: "a", personId: "alice", groupId: "ours", rank: "LEAD", active: true },
    { id: "b", personId: "bob", groupId: "ours", rank: "READER", active: true },
    { id: "c", personId: "carol", groupId: "theirs", rank: "READER", active: true },
    { id: "d", personId: "carol", groupId: "ours", rank: "ROOT", active: true },
  ];
  for (const seat of seats) seat.rank = parsed.policy.enums.Rank?.stored?.[seat.rank] ?? seat.rank;
  const store: Record<string, readonly Record<string, unknown>[]> = { Seat: seats, Group: [{ id: "ours" }, { id: "theirs" }] };
  const engine = createAccessRuntime(parsed.policy, parsed.rows, parsed.settings, {
    find: async (model, where) => (store[model] ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
  });
  return { parsed, engine, seats, store, viewer: { id: "alice", email: "alice@example.test" } };
}
test("a role belongs to the viewer's active membership in this group", async () => {
  const { engine, seats, viewer } = harness();
  assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, { rank: "LEAD" })).allowed, true);
  assert.equal((await engine.authorize("Seat", "update", seats[2], viewer, { rank: "LEAD" })).code, "NOT_FOUND");
  assert.equal((await engine.authorize("Seat", "update", seats[0], { id: "bob" }, { rank: "LEAD" })).allowed, false);
  seats[0]!.active = false;
  assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, { rank: "LEAD" })).allowed, false);
});
test("ownership exclusions, static fields, protected enum values and undeclared writes fail closed", async () => {
  const { engine, seats, viewer } = harness();
  for (const target of [seats[0], seats[3]]) assert.equal((await engine.authorize("Seat", "update", target, viewer, { rank: "READER" })).allowed, false);
  for (const fields of [{ rank: "ROOT" }, { personId: "alice" }, { id: "invented" }, { secret: "hidden" }, { absent: "value" }, { group: {} }]) {
    assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, fields)).allowed, false);
  }
  assert.equal((await engine.authorize("Seat", "update", seats[3], viewer, { rank: null })).reason, "protected");
  assert.equal((await engine.permissions("Seat", seats[3]!, viewer)).fields.rank!.writable, false);
  assert.equal((await engine.authorize("Seat", "delete", seats[1], viewer)).allowed, false);
});
test("field overrides, OR clauses, state conditions and explicit empty grants have one meaning", async () => {
  const { engine, seats, viewer } = harness(source.replace('// @access create(edit)', '// @access create(edit) update(member)').replace('active Boolean', 'active Boolean // @access write()'));
  assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, { active: false })).allowed, false);
  // A model-wide update never moves a row: the foreign keys behind owner and via are access links.
  assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, { personId: "carol" })).reason, "link");
  seats[1]!.active = false;
  assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, { rank: "LEAD" })).reason, "when");
  const other = harness(source.replace('write(edit, !owner, active: true)', 'write(edit, !owner, active: true) write(owner)'));
  assert.equal((await other.engine.authorize("Seat", "update", other.seats[0], viewer, { rank: "READER" })).allowed, true);
});
test("create checks proposed values and does not inherit update permission", async () => {
  const { engine, viewer } = harness(source.replace('create(edit)', 'create(edit, active: true)'));
  const row = { personId: "bob", groupId: "ours", active: true };
  assert.equal((await engine.authorize("Seat", "create", row, viewer, { rank: "READER" })).allowed, true);
  assert.equal((await engine.authorize("Seat", "create", row, viewer, { active: false })).reason, "when");
  assert.equal((await engine.authorize("Seat", "create", { ...row, groupId: "theirs" }, viewer, { rank: "READER" })).allowed, false);
  assert.equal((await engine.authorize("Group", "create", { id: "ours" }, viewer)).allowed, false);
});
test("permission answers agree with writes, including invisible rows and missing identities", async () => {
  const { engine, seats, viewer } = harness();
  const answer = await engine.permissions("Seat", seats[1]!, viewer);
  assert.equal(answer.update, true);
  assert.equal(answer.fields.id!.writable, false);
  assert.deepEqual(answer.fields.rank!.values, ["LEAD", "READER"]);
  assert.equal((await engine.permissions("Seat", seats[0]!, viewer)).fields.rank!.writable, false);
  for (const actor of [{ id: "outsider" }, {}]) {
    const denied = await engine.permissions("Seat", seats[1]!, actor);
    assert.equal(denied.update, false);
    assert.ok(Object.values(denied.fields).every((field) => !field.readable && !field.writable));
  }
  const group = await engine.permissions("Group", { id: "ours" }, viewer);
  assert.equal(group.can.edit, true);
  assert.equal(group.create.seats, true);
  assert.deepEqual(group.roles, ["LEAD"]);
});
test("field read overrides narrow row visibility; no rule cannot expose an unknown field", async () => {
  const { engine, seats } = harness(source.replace('active Boolean', 'active Boolean // @access read(owner)').replace('rank Rank?', 'rank Rank?'));
  assert.equal(await engine.readable("Seat", "active", seats[1]!, { id: "alice" }), false);
  assert.equal(await engine.readable("Seat", "active", seats[1]!, { id: "bob" }), true);
  assert.equal(await engine.readable("Seat", "secret", seats[1]!, { id: "bob" }), false);
  assert.equal(await engine.readable("Seat", "unknown", seats[1]!, { id: "bob" }), false);
});
test("enum symbols map to stored values without accepting symbolic input values", async () => {
  const { engine, seats, viewer } = harness(source.replace('ROOT = "ROOT"', 'ROOT = "root"').replace('LEAD = "LEAD"', 'LEAD = "lead"').replace('READER = "READER"', 'READER = "reader"'));
  assert.equal((await engine.authorize("Seat", "update", seats[1], viewer, { rank: "lead" })).allowed, true);
  for (const value of ["LEAD", "root", null]) assert.equal((await engine.authorize("Seat", "update", seats[3], viewer, { rank: value })).allowed, false);
  assert.deepEqual((await engine.permissions("Seat", seats[1]!, viewer)).fields.rank!.values, ["lead", "reader"]);
});
test("matching role labels in different enums never transfer a permission", async () => {
  const second = `
enum OtherRank {
  // @access special(LEAD)
  LEAD
  READER
}
model OtherSeat {
  id String @id
  personId String
  groupId String
  rank OtherRank // @access role
  person Person @relation(fields: [personId], references: [id]) // @access owner
  group Group @relation(fields: [groupId], references: [id])
}
`;
  const { engine, store, viewer } = harness(source.replace('  name String', '  name String // @access write(special)').replace('  seats Seat[] //', '  otherSeats OtherSeat[] // @access members\n  seats Seat[] //') + second);
  store.OtherSeat = [{ id: "other", personId: "alice", groupId: "ours", rank: "READER" }];
  assert.equal((await engine.authorize("Group", "update", { id: "ours" }, viewer, { name: "denied" })).allowed, false);
  assert.equal((await engine.permissions("Group", { id: "ours" }, viewer)).can.special, false);
});
test("invalid declarations produce diagnostics rather than an editor crash", () => {
  for (const [from, to] of [
    ['edit(LEAD)', 'edit(MISSING)'], ['via(member)', 'via(missing)'], ['active: true', 'missing: true'],
    ['active: true', 'active: [true]'], ['write(edit', 'write(authenticated'], ['@access role', '@access role role'],
    ['edit(LEAD)', 'edit(LEAD) edit(READER)'], ['@access role', '@access editable'], ['write(edit', 'write(!alien, edit'],
    ['active: true', 'active: true, active: false'], ['active: true', 'personId: alice'], ['create(edit)', 'action(edit)'],
  ]) assert.ok(readClientAccess(source.replace(from!, to!)).problems.length, to);
});
const document = `
enum Rank {
  // @access edit(LEAD)
  // @access publish(LEAD)
  LEAD = "LEAD"
  WRITER = "WRITER"
  READER = "READER"
}
enum Stage {
  DRAFT
  REVIEW
  PUBLISHED
  ARCHIVED
}
model Person {
  id String @id
  email String @unique
}
model Group {
  // @access read(member) create(authenticated)
  id String @id
  seats Seat[] // @access members
  docs Doc[]
}
model Seat {
  id String @id
  personId String
  groupId String
  rank Rank // @access role
  person Person @relation(fields: [personId], references: [id]) // @access owner
  group Group @relation(fields: [groupId], references: [id]) // @access via(member)
}
model Doc {
  // @access create(edit) update(edit, stage: DRAFT | REVIEW)
  id String @id
  authorId String // @access read-only
  groupId String
  stage Stage @default(DRAFT) // @access write(owner, stage: DRAFT, to: REVIEW) write(publish, stage: REVIEW, to: PUBLISHED | DRAFT)
  secret Boolean @default(false)
  body String // @access read(owner, edit) read(anyone, stage: PUBLISHED)
  title String
  author Person @relation(fields: [authorId], references: [id]) // @access owner
  group Group @relation(fields: [groupId], references: [id]) // @access via(member, this.secret: false) via(LEAD)
}
model Notice {
  // @access read(authenticated)
  id String @id
  text String
}
`;
function documents(text = document) {
  const parsed = readClientAccess(text);
  assert.deepEqual(parsed.problems, []);
  const store: Record<string, Record<string, unknown>[]> = {
    Group: [{ id: "g1" }, { id: "g2" }],
    Seat: [
      { id: "s1", personId: "lead", groupId: "g1", rank: "LEAD" },
      { id: "s2", personId: "writer", groupId: "g1", rank: "WRITER" },
      { id: "s3", personId: "reader", groupId: "g1", rank: "READER" },
      { id: "s4", personId: "other", groupId: "g2", rank: "LEAD" },
    ],
    Doc: [
      { id: "d1", authorId: "writer", groupId: "g1", stage: "DRAFT", secret: false, body: "b", title: "t" },
      { id: "d2", authorId: "writer", groupId: "g1", stage: "REVIEW", secret: true, body: "b", title: "t" },
    ],
    Notice: [{ id: "n1", text: "hello" }],
  };
  const consulted: string[] = [];
  const engine = createAccessRuntime(parsed.policy, parsed.rows, parsed.settings, {
    find: async (model, where) => (store[model] ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
  }, { observe: (rule) => consulted.push(rule) });
  const as = (id: string) => ({ id, email: `${id}@example.test` });
  return { parsed, engine, store, as, consulted };
}

test("to: limits a field write to the values a clause names, and _access lists only those", async () => {
  const { engine, store, as } = documents();
  const [draft, review] = store.Doc as [Record<string, unknown>, Record<string, unknown>];
  assert.equal((await engine.authorize("Doc", "update", draft, as("writer"), { stage: "REVIEW" })).allowed, true);
  assert.deepEqual(await engine.authorize("Doc", "update", draft, as("writer"), { stage: "PUBLISHED" }), { allowed: false, code: "FORBIDDEN", reason: "transition", field: "stage" });
  assert.deepEqual((await engine.authorize("Doc", "update", review, as("writer"), { stage: "DRAFT" })).reason, "when", "the author's clause needs DRAFT");
  assert.equal((await engine.authorize("Doc", "update", review, as("lead"), { stage: "PUBLISHED" })).allowed, true);
  assert.equal((await engine.authorize("Doc", "update", review, as("lead"), { stage: "ARCHIVED" })).reason, "transition");
  assert.deepEqual((await engine.permissions("Doc", draft, as("writer"))).fields.stage!.values, ["REVIEW"]);
  assert.deepEqual((await engine.permissions("Doc", review, as("lead"))).fields.stage!.values, ["DRAFT", "PUBLISHED"]);
  assert.equal((await engine.permissions("Doc", review, as("writer"))).fields.stage!.writable, false);
});

test("this. conditions and several clauses on one relation decide visibility; roles still reach the row", async () => {
  const { engine, store, as } = documents();
  const [draft, secret] = store.Doc as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(await engine.visible("Doc", draft, as("reader")), true);
  assert.equal(await engine.visible("Doc", secret, as("reader")), false, "a member sees only rows that are not secret");
  assert.equal(await engine.visible("Doc", secret, as("lead")), true, "a LEAD sees every row");
  assert.equal(await engine.visible("Doc", secret, as("other")), false, "a LEAD of another group sees nothing");
  assert.equal(await engine.can("Doc", secret, as("lead"), "publish"), true);
  assert.equal(await engine.can("Doc", secret, as("reader"), "publish"), false);
});

test("read conditions name this row; a model's read(authenticated) shows its rows to every signed-in user", async () => {
  const { engine, store, as } = documents();
  const [draft] = store.Doc as [Record<string, unknown>];
  assert.equal(await engine.readable("Doc", "body", draft, as("reader")), false);
  assert.equal(await engine.readable("Doc", "body", { ...draft, stage: "PUBLISHED" }, as("reader")), true);
  assert.equal(await engine.readable("Doc", "body", draft, as("writer")), true);
  assert.equal(await engine.visible("Notice", store.Notice![0]!, as("stranger")), true);
  assert.equal(await engine.visible("Notice", store.Notice![0]!, {}), false, "never without a signed-in user");
  assert.equal(await engine.readable("Notice", "text", store.Notice![0]!, as("stranger")), true);
});

test("access links are set at creation; a write rule on one moves the row only where create allows it", async () => {
  const { engine, store, as } = documents();
  const [draft] = store.Doc as [Record<string, unknown>];
  assert.equal((await engine.authorize("Doc", "create", { authorId: "writer", groupId: "g1" }, as("lead"), { groupId: "g1", title: "x" })).allowed, true);
  assert.equal((await engine.authorize("Doc", "update", draft, as("lead"), { groupId: "g2" })).reason, "link");
  assert.equal((await engine.permissions("Doc", draft, as("lead"))).fields.groupId!.writable, false);
  const movable = documents(document.replace("  groupId String\n  stage", "  groupId String // @access write(edit)\n  stage"));
  const stored = movable.store.Doc![0]!;
  assert.equal((await movable.engine.authorize("Doc", "update", stored, movable.as("lead"), { groupId: "g2" })).reason, "who", "the destination's create rule judges the mover there");
  movable.store.Seat!.push({ id: "s5", personId: "lead", groupId: "g2", rank: "LEAD" });
  assert.equal((await movable.engine.authorize("Doc", "update", stored, movable.as("lead"), { groupId: "g2" })).allowed, true);
});

test("denials say why: excluded owner, the failing condition, a protected value only to a named writer", async () => {
  const seatSource = source;
  const { engine, seats, viewer } = harness(seatSource);
  // Alice (LEAD) on her own seat: the rule names her, then excludes the owner.
  assert.deepEqual(await engine.authorize("Seat", "update", seats[0], viewer, { rank: "READER" }), { allowed: false, code: "FORBIDDEN", reason: "excluded", field: "rank" });
  // ROOT is never replaced; Bob, whom no clause names, learns only that he may not.
  assert.equal((await engine.authorize("Seat", "update", seats[3], { id: "bob" }, { rank: "READER" })).reason, "who");
  assert.equal((await engine.authorize("Seat", "update", seats[3], viewer, { rank: "READER" })).reason, "protected");
  seats[1]!.active = false;
  assert.deepEqual(await engine.authorize("Seat", "update", seats[1], viewer, { rank: "LEAD" }), { allowed: false, code: "FORBIDDEN", reason: "when", field: "rank", condition: "active" });
});

test("explain names each clause behind an answer, and observe records the rules a decision consults", async () => {
  const { engine, store, as, consulted } = documents();
  const [draft] = store.Doc as [Record<string, unknown>];
  const why = await engine.explain("Doc", { verb: "update", field: "stage" }, draft, as("reader"));
  assert.equal(why.allowed, false);
  assert.equal(why.source, "field");
  assert.deepEqual(why.clauses.map((clause) => clause.outcome), ["who", "who"]);
  const body = await engine.explain("Doc", { verb: "read", field: "body" }, draft, as("reader"));
  assert.deepEqual(body.clauses.map((clause) => [clause.outcome, clause.condition]), [["who", undefined], ["when", "stage"]]);
  assert.equal((await engine.explain("Doc", { verb: "update", field: "groupId" }, draft, as("lead"))).blocked, "link");
  assert.equal((await engine.explain("Doc", { verb: "read", field: "title" }, store.Doc![1]!, as("reader"))).blocked, "invisible");
  consulted.length = 0;
  await engine.authorize("Doc", "update", draft, as("writer"), { stage: "REVIEW" });
  assert.deepEqual(consulted, [
    "Doc.stage write(owner, stage: DRAFT, to: REVIEW)",
    "Doc.stage write(publish, stage: REVIEW, to: PUBLISHED | DRAFT)",
  ]);
});

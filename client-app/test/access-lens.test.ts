import assert from "./support/assert";
import test from "node:test";
import { readClientAccess as readCore } from "aws-studio/database/client-access";

/** The lens runs the enforcement core; these fixtures write it in its own text form (see packages/database/test/client-access.test.ts). */
const readClientAccess = (source: string) => readCore(source, undefined, { legacy: true });
import { changedModels, consequences, explainFor, modelLens, personas, scenarioFields } from "../src/views/access-lens";

// A generic application: people hold ranks in groups; a group's docs are
// edited by editors, published by leads, and secret ones hidden from readers.
const source = `
enum Rank {
  // @access edit(LEAD, EDITOR)
  // @access publish(LEAD)
  LEAD = "LEAD"
  EDITOR = "EDITOR"
  READER = "READER"
}
enum Stage {
  DRAFT
  REVIEW
  PUBLISHED
}
model Person {
  id String @id
  email String @unique
}
model Group {
  // @access read(member)
  id String @id
  seats Seat[] // @access members(active: true)
  invites Invite[] // @access members
}
model Seat {
  id String @id
  personId String
  groupId String
  active Boolean
  rank Rank // @access role
  person Person @relation(fields: [personId], references: [id]) // @access owner
  group Group @relation(fields: [groupId], references: [id]) // @access via(member)
}
model Invite {
  id String @id
  email String // @access owner
  groupId String
  group Group @relation(fields: [groupId], references: [id]) // @access via(LEAD)
}
model Doc {
  // @access create(edit) update(edit, stage: DRAFT | REVIEW)
  id String @id
  authorId String // @access read-only
  groupId String
  secret Boolean
  stage Stage // @access write(owner, stage: DRAFT, to: REVIEW) write(publish, stage: REVIEW, to: PUBLISHED)
  title String
  author Person @relation(fields: [authorId], references: [id]) // @access owner
  group Group @relation(fields: [groupId], references: [id]) // @access via(member, this.secret: false) via(LEAD)
}
`;
const parsed = readClientAccess(source);
const people = personas(parsed);
const as = (label: string) => people.find((person) => person.label === label)!.persona;

test("personas come from the draft: strangers, owners, each role, and role-less members", () => {
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(people.map((person) => person.label), ["Signed-in user", "Row owner", "Lead", "Editor", "Reader", "Invite holder"]);
});

test("a persona's lens is the engine's answer across the row's states", async () => {
  const reader = await modelLens(parsed, "Doc", as("Reader"));
  assert.deepEqual(reader.visible, { level: "some", when: "not secret" });
  assert.equal(reader.fields.title!.write.level, "no");
  const editor = await modelLens(parsed, "Doc", as("Editor"));
  // An editor sees only docs that are not secret, and edits them before they are published.
  assert.deepEqual(editor.fields.title!.write, { level: "some", when: "not secret and stage is not PUBLISHED" });
  assert.equal(editor.fields.groupId!.write.level, "no", "an access link never moves");
  assert.equal(editor.create.level, "yes");
  const lead = await modelLens(parsed, "Doc", as("Lead"));
  assert.deepEqual(lead.visible, { level: "yes" });
  assert.deepEqual(lead.fields.stage!.write, { level: "some", when: "stage is REVIEW" });
  assert.equal((await modelLens(parsed, "Doc", as("Signed-in user"))).visible.level, "no");
  assert.equal((await modelLens(parsed, "Group", as("Invite holder"))).visible.level, "yes", "a pending invitee sees the group");
  assert.equal((await modelLens(parsed, "Invite", as("Invite holder"))).visible.level, "no", "the fixture's invite is someone else's");
});

test("why names each clause and its outcome for the persona", async () => {
  const why = await explainFor(parsed, "Doc", as("Reader"), { verb: "update", field: "stage" });
  assert.equal(why.allowed, false);
  assert.deepEqual(why.clauses.map((clause) => clause.outcome), ["who", "who"]);
  const lead = await explainFor(parsed, "Doc", as("Lead"), { verb: "update", field: "stage" });
  assert.equal(lead.allowed, true);
  assert.deepEqual(lead.state, { secret: true, stage: "REVIEW" });
});

test("consequences say who gains or loses what, broadening first", async () => {
  const after = readClientAccess(source.replace("// @access edit(LEAD, EDITOR)", "// @access edit(LEAD, EDITOR, READER)"));
  const effects = await consequences(parsed, after, "Doc");
  assert.ok(effects.length > 0);
  assert.equal(effects[0]!.kind, "broadens");
  assert.ok(effects.some((effect) => effect.text === "Reader can create doc rows"));
  assert.ok(effects.some((effect) => effect.text === "Reader can edit Doc.title when not secret and stage is not PUBLISHED"), effects.map((effect) => effect.text).join("\n"));
  assert.deepEqual(await consequences(parsed, parsed, "Doc"), []);
});

test("destination-only enum changes report concrete gains and losses", async () => {
  const widened = readClientAccess(source.replace("to: REVIEW)", "to: REVIEW | PUBLISHED)"));
  assert.deepEqual(widened.problems, []);
  const effects = await consequences(parsed, widened, "Doc");
  assert.ok(effects.some((effect) => effect.persona === "Row owner" && effect.kind === "broadens" && effect.text === "Row owner can set Doc.stage to PUBLISHED when stage is DRAFT"), effects.map((effect) => effect.text).join("\n"));
  const narrowed = await consequences(widened, parsed, "Doc");
  assert.ok(narrowed.some((effect) => effect.persona === "Row owner" && effect.kind === "narrows" && effect.text === "Row owner can no longer set Doc.stage to PUBLISHED when stage is DRAFT"));
  const before = await modelLens(parsed, "Doc", as("Row owner"), { secret: false, stage: "DRAFT" });
  const after = await modelLens(widened, "Doc", as("Row owner"), { secret: false, stage: "DRAFT" });
  assert.deepEqual(before.fields.stage!.values.filter((entry) => entry.write.level === "yes").map((entry) => entry.value), ["REVIEW"]);
  assert.deepEqual(after.fields.stage!.values.filter((entry) => entry.write.level === "yes").map((entry) => entry.value), ["REVIEW", "PUBLISHED"]);
});

test("Boolean destination changes use the engine's assignment answers", async () => {
  const restricted = readClientAccess(source.replace("  secret Boolean", "  secret Boolean // @access write(owner, to: true)"));
  const unrestricted = readClientAccess(source.replace("  secret Boolean", "  secret Boolean // @access write(owner)"));
  assert.deepEqual(restricted.problems, []);
  assert.deepEqual(unrestricted.problems, []);
  const effects = await consequences(restricted, unrestricted, "Doc");
  assert.ok(effects.some((effect) => effect.persona === "Row owner" && effect.kind === "broadens" && effect.text === "Row owner can set Doc.secret to false"), effects.map((effect) => effect.text).join("\n"));
  const lens = await modelLens(restricted, "Doc", as("Row owner"));
  assert.deepEqual(lens.fields.secret!.values, [{ value: true, write: { level: "yes" } }, { value: false, write: { level: "no" } }]);
});

test("a change to a create column or a named write appears in the affected model's review", async () => {
  const contract = `
/// @access(read: isMe(id))
model User {
  id String @id
  notes Note[]
}
/// @access(read: isMe(authorId))
/// @access(create(title): isMe(authorId))
model Note {
  id String @id
  authorId String
  author User @relation(fields: [authorId], references: [id])
  title String
  body String
  draft Boolean
}`;
  const before = readCore(contract);
  const after = readCore(contract.replace("create(title)", "create(title, body)"));
  assert.deepEqual(before.problems, []);
  assert.deepEqual(after.problems, []);
  const changes = await consequences(before, after, "Note");
  assert.ok(changes.some(({ text }) => text === "Row owner can set Note.body on creation"));
  assert.ok(!changes.some(({ text }) => text === "Row owner can edit Note.body"));
  const withCommand = readCore(contract.replace("model Note {", "/// @access(command publishNote, delete: owner && draft == false)\nmodel Note {"));
  assert.deepEqual(withCommand.problems, []);
  assert.ok(changedModels(before, withCommand).includes("Note"));
  const commandChanges = await consequences(before, withCommand, "Note");
  assert.ok(commandChanges.some(({ text }) => text.includes("Command publishNote") && text.includes("on Note")));
  assert.ok(commandChanges.some(({ text }) => text === "Row owner can delete note rows when not draft"));
});

test("condition replacements report the states gained and lost instead of equal-rank changes", async () => {
  const after = readClientAccess(source.replace("update(edit, stage: DRAFT | REVIEW)", "update(edit, stage: REVIEW | PUBLISHED)"));
  const effects = await consequences(parsed, after, "Doc");
  assert.ok(effects.some((effect) => effect.kind === "broadens" && effect.text === "Editor can edit Doc.title when not secret and stage is PUBLISHED"), effects.map((effect) => effect.text).join("\n"));
  assert.ok(effects.some((effect) => effect.kind === "narrows" && effect.text === "Editor can no longer edit Doc.title when not secret and stage is DRAFT"));
});

test("personas removed from the draft still appear in access losses", async () => {
  const after = readClientAccess(source.replace('  READER = "READER"\n', ""));
  assert.deepEqual(after.problems, []);
  assert.equal(personas(after).some((person) => person.label === "Reader"), false);
  const effects = await consequences(parsed, after, "Doc");
  assert.ok(effects.some((effect) => effect.persona === "Reader" && effect.kind === "narrows" && effect.text === "Reader can no longer see doc rows when not secret"), effects.map((effect) => effect.text).join("\n"));
});

test("membership-filter changes compare the same related rows and disclose their scope", async () => {
  const after = readClientAccess(source.replace("members(active: true)", "members(active: false)"));
  const effects = await consequences(parsed, after, "Doc");
  assert.ok(effects.some((effect) => effect.persona === "Reader" && effect.kind === "narrows" && effect.text === "Reader can no longer see doc rows when not secret (with Seat.active = true)"), effects.map((effect) => effect.text).join("\n"));
  assert.ok(effects.some((effect) => effect.persona === "Reader" && effect.kind === "broadens" && effect.text === "Reader can see doc rows when not secret (with Seat.active = false)"));
});

test("a chosen row scenario constrains both answers and explanations", async () => {
  assert.deepEqual(scenarioFields(parsed, "Doc").map((field) => field.field), ["secret", "stage"]);
  const hidden = await modelLens(parsed, "Doc", as("Editor"), { secret: true, stage: "DRAFT" });
  assert.deepEqual(hidden.coverage, { evaluated: 1, total: 1, truncated: false });
  assert.deepEqual(hidden.visible, { level: "no" });
  assert.deepEqual(hidden.fields.title!.write, { level: "no" });
  assert.ok(hidden.assumptions.includes("Seat.active = true"), "the assumed active membership is disclosed");
  const visible = await modelLens(parsed, "Doc", as("Editor"), { secret: false, stage: "DRAFT" });
  assert.deepEqual(visible.fields.title!.write, { level: "yes" });
  const why = await explainFor(parsed, "Doc", as("Lead"), { verb: "update", field: "stage" }, { secret: false, stage: "DRAFT" });
  assert.equal(why.allowed, false, "a fixed scenario must not jump to REVIEW to find a passing state");
  assert.deepEqual(why.state, { secret: false, stage: "DRAFT" });
});

test("bounded state evaluation reports coverage and fixes a scenario before applying the bound", async () => {
  const flags = Array.from({ length: 7 }, (_, index) => `flag${index}`);
  const many = readClientAccess(source
    .replace("update(edit, stage: DRAFT | REVIEW)", `update(edit, ${flags.map((field) => `${field}: true`).join(", ")})`)
    .replace("  title String", `${flags.map((field) => `  ${field} Boolean`).join("\n")}\n  title String`));
  assert.deepEqual(many.problems, []);
  const lens = await modelLens(many, "Doc", as("Editor"));
  assert.deepEqual(lens.coverage, { evaluated: 96, total: 768, truncated: true });
  const state = { secret: false, stage: "DRAFT", ...Object.fromEntries(flags.map((field) => [field, false])) };
  const fixed = await modelLens(many, "Doc", as("Editor"), state);
  assert.deepEqual(fixed.coverage, { evaluated: 1, total: 1, truncated: false });
  assert.equal(fixed.visible.level, "yes");
  assert.equal(fixed.fields.title!.write.level, "no");
  const effects = await consequences(many, many, "Doc");
  assert.ok(effects.some((effect) => effect.kind === "changes" && effect.text.includes("96 of 768")), "a partial comparison must never claim no access changed");
});

test("changed models include protection changes, removed models and inherited access paths", () => {
  const protectedField = readClientAccess(source.replace("  title String", "  title String // @access server-only"));
  assert.ok(changedModels(parsed, protectedField).includes("Doc"));
  const groupChange = readClientAccess(source.replace("members(active: true)", "members(active: false)"));
  const affected = changedModels(parsed, groupChange);
  assert.ok(affected.includes("Group"));
  assert.ok(affected.includes("Doc"));
  assert.ok(affected.includes("Seat"));
  const removed = readClientAccess(source.slice(0, source.indexOf("model Doc")));
  assert.ok(changedModels(parsed, removed).includes("Doc"));
});

test("the field example only asks for states that affect the selected field or row visibility", () => {
  const withOther = readClientAccess(source.replace("title String", "title Boolean // @access write(publish, title: true)"));
  assert.deepEqual(scenarioFields(withOther, "Doc", "stage").map(entry => entry.field).sort(), ["secret", "stage"]);
});

test("preview people distinguish two declared membership paths to the same role enum", () => {
  const shared = source.replace("  seats Seat[] // @access members(active: true)",
    '  seats Seat[] @relation("groupSeats") // @access members(active: true)\n  delegatedSeats Seat[] @relation("delegatedSeats") // @access members(active: true)')
    .replace("  group Group @relation(fields: [groupId], references: [id]) // @access via(member)",
      '  group Group @relation("groupSeats", fields: [groupId], references: [id]) // @access via(member)\n  delegatedId String?\n  delegated Group? @relation("delegatedSeats", fields: [delegatedId], references: [id])');
  const draft = readClientAccess(shared);
  const choices = personas(draft).filter(entry => entry.persona.kind === "role" && entry.persona.role === "EDITOR");
  assert.deepEqual(draft.problems, []);
  assert.equal(new Set(choices.map(entry => entry.id)).size, 2);
  assert.deepEqual(choices.map(entry => entry.label), ["Editor through Group.seats", "Editor through Group.delegatedSeats"]);
});

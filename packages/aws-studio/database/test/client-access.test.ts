import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeRowAccess,
  readClientAccess as readCore,
  renderClientAccess,
  type AccessModules,
} from "../client-access.js";

/**
 * The enforcement core, written in its own text form (`// @access owner`):
 * the rules `/// @access(…)` directives lower into. A schema never uses this
 * form, and without `{ legacy: true }` it is an AG-LEGACY problem; these suites
 * read it directly to test the core's semantics and diagnostics.
 */
const readClientAccess = (source: string, modules?: AccessModules) => readCore(source, modules, { legacy: true });

// A small, generic application: users own notes, teams have members, and a
// team's documents and comments inherit the team's visibility.
const source = [
  "// use prisma-8",
  "// Access: `// @access server-only` documents the syntax here.",
  "enum MemberStatus {",
  "  ACTIVE",
  "  LEFT",
  "}",
  "model User {",
  "  id        Uuid     @id @default(uuid())",
  "  email     String   @unique",
  "  password  String   // @access server-only",
  "  notes     Note[]",
  "  members   Member[] // @access via(status: ACTIVE)",
  "}",
  "model Note {",
  '  id       Uuid   @id @default(uuid())',
  '  title    String @default("a // b")',
  "  secret   String // internal note @access server-only",
  "  author   User   @relation(fields: [authorId], references: [id]) // @access owner",
  "  authorId Uuid",
  "  editedAt TimestamptzString(6) @default(now())",
  '  @@map("notes")',
  "}",
  "model Team {",
  "  id      Uuid     @id",
  "  members Member[] // @access members(status: ACTIVE)",
  "  invites Invite[] // @access members",
  "  docs    Doc[]",
  "}",
  "model Member {",
  "  id     Uuid         @id",
  "  status MemberStatus",
  "  team   Team @relation(fields: [teamId], references: [id]) // @access via",
  "  teamId Uuid",
  "  user   User @relation(fields: [userId], references: [id]) // @access owner",
  "  userId Uuid",
  "}",
  "model Invite {",
  "  id     Uuid   @id",
  "  email  String // @access owner",
  "  token  String // @access server-only",
  "  team   Team   @relation(fields: [teamId], references: [id]) // @access via",
  "  teamId Uuid",
  "}",
  "model Doc {",
  "  id     Uuid @id",
  "  team   Team @relation(fields: [teamId], references: [id]) // @access via",
  "  teamId Uuid",
  "}",
  "model Log {",
  "  id   Uuid   @id",
  "  text String",
  "}",
].join("\n");

const lineOf = (text: string) => source.split("\n").findIndex((line) => line.includes(text)) + 1;

test("field settings: explicit ones, and read-only keys and clock fields without a comment", () => {
  const { settings, problems } = readClientAccess(source);
  assert.deepEqual(problems, []);
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), {
    User: { id: "read-only", password: "server-only" },
    Note: { id: "read-only", secret: "server-only", editedAt: "read-only" },
    Team: { id: "read-only" },
    Member: { id: "read-only" },
    Invite: { id: "read-only", token: "server-only" },
    Doc: { id: "read-only" },
    Log: { id: "read-only" },
  });
});

test("row rules: owner, members and via, with the user model and the viewer fields derived", () => {
  const { rows } = readClientAccess(source);
  assert.equal(rows.userModel, "User");
  assert.deepEqual(rows.viewer, ["id", "email"]);
  assert.deepEqual(Object.keys(rows.models), ["User", "Note", "Team", "Member", "Invite", "Doc"], "Log has no rule, so it is not in the API");
  assert.deepEqual(rows.models.User, {
    key: ["id"], self: true,
    rules: [{ kind: "via", relation: "members", model: "Member", local: ["id"], target: ["userId"], where: { status: "ACTIVE" } }],
  });
  assert.deepEqual(rows.models.Note!.rules, [{ kind: "owner", relation: "author", fields: ["authorId"] }]);
  assert.deepEqual(rows.models.Team!.rules, [
    { kind: "members", relation: "members", model: "Member", local: ["id"], target: ["teamId"], where: { status: "ACTIVE" } },
    { kind: "members", relation: "invites", model: "Invite", local: ["id"], target: ["teamId"] },
  ]);
  assert.deepEqual(rows.models.Invite!.rules, [
    { kind: "owner", field: "email" },
    { kind: "via", relation: "team", model: "Team", local: ["teamId"], target: ["id"] },
  ]);
  assert.equal(describeRowAccess("Team", rows), "Visible to users with ACTIVE members or invites");
  assert.equal(describeRowAccess("Invite", rows), "Visible to the user with this email, or anyone who can see its team");
  assert.equal(describeRowAccess("User", rows), "Visible to the user themself, or anyone who can see its ACTIVE members");
  assert.equal(describeRowAccess("Log", rows), "Not in the GraphQL API");
});

test("every invalid or misplaced setting is a problem that names its fix, never ignored", () => {
  const problems = (lines: readonly string[]) => readClientAccess(lines.join("\r\n")).problems.map((item) => `${item.line}: ${item.message}`);
  const base = ["model User {", "  id Uuid @id", "  email String @unique", "}"];
  assert.deepEqual(problems([
    "model Note {",
    "  /// @access server-only",
    "  id     Uuid @id",
    "  title  String // @access editable",
    "  body   String // @access hidden",
    "  author User @relation(fields: [authorId], references: [id]) // @access read-only",
    "  authorId Uuid",
    '  @@map("notes") // @access server-only',
    "}",
    ...base,
  ]), [
    // `///` starts an Access Graph directive, which takes its rules in parentheses.
      "2: AG-SYNTAX: Write the rule inside parentheses: /// @access(read: userId == auth.id).",
    '4: Fields inherit model rules: remove "@access editable" from Note.title. Client assignments require a write grant.',
    '5: Unknown access setting "hidden" on Note.body. Use server-only, read-only, read or write on a field, or owner, members or via on a relation.',
    "6: Note.author is a relation. Set read-only on its foreign-key field, or use owner, members or via here.",
    "8: Put @access at the end of a field's line, or on a comment line of its own inside a model or enum.",
  ]);
  const rows = problems([
    "enum S {", "  ON", "}",
    "model A {",
    "  id    Uuid @id",
    '  bs    B[]  @relation("AtoB") // @access members(state: OFF)',
    "  cs    C[]  // @access members",
    '  b     B?   @relation("BtoA", fields: [bId], references: [id]) // @access via',
    "  bId   Uuid?",
    "  name  String // @access owner(x: ON)",
    "  title String // @access via",
    "}",
    "model B {",
    "  id    Uuid @id",
    "  state S",
    "  aId   Uuid",
    '  owner A @relation("AtoB", fields: [aId], references: [id])',
    '  as    A[] @relation("BtoA") // @access via',
    "  as2   A[] // @access members(",
    "  u     User @relation(fields: [uId], references: [id]) // @access owner",
    "  uId   Uuid",
    "}",
    "model C {",
    "  id  Uuid @id",
    "  a   A @relation(fields: [aId], references: [id])",
    "  aId Uuid",
    "}",
    ...base,
  ]);
  assert.deepEqual(rows, [
    "6: OFF is not a S value. Use one of ON.",
    "7: members on A.cs counts the owners of C rows, but C has no owner. Add @access owner to the relation that names its user.",
    "10: owner takes no filter; only members and via do.",
    "11: via needs a relation; A.title is a field.",
    "18: via goes round in a circle: A → B → A. Give one of these models owner or members instead.",
    '19: Close the parentheses after "members" on B.as2.',
  ]);
  assert.deepEqual(problems([
    "model Note {",
    "  id Uuid @id",
    "  notes Note[] // @access owner",
    "  email String // @access owner",
    "  title String // @access owner",
    "  team Team @relation(fields: [teamId], references: [id]) // @access owner",
    "  teamId Uuid",
    "}",
    "model Team {", "  id Uuid @id", "  notes Note[]", "}",
    ...base.slice(0, 3),
    "  notes2 Note[]",
    "}",
    "model Pin {",
    "  id Uuid @id",
    "  user User @relation(fields: [userId], references: [id]) // @access owner",
    "  userId Uuid",
    "}",
  ]), [
    "3: owner needs a to-one relation that holds the foreign key, such as user User @relation(fields: [userId], references: [id]).",
    "4: owner on Note.email matches Team.email, which must be a unique field of Team.",
    "5: owner on Note.title matches Team.title, which must be a unique field of Team.",
    "20: Every owner relation must point at one user model. This one points at User; another points at Team.",
  ], "the first owner relation names the user model, and a field owner must be one of its unique fields");
});

test("the generated module is stable and literal", () => {
  const { settings, rows } = readClientAccess(source);
  const text = renderClientAccess(settings, rows);
  assert.equal(text, renderClientAccess(settings, rows));
  assert.match(text, /"secret": "server-only",/);
  assert.match(text, /export const rowAccess = \{\n  "userModel": "User",/);
  assert.match(text, /\} as const;\n\nexport type RowAccess = typeof rowAccess;/);
  assert.match(renderClientAccess({}, { viewer: [], models: {} }), /export const clientAccess = \{\n\} as const;/);
});

test("conditions, transitions, links and user references are validated with their fix", () => {
  const problems = (text: string) => readClientAccess(text).problems.map((item) => item.message);
  const base = `
enum Stage {
  DRAFT
  LIVE
  LOCKED // @access read-only
}
model User {
  id Uuid @id
  email String @unique
  posts Post[]
}
model Post {
  // @access create(owner) update(owner)
  id Uuid @id
  stage Stage
  hidden Boolean
  author User @relation(fields: [authorId], references: [id]) // @access owner
  authorId Uuid
}
`;
  assert.deepEqual(problems(base), []);
  const at = (from: string, to: string) => problems(base.replace(from, to));
  assert.deepEqual(at("  stage Stage\n", "  stage Stage // @access write(owner, to: LIVE | DRAFT)\n"), []);
  assert.match(at("  stage Stage\n", "  stage Stage // @access write(owner, to: LOCKED)\n")[0]!, /Stage.LOCKED is read-only/);
  assert.match(at("  stage Stage\n", "  stage Stage // @access write(owner, to: GONE)\n")[0]!, /GONE is not a Stage value/);
  assert.match(at("  hidden Boolean\n", "  hidden Boolean // @access write(owner, to: true | false)\n")[0]!, /not valid in write/);
  assert.match(at("create(owner) update(owner)", "create(owner) update(owner, to: LIVE)")[0]!, /to: names the value a field's write assigns/);
  assert.deepEqual(at("  hidden Boolean\n", "  hidden Boolean // @access read(owner, stage: LIVE | DRAFT)\n"), [], "reads take conditions");
  assert.deepEqual(at("update(owner)", "update(owner, this.stage: DRAFT)"), [], "this. names this row everywhere");
  assert.match(at("update(owner)", "update(owner, this.stage: DRAFT, stage: LIVE)")[0]!, /names stage twice/);
  assert.match(at("  authorId Uuid\n", "  authorId Uuid // @access write(owner)\n").join(), /^$/, "a move needs create, which Post has");
  assert.match(at("// @access create(owner) update(owner)", "// @access update(owner)").join("\n") + at("// @access create(owner) update(owner)\n", "// @access update(owner)\n").join(), /^$/);
  assert.match(problems(base.replace("// @access create(owner) update(owner)", "// @access update(owner)").replace("  authorId Uuid\n", "  authorId Uuid // @access write(owner)\n"))[0]!, /moves the row.*add create/);
  const reviewer = base.replace("  authorId Uuid\n", "  authorId Uuid\n  reviewer User? @relation(\"Review\", fields: [reviewerId], references: [id])\n  reviewerId Uuid?\n").replace("  posts Post[]\n", "  posts Post[]\n  reviews Post[] @relation(\"Review\")\n");
  assert.match(problems(reviewer)[0]!, /Post.reviewerId names a User that clients could choose/);
  assert.deepEqual(problems(reviewer.replace("reviewerId Uuid?\n", "reviewerId Uuid? // @access read-only\n")), []);
  assert.deepEqual(problems(reviewer.replace("reviewerId Uuid?\n", "reviewerId Uuid? // @access write(owner)\n")), []);
  assert.match(at("author User @relation(fields: [authorId], references: [id]) // @access owner", "author User @relation(fields: [authorId], references: [id]) // @access owner owner")[0]!, /says owner twice/);
  assert.match(at("// @access create(owner) update(owner)", "// @access create(owner) update(owner) delete(authenticated)")[0]!, /only create and a model's read take it/);
});

test("several row clauses on one relation are alternatives, and describe themselves in words", () => {
  const text = source.replace("  team   Team   @relation(fields: [teamId], references: [id]) // @access via\n  teamId Uuid\n}\nmodel Doc",
    "  team   Team   @relation(fields: [teamId], references: [id]) // @access via\n  teamId Uuid\n}\nmodel Doc")
    .replace("model Doc {\n  id     Uuid @id\n  team   Team @relation(fields: [teamId], references: [id]) // @access via",
      "model Doc {\n  id     Uuid @id\n  draft  Boolean\n  team   Team @relation(fields: [teamId], references: [id]) // @access via(this.draft: false) via(this.draft: true)");
  const { problems, rows } = readClientAccess(text);
  assert.deepEqual(problems, []);
  assert.equal(rows.models.Doc!.rules.length, 2);
  assert.equal(describeRowAccess("Doc", rows), "Visible to anyone who can see its team while not draft, or anyone who can see its team while draft");
  assert.equal(describeRowAccess("Doc", readClientAccess(text.replace("model Log {\n", "model Log {\n  // @access read(authenticated)\n")).rows) && describeRowAccess("Log", readClientAccess(text.replace("model Log {\n", "model Log {\n  // @access read(authenticated)\n")).rows), "Visible to every signed-in user");
});

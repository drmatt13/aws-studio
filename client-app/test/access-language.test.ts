import assert from "./support/assert";
import { test } from "node:test";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { prismaCompletions, prismaDefinition, prismaLanguage } from "../src/views/prisma-language";
import { accessDiagnostics, accessTokens, explainAccessAt } from "../src/views/prisma-access-language";
import { accessDirectives, readClientAccess } from "aws-studio/database/client-access";

const contract = `// use prisma-8
enum Rank {
  /// @access(...READER, editMembers)
  LEAD = "lead"
  /// @access(read)
  READER = "reader"
}
enum Status {
  ACTIVE = "active"
  INVITED = "invited"
}
/// @access(read: id == auth.id)
model User {
  id String @id
  seats Seat[]
}
/// @access(roles: seats[status=ACTIVE].rank)
model Group {
  id String @id
  seats Seat[]
  notes Note[]
}
model Seat {
  id String @id
  userId String
  groupId String
  rank Rank
  status Status
  nickname String
  user User @relation(fields: [userId], references: [id])
  group Group @relation(fields: [groupId], references: [id])
  @@unique([groupId, userId])
}
/// @access(read: group.member || authorId == auth.id)
model Note {
  id String @id
  groupId String
  authorId String
  body String
  status Status
  group Group @relation(fields: [groupId], references: [id])
  author User @relation(fields: [authorId], references: [id])
}
`;

function complete(line: string, replacement: string) {
  assert.ok(contract.includes(line), line);
  const marked = contract.replace(line, replacement), pos = marked.indexOf("|");
  assert.notEqual(pos, -1);
  const doc = marked.slice(0, pos) + marked.slice(pos + 1);
  return prismaCompletions(new CompletionContext(EditorState.create({ doc, extensions: [prismaLanguage] }), pos, true));
}
const labels = (result: ReturnType<typeof complete>) => result?.options.map(option => option.label) ?? [];

test("the fixture compiles", () => {
  assert.deepEqual(readClientAccess(contract).problems, []);
});

test("a directive offers what may be written where it sits: model, field or role", () => {
  assert.deepEqual(labels(complete("/// @access(read: group.member || authorId == auth.id)", "/// @access(|)")), ["read", "create", "update", "delete", "deny", "command", "roles", "from", "only", "fields"]);
  const field = labels(complete("  nickname String\n  user", "  /// @access(|)\n  nickname String\n  user"));
  assert.ok(field.includes("readonly") && field.includes("serverOnly") && field.includes("write"), JSON.stringify(field));
  const transition = labels(complete("  status Status\n  nickname", "  /// @access(|)\n  status Status\n  nickname"));
  assert.ok(transition.includes("ACTIVE") && transition.includes("INVITED"), "a state field offers its values to start a transition");
  assert.deepEqual(labels(complete("  status Status\n  nickname", "  /// @access(ACTIVE -> |)\n  status Status\n  nickname")), ["ACTIVE", "INVITED"]);
  assert.deepEqual(labels(complete("/// @access(read)\n  READER", "/// @access(|)\n  READER")), ["...LEAD", "read", "create", "update", "delete", "editMembers", "protected"]);
  assert.equal(complete("  nickname String\n  user", "  nickname String // |\n  user"), null, "an ordinary comment offers nothing");
});

test("a condition offers identities, relations, row values and the abilities a relation leads to", () => {
  const start = labels(complete("read: group.member || authorId == auth.id", "read: |"));
  for (const expected of ["isMe(authorId)", "status", "group.", "author.", "authenticated"]) assert.ok(start.includes(expected), expected);
  assert.ok(!start.includes("editMembers"), "a model without its own scope names roles through a relation");
  const related = labels(complete("read: group.member || authorId == auth.id", "read: group.|"));
  for (const expected of ["read", "member", "editMembers", "LEAD", "READER"]) assert.ok(related.includes(expected), expected);
  assert.deepEqual(labels(complete("read: group.member || authorId == auth.id", "read: group.member && status == |")), ["ACTIVE", "INVITED"]);
  assert.deepEqual(labels(complete("read: group.member || authorId == auth.id", "read: authorId == |")), ["auth.id"]);
  const scoped = labels(complete("/// @access(roles: seats[status=ACTIVE].rank)", "/// @access(roles: seats[status=ACTIVE].rank)\n/// @access(deny read: |)"));
  assert.ok(scoped.includes("editMembers") && scoped.includes("member"), "a scope names its own roles and abilities");
});

test("typing the directive itself is offered after three slashes", () => {
  assert.deepEqual(labels(complete("/// @access(read: id == auth.id)\nmodel User", "/// @acc|\nmodel User")), ["@access"]);
});

test("inline declarations complete against their own field or enum value across continuation lines", () => {
  assert.deepEqual(labels(complete("nickname String", "nickname String /// @acc|")), ["@access"]);
  assert.deepEqual(labels(complete("status Status\n  nickname", "status Status /// @access(ACTIVE ->\n  /// |)\n  nickname")), ["ACTIVE", "INVITED"]);
  assert.deepEqual(labels(complete('/// @access(read)\n  READER = "reader"', 'READER = "reader" /// @access(|)')), ["...LEAD", "read", "create", "update", "delete", "editMembers", "protected"]);
  assert.equal(complete("nickname String", 'nickname String @default("/// @acc|")'), null);
});

test("a multiline field group completes, colours and explains its fields at their source positions", () => {
  const rule = "/// @access(read: group.member || authorId == auth.id)";
  const fieldOptions = labels(complete(rule, `/// @access(fields(body,\n///   |), readonly)\n${rule}`));
  assert.ok(fieldOptions.includes("status"));
  assert.ok(!fieldOptions.includes("body") && !fieldOptions.includes("group"));
  const fieldRules = labels(complete(rule, `/// @access(fields(body, status), |)\n${rule}`));
  assert.deepEqual(fieldRules, ["readonly", "serverOnly", "read", "write"]);

  const source = contract.replace(rule, `/// @access(fields(body,\n///   status), readonly)\n${rule}`);
  const directive = accessDirectives(source).find(({ rule }) => rule?.kind === "fieldGroup")!;
  assert.deepEqual(accessTokens([directive]).map(({ from, to, category }) => [source.slice(from, to), category]), [
    ["fields", "action"], ["body", "column"], ["status", "column"], ["readonly", "limit"],
  ]);
  const status = source.indexOf("status), readonly");
  const hover = explainAccessAt(source, status + 1)!;
  assert.equal(hover.title, "Note.status");
  assert.equal(source.slice(hover.from, hover.to), "status");
  assert.equal(prismaDefinition(source, status + 1)?.text, "status Status");
  assert.equal(explainAccessAt(source, source.indexOf("readonly") + 1)?.title, "Read only");
});

test("go to definition follows relations, fields, roles and abilities to their declarations", () => {
  const at = (needle: string, offset = 1) => prismaDefinition(contract, contract.indexOf(needle) + offset);
  assert.equal(at("member || authorId"), undefined, "member is a keyword, not a declaration");
  assert.equal(at("group.member")?.text, "group Group @relation(fields: [groupId], references: [id])");
  assert.equal(at("authorId == auth")?.text, "authorId String");
  assert.equal(at("READER, editMembers", 1)?.text, 'READER = "reader"');
  const editMembers = prismaDefinition(contract, contract.indexOf("editMembers") + 2)!;
  assert.equal(editMembers.kind, "AccessPermission");
  assert.equal(editMembers.text, "/// @access(...READER, editMembers)");
});

test("hover explains a token in words, from the compiled policy", () => {
  const explanation = explainAccessAt(contract, contract.indexOf("group.member") + 7)!;
  assert.equal(explanation.category, "role");
  assert.match(explanation.body, /Eligible roles in the related Group’s scope: LEAD, READER/);
  const identity = explainAccessAt(contract, contract.indexOf("authorId == auth.id") + 2)!;
  assert.equal(identity.category, "identity");
  assert.equal(contract.slice(identity.from, identity.to), "authorId == auth.id");
});

test("access problems underline the word the compiler points at", () => {
  const typo = contract.replace("/// @access(read: id == auth.id)\nmodel User", "/// @access(red: id == auth.id)\nmodel User");
  const [diagnostic] = accessDiagnostics(typo, readClientAccess(typo).problems);
  assert.equal(diagnostic!.code, "AG-KEY");
  assert.equal(typo.slice(diagnostic!.from, diagnostic!.to), "red");
  const unknown = contract.replace("group.member ||", "group.membr ||");
  const problems = readClientAccess(unknown).problems;
  assert.ok(problems.length > 0, "an unknown role or ability fails compilation");
});

test("permission references navigate to the exact row and its holder names navigate to the enum values", () => {
  const source = contract.replace("enum Rank {", "/// @access(review: [LEAD])\n/// @access(exportNotes: [])\nenum Rank {").replace("group.member ||", "group.review ||");
  const permission = prismaDefinition(source, source.lastIndexOf("group.review") + 7)!;
  assert.equal(permission.text, "/// @access(review: [LEAD])");
  assert.equal(source.slice(permission.from, permission.to), "review");
  assert.equal(prismaDefinition(source, source.indexOf("[LEAD]") + 2)?.text, 'LEAD = "lead"');
  assert.match(explainAccessAt(source, source.indexOf("exportNotes") + 2)!.body, /none/);
  assert.deepEqual(labels(complete("enum Rank {", "/// @access(review: [LEAD, |])\nenum Rank {")), ["READER"]);
});

test("identity and membership completion follow the actual foreign key and scoped fields", () => {
  const binding = "roles: seats[status=ACTIVE].rank";
  const rule = "role: seats[isMe(userId) && status == ACTIVE].rank";
  const source = contract.replace(binding, rule);
  assert.deepEqual(labels(complete(binding, "role: seats[isMe(|)].rank")), ["userId"]);
  assert.deepEqual(labels(complete("read: group.member || authorId == auth.id", "read: isMe(|)")), ["authorId"]);
  assert.deepEqual(labels(complete(binding, "role: seats[isMe(userId) && status == |].rank")), ["ACTIVE", "INVITED"]);
  assert.equal(explainAccessAt(source, source.indexOf("isMe(userId)") + 1)?.title, "The signed-in user");
  assert.equal(prismaDefinition(source, source.indexOf("isMe(userId)") + 6)?.text, "userId String");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { SyntaxProblem, categorize, normalizedRule, parseRule, readDirectives } from "../access-syntax.js";

const categories = (text: string, placement: "model" | "field" | "enum" | "value") =>
  categorize(parseRule(text, placement)).map(({ from, to, category }) => `${text.slice(from, to)}:${category}`);

test("directives stack, continue over /// lines while open, and map every character to the source", () => {
  const source = [
    "/// @access(read: id == auth.id)",
    "/// A description between rules.",
    "/// @access(read(id, name):",
    "///   members.read",
    "///   || sent.read)",
    "model User {",
    "  name String // @access(read)",
    "}",
  ].join("\n");
  const found = readDirectives(source);
  assert.deepEqual(found.map(({ line, endLine, error }) => [line, endLine, error?.code]), [[1, 1, undefined], [3, 5, undefined], [7, 7, "AG-SLASHES"]]);
  const continued = found[1]!;
  assert.equal(normalizedRule(continued.text), "read(id, name): members.read || sent.read");
  const at = continued.text.indexOf("sent");
  assert.equal(source.slice(continued.offsets[at], continued.offsets[at]! + 4), "sent", "offsets point into the source");
});

test("prose that mentions @access is documentation; a directive hidden behind prose is an error", () => {
  assert.deepEqual(readDirectives("/// See `@access` in the guide.\nmodel A {}"), []);
  assert.equal(readDirectives("/// Note: @access(read: x == auth.id)\nmodel A {}")[0]!.error!.code, "AG-SYNTAX");
  assert.equal(readDirectives("/// @access(read: x == auth.id) trailing\nmodel A {}")[0]!.error!.code, "AG-SYNTAX");
});

test("each token has a category: identity, role, path, state, limit, action, column", () => {
  assert.deepEqual(categories("read, update(name): ownerId == auth.id", "model"), ["read:action", "update:action", "name:column", "ownerId:identity", "==:identity", "auth.id:identity"]);
  assert.deepEqual(categories("read: workspace.member || conversation.read", "model"), ["read:action", "workspace:path", "member:role", "conversation:path", "read:path"]);
  assert.deepEqual(categories("create: workspace.invite && email != auth.email", "model"), ["create:action", "workspace:path", "invite:role", "email:identity", "!=:limit", "auth.email:identity"]);
  assert.deepEqual(categories("deny read: status == DRAFT && !createCase", "model"), ["deny:limit", "read:action", "status:state", "==:state", "DRAFT:state", "!:limit", "createCase:role"]);
  assert.deepEqual(categories("roles: memberships[status=ACTIVE].role", "model"), ["roles:role", "memberships:role", "status:state", "ACTIVE:state", "role:role"]);
  assert.deepEqual(categories("role: seats[isMe(personId) && status == ACTIVE].role", "model"), ["role:role", "seats:role", "isMe:identity", "personId:identity", "status:state", "ACTIVE:state", "role:role"]);
  assert.deepEqual(categories("create: team.editor && !isMe(personId)", "model"), ["create:action", "team:path", "editor:role", "!:limit", "isMe:identity", "personId:identity"]);
  assert.deepEqual(categories("from: workspace, only: [read]", "model"), ["from:path", "workspace:path", "only:limit", "read:action"]);
  assert.deepEqual(categories("PENDING -> ACCEPTED | DECLINED: email == auth.email", "field"), ["PENDING:state", "->:state", "ACCEPTED:state", "DECLINED:state", "email:identity", "==:identity", "auth.email:identity"]);
  assert.deepEqual(categories("serverOnly", "field"), ["serverOnly:limit"]);
  assert.deepEqual(categories("fields(plan,\n status,), read: id == auth.id, readonly", "model"), ["fields:action", "plan:column", "status:column", "read:action", "id:identity", "==:identity", "auth.id:identity", "readonly:limit"]);
  assert.deepEqual(categories("...ADMIN, read, inviteMembers, protected", "value"), ["...ADMIN:role", "read:action", "inviteMembers:role", "protected:limit"]);
  assert.deepEqual(categories("inviteMembers: [ADMIN, OWNER]", "enum"), ["inviteMembers:role", "ADMIN:role", "OWNER:role"]);
  assert.deepEqual(categories("command saveDraft, update(title): editNotes && status == DRAFT", "model"), ["command:action", "saveDraft:action", "update:action", "title:column", "editNotes:role", "status:state", "==:state", "DRAFT:state"]);
});

test("a permission row retains exact spans for the name, each role and the full list", () => {
  for (const list of ["[]", "[\n  EDITOR, OWNER,\n]"]) {
    const text = `editNotes: ${list}`;
    const rule = parseRule(text, "enum");
    assert.ok(rule.kind === "permission");
    assert.equal(text.slice(rule.name.from, rule.name.to), "editNotes");
    assert.equal(text.slice(rule.listSpan.from, rule.listSpan.to), list);
    assert.deepEqual(rule.roles.map((role) => text.slice(role.from, role.to)), list === "[]" ? [] : ["EDITOR", "OWNER"]);
  }
});

test("syntax errors carry a code and the span to underline", () => {
  const problem = (text: string, placement: "model" | "field" | "value" = "model") => {
    try { parseRule(text, placement); } catch (error) { if (error instanceof SyntaxProblem) return [error.code, text.slice(error.at.from, error.at.to)]; throw error; }
    return undefined;
  };
  assert.deepEqual(problem("read userId == auth.id"), ["AG-SYNTAX", "userId"]);
  assert.deepEqual(problem("view: userId == auth.id"), ["AG-KEY", "view"]);
  assert.deepEqual(problem("read: userId == input.id"), ["AG-READ-EXPRESSION", "input."]);
  assert.deepEqual(problem("read: isMe()"), ["AG-SYNTAX", ")"]);
  assert.deepEqual(problem("read: isMe(user.id)"), ["AG-SYNTAX", "."]);
  assert.deepEqual(problem("read: isMe(a, b)"), ["AG-SYNTAX", ","]);
  assert.deepEqual(problem("roles: seats[isMe(a) && isMe(b)].role"), ["AG-ROLES-SYNTAX", "isMe"]);
  assert.deepEqual(problem("roles: seats[isMe(a) || state == ACTIVE].role"), ["AG-SYNTAX", "||"]);
  assert.deepEqual(problem("role: seats.role, roles: seats.role"), ["AG-DUPLICATE", "roles"]);
  assert.deepEqual(problem("from: case, read: x == auth.id"), ["AG-BASE", "read"]);
  assert.deepEqual(problem("read: a == auth.id, update: b == auth.id"), ["AG-SYNTAX", ","]);
  assert.deepEqual(problem("hidden", "field"), ["AG-FIELD-RULE", "hidden"]);
  assert.deepEqual(problem("fields(plan, plan), readonly"), ["AG-DUPLICATE", "plan"]);
  assert.deepEqual(problem("read(id), read(name): authenticated"), ["AG-DUPLICATE", "read"]);
  assert.deepEqual(problem("fields(plan), readonly", "field"), ["AG-FIELD-GROUP", "fields"]);
  assert.deepEqual(problem("fields(), readonly"), ["AG-SYNTAX", ")"]);
  assert.equal(problem("read: (a == auth.id")?.[0], "AG-SYNTAX", "an unclosed parenthesis");
});

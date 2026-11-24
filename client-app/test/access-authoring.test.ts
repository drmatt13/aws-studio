import assert from "./support/assert";
import { test } from "node:test";
import { accessFixture } from "./support/access-fixture";
const modules = undefined;
import { accessDirectives, readClientAccess } from "aws-studio/database/client-access";
import { accessDirectiveLine, roleHoldings, setAccessRule, toggleRoleHolding } from "../src/views/access-authoring";

const source = `// use prisma-8
enum Rank {
  /// The highest role.
  /// @access(...LEAD, delete, protected)
  ROOT = "ROOT"
  /// @access(...READER, update, invite)
  LEAD = "LEAD"
  /// @access(read)
  READER = "READER"
}
enum State {
  ACTIVE = "ACTIVE"
  GONE = "GONE"
}
/// @access(read: id == auth.id)
model User {
  id String @id
  seats Seat[]
}
/// @access(roles: seats[state=ACTIVE].rank)
model Group {
  id String @id
  seats Seat[]
}
model Seat {
  groupId String
  personId String
  rank Rank
  state State
  group Group @relation(fields: [groupId], references: [id])
  person User @relation(fields: [personId], references: [id])
  @@id([groupId, personId])
}
`;

test("a role's holdings are its own list, and what it gets from the role that declares it", () => {
  const parsed = readClientAccess(source);
  assert.deepEqual(parsed.problems, []);
  const holdings = roleHoldings(accessDirectives(source), parsed, "Rank");
  assert.deepEqual(holdings.ROOT, { own: ["delete"], includes: ["LEAD"], inherited: { update: "LEAD", invite: "LEAD", read: "READER" } });
  assert.deepEqual(holdings.READER, { own: ["read"], includes: [], inherited: {} });
  assert.equal(accessDirectiveLine(source.split("\n"), parsed.index.enums.Rank!.values.ROOT!), parsed.index.enums.Rank!.values.ROOT! - 1, "past the doc comment");
});

test("each permission cell edits a single exact list, including the first and last holder", () => {
  const schema = source.replace("enum Rank {", "/// @access(review: [LEAD])\n/// @access(exportNotes: [])\nenum Rank {");
  const parsed = readClientAccess(schema);
  assert.deepEqual(parsed.problems, []);
  const holdings = roleHoldings(accessDirectives(schema), parsed, "Rank");
  assert.ok(holdings.LEAD!.own.includes("review"));
  assert.equal(holdings.ROOT!.inherited.review, undefined);
  const none = toggleRoleHolding(schema, parsed, "Rank", "LEAD", "review");
  assert.equal(none.source, schema.replace("review: [LEAD]", "review: []"));
  const first = toggleRoleHolding(none.source, readClientAccess(none.source), "Rank", "READER", "review");
  assert.equal(first.source, schema.replace("review: [LEAD]", "review: [READER]"));
  assert.deepEqual(readClientAccess(first.source).policy.enums.Rank!.grants, { review: ["READER"], exportNotes: [], invite: ["ROOT", "LEAD"] });
  const action = toggleRoleHolding(schema, parsed, "Rank", "LEAD", "create");
  assert.equal(action.source, schema.replace("...READER, update, invite", "...READER, create, update, invite"));
  const multiline = schema.replace("review: [LEAD]", "review: [\n///  LEAD,\n/// ]");
  assert.equal(toggleRoleHolding(multiline, readClientAccess(multiline), "Rank", "READER", "review").source, schema.replace("review: [LEAD]", "review: [LEAD, READER]"));
});

test("configuration adds, changes and removes trailing rules while preserving source and prose", () => {
  const target = { kind: "field" as const, model: "User", field: "name" };
  const initial = source.replace("  id String @id", "  id String @id\n  name String @map(\"member//name\")  ").replaceAll("\n", "\r\n");
  const proposal = setAccessRule(initial, target, undefined, "readonly");
  assert.equal(proposal.problem, undefined);
  const withRule = initial.replace('String @map("member//name")', 'String @map("member//name") /// @access(readonly)');
  assert.equal(proposal.source, withRule);
  const selected = accessDirectives(withRule).find(({ inline }) => inline)!;
  const changed = setAccessRule(withRule, target, selected, "serverOnly");
  assert.equal(changed.source, withRule.replace("/// @access(readonly)", "/// @access(serverOnly)"));
  assert.equal(setAccessRule(withRule, target, selected, null).source, initial);
  assert.ok(setAccessRule(changed.source, target, selected, null).problem);
  assert.deepEqual(setAccessRule(withRule, target, selected, "readonly)\n/// @access(serverOnly").source, withRule);
  const prose = initial.replace('String @map("member//name")', 'String @map("member//name") // keep this note');
  const stacked = setAccessRule(prose, target, undefined, "readonly");
  assert.equal(stacked.source, prose.replace("  name String", "  /// @access(readonly)\r\n  name String"));
  const added = accessDirectives(stacked.source).find(({ args }) => args === "readonly")!;
  assert.equal(setAccessRule(stacked.source, target, added, null).source, prose);
});

test("the role matrix edits a trailing role rule, preserving its binding, sibling, whitespace and CRLF", () => {
  const schema = source.replace('  /// @access(...LEAD, delete, protected)\n  ROOT = "ROOT"', '  ROOT = "ROOT"   /// @access(...LEAD, delete, protected)  ').replaceAll("\n", "\r\n");
  const parsed = readClientAccess(schema);
  assert.deepEqual(parsed.problems, []);
  const changed = toggleRoleHolding(schema, parsed, "Rank", "ROOT", "delete");
  assert.equal(changed.source, schema.replace("...LEAD, delete, protected", "...LEAD, protected"));
  assert.equal(accessDirectiveLine(schema.split("\n"), parsed.index.enums.Rank!.values.ROOT!), parsed.index.enums.Rank!.values.ROOT);
});

test("toggling edits one role's own directive, keeps its includes and protection, and refuses inherited items", () => {
  const parsed = readClientAccess(source);
  const added = toggleRoleHolding(source, parsed, "Rank", "READER", "invite");
  assert.equal(added.problem, undefined);
  const changed = added.source.split("\n").filter((line, index) => line !== source.split("\n")[index]);
  assert.deepEqual(changed, ["  /// @access(read, invite)"]);
  assert.deepEqual(readClientAccess(added.source).policy.enums.Rank!.grants.invite, ["ROOT", "LEAD", "READER"]);

  const removed = toggleRoleHolding(source, parsed, "Rank", "ROOT", "delete");
  assert.deepEqual(removed.source.split("\n").filter((line, index) => line !== source.split("\n")[index]), ["  /// @access(...LEAD, protected)"]);

  const inherited = toggleRoleHolding(source, parsed, "Rank", "ROOT", "invite");
  assert.equal(inherited.source, source);
  assert.match(inherited.problem!, /ROOT gets invite from LEAD/);

  const invalid = toggleRoleHolding(source, parsed, "Rank", "READER", "read");
  assert.equal(invalid.source, source, "a draft that would not compile is refused");
  assert.match(invalid.problem!, /without read/);
});

test("all 66 fixture permission cells toggle independently and round-trip, including a permission used by commands", () => {
  const schema = accessFixture;
  const parsed = readClientAccess(schema, modules);
  assert.deepEqual(parsed.problems, []);
  const enumeration = "ProjectRole";
  const baseline = parsed.policy.enums[enumeration]!;
  let on = 0, off = 0;
  for (const [permission, roles] of Object.entries(baseline.grants)) {
    for (const role of baseline.values) {
      const wasHeld = roles.includes(role);
      if (wasHeld) on++;
      else off++;
      const edit = toggleRoleHolding(schema, parsed, enumeration, role, permission, modules);
      assert.equal(edit.problem, undefined, `${role} × ${permission}`);
      const changed = readClientAccess(edit.source, modules);
      assert.deepEqual(changed.problems, []);
      const holders = baseline.values.filter(value => value === role ? !wasHeld : roles.includes(value));
      assert.deepEqual(changed.policy.enums[enumeration]!.grants, { ...baseline.grants, [permission]: holders });
      assert.equal(toggleRoleHolding(edit.source, changed, enumeration, role, permission, modules).source, schema);
    }
  }
  assert.deepEqual({ on, off }, { on: 34, off: 32 });

  const command = parsed.graph.commands.saveProjectDraft!;
  const holders = baseline.grants[command.who]!;
  let draft = schema;
  const toggle = (role: string) => {
    const current = readClientAccess(draft, modules);
    const next = toggleRoleHolding(draft, current, enumeration, role, command.who, modules);
    assert.equal(next.problem, undefined);
    draft = next.source;
  };
  holders.forEach(toggle);
  assert.ok(draft.includes(`@access(${command.who}: [])`));
  const empty = readClientAccess(draft, modules);
  assert.deepEqual(empty.problems, []);
  assert.deepEqual(empty.policy.enums[enumeration]!.grants[command.who], []);
  assert.deepEqual(empty.graph.commands.saveProjectDraft, command);
  holders.forEach(toggle);
  assert.equal(draft, schema);
});

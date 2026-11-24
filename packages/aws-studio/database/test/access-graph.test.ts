import assert from "node:assert/strict";
import { test } from "node:test";
import { accessDirectives, fieldAudiences, readClientAccess, renderRolePolicies, type AccessModules, type ClientAccessProblem } from "../client-access.js";
import { command, defineAccessPolicy } from "./access-policy.js";
import { accessGraphFingerprint } from "../access-graph-artifact.js";
import { createAccessRuntime, type AccessRow } from "../access-runtime.js";

/**
 * The Access Graph V1 specification's canonical example (section 4), ported to
 * this repository's Prisma 8 syntax (uuid() keys, String instead of cuid ids),
 * and the expected outcomes of its section 7, evaluated by the same runtime the
 * GraphQL API and the credential brokers use.
 */
const CANONICAL = `
enum WorkspaceRole {
  /// @access(read, create, update, delete)
  OWNER = "OWNER"

  /// @access(read, create, update, delete)
  ADMIN = "ADMIN"

  /// @access(read, create, update)
  EDITOR = "EDITOR"

  /// @access(read, create)
  CONTRIBUTOR = "CONTRIBUTOR"

  /// @access(read)
  VIEWER = "VIEWER"
}

enum MembershipStatus {
  INVITED
  ACTIVE
  SUSPENDED
}

/// @access(read: id == auth.id)
model User {
  id          String            @id @default(uuid())
  email       String            @unique
  name        String?
  memberships WorkspaceMember[]
  bills       Billing[]
}

/// @access(roles: members[status=ACTIVE].role)
model Workspace {
  id      String            @id @default(uuid())
  name    String
  members WorkspaceMember[]
  cases   Case[]
}

model WorkspaceMember {
  workspaceId String
  userId      String
  role        WorkspaceRole
  status      MembershipStatus @default(INVITED)

  workspace Workspace @relation(fields: [workspaceId], references: [id])
  user      User      @relation(fields: [userId], references: [id])

  @@id([workspaceId, userId])
}

/// @access(from: workspace)
model Case {
  id          String     @id @default(uuid())
  workspaceId String
  title       String

  workspace Workspace  @relation(fields: [workspaceId], references: [id])
  documents Document[]
}

/// @access(from: case)
model Document {
  id       String @id @default(uuid())
  caseId   String
  title    String
  content  String

  /// @access(readonly)
  publishedAt DateTime?

  /// @access(serverOnly)
  internalNotes String?

  case Case @relation(fields: [caseId], references: [id])
}

/// @access(read: userId == auth.id)
model Billing {
  id     String  @id @default(uuid())
  userId String
  amount Decimal @db.Decimal(12, 2)
  status String

  user User @relation(fields: [userId], references: [id])
}
`;

/** Section 5.4: a nested group is a scope of its own. */
const GROUPS = `
/// @access(read)
enum GroupRole {
  /// @access(read, create, update, delete)
  LEAD = "LEAD"
  /// @access(read)
  MEMBER = "MEMBER"
}

/// @access(roles: members[status=ACTIVE].role)
model Group {
  id          String        @id @default(uuid())
  workspaceId String
  members     GroupMember[]
  documents   GroupDocument[]
}

model GroupMember {
  groupId String
  userId  String
  role    GroupRole
  status  MembershipStatus

  group Group @relation(fields: [groupId], references: [id])
  user  User  @relation(fields: [userId], references: [id])

  @@id([groupId, userId])
}

/// @access(from: group)
model GroupDocument {
  id      String @id @default(uuid())
  groupId String
  title   String

  group Group @relation(fields: [groupId], references: [id])
}
`.replace("/// @access(read)\nenum GroupRole", "enum GroupRole");

const compile = (source: string, modules?: AccessModules) => readClientAccess(source, modules);
const codes = (problems: readonly ClientAccessProblem[]) => problems.map((problem) => problem.code ?? "legacy");

type Store = Record<string, AccessRow[]>;
function runtimeOf(source: string, store: Store, modules?: AccessModules) {
  const { policy, rows, settings, problems } = compile(source, modules);
  assert.deepEqual(problems, [], "the fixture compiles");
  return createAccessRuntime(policy, rows, settings, {
    find: async (model, where) => (store[model] ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
  });
}

const U42 = { id: "U42" };
function world(): Store {
  return {
    User: [{ id: "U42", email: "u42@example.com" }, { id: "U77", email: "u77@example.com" }],
    Billing: [{ id: "B1", userId: "U42", amount: "10.00", status: "PAID" }, { id: "B2", userId: "U77", amount: "20.00", status: "PAID" }],
    Workspace: [{ id: "W1", name: "One" }, { id: "W2", name: "Two" }],
    WorkspaceMember: [],
    Case: [{ id: "C1", workspaceId: "W1", title: "First" }, { id: "C2", workspaceId: "W2", title: "Second" }],
    Document: [{ id: "D1", caseId: "C1", title: "Doc", content: "…", publishedAt: null, internalNotes: "secret" }],
  };
}
const member = (store: Store, workspaceId: string, role: string, status = "ACTIVE") => {
  store.WorkspaceMember!.push({ workspaceId, userId: "U42", role, status });
  return store;
};
const row = (store: Store, model: string, id: string) => store[model]!.find((candidate) => candidate.id === id)!;


// ─── Compilation ─────────────────────────────────────────────────────────────

test("the canonical schema compiles to the specification's five-tier matrix and graph", () => {
  const { graph, problems, rows } = compile(CANONICAL);
  assert.deepEqual(problems, []);
  assert.deepEqual(graph.enums.WorkspaceRole!.masks, {
    OWNER: ["read", "create", "update", "delete"],
    ADMIN: ["read", "create", "update", "delete"],
    EDITOR: ["read", "create", "update"],
    CONTRIBUTOR: ["read", "create"],
    VIEWER: ["read"],
  });
  const kase = graph.models.Case!;
  assert.deepEqual(kase.path, ["Case", "Workspace"]);
  assert.equal(kase.scope, "Workspace");
  assert.deepEqual(kase.actions, {
    read: ["OWNER", "ADMIN", "EDITOR", "CONTRIBUTOR", "VIEWER"],
    create: ["OWNER", "ADMIN", "EDITOR", "CONTRIBUTOR"],
    update: ["OWNER", "ADMIN", "EDITOR"],
    delete: ["OWNER", "ADMIN"],
  });
  assert.deepEqual(graph.models.Document!.path, ["Document", "Case", "Workspace"]);
  assert.deepEqual(graph.models.Document!.fields, { publishedAt: "readonly", internalNotes: "serverOnly" });
  assert.deepEqual(graph.models.Workspace!.roles, { relation: "members", membership: "WorkspaceMember", principal: "user", filter: { status: "ACTIVE" }, field: "role", enumeration: "WorkspaceRole" });
  assert.deepEqual(graph.models.Billing!.identity, ["userId"]);
  assert.equal(graph.principal, "User");
  // WorkspaceMember resolves roles but is not in the client API.
  assert.equal(rows.models.WorkspaceMember, undefined);
  assert.deepEqual(rows.principals, { WorkspaceMember: { relation: "user", fields: ["userId"] } });
});

test("trailing field and enum-value directives bind to their own declaration alongside stacked rules", () => {
  const stacked = CANONICAL.replace("  name        String?", "  /// @access(read: isMe(id))\n  /// @access(readonly)\n  name        String?");
  assert.notEqual(stacked, CANONICAL);
  const inline = stacked.replace("  /// @access(readonly)\n  name        String?", "  name        String? @map(\"display//name\")   /// @access(readonly)")
    .replace('  /// @access(read, create, update, delete)\n  OWNER = "OWNER"', '  OWNER = "OWNER" /// @access(read,\n  /// create, update, delete)')
    .replace("  /// @access(serverOnly)\n  internalNotes String?", "  internalNotes String? /// @access(serverOnly)").replaceAll("\n", "\r\n");
  const before = compile(stacked), after = compile(inline);
  assert.deepEqual(before.problems, []);
  assert.deepEqual(after.problems, []);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.policy, before.policy);
  assert.equal(accessGraphFingerprint(after.graph), accessGraphFingerprint(before.graph));
  const directives = accessDirectives(inline);
  const byField = directives.filter(({ target }) => target.kind === "field" && target.model === "User" && target.field === "name");
  assert.deepEqual(byField.map((entry) => [entry.args, !!entry.inline]), [["read: isMe(id)", false], ["readonly", true]]);
  for (const entry of directives.filter(({ inline }) => inline)) {
    assert.equal(inline.slice(entry.commentFrom, entry.from), "/// ");
    assert.equal(inline[entry.to - 1], ")");
    assert.equal(inline[entry.offsets[0]!], entry.args[0]);
  }
  const misplaced = (fragment: string) => compile(CANONICAL.replace(fragment, fragment + " /// @access(readonly)")).problems;
  for (const line of ["enum WorkspaceRole {", "model Workspace {", "@@id([workspaceId, userId])", "}"]) {
    assert.ok(misplaced(line).some(({ code }) => code === "AG-PLACEMENT"), line);
  }
});

test("a role includes the role below it: ...LOWER resolves to the same masks and abilities as listing them", () => {
  const ladder = CANONICAL
    .replace("/// @access(read, create, update, delete)\n  OWNER", "/// @access(...ADMIN, protected)\n  OWNER")
    .replace("/// @access(read, create, update, delete)\n  ADMIN", "/// @access(...EDITOR, delete, inviteMembers)\n  ADMIN")
    .replace("/// @access(read, create, update)\n  EDITOR", "/// @access(...CONTRIBUTOR, update)\n  EDITOR")
    .replace("/// @access(read, create)\n  CONTRIBUTOR", "/// @access(...VIEWER, create)\n  CONTRIBUTOR");
  const flat = CANONICAL
    .replace("/// @access(read, create, update, delete)\n  OWNER", "/// @access(read, create, update, delete, inviteMembers, protected)\n  OWNER")
    .replace("/// @access(read, create, update, delete)\n  ADMIN", "/// @access(read, create, update, delete, inviteMembers)\n  ADMIN");
  const fromLadder = compile(ladder);
  assert.deepEqual(fromLadder.problems, []);
  assert.deepEqual(fromLadder.graph.enums.WorkspaceRole!.masks, compile(CANONICAL).graph.enums.WorkspaceRole!.masks);
  assert.deepEqual(fromLadder.policy.enums.WorkspaceRole!.grants, { inviteMembers: ["OWNER", "ADMIN"] });
  assert.deepEqual(fromLadder.policy.enums.WorkspaceRole!.assignable, ["ADMIN", "EDITOR", "CONTRIBUTOR", "VIEWER"]);
  assert.deepEqual(fromLadder.graph.enums.WorkspaceRole!.includes!.OWNER, ["ADMIN"]);
  const fromList = compile(flat);
  assert.deepEqual(fromList.problems, []);
  assert.deepEqual(fromLadder.policy, fromList.policy, "the ladder is notation: the policy is the same");

  const problem = (from: string, to: string) => codes(compile(ladder.replace(from, to)).problems);
  assert.ok(problem("...VIEWER, create", "...NOBODY, create").includes("AG-ROLE-INCLUDE"));
  assert.ok(problem("...VIEWER, create", "VIEWER, create").includes("AG-ROLE-INCLUDE"), "a role is included with ...");
  assert.ok(problem("/// @access(read)\n  VIEWER", "/// @access(...OWNER)\n  VIEWER").includes("AG-CYCLE"));
  assert.ok(problem("delete, inviteMembers", "delete, Invite").includes("AG-ACTION"));
  assert.ok(problem("delete, inviteMembers", "delete, delete").includes("AG-DUPLICATE"));
});

test("permission rows have exact group-scoped holders and retain an ungranted permission in every export", async () => {
  const source = CANONICAL
    .replace("enum WorkspaceRole", "/// @access(editNotes: [VIEWER, ADMIN])\n/// @access(publishNotes: [])\nenum WorkspaceRole")
    .replace("/// @access(read, create, update, delete)\n  OWNER", "/// @access(...ADMIN, protected)\n  OWNER")
    .replace("/// @access(read, create)\n  CONTRIBUTOR", "CONTRIBUTOR");
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  const enumeration = parsed.graph.enums.WorkspaceRole!;
  assert.deepEqual(enumeration.permissions, { editNotes: ["ADMIN", "VIEWER"], publishNotes: [] });
  assert.deepEqual(enumeration.unassignable, ["OWNER"]);
  assert.deepEqual(enumeration.masks.CONTRIBUTOR, []);
  assert.deepEqual(parsed.policy.enums.WorkspaceRole!.grants, enumeration.permissions);
  assert.match(renderRolePolicies(parsed.policy), /"publishNotes": \[\]/);
  const fingerprint = accessGraphFingerprint(parsed.graph);
  assert.equal(fingerprint, accessGraphFingerprint(compile(source.replace("[VIEWER, ADMIN]", "[ADMIN, VIEWER]")).graph));
  assert.notEqual(fingerprint, accessGraphFingerprint(compile(source.replace("/// @access(publishNotes: [])\n", "")).graph));
  const store = member(member(world(), "W1", "ADMIN"), "W2", "OWNER");
  const access = runtimeOf(source, store);
  assert.equal(await access.can("Case", row(store, "Case", "C1"), U42, "editNotes"), true);
  assert.equal(await access.can("Case", row(store, "Case", "C2"), U42, "editNotes"), false, "a role spread cannot add a holder to an exact list");
  assert.equal(await access.can("Case", row(store, "Case", "C1"), U42, "publishNotes"), false);
  assert.deepEqual((await access.permissions("Workspace", row(store, "Workspace", "W1"), U42)).can, { editNotes: true, publishNotes: false });
});

test("a permission matrix can start empty and compile without any value directives", () => {
  const source = "/// @access(editNotes: [])\nenum ClubRole {\n  OWNER\n  READER\n}";
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.graph.enums.ClubRole!.masks, { OWNER: [], READER: [] });
  assert.deepEqual(parsed.policy.enums.ClubRole!.grants, { editNotes: [] });
});

test("action rows above a role enum name exact holders and compile to the same policy as value grants", () => {
  const values = [
    ["/// @access(read, create, update, delete)\n  OWNER", "OWNER"],
    ["/// @access(read, create, update, delete)\n  ADMIN", "ADMIN"],
    ["/// @access(read, create, update)\n  EDITOR", "EDITOR"],
    ["/// @access(read, create)\n  CONTRIBUTOR", "CONTRIBUTOR"],
    ["/// @access(read)\n  VIEWER", "VIEWER"],
  ] as const;
  const rows = values.reduce((source, [from, to]) => source.replace(from, to), CANONICAL).replace("enum WorkspaceRole {", [
    "/// @access(read: [OWNER, ADMIN, EDITOR, CONTRIBUTOR, VIEWER])",
    "/// @access(create: [OWNER, ADMIN, EDITOR, CONTRIBUTOR])",
    "/// @access(update: [OWNER, ADMIN, EDITOR])",
    "/// @access(delete: [OWNER, ADMIN])",
    "enum WorkspaceRole {",
  ].join("\n"));
  const parsed = compile(rows), reference = compile(CANONICAL);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.graph.enums.WorkspaceRole!.masks, reference.graph.enums.WorkspaceRole!.masks);
  assert.deepEqual(parsed.graph.enums.WorkspaceRole!.permissions, {}, "an action row is a mask, not a named ability");
  assert.deepEqual(parsed.policy, reference.policy, "rows are notation: the policy is the same");
  assert.equal(accessGraphFingerprint(parsed.graph), accessGraphFingerprint(reference.graph));

  // A role that includes another never gains a holder through an exact row.
  const included = compile(rows.replace("[OWNER, ADMIN, EDITOR, CONTRIBUTOR, VIEWER]", "[OWNER, ADMIN, EDITOR, CONTRIBUTOR]").replace("\n  VIEWER", "\n  /// @access(...CONTRIBUTOR)\n  VIEWER"));
  assert.deepEqual(included.problems, []);
  assert.deepEqual(included.graph.enums.WorkspaceRole!.masks.VIEWER, []);

  // A write without read points at the row that granted it.
  const unread = rows.replace("read: [OWNER, ", "read: [");
  const problem = compile(unread).problems.find(({ code }) => code === "AG-MASK-READ");
  assert.ok(problem, "OWNER may create without read");
  assert.match(unread.split("\n")[problem.line - 1]!, /^\/\/\/ @access\(create:/);

  // An action declared both ways is ambiguous, at the role's own token.
  const mixed = rows.replace("\n  VIEWER", "\n  /// @access(read)\n  VIEWER");
  const twice = compile(mixed).problems.find(({ code }) => code === "AG-MIXED");
  assert.ok(twice?.column);
  assert.ok(mixed.split("\n")[twice.line - 1]!.slice(twice.column - 1).startsWith("read)"));
  assert.ok(codes(compile(rows.replace("/// @access(delete: [OWNER, ADMIN])", "/// @access(delete: [OWNER])\n/// @access(delete: [ADMIN])")).problems).includes("AG-DUPLICATE"));
});

test("ambiguous permission declarations and unknown roles are diagnosed at the offending token", () => {
  const cases = [
    ["editNotes: [EDITOR, NOBODY]", "AG-ROLE", "NOBODY"],
    ["editNotes: [EDITOR, EDITOR]", "AG-DUPLICATE", "EDITOR"],
    ["editNotes: [])\n/// @access(editNotes: [OWNER]", "AG-DUPLICATE", "editNotes"],
    // The values already hold read, so a read row would declare its holders twice.
    ["read: [OWNER]", "AG-MIXED", "read"],
    ["member: []", "AG-ACTION", "member"],
    ["Invite: []", "AG-ACTION", "Invite"],
    ["OWNER: []", "AG-ACTION", "OWNER"],
  ] as const;
  for (const [directive, code, token] of cases) {
    const source = CANONICAL.replace("enum WorkspaceRole", `/// @access(${directive})\nenum WorkspaceRole`);
    const problem = compile(source).problems.find((problem) => problem.code === code);
    assert.ok(problem?.column, directive);
    assert.ok(source.split("\n")[problem.line - 1]!.slice(problem.column - 1).startsWith(token), directive);
  }
  const mixed = CANONICAL
    .replace("enum WorkspaceRole", "/// @access(editNotes: [])\nenum WorkspaceRole")
    .replace("/// @access(read)\n  VIEWER", "/// @access(read, editNotes)\n  VIEWER");
  assert.ok(codes(compile(mixed).problems).includes("AG-MIXED"));
});

test("a shared profile: the owner reads every column, others only the columns their rule lists", async () => {
  const source = CANONICAL
    .replace("/// @access(read: id == auth.id)\nmodel User {", "/// @access(read, update: id == auth.id)\n/// @access(read(id, email, name): authenticated)\nmodel User {")
    .replace("  name        String?", `  name        String?
  /// @access(readonly)
  subscription String?
  contact String?
  /// @access(serverOnly)
  paymentToken String?`);
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  // Every signed-in user sees the row, so they are among the default readers; the owner's columns say so.
  assert.deepEqual(parsed.policy.models.User!.read, [{ who: ["authenticated"] }, { who: ["owner"] }]);
  assert.equal(parsed.policy.models.User!.fields.name!.read, undefined, "listed columns follow the defaults");
  assert.deepEqual(parsed.policy.models.User!.fields.contact!.read, [{ who: ["owner"] }], "unlisted columns are the owner's");
  const access = runtimeOf(source, world());
  const self = { id: "U42" };
  const peer = { id: "U77" };
  assert.equal(await access.visible("User", peer, U42), true);
  assert.equal(await access.readable("User", "name", peer, U42), true);
  assert.equal(await access.readable("User", "subscription", peer, U42), false);
  assert.equal(await access.readable("User", "contact", peer, U42), false);
  assert.equal(await access.readable("User", "subscription", self, U42), true);
  assert.equal(await access.readable("User", "paymentToken", self, U42), false);
  assert.equal((await access.permissions("User", peer, U42)).fields.subscription?.readable, false);
  assert.equal((await access.authorize("User", "update", self, U42, { subscription: "paid" })).allowed, false);
  assert.equal((await access.authorize("User", "update", self, U42, { contact: "self@example.test" })).allowed, true);
  assert.equal((await access.authorize("User", "update", peer, U42, { contact: "x" })).allowed, false);
  const audiences = fieldAudiences(parsed.settings, parsed.rows, parsed.policy).User!;
  assert.ok(audiences.read.owner.includes("subscription"));
  assert.ok(!audiences.read.anyone.includes("subscription"));
  assert.ok(!audiences.read.owner.includes("paymentToken"));
  // Without the wider rule, other people see no row at all.
  const own = runtimeOf(source.replace("/// @access(read(id, email, name): authenticated)\n", ""), world());
  assert.equal(await own.visible("User", peer, U42), false);
  assert.notEqual(accessGraphFingerprint(parsed.graph), accessGraphFingerprint(compile(source.replace("read(id, email, name)", "read(id, name)")).graph));
});

test("an explicit field condition governs reads and literal projections when the model also lists read columns", async () => {
  const source = `
/// @access(read: isMe(id))
/// @access(read(id, name): authenticated)
model User {
  id String @id
  name String
  active Boolean
  /// @access(read: isMe(id) && active == true)
  privateEmail String
}`;
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.policy.models.User!.fields.privateEmail!.read, [{ who: ["owner"], where: { active: true } }]);
  const engine = runtimeOf(source, {});
  for (const active of [true, false]) {
    assert.equal(await engine.readable("User", "privateEmail", { ...U42, active }, U42), active);
  }
  const fields = fieldAudiences(parsed.settings, parsed.rows, parsed.policy).User!.read;
  assert.ok(!fields.owner.includes("privateEmail"));
  assert.ok(!fields.anyone.includes("privateEmail"));
});

test("a projection shared by all row readers omits a grant with an owner exception", () => {
  const source = `model Person {
  id String @id
  notes Note[]
}
model Note {
  id String @id
  ownerId String
  text String // @access read(anyone, !owner)
  owner Person @relation(fields: [ownerId], references: [id]) // @access owner
}`;
  const parsed = readClientAccess(source, undefined, { legacy: true });
  assert.deepEqual(parsed.problems, []);
  const projected = fieldAudiences(parsed.settings, parsed.rows, parsed.policy).Note!.read;
  assert.ok(!projected.anyone.includes("text"));
  assert.ok(!projected.owner.includes("text"));
});

test("isMe and an explicit membership selector resolve to the same principal and policy as explicit comparisons", async () => {
  const source = CANONICAL.replaceAll(/(\w+) == auth\.id/g, "isMe($1)")
    .replace("roles: members[status=ACTIVE]", "role: members[isMe(userId) && status == ACTIVE]");
  const previous = compile(CANONICAL);
  const next = compile(source);
  assert.deepEqual(next.problems, []);
  assert.deepEqual(next.policy, previous.policy);
  assert.deepEqual(next.rows, previous.rows);
  assert.equal(accessGraphFingerprint(next.graph), accessGraphFingerprint(previous.graph));

  const renamed = source.replaceAll(/\bUser\b/g, "Person")
    .replace("isMe(id)", "isMe(personKey)").replace("id          String            @id", "personKey   String            @id")
    .replaceAll(/(Person\s+@relation\(fields: \[userId\], references: \[)id/g, "$1personKey");
  const store = world();
  const access = runtimeOf(renamed, store, defineAccessPolicy({ principal: "Person" }));
  const bill = row(store, "Billing", "B1");
  assert.equal(await access.visible("Billing", bill, { personKey: "U42" }), true);
  assert.equal(await access.visible("Billing", bill, { id: "U42" }), false);
  assert.equal(await access.visible("Billing", { ...bill, userId: null }, {}), false);
  for (const invalid of ["amount", "email", "user", "unknown"]) {
    assert.ok(codes(compile(source.replace("read: isMe(userId)", `read: isMe(${invalid})`)).problems).includes("AG-READ-FIELD"));
  }
  assert.ok(codes(compile(source.replace("userId String\n  amount", "userId Int\n  amount")).problems).includes("AG-READ-FIELD"));
});

test("only the selected membership principal receives the group's role, even when someone else can read the membership", async () => {
  const source = CANONICAL
    .replace("roles: members[status=ACTIVE]", "roles: members[status == ACTIVE && isMe(userId)]")
    .replace("model WorkspaceMember {", "/// @access(read: isMe(inviterId))\nmodel WorkspaceMember {\n  inviterId String?\n  inviter User? @relation(\"Inviter\", fields: [inviterId], references: [id])")
    .replace("memberships WorkspaceMember[]", "memberships WorkspaceMember[] @relation(\"Seat\")\n  invitations WorkspaceMember[] @relation(\"Inviter\")")
    .replace("user      User      @relation(", "user      User      @relation(\"Seat\", ");
  const store = world();
  const membership = { workspaceId: "W1", userId: "U42", inviterId: "U77", role: "ADMIN", status: "ACTIVE" };
  store.WorkspaceMember = [membership];
  const access = runtimeOf(source, store);
  const inviter = { id: "U77" };
  assert.equal(await access.visible("WorkspaceMember", membership, inviter), true);
  assert.equal(await access.visible("WorkspaceMember", membership, U42), false);
  assert.equal(await access.visible("Workspace", row(store, "Workspace", "W1"), U42), true);
  assert.equal(await access.visible("Workspace", row(store, "Workspace", "W1"), inviter), false);
  assert.equal((await access.authorize("Case", "update", row(store, "Case", "C1"), inviter, { title: "x" })).allowed, false);
  assert.ok(codes(compile(source.replace(" && isMe(userId)", "")).problems).includes("AG-ROLES-PRINCIPAL"));
  assert.ok(codes(compile(source.replace(" && isMe(userId)", " && isMe(workspaceId)")).problems).includes("AG-ROLES-PRINCIPAL"));
  assert.ok(codes(compile(source.replace(" && isMe(userId)", " && isMe(inviterId)")).problems).includes("AG-ROLES-UNIQUE"));
});

test("a field can narrow a role-scoped row to a verified principal reference without opening the row", async () => {
  const source = CANONICAL.replace("  name    String\n  members", `  /// @access(read: isMe(stewardId))
  name    String
  stewardId String?
  steward User? @relation(fields: [stewardId], references: [id])
  members`);
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  const store = member(world(), "W1", "VIEWER");
  const access = runtimeOf(source, store);
  assert.equal(await access.readable("Workspace", "name", { id: "W1", stewardId: "U42" }, U42), true);
  assert.equal(await access.readable("Workspace", "name", { id: "W1", stewardId: "U77" }, U42), false);
  assert.equal(await access.readable("Workspace", "name", { id: "W2", stewardId: "U42" }, U42), false);
  const audience = fieldAudiences(parsed.settings, parsed.rows, parsed.policy).Workspace!;
  assert.ok(!audience.read.anyone.includes("name"));
  assert.ok(!audience.read.owner.includes("name"));
});

test("grouped field rules compile like the same rules written above each field", () => {
  const expanded = CANONICAL
    .replace("/// @access(read: id == auth.id)", "/// @access(read, update: id == auth.id)\n/// @access(read(id, name): authenticated)")
    .replace("  name        String?", `  name        String?
  /// @access(read: id == auth.id, readonly)
  plan String?
  /// @access(read: id == auth.id, readonly)
  status String?`)
    .replace("  internalNotes String?", "  internalNotes String?\n  /// @access(serverOnly)\n  internalLabel String?");
  const grouped = expanded
    .replace("model User {", `/// @access(fields(
///   plan,
///   status,
/// ), read: id == auth.id, readonly)
model User {`)
    .replaceAll("  /// @access(read: id == auth.id, readonly)\n", "")
    .replace("model Document {", "/// @access(fields(internalNotes, internalLabel), serverOnly)\nmodel Document {")
    .replaceAll("  /// @access(serverOnly)\n", "");
  const before = compile(expanded);
  const after = compile(grouped);
  assert.deepEqual(before.problems, []);
  assert.deepEqual(after.problems, []);
  assert.deepEqual(after.policy, before.policy);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.settings, before.settings);
  assert.equal(accessGraphFingerprint(after.graph), accessGraphFingerprint(before.graph));
  assert.deepEqual(after.policy.models.User!.fields.plan!.read, [{ who: ["owner"] }]);
  assert.equal(after.settings.User!.plan, "read-only");
  assert.equal(after.settings.Document!.internalNotes, "server-only");
});

test("grouped fields are checked against their model, with diagnostics at the selected tokens", () => {
  const source = CANONICAL.replace("model Document {", `/// @access(fields(internalNotes,
///   missing, case), serverOnly)
model Document {`);
  const line = source.split("\n").findIndex((text) => text.includes("missing, case")) + 1;
  const problems = compile(source).problems;
  assert.deepEqual(problems.map(({ code, line, column }) => ({ code, line, column })), [
    { code: "AG-COLUMN", line, column: 7 }, { code: "AG-COLUMN", line, column: 16 },
  ]);

  const wrongAction = CANONICAL.replace("model Document {", "/// @access(fields(publishedAt, internalNotes), write: id == auth.id)\nmodel Document {");
  assert.ok(codes(compile(wrongAction).problems).includes("AG-SCOPE-FIELD"));
  const conflicting = CANONICAL.replace("model Document {", "/// @access(fields(title, publishedAt), serverOnly)\nmodel Document {");
  assert.ok(codes(compile(conflicting).problems).includes("AG-FIELD-RULE"));
});

test("conflicting, unbound and invalid scalar directives fail compilation", () => {
  for (const [directive, code] of [
    ["read: title == auth.id", "AG-READ-FIELD"],
    ["read: id == token.id", "AG-READ-EXPRESSION"],
    ["serverOnly, read: id == auth.id", "AG-FIELD-RULE"],
    ["readonly, serverOnly", "AG-FIELD-RULE"],
    ["readonly, typo", "AG-FIELD-RULE"],
    ["write: id == auth.id", "AG-SCOPE-FIELD"],
    ["DRAFT -> OPEN: member", "AG-SCOPE-FIELD"],
  ]) {
    const parsed = compile(CANONICAL.replace("/// @access(readonly)\n  publishedAt", `/// @access(${directive})\n  publishedAt`));
    assert.ok(codes(parsed.problems).includes(code!), `${directive}: ${JSON.stringify(parsed.problems)}`);
  }
  const mixed = CANONICAL.replace("/// @access(read: id == auth.id)\nmodel User {", "model User {\n  // @access read(owner)")
    .replace("  name        String?", "  /// @access(readonly)\n  name        String? // @access write(owner)");
  assert.ok(codes(compile(mixed).problems).includes("AG-LEGACY"), "the retired comment form is refused, never mixed in");
  const steward = CANONICAL.replace("  name    String\n  members", "  /// @access(read: stewardId == auth.id)\n  /// @access(read: stewardId == auth.id)\n  name    String\n  stewardId String?\n  steward User? @relation(fields: [stewardId], references: [id])\n  members");
  assert.ok(codes(compile(steward).problems).includes("AG-DUPLICATE"), "one read expression per field");
  const unbound = CANONICAL + "\nmodel Orphan {\n  id String @id\n  /// @access(readonly)\n  label String\n}\n";
  assert.ok(codes(compile(unbound).problems).includes("AG-FIELD-MODEL"));
});

test("compilation is deterministic and the fingerprint ignores where and how directives are written", () => {
  const first = compile(CANONICAL);
  assert.deepEqual(compile(CANONICAL), first);
  const shifted = compile(`\n\n// A comment that moves every line.\n${CANONICAL}`);
  assert.notDeepEqual(shifted.graph.provenance, first.graph.provenance);
  assert.equal(accessGraphFingerprint(shifted.graph), accessGraphFingerprint(first.graph));
  const widened = compile(CANONICAL.replace("/// @access(read)\n  VIEWER", "/// @access(read, create)\n  VIEWER"));
  assert.notEqual(accessGraphFingerprint(widened.graph), accessGraphFingerprint(first.graph));
  const rules = `${CANONICAL}\n/// @access(read, create: ownerId == auth.id)\nmodel Note {\n  id String @id\n  ownerId String\n  owner User @relation("Notes", fields: [ownerId], references: [id])\n}\n`.replace("bills       Billing[]", "bills       Billing[]\n  notes       Note[] @relation(\"Notes\")");
  const reflowed = rules.replace("/// @access(read, create: ownerId == auth.id)", "/// @access(read,\n///   create:   ownerId==auth.id)");
  assert.deepEqual(compile(rules).problems, []);
  assert.equal(accessGraphFingerprint(compile(reflowed).graph), accessGraphFingerprint(compile(rules).graph), "reflowing a rule changes nothing");
  assert.notEqual(accessGraphFingerprint(compile(rules.replace("read, create:", "read:")).graph), accessGraphFingerprint(compile(rules).graph), "changing a rule does");
});

// ─── Section 7: normative outcomes ───────────────────────────────────────────

test("section 7: identity reads and owner-only billing", async () => {
  const store = world();
  const access = runtimeOf(CANONICAL, store);
  assert.equal(await access.visible("Billing", row(store, "Billing", "B1"), U42), true, "U42 reads their own bill");
  assert.equal(await access.visible("Billing", row(store, "Billing", "B2"), U42), false, "U42 cannot read U77's bill");
  assert.equal((await access.authorize("Billing", "update", row(store, "Billing", "B1"), U42, { status: "VOID" })).allowed, false, "read does not imply write");
  assert.equal(await access.visible("User", row(store, "User", "U42"), U42), true);
  assert.equal(await access.visible("User", row(store, "User", "U77"), U42), false);
});

test("section 7: role-scoped CRUD through the declared parent chain", async () => {
  const editor = member(world(), "W1", "EDITOR");
  let access = runtimeOf(CANONICAL, editor);
  assert.equal((await access.authorize("Case", "update", row(editor, "Case", "C1"), U42, { title: "Renamed" })).allowed, true, "EDITOR updates W1's case");

  const viewer = member(world(), "W1", "VIEWER");
  access = runtimeOf(CANONICAL, viewer);
  assert.equal(await access.visible("Document", row(viewer, "Document", "D1"), U42), true);
  const denied = await access.authorize("Document", "update", row(viewer, "Document", "D1"), U42, { title: "x" });
  assert.equal(denied.allowed, false, "VIEWER holds read only");
  assert.equal(denied.reason, "who");

  const admin = member(world(), "W1", "ADMIN");
  access = runtimeOf(CANONICAL, admin);
  assert.equal((await access.authorize("Case", "update", row(admin, "Case", "C2"), U42, { title: "x" })).reason, "missing", "ADMIN in W1 has nothing in W2");

  const suspended = member(world(), "W1", "ADMIN", "SUSPENDED");
  access = runtimeOf(CANONICAL, suspended);
  assert.equal(await access.visible("Case", row(suspended, "Case", "C1"), U42), false, "a SUSPENDED membership grants nothing");

  const contributor = member(world(), "W1", "CONTRIBUTOR");
  access = runtimeOf(CANONICAL, contributor);
  const created = await access.authorize("Document", "create", { caseId: "C1" }, U42, { caseId: "C1", title: "New", content: "…" });
  assert.equal(created.allowed, true, "CONTRIBUTOR creates under a readable case");
  assert.equal((await access.authorize("Document", "create", { caseId: "C2" }, U42, { caseId: "C2", title: "New", content: "…" })).reason, "missing", "never under another workspace's case");
  assert.equal((await access.authorize("Document", "update", row(contributor, "Document", "D1"), U42, { title: "x" })).allowed, false, "CONTRIBUTOR cannot update");
});

test("section 7: links never move, protected fields stay protected, memberships are not in the API", async () => {
  const store = member(world(), "W1", "OWNER");
  store.Case!.push({ id: "C3", workspaceId: "W1", title: "Third" });
  const access = runtimeOf(CANONICAL, store);
  const document = row(store, "Document", "D1");
  const moved = await access.authorize("Document", "update", document, U42, { caseId: "C3" });
  assert.equal(moved.reason, "link", "caseId is immutable after creation");
  assert.equal((await access.authorize("Document", "update", document, U42, { publishedAt: "2026-01-01T00:00:00Z" })).reason, "field", "readonly");
  assert.equal((await access.authorize("Document", "update", document, U42, { internalNotes: "x" })).reason, "field", "serverOnly");
  assert.equal(await access.readable("Document", "internalNotes", document, U42), false);
  assert.equal(await access.readable("Document", "publishedAt", document, U42), true);
  assert.equal(await access.visible("WorkspaceMember", store.WorkspaceMember![0]!, U42), false, "WorkspaceMember has no client policy");
  assert.equal((await access.authorize("WorkspaceMember", "update", store.WorkspaceMember![0]!, U42, { role: "VIEWER" })).allowed, false);
});

test("section 5.4 and 7: a nested group is an independent scope", async () => {
  const source = CANONICAL + GROUPS;
  const store: Store = { ...member(world(), "W1", "ADMIN"), Group: [{ id: "G1", workspaceId: "W1" }], GroupMember: [], GroupDocument: [{ id: "GD1", groupId: "G1", title: "Plan" }] };
  const access = runtimeOf(source, store);
  assert.equal(await access.visible("GroupDocument", row(store, "GroupDocument", "GD1"), U42), false, "a Workspace ADMIN gains nothing in the group");
  store.GroupMember!.push({ groupId: "G1", userId: "U42", role: "MEMBER", status: "ACTIVE" });
  assert.equal(await access.visible("GroupDocument", row(store, "GroupDocument", "GD1"), U42), true);
  assert.equal((await access.authorize("GroupDocument", "update", row(store, "GroupDocument", "GD1"), U42, { title: "x" })).allowed, false, "the group role decides");
});

// ─── Section 6.4: fail-closed compilation ────────────────────────────────────

test("section 6.4: every invalid policy fails with a code at its line and column", () => {
  const cases: [string, string, (source: string) => string][] = [
    ["two slashes", "AG-SLASHES", (source) => source.replace("/// @access(from: case)", "// @access(from: case)")],
    ["stray directive", "AG-STRAY", (source) => `${source}\n/// @access(read)\n`],
    ["unknown key", "AG-KEY", (source) => source.replace("from: case)", "from: case, write: owner)")],
    ["two bases", "AG-BASE", (source) => source.replace("/// @access(from: case)", "/// @access(from: case, read: id == auth.id)")],
    ["unknown action", "AG-ACTION", (source) => source.replace("/// @access(read)\n  VIEWER", "/// @access(read, Manage)\n  VIEWER")],
    ["action without read", "AG-MASK-READ", (source) => source.replace("/// @access(read)\n  VIEWER", "/// @access(create)\n  VIEWER")],
    ["unannotated role", "AG-ROLE-UNANNOTATED", (source) => source.replace("  /// @access(read)\n  VIEWER", "  VIEWER")],
    ["missing role relation", "AG-ROLES-RELATION", (source) => source.replace("roles: members[", "roles: seats[")],
    ["non-enum role field", "AG-ROLES-FIELD", (source) => source.replace("].role)", "].userId)")],
    ["unknown status value", "AG-ROLES-FILTER", (source) => source.replace("[status=ACTIVE]", "[status=LIVE]")],
    ["ambiguous user", "AG-ROLES-PRINCIPAL", (source) => source.replace("  @@id([workspaceId, userId])", "  inviterId String\n  inviter User @relation(\"Inviter\", fields: [inviterId], references: [id])\n  @@id([workspaceId, userId])").replace("memberships WorkspaceMember[]", "memberships WorkspaceMember[]\n  invited WorkspaceMember[] @relation(\"Inviter\")")],
    ["membership not unique", "AG-ROLES-UNIQUE", (source) => source.replace("  @@id([workspaceId, userId])", "  id String @id")],
    ["from a scalar", "AG-FROM-RELATION", (source) => source.replace("/// @access(from: case)", "/// @access(from: caseId)")],
    ["from a list", "AG-FROM-RELATION", (source) => source.replace("/// @access(from: workspace)\nmodel Case", "/// @access(from: documents)\nmodel Case")],
    ["optional parent", "AG-FROM-OPTIONAL", (source) => source.replace("case Case @relation", "case Case? @relation")],
    ["unsupported identity expression", "AG-READ-EXPRESSION", (source) => source.replace("read: userId == auth.id", "read: userId == input.id")],
    ["identity field not a user link", "AG-READ-FIELD", (source) => source.replace("read: userId == auth.id", "read: status == auth.id")],
    ["only without read", "AG-MASK-READ", (source) => source.replace("/// @access(from: case)", "/// @access(from: case, only: [update])")],
    ["deny names no ability", "AG-DENY", (source) => source.replace("/// @access(from: case)", "/// @access(from: case)\n/// @access(deny read: hidden)")],
    ["deny without a scope", "AG-DENY-SCOPE", (source) => source.replace("/// @access(read: userId == auth.id)", "/// @access(read: userId == auth.id)\n/// @access(deny read: status == PAID)")],
    ["rules beside a scope", "AG-SCOPE-RULE", (source) => source.replace("/// @access(from: case)", "/// @access(from: case)\n/// @access(update: member)")],
    ["two scopes", "AG-DUPLICATE", (source) => source.replace("/// @access(from: case)", "/// @access(from: case)\n/// @access(only: [read])")],
    ["from a rules model", "AG-FROM-RULES", (source) => source.replace("/// @access(read: userId == auth.id)\nmodel Billing", "/// @access(read, update: userId == auth.id)\nmodel Billing").replace("  user User @relation(fields: [userId], references: [id])\n}", "  user User @relation(fields: [userId], references: [id])\n  lines BillingLine[]\n}\n/// @access(from: billing)\nmodel BillingLine {\n  id String @id\n  billingId String\n  billing Billing @relation(fields: [billingId], references: [id])\n}")],
    ["a retired comment rule", "AG-LEGACY", (source) => source.replace("  title    String\n  content", "  title    String // @access read-only\n  content")],
    ["cascade beyond delete", "AG-CASCADE", (source) => source.replace("/// @access(from: case)", "/// @access(from: case, only: [read, create, update])").replace("case Case @relation(fields: [caseId], references: [id])", "case Case @relation(fields: [caseId], references: [id], onDelete: Cascade)")],
    ["create cannot fill a field", "AG-CREATE-UNFILLABLE", (source) => source.replace("/// @access(readonly)\n  publishedAt DateTime?", "/// @access(readonly)\n  publishedAt DateTime")],
    ["unclosed directive", "AG-SYNTAX", (source) => source.replace("/// @access(from: case)", "/// @access(from: case")],
    ["text after a directive", "AG-SYNTAX", (source) => source.replace("/// @access(from: case)", "/// @access(from: case) the documents")],
  ];
  for (const [name, code, change] of cases) {
    const source = change(CANONICAL);
    assert.notEqual(source, CANONICAL, `${name}: the fixture changed`);
    const problems = compile(source).problems;
    const found = problems.find((problem) => problem.code === code);
    assert.ok(found, `${name}: expected ${code}, got ${JSON.stringify(problems)}`);
    assert.ok(found.line > 0 && found.message.startsWith(`${code}: `), `${name}: located and coded`);
  }
});

test("a directive cycle fails", () => {
  const source = `
/// @access(read: id == auth.id)
model User {
  id String @id
}
/// @access(from: b)
model A {
  id  String @id
  bId String
  b   B @relation(fields: [bId], references: [id])
  bs  B[] @relation("BA")
}
/// @access(from: a)
model B {
  id  String @id
  aId String
  a   A @relation("BA", fields: [aId], references: [id])
  as  A[]
}`;
  assert.ok(codes(compile(source).problems).includes("AG-CYCLE"));
});

// ─── deny ────────────────────────────────────────────────────────────────────

const GUARDED = CANONICAL
  .replace("enum MembershipStatus {", "enum CaseStatus {\n  DRAFT\n  OPEN\n}\n\nenum MembershipStatus {")
  .replace("/// @access(read, create, update, delete)\n  OWNER", "/// @access(read, create, update, delete, draftCases)\n  OWNER")
  .replace("/// @access(read, create, update, delete)\n  ADMIN", "/// @access(read, create, update, delete, draftCases)\n  ADMIN")
  .replace("/// @access(from: workspace)\nmodel Case {", "/// @access(from: workspace)\n/// @access(deny read: status == DRAFT && !draftCases)\nmodel Case {")
  .replace("  title       String\n\n  workspace Workspace  @relation", "  title       String\n  status      CaseStatus @default(OPEN)\n\n  workspace Workspace  @relation");

test("deny hides rows of its model and every descendant, compiled in disjunctive normal form", async () => {
  const { graph, problems, rows } = compile(GUARDED);
  assert.deepEqual(problems, []);
  assert.deepEqual(graph.guards["Case.deny"]!.disjuncts, [{ row: { status: { not: "DRAFT" } } }, { roles: ["OWNER", "ADMIN"] }]);
  assert.deepEqual(graph.models.Document!.guards, [{ name: "Case.deny", model: "Case" }]);
  assert.deepEqual(rows.models.Case!.rules.map((rule) => ("own" in rule ? rule.own : undefined) ?? ("who" in rule ? rule.who : undefined)), [{ status: { not: "DRAFT" } }, ["OWNER", "ADMIN"]]);

  const store = member(world(), "W1", "EDITOR");
  store.Case = [{ id: "C1", workspaceId: "W1", title: "Open", status: "OPEN" }, { id: "C9", workspaceId: "W1", title: "Draft", status: "DRAFT" }];
  store.Document = [{ id: "D9", caseId: "C9", title: "Draft doc", content: "…" }];
  let access = runtimeOf(GUARDED, store);
  assert.equal(await access.visible("Case", row(store, "Case", "C1"), U42), true);
  assert.equal(await access.visible("Case", row(store, "Case", "C9"), U42), false, "EDITOR does not see drafts");
  assert.equal(await access.visible("Document", row(store, "Document", "D9"), U42), false, "nor documents under a draft");
  assert.equal((await access.authorize("Document", "create", { caseId: "C9" }, U42, { caseId: "C9", title: "x", content: "y" })).reason, "missing", "nor create under one");
  assert.equal((await access.authorize("Case", "update", row(store, "Case", "C9"), U42, { title: "x" })).reason, "missing", "nor update one");

  store.WorkspaceMember = [{ workspaceId: "W1", userId: "U42", role: "ADMIN", status: "ACTIVE" }];
  access = runtimeOf(GUARDED, store);
  assert.equal(await access.visible("Document", row(store, "Document", "D9"), U42), true, "those deny spares see them");
});

test("deny is checked against the schema and fingerprinted by its meaning", () => {
  const broken = (condition: string) => codes(compile(GUARDED.replace("deny read: status == DRAFT && !draftCases", `deny read: ${condition}`)).problems);
  assert.ok(broken("title == x").includes("AG-DENY"), "a String field is not an enum or Boolean");
  assert.ok(broken("status == ARCHIVED").includes("AG-DENY"), "an unknown value");
  assert.ok(broken("ROOT").includes("AG-DENY"), "an unknown role");
  assert.ok(broken("nothing").includes("AG-DENY"), "an unknown ability");
  assert.ok(broken("workspace.draftCases").includes("AG-DENY"), "no relation: deny tests this row and its scope");
  assert.ok(broken("workspaceId == auth.id").includes("AG-DENY"), "no identity");
  assert.ok(broken("status == DRAFT || status == OPEN").includes("AG-DENY-EMPTY"));
  assert.ok(codes(compile(GUARDED.replace("deny read:", "deny update:")).problems).includes("AG-DENY-ACTION"));

  const base = compile(GUARDED);
  const rewritten = compile(GUARDED.replace("deny read: status == DRAFT && !draftCases", "deny read: !(status != DRAFT || draftCases)"));
  assert.deepEqual(rewritten.problems, []);
  assert.deepEqual(rewritten.graph.guards["Case.deny"]!.disjuncts, base.graph.guards["Case.deny"]!.disjuncts, "an equivalent deny has the same normal form");
  const narrower = compile(GUARDED.replace("/// @access(read, create, update, delete, draftCases)\n  ADMIN", "/// @access(read, create, update, delete)\n  ADMIN"));
  assert.notEqual(accessGraphFingerprint(narrower.graph), accessGraphFingerprint(base.graph), "a changed audience changes the fingerprint");
});

// ─── Allow rules ─────────────────────────────────────────────────────────────

/** Allow rules on models without a role scope of their own: invitations and messages. */
const INVITES = CANONICAL
  .replace("/// @access(read, create, update, delete)\n  OWNER", "/// @access(read, create, update, delete, invite)\n  OWNER")
  .replace("/// @access(read, create, update, delete)\n  ADMIN", "/// @access(read, create, update, delete, invite)\n  ADMIN")
  .replace("enum MembershipStatus {", "enum InviteStatus {\n  PENDING\n  ACCEPTED\n  DECLINED\n  REVOKED\n}\n\nenum MembershipStatus {")
  .replace("  email       String            @unique", "  email       String            @unique\n  sent        Invitation[]      @relation(\"Sent\")")
  .replace("  cases   Case[]\n}", "  cases   Case[]\n  invitations Invitation[]\n}")
  + `
/// The invitee and members who may invite see an invitation.
/// @access(read: email == auth.email || workspace.invite)
/// @access(create: workspace.invite && email != auth.email)
model Invitation {
  id          String @id @default(uuid())
  workspaceId String
  email       String
  note        String?
  /// @access(readonly)
  senderId    String?
  /// @access(PENDING -> ACCEPTED | DECLINED: email == auth.email)
  /// @access(PENDING -> REVOKED: workspace.invite)
  status      InviteStatus @default(PENDING)

  workspace Workspace @relation(fields: [workspaceId], references: [id])
  sender    User?     @relation("Sent", fields: [senderId], references: [id])
}
`;

test("allow rules lower into row rules, grants and transitions the runtime enforces", async () => {
  const parsed = compile(INVITES);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.rows.models.Invitation!.rules, [
    { kind: "owner", field: "email" },
    { kind: "via", relation: "workspace", model: "Workspace", local: ["workspaceId"], target: ["id"], who: ["invite"] },
  ]);
  assert.deepEqual(parsed.policy.models.Invitation!.create, [{ who: ["invite"], except: ["owner"] }]);
  assert.deepEqual(parsed.policy.models.Invitation!.fields.status!.write, [
    { who: ["owner"], where: { status: "PENDING" }, to: { in: ["ACCEPTED", "DECLINED"] } },
    { who: ["invite"], where: { status: "PENDING" }, to: "REVOKED" },
  ]);
  assert.deepEqual(parsed.graph.rules!.Invitation!.model, ["read: email == auth.email || workspace.invite", "create: workspace.invite && email != auth.email"]);

  const store: Store = { ...member(world(), "W1", "ADMIN"), Invitation: [{ id: "I1", workspaceId: "W1", email: "u77@example.com", status: "PENDING", senderId: "U42" }] };
  const admin = runtimeOf(INVITES, store);
  const invitee = { id: "U77", email: "u77@example.com" };
  const invitation = row(store, "Invitation", "I1");
  assert.equal(await admin.visible("Invitation", invitation, invitee), true, "the invitee sees it by email");
  assert.equal(await admin.visible("Invitation", invitation, { id: "U9", email: "u9@example.com" }), false);
  assert.equal(await admin.visible("Invitation", invitation, { ...U42, email: "u42@example.com" }), true, "an inviter sees it");
  assert.equal((await admin.authorize("Invitation", "update", invitation, invitee, { status: "ACCEPTED" })).allowed, true);
  assert.equal((await admin.authorize("Invitation", "update", invitation, invitee, { status: "REVOKED" })).reason, "transition");
  assert.equal((await admin.authorize("Invitation", "update", invitation, { ...U42, email: "u42@example.com" }, { status: "REVOKED" })).allowed, true);
  assert.equal((await admin.authorize("Invitation", "update", { ...invitation, status: "ACCEPTED" }, invitee, { status: "DECLINED" })).reason, "when");
  assert.equal((await admin.authorize("Invitation", "create", { workspaceId: "W1" }, { ...U42, email: "u42@example.com" }, { workspaceId: "W1", email: "u42@example.com" })).reason, "excluded", "never invite yourself");
  assert.equal((await admin.authorize("Invitation", "update", invitation, invitee, { senderId: "U77" })).reason, "field", "readonly");
});

test("each field in a grouped transition checks its own stored value", async () => {
  const source = INVITES
    .replace("model Invitation {", "/// @access(fields(status, responseStatus), PENDING -> ACCEPTED: email == auth.email)\nmodel Invitation {")
    .replace("  /// @access(PENDING -> ACCEPTED | DECLINED: email == auth.email)\n", "")
    .replace("  status      InviteStatus @default(PENDING)", "  status      InviteStatus @default(PENDING)\n  responseStatus InviteStatus @default(PENDING)");
  const store = world();
  const row = { id: "I1", workspaceId: "W1", email: "u77@example.com", status: "PENDING", responseStatus: "DECLINED" };
  const invitee = { id: "U77", email: row.email };
  const access = runtimeOf(source, { ...store, Invitation: [row] });
  assert.equal((await access.authorize("Invitation", "update", row, invitee, { status: "ACCEPTED" })).allowed, true);
  assert.equal((await access.authorize("Invitation", "update", row, invitee, { responseStatus: "ACCEPTED" })).reason, "when");
});

test("isMe works in allow rules and a negated write condition through a verified membership", async () => {
  const source = INVITES.replaceAll("email == auth.email", "isMe(senderId)").replace("email != auth.email", "!isMe(senderId)")
    .replace("PENDING -> REVOKED: workspace.invite", "PENDING -> REVOKED: workspace.invite && !isMe(senderId)");
  const store = member(world(), "W1", "ADMIN");
  const access = runtimeOf(source, store);
  const invitation = { workspaceId: "W1", senderId: "U42", status: "PENDING" };
  assert.equal((await access.authorize("Invitation", "update", invitation, U42, { status: "REVOKED" })).allowed, false);
  assert.equal((await access.authorize("Invitation", "update", { ...invitation, senderId: "U77" }, U42, { status: "REVOKED" })).allowed, true);
  const wrongField = compile(source.replaceAll("isMe(senderId)", "isMe(email)"));
  assert.ok(codes(wrongField.problems).includes("AG-READ-FIELD"), "the verified email comparison is a separate predicate");
});

test("a repeated related state condition cannot overwrite an earlier constraint", () => {
  const source = INVITES.replace("  members WorkspaceMember[]", "  approval MembershipStatus\n  members WorkspaceMember[]")
    .replace("read: email == auth.email || workspace.invite", "read: email == auth.email || workspace.invite && workspace.approval == ACTIVE");
  assert.deepEqual(compile(source).problems, []);
  assert.ok(codes(compile(source.replace("workspace.approval == ACTIVE", "workspace.approval == ACTIVE && workspace.approval == INVITED")).problems).includes("AG-STATE-TWICE"));
});

test("a write through rel.read grants exactly the row's readers; identities lower to the owner", () => {
  const source = INVITES + `
/// @access(read, create: invitation.read)
model Reply {
  id           String @id @default(uuid())
  invitationId String
  body         String
  invitation   Invitation @relation(fields: [invitationId], references: [id])
}
`.replace("model Invitation {\n  id          String @id @default(uuid())", "model Invitation {\n  id          String @id @default(uuid())\n  replies     Reply[]");
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.policy.models.Reply!.create, [{ who: ["anyone"] }]);
  assert.deepEqual(parsed.rows.models.Reply!.rules, [{ kind: "via", relation: "invitation", model: "Invitation", local: ["invitationId"], target: ["id"] }]);
});

test("create and update column grants keep their own audiences and row conditions", async () => {
  const source = CANONICAL + `
/// @access(read: isMe(ownerId))
/// @access(create(title, body): isMe(ownerId))
/// @access(update(body): isMe(ownerId))
/// @access(update(title): isMe(ownerId) && editable == true)
model Note {
  id String @id
  ownerId String
  owner User @relation(fields: [ownerId], references: [id])
  title String
  body String
  editable Boolean
}`;
  const engine = runtimeOf(source, world());
  const note = { id: "N1", ownerId: U42.id, title: "Heading", body: "", editable: false };
  const authorize = (verb: "create" | "update", fields: AccessRow) => engine.authorize("Note", verb, note, U42, fields);
  assert.equal((await authorize("create", { title: "Heading", body: "" })).allowed, true);
  assert.equal((await authorize("update", { body: "Text" })).allowed, true);
  assert.equal((await authorize("update", { body: "Text", title: "New" })).allowed, false);
  assert.equal((await authorize("create", { editable: true })).allowed, false);
  assert.equal((await engine.permissions("Note", note, U42)).fields.title!.writable, false);
  assert.equal((await engine.explain("Note", { verb: "update", field: "title" }, note, U42)).allowed, false);
  assert.equal((await engine.authorize("Note", "update", { ...note, editable: true }, U42, { title: "New" })).allowed, true);
  const opposite = runtimeOf(source.replace("create(title, body)", "create(title)"), world());
  assert.equal((await opposite.authorize("Note", "create", note, U42, { body: "Text" })).allowed, false);
});

test("rules the runtime cannot enforce exactly fail with a code at the directive", () => {
  const replace = (from: string, to: string) => {
    const source = INVITES.replace(from, to);
    assert.notEqual(source, INVITES, `${from} is in the fixture`);
    return compile(source).problems;
  };
  const cases: [string, string, string][] = [
    ["AG-AUDIENCE", "create: workspace.invite && email != auth.email", "create: status == PENDING"],
    ["AG-AUDIENCE", "create: workspace.invite && email != auth.email", "create: workspace.invite && authenticated"],
    ["AG-SCOPE-NAME", "create: workspace.invite && email != auth.email", "create: invite"],
    ["AG-PATH", "create: workspace.invite && email != auth.email", "create: workspace.members.invite"],
    ["AG-NOT", "create: workspace.invite && email != auth.email", "create: !workspace.invite"],
    ["AG-READ-STATE", "read: email == auth.email || workspace.invite", "read: email == auth.email && status == PENDING || workspace.invite"],
    ["AG-WRITE-PATH", "create: workspace.invite && email != auth.email", "create: workspace.read"],
    ["AG-SCOPE-PATH", "PENDING -> REVOKED: workspace.invite", "PENDING -> REVOKED: sender.invite"],
    ["AG-IDENTITY-UNREAD", "PENDING -> REVOKED: workspace.invite", "PENDING -> REVOKED: senderId == auth.id"],
    ["AG-IDENTITY-FIELD", "read: email == auth.email", "read: note == auth.email"],
    ["AG-STATE-VALUE", "PENDING -> REVOKED", "PENDING -> CANCELLED"],
    ["AG-TRANSITION", "PENDING -> REVOKED: workspace.invite", "PENDING -> REVOKED: workspace.invite && status == PENDING"],
    ["AG-COLUMN", "create: workspace.invite", "create(senderId): workspace.invite"],
    ["AG-DUPLICATE", "create: workspace.invite", "create(note, note): workspace.invite"],
  ];
  for (const [code, from, to] of cases) {
    const problems = replace(from, to);
    const found = problems.find((problem) => problem.code === code);
    assert.ok(found, `${to}: expected ${code}, got ${JSON.stringify(problems)}`);
    assert.ok(found.column && found.column > 1, `${code} points into the directive`);
  }
  const principal = compile(CANONICAL.replace("/// @access(read: id == auth.id)\nmodel User {", "/// @access(read(id): authenticated)\nmodel User {"));
  assert.ok(codes(principal.problems).includes("AG-SELF"), "the principal says its users see their own row");
});

test("a two-owner row: rules name every owner link, and an exclusion excludes them all", () => {
  const source = CANONICAL.replace("  bills       Billing[]", "  bills       Billing[]\n  asA Pair[] @relation(\"A\")\n  asB Pair[] @relation(\"B\")") + `
/// @access(read, create: aId == auth.id || bId == auth.id)
model Pair {
  id  String @id @default(uuid())
  aId String
  bId String
  a   User @relation("A", fields: [aId], references: [id])
  b   User @relation("B", fields: [bId], references: [id])
}
`;
  const parsed = compile(source);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.policy.models.Pair!.create, [{ who: ["owner"] }]);
  assert.ok(codes(compile(source.replace("/// @access(read, create: aId == auth.id || bId == auth.id)", "/// @access(read: aId == auth.id || bId == auth.id)\n/// @access(create: aId == auth.id)")).problems).includes("AG-OWNER-PARTIAL"));
});

// ─── Typed application commands ──────────────────────────────────────────────

const CAPPED = CANONICAL
  .replace("/// @access(from: workspace)\nmodel Case {", "/// @access(from: workspace, only: [read])\nmodel Case {")
  .replace("/// @access(read, create, update, delete)\n  OWNER", "/// @access(read, create, update, delete, renameCases)\n  OWNER")
  .replace("/// @access(read, create, update, delete)\n  ADMIN", "/// @access(read, create, update, delete, renameCases)\n  ADMIN")
  .replace("/// @access(read, create, update)\n  EDITOR", "/// @access(read, create, update, renameCases)\n  EDITOR");
const commandModules = defineAccessPolicy({
  commands: {
    renameCase: command({ who: "renameCases", writes: [{ model: "Case", verb: "update", fields: ["title"] }] }),
  },
});

test("a command writes what the cap withholds, for its audience and fields only, and _access answers from it", async () => {
  const { graph, problems } = compile(CAPPED, commandModules);
  assert.deepEqual(problems, []);
  assert.deepEqual(graph.models.Document!.actions.update, [], "the cap reaches descendants");
  const store = member(world(), "W1", "EDITOR");
  const access = runtimeOf(CAPPED, store, commandModules);
  const kase = row(store, "Case", "C1");
  assert.equal((await access.authorize("Case", "update", kase, U42, { title: "x" })).reason, "who", "no grant without the command");
  assert.equal((await access.authorize("Case", "update", kase, U42, { title: "x" }, "renameCase")).allowed, true);
  assert.equal((await access.authorize("Case", "update", kase, U42, { workspaceId: "W2" }, "renameCase")).reason, "field", "only the command's fields");
  assert.equal((await access.permissions("Case", kase, U42)).fields.title!.writable, true, "eligibility follows the command");

  const viewer = member(world(), "W1", "VIEWER");
  const denied = runtimeOf(CAPPED, viewer, commandModules);
  assert.equal((await denied.authorize("Case", "update", row(viewer, "Case", "C1"), U42, { title: "x" }, "renameCase")).reason, "who");
  assert.equal((await denied.permissions("Case", row(viewer, "Case", "C1"), U42)).fields.title!.writable, false);
});

test("commands are checked against the schema", () => {
  const problems = (definition: Parameters<typeof command>[0]) => compile(CAPPED, { ...commandModules, commands: { broken: command(definition) } }).problems;
  assert.ok(codes(problems({ who: "renameCases", writes: [{ model: "Missing", verb: "update" }] })).includes("AG-COMMAND"));
  assert.ok(codes(problems({ who: "nobody", writes: [{ model: "Case", verb: "update", fields: ["title"] }] })).includes("AG-COMMAND"));
  assert.ok(codes(problems({ who: "renameCases", writes: [{ model: "Case", verb: "update", fields: ["workspaceId"] }] })).includes("AG-COMMAND"), "a command never moves a row");
  assert.ok(codes(problems({ who: "renameCases", writes: [{ model: "Document", verb: "update", fields: ["internalNotes"] }] })).includes("AG-COMMAND"), "nor assigns a serverOnly field");
});

const schemaCommand = "/// @access(command renameCase, update(title): renameCases";
const COMMAND_SOURCE = CAPPED
  .replace("model Case {", `${schemaCommand} && draft == true)\nmodel Case {\n  draft Boolean`)
  .replace("model Document {", `${schemaCommand})\nmodel Document {`);

test("writes of one schema command share an audience across models and enforce local state", async () => {
  const parsed = compile(COMMAND_SOURCE);
  assert.deepEqual(parsed.problems, []);
  const command = parsed.policy.commands!.renameCase!;
  assert.deepEqual(command, {
    closed: true, who: "renameCases",
    writes: [{ model: "Case", verb: "update", fields: ["title"], when: { draft: true } }, { model: "Document", verb: "update", fields: ["title"] }],
  });
  assert.deepEqual(parsed.graph.commands.renameCase, command);
  assert.equal(compile(CAPPED, commandModules).policy.commands!.renameCase!.closed, undefined);
  const locations = parsed.graph.provenance.commands!.renameCase!;
  assert.deepEqual(locations.map((site) => [site.model, site.verb]), [["Case", "update"], ["Document", "update"]]);
  for (const site of locations) assert.ok(COMMAND_SOURCE.split("\n")[site.line - 1]!.slice(site.column - 1).startsWith("@access(command renameCase"));
  const store = member(world(), "W1", "EDITOR");
  const access = runtimeOf(COMMAND_SOURCE, store);
  for (const draft of [true, false]) {
    const kase = { ...row(store, "Case", "C1"), draft };
    assert.equal((await access.authorize("Case", "update", kase, U42, { title: "edited" }, "renameCase")).allowed, draft);
  }
  assert.equal((await access.authorize("Document", "update", row(store, "Document", "D1"), U42, { title: "edited" }, "renameCase")).allowed, true);
});

test("schema commands diagnose ambiguous audiences, writes, columns and conditions at their source", () => {
  const change = (replacement: string) => COMMAND_SOURCE.replace(`${schemaCommand} && draft == true)`, `/// @access(${replacement})`);
  const bad = [
    change("command renameCase, update(title):"),
    change("command renameCase, update(title): draft == true"),
    change("command renameCase, update(title): renameCases || authenticated"),
    change("command renameCase, update(title): renameCases && draft == true && draft == false"),
    change("command renameCase, update(title): renameCases && draft == ACTIVE"),
    change("command renameCase, update(title): renameCases && title == DRAFT"),
    change("command renameCase, update(title): renameCases && workspace.status == ACTIVE"),
    change("command renameCase, update(title, title): renameCases"),
    change("command renameCase, update(title): authenticated"),
    change("command renameCase, update(workspaceId): renameCases"),
    change("command renameCase, update(invalid): renameCases"),
    COMMAND_SOURCE.replace(`${schemaCommand})\nmodel Document`, "/// @access(command renameCase, create(publishedAt): renameCases)\nmodel Document"),
    change("command renameCase, update(title): renameCases)\n/// @access(command renameCase, update(title): renameCases"),
    COMMAND_SOURCE.replaceAll("update(title): renameCases", "update(title): misspelled"),
  ];
  for (const source of bad) {
    const problem = compile(source).problems.find((item) => item.column && source.split("\n")[item.line - 1]!.includes("command renameCase"));
    assert.ok(problem, source.slice(source.indexOf("command renameCase"), source.indexOf("model Case {")));
  }
  assert.ok(codes(compile(COMMAND_SOURCE, commandModules).problems).includes("AG-COMMAND-DIRECTIVE"), "a TS and schema command cannot share a name");
});

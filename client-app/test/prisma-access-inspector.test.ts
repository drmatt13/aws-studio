import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement } from "react";
import { accessFixture } from "./support/access-fixture";
const modules = undefined;
import { readClientAccess } from "aws-studio/database/client-access";
import { PrismaAccessInspector, type PrismaAccessInspectorProps } from "../src/views/PrismaAccessInspector";
import { personas, sampleReadAccess, sampleReadFields } from "../src/views/access-lens";

const source = accessFixture;
const parsed = readClientAccess(source, modules);
const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react");
let dom: { window: Window & typeof globalThis };

before(() => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  ui = require("@testing-library/react");
});
afterEach(() => ui.cleanup());
after(() => dom.window.close());

function panel(line: number, props: Partial<PrismaAccessInspectorProps> = {}) {
  return ui.render(createElement(PrismaAccessInspector, {
    source, parsed, line, onNavigate: () => {}, onClose: () => {}, ...props,
  }));
}


test("a scope model traces its path to exact declarations and shows the deny rule it inherits", () => {
  assert.deepEqual(parsed.problems, []);
  const opened: number[] = [];
  const mounted = panel(parsed.graph.provenance.models.ProjectFile!.line, {
    exposure: { status: "available", typesByModel: {} },
    onNavigate: (line) => opened.push(line),
  });
  assert.ok(mounted.getByRole("heading", { name: "ProjectFile" }));
  assert.ok(mounted.getByText("Access · In a role scope"));
  const path = ui.within(mounted.getByRole("list", { name: "Access path" }));
  assert.deepEqual(path.getAllByRole("listitem").map((item) => item.textContent), ["ProjectFile", "Project", "Team"]);
  ui.fireEvent.click(path.getByRole("button", { name: "Project" }));
  assert.deepEqual(opened, [parsed.graph.provenance.models.Project!.line]);
  assert.ok(mounted.getByText("Deny always wins"));
  assert.ok([...mounted.container.querySelectorAll("[data-ui=access-code]")].some((code) => code.textContent === "deny read: status == DRAFT && !createProject"));
  assert.ok(mounted.getByText("Inherited through from:."));
  assert.ok(mounted.getByText("No registered GraphQL table type"));
  assert.ok(mounted.getByText("Role actions here · Read only"));
});

test("the inherited sample evaluates the project status for the selected role with the runtime", async () => {
  const choices = personas(parsed);
  const reviewer = choices.find(({ persona }) => persona.kind === "role" && persona.role === "REVIEWER")!.persona;
  const admin = choices.find(({ persona }) => persona.kind === "role" && persona.role === "ADMIN")!.persona;
  assert.deepEqual(sampleReadFields(parsed, "ProjectFile").map(({ model, field }) => `${model}.${field}`), ["Project.status"]);
  assert.deepEqual(await sampleReadAccess(parsed, "ProjectFile", reviewer, { Project: { status: "DRAFT" } }), {
    allowed: false, reason: "Project’s deny rule hides this sample.",
  });
  assert.deepEqual(await sampleReadAccess(parsed, "ProjectFile", reviewer, { Project: { status: "ACTIVE" } }), { allowed: true });
  assert.deepEqual(await sampleReadAccess(parsed, "ProjectFile", admin, { Project: { status: "DRAFT" } }), { allowed: true });
  assert.deepEqual(await sampleReadAccess(parsed, "ProjectFile", { kind: "stranger" }, { Project: { status: "DRAFT" } }), {
    allowed: false, reason: "Team’s row access rule rejected this sample.",
  });
});

test("a field of a scope model shows its commands; colours mark each part of a rule", () => {
  const jumps: number[] = [];
  const mounted = panel(parsed.index.models.Project!.fields.title!, {
    exposure: { status: "available", typesByModel: { Project: ["ProjectDraft"] } },
    onEditSource: line => jumps.push(line),
  });
  assert.ok(mounted.getByRole("heading", { name: "Project.title" }));
  assert.ok(mounted.getByText("Role actions here · Read only"));
  assert.equal(mounted.queryByText(/GraphQL types/), null);
  const command = mounted.getByRole("button", { name: "saveProjectDraft" });
  assert.match(command.closest("li")!.textContent!, /createProject.*status is DRAFT.*title/);
  ui.fireEvent.click(command);
  assert.match(source.split("\n")[jumps[0]! - 1]!, /command saveProjectDraft, update\(title/);
  const deny = [...mounted.container.querySelectorAll("[data-ui=access-code]")].find((code) => code.textContent!.startsWith("deny"))!;
  assert.deepEqual([...deny.querySelectorAll("span")].map((span) => [span.textContent, span.className.split(" ")[0]]), [
    ["deny", "text-access-limit"], ["read", "text-ink"], ["status", "text-access-state"], ["==", "text-access-state"], ["DRAFT", "text-access-state"],
    ["!", "text-access-limit"], ["createProject", "text-access-role"],
  ]);
});

test("a model with rules shows who sees its rows, its rules as written and its writes", () => {
  const jumps: number[] = [];
  const mounted = panel(parsed.index.models.TeamInvitation!.line, { onEditSource: (line) => jumps.push(line) });
  assert.ok(mounted.getByText("Access · Rules"));
  const readers = mounted.getByRole("list", { name: "Who sees rows" });
  assert.deepEqual(ui.within(readers).getAllByRole("listitem").map((item) => item.textContent), ["The user whose email it is", "inviteMembers of the related Team"]);
  const rules = [...readers.closest("section")!.querySelectorAll("[data-ui=access-code]")].map((code) => code.textContent);
  assert.deepEqual(rules, ["read: email == auth.email || team.inviteMembers", "create: team.inviteMembers && email != auth.email"]);
  assert.match(mounted.getByText("Create").nextElementSibling!.textContent!, /inviteMembers.*excluding the row’s owner/);
  ui.fireEvent.click(mounted.getAllByRole("button", { name: /^Show line \d+ in source$/ })[0]!);
  assert.equal(source.split("\n")[jumps[0]! - 1]!.trim(), "/// @access(read: email == auth.email || team.inviteMembers)");
  mounted.unmount();

  const status = panel(parsed.index.models.TeamInvitation!.fields.status!);
  assert.deepEqual([...status.container.querySelectorAll("[data-ui=access-code]")].map((code) => code.textContent).slice(-2),
    ["PENDING -> ACCEPTED | DECLINED: email == auth.email", "PENDING -> REVOKED: team.inviteMembers"]);
});

test("the permission matrix grants each role independently and links to the declaration", () => {
  const changes: string[] = [];
  const jumps: number[] = [];
  const enumeration = parsed.index.enums.ProjectRole!;
  const mounted = panel(enumeration.line, { modules, onApplySource: (next) => changes.push(next), onNavigate: (line) => jumps.push(line) });
  assert.ok(mounted.getByText("Role permissions"));
  assert.deepEqual(mounted.getAllByRole("rowheader").map((header) => header.textContent), [
    "read", "manageTeam", "inviteMembers", "changeMemberRoles", "removeMembers", "createProject", "createChange",
    "acceptChange", "answerQuestion", "setTaskStatus", "markReviewed", "uploadFiles",
  ]);
  const own = mounted.getByRole("button", { name: "REVIEWER holds acceptChange. Toggle" });
  const manager = mounted.getByRole("button", { name: "MANAGER holds acceptChange. Toggle" });
  const none = mounted.getByRole("button", { name: "CONTRIBUTOR does not hold acceptChange. Toggle" });
  assert.equal(manager.getAttribute("aria-pressed"), "true");
  own.focus();
  ui.fireEvent.keyDown(own, { key: "ArrowRight" });
  assert.equal(document.activeElement, none);
  ui.fireEvent.click(none);
  assert.equal(changes.length, 1);
  const changed = changes[0]!.split("\n").filter((line, index) => line !== source.split("\n")[index]);
  assert.deepEqual(changed, ["/// @access(acceptChange: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR])"]);
  assert.deepEqual(readClientAccess(changes[0]!, modules).policy.enums.ProjectRole!.grants.acceptChange, ["OWNER", "ADMIN", "MANAGER", "REVIEWER", "CONTRIBUTOR"]);
  ui.fireEvent.click(ui.within(mounted.getByRole("table")).getByRole("button", { name: "OWNER" }));
  assert.deepEqual(jumps, [enumeration.values.OWNER!]);
  assert.match(source.split("\n")[jumps[0]! - 1]!, /^\s*OWNER\b.*@access\(protected\)/);
  ui.fireEvent.click(mounted.getByRole("button", { name: /^acceptChange$/ }));
  assert.match(source.split("\n")[jumps.at(-1)! - 1]!, /@access\(acceptChange: \[OWNER, ADMIN, MANAGER, REVIEWER\]\)/);
  // read is a row like any ability: its header links to the row, and a cell edits that row's list.
  ui.fireEvent.click(mounted.getByRole("button", { name: /^read$/ }));
  assert.equal(source.split("\n")[jumps.at(-1)! - 1], "/// @access(read: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR, READONLY])");
  ui.fireEvent.click(mounted.getByRole("button", { name: "READONLY holds read. Toggle" }));
  assert.deepEqual(changes.at(-1)!.split("\n").filter((line, index) => line !== source.split("\n")[index]),
    ["/// @access(read: [OWNER, ADMIN, MANAGER, REVIEWER, CONTRIBUTOR])"]);
  assert.match(mounted.getByText(/Clients never assign or replace/).textContent!, /OWNER.*protected/);
  ui.fireEvent.click(mounted.getByRole("button", { name: "TeamMember.role" }));
  assert.deepEqual(jumps.at(-1), parsed.index.models.TeamMember!.fields.role!);
});

test("a private field on the principal reads as the owner's, and the close action works", async () => {
  const line = parsed.index.models.User!.fields.privateStatus!;
  const actions: string[] = [];
  const exposure = { status: "available" as const, typesByModel: { User: ["CurrentUser", "MessageSender", "TeamUser"] } };
  const model = panel(parsed.index.models.User!.line, { exposure });
  assert.ok(model.getByText("GraphQL types · CurrentUser, MessageSender, TeamUser"));
  assert.deepEqual(ui.within(model.getByRole("list", { name: "Who sees rows" })).getAllByRole("listitem").map((item) => item.textContent)[0], "Each signed-in user, their own row");
  model.unmount();
  const mounted = panel(line, { exposure, onClose: () => actions.push("close") });
  assert.match(mounted.getByText("Read").nextElementSibling!.textContent!, /owner/i);
  assert.equal(mounted.getByText("Update").nextElementSibling!.textContent, "Clients cannot edit it");
  assert.equal(mounted.queryByText(/GraphQL types/), null);
  ui.fireEvent.click(mounted.getByRole("button", { name: "Close access inspector" }));
  assert.deepEqual(actions, ["close"]);
  const peer = personas(parsed).find(({ persona }) => persona.kind === "role" && persona.role === "ADMIN")!.persona;
  assert.deepEqual(await sampleReadAccess(parsed, "User", { kind: "owner" }, {}, "privateStatus"), { allowed: true });
  assert.deepEqual(await sampleReadAccess(parsed, "User", peer, {}, "firstName"), { allowed: true });
  assert.equal((await sampleReadAccess(parsed, "User", peer, {}, "privateStatus")).allowed, false);
});

test("a field and its model link to the same grouped declaration", () => {
  const source = `// use prisma-8
/// @access(read: id == auth.id)
/// @access(fields(email, phone),
///   serverOnly)
model User {
  id String @id
  email String
  phone String
  name String
}
`;
  const parsed = readClientAccess(source);
  assert.deepEqual(parsed.problems, []);
  const model = parsed.index.models.User!;
  const jumps: number[] = [];
  const props = { source, parsed, onEditSource: (line: number) => jumps.push(line) };
  const modelView = panel(model.line, props);
  const groups = modelView.getByRole("region", { name: "Grouped field rules" });
  assert.equal(groups.querySelector("[data-ui=access-code]")?.textContent, "fields(email, phone), serverOnly");
  ui.fireEvent.click(ui.within(groups).getByRole("button", { name: "Show line 3 in source" }));
  modelView.unmount();

  const field = panel(model.fields.phone!, props);
  assert.ok(field.getByText("Server only"));
  ui.fireEvent.click(field.getByRole("button", { name: "Show line 3 in source" }));
  assert.deepEqual(jumps, [3, 3]);
  field.unmount();

  const other = panel(model.fields.name!, props);
  assert.equal(other.queryByRole("button", { name: "Show line 3 in source" }), null);
});

test("a model without a directive explains that it is not in the API", () => {
  const source = "// use prisma-8\n/// @access(read: id == auth.id)\nmodel User {\n  id String @id\n}\nmodel Audit {\n  id String @id\n}\n";
  const local = readClientAccess(source);
  const mounted = panel(6, { source, parsed: local });
  assert.ok(mounted.getByText("Audit is not in the client API."));
});

test("a schema without Access Graph preserves application-owned API exposure", () => {
  const source = "model Project {\n  id String @id\n}\n";
  const mounted = panel(1, { source, parsed: readClientAccess(source) });
  assert.ok(mounted.getByText("No Access Graph policy declared."));
  assert.ok(mounted.getByText("API exposure and authorization remain defined by the application's resolvers and repositories."));
  assert.equal(mounted.queryByText("Project is not in the client API."), null);
});

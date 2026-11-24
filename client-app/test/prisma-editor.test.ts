import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, test } from "node:test";
import { createElement as h, createRef } from "react";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { StringStream } from "@codemirror/language";
import { format } from "@prisma/orm-framework/psl-parser/format";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { editorChange, type PrismaEditorHandle } from "../src/views/PrismaEditor";
import { prismaCompletions, prismaDefinition, prismaFold, prismaSymbols, prismaToken } from "../src/views/prisma-language";

const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react");
let component: typeof import("../src/views/PrismaEditor");
let dom: { window: Window & typeof globalThis };

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "Window", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "DOMRect", "Range", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  ui = require("@testing-library/react");
  component = await import("../src/views/PrismaEditor");
});
afterEach(() => ui.cleanup());
after(() => dom.window.close());

const contract = `// use prisma-8
// Keep comments and physical names.
enum Role {
  MEMBER
  ADMIN
}
model User {
  id Uuid @id
  nickname String? @map("display_name") // keep this explanation
  joinedAt TimestamptzString(6) @default(now())
  role Role @default(MEMBER)
  @@map("users")
}
model Project {
  ownerId Uuid @map("owner_id")
  owner User @relation(fields: [ownerId], references: [id])
  slug String
  @@id([ownerId, slug], map: "projects_pkey")
}
`;

test("Prisma 8 lexical highlighting covers constructors, annotations and source comments", () => {
  const line = '  joinedAt temporal.timestamptzString(6, onCreate: now) @map("joined_at") // field';
  const stream = new StringStream(line, 2, 2);
  const state = { multilineString: false, afterAttribute: false, afterDeclaration: false, depth: 1 };
  const tokens: { text: string; style: string | null }[] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = prismaToken(stream, state);
    tokens.push({ text: line.slice(stream.start, stream.pos), style });
  }
  assert.deepEqual(tokens.filter(token => ["timestamptzString", "6", "map", '"joined_at"', "// field"].includes(token.text)), [
    { text: "timestamptzString", style: "functionName" },
    { text: "6", style: "number" }, { text: "map", style: "meta" },
    { text: '"joined_at"', style: "string" }, { text: "// field", style: "comment" },
  ]);
});

test("native parser reconstructs navigation for enum types, composite keys and owning relationships", () => {
  assert.equal(parse(contract, "contract.prisma").diagnostics.length, 0);
  assert.ok(prismaSymbols(contract).some(symbol => symbol.name === "Role"));
  const modelReference = contract.indexOf("owner User") + "owner ".length;
  assert.equal(prismaDefinition(contract, modelReference)?.name, "User");
  const fieldReference = contract.indexOf("[ownerId]") + 2;
  assert.equal(prismaDefinition(contract, fieldReference)?.from, contract.indexOf("ownerId Uuid"));
  const targetField = contract.indexOf("references: [id]") + "references: [".length;
  assert.equal(prismaDefinition(contract, targetField)?.from, contract.indexOf("id Uuid"));
  const enumReference = contract.indexOf("role Role") + 6;
  assert.equal(prismaDefinition(contract, enumReference)?.name, "Role");
  const unknown = contract + "\nmodel Unfinished {\n  draft String?\n";
  assert.ok(prismaSymbols(unknown).some(symbol => symbol.name === "draft"), "recovered invalid drafts remain navigable");
});

test("native formatter preserves comments, mappings and Prisma 8 constructor syntax", () => {
  const formatted = format(contract, { indent: 2 });
  assert.equal(parse(formatted, "contract.prisma").diagnostics.length, 0);
  for (const text of ['// Keep comments and physical names.', '@map("display_name")', '// keep this explanation', 'TimestamptzString(6)', '@@id([ownerId, slug], map: "projects_pkey")']) assert.ok(formatted.includes(text), text);
  assert.throws(() => format('model User { id String @id\n broken ???'), /parse errors/i);
});

test("completion names its syntax capability and does not insert into strings or comments", () => {
  const complete = (text: string) => prismaCompletions(new CompletionContext(EditorState.create({ doc: text }), text.length, true));
  assert.ok(complete("model User {\n  joinedAt Timest")?.options.some(option => option.label === "TimestamptzString"));
  assert.ok(complete("model User {\n  id Uuid @ma")?.options.some(option => option.label === "@map"));
  assert.equal(complete("// model User"), null);
  assert.equal(complete('model User {\n id Uuid @map("unfinished'), null);
  assert.ok(complete(`${contract}\nmodel Other {\n user Us`)?.options.some(option => option.label === "User"));
});

test("folding skips closing braces in strings and comments", () => {
  const text = 'model Example {\n  value String @default("}") // }\n}\n';
  const fold = prismaFold(text, 0, text.indexOf("\n"));
  assert.deepEqual(fold, { from: text.indexOf("{") + 1, to: text.lastIndexOf("}") });
  assert.equal(prismaFold(text, text.indexOf("  value"), text.indexOf("\n}")), null);
});

test("minimal document replacement preserves unchanged comments and mapped column text", () => {
  const next = contract.replace("nickname String?", "displayName String?");
  const change = editorChange(contract, next)!;
  assert.equal(contract.slice(0, change.from) + change.insert + contract.slice(change.to), next);
  assert.ok(!change.insert.includes("@map"));
  assert.equal(editorChange(contract, contract), null);
});

test("validation rerenders retain the editor, selection, invalid draft and undo history", async () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  const props = { ref, value: contract, onChange: (text: string) => changes.push(text) };
  const mounted = ui.render(h(component.PrismaEditor, props));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const offset = contract.indexOf("nickname");
  ui.act(() => ref.current!.replace(offset, offset + "nickname".length, "displayName"));
  const draft = changes.at(-1)!;
  ui.act(() => ref.current!.reveal(offset, offset + "displayName".length, false));
  mounted.rerender(h(component.PrismaEditor, { ...props, value: draft, diagnostics: [{ from: offset, to: offset + 3, severity: "error", message: "Example validation problem" }] }));
  assert.equal(ui.screen.getByRole("textbox", { name: "Prisma schema source" }), content);
  assert.deepEqual(ref.current!.getSelection(), { from: offset, to: offset + "displayName".length });
  ui.act(() => ref.current!.replace(draft.length, draft.length, "\nmodel Broken { ???"));
  const invalid = changes.at(-1)!;
  mounted.rerender(h(component.PrismaEditor, { ...props, value: invalid, diagnostics: [] }));
  assert.ok(content.textContent?.includes("model Broken { ???"));
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), draft);
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), contract);
  ui.act(() => ref.current!.redo());
  assert.equal(changes.at(-1), draft);
});

test("external draft changes do not echo onChange and formatting is one undoable action", () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  const props = { ref, value: contract, onChange: (text: string) => changes.push(text) };
  const mounted = ui.render(h(component.PrismaEditor, props));
  const external = contract.replace("nickname", "displayName");
  mounted.rerender(h(component.PrismaEditor, { ...props, value: external }));
  assert.equal(changes.length, 0);
  ui.act(() => ref.current!.replaceDocument(format(external)));
  assert.equal(changes.length, 1);
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), external);
});

test("review and format shortcuts never write source and read-only sessions reject visual edits", () => {
  const ref = createRef<PrismaEditorHandle>();
  let reviews = 0, formats = 0, changes = 0;
  ui.render(h(component.PrismaEditor, { ref, value: contract, readOnly: true, onChange: () => changes++, onSave: () => reviews++, onFormat: () => formats++ }));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const modifier = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  ui.fireEvent.keyDown(content, { key: "s", code: "KeyS", ...modifier });
  ui.fireEvent.keyDown(content, { key: "F", code: "KeyF", keyCode: 70, ...modifier, shiftKey: true });
  assert.equal(reviews, 1);
  assert.equal(formats, 1);
  ui.act(() => ref.current!.replace(0, 0, "forbidden"));
  ui.act(() => ref.current!.replaceDocument("forbidden"));
  assert.equal(changes, 0);
});

/** The editor's contract with access directives: a principal, a role scope, rules and a field protection. */
const governed = `// use prisma-8
enum Role {
  /// @access(...MEMBER, manage)
  ADMIN
  /// @access(read)
  MEMBER
}
/// @access(read, update(nickname): id == auth.id)
model User {
  id Uuid @id
  nickname String? @map("display_name")
}
/// @access(read: team.member || authorId == auth.id)
model Note {
  teamId Uuid
  authorId Uuid
  /// @access(serverOnly)
  draft String?
  team Team @relation(fields: [teamId], references: [id])
  author User @relation(fields: [authorId], references: [id])
  @@id([teamId, authorId])
}
/// @access(roles: memberships[state=ACTIVE].role)
model Team {
  id Uuid @id
  memberships Membership[]
}
model Membership {
  teamId Uuid
  userId Uuid
  role Role
  state State
  team Team @relation(fields: [teamId], references: [id])
  user User @relation(fields: [userId], references: [id])
  @@id([teamId, userId])
}
enum State {
  ACTIVE
  LEFT
}
`;
const tokens = (container: HTMLElement, category: string) => [...container.querySelectorAll(`.cm-access-${category}`)].map((token) => token.textContent);

test("valid rules fold into clickable pills, keeping model rules stacked and member rules inline", async () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [], opened: number[] = [];
  const source = governed.replace("  /// @access(read)\n  MEMBER", "  MEMBER /// @access(read)");
  const mounted = ui.render(h(component.PrismaEditor, { ref, value: source, validatedSource: source, onChange: (value: string) => changes.push(value), onFieldAccess: (position: number) => opened.push(position) }));
  // Role values carry quiet annotations; every other rule is a pill.
  const pill = (target: string) => mounted.container.querySelector<HTMLElement>(`:is(.cm-access-pill, .cm-access-annotation)[data-access-target="${target}"]`);
  assert.equal(pill("Team")?.dataset.accessKind, "role");
  assert.ok(pill("Role.ADMIN")?.classList.contains("cm-access-annotation"));
  assert.ok(pill("Note.draft")?.classList.contains("cm-access-pill"));
  assert.equal(pill("Note")?.dataset.accessKind, "mixed");
  assert.equal(pill("Note")?.closest(".cm-line")?.textContent, "read: team.member || authorId == auth.id");
  for (const [target, name] of [["Role.ADMIN", "ADMIN"], ["Role.MEMBER", "MEMBER"], ["Note.draft", "draft"]]) {
    assert.ok(pill(target!)?.closest(".cm-line")?.textContent?.trimStart().startsWith(name!), target);
  }
  ui.fireEvent.mouseDown(pill("Role.ADMIN")!, { button: 0 });
  assert.equal(source.slice(opened[0]).split("\n")[0], "  /// @access(...MEMBER, manage)");
  const matrix = ui.screen.getByRole("button", { name: "Role permissions for Role" });
  ui.fireEvent.click(matrix, { detail: 0 });
  assert.equal(source.slice(opened[1]).split("\n")[0], "enum Role {");
  assert.equal(ui.screen.queryByRole("button", { name: "Configure access for User.nickname" }), null);
  const end = source.indexOf("\n", source.indexOf("nickname String?"));
  ui.act(() => ref.current!.reveal(end));
  const hint = await ui.screen.findByRole("button", { name: "Configure access for User.nickname" });
  assert.equal(ui.screen.queryByRole("button", { name: "Configure access for Note.team" }), null);
  ui.fireEvent.mouseDown(hint, { button: 0 });
  assert.equal(opened[2], end);
  ui.act(() => ref.current!.reveal(source.indexOf("team.member ||")));
  assert.equal(pill("Note"), null);
  assert.deepEqual(tokens(mounted.container, "identity"), ["authorId", "==", "auth.id"]);
  assert.deepEqual(tokens(mounted.container, "role"), ["member"]);
  assert.deepEqual(tokens(mounted.container, "path"), ["team"]);
  ui.act(() => ref.current!.reveal(0));
  assert.ok(pill("Note"));
  assert.deepEqual(changes, []);
});

test("a caret directly after a folded rule shows its source; a caret before it leaves it folded", () => {
  const ref = createRef<PrismaEditorHandle>();
  const source = governed.replace("  /// @access(read)\n  MEMBER", "  MEMBER /// @access(read)");
  const mounted = ui.render(h(component.PrismaEditor, { ref, value: source, onChange: () => {} }));
  const folded = (target: string) => mounted.container.querySelector(`:is(.cm-access-pill, .cm-access-annotation)[data-access-target="${target}"]`);
  const text = () => mounted.container.querySelector(".cm-content")!.textContent!;

  const rule = "/// @access(read: team.member || authorId == auth.id)";
  const start = source.indexOf(rule);
  ui.act(() => ref.current!.reveal(start));
  assert.ok(folded("Note"), "the caret before a pill");
  ui.act(() => ref.current!.reveal(start + rule.length));
  assert.equal(folded("Note"), null, "the caret after the rule's last character");
  assert.ok(text().includes(rule));

  ui.act(() => ref.current!.reveal(source.indexOf("\n", source.indexOf("MEMBER /// @access(read)"))));
  assert.equal(folded("Role.MEMBER"), null, "a trailing value annotation");
  assert.ok(folded("Note"), "leaving a rule folds it again");

  // A stacked field rule is drawn after its field, so the end of the field's line is directly after it.
  assert.ok(folded("Note.draft"));
  ui.act(() => ref.current!.reveal(source.indexOf("\n", source.indexOf("draft String?"))));
  assert.equal(folded("Note.draft"), null);
  assert.ok(text().includes("/// @access(serverOnly)"));
});

test("role value annotations align in one column after the enum's widest value", () => {
  const source = governed.replace("  /// @access(read)\n  MEMBER", "  MEMBER /// @access(read)");
  const mounted = ui.render(h(component.PrismaEditor, { value: source, onChange: () => {} }));
  const indent = (target: string) => mounted.container.querySelector<HTMLElement>(`.cm-access-annotation[data-access-target="${target}"]`)!.style.marginInlineStart;
  // "  MEMBER" is the widest value (8 columns), so annotations start at column 10:
  // ADMIN's is drawn at its line end (column 7), MEMBER's comment starts at column 9.
  assert.equal(indent("Role.ADMIN"), "calc(3ch - 4px)");
  assert.equal(indent("Role.MEMBER"), "calc(1ch - 4px)");
  const parts = [...mounted.container.querySelectorAll('.cm-access-annotation[data-access-target="Role.ADMIN"] span > span')];
  assert.deepEqual(parts.map((part) => [part.textContent, (part as HTMLElement).dataset.category]), [["...MEMBER", "role"], [", ", undefined], ["manage", "role"]]);
});

test("invalid directives and ordinary comments stay editable, including after an inline rule is changed", () => {
  const ref = createRef<PrismaEditorHandle>();
  const source = governed.replace("  /// @access(serverOnly)\n  draft String?", "  draft String? /// @access(serverOnly)");
  const mounted = ui.render(h(component.PrismaEditor, { ref, value: source, onChange: () => {} }));
  const at = source.indexOf("serverOnly");
  const pill = () => mounted.container.querySelector('.cm-access-pill[data-access-target="Note.draft"]');
  assert.ok(pill()?.closest(".cm-line")?.textContent?.includes("draft String?"));
  ui.act(() => ref.current!.replace(at, at + 10, "unfinished"));
  assert.equal(pill(), null);
  assert.ok(mounted.container.querySelector(".cm-content")?.textContent?.includes("/// @access(unfinished)"));
  ui.act(() => ref.current!.undo());
  assert.ok(pill());
  ui.act(() => ref.current!.reveal(at));
  assert.deepEqual(tokens(mounted.container, "limit"), ["serverOnly"]);
  assert.ok(mounted.container.querySelector(".cm-content")?.textContent?.includes("// use prisma-8"));
});

test("multiple field pills retain source order beside their declaration, including a multiline trailing rule", () => {
  const field = 'nickname String? @map("display_name")';
  const source = governed.replace(field, '/// @access(read: isMe(id))\n  ' + field + ' /// @access(\n  /// readonly)');
  const mounted = ui.render(h(component.PrismaEditor, { value: source, onChange: () => {} }));
  const pills = [...mounted.container.querySelectorAll('.cm-access-pill[data-access-target="User.nickname"]')];
  assert.deepEqual(pills.map(pill => pill.textContent), ["read: isMe(id)", "readonly"]);
  assert.equal(pills[0]!.closest(".cm-line"), pills[1]!.closest(".cm-line"));
  assert.ok(pills[0]!.closest(".cm-line")?.textContent?.includes(field));
});

test("a schema without Access Graph policy keeps model headers plain and access inspection available", () => {
  const opened: number[] = [];
  const ref = createRef<PrismaEditorHandle>();
  const mounted = ui.render(h(component.PrismaEditor, { ref, value: contract, onChange: () => {}, onFieldAccess: (position: number) => opened.push(position) }));
  assert.equal(mounted.container.querySelector(".cm-access-scope-chip"), null);

  const project = contract.indexOf("model Project");
  ui.act(() => ref.current!.reveal(project));
  ui.fireEvent.keyDown(ui.screen.getByRole("textbox", { name: "Prisma schema source" }), { key: ".", code: "Period", ctrlKey: true });
  assert.deepEqual(opened, [project]);
});

test("each model shows where access to its rows comes from, and its chip opens the inspector without editing", () => {
  const opened: number[] = [];
  const changes: string[] = [];
  const ref = createRef<PrismaEditorHandle>();
  const mounted = ui.render(h(component.PrismaEditor, { ref, value: governed, onChange: (text: string) => changes.push(text), onFieldAccess: (position: number) => opened.push(position) }));
  const chips: Record<string, HTMLElement> = Object.fromEntries([...mounted.container.querySelectorAll<HTMLElement>(".cm-access-scope-chip")].map((chip) => [chip.dataset.accessModel, chip]));
  assert.deepEqual(Object.keys(chips), ["User", "Note", "Team", "Membership"]);
  assert.equal(chips.Team!.textContent, "Team roles");
  assert.equal(chips.Membership!.dataset.exposed, "false");
  assert.equal(chips.Membership!.getAttribute("aria-label"), "Membership is not in the client API");
  assert.deepEqual([...chips.Note!.querySelectorAll<HTMLElement>(".cm-access-scope-dot")].map((dot) => dot.dataset.kind), ["identity", "role"]);
  const rails = [...mounted.container.querySelectorAll<HTMLElement>(".cm-line.cm-access-rail")];
  assert.ok(rails.some((line) => line.dataset.accessRail === "identity role" && line.textContent!.startsWith("model Note")));
  assert.ok(!rails.some((line) => line.textContent!.startsWith("model Membership")), "a model outside the API has no rail");
  ui.fireEvent.mouseDown(chips.Note!, { button: 0 });
  assert.deepEqual(opened.map((position) => ref.current!.lineNumberAt(position)), [governed.split("\n").findIndex((line) => line.startsWith("model Note")) + 1]);
  ui.act(() => ref.current!.reveal(governed.indexOf("nickname String?")));
  ui.fireEvent.keyDown(ui.screen.getByRole("textbox", { name: "Prisma schema source" }), { key: ".", code: "Period", ctrlKey: true });
  assert.equal(opened.length, 2, "Ctrl+. inspects the declaration at the cursor");
  assert.deepEqual(changes, [], "opening access never edits the source");
});

test("typing in a directive keeps the source exact and undoable", () => {
  const changes: string[] = [];
  const ref = createRef<PrismaEditorHandle>();
  ui.render(h(component.PrismaEditor, { ref, value: governed, onChange: (text: string) => changes.push(text) }));
  const at = governed.indexOf("serverOnly");
  ui.act(() => ref.current!.replace(at, at + "serverOnly".length, "readonly"));
  assert.equal(changes.at(-1), governed.replace("@access(serverOnly)", "@access(readonly)"));
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), governed);
});

test("familiar search and replace edits the draft with native undo", async () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  ui.render(h(component.PrismaEditor, { ref, value: contract, onChange: (text: string) => changes.push(text) }));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const modifier = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  ui.fireEvent.keyDown(content, { key: "h", code: "KeyH", ...modifier });
  const search = await ui.screen.findByPlaceholderText("Find");
  const replacement = ui.screen.getByPlaceholderText("Replace");
  ui.fireEvent.change(search, { target: { value: "nickname" } });
  ui.fireEvent.change(replacement, { target: { value: "displayName" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "replace all" }));
  assert.ok(changes.at(-1)?.includes("displayName String?"));
  assert.ok(changes.at(-1)?.includes('@map("display_name")'), "physical mapping survives text replacement");
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), contract);
});

test("the editor leaves the browser's find shortcut alone, and its own search finds and edits directive text", () => {
  const ref = createRef<PrismaEditorHandle>();
  const changes: string[] = [];
  ui.render(h(component.PrismaEditor, { ref, value: governed, onChange: (text: string) => changes.push(text) }));
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const modifier = process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
  assert.equal(ui.fireEvent.keyDown(content, { key: "f", code: "KeyF", ...modifier }), true, "Ctrl/Cmd+F stays the browser's");
  assert.equal(ui.screen.queryByPlaceholderText("Find"), null);
  ui.fireEvent.keyDown(content, { key: "f", code: "KeyF", altKey: true, ...modifier });
  ui.fireEvent.change(ui.screen.getByPlaceholderText("Find"), { target: { value: "serverOnly" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "next" }));
  const selection = ref.current!.getSelection();
  assert.equal(governed.slice(selection.from, selection.to), "serverOnly");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "close" }));
  ui.fireEvent.keyDown(content, { key: "Backspace", code: "Backspace" });
  assert.equal(changes.at(-1), governed.replace("@access(serverOnly)", "@access()"), "only the selected text is deleted");
  ui.act(() => ref.current!.undo());
  assert.equal(changes.at(-1), governed);
});

test("View as dims fields the persona cannot read, and leaves no trace without a lens", () => {
  const no = { level: "no" as const }, yes = { level: "yes" as const };
  const lens = { label: "Member", models: {
    User: { model: "User", visible: yes, create: no, delete: no, coverage: { evaluated: 1, total: 1, truncated: false }, assumptions: [], fields: {
      id: { read: yes, write: no, values: [] },
      nickname: { read: no, write: no, values: [] },
    } },
    Note: { model: "Note", visible: yes, create: no, delete: no, coverage: { evaluated: 1, total: 1, truncated: false }, assumptions: [], fields: { draft: { read: no, write: no, values: [] } } },
  } };
  const mounted = ui.render(h(component.PrismaEditor, { value: governed, onChange: () => {}, lens }));
  assert.deepEqual([...mounted.container.querySelectorAll(".cm-lens-dim")].map((line) => line.textContent?.trim().split(" ")[0]), ["nickname", "draft"]);
  mounted.rerender(h(component.PrismaEditor, { value: governed, onChange: () => {} }));
  assert.equal(mounted.container.querySelectorAll(".cm-lens-dim").length, 0);
});

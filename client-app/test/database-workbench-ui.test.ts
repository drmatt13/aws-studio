import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { createElement as h } from "react";
import type { EditorView } from "@codemirror/view";
import type { SnapshotResponse } from "../shared/api";
import type { ModeModel, Snapshot } from "../shared/model";
import type { DatabaseSaveResult, DatabaseSourceReview, DatabaseValidation, DatabaseWorkbench } from "../shared/database-workbench";
import { parseDeclaredSchema } from "../server/database";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

const require = createRequire(import.meta.url);
const source = `// use prisma-8
// Keep comments and physical mappings.
model Person {
  id Uuid @id
}
model Entry {
  id Uuid @id
  title String @map("entry_title") // do not lose this
  ownerId Uuid
  owner Person @relation(fields: [ownerId], references: [id])
  @@map("entries")
}
`;
/** Access directives on the same models: a principal, a role scope, and rules on Entry. */
const governedSource = `// use prisma-8
/// @access(edit: [EDITOR])
enum Rank {
  /// @access(...READER)
  EDITOR
  /// @access(read)
  READER
}
enum SeatState {
  ACTIVE
  LEFT
}
/// @access(read: id == auth.id)
model User {
  id Uuid @id
  seats Seat[]
  entries Entry[]
}
/// @access(roles: seats[state=ACTIVE].rank)
model Group {
  id Uuid @id
  seats Seat[]
}
model Seat {
  groupId Uuid
  userId Uuid
  rank Rank
  state SeatState
  group Group @relation(fields: [groupId], references: [id])
  user User @relation(fields: [userId], references: [id])
  @@id([groupId, userId])
}
/// @access(read, update(title): ownerId == auth.id)
model Entry {
  id Uuid @id
  title String @map("entry_title") // do not lose this
  ownerId Uuid
  owner User @relation(fields: [ownerId], references: [id])
  @@map("entries")
}
`;
let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let query: typeof import("@tanstack/react-query");
let studio: typeof import("../src/studio");
let database: typeof import("../src/views/Database");
let history: typeof import("../src/views/DatabaseHistory");
let cloud: typeof import("../src/views/DatabaseCloud");
let dom: { window: Window & typeof globalThis };
let persisted: DatabaseWorkbench;
let sourceReviews: DatabaseSourceReview[];
let saves: string[];
let saveGate: Promise<void> | undefined;
let refreshUnavailable: boolean;
let contractImpact: DatabaseSaveResult["contractImpact"];
let fullscreenElement: Element | null = null;
let activeStudio: ReturnType<typeof import("../src/studio").useStudio>;
const clients: import("@tanstack/react-query").QueryClient[] = [];
const cloudPlacement = { binding: "fixture-launch-and-logs", launch: { cluster: "arn:aws:ecs:us-east-1:123456789012:cluster/production", containerName: "Main", launchType: "FARGATE", platformVersion: "LATEST", subnets: ["subnet-public"], securityGroups: ["sg-task"], assignPublicIp: true }, logs: { group: "database-logs", streamPrefix: "task" } };

function validate(text: string): DatabaseValidation {
  const parsed = parse(text, "contract.prisma");
  const file = parsed.sources.sourceFileFor(parsed.document.syntax);
  return { sourceHash: text, valid: !parsed.diagnostics.length,
    diagnostics: parsed.diagnostics.map(item => ({ from: file.offsetAt(item.range.start), to: file.offsetAt(item.range.end), severity: "error" as const, code: item.code, message: item.message })),
    schema: parsed.diagnostics.length ? undefined : parseDeclaredSchema(text), storageHash: text, executionHash: text, validatedAt: "2026-10-22T12:00:00Z" };
}
function workbench(text = source, revision = "source-revision"): DatabaseWorkbench {
  return { source: text, revision, configRevision: "config", file: "packages/database/prisma/contract.prisma", validation: validate(text), capabilities: { dialect: "Prisma 8", semanticValidation: true, formatting: true, languageServer: false, notes: ["Completion is curated syntax assistance; semantic validation uses pinned Prisma."] }, targets: [
    { id: "local:postgres", label: "Development PostgreSQL", available: true, identity: "local-identity", detail: "Read only; does not start Compose." },
    { id: "production", label: "Production RDS", available: false, identity: "production-identity", detail: "Private IAM and TLS access required." },
  ] };
}
function snapshot(): Snapshot {
  const mode = (mode: "dev" | "prod"): ModeModel => ({ mode, status: "ok", targets: [], routes: [], resources: [], edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 });
  return { revision: "graph-revision", repositoryRoot: "/fixture", generatedAt: "2026-10-22T12:00:00Z", descriptions: { values: {} }, schema: parseDeclaredSchema(source), databaseProblems: [], models: { dev: mode("dev"), prod: mode("prod") }, files: {}, source: { cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, entities: {}, editability: {}, links: {}, catalog: {}, problems: [] } };
}

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "Window", "HTMLElement", "HTMLDialogElement", "Element", "Node", "Text", "MutationObserver", "DOMRect", "Range", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  dom.window.HTMLElement.prototype.requestFullscreen = async function () {
    fullscreenElement = this;
    document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
  document.exitFullscreen = async () => {
    fullscreenElement = null;
    document.dispatchEvent(new dom.window.Event("fullscreenchange"));
  };
  ui = require("@testing-library/react"); router = require("@tanstack/react-router"); query = require("@tanstack/react-query");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  studio = await import("../src/studio"); database = await import("../src/views/Database"); history = await import("../src/views/DatabaseHistory");
  cloud = await import("../src/views/DatabaseCloud");
});
beforeEach(() => {
  fullscreenElement = null;
  persisted = workbench(); sourceReviews = []; saves = []; saveGate = undefined; refreshUnavailable = false; contractImpact = undefined;
  mock.method(database.databaseApi, "load", async () => persisted);
  mock.method(database.databaseApi, "validate", async (text: string) => validate(text));
  mock.method(database.databaseApi, "review", async (text: string, expectedRevision: string) => {
    const validation = validate(text);
    if (!validation.valid) throw new Error("Finish the invalid Prisma draft before saving. Nothing was written.");
    const reviewed: DatabaseSourceReview = { reviewId: `review-${sourceReviews.length}`, file: persisted.file, before: persisted.source, after: text, expectedRevision, sourceHash: text, configRevision: "config", validation, effects: ["Writes authored contract only. No migration, database or deployment changes."], expiresAt: "2026-10-22T13:00:00Z", contractImpact };
    sourceReviews.push(reviewed); return reviewed;
  });
  mock.method(database.databaseApi, "save", async (id: string) => {
    saves.push(id); await saveGate;
    const reviewed = sourceReviews.find(item => item.reviewId === id)!;
    persisted = workbench(reviewed.after, "saved-revision");
    return { saved: true, source: persisted.source, revision: persisted.revision, file: persisted.file, refresh: refreshUnavailable ? "unavailable" as const : "complete" as const, message: refreshUnavailable ? "Source saved; graph refresh unavailable. Refresh separately." : "Source saved.", ...(contractImpact ? { contractImpact } : {}) };
  });
  mock.method(history.historyApi, "load", async () => ({ revision: "history", sourceHash: persisted.revision, migrations: [], snapshots: [], heads: [], refs: [], issues: [], observedAt: "2026-10-22T12:00:00Z" }));
  mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).startsWith("/api/deploy/local")) return Response.json({ project: "fixture", docker: { engine: "running" }, services: [], watch: { running: false }, client: { running: false }, exported: { client: false }, startedBy: "none", restartNeeded: [] });
    if (String(input) === "/api/database/application/operations") return Response.json([]);
    // The access popup reads client operations to see which permissions are API surface.
    if (String(input).startsWith("/api/graphql/workspace")) return Response.json({ revision: "fixture", schema: { status: "missing", types: [], diagnostics: [] }, client: { status: "missing", documents: [], features: [], diagnostics: [] } });
    throw new Error(`Unexpected workbench request: ${String(input)}`);
  });
});
afterEach(() => { ui.cleanup(); for (const client of clients.splice(0)) client.clear(); mock.restoreAll(); dom.window.localStorage.clear(); });
after(() => dom.window.close());

async function mount(associations: { dev?: string; prod?: string } = { dev: "dev", prod: "production-connection" }) {
  const response: SnapshotResponse = { snapshot: snapshot(), evaluating: false, commands: {}, busy: null };
  dom.window.localStorage.setItem(`aws-studio:mode-profiles:v1:${response.snapshot.repositoryRoot}`, JSON.stringify(associations));
  function Workbench() { activeStudio = studio.useStudio(); return h("div", null, h(router.Link, { to: "/other" }, "Open other view"), h(router.Outlet)); }
  function Root() { return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h(Workbench) }); }
  const root = router.createRootRoute({ component: Root });
  const databaseRoute = router.createRoute({ getParentRoute: () => root, path: "/database", component: database.Database });
  const application = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/database"] }), routeTree: root.addChildren([
    databaseRoute.addChildren(["history", "status", "sql", "retention"].map(path => router.createRoute({ getParentRoute: () => databaseRoute, path, component: () => null }))),
    router.createRoute({ getParentRoute: () => root, path: "/other", component: () => h("p", null, "Other view reached") }),
    router.createRoute({ getParentRoute: () => root, path: "/graphql/schema", component: () => h("p", null, "Contract workflow reached") }),
  ]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: application })));
  await ui.screen.findByRole("textbox", { name: "Prisma schema source" });
  return application;
}
function editor(): EditorView { return require("@codemirror/view").EditorView.findFromDOM(ui.screen.getByRole("textbox", { name: "Prisma schema source" }))!; }
function replaceText(old: string, next: string) {
  const view = editor(), from = view.state.doc.toString().indexOf(old); assert.ok(from >= 0);
  ui.act(() => view.dispatch({ changes: { from, to: from + old.length, insert: next }, annotations: require("@codemirror/commands").isolateHistory.of("full") }));
}
function splitSchema() {
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Split source and diagram" }));
}
async function openAccessFor(symbol: string) {
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Jump to model or enum" }), { target: { value: symbol } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: /^Access$/ }));
  return ui.screen.findByRole("dialog", { name: `Access for ${symbol}` });
}
async function validateDraft() { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Validate draft" })); await ui.waitFor(() => assert.ok(!ui.screen.queryByText("Validating…"))); }
async function openStatus(mode: "dev" | "prod" = "dev") {
  ui.act(() => activeStudio.setMode(mode));
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Database status" }));
  await ui.screen.findByRole("heading", { name: mode === "prod" ? "Production database" : "Local database" });
}

test("diagram fields navigate to source and cursor navigation highlights their logical and physical identities", async () => {
  await mount();
  splitSchema();
  const view = editor();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Locate Entry.title" }));
  const selection = view.state.selection.main;
  assert.match(view.state.sliceDoc(selection.from, selection.to), /title String @map\("entry_title"\)/);
  assert.match(document.querySelector("[data-ui~=\"workbench-entity-details\"]")!.textContent!, /Entry\.title/);
  assert.match(document.querySelector("[data-ui~=\"workbench-entity-details\"]")!.textContent!, /entry_title/);
  const person = source.indexOf("id Uuid");
  ui.act(() => view.dispatch({ selection: { anchor: person } }));
  assert.equal(ui.screen.getByRole("button", { name: "Select table Person" }).getAttribute("aria-pressed"), "true");
});

test("temporarily invalid drafts retain the labeled last-valid diagram and preserve editor undo", async () => {
  await mount();
  splitSchema();
  const content = ui.screen.getByRole("textbox", { name: "Prisma schema source" });
  const view = editor();
  replaceText("title String", "title String?"); await validateDraft();
  replaceText("title String?", "title ???"); await validateDraft();
  assert.ok(ui.screen.getByText("Invalid draft"));
  assert.ok(ui.screen.getByText(/Last valid diagram/));
  assert.equal(ui.screen.getByRole("textbox", { name: "Prisma schema source" }), content);
  const oldSelection = view.state.selection.main;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Locate Entry.title" }));
  assert.deepEqual(view.state.selection.main, oldSelection, "source navigation pauses while last-valid diagram is retained");
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.match(view.state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("source review requires explicit Save schema and keeps text, comments and mapping through review", async () => {
  await mount();
  replaceText("title String", "displayName String"); await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.equal(sourceReviews.length, 1); assert.equal(saves.length, 0);
  assert.match(ui.screen.getByLabelText("Proposed source").textContent!, /displayName String @map\("entry_title"\)/);
  assert.match(ui.screen.getByLabelText("Proposed source").textContent!, /do not lose this/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to editing" }));
  assert.equal(saves.length, 0); assert.match(editor().state.doc.toString(), /displayName/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save schema" }));
  await ui.waitFor(() => assert.ok(!ui.screen.queryByRole("dialog"), "source review closes after save"));
  assert.deepEqual(saves, ["review-1"]);
  assert.ok(ui.screen.getByText("Saved source", { selector: "[data-ui~=\"workbench-badge\"]" }));
});

test("a saved Prisma change shows its impact and continues to the API stage without validating the chain", async () => {
  contractImpact = { revision: "saved-revision", beforeRevision: "source-revision", models: ["Entry"], diffs: [{ surface: "prisma", subject: "Entry", path: "Entry.displayName", change: "added", before: null, after: "String" }], semantics: "changed", stages: ["api", "codegen", "client"], earliestStage: "api" };
  const application = await mount();
  replaceText("title String", "displayName String"); await validateDraft();
  assert.equal(ui.screen.queryByRole("region", { name: "Saved contract impact" }), null, "draft edits are not saved-source impact");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Save schema" }));
  const impact = await ui.screen.findByRole("region", { name: "Saved contract impact" });
  assert.ok(ui.within(impact).getByText("Next: Repository and API"));
  assert.ok(ui.within(impact).getByText("Entry.displayName"));
  ui.fireEvent.click(ui.within(impact).getByRole("link", { name: "Continue contract update" }));
  await ui.screen.findByText("Contract workflow reached");
  assert.equal(application.state.location.pathname, "/graphql/schema");
  assert.equal(saves.length, 1);
});

test("the source opens an anchored policy popup and review includes policy impact", async () => {
  persisted = workbench(governedSource);
  await mount();
  const view = editor();
  await ui.waitFor(() => assert.ok(document.querySelector(".cm-access-pill")));
  const trigger = ui.screen.getByRole("button", { name: /^Access$/ });
  const pane = await openAccessFor("Entry");
  assert.ok(ui.within(pane).getByRole("heading", { name: "Entry" }));
  assert.ok(ui.within(pane).getByText("Access · Rules"));
  assert.equal(document.querySelector('[data-ui="workbench-split"]')?.getAttribute("data-mode"), "source");
  ui.fireEvent.keyDown(pane, { key: "Escape" });
  await ui.waitFor(() => assert.equal(document.activeElement, trigger));
  assert.equal(editor(), view);

  contractImpact = { revision: "draft", beforeRevision: "source-revision", models: ["Entry"], diffs: [], accessChanges: [{ surface: "prisma", subject: "Entry", path: "Entry · rules", change: "changed", before: "read, update(title): ownerId == auth.id", after: "read: ownerId == auth.id" }], semantics: "changed", stages: ["api", "codegen", "client"], earliestStage: "api" };
  replaceText("read, update(title): ownerId", "read: ownerId");
  await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  const review = await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.ok(ui.within(review).getByRole("region", { name: "Access policy changes" }).textContent!.includes("Entry · rules"));
  assert.deepEqual(saves, []);
});

test("Ctrl+., a model's scope chip and a diagram field open the inspector at their declaration without editing", async () => {
  persisted = workbench(governedSource);
  await mount();
  splitSchema();
  const view = editor();
  ui.act(() => view.dispatch({ selection: { anchor: governedSource.indexOf("title String") } }));
  // Ctrl+. is bound on every platform, so this does not depend on jsdom's platform.
  ui.fireEvent.keyDown(view.contentDOM, { key: ".", code: "Period", ctrlKey: true });
  let pane = await ui.screen.findByRole("dialog", { name: "Access for Entry.title" });
  assert.ok(ui.within(pane).getByRole("heading", { name: "Entry.title" }));
  assert.match(ui.within(pane).getByText("Update").nextElementSibling!.textContent!, /owner/i);

  ui.fireEvent.click(ui.within(pane).getByRole("button", { name: "Close access inspector" }));
  const chip = await ui.waitFor(() => {
    const found = document.querySelector<HTMLElement>('.cm-access-scope-chip[data-access-model="Group"]');
    assert.ok(found);
    return found;
  });
  assert.equal(chip.textContent, "Group roles");
  ui.fireEvent.mouseDown(chip, { button: 0 });
  pane = await ui.screen.findByRole("dialog", { name: "Access for Group" });
  await ui.waitFor(() => assert.ok(ui.within(pane).getByRole("heading", { name: "Group" })));
  ui.fireEvent.click(ui.within(pane).getByRole("button", { name: "Close access inspector" }));

  await validateDraft();
  ui.fireEvent.contextMenu(ui.screen.getByRole("button", { name: /^Locate Entry\.title/ }));
  pane = await ui.screen.findByRole("dialog", { name: "Access for Entry.title" });
  await ui.waitFor(() => assert.ok(ui.within(pane).getByRole("heading", { name: "Entry.title" })));
  assert.equal(editor().state.doc.toString(), governedSource, "inspecting never edits the draft");
  assert.equal(sourceReviews.length + saves.length, 0);
});

test("the matrix popup stages one undoable cell edit and source links dismiss it", async () => {
  persisted = workbench(governedSource);
  await mount();
  const matrix = await ui.screen.findByRole("button", { name: "Role permissions for Rank" });
  ui.fireEvent.mouseDown(matrix, { button: 0 });
  const pane = await ui.screen.findByRole("dialog", { name: "Access for Rank" });
  assert.ok(ui.within(pane).getByText("Role permissions"));
  assert.equal(ui.within(pane).getByRole("button", { name: "EDITOR holds read from READER" }).getAttribute("aria-disabled"), "true");
  ui.fireEvent.click(ui.within(pane).getByRole("button", { name: "READER does not hold edit. Toggle" }));
  await ui.waitFor(() => assert.equal(editor().state.doc.toString(), governedSource.replace("edit: [EDITOR]", "edit: [EDITOR, READER]")));
  assert.equal(sourceReviews.length + saves.length, 0, "changing a cell only edits the draft");
  ui.act(() => require("@codemirror/commands").undo(editor()));
  assert.equal(editor().state.doc.toString(), governedSource, "one edit, one undo");
  ui.fireEvent.click(ui.within(pane).getByRole("button", { name: /^edit$/ }));
  await ui.waitFor(() => assert.equal(editor().state.doc.lineAt(editor().state.selection.main.head).text, "/// @access(edit: [EDITOR])"));

  assert.equal(ui.screen.queryByRole("dialog", { name: "Access for Rank" }), null);
  const modelPopup = await openAccessFor("Entry");
  ui.fireEvent.click(ui.within(modelPopup).getAllByRole("button", { name: /^Show line \d+ in source$/ })[0]!);
  await ui.waitFor(() => assert.equal(editor().state.doc.lineAt(editor().state.selection.main.head).text, "/// @access(read, update(title): ownerId == auth.id)"));
});

test("discard asks deliberately, preserves undo and never writes source", async () => {
  await mount(); replaceText("title String", "title String?");
  const view = editor(), content = view.contentDOM;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  await ui.screen.findByRole("dialog", { name: "Discard schema draft?" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep editing" }));
  assert.match(view.state.doc.toString(), /title String\?/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Discard draft" }));
  assert.equal(view.state.doc.toString(), source);
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("button", { name: "Validate draft" }), "discarding returns focus to a source action that remains available"));
  assert.equal(editor().contentDOM, content);
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.match(view.state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("route navigation and browser exit protect an unsaved schema and allow explicit discard", async () => {
  const application = await mount(); replaceText("title String", "title String?");
  const exit = new dom.window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(exit); assert.equal(exit.defaultPrevented, true);
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Open other view" }));
  await ui.screen.findByRole("dialog", { name: "Leave your schema draft?" });
  await ui.act(async () => { ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep editing" })); });
  // The pathname never changed while blocked. Wait for cancellation and the
  // actual guard dismissal before requesting another navigation.
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog", { name: "Leave your schema draft?" }), null));
  assert.equal(application.state.location.pathname, "/database");
  assert.match(editor().state.doc.toString(), /title String\?/);
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Open other view" }));
  const nextGuard = await ui.screen.findByRole("dialog", { name: "Leave your schema draft?" });
  ui.fireEvent.click(ui.within(nextGuard).getByRole("button", { name: "Discard and continue" }));
  await ui.screen.findByText("Other view reached");
  assert.equal(saves.length, 0);
});

test("schema draft, cursor and undo survive database routes, browser back and declaration modes", async () => {
  const application = await mount();
  const view = editor(), content = view.contentDOM;
  replaceText("title String", "title String?"); await validateDraft();
  const anchor = view.state.doc.toString().indexOf("title String?");
  ui.act(() => view.dispatch({ selection: { anchor } }));
  const selection = view.state.selection.main;
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "History & migrations" }));
  await ui.waitFor(() => assert.equal(application.state.location.pathname, "/database/history"));
  await ui.screen.findByRole("heading", { name: "Migrations" });
  assert.equal(ui.screen.queryByRole("dialog", { name: "Leave your schema draft?" }), null);
  ui.act(() => activeStudio.setMode("prod"));
  assert.equal(activeStudio.mode, "prod");
  await openStatus("prod");
  assert.equal(application.state.location.pathname, "/database/status");
  await ui.act(async () => { application.history.back(); });
  await ui.waitFor(() => assert.equal(application.state.location.pathname, "/database/history"));
  await ui.act(async () => { application.history.back(); });
  await ui.waitFor(() => assert.equal(application.state.location.pathname, "/database"));
  await ui.screen.findByRole("textbox", { name: "Prisma schema source" });
  assert.equal(editor(), view);
  assert.equal(editor().contentDOM, content);
  assert.deepEqual(view.state.selection.main, selection);
  assert.match(view.state.doc.toString(), /title String\?/);
  assert.equal(activeStudio.mode, "prod");
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.equal(view.state.doc.toString(), source);
  assert.equal(saves.length, 0);
});

test("external save conflict preserves editor identity and offers an explicit latest-source review", async () => {
  await mount(); replaceText("title String", "title String?");
  const content = editor().contentDOM;
  persisted = workbench(source.replace("title String", "title VarChar(200)"), "external-revision");
  ui.fireEvent(window, new dom.window.Event("focus"));
  await ui.screen.findByText("Saved source changed outside this session.");
  assert.equal(editor().contentDOM, content); assert.match(editor().state.doc.toString(), /title String\?/);
  assert.equal((ui.screen.getByRole("button", { name: "Review source changes" }) as HTMLButtonElement).disabled, true);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review draft against latest source" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.equal(sourceReviews[0]?.expectedRevision, "external-revision");
  assert.match(ui.screen.getByLabelText("Saved source").textContent!, /VarChar\(200\)/);
  assert.equal(saves.length, 0);
});

test("workbench help opens a modal and dismissing it returns focus without changing the draft", async () => {
  await mount(); replaceText("title String", "title String?");
  const view = editor();
  const trigger = ui.screen.getByRole("button", { name: "How this works" });
  assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  assert.equal(ui.screen.queryByRole("dialog", { name: "How this works" }), null);
  trigger.focus();
  ui.fireEvent.click(trigger);
  const help = await ui.screen.findByRole("dialog", { name: "How this works" });
  assert.equal((help as HTMLDialogElement).open, true);
  assert.match(help.textContent!, /Saving only writes/);
  ui.fireEvent(help, new dom.window.Event("cancel", { cancelable: true }));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog", { name: "How this works" }), null));
  assert.equal(document.activeElement, trigger);
  ui.fireEvent.click(trigger);
  await ui.screen.findByRole("dialog", { name: "How this works" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Got it" }));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog", { name: "How this works" }), null));
  assert.equal(document.activeElement, trigger);
  assert.equal(editor(), view);
  assert.match(view.state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("keyboard resizing and schema focus modes preserve keyboard focus and the same editor session", async () => {
  await mount(); const view = editor();
  assert.ok(!ui.screen.queryByText("Next: understand database evolution"));
  splitSchema();
  const separator = ui.screen.getByRole("separator", { name: "Resize source and diagram" });
  ui.fireEvent.keyDown(separator, { key: "End" }); assert.equal(separator.getAttribute("aria-valuenow"), "75");
  ui.fireEvent.keyDown(separator, { key: "Home" }); assert.equal(separator.getAttribute("aria-valuenow"), "25");
  const sourceControl = ui.screen.getByRole("button", { name: "Focus source" });
  sourceControl.focus();
  ui.fireEvent.click(sourceControl);
  assert.equal(document.querySelector("[data-ui~=\"workbench-split\"]")?.getAttribute("data-mode"), "source");
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("button", { name: "Focus source" }), "entering source-only mode preserves focus on its layout control"));
  const diagramControl = ui.screen.getByRole("button", { name: "Focus diagram" });
  diagramControl.focus();
  ui.fireEvent.click(diagramControl);
  assert.equal(document.querySelector("[data-ui~=\"workbench-split\"]")?.getAttribute("data-mode"), "diagram");
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("button", { name: "Focus diagram" }), "leaving source-only mode preserves focus on its layout control"));
  const controls = ui.screen.getByRole("group", { name: "Editing layout" });
  assert.equal(ui.within(controls).getByRole("button", { name: "Focus diagram" }).getAttribute("aria-pressed"), "true");
  const splitControl = ui.screen.getByRole("button", { name: "Split source and diagram" });
  splitControl.focus();
  ui.fireEvent.click(splitControl);
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("button", { name: "Split source and diagram" })));
  assert.equal(editor(), view);
});

test("one workspace fullscreen control preserves each layout, draft, selection and undo and restores keyboard focus on browser exit", async () => {
  await mount();
  replaceText("title String", "title String?");
  const view = editor();
  ui.act(() => view.dispatch({ selection: { anchor: 25 } }));
  const selection = view.state.selection.main;
  for (const layout of [{ mode: "split", label: "Split source and diagram" }, { mode: "source", label: "Focus source" }, { mode: "diagram", label: "Focus diagram" }]) {
    ui.fireEvent.click(ui.screen.getByRole("button", { name: layout.label }));
    const triggers = ui.screen.getAllByRole("button", { name: "Fullscreen schema workspace" });
    assert.equal(triggers.length, 1, "fullscreen is a single shared workspace action");
    const trigger = triggers[0]!;
    trigger.focus();
    ui.fireEvent.click(trigger);
    await ui.waitFor(() => assert.ok(document.fullscreenElement === document.querySelector("[data-ui~=\"database-workbench\"]"), "workbench enters fullscreen"));
    assert.equal(document.querySelector("[data-ui~=\"workbench-split\"]")?.getAttribute("data-mode"), layout.mode);
    assert.equal(editor(), view);
    assert.deepEqual(view.state.selection.main, selection);
    assert.match(view.state.doc.toString(), /title String\?/);
    // The same event is emitted when the browser handles Escape.
    await ui.act(() => document.exitFullscreen());
    await ui.waitFor(() => assert.ok(document.activeElement === trigger, "keyboard focus returns to the fullscreen trigger"));
    assert.equal(document.querySelector("[data-ui~=\"workbench-split\"]")?.getAttribute("data-mode"), layout.mode);
  }
  ui.act(() => require("@codemirror/commands").undo(view));
  assert.equal(view.state.doc.toString(), source);
  assert.equal(saves.length, 0);
});

test("fullscreen keeps layout switching and source review available; exit returns to the original focus mode", async () => {
  await mount(); replaceText("title String", "title String?"); await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Focus source" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fullscreen schema workspace" }));
  await ui.waitFor(() => assert.ok(document.fullscreenElement));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Split source and diagram" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Focus diagram" }));
  await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Discard" }));
  await ui.screen.findByRole("dialog", { name: "Discard schema draft?" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Keep editing" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  const review = await ui.screen.findByRole("dialog", { name: "Review source changes" });
  assert.ok(document.fullscreenElement!.contains(review), "review must be visible within the fullscreen element");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back to editing" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Exit fullscreen" }));
  await ui.waitFor(() => assert.equal(document.fullscreenElement, null));
  assert.equal(document.querySelector("[data-ui~=\"workbench-split\"]")?.getAttribute("data-mode"), "source");
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("button", { name: "Fullscreen schema workspace" }), "focus returns to the current fullscreen control after changing layouts"));
  assert.equal(saves.length, 0);
});

test("a rejected fullscreen request restores the workspace and preserves unsaved text", async () => {
  await mount(); replaceText("title String", "title String?");
  mock.method(dom.window.HTMLElement.prototype, "requestFullscreen", async () => { throw new Error("Denied by browser"); });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fullscreen schema workspace" }));
  await ui.screen.findByText(/The browser could not change fullscreen mode/);
  assert.equal(document.fullscreenElement, null);
  assert.equal(document.querySelector("[data-ui~=\"workbench-split\"]")?.getAttribute("data-mode"), "source");
  assert.match(editor().state.doc.toString(), /title String\?/);
  assert.equal(saves.length, 0);
});

test("save freezes the reviewed draft and remains a source success when graph refresh fails", async () => {
  await mount(); replaceText("title String", "title String?"); await validateDraft();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Fullscreen schema workspace" }));
  await ui.waitFor(() => assert.ok(document.fullscreenElement));
  let finish!: () => void;
  saveGate = new Promise<void>(resolve => { finish = resolve; }); refreshUnavailable = true;
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review source changes" }));
  await ui.screen.findByRole("dialog", { name: "Review source changes" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save schema" }));
  await ui.waitFor(() => assert.equal(editor().state.readOnly, true));
  assert.equal((ui.screen.getByRole("button", { name: "Back to editing" }) as HTMLButtonElement).disabled, true);
  assert.equal(persisted.source, source, "no source success is claimed before the response");
  await ui.act(async () => { finish(); await saveGate; });
  await ui.waitFor(() => assert.ok(!ui.screen.queryByRole("dialog"), "review closes after successful source write"));
  assert.match(persisted.source, /title String\?/);
  assert.ok(ui.screen.getByText("Saved source", { selector: "[data-ui~=\"workbench-badge\"]" }));
  const feedback = await ui.screen.findByText("Source saved; graph refresh unavailable. Refresh separately.");
  assert.ok(document.fullscreenElement!.contains(feedback), "partial-effect feedback remains visible in fullscreen");
  assert.equal(saves.length, 1);
});

test("inspection stays explicit and a late local response cannot cross declaration modes", async () => {
  let resolveObservation!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveObservation = resolve; });
  const bodies: { targetId: string }[] = [];
  const metadataFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/database/workbench/inspect") {
      bodies.push(JSON.parse(String(init?.body)));
      return pending;
    }
    return metadataFetch(input as RequestInfo, init);
  });
  await mount();
  await openStatus();
  assert.equal(ui.screen.queryByRole("combobox", { name: "Database target" }), null);
  assert.equal(bodies.length, 0);
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("button", { name: "Inspect database" }) as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Inspect database" }));
  await ui.waitFor(() => assert.equal(bodies.length, 1));
  assert.equal(bodies[0]?.targetId, "local:postgres");
  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: "Production database" });
  await ui.act(async () => {
    resolveObservation(Response.json({ id: "local-observation", targetId: "local:postgres", targetIdentity: "local-identity", observedAt: "2026-10-22T12:00:00Z", savedRevision: "source-revision", historyRevision: "history", baseline: { label: "Saved source" }, status: "observed", marker: { status: "matches" }, physical: { status: "matches", issues: [], warnings: [] }, migrationState: { status: "current", message: "Fixture is current" }, ledger: [], message: "Local-only observation marker", limits: [] }));
    await pending;
  });
  assert.ok(!ui.screen.queryByText("Local-only observation marker"));
  assert.ok(ui.within(ui.screen.getByRole("region", { name: "Database readiness" })).getByText("Not checked", { exact: true }));
  ui.act(() => activeStudio.setMode("dev"));
  await ui.screen.findByRole("heading", { name: "Local database" });
  assert.ok(ui.within(ui.screen.getByRole("region", { name: "Database readiness" })).getByText("Not checked", { exact: true }));
  assert.equal(bodies.length, 1, "mode changes never implicitly inspect or write");
});

test("local pending migrations offer a separate reviewed action and mode changes expire its approval", async () => {
  const metadataFetch = globalThis.fetch;
  let inspections = 0, reviews = 0, applications = 0;
  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/database/workbench/inspect") {
      inspections++;
      return Response.json({ id: "pending-local", targetId: "local:postgres", targetIdentity: "local-identity", observedAt: "2026-10-22T12:00:00Z", savedRevision: "source-revision", historyRevision: "history", baseline: { label: "Saved source" }, status: "observed", marker: { status: "differs" }, physical: { status: "differs", issues: [], warnings: [] }, historicalPhysical: { storageHash: "origin", status: "matches", issues: [], warnings: [] }, migrationState: { status: "pending", message: "A reviewed forward path is available." }, ledger: [], message: "Local schema is behind saved source.", limits: [] });
    }
    if (String(input) === "/api/database/application/review") {
      assert.equal(JSON.parse(String(init?.body)).targetId, "local:postgres"); reviews++;
      return Response.json({ id: "local-review", targetId: "local:postgres", targetLabel: "Development PostgreSQL", targetIdentity: "local-identity", sourceHash: "source-revision", historyRevision: "history", from: "origin", to: "destination", createdAt: "2026-10-22T12:00:00Z", expiresAt: "2026-10-22T12:05:00Z", confirmation: "Development PostgreSQL", effects: ["Changes the reviewed local database only."], migrations: [{ id: "app/add-summary", name: "add_summary", migrationHash: "package", from: "origin", to: "destination", source: "// Reviewed migration source", operations: [] }] });
    }
    if (String(input) === "/api/database/application/apply") { applications++; throw new Error("This test never authorizes application."); }
    return metadataFetch(input as RequestInfo, init);
  });
  await mount(); await openStatus();
  assert.equal(ui.screen.queryByRole("button", { name: "Review pending migrations" }), null);
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("button", { name: "Inspect database" }) as HTMLButtonElement).disabled, false));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Inspect database" }));
  await ui.screen.findByText("Migrations pending", { selector: "h3" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review pending migrations" }));
  await ui.screen.findByRole("dialog", { name: "Authorize reviewed database application" });
  assert.equal((ui.screen.getByRole("button", { name: "Apply reviewed migration" }) as HTMLButtonElement).disabled, true);
  assert.deepEqual([inspections, reviews, applications], [1, 1, 0]);
  ui.act(() => activeStudio.setMode("prod"));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog", { name: "Authorize reviewed database application" }), null));
  assert.equal(ui.screen.queryByRole("button", { name: "Review pending migrations" }), null);
  assert.equal(applications, 0);
});

test("production database exposes pinned destination and billing before separate inspection and SQL approvals", async () => {
  persisted = { ...persisted, targets: persisted.targets.map(target => target.id === "production" ? { ...target, handoffs: [{ deployment: "production", account: "123456789012", region: "us-east-1", command: "", detail: "Private IAM/TLS task" }] } : target) };
  const identity = { deployment: "production", account: "123456789012", region: "us-east-1", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/database:7" };
  let preparations = 0, inspections = 0, applications = 0;
  const destination = { ...cloudPlacement, id: "prepared", expiresAt: "2026-10-22T13:00:00Z", profile: "production-connection", protocol: 1 as const, identity, effects: ["Inspect starts one billed Fargate task.", "Inspection never applies database changes."] };
  mock.method(cloud.databaseCloudApi, "prepare", async (deployment: string, profile: string) => { assert.equal(deployment, "production"); assert.equal(profile, "production-connection", "the Production declaration uses its own selected profile"); preparations++; return destination; });
  mock.method(cloud.databaseCloudApi, "review", async () => { inspections++; return { id: "approved", destination, profile: "production-connection", confirmation: "Apply production", expiresAt: destination.expiresAt, review: { version: 1 as const, identity, inputsDigest: "inputs", markerHash: "origin", markerIdentity: "markers", ledgerIdentity: "ledger", storageHash: "destination", helpers: [], digest: "exact-review", migrations: [{ spaceId: "app", dirName: "next", migrationHash: "edge", from: "origin", to: "destination", source: "Reviewed migration code", sql: [{ phase: "execute", sql: "ALTER TABLE entries ADD COLUMN archived boolean" }] }] } }; });
  mock.method(cloud.databaseCloudApi, "apply", async () => { applications++; return { status: "applied" as const, database: "applied" as const, source: "unchanged" as const, artifacts: "unchanged" as const, targetId: "production", message: "Reviewed production SQL applied.", applied: [] }; });
  const routed = await mount(); await openStatus("prod");
  assert.equal(ui.screen.queryByRole("button", { name: "Inspect database" }), null);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Production database deployment" }), { target: { value: "production" } });
  assert.deepEqual([preparations, inspections, applications], [0, 0, 0]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check database task destination" }));
  const preflight = await ui.screen.findByRole("dialog", { name: "Authorize billed read-only database inspection" });
  assert.match(preflight.textContent!, /123456789012.*us-east-1/); assert.match(preflight.textContent!, /task-definition\/database:7/); assert.match(preflight.textContent!, /billed Fargate/); assert.match(preflight.textContent!, /Public IP assignment: Enabled/); assert.match(preflight.textContent!, /subnet-public/); assert.match(preflight.textContent!, /sg-task/);
  assert.equal((ui.screen.getByRole("button", { name: "Start billed read-only task" }) as HTMLButtonElement).disabled, true);
  ui.act(() => routed.history.back());
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog"), null));
  ui.act(() => routed.history.forward());
  await ui.waitFor(() => assert.equal(routed.state.location.pathname, "/database/status"));
  assert.equal(ui.screen.queryByRole("dialog"), null, "returning to Status never reopens a discarded destination review");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check database task destination" }));
  await ui.screen.findByRole("dialog", { name: "Authorize billed read-only database inspection" });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Confirm production database action" }), { target: { value: "Inspect production" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Start billed read-only task" }));
  const review = await ui.screen.findByRole("dialog", { name: "Review production SQL and authorize application" });
  assert.match(review.textContent!, /ALTER TABLE entries ADD COLUMN archived boolean/); assert.equal(applications, 0);
  assert.equal((ui.screen.getByRole("button", { name: "Apply reviewed production SQL" }) as HTMLButtonElement).disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Confirm production database action" }), { target: { value: "Apply production" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Apply reviewed production SQL" }));
  await ui.screen.findByText("Reviewed production SQL applied.");
  assert.deepEqual([preparations, inspections, applications], [2, 1, 1]);
});

for (const changed of ["configuration", "history"] as const) test(`production approvals expire when ${changed} changes without changing contract text`, async () => {
  persisted = { ...persisted, targets: persisted.targets.map(target => target.id === "production" ? { ...target, handoffs: [{ deployment: "production", account: "123456789012", region: "us-east-1", command: "", detail: "Private IAM/TLS" }] } : target) };
  const identity = { deployment: "production", account: "123456789012", region: "us-east-1", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/database:7" };
  let preparations = 0, inspections = 0;
  mock.method(cloud.databaseCloudApi, "prepare", async () => { preparations++; return { ...cloudPlacement, id: "prepared", expiresAt: "2099-01-01T00:00:00Z", profile: "production-connection", protocol: 1 as const, identity, effects: ["A billed inspection needs separate approval."] }; });
  mock.method(cloud.databaseCloudApi, "review", async () => { inspections++; throw new Error("An expired review must not start a task."); });
  await mount(); await openStatus("prod");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check database task destination" }));
  await ui.screen.findByRole("dialog", { name: "Authorize billed read-only database inspection" });
  if (changed === "configuration") persisted = { ...persisted, configRevision: "changed-config" };
  else {
    persisted = { ...persisted }; // A fresh HTTP response, with identical source/config revisions.
    mock.method(history.historyApi, "load", async () => ({ revision: "changed-history", sourceHash: persisted.revision, migrations: [], snapshots: [], heads: [], refs: [], issues: [], observedAt: "2026-10-22T12:00:00Z" }));
  }
  await ui.act(async () => { window.dispatchEvent(new dom.window.Event("focus")); });
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog"), null));
  assert.deepEqual([preparations, inspections], [1, 0]);
});

test("empty production initialization previews complete steps/control DDL and has a distinct typed write action", async () => {
  persisted = { ...persisted, targets: persisted.targets.map(target => target.id === "production" ? { ...target, handoffs: [{ deployment: "production", account: "123456789012", region: "us-east-1", command: "", detail: "Private IAM/TLS" }] } : target) };
  const identity = { deployment: "production", account: "123456789012", region: "us-east-1", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/database:7" };
  const destination = { ...cloudPlacement, id: "prepared", expiresAt: "2026-10-22T13:00:00Z", profile: "production-connection", protocol: 1 as const, identity, effects: ["A billed read-only Fargate inspection."] };
  let writes = 0;
  mock.method(cloud.databaseCloudApi, "prepare", async () => destination);
  mock.method(cloud.databaseCloudApi, "review", async () => ({ id: "init-review", destination, profile: "production-connection", confirmation: "Initialize production", expiresAt: destination.expiresAt, review: { version: 1 as const, kind: "initialize" as const, identity, inputsDigest: "inputs", markerHash: "@empty", markerIdentity: "markers", ledgerIdentity: "ledger", storageHash: "current", digest: "complete-review", helpers: [], migrations: [], initialization: { operations: [{ id: "create", label: "Create entries", operationClass: "additive" }], operationsDigest: "all-native-ops", sql: ["CREATE TABLE entries (id uuid)"], statements: [{ operationId: "create", phase: "precheck", sql: "SELECT $1 AS result", params: [true] }, { operationId: "create", phase: "execute", sql: "CREATE TABLE entries (id uuid)" }], controlSql: [{ sql: "CREATE SCHEMA IF NOT EXISTS prisma_contract" }] } } }));
  mock.method(cloud.databaseCloudApi, "apply", async (_id: string, confirmation: string) => { assert.equal(confirmation, "Initialize production"); writes++; return { status: "applied" as const, database: "applied" as const, source: "unchanged" as const, artifacts: "unchanged" as const, targetId: "production", message: "Reviewed initialization applied.", applied: [] }; });
  await mount(); await openStatus("prod");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Production database deployment" }), { target: { value: "production" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check database task destination" }));
  await ui.screen.findByRole("dialog", { name: "Authorize billed read-only database inspection" });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Confirm production database action" }), { target: { value: "Inspect production" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Start billed read-only task" }));
  const dialog = await ui.screen.findByRole("dialog", { name: "Review empty production database initialization" });
  assert.match(dialog.textContent!, /SELECT \$1 AS result/); assert.match(dialog.textContent!, /Parameters: \[true\]/); assert.match(dialog.textContent!, /CREATE SCHEMA IF NOT EXISTS prisma_contract/);
  const apply = ui.screen.getByRole("button", { name: "Initialize reviewed production database" }) as HTMLButtonElement;
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Confirm production database action" }), { target: { value: "Apply production" } });
  assert.equal(apply.disabled, true); assert.equal(writes, 0);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Confirm production database action" }), { target: { value: "Initialize production" } });
  assert.equal(apply.disabled, false); ui.fireEvent.click(apply); await ui.screen.findByText("Reviewed initialization applied."); assert.equal(writes, 1);
});

test("production database preparation requires the active association and never supplies a fallback profile", async () => {
  persisted = { ...persisted, targets: persisted.targets.map(target => target.id === "production" ? { ...target, handoffs: [{ deployment: "production", account: "123456789012", region: "us-east-1", command: "", detail: "Private IAM/TLS" }] } : target) };
  let preparations = 0;
  mock.method(cloud.databaseCloudApi, "prepare", async () => { preparations++; throw new Error("An unselected connection must not be used."); });
  await mount({}); await openStatus("prod");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Production database deployment" }), { target: { value: "production" } });
  assert.equal((ui.screen.getByRole("button", { name: "Check database task destination" }) as HTMLButtonElement).disabled, true);
  assert.ok(ui.screen.getByRole("button", { name: "Choose connection" }));
  assert.equal(preparations, 0);
});

test("changing the active connection clears a production approval without starting another inspection", async () => {
  persisted = { ...persisted, targets: persisted.targets.map(target => target.id === "production" ? { ...target, handoffs: [{ deployment: "production", account: "123456789012", region: "us-east-1", command: "", detail: "Private IAM/TLS" }] } : target) };
  const identity = { deployment: "production", account: "123456789012", region: "us-east-1", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/database:7" };
  const destination = { ...cloudPlacement, id: "prepared", expiresAt: "2026-10-22T13:00:00Z", profile: "production-connection", protocol: 1 as const, identity, effects: ["A billed read-only inspection requires separate approval."] };
  let preparations = 0, inspections = 0;
  mock.method(cloud.databaseCloudApi, "prepare", async () => { preparations++; return destination; });
  mock.method(cloud.databaseCloudApi, "review", async () => { inspections++; throw new Error("The stale approval must not be submitted."); });
  await mount(); await openStatus("prod");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Production database deployment" }), { target: { value: "production" } });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check database task destination" }));
  await ui.screen.findByRole("dialog", { name: "Authorize billed read-only database inspection" });
  ui.act(() => activeStudio.setAwsProfile("prod", "another-connection"));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog", { name: "Authorize billed read-only database inspection" }), null));
  assert.equal(activeStudio.mode, "prod");
  assert.equal(activeStudio.awsProfile, "another-connection");
  assert.deepEqual([preparations, inspections], [1, 0]);
});

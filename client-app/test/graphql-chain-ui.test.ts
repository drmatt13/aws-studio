import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { createElement as h } from "react";
import type { GraphQLChain, ReviewPlan, ReviewRequest, AcceptRequest } from "aws-studio/contract-chain/graphql-chain";
import { graphqlChainFixture, withChainLink, type ChainLinkFixture } from "./support/graphql-chain";
import { graphqlWorkspaceFixture } from "./support/graphql-workspace";
import { contractTaskFixture } from "./support/contract-propagation";
import { setupDom } from "./support/ui-harness";

const require = createRequire(import.meta.url);
let harness: ReturnType<typeof setupDom>, ui: typeof import("@testing-library/react"), query: typeof import("@tanstack/react-query");
let page: typeof import("../src/views/GraphQL"), api: typeof import("../src/graphql-chain-api"), http: typeof import("../src/http");
let workspaceApi: typeof import("../src/graphql-workspace-api");
let tasksApi: typeof import("../src/agent-tasks-api");
let chain: GraphQLChain, failure: Error | undefined, waiting: Promise<void> | undefined;
let retainedTasks: import("../shared/agent-runtime").CodingTask[];
let runtimeState: import("../shared/graphql-workspace").GraphQLRuntime;
const executions: import("../shared/graphql-workspace").GraphQLExecuteRequest[] = [];
const calls: string[] = [], clients: import("@tanstack/react-query").QueryClient[] = [];
let reviews: ReviewRequest[], accepts: AcceptRequest[], reviewFailure: Error | undefined, acceptFailure: Error | undefined, reviewWaiting: Promise<void> | undefined;
const plan: ReviewPlan = { reviewId: "fixture-review", expectedRevision: "chain-fixture-revision", expiresAt: "2099-01-01T00:00:00Z", file: "graphql-chain.review.json", before: null, after: '{\n  "version": 1,\n  "prisma": null,\n  "client": null\n}\n', effects: ["Updates only graphql-chain.review.json; application source is unchanged."] };

before(async () => {
  harness = setupDom(); ui = require("@testing-library/react"); query = require("@tanstack/react-query");
  // The initial query paint shares CPU with native fixtures during workspace verification.
  ui.configure({ asyncUtilTimeout: 5000, getElementError: message => new Error(message ?? "Element not found") });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  api = await import("../src/graphql-chain-api"); workspaceApi = await import("../src/graphql-workspace-api"); tasksApi = await import("../src/agent-tasks-api"); http = await import("../src/http"); page = await import("../src/views/GraphQL");
});
beforeEach(() => {
  chain = graphqlChainFixture(); failure = undefined; waiting = undefined; calls.length = 0; retainedTasks = [];
  runtimeState = { status: "stopped", endpoint: null, message: "Local API is stopped." }; executions.length = 0;
  reviews = []; accepts = []; reviewFailure = undefined; acceptFailure = undefined; reviewWaiting = undefined;
  mock.method(tasksApi.agentTasksApi, "list", async () => ({ tasks: retainedTasks }));
  mock.method(api.graphqlChainApi, "load", async (_signal?: AbortSignal, freshness = "cached") => {
    calls.push(freshness); await waiting; if (failure) throw failure; return chain;
  });
  mock.method(api.graphqlChainApi, "review", async (request: ReviewRequest) => { reviews.push(request); await reviewWaiting; if (reviewFailure) throw reviewFailure; return plan; });
  mock.method(api.graphqlChainApi, "accept", async (request: AcceptRequest) => { accepts.push(request); if (acceptFailure) throw acceptFailure; chain = graphqlChainFixture(); return { status: "recorded" as const, revision: "recorded-revision", message: "Project review recorded." }; });
  mock.method(workspaceApi.graphqlWorkspaceApi, "load", async () => graphqlWorkspaceFixture());
  mock.method(workspaceApi.graphqlWorkspaceApi, "runtime", async () => runtimeState);
  mock.method(workspaceApi.graphqlWorkspaceApi, "execute", async (request: import("../shared/graphql-workspace").GraphQLExecuteRequest) => { executions.push(request); return { status: 200, durationMs: 4, body: { data: { projects: [] } } }; });
});
afterEach(() => { ui.cleanup(); clients.splice(0).forEach(client => client.clear()); mock.restoreAll(); });
after(() => harness.cleanup());

function mount(section?: import("../src/views/GraphQL").GraphQLSection) {
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  return ui.render(h(query.QueryClientProvider, { client }, h(page.GraphQLWorkspace, { repositoryRoot: "/fixture", snapshotRevision: "snapshot", section })));
}
function useLink(link: ChainLinkFixture) { chain = withChainLink(chain, link); }
async function details() { return ui.screen.findByRole("heading", { name: "Pothos review" }); }
async function reviewDecisions(kinds: readonly ("api" | "client")[]) {
  await ui.screen.findByRole("dialog", { name: "Review contract decisions" });
  for (const kind of kinds) {
    ui.fireEvent.change(ui.screen.getByRole("textbox", { name: kind === "api" ? "Accepted API behavior" : "Accepted client behavior" }), { target: { value: "Preserve the reviewed application behavior and intentional omissions." } });
    const group = ui.screen.getByRole("group", { name: kind === "api" ? "Repository and API" : "Client operations" });
    ui.fireEvent.change(ui.within(group).getByRole("textbox", { name: "Source or user evidence" }), { target: { value: "Developer reviewed current source, authorization and cache behavior." } });
  }
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Review evidence" }));
}

test("the read-only baseline has four layers, truthful statuses and a selectable detail", async () => {
  mount(); await details();
  for (const caption of ["Database contract", "Pothos schema", "Generated GraphQL", "Client operations"]) assert.ok(ui.screen.getAllByText(caption).length);
  assert.equal(ui.screen.getAllByRole("button", { name: /Approved/ }).length, 3);
  const current = ui.screen.getByRole("button", { name: "Codegen: Approved" });
  assert.equal(current.getAttribute("aria-expanded"), "false");
  ui.fireEvent.click(current);
  await ui.screen.findByText("The generated schema, documents and files match their source.");
  assert.equal(current.getAttribute("aria-expanded"), "true");
  assert.equal(ui.screen.getByRole("link", { name: "Explorer" }).getAttribute("aria-current"), "page");
  assert.deepEqual(calls, ["cached"]);
});

test("loading keeps the chain mounted and never shows a healthy status", async () => {
  let release!: () => void; waiting = new Promise(resolve => { release = resolve; }); mount();
  assert.ok(await ui.screen.findByText("Checking contract chain…"));
  assert.equal(ui.screen.queryAllByRole("button", { name: /Approved/ }).length, 0);
  assert.ok(ui.screen.getByRole("region", { name: "Contract chain layers" }));
  await ui.act(async () => release()); await details();
});

test("a background contract check keeps review controls paused after its HTTP response completes", async () => {
  chain = { ...chain, inspection: { status: "checking", message: "Checking saved source in the background." } };
  mount(); await details();
  const refresh = ui.screen.getByRole("button", { name: "Checking…" }) as HTMLButtonElement;
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.getAttribute("aria-busy"), "true");
  ui.fireEvent.click(refresh);
  assert.ok(calls.length > 0 && calls.every(mode => mode === "cached"));
  assert.equal(reviews.length, 0);
});

test("a retained task cannot keep the saved contract verified title while its source is being rechecked", async () => {
  const before = contractTaskFixture("client");
  retainedTasks = [{ ...before, status: "completed", sourceOutcome: "applied", contract: { ...before.contract!, status: "applied-awaiting-check" } }];
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  const render = (revision: string) => h(query.QueryClientProvider, { client }, h(page.GraphQLWorkspace, { repositoryRoot: "/fixture", snapshotRevision: revision }));
  const view = ui.render(render("before"));
  await ui.screen.findByRole("heading", { name: "Contract chain verified" });
  let release!: () => void;
  waiting = new Promise(resolve => { release = resolve; });
  view.rerender(render("after"));
  await ui.screen.findByRole("heading", { name: "Contract run" });
  assert.equal(ui.screen.queryByRole("heading", { name: "Contract chain verified" }), null);
  assert.equal(ui.screen.queryByText("Current source needs checking"), null);
  assert.equal(ui.screen.queryByRole("button", { name: "Check saved source" }), null);
  assert.ok(ui.screen.getByRole("heading", { name: "Pothos review" }));
  assert.equal(reviews.length, 0); assert.equal(accepts.length, 0);
  await ui.act(async () => release());
  await ui.screen.findByRole("heading", { name: "Contract chain verified" });
});

test("Check again withdraws the saved contract claim until its fresh read returns", async () => {
  const before = contractTaskFixture("client");
  retainedTasks = [{ ...before, status: "completed", sourceOutcome: "applied", contract: { ...before.contract!, status: "applied-awaiting-check" } }];
  mount();
  await ui.screen.findByRole("heading", { name: "Contract chain verified" });
  let release!: () => void;
  waiting = new Promise(resolve => { release = resolve; });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check again" }));
  await ui.screen.findByRole("heading", { name: "Contract run" });
  await ui.act(async () => release());
  await ui.screen.findByRole("heading", { name: "Contract chain verified" });
  assert.deepEqual(calls, ["cached", "fresh"]);
});

test("a background read keeps the contract card and its draft shortcut in place", async () => {
  useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: { Project: { status: "no-review" } }, actions: [{ kind: "agent", link: "prisma-pothos" }] });
  mount();
  const card = await ui.screen.findByRole("region", { name: "Contract update" });
  const start = ui.screen.getByRole("button", { name: "Draft next task" });
  await ui.waitFor(() => assert.equal(start.hasAttribute("disabled"), false));
  let release!: () => void;
  waiting = new Promise(resolve => { release = resolve; });
  ui.act(() => { query.focusManager.setFocused(false); query.focusManager.setFocused(true); });
  await ui.waitFor(() => assert.equal(calls.length, 2));
  assert.equal(start.hasAttribute("disabled"), false);
  assert.ok(card.isConnected);
  assert.ok(ui.screen.getByRole("heading", { name: "Next: Repository and API" }));
  await ui.act(async () => release());
  await ui.waitFor(() => assert.equal(start.hasAttribute("disabled"), false));
  assert.ok(card.isConnected);
});

test("the open review is the first card beneath the chain", async () => {
  useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: { Project: { status: "no-review" } }, actions: [{ kind: "agent", link: "prisma-pothos" }] });
  const { container } = mount();
  await ui.screen.findByRole("region", { name: "Contract update" });
  const detail = container.querySelector("#graphql-chain-detail-heading")!.closest("section")!;
  const visible = [...container.querySelector('[data-ui="graphql-page"]')!.children].filter(element => !element.classList.contains("sr-only"));
  assert.equal(visible[0], detail);
});

test("missing reviews are explicit and do not write or fabricate a baseline", async () => {
  chain = { ...chain, record: "missing", nodes: chain.nodes.map(node => node.id === "client" ? { ...node, reviewedAgainst: null, fingerprint: { status: "unavailable", diagnostics: [] } } : node) };
  useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: { Project: { status: "no-review" }, User: { status: "no-review" } }, actions: [] });
  mount(); await details();
  assert.ok(ui.screen.getByText("Record the current source as the reviewed baseline after checking Pothos exposure."));
  assert.equal(ui.screen.getByRole("button", { name: "Pothos review: No review recorded" }).getAttribute("aria-expanded"), "true");
  assert.deepEqual(calls, ["cached"]);
});

test("a changed model names the field and leaves other models reviewed", async () => {
  const first = chain.links[0]; assert.equal(first.id, "prisma-pothos"); if (first.id !== "prisma-pothos") return;
  const diffs = [{ surface: "prisma" as const, subject: "Project", path: "Project.dueDate", change: "added" as const, before: null, after: JSON.stringify({ type: "TimestamptzString(6)", nullability: "optional", default: null }) }];
  useLink({ ...first, state: { status: "changed", diffs }, models: { ...first.models, Project: { status: "changed", diffs } } });
  mount(); await ui.screen.findByRole("heading", { name: "Changed since Pothos was last reviewed" });
  assert.ok(ui.screen.getByRole("rowheader", { name: "Project.dueDate" }));
  assert.ok(ui.screen.getByRole("cell", { name: "Added" }));
  assert.ok(ui.screen.getByRole("cell", { name: "TimestamptzString(6)?" }));
  assert.match(ui.screen.getByRole("list", { name: "Model reviews" }).textContent!, /User\s*Reviewed/);
});

test("outdated schema and documents show the exact next command", async () => {
  useLink({ id: "pothos-generated", kind: "derived", state: { status: "out-of-date", reasons: ["schema-changed", "documents-changed"], files: ["client-app/src/api/generated/gql.ts"] }, checks: { schema: { status: "failed", diagnostics: [] }, documents: { status: "failed", diagnostics: [] }, "generated-files": { status: "failed", diagnostics: [] } }, actions: [{ kind: "command", command: "npm run codegen" }] });
  mount("explorer"); await ui.screen.findByText("Schema changed.");
  assert.ok(ui.screen.getByText("Documents changed.")); assert.ok(ui.screen.getByText("npm run codegen"));
  assert.ok(ui.screen.getByRole("button", { name: "Copy command" }));
});

test("client review changes show type and field changes", async () => {
  useLink({ id: "generated-client", kind: "derived-then-reviewed", state: { status: "changed", diffs: [{ surface: "sdl", subject: "Project", path: "Project.dueDate", change: "added", before: null, after: "dueDate: String" }] }, validation: { status: "passed" }, actions: [] });
  mount("client"); await ui.screen.findByRole("heading", { name: "Changed since client operations were last reviewed" });
  assert.ok(ui.screen.getByRole("rowheader", { name: "Project.dueDate" }));
});

test("invalid documents retain the document, error and source location", async () => {
  useLink({ id: "generated-client", kind: "derived-then-reviewed", state: { status: "invalid", problems: [{ document: "ProjectSummary", file: "client-app/src/api/projects/operations.ts", line: 7, message: 'Cannot query field "name" on type "Project".' }] }, validation: { status: "failed", diagnostics: [] }, actions: [] });
  mount("client"); await ui.screen.findAllByText("ProjectSummary");
  assert.ok(ui.screen.getByText('Cannot query field "name" on type "Project".'));
  assert.ok(ui.screen.getAllByText("client-app/src/api/projects/operations.ts:7").length);
});

test("Unknown shows the restricted capability error without hiding independent evidence", async () => {
  const diagnostics = [{ code: "sandbox-unavailable", message: "Restricted schema evaluation is unavailable. Install a compatible Codex sandbox and check again.", file: "schema/project.ts", line: 4, column: 2 }];
  useLink({ id: "pothos-generated", kind: "derived", state: { status: "unknown", diagnostics }, checks: { schema: { status: "unavailable", diagnostics }, documents: { status: "passed" }, "generated-files": { status: "unavailable", diagnostics } }, actions: [] });
  mount("explorer"); await ui.screen.findByText(diagnostics[0].message);
  assert.ok(ui.screen.getByText("schema/project.ts:4:2"));
  assert.equal(ui.screen.getAllByRole("button", { name: /Approved/ }).length, 1);
});

test("read failures and an old server have contained recovery", async () => {
  failure = new http.ApiError(404, "Unknown route"); mount();
  await ui.screen.findByRole("alert");
  assert.ok(ui.screen.getByText("Restart Studio, then reload this page to use the contract chain."));
  failure = undefined; ui.fireEvent.click(ui.screen.getByRole("button", { name: "Try again" }));
  await details(); assert.deepEqual(calls, ["cached", "fresh"]);
});

test("a failed background refresh stops presenting old green evidence", async () => {
  mount(); await details(); failure = new Error("Fixture source read failed");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check again" }));
  await ui.screen.findByRole("alert");
  assert.equal(ui.screen.queryAllByRole("button", { name: /Approved/ }).length, 0);
  assert.ok(ui.screen.getByText(/Fixture source read failed/));
});

test("a busy source gate reports its own recovery instead of asking for a restart", async () => {
  failure = new http.ApiError(409, "Source is busy. Wait for the current write, then check again."); mount();
  await ui.screen.findByRole("alert");
  assert.ok(ui.screen.getByText(/Source is busy/));
  assert.equal(ui.screen.queryByText("Restart Studio, then reload this page to use the contract chain."), null);
});

test("window focus and snapshot revisions recheck the saved source", async () => {
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  const render = (revision: string) => h(query.QueryClientProvider, { client }, h(page.GraphQLWorkspace, { repositoryRoot: "/fixture", snapshotRevision: revision }));
  const view = ui.render(render("before")); await details();
  ui.act(() => { query.focusManager.setFocused(false); query.focusManager.setFocused(true); });
  await ui.waitFor(() => assert.equal(calls.length, 2));
  view.rerender(render("after"));
  await ui.waitFor(() => assert.equal(calls.length, 3));
});

function modelReviewAction() {
  useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: { Project: { status: "no-review" } }, actions: [{ kind: "acknowledge", scope: { kind: "model", model: "Project" } }] });
}

test("acknowledgement reviews the fixed-file change before accepting and Back restores focus", async () => {
  modelReviewAction(); mount(); await details();
  const trigger = ui.screen.getByRole("button", { name: "Mark Project reviewed, no API change" }); trigger.focus(); ui.fireEvent.click(trigger);
  await ui.screen.findByRole("dialog", { name: "Review contract chain record" });
  assert.deepEqual(reviews, [{ expectedRevision: "chain-fixture-revision", scope: { kind: "model", model: "Project" } }]);
  assert.equal(accepts.length, 0);
  assert.ok(ui.screen.getByRole("region", { name: "Changes to graphql-chain.review.json" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Back" }));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("dialog"), null));
  assert.equal(document.activeElement, trigger); assert.equal(accepts.length, 0);
});

test("recording accepts only the reviewed identity, rechecks and restores a useful focus target", async () => {
  modelReviewAction(); mount(); await details();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Mark Project reviewed, no API change" }));
  await ui.screen.findByRole("dialog"); ui.fireEvent.click(ui.screen.getByRole("button", { name: "Record review" }));
  await ui.screen.findByText("Project review recorded.");
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("button", { name: "Check again" })));
  assert.deepEqual(accepts, [{ reviewId: "fixture-review", expectedRevision: "chain-fixture-revision" }]);
  assert.deepEqual(calls, ["cached", "fresh"]);
});

test("stale acknowledgement failures stay visible and never record an unreviewed candidate", async () => {
  modelReviewAction(); reviewFailure = new http.ApiError(409, "Source changed. Check again before recording this review."); mount(); await details();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Mark Project reviewed, no API change" }));
  await ui.screen.findByRole("alert"); assert.equal(ui.screen.queryByRole("dialog"), null); assert.equal(accepts.length, 0);
  assert.ok(ui.screen.getByText("Source changed. Check again before recording this review."));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check again" }));
  await ui.waitFor(() => assert.equal(ui.screen.queryByRole("alert"), null));
  assert.deepEqual(calls, ["cached", "fresh"]);
});

test("a rejected apply retains the reviewed diff and no success state", async () => {
  modelReviewAction(); acceptFailure = new http.ApiError(409, "The review record changed after review."); mount(); await details();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Mark Project reviewed, no API change" }));
  await ui.screen.findByRole("dialog"); ui.fireEvent.click(ui.screen.getByRole("button", { name: "Record review" }));
  await ui.screen.findByRole("alert"); assert.ok(ui.screen.getByRole("dialog"));
  assert.ok(ui.screen.getByText("The review record changed after review."));
  await ui.waitFor(() => assert.equal(document.activeElement, ui.screen.getByRole("alert")));
  assert.equal(ui.screen.queryByText("Project review recorded."), null);
});

test("an open review pauses acceptance while source evidence is being rechecked", async () => {
  modelReviewAction(); mount(); await details();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Mark Project reviewed, no API change" }));
  const dialog = await ui.screen.findByRole("dialog");
  let release!: () => void; waiting = new Promise(resolve => { release = resolve; });
  ui.act(() => { query.focusManager.setFocused(false); query.focusManager.setFocused(true); });
  await ui.waitFor(() => assert.equal(ui.within(dialog).getByRole("button", { name: "Checking…" }).hasAttribute("disabled"), true));
  ui.fireEvent.click(ui.within(dialog).getByRole("button", { name: "Checking…" }));
  assert.equal(accepts.length, 0);
  await ui.act(async () => release());
  await ui.waitFor(() => assert.equal(ui.within(dialog).getByRole("button", { name: "Record review" }).hasAttribute("disabled"), false));
  assert.equal(ui.within(dialog).queryByRole("alert"), null);
});

test("the baseline is explicit and review controls pause while preparing the plan", async () => {
  chain = { ...chain, record: "missing" };
  useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: { Project: { status: "no-review" } }, actions: [{ kind: "acknowledge", scope: { kind: "baseline" } }] });
  let release!: () => void; reviewWaiting = new Promise(resolve => { release = resolve; }); mount(); await details();
  const trigger = ui.screen.getByRole("button", { name: "Record reviewed baseline" }); ui.fireEvent.click(trigger);
  assert.equal(reviews.length, 0, "the baseline cannot bypass explicit application decisions");
  await reviewDecisions(["api", "client"]);
  await ui.waitFor(() => assert.equal(trigger.hasAttribute("disabled"), true));
  assert.equal(ui.screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled"), true);
  assert.equal(accepts.length, 0); await ui.act(async () => release()); await ui.screen.findByRole("dialog");
  assert.deepEqual(reviews[0]?.scope, { kind: "baseline" });
});

for (const [section, label, subject] of [
  ["schema", "Draft Pothos task", /repository and Pothos GraphQL API/],
  ["client", "Draft client task", /authored client operations/],
  ["client", "Draft full contract task", /repositories, the Pothos GraphQL API, generated documents and TanStack Query/],
] as const) test(`${label} opens an editable plain Coding request`, async () => {
  if (section === "schema") useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: {}, actions: [] });
  else useLink({ id: "generated-client", kind: "derived-then-reviewed", state: { status: "no-review" }, validation: { status: "passed" }, actions: [] });
  let prepared: import("../src/coding-task-navigation").CodingTaskPreparation | undefined;
  const capture = (event: Event) => { prepared = (event as CustomEvent<import("../src/coding-task-navigation").CodingTaskPreparation>).detail; };
  window.addEventListener("studio:prepare-coding-task", capture);
  try {
    mount(section);
    await ui.screen.findByRole("button", { name: /No review recorded/ });
    const action = await ui.screen.findByRole("button", { name: label });
    assert.equal(action.hasAttribute("disabled"), false);
    ui.fireEvent.click(action);
    assert.equal(prepared?.repository, "/fixture");
    assert.ok(prepared?.request.id);
    assert.deepEqual(Object.keys(prepared!.request).sort(), ["id", "prompt"]);
    assert.match(prepared!.request.prompt, subject);
    assert.equal(reviews.length, 0);
    assert.equal(accepts.length, 0);
  } finally { window.removeEventListener("studio:prepare-coding-task", capture); }
});

for (const status of ["stale", "checking"] as const) test(`${status} source allows drafting a task without refreshing saved source`, async () => {
  useLink({ id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: {}, actions: [] });
  chain = { ...chain, inspection: { status, message: "Inspect current saved source first." } };
  let prepared = 0;
  const capture = () => { prepared++; };
  window.addEventListener("studio:prepare-coding-task", capture);
  try {
    mount(); await details();
    assert.equal(ui.screen.queryByRole("button", { name: "Draft next task" }), null);
    for (const name of ["Draft full contract task", "Draft Pothos task"]) {
      const action = await ui.screen.findByRole("button", { name });
      assert.equal(action.hasAttribute("disabled"), false);
      ui.fireEvent.click(action);
    }
    assert.equal(prepared, 2);
    assert.ok(calls.every(mode => mode === "cached"));
    assert.equal(reviews.length, 0);
    assert.equal(accepts.length, 0);
  } finally { window.removeEventListener("studio:prepare-coding-task", capture); }
});

test("Schema browses generated types and SDL without inventing Prisma mapping", async () => {
  mount(); await ui.screen.findByRole("heading", { name: "Schema" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Project object" }));
  assert.ok(ui.screen.getByRole("region", { name: "Project fields" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "SDL" }));
  assert.equal(ui.screen.getByLabelText("Project SDL").textContent, "type Project { id: ID! name: String! }");
  ui.fireEvent.change(ui.screen.getByRole("searchbox", { name: "Find a type or field" }), { target: { value: "unmatched" } });
  assert.ok(ui.screen.getByText("No types match “unmatched”."));
  assert.equal(ui.screen.queryByText("From Prisma"), null);
});

test("tabs highlight their corresponding chain segment and Client loads an operation into Explorer", async () => {
  mount(); await ui.screen.findByRole("heading", { name: "Schema" });
  ui.fireEvent.click(ui.screen.getByRole("link", { name: "Client", hidden: false }));
  await ui.screen.findByRole("heading", { name: "Client" });
  assert.equal(document.querySelector('[data-chain-link="generated-client"]')?.getAttribute("aria-current"), "step");
  assert.ok(ui.screen.getByText("projects.id"));
  assert.ok(ui.screen.getByLabelText("projectKeys source"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Run in Explorer" }));
  await ui.screen.findByRole("heading", { name: "Explorer" });
  assert.equal(document.querySelector('[data-chain-link="pothos-generated"]')?.getAttribute("aria-current"), "step");
  assert.match((ui.screen.getByRole("textbox", { name: "Operation document" }) as HTMLTextAreaElement).value, /fragment ProjectSummary/);
  assert.equal(executions.length, 0);
});

test("Explorer runs only an explicit authenticated ready request and keeps credentials out of storage", async () => {
  runtimeState = { status: "ready", endpoint: "http://127.0.0.1:3001/graphql", message: "Local API is ready." };
  mount("explorer"); await ui.screen.findByText("Local API is ready.");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Operation" }), { target: { value: "projects" } });
  const token = ui.screen.getByLabelText("Cognito ID token") as HTMLInputElement;
  assert.equal(token.type, "password"); assert.equal(ui.screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), true);
  ui.fireEvent.change(token, { target: { value: "fixture.id.token" } });
  assert.equal(executions.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Run" }));
  await ui.screen.findByLabelText("GraphQL response"); assert.equal(executions.length, 1); assert.equal(executions[0]?.idToken, "fixture.id.token");
  assert.equal(window.localStorage.length, 0); assert.equal(window.sessionStorage.length, 0);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Clear token" })); assert.equal(token.value, "");
});

test("Explorer refuses stopped runtime and requires a fresh confirmation for scratch mutations", async () => {
  mount("explorer"); await ui.screen.findByText(/Local API is stopped/);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Operation document" }), { target: { value: "mutation Scratch { archiveProject(id: \"fixture\") }" } });
  ui.fireEvent.change(ui.screen.getByLabelText("Cognito ID token"), { target: { value: "fixture.id.token" } });
  assert.equal(ui.screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), true);
  runtimeState = { status: "ready", endpoint: "http://127.0.0.1:3001/graphql", message: "Local API is ready." };
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check runtime" })); await ui.screen.findByText("Local API is ready.");
  assert.equal(ui.screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), true);
  ui.fireEvent.click(ui.screen.getByRole("checkbox", { name: "Allow this run to change local data" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Run" })); await ui.screen.findByLabelText("GraphQL response");
  assert.equal(executions[0]?.confirmMutation, true);
  assert.equal((ui.screen.getByRole("checkbox", { name: "Allow this run to change local data" }) as HTMLInputElement).checked, false);
  assert.equal(ui.screen.getByRole("button", { name: "Run" }).hasAttribute("disabled"), true);
});

test("locally current generation stays visibly blocked by missing API reconciliation", async () => {
  const generated = chain.links[1]!;
  useLink({ ...generated, confidence: { status: "blocked", blockedBy: ["repository-pothos"], diagnostics: [{ code: "UPSTREAM_REVIEW_REQUIRED", message: "Waiting for repository and API review. Review its implementation and pass backend checks." }] }, actions: [] });
  mount("explorer"); await ui.screen.findByRole("heading", { name: "Generated GraphQL", level: 3 });
  assert.ok(ui.screen.getByRole("button", { name: "Codegen: Waiting for upstream" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Codegen: Approved" }), null);
  assert.ok(ui.screen.getByText("Generated files match the current schema and documents; upstream confidence is reported separately."));
  assert.ok(ui.screen.getByText(/Review its implementation and pass backend checks/));
  assert.equal(reviews.length, 0);
});

test("API implementation review is a distinct scoped acknowledgement", async () => {
  const first = chain.links[0]!;
  useLink({ ...first, confidence: { status: "stale", blockedBy: [], diagnostics: [{ code: "API_IMPLEMENTATION_CHANGED", message: "Repository or Pothos source changed. Review implementation and backend checks." }] }, actions: [{ kind: "acknowledge", scope: { kind: "api" } }] });
  mount(); await details();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Record repository and API review" }));
  assert.equal(reviews.length, 0);
  await reviewDecisions(["api"]);
  await ui.screen.findByRole("dialog", { name: "Review contract chain record" });
  assert.deepEqual(reviews[0]?.scope, { kind: "api" });
  assert.ok(reviews[0]?.decisions?.api?.statement);
  assert.equal(accepts.length, 0);
});

test("historical fingerprints and local results never become the current rail or review authority", async () => {
  const previous = chain;
  const diagnostics = [{ code: "INSPECTION_STALE", message: "Source changed. Check again before using this evidence." }];
  chain = { ...chain, inspection: { status: "stale", message: diagnostics[0]!.message }, history: { revision: previous.revision, checkedAt: "2026-11-11T12:00:00.000Z", nodes: previous.nodes, links: previous.links.map(link => ({ ...link, actions: [] })) }, links: previous.links.map(link => ({ ...link, confidence: { status: "stale", diagnostics, blockedBy: [] }, actions: [] })) };
  mount(); await details();
  assert.equal(ui.screen.queryAllByRole("button", { name: /Approved/ }).length, 0);
  ui.fireEvent.click(ui.screen.getByText(/Previous check ·/));
  assert.ok(ui.screen.getByRole("list", { name: "Previous fingerprints" }));
  assert.match(ui.screen.getByRole("list", { name: "Previous local evidence" }).textContent!, /Codegen: Current/);
  assert.equal(ui.screen.queryByRole("button", { name: "Record repository and API review" }), null);
  assert.equal(reviews.length, 0);
});

test("incompatible server semantics and incomplete verification fail the browser response guard", () => {
  assert.equal(api.readGraphQLChain(chain), chain);
  assert.throws(() => api.readGraphQLChain({ ...chain, version: 1 }), /Restart npm run studio/);
  assert.throws(() => api.readGraphQLChain({ ...chain, verification: {} }), /Restart npm run studio/);
  assert.throws(() => api.readGraphQLChain({ ...chain, links: chain.links.map(link => ({ ...link, confidence: undefined })) }), /Restart npm run studio/);
});

test("a stale inspection disables an open review even when the last source revision is unchanged", async () => {
  modelReviewAction(); mount(); await details();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Mark Project reviewed, no API change" }));
  const dialog = await ui.screen.findByRole("dialog");
  chain = { ...chain, inspection: { status: "stale", message: "Source watching stopped. Check again." }, links: chain.links.map(link => ({ ...link, actions: [], confidence: { status: "stale", blockedBy: [], diagnostics: [] } })) };
  ui.act(() => { query.focusManager.setFocused(false); query.focusManager.setFocused(true); });
  await ui.waitFor(() => assert.equal(ui.within(dialog).getByRole("button", { name: "Record review" }).hasAttribute("disabled"), true));
  assert.ok(ui.within(dialog).getByText("Source changed. Check again before recording this review."));
  ui.fireEvent.click(ui.within(dialog).getByRole("button", { name: "Record review" }));
  assert.equal(accepts.length, 0);
});

test("blocked independent checks remain distinct from unavailable checks without presenting verified confidence", async () => {
  const diagnostics = [{ code: "UPSTREAM_CHECK_REQUIRED", message: "Client checks wait for current generated documents." }];
  const client = chain.links[2]!;
  useLink({ ...client, confidence: { status: "blocked", blockedBy: ["codegen"], diagnostics: [] }, actions: [] });
  chain = { ...chain, verification: { ...chain.verification, client: { status: "blocked", diagnostics }, consumers: { status: "blocked", diagnostics }, integration: { status: "blocked", diagnostics } } };
  assert.equal(api.readGraphQLChain(chain), chain);
  mount("client"); await ui.screen.findByRole("heading", { name: "Client operations review" });
  assert.ok(ui.screen.getByRole("button", { name: "Client review: Waiting for upstream" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Client review: Approved" }), null);
  const checks = ui.screen.getByRole("list", { name: "Independent verification" });
  assert.match(checks.textContent!, /Operations and cache behavior: Waiting for upstream/);
  assert.doesNotMatch(checks.textContent!, /Unavailable|Passed/);
  assert.equal(reviews.length, 0);
});

test("an unreviewed client fingerprint identifies current source rather than accepted evidence", async () => {
  const current = "c".repeat(64), reviewed = "a".repeat(64);
  chain = { ...chain, nodes: chain.nodes.map(node => node.id === "client" ? { ...node, fingerprint: { status: "available", value: current }, reviewedAgainst: reviewed } : node) };
  useLink({ ...chain.links[2]!, confidence: { status: "stale", blockedBy: [], diagnostics: [{ code: "CLIENT_IMPLEMENTATION_CHANGED", message: "Client implementation changed. Review source after passing its checks." }] }, actions: [] });
  mount("client"); await ui.screen.findByRole("heading", { name: "Client operations review" });
  const stage = document.querySelector('[data-chain-node="client"]')!;
  assert.ok(ui.within(stage as HTMLElement).getByText("Generated SHA-256", { exact: true }));
  assert.equal(ui.within(stage as HTMLElement).queryByText("reviewed against", { exact: true }), null);
  assert.ok(stage.querySelector(`[title="${current}"]`));
  const source = ui.within(stage as HTMLElement).getByText("Source SHA-256", { exact: true }).parentElement!;
  assert.equal(source.getAttribute("title"), reviewed, "accepted input remains visible when current output changes");
  assert.equal(ui.screen.queryByRole("button", { name: "Client review: Approved" }), null);
});

test("accepted source hashes face current generated hashes without copying live upstream content", async () => {
  const ids = ["prisma", "pothos", "generated", "client"] as const;
  chain = { ...chain, nodes: chain.nodes.map((node, index) => ({ ...node, reviewedAgainst: index ? String(index).repeat(64) : null })) };
  mount(); await details();
  for (const [index, id] of ids.entries()) {
    const node = chain.nodes.find(item => item.id === id)!;
    const stage = document.querySelector(`[data-chain-node="${id}"]`)!;
    const output = ui.within(stage as HTMLElement).getByText("Generated SHA-256", { exact: true }).parentElement!;
    assert.ok(output.classList.contains("ml-auto"), "generated output is right aligned");
    if (node.fingerprint.status === "available") assert.equal(output.getAttribute("title"), node.fingerprint.value);
    if (!index) assert.equal(ui.within(stage as HTMLElement).queryByText("Source SHA-256", { exact: true }), null);
    else {
      const input = ui.within(stage as HTMLElement).getByText("Source SHA-256", { exact: true }).parentElement!;
      assert.equal(input.classList.contains("ml-auto"), false, "source input is left aligned");
      assert.equal(input.getAttribute("title"), node.reviewedAgainst);
    }
  }
});

test("an unapproved connection has no consumed source hash even when live upstream content is available", async () => {
  chain = { ...chain, nodes: chain.nodes.map(node => ({ ...node, reviewedAgainst: null })) };
  mount(); await details();
  for (const id of ["pothos", "generated", "client"]) {
    const stage = document.querySelector(`[data-chain-node="${id}"]`)!;
    const input = ui.within(stage as HTMLElement).getByText("Source SHA-256", { exact: true }).parentElement!;
    assert.equal(input.hasAttribute("title"), false);
    assert.ok(ui.within(input).getByText("Not recorded", { exact: true }));
  }
});


/** What Studio serves after a restart or any save: ledger hashes from the watcher, no live check yet. */
function staleLedgerChain(approved: boolean): GraphQLChain {
  const message = "Saved source changed. Checking is required before using this evidence.";
  const diagnostics = [{ code: "INSPECTION_STALE", message }];
  const confidence = { status: "stale" as const, diagnostics, blockedBy: [] };
  const unknown = { status: "unknown" as const, diagnostics }, unavailable = { status: "unavailable" as const, diagnostics };
  const hashes = ["a", "b", "c", "d"].map(letter => letter.repeat(64));
  const fixture = graphqlChainFixture();
  return { ...fixture, inspection: { status: "stale", message, diagnostics }, fingerprints: "ready",
    verification: { database: unavailable, api: unavailable, client: unavailable, consumers: unavailable, integration: unavailable },
    nodes: fixture.nodes.map((node, index) => ({ ...node, fingerprint: { status: "available" as const, value: hashes[index]! }, reviewedAgainst: index ? hashes[index - 1]! : null, recordedOutput: index ? hashes[index]! : null, ...(approved && index ? { approvalRecorded: true } : {}) })),
    links: [
      { id: "prisma-pothos", kind: "reviewed", state: unknown, confidence, models: {}, actions: [] },
      { id: "pothos-generated", kind: "derived", state: unknown, confidence, checks: { schema: unavailable, documents: unavailable, "generated-files": unavailable }, actions: [] },
      { id: "generated-client", kind: "derived-then-reviewed", state: unknown, confidence, validation: unavailable, actions: [] },
    ] };
}

test("a committed approval reads Approved on the rail and in the open card before any live check", async () => {
  chain = staleLedgerChain(true);
  mount(); await details();
  const card = ui.screen.getByRole("heading", { name: "Pothos review" }).closest("section, article, div[aria-labelledby]") as HTMLElement;
  assert.equal(ui.screen.getAllByRole("button", { name: /: Approved$/ }).length, 3);
  assert.ok(ui.within(card).getByText("Approved", { exact: true }));
  assert.equal(ui.screen.queryByText("Check required"), null, "the card never contradicts the rail");
  assert.equal(ui.within(card).queryByText("Unavailable"), null, "checks that have not run are not presented as unavailable evidence");
  assert.equal(ui.screen.queryByText(/Checking is required before using this evidence/), null);
  assert.ok(ui.within(card).getByText(/graphql-chain\.review\.json/));
});

test("matching hashes show In sync independently of saved approval on the rail and in the detail", async () => {
  chain = staleLedgerChain(false);
  mount(); await details();
  const card = ui.screen.getByRole("heading", { name: "Pothos review" }).closest("section, article, div[aria-labelledby]") as HTMLElement;
  assert.equal(ui.screen.getAllByRole("button", { name: /: In sync$/ }).length, 3);
  assert.equal(ui.screen.queryAllByRole("button", { name: /: Approved$/ }).length, 0);
  assert.ok(ui.within(card).getByText("In sync", { exact: true }));
  assert.equal(ui.screen.queryByText("Check required"), null);
  assert.ok(ui.within(card).getByText(/The current upstream output matches the input recorded for this stage/));
  assert.ok(ui.within(card).getByRole("button", { name: "Draft Pothos task" }));
});

for (const reason of ["changed input", "unrecorded output", "missing files"] as const) test(`Codegen requests regeneration for ${reason} while Pothos stays in sync`, async () => {
  chain = staleLedgerChain(false);
  chain = { ...chain, nodes: chain.nodes.map(node => node.id !== "generated" ? node
    : reason === "changed input" ? { ...node, reviewedAgainst: "e".repeat(64) }
      : reason === "unrecorded output" ? { ...node, recordedOutput: null }
        : { ...node, fingerprint: { status: "unavailable", diagnostics: [{ code: "SOURCE_MISSING", message: "No generated files." }] } }) };
  mount("explorer");
  await ui.screen.findByRole("button", { name: "Codegen: Regeneration needed" });
  assert.ok(ui.screen.getByRole("button", { name: "Pothos review: In sync" }));
  assert.ok(ui.screen.getByRole("button", { name: "Client review: Waiting for upstream" }));
  assert.ok(ui.screen.getByText("Use Regenerate GraphQL to produce files from the current schema and operations."));
});

test("checking preserves Approved labels for verified upstream stages while client changes are checked", async () => {
  useLink({ id: "generated-client", kind: "derived-then-reviewed", state: { status: "no-review" }, validation: { status: "passed" }, actions: [] });
  chain = { ...chain, inspection: { status: "checking", message: "Checking changed client inputs." } };
  mount(); await details();
  assert.ok(ui.screen.getByRole("button", { name: "Pothos review: Approved" }));
  assert.ok(ui.screen.getByRole("button", { name: "Codegen: Approved" }));
  assert.ok(ui.screen.getByRole("button", { name: "Client review: Checking…" }));
});


test("ordinary chain reads preserve Approved stages while pausing actions", async () => {
  mount(); await details();
  let release!: () => void; waiting = new Promise(resolve => { release = resolve; });
  const refresh = clients[0]!.refetchQueries({ queryKey: ["graphql-chain", "/fixture"] });
  try {
    await ui.waitFor(() => assert.ok(calls.length >= 2));
    assert.equal(ui.screen.getAllByRole("button", { name: /: Approved$/ }).length, 3);
    assert.equal(ui.screen.queryAllByRole("button", { name: /: Checking…$/ }).length, 0);
  } finally { await ui.act(async () => { release(); await refresh; }); }
});

test("a known source revision hides obsolete Approved stages until its read completes", async () => {
  const rendered = mount(); await details();
  let release!: () => void; waiting = new Promise(resolve => { release = resolve; });
  rendered.rerender(h(query.QueryClientProvider, { client: clients[0]! }, h(page.GraphQLWorkspace, { repositoryRoot: "/fixture", snapshotRevision: "changed-source" })));
  try {
    await ui.waitFor(() => assert.equal(ui.screen.getAllByRole("button", { name: /: Checking…$/ }).length, 3));
    assert.equal(ui.screen.queryAllByRole("button", { name: /: Approved$/ }).length, 0);
  } finally { await ui.act(async () => release()); }
  await ui.waitFor(() => assert.equal(ui.screen.getAllByRole("button", { name: /: Approved$/ }).length, 3));
});


test("the active inspection phase is visible beside contract details and clears at completion", async () => {
  const message = "Hashing portable proof inputs · 8m 2s elapsed · 1m 4s in this phase.";
  chain = { ...chain, inspection: { status: "checking", message } };
  mount(); await details();
  const phase = await ui.screen.findByText(message);
  assert.equal(phase.getAttribute("role"), "status");
  assert.equal(phase.classList.contains("sr-only"), false);
  chain = { ...chain, inspection: { status: "ready" } };
  await ui.act(async () => { await clients[0]!.invalidateQueries({ queryKey: ["graphql-chain"] }); });
  await ui.waitFor(() => assert.equal(ui.screen.queryByText(message), null));
});

function approvedTaskForInspection() {
  const task = contractTaskFixture("client");
  return { ...task, status: "completed" as const, updatedAt: "2026-11-12T12:00:30Z", sourceOutcome: "unchanged" as const,
    contract: { ...task.contract!, status: "applied-awaiting-check" as const, approval: { status: "approved" as const, message: "Saved-source stage approvals recorded." } } };
}
function checkedAfterApproval(): GraphQLChain {
  return { ...graphqlChainFixture(), inspection: { status: "ready", checkedAt: "2026-11-12T12:01:00Z" } };
}
function refreshReturnsApproved() {
  mock.method(api.graphqlChainApi, "load", async (_signal?: AbortSignal, freshness = "cached") => {
    calls.push(freshness); await waiting;
    if (freshness === "refresh") chain = checkedAfterApproval();
    return chain;
  });
}

test("mounting after completed approval checks stale saved evidence once and displays Approved", async () => {
  retainedTasks = [approvedTaskForInspection()];
  chain = { ...chain, inspection: { status: "stale", checkedAt: "2026-11-12T12:00:00Z", message: "Saved source changed after the review write." } };
  refreshReturnsApproved();
  mount();
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
  await ui.waitFor(() => assert.equal(ui.screen.getAllByRole("button", { name: /Approved/ }).length, 3));
  await ui.act(async () => { await clients[0]!.refetchQueries({ queryKey: ["coding-tasks", "/fixture"] }); await clients[0]!.refetchQueries({ queryKey: ["graphql-chain", "/fixture"] }); });
  assert.equal(calls.filter(call => call === "refresh").length, 1, "ordinary polling does not repeat the approval check");
});

test("an approved task arriving after the initial stale chain read still starts one refresh", async () => {
  retainedTasks = [approvedTaskForInspection()];
  chain = { ...chain, inspection: { status: "stale", message: "The review record changed." } };
  let release!: () => void; const taskRead = new Promise<void>(resolve => { release = resolve; });
  mock.method(tasksApi.agentTasksApi, "list", async () => { await taskRead; return { tasks: retainedTasks }; });
  refreshReturnsApproved(); mount();
  await ui.waitFor(() => assert.deepEqual(calls, ["cached"]));
  await ui.act(async () => release());
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
});

test("an approved task arriving before the initial chain read waits for that read before checking once", async () => {
  retainedTasks = [approvedTaskForInspection()];
  chain = { ...chain, inspection: { status: "stale", message: "The review record changed." } };
  let release!: () => void; waiting = new Promise<void>(resolve => { release = resolve; });
  refreshReturnsApproved(); mount();
  await ui.waitFor(() => assert.ok(clients[0]!.getQueryData(["coding-tasks", "/fixture"])));
  assert.deepEqual(calls, ["cached"]);
  await ui.act(async () => release());
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
});

test("a failed initial chain query gets one approval-driven refresh", async () => {
  retainedTasks = [approvedTaskForInspection()];
  mock.method(api.graphqlChainApi, "load", async (_signal?: AbortSignal, freshness = "cached") => {
    calls.push(freshness);
    if (freshness === "cached") throw new Error("Initial cached read failed");
    return checkedAfterApproval();
  });
  mount();
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
  await ui.waitFor(() => assert.equal(ui.screen.getAllByRole("button", { name: /Approved/ }).length, 3));
});

test("an existing fresh server check covers an approved task without a duplicate inspection", async () => {
  retainedTasks = [approvedTaskForInspection()];
  chain = { ...chain, inspection: { status: "checking", message: "Checking approved saved source." } };
  mount(); await ui.waitFor(() => assert.deepEqual(calls, ["cached"]));
  chain = checkedAfterApproval();
  await ui.act(async () => { await clients[0]!.refetchQueries({ queryKey: ["graphql-chain", "/fixture"] }); });
  await ui.waitFor(() => assert.equal(ui.screen.getAllByRole("button", { name: /Approved/ }).length, 3));
  assert.equal(calls.includes("refresh"), false);
});

test("an already healthy inspection after approval needs no additional fresh check", async () => {
  retainedTasks = [approvedTaskForInspection()]; chain = checkedAfterApproval();
  mount(); await details();
  await ui.act(async () => { await clients[0]!.refetchQueries({ queryKey: ["coding-tasks", "/fixture"] }); });
  assert.deepEqual(calls, ["cached"]);
});

test("a completed historical approval does not start a check when its saved hashes are in sync", async () => {
  retainedTasks = [approvedTaskForInspection()]; chain = staleLedgerChain(false);
  mount(); await details();
  await ui.act(async () => { await clients[0]!.refetchQueries({ queryKey: ["coding-tasks", "/fixture"] }); });
  assert.ok(ui.screen.getByRole("button", { name: "Pothos review: In sync" }));
  assert.equal(calls.includes("refresh"), false);
});

test("a newer approval refreshes an earlier healthy rail and confirms completion", async () => {
  retainedTasks = [approvedTaskForInspection()];
  chain = { ...chain, inspection: { status: "ready", checkedAt: "2026-11-12T12:00:00Z" } };
  refreshReturnsApproved(); mount(); await details();
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
  assert.ok(ui.screen.getByText("Saved-source stage approvals recorded."));
});

test("a failed approval-driven refresh is not restarted by later polling failures", async () => {
  retainedTasks = [approvedTaskForInspection()]; failure = new Error("Inspection unavailable");
  mount();
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
  await ui.waitFor(() => assert.equal(clients[0]!.getQueryState(["graphql-chain", "/fixture"])?.fetchStatus, "idle"));
  await ui.act(async () => { await clients[0]!.refetchQueries({ queryKey: ["coding-tasks", "/fixture"] }); await clients[0]!.refetchQueries({ queryKey: ["graphql-chain", "/fixture"] }); });
  assert.equal(calls.filter(call => call === "refresh").length, 1);
});

test("an approval completed while the page stays mounted starts one refresh", async () => {
  const approved = approvedTaskForInspection();
  retainedTasks = [{ ...approved, contract: { ...approved.contract!, approval: { status: "checking", message: "Checking saved source." } } }];
  chain = { ...chain, inspection: { status: "stale", message: "Review write is pending." } };
  refreshReturnsApproved(); mount(); await details();
  assert.equal(calls.includes("refresh"), false);
  retainedTasks = [approved];
  await ui.act(async () => { await clients[0]!.refetchQueries({ queryKey: ["coding-tasks", "/fixture"] }); });
  await ui.waitFor(() => assert.equal(calls.filter(call => call === "refresh").length, 1));
});

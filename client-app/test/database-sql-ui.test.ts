import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import type { Mode } from "../shared/model";
import type {
  SavedSqlCommand,
  SqlCatalog,
  SqlExecutionResult,
  SqlExecutionReview,
} from "../shared/database-sql";
const require = createRequire(import.meta.url);
let ui: typeof import("@testing-library/react"),
  view: typeof import("../src/views/DatabaseSql"),
  router: typeof import("@tanstack/react-router"),
  dom: { window: Window & typeof globalThis };
const command: SavedSqlCommand = {
  name: "seed_demo",
  kind: "seed",
  intent: "repeatable",
  description: "Fixture seed",
  parameters: ["label"],
  sql: "INSERT INTO fixture_items(label) VALUES ($1) ON CONFLICT DO NOTHING",
};
const path = "packages/database/sql/seed/seed_demo.sql";
const catalog: SqlCatalog = {
  directory: "packages/database/sql",
  commands: [{ path, revision: "revision-a", command }],
  issues: [],
  history: [],
  targets: [],
};
const review: SqlExecutionReview = {
  id: "review-a",
  path,
  revision: "revision-a",
  command,
  targetId: "local:postgres",
  targetLabel: "Local PostgreSQL",
  targetIdentity: "target-a",
  parameters: ["demo"],
  confirmation: "Run seed_demo on Local PostgreSQL",
  expiresAt: "2099-01-01T00:00:00Z",
  effects: ["Review the actual target and statement"],
};
const result: SqlExecutionResult = {
  id: "operation-a",
  name: command.name,
  path,
  revision: "revision-a",
  targetLabel: "Local PostgreSQL",
  targetIdentity: "target-a",
  startedAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:01Z",
  status: "committed",
  database: "committed",
  message: "PostgreSQL confirmed COMMIT.",
  rowCount: 1,
  rows: [{ label: "demo" }],
  truncated: false,
};
before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const name of [
    "window",
    "self",
    "document",
    "navigator",
    "Window",
    "HTMLElement",
    "HTMLDialogElement",
    "Element",
    "Node",
    "MutationObserver",
    "getComputedStyle",
  ] as const)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
    });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: dom.window.requestAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(globalThis, "scrollTo", {
    configurable: true,
    value: () => {},
  });
  dom.window.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  ui = require("@testing-library/react");
  router = require("@tanstack/react-router");
  view = await import("../src/views/DatabaseSql");
});
afterEach(() => {
  ui.cleanup();
  mock.restoreAll();
});
after(() => dom.window.close());
async function mount(value = catalog, initialMode: Mode = "dev") {
  mock.method(view.databaseSqlApi, "load", async () => value);
  const { createElement: h, useState } = require("react");
  let changeMode: (mode: Mode) => void = () => {};
  function Root() {
    const [mode, setMode] = useState(initialMode);
    changeMode = setMode;
    const pathname = router.useLocation({
      select: (location) => location.pathname,
    });
    return h(
      "div",
      null,
      h(
        "section",
        { hidden: pathname !== "/database/sql" },
        h(view.DatabaseSql, { active: pathname === "/database/sql", mode }),
      ),
      h(router.Outlet),
    );
  }
  const root = router.createRootRoute({ component: Root });
  const application = router.createRouter({
    history: router.createMemoryHistory({ initialEntries: ["/database/sql"] }),
    routeTree: root.addChildren([
      router.createRoute({
        getParentRoute: () => root,
        path: "/database/sql",
        component: () => null,
      }),
      router.createRoute({
        getParentRoute: () => root,
        path: "/deploy",
        component: () => h("p", null, "Other workspace"),
      }),
    ]),
  });
  const mounted = ui.render(h(router.RouterProvider, { router: application }));
  await ui.waitFor(() =>
    assert.ok(!mounted.queryByText("Loading saved commands…")),
  );
  await mounted.findByRole("navigation", { name: "Saved SQL commands" });
  return {
    ...mounted,
    application,
    setMode: (mode: Mode) => ui.act(() => changeMode(mode)),
  };
}
async function open(value = catalog) {
  const mounted = await mount(value);
  ui.fireEvent.click(
    mounted.getByRole("button", {
      name: "Open SQL command " + value.commands[0]!.command.name,
    }),
  );
  return mounted;
}
async function approve(mounted: Awaited<ReturnType<typeof mount>>) {
  const dialog = await mounted.findByRole("dialog", {
    name: "Approve SQL execution",
  });
  ui.fireEvent.change(
    ui.within(dialog).getByLabelText("SQL execution confirmation"),
    { target: { value: review.confirmation } },
  );
  ui.fireEvent.click(
    ui.within(dialog).getByRole("button", { name: "Execute reviewed SQL" }),
  );
  return dialog;
}
test("empty catalog offers a harmless query starter and a blank seed without inventing tables", async () => {
  const mounted = await mount({ ...catalog, commands: [] });
  assert.ok(mounted.getByText("No saved commands yet."));
  assert.equal(mounted.queryByLabelText("SQL source"), null);
  ui.fireEvent.click(mounted.getByRole("button", { name: "Create query" }));
  assert.match(
    (mounted.getByLabelText("SQL source") as HTMLTextAreaElement).value,
    /SELECT current_database\(\)/,
  );
  assert.doesNotMatch(
    (mounted.getByLabelText("SQL source") as HTMLTextAreaElement).value,
    /demo_items|INSERT/,
  );
  ui.fireEvent.click(mounted.getByRole("button", { name: "Create seed" }));
  assert.equal(
    (mounted.getByLabelText("SQL source") as HTMLTextAreaElement).value,
    "",
  );
  assert.equal(
    (
      mounted.getByRole("button", {
        name: "Review SQL source",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
});
test("execution errors remain visible inside the approval modal and never imply success", async () => {
  const mounted = await open();
  mock.method(view.databaseSqlApi, "executionReview", async () => review);
  mock.method(view.databaseSqlApi, "execute", async () => {
    throw new Error("Source or target changed. Review again.");
  });
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  const dialog = await approve(mounted);
  await ui.waitFor(() =>
    assert.match(
      ui.within(dialog).getByRole("alert").textContent!,
      /Source or target changed/,
    ),
  );
  assert.equal(mounted.queryByLabelText("SQL execution result"), null);
});
test("confirmed results show readable rows and revision, then clear when mode changes", async () => {
  const mounted = await open();
  mock.method(view.databaseSqlApi, "executionReview", async () => review);
  mock.method(view.databaseSqlApi, "execute", async () => result);
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  await approve(mounted);
  const section = await mounted.findByLabelText("SQL execution result");
  assert.match(section.textContent!, /seed_demo.*committed/);
  assert.match(section.textContent!, /revision-a/);
  assert.ok(ui.within(section).getByRole("columnheader", { name: "label" }));
  assert.ok(ui.within(section).getByRole("cell", { name: "demo" }));
  mounted.setMode("prod");
  await ui.waitFor(() =>
    assert.equal(mounted.queryByLabelText("SQL execution result"), null),
  );
  assert.equal(
    mounted.queryByRole("button", { name: "Review execution" }),
    null,
  );
  assert.ok(mounted.getByText(/Production · source editing only/));
  assert.ok(mounted.getByLabelText("SQL source"));
});
test("named parameter controls preserve bound scalar types and reject invalid numbers before review", async () => {
  const typed = {
    ...command,
    parameters: ["label", "limit", "enabled", "optional"],
  };
  const mounted = await open({
    ...catalog,
    commands: [{ path, revision: "revision-a", command: typed }],
  });
  const calls: unknown[][] = [];
  mock.method(
    view.databaseSqlApi,
    "executionReview",
    async (...args: unknown[]) => {
      calls.push(args);
      return review;
    },
  );
  ui.fireEvent.change(mounted.getByLabelText("SQL parameter label"), {
    target: { value: "demo" },
  });
  ui.fireEvent.change(mounted.getByLabelText("Type for SQL parameter limit"), {
    target: { value: "number" },
  });
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  await ui.waitFor(() =>
    assert.match(
      mounted.getByRole("alert").textContent!,
      /valid number for limit/,
    ),
  );
  assert.equal(calls.length, 0);
  ui.fireEvent.change(mounted.getByLabelText("SQL parameter limit"), {
    target: { value: "12" },
  });
  ui.fireEvent.change(
    mounted.getByLabelText("Type for SQL parameter enabled"),
    { target: { value: "boolean" } },
  );
  ui.fireEvent.change(mounted.getByLabelText("SQL parameter enabled"), {
    target: { value: "true" },
  });
  ui.fireEvent.change(
    mounted.getByLabelText("Type for SQL parameter optional"),
    { target: { value: "null" } },
  );
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  await mounted.findByRole("dialog", { name: "Approve SQL execution" });
  assert.deepEqual(calls, [
    [path, "revision-a", "local:postgres", ["demo", 12, true, null]],
  ]);
});
test("command switching, navigation and unload protect an edited SQL draft", async () => {
  const mounted = await open();
  ui.fireEvent.change(mounted.getByLabelText("SQL source"), {
    target: { value: command.sql + " RETURNING label" },
  });
  const event = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  ui.fireEvent.click(mounted.getByRole("button", { name: "Create query" }));
  let guard = await mounted.findByRole("dialog", {
    name: "Discard SQL draft?",
  });
  ui.fireEvent.click(
    ui.within(guard).getByRole("button", { name: "Keep editing" }),
  );
  assert.match(
    (mounted.getByLabelText("SQL source") as HTMLTextAreaElement).value,
    /RETURNING label/,
  );
  void mounted.application.navigate({ to: "/deploy" });
  guard = await mounted.findByRole("dialog", { name: "Discard SQL draft?" });
  assert.equal(mounted.application.state.location.pathname, "/database/sql");
  ui.fireEvent.click(
    ui.within(guard).getByRole("button", { name: "Discard and continue" }),
  );
  await mounted.findByText("Other workspace");
  assert.equal(mounted.application.state.location.pathname, "/deploy");
  const after = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});
test("a late execution review cannot reopen after a Development Production Development cycle", async () => {
  const mounted = await open();
  let resolve!: (value: SqlExecutionReview) => void;
  mock.method(
    view.databaseSqlApi,
    "executionReview",
    () =>
      new Promise<SqlExecutionReview>((next) => {
        resolve = next;
      }),
  );
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  mounted.setMode("prod");
  mounted.setMode("dev");
  await ui.act(async () => resolve(review));
  assert.equal(
    mounted.queryByRole("dialog", { name: "Approve SQL execution" }),
    null,
  );
});
test("an accepted local execution refreshes history but never resurfaces under another mode generation", async () => {
  const mounted = await open();
  let resolve!: (value: SqlExecutionResult) => void;
  mock.method(view.databaseSqlApi, "executionReview", async () => review);
  mock.method(
    view.databaseSqlApi,
    "execute",
    () =>
      new Promise<SqlExecutionResult>((next) => {
        resolve = next;
      }),
  );
  const load = mock.method(view.databaseSqlApi, "load", async () => catalog);
  ui.fireEvent.click(mounted.getByRole("button", { name: "Review execution" }));
  await approve(mounted);
  mounted.setMode("prod");
  mounted.setMode("dev");
  await ui.act(async () => resolve(result));
  assert.equal(mounted.queryByLabelText("SQL execution result"), null);
  assert.ok(load.mock.callCount() > 0);
});

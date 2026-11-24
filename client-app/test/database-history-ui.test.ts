import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h, useState } from "react";
import type { DatabaseHistory as HistoryData, DatabaseSchemaComparison } from "../shared/database-history";
import type { DatabaseObservation, DatabaseWorkbench } from "../shared/database-workbench";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";

const require = createRequire(import.meta.url);
const first = "a".repeat(64), second = "b".repeat(64), orphan = "c".repeat(64);
const saved: DatabaseWorkbench = {
  file: "packages/database/prisma/contract.prisma", source: "// use prisma-8\n", revision: "source", configRevision: "config",
  validation: { sourceHash: "source", valid: true, diagnostics: [], validatedAt: "2026-10-22T12:00:00Z", storageHash: second },
  targets: [], capabilities: { dialect: "Prisma 8", semanticValidation: true, formatting: true, languageServer: false, notes: [] },
};
const historyData: HistoryData = {
  revision: "history", sourceHash: "source", observedAt: "2026-10-22T12:00:00Z", heads: [second], refs: [], issues: [],
  migrations: [{ id: "app/create", space: "app", name: "create", from: first, to: second, createdAt: "2026-10-22T12:00:00Z", migrationHash: "d".repeat(64), integrity: "verified", operations: [], source: "// migration source", sourcePath: "migration.ts", sourceVerification: "not-executed", pendingPlaceholders: false, issues: [] }],
  snapshots: [first, second, orphan].map(hash => ({ hash, path: `snapshots/${hash}/contract.json`, available: true, provenance: "semantic-contract", contract: {}, issues: [] })),
};
const comparison: DatabaseSchemaComparison = { from: "saved", to: "saved", sourceHash: "source", historyRevision: "history", fromStorageHash: second, toStorageHash: second, storageChanged: false, domainChanged: false, executionChanged: false, changes: [], limitations: [], observedAt: "2026-10-22T12:00:00Z" };

let ui: typeof import("@testing-library/react");
let router: typeof import("@tanstack/react-router");
let view: typeof import("../src/views/DatabaseHistory");
let dom: { window: Window & typeof globalThis };
let update: (value: { saved: DatabaseWorkbench; snapshotRevision: string }) => void;

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "Window", "HTMLElement", "HTMLDialogElement", "Element", "Node", "Text", "MutationObserver", "DOMRect", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  dom.window.scrollTo = () => {};
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); router = require("@tanstack/react-router");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
  view = await import("../src/views/DatabaseHistory");
});
afterEach(() => { ui.cleanup(); mock.restoreAll(); });
after(() => dom.window.close());

async function mount({ mode = "dev", observation, advanced = true }: { mode?: "dev" | "prod"; observation?: DatabaseObservation; advanced?: boolean } = {}) {
  function Harness() {
    const [props, setProps] = useState({ saved, snapshotRevision: "snapshot" });
    update = setProps;
    return h(view.DatabaseHistory, { ...props, mode, observation, active: true, draft: saved.source, dirty: false, onInstalled() {} });
  }
  const root = router.createRootRoute({ component: () => h(router.Outlet) });
  const application = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/history"] }), routeTree: root.addChildren([
    router.createRoute({ getParentRoute: () => root, path: "/history", component: Harness }),
  ]) });
  ui.render(h(router.RouterProvider, { router: application }));
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("button", { name: "Plan migration" }) as HTMLButtonElement).disabled, false));
  if (advanced) ui.fireEvent.click(ui.screen.getByText("Advanced history details"));
}

test("named changes and SQL lead history while technical comparisons start collapsed", async () => {
  const sql = 'ALTER TABLE "projects" ADD COLUMN "summary" text;';
  const migration = { ...historyData.migrations[0], name: "20261022T1200_add_project_summary", operations: [{ id: "summary", label: "Add projects.summary", operationClass: "additive", statements: [{ phase: "execute" as const, sql }] }] };
  mock.method(view.historyApi, "load", async () => ({ ...historyData, migrations: [migration] }));
  mock.method(view.historyApi, "compare", async () => ({ ...comparison, from: first, to: second, storageChanged: true }));
  await mount({ advanced: false });
  const list = ui.screen.getByRole("navigation", { name: "Migration graph" });
  assert.match(list.textContent!, /Add project summary/);
  assert.match(list.textContent!, /Add projects\.summary/);
  assert.equal(list.textContent!.includes(first.slice(0, 12)), false);
  assert.equal(ui.screen.getByText("Advanced history details").closest("details")!.open, false);
  ui.fireEvent.click(ui.within(list).getByRole("button"));
  await ui.waitFor(() => assert(ui.screen.getByRole("heading", { name: "Changes & SQL" })));
  assert(ui.screen.getByText(sql));
  assert.equal(ui.screen.getByText("Add projects.summary", { selector: "strong" }).closest("details")!.open, true);
});

test("application status uses only a current observation for the active declaration mode", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  const observation: DatabaseObservation = {
    id: "observed", targetId: "local:postgres", targetIdentity: "local", observedAt: "2026-10-22T12:00:00Z",
    savedRevision: "source", historyRevision: "history", baseline: { label: "Saved schema", storageHash: second }, status: "observed",
    marker: { status: "matches" }, physical: { status: "matches", issues: [], warnings: [] },
    migrationState: { status: "current", message: "At saved storage contract." },
    ledger: [{ migrationHash: historyData.migrations[0].migrationHash, name: "create", from: first, to: second, appliedAt: "2026-10-22T12:00:00Z" }], message: "Observed", limits: [],
  };
  await mount({ observation, advanced: false });
  assert.match(ui.screen.getByRole("region", { name: "Migration application status" }).textContent!, /Migration history current/);
  assert(ui.within(ui.screen.getByRole("navigation", { name: "Migration graph" })).getByText("Applied"));
  ui.cleanup();
  await mount({ mode: "prod", observation, advanced: false });
  assert.match(ui.screen.getByRole("region", { name: "Migration application status" }).textContent!, /Production database.*Not checked/);
  assert.equal(ui.screen.queryByText("Applied", { exact: true }), null);
  ui.cleanup();
  await mount({ observation: { ...observation, historyRevision: "old-history" }, advanced: false });
  assert.match(ui.screen.getByRole("region", { name: "Migration application status" }).textContent!, /Not checked/);
  assert.equal(ui.screen.queryByText("Applied", { exact: true }), null);
});

test("baseline selectors are frozen while a comparison is pending", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  let resolve!: (value: DatabaseSchemaComparison) => void;
  mock.method(view.historyApi, "compare", () => new Promise<DatabaseSchemaComparison>(done => { resolve = done; }));
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Compare schemas" }));
  await ui.waitFor(() => assert((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled));
  assert((ui.screen.getByLabelText("To") as HTMLSelectElement).disabled);
  await ui.act(async () => { resolve(comparison); });
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled, false));
  assert(ui.screen.getByText("These semantic contracts are equal. Authored comments and formatting are outside this comparison."));
});

test("snapshot and configuration changes expire a comparison and load fresh history", async () => {
  const load = mock.method(view.historyApi, "load", async () => historyData);
  mock.method(view.historyApi, "compare", async () => comparison);
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Compare schemas" }));
  await ui.waitFor(() => assert(ui.screen.getByText("These semantic contracts are equal. Authored comments and formatting are outside this comparison.")));
  const beforeSnapshot = load.mock.callCount();
  await ui.act(async () => { update({ saved, snapshotRevision: "snapshot-2" }); });
  await ui.waitFor(() => assert.equal(load.mock.callCount(), beforeSnapshot + 1));
  assert.equal(ui.screen.queryByText("These semantic contracts are equal. Authored comments and formatting are outside this comparison."), null);
  const beforeConfig = load.mock.callCount();
  await ui.act(async () => { update({ saved: { ...saved, configRevision: "config-2" }, snapshotRevision: "snapshot-2" }); });
  await ui.waitFor(() => assert.equal(load.mock.callCount(), beforeConfig + 1));
  assert(ui.screen.getByRole("button", { name: "Compare schemas" }));
});

test("planning offers known app graph origins while orphan snapshots remain comparison-only", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  await mount();
  assert((ui.screen.getByLabelText("From") as HTMLSelectElement).querySelector(`option[value="${orphan}"]`));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Plan migration" }));
  const baseline = await ui.screen.findByLabelText("Migration baseline") as HTMLSelectElement;
  assert(baseline.querySelector(`option[value="${first}"]`));
  assert(baseline.querySelector(`option[value="${second}"]`));
  assert.equal(baseline.querySelector(`option[value="${orphan}"]`), null);
  assert.equal(baseline.value, "", "planning never chooses a baseline by date or graph position");
  assert.match(baseline.querySelector(`option[value="${first}"]`)!.textContent!, /Before Create/);
  assert.match(baseline.querySelector(`option[value="${second}"]`)!.textContent!, /After Create/);
});

test("a comparison completed after history invalidation cannot overwrite fresh history", async () => {
  mock.method(view.historyApi, "load", async () => historyData);
  let resolve!: (value: DatabaseSchemaComparison) => void;
  mock.method(view.historyApi, "compare", () => new Promise<DatabaseSchemaComparison>(done => { resolve = done; }));
  await mount();
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Compare schemas" }));
  await ui.waitFor(() => assert((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled));
  await ui.act(async () => { update({ saved, snapshotRevision: "new-history" }); });
  await ui.waitFor(() => assert.equal((ui.screen.getByLabelText("From") as HTMLSelectElement).disabled, false));
  await ui.act(async () => { resolve({ ...comparison, storageChanged: true }); });
  assert.equal(ui.screen.queryByText("Comparison evidence and limits"), null);
});

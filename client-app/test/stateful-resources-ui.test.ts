import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, mock, test } from "node:test";
import { createElement as h } from "react";
import type { SnapshotResponse } from "../shared/api";
import type { ModeModel, Snapshot } from "../shared/model";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { connectionCatalogFixture } from "./browser/support/aws-connections";
import { discoveryFor } from "./browser/support/scenarios";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react"), query: typeof import("@tanstack/react-query"), router: typeof import("@tanstack/react-router"), studio: typeof import("../src/studio"), view: typeof import("../src/views/DataRetention");
let observations: typeof import("../src/deploy/observations");
const clients: import("@tanstack/react-query").QueryClient[] = [];
let posted: { url: string; body: any }[];
let activeStudio: ReturnType<typeof import("../src/studio").useStudio>;
let retentionGate: Promise<void> | undefined;
const model = (mode: "dev" | "prod"): ModeModel => ({ mode, status: "ok", targets: [], routes: [], resources: [], edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0 });
const snapshot = { revision: "r1", repositoryRoot: "/fixture", generatedAt: "2026-10-23T12:00:00Z", descriptions: { values: {} }, databaseProblems: [], models: { dev: model("dev"), prod: model("prod") }, files: {}, source: { cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, entities: {}, editability: {}, links: {}, catalog: {}, problems: [] } } as unknown as Snapshot;
const response: SnapshotResponse = { snapshot, evaluating: false, commands: {}, busy: null };
before(async () => {
  require.extensions[".css"] = () => {};
  dom = new (require("jsdom").JSDOM)(`<!doctype html><html><head><meta name="studio-token" content="t"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "HTMLDialogElement", "Element", "Node", "MutationObserver", "getComputedStyle"] as const) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  ui = require("@testing-library/react"); query = require("@tanstack/react-query"); router = require("@tanstack/react-router"); studio = await import("../src/studio"); observations = await import("../src/deploy/observations"); view = await import("../src/views/DataRetention");
  ui.configure({ getElementError: message => new Error(message ?? "Element not found") });
});
afterEach(async () => { ui.cleanup(); for (const client of clients.splice(0)) { await client.cancelQueries(); client.clear(); } mock.restoreAll(); }); after(() => dom.window.close());

function answers() {
  posted = [];
  retentionGate = undefined;
  mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body) posted.push({ url, body });
    let value: unknown;
    if (url.startsWith("/api/stateful-resources/source")) { const mode = url.includes("prod") ? "prod" : "dev"; value = { file: "framework-config/deployment/stateful-resources.ts", hash: `${mode}-hash`, mode, resources: { database: {}, cognito: { retention: "retain" } }, legacy: { file: `cdk-app/.env.${mode}`, retain: false, configured: true }, problems: [] }; }
    else if (url.startsWith("/api/deploy/overview")) value = { jobs: [], preferences: { profiles: {} }, targets: [{ name: "job2-dev", mode: "dev", region: "us-east-1" }, { name: "job2-prod", mode: "prod", region: "us-east-1" }], profiles: [{ name: "dev", region: "us-east-1" }] };
    else if (url === "/api/aws-connections") value = connectionCatalogFixture([{ name: "dev", region: "us-east-1" }]);
    else if (url.startsWith("/api/deploy/status?")) { const request = new URL(url, "http://localhost"); value = { ok: true, value: { ...discoveryFor(request), deployment: request.searchParams.get("deployment") } }; }
    else if (url === "/api/stateful-resources/retention/plan") { await retentionGate; value = { planId: "plan", expiresAt: "later", effects: ["Source only; deployment is separate."], changes: [{ file: "framework-config/deployment/stateful-resources.ts", diff: { unified: `+ ${body.kind}: ${body.retention}` } }] }; }
    else if (url === "/api/stateful-resources/inventory") value = { account: "123456789012", region: body.selection.region, ledgers: [] };
    else if (url.startsWith("/api/deploy/teardown?")) value = { ok: true, value: { deployment: "job2-prod", mode: "prod", account: "123456789012", region: "us-east-1", stacks: [], leftInPlace: [], remains: [{ stack: "job2-prod-database", logicalId: "Database", type: "AWS::RDS::DBInstance", policy: "Retain" }], secrets: [], record: true } };
    else if (url === "/api/stateful-resources/apply") value = { status: "applied", message: "Saved source only; deployment is separate." };
    else if (url === "/api/stateful-resources/reference/plan") return new Response(JSON.stringify({ error: "Original app client is missing. Choose a surviving public app client." }), { status: 422 });
    else value = response;
    return new Response(JSON.stringify(value), { status: 200 });
  });
}
async function mount(kind?: "database" | "cognito") {
  dom.window.localStorage.setItem(`aws-studio:mode-profiles:v1:${snapshot.repositoryRoot}`, JSON.stringify({dev:"dev",prod:"dev"}));
  function Workspace() { activeStudio = studio.useStudio(); return h("div", null, h(observations.GlobalDeploymentObservations), h(router.Outlet)); }
  function Root() { return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h(Workspace) }); }
  const root = router.createRootRoute({ component: Root }), app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/lifecycle"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/lifecycle", component: () => h(view.DataRetention, { kind }) })]) });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client);
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.waitFor(() => assert.ok(!(document.querySelector(`[aria-label="${kind === "cognito" ? "Cognito User Pool" : "Database"} retention policy"]`) as HTMLSelectElement).disabled));
}
test("independent retention is reviewed before source apply and deployed protection stays unverified", async () => {
  answers(); await mount();
  assert.equal((ui.screen.getByRole("combobox", { name: "Cognito User Pool retention policy" }) as HTMLSelectElement).value, "retain");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database retention policy" }), { target: { value: "retain" } });
  await ui.screen.findByRole("dialog", { name: "Review lifecycle source" });
  assert.equal(posted.length, 1); assert.equal(posted[0]!.body.kind, "database");
  assert.equal(posted[0]!.body.mode, "dev"); assert.equal(posted[0]!.body.hash, "dev-hash");
  assert.match(document.body.textContent!, /Unverified for this destination/);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Cancel" }));
  assert.equal(posted.length, 1, "cancel cannot write source");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database retention policy" }), { target: { value: "remove" } });
  await ui.screen.findByRole("dialog", { name: "Review lifecycle source" });
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Save lifecycle source" }));
  await ui.screen.findByText("Saved source only; deployment is separate.");
  assert.equal(posted.filter(post => post.url.endsWith("/apply")).length, 1);
});
test("retained Cognito review sends exact destination and existing client; failed prerequisites remain actionable without apply", async () => {
  answers(); await mount("cognito");
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Lifecycle destination" }), { target: { value: "job2-dev" } });
  ui.fireEvent.click(ui.screen.getByText("Reference a retained resource"));
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Original resource deployment" }), { target: { value: "old-dev" } });
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Retained resource ID" }), { target: { value: "us-east-1_Original" } });
  const review = ui.screen.getByRole("button", { name: "Inspect and review reference source" }) as HTMLButtonElement;
  assert.equal(review.disabled, true);
  ui.fireEvent.change(ui.screen.getByRole("textbox", { name: "Retained Cognito app client ID" }), { target: { value: "oldclient123" } });
  assert.equal(review.disabled, false); ui.fireEvent.click(review);
  await ui.screen.findByRole("alert");
  assert.match(document.body.textContent!, /Choose a surviving public app client/);
  assert.equal(posted.length, 1); assert.deepEqual(posted[0]!.body.selection, { profile: "dev", deployment: "job2-dev", region: "us-east-1", mode: "dev" });
  assert.equal(posted[0]!.body.clientId, "oldclient123"); assert.equal(posted.filter(post => post.url.endsWith("/apply")).length, 0);
});

test("database retention leads with local volume persistence and follows the shared declaration mode", async () => {
  answers(); await mount("database");
  assert.ok(ui.screen.getByRole("region", { name: "Local PostgreSQL persistence" }));
  assert.match(ui.screen.getByRole("region", { name: "Local PostgreSQL persistence" }).textContent!, /Rebuild images or recreate containersData kept/);
  assert.equal(ui.screen.queryByRole("combobox", { name: "Retention environment" }), null);
  assert.equal(ui.screen.getByRole("combobox", { name: "Database retention policy" }).closest("details")!.open, false);
  assert.equal(ui.screen.getByText("Advanced AWS retention and recovery").closest("details")!.open, false);
  assert.equal(ui.screen.getByRole("link", { name: "Check local database" }).getAttribute("href"), "/database/status");
  assert.equal(posted.length, 0, "opening retention never writes source or inspects AWS");

  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: "When the deployment is deleted" });
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("combobox", { name: "Database retention policy" }) as HTMLSelectElement).disabled, false));
  assert.equal(ui.screen.queryByRole("region", { name: "Local PostgreSQL persistence" }), null);
  assert.equal(ui.screen.queryByRole("combobox", { name: "Retention environment" }), null);
  assert.match(ui.screen.getByRole("status").textContent!, /Not checked: Unverified for this destination/);
  assert.equal(ui.screen.getByText("Inspect deployed protection", { exact: true }).closest("details")!.open, false);
  assert.equal(ui.screen.getByText("Advanced retained-resource recovery").closest("details")!.open, false);
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database retention policy" }), { target: { value: "retain" } });
  await ui.screen.findByRole("dialog", { name: "Review lifecycle source" });
  assert.deepEqual(posted.map(post => [post.url, post.body.mode]), [["/api/stateful-resources/retention/plan", "prod"]]);
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Cancel" }));
  assert.equal(posted.filter(post => post.url.endsWith("/apply")).length, 0);
});

test("production protection stays unverified until an explicit destination inspection and clears on mode change", async () => {
  answers(); await mount("database");
  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: "When the deployment is deleted" });
  ui.fireEvent.click(ui.screen.getByText("Inspect deployed protection", { exact: true }));
  const destination = await ui.screen.findByRole("combobox", { name: "Lifecycle destination" });
  ui.fireEvent.change(destination, { target: { value: "job2-prod" } });
  const inspect = ui.screen.getByRole("button", { name: "Inspect deployed protection and inventory" }) as HTMLButtonElement;
  await ui.waitFor(() => assert.equal(inspect.disabled, false));
  ui.fireEvent.click(inspect);
  await ui.screen.findByText(/1 stateful resource policies/);
  assert.match(ui.screen.getByRole("status").textContent!, /Last observed:/);
  assert.match(document.body.textContent!, /job2-prod-database\/Database/);
  assert.equal(posted.filter(post => /\/(apply|plan)$/.test(post.url)).length, 0);
  assert.deepEqual(posted[0]!.body.selection, { mode: "prod", profile: "dev", deployment: "job2-prod", region: "us-east-1" });
  ui.act(() => activeStudio.setMode("dev"));
  await ui.screen.findByRole("heading", { name: "Local data survives restarts" });
  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: "When the deployment is deleted" });
  assert.match(ui.screen.getByRole("status").textContent!, /Not checked: Unverified/);
});

test("a retention review arriving after a declaration-mode change cannot reopen the old mode's source plan", async () => {
  answers(); await mount("database");
  ui.fireEvent.click(ui.screen.getByText("Advanced AWS retention and recovery"));
  let finish!: () => void;
  retentionGate = new Promise<void>(resolve => { finish = resolve; });
  ui.fireEvent.change(ui.screen.getByRole("combobox", { name: "Database retention policy" }), { target: { value: "retain" } });
  ui.act(() => activeStudio.setMode("prod"));
  await ui.screen.findByRole("heading", { name: "When the deployment is deleted" });
  await ui.act(async () => { finish(); });
  await ui.waitFor(() => assert.equal((ui.screen.getByRole("combobox", { name: "Database retention policy" }) as HTMLSelectElement).disabled, false));
  assert.equal(ui.screen.queryByRole("dialog", { name: "Review lifecycle source" }), null);
  assert.equal(posted.filter(post => post.url.endsWith("/apply")).length, 0);
});

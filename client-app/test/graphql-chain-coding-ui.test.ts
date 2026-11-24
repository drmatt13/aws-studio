import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { snapshot as snapshotFixture, dockerStatus } from "./browser/support/scenarios";
import { logEvidence } from "./support/development-logs";
import { openCodingTask, prepareCodingTask } from "../src/coding-task-navigation";
import type { CodingTask, CodingTaskRequest } from "../shared/agent-runtime";
import { contractTaskFixture } from "./support/contract-propagation";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let router: typeof import("@tanstack/react-router");
let studio: typeof import("../src/studio");
let activity: typeof import("../src/views/GlobalActivity");
let client: import("@tanstack/react-query").QueryClient;
const posts: CodingTaskRequest[] = [], reads: string[] = [];
const resumptions: string[] = [];
let repairTask: CodingTask | undefined;
let startSucceeds: boolean, providerAvailable: boolean;
let modelsWaiting: Promise<void> | undefined;
const response = snapshotFixture();

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-token" content="fixture"><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`, { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "getComputedStyle", "localStorage"] as const)
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: dom.window.requestAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: dom.window.cancelAnimationFrame.bind(dom.window) });
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    if (init?.method === "POST") {
      if (url.pathname === "/api/agent-tasks") {
        const request = JSON.parse(String(init.body)) as CodingTaskRequest; posts.push(request);
        if (!startSucceeds) return new Response(JSON.stringify({ error: "Coding host temporarily unavailable" }), { status: 503 });
        repairTask = { id: "coding-task", provider: request.provider, status: "queued", prompt: request.prompt, createdAt: "now", updatedAt: "now", lastSeq: 0, cancelRequested: false };
        return Response.json(repairTask);
      }
      if (repairTask && url.pathname === `/api/agent-tasks/${repairTask.id}/resume`) { resumptions.push(repairTask.id); repairTask = { ...repairTask, status: "queued" }; return Response.json(repairTask); }
      throw new Error(`Unexpected mutation ${url.pathname}`);
    }
    reads.push(url.pathname);
    if (url.pathname === "/api/agent-lab/models") await modelsWaiting;
    const answer = url.pathname === "/api/operations" ? { jobs: [] }
      : url.pathname === "/api/machine/docker" ? dockerStatus()
      : url.pathname === "/api/agent-lab/status" ? { providers: [{ id: "codex", label: "Codex", available: providerAvailable, detail: providerAvailable ? "Fixture" : "Sign in to Codex before starting" }], busy: false }
      : url.pathname === "/api/agent-lab/models" ? { provider: "codex", source: "cli", models: [] }
      : url.pathname === "/api/agent-tasks" ? { tasks: repairTask ? [repairTask] : [] }
      : repairTask && url.pathname === `/api/agent-tasks/${repairTask.id}/events` ? { task: repairTask, events: [] }
      : url.pathname === "/api/agent-tasks/recovery" ? { coordination: { status: "ready", epoch: "fixture" }, recoveries: [] }
      : url.pathname === "/api/development-logs/evidence" ? logEvidence()
      : url.pathname === "/api/aws-connections" ? { revision: "fixture", profiles: [], sessions: [], diagnostics: [], environment: { credentialsPresent: false, endpointOverridesPresent: false }, capabilities: { available: false } }
      : undefined;
    if (!answer) throw new Error(`Unexpected read ${url.pathname}`);
    return new Response(JSON.stringify(answer));
  } });
  ui = require("@testing-library/react"); query = require("@tanstack/react-query"); router = require("@tanstack/react-router");
  studio = await import("../src/studio"); activity = await import("../src/views/GlobalActivity");
  // Module compilation is test setup, not evidence that a panel mounted or read data.
  // Keep the lazy mount/visibility assertions below independent of a cold tsx cache.
  await Promise.all([import("../src/sightline/AgentViews"), import("../src/views/agent/CodingPanel")]);
});
beforeEach(() => { posts.length = 0; reads.length = 0; resumptions.length = 0; repairTask = undefined; startSucceeds = false; providerAvailable = true; modelsWaiting = undefined; dom.window.localStorage.clear(); client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); client.setQueryData(["snapshot"], response); });
afterEach(async () => { ui.cleanup(); await client.cancelQueries(); client.clear(); });
after(() => dom.window.close());

async function renderTray() {
  const root = router.createRootRoute({ component: () => h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children: h(activity.GlobalActivity) }) });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root.addChildren([router.createRoute({ getParentRoute: () => root, path: "/", component: () => null })]) });
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  await ui.screen.findByRole("region", { name: "Activity" });
  return ui.within(ui.screen.getByRole("region", { name: "Activity" }));
}
function prepare(id: string, prompt: string, repository = response.snapshot.repositoryRoot) {
  ui.act(() => prepareCodingTask(repository, { id, prompt }));
}

test("a GraphQL handoff opens the ordinary composer with no checks or submission before Start", async () => {
  startSucceeds = true;
  const tray = await renderTray();
  prepare("codegen", "Generate and check GraphQL documents in the saved project.");
  const coding = ui.within(await ui.screen.findByRole("region", { name: "Coding tasks" }));
  const prompt = await coding.findByRole("textbox", { name: "Coding request" }) as HTMLTextAreaElement;
  await ui.waitFor(() => assert.equal(prompt.value, "Generate and check GraphQL documents in the saved project."));
  const start = coding.getByRole("button", { name: "Start coding task" });
  await ui.waitFor(() => assert.equal(start.hasAttribute("disabled"), false));
  assert.equal(tray.getByRole("tab", { name: "Coding" }).getAttribute("aria-selected"), "true");
  assert.equal(posts.length, 0);
  assert.equal(reads.some(path => path.startsWith("/api/graphql/")), false);
  assert.equal(coding.queryByText(/Application decisions/), null);
  assert.ok(coding.getByText(/Studio chooses checks based on the files changed/));

  const edited = "Generate the documents and preserve the existing selections.";
  ui.fireEvent.change(prompt, { target: { value: edited } });
  ui.fireEvent.click(start);
  await coding.findByRole("article", { name: "Selected coding task" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.prompt, edited);
  assert.equal(posts[0]!.provider, "codex");
  assert.equal(Object.hasOwn(posts[0]!, "validation"), false);
  assert.equal(Object.hasOwn(posts[0]!, "contract"), false);
  assert.equal(Object.hasOwn(posts[0]!, "contractRun"), false);
  assert.equal(reads.some(path => path.startsWith("/api/graphql/")), false);
});

test("the first lazy hand-off only prefills Coding and preserves an existing draft until a choice", async () => {
  const tray = await renderTray();
  assert.equal(ui.screen.queryByRole("textbox", { name: "Coding request" }), null);
  assert.equal(reads.filter(path => path === "/api/agent-tasks").length, 0);
  prepare("first", "Propagate Project.dueDate");
  const prompt = await ui.screen.findByRole("textbox", { name: "Coding request" }) as HTMLTextAreaElement;
  await ui.waitFor(() => assert.equal(prompt.value, "Propagate Project.dueDate"));
  assert.equal(posts.length, 0);
  assert.ok(ui.screen.getByText(/Studio chooses checks based on the files changed/));
  ui.fireEvent.change(prompt, { target: { value: "Keep this unsent source request" } });
  prepare("second", "Another propagation request");
  assert.equal(prompt.value, "Keep this unsent source request");
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Keep current draft" }));
  assert.equal(prompt.value, "Keep this unsent source request");
  prepare("third", "Use this propagation request");
  ui.fireEvent.click(await ui.screen.findByRole("button", { name: "Use suggested prompt" }));
  assert.equal(prompt.value, "Use this propagation request");
  assert.equal(posts.length, 0);
  ui.fireEvent.click(tray.getByRole("tab", { name: "Conversation" }));
  prepare("foreign", "Other repository work", "/another-repository");
  assert.equal(tray.getByRole("tab", { name: "Conversation" }).getAttribute("aria-selected"), "true");
  assert.equal(ui.screen.queryByRole("textbox", { name: "Coding request" }), null);
  ui.fireEvent.click(tray.getByRole("tab", { name: "Coding" }));
  assert.equal((await ui.screen.findByRole("textbox", { name: "Coding request" }) as HTMLTextAreaElement).value, "Use this propagation request");
});

test("hiding Coding stops its context reads and retains the same failed submission for retry", async () => {
  const tray = await renderTray();
  prepare("retry", "Propagate with a retry identity");
  const prompt = await ui.screen.findByRole("textbox", { name: "Coding request" }) as HTMLTextAreaElement;
  await ui.waitFor(() => assert.equal(prompt.value, "Propagate with a retry identity"));
  const start = await ui.screen.findByRole("button", { name: "Start coding task" });
  await ui.waitFor(() => assert.equal(start.hasAttribute("disabled"), false));
  ui.fireEvent.click(start);
  await ui.screen.findByText(/Coding host temporarily unavailable/);
  assert.equal(posts.length, 1);
  assert.equal(Object.hasOwn(posts[0]!, "validation"), false);
  ui.fireEvent.click(tray.getByRole("button", { name: "Agent: collapse panel" }));
  const before = reads.filter(path => path === "/api/development-logs/evidence").length;
  await ui.act(async () => { await client.invalidateQueries({ queryKey: ["development-log-evidence"] }); await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(reads.filter(path => path === "/api/development-logs/evidence").length, before);
  assert.equal(prompt.closest("[inert]") !== null, true);
  ui.fireEvent.click(tray.getByRole("button", { name: "Agent: expand panel" }));
  assert.equal((await ui.screen.findByRole("textbox", { name: "Coding request" }) as HTMLTextAreaElement).value, "Propagate with a retry identity");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Start coding task" }));
  await ui.waitFor(() => assert.equal(posts.length, 2));
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(posts[0]!.requestKey.length > 0, true);
});

test("known authored-operation failures offer repair only after an explicit action", async () => {
  const before = contractTaskFixture("codegen");
  repairTask = { ...before, status: "failed", proposalDigest: undefined, lastSeq: 0, canResumeValidation: true, contract: { ...before.contract!, stage: "client", status: "working", repairStage: "client", gateReason: "Authored operations failed Codegen. Resume to repair them.", checkpoints: before.contract!.checkpoints.map(checkpoint => ({ ...checkpoint, stage: "codegen", status: "failed", checks: checkpoint.checks.map(check => ({ ...check, status: "failed" })) })) } };
  await renderTray();
  ui.act(() => openCodingTask(response.snapshot.repositoryRoot, repairTask!));
  const repair = await ui.screen.findByRole("button", { name: "Repair authored operations" });
  assert.ok(ui.screen.getByText("Historical candidate evidence"));
  assert.ok(ui.screen.getByText("Authored operations failed Codegen. Resume to repair them."));
  assert.equal(resumptions.length, 0);
  ui.fireEvent.click(repair);
  await ui.waitFor(() => assert.deepEqual(resumptions, [before.id]));
});

test("provider recovery enables Start and leaves the suggested prompt in the ordinary composer", async () => {
  providerAvailable = false;
  await renderTray();
  prepare("unavailable-provider", "Reconcile Pothos");
  const coding = ui.within(await ui.screen.findByRole("region", { name: "Coding tasks" }));
  await coding.findByText("Sign in to Codex before starting");
  assert.equal(posts.length, 0);
  assert.equal(ui.screen.getByRole("button", { name: "Start coding task" }).hasAttribute("disabled"), true);
  assert.equal((ui.screen.getByRole("textbox", { name: "Coding request" }) as HTMLTextAreaElement).value, "Reconcile Pothos");
  providerAvailable = true;
  ui.fireEvent.click(coding.getByRole("button", { name: "Check again" }));
  await ui.waitFor(() => assert.equal(coding.getByRole("button", { name: "Start coding task" }).hasAttribute("disabled"), false));
  assert.equal(posts.length, 0);
});

test("a suggested prompt keeps the usual model options and waits for explicit Start", async () => {
  dom.window.localStorage.setItem("aws-studio:agent-preferences:v1", JSON.stringify({ provider: "codex", models: { codex: "unavailable-model", claude: "" } }));
  let release!: () => void; modelsWaiting = new Promise(resolve => { release = resolve; });
  await renderTray();
  prepare("check-model-first", "Reconcile the Pothos schema.");
  const coding = ui.within(await ui.screen.findByRole("region", { name: "Coding tasks" }));
  await coding.findByRole("textbox", { name: "Coding request" });
  await ui.waitFor(() => assert.ok(reads.includes("/api/agent-lab/models")));
  assert.equal(coding.getByRole("button", { name: "Start coding task" }).hasAttribute("disabled"), true);
  assert.equal(posts.length, 0);
  await ui.act(async () => release());
  await coding.findByText("The selected model is unavailable. Choose another model or CLI default.");
  assert.equal(posts.length, 0);
  ui.fireEvent.change(coding.getByRole("combobox", { name: "Agent model" }), { target: { value: "" } });
  await ui.waitFor(() => assert.equal(coding.getByRole("button", { name: "Start coding task" }).hasAttribute("disabled"), false));
  assert.equal(posts.length, 0);
});

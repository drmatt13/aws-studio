import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import { overview, dockerStatus, snapshot, discovery, NOW } from "./browser/support/scenarios";
import { connectionCatalogFixture } from "./browser/support/aws-connections";
import type { DockerView, JobView, LocalRunView, StatusView, StackView } from "../shared/deploy";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
const timers = new Set<ReturnType<typeof setTimeout>>();
let local: LocalRunView;
let router: typeof import("@tanstack/react-router");
let studio: typeof import("../src/studio");
let deployment: typeof import("../src/deploy/queries");
let profiles: typeof import("../src/aws-profile-queries");
let runtime: typeof import("../src/deploy/local-runtime");
const response = snapshot();
const destination = { deployment: "browser-dev", profile: "browser", account: "123456789012", region: "us-east-1" };
let ui: typeof import("@testing-library/react");
let view: typeof import("../src/views/map/ComposePreview");
let api: typeof import("../src/deploy/api").deployApi;
let operationsApi: typeof import("../src/operations/api").operationsApi;
let docker: DockerView;
let operations: string[];
let query: typeof import("@tanstack/react-query");
let machine: typeof import("../src/machine/docker");
let client: import("@tanstack/react-query").QueryClient;
let outcome: JobView["status"];
let readDocker: () => Promise<ReturnType<typeof dockerStatus>>;
/** When false, a started runtime job keeps running until it is cancelled. */
let settles: boolean;
let cancels: string[];
/** How many stop requests are refused because a cancelled start still holds the runtime lock. */

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  // JSDOM hides native popovers but does not implement showing them. Browser tests cover dismissal/focus.
  dom.window.HTMLElement.prototype.showPopover = function () { this.style.display = "block"; };
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string) => {
    if (input.startsWith("/api/machine/docker")) return new Response(JSON.stringify(await readDocker()));
    if (input.startsWith("/api/deploy/local")) return new Response(JSON.stringify({ ...local, docker }));
    if (input === "/api/operations") return new Response(JSON.stringify(client.getQueryData(["operations"]) ?? { jobs: [] }));
    throw new Error(`Unscripted ${input}`);
  } });
  Object.defineProperty(globalThis, "scrollTo", { configurable: true, value: () => {} });
  query = require("@tanstack/react-query");
  machine = await import("../src/machine/docker");
  ui = require("@testing-library/react");
  view = await import("../src/views/map/ComposePreview");
  api = (await import("../src/deploy/api")).deployApi;
  operationsApi = (await import("../src/operations/api")).operationsApi;
  router = require("@tanstack/react-router");
  studio = await import("../src/studio");
  deployment = await import("../src/deploy/queries");
  profiles = await import("../src/aws-profile-queries");
  runtime = await import("../src/deploy/local-runtime");
});

beforeEach(() => {
  docker = { engine: "running", desktop: true };
  operations = [];
  local = { ...overview().local, lifecycle: "off", activeContainerCount: 0, readiness: { state: "stopped", observedAt: NOW, message: "Stopped" } };
  outcome = "succeeded";
  settles = true;
  cancels = [];
  operationsApi.cancel = async (id) => {
    cancels.push(id);
    const jobs = (client.getQueryData<{ jobs: JobView[] }>(["operations"])?.jobs ?? [])
      .map(job => job.id === id ? { ...job, status: "cancelled" as const, cancelRequested: true, endedAt: NOW } : job);
    const timer = setTimeout(() => { timers.delete(timer); client.setQueryData(["operations"], { jobs }); }, 10);
    timers.add(timer);
    return jobs.find(job => job.id === id)!;
  };
  readDocker = async () => dockerStatus(docker);
  client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  api.overview = async () => ({ ...overview(), local: { ...overview().local, docker } });
  api.operate = async (kind, params) => {
    assert.ok(["docker-start", "local-start", "local-restart", "local-stop"].includes(kind), `unexpected operation: ${kind}`);
    if (kind === "local-start" || kind === "local-restart") assert.deepEqual(params, { ...destination, mode: "dev", export: true });
    if (kind === "local-stop") assert.deepEqual(params, {});
    operations.push(kind);
    const started: JobView = { id: `job-${operations.length}`, kind, title: kind, params, status: "running", startedAt: new Date(Date.now() + operations.length).toISOString(), lastSeq: 0 };
    if (kind === "local-start" && !settles) {
      // Containers are observed coming up while the start keeps running.
      local = { ...local, watch: { running: true }, client: { running: true }, lifecycle: "starting", activeContainerCount: 1,
        readiness: { state: "starting", observedAt: NOW, message: "Starting" },
        binding: { ...destination, startedAt: NOW }, exported: { ...destination, client: true } };
      return started;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (outcome === "succeeded") {
        if (kind === "docker-start") docker = { engine: "running", desktop: true };
        else {
          const running = kind === "local-start" || kind === "local-restart";
          local = { ...local, watch: { running }, client: { running }, lifecycle: running ? "running" : "off", activeContainerCount: running ? 1 : 0,
            readiness: { state: running ? "ready" : "stopped", observedAt: NOW, message: running ? "Ready" : "Stopped" },
            binding: { ...destination, startedAt: NOW }, exported: { ...destination, client: true } };
          client.setQueryData(runtime.localRuntimeQuery(response.snapshot.repositoryRoot).queryKey, local);
        }
      }
      client.setQueryData(["operations"], { jobs: [{ ...started, status: outcome, ...(outcome === "failed" ? { summary: "Docker Desktop could not start." } : {}) }] });
    }, 10);
    timers.add(timer);
    return started;
  };
});

afterEach(async () => {
  ui.cleanup();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  await client.cancelQueries(); client.clear();
  dom.window.localStorage.clear();
});
after(() => dom.window.close());

const mount = async (motion: boolean, compatible = true) => {
  const source = { repository: response.snapshot.repositoryRoot, sourceRevision: response.snapshot.revision };
  const scope = { ...source, mode: "dev" as const, profile: destination.profile, deployment: destination.deployment, generation: "0:0" };
  const stack: StackView = { name: "browser-dev-Core", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "browser-dev", mode: "dev" } };
  const status: StatusView = { ...discovery(), deployment: destination.deployment,
    detail: { name: destination.deployment, mode: "dev", account: destination.account, region: destination.region,
      stacks: [stack], contracts: [2], state: { kind: "ready", stacks: [stack] }, events: [], changeSets: [],
      local: { compatible, ...(compatible ? {} : { problem: "Deploy current source changes before starting locally." }), exported: { client: true, fresh: true } } } };
  dom.window.localStorage.setItem(`aws-studio:mode-profiles:v1:${source.repository}`, JSON.stringify({ dev: destination.profile }));
  client.setQueryData(deployment.deploymentOverviewQuery(false, source).queryKey, overview());
  client.setQueryData(profiles.awsProfileCatalogQuery().queryKey, connectionCatalogFixture([{ name: "browser", kind: "sso", region: "us-east-1" }]));
  client.setQueryData(deployment.deploymentStatusQuery(scope).queryKey, status);
  client.setQueryData(["operations"], { jobs: [] });
  client.setQueryData(runtime.localRuntimeQuery(source.repository).queryKey, local);
  function Root() {
    return h(studio.StudioProvider, { response, selected: undefined, select: () => {}, children:
      h("div", null, h(machine.GlobalDockerStatus), h(view.ComposePreview, { motion })) });
  }
  const root = router.createRootRoute({ component: Root });
  const app = router.createRouter({ history: router.createMemoryHistory({ initialEntries: ["/"] }), routeTree: root });
  ui.render(h(query.QueryClientProvider, { client }, h(router.RouterProvider, { router: app })));
  return await ui.screen.findByRole("switch", { name: "Local runtime" });
};
const cardOf = (control: HTMLElement) => control.closest<HTMLElement>("[data-ui='compose-preview']")!;
const status = (control: HTMLElement) =>
  [...cardOf(control).querySelectorAll("[data-slot='compose-status']")].find((item) => item.getAttribute("data-current") === "true")?.textContent;
const settled = async (control: HTMLElement) => ui.waitFor(() => {
  assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Running"); assert.equal(control.getAttribute("aria-busy"), "false");
});
/** Holds every operation of one kind until released, so the in-between scenes can be inspected. */
const hold = (kind: string) => {
  const operate = api.operate;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.operate = async (requested, params) => { if (requested === kind) await pending; return operate(requested, params); };
  return () => release();
};
const runningLocal = (): LocalRunView => ({ ...local, watch: { running: true }, client: { running: true }, lifecycle: "running", activeContainerCount: 1,
  readiness: { state: "ready", observedAt: NOW, message: "Ready" },
  binding: { ...destination, startedAt: NOW }, exported: { ...destination, client: true } });
const cargo = (control: HTMLElement) => [...cardOf(control).querySelectorAll("[data-slot='compose-cargo']")].map(item => item.getAttribute("data-loaded"));
const pause = (ms: number) => ui.act(() => new Promise<void>(resolve => setTimeout(resolve, ms)));

test("a blocked start keeps the runtime Stopped and explains the prerequisite in Details", async () => {
  const control = await mount(false, false);
  await ui.waitFor(() => assert.equal((control as HTMLButtonElement).disabled, true));
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  ui.fireEvent.click(control);
  assert.deepEqual(operations, [], "a blocked start submits no operation");
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Local runtime details" }));
  assert.ok(await ui.screen.findByText("Deploy current source changes before starting locally."));
  assert.ok(ui.screen.getByRole("link", { name: "Open Deploy" }));
});

test("only the switch toggles; the rest of the card is not a control", async () => {
  const control = await mount(true);
  const card = cardOf(control);
  assert.notEqual(card, control);
  assert.equal(card.tagName, "DIV");
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(status(control), "Stopped");
  ui.fireEvent.click(card);
  ui.fireEvent.click(ui.screen.getByText("Local runtime"));
  ui.fireEvent.click(card.querySelector("[data-slot='compose-status']")!);
  await pause(30);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.deepEqual(operations, [], "clicking the card, its title or its status starts nothing");
  ui.fireEvent.click(control);
  await settled(control);
  assert.equal(card.getAttribute("data-state"), "on");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "false"));
  await ui.waitFor(() => assert.equal(status(control), "Stopped"));
  assert.deepEqual(operations, ["local-start", "local-stop"]);
});

test("nothing moves before the first turn-on; a start surfaces once and arrives once", async () => {
  const control = await mount(true);
  const card = cardOf(control);
  assert.equal(card.getAttribute("data-motion"), "on");
  assert.equal(card.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect is mounted on page load");
  assert.equal(card.querySelector("[data-slot='compose-arrival']"), null);
  ui.fireEvent.click(control);
  await settled(control);
  const launch = card.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(launch.length > 0, "turning on mounts the surfacing ripples");
  const arrival = card.querySelectorAll("[data-slot='compose-arrival']");
  assert.ok(arrival.length > 0, "readiness mounts the spout and the border light");
  assert.ok(card.querySelector("[data-slot='compose-hover-spout']"), "a running whale can spout on hover");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(status(control), "Stopped"));
  ui.fireEvent.click(control);
  await settled(control);
  const replay = card.querySelectorAll("[data-slot='compose-launch']");
  assert.ok(replay.length > 0 && [...replay].every((item) => ![...launch].includes(item)), "a second turn-on remounts the launch so it replays");
  const again = card.querySelectorAll("[data-slot='compose-arrival']");
  assert.ok(again.length > 0 && [...again].every((item) => ![...arrival].includes(item)), "and a second arrival replays too");
});

test("the launch begins with the toggle and the arrival waits for readiness", async () => {
  const release = hold("local-start");
  const control = await mount(true);
  const card = cardOf(control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => {
    assert.equal(status(control), "Starting…");
    assert.equal(control.getAttribute("aria-checked"), "true");
    assert.equal(card.getAttribute("data-scene"), "starting");
    assert.ok(card.querySelector("[data-slot='compose-launch']"));
  });
  assert.equal(card.querySelector("[data-slot='compose-arrival']"), null, "nothing celebrates before the services answer");
  const launch = card.querySelector("[data-slot='compose-launch']");
  release();
  await settled(control);
  assert.equal(card.querySelector("[data-slot='compose-launch']"), launch, "readiness does not start a second launch");
  assert.ok(card.querySelector("[data-slot='compose-arrival']"));
  assert.ok(cargo(control).every(loaded => loaded === "true"), "every container is aboard once running");
});

test("while starting, containers stack onto the whale and then rest as a full stack", async () => {
  const release = hold("local-start");
  const control = await mount(true);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.ok(cargo(control).every(loaded => loaded === "true")), { timeout: 1000 });
  await pause(2500);
  assert.ok(cargo(control).every(loaded => loaded === "true"), "the stack rests instead of reloading every couple of seconds");
  assert.equal(status(control), "Starting…");
  release();
  await settled(control);
});

test("stopping slides the switch off at once while the whale winds down", async () => {
  local = runningLocal();
  const release = hold("local-stop");
  const control = await mount(true);
  const card = cardOf(control);
  await settled(control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => {
    assert.equal(control.getAttribute("aria-checked"), "false", "the knob reports the request immediately");
    assert.equal(card.getAttribute("data-scene"), "stopping");
    assert.equal(status(control), "Stopping…");
    assert.equal(control.getAttribute("aria-busy"), "true");
  });
  assert.equal(control.getAttribute("aria-disabled"), "true", "busy, but it keeps keyboard focus");
  assert.match(card.querySelector("[data-slot='compose-whale']")!.getAttribute("class") ?? "", /animate-compose-breathe/, "the whale ebbs while stopping");
  assert.ok(cargo(control).every(loaded => loaded === "false"), "the containers come off");
  release();
  await ui.waitFor(() => { assert.equal(card.getAttribute("data-scene"), "off"); assert.equal(status(control), "Stopped"); });
  assert.doesNotMatch(card.querySelector("[data-slot='compose-whale']")!.getAttribute("class") ?? "", /animate-compose-breathe/, "the ebb ends with the shutdown");
});

test("with motion off the switch changes state without any animation", async () => {
  const release = hold("local-start");
  const control = await mount(false);
  const card = cardOf(control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(card.getAttribute("data-scene"), "starting"));
  await pause(60);
  assert.ok(cargo(control).every(loaded => loaded === "false"), "no loading loop runs");
  release();
  await settled(control);
  assert.equal(card.getAttribute("data-motion"), "off");
  assert.equal(card.querySelector("[data-slot='compose-launch']"), null, "no one-shot effect plays");
  assert.equal(card.querySelector("[data-slot='compose-arrival']"), null);
  assert.equal(card.querySelector("[data-slot='compose-hover-spout']"), null, "and hovering never spouts");
});

test("a stale Docker observation is checked again and startup continues without a popup", async () => {
  let reads = 0;
  readDocker = async () => { reads += 1; return dockerStatus(docker); };
  const control = await mount(true);
  await ui.waitFor(() => assert.ok(reads >= 1));
  // An observation from a minute ago, as after the tab sat in the background.
  await ui.act(async () => { client.setQueryData(machine.dockerStatusQuery().queryKey, dockerStatus(docker), { updatedAt: Date.now() - 60_000 }); });
  await pause(20); // Query notifications are batched on a timer.
  const before = reads;
  ui.fireEvent.click(control);
  await settled(control);
  assert.ok(reads > before, "the old observation was confirmed first");
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.deepEqual(operations, ["local-start"]);
});

test("a stopped Docker Desktop starts from the same click, then the runtime", async () => {
  docker = { engine: "stopped", desktop: true };
  const release = hold("docker-start");
  const control = await mount(true);
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(status(control), "Starting Docker…"); assert.equal(control.getAttribute("aria-checked"), "true"); });
  assert.equal(ui.screen.queryByRole("dialog"), null);
  release();
  await settled(control);
  assert.deepEqual(operations, ["docker-start", "local-start"]);
  assert.equal(ui.screen.queryByRole("dialog"), null, "no popup at any point");
});

test("the switch cancels a start that is still waiting for Docker", async () => {
  docker = { engine: "stopped", desktop: true };
  const release = hold("docker-start");
  const control = await mount(false);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(status(control), "Starting Docker…"));
  assert.equal(control.getAttribute("aria-disabled"), null, "waiting for Docker can be cancelled");
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "false"));
  release();
  await pause(60);
  assert.deepEqual(operations, ["docker-start"], "Docker may finish starting, but the runtime does not");
  assert.equal(control.getAttribute("aria-checked"), "false");
});

test("Docker without Desktop offers instructions, and the runtime starts once Docker answers", async () => {
  docker = { engine: "missing", desktop: false };
  const control = await mount(false);
  ui.fireEvent.click(control);
  await ui.screen.findByText("Docker is not installed");
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(ui.screen.queryByRole("button", { name: "Start Docker Desktop" }), null);
  assert.ok(ui.screen.getByText(/Install Docker Desktop, open it and finish setup/));
  assert.ok(ui.screen.getByText(/As soon as Docker is running, Local runtime starts/));
  docker = { engine: "running", desktop: false };
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Check again" }));
  await settled(control);
  assert.equal(ui.screen.queryByRole("dialog"), null, "the popup hands back by itself");
  assert.equal(ui.screen.queryByText("Done"), null);
  assert.deepEqual(operations, ["local-start"]);
});

test("a failed Docker start explains itself and a retry continues to the runtime", async () => {
  docker = { engine: "stopped", desktop: true };
  outcome = "failed";
  const control = await mount(false);
  ui.fireEvent.click(control);
  const alert = await ui.screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /Docker Desktop could not start/);
  assert.equal(control.getAttribute("aria-checked"), "false");
  outcome = "succeeded";
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Start Docker Desktop" }));
  await settled(control);
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.deepEqual(operations, ["docker-start", "docker-start", "local-start"]);
});

test("cancelling while Docker is checked ignores the late answer", async () => {
  let finish!: (value: ReturnType<typeof dockerStatus>) => void;
  readDocker = () => new Promise((resolve) => { finish = resolve; });
  const control = await mount(false);
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.equal(control.getAttribute("aria-checked"), "true"); assert.equal(status(control), "Starting…"); });
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-checked"), "false"));
  await ui.act(async () => { finish(dockerStatus()); });
  await pause(30);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal(ui.screen.queryByRole("dialog"), null);
  assert.deepEqual(operations, []);
});

test("pressing the switch mid-start sends one stop request to the checkout owner", async () => {
  settles = false;
  const release = hold("local-stop");
  const control = await mount(true);
  const card = cardOf(control);
  ui.fireEvent.click(control);
  await ui.waitFor(() => { assert.deepEqual(operations, ["local-start"]); assert.equal(card.getAttribute("data-scene"), "starting"); });
  await ui.waitFor(() => assert.equal(control.getAttribute("aria-disabled"), null, "a running start can be interrupted"));
  assert.equal(control.getAttribute("aria-busy"), "true");
  assert.equal(control.getAttribute("title"), "Stop starting");
  ui.fireEvent.click(control);
  await ui.waitFor(() => {
    assert.equal(control.getAttribute("aria-checked"), "false", "the knob slides off at once");
    assert.equal(card.getAttribute("data-scene"), "stopping");
    assert.equal(status(control), "Stopping…");
  });
  assert.equal(control.getAttribute("aria-disabled"), "true", "a second press cannot race the interruption");
  assert.deepEqual(cancels, [], "the browser delegates startup preemption to its checkout owner");
  release();
  await ui.waitFor(() => assert.deepEqual(operations, ["local-start", "local-stop"]), { timeout: 3000 });
  await ui.waitFor(() => { assert.equal(card.getAttribute("data-scene"), "off"); assert.equal(status(control), "Stopped"); });
  assert.equal(ui.screen.queryByRole("dialog"), null);
});

test("a start that is only being submitted cannot be interrupted yet", async () => {
  const release = hold("local-start");
  const control = await mount(false);
  ui.fireEvent.click(control);
  await ui.waitFor(() => assert.equal(status(control), "Starting…"));
  assert.equal(control.getAttribute("aria-disabled"), "true");
  ui.fireEvent.click(control);
  release();
  await settled(control);
  assert.deepEqual(operations, ["local-start"]);
  assert.deepEqual(cancels, []);
});

test("drifted database inputs offer one restart in Details instead of stop-then-start", async () => {
  local = { ...runningLocal(), lifecycle: "attention", readiness: { state: "blocked", observedAt: NOW, remedy: "restart",
    message: "package.json changed after local storage was verified. Restart local runtime to rebuild its images, then review any pending local migration in Database." } };
  const control = await mount(false);
  await ui.waitFor(() => assert.equal(status(control), "Needs attention"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Local runtime details" }));
  assert.ok(await ui.screen.findByText(/^package\.json changed after local storage was verified/));
  assert.equal(ui.screen.queryByRole("button", { name: "Check again" }), null, "the one remedy is offered instead");
  assert.ok(ui.screen.getByRole("button", { name: "Stop runtime" }));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Restart runtime" }));
  await settled(control);
  assert.deepEqual(operations, ["local-restart"]);
  assert.equal(ui.screen.queryByRole("dialog"), null, "Details closes so the switch narrates the rebuild");
});

test("a runtime that needs attention for another reason keeps Check again and offers no restart", async () => {
  local = { ...runningLocal(), lifecycle: "attention", readiness: { state: "blocked", observedAt: NOW, message: "Needs attention: postgres. Open its logs." } };
  const control = await mount(false);
  await ui.waitFor(() => assert.equal(status(control), "Needs attention"));
  ui.fireEvent.click(ui.screen.getByRole("button", { name: "Local runtime details" }));
  assert.ok(await ui.screen.findByText("Needs attention: postgres. Open its logs."));
  assert.ok(ui.screen.getByRole("button", { name: "Check again" }));
  assert.equal(ui.screen.queryByRole("button", { name: "Restart runtime" }), null);
});

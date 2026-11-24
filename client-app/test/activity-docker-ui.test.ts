import assert from "./support/assert";
import { createRequire } from "node:module";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createElement as h, Profiler } from "react";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import type { DockerView, JobView } from "../shared/deploy";

const require = createRequire(import.meta.url);
let dom: { window: Window & typeof globalThis };
let ui: typeof import("@testing-library/react");
let query: typeof import("@tanstack/react-query");
let view: typeof import("../src/views/GlobalActivity");
let client: import("@tanstack/react-query").QueryClient;
let docker: DockerView;
let dockerFailure: { status: number; error: string } | undefined;
let startFailure: string | undefined;
let jobs: JobView[];
let reads: string[];
let submitted: string[];

const startup = (status: JobView["status"], startedAt = "2026-11-04T12:00:00.000Z", summary?: string): JobView => ({
  id: `docker-${status}-${startedAt}`, kind: "docker-start", title: "Start Docker Desktop", params: {}, status, startedAt,
  ...(status === "running" ? {} : { endedAt: startedAt }), ...(summary ? { summary } : {}), lastSeq: 0,
  steps: [{ label: "Wait for the engine", status: status === "running" ? "running" : "done" }],
});
const discard: JobView = {
  id: "discard", kind: "deploy-discard", title: "Discard plan for my-aws-app", params: {}, status: "succeeded",
  startedAt: "2026-11-02T12:00:00.000Z", endedAt: "2026-11-02T12:00:01.000Z", lastSeq: 0,
};

before(async () => {
  const { JSDOM } = require("jsdom");
  dom = new JSDOM(`<!doctype html><html><head><meta name="studio-protocol" content="${STUDIO_PROTOCOL_VERSION}"></head><body></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of ["window", "self", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "getComputedStyle"] as const) {
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: class { addEventListener() {} removeEventListener() {} close() {} } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: string, init?: RequestInit) => {
    if (input.startsWith("/api/machine/docker")) {
      reads.push(input);
      if (dockerFailure) return new Response(JSON.stringify({ error: dockerFailure.error }), { status: dockerFailure.status });
      return new Response(JSON.stringify({ docker, checks: [], observedAt: new Date(reads.length).toISOString() }));
    }
    if (input === "/api/deploy/operations" && init?.method === "POST") {
      if (startFailure) return new Response(JSON.stringify({ error: startFailure }), { status: 503 });
      const job = startup("running", "2026-11-04T13:00:00.000Z");
      submitted.push((JSON.parse(String(init.body)) as { kind: string }).kind);
      jobs = [job, ...jobs];
      return new Response(JSON.stringify(job));
    }
    if (input === "/api/operations") return new Response(JSON.stringify({ jobs }));
    if (/^\/api\/operations\/.+\/log/.test(input)) return new Response(JSON.stringify({ lines: [], job: jobs[0] }));
    throw new Error(`Unscripted ${input}`);
  } });
  query = require("@tanstack/react-query");
  ui = require("@testing-library/react");
  view = await import("../src/views/GlobalActivity");
});

beforeEach(() => {
  docker = { engine: "stopped", desktop: true };
  dockerFailure = undefined;
  startFailure = undefined;
  jobs = [startup("succeeded", "2026-11-04T12:00:00.000Z", "Docker is running."), discard];
  reads = [];
  submitted = [];
  client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(async () => { ui.cleanup(); await client.cancelQueries(); client.clear(); });
after(() => dom.window.close());

function selectJob(tray: ReturnType<typeof ui.within>, id: string) {
  const row = tray.getByRole("list", { name: "Operations" }).querySelector(`[data-job="${id}"]`);
  assert.ok(row);
  ui.fireEvent.click(row);
}

async function renderTray() {
  ui.render(h(query.QueryClientProvider, { client }, h(view.GlobalActivity)));
  const tray = ui.within(ui.screen.getByRole("region", { name: "Activity" }));
  await ui.waitFor(() => assert.doesNotMatch(tray.getByRole("status").textContent ?? "", /Checking/));
  return { tray, toggle: () => tray.getByRole("button", { name: /^Activity/ }) };
}

test("a past successful startup cannot headline over a stopped engine", async () => {
  const { tray, toggle } = await renderTray();
  await ui.waitFor(() => assert.equal(toggle().textContent?.trim(), ""));
  assert.equal(tray.getByRole("status").textContent, "Docker stopped");
  assert.doesNotMatch(toggle().textContent ?? "", /Start Docker Desktop|startup completed|Docker is running/);
});

test("the Docker status appears on an idle tray, not only beside a Docker job", async () => {
  jobs = [];
  const { tray, toggle } = await renderTray();
  assert.equal(tray.getByRole("status").textContent, "Docker stopped");
  await ui.waitFor(() => assert.equal(toggle().textContent?.trim(), ""));
});

test("completed legacy discard keeps recovery as information while explicit cloud cleanup remains a warning", async () => {
  jobs = [{ ...discard, execution: "finished", exitCode: 0, outcome: "unverified", summary: "Plan discarded.", recovery: "Refresh AWS observations to confirm remaining change sets and resources." }];
  const { tray, toggle } = await renderTray();
  ui.fireEvent.click(toggle());
  selectJob(tray, discard.id);
  await ui.waitFor(() => assert.ok(tray.getByText("Plan discarded.")));
  const information = tray.getByText(/Refresh AWS observations/);
  assert.equal(information.getAttribute("data-ui"), "activity-completion-note");
  assert.equal(information.getAttribute("role"), null);
  assert.equal(tray.queryByRole("button", { name: "Ask in Conversation" }), null);
  assert.equal(tray.queryByText("Unverified"), null);
  assert.equal(jobs[0]?.outcome, "unverified");
  jobs = [{ ...jobs[0]!, params: { discardCloud: true } }];
  client.setQueryData(["operations"], { jobs });
  await ui.waitFor(() => assert.ok(tray.getAllByText("Unverified").length));
  assert.equal(tray.getByText(/Refresh AWS observations/).getAttribute("data-ui"), null);
  assert.ok(tray.getByRole("button", { name: "Ask in Conversation" }));
});

test("a history of only Docker startups does not claim nothing has run", async () => {
  jobs = [startup("succeeded")];
  const { toggle } = await renderTray();
  await ui.waitFor(() => assert.equal(client.getQueryData<{ jobs: JobView[] }>(["operations"])?.jobs.length, 1));
  assert.doesNotMatch(toggle().textContent ?? "", /Nothing has run yet/);
});

test("Start submits the shared operation in place, without a nested button or opening the tray", async () => {
  const { tray, toggle } = await renderTray();
  const start = tray.getByRole("button", { name: "Start Docker" });
  assert.equal(start.closest("button[aria-expanded]"), null);
  ui.fireEvent.click(start);
  await ui.waitFor(() => assert.equal(tray.getByRole("status").textContent, "Starting Docker…"));
  assert.deepEqual(submitted, ["docker-start"]);
  assert.equal(tray.queryByRole("button", { name: "Start Docker" }), null);
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.doesNotMatch(toggle().textContent ?? "", /Start Docker Desktop/);
});

test("a rejected Start opens the tray with the reason and can be retried", async () => {
  startFailure = "Studio has stopped accepting operations.";
  const { tray, toggle } = await renderTray();
  ui.fireEvent.click(tray.getByRole("button", { name: "Start Docker" }));
  assert.match((await tray.findByRole("alert")).textContent ?? "", /stopped accepting operations/);
  assert.equal(toggle().getAttribute("aria-expanded"), "true");
  assert.ok(tray.getByRole("button", { name: "Start Docker" }));
});

test("a failed startup stays in the headline only while Docker has not recovered", async () => {
  jobs = [startup("failed", "2026-11-04T12:00:00.000Z", "Docker did not start within two minutes."), discard];
  const { tray, toggle } = await renderTray();
  ui.fireEvent.click(toggle());
  selectJob(tray, jobs[0]!.id);
  ui.fireEvent.click(toggle());
  await ui.waitFor(() => assert.match(toggle().textContent ?? "", /Docker did not start within two minutes/));
  docker = { engine: "running", desktop: true };
  await client.refetchQueries({ queryKey: ["machine", "docker"] });
  await ui.waitFor(() => assert.doesNotMatch(toggle().textContent ?? "", /did not start/));
  assert.equal(toggle().textContent?.trim(), "");
});

test("an older failure is not resurrected by a newer success going quiet", async () => {
  jobs = [startup("succeeded", "2026-11-04T12:00:00.000Z"), startup("failed", "2026-11-03T12:00:00.000Z", "Docker did not start within two minutes."), discard];
  const { toggle } = await renderTray();
  await ui.waitFor(() => assert.equal(toggle().textContent?.trim(), ""));
  assert.doesNotMatch(toggle().textContent ?? "", /did not start/);
});

test("a startup's detail relates the past run to Docker's current state", async () => {
  const { tray, toggle } = await renderTray();
  ui.fireEvent.click(toggle());
  selectJob(tray, jobs[0]!.id);
  await tray.findByText("Docker has since stopped.");
  assert.equal(tray.queryByText(/Docker startup completed|Docker is running/), null);
  docker = { engine: "running", desktop: true };
  await client.refetchQueries({ queryKey: ["machine", "docker"] });
  await ui.waitFor(() => assert.equal(tray.queryByText("Docker has since stopped."), null));
  assert.equal(tray.getByRole("status").textContent, "Docker running");
});

test("Check again forces a fresh read and an unclear answer can resolve", async () => {
  docker = { engine: "unknown", desktop: true, problem: "permission denied" };
  const { tray } = await renderTray();
  assert.equal(tray.getByRole("status").textContent, "Docker status unknown");
  assert.equal(tray.getByRole("status").getAttribute("title"), "permission denied");
  docker = { engine: "running", desktop: true };
  ui.fireEvent.click(tray.getByRole("button", { name: "Check again for Docker" }));
  await ui.waitFor(() => assert.equal(tray.getByRole("status").textContent, "Docker running"));
  assert.ok(reads.some(read => read.includes("force=1")));
});

test("the reason for an unclear state is readable without hovering once the tray is open", async () => {
  docker = { engine: "unknown", desktop: true, problem: "permission denied" };
  const { tray, toggle } = await renderTray();
  const collapsedDetail = tray.queryByText("permission denied");
  assert.ok(!collapsedDetail || collapsedDetail.closest("[hidden]"), "the collapsed panel does not expose diagnostic details");
  ui.fireEvent.click(toggle());
  assert.equal((await tray.findByText("permission denied")).closest("[hidden]"), null);
});

test("log output renders nothing unless the open tray is showing that job", async () => {
  const { logs } = await import("../src/operations/live");
  jobs = [startup("succeeded", "2026-11-04T12:00:00.000Z"), discard];
  let commits = 0;
  ui.render(h(query.QueryClientProvider, { client }, h(Profiler, { id: "tray", onRender: () => { commits++; } }, h(view.GlobalActivity))));
  const tray = ui.within(ui.screen.getByRole("region", { name: "Activity" }));
  await ui.waitFor(() => assert.equal(client.getQueryData<{ jobs: JobView[] }>(["operations"])?.jobs.length, 2));
  await ui.waitFor(() => assert.doesNotMatch(tray.getByRole("status").textContent ?? "", /Checking/));
  const line = (seq: number) => ({ seq, at: "2026-11-04T12:00:00.000Z", stream: "out" as const, text: `line ${seq}` });
  const settled = commits;
  ui.act(() => { for (let seq = 1; seq <= 200; seq++) logs.add(discard.id, [line(seq)]); });
  assert.equal(commits, settled, "a closed tray ignores all output");

  ui.fireEvent.click(tray.getByRole("tab", { name: "Activity" }));
  selectJob(tray, discard.id);
  await tray.findByRole("log");
  await ui.act(() => new Promise(resolve => setTimeout(resolve, 50)));
  const opened = commits;
  ui.act(() => { for (let seq = 1; seq <= 200; seq++) logs.add("another-job", [line(seq)]); });
  assert.equal(commits, opened, "another job's output is not this reader's");
  ui.act(() => { logs.add(tray.getByRole("list", { name: "Operations" }).querySelector("[aria-current]")!.getAttribute("data-job")!, [line(1000)]); });
  assert.equal(commits, opened + 1, "the job being read commits once per batch");
});

test("missing Docker links to installation instead of offering Start", async () => {
  docker = { engine: "missing", desktop: false };
  const { tray } = await renderTray();
  assert.equal(tray.getByRole("status").textContent, "Docker not installed");
  assert.equal(tray.queryByRole("button", { name: "Start Docker" }), null);
  assert.equal(tray.getByRole("link", { name: /Install Docker/ }).getAttribute("href"), "https://docs.docker.com/get-docker/");
});

test("a server that predates the route gives the restart instruction, never a generic failure", async () => {
  dockerFailure = { status: 404, error: "This API is unavailable in the running Studio server. Restart npm run studio in this checkout and reload the page." };
  const { tray } = await renderTray();
  assert.equal(tray.getByRole("status").textContent, "Restart Studio to check Docker");
  assert.match(tray.getByRole("status").getAttribute("title") ?? "", /Restart npm run studio/);
  assert.equal(tray.queryByRole("button", { name: "Start Docker" }), null);
  assert.equal(tray.queryByRole("button", { name: "Check again for Docker" }), null);
});

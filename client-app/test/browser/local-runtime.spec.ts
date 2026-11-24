import { test, expect, assertAccessible } from "./support/test";
import { NOW, dockerStatus, discoveryFor, overview } from "./support/scenarios";
import { installLocalRuntime, localRuntimeView, LOCAL_ACCOUNT, LOCAL_REGION } from "./support/local-runtime";
import type { JobView } from "../../shared/deploy";
import type { Page } from "@playwright/test";
import { inspectionStatus } from "./support/stack-inspection";
import { connectionCatalogFixture } from "./support/aws-connections";
import { LOCAL_DATABASE_PREPARATION_STEP, LOCAL_DATABASE_VERIFICATION_STEP } from "../../shared/operations";

const controlFor = (page: Page) => page.getByRole("switch", { name: "Local runtime", exact: true, includeHidden: true });
const detailsFor = (page: Page) => page.getByRole("button", { name: "Local runtime details", exact: true });
/** The card carries the status line; only the switch inside it is a control. */
const cardFor = (page: Page) => page.locator("[data-ui='compose-preview']");
async function expectActivityClosed(page: Page) {
  const toggle = page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: expand panel", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}
const dockerJob = (status: JobView["status"]): JobView => ({
  id: "docker-start-job", kind: "docker-start", title: "Start Docker Desktop", params: {}, status, startedAt: NOW, lastSeq: 0,
  ...(status === "failed" ? { summary: "Docker Desktop could not start. Open it from your applications, then check again." } : {}),
});

for (const width of [1440, 390]) test(`Docker-revived infrastructure alone reads Stopped, and Start is a normal start at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  // After a Docker restart only restart-policy database containers are back. No compute: the runtime is off.
  const revived = { ...localRuntimeView(), exported: { client: false },
    services: [{ name: "postgres", container: "fixture-postgres", state: "running", health: "healthy" as const, oneShot: false, ports: "127.0.0.1:5432->5432/tcp" },
      { name: "pgadmin", container: "fixture-pgadmin", state: "running", oneShot: false, ports: "127.0.0.1:5050->80/tcp" }] };
  runtime.set(revived);
  await studio.goto();
  await expect(cardFor(page)).toContainText("Stopped");
  for (const stale of ["Setup needed", "Recovery failed", "Reconnecting", "Partially running", "Needs attention", "outside Studio"])
    await expect(page.locator("body")).not.toContainText(stale);
  await expect(cardFor(page)).toHaveAttribute("data-scene", "off");
  await expect(controlFor(page)).not.toBeChecked();
  await expect(controlFor(page)).toBeEnabled();
  expect(runtime.submitted).toEqual([]);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("docker-restarted-off.png"), fullPage: true });
  await controlFor(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start"]);
  expect(runtime.submitted[0]?.params.export).toBe(true);
  await expect(cardFor(page)).toContainText("Preparing database");
  await runtime.finish(localRuntimeView("ready"));
  await expect(cardFor(page)).toContainText("Running");
  await expectActivityClosed(page);
});

for (const width of [1440, 390]) test(`live compute without exported settings needs attention, stays stoppable and restarts cleanly at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView("blocked"), exported: { client: false }, watch: { running: false }, client: { running: false },
    binding: undefined, profile: undefined, startedBy: "outside",
    readiness: { state: "blocked", observedAt: NOW,
      message: "This checkout needs local development settings. Stop local runtime, then start it again to generate settings from your Development deployment. Existing database data is preserved." } });
  await studio.goto();
  await expect(cardFor(page)).toContainText("Needs attention");
  await expect(page.locator("body")).not.toContainText("Setup needed");
  await expect(page.locator("body")).not.toContainText("Recovery failed");
  await expect(controlFor(page)).toBeChecked();
  await expect(controlFor(page)).toBeEnabled();
  expect(runtime.submitted).toEqual([]);
  const details = detailsFor(page);
  await details.focus();
  await page.keyboard.press("Enter");
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toContainText("Stop local runtime, then start it again");
  await expect(help).toContainText("Existing database data is preserved");
  await help.getByRole("button", { name: "Check again", exact: true }).click();
  expect(runtime.submitted).toEqual([]);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("recloned-attention.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(details).toBeFocused();
  await controlFor(page).focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-stop"]);
  await expect(cardFor(page)).toContainText("Stopping containers");
  await runtime.finish(localRuntimeView());
  await expect(cardFor(page)).toHaveAttribute("data-scene", "off");
  await expect(controlFor(page)).not.toBeChecked();
  await expect(controlFor(page)).toBeEnabled();
  await controlFor(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-stop", "local-start"]);
  expect(runtime.submitted[1]?.params.export).toBe(true);
  await expect(cardFor(page)).toContainText("Preparing database");
  await runtime.finish(localRuntimeView("ready"));
  await expect(cardFor(page)).toContainText("Running");
  await expectActivityClosed(page);
});

test("a tab opened mid-operation shows what the checkout host is doing and can stop it", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  // Another tab started this; this page has submitted nothing and no job list entry exists yet.
  runtime.set({ ...localRuntimeView("starting"), operation: { kind: "local-start", id: "started-in-another-tab" } });
  await studio.goto();
  await expect(cardFor(page)).toContainText("Starting");
  await expect(cardFor(page)).toHaveAttribute("data-scene", "starting");
  await expect(controlFor(page)).toBeChecked();
  runtime.set({ ...localRuntimeView("ready") });
  await expect(cardFor(page)).toContainText("Running", { timeout: 10_000 });
  runtime.set({ ...localRuntimeView("ready"), lifecycle: "stopping", operation: { kind: "local-stop", id: "stopped-in-another-tab" } });
  await expect(cardFor(page)).toContainText("Stopping", { timeout: 10_000 });
  runtime.set(localRuntimeView());
  await expect(cardFor(page)).toContainText("Stopped", { timeout: 10_000 });
  await expect(controlFor(page)).not.toBeChecked();
  expect(runtime.submitted).toEqual([]);
});

for (const { width, label } of [
  { width: 1440, label: LOCAL_DATABASE_PREPARATION_STEP },
  { width: 390, label: LOCAL_DATABASE_PREPARATION_STEP },
  { width: 1440, label: LOCAL_DATABASE_VERIFICATION_STEP },
]) test(`failed ${label} opens Database status without applying changes at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  installLocalRuntime(studio);
  const job: JobView = { id: "database-preflight-failure", kind: "local-start", params: {}, title: "Start development",
    status: "failed", startedAt: NOW, endedAt: NOW, lastSeq: 0,
    summary: "Local database preparation failed. Inspect existing storage before retrying.",
    steps: [{ label, status: "failed" }] };
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: [job] } }));
  studio.reply("GET", `/api/operations/${job.id}/log`, route => route.fulfill({ json: { job, lines: [] } }));
  studio.reply("GET", "/api/database/history", route => route.fulfill({ json: {
    revision: "startup-history", sourceHash: "db-browser", observedAt: NOW, heads: [], refs: [], issues: [], migrations: [], snapshots: [],
  } }));
  studio.reply("GET", "/api/database/application/operations", route => route.fulfill({ json: [] }));
  await studio.goto();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await activity.getByRole("button", { name: /^Activity:/ }).click();
  await activity.locator(`[data-job="${job.id}"]`).click();
  await expect(activity).toContainText("Empty local storage is initialized during startup.");
  await expect(activity).toContainText("existing objects, signature or pending migrations");
  const review = activity.getByRole("link", { name: "Review local database", exact: true });
  await review.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/database\/status$/);
  await expect(page.getByRole("link", { name: "Database status", exact: true })).toHaveAttribute("aria-current", "page");
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("database-startup-recovery.png"), fullPage: true });
  await page.getByRole("link", { name: "Schema", exact: true }).click();
  await expect(page).toHaveURL(/\/database\/schema$/);
  await activity.getByRole("link", { name: "Review local database", exact: true }).click();
  await expect(page.getByRole("link", { name: "Database status", exact: true })).toHaveAttribute("aria-current", "page");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

for (const width of [1440, 390]) test(`runtime starts and stops only after observed readiness at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  await studio.goto();
  const control = controlFor(page);
  const card = cardFor(page);
  await expect(card).toContainText("Stopped");
  await expect(control).not.toBeChecked();
  await expect(control).toHaveAccessibleDescription(/Empty local PostgreSQL storage is initialized automatically.*migrations require review in Database/);
  await control.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.length).toBe(1);
  expect(runtime.submitted[0]).toMatchObject({ kind: "local-start", params: {
    deployment: "browser-dev", profile: "browser", mode: "dev", account: LOCAL_ACCOUNT, region: LOCAL_REGION, export: true,
  } });
  await expect(control).toBeChecked();
  // A running start stays pressable, so it can be interrupted.
  await expect(control).toBeEnabled();
  await expect(control).toHaveAttribute("title", "Stop starting");
  await expect(control).toHaveAttribute("aria-busy", "true");
  await expect(control).toBeFocused();
  // The status narrates the running step of the startup job.
  await expect(card).toContainText("Preparing database");
  await expect(card).toHaveAttribute("data-scene", "starting");
  await expectActivityClosed(page);
  // A completed startup command still cannot claim ready while the observation is pending.
  await runtime.finish(localRuntimeView("starting"));
  await expect(control).toBeChecked();
  await expect(card).toContainText("Starting");
  await expect(card).not.toContainText("Running");
  await runtime.publish(localRuntimeView("ready"));
  await expect(control).toBeChecked();
  await expectActivityClosed(page);
  await expect(card).toContainText("Running");
  await expect(card).toHaveAttribute("data-scene", "running");
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("runtime-ready.png"), fullPage: true });
  await control.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => runtime.submitted.length).toBe(2);
  expect(runtime.submitted[1]).toMatchObject({ kind: "local-stop", params: {} });
  await expect(control).toBeDisabled();
  // The switch reports the request at once while the card winds down.
  await expect(control).not.toBeChecked();
  await expect(card).toHaveAttribute("data-scene", "stopping");
  await expect(card).toContainText("Stopping containers");
  await runtime.finish(localRuntimeView());
  await expect(control).not.toBeChecked();
  await expectActivityClosed(page);
  await expect(card).toContainText("Stopped");
  expect(runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertAccessible(page);
});

test("pressing the switch mid-start sends one stop intent to the checkout owner", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  await studio.goto();
  const control = controlFor(page);
  const card = cardFor(page);
  await control.click();
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start"]);
  await runtime.publish(localRuntimeView("starting"));
  await expect(control).toBeEnabled();
  await control.click();
  await expect(control).not.toBeChecked();
  await expect(card).toHaveAttribute("data-scene", "stopping");
  await expect(card).toContainText("Stopping");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop"]);
  expect(studio.requests.filter(request => request.path.endsWith("/cancel"))).toEqual([]);
  await expect(card).toContainText("Stopping containers");
  await runtime.finish(localRuntimeView());
  await expect(card).toHaveAttribute("data-scene", "off");
  await expect(card).toContainText("Stopped");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await assertAccessible(page);
});

for (const open of [false, true]) test(`accepting a runtime toggle preserves Agent mode with the tray ${open ? "open" : "closed"}`, async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: {
    providers: [{ id: "codex", label: "Codex", available: false, detail: "Fixture CLI is not installed." }], busy: false,
  } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route("**/api/deploy/operations", async route => {
    requested = true;
    await pending;
    await route.fallback();
  });
  await studio.goto();
  await controlFor(page).click();
  await expect.poll(() => requested).toBe(true);
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const agent = activity.getByRole("tab", { name: "Agent", exact: true });
  await agent.click();
  const toggle = activity.getByRole("button", { name: /^Agent:/ });
  if (!open) await toggle.click();
  release();
  await expect.poll(() => runtime.submitted.length).toBe(1);
  await runtime.finish(localRuntimeView("ready"));
  await expect(agent).toHaveAttribute("aria-selected", "true");
  await expect(toggle).toHaveAttribute("aria-expanded", String(open));
});

test("a pending local observation never claims stopped or starts compute", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/local", async route => { await pending; await route.fulfill({ json: localRuntimeView("ready") }); });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).not.toBeChecked();
  await expect(cardFor(page)).toContainText(/Checking|Loading/);
  await expect(control).toBeDisabled();
  expect(runtime.submitted).toEqual([]);
  release();
  await expect(control).toBeChecked();
  expect(runtime.submitted).toEqual([]);
});

for (const state of ["in-progress", "failed", "incomplete", "incompatible"] as const)
  test(`a ${state} AWS development deployment does not advertise local startup`, async ({ page, studio }) => {
    const runtime = installLocalRuntime(studio);
    let complete = false;
    studio.reply("GET", "/api/deploy/status", (route, url) => {
      const value = inspectionStatus(url);
      const base = value.detail!;
      const stacks = !complete && state === "incomplete"
        ? base.stacks.map((stack, index) => index === 0 ? { ...stack, health: "in-progress" as const, status: "CREATE_IN_PROGRESS" } : stack)
        : base.stacks;
      const detail = {
        ...base, stacks,
        state: !complete && (state === "in-progress" || state === "failed") ? { kind: state, stacks, deployable: false } : base.state,
        local: { compatible: complete || state !== "incompatible", problem: "Development resources require an update.",
          exported: { deployment: "browser-dev", client: true, fresh: true } },
      };
      return route.fulfill({ json: { ok: true, value: { ...value, detail } } });
    });
    await studio.goto();
    const control = controlFor(page);
    if (state !== "incompatible") {
      await expect(control).toHaveCount(0);
      await expect(detailsFor(page)).toHaveCount(0);
      expect(runtime.submitted).toEqual([]);
      await assertAccessible(page);
      return;
    }
    await expect(control).toBeDisabled();
    await expect(control).not.toBeChecked();
    const details = detailsFor(page);
    await details.focus();
    await page.keyboard.press("Enter");
    const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
    await expect(help).toBeVisible();
    await expect(help).toContainText(/development|deploy|resources/i);
    await assertAccessible(page);
    expect(runtime.submitted).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(details).toBeFocused();
    complete = true;
    await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
    await expect(control).toBeEnabled();
    await expect(control).not.toBeChecked();
    expect(runtime.submitted).toEqual([]);
  });

for (const width of [1440, 390]) test(`incompatible development resources leave the runtime Stopped and explain startup in Details at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  studio.reply("GET", "/api/deploy/status", (route, url) => {
    const value = inspectionStatus(url);
    return route.fulfill({ json: { ok: true, value: { ...value, detail: { ...value.detail!,
      local: { compatible: false, problem: "Development resources require an update.",
        exported: { deployment: "browser-dev", client: true, fresh: true } },
    } } } });
  });
  await studio.goto();
  await expect(cardFor(page)).toContainText("Stopped");
  await expect(controlFor(page)).not.toBeChecked();
  await expect(controlFor(page)).toBeDisabled();
  await detailsFor(page).focus();
  await page.keyboard.press("Enter");
  const details = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(details).toContainText("Development resources require an update.");
  await expect(details.getByRole("link", { name: "Open Deploy", exact: true })).toHaveAttribute("href", "/deploy");
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(detailsFor(page)).toBeFocused();
  expect(runtime.submitted).toEqual([]);
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("a running local runtime can be stopped even after its AWS deployment disappears", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true,
    value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment"), detail: undefined } } }));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await expect(control).toBeEnabled();
  await control.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-stop"]);
  await runtime.finish(localRuntimeView());
  await expectActivityClosed(page);
  await expect(control).toHaveCount(0);
  expect(runtime.submitted.some(entry => entry.kind === "local-start")).toBe(false);
});

for (const reason of ["deployment", "profile", "unavailable", "ownership conflict", "stale recovery"] as const) test(`runtime stays hidden with no confirmed ${reason} and no active work`, async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  if (["deployment", "ownership conflict", "stale recovery"].includes(reason)) studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: {
    ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment"), detail: undefined },
  } }));
  else if (reason === "profile") await page.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", "{}"));
  else studio.reply("GET", "/api/deploy/status", route => route.fulfill({ json: { ok: false,
    problem: { kind: "denied", message: "Development stack status cannot be verified." } } }));
  if (reason === "ownership conflict") runtime.set({ ...localRuntimeView(), lifecycle: undefined,
    ownershipConflict: "This Compose project belongs to another checkout. Choose a unique COMPOSE_PROJECT_NAME in cdk-app/.env.dev.",
    observationProblem: "Ownership could not be verified." });
  if (reason === "stale recovery") runtime.set({ ...localRuntimeView(),
    recovery: { state: "failed", message: "A previous checkout could not reconnect." } });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toHaveCount(0);
  await expect(detailsFor(page)).toHaveCount(0);
  await assertAccessible(page);
  expect(runtime.submitted).toEqual([]);
});

for (const width of [1440, 390]) test(`one switch press starts a stopped Docker Desktop and then the runtime, with no popup, at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  let running = false;
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: running ? "running" : "stopped", desktop: true }) }));
  await studio.goto();
  const control = controlFor(page);
  const card = cardFor(page);
  await control.focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["docker-start"]);
  await expect(control).toBeChecked();
  await expect(card).toContainText("Starting Docker");
  await expect(control).toBeEnabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("runtime-starting-docker.png"), fullPage: true });
  running = true;
  await studio.emit("machine-docker", dockerStatus({ engine: "running", desktop: true }, "2026-10-28T12:00:05.000Z"));
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["docker-start", "local-start"]);
  expect(runtime.submitted[1]).toMatchObject({ kind: "local-start", params: { deployment: "browser-dev", profile: "browser", mode: "dev" } });
  await expect(control).toBeChecked();
  await expect(card).toContainText("Preparing database");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const width of [1440, 390]) test(`Docker help appears only when Docker cannot start itself and hands back once it answers at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  let running = false;
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus(running ? { engine: "running", desktop: false } : { engine: "missing", desktop: false }) }));
  await studio.goto();
  const control = controlFor(page);
  await control.focus();
  await page.keyboard.press("Space");
  const popup = page.getByRole("dialog", { name: "Docker is not installed", exact: true });
  await expect(popup).toBeVisible();
  await expect(control).not.toBeChecked();
  await expect(popup).toContainText("As soon as Docker is running, Local runtime starts");
  await expect(popup.getByRole("button", { name: "Start Docker Desktop", exact: true })).toHaveCount(0);
  expect(runtime.submitted).toEqual([]);
  await assertAccessible(page);
  const bounds = (await popup.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 12);
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  await page.screenshot({ path: testInfo.outputPath("runtime-docker-prerequisite.png"), fullPage: true });
  running = true;
  await popup.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start"]);
  await expect(control).toBeChecked();
  await expect(control).toBeFocused();
  await expect(cardFor(page)).toContainText("Preparing database");
});

for (const width of [1440, 390]) for (const reason of [
  { id: "source", message: "Database source, migration history or dependencies changed after local storage was verified. Restart local runtime to rebuild its images, then review any pending local migration in Database." },
  { id: "missing-proof", message: "This local runtime has no current database source verification. Restart local runtime to rebuild the database image and verify the saved contract." },
  { id: "replaced-database", message: "Local PostgreSQL restarted or was recreated after its storage check. Restart local runtime to verify the current database; a new empty volume will initialize automatically." },
]) test(`database readiness proof invalidates Running for ${reason.id} at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  await studio.goto();
  const control = controlFor(page), card = cardFor(page);
  await expect(card).toContainText("Running");
  await expect(control).toBeChecked();

  // Services stay healthy: readiness depends on the current database proof too.
  const running = localRuntimeView("ready");
  await runtime.publish({ ...running, lifecycle: "attention", readiness: { state: "blocked", observedAt: NOW, message: reason.message } });
  await expect(card).toContainText("Needs attention");
  await expect(card).not.toContainText("Running");
  await expect(control).toBeChecked();
  await expect(control).toBeEnabled();
  await expectActivityClosed(page);
  const details = detailsFor(page);
  await details.focus();
  await page.keyboard.press("Enter");
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(reason.message);
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeEnabled();
  expect(runtime.submitted).toEqual([]);
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`database-proof-${reason.id}.png`), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(details).toBeFocused();
  await expect(control).toBeChecked();
});

test("partial startup failure keeps cleanup available and a later start is explicit", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  await studio.goto();
  const control = controlFor(page);
  await control.click();
  await expect.poll(() => runtime.submitted.length).toBe(1);
  await runtime.finish(localRuntimeView("blocked"), "failed");
  await expectActivityClosed(page);
  await expect(control).toBeChecked();
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(/prisma-verify|Needs attention|Database/i);
  await expect(help.getByRole("button", { name: "View activity", exact: true })).toBeVisible();
  await help.getByRole("button", { name: "View activity", exact: true }).click();
  const collapse = page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: collapse panel", exact: true });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await detailsFor(page).click();
  await help.getByRole("button", { name: "Stop runtime", exact: true }).click();
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop"]);
  await runtime.finish(localRuntimeView());
  await expectActivityClosed(page);
  await expect(control).not.toBeChecked();
  await control.click();
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-start", "local-stop", "local-start"]);
  await runtime.finish(localRuntimeView("ready"));
  await expectActivityClosed(page);
  await expect(control).toBeChecked();
});

test("runtime readiness survives navigation and reload and detects external shutdown", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await expect(cardFor(page)).toContainText("Running");
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Deploy", exact: true }).click();
  await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "Map", exact: true }).click();
  await expect(control).toBeChecked();
  await expect(cardFor(page)).toContainText("Running");
  await page.reload();
  await expect(control).toBeChecked();
  await expect(cardFor(page)).toContainText("Running");
  runtime.set(localRuntimeView());
  await expect(control).not.toBeChecked({ timeout: 10_000 });
  expect(runtime.submitted).toEqual([]);
});

test("an active checkout reconnects across refresh and simultaneous tabs without an AWS profile or lifecycle writes", async ({ page, context, studio }) => {
  await context.addInitScript(() => localStorage.setItem("aws-studio:mode-profiles:v1:/studio-fixture", "{}"));
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  const other = await context.newPage();
  try {
    await Promise.all([studio.goto(), other.goto("/")]);
    for (const tab of [page, other]) {
      await expect(controlFor(tab)).toBeChecked();
      await expect(cardFor(tab)).toContainText("Running");
      await expect(tab.getByRole("button", { name: "Development AWS profile: choose a profile", exact: true })).toBeVisible();
    }
    await Promise.all([page.reload(), other.reload()]);
    for (const tab of [page, other]) await expect(cardFor(tab)).toContainText("Running");
    await detailsFor(page).focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "Local runtime", exact: true });
    await expect(details).toContainText("profile browser");
    await expect(details).toContainText("Containers");
    await expect(details).toContainText("Source watcher");
    await expect(details).toContainText("Web client");
    await assertAccessible(page);
    await page.keyboard.press("Escape");
    await expect(detailsFor(page)).toBeFocused();
    expect(runtime.submitted).toEqual([]);
    expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
    expect(studio.requests.filter(request => /\/deploy\/(status|discover|identity)/.test(request.path))).toEqual([]);
  } finally { await other.close(); }
});

for (const width of [1440, 390]) test(`reconnection explains missing components and an explicit retry needs no lifecycle write at ${width}px`, async ({ page, studio }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const runtime = installLocalRuntime(studio);
  const partial = { ...localRuntimeView("starting"), watch: { running: false }, client: { running: false } };
  runtime.set({ ...partial, recovery: { state: "reconnecting", message: "Resuming source watcher and web client for this checkout." } });
  await studio.goto();
  await expect(cardFor(page)).toContainText("Starting");
  await expect(cardFor(page)).not.toContainText("Reconnecting");
  await expect(controlFor(page)).toBeChecked();
  await expect(controlFor(page)).toBeEnabled();
  await detailsFor(page).click();
  const details = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(details).toContainText("Resuming source watcher and web client");
  await expect(details.getByRole("definition")).toHaveText(["1 active", "Stopped", "Stopped"]);
  await expect(details.getByRole("button", { name: "Stop runtime", exact: true })).toBeEnabled();
  await runtime.publish({ ...partial, lifecycle: "attention", recovery: { state: "failed", message: "The web client could not bind its port. Free the port, then retry recovery." } });
  await expect(cardFor(page)).toContainText("Needs attention");
  await expect(cardFor(page)).not.toContainText("Recovery failed");
  await expect(details.getByRole("alert")).toContainText("could not bind its port");
  studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: localRuntimeView("ready") }));
  await details.getByRole("button", { name: "Retry recovery", exact: true }).click();
  expect(studio.requests.some(request => request.path === "/api/deploy/local?force=1")).toBe(true);
  await expect(cardFor(page)).toContainText("Running");
  await expect(details.getByRole("definition")).toHaveText(["1 active", "Running", "Running"]);
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("runtime-reconnected.png"), fullPage: true });
  expect(runtime.submitted).toEqual([]);
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("an intentional stop interrupts reconnection and remains stopped after refresh", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView("starting"), watch: { running: false }, client: { running: false },
    recovery: { state: "reconnecting", message: "Resuming source watcher and web client." } });
  await studio.goto();
  await expect(cardFor(page)).toContainText("Starting");
  await controlFor(page).focus();
  await page.keyboard.press("Space");
  await expect.poll(() => runtime.submitted.map(entry => entry.kind)).toEqual(["local-stop"]);
  await expect(cardFor(page)).toContainText("Stopping");
  await runtime.finish(localRuntimeView());
  await expect(cardFor(page)).toContainText("Stopped");
  await expect(controlFor(page)).not.toBeChecked();
  await page.reload();
  await expect(cardFor(page)).toContainText("Stopped");
  await expect(controlFor(page)).not.toBeChecked();
  expect(runtime.submitted.map(entry => entry.kind)).toEqual(["local-stop"]);
});

test("a confirmed foreign checkout cannot be started or stopped from this checkout", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView(), ownershipConflict: "This Compose project belongs to another checkout. Choose a unique project name.", observationProblem: "Ownership could not be verified." });
  await studio.goto();
  await expect(cardFor(page)).toContainText("Ownership conflict");
  await expect(controlFor(page)).toBeDisabled();
  await detailsFor(page).click();
  const details = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(details.getByRole("alert")).toContainText("belongs to another checkout");
  await expect(details.getByRole("button", { name: "Stop runtime", exact: true })).toHaveCount(0);
  await expect(details.getByRole("link", { name: "Open Deploy", exact: true })).toHaveCount(0);
  expect(runtime.submitted).toEqual([]);
  await assertAccessible(page);
});

test("editing source and switching declaration modes never retargets a running runtime", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  const source = page.getByRole("group", { name: "Source environment", exact: true });
  await source.getByRole("button", { name: "Production", exact: true }).click();
  await expect(control).toHaveCount(0);
  await source.getByRole("button", { name: "Development", exact: true }).click();
  await expect(control).toBeChecked();
  Object.assign(studio.response.snapshot!, { revision: "local-handler-edit" });
  await studio.emit("snapshot", { revision: "local-handler-edit", external: [] });
  await expect(control).toBeChecked();
  await expect(cardFor(page)).toContainText("Running");
  expect(runtime.submitted).toEqual([]);
});

test("changing the selected AWS profile keeps the actual runtime bound to its original profile", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set(localRuntimeView("ready"));
  studio.reply("GET", "/api/aws-connections", route => route.fulfill({ json: connectionCatalogFixture([
    ...overview().profiles, { name: "second-profile", kind: "sso", region: "us-east-1" },
  ]) }));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await page.getByRole("button", { name: "Development AWS profile: browser", exact: true }).click();
  await page.getByRole("combobox", { name: "AWS profile", exact: true }).selectOption("second-profile");
  await page.keyboard.press("Escape");
  await expect(control).toBeChecked();
  await expect(cardFor(page)).toContainText("Running");
  await expect(cardFor(page)).not.toContainText(/elsewhere|attention/i);
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toContainText("profile browser");
  expect(runtime.submitted).toEqual([]);
});

test("a different runtime binding cannot silently retarget the selected deployment", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView("ready"), profile: "other-profile",
    exported: { deployment: "other-dev", account: "999999999999", region: "us-west-2", client: true },
    binding: { deployment: "other-dev", profile: "other-profile", account: "999999999999", region: "us-west-2", startedAt: NOW },
  });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText(/other-dev|another|different/i);
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeVisible();
  expect(runtime.submitted).toEqual([]);
});

for (const failure of ["HTTP failure", "unknown container observation"] as const)
test(`an unavailable local read (${failure}) retains evidence without claiming readiness and can retry`, async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  let unavailable = false;
  studio.reply("GET", "/api/deploy/local", route => route.fulfill(unavailable
    ? failure === "HTTP failure" ? { status: 503, json: { error: "Local runtime status is unavailable. Check again." } }
      : { json: { ...localRuntimeView(), docker: { engine: "unknown", desktop: true }, observationProblem: "Local runtime status is unavailable. Check again." } }
    : { json: localRuntimeView("ready") }));
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  unavailable = true;
  await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
  await expect(cardFor(page)).toContainText("Status unavailable");
  await expect(control).toBeChecked();
  await expect(cardFor(page)).not.toContainText("Running");
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help.getByRole("alert")).toContainText("Local runtime status is unavailable");
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeEnabled();
  unavailable = false;
  await help.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(control).toBeChecked();
  await expect(cardFor(page)).toContainText("Running");
  await page.keyboard.press("Escape");
  await expect(detailsFor(page)).toBeFocused();
  expect(runtime.submitted).toEqual([]);
});

test("healthy external containers have no verified runtime binding and remain inspectable", async ({ page, studio }) => {
  const runtime = installLocalRuntime(studio);
  runtime.set({ ...localRuntimeView("ready"), startedBy: "outside", profile: undefined, binding: undefined });
  await studio.goto();
  const control = controlFor(page);
  await expect(control).toBeChecked();
  await detailsFor(page).click();
  const help = page.getByRole("dialog", { name: "Local runtime", exact: true });
  await expect(help).toBeVisible();
  await expect(help).toContainText("Deployment metadata is unavailable");
  await expect(cardFor(page)).toContainText("Running");
  await expect(help.getByRole("button", { name: "Stop runtime", exact: true })).toBeVisible();
  expect(runtime.submitted).toEqual([]);
});

for (const width of [1440, 390]) test(`Activity bar states Docker's current condition and starts it in place at ${width}px`, async ({ page, studio }) => {
  await page.setViewportSize({ width, height: 900 });
  let running = false, submitted = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const past = { ...dockerJob("succeeded"), id: "past-startup", summary: "Docker is running." };
  studio.reply("GET", "/api/machine/docker", route => route.fulfill({ json: dockerStatus({ engine: running ? "running" : "stopped", desktop: true }) }));
  studio.reply("POST", "/api/deploy/operations", route => { submitted = true; return route.fulfill({ json: dockerJob("running") }); });
  studio.reply("GET", "/api/operations", async route => {
    if (!submitted) { await route.fulfill({ json: { jobs: [past] } }); return; }
    await pending; running = true;
    await route.fulfill({ json: { jobs: [dockerJob("succeeded"), past] } });
  });
  await studio.goto();
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const toggle = activity.getByRole("button", { name: /^Activity/ });
  await expect(activity.getByRole("status")).toHaveText("Docker stopped");
  await expect(toggle).not.toContainText("Start Docker Desktop");
  await assertAccessible(page);
  await activity.getByRole("button", { name: "Start Docker", exact: true }).click();
  await expect(activity.getByRole("status")).toHaveText("Starting Docker…");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  release();
  await expect(activity.getByRole("status")).toHaveText("Docker running");
  await assertAccessible(page);
});

test("a late HTTP observation cannot replace a newer Docker event", async ({ page, studio }) => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  studio.reply("GET", "/api/machine/docker", async route => { await pending; await route.fulfill({ json: dockerStatus({ engine: "stopped", desktop: true }) }); });
  await studio.goto("/deploy");
  await studio.emit("machine-docker", dockerStatus({ engine: "running", desktop: true }, "2026-10-28T12:00:01.000Z"));
  const readiness = page.getByRole("region", { name: "Machine readiness" });
  await expect(readiness).toContainText("This machine");
  finish();
  await studio.settle();
  await expect(readiness).not.toContainText("not running");
  expect(studio.requests.filter(request => request.method === "POST")).toHaveLength(0);
});

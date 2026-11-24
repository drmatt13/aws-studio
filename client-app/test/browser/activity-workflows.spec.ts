import type { Page } from "@playwright/test";
import type { JobLogLine, JobView } from "../../shared/deploy";
import { test, expect, assertAccessible, type StudioFixture } from "./support/test";
import { NOW } from "./support/scenarios";

const finished: JobView = {
  id: "workflow-done", kind: "export", title: "Export fixture outputs", deployment: "browser-dev", params: { deployment: "browser-dev" },
  status: "succeeded", startedAt: "2026-10-28T11:30:00.000Z", endedAt: "2026-10-28T11:31:12.000Z", exitCode: 0, lastSeq: 8, summary: "Exported 12 outputs.",
};
const running: JobView = {
  id: "workflow-running", kind: "deploy-plan", title: "Synthesize browser-dev", deployment: "browser-dev", params: { deployment: "browser-dev", review: "template" },
  status: "running", startedAt: "2026-10-28T11:40:00.000Z", lastSeq: 1, steps: [{ label: "Synthesize", status: "running" }],
};
const failed: JobView = {
  id: "workflow-failed", kind: "deploy-apply", title: "Deploy browser-dev", deployment: "browser-dev", params: { plan: "plan-1" },
  status: "failed", startedAt: "2026-10-28T11:50:00.000Z", endedAt: "2026-10-28T11:53:41.000Z", exitCode: 1, lastSeq: 6, origin: "/deploy",
  summary: "Command exited with status 1. Read the recorded output and domain evidence.",
  steps: [{ label: "Check source", status: "done", startedAt: "2026-10-28T11:50:00.000Z", endedAt: "2026-10-28T11:50:04.000Z" }, { label: "Apply", status: "failed", startedAt: "2026-10-28T11:50:04.000Z", endedAt: "2026-10-28T11:53:41.000Z" }],
};
const line = (seq: number, text: string, stream: JobLogLine["stream"] = "out"): JobLogLine => ({ seq, at: NOW, stream, text });
const output = [line(1, "$ tsx scripts/export.ts", "info"), line(2, "Reading stacks", "err"), line(3, "[WARNING] aws-cdk-lib deprecated", "err"), line(4, "Exported 12 outputs", "err"), line(5, "Done", "out")];
const failureLog = [line(1, "$ tsx scripts/deploy.ts --apply", "info"), line(2, "browser-dev-RdsStack: creating change set"), line(3, "AccessDenied: not authorized to perform cloudformation:CreateChangeSet", "err"), line(4, "Rolling back", "err"), line(5, "Error: stack failed", "err"), line(6, failed.summary!, "err")];

async function tray(page: Page, studio: StudioFixture, jobs: readonly JobView[], logs: Readonly<Record<string, readonly JobLogLine[]>> = {}) {
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
  for (const job of jobs) studio.reply("GET", `/api/operations/${job.id}/log`, route => route.fulfill({ json: { job, lines: logs[job.id] ?? [] } }));
  await studio.goto("/graphql");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  return { activity, toggle: activity.getByRole("button", { name: /^Activity:/ }), history: activity.getByRole("list", { name: "Operations", exact: true }), log: activity.getByLabel("Log", { exact: true }) };
}

test("The header leads with the result and the facts a developer would otherwise dig for", async ({ page, studio }) => {
  const { activity, toggle } = await tray(page, studio, [finished], { [finished.id]: output });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${finished.id}"]`).click();
  const header = activity.locator("header");
  await expect(header).toContainText("Exported 12 outputs.");
  await expect(header).toContainText("1m · exit 0");
  await expect(header).not.toContainText("Done");
  await expect(activity.getByRole("img", { name: "done", exact: true })).toHaveCount(0);
});

test("Log colour follows what a line says, so ordinary stderr is not a warning", async ({ page, studio }) => {
  const { toggle, log } = await tray(page, studio, [finished], { [finished.id]: output });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${finished.id}"]`).click();
  await expect(log).toContainText("Exported 12 outputs");
  const ink = await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--ink)"; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
  await expect(log.getByText("Reading stacks")).toHaveCSS("color", ink);
  await expect(log.getByText("[WARNING] aws-cdk-lib deprecated")).not.toHaveCSS("color", ink);
});

test("The log filters, narrows to problems, shows times, wraps and copies what is visible", async ({ page, studio, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { activity, toggle, log } = await tray(page, studio, [finished], { [finished.id]: output });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${finished.id}"]`).click();
  await expect(log).toContainText("Reading stacks");
  const filter = activity.getByRole("searchbox", { name: "Filter log", exact: true });
  await filter.fill("EXPORTED");
  await expect(log).toHaveText("Exported 12 outputs");
  await expect(log.locator("mark")).toHaveText("Exported");
  await filter.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(filter).toHaveValue("");
  await filter.fill("nothing like this");
  await expect(log).toContainText("No lines match.");
  await filter.fill("");

  const problems = activity.getByRole("button", { name: "Problems 1", exact: true });
  await problems.click();
  await expect(problems).toHaveAttribute("aria-pressed", "true");
  await expect(log).toHaveText("[WARNING] aws-cdk-lib deprecated");
  await activity.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(activity.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("[WARNING] aws-cdk-lib deprecated");
  await problems.click();

  const wrap = activity.getByRole("button", { name: "Wrap", exact: true });
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect(log).toHaveCSS("white-space", "pre");
  await wrap.click();
  await expect(log).toHaveCSS("white-space", "pre-wrap");
  await wrap.click();
  await activity.getByRole("button", { name: "Time", exact: true }).click();
  await expect(log).toHaveAttribute("data-times", "true");
  const copied = await log.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); return selection.toString(); });
  expect(copied.trimEnd(), "gutters never enter a selection, and lines keep one break").toBe(output.map(entry => entry.text).join("\n"));
  await assertAccessible(page);
});

test("An unwrapped table keeps its columns and scrolls to the end of its longest line", async ({ page, studio }) => {
  const table = `| + | ${"x".repeat(400)} | end-of-row |`;
  const { toggle, log } = await tray(page, studio, [finished], { [finished.id]: [line(1, table), line(2, "short")] });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${finished.id}"]`).click();
  const row = log.locator('[data-seq="1"]');
  await expect(row).toContainText("end-of-row");
  expect(await log.evaluate(element => element.scrollWidth > element.clientWidth), "the log scrolls sideways").toBe(true);
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth), "the line's own box holds all its text, so nothing is clipped").toBe(true);
});

test("On a phone a long failure leaves the log reachable by scrolling the panel", async ({ page, studio }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { activity, toggle, log } = await tray(page, studio, [failed], { [failed.id]: failureLog });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${failed.id}"]`).click();
  await expect(log).toContainText("AccessDenied");
  expect((await log.boundingBox())!.height).toBeGreaterThan(200);
  await log.scrollIntoViewIfNeeded();
  await expect(log).toBeInViewport();
  await expect(activity.getByRole("button", { name: "Ask in Conversation", exact: true })).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertAccessible(page);
});

test("Bundling noise folds without losing a line, and a filter reaches inside it", async ({ page, studio }) => {
  const assets = Array.from({ length: 12 }, (_, index) => [line(0, `Bundling asset browser-dev-Stack/Function${index}/Code/Stage...`, "err"), line(0, "  ...1b92d/index.js  842b", "err"), line(0, "  ...1b92d/index.js.map  1.5kb", "err"), line(0, "⚡ Done in 1ms", "err")]).flat().map((entry, index) => ({ ...entry, seq: index + 2 }));
  const lines = [line(1, "$ tsx scripts/deploy.ts --plan", "info"), ...assets, line(50, "Successfully synthesized", "err")];
  const { activity, toggle, log } = await tray(page, studio, [{ ...finished, lastSeq: 50 }], { [finished.id]: lines });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${finished.id}"]`).click();
  const fold = activity.getByRole("button", { name: "Bundled 12 assets", exact: true });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(log).not.toContainText("Bundling asset");
  await expect(log).toContainText("Successfully synthesized");
  await fold.click();
  await expect(log).toContainText("Function11/Code/Stage");
  await fold.click();
  await expect(log).not.toContainText("Function11/Code/Stage");
  await activity.getByRole("searchbox", { name: "Filter log", exact: true }).fill("Function7");
  await expect(log).toContainText("Function7/Code/Stage");
});

test("A failure names its step, jumps to its first error and offers Agent a draft that nothing sends", async ({ page, studio }) => {
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: { providers: [{ id: "codex", label: "Codex", available: true }], busy: false } }));
  studio.reply("GET", "/api/agent-lab/models", route => route.fulfill({ json: { models: [] } }));
  const { activity, toggle, log } = await tray(page, studio, [failed], { [failed.id]: failureLog });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${failed.id}"]`).click();
  const header = activity.locator("header");
  await expect(header).toContainText("Failed at Apply");
  await expect(header).toContainText("3m · exit 1");
  await expect(header).not.toContainText("Command exited");
  await expect(activity.getByRole("button", { name: "Stop command", exact: true })).toHaveCount(0);
  await expect(activity.getByText("AccessDenied: not authorized to perform cloudformation:CreateChangeSet").first()).toBeVisible();
  await activity.getByRole("button", { name: "Line 3", exact: true }).click();
  await expect(log.locator('[data-seq="3"]')).toBeInViewport();
  await activity.getByRole("button", { name: "Ask in Conversation", exact: true }).click();
  const composer = page.locator('[data-ui="agent-panel"] textarea');
  await expect(composer).toBeFocused();
  const draft = await composer.inputValue();
  expect(draft).toContain("Operation: Deploy browser-dev");
  expect(draft).toContain("Result: Failed at Apply");
  expect(draft).toContain("Exit code: 1");
  expect(draft).toContain("AccessDenied: not authorized");
  expect(studio.requests.filter(request => request.method === "POST")).toEqual([]);
});

test("Jumping to an error happens once per request, so a reader who moves on stays put", async ({ page, studio }) => {
  const long = [...Array.from({ length: 120 }, (_, index) => line(index + 1, `Line ${index + 1}`)), line(121, "Error: first problem", "err"), ...Array.from({ length: 120 }, (_, index) => line(index + 122, `Line ${index + 122}`))];
  const { activity, toggle, log } = await tray(page, studio, [{ ...failed, lastSeq: 241 }], { [failed.id]: long });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${failed.id}"]`).click();
  const jump = activity.getByRole("button", { name: "Line 121", exact: true });
  await jump.click();
  await expect(log.locator('[data-seq="121"]')).toBeInViewport();
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await studio.emit("operation-log", { id: failed.id, lines: [line(242, "A late line")] });
  await expect(log.locator('[data-seq="242"]')).toBeAttached();
  expect(await log.evaluate(element => element.scrollTop)).toBe(0);
  await jump.click();
  await expect(log.locator('[data-seq="121"]')).toBeInViewport();
});

test("Ask in Conversation keeps a draft already being written", async ({ page, studio }) => {
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: { providers: [{ id: "codex", label: "Codex", available: true }], busy: false } }));
  studio.reply("GET", "/api/agent-lab/models", route => route.fulfill({ json: { models: [] } }));
  const { activity, toggle } = await tray(page, studio, [failed], { [failed.id]: failureLog });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${failed.id}"]`).click();
  await activity.getByRole("tab", { name: "Agent", exact: true }).click();
  const composer = page.locator('[data-ui="agent-panel"] textarea');
  await composer.fill("My earlier thought");
  await activity.getByRole("tab", { name: /^Activity/ }).click();
  await activity.getByRole("button", { name: "Ask in Conversation", exact: true }).click();
  const draft = await composer.inputValue();
  expect(draft.startsWith("My earlier thought\n\nHelp me resolve")).toBe(true);
});

test("Stopping says only what is true of that job", async ({ page, studio }) => {
  const applying: JobView = { ...failed, id: "workflow-applying", status: "running", endedAt: undefined, exitCode: undefined, startedAt: "2026-10-28T11:55:00.000Z", steps: [{ label: "Apply", status: "running" }] };
  const client: JobView = { id: "workflow-client", kind: "local-client", title: "Web client", params: {}, status: "running", execution: "running", startedAt: "2026-10-28T10:00:00.000Z", lastSeq: 0 };
  const { activity, toggle, history } = await tray(page, studio, [applying, running, client]);
  await toggle.click();
  await history.getByRole("button", { name: /^Synthesize browser-dev/ }).click();
  await expect(activity.locator("header")).toContainText("read-only");
  await expect(activity.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(activity).not.toContainText("finish in AWS");
  await history.getByRole("button", { name: /^Deploy browser-dev/ }).click();
  await expect(activity.getByRole("button", { name: "Stop command", exact: true })).toBeVisible();
  await expect(activity).toContainText("Stacks already started finish in AWS.");
  await history.getByRole("button", { name: /^Web client/ }).click();
  await expect(activity.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(activity).not.toContainText("finish in AWS");
});

test("Running work stays reachable however much history has passed, and older history pages in", async ({ page, studio }) => {
  const client: JobView = { id: "workflow-old-client", kind: "local-client", title: "Web client", params: {}, status: "running", execution: "running", startedAt: "2026-01-01T00:00:00.000Z", lastSeq: 0 };
  const history = Array.from({ length: 45 }, (_, index): JobView => ({ ...finished, id: `workflow-history-${String(index).padStart(2, "0")}`, title: `Export ${index}`, startedAt: new Date(Date.parse("2026-10-28T11:00:00.000Z") - index * 60_000).toISOString() }));
  const { activity, toggle, history: list } = await tray(page, studio, [...history, client]);
  await toggle.click();
  await expect(list.getByRole("button", { name: /^Web client Running/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /^Export 19 / })).toHaveCount(1);
  await expect(list.getByRole("button", { name: /^Export 20 / })).toHaveCount(0);
  await activity.getByRole("button", { name: "Show 20 older", exact: true }).click();
  await expect(list.getByRole("button", { name: /^Export 39 / })).toHaveCount(1);
  await activity.getByRole("button", { name: "Show 5 older", exact: true }).click();
  await expect(activity.getByRole("button", { name: /^Show \d+ older$/ })).toHaveCount(0);
});

test("Repeats and development sessions fold into one row that opens to its jobs", async ({ page, studio }) => {
  const at = (minutes: number) => new Date(Date.parse("2026-10-28T11:00:00.000Z") - minutes * 60_000).toISOString();
  const job = (id: string, kind: JobView["kind"], title: string, minutes: number): JobView => ({ id, kind, title, params: {}, status: "succeeded", startedAt: at(minutes), endedAt: at(minutes), lastSeq: 0 });
  const jobs = [job("stop", "local-stop", "Stop development", 1), job("web", "local-client", "Web client", 2), job("watch", "local-watch", "Source watch", 3), job("start", "local-start", "Start development against browser-dev", 4), job("docker-a", "docker-start", "Start Docker Desktop", 5), job("docker-b", "docker-start", "Start Docker Desktop", 6)];
  const { activity, toggle, history } = await tray(page, studio, jobs);
  await toggle.click();
  await expect(history.getByRole("button")).toHaveCount(2);
  const session = history.getByRole("button", { name: /^Development session/ });
  await session.click();
  await expect(session).toHaveAttribute("aria-expanded", "true");
  await expect(activity.getByRole("list", { name: "Development session", exact: true }).getByRole("button")).toHaveCount(4);
  await expect(activity.locator("header")).toContainText("Start development against browser-dev");
  const member = activity.getByRole("list", { name: "Development session", exact: true }).getByRole("button", { name: /^Start development/ });
  await member.click();
  await expect(history.locator("[aria-current]")).toHaveCount(0);
  await expect(member).toBeFocused();
  await expect(history.locator('[tabindex="0"]')).toHaveCount(1);
  await expect(activity.getByText("Select an activity to view its steps and log.")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(member).toHaveAttribute("aria-current", "true");
  await session.click();
  await expect(session).toHaveAttribute("aria-expanded", "false");
  await expect(history.getByRole("button", { name: /^Start Docker Desktop/ })).toContainText("×2");
  await assertAccessible(page);
});

test("One Tab stop reaches history, and arrow keys move through it", async ({ page, studio }) => {
  const second: JobView = { ...finished, id: "workflow-second", title: "Second export", startedAt: "2026-10-28T11:20:00.000Z" };
  const third: JobView = { ...finished, id: "workflow-third", title: "Third export", startedAt: "2026-10-28T11:10:00.000Z" };
  const { activity, toggle, history } = await tray(page, studio, [finished, second, third]);
  await toggle.click();
  await expect(history.locator('[data-history-row][tabindex="0"]')).toHaveCount(1);
  const first = history.getByRole("button", { name: /^Export fixture outputs/ });
  await first.focus();
  await page.keyboard.press("ArrowDown");
  await expect(history.getByRole("button", { name: /^Second export/ })).toBeFocused();
  await expect(activity.locator("header")).toContainText("Second export");
  await page.keyboard.press("End");
  await expect(history.getByRole("button", { name: /^Third export/ })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("/");
  await expect(activity.getByRole("searchbox", { name: "Filter log", exact: true })).toBeFocused();
});

test("Ctrl+` opens the tray at the selected job and returns focus when it closes", async ({ page, studio }) => {
  const { toggle, history } = await tray(page, studio, [finished]);
  const link = page.getByRole("navigation", { name: "Views", exact: true }).getByRole("link", { name: "GraphQL", exact: true });
  await link.focus();
  await page.keyboard.press("Control+Backquote");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(history.getByRole("button", { name: /^Export fixture outputs/ })).toBeFocused();
  await page.keyboard.press("Control+Backquote");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(link).toBeFocused();
});

test("The tray restores its layout and log options after reload with no activity selected", async ({ page, studio }) => {
  const second: JobView = { ...finished, id: "workflow-second", title: "Second export", startedAt: "2026-10-28T11:20:00.000Z" };
  const { activity, toggle, history, log } = await tray(page, studio, [finished, second], { [second.id]: [line(1, "Second output")] });
  await toggle.click();
  await history.getByRole("button", { name: /^Second export/ }).click();
  await activity.getByRole("separator", { name: "Resize bottom panel", exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await activity.getByRole("button", { name: "Wrap", exact: true }).click();
  const height = (await page.locator('[data-ui="activity-drawer"]').boundingBox())!.height;
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(history.locator("[aria-current]")).toHaveCount(0);
  await expect(log).toHaveCount(0);
  await expect(activity.getByText("Select an activity to view its steps and log.")).toBeVisible();
  await history.getByRole("button", { name: /^Second export/ }).click();
  await expect(log).toContainText("Second output");
  await expect(activity.getByRole("button", { name: "Wrap", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await page.locator('[data-ui="activity-drawer"]').boundingBox())?.height).toBe(height);
});

test("A corrupt store is ignored without selecting a fallback activity", async ({ page, studio }) => {
  await page.addInitScript(() => localStorage.setItem("aws-studio:activity:v1", JSON.stringify({ open: "yes", selected: "gone", height: "tall", attention: 4 })));
  const { toggle, history } = await tray(page, studio, [finished]);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(history.locator("[aria-current]")).toHaveCount(0);
});

test("An unseen failure neither marks the tab nor selects it or fills the bar", async ({ page, studio }) => {
  const done = { ...finished, startedAt: "2026-10-28T12:05:00.000Z", endedAt: "2026-10-28T12:06:00.000Z" };
  const { activity, toggle, history } = await tray(page, studio, [done]);
  const tab = activity.getByRole("tab", { name: "Activity", exact: true });
  await expect(tab).toBeVisible();
  const failure = { ...failed, startedAt: "2026-10-28T12:30:00.000Z", endedAt: "2099-01-01T00:00:00.000Z" };
  studio.reply("GET", `/api/operations/${failed.id}/log`, route => route.fulfill({ json: { job: failure, lines: failureLog } }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs: [{ ...done, startedAt: "2099-01-01T00:01:00.000Z", endedAt: "2099-01-01T00:02:00.000Z" }, failure] } }));
  await studio.emit("operation-job", failure);
  await studio.emit("operation-job", { ...done, startedAt: "2099-01-01T00:01:00.000Z", endedAt: "2099-01-01T00:02:00.000Z" });
  await expect(toggle).toHaveText("");
  await toggle.click();
  await expect(history.getByRole("button", { name: /^Deploy browser-dev/ })).toBeVisible();
  await expect(history.locator("[aria-current]")).toHaveCount(0);
  // The failure is in history, yet the tab keeps its plain name and carries no dot.
  await expect(tab).toBeVisible();
  await expect(tab.locator(".rounded-full")).toHaveCount(0);
  await assertAccessible(page);
});

test("A hidden tab reports running work and what finished while it was away", async ({ page, studio }) => {
  await tray(page, studio, [running]);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => (window as unknown as { __hidden: boolean }).__hidden });
    (window as unknown as { __hidden: boolean }).__hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page).toHaveTitle("(1) Running · AWS Studio");
  await studio.emit("operation-job", { ...running, status: "failed", endedAt: NOW });
  await expect(page).toHaveTitle("✕ Synthesize browser-dev · AWS Studio");
  await page.evaluate(() => {
    (window as unknown as { __hidden: boolean }).__hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page).toHaveTitle("AWS Studio");
});

test("A finished job is announced to anyone not looking at the tray", async ({ page, studio }) => {
  const { activity } = await tray(page, studio, [running]);
  await studio.emit("operation-job", { ...running, status: "failed", endedAt: NOW });
  await expect(activity.locator('[aria-live="polite"].sr-only')).toHaveText("Synthesize browser-dev: Failed");
});

test("Links open what a developer wants without adding to the tab order", async ({ page, studio }) => {
  const stack = "arn:aws:cloudformation:us-east-1:123456789012:stack/browser-dev-Stack/abc";
  const { toggle, log } = await tray(page, studio, [finished], { [finished.id]: [line(1, "Local: http://127.0.0.1:5173/"), line(2, `Stack ${stack}`), line(3, "See arn:aws:lambda:us-east-1:123456789012:function:app")] });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${finished.id}"]`).click();
  const web = log.getByRole("link", { name: "http://127.0.0.1:5173/", exact: true });
  await expect(web).toHaveAttribute("rel", "noreferrer");
  await expect(web).toHaveAttribute("tabindex", "-1");
  await expect(log.getByRole("link", { name: stack, exact: true })).toHaveAttribute("href", /cloudformation\/home\?region=us-east-1#\/stacks\/stackinfo\?stackId=/);
  await expect(log.getByRole("link")).toHaveCount(2);
});

test("Latest returns to a running log's tail, and a new job opens at its own", async ({ page, studio }) => {
  const lines = Array.from({ length: 200 }, (_, index) => line(index + 1, `Line ${index + 1}`));
  const { activity, toggle, history, log } = await tray(page, studio, [{ ...running, lastSeq: 200 }, finished], { [running.id]: lines, [finished.id]: lines });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${running.id}"]`).click();
  await expect(log).toContainText("Line 200");
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  const latest = activity.getByRole("button", { name: "Latest", exact: true });
  await expect(latest).toBeVisible();
  await studio.emit("operation-log", { id: running.id, lines: [line(201, "Line 201")] });
  expect(await log.evaluate(element => element.scrollTop), "a reader scrolled away is left alone").toBe(0);
  await latest.click();
  await expect(latest).toHaveCount(0);
  await expect(log.locator('[data-seq="201"]')).toBeInViewport();
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await history.getByRole("button", { name: /^Export fixture outputs/ }).click();
  await expect(log.locator('[data-seq="200"]')).toBeInViewport();
});

test("A 5,000-line log stays pinned and responsive while output streams", async ({ page, studio }) => {
  const lines = Array.from({ length: 5000 }, (_, index) => line(index + 1, `Deployment progress line ${index + 1} ${"output ".repeat(6)}`));
  const job = { ...running, lastSeq: 5000 };
  const { activity, toggle, log } = await tray(page, studio, [job], { [running.id]: lines });
  await toggle.click();
  await page.locator(`[data-history-row][data-job="${running.id}"]`).click();
  await expect(log.locator('[data-seq="5000"]')).toBeAttached({ timeout: 15_000 });
  await expect(log.locator('[data-seq="5000"]')).toBeInViewport();
  await expect(log).toContainText("Showing the latest 5,000 lines.");
  const duration = await page.evaluate(async () => {
    const started = performance.now();
    await new Promise(resolve => requestAnimationFrame(resolve));
    return performance.now() - started;
  });
  expect(duration).toBeLessThan(250);
  for (let seq = 5001; seq <= 5020; seq++) await studio.emit("operation-log", { id: running.id, lines: [line(seq, `Live line ${seq}`)] });
  await expect(log.locator('[data-seq="5020"]')).toBeInViewport();
  expect(await log.locator("[data-seq]").count()).toBe(5000);
  await activity.getByRole("searchbox", { name: "Filter log", exact: true }).fill("line 4321 ");
  await expect(log.locator("[data-seq]")).toHaveCount(1);
});

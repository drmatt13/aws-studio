import type { JobView, OperationKind, OperationRequest, PlanSummaryView } from "../../shared/deploy";
import type { SnapshotResponse } from "../../shared/api";
import { test, expect, assertAccessible } from "./support/test";
import { deploymentPlan, NOW, overview } from "./support/scenarios";
import type { Page } from "@playwright/test";

type Publication = NonNullable<SnapshotResponse["sourcePublication"]>;
const ready: Publication = { status: "ready", epoch: "fixture" };
const held: Publication = { status: "busy", epoch: "fixture", message: "Source is reserved by an active or unverifiable Studio operation." };
const refreshing: Publication = { status: "refresh_required", epoch: "fixture-next", message: "Saved source changed. Refresh Studio to publish a complete architecture before editing it." };

const plan: PlanSummaryView = {
  key: "ready-plan", deployment: "browser-dev", mode: "dev", profile: "browser", account: "123456789012", region: "us-east-1",
  status: "ready", createdAt: NOW, expired: false, synthesis: { current: true },
};
const TITLES: Partial<Record<OperationKind, string>> = { "deploy-plan": "Synthesize browser-dev", "deploy-discard": "Discard plan for browser-dev", "deploy-apply": "Deploy browser-dev" };

/** Records what actually moved inside the page, including any shift the browser excuses after a click. */
async function watchLayout(page: Page) {
  await page.evaluate(() => {
    const state = { total: 0, moved: [] as string[] };
    (window as unknown as { __shifts: typeof state }).__shifts = state;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources?: { node?: Node }[] })[]) {
        const nodes = (entry.sources ?? []).map(source => source.node).filter((node): node is Element => node instanceof Element && !!node.closest("main"));
        if (nodes.length) { state.total += entry.value; state.moved.push(...nodes.map(node => node.textContent?.slice(0, 40) ?? node.nodeName)); }
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
}
const shifts = (page: Page) => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return (window as unknown as { __shifts: { total: number; moved: string[] } }).__shifts;
});
const top = async (page: Page, text: string) => (await page.getByRole("main").getByText(text, { exact: true }).boundingBox())!.y;

/** The real page against fixtures: an operation holds the source exactly as the server reports it. */
function workflow(studio: Parameters<Parameters<typeof test>[2]>[0]["studio"]) {
  const jobs: JobView[] = [], submitted: OperationRequest[] = [];
  let publication = ready, plans: PlanSummaryView[] = [];
  studio.reply("GET", "/api/snapshot", route => route.fulfill({ json: { ...studio.response, sourcePublication: publication } }));
  studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), jobs } }));
  studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
  studio.reply("GET", "/api/deploy/plans", route => route.fulfill({ json: plans }));
  const announce = (next: Publication) => { publication = next; return studio.emit("snapshot", { revision: "browser-revision", external: [] }); };
  studio.reply("POST", "/api/deploy/operations", async route => {
    const request = route.request().postDataJSON() as OperationRequest;
    submitted.push(request);
    const job: JobView = {
      id: `job-${submitted.length}`, kind: request.kind, title: TITLES[request.kind] ?? request.kind, params: request.params,
      deployment: "browser-dev", status: "running", startedAt: NOW, lastSeq: 0,
      ...(typeof request.params.plan === "string" ? { planId: request.params.plan } : request.kind === "deploy-plan" ? { planId: "in-flight" } : {}),
      steps: [{ label: "Working", status: "running" }],
    };
    jobs.unshift(job);
    studio.reply("GET", `/api/operations/${job.id}/log`, log => log.fulfill({ json: { job: jobs.find(entry => entry.id === job.id), lines: [] } }));
    await route.fulfill({ json: job });
    await studio.emit("operation-job", job);
    await studio.emit("deploy-job", job);
    await announce(held);
  });
  return { submitted, setPlans: (next: PlanSummaryView[]) => { plans = next; }, announce,
    async finish(nextPlans: PlanSummaryView[]) {
      const job: JobView = { ...jobs[0]!, status: "succeeded", endedAt: NOW, summary: "Done.", steps: [{ label: "Working", status: "done" }] };
      jobs[0] = job; plans = nextPlans;
      await studio.emit("operation-job", job);
      await studio.emit("deploy-job", job);
      await studio.emit("deploy-changed", { deployment: "browser-dev", profile: "browser" });
      await announce(refreshing);
      await announce(ready);
    } };
}

const WARNINGS = /does not load right now|Editing is paused|wait until it ends/;

for (const width of [1440, 390])
  test(`synthesizing moves nothing and raises no alarm at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 900 });
    const flow = workflow(studio);
    await studio.goto("/deploy");
    const main = page.getByRole("main");
    const header = page.locator("main h1").locator("xpath=ancestor::header");
    const idle = header.getByRole("button", { name: "Synthesize", exact: true });
    await expect(idle).toBeEnabled();
    const before = await idle.boundingBox(), absent = await top(page, "Not deployed here");
    await watchLayout(page);
    await idle.click();

    const running = header.getByRole("button", { name: "Synthesizing…", exact: true });
    await expect(running).toBeDisabled();
    await expect(page.getByRole("region", { name: "Activity", exact: true }), "progress lives in Activity").toContainText("Synthesize browser-dev");
    await expect(page.getByRole("button", { name: /^Configuration health/ }), "a routine hold is not a health condition").toHaveCount(0);
    await expect(main).not.toContainText(WARNINGS);
    await expect(main.locator('article[data-severity="attention"], article[data-severity="blocking"]')).toHaveCount(0);
    expect(await running.boundingBox(), "the action keeps its place and width").toEqual(before);
    expect(await top(page, "Not deployed here")).toBe(absent);

    await flow.finish([plan]);
    const card = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-severity", "info");
    await expect(main).not.toContainText(WARNINGS);
    await expect(page.getByText("Editing resumes when the operation ends."), "the pause ends with the operation").toHaveCount(0);
    expect(await top(page, "Not deployed here"), "the result arrives without pushing anything").toBe(absent);
    expect((await card.boundingBox())!.y).toBeGreaterThan(absent);
    expect((await shifts(page)).moved).toEqual([]);
    await assertAccessible(page);
  });

for (const [action, kind, progress] of [["Discard", "deploy-discard", "Discarding this plan…"]] as const)
  test(`${action} changes its card in place until the plan leaves`, async ({ page, studio }) => {
    const flow = workflow(studio);
    flow.setPlans([plan]);
    await studio.goto("/deploy");
    const card = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(card).toBeVisible();
    const before = await card.boundingBox(), absent = await top(page, "Not deployed here");
    await watchLayout(page);
    await card.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => flow.submitted.map(request => request.kind)).toEqual([kind]);

    const working = page.getByRole("article").filter({ hasText: progress });
    await expect(working).toBeVisible();
    await expect(working).toHaveAttribute("data-severity", "info");
    await expect(page.getByRole("main")).not.toContainText(WARNINGS);
    for (const button of await working.getByRole("button").all()) await expect(button).toBeDisabled();
    expect(await working.boundingBox(), "the card is the same card").toEqual(before);

    await flow.finish([]);
    await expect(page.getByRole("article").filter({ hasText: progress })).toHaveCount(0);
    expect(await top(page, "Not deployed here")).toBe(absent);
    expect((await shifts(page)).moved).toEqual([]);
  });

test("a plan's stack row stays readable under the pointer", async ({ page, studio }) => {
  const flow = workflow(studio);
  flow.setPlans([plan]);
  studio.reply("GET", `/api/deploy/plans/${plan.key}`, route => route.fulfill({ json: { ...deploymentPlan(), key: plan.key, synthesis: { current: true },
    stacks: [{ name: "browser-dev-CognitoStack", fingerprint: { exists: false }, exportsInUse: [], noChanges: false, changes: [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", action: "add", replacement: "False", stateful: true }] }] } }));
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const row = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ }).getByRole("button", { name: /CognitoStack/ });
  await row.hover();
  await assertAccessible(page);
});

test("inspector fields wait in place while an operation holds the source", async ({ page, studio }) => {
  const flow = workflow(studio);
  await studio.goto("/?select=lambda%3Afixture-0");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  await inspector.locator("[data-inspector-disclosure] > details > summary").filter({ hasText: /^Settings/ }).press("Enter");
  const memory = inspector.getByRole("spinbutton", { name: "Memory in MB", exact: true });
  await expect(memory).toBeEnabled();
  const before = await memory.boundingBox();
  const source = await page.getByRole("group", { name: "Source environment" }).boundingBox();
  await flow.announce(held);
  await expect(memory).toBeDisabled();
  expect(await memory.boundingBox(), "the field is the same field, not a read-only replacement").toEqual(before);
  await expect(inspector).not.toContainText(WARNINGS);
  await expect(page.getByRole("banner").getByText("Editing resumes when the operation ends.")).toBeVisible();
  expect(await page.getByRole("group", { name: "Source environment" }).boundingBox(), "the note takes free space").toEqual(source);
  await flow.announce(ready);
  await expect(memory).toBeEnabled();
  await expect(page.getByText("Editing resumes when the operation ends.")).toBeHidden();
});

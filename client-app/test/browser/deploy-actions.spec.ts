import type { JobView, OperationRequest, PlanSummaryView, PlanView, TeardownPlanView } from "../../shared/deploy";
import { test as base, expect, assertAccessible } from "./support/test";
import { deploymentPlan, discoveryFor, NOW, overview } from "./support/scenarios";
import { localRuntimeView } from "./support/local-runtime";
import { inspectionStatus } from "./support/stack-inspection";

interface DeploymentScenario {
  readonly jobs: JobView[];
  readonly submitted: OperationRequest[];
  save(plan: PlanView): void;
  finish(plan?: PlanView): Promise<void>;
  fail(message: string): Promise<void>;
}

function prepared(patch: Partial<PlanView> = {}): PlanView {
  return {
    ...deploymentPlan(),
    key: "prepared-development", planId: "prepared-development-id",
    synthesis: { current: true },
    confirmation: { level: "click", reasons: [] }, uncertainties: [],
    stacks: [{ name: "browser-dev-CognitoStack", fingerprint: { exists: false }, exportsInUse: [], noChanges: false,
      changes: [{ logicalId: "UserPool", type: "AWS::Cognito::UserPool", action: "add", replacement: "False", stateful: true }] }],
    ...patch,
  };
}

function summary(plan: PlanView): PlanSummaryView {
  return {
    key: plan.key, deployment: plan.identity.deployment, mode: plan.identity.mode,
    profile: plan.profile, account: plan.identity.account, region: plan.identity.region,
    status: plan.status, createdAt: plan.createdAt, expired: plan.expired,
    synthesis: plan.synthesis,
    ...(plan.result ? { applied: plan.result.status } : {}),
  };
}

/** Exercise the real compiled UI while every operation remains a browser fixture. */
const test = base.extend<{ deployment: DeploymentScenario }>({
  deployment: [async ({ studio }, use) => {
    const jobs: JobView[] = [], submitted: OperationRequest[] = [];
    const plans = new Map<string, PlanView>();
    const save = (plan: PlanView) => {
      plans.set(plan.key, plan);
      studio.reply("GET", `/api/deploy/plans/${plan.key}`, route => route.fulfill({ json: plans.get(plan.key) }));
    };
    studio.reply("GET", "/api/deploy/overview", route => route.fulfill({ json: { ...overview(), jobs } }));
    studio.reply("GET", "/api/operations", route => route.fulfill({ json: { jobs } }));
    studio.reply("GET", "/api/deploy/plans", route => route.fulfill({ json: [...plans.values()].map(summary) }));
    studio.reply("POST", "/api/deploy/operations", async route => {
      const request = route.request().postDataJSON() as OperationRequest;
      submitted.push(request);
      const job: JobView = {
        id: `fixture-deployment-${submitted.length}`, kind: request.kind,
        title: request.kind === "deploy-plan" ? "Synthesize browser-dev" : "Deploy browser-dev",
        params: request.params, deployment: String(request.params.deployment ?? "browser-dev"),
        status: "running", startedAt: NOW, lastSeq: 0,
        ...(request.kind === "deploy-plan" ? { planId: "prepared-development" } : {}),
        steps: [{ label: request.kind === "deploy-plan" ? "Synthesize and compare" : "Deploy and verify", status: "running" }],
      };
      jobs.unshift(job);
      studio.reply("GET", `/api/operations/${job.id}/log`, logRoute => logRoute.fulfill({ json: { job: jobs.find(entry => entry.id === job.id), lines: [] } }));
      await route.fulfill({ json: job });
    });
    const settle = async (status: "succeeded" | "failed", plan?: PlanView, message?: string) => {
      const previous = jobs[0];
      if (!previous) throw new Error("No fixture operation is running.");
      if (plan) save(plan);
      const job: JobView = {
        ...previous, status, endedAt: NOW,
        ...(plan ? { planId: plan.key } : {}),
        summary: message ?? "Synthesis complete.",
        steps: previous.steps?.map(step => ({ ...step, status: status === "succeeded" ? "done" : "failed" })),
      };
      jobs[0] = job;
      await studio.emit("operation-job", job);
      await studio.emit("deploy-job", job);
      await studio.emit("deploy-changed", { deployment: job.deployment, profile: job.params.profile });
    };
    await use({ jobs, submitted, save,
      finish: plan => settle("succeeded", plan ?? prepared()),
      fail: message => settle("failed", undefined, message),
    });
  }, { auto: true }],
});

for (const width of [1440, 390])
  test(`synthesis creates a reviewable plan and deployment stays inside review at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await studio.goto("/deploy");
    const header = page.locator("main h1").locator("xpath=ancestor::header");
    const synthesize = header.getByRole("button", { name: "Synthesize", exact: true });
    await expect(synthesize).toBeEnabled();
    await expect(header.getByRole("button", { name: /^(Deploy|Review plan)$/ })).toHaveCount(0);
    await synthesize.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => deployment.submitted.length).toBe(1);
    expect(deployment.submitted[0]).toMatchObject({ kind: "deploy-plan", params: { deployment: "browser-dev", profile: "browser", review: "template" } });
    const synthesizing = page.getByRole("button", { name: "Synthesizing…", exact: true });
    await expect(synthesizing).toBeDisabled();
    await expect(synthesizing).toHaveAttribute("aria-busy", "true");
    await expect(synthesizing).toHaveCSS("opacity", "1");
    await expect(synthesizing).toHaveCSS("text-transform", "none");
    await expect(synthesizing).toHaveCSS("font-variant", "normal");
    await page.screenshot({ path: testInfo.outputPath("synthesis-busy-label.png"), fullPage: true });
    await page.keyboard.press("Enter");
    expect(deployment.submitted).toHaveLength(1);
    await expect(page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: collapse panel", exact: true })).toBeVisible();
    await deployment.finish();
    const card = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(card).toBeVisible();
    await expect(header.getByRole("button", { name: "Synthesize", exact: true })).toHaveAttribute("aria-busy", "false");
    await expect(header.getByRole("button", { name: /^(Deploy|Review plan)$/ })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Review plan", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
    await card.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await expect(review).toBeVisible();
    expect(deployment.submitted).toHaveLength(1);
    expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("prepared-deployment-review.png"), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await review.getByRole("button", { name: "Deploy development", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => deployment.submitted.length).toBe(2);
    expect(deployment.submitted[1]).toMatchObject({ kind: "deploy-apply", params: { plan: "prepared-development", profile: "browser", currentSource: true } });
    expect(deployment.submitted.filter(request => request.kind === "deploy-plan")).toHaveLength(1);
  });

for (const width of [1440, 390]) for (const outcome of ["succeeded", "failed"] as const)
test(`deployment keeps one stable progress panel across partial AWS observations and final ${outcome} at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let phase: "absent" | "incompatible" | "in-progress" | "unmarked" | "final" = "absent";
  let release!: () => void;
  const finalRead = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/deploy/status", async (route, url) => {
    if (phase === "absent") { await route.fulfill({ json: { ok: true, value: { ...discoveryFor(url), deployment: url.searchParams.get("deployment") } } }); return; }
    if (phase === "final") await finalRead;
    const result = inspectionStatus(url);
    if (!result.detail) throw new Error("The inspection fixture must describe a deployment.");
    let detail = result.detail;
    if (detail) {
      if (phase === "incompatible") detail = { ...detail, stacks: detail.stacks.slice(0, 1),
        local: { compatible: false, problem: "lambda:sign-in needs an attribute absent from the deployment.",
          exported: { deployment: "browser-dev", manifest: "fixture", client: true, fresh: false } } };
      if (phase === "in-progress" || phase === "unmarked") {
        const stack = { ...detail.stacks[1]!, status: "CREATE_IN_PROGRESS", health: "in-progress" as const };
        detail = { ...detail, stacks: [stack], state: phase === "unmarked"
          ? { kind: "conflict", reason: "unmarked", message: "Stacks of this name are not this deployment's", stacks: [{ ...stack, evidence: "none", identity: undefined }] }
          : { kind: "in-progress", stacks: [stack], deployable: false } };
      }
      if (phase === "final" && outcome === "failed") {
        const stack = { ...detail.stacks[0]!, status: "CREATE_FAILED", health: "failed" as const };
        detail = { ...detail, stacks: [stack], state: { kind: "failed", stacks: [stack], deployable: true } };
      }
    }
    await route.fulfill({ json: { ok: true, value: { ...result, detail } } });
  });
  deployment.save(prepared());
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  await page.getByRole("dialog", { name: /^Review deployment for browser-dev/ }).getByRole("button", { name: "Deploy development", exact: true }).click();
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-apply"]);
  const main = page.getByRole("main"), progress = main.getByRole("status", { name: "Deployment progress", exact: true });
  await expect(progress).toContainText("Deploying browser-dev");
  const bounds = await progress.boundingBox();
  await progress.evaluate(element => element.setAttribute("data-fixture-identity", "same-panel"));
  const expectedAccent = await progress.evaluate(element => {
    const probe = document.createElement("span"); probe.style.color = "var(--accept)"; element.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  });
  await expect(progress).toHaveCSS("border-left-color", expectedAccent);
  for (const next of ["incompatible", "in-progress", "unmarked"] as const) {
    phase = next;
    const before = studio.requests.filter(request => request.path.startsWith("/api/deploy/status?")).length;
    await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
    await expect.poll(() => studio.requests.filter(request => request.path.startsWith("/api/deploy/status?")).length).toBeGreaterThan(before);
    await studio.settle();
    await expect(progress).toHaveAttribute("data-fixture-identity", "same-panel");
    expect(await progress.boundingBox()).toEqual(bounds);
    await expect(main.locator("article")).toHaveCount(1);
    await expect(main.getByRole("alert")).toHaveCount(0);
    await expect(main).not.toContainText("Local development cannot run");
    await expect(main).not.toContainText("CloudFormation is working");
    await expect(main).not.toContainText("Stacks of this name");
    await expect(main).not.toContainText("Synthesize again");
    await expect(main.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(0);
  }
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("steady-deployment-progress.png"), fullPage: true });
  phase = "final";
  if (outcome === "succeeded") await deployment.finish(); else await deployment.fail("Fixture deployment failed.");
  await expect(progress).toContainText("Deploying browser-dev");
  await expect(main.getByRole("button", { name: "Synthesize", exact: true })).toBeDisabled();
  await expect(progress).toHaveAttribute("data-fixture-identity", "same-panel");
  expect(await progress.boundingBox()).toEqual(bounds);
  await expect(main.getByRole("alert")).toHaveCount(0);
  release();
  await expect(progress).toHaveCount(0);
  await expect(main.getByText(outcome === "succeeded" ? "Deployed · 5 stacks" : "1 stack failed", { exact: true })).toBeVisible();
  expect(deployment.submitted).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("reviewing a saved current plan preserves the artifact and returns focus to its card", async ({ page, studio, deployment }) => {
  deployment.save(prepared());
  await studio.goto("/deploy");
  const header = page.locator("main h1").locator("xpath=ancestor::header");
  await expect(header.getByRole("button", { name: /^(Deploy|Review plan)$/ })).toHaveCount(0);
  const reviewPlan = page.getByRole("button", { name: "Review plan", exact: true });
  await reviewPlan.click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  await expect(review).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(reviewPlan).toBeFocused();
  expect(deployment.submitted).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(review).toBeVisible();
  expect(deployment.submitted).toEqual([]);
});

for (const width of [1440, 390])
  test(`only the newest plan is current and earlier plans remain reviewable at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const earlier = prepared({ key: "earlier-development", planId: "earlier-development-id", createdAt: "2026-10-28T11:00:00.000Z" });
    const current = prepared({ createdAt: "2026-10-28T12:00:00.000Z" });
    deployment.save(earlier);
    deployment.save(current);
    // Plans belonging to another connection are never part of this destination's history.
    deployment.save(prepared({ key: "foreign-profile", planId: "foreign-profile-id", profile: "another-profile", createdAt: "2026-10-28T13:00:00.000Z" }));
    await studio.goto("/deploy");
    const cards = page.getByRole("article").filter({ hasText: "Plan ready for review" });
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(1);
    await cards.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    const earlierPlans = page.locator("summary").filter({ hasText: /^Earlier plans \(1\)$/ });
    await expect(earlierPlans).toBeVisible();
    await earlierPlans.focus();
    await page.keyboard.press("Enter");
    await expect(cards).toHaveCount(2);
    const history = earlierPlans.locator("xpath=..");
    const earlierReview = history.getByRole("button", { name: "Review plan", exact: true });
    await expect(earlierReview).toBeVisible();
    await expect(history.getByRole("button", { name: "Discard", exact: true })).toBeVisible();
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("current-plan-and-history.png"), fullPage: true });
    await earlierReview.click();
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Deploy development", exact: true }).click();
    await expect.poll(() => deployment.submitted.length).toBe(1);
    expect(deployment.submitted[0]).toMatchObject({ kind: "deploy-apply", params: { plan: earlier.key, profile: "browser" } });
    expect(deployment.submitted[0]?.params.currentSource).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

for (const width of [1440, 390])
  test(`deployment review keeps inspectable changes inside their stack at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    deployment.save(prepared({ iamBroadening: true, reviewEvidence: {
      security: "Fixture security analysis.", templates: "Fixture template comparison.", problems: [],
    }, stacks: [{ name: "browser-dev-CognitoStack", fingerprint: { exists: false }, exportsInUse: [], noChanges: false,
      changes: [{ logicalId: "ReplayPolicy", type: "AWS::IAM::Policy", action: "add", replacement: "False", stateful: false,
        after: { PolicyDocument: { Statement: [{ Action: "s3:GetObject", Resource: "replay-bucket/*" }] } } }] }],
    }));
    await studio.goto("/deploy");
    await page.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await expect(review.getByText(/IAM or security permissions broaden/)).toHaveCount(0);
    for (const label of ["IAM and security diff", "Full template diff", "Synthesis details and limitations"])
      await expect(review.getByText(label, { exact: true })).toHaveCount(0);
    const stack = review.getByRole("button", { name: "CognitoStack 1 to add", exact: true });
    const changes = review.getByRole("region", { name: "Resource changes in CognitoStack", exact: true });
    await expect(changes).toHaveCount(0);
    await stack.focus();
    await page.keyboard.press("Enter");
    await expect(changes).toBeVisible();
    await expect(stack).toBeFocused();
    const card = stack.locator("xpath=..");
    const [cardBox, headerBox, changesBox] = await Promise.all([card.boundingBox(), stack.boundingBox(), changes.boundingBox()]);
    expect(cardBox).not.toBeNull(); expect(headerBox).not.toBeNull(); expect(changesBox).not.toBeNull();
    expect(changesBox!.x).toBeGreaterThan(cardBox!.x);
    expect(changesBox!.x + changesBox!.width).toBeLessThan(cardBox!.x + cardBox!.width);
    expect(changesBox!.y).toBeGreaterThan(headerBox!.y + headerBox!.height);
    expect(changesBox!.y + changesBox!.height).toBeLessThan(cardBox!.y + cardBox!.height);
    expect(await card.evaluate(element => Number.parseFloat(getComputedStyle(element).borderTopWidth))).toBeGreaterThan(0);
    await changes.locator("summary").filter({ hasText: /^Inspect property values$/ }).click();
    await expect(changes).toContainText("s3:GetObject");
    await expect(changes).toContainText("replay-bucket/*");
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("deployment-stack-review.png"), fullPage: true });
    await stack.focus();
    await page.keyboard.press("Space");
    await expect(changes).toHaveCount(0);
    await expect(stack).toBeFocused();
    expect(deployment.submitted).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

test("a synthesis finishing after a mode switch stays bound to its original destination", async ({ page, studio, deployment }) => {
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  const mode = page.getByRole("group", { name: "Source environment", exact: true });
  await mode.getByRole("button", { name: "Production", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^browser-prod/ })).toBeVisible();
  await deployment.finish();
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(0);
  expect(deployment.submitted).toHaveLength(1);
  await mode.getByRole("button", { name: "Development", exact: true }).click();
  await expect(page.getByText("Plan ready for review", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "GraphQL", exact: true }).click();
  await page.getByRole("link", { name: "Deploy", exact: true }).click();
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ })).toBeVisible();
  expect(deployment.submitted).toHaveLength(1);
});

test("stale current plans cannot deploy and a new no-change synthesis never applies", async ({ page, studio, deployment }) => {
  deployment.save(prepared({ synthesis: { current: false, reason: "Deployment sources changed. Synthesize again." } }));
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  await expect(review.getByText("Deployment sources changed. Synthesize again.", { exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  expect(deployment.submitted[0]?.kind).toBe("deploy-plan");
  await deployment.finish(prepared({ status: "no-changes", stacks: [] }));
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  await expect(review).toBeVisible();
  await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toHaveCount(0);
  expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
});

test("source changes during preparation require another synthesis before deployment", async ({ page, studio, deployment }) => {
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  const previousReads = studio.requests.filter(request => request.path === "/api/snapshot").length;
  Object.assign(studio.response.snapshot!, { revision: "changed-deployment-source" });
  await studio.emit("snapshot", { revision: "changed-deployment-source", external: [] });
  await expect.poll(() => studio.requests.filter(request => request.path === "/api/snapshot").length).toBeGreaterThan(previousReads);
  await deployment.finish(prepared({ synthesis: { current: false, reason: "Deployment sources changed. Synthesize again." } }));
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  await expect(review.getByRole("button", { name: "Deploy development", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(2);
  expect(deployment.submitted.every(request => request.kind === "deploy-plan")).toBe(true);
});

test("synthesis errors stay in Activity without creating a review or deployment", async ({ page, studio, deployment }) => {
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Synthesize", exact: true }).click();
  await expect.poll(() => deployment.submitted.length).toBe(1);
  await deployment.fail("Invalid resource reference in the declaration.");
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toContainText("Invalid resource reference in the declaration.");
  await expect(page.getByRole("dialog", { name: /Review deployment/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review plan", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Synthesize", exact: true })).toBeEnabled();
  expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
});

for (const width of [1440, 390])
  test(`development synthesis and review stay available while runtime blocks deployment and destruction at ${width}px`, async ({ page, studio, deployment }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let local = localRuntimeView("ready");
    studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: local }));
    studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: inspectionStatus(url) } }));
    deployment.save(prepared());
    await studio.goto("/deploy");
    const synthesize = page.getByRole("button", { name: "Synthesize", exact: true });
    await expect(synthesize).toBeEnabled();
    const deployed = page.getByRole("group", { name: "Deployed deployment", exact: true });
    await deployed.locator("summary").click();
    await expect(deployed.getByRole("button", { name: "Destroy…", exact: true })).toBeDisabled();
    await expect(deployed).toContainText("Stop local runtime before changing development resources.");
    expect(studio.requests.some(request => request.path.startsWith("/api/deploy/teardown"))).toBe(false);
    await synthesize.click();
    await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-plan"]);
    await deployment.finish();
    await page.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    const apply = review.getByRole("button", { name: "Deploy development", exact: true });
    await expect(apply).toBeDisabled();
    await expect(review).toContainText("Stop local runtime before changing development resources.");
    await assertAccessible(page);
    await page.screenshot({ path: testInfo.outputPath("runtime-blocks-development-review.png"), fullPage: true });
    await review.getByRole("button", { name: "Stop local runtime", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-plan", "local-stop"]);
    await expect(apply).toBeDisabled();
    local = localRuntimeView();
    await deployment.finish();
    await expect(review).toBeVisible();
    await expect(apply).toBeEnabled();
    await expect(apply).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-plan", "local-stop", "deploy-apply"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

test("a partial local runtime blocks development deployment until cleanup finishes", async ({ page, studio, deployment }) => {
  let local = localRuntimeView("blocked");
  studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: local }));
  deployment.save(prepared());
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  const apply = review.getByRole("button", { name: "Deploy development", exact: true });
  await expect(apply).toBeDisabled();
  await review.getByRole("button", { name: "Stop local runtime", exact: true }).click();
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["local-stop"]);
  local = localRuntimeView();
  await deployment.finish();
  await expect(apply).toBeEnabled();
  expect(deployment.submitted.some(request => request.kind === "deploy-apply")).toBe(false);
});

test("unknown local runtime status blocks development confirmation and can be checked again", async ({ page, studio, deployment }) => {
  let unavailable = true;
  studio.reply("GET", "/api/deploy/local", route => route.fulfill(unavailable
    ? { status: 503, json: { error: "Local runtime status could not be read." } }
    : { json: localRuntimeView() }));
  deployment.save(prepared());
  await studio.goto("/deploy");
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
  const apply = review.getByRole("button", { name: "Deploy development", exact: true });
  await expect(apply).toBeDisabled();
  await expect(review).toContainText(/check|unavailable|could not/i);
  unavailable = false;
  await review.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(apply).toBeEnabled();
  expect(deployment.submitted).toEqual([]);
});

for (const typed of [true, false])
test(`an open deletion review reacts when local runtime starts and returns keyboard focus after stopping (${typed ? "confirmed" : "untyped"})`, async ({ page, studio, deployment }) => {
  let local = localRuntimeView();
  studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: local }));
  studio.reply("GET", "/api/deploy/status", (route, url) => route.fulfill({ json: { ok: true, value: inspectionStatus(url) } }));
  const deletion: TeardownPlanView = { key: "runtime-delete-review", deployment: "browser-dev", mode: "dev", account: "123456789012", region: "us-east-1",
    createdAt: NOW, expiresAt: "2030-01-01T00:00:00Z", digest: "fixture-runtime-delete", stacks: [], leftInPlace: [], remains: [], secrets: [], record: true };
  studio.reply("GET", "/api/deploy/teardown", route => route.fulfill({ json: { ok: true, value: deletion } }));
  await studio.goto("/deploy");
  const deployed = page.getByRole("group", { name: "Deployed deployment", exact: true });
  await deployed.locator("summary").click();
  await deployed.getByRole("button", { name: "Destroy…", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Delete browser-dev\b/ });
  const remove = review.getByRole("button", { name: "Delete browser-dev", exact: true });
  const confirmation = review.getByRole("textbox", { name: "Type browser-dev to delete it", exact: true });
  if (typed) {
    await confirmation.fill("browser-dev");
    await expect(remove).toBeEnabled();
  } else await expect(remove).toBeDisabled();
  local = localRuntimeView("ready");
  await studio.emit("deploy-changed", { profile: "browser", deployment: "browser-dev" });
  await expect(remove).toBeDisabled();
  await review.getByRole("button", { name: "Stop local runtime", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["local-stop"]);
  local = localRuntimeView();
  await deployment.finish();
  if (typed) {
    await expect(remove).toBeEnabled();
    await expect(remove).toBeFocused();
  } else {
    await expect(remove).toBeDisabled();
    await expect(confirmation).toBeFocused();
  }
  expect(deployment.submitted.some(request => request.kind === "destroy")).toBe(false);
  await assertAccessible(page);
});

test("development runtime does not block an independent production deployment review", async ({ page, studio, deployment }) => {
  studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: localRuntimeView("ready") }));
  const prod = prepared({ key: "prepared-production", planId: "prepared-production-id", identity: { ...deploymentPlan().identity, deployment: "browser-prod", mode: "prod" } });
  deployment.save(prod);
  await studio.goto("/deploy");
  await page.getByRole("group", { name: "Source environment", exact: true }).getByRole("button", { name: "Production", exact: true }).click();
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  const review = page.getByRole("dialog", { name: /^Review deployment for browser-prod\b/ });
  await expect(review.getByRole("button", { name: "Deploy production", exact: true })).toBeEnabled();
  await expect(review.getByRole("button", { name: "Stop local runtime", exact: true })).toHaveCount(0);
  expect(deployment.submitted).toEqual([]);
});

for (const kind of ["secret creation", "change-set preparation"] as const)
  test(`runtime blocks ${kind} while ordinary template synthesis stays available`, async ({ page, studio, deployment }) => {
    studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: localRuntimeView("ready") }));
    deployment.save(prepared(kind === "secret creation" ? {
      status: "needs-secrets", secrets: [{ name: "fixture-secret", variable: "FIXTURE_SECRET", action: "create" }],
    } : { status: "blocked", review: "change-set", synthesis: { current: false, reason: "Prepare the new change set." } }));
    await studio.goto("/deploy");
    await expect(page.getByRole("button", { name: "Synthesize", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Review plan", exact: true }).click();
    const review = page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ });
    await expect(review.getByRole("button", { name: kind === "secret creation" ? "Create secrets and plan again" : "Synthesize again", exact: true })).toBeDisabled();
    await expect(review.getByRole("button", { name: "Stop local runtime", exact: true })).toBeVisible();
    expect(deployment.submitted).toEqual([]);
  });

test("the complete development journey deploys, runs locally, stops and destroys explicitly", async ({ page, studio, deployment }, testInfo) => {
  let cloudExists = false;
  let local = localRuntimeView();
  studio.reply("GET", "/api/deploy/local", route => route.fulfill({ json: local }));
  studio.reply("GET", "/api/deploy/status", (route, url) => {
    const value = inspectionStatus(url);
    return route.fulfill({ json: { ok: true, value: cloudExists ? { ...value, detail: { ...value.detail!, local: {
      compatible: true, exported: { deployment: "browser-dev", client: true, fresh: true },
    } } } : { ...value, deployments: [], detail: undefined, targets: value.targets.map(target => ({ ...target, status: "absent" })) } } });
  });
  const initial = prepared();
  const applied = prepared({ result: { status: "succeeded", deferred: [], verification: { verified: true, stacks: [] } } });
  deployment.save(initial);
  await studio.goto();
  const runtime = page.getByRole("switch", { name: "Local runtime", exact: true, includeHidden: true });
  await expect(runtime).toHaveCount(0);
  const navigation = page.getByRole("navigation", { name: "Views", exact: true });
  await navigation.getByRole("link", { name: "Deploy", exact: true }).click();
  await page.getByRole("button", { name: "Review plan", exact: true }).click();
  await page.getByRole("dialog", { name: /^Review deployment for browser-dev\b/ }).getByRole("button", { name: "Deploy development", exact: true }).click();
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-apply"]);
  await navigation.getByRole("link", { name: "Map", exact: true }).click();
  await expect(runtime).toHaveCount(0);
  cloudExists = true;
  await deployment.finish(applied);
  const collapseActivity = async () => {
    const collapse = page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: collapse panel", exact: true });
    await expect(collapse).toBeVisible();
    await collapse.click();
  };
  await collapseActivity();
  await expect(runtime).toBeEnabled();
  await runtime.click();
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-apply", "local-start"]);
  local = localRuntimeView("ready");
  await deployment.finish(applied);
  await expect(page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: expand panel", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(runtime).toBeChecked();
  // The card carries the status line; the switch inside it is only the control.
  await expect(page.locator("[data-ui='compose-preview']")).toContainText("Running");
  await runtime.click();
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-apply", "local-start", "local-stop"]);
  local = localRuntimeView();
  await deployment.finish(applied);
  await expect(page.getByRole("region", { name: "Activity", exact: true }).getByRole("button", { name: "Activity: expand panel", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(runtime).not.toBeChecked();
  await navigation.getByRole("link", { name: "Deploy", exact: true }).click();
  const deployed = page.getByRole("group", { name: "Deployed deployment", exact: true });
  await deployed.locator("summary").click();
  const deletion: TeardownPlanView = { key: "journey-delete-review", deployment: "browser-dev", mode: "dev", account: "123456789012", region: "us-east-1",
    createdAt: NOW, expiresAt: "2030-01-01T00:00:00Z", digest: "fixture-journey-delete", stacks: [], leftInPlace: [], remains: [], secrets: [], record: true };
  studio.reply("GET", "/api/deploy/teardown", route => route.fulfill({ json: { ok: true, value: deletion } }));
  await deployed.getByRole("button", { name: "Destroy…", exact: true }).click();
  const deletionReview = page.getByRole("dialog", { name: /^Delete browser-dev\b/ });
  const remove = deletionReview.getByRole("button", { name: "Delete browser-dev", exact: true });
  await expect(remove).toBeDisabled();
  await deletionReview.getByRole("textbox", { name: "Type browser-dev to delete it", exact: true }).fill("browser-dev");
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect.poll(() => deployment.submitted.map(request => request.kind)).toEqual(["deploy-apply", "local-start", "local-stop", "destroy"]);
  cloudExists = false;
  await deployment.finish(applied);
  await collapseActivity();
  await navigation.getByRole("link", { name: "Map", exact: true }).click();
  await expect(runtime).toHaveCount(0);
  await assertAccessible(page);
  await page.screenshot({ path: testInfo.outputPath("development-journey-destroyed.png"), fullPage: true });
});

import type { CodingProposal, CodingTask } from "../../shared/agent-runtime";
import type { ContractDecision } from "../../shared/contract-propagation";
import type { DatabaseSourceReview } from "../../shared/database-workbench";
import { contractTaskFixture } from "../support/contract-propagation";
import { graphqlChainFixture, withChainLink } from "../support/graphql-chain";
import { test, expect, assertAccessible } from "./support/test";
import { workbench } from "./support/scenarios";

const diffs = [{ surface: "prisma" as const, subject: "Note", path: "Note.slug", change: "added" as const, before: null, after: "String?" }];
const savedChain = () => withChainLink(graphqlChainFixture(), { id: "prisma-pothos", kind: "reviewed", state: { status: "changed", diffs }, models: { Note: { status: "changed", diffs } }, actions: [{ kind: "agent", link: "prisma-pothos" }] });
function proposal(task: CodingTask): CodingProposal {
  return { id: "contract-proposal", taskId: task.id, digest: task.proposalDigest!, baselineDigest: "baseline", candidateDigest: "candidate", createdAt: task.createdAt, activation: "none", limitations: [], changes: [], validation: [{ command: "Independent contract checks", status: "passed", candidateDigest: "candidate" }] };
}

test.beforeEach(async ({ studio }) => {
  studio.reply("GET", "/api/agent-tasks/recovery", route => route.fulfill({ json: { coordination: { status: "ready", epoch: "fixture" }, recoveries: [] } }));
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: { providers: ["codex", "claude"].map(id => ({ id, label: id, available: true, detail: "Installed" })), busy: false } }));
  studio.reply("GET", "/api/agent-lab/models", (route, url) => route.fulfill({ json: { provider: url.searchParams.get("provider"), source: "cli", models: [] } }));
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: savedChain() }));
});

for (const width of [1440, 390]) {
  test(`saved Prisma impact opens the API stage without starting a deep check at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 900 });
    let saved = workbench(), review: DatabaseSourceReview;
    studio.reply("GET", "/api/database/workbench", route => route.fulfill({ json: saved }));
    studio.reply("POST", "/api/database/workbench/review", route => {
      const request = route.request().postDataJSON() as { source: string };
      review = { reviewId: "prisma-review", file: saved.file, before: saved.source, after: request.source, expectedRevision: saved.revision, configRevision: saved.configRevision, sourceHash: "saved-note-slug", expiresAt: "2099-01-01T00:00:00Z", validation: { ...saved.validation, valid: true }, effects: ["Writes only authored Prisma source."] };
      return route.fulfill({ json: review });
    });
    studio.reply("POST", "/api/database/workbench/save", route => {
      const beforeRevision = saved.revision;
      saved = { ...saved, source: review.after, revision: "saved-note-slug" };
      return route.fulfill({ json: { saved: true, source: saved.source, revision: saved.revision, file: saved.file, refresh: "complete", message: "Authored schema saved.", contractImpact: { revision: saved.revision, beforeRevision, models: ["Note"], diffs, semantics: "changed", stages: ["api", "codegen", "client"], earliestStage: "api" } } });
    });
    await studio.goto("/database/schema");
    const editor = page.getByRole("textbox", { name: "Prisma schema source" });
    await editor.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Home");
    await page.keyboard.insertText("  slug String?\n");
    await expect(page.getByRole("region", { name: "Saved contract impact" })).toHaveCount(0);
    await page.getByRole("button", { name: "Validate draft", exact: true }).click();
    await page.getByRole("button", { name: "Review source changes", exact: true }).click();
    await page.getByRole("button", { name: "Save schema", exact: true }).click();
    const impact = page.getByRole("region", { name: "Saved contract impact" });
    await expect(impact).toContainText("Next: Repository and API");
    await impact.getByText("Inspect affected fields · 1", { exact: true }).click();
    await expect(impact).toContainText("Note.slug");
    const next = impact.getByRole("link", { name: "Continue contract update", exact: true });
    await next.focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/graphql\/schema$/);
    await expect(page.getByRole("heading", { name: "Next: Repository and API", exact: true })).toBeVisible();
    expect(studio.requests.filter(request => request.path.includes("check=fresh"))).toHaveLength(0);
    expect(studio.requests.filter(request => request.method === "POST" && request.path.startsWith("/api/agent-tasks"))).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertAccessible(page);
  });

  test(`candidate decisions rerun their stage and survive reload without changing the saved rail at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 900 });
    const before = contractTaskFixture(), decisions = before.contract!.decisions.slice(0, 1);
    let current: CodingTask = { ...before, contract: { ...before.contract!, decisions, checkpoints: before.contract!.checkpoints.map(checkpoint => ({ ...checkpoint, decisions })) } };
    studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
    studio.reply("GET", `/api/agent-tasks/${current.id}/events`, route => route.fulfill({ json: { task: current, events: [] } }));
    studio.reply("GET", `/api/agent-tasks/${current.id}/proposal`, route => route.fulfill({ json: proposal(current) }));
    studio.reply("POST", `/api/agent-tasks/${current.id}/continue`, route => {
      const request = route.request().postDataJSON() as { digest: string; decisions: readonly ContractDecision[] };
      expect(request.digest).toBe(current.proposalDigest);
      current = { ...current, lastSeq: current.lastSeq + 1, proposalDigest: "reconciled-decisions", contract: { ...current.contract!, decisions: request.decisions, checkpoints: current.contract!.checkpoints.map(checkpoint => ({ ...checkpoint, decisions: request.decisions })) } };
      return route.fulfill({ json: current });
    });
    await studio.goto("/graphql/schema");
    const card = page.getByRole("region", { name: "Contract update", exact: true });
    await expect(card).toContainText("Private candidate");
    await expect(page.getByRole("button", { name: "Codegen: Waiting for upstream", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Open in Coding", exact: true }).focus(); await page.keyboard.press("Enter");
    const coding = page.getByRole("region", { name: "Coding tasks", exact: true });
    const candidate = coding.getByRole("region", { name: "Candidate contract progress", exact: true });
    await candidate.getByText(/Public exposure · Needs review/).click();
    await candidate.getByRole("textbox", { name: "Reviewed behavior", exact: true }).fill("Keep this field private; no public API changes.");
    await candidate.getByRole("textbox", { name: "Source or user evidence", exact: true }).fill("Explicit developer intent for this update.");
    await candidate.getByRole("checkbox", { name: "I reviewed this decision", exact: true }).check();
    await candidate.getByRole("button", { name: "Apply decisions to candidate", exact: true }).click();
    await expect(candidate.getByRole("button", { name: "Continue to Generate documents", exact: true })).toBeEnabled();
    await expect(coding.getByRole("button", { name: "Approve and apply", exact: true })).toHaveCount(0);
    await page.reload();
    const restored = page.getByRole("region", { name: "Contract update", exact: true });
    await expect(restored).toContainText("Private candidate");
    await restored.getByRole("button", { name: "Open in Coding", exact: true }).click();
    await expect(candidate.getByRole("button", { name: "Continue to Generate documents", exact: true })).toBeEnabled();
    expect(studio.requests.filter(request => request.path.endsWith("/continue"))).toHaveLength(1);
    expect(studio.requests.filter(request => request.path.endsWith("/approve") || request.path.endsWith("/accept"))).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertAccessible(page);
  });
}

test("a verified no-op candidate still requires explicit final approval and saved proof renewal", async ({ page, studio }) => {
  const before = contractTaskFixture("client");
  let current: CodingTask = { ...before, contract: { ...before.contract!, stage: "client", status: "ready", decisions: [] } };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${current.id}/events`, route => route.fulfill({ json: { task: current, events: [] } }));
  studio.reply("GET", `/api/agent-tasks/${current.id}/proposal`, route => route.fulfill({ json: proposal(current) }));
  studio.reply("POST", `/api/agent-tasks/${current.id}/approve`, route => {
    current = { ...current, status: "completed", lastSeq: current.lastSeq + 1, contract: { ...current.contract!, status: "applied-awaiting-check" } };
    return route.fulfill({ json: current });
  });
  await studio.goto("/graphql/schema");
  await page.getByRole("region", { name: "Contract update", exact: true }).getByRole("button", { name: "Open in Coding", exact: true }).click();
  const coding = page.getByRole("region", { name: "Coding tasks", exact: true });
  await expect(coding).toContainText("Candidate ready for review");
  const apply = coding.getByRole("button", { name: "Approve and apply", exact: true });
  await expect(apply).toBeEnabled(); expect(studio.requests.filter(request => request.path.endsWith("/approve"))).toHaveLength(0);
  const sourceReads = studio.requests.filter(request => request.path.startsWith("/api/graphql/chain")).length;
  await apply.focus(); await page.keyboard.press("Enter");
  await expect(coding).toContainText("Applied · verification pending");
  await expect.poll(() => studio.requests.filter(request => request.path.startsWith("/api/graphql/chain")).length).toBeGreaterThan(sourceReads);
  await page.getByRole("button", { name: "Agent: collapse panel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Codegen: Waiting for upstream", exact: true })).toBeVisible();
  expect(studio.requests.filter(request => request.path.endsWith("/accept"))).toHaveLength(0);
});

test("a retained passing candidate without versioned proof is historical and cannot be applied", async ({ page, studio }) => {
  const before = contractTaskFixture("client"), current: CodingTask = { ...before, contract: { ...before.contract!, status: "ready", decisions: [], proofs: undefined } };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${current.id}/events`, route => route.fulfill({ json: { task: current, events: [] } }));
  studio.reply("GET", `/api/agent-tasks/${current.id}/proposal`, route => route.fulfill({ json: proposal(current) }));
  await studio.goto("/graphql/schema");
  await page.getByRole("region", { name: "Contract update", exact: true }).getByRole("button", { name: "Open in Coding", exact: true }).click();
  const coding = page.getByRole("region", { name: "Coding tasks", exact: true });
  await expect(coding.getByRole("heading", { name: "Candidate proof needs renewal" })).toBeVisible();
  await expect(coding.getByText("Historical candidate evidence", { exact: true })).toBeVisible();
  await expect(coding.getByText("Candidate ready for review", { exact: true })).toHaveCount(0);
  await expect(coding.getByRole("button", { name: "Approve and apply", exact: true })).toBeDisabled();
  await expect(coding.getByRole("button", { name: "Refresh candidate from saved source", exact: true })).toBeEnabled();
  expect(studio.requests.filter(request => request.path.endsWith("/approve") || request.path.endsWith("/accept"))).toHaveLength(0);
  await assertAccessible(page);
});

test("known document failures resume authored-operation repair only on explicit request", async ({ page, studio }) => {
  const before = contractTaskFixture("codegen");
  let current: CodingTask = { ...before, status: "failed", lastSeq: 0, canResumeValidation: true, contract: { ...before.contract!, stage: "client", status: "working", repairStage: "client", gateReason: "Authored operations failed Codegen. Resume to repair them, then rerun the generated-document checks.", checkpoints: before.contract!.checkpoints.map(checkpoint => ({ ...checkpoint, stage: "codegen", status: "failed", checks: checkpoint.checks.map(check => ({ ...check, status: "failed" })) })) } };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [current] } }));
  studio.reply("GET", `/api/agent-tasks/${current.id}/events`, route => route.fulfill({ json: { task: current, events: [] } }));
  studio.reply("GET", `/api/agent-tasks/${current.id}/proposal`, route => route.fulfill({ json: { ...proposal(current), validation: current.contract!.checkpoints[0]!.checks } }));
  studio.reply("POST", `/api/agent-tasks/${current.id}/resume`, route => { current = { ...current, status: "running" }; return route.fulfill({ json: current }); });
  await studio.goto("/graphql/schema");
  await page.getByRole("region", { name: "Contract update", exact: true }).getByRole("button", { name: "Open in Coding", exact: true }).click();
  const coding = page.getByRole("region", { name: "Coding tasks", exact: true });
  await expect(coding).toContainText("Historical candidate evidence");
  await expect(coding).toContainText("Authored operations failed Codegen.");
  await expect(coding.getByRole("button", { name: "Approve and apply", exact: true })).toHaveCount(0);
  const repair = coding.getByRole("button", { name: "Repair authored operations", exact: true });
  await expect(repair).toBeEnabled();
  expect(studio.requests.filter(request => request.path.endsWith("/resume"))).toHaveLength(0);
  await repair.focus(); await page.keyboard.press("Enter");
  await expect(coding.getByRole("region", { name: "Live task activity" })).toBeVisible();
  await coding.getByText("Task details", { exact: true }).click();
  await expect(coding.getByRole("list", { name: "Candidate checkpoints", exact: true })).toContainText("Previous check · failed");
  expect(studio.requests.filter(request => request.path.endsWith("/resume"))).toHaveLength(1);
  expect(studio.requests.filter(request => request.path.endsWith("/approve") || request.path.endsWith("/accept") || request.path.endsWith("/continue"))).toHaveLength(0);
  await assertAccessible(page);
});

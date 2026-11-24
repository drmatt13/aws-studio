import type { GraphQLChain, ReviewPlan, ReviewRequest } from "aws-studio/contract-chain/graphql-chain";
import { contractTaskFixture } from "../support/contract-propagation";
import { graphqlChainFixture, withChainLink } from "../support/graphql-chain";
import { test, expect, assertAccessible } from "./support/test";

for (const width of [1440, 390]) {
  test(`proof lineage stays progressive, readable and keyboard accessible at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 1000 });
    const chain = graphqlChainFixture();
    studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: chain }));
    await studio.goto("/graphql/schema");
    const summary = page.getByText("Proof lineage", { exact: true });
    const api = page.getByRole("region", { name: "Repository and API proof", exact: true });
    await expect(api).toHaveCount(0);
    await summary.focus(); await summary.press("Enter");
    await expect(api).toBeVisible();
    await expect(api.getByText("Verified by current checks", { exact: true })).toBeVisible();
    await expect(api.getByText(/Current receipt binding matches/)).toBeVisible();
    await api.getByText(/^Inspect receipt/).click();
    await expect(api.getByText("Saved source · schema 1", { exact: true })).toBeVisible();
    await expect(api.getByText("Preserve the approved public API and ownership rules.", { exact: true })).toBeVisible();
    const comparison = page.getByRole("region", { name: "Local and CI evidence comparison", exact: true });
    await expect(comparison.getByText("No CI observation loaded", { exact: true })).toBeVisible();
    await expect(comparison).toContainText("not authenticated by its content identity");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertAccessible(page);
    await summary.focus(); await summary.press("Enter");
    await expect(api).toHaveCount(0); await expect(summary).toBeFocused();
  });
}

test("retained applied tasks withdraw saved-source confidence during a pending recheck", async ({ page, studio }) => {
  const before = contractTaskFixture("client"), task = { ...before, status: "completed" as const, sourceOutcome: "applied" as const, contract: { ...before.contract!, status: "applied-awaiting-check" as const } };
  let release!: () => void, hold = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [task] } }));
  studio.reply("GET", "/api/graphql/chain", async route => { if (hold) await waiting; await route.fulfill({ json: graphqlChainFixture() }); });
  await studio.goto("/graphql/schema");
  await expect(page.getByRole("heading", { name: "Contract chain verified", exact: true })).toBeVisible();
  hold = true;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("region", { name: "Contract update", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Contract chain verified", exact: true })).toHaveCount(0);
  await expect(page.getByText("Current source needs checking", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  expect(studio.requests.filter(request => request.path.endsWith("/accept"))).toHaveLength(0);
  release();
  await expect(page.getByRole("heading", { name: "Contract chain verified", exact: true })).toBeVisible();
});

test("recorded CI claims and stale predecessor evidence never become current proof", async ({ page, studio }) => {
  const previous = graphqlChainFixture();
  const impacted = withChainLink(previous, { ...previous.links[0]!, confidence: { status: "stale", blockedBy: [], diagnostics: [{ code: "API_IMPLEMENTATION_CHANGED", message: "Repository implementation changed while SDL stayed identical." }] }, actions: [] });
  const chain: GraphQLChain = { ...impacted,
    proof: { ...impacted.proof, ci: { status: "different", message: "The imported report describes an older API predecessor." }, stages: impacted.proof.stages.map(stage => stage.stage === "codegen" ? { ...stage, status: "blocked", current: null, action: "Renew the API predecessor before trusting generated proof.", predecessors: [{ stage: "api", current: "8".repeat(64), recorded: stage.recorded!.predecessors.api!, matches: false }] } : stage) } };
  let deepChecks = 0;
  studio.reply("GET", "/api/graphql/chain", (route, url) => { if (url.searchParams.has("check")) deepChecks++; return route.fulfill({ json: chain }); });
  await studio.goto("/graphql/explorer");
  await expect(page.getByRole("button", { name: "Codegen: Waiting for upstream", exact: true })).toBeVisible();
  await page.getByText("Proof lineage", { exact: true }).click();
  const codegen = page.getByRole("region", { name: "Generated GraphQL proof", exact: true });
  await expect(codegen.getByText("Waiting for predecessor proof", { exact: true })).toBeVisible();
  await expect(codegen.getByText(/Previous binding changed/)).toBeVisible();
  await expect(codegen.getByText(/^Recorded historical receipt/)).toBeVisible();
  await expect(page.getByText("Recorded CI evidence differs", { exact: true })).toBeVisible();
  expect(studio.requests.filter(request => request.path.endsWith("/accept"))).toHaveLength(0);
  expect(deepChecks).toBe(0);
  await assertAccessible(page);
});

test("API review gathers deliberate decisions before the concrete record and final acceptance", async ({ page, studio }) => {
  let chain = withChainLink(graphqlChainFixture(), { ...graphqlChainFixture().links[0]!, confidence: { status: "stale", blockedBy: [], diagnostics: [] }, actions: [{ kind: "acknowledge", scope: { kind: "api" } }] });
  let prepared: ReviewRequest | undefined;
  const plan: ReviewPlan = { reviewId: "reviewed-proof", expectedRevision: chain.revision, expiresAt: "2099-01-01T00:00:00Z", file: "graphql-chain.review.json", before: '{"version":2}', after: '{"version":3,"proofs":{}}', effects: ["Records the deliberately reviewed API decision and current independent proof."] };
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: chain }));
  studio.reply("POST", "/api/graphql/chain/review", route => { prepared = route.request().postDataJSON() as ReviewRequest; return route.fulfill({ json: plan }); });
  studio.reply("POST", "/api/graphql/chain/accept", route => { const current = graphqlChainFixture(); chain = withChainLink(current, { ...current.links[2]!, confidence: { status: "stale", blockedBy: [], diagnostics: [{ code: "PREDECESSOR_REVIEW_CHANGED", message: "Renew client proof against the newly accepted API decision." }] }, actions: [] }); return route.fulfill({ json: { status: "recorded", revision: "renewed", message: "API decision and proof recorded." } }); });
  await studio.goto("/graphql/schema");
  await page.getByRole("button", { name: "Record repository and API review", exact: true }).click();
  const decisions = page.getByRole("dialog", { name: "Review contract decisions", exact: true });
  await expect(decisions.getByRole("button", { name: "Review evidence", exact: true })).toBeDisabled();
  await expect(decisions.getByRole("textbox", { name: "Accepted API behavior", exact: true })).toHaveValue("");
  expect(prepared).toBeUndefined();
  await decisions.getByRole("textbox", { name: "Accepted API behavior", exact: true }).fill("Keep the private field withheld; preserve owner-scoped writes and validation.");
  await decisions.getByRole("textbox", { name: "Source or user evidence", exact: true }).fill("Developer reviewed Project repository, executable schema tests and source intent.");
  await decisions.getByRole("button", { name: "Review evidence", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review contract chain record", exact: true });
  await expect(review).toBeVisible();
  expect(prepared?.decisions?.api?.statement).toContain("private field withheld");
  expect(studio.requests.filter(request => request.path.endsWith("/accept"))).toHaveLength(0);
  await review.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(page.getByText("API decision and proof recorded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Client review: Needs review", exact: true })).toBeVisible();
  expect(studio.requests.filter(request => request.path.endsWith("/review"))).toHaveLength(1);
  expect(studio.requests.filter(request => request.path.endsWith("/accept"))).toHaveLength(1);
});

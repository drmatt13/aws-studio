import type { GraphQLChain } from "aws-studio/contract-chain/graphql-chain";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { graphqlChainFixture, chainLinkFixture, withChainLink, type ChainLinkFixture } from "../support/graphql-chain";
import { test, expect, assertAccessible } from "./support/test";

const changed: ChainLinkFixture = {
  id: "prisma-pothos", kind: "reviewed",
  state: { status: "changed", diffs: [{ surface: "prisma", subject: "Project", path: "Project.dueDate", change: "added", before: null, after: "TimestamptzString(6)?" }] },
  models: { Project: { status: "changed", diffs: [{ surface: "prisma", subject: "Project", path: "Project.dueDate", change: "added", before: null, after: "TimestamptzString(6)?" }] }, User: { status: "reviewed", current: "user", reviewedAgainst: "user" } },
  actions: [{ kind: "agent", link: "prisma-pothos" }],
};
function withLink(link: ChainLinkFixture): GraphQLChain { return withChainLink(graphqlChainFixture(), link); }

for (const width of [1440, 390, 320]) test(`contract chain scrolls with content and stays keyboard operable at ${width}px`, async ({ page, studio }, info) => {
  await page.setViewportSize({ width, height: 600 });
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: withLink(changed) }));
  await studio.goto("/graphql");
  await expect(page.getByRole("heading", { name: "GraphQL", exact: true, level: 1 })).toHaveCount(1);
  const layers = page.getByRole("region", { name: "Contract chain layers", exact: true });
  await expect(layers.getByText("Database contract", { exact: true })).toBeVisible();
  await expect(page.getByRole("rowheader", { name: "Project.dueDate", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "TimestamptzString(6)?", exact: true })).toBeVisible();
  const current = layers.getByRole("button", { name: "Codegen: Waiting for upstream", exact: true });
  await current.focus(); await expect(current).toBeInViewport(); await page.keyboard.press("Enter");
  // A chain link opens its section; pressing it again there shows or hides its detail.
  await expect(page).toHaveURL(/\/graphql\/explorer$/);
  await expect(current).toBeFocused();
  await expect(page.getByText("Generated files match the current schema and documents; upstream confidence is reported separately.", { exact: true })).toBeVisible();
  await expect(current).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter"); await expect(current).toHaveAttribute("aria-expanded", "false");
  const review = layers.getByRole("button", { name: "Pothos review: Project changed", exact: true });
  await review.focus(); await expect(review).toBeInViewport(); await page.keyboard.press("Space");
  await expect(page).toHaveURL(/\/graphql\/schema$/);
  await expect(page.getByRole("heading", { name: "Changed since Pothos was last reviewed", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-ui="graphql-scroll"]').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(layers).not.toBeInViewport();
  await expect(page.getByRole("navigation", { name: "GraphQL sections", exact: true })).toBeInViewport();
  expect(studio.requests.filter(request => request.method !== "GET").every(request => request.path === "/api/aws-connections/check")).toBe(true);
  await assertAccessible(page);
  const evidence = path.resolve(__dirname, "../../../output/playwright/graphql-contract-chain/browser", info.project.name, `chain-${width}.png`);
  await mkdir(path.dirname(evidence), { recursive: true });
  await page.screenshot({ path: evidence });
  await info.attach(`graphql-chain-${width}`, { path: evidence, contentType: "image/png" });
});

test("chain loading, read failure and explicit retry keep independent source controls", async ({ page, studio }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; }); let fail = true;
  studio.reply("GET", "/api/graphql/chain", async route => {
    await pending;
    await route.fulfill(fail ? { status: 503, json: { error: "Fixture chain source read failed" } } : { json: graphqlChainFixture() });
  });
  await page.goto("/graphql");
  await expect(page.getByText("Checking contract chain…", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Contract chain layers", exact: true })).toBeVisible();
  release();
  const failure = page.getByRole("alert").filter({ hasText: "Fixture chain source read failed" });
  await expect(failure).toBeVisible();
  await expect(page.getByRole("button", { name: /Approved/ })).toHaveCount(0);
  fail = false; await failure.getByRole("button", { name: "Try again", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Pothos review", exact: true })).toBeVisible();
  expect(studio.requests.some(request => request.path === "/api/graphql/chain?check=fresh")).toBe(true);
});

test("saved hashes keep loading and recorded approvals survive a fresh page", async ({ page, studio }) => {
  const chain = graphqlChainFixture();
  let phase: "reading" | "unrecorded" | "approved" = "reading";
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: {
    ...chain,
    fingerprints: phase === "reading" ? "checking" : "ready",
    inspection: { status: "stale" },
    nodes: chain.nodes.map((node, index) => {
      const upstream = chain.nodes[index - 1]?.fingerprint;
      return {
        ...node,
        fingerprint: phase === "reading" ? { status: "unavailable", diagnostics: [] } : node.fingerprint,
        reviewedAgainst: phase === "approved" && upstream?.status === "available" ? upstream.value : null,
        recordedOutput: phase === "approved" && index > 0 && node.fingerprint.status === "available" ? node.fingerprint.value : null,
        approvalRecorded: phase === "approved" && index > 0,
      };
    }),
  } }));
  await studio.goto("/graphql/schema");
  await expect(page.getByText("Reading saved contract hashes…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Checking…" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: /Reading hashes/ })).toHaveCount(3);
  phase = "unrecorded";
  await expect(page.getByRole("button", { name: "Pothos review: Not recorded", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /: Waiting for upstream$/ })).toHaveCount(2);
  phase = "approved";
  await expect(page.getByRole("button", { name: /: Approved$/ })).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole("button", { name: /: Approved$/ })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Draft full contract task", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Draft Pothos task", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Codegen: Approved", exact: true }).click();
  await expect(page.getByRole("button", { name: "Regenerate GraphQL", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Client review: Approved", exact: true }).click();
  await expect(page.getByRole("button", { name: "Draft client task", exact: true })).toBeDisabled();
});

test("the rail stays in sync to the left of a changed handoff and waits to its right", async ({ page, studio }) => {
  const chain = graphqlChainFixture();
  const saved = ["a", "b", "c", "d"].map(letter => letter.repeat(64));
  const pothosOutput = "e".repeat(64);
  let regenerated = false;
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: {
    ...chain, inspection: { status: "stale" }, fingerprints: "ready",
    nodes: chain.nodes.map((node, index) => ({ ...node, approvalRecorded: false,
      fingerprint: { status: "available", value: index === 1 ? pothosOutput : saved[index] },
      reviewedAgainst: index === 2 && regenerated ? pothosOutput : saved[index - 1] ?? null,
      recordedOutput: index ? saved[index] : null,
    })),
  } }));
  await studio.goto("/graphql/schema");
  const rail = page.getByRole("region", { name: "Contract chain layers" });
  await expect(rail.getByRole("button", { name: "Pothos review: In sync", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Codegen: Regeneration needed", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Client review: Waiting for upstream", exact: true })).toBeVisible();
  await rail.getByRole("button", { name: "Client review: Waiting for upstream", exact: true }).press("Enter");
  await expect(page).toHaveURL(/\/graphql\/client$/);
  await expect(page.getByText("An earlier handoff needs attention before this stage can be in sync.", { exact: true })).toBeVisible();
  regenerated = true;
  await expect(rail.getByRole("button", { name: "Client review: In sync", exact: true })).toBeVisible();
  expect(studio.requests.some(request => request.path.startsWith("/api/graphql/chain?check="))).toBe(false);
});

test("generated drift and invalid client documents keep their own diagnoses", async ({ page, studio }) => {
  const chain = graphqlChainFixture();
  const links: readonly ChainLinkFixture[] = [chain.links[0]!,
    { id: "pothos-generated", kind: "derived", state: { status: "out-of-date", reasons: ["documents-changed"], files: ["client-app/src/api/generated/gql.ts"] }, checks: { schema: { status: "passed" }, documents: { status: "failed", diagnostics: [] }, "generated-files": { status: "failed", diagnostics: [] } }, actions: [{ kind: "command", command: "npm run codegen" }] },
    { id: "generated-client", kind: "derived-then-reviewed", state: { status: "invalid", problems: [{ document: "ProjectSummary", file: "client-app/src/api/projects/operations.ts", line: 7, message: 'Cannot query field "name" on type "Project".' }] }, validation: { status: "failed", diagnostics: [] }, actions: [] },
  ];
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: { ...chain, links: links.map(chainLinkFixture) } }));
  await studio.goto("/graphql");
  await page.getByRole("button", { name: "Client review: Verification failed", exact: true }).click();
  await expect(page.getByRole("list", { name: "Invalid client documents", exact: true }).getByText("ProjectSummary", { exact: true })).toBeVisible();
  await expect(page.getByText('Cannot query field "name" on type "Project".', { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Codegen: Regeneration needed", exact: true }).click();
  await expect(page.getByText("Documents changed.", { exact: true })).toBeVisible();
  await expect(page.getByText("npm run codegen", { exact: true })).toBeVisible();
  expect(studio.requests.some(request => request.path.startsWith("/api/commands"))).toBe(false);
});

test("no review and unavailable restricted evaluation are explicit", async ({ page, studio }) => {
  const chain = graphqlChainFixture(), diagnostics = [{ code: "sandbox-unavailable", message: "Restricted schema evaluation is unavailable. Install a compatible Codex sandbox and check again." }];
  const unavailable = withChainLink(withChainLink(chain, { id: "prisma-pothos", kind: "reviewed", state: { status: "no-review" }, models: { Project: { status: "no-review" } }, actions: [] }),
    { id: "pothos-generated", kind: "derived", state: { status: "unknown", diagnostics }, checks: { schema: { status: "unavailable", diagnostics }, documents: { status: "passed" }, "generated-files": { status: "unavailable", diagnostics } }, actions: [] });
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: { ...unavailable, record: "missing" } }));
  await studio.goto("/graphql");
  await expect(page.getByText("Record the current source as the reviewed baseline after checking Pothos exposure.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Codegen: Unavailable", exact: true }).click();
  await expect(page.getByText(diagnostics[0].message, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approved/ })).toHaveCount(0);
});

for (const width of [1440, 390]) test(`acknowledgement reviews before applying and preserves keyboard focus at ${width}px`, async ({ page, studio }, info) => {
  await page.setViewportSize({ width, height: 900 });
  let current = withLink({ ...changed, actions: [{ kind: "acknowledge", scope: { kind: "model", model: "Project" } }] });
  const review = { reviewId: "fixture-review", expectedRevision: current.revision, expiresAt: "2099-01-01T00:00:00Z", file: "graphql-chain.review.json", before: null, after: '{\n  "version": 1\n}\n', effects: ["Updates only graphql-chain.review.json; application source is unchanged."] };
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: current }));
  studio.reply("POST", "/api/graphql/chain/review", route => route.fulfill({ json: review }));
  studio.reply("POST", "/api/graphql/chain/accept", route => { current = graphqlChainFixture(); return route.fulfill({ json: { status: "recorded", revision: "recorded", message: "Project review recorded." } }); });
  await studio.goto("/graphql");
  const trigger = page.getByRole("button", { name: "Mark Project reviewed, no API change", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Review contract chain record", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Changes to graphql-chain.review.json", exact: true })).toBeVisible();
  const evidence = path.resolve(__dirname, "../../../output/playwright/graphql-contract-chain/browser", info.project.name, `review-${width}.png`);
  await mkdir(path.dirname(evidence), { recursive: true }); await page.screenshot({ path: evidence });
  expect(studio.requests.filter(request => request.path.endsWith("/accept"))).toHaveLength(0);
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Record review", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0); await expect(page.getByText("Project review recorded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again", exact: true })).toBeFocused();
  const accepts = studio.requests.filter(request => request.path.endsWith("/accept"));
  expect(accepts).toHaveLength(1); expect(accepts[0]?.body).toEqual({ reviewId: review.reviewId, expectedRevision: review.expectedRevision });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a stale acknowledgement keeps the reviewed diff and failure visible", async ({ page, studio }) => {
  const current = withLink({ ...changed, actions: [{ kind: "acknowledge", scope: { kind: "model", model: "Project" } }] });
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: current }));
  studio.reply("POST", "/api/graphql/chain/review", route => route.fulfill({ json: { reviewId: "review", expectedRevision: current.revision, expiresAt: "2099-01-01T00:00:00Z", file: "graphql-chain.review.json", before: "{}\n", after: '{"version":1}\n', effects: ["Updates only graphql-chain.review.json."] } }));
  studio.reply("POST", "/api/graphql/chain/accept", route => route.fulfill({ status: 409, json: { error: "Source changed. Check again before recording this review." } }));
  await studio.goto("/graphql"); await page.getByRole("button", { name: "Mark Project reviewed, no API change", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review contract chain record", exact: true });
  await dialog.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Source changed. Check again before recording this review.");
  await expect(dialog.getByRole("alert")).toBeFocused();
  await expect(dialog.getByRole("region", { name: "Changes to graphql-chain.review.json", exact: true })).toBeVisible();
  await expect(page.getByText("Project review recorded.", { exact: true })).toHaveCount(0);
});

test("unavailable task history keeps its retry in the chain header without moving the chain", async ({ page, studio }) => {
  // A list that never loaded returns to pending on every refetch; the failure must not blink away meanwhile.
  const failure = "The loaded contract checker policy or installed control dependencies changed.";
  const held: ((outcome: "fail" | "succeed") => void)[] = [];
  let reads = 0;
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: withLink(changed) }));
  studio.reply("GET", "/api/agent-tasks", route => {
    const respond = (outcome: "fail" | "succeed") => (outcome === "fail" ? route.fulfill({ status: 500, json: { error: failure } }) : route.fulfill({ json: { tasks: [] } })).catch(() => undefined); // A superseded read may already be aborted.
    return ++reads === 1 ? respond("fail") : new Promise<void>(resolve => { held.push(outcome => { void respond(outcome).then(resolve); }); });
  });
  const release = async (outcome: "fail" | "succeed") => {
    const settled = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-tasks");
    for (const respond of held.splice(0)) respond(outcome);
    await settled;
  };
  await studio.goto("/graphql");
  const band = page.locator('[data-ui="graphql-chain"]'), actions = band.locator('[data-ui="workbench-actions"]');
  const plate = band.getByRole("region", { name: "Contract chain layers", exact: true });
  const retry = actions.getByRole("button", { name: "Retry task history", exact: true });
  await expect(retry).toBeVisible();
  await expect(actions.getByRole("button", { name: "Check again", exact: true })).toBeVisible();
  // The failure is not narrated on the page: nothing is inserted above the plate to push the chain down.
  await expect(page.getByText(failure)).toHaveCount(0);
  await expect(page.getByText("Couldn’t restore contract task history.")).toHaveCount(0);
  const before = await plate.boundingBox();
  await retry.click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await expect(retry).toBeEnabled();
  expect(await plate.boundingBox()).toEqual(before);
  await release("fail");
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await release("succeed");
  await expect(retry).toHaveCount(0);
  expect(await plate.boundingBox()).toEqual(before);
});

test("contract chain statuses retain words and shapes in forced colors", async ({ page, studio }) => {
  await page.emulateMedia({ forcedColors: "active" });
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: withLink(changed) }));
  await studio.goto("/graphql");
  const changedLink = page.getByRole("button", { name: "Pothos review: Project changed", exact: true }), currentLink = page.getByRole("button", { name: "Codegen: Waiting for upstream", exact: true });
  await expect(changedLink.locator('[data-status-shape="attention"]')).toBeVisible();
  await expect(currentLink.locator('[data-status-shape="pending"]')).toBeVisible();
  for (const link of [changedLink, currentLink]) await expect(link.locator("[data-status-shape]")).not.toHaveCSS("color", await link.evaluate(element => getComputedStyle(element).backgroundColor));
  await assertAccessible(page);
});

test("restored evidence is historical while current confidence and review actions stay unavailable", async ({ page, studio }) => {
  const previous = graphqlChainFixture(), diagnostics = [{ code: "INSPECTION_STALE", message: "Saved source changed. Check again before renewing confidence." }];
  const chain: GraphQLChain = { ...previous, inspection: { status: "stale", message: diagnostics[0]!.message },
    history: { revision: previous.revision, checkedAt: "2026-11-11T12:00:00.000Z", nodes: previous.nodes, links: previous.links.map(link => ({ ...link, actions: [] })) },
    links: previous.links.map(link => ({ ...link, confidence: { status: "stale", diagnostics, blockedBy: [] }, actions: [] })),
  };
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: chain }));
  await studio.goto("/graphql");
  await expect(page.getByRole("button", { name: /Approved/ })).toHaveCount(0);
  await page.getByText("Previous check · 11/11/2026, 12:00:00 PM", { exact: true }).click();
  await expect(page.getByRole("list", { name: "Previous local evidence", exact: true })).toContainText("Codegen: Current");
  await expect(page.getByRole("list", { name: "Previous fingerprints", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Record.*review|Mark.*reviewed/ })).toHaveCount(0);
  expect(studio.requests.filter(request => request.method === "POST" && request.path.startsWith("/api/graphql/chain"))).toHaveLength(0);
  await assertAccessible(page);
});

for (const version of [1, 2]) test(`a version ${version} server's independent green response is refused with a restart instruction`, async ({ page, studio }) => {
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: { ...graphqlChainFixture(), version } }));
  await studio.goto("/graphql");
  await expect(page.getByRole("alert")).toContainText("Restart npm run studio");
  await expect(page.getByRole("button", { name: /Approved/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Schema", exact: true, level: 2 })).toBeVisible();
  expect(studio.requests.filter(request => request.method === "POST" && request.path.startsWith("/api/graphql/chain"))).toHaveLength(0);
});

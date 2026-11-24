import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CodingTask, CodingTaskRequest } from "../../shared/agent-runtime";
import { contractTaskFixture } from "../support/contract-propagation";
import { graphqlChainFixture } from "../support/graphql-chain";
import { test, expect, assertAccessible, type StudioFixture } from "./support/test";

function codingHost(studio: StudioFixture) {
  const submitted: CodingTaskRequest[] = [];
  let current: CodingTask | undefined;
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: current ? [current] : [] } }));
  studio.reply("GET", "/api/agent-tasks/recovery", route => route.fulfill({ json: { coordination: { status: "ready", epoch: "fixture" }, recoveries: [] } }));
  studio.reply("GET", "/api/agent-lab/status", route => route.fulfill({ json: { providers: [{ id: "codex", label: "Codex", available: true, detail: "Installed fixture" }], busy: false } }));
  studio.reply("GET", "/api/agent-lab/models", route => route.fulfill({ json: { provider: "codex", source: "cli", models: [] } }));
  studio.reply("GET", "/api/agent-tasks/draft-task/events", route => route.fulfill({ json: { task: current, events: [] } }));
  studio.reply("POST", "/api/agent-tasks", route => {
    const request = route.request().postDataJSON() as CodingTaskRequest;
    submitted.push(request);
    current = {
      id: "draft-task", provider: request.provider, prompt: request.prompt, status: "queued",
      createdAt: "2026-11-12T12:00:00Z", updatedAt: "2026-11-12T12:00:00Z",
      lastSeq: 0, cancelRequested: false, sourceOutcome: "unchanged",
    };
    return route.fulfill({ json: current });
  });
  return submitted;
}

function contractWrites(studio: StudioFixture) {
  return studio.requests.filter(request => request.method === "POST" && /^\/api\/(?:agent-tasks|graphql\/chain)/.test(request.path));
}

function reviewNeeded(studio: StudioFixture, section: "schema" | "client" = "schema") {
  const chain = graphqlChainFixture();
  const unreviewed = section === "schema" ? "pothos" : "client";
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: {
    ...chain, inspection: { status: "stale" }, fingerprints: "ready",
    nodes: chain.nodes.map((node, index) => {
      const upstream = chain.nodes[index - 1]?.fingerprint;
      return { ...node,
        reviewedAgainst: node.id !== unreviewed && upstream?.status === "available" ? upstream.value : null,
        recordedOutput: index > 0 && node.fingerprint.status === "available" ? node.fingerprint.value : null,
      };
    }),
  } }));
}

test("Codegen regenerates locally and refreshes the handoff without opening Coding", async ({ page, studio }) => {
  const chain = graphqlChainFixture();
  const hashes = ["a", "b", "c", "d"].map(letter => letter.repeat(64));
  let regenerated = false, rejected = true, calls = 0;
  studio.reply("GET", "/api/graphql/chain", route => route.fulfill({ json: {
    ...chain, inspection: { status: "stale" }, fingerprints: "ready",
    nodes: chain.nodes.map((node, index) => ({ ...node, fingerprint: { status: "available", value: hashes[index] },
      reviewedAgainst: index === 2 && !regenerated ? "f".repeat(64) : hashes[index - 1] ?? null,
      recordedOutput: index ? hashes[index] : null,
    })),
  } }));
  const commandPath = "/api/commands/graphql%3Aregenerate";
  let release!: () => void;
  const running = new Promise<void>(resolve => { release = resolve; });
  studio.reply("POST", commandPath, async route => {
    calls++;
    expect(route.request().postDataJSON()).toMatchObject({ confirmed: true });
    if (rejected) return route.fulfill({ json: { command: "graphql:regenerate", exitCode: 1, output: 'Cannot query field "removed".', durationMs: 1 } });
    await running;
    regenerated = true;
    return route.fulfill({ json: { command: "graphql:regenerate", exitCode: 0, output: "Generated", durationMs: 2 } });
  });
  await studio.goto("/graphql/schema");
  const fullDraft = page.getByRole("button", { name: "Draft full contract task", exact: true });
  await expect(page.getByRole("button", { name: "Pothos review: In sync", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft Pothos task", exact: true })).toBeDisabled();
  await expect(fullDraft).toBeEnabled();
  await page.getByRole("button", { name: "Codegen: Regeneration needed", exact: true }).click();
  const button = page.getByRole("button", { name: "Regenerate GraphQL", exact: true });
  await expect(button).toBeEnabled();
  await button.press("Enter");
  await expect(page.getByRole("alert")).toContainText('Cannot query field "removed".');
  await expect(page.getByRole("button", { name: "Client review: Waiting for upstream", exact: true })).toBeVisible();
  rejected = false;
  await button.click();
  await expect(page.getByRole("button", { name: "Regenerating GraphQL…", exact: true })).toBeDisabled();
  release();
  await expect(page.getByText("GraphQL outputs regenerated.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Codegen: In sync", exact: true })).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(fullDraft).toBeDisabled();
  await page.getByRole("button", { name: "Client review: In sync", exact: true }).click();
  await expect(page.getByRole("button", { name: "Draft client task", exact: true })).toBeDisabled();
  expect(calls).toBe(2);
  expect(contractWrites(studio)).toEqual([]);
  await expect(page.getByRole("region", { name: "Coding tasks", exact: true })).toHaveCount(0);
});

test("Opening a running contract selects its task when Coding has not mounted and storage is unavailable", async ({ page, studio }) => {
  codingHost(studio);
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key.startsWith("aws-studio:coding-task:")) throw new Error("Task selection storage unavailable");
      return read.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("aws-studio:coding-task:")) throw new Error("Task selection storage unavailable");
      write.call(this, key, value);
    };
  });
  const contract = { ...contractTaskFixture("api"), status: "running" as const, proposalDigest: undefined };
  const other = { ...contract, id: "other-active-task", prompt: "Work on a separate task.", contract: undefined };
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ json: { tasks: [other, contract] } }));
  for (const task of [contract, other]) {
    studio.reply("GET", `/api/agent-tasks/${task.id}/events`, route => route.fulfill({ json: { task, events: [] } }));
  }
  await studio.goto("/graphql/schema");
  await expect(page.getByRole("button", { name: "Pothos review: Approved", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Draft full contract task", exact: true })).toBeDisabled();
  await page.getByRole("region", { name: "Contract update", exact: true }).getByRole("button", { name: "Open in Coding", exact: true }).click();
  await expect(page.locator("#coding-task-select")).toHaveValue(contract.id);
  await expect(page.getByRole("tab", { name: "Coding", exact: true })).toBeFocused();
  expect(contractWrites(studio)).toEqual([]);
});

for (const width of [1440, 390]) {
  for (const [section, label, subject] of [
    ["schema", "Draft Pothos task", /Pothos GraphQL API/],
    ["client", "Draft client task", /authored client operations/],
  ] as const) test(`${label} opens an editable request with the keyboard at ${width}px`, async ({ page, studio }, info) => {
    await page.setViewportSize({ width, height: 900 });
    codingHost(studio);
    reviewNeeded(studio, section);
    await studio.goto(`/graphql/${section}`);
    await page.getByRole("button", { name: label, exact: true }).press("Enter");
    const composer = page.getByRole("textbox", { name: "Coding request", exact: true });
    await expect(page.getByRole("tab", { name: "Coding", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(subject);
    await expect(page.getByRole("button", { name: "Start coding task", exact: true })).toBeEnabled();
    expect(contractWrites(studio)).toEqual([]);
    expect(studio.requests.some(request => request.path.startsWith("/api/graphql/chain?check="))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await assertAccessible(page);
    const evidence = path.resolve(__dirname, "../../../output/playwright/graphql-contract-actions/browser", info.project.name, `draft-${section}-${width}.png`);
    await mkdir(path.dirname(evidence), { recursive: true });
    await page.screenshot({ path: evidence });
    await info.attach(`draft-${section}-${width}`, { path: evidence, contentType: "image/png" });
  });

  test(`the full contract shortcut submits only the edited ordinary request at ${width}px`, async ({ page, studio }) => {
    await page.setViewportSize({ width, height: 900 });
    const submitted = codingHost(studio);
    reviewNeeded(studio, "client");
    await studio.goto("/graphql/client");
    await page.getByRole("button", { name: "Draft full contract task", exact: true }).press("Space");
    const composer = page.getByRole("textbox", { name: "Coding request", exact: true });
    await expect(composer).toHaveValue(/Prisma through repositories, the Pothos GraphQL API, generated documents and TanStack Query/);
    const edited = "Add a test for the existing GraphQL authorization behavior.";
    await composer.fill(edited);
    expect(contractWrites(studio)).toEqual([]);
    await page.getByRole("button", { name: "Start coding task", exact: true }).press("Enter");
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ provider: "codex", prompt: edited });
    for (const field of ["contract", "contractRun", "validation"]) expect(submitted[0]).not.toHaveProperty(field);
    expect(contractWrites(studio).map(request => request.path)).toEqual(["/api/agent-tasks"]);
  });
}

test("a shortcut offers its prompt without replacing the current draft", async ({ page, studio }) => {
  codingHost(studio);
  reviewNeeded(studio);
  await studio.goto("/graphql/schema");
  await page.getByRole("button", { name: "Draft Pothos task", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Coding request", exact: true });
  await composer.fill("Keep this draft while exploring.");
  await page.getByRole("button", { name: "Agent: collapse panel", exact: true }).click();
  const action = page.getByRole("button", { name: "Draft full contract task", exact: true });
  await action.click();
  await expect(composer).toHaveValue("Keep this draft while exploring.");
  await page.getByRole("button", { name: "Keep current draft", exact: true }).click();
  await expect(composer).toHaveValue("Keep this draft while exploring.");
  await page.getByRole("button", { name: "Agent: collapse panel", exact: true }).click();
  await action.click();
  await page.getByRole("button", { name: "Use suggested prompt", exact: true }).click();
  await expect(composer).toHaveValue(/Prisma through repositories/);
  expect(contractWrites(studio)).toEqual([]);
});

test("stale contract evidence and unavailable task history still allow drafting", async ({ page, studio }) => {
  codingHost(studio);
  studio.reply("GET", "/api/agent-tasks", route => route.fulfill({ status: 503, json: { error: "The coding runner is unavailable." } }));
  reviewNeeded(studio);
  await studio.goto("/graphql/schema");
  await expect(page.getByRole("button", { name: "Retry task history", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Draft Pothos task", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Coding request", exact: true })).toHaveValue(/Pothos GraphQL API/);
  expect(studio.requests.some(request => request.path.startsWith("/api/graphql/chain?check="))).toBe(false);
  expect(contractWrites(studio)).toEqual([]);
});

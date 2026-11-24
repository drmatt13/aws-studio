import type { Page } from "@playwright/test";
import { test, expect, assertAccessible } from "./support/test";
import {
  logEvent,
  logEvidence,
  logPage,
  logRun,
} from "../support/development-logs";
import { buildDevelopmentTrace } from "../../shared/development-traces";
import type { ConversationContext } from "../../shared/agent-context";

const tray = (page: Page) =>
  page.getByRole("region", { name: "Activity", exact: true });
const panel = (page: Page) => tray(page).locator('[data-ui="agent-panel"]');
const question = (page: Page) =>
  panel(page).getByRole("textbox", { name: "Ask the agent", exact: true });
async function open(page: Page) {
  await tray(page)
    .getByRole("tab", { name: /^Agent/ })
    .click();
  await expect(question(page)).toBeVisible();
}
const contextOf = (body: unknown) =>
  JSON.parse((body as { context: string }).context) as ConversationContext;
test.beforeEach(async ({ studio }) => {
  studio.reply("GET", "/api/agent-lab/status", (route) =>
    route.fulfill({
      json: {
        providers: [
          {
            id: "codex",
            label: "Codex",
            available: true,
            detail: "Fixture provider",
          },
        ],
        busy: false,
      },
    }),
  );
  studio.reply("GET", "/api/agent-lab/models", (route) =>
    route.fulfill({ json: { provider: "codex", source: "cli", models: [] } }),
  );
  studio.reply("GET", "/api/development-logs/evidence", (route, url) => {
    const resource = url.searchParams.get("resource") ?? "lambda:fixture-0";
    const value = logEvidence([
      logEvent(1, {
        resource: { id: resource, kind: "lambda" },
        kind: "lambda.invocation.completed",
        outcome: "succeeded",
        details: {
          result: "[sensitive invocation payload omitted]",
          http: { status: 401 },
        },
        durationMs: 1365,
      }),
    ]);
    return route.fulfill({
      json: {
        ...value,
        entries: value.entries.map((entry) => ({
          ...entry,
          outcome: "succeeded",
          httpStatus: 401,
          durationMs: 1365,
        })),
      },
    });
  });
  studio.reply("GET", "/api/development-logs/trace", (route, url) =>
    route.fulfill({
      json: buildDevelopmentTrace({
        ...logPage([
          logEvent(1, {
            resource: { id: url.searchParams.get("resource")!, kind: "lambda" },
            kind: "lambda.invocation.completed",
            outcome: "succeeded",
            details: {
              result: "[sensitive invocation payload omitted]",
              http: { status: 401 },
            },
            durationMs: 1365,
          }),
        ]),
        traceId: url.searchParams.get("traceId")!,
        complete: true,
      }),
    }),
  );
});
for (const width of [1440, 390])
  test(`Conversation uses selected runtime facts and preserves original context on retry at ${width}px`, async ({
    page,
    studio,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let attempts = 0;
    Object.assign(studio.response.snapshot, {
      credentials: "CONVERSATION_PRIVATE_CANARY",
    });
    studio.reply("POST", "/api/agent-lab/chat", (route) => {
      attempts++;
      const context = contextOf(route.request().postDataJSON());
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          json: { error: "Fixture disconnected after capture" },
        });
      return route.fulfill({
        json: {
          answer: `${context.focus?.id}: handler returned normally; observed HTTP ${context.observations.entries[0]?.httpStatus} in ${context.observations.entries[0]?.durationMs} ms.`,
        },
      });
    });
    await studio.goto("/?select=lambda%3Afixture-0");
    await open(page);
    await panel(page)
      .getByRole("button", { name: /^Context:/ })
      .click();
    await expect(
      panel(page).getByRole("checkbox", {
        name: "Include Studio context",
        exact: true,
      }),
    ).toBeChecked();
    await expect
      .poll(() =>
        panel(page).getByLabel("Conversation Studio context").textContent(),
      )
      .toContain('"httpStatus": 401');
    await page.keyboard.press("Escape");
    await expect(
      panel(page).getByRole("button", { name: /^Context:/ }),
    ).toBeFocused();
    await question(page).fill(
      "Did the selected function run and what was the result?",
    );
    await panel(page)
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await expect(panel(page).getByRole("alert")).toContainText(
      "Fixture disconnected",
    );
    const first = studio.requests.find(
      (item) => item.path === "/api/agent-lab/chat",
    )!.body;
    expect(contextOf(first).focus?.id).toBe("lambda:fixture-0");
    expect(JSON.stringify(first)).not.toContain("CONVERSATION_PRIVATE_CANARY");
    if (width < 650)
      await tray(page)
        .getByRole("button", { name: "Agent: collapse panel", exact: true })
        .click();
    await page
      .getByRole("complementary", { name: "Inspector", exact: true })
      .getByRole("button", { name: "Back to Resources", exact: true })
      .click();
    await page.locator('[data-resource-id="lambda:fixture-1"]').click();
    if (width < 650) await open(page);
    await expect(
      panel(page).getByRole("button", { name: /^Context:/ }),
    ).toContainText("Fixture handler 1");
    await panel(page)
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await expect(
      panel(page).getByRole("article", { name: "Codex answer", exact: true }),
    ).toContainText(
      "lambda:fixture-0: handler returned normally; observed HTTP 401 in 1365 ms",
    );
    const posts = studio.requests.filter(
      (item) => item.path === "/api/agent-lab/chat",
    );
    expect(posts[1]!.body).toEqual(first);
    await question(page).fill("What about the resource selected now?");
    await panel(page)
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await expect(
      panel(page)
        .getByRole("article", { name: "Codex answer", exact: true })
        .last(),
    ).toContainText("lambda:fixture-1");
    const latest = contextOf(
      studio.requests
        .filter((item) => item.path === "/api/agent-lab/chat")
        .at(-1)!.body,
    );
    expect(latest.focus?.id).toBe("lambda:fixture-1");
    expect(JSON.stringify(latest).length).toBeLessThanOrEqual(6000);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await assertAccessible(page);
  });
test("Conversation acknowledges unavailable evidence, supports opt-out, and excludes development context in Production", async ({
  page,
  studio,
}) => {
  studio.reply("GET", "/api/development-logs/evidence", (route) =>
    route.fulfill({
      json: {
        ...logEvidence([]),
        run: undefined,
        collection: "not-configured",
      },
    }),
  );
  studio.reply("POST", "/api/agent-lab/chat", (route) => {
    const body = route.request().postDataJSON() as { context?: string };
    const evidence = body.context
      ? (JSON.parse(body.context) as ConversationContext)
      : undefined;
    return route.fulfill({
      json: {
        answer: evidence?.observations.entries.length
          ? "Observed evidence supplied."
          : "No observed invocation evidence was supplied; this does not prove it never ran.",
      },
    });
  });
  await studio.goto("/?select=lambda%3Afixture-0");
  await open(page);
  await question(page).fill("Did it run?");
  await panel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    panel(page).getByRole("article", { name: "Codex answer", exact: true }),
  ).toContainText("No observed invocation evidence");
  await question(page).fill("Explain the framework generally.");
  await panel(page)
    .getByRole("button", { name: /^Context:/ })
    .click();
  await panel(page)
    .getByRole("checkbox", { name: "Include Studio context", exact: true })
    .uncheck();
  await page
    .getByRole("dialog", { name: "Studio context", exact: true })
    .getByRole("button", { name: "Close Studio context", exact: true })
    .click();
  await expect(question(page)).toHaveValue("Explain the framework generally.");
  await panel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      () =>
        studio.requests.filter((item) => item.path === "/api/agent-lab/chat")
          .length,
    )
    .toBe(2);
  expect(
    studio.requests
      .filter((item) => item.path === "/api/agent-lab/chat")
      .at(-1)!.body,
  ).not.toHaveProperty("context");
  await panel(page)
    .getByRole("button", { name: /^Context:/ })
    .click();
  await panel(page)
    .getByRole("checkbox", { name: "Include Studio context", exact: true })
    .check();
  await page
    .getByRole("dialog", { name: "Studio context", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Source environment", exact: true })
    .getByRole("button", { name: "Production", exact: true })
    .click();
  await question(page).fill("What production execution did you observe?");
  await panel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      () =>
        studio.requests.filter((item) => item.path === "/api/agent-lab/chat")
          .length,
    )
    .toBe(3);
  const context = contextOf(
    studio.requests
      .filter((item) => item.path === "/api/agent-lab/chat")
      .at(-1)!.body,
  );
  expect(context.source.mode).toBe("prod");
  expect(context.observations.entries).toEqual([]);
  expect(context.trace).toBeUndefined();
  expect(context.observations.runId).toBeUndefined();
  const reads = studio.requests.filter((item) =>
    item.path.startsWith("/api/development-logs/"),
  ).length;
  await page.waitForTimeout(2200);
  expect(
    studio.requests.filter((item) =>
      item.path.startsWith("/api/development-logs/"),
    ).length,
  ).toBe(reads);
});

test("Conversation sends each execution's own digest and reads the newest execution's trace", async ({
  page,
  studio,
}) => {
  const digest = (name: string, sequence: number, fields: object) => ({
    sequence,
    resourceId: "lambda:fixture-0",
    invocationId: `invocation-${name}`,
    traceId: `trace-${name}`,
    startObserved: true,
    endedAt: logRun.startedAt,
    records: 2,
    errorLevel: 0,
    ...fields,
  });
  studio.reply("GET", "/api/development-logs/evidence", (route) =>
    route.fulfill({
      json: {
        ...logEvidence([]),
        executions: [
          digest("ok", 9, {
            outcome: "returned",
            httpStatus: 200,
            httpStatusSource: "handler-result",
            durationMs: 25,
          }),
          digest("failed", 3, {
            outcome: "failed",
            startObserved: false,
            error: "TypeError: boom at getOrder (/var/task/src/orders.ts:42:17)",
            errorLevel: 1,
          }),
        ],
        window: { records: 26, olderUnread: true, olderErrorsUnread: false },
        excluded: { executions: 8, failed: 0, records: 22, errorLevel: 5 },
      },
    }),
  );
  studio.reply("POST", "/api/agent-lab/chat", (route) =>
    route.fulfill({ json: { answer: "Captured." } }),
  );
  await studio.goto("/?select=lambda%3Afixture-0");
  await open(page);
  const traced = (name: string) =>
    studio.requests.some(
      (item) =>
        item.path.includes("/api/development-logs/trace") &&
        item.path.includes(`traceId=trace-${name}`),
    );
  await expect.poll(() => traced("ok")).toBe(true);
  await question(page).fill("What failed?");
  await panel(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    panel(page).getByRole("article", { name: "Codex answer", exact: true }),
  ).toContainText("Captured.");
  const context = contextOf(
    studio.requests.find((item) => item.path === "/api/agent-lab/chat")!.body,
  );
  expect(
    context.observations.executions?.map((execution) => [
      execution.invocationId,
      execution.outcome,
      execution.httpStatus,
      execution.startObserved,
    ]),
  ).toEqual([
    ["invocation-ok", "returned", 200, true],
    ["invocation-failed", "failed", undefined, false],
  ]);
  expect(context.observations.executions?.[1]?.error).toContain(
    "getOrder (/var/task/src/orders.ts:42:17)",
  );
  expect(context.observations.excluded).toEqual({
    executions: 8,
    failed: 0,
    records: 22,
    errorLevel: 5,
  });
  expect(context.observations.window?.olderUnread).toBe(true);
  // Only the newest execution's trace is read; the failure stays a digest of its own.
  expect(traced("failed")).toBe(false);
});

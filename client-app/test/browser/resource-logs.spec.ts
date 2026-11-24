import type { Page } from "@playwright/test";
import type { DevelopmentLogPage } from "../../shared/development-logs";
import {
  logEvent,
  logEvidence,
  logPage,
  logRun,
  workflowLogModel,
} from "../support/development-logs";
import { test, expect, assertAccessible } from "./support/test";

const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "Inspector", exact: true });
const disclosure = (page: Page) =>
  inspector(page).locator('[data-slot="resource-logs"] > details');
const summary = (page: Page) => disclosure(page).locator(":scope > summary");

for (const width of [1440, 390])
  test(`one invocation groups its lifecycle and distinguishes HTTP outcomes at ${width}px`, async ({
    page,
    studio,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let status = 401,
      failed = false;
    const events = () => {
      const base = {
        correlation: {
          traceId: "trace-grouped",
          invocationId: "invocation-grouped",
          requestId: "request-grouped",
        },
        level: "info" as const,
        message: undefined,
        outcome: undefined,
        details: undefined,
        omissions: [],
      };
      return [
        logEvent(10, { ...base, kind: "lambda.invocation.started" }),
        logEvent(11, {
          ...base,
          kind: "lambda.invocation.input",
          details: { input: "[sensitive invocation payload omitted]" },
        }),
        logEvent(12, {
          ...base,
          kind: "lambda.worker",
          details: { mode: "cold" },
        }),
        logEvent(13, {
          ...base,
          kind: failed
            ? "lambda.invocation.failed"
            : "lambda.invocation.completed",
          durationMs: 1365,
          outcome: failed ? "failed" : "succeeded",
          level: failed ? "error" : "info",
          details: failed
            ? { error: { message: "Upstream fixture unavailable" } }
            : {
                http: { status },
                result: "[sensitive invocation payload omitted]",
              },
        }),
      ];
    };
    studio.reply("GET", "/api/development-logs/entries", (route) =>
      route.fulfill({ json: logPage(events()) }),
    );
    await studio.goto("/?select=lambda%3Afixture-0");
    await summary(page).click();
    const runDetails = inspector(page).locator('[data-slot="log-run-details"]');
    await expect(runDetails).not.toHaveAttribute("open");
    await runDetails.locator(":scope > summary").focus();
    await page.keyboard.press("Space");
    await expect(
      runDetails.getByText(logRun.bindingId, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(runDetails).not.toHaveAttribute("open");
    const primary = inspector(page).locator('[data-slot="log-operation"]');
    await expect(primary).toHaveCount(1);
    await expect(
      primary.getByText("Returned status 401", { exact: true }),
    ).toBeVisible();
    await expect(primary.getByText("1.365 s", { exact: true })).toBeVisible();
    await expect(
      primary.getByText("Cold start", { exact: true }),
    ).toBeVisible();
    await expect(
      primary.getByText(
        "Handler returned normally · error response status returned",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      primary.getByText("lambda.invocation.started", { exact: true }),
    ).toHaveCount(0);
    const toggle = primary.locator(":scope > details > summary");
    await toggle.focus();
    await page.keyboard.press("Space");
    const lifecycle = primary.getByRole("list", {
      name: "Invocation lifecycle",
      exact: true,
    });
    await expect(lifecycle.locator(":scope > li")).toHaveCount(4);
    await expect(
      lifecycle.getByText("lambda.invocation.input", { exact: true }),
    ).toBeVisible();
    await lifecycle
      .getByRole("button", { name: "Show event details", exact: true })
      .last()
      .click();
    await expect(
      lifecycle.locator("pre").filter({ hasText: '"http"' }),
    ).toContainText('"status": 401');
    await expect(
      lifecycle.locator("pre").filter({ hasText: '"http"' }),
    ).toContainText("[sensitive invocation payload omitted]");
    expect(
      studio.requests.filter((request) =>
        request.path.startsWith("/api/development-logs/trace"),
      ),
    ).toEqual([]);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(lifecycle).toHaveCount(0);
    const pauseFollow = inspector(page).getByRole("button", {
      name: "Pause follow",
      exact: true,
    });
    if (await pauseFollow.count()) await pauseFollow.click();
    await expect(
      inspector(page).getByRole("button", { name: "Follow logs", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    for (const next of [200, 500]) {
      status = next;
      await inspector(page)
        .getByRole("button", { name: "Refresh logs", exact: true })
        .click();
      await expect(
        primary.getByText(`Returned status ${next}`, { exact: true }),
      ).toBeVisible();
      await expect(primary).toHaveCount(1);
      await expect(
        primary.getByText("Handler returned normally", { exact: next < 400 }),
      ).toBeVisible();
    }
    failed = true;
    await inspector(page)
      .getByRole("button", { name: "Refresh logs", exact: true })
      .click();
    await expect(
      primary.getByText("Execution failed", { exact: true }),
    ).toBeVisible();
    await expect(
      primary.getByText("Upstream fixture unavailable", { exact: true }),
    ).toBeVisible();
    await expect(primary.getByText(/Handler returned normally/)).toHaveCount(0);
    await primary.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await assertAccessible(page);
    await page.screenshot({
      path: info.outputPath(`grouped-invocation-${width}.png`),
      fullPage: true,
    });
  });

test("workflow-owned event Lambda Logs reads local execution while an AWS-only event stays unsupported", async ({
  page,
  studio,
}) => {
  for (const mode of ["dev", "prod"] as const)
    Object.assign(
      studio.response.snapshot.models[mode],
      workflowLogModel(studio.response.snapshot.models[mode]),
    );
  studio.reply("GET", "/api/development-logs/entries", (route) =>
    route.fulfill({ json: logPage([logEvent()]) }),
  );
  await studio.goto("/?select=lambda%3Afixture-0");
  await summary(page).click();
  await expect(
    inspector(page).getByText(/Local workflow invocations are captured/),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("Order lookup failed: upstream unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(inspector(page).locator("time").first()).toHaveAttribute(
    "title",
    logRun.startedAt,
  );
  await inspector(page)
    .getByRole("button", { name: "Show event details", exact: true })
    .click();
  await expect(
    inspector(page).locator("pre").filter({ hasText: '"observedAt"' }),
  ).toContainText('"occurredAt"');
  await inspector(page)
    .getByRole("button", { name: "Back to Resources", exact: true })
    .click();
  await page.locator('[data-resource-id="lambda:aws-only-fixture"]').click();
  await summary(page).click();
  await expect(
    inspector(page).getByText(/This event handler runs in AWS/),
  ).toBeVisible();
  expect(
    studio.requests.filter((request) =>
      request.path.includes("resource=lambda%3Aaws-only-fixture"),
    ),
  ).toEqual([]);
});

test("older history moves a bounded window beyond 1,000 records and Follow returns to the tail", async ({
  page,
  studio,
}) => {
  studio.reply("GET", "/api/development-logs/entries", (route, url) => {
    const maximum = Number(url.searchParams.get("cursor") ?? "1501") - 1,
      minimum = Math.max(1, maximum - 99);
    const entries = Array.from({ length: maximum - minimum + 1 }, (_, index) =>
      logEvent(minimum + index, {
        message: `Window event ${minimum + index}`,
        kind: "worker.stdout",
        level: "info",
        stream: "stdout",
      }),
    );
    return route.fulfill({
      json: {
        ...logPage(entries),
        olderCursor: minimum > 1 ? String(minimum) : undefined,
      },
    });
  });
  await studio.goto("/?select=lambda%3Afixture-0");
  await summary(page).click();
  const region = inspector(page).getByRole("region", {
    name: "Resource log entries",
    exact: true,
  });
  await expect(
    inspector(page).getByText("Window event 1500", { exact: true }),
  ).toBeVisible();
  for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
    const button = inspector(page).getByRole("button", {
      name: "Load older logs",
      exact: true,
    });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(region.locator("[data-log-event-id]")).toHaveCount(
      Math.min((pageNumber + 1) * 100, 1000),
    );
    await expect(button).toBeEnabled();
  }
  await expect(
    inspector(page).getByText(
      /100 newer entries are outside this 1,000-entry history window/,
    ),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("Window event 1500", { exact: true }),
  ).toHaveCount(0);
  await region.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    inspector(page).getByText("Window event 401", { exact: true }),
  ).toBeVisible();
  const anchor = await region
    .locator('[data-log-event-id="fixture-event-401"]')
    .evaluate((element) => element.getBoundingClientRect().top - element.closest('[role="region"]')!.getBoundingClientRect().top);
  await inspector(page)
    .getByRole("button", { name: "Load older logs", exact: true })
    .click();
  await expect(
    region.locator('[data-log-event-id="fixture-event-301"]'),
  ).toHaveCount(1);
  expect(
    await region
      .locator('[data-log-event-id="fixture-event-401"]')
      .evaluate((element) => element.getBoundingClientRect().top - element.closest('[role="region"]')!.getBoundingClientRect().top),
  ).toBeCloseTo(anchor, 0);
  await inspector(page)
    .getByRole("button", { name: "Follow logs", exact: true })
    .click();
  await expect(region.locator("[data-log-event-id]")).toHaveCount(100);
  await expect(
    inspector(page).getByText("Window event 1500", { exact: true }),
  ).toBeVisible();
});

for (const width of [1440, 390])
  test(`resource Logs supports keyboard, history, filters and Production isolation at ${width}px`, async ({
    page,
    studio,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    studio.reply("GET", "/api/development-logs/runs", (route) =>
      route.fulfill({ json: { schemaVersion: 1, runs: [logRun] } }),
    );
    studio.reply("GET", "/api/development-logs/entries", (route, url) =>
      route.fulfill({
        json: url.searchParams.has("cursor")
          ? logPage([logEvent(0, { message: "Earlier request arrived" })])
          : { ...logPage([logEvent()]), olderCursor: "fixture-older-cursor" },
      }),
    );
    await studio.goto();
    await page.getByRole("button", { name: "Resources", exact: true }).click();
    await page.locator('[data-resource-id="lambda:fixture-0"]').focus();
    await page.keyboard.press("Enter");
    await expect(disclosure(page)).not.toHaveAttribute("open");
    expect(
      studio.requests.filter((request) =>
        request.path.startsWith("/api/development-logs/"),
      ),
    ).toEqual([]);
    await summary(page).focus();
    await page.keyboard.press("Space");
    await expect(disclosure(page)).toHaveAttribute("open", "");
    await expect(
      inspector(page).getByText("Order lookup failed: upstream unavailable", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(inspector(page).locator("time").first()).toHaveText(
      /^\d{2}:\d{2}:\d{2}[.,]\d{3}$/,
    );
    await inspector(page)
      .getByRole("button", { name: "Pause follow", exact: true })
      .click();
    await inspector(page)
      .getByRole("button", { name: "Show event details", exact: true })
      .click();
    await expect(
      inspector(page).getByText(/"authorization": "\[redacted\]"/),
    ).toBeVisible();
    await inspector(page)
      .getByRole("button", { name: "Load older logs", exact: true })
      .click();
    await expect(
      inspector(page).getByText("Earlier request arrived", { exact: true }),
    ).toBeVisible();
    await inspector(page)
      .getByRole("searchbox", { name: "Search resource logs", exact: true })
      .fill("upstream");
    await expect
      .poll(() =>
        studio.requests.some((request) =>
          request.path.includes("search=upstream"),
        ),
      )
      .toBe(true);
    await inspector(page)
      .getByRole("combobox", { name: "Resource log level", exact: true })
      .selectOption("error");
    await expect
      .poll(() =>
        studio.requests.some((request) => request.path.includes("level=error")),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await assertAccessible(page);
    await page.screenshot({
      path: info.outputPath(`resource-logs-${width}.png`),
      fullPage: true,
    });
    await summary(page).focus();
    await page.keyboard.press("Enter");
    await expect(disclosure(page)).not.toHaveAttribute("open");
    const before = studio.requests.filter((request) =>
      request.path.startsWith("/api/development-logs/"),
    ).length;
    await page
      .getByRole("group", { name: "Source environment", exact: true })
      .getByRole("button", { name: "Production", exact: true })
      .click();
    await summary(page).focus();
    await page.keyboard.press("Enter");
    await expect(
      inspector(page).getByText(/Production log collection is not implemented/),
    ).toBeVisible();
    await expect(
      inspector(page).getByText("Order lookup failed: upstream unavailable", {
        exact: true,
      }),
    ).toHaveCount(0);
    await page.waitForTimeout(2200);
    expect(
      studio.requests.filter((request) =>
        request.path.startsWith("/api/development-logs/"),
      ).length,
    ).toBe(before);
    expect(
      studio.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
  });

test("direct map selection shares Logs and preserves disclosure state through browser Back", async ({
  page,
  studio,
}) => {
  studio.reply("GET", "/api/development-logs/entries", (route) =>
    route.fulfill({ json: logPage([logEvent()]) }),
  );
  await studio.goto();
  const navigator = page.getByRole("list", {
    name: "Entities in the landscape",
  });
  await navigator
    .getByRole("button", { name: /^fixture-0, HTTP Lambda/ })
    .focus();
  await page.keyboard.press("Enter");
  await summary(page).focus();
  await page.keyboard.press("Enter");
  await expect(
    inspector(page).getByText("Order lookup failed: upstream unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await inspector(page)
    .getByRole("button", { name: "Back to Resources", exact: true })
    .click();
  await page.locator('[data-resource-id="lambda:fixture-1"]').click();
  await expect(disclosure(page)).not.toHaveAttribute("open");
  await page.goBack();
  await page.goBack();
  await expect(disclosure(page)).toHaveAttribute("open", "");
  await expect(
    inspector(page).getByText("Order lookup failed: upstream unavailable", {
      exact: true,
    }),
  ).toBeVisible();
});

test("Logs distinguishes loading, empty, stopped, disconnected, failures and gaps", async ({
  page,
  studio,
}) => {
  let state: DevelopmentLogPage = logPage(),
    fail = false,
    release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  studio.reply("GET", "/api/development-logs/entries", async (route) => {
    if (first) {
      first = false;
      await pending;
    }
    await route.fulfill(
      fail
        ? { status: 503, json: { error: "Fixture cache unavailable" } }
        : { json: state },
    );
  });
  await studio.goto("/?select=lambda%3Afixture-0");
  await summary(page).click();
  await expect(
    inspector(page).getByText("Loading development logs…", { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    inspector(page).getByText(
      "No cached development logs for this resource in this run.",
      { exact: true },
    ),
  ).toBeVisible();
  await inspector(page)
    .getByRole("button", { name: "Pause follow", exact: true })
    .click();
  for (const [collection, text] of [
    ["stopped", "Runtime stopped · cached history"],
    [
      "disconnected",
      "Collector disconnected · cached evidence may be incomplete",
    ],
    [
      "failed",
      "Development log collection failed · cached history remains available",
    ],
  ] as const) {
    state = { ...logPage([logEvent()]), collection };
    await inspector(page)
      .getByRole("button", { name: "Refresh logs", exact: true })
      .click();
    await expect(
      inspector(page).getByText(text, { exact: true }),
    ).toBeVisible();
  }
  state = {
    ...state,
    dropped: 3,
    truncated: 2,
    gaps: [
      {
        reason: "retention",
        at: logRun.startedAt,
        count: 4,
        message: "Older entries expired",
      },
      ...Array.from({length:24},()=>({reason:"restart" as const,at:logRun.startedAt,message:"Collector restarted; execution recovery is not implied."})),
    ],
  };
  await inspector(page)
    .getByRole("button", { name: "Refresh logs", exact: true })
    .click();
  await expect(
    inspector(page).getByText(/Log history is incomplete/),
  ).toBeVisible();
  await expect(inspector(page).getByText(/24 markers/)).toBeVisible();
  await expect(inspector(page).getByText("Collector restarted; execution recovery is not implied.",{exact:true})).toHaveCount(0);
  await inspector(page).locator("summary").filter({hasText:"History gaps (25)"}).click();
  await expect(inspector(page).locator("summary").filter({hasText:"History gaps (25)"}).locator("..").getByRole("listitem")).toHaveCount(25);
  fail = true;
  await inspector(page)
    .getByRole("button", { name: "Refresh logs", exact: true })
    .click();
  await expect(inspector(page).getByRole("alert")).toContainText(
    "Fixture cache unavailable",
  );
  await expect(
    inspector(page).getByText("Order lookup failed: upstream unavailable", {
      exact: true,
    }),
  ).toBeVisible();
});

test("Sightline reads useful cached excerpts before Logs is expanded and stops reading in Production", async ({
  page,
  studio,
}) => {
  studio.reply("GET", "/api/development-logs/evidence", (route) =>
    route.fulfill({ json: logEvidence([logEvent()]) }),
  );
  studio.reply("GET", "/api/agent-lab/status", (route) =>
    route.fulfill({ json: { providers: [], busy: false } }),
  );
  await studio.goto("/?select=lambda%3Afixture-0");
  await expect(disclosure(page)).not.toHaveAttribute("open");
  const tray = page.getByRole("region", { name: "Activity", exact: true });
  await tray.getByRole("tab", { name: /^Agent/ }).click();
  const toggle = tray.getByRole("button", {
    name: /^Agent: (expand|collapse) panel$/,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await tray.getByRole("tab", { name: "Context", exact: true }).click();
  const sightline = page.getByRole("region", {
    name: "Sightline",
    exact: true,
  });
  await sightline
    .getByRole("button", { name: "Expand all", exact: true })
    .click();
  await expect(sightline.getByText(/Order lookup failed/)).toBeVisible();
  expect(
    studio.requests.filter((request) =>
      request.path.startsWith("/api/development-logs/entries"),
    ),
  ).toEqual([]);
  await page
    .getByRole("group", { name: "Source environment", exact: true })
    .getByRole("button", { name: "Production", exact: true })
    .click();
  await expect(
    sightline.getByText(/Production log collection is not implemented/),
  ).toBeVisible();
  await expect(sightline.getByText(/Order lookup failed/)).toHaveCount(0);
  const before = studio.requests.filter((request) =>
    request.path.startsWith("/api/development-logs/"),
  ).length;
  await page.waitForTimeout(2200);
  expect(
    studio.requests.filter((request) =>
      request.path.startsWith("/api/development-logs/"),
    ).length,
  ).toBe(before);
});

import { buildDevelopmentTrace } from "../../shared/development-traces";
import { logEvent, logPage, logRun } from "../support/development-logs";
import { test, expect, assertAccessible } from "./support/test";

function traceFixture() {
  const make = (
    sequence: number,
    resource: string,
    spanId: string,
    kind: string,
    parentSpanId?: string,
  ) =>
    logEvent(sequence, {
      resource: { id: resource, kind: resource.split(":")[0]! },
      kind,
      outcome: undefined,
      level: "info",
      message: undefined,
      details: undefined,
      correlation: {
        traceId: "trace-browser",
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        invocationId:
          resource === "lambda:fixture-0"
            ? "selected-invocation"
            : `child-${spanId}`,
      },
    });
  const events = [
    make(1, "gateway:http", "request", "http.request.received"),
    make(
      2,
      "lambda:fixture-0",
      "selected",
      "lambda.invocation.started",
      "request",
    ),
    make(3, "workflow:orders", "workflow", "workflow.accepted", "selected"),
    make(
      4,
      "lambda:failed-step",
      "failed",
      "lambda.invocation.started",
      "workflow",
    ),
    {
      ...make(
        5,
        "lambda:failed-step",
        "failed",
        "lambda.invocation.failed",
        "workflow",
      ),
      level: "error" as const,
      outcome: "failed",
      message: "Inventory lookup failed",
      durationMs: 40,
    },
    {
      ...make(
        6,
        "lambda:fixture-0",
        "selected",
        "lambda.invocation.completed",
        "request",
      ),
      outcome: "succeeded",
      details: { http: { status: 401 } },
      durationMs: 50,
    },
    {
      ...make(7, "gateway:http", "request", "http.response.finished"),
      details: { status: 401 },
      durationMs: 55,
    },
  ];
  return {
    events,
    trace: buildDevelopmentTrace({
      ...logPage(events),
      traceId: "trace-browser",
      complete: true,
    }),
  };
}

for (const width of [1440, 390])
  test(`trace disclosure shows the observed failure chain and isolates Production at ${width}px`, async ({
    page,
    studio,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { events, trace } = traceFixture();
    studio.reply("GET", "/api/development-logs/entries", (route) =>
      route.fulfill({
        json: logPage(
          events.filter((event) => event.resource.id === "lambda:fixture-0"),
        ),
      }),
    );
    studio.reply("GET", "/api/development-logs/trace", (route) =>
      route.fulfill({ json: trace }),
    );
    await studio.goto("/?select=lambda%3Afixture-0");
    const inspector = page.getByRole("complementary", {
      name: "Inspector",
      exact: true,
    });
    await inspector
      .locator('[data-slot="resource-logs"] > details > summary')
      .click();
    expect(
      studio.requests.filter((request) =>
        request.path.startsWith("/api/development-logs/trace"),
      ),
    ).toEqual([]);
    const operation = inspector.locator(
      '[data-slot="log-operation"] > details',
    );
    await expect(operation).toHaveCount(1);
    await operation.locator(":scope > summary").click();
    const disclosure = inspector.locator('[data-slot="development-trace"]');
    await expect(disclosure).not.toHaveAttribute("open");
    expect(
      studio.requests.filter((request) =>
        request.path.startsWith("/api/development-logs/trace"),
      ),
    ).toEqual([]);
    await disclosure.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    const chain = disclosure.getByRole("list", {
      name: "Trace execution chain",
      exact: true,
    });
    await expect(
      chain.getByText("gateway:http", { exact: true }),
    ).toBeVisible();
    await expect(
      chain.getByText("workflow:orders", { exact: true }),
    ).toBeVisible();
    await expect(
      chain.getByText("lambda:failed-step", { exact: true }),
    ).toBeVisible();
    await expect(
      chain.getByText("Inventory lookup failed", { exact: true }),
    ).toBeVisible();
    await expect(chain.getByText("HTTP 401", { exact: true })).toHaveCount(1);
    await expect(
      chain.getByText("Returned status 401", { exact: true }),
    ).toHaveCount(1);
    await expect(
      chain.getByText("Execution failed", { exact: true }),
    ).toBeVisible();
    await chain
      .locator("li")
      .filter({ has: page.getByText("lambda:failed-step", { exact: true }) })
      .locator("summary")
      .focus();
    await page.keyboard.press("Space");
    await expect(
      disclosure.getByText('"parentSpanId": "workflow"', { exact: false }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await assertAccessible(page);
    await page
      .getByRole("group", { name: "Source environment", exact: true })
      .getByRole("button", { name: "Production", exact: true })
      .click();
    await expect(
      inspector.getByText(/Production log collection is not implemented/),
    ).toBeVisible();
    await expect(
      inspector.getByText("Inventory lookup failed", { exact: true }),
    ).toHaveCount(0);
    const count = studio.requests.filter((request) =>
      request.path.startsWith("/api/development-logs/trace"),
    ).length;
    await page.waitForTimeout(2200);
    expect(
      studio.requests.filter((request) =>
        request.path.startsWith("/api/development-logs/trace"),
      ).length,
    ).toBe(count);
    expect(
      studio.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
  });

test("trace cache failures stay explicit without claiming an observed execution chain", async ({
  page,
  studio,
}) => {
  const { events } = traceFixture();
  studio.reply("GET", "/api/development-logs/entries", (route) =>
    route.fulfill({
      json: logPage(
        events.filter((event) => event.resource.id === "lambda:fixture-0"),
      ),
    }),
  );
  studio.reply("GET", "/api/development-logs/trace", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Trace cache is unavailable" },
    }),
  );
  await studio.goto("/?select=lambda%3Afixture-0");
  const inspector = page.getByRole("complementary", {
    name: "Inspector",
    exact: true,
  });
  await inspector
    .locator('[data-slot="resource-logs"] > details > summary')
    .click();
  await inspector
    .locator('[data-slot="log-operation"] > details > summary')
    .click();
  await inspector.locator('[data-slot="development-trace"] > summary').click();
  await expect(inspector.getByRole("alert")).toHaveText(
    "Trace cache is unavailable",
  );
  await expect(
    inspector.getByText("lambda:failed-step", { exact: true }),
  ).toHaveCount(0);
});

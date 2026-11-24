import assert from "./support/assert";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildDevelopmentTrace } from "../shared/development-traces";
import { developmentLogsRouter } from "../server/development-logs";
import { logEvent, logPage, logRun } from "./support/development-logs";
import { snapshot } from "./browser/support/scenarios";
import type { DevelopmentLogEvent } from "../shared/development-logs";
import type { DevelopmentLogTracePage } from "aws-studio/development-logs/contract";

const event = (
  index: number,
  resource: string,
  span: string,
  parent?: string,
  change: Partial<DevelopmentLogEvent> = {},
) =>
  logEvent(index, {
    resource: { id: resource, kind: resource.split(":")[0]! },
    correlation: {
      traceId: "trace-orders",
      spanId: span,
      ...(parent ? { parentSpanId: parent } : {}),
    },
    outcome: undefined,
    level: "info",
    message: undefined,
    details: undefined,
    ...change,
  });
const tracePage = (events: DevelopmentLogEvent[]): DevelopmentLogTracePage => ({
  ...logPage(events),
  traceId: "trace-orders",
  complete: true,
});

test("trace reconstruction follows explicit span parents and distinguishes HTTP rejection from handler return", () => {
  const events = [
    event(1, "gateway:http", "request", undefined, {
      kind: "http.request.received",
    }),
    event(2, "lambda:orders", "call", "request", {
      kind: "lambda.invocation.started",
    }),
    event(3, "lambda:orders", "call", "request", {
      kind: "lambda.invocation.completed",
      outcome: "succeeded",
      details: { http: { status: 401 } },
      durationMs: 12,
    }),
    event(4, "gateway:http", "request", undefined, {
      kind: "http.response.finished",
      details: { status: 401 },
      durationMs: 20,
    }),
    event(5, "workflow:async", "async", "call", {
      kind: "workflow.accepted",
      correlation: {
        traceId: "trace-orders",
        spanId: "async",
        parentSpanId: "call",
        executionId: "execution-1",
      },
    }),
  ];
  const result = buildDevelopmentTrace(tracePage(events));
  assert.equal(result.spans.length, 3);
  const request = result.spans.find(
      (span) => span.resourceId === "gateway:http",
    )!,
    lambda = result.spans.find((span) => span.resourceId === "lambda:orders")!,
    workflow = result.spans.find(
      (span) => span.resourceId === "workflow:async",
    )!;
  assert.equal(lambda.parentId, request.id);
  assert.equal(workflow.parentId, lambda.id);
  assert.equal(lambda.summary.execution, "returned");
  assert.equal(lambda.summary.httpStatus, 401);
  assert.equal(lambda.summary.label, "Returned status 401");
  assert.equal(lambda.summary.httpStatusSource, "handler-result");
  assert.equal(request.summary.httpStatusSource, "gateway-response");
  assert.equal(lambda.summary.tone, "warning");
  assert.equal(request.summary.durationMs, 20);
  assert.equal(workflow.incomplete, true);
  assert.equal(workflow.summary.execution, "unobserved");
});

test("missing or cyclic parents remain explicit and retries/maps retain their own observed identities", () => {
  const result = buildDevelopmentTrace(
    tracePage([
      event(1, "workflow:orders", "branch-a", "missing", {
        kind: "workflow.state.entered",
        correlation: {
          traceId: "trace-orders",
          spanId: "branch-a",
          parentSpanId: "missing",
          stateAttemptId: "attempt-1",
          mapIndex: 0,
        },
      }),
      event(2, "workflow:orders", "branch-b", "branch-c", {
        kind: "workflow.state.failed",
        level: "error",
        message: "Useful failed step",
      }),
      event(3, "workflow:orders", "branch-c", "branch-b", {
        kind: "workflow.state.entered",
      }),
      event(4, "workflow:orders", "retry", "missing", {
        kind: "workflow.state.retrying",
        correlation: {
          traceId: "trace-orders",
          spanId: "retry",
          parentSpanId: "missing",
          stateAttemptId: "attempt-2",
          mapIndex: 0,
        },
      }),
    ]),
  );
  assert.equal(result.spans.length, 4);
  assert.ok(result.spans.some((span) => span.orphan));
  assert.ok(result.gaps.some((gap) => gap.message.includes("cyclic")));
  assert.equal(
    result.spans.find((span) => span.spanId === "branch-a")?.correlation
      .mapIndex,
    0,
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "retry")?.summary.label,
    "Retry scheduled",
  );
  assert.equal(
    result.spans.find((span) => span.spanId === "branch-b")?.summary
      .errorExcerpt,
    "Useful failed step",
  );
});

test("trace reconstruction caps spans while prioritizing failed spans and their observed ancestors", () => {
  const events = [
    event(1, "gateway:http", "root", undefined, {
      kind: "http.request.received",
    }),
    ...Array.from({ length: 120 }, (_, index) =>
      event(index + 2, `lambda:step-${index}`, `span-${index}`, "root", {
        kind:
          index === 119
            ? "lambda.invocation.failed"
            : "lambda.invocation.completed",
        level: index === 119 ? "error" : "info",
        outcome: index === 119 ? "failed" : "succeeded",
      }),
    ),
  ];
  const result = buildDevelopmentTrace(tracePage(events));
  assert.equal(result.spans.length, 80);
  assert.equal(result.complete, false);
  assert.equal(result.omitted, 41);
  assert.ok(result.spans.some((span) => span.resourceId === "lambda:step-119"));
  assert.ok(result.spans.some((span) => span.resourceId === "gateway:http"));
});

test("trace projection excludes other runtime runs and trace identities", () => {
  const page = tracePage([
    event(1, "lambda:orders", "current", undefined, {
      kind: "lambda.invocation.started",
    }),
    event(2, "lambda:other", "old", undefined, {
      runtimeSessionId: "another-runtime",
      message: "OTHER_RUN_CANARY",
    }),
    event(3, "lambda:other", "foreign", undefined, {
      correlation: { traceId: "another-trace", spanId: "foreign" },
      message: "OTHER_TRACE_CANARY",
    }),
  ]);
  const projected = buildDevelopmentTrace(page);
  assert.equal(projected.events.length, 1);
  assert.equal(projected.spans.length, 1);
  assert.equal(projected.complete, false);
  assert.ok(!JSON.stringify(projected).includes("OTHER_RUN_CANARY"));
  assert.ok(!JSON.stringify(projected).includes("OTHER_TRACE_CANARY"));
});

test("trace API requires Development and a same-run selected-resource anchor before cross-resource reads", async () => {
  let wideReads = 0,
    anchor = true,
    oversized = false;
  const runId = "00000000-0000-4000-8000-000000000001";
  const apiPage = (events: DevelopmentLogEvent[]) => ({
    ...tracePage(events),
    run: { ...logRun, runtimeSessionId: runId },
    entries: events.map((event) => ({ ...event, runtimeSessionId: runId })),
  });
  const app = express();
  app.use(
    "/logs",
    developmentLogsRouter({
      model: () => snapshot().snapshot.models.dev,
      readRuns: async () => [logRun],
      readEntries: async () =>
        apiPage(
          anchor
            ? [
                event(1, "lambda:fixture-0", "root", undefined, {
                  kind: "lambda.invocation.started",
                }),
              ]
            : [],
        ),
      readTrace: async (query) => {
        if (query.resourceIds && !anchor) return apiPage([]);
        if (!query.resourceIds) wideReads++;
        if (!query.resourceIds && oversized)
          return {
            ...apiPage(
              Array.from({ length: 200 }, (_, index) =>
                event(index + 1, "lambda:fixture-0", "root", undefined, {
                  kind: "lambda.output",
                  message: "x".repeat(1024),
                  details: { preview: "y".repeat(2048) },
                }),
              ),
            ),
            gaps: Array.from({ length: 64 }, (_, index) => ({
              reason: "restart" as const,
              at: logRun.startedAt,
              message: `Fixture gap ${index}`,
            })),
          };
        return apiPage([
          event(1, "lambda:fixture-0", "root", undefined, {
            kind: "lambda.invocation.completed",
            outcome: "succeeded",
            details: { http: { status: 200 } },
            durationMs: 15,
          }),
        ]);
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/logs/trace`;
  const query = new URLSearchParams({
    mode: "dev",
    resource: "lambda:fixture-0",
    runId,
    traceId: "trace-orders",
  });
  try {
    for (const invalid of [
      { mode: "prod" },
      { resource: "../../private" },
      { traceId: "x\nsecret" },
      { traceId: "x".repeat(257) },
      { runId: "../run" },
      { command: "docker logs" },
    ]) {
      const bad = new URLSearchParams(query);
      for (const [key, value] of Object.entries(invalid)) bad.set(key, value);
      assert.equal((await fetch(`${base}?${bad}`)).status, 400);
    }
    assert.equal(wideReads, 0);
    anchor = false;
    const missing = await (await fetch(`${base}?${query}`)).json();
    assert.equal(wideReads, 0);
    assert.equal(missing.complete, false);
    assert.equal(missing.spans.length, 0);
    anchor = true;
    const ok = await (await fetch(`${base}?${query}`)).json();
    assert.equal(wideReads, 1);
    assert.equal(ok.spans[0].summary.httpStatus, 200);
    assert.equal(ok.spans[0].summary.durationMs, 15);
    oversized = true;
    const bounded = await (await fetch(`${base}?${query}`)).text(),
      boundedTrace = JSON.parse(bounded);
    assert.ok(Buffer.byteLength(bounded) <= 256 * 1024);
    assert.equal(boundedTrace.complete, false);
    assert.ok(
      boundedTrace.gaps.some(
        (gap: { reason: string; count?: number }) =>
          gap.reason === "truncated" && (gap.count ?? 0) > 0,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

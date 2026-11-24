import assert from "./support/assert";
import { test } from "node:test";
import {
  groupDevelopmentLogOperations,
  summarizeDevelopmentLogOperation,
} from "../shared/development-log-operations";
import { logEvent } from "./support/development-logs";
import type { DevelopmentLogEvent } from "../shared/development-logs";

function invocation(
  sequence: number,
  kind: string,
  changes: Partial<DevelopmentLogEvent> = {},
) {
  return logEvent(sequence, {
    kind,
    correlation: {
      invocationId: "invoke-a",
      traceId: "trace-a",
      requestId: "request-a",
    },
    occurredAt: new Date(Date.UTC(2026, 0, 1) + sequence * 10).toISOString(),
    level: "info",
    message: undefined,
    details: undefined,
    omissions: [],
    outcome: undefined,
    ...changes,
  });
}

test("one invocation retains four lifecycle events and distinguishes HTTP401 from handler completion", () => {
  const events = [
    invocation(1, "lambda.invocation.started"),
    invocation(2, "lambda.invocation.input", {
      details: { input: "[sensitive invocation payload omitted]" },
    }),
    invocation(3, "lambda.worker", { details: { mode: "cold" } }),
    invocation(4, "lambda.invocation.completed", {
      durationMs: 1365,
      outcome: "succeeded",
      details: {
        result: "[sensitive invocation payload omitted]",
        http: { status: 401 },
      },
    }),
  ];
  const groups = groupDevelopmentLogOperations(events);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.kind, "invocation");
  assert.deepEqual(groups[0]!.events, events);
  assert.equal(groups[0]!.summary.execution, "returned");
  assert.equal(groups[0]!.summary.label, "Returned status 401");
  assert.equal(groups[0]!.summary.httpStatusSource, "handler-result");
  assert.equal(groups[0]!.summary.tone, "warning");
  assert.equal(groups[0]!.summary.durationMs, 1365);
  assert.equal(groups[0]!.summary.worker, "cold");
  assert.equal(groups[0]!.summary.missingStart, false);
});

test("concurrent, late and historical events use exact run/resource/invocation identities", () => {
  const a = invocation(1, "lambda.invocation.started");
  const b = invocation(2, "lambda.invocation.started", {
    correlation: { ...a.correlation, invocationId: "invoke-b" },
  });
  const late = invocation(3, "lambda.output", {
    late: true,
    stream: "stdout",
    message: "A after B started",
  });
  const native = invocation(4, "lambda.output", {
    attribution: "worker",
    correlation: { traceId: "trace-a" },
    message: "No invocation known",
  });
  const historical = invocation(5, "lambda.invocation.completed", {
    runtimeSessionId: "older-runtime",
  });
  const other = invocation(6, "lambda.invocation.completed", {
    resource: { id: "lambda:another", kind: "lambda" },
  });
  const groups = groupDevelopmentLogOperations([
    a,
    b,
    late,
    native,
    historical,
    other,
    late,
  ]);
  assert.equal(groups.length, 5);
  assert.deepEqual(
    groups[0]!.events.map((event) => event.eventId),
    [a.eventId, late.eventId],
  );
  assert.equal(groups[1]!.events[0]!.correlation.invocationId, "invoke-b");
  assert.equal(groups[2]!.kind, "event");
  assert.equal(groups[3]!.runtimeSessionId, "older-runtime");
  assert.equal(groups[4]!.resourceId, "lambda:another");
  const agentOutput = invocation(7, "process.output", {
    resource: { id: "agent:helper", kind: "agent" },
    attribution: "session",
  });
  assert.equal(
    groupDevelopmentLogOperations([agentOutput])[0]!.kind,
    "event",
    "an inherited caller invocation does not turn agent session output into a Lambda invocation",
  );
});

test("finished response status outranks integration return and request abort is never success", () => {
  const events = [
    invocation(1, "http.request.received", {
      resource: { id: "gateway:http", kind: "gateway" },
    }),
    invocation(2, "http.integration.completed", { details: { status: 200 } }),
    invocation(3, "http.response.finished", {
      details: { status: 500 },
      durationMs: 20,
    }),
  ];
  const summary = summarizeDevelopmentLogOperation(events);
  assert.equal(summary.httpStatus, 500);
  assert.equal(summary.tone, "error");
  assert.equal(summary.label, "HTTP 500");
  assert.equal(summary.httpStatusSource, "gateway-response");
  const aborted = summarizeDevelopmentLogOperation([
    ...events.slice(0, 2),
    invocation(4, "http.response.aborted"),
  ]);
  assert.equal(aborted.execution, "aborted");
  assert.equal(aborted.label, "Request aborted");
});

test("timeouts, cancellations and exceptions remain distinct while stderr does not rewrite success", () => {
  for (const [kind, expected] of [
    ["lambda.invocation.failed", "failed"],
    ["lambda.invocation.cancelled", "cancelled"],
    ["lambda.invocation.timed-out", "timed-out"],
  ] as const) {
    const summary = summarizeDevelopmentLogOperation([
      invocation(1, "lambda.invocation.started"),
      invocation(2, kind, {
        details: { error: { message: "Useful sanitized failure" } },
      }),
    ]);
    assert.equal(summary.execution, expected);
    assert.equal(summary.errorExcerpt, "Useful sanitized failure");
  }
  const summary = summarizeDevelopmentLogOperation([
    invocation(1, "lambda.invocation.started"),
    invocation(2, "lambda.output", {
      stream: "stderr",
      level: "error",
      message: "Diagnostic warning",
    }),
    invocation(3, "lambda.invocation.completed", {
      details: { http: { status: 200 } },
    }),
  ]);
  assert.equal(summary.execution, "returned");
  assert.equal(summary.label, "Returned status 200");
  assert.equal(summary.errorExcerpt, "Diagnostic warning");
});

test("partial pages do not invent running or completed execution and step catches do not fail workflow", () => {
  assert.equal(
    summarizeDevelopmentLogOperation([invocation(1, "lambda.output")]).label,
    "Partial evidence",
  );
  assert.equal(
    summarizeDevelopmentLogOperation([
      invocation(1, "lambda.invocation.started"),
    ]).execution,
    "unobserved",
  );
  const state = [
    invocation(1, "workflow.state.entered"),
    invocation(2, "workflow.state.failed"),
    invocation(3, "workflow.state.caught"),
  ];
  assert.equal(summarizeDevelopmentLogOperation(state).execution, "unobserved");
  assert.equal(
    summarizeDevelopmentLogOperation(state, { scope: "span" }).label,
    "Failure caught",
  );
  assert.equal(
    summarizeDevelopmentLogOperation([
      invocation(1, "workflow.accepted"),
      ...state,
      invocation(4, "workflow.finished", { outcome: "succeeded" }),
    ]).execution,
    "returned",
  );
});

test("HTTP status is explicit metadata rather than text inference and grouping retains no external state", () => {
  const event = invocation(1, "lambda.output", {
    message: "HTTP 200",
    details: { statusCode: 401, result: { statusCode: 500 } },
  });
  assert.equal(summarizeDevelopmentLogOperation([event]).httpStatus, undefined);
  const events = Object.freeze(
    Array.from({ length: 1000 }, (_, index) =>
      invocation(index, "lambda.invocation.started", {
        correlation: { invocationId: `invoke-${index}` },
      }),
    ),
  );
  assert.equal(groupDevelopmentLogOperations(events).length, 1000);
  assert.equal(groupDevelopmentLogOperations([]).length, 0);
  assert.equal(events[0]!.kind, "lambda.invocation.started");
});

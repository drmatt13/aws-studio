import assert from "./support/assert";
import { test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { developmentLogsRouter } from "../server/development-logs";
import { AgentLabService, conversationPrompt } from "../server/agent-lab";
import { buildSightline } from "../src/sightline/build";
import { newestEvidenceTraceId } from "../src/sightline/logs";
import { buildConversationContext } from "../src/sightline/agent-context";
import {
  CONVERSATION_CONTEXT_LIMIT,
  parseConversationContext,
  type ConversationContext,
} from "../shared/agent-context";
import { buildDevelopmentTrace } from "../shared/development-traces";
import type {
  DevelopmentLogEvent,
  DevelopmentLogEvidence,
} from "../shared/development-logs";
import type { SightlineInputs } from "../src/sightline/types";
import { snapshot } from "./browser/support/scenarios";
import { logEvent, logPage, logRun, logTime } from "./support/development-logs";
import { DEVELOPMENT_LOG_LIMITS } from "aws-studio/development-logs/contract";

const at = (seconds: number) =>
  new Date(Date.parse(logTime) + seconds * 1000).toISOString();
/** One record with nothing inherited from the failure-shaped fixture default. */
const record = (
  sequence: number,
  overrides: Partial<DevelopmentLogEvent>,
): DevelopmentLogEvent =>
  logEvent(sequence, {
    eventId: `event-${sequence}`,
    occurredAt: at(sequence),
    observedAt: at(sequence),
    relatedResourceIds: [],
    level: "info",
    stream: "event",
    attribution: "invocation",
    message: undefined,
    details: undefined,
    outcome: undefined,
    phase: undefined,
    correlation: {},
    omissions: [],
    ...overrides,
  });
const identity = (name: string) => ({
  traceId: `trace-${name}`,
  requestId: `request-${name}`,
  invocationId: `invocation-${name}`,
  spanId: `span-${name}`,
});
const started = (sequence: number, name: string) =>
  record(sequence, {
    kind: "lambda.invocation.started",
    phase: "started",
    correlation: identity(name),
  });
const completed = (sequence: number, name: string, status = 200) =>
  record(sequence, {
    kind: "lambda.invocation.completed",
    phase: "completed",
    outcome: "succeeded",
    durationMs: 25,
    correlation: identity(name),
    details: {
      result: { statusCode: status },
      http: { status, source: "handler-result" },
    },
  });
const failed = (sequence: number, name: string, error: unknown) =>
  record(sequence, {
    kind: "lambda.invocation.failed",
    level: "error",
    phase: "completed",
    outcome: "failed",
    durationMs: 41,
    correlation: identity(name),
    details: { error },
  });
/** Producers label every stderr line `error`, whatever it says. */
const output = (
  sequence: number,
  name: string | undefined,
  message: string,
  stream: "stdout" | "stderr" = "stdout",
) =>
  record(sequence, {
    kind: "lambda.output",
    stream,
    level: stream === "stderr" ? "error" : "info",
    message,
    attribution: name ? "invocation" : "worker",
    correlation: name ? identity(name) : {},
    details: { workerId: "worker-1" },
  });
const typeError = {
  name: "TypeError",
  message: "Cannot read properties of undefined (reading 'id')",
  stack:
    "TypeError: Cannot read properties of undefined (reading 'id')\n    at getOrder (/var/task/src/orders.ts:42:17)\n    at handler (/var/task/src/handler.ts:18:9)",
};
const deprecation = "(node:1) DeprecationWarning: Buffer() is deprecated";

/** The real evidence route over a bounded cache projection, including reserved-kind selection. */
async function readEvidence(
  events: readonly DevelopmentLogEvent[],
  page: Partial<ReturnType<typeof logPage>> = {},
): Promise<DevelopmentLogEvidence> {
  const app = express();
  app.use(
    "/logs",
    developmentLogsRouter({
      model: () => snapshot().snapshot.models.dev,
      readRuns: async () => [logRun],
      readEntries: async (query) => {
        const ordered = [...events].sort(
          (a, b) => b.ingestSequence - a.ingestSequence,
        );
        const scanned = ordered.slice(0, DEVELOPMENT_LOG_LIMITS.scanRecords);
        const matching = scanned.filter(
          (event) => !query.level || event.level === query.level,
        );
        const limit = query.limit ?? 200;
        const selected = matching.slice(0, limit);
        const reserved = matching.find((event) =>
          query.reserveKinds?.includes(event.kind),
        );
        if (reserved && !selected.includes(reserved))
          selected[selected.length - 1] = reserved;
        const scanLimited =
          ordered.length > scanned.length &&
          (matching.length < limit || (!!query.reserveKinds && !reserved));
        return {
          ...logPage(selected),
          observedAt: at(40),
          ...(matching.length > limit || scanLimited
            ? { olderCursor: "older" }
            : {}),
          ...(scanLimited
            ? {
                gaps: [
                  {
                    reason: "truncated" as const,
                    at: at(40),
                    message: "This page reached the bounded cache scan limit.",
                  },
                ],
              }
            : {}),
          ...page,
        };
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/logs/evidence?mode=dev&resource=lambda%3Afixture-0&limit=24`,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as DevelopmentLogEvidence;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function inputs(evidence?: DevelopmentLogEvidence): SightlineInputs {
  return {
    capturedAt: logTime,
    pathname: "/",
    snapshot: snapshot().snapshot,
    mode: "dev",
    selected: "lambda:fixture-0",
    source: {
      latestRevision: "browser-revision",
      evaluating: false,
      dirty: false,
      conflicted: false,
      connected: true,
    },
    aliases: {},
    workspace: {},
    deployments: {
      dev: {
        availability: "missing-profile",
        observed: { availability: "not-loaded" },
      },
      prod: {
        availability: "missing-profile",
        observed: { availability: "not-loaded" },
      },
    },
    activity: { availability: "available", jobs: [] },
    developmentLogs: evidence
      ? { availability: "available", evidence }
      : undefined,
  };
}
const traceOf = (
  events: readonly DevelopmentLogEvent[],
  name: string,
  complete = true,
) =>
  buildDevelopmentTrace({
    ...logPage(
      events.filter((event) => event.correlation.traceId === `trace-${name}`),
    ),
    traceId: `trace-${name}`,
    complete,
  });
/** What the provider is handed: the browser capture after the server's validation and re-sanitization. */
async function received(
  context: ConversationContext,
): Promise<ConversationContext> {
  let captured: ConversationContext | undefined;
  const service = new AgentLabService({
    answer: async (_provider, _messages, _signal, _model, evidence) => {
      captured = evidence;
      return { answer: "captured" };
    },
  });
  try {
    await service.chat({
      provider: "codex",
      messages: [{ role: "user", content: "What happened to this Lambda?" }],
      context: JSON.stringify(context),
    });
  } finally {
    service.dispose();
  }
  assert.ok(captured, "the provider received a context");
  return captured;
}

/** A failed request, 26 noise lines with five stderr warnings, then a completed request. */
function regression(): DevelopmentLogEvent[] {
  const events = [
    started(1, "failed"),
    record(2, {
      kind: "lambda.worker",
      phase: "warm",
      correlation: identity("failed"),
    }),
    failed(3, "failed", typeError),
  ];
  for (let index = 0; index < 26; index++)
    events.push(
      index % 5 === 2
        ? output(4 + index, undefined, deprecation, "stderr")
        : index % 2
          ? output(4 + index, `noise-${index}`, `handled tick ${index}`)
          : output(4 + index, undefined, `cache refresh ${index}`),
    );
  events.push(
    started(30, "ok"),
    record(31, {
      kind: "lambda.worker",
      phase: "warm",
      correlation: identity("ok"),
    }),
    output(32, "ok", "Loaded order order-9"),
    completed(33, "ok"),
    output(34, "ok", "flushed metrics"),
  );
  return events;
}

test("a failed invocation survives 26 noise lines with five stderr warnings and stays distinct from the newer 200", async () => {
  const events = regression(),
    evidence = await readEvidence(events);
  assert.deepEqual(
    evidence.executions.map((execution) => execution.invocationId),
    ["invocation-ok", "invocation-failed"],
  );
  // 24 recent records plus the two older error-level records the second read adds.
  assert.deepEqual(evidence.window, {
    records: 26,
    olderUnread: true,
    olderErrorsUnread: false,
  });
  const value = inputs(evidence),
    sightline = buildSightline(value);
  assert.ok(JSON.stringify(sightline.developmentLogs).length <= 3_200);
  assert.ok(JSON.stringify(sightline).length <= 12_000);
  const context = await received(
    buildConversationContext(
      sightline,
      traceOf(events, "ok"),
      value.snapshot.models.dev,
    ),
  );
  assert.ok(JSON.stringify(context).length <= CONVERSATION_CONTEXT_LIMIT);
  const [ok, broken] = context.observations.executions ?? [];
  assert.deepEqual(ok, {
    invocationId: "invocation-ok",
    traceId: "trace-ok",
    outcome: "returned",
    httpStatus: 200,
    httpStatusSource: "handler-result",
    durationMs: 25,
    workerMode: "warm",
    startObserved: true,
    endedAt: at(33),
    ageSeconds: 7,
  });
  assert.equal(broken?.invocationId, "invocation-failed");
  assert.equal(broken?.traceId, "trace-failed");
  assert.equal(broken?.outcome, "failed");
  assert.equal(broken?.httpStatus, undefined, "a thrown handler has no status");
  assert.equal(broken?.durationMs, 41);
  assert.equal(broken?.endedAt, at(3));
  assert.equal(broken?.ageSeconds, 37);
  assert.equal(broken?.startObserved, false, "its start was never read");
  assert.match(
    broken?.error ?? "",
    /^TypeError: Cannot read properties of undefined \(reading 'id'\) at getOrder \(\/var\/task\/src\/orders\.ts:42:17\)/,
  );
  assert.equal(context.observations.executions?.length, 2);
  // The single remaining slot outside executions goes to unattributed error-level output, labelled as such.
  assert.equal(context.observations.entries.length, 1);
  assert.equal(context.observations.entries[0]?.excerpt, deprecation);
  assert.equal(context.observations.entries[0]?.level, "error");
  assert.equal(context.observations.entries[0]?.attribution, "worker");
  assert.deepEqual(context.observations.entries[0]?.correlation, {});
  // Eight single-line invocations and 19 records were read but left out; four of those are stderr noise.
  assert.deepEqual(context.observations.excluded, {
    executions: 8,
    failed: 0,
    records: 19,
    errorLevel: 4,
  });
  assert.deepEqual(context.observations.window, evidence.window);
  assert.equal(context.trace?.id, "trace-ok");
  const prompt = conversationPrompt(
    [{ role: "user", content: "What happened to this Lambda?" }],
    context,
  );
  assert.ok(prompt.includes('"invocationId":"invocation-failed"'));
  assert.ok(prompt.includes('"invocationId":"invocation-ok"'));
});

test("a returned invocation that wrote stderr warnings is not classified as failed", async () => {
  const evidence = await readEvidence([
    failed(1, "older", typeError),
    started(2, "warned"),
    output(3, "warned", deprecation, "stderr"),
    completed(4, "warned"),
    started(5, "clean"),
    completed(6, "clean"),
  ]);
  // If stderr made "warned" a failure, it would outrank the older real one for the failed slot.
  assert.deepEqual(
    evidence.executions.map((execution) => execution.invocationId),
    ["invocation-clean", "invocation-older", "invocation-warned"],
  );
  const value = inputs(evidence),
    context = await received(
      buildConversationContext(
        buildSightline(value),
        undefined,
        value.snapshot.models.dev,
      ),
    );
  const warned = context.observations.executions?.find(
    (execution) => execution.invocationId === "invocation-warned",
  );
  assert.equal(warned?.outcome, "returned");
  assert.equal(warned?.httpStatus, 200);
  assert.equal(warned?.error, undefined);
  assert.equal(warned?.errorLevelOutput, deprecation);
  assert.equal(context.observations.excluded?.failed, 0);
});

test("a missing start, a running execution and an incomplete trace stay distinguishable from a whole execution", async () => {
  const events = [
    completed(1, "cut-off"),
    started(2, "running"),
    output(3, "running", "still working"),
    started(4, "whole"),
    completed(5, "whole"),
  ];
  const value = inputs(await readEvidence(events)),
    context = await received(
      buildConversationContext(
        buildSightline(value),
        traceOf(events, "whole", false),
        value.snapshot.models.dev,
      ),
    );
  const by = (name: string) =>
    context.observations.executions?.find(
      (execution) => execution.invocationId === `invocation-${name}`,
    );
  assert.deepEqual(by("whole"), {
    invocationId: "invocation-whole",
    traceId: "trace-whole",
    outcome: "returned",
    httpStatus: 200,
    httpStatusSource: "handler-result",
    durationMs: 25,
    startObserved: true,
    endedAt: at(5),
    ageSeconds: 35,
  });
  // No terminal record: no outcome, status, duration or end time is made up for it.
  assert.deepEqual(by("running"), {
    invocationId: "invocation-running",
    traceId: "trace-running",
    outcome: "unobserved",
    startObserved: true,
    lastRecordAt: at(3),
    ageSeconds: 37,
  });
  assert.equal(by("cut-off")?.startObserved, false);
  assert.equal(by("cut-off")?.outcome, "returned");
  // The trace belongs to one execution and its incompleteness is its own.
  assert.equal(context.trace?.id, "trace-whole");
  assert.equal(context.trace?.complete, false);
});

test("the failure excerpt keeps its location within the bound and never carries private paths, accounts or credentials", async () => {
  const stack =
    "Error: Order lookup failed for account 123456789012 token=AUTH_TOKEN_CANARY secret=s password=p\n    at getOrder (/var/task/src/orders.ts:42:17)\n    at load (/Users/alice/private-project/src/load.ts:7:3)\n" +
    "    at next (/var/task/node_modules/lib/index.js:1:1)\n".repeat(40);
  const value = inputs(
      await readEvidence([
        started(1, "leaky"),
        failed(2, "leaky", {
          name: "Error",
          message: "Order lookup failed",
          stack,
        }),
      ]),
    ),
    captured = buildConversationContext(
      buildSightline(value),
      undefined,
      value.snapshot.models.dev,
    );
  assert.equal(captured.observations.executions?.[0]?.error?.length, 240);
  // The server's redaction markers are longer than these short secrets; a full excerpt must still be accepted.
  const context = await received(captured);
  const error = context.observations.executions?.[0]?.error ?? "";
  assert.ok(error.includes("at getOrder (/var/task/src/orders.ts:42:17)"));
  assert.ok(error.length <= 360, `excerpt is ${error.length} characters`);
  assert.ok(error.endsWith("…"), "a cut excerpt says so");
  assert.ok(!error.includes("\n"));
  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes("/Users/alice"));
  assert.ok(!serialized.includes("123456789012"));
  assert.ok(!serialized.includes("AUTH_TOKEN_CANARY"));
});

test("interleaved invocations of one request never share an outcome, status, excerpt or trace", async () => {
  const shared = (name: string) => ({
    ...identity(name),
    requestId: "request-shared",
  });
  const evidence = await readEvidence([
    { ...started(1, "a"), correlation: shared("a") },
    { ...started(2, "b"), correlation: shared("b") },
    { ...output(3, "b", "b warned", "stderr"), correlation: shared("b") },
    {
      ...failed(4, "a", {
        name: "Error",
        message: "a exploded",
        stack: "Error: a exploded\n    at a (/var/task/a.ts:1:1)",
      }),
      correlation: shared("a"),
    },
    { ...completed(5, "b", 201), correlation: shared("b") },
  ]);
  const value = inputs(evidence),
    context = await received(
      buildConversationContext(
        buildSightline(value),
        undefined,
        value.snapshot.models.dev,
      ),
    );
  assert.deepEqual(context.observations.executions, [
    {
      invocationId: "invocation-b",
      traceId: "trace-b",
      outcome: "returned",
      httpStatus: 201,
      httpStatusSource: "handler-result",
      durationMs: 25,
      startObserved: true,
      endedAt: at(5),
      ageSeconds: 35,
      errorLevelOutput: "b warned",
    },
    {
      invocationId: "invocation-a",
      traceId: "trace-a",
      outcome: "failed",
      durationMs: 41,
      startObserved: true,
      endedAt: at(4),
      ageSeconds: 36,
      error: "Error: a exploded at a (/var/task/a.ts:1:1)",
    },
  ]);
});

test("tight budgets drop whole digests and keep the excluded counts true", async () => {
  const longStack = (name: string) => ({
    name: "Error",
    message: `${name} failed`,
    stack:
      `Error: ${name} failed\n` +
      "    at step (/var/task/x.ts:1:1)\n".repeat(60),
  });
  const events = [
    ...["one", "two", "three"].flatMap((name, index) => [
      started(index * 2 + 1, name),
      failed(index * 2 + 2, name, longStack(name)),
    ]),
    ...[7, 8, 9, 10].map((sequence) =>
      output(sequence, undefined, "stderr noise ".repeat(60), "stderr"),
    ),
  ];
  const evidence = await readEvidence(events);
  assert.equal(evidence.window.records, 10);
  const value = inputs(evidence),
    sightline = buildSightline(value),
    logs = sightline.developmentLogs as unknown as {
      executions: { records: number; outcome: string }[];
      entries: unknown[];
      excluded: NonNullable<ConversationContext["observations"]["excluded"]>;
    };
  assert.ok(JSON.stringify(logs).length <= 3_200);
  // Ten records were read: every one is shown or counted, whatever the budget removed.
  assert.equal(
    logs.executions.reduce((sum, execution) => sum + execution.records, 0) +
      logs.entries.length +
      logs.excluded.records,
    10,
  );
  assert.equal(logs.executions.length + logs.excluded.executions, 3);
  assert.ok(
    logs.excluded.records > evidence.excluded.records,
    "the Sightline budget removed something",
  );
  // A maximal focus and trace leave the Conversation envelope too small for three digests.
  const focusId = `lambda:${"f".repeat(590)}`,
    longId = "t".repeat(256),
    wide = "w".repeat(240);
  const crowded = structuredClone(sightline) as typeof sightline;
  Object.assign(crowded.focus!, {
    id: focusId,
    name: "n".repeat(240),
    description: "d".repeat(400),
    declared: {
      kind: wide,
      role: wide,
      targetId: wide,
      constructId: wide,
      compute: { runtime: wide },
    },
  });
  const trace = buildDevelopmentTrace({
    ...logPage([
      record(1, {
        resource: { id: focusId, kind: "lambda" },
        kind: "lambda.invocation.completed",
        outcome: "succeeded",
        correlation: { traceId: longId, spanId: longId },
      }),
    ]),
    traceId: longId,
    complete: true,
  });
  const context = parseConversationContext(
    JSON.stringify(
      buildConversationContext(crowded, trace, value.snapshot.models.dev),
    ),
  );
  assert.ok(JSON.stringify(context).length <= CONVERSATION_CONTEXT_LIMIT);
  const shown = context.observations.executions ?? [];
  assert.ok(shown.length >= 1 && shown.length < logs.executions.length);
  assert.equal(shown.length + context.observations.excluded!.executions, 3);
  assert.equal(
    shown.filter((execution) => execution.outcome === "failed").length +
      context.observations.excluded!.failed,
    3,
    "a dropped failure is still counted as a failure",
  );
});

test("Production never carries development executions and the server rejects a context that tries", async () => {
  const value = inputs(await readEvidence(regression())),
    dev = buildConversationContext(buildSightline(value)),
    prodSightline = buildSightline({ ...value, mode: "prod" }),
    prod = buildConversationContext(prodSightline);
  assert.equal(prodSightline.developmentLogs.availability, "not-applicable");
  assert.ok(!JSON.stringify(prodSightline).includes("invocation-failed"));
  assert.equal(prod.observations.executions, undefined);
  assert.equal(prod.observations.window, undefined);
  assert.equal(prod.observations.excluded, undefined);
  for (const smuggled of [
    { executions: dev.observations.executions },
    { window: dev.observations.window },
    { excluded: dev.observations.excluded },
  ])
    assert.throws(
      () =>
        parseConversationContext(
          JSON.stringify({
            ...prod,
            observations: { ...prod.observations, ...smuggled },
          }),
        ),
      /Production/,
    );
});

test("a reserved terminal failure survives a supplemental read saturated by stderr", async () => {
  const events = [
    failed(1, "lost", typeError),
    ...Array.from({ length: 8 }, (_, index) =>
      output(2 + index, undefined, deprecation, "stderr"),
    ),
    ...Array.from({ length: 20 }, (_, index) =>
      output(10 + index, undefined, `cache refresh ${index}`),
    ),
    started(30, "ok"),
    completed(31, "ok"),
  ];
  const evidence = await readEvidence(events);
  assert.deepEqual(
    evidence.executions.map((execution) => execution.invocationId),
    ["invocation-ok", "invocation-lost"],
  );
  assert.equal(evidence.excluded.failed, 0);
  const value = inputs(evidence),
    context = await received(
      buildConversationContext(
        buildSightline(value),
        traceOf(events, "ok"),
        value.snapshot.models.dev,
      ),
    );
  const failure = context.observations.executions?.find(
    (execution) => execution.invocationId === "invocation-lost",
  );
  assert.equal(failure?.outcome, "failed");
  assert.match(failure?.error ?? "", /TypeError:.*orders\.ts:42:17/);
  assert.equal(failure?.startObserved, false);
  // A complete trace for the 200 says nothing about the resource: older error-level records were not read.
  assert.equal(context.trace?.complete, true);
  // The eight supplemental records include the failure and seven stderr lines,
  // two of which overlap the recent tail. One stderr line remains unread.
  assert.deepEqual(context.observations.window, {
    records: 30,
    olderUnread: true,
    olderErrorsUnread: true,
  });
  const prompt = conversationPrompt(
    [{ role: "user", content: "Is this Lambda healthy?" }],
    context,
  );
  assert.ok(prompt.includes('"olderErrorsUnread":true'));
  // The prompt must explain the fields the payload uses to say evidence is missing.
  assert.ok(prompt.includes('"invocationId":"invocation-lost"'));
  assert.ok(prompt.includes('"invocationId":"invocation-ok"'));
  for (const field of ["olderErrorsUnread", "unobserved", "startObserved"])
    assert.ok(
      prompt.split("Captured Studio context")[0]!.includes(field),
      `the instructions explain ${field}`,
    );
});

test("a failure beyond the bounded scan remains explicitly unread in the final prompt", async () => {
  const events = [
    failed(1, "beyond-scan", typeError),
    ...Array.from({ length: DEVELOPMENT_LOG_LIMITS.scanRecords }, (_, index) =>
      output(index + 2, undefined, `cache refresh ${index}`),
    ),
    started(DEVELOPMENT_LOG_LIMITS.scanRecords + 2, "ok"),
    completed(DEVELOPMENT_LOG_LIMITS.scanRecords + 3, "ok"),
  ];
  const evidence = await readEvidence(events);
  const value = inputs(evidence);
  const context = await received(
    buildConversationContext(buildSightline(value)),
  );
  assert.deepEqual(
    context.observations.executions?.map((item) => item.invocationId),
    ["invocation-ok"],
  );
  assert.equal(context.observations.window?.olderUnread, true);
  assert.equal(context.observations.window?.olderErrorsUnread, true);
  assert.deepEqual(context.observations.gapReasons, ["truncated"]);
  const prompt = conversationPrompt(
    [{ role: "user", content: "Is this Lambda healthy?" }],
    context,
  );
  assert.ok(!prompt.includes("invocation-beyond-scan"));
  assert.ok(prompt.includes('"olderErrorsUnread":true'));
});

test("unavailable evidence and cache gaps reach the model as missing evidence, never as an empty healthy window", async () => {
  const none = buildConversationContext(buildSightline(inputs()));
  assert.equal(none.observations.availability, "not-loaded");
  assert.equal(none.observations.executions, undefined);
  assert.equal(none.observations.window, undefined);
  assert.equal(none.observations.excluded, undefined);
  const evidence = await readEvidence(
    [started(1, "interrupted"), output(2, "interrupted", "working")],
    {
      gaps: [
        {
          reason: "restart",
          at: at(3),
          message: "The collector restarted; uncommitted evidence was lost.",
        },
      ],
    },
  );
  const value = inputs(evidence),
    context = await received(
      buildConversationContext(
        buildSightline(value),
        undefined,
        value.snapshot.models.dev,
      ),
    );
  assert.deepEqual(context.observations.gapReasons, ["restart"]);
  assert.equal(context.observations.executions?.[0]?.outcome, "unobserved");
  assert.equal(context.observations.executions?.[0]?.endedAt, undefined);
});

test("outside executions, a recorded failure event outranks newer stderr output for the remaining slot", async () => {
  const evidence = await readEvidence([
    record(1, {
      kind: "lambda.exited_without_result",
      level: "error",
      attribution: "worker",
    }),
    ...Array.from({ length: 5 }, (_, index) =>
      output(2 + index, undefined, deprecation, "stderr"),
    ),
    started(7, "ok"),
    completed(8, "ok"),
    started(9, "next"),
    completed(10, "next"),
  ]);
  assert.equal(evidence.entries[0]?.kind, "lambda.exited_without_result");
  const value = inputs(evidence),
    context = buildConversationContext(
      buildSightline(value),
      undefined,
      value.snapshot.models.dev,
    );
  assert.deepEqual(
    context.observations.entries.map((entry) => entry.kind),
    ["lambda.exited_without_result"],
  );
  assert.equal(context.observations.excluded?.errorLevel, 5);
});

test("the trace read follows the newest execution or outside record that names a trace", async () => {
  assert.equal(
    newestEvidenceTraceId(await readEvidence(regression())),
    "trace-ok",
  );
  const later = await readEvidence([
    ...regression(),
    record(35, {
      kind: "lambda.worker",
      attribution: "worker",
      correlation: { traceId: "trace-later" },
    }),
  ]);
  assert.equal(newestEvidenceTraceId(later), "trace-later");
  assert.equal(newestEvidenceTraceId(undefined), undefined);
});

test("the latest terminal execution is the one that ended last, not the one that logged last", async () => {
  const evidence = await readEvidence([
    started(1, "earlier"),
    completed(2, "earlier"),
    started(3, "later"),
    completed(4, "later", 503),
    output(5, "earlier", "late flush from the earlier invocation"),
  ]);
  assert.deepEqual(
    evidence.executions.map((execution) => [
      execution.invocationId,
      execution.httpStatus,
    ]),
    [
      ["invocation-later", 503],
      ["invocation-earlier", 200],
    ],
  );
  // The trace read follows the same order.
  assert.equal(newestEvidenceTraceId(evidence), "trace-later");
});

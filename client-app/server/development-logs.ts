import express from "express";
import type { ModeModel } from "../shared/model";
import {
  developmentExecutionFailed,
  type DevelopmentLogEvent,
  type DevelopmentLogEvidence,
  type DevelopmentLogExcerpt,
  type DevelopmentLogExecution,
  type DevelopmentLogPage,
  type DevelopmentLogRun,
} from "../shared/development-logs";
import {
  developmentLogScope,
  type DevelopmentLogScope,
} from "../shared/development-log-scope";
import type {
  DevelopmentLogQuery,
  DevelopmentLogTraceQuery,
  DevelopmentLogTracePage,
} from "aws-studio/development-logs/contract";
import {
  buildDevelopmentTrace,
  type DevelopmentTrace,
} from "../shared/development-traces";
import { sendJson } from "./http";
import {
  groupDevelopmentLogOperations,
  summarizeDevelopmentLogOperation,
  type DevelopmentLogOperation,
} from "../shared/development-log-operations";
import {
  developmentHttpStatus,
  developmentHttpStatusSource,
  developmentDuration,
  developmentWorkerMode,
} from "../shared/development-log-outcomes";

export interface DevelopmentLogReadOwner {
  model(): ModeModel;
  readRuns(): Promise<readonly DevelopmentLogRun[]>;
  readEntries(query: DevelopmentLogQuery): Promise<DevelopmentLogPage>;
  readTrace?(query: DevelopmentLogTraceQuery): Promise<DevelopmentLogTracePage>;
}
async function readCache<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if ((error as { status?: number })?.status === 400) throw error;
    throw Object.assign(
      new Error("Development log cache is unavailable. Refresh to retry."),
      { status: 503 },
    );
  }
}
const bad = (message: string): never => {
  throw Object.assign(new Error(message), { status: 400 });
};
const text = (
  value: unknown,
  name: string,
  limit: number,
): string | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > limit ||
    /[\u0000-\u001f]/.test(value)
  )
    return bad(`Choose a valid ${name}.`);
  return value;
};
const levelNames = ["debug", "info", "warn", "error"];
// Error-level terminal events, rather than output written to stderr. These kinds
// use the existing operation outcome policy after retrieval; severity is not an outcome.
const terminalErrorKinds = [
  "lambda.invocation.failed",
  "lambda.invocation.timed-out",
  "lambda.failed",
  "lambda.timeout",
  "http.response.aborted",
  "workflow.finished",
  "task.finished",
  "agent.turn_failed",
  "agent.invocation_failed",
];
export function readDevelopmentLogQuery(
  query: Record<string, unknown>,
  model: ModeModel,
  evidence = false,
): { query: DevelopmentLogQuery; scope?: DevelopmentLogScope } {
  if (query.mode !== "dev")
    bad(
      "Development log cache reads require Source: Development. Production log collection is not implemented.",
    );
  const allowed = [
    "mode",
    "resource",
    "runId",
    "limit",
    "cursor",
    "direction",
    "search",
    "level",
    "stream",
    "kind",
  ];
  if (Object.keys(query).some((key) => !allowed.includes(key)))
    bad("Unsupported development log query field.");
  const resource = text(query.resource, "resource identity", 600);
  const scope =
    resource === undefined ? undefined : developmentLogScope(model, resource);
  if (resource !== undefined && !scope)
    bad("Choose a resource in the accepted development model.");
  if (scope?.kind === "not-applicable")
    bad("This declaration has no local execution log stream.");
  const runId = text(query.runId, "runtime run", 160);
  if (runId !== undefined && !/^[A-Za-z0-9_-]+$/.test(runId))
    bad("Choose a valid runtime run.");
  const limit =
    query.limit === undefined ? (evidence ? 24 : 100) : Number(query.limit);
  if (
    Array.isArray(query.limit) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > (evidence ? 24 : 200)
  )
    bad(`Log page size must be between 1 and ${evidence ? 24 : 200}.`);
  const direction = text(query.direction, "cursor direction", 10);
  if (direction !== undefined && direction !== "older" && direction !== "newer")
    bad("Choose older or newer log entries.");
  const level = text(query.level, "log level", 10);
  if (level !== undefined && !levelNames.includes(level))
    bad("Choose a supported log level.");
  const stream = text(query.stream, "log stream", 20);
  if (stream !== undefined && !["stdout", "stderr", "event"].includes(stream))
    bad("Choose a supported log stream.");
  return {
    scope,
    query: {
      ...(scope
        ? { resourceIds: scope.resourceIds, routeId: scope.routeId }
        : {}),
      ...(runId ? { runId } : {}),
      limit,
      ...(direction ? { direction: direction as "older" | "newer" } : {}),
      ...(query.cursor === undefined
        ? {}
        : { cursor: text(query.cursor, "log cursor", 2048) }),
      ...(query.search === undefined
        ? {}
        : { search: text(query.search, "log search", 128) }),
      ...(level ? { level: level as DevelopmentLogQuery["level"] } : {}),
      ...(stream ? { stream: stream as DevelopmentLogQuery["stream"] } : {}),
      ...(query.kind === undefined
        ? {}
        : { kind: text(query.kind, "event kind", 120) }),
    },
  };
}

function excerpt(
  event: DevelopmentLogPage["entries"][number],
): DevelopmentLogExcerpt {
  const details =
    event.details === undefined ? undefined : JSON.stringify(event.details);
  const message = event.message?.slice(0, 400);
  return {
    ingestSequence: event.ingestSequence,
    eventId: event.eventId,
    resourceId: event.resource.id,
    runtimeSessionId: event.runtimeSessionId,
    at: event.occurredAt,
    level: event.level,
    kind: event.kind,
    outcome: event.outcome,
    httpStatus: developmentHttpStatus(event),
    httpStatusSource: developmentHttpStatusSource(event),
    durationMs: developmentDuration(event),
    workerMode: developmentWorkerMode(event),
    attribution: event.attribution,
    ...(message ? { message } : {}),
    ...(details ? { detailsPreview: details.slice(0, 160) } : {}),
    correlation: event.correlation,
    truncated:
      (event.message?.length ?? 0) > 400 ||
      (details?.length ?? 0) > 160 ||
      event.omissions.length > 0,
  };
}

const bounded = (value: string, limit = 400) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const fields = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** A recorded failure on one line. A stack keeps the location that the message alone lacks. */
function recordedError(event?: DevelopmentLogEvent): string | undefined {
  const error = fields(event?.details)?.error,
    parts = fields(error);
  const text =
    typeof error === "string"
      ? error
      : typeof parts?.stack === "string"
        ? parts.stack
        : typeof parts?.message === "string"
          ? [parts.name, parts.message]
              .filter((part) => typeof part === "string")
              .join(": ")
          : undefined;
  return text?.replace(/\s*\n\s*/g, " ").trim() || undefined;
}
/** Every field comes from this operation's own records and the shared outcome policy. */
function execution(
  operation: DevelopmentLogOperation,
  observedAt: string,
): DevelopmentLogExecution {
  const { summary, events } = operation,
    last = events.at(-1)!,
    newestFirst = [...events].reverse();
  const key = operation.kind === "invocation" ? "invocationId" : "requestId";
  const identity = events.find((event) => event.correlation[key])?.correlation[
    key
  ];
  const error = recordedError(
    newestFirst.find((event) => fields(event.details)?.error !== undefined),
  );
  const output = newestFirst.find(
    (event) => event.level === "error" && event.message,
  )?.message;
  // Late output must not make an older execution look like the most recent outcome.
  const end = summary.endedAt
    ? newestFirst.find(
        (event) =>
          summarizeDevelopmentLogOperation([event]).endedAt !== undefined,
      )
    : undefined;
  const age = Math.round(
    (Date.parse(observedAt) - Date.parse(summary.endedAt ?? last.occurredAt)) /
      1000,
  );
  return {
    sequence: (end ?? last).ingestSequence,
    resourceId: operation.resourceId,
    ...(identity ? { [key]: identity } : {}),
    ...(operation.traceId ? { traceId: operation.traceId } : {}),
    outcome: summary.execution,
    ...(summary.httpStatus === undefined
      ? {}
      : { httpStatus: summary.httpStatus }),
    ...(summary.httpStatusSource
      ? { httpStatusSource: summary.httpStatusSource }
      : {}),
    ...(summary.durationMs === undefined
      ? {}
      : { durationMs: summary.durationMs }),
    ...(summary.worker ? { workerMode: summary.worker } : {}),
    startObserved: !summary.missingStart,
    ...(summary.endedAt
      ? { endedAt: summary.endedAt }
      : { lastRecordAt: last.occurredAt }),
    ...(Number.isFinite(age) && age >= 0 ? { ageSeconds: age } : {}),
    ...(error
      ? { error: bounded(error) }
      : output
        ? { errorLevelOutput: bounded(output) }
        : {}),
    records: events.length,
    errorLevel: events.filter((event) => event.level === "error").length,
  };
}

/** Reads sanitized cache bytes only. It never starts a collector or runs operational commands. */
export function developmentLogsRouter(owner: DevelopmentLogReadOwner) {
  const router = express.Router();
  router.get("/trace", (request, response) =>
    sendJson(response, async (): Promise<DevelopmentTrace> => {
      const query = request.query;
      if (
        Object.keys(query).some(
          (key) => !["mode", "resource", "runId", "traceId"].includes(key),
        )
      )
        bad("Unsupported development trace query field.");
      const parsed = readDevelopmentLogQuery(
        { mode: query.mode, resource: query.resource, runId: query.runId },
        owner.model(),
      );
      const traceId = text(query.traceId, "trace identity", 256),
        runId = parsed.query.runId;
      if (!parsed.scope || parsed.scope.kind === "unsupported")
        bad("Choose a resource with local development trace evidence.");
      if (
        !traceId ||
        !/^[A-Za-z0-9_.:/-]+$/.test(traceId) ||
        !runId ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)
      )
        bad("Choose a valid trace and its original runtime run.");
      // Scope ownership is proven from sanitized cache evidence, never from an arbitrary trace ID.
      const anchor = owner.readTrace
        ? await readCache(() =>
            owner.readTrace!({
              runId: runId!,
              traceId: traceId!,
              resourceIds: parsed.query.resourceIds,
              routeId: parsed.query.routeId,
              limit: 24,
            }),
          )
        : await readCache(() =>
            owner.readEntries({ ...parsed.query, search: traceId, limit: 24 }),
          );
      const anchored =
        anchor.run?.runtimeSessionId === runId &&
        anchor.entries.some(
          (event) =>
            event.runtimeSessionId === runId &&
            event.correlation.traceId === traceId,
        );
      let page: DevelopmentLogTracePage;
      if (!anchored)
        page = {
          ...anchor,
          entries: [],
          traceId: traceId!,
          complete: false,
          gaps: [
            ...anchor.gaps,
            {
              reason: "source-unavailable",
              at: anchor.observedAt,
              message:
                "This resource has no retained evidence for the requested trace.",
            },
          ],
        };
      else if (owner.readTrace)
        page = await readCache(() =>
          owner.readTrace!({ runId: runId!, traceId: traceId!, limit: 200 }),
        );
      else
        page = {
          ...anchor,
          traceId: traceId!,
          complete: false,
          gaps: [
            ...anchor.gaps,
            {
              reason: "source-unavailable",
              at: anchor.observedAt,
              message:
                "Cross-resource trace evidence is unavailable from this cache reader.",
            },
          ],
        };
      let result = buildDevelopmentTrace(page);
      let omittedEvents = 0;
      // The reconstructed model and its source events share one bounded response envelope.
      while (
        Buffer.byteLength(JSON.stringify(result)) > 256 * 1024 &&
        page.entries.length
      ) {
        omittedEvents++;
        page = {
          ...page,
          entries: page.entries.slice(1),
          complete: false,
          gaps: [
            ...page.gaps.filter(
              (gap) => !gap.message.includes("bounded trace response"),
            ),
            {
              reason: "truncated" as const,
              at: page.observedAt,
              count: omittedEvents,
              message: "Older events are outside the bounded trace response.",
            },
          ].slice(-64),
        };
        result = buildDevelopmentTrace(page);
      }
      return result;
    }),
  );
  router.get("/runs", (request, response) =>
    sendJson(response, async () => {
      if (
        request.query.mode !== "dev" ||
        Object.keys(request.query).some((key) => key !== "mode")
      )
        bad("Development run reads require mode=dev.");
      return {
        schemaVersion: 1,
        runs: await readCache(() => owner.readRuns()),
      };
    }),
  );
  router.get("/entries", (request, response) =>
    sendJson(response, async () => {
      const parsed = readDevelopmentLogQuery(request.query, owner.model());
      return readCache(() => owner.readEntries(parsed.query));
    }),
  );
  router.get("/evidence", (request, response) =>
    sendJson(response, async (): Promise<DevelopmentLogEvidence> => {
      const parsed = readDevelopmentLogQuery(
        request.query,
        owner.model(),
        true,
      );
      const page = await readCache(() => owner.readEntries(parsed.query));
      // Pin the second bounded cache read to this exact run; a runtime restart cannot mix evidence.
      const errors = page.run
        ? await readCache(() =>
            owner.readEntries({
              ...parsed.query,
              runId: page.run!.runtimeSessionId,
              level: "error",
              limit: 8,
              cursor: undefined,
              direction: "older",
              reserveKinds: terminalErrorKinds,
            }),
          )
        : undefined;
      const read = [
        ...new Map(
          [...page.entries, ...(errors?.entries ?? [])].map((event) => [
            event.eventId,
            event,
          ]),
        ).values(),
      ];
      // Group before selecting: severity labels a record, only its execution's outcome says it failed.
      const operations = groupDevelopmentLogOperations(read);
      const identified = operations
        .filter((operation) => operation.kind !== "event")
        .map((operation) => execution(operation, page.observedAt))
        .sort((a, b) => b.sequence - a.sequence);
      const ended = identified.filter((item) => item.endedAt),
        failed = identified.filter(developmentExecutionFailed),
        running = identified.filter(
          (item) => !item.endedAt && item.startObserved,
        );
      // Current outcome, newest failure, then anything still running. A fragment with neither
      // a start nor an end takes a slot only when nothing better was read.
      const ranked = [
        ...new Set(
          [
            ended[0],
            failed[0],
            running[0],
            ...failed,
            ...ended,
            ...running,
          ].filter((item) => item !== undefined),
        ),
      ];
      const executions = (
        ranked.length ? ranked : identified.slice(0, 1)
      ).slice(0, parsed.scope ? 3 : 2);
      const outside = operations
        .filter((operation) => operation.kind === "event")
        .map((operation) => operation.events[0]!)
        .sort((a, b) => b.ingestSequence - a.ingestSequence);
      const current = [
        outside[0],
        outside.find(
          (event) =>
            summarizeDevelopmentLogOperation([event]).endedAt !== undefined,
        ),
      ].filter((event) => event !== undefined);
      // A recorded failure event outranks raw error-level output such as stderr.
      const problems = [
        ...outside.filter(
          (event) => event.level === "error" && event.stream === "event",
        ),
        ...outside.filter(
          (event) => event.level === "error" && event.stream !== "event",
        ),
      ];
      // Executions already carry current activity, so the remaining slots go to problems first.
      const entries = [
        ...new Set(
          executions.length
            ? [...problems, ...current, ...outside]
            : [...current, ...problems, ...outside],
        ),
      ].slice(0, parsed.scope ? 8 : 6);
      const errorLevel = (events: readonly { level: string }[]) =>
        events.filter((event) => event.level === "error").length;
      const hidden = identified.filter((item) => !executions.includes(item));
      return {
        schemaVersion: 1,
        source: "development",
        observedAt: page.observedAt,
        collection: page.collection,
        run: page.run,
        scope: parsed.scope,
        executions,
        entries: entries.map(excerpt),
        window: {
          records: read.length,
          olderUnread: page.olderCursor !== undefined,
          olderErrorsUnread: errors?.olderCursor !== undefined,
        },
        excluded: {
          executions: hidden.length,
          failed: hidden.filter(developmentExecutionFailed).length,
          records:
            read.length -
            executions.reduce((sum, item) => sum + item.records, 0) -
            entries.length,
          errorLevel:
            errorLevel(read) -
            executions.reduce((sum, item) => sum + item.errorLevel, 0) -
            errorLevel(entries),
        },
        gaps: [
          ...new Map(
            [...page.gaps, ...(errors?.gaps ?? [])].map((gap) => [
              JSON.stringify(gap),
              gap,
            ]),
          ).values(),
        ].slice(-64),
        dropped: page.dropped,
        truncated: page.truncated,
      };
    }),
  );
  return router;
}

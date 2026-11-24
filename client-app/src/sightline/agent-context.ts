import {
  CONVERSATION_CONTEXT_LIMIT,
  type ConversationContext,
  type ConversationExecution,
  type ConversationObservation,
} from "../../shared/agent-context";
import { developmentExecutionFailed } from "../../shared/development-logs";
import type { Sightline } from "./types";
import type { DevelopmentTrace } from "../../shared/development-traces";
import type { ModeModel } from "../../shared/model";
import { text } from "./safe";

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
/** The digest fields a model needs; per-digest counts stay behind and feed `excluded`. */
const executionFields = [
  "invocationId",
  "requestId",
  "traceId",
  "outcome",
  "httpStatus",
  "httpStatusSource",
  "durationMs",
  "workerMode",
  "startObserved",
  "endedAt",
  "lastRecordAt",
  "ageSeconds",
  "error",
  "errorLevelOutput",
] as const;
/** Reuse the privacy-reviewed Sightline projection; never expand into private input/query caches. */
export function buildConversationContext(
  sightline: Sightline,
  trace?: DevelopmentTrace,
  model?: ModeModel,
): ConversationContext {
  const focus = sightline.focus,
    declared = record(focus?.declared),
    logs = record(sightline.developmentLogs);
  const facts: Record<string, string | boolean> = {};
  for (const key of ["kind", "role", "targetId", "constructId"])
    if (typeof declared[key] === "string") facts[key] = declared[key];
  if (typeof record(declared.compute).runtime === "string")
    facts.runtime = declared.compute.runtime;
  for (const key of ["deploy", "local", "cloud"])
    if (["string", "boolean"].includes(typeof record(declared.lanes)[key]))
      facts[key] = declared.lanes[key];
  const observed = sightline.source.mode === "dev";
  // Present only when a development read happened; absence is never an empty healthy window.
  const read =
    observed && logs.window && logs.excluded
      ? {
          window: {
            records: logs.window.records,
            olderUnread: logs.window.olderUnread,
            olderErrorsUnread: logs.window.olderErrorsUnread,
          },
          excluded: {
            executions: logs.excluded.executions,
            failed: logs.excluded.failed,
            records: logs.excluded.records,
            errorLevel: logs.excluded.errorLevel,
          },
        }
      : undefined;
  // Anything this smaller envelope cannot carry stays counted.
  const dropExecution = (item: Record<string, any>) => {
    if (!read) return;
    read.excluded.executions++;
    if (developmentExecutionFailed(item as { outcome: string }))
      read.excluded.failed++;
    read.excluded.records += item.records;
    read.excluded.errorLevel += item.errorLevel;
  };
  const dropEntry = (item: Record<string, any>) => {
    if (!read) return;
    read.excluded.records++;
    if (item.level === "error") read.excluded.errorLevel++;
  };
  const all: Record<string, any>[] =
    read && Array.isArray(logs.executions) ? logs.executions : [];
  all.slice(3).forEach(dropExecution);
  const digests = all.slice(0, 3);
  const executions = digests.map(
    (item) =>
      ({
        ...(item.resourceId === focus?.id
          ? {}
          : { resourceId: item.resourceId }),
        ...Object.fromEntries(
          executionFields
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, item[key]]),
        ),
      }) as ConversationExecution,
  );
  const records: Record<string, any>[] =
    observed && Array.isArray(logs.entries) ? logs.entries : [];
  records.slice(4).forEach(dropEntry);
  const entries: ConversationObservation[] = records
    .slice(0, 4)
    .map((entry: Record<string, any>) => ({
      at: entry.at,
      resourceId: entry.resourceId,
      kind: entry.kind,
      ...(entry.level ? { level: entry.level } : {}),
      ...(entry.attribution ? { attribution: entry.attribution } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.httpStatus === undefined
        ? {}
        : { httpStatus: entry.httpStatus }),
      ...(entry.httpStatusSource
        ? { httpStatusSource: entry.httpStatusSource }
        : {}),
      ...(entry.durationMs === undefined
        ? {}
        : { durationMs: entry.durationMs }),
      ...(entry.workerMode ? { workerMode: entry.workerMode } : {}),
      ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
      ...(entry.payloadPreview ? { payloadPreview: entry.payloadPreview } : {}),
      correlation: entry.correlation ?? {},
    }));
  const omitted = [
    "private inputs, auth bodies, SQL, source text and operational authority excluded",
  ];
  const relationships = (
    Array.isArray(declared.connections) ? declared.connections : []
  )
    .slice(0, 8)
    .map((edge: Record<string, any>) => ({
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
    }));
  if (
    trace &&
    (trace.run?.runtimeSessionId !== record(logs.run).id ||
      (focus &&
        !trace.spans.some((span) => span.resourceId === focus.id) &&
        !trace.events.some(
          (event) =>
            event.resource.id === focus.id ||
            event.relatedResourceIds.includes(focus.id),
        )))
  )
    trace = undefined;
  const workloads =
    model && !focus
      ? model.targets.slice(0, 6).map((target) => ({
          id: text(target.ref, "application.workloads.id", [], 600),
          name: text(target.title, "application.workloads.name", [], 240),
          kind: target.kind,
        }))
      : [];
  const spanIdentity = (id: string) => {
    const span = trace?.spans.find((item) => item.id === id);
    return span?.spanId ?? span?.eventIds[0] ?? id;
  };
  const traceSpans =
    trace && sightline.source.mode === "dev"
      ? [...trace.spans]
          .sort(
            (a, b) =>
              Number(b.summary.tone !== "neutral") -
              Number(a.summary.tone !== "neutral"),
          )
          .slice(0, 8)
          .map((span) => ({
            id: spanIdentity(span.id),
            ...(span.parentId ? { parentId: spanIdentity(span.parentId) } : {}),
            resourceId: span.resourceId,
            ...(span.summary.execution
              ? { outcome: span.summary.execution }
              : {}),
            ...(span.summary.httpStatus === undefined
              ? {}
              : { httpStatus: span.summary.httpStatus }),
            ...(span.summary.httpStatusSource
              ? { httpStatusSource: span.summary.httpStatusSource }
              : {}),
            ...(span.summary.durationMs === undefined
              ? {}
              : { durationMs: span.summary.durationMs }),
            incomplete: span.incomplete || span.orphan,
          }))
      : [];
  const includedSpans = new Set(traceSpans.map((span) => span.id));
  for (const span of traceSpans)
    if (span.parentId && !includedSpans.has(span.parentId))
      span.incomplete = true;
  const result: ConversationContext = {
    schemaVersion: 1,
    capturedAt: sightline.capturedAt,
    source: {
      mode: sightline.source.mode,
      revision: sightline.source.revision,
      stale: sightline.source.stale,
      connected: sightline.source.connected,
      modelStatus: sightline.source.modelStatus,
      evaluating: sightline.source.evaluating,
      latestRevision: sightline.source.latestRevision,
      draftDirty: sightline.source.draft.dirty,
      draftConflicted: sightline.source.draft.conflicted,
    },
    focus: focus
      ? {
          id: focus.id,
          name: focus.name,
          kind: focus.kind,
          ...(typeof focus.description === "string"
            ? { description: focus.description.slice(0, 400) }
            : {}),
          declared: facts,
          relationships,
        }
      : null,
    ...(model
      ? {
          application: {
            counts: {
              workloads: model.targets.length,
              resources: model.resources.length,
              routes: model.routes.length,
            },
            workloads,
          },
        }
      : {}),
    observations: {
      availability: String(logs.availability ?? "not-loaded"),
      ...(typeof logs.reason === "string"
        ? { reason: logs.reason.slice(0, 320) }
        : {}),
      ...(typeof logs.collection === "string"
        ? { collection: logs.collection }
        : {}),
      ...(typeof logs.observedAt === "string"
        ? { observedAt: logs.observedAt }
        : {}),
      ...(typeof record(logs.run).id === "string"
        ? { runId: logs.run.id }
        : {}),
      gaps: Array.isArray(logs.gaps) ? logs.gaps.length : 0,
      ...(observed && Array.isArray(logs.gaps) && logs.gaps.length
        ? {
            gapReasons: [
              ...new Set<string>(
                logs.gaps.map((gap: Record<string, any>) => gap.reason),
              ),
            ],
          }
        : {}),
      ...(read ? { ...read, executions } : {}),
      entries,
    },
    ...(trace && sightline.source.mode === "dev"
      ? {
          trace: {
            id: trace.traceId,
            complete: trace.complete && trace.spans.length <= 8,
            observedAt: trace.observedAt,
            omitted: trace.omitted + Math.max(0, trace.spans.length - 8),
            spans: traceSpans,
          },
        }
      : {}),
    omitted,
  };
  if (sightline.omitted.length)
    omitted.push(
      "Sightline contains additional privacy, relevance or budget omissions",
    );
  if (model && !focus && model.targets.length > workloads.length)
    omitted.push("additional workloads outside this overview");
  while (
    JSON.stringify(result).length > CONVERSATION_CONTEXT_LIMIT &&
    (workloads.length ||
      traceSpans.length > 1 ||
      relationships.length ||
      executions.length + entries.length > 1)
  ) {
    if (workloads.length) {
      workloads.pop();
      if (!omitted.includes("additional workloads outside this overview"))
        omitted.push("additional workloads outside this overview");
    } else if (traceSpans.length > 1) {
      traceSpans.pop();
      if (result.trace) {
        (result.trace as { complete: boolean; omitted: number }).complete =
          false;
        (result.trace as { omitted: number }).omitted++;
      }
    } else if (relationships.length) {
      relationships.pop();
      if (!omitted.includes("additional relationships omitted"))
        omitted.push("additional relationships omitted");
    } else {
      // Records outside executions yield first, then the least relevant execution.
      if (entries.length > (executions.length ? 0 : 1))
        dropEntry(entries.pop()!);
      else {
        dropExecution(digests[executions.length - 1]!);
        executions.pop();
      }
      if (!omitted.includes("additional observations omitted"))
        omitted.push("additional observations omitted");
    }
  }
  if (JSON.stringify(result).length > CONVERSATION_CONTEXT_LIMIT)
    throw new Error(
      "Conversation context exceeds its required envelope budget.",
    );
  return result;
}

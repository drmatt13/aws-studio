import { developmentLogScope } from "../../shared/development-log-scope";
import {
  developmentExecutionFailed,
  type DevelopmentLogEvidence,
} from "../../shared/development-logs";
import type {
  SightlineInputs,
  SightlineOmission,
  SightlineRecord,
} from "./types";
import { bounded, omit, text } from "./safe";

/** The one trace a visible agent consumer reads: whichever execution or outside record is newest. */
export function newestEvidenceTraceId(
  evidence: DevelopmentLogEvidence | undefined,
): string | undefined {
  return [
    ...(evidence?.executions ?? []).map((item) => ({
      sequence: item.sequence,
      at: item.endedAt ?? item.lastRecordAt ?? "",
      id: item.invocationId ?? item.requestId ?? "",
      traceId: item.traceId,
    })),
    ...(evidence?.entries ?? []).map((entry) => ({
      sequence: entry.ingestSequence ?? 0,
      at: entry.at,
      id: entry.eventId,
      traceId: entry.correlation.traceId,
    })),
  ]
    .filter((item) => item.traceId)
    .sort(
      (a, b) =>
        b.sequence - a.sequence ||
        b.at.localeCompare(a.at) ||
        b.id.localeCompare(a.id),
    )[0]?.traceId;
}

/** Separate allow-list: adding log evidence never opens operation/private-detail exclusions. */
export function buildDevelopmentLogSightline(
  inputs: SightlineInputs,
  omitted: SightlineOmission[],
): SightlineRecord {
  const base = { evidence: "observed", source: "development", untrusted: true };
  if (inputs.mode === "prod")
    return {
      ...base,
      availability: "not-applicable",
      reason:
        "Production log collection is not implemented. Development logs are excluded from this source view.",
    };
  const scope = inputs.selected
    ? developmentLogScope(inputs.snapshot.models.dev, inputs.selected)
    : undefined;
  if (
    inputs.selected &&
    (!scope || scope.kind === "not-applicable" || scope.kind === "unsupported")
  )
    return {
      ...base,
      availability: "not-applicable",
      coverage: scope?.kind ?? "unsupported",
      resourceId: inputs.selected,
      reason:
        scope?.reason ?? "This selection has no local execution log stream.",
    };
  const input = inputs.developmentLogs,
    value = input?.evidence;
  if (!value)
    return {
      ...base,
      availability: input?.availability ?? "not-loaded",
      resourceId: inputs.selected ?? null,
    };
  const limit = inputs.selected ? 3 : 2;
  // Whatever a bound or the budget removes below stays counted, so the totals remain true.
  const excluded = { ...value.excluded };
  const dropExecution = (item: {
    outcome: string;
    httpStatus?: number;
    records: number;
    errorLevel: number;
  }) => {
    excluded.executions++;
    if (developmentExecutionFailed(item)) excluded.failed++;
    excluded.records += item.records;
    excluded.errorLevel += item.errorLevel;
  };
  const dropEntry = (item: { level: string }) => {
    excluded.records++;
    if (item.level === "error") excluded.errorLevel++;
  };
  const field = "developmentLogs.executions";
  const id = (item: string | undefined, key: string, size: number) =>
    item === undefined ? undefined : text(item, `${field}.${key}`, omitted, size);
  value.executions.slice(limit).forEach(dropExecution);
  const executions = bounded(value.executions, limit, field, omitted).map(
    (item) => ({
      resourceId: text(item.resourceId, `${field}.resourceId`, omitted, 240),
      invocationId: id(item.invocationId, "invocationId", 80),
      requestId: id(item.requestId, "requestId", 80),
      traceId: id(item.traceId, "traceId", 240),
      outcome: item.outcome,
      httpStatus: item.httpStatus,
      httpStatusSource: item.httpStatusSource,
      durationMs: item.durationMs,
      workerMode: item.workerMode,
      startObserved: item.startObserved,
      endedAt: id(item.endedAt, "endedAt", 40),
      lastRecordAt: id(item.lastRecordAt, "lastRecordAt", 40),
      ageSeconds: item.ageSeconds,
      error: id(item.error, "error", 240),
      errorLevelOutput: id(item.errorLevelOutput, "errorLevelOutput", 240),
      records: item.records,
      errorLevel: item.errorLevel,
    }),
  );
  // Executions come first; records outside them keep at least one slot.
  const entryLimit = Math.max(1, limit - executions.length);
  value.entries.slice(entryLimit).forEach(dropEntry);
  const entries = bounded(
    value.entries,
    entryLimit,
    "developmentLogs.entries",
    omitted,
  ).map((entry) => {
    const subject = inputs.selected ?? entry.resourceId;
    const laneKeys = subject.startsWith("workflow:")
      ? ["executionId", "stateId", "stateAttemptId", "mapIndex"]
      : subject.startsWith("task:")
        ? ["taskRunId", "executionId"]
        : subject.startsWith("agent:") || entry.correlation.toolCallId
          ? ["agentSessionId", "turnId", "toolCallId"]
          : entry.correlation.connectionId
            ? ["connectionId", "messageId"]
            : [
                "requestId",
                "invocationId",
                "executionId",
                "taskRunId",
                "agentSessionId",
              ];
    const correlations = [
      ...new Set([
        "traceId",
        ...laneKeys,
        "parentSpanId",
        "requestId",
        "invocationId",
      ]),
    ].flatMap((key) => {
      const item = (
        entry.correlation as Readonly<
          Record<string, string | number | undefined>
        >
      )[key];
      return item === undefined
        ? []
        : [
            [
              key,
              typeof item === "string"
                ? text(
                    item,
                    `developmentLogs.entries.correlation.${key}`,
                    omitted,
                    80,
                  )
                : item,
            ] as const,
          ];
    });
    return {
      eventId: text(
        entry.eventId,
        "developmentLogs.entries.eventId",
        omitted,
        100,
      ),
      resourceId: text(
        entry.resourceId,
        "developmentLogs.entries.resourceId",
        omitted,
        240,
      ),
      runtimeSessionId: text(
        entry.runtimeSessionId,
        "developmentLogs.entries.runtimeSessionId",
        omitted,
        100,
      ),
      at: text(entry.at, "developmentLogs.entries.at", omitted, 40),
      level: entry.level,
      kind: text(entry.kind, "developmentLogs.entries.kind", omitted, 100),
      attribution: entry.attribution,
      outcome: entry.outcome
        ? text(entry.outcome, "developmentLogs.entries.outcome", omitted, 80)
        : undefined,
      httpStatus: entry.httpStatus,
      httpStatusSource: entry.httpStatusSource,
      durationMs: entry.durationMs,
      workerMode: entry.workerMode,
      excerpt: entry.message
        ? text(entry.message, "developmentLogs.entries.excerpt", omitted, 360)
        : undefined,
      payloadPreview: entry.detailsPreview
        ? text(
            entry.detailsPreview,
            "developmentLogs.entries.payloadPreview",
            omitted,
            480,
          )
        : undefined,
      correlation: Object.fromEntries(
        bounded(
          correlations,
          4,
          "developmentLogs.entries.correlation",
          omitted,
        ),
      ),
      truncated: entry.truncated,
    };
  });
  if (value.excluded.records)
    omit(
      omitted,
      "developmentLogs.entries",
      "relevance",
      value.excluded.records,
    );
  const result: SightlineRecord = {
    ...base,
    availability: input?.availability ?? "available",
    collection: value.collection,
    coverage: scope?.kind ?? "overview",
    coverageReason: scope?.reason
      ? text(scope.reason, "developmentLogs.coverageReason", omitted, 240)
      : undefined,
    observedAt: text(
      value.observedAt,
      "developmentLogs.observedAt",
      omitted,
      40,
    ),
    resourceId: inputs.selected ?? null,
    run: value.run
      ? {
          id: text(
            value.run.runtimeSessionId,
            "developmentLogs.run.id",
            omitted,
            100,
          ),
          bindingId: text(
            value.run.bindingId,
            "developmentLogs.run.bindingId",
            omitted,
            100,
          ),
          declarationDigest: text(
            value.run.declarationDigest,
            "developmentLogs.run.declarationDigest",
            omitted,
            100,
          ),
          composeProject: text(
            value.run.composeProject,
            "developmentLogs.run.composeProject",
            omitted,
            100,
          ),
          startedAt: text(
            value.run.startedAt,
            "developmentLogs.run.startedAt",
            omitted,
            40,
          ),
          status: value.run.status,
          deployment: value.run.binding.deployment
            ? text(
                value.run.binding.deployment,
                "developmentLogs.run.deployment",
                omitted,
                100,
              )
            : undefined,
          region: value.run.binding.region
            ? text(
                value.run.binding.region,
                "developmentLogs.run.region",
                omitted,
                40,
              )
            : undefined,
        }
      : null,
    dropped: value.dropped,
    truncated: value.truncated,
    gaps: bounded(value.gaps, 2, "developmentLogs.gaps", omitted).map(
      (gap) => ({ reason: gap.reason, at: gap.at, count: gap.count }),
    ),
    window: value.window,
    excluded,
    executions,
    entries,
  };
  // Reserve a small deterministic share of the unchanged overall 12k envelope. Records
  // outside executions yield first, then the least relevant execution; one item always stays.
  while (
    JSON.stringify(result).length > 3_200 &&
    executions.length + entries.length > 1
  ) {
    if (entries.length > (executions.length ? 0 : 1)) {
      dropEntry(entries.pop()!);
      omit(omitted, "developmentLogs.entries", "budget", 1);
    } else {
      dropExecution(executions.pop()!);
      omit(omitted, field, "budget", 1);
    }
  }
  return result;
}

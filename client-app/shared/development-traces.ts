import type {
  DevelopmentCorrelation,
  DevelopmentLogTracePage,
} from "aws-studio/development-logs/contract";
import type {
  DevelopmentLogEvent,
  DevelopmentLogPage,
  DevelopmentLogRun,
} from "./development-logs";
import {
  summarizeDevelopmentLogOperation,
  type DevelopmentLogOperationSummary,
} from "./development-log-operations";

export const DEVELOPMENT_TRACE_SPAN_LIMIT = 80;
export interface DevelopmentTraceSpan {
  readonly id: string;
  readonly spanId?: string;
  readonly parentId?: string;
  readonly parentSpanId?: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly summary: DevelopmentLogOperationSummary;
  readonly correlation: DevelopmentCorrelation;
  readonly eventIds: readonly string[];
  readonly orphan: boolean;
  readonly incomplete: boolean;
}
export interface DevelopmentTrace {
  readonly schemaVersion: 1;
  readonly source: "development";
  readonly traceId: string;
  readonly observedAt: string;
  readonly collection: DevelopmentLogPage["collection"];
  readonly run?: DevelopmentLogRun;
  readonly spans: readonly DevelopmentTraceSpan[];
  readonly roots: readonly string[];
  readonly events: readonly DevelopmentLogEvent[];
  readonly complete: boolean;
  readonly gaps: DevelopmentLogPage["gaps"];
  readonly dropped: number;
  readonly truncated: number;
  readonly omitted: number;
}

/** Observed span identities and explicit parent links only; no adjacency/time-based attribution. */
export function buildDevelopmentTrace(
  page: DevelopmentLogTracePage,
): DevelopmentTrace {
  const groups = new Map<string, DevelopmentLogEvent[]>();
  const sourceEvents = page.entries
    .slice(0, 200)
    .filter(
      (event) =>
        event.correlation.traceId === page.traceId &&
        (!page.run || event.runtimeSessionId === page.run.runtimeSessionId),
    );
  const mismatched = page.entries.length - sourceEvents.length;
  for (const event of sourceEvents) {
    const identity =
      event.correlation.spanId ??
      (event.correlation.invocationId
        ? `invocation:${event.correlation.invocationId}`
        : `event:${event.eventId}`);
    const id = JSON.stringify([event.resource.id, identity]);
    const list = groups.get(id) ?? [];
    list.push(event);
    groups.set(id, list);
  }
  const spans: DevelopmentTraceSpan[] = [...groups].map(([id, events]) => {
    const first = events[0]!,
      parents = [
        ...new Set(
          events
            .map((event) => event.correlation.parentSpanId)
            .filter((value): value is string => !!value),
        ),
      ];
    const summary = summarizeDevelopmentLogOperation(events, { scope: "span" });
    return {
      id,
      ...(first.correlation.spanId ? { spanId: first.correlation.spanId } : {}),
      ...(parents.length === 1 ? { parentSpanId: parents[0] } : {}),
      resourceId: first.resource.id,
      kind: first.kind.split(".")[0] ?? "event",
      summary,
      correlation: first.correlation,
      eventIds: events.map((event) => event.eventId),
      orphan: parents.length > 1,
      incomplete:
        !first.correlation.spanId || summary.missingStart || !summary.endedAt,
    };
  });
  const bySpan = new Map<string, DevelopmentTraceSpan[]>();
  for (const span of spans)
    if (span.spanId)
      bySpan.set(span.spanId, [...(bySpan.get(span.spanId) ?? []), span]);
  const linked = spans.map((span) => {
    if (!span.parentSpanId) return span;
    const candidates = bySpan.get(span.parentSpanId) ?? [];
    return candidates.length === 1 && candidates[0]!.id !== span.id
      ? { ...span, parentId: candidates[0]!.id }
      : { ...span, orphan: true };
  });
  const byId = new Map(linked.map((span) => [span.id, span]));
  let invalidParent = false;
  for (const span of linked) {
    const visited = new Set([span.id]);
    let parent = span.parentId;
    while (parent) {
      if (visited.has(parent)) {
        byId.set(span.id, { ...span, parentId: undefined, orphan: true });
        invalidParent = true;
        break;
      }
      visited.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }
  const ordered = [...byId.values()],
    selected = new Set<string>();
  const include = (span: DevelopmentTraceSpan) => {
    const lineage: string[] = [];
    let next: DevelopmentTraceSpan | undefined = span;
    while (next && !selected.has(next.id) && !lineage.includes(next.id)) {
      lineage.unshift(next.id);
      next = next.parentId ? byId.get(next.parentId) : undefined;
    }
    for (const id of lineage)
      if (selected.size < DEVELOPMENT_TRACE_SPAN_LIMIT) selected.add(id);
  };
  // Preserve failures and their observed ancestors before spending space on ordinary siblings.
  for (const span of ordered.filter((span) => span.summary.tone !== "neutral"))
    include(span);
  for (const span of ordered.filter((span) => !span.parentId)) include(span);
  for (const span of ordered) include(span);
  const kept = ordered
    .filter((span) => selected.has(span.id))
    .map((span) =>
      span.parentId && !selected.has(span.parentId)
        ? { ...span, parentId: undefined, orphan: true }
        : span,
    );
  const omitted = ordered.length - kept.length;
  const gaps = [...page.gaps];
  if (mismatched)
    gaps.push({
      reason: "source-unavailable",
      at: page.observedAt,
      count: mismatched,
      message: "Records outside this trace/run or response limit were omitted.",
    });
  const missingParents = kept.filter((span) => span.orphan).length;
  if (missingParents)
    gaps.push({
      reason: "source-unavailable",
      at: page.observedAt,
      count: missingParents,
      message: "Some observed parent span evidence is missing or ambiguous.",
    });
  if (invalidParent)
    gaps.push({
      reason: "source-unavailable",
      at: page.observedAt,
      message: "Conflicting or cyclic observed parent links were omitted.",
    });
  if (omitted)
    gaps.push({
      reason: "truncated",
      at: page.observedAt,
      count: omitted,
      message: "Additional spans are outside this bounded trace view.",
    });
  return {
    schemaVersion: 1,
    source: "development",
    traceId: page.traceId,
    observedAt: page.observedAt,
    collection: page.collection,
    ...(page.run ? { run: page.run } : {}),
    spans: kept,
    roots: kept.filter((span) => !span.parentId).map((span) => span.id),
    events: sourceEvents,
    complete:
      page.complete &&
      !omitted &&
      !invalidParent &&
      !missingParents &&
      !mismatched,
    gaps: gaps.slice(-64),
    dropped: page.dropped,
    truncated: page.truncated,
    omitted,
  };
}

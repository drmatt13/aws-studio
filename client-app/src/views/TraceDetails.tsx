import { memo, useMemo, useState } from "react";
import type { DevelopmentTraceSpan } from "../../shared/development-traces";
import type { DevelopmentLogEvent } from "../../shared/development-logs";
import { useDevelopmentTrace } from "../development-logs";
import { useStudio } from "../studio";
import { Button } from "../ui/Button";
import { Notice } from "../ui/Surface";
import { InspectorSummary } from "./InspectorUI";

export function TraceDetails({
  traceId,
  runId,
  resourceId,
}: {
  readonly traceId: string;
  readonly runId: string;
  readonly resourceId: string;
}) {
  const { mode } = useStudio();
  const [open, setOpen] = useState(false);
  return (
    <details
      data-slot="development-trace"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <InspectorSummary className="flex items-center text-caption font-semibold">
        Execution trace
      </InspectorSummary>
      {mode === "prod" ? (
        <p className="text-caption text-graphite">
          Production trace collection is not implemented.
        </p>
      ) : open ? (
        <TraceContent traceId={traceId} runId={runId} resourceId={resourceId} />
      ) : null}
    </details>
  );
}
function TraceContent(props: {
  readonly traceId: string;
  readonly runId: string;
  readonly resourceId: string;
}) {
  const { mode, snapshot } = useStudio();
  const query = useDevelopmentTrace(
    snapshot.repositoryRoot,
    mode,
    props.resourceId,
    props.runId,
    props.traceId,
  );
  const trace = query.data;
  const ordered = useMemo(() => {
    if (!trace) return [];
    const byParent = new Map<string | undefined, DevelopmentTraceSpan[]>();
    for (const span of trace.spans)
      byParent.set(span.parentId, [
        ...(byParent.get(span.parentId) ?? []),
        span,
      ]);
    const result: { span: DevelopmentTraceSpan; depth: number }[] = [],
      seen = new Set<string>();
    const visit = (id: string | undefined, depth: number) => {
      for (const span of byParent.get(id) ?? []) {
        if (seen.has(span.id)) continue;
        seen.add(span.id);
        result.push({ span, depth });
        visit(span.id, depth + 1);
      }
    };
    visit(undefined, 0);
    // Malformed/incomplete cache relationships remain visible instead of disappearing.
    for (const span of trace.spans)
      if (!seen.has(span.id)) result.push({ span, depth: 0 });
    return result;
  }, [trace?.spans]);
  return (
    <div
      className="mt-2 grid min-w-0 gap-2"
      aria-label="Execution trace evidence"
    >
      <div className="flex flex-wrap items-center gap-2 text-meta text-graphite">
        <span role="status">
          {query.isPending
            ? "Loading cached trace…"
            : query.isError
              ? "Trace cache unavailable"
              : trace?.spans.length
                ? `${trace.spans.length} observed spans${trace.complete ? "" : " · partial evidence"}`
                : "No retained trace evidence for this resource."}
        </span>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh trace
        </Button>
      </div>
      {query.isError ? (
        <Notice role="alert">{query.error.message}</Notice>
      ) : null}
      {trace ? (
        <>
          <p className="m-0 text-meta text-graphite wrap-anywhere">
            Development · trace <code>{trace.traceId}</code>
            <br />
            Observed {new Date(trace.observedAt).toLocaleTimeString()} ·{" "}
            {trace.collection}
          </p>
          {trace.gaps.length ||
          trace.spans.some((span) => span.orphan || span.incomplete) ? (
            <p className="m-0 text-caption text-graphite">
              This is bounded cached evidence. Missing parents, starts or
              completion events are labeled below; other execution may be
              unobserved.
            </p>
          ) : null}
          {trace.gaps.slice(0, 2).map((gap, index) => (
            <p
              key={`${gap.reason}:${index}`}
              className="m-0 text-meta text-graphite"
            >
              {gap.message}
            </p>
          ))}
          {trace.gaps.length > 2 ? (
            <p className="m-0 text-meta text-graphite">
              {trace.gaps.length - 2} additional cache gaps.
            </p>
          ) : null}
          <ol
            aria-label="Trace execution chain"
            className="m-0 grid min-w-0 list-none gap-1 p-0"
          >
            {ordered.map(({ span, depth }) => (
              <TraceSpan
                key={span.id}
                span={span}
                depth={depth}
                events={trace.events}
              />
            ))}
          </ol>
          {trace.spans.length ? (
            <p className="m-0 text-meta text-graphite">
              Parallel and asynchronous spans can overlap. Their durations are
              not additive.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
const TraceSpan = memo(function TraceSpan({
  span,
  depth,
  events,
}: {
  readonly span: DevelopmentTraceSpan;
  readonly depth: number;
  readonly events: readonly DevelopmentLogEvent[];
}) {
  const [open, setOpen] = useState(false);
  const tone =
    span.summary.tone === "error"
      ? "text-refuse"
      : span.summary.tone === "warning"
        ? "text-caution"
        : "";
  return (
    <li
      className="min-w-0 border-s border-rule ps-2"
      style={{
        marginInlineStart: `calc(var(--spacing) * ${Math.min(depth, 5) * 3})`,
      }}
    >
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <InspectorSummary className="flex min-w-0 items-start text-caption">
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <code className="wrap-anywhere">{span.resourceId}</code>
              <span className={`font-semibold ${tone}`}>
                {span.summary.label}
              </span>
              {span.summary.durationMs !== undefined ? (
                <span className="text-meta text-graphite">
                  {Math.round(span.summary.durationMs)} ms
                </span>
              ) : null}
            </span>
            {span.correlation.stateId ? (
              <span className="text-meta text-graphite wrap-anywhere">
                State {span.correlation.stateId}
                {span.correlation.mapIndex !== undefined
                  ? ` · map item ${span.correlation.mapIndex}`
                  : ""}
              </span>
            ) : null}
            {span.orphan ? (
              <span className="text-meta text-graphite">
                Parent evidence unavailable
              </span>
            ) : null}
            {span.incomplete ? (
              <span className="text-meta text-graphite">
                {span.summary.missingStart
                  ? "Start not observed"
                  : "Completion not observed"}
              </span>
            ) : null}
            {span.summary.errorExcerpt ? (
              <span className="whitespace-pre-wrap font-mono text-caption text-refuse wrap-anywhere">
                {span.summary.errorExcerpt}
              </span>
            ) : null}
          </span>
        </InspectorSummary>
        {open ? (
          <div className="my-2 grid min-w-0 gap-2">
            <pre
              className="m-0 max-h-[180px] overflow-auto whitespace-pre-wrap font-mono text-meta wrap-anywhere"
              tabIndex={0}
            >
              {JSON.stringify(
                {
                  correlation: span.correlation,
                  startedAt: span.summary.startedAt,
                  endedAt: span.summary.endedAt,
                  parentSpanId: span.parentSpanId,
                  worker: span.summary.worker,
                },
                null,
                2,
              )}
            </pre>
            <ol
              aria-label="Trace span events"
              className="m-0 grid list-none gap-2 p-0"
            >
              {span.eventIds
                .map((id) => events.find((event) => event.eventId === id))
                .filter((event) => !!event)
                .map((event) => (
                  <li key={event.eventId} className="min-w-0 text-meta">
                    <time dateTime={event.occurredAt} title={event.occurredAt}>
                      {new Date(event.occurredAt).toLocaleTimeString()}
                    </time>{" "}
                    · <code className="wrap-anywhere">{event.kind}</code>
                    {event.message ? (
                      <pre className="m-0 whitespace-pre-wrap font-mono text-caption wrap-anywhere">
                        {event.message}
                      </pre>
                    ) : null}
                  </li>
                ))}
            </ol>
          </div>
        ) : null}
      </details>
    </li>
  );
});

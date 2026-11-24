import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  DevelopmentLogEvent,
  DevelopmentLogPage,
} from "../../shared/development-logs";
import { developmentLogScope } from "../../shared/development-log-scope";
import {
  groupDevelopmentLogOperations,
  type DevelopmentLogOperation,
} from "../../shared/development-log-operations";
import { developmentLogsApi } from "../development-logs";
import { useStudio } from "../studio";
import { Button } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";
import { Notice } from "../ui/Surface";
import { InspectorDisclosure, InspectorSummary } from "./InspectorUI";
import { TraceDetails } from "./TraceDetails";

const collectionText: Record<string, string> = {
  "not-configured":
    "Development collection has not started. Start the local development runtime to collect resource logs.",
  collecting: "Collecting development logs",
  stopped: "Runtime stopped · cached history",
  disconnected: "Collector disconnected · cached evidence may be incomplete",
  failed:
    "Development log collection failed · cached history remains available",
};
const at = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        fractionalSecondDigits: 3,
      });
};

export function ResourceLogs({ selected }: { readonly selected: string }) {
  const { model, mode } = useStudio();
  const scope = developmentLogScope(model, selected);
  const [open, setOpen] = useState(false);
  if (!scope || scope.kind === "not-applicable") return null;
  return (
    <InspectorDisclosure
      title="Logs"
      data-slot="resource-logs"
      onToggle={setOpen}
    >
      {mode === "prod" ? (
        <p className="m-0 text-caption text-graphite">
          Production log collection is not implemented. This view does not fetch
          production logs or display development logs.
        </p>
      ) : open ? (
        <DevelopmentLogContent
          key={selected}
          selected={selected}
          active={open}
          reason={scope.reason}
          unsupported={scope.kind === "unsupported"}
        />
      ) : null}
    </InspectorDisclosure>
  );
}

function DevelopmentLogContent({
  selected,
  active,
  reason,
  unsupported,
}: {
  readonly selected: string;
  readonly active: boolean;
  readonly reason?: string;
  readonly unsupported: boolean;
}) {
  const { snapshot } = useStudio();
  const [follow, setFollow] = useState(true),
    [runId, setRunId] = useState(""),
    [search, setSearch] = useState(""),
    [level, setLevel] = useState("");
  const [querySearch, setQuerySearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuerySearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const [older, setOlder] = useState<readonly DevelopmentLogEvent[]>([]),
    [olderCursor, setOlderCursor] = useState<string | undefined>();
  const [hasLoadedOlder, setHasLoadedOlder] = useState(false);
  const [newerOmitted, setNewerOmitted] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false),
    [olderProblem, setOlderProblem] = useState<string>();
  const olderRequest = useRef<AbortController | undefined>(undefined),
    generation = useRef(0);
  useEffect(() => () => olderRequest.current?.abort(), []);
  const options = {
    resource: selected,
    ...(runId ? { runId } : {}),
    ...(querySearch ? { search: querySearch } : {}),
    ...(level ? { level } : {}),
    limit: 100,
  };
  const query = useQuery({
    queryKey: ["development-log-entries", snapshot.repositoryRoot, options],
    queryFn: ({ signal }) => developmentLogsApi.entries(options, signal),
    enabled: active && !unsupported,
    refetchInterval: active && follow && !unsupported ? 2_000 : false,
    staleTime: 1_000,
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 30_000,
  });
  const runs = useQuery({
    queryKey: ["development-log-runs", snapshot.repositoryRoot],
    queryFn: ({ signal }) => developmentLogsApi.runs(signal),
    enabled: active && !unsupported,
    staleTime: 2_000,
    refetchInterval: active && follow && !unsupported ? 5_000 : false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const page = query.data;
  const displayedRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentRun = page?.run?.runtimeSessionId;
    if (
      currentRun &&
      displayedRun.current &&
      currentRun !== displayedRun.current
    ) {
      generation.current++;
      olderRequest.current?.abort();
      setOlder([]);
      setOlderCursor(undefined);
      setHasLoadedOlder(false);
      setNewerOmitted(0);
      setLoadingOlder(false);
      readingAnchor.current = undefined;
    }
    if (currentRun) displayedRun.current = currentRun;
  }, [page?.run?.runtimeSessionId]);
  const merged = useMemo(
    () =>
      [
        ...new Map(
          (hasLoadedOlder
            ? older.filter(
                (event) =>
                  event.runtimeSessionId === page?.run?.runtimeSessionId,
              )
            : (page?.entries ?? [])
          ).map((event) => [event.eventId, event]),
        ).values(),
      ].sort((a, b) => a.ingestSequence - b.ingestSequence),
    [hasLoadedOlder, older, page?.entries, page?.run?.runtimeSessionId],
  );
  const events = merged.slice(-1000),
    displayOmitted = Math.max(0, merged.length - events.length);
  const operations = useMemo(
    () => groupDevelopmentLogOperations(events),
    [merged],
  );
  const firstRowId =
    operations[0]?.kind === "event"
      ? operations[0].events[0]?.eventId
      : operations[0]?.id;
  const log = useRef<HTMLDivElement>(null),
    previous = useRef({ height: 0, top: 0, first: "" });
  const readingAnchor = useRef<{ eventId: string; offset: number } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    const element = log.current;
    if (!element) return;
    if (follow) element.scrollTop = element.scrollHeight;
    else if (readingAnchor.current) {
      const anchor = readingAnchor.current;
      const row = [
        ...element.querySelectorAll<HTMLElement>("[data-log-event-id]"),
      ].find((item) => item.dataset.logEventId === anchor.eventId);
      if (row)
        element.scrollTop +=
          row.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          anchor.offset;
      else element.scrollTop = 0;
      readingAnchor.current = undefined;
    } else if (previous.current.first && firstRowId !== previous.current.first)
      element.scrollTop =
        previous.current.top + element.scrollHeight - previous.current.height;
    previous.current = {
      height: element.scrollHeight,
      top: element.scrollTop,
      first: firstRowId ?? "",
    };
  }, [operations, follow]);
  const reset = () => {
    generation.current++;
    olderRequest.current?.abort();
    setOlder([]);
    setOlderCursor(undefined);
    setHasLoadedOlder(false);
    setNewerOmitted(0);
    setLoadingOlder(false);
    setOlderProblem(undefined);
    readingAnchor.current = undefined;
  };
  const loadOlder = async () => {
    const cursor = hasLoadedOlder ? olderCursor : page?.olderCursor;
    if (!cursor || loadingOlder) return;
    const requestGeneration = generation.current,
      controller = new AbortController();
    olderRequest.current = controller;
    setFollow(false);
    setLoadingOlder(true);
    setOlderProblem(undefined);
    try {
      const result = await developmentLogsApi.entries(
        { ...options, cursor, direction: "older" },
        controller.signal,
      );
      if (requestGeneration === generation.current) {
        const element = log.current;
        if (element) {
          const top = element.getBoundingClientRect().top;
          const row = [
            ...element.querySelectorAll<HTMLElement>("[data-log-event-id]"),
          ].find((item) => item.getBoundingClientRect().bottom > top + 1);
          if (row?.dataset.logEventId)
            readingAnchor.current = {
              eventId: row.dataset.logEventId,
              offset: row.getBoundingClientRect().top - top,
            };
        }
        const current = hasLoadedOlder ? older : (page?.entries ?? []);
        const window = [
          ...new Map(
            [...result.entries, ...current].map((event) => [
              event.eventId,
              event,
            ]),
          ).values(),
        ].sort((a, b) => a.ingestSequence - b.ingestSequence);
        setNewerOmitted((value) => value + Math.max(0, window.length - 1000));
        setOlder(window.slice(0, 1000));
        setOlderCursor(result.olderCursor);
        setHasLoadedOlder(true);
      }
    } catch (error) {
      if (
        !controller.signal.aborted &&
        requestGeneration === generation.current
      )
        setOlderProblem(
          error instanceof Error
            ? error.message
            : "Could not load older log entries.",
        );
    } finally {
      if (requestGeneration === generation.current) setLoadingOlder(false);
    }
  };
  if (unsupported)
    return <p className="m-0 text-caption text-graphite">{reason}</p>;
  return (
    <div className="grid min-w-0 gap-3">
      {reason ? (
        <p className="m-0 text-caption text-graphite">{reason}</p>
      ) : null}
      <p className="m-0 text-caption text-graphite" role="status">
        {query.isError
          ? "Log cache disconnected · displaying previously observed history"
          : page
            ? (collectionText[page.collection] ?? page.collection)
            : query.isPending
              ? "Loading development logs…"
              : "Development log cache unavailable"}
      </p>
      {page?.run ? (
        <details
          data-slot="log-run-details"
          className="min-w-0 text-meta text-graphite"
        >
          <InspectorSummary className="cursor-pointer">
            Run details · started{" "}
            {new Date(page.run.startedAt).toLocaleString()}
          </InspectorSummary>
          <p className="m-0 mt-2 wrap-anywhere">
            Development · run <code>{page.run.runtimeSessionId}</code>
            <br />
            Binding <code>{page.run.bindingId}</code>
            <br />
            Declarations at start <code>{page.run.declarationDigest}</code>
            <br />
            Compose <code>{page.run.composeProject}</code>
            {page.run.binding.deployment ? (
              <> · {page.run.binding.deployment}</>
            ) : null}
          </p>
        </details>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-[1_1_160px] gap-1 text-caption">
          Run
          <Select
            aria-label="Development log run"
            value={runId}
            onChange={(event) => {
              setRunId(event.target.value);
              reset();
            }}
          >
            <option value="">Latest runtime run</option>
            {runs.data?.runs.map((run) => (
              <option key={run.runtimeSessionId} value={run.runtimeSessionId}>
                {new Date(run.startedAt).toLocaleString()} · {run.status} ·{" "}
                {run.runtimeSessionId.slice(0, 8)}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          aria-pressed={follow}
          onClick={() => {
            if (follow) setFollow(false);
            else {
              reset();
              setFollow(true);
              void query.refetch();
            }
          }}
        >
          {follow ? "Pause follow" : "Follow logs"}
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          disabled={query.isFetching}
          onClick={() => {
            reset();
            setFollow(false);
            void query.refetch();
          }}
        >
          Refresh logs
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        <label className="grid min-w-0 flex-[1_1_160px] gap-1 text-caption">
          Search logs
          <TextInput
            type="search"
            aria-label="Search resource logs"
            maxLength={128}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setFollow(false);
              reset();
            }}
          />
        </label>
        <label className="grid min-w-0 flex-[1_1_100px] gap-1 text-caption">
          Level
          <Select
            aria-label="Resource log level"
            value={level}
            onChange={(event) => {
              setLevel(event.target.value);
              reset();
            }}
          >
            <option value="">All levels</option>
            {["debug", "info", "warn", "error"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Select>
        </label>
      </div>
      {query.error ? (
        <Notice role="alert">
          {query.error.message} Cached entries remain labeled with their
          original run.
        </Notice>
      ) : null}
      {page?.gaps.length || page?.dropped || page?.truncated ? (
        <LogHistoryNotice page={page} />
      ) : null}
      {displayOmitted ? (
        <Notice tone="warning">
          {displayOmitted} older entries omitted from this 1,000-entry display.
          Narrow the filters or select another run to inspect more history.
        </Notice>
      ) : null}
      {newerOmitted ? (
        <Notice tone="warning">
          {newerOmitted} newer entries are outside this 1,000-entry history
          window. Follow logs to return to the latest entries.
        </Notice>
      ) : null}
      <Button
        type="button"
        variant="quiet"
        size="compact"
        disabled={
          loadingOlder || !(hasLoadedOlder ? olderCursor : page?.olderCursor)
        }
        onClick={() => void loadOlder()}
      >
        {loadingOlder ? "Loading older logs…" : "Load older logs"}
      </Button>
      {olderProblem ? <Notice role="alert">{olderProblem}</Notice> : null}
      {querySearch || level ? (
        <p className="m-0 text-meta text-graphite">
          Filters may hide other lifecycle events from an entry.
        </p>
      ) : null}
      {!events.length && !query.isPending ? (
        <p className="m-0 text-caption text-graphite">
          {search || level
            ? "No cached entries match these filters."
            : "No cached development logs for this resource in this run."}
        </p>
      ) : null}
      <div
        ref={log}
        role="region"
        aria-label="Resource log entries"
        tabIndex={0}
        className="max-h-[420px] min-w-0 overflow-auto overscroll-contain rounded-md border border-rule"
        onScroll={() => {
          const element = log.current!;
          previous.current = {
            height: element.scrollHeight,
            top: element.scrollTop,
            first: firstRowId ?? "",
          };
          if (
            element.scrollHeight - element.scrollTop - element.clientHeight >
            40
          )
            setFollow(false);
        }}
      >
        <ol
          className="m-0 grid list-none p-0"
          aria-label="Development log timeline"
        >
          {operations.map((operation) =>
            operation.kind === "event" ? (
              <LogEntry key={operation.id} event={operation.events[0]!} />
            ) : (
              <OperationEntry
                key={operation.id}
                operation={operation}
                selected={selected}
              />
            ),
          )}
        </ol>
      </div>
      {page ? (
        <p className="m-0 text-meta text-graphite">
          Cache observed {at(page.observedAt)} · {operations.length}{" "}
          {operations.length === 1 ? "entry" : "entries"} · {events.length}{" "}
          events. Logs are sanitized, bounded evidence; they do not establish
          durable execution recovery.
        </p>
      ) : null}
    </div>
  );
}

const OperationEntry = memo(function OperationEntry({
  operation,
  selected,
}: {
  readonly operation: DevelopmentLogOperation;
  readonly selected: string;
}) {
  const [open, setOpen] = useState(false);
  const { summary } = operation;
  const request = operation.kind === "request";
  const arrival = operation.events.find(
    (event) => event.kind === "http.request.received",
  );
  const location =
    arrival?.details && typeof arrival.details === "object"
      ? (arrival.details as Record<string, unknown>)
      : undefined;
  const requestName =
    typeof location?.method === "string" && typeof location.path === "string"
      ? `${location.method.slice(0, 16)} ${location.path.slice(0, 180)}`
      : "HTTP request";
  const duration =
    summary.durationMs === undefined
      ? undefined
      : summary.durationMs >= 1000
        ? `${(summary.durationMs / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")} s`
        : `${Math.round(summary.durationMs)} ms`;
  const tone =
    summary.tone === "error"
      ? "text-refuse"
      : summary.tone === "warning"
        ? "text-caution"
        : "";
  return (
    <li
      data-slot="log-operation"
      data-log-event-id={operation.id}
      className="min-w-0 border-b border-rule last:border-b-0"
    >
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <InspectorSummary
          targetSize="row"
          className="flex cursor-pointer items-start gap-1 p-2 hover:bg-wash"
        >
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta">
              <time dateTime={summary.startedAt} title={summary.startedAt}>
                {at(summary.startedAt)}
              </time>
              <span className="font-semibold text-caption wrap-anywhere">
                {request ? requestName : "Invocation"}
              </span>
              <span className={`font-semibold ${tone}`}>{summary.label}</span>
              {duration ? <span>{duration}</span> : null}
              {summary.worker ? (
                <span>
                  {summary.worker === "cold" ? "Cold start" : "Warm worker"}
                </span>
              ) : null}
            </span>
            {summary.execution === "returned" && !request ? (
              <span className="text-meta text-quiet">
                Handler returned normally
                {summary.httpStatus !== undefined && summary.httpStatus >= 400
                  ? " · error response status returned"
                  : ""}
              </span>
            ) : null}
            {request &&
            summary.execution === "unobserved" &&
            summary.httpStatus !== undefined ? (
              <span className="text-meta text-quiet">
                Integration returned · response completion not observed
              </span>
            ) : null}
            {summary.errorExcerpt ? (
              <span className="whitespace-pre-wrap font-mono text-caption text-refuse wrap-anywhere">
                {summary.errorExcerpt}
              </span>
            ) : null}
            <span className="text-meta text-quiet">
              {operation.events.length} lifecycle{" "}
              {operation.events.length === 1 ? "event" : "events"}
              {summary.missingStart ? " · earlier events unavailable" : ""}
            </span>
          </span>
        </InspectorSummary>
        {open ? (
          <div className="grid min-w-0 gap-2 border-t border-rule p-2">
            {operation.traceId ? (
              <TraceDetails
                traceId={operation.traceId}
                runId={operation.runtimeSessionId}
                resourceId={selected}
              />
            ) : null}
            <ol
              aria-label={
                request ? "HTTP request lifecycle" : "Invocation lifecycle"
              }
              className="m-0 grid list-none rounded-md border border-rule p-0"
            >
              {operation.events.map((event) => (
                <LogEntry key={event.eventId} event={event} />
              ))}
            </ol>
          </div>
        ) : null}
      </details>
    </li>
  );
});

function LogHistoryNotice({
  page,
}: {
  readonly page: Pick<DevelopmentLogPage, "gaps" | "dropped" | "truncated">;
}) {
  const [open, setOpen] = useState(false);
  const groups = new Map<string, { message: string; occurrences: number }>();
  for (const gap of page.gaps) {
    const key = JSON.stringify([gap.reason, gap.message, gap.resourceId]);
    const previous = groups.get(key);
    groups.delete(key);
    groups.set(key, {
      message: gap.message,
      occurrences: (previous?.occurrences ?? 0) + 1,
    });
  }
  return (
    <Notice tone="warning">
      Log history is incomplete.{" "}
      {page.dropped ? `${page.dropped} records dropped. ` : ""}
      {page.truncated ? `${page.truncated} records truncated. ` : ""}
      {[...groups.values()]
        .slice(-2)
        .map(
          (group) =>
            `${group.message}${group.occurrences > 1 ? ` (${group.occurrences} markers)` : ""}`,
        )
        .join(" ")}
      {groups.size > 2 ? ` ${groups.size - 2} additional gap types.` : ""}
      {page.gaps.length ? (
        <details
          className="mt-1"
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer">
            History gaps ({page.gaps.length})
          </summary>
          {open ? (
            <ul className="my-1 max-h-[140px] overflow-auto pl-4">
              {page.gaps.map((gap, index) => (
                <li key={`${gap.at}:${index}`}>
                  <time dateTime={gap.at}>{at(gap.at)}</time> · {gap.message}
                  {gap.count ? ` (${gap.count})` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </Notice>
  );
}

const LogEntry = memo(function LogEntry({
  event,
}: {
  readonly event: DevelopmentLogEvent;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li
      data-log-event-id={event.eventId}
      className="min-w-0 border-b border-rule p-2 last:border-b-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta">
        <time dateTime={event.occurredAt} title={event.occurredAt}>
          {at(event.occurredAt)}
        </time>
        <span
          className={
            event.level === "error"
              ? "font-semibold text-refuse"
              : "font-semibold"
          }
        >
          {event.level}
        </span>
        <code className="wrap-anywhere">{event.kind}</code>
        {event.outcome ? <span>{event.outcome}</span> : null}
      </div>
      {event.message ? (
        <pre className="m-0 mt-1 whitespace-pre-wrap font-mono text-caption wrap-anywhere">
          {event.message}
        </pre>
      ) : null}
      <p className="m-0 mt-1 text-meta text-graphite wrap-anywhere">
        <code>{event.resource.id}</code> · {event.stream} · attribution:{" "}
        {typeof event.attribution === "string"
          ? event.attribution
          : JSON.stringify(event.attribution)}
        {event.late ? " · late output" : ""}
      </p>
      <Button
        type="button"
        variant="link"
        size="compact"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Hide event details" : "Show event details"}
      </Button>
      {expanded ? (
        <pre
          className="m-0 max-h-[260px] overflow-auto whitespace-pre-wrap font-mono text-caption wrap-anywhere"
          tabIndex={0}
        >
          {JSON.stringify(
            {
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              observedAt: event.observedAt,
              runtimeSessionId: event.runtimeSessionId,
              bindingId: event.bindingId,
              declarationDigest: event.declarationDigest,
              producer: event.producer,
              correlation: event.correlation,
              details: event.details,
              omissions: event.omissions,
            },
            null,
            2,
          )}
        </pre>
      ) : null}
    </li>
  );
});

import { ArrowDown, ChevronRight, Search, Sparkles } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JobLogLine, JobView } from "../../../shared/operations";
import { useOperationLog } from "../../operations/live";
import { firstError, linkParts, logRows, problemCount, severityOf, visibleLines, type LineSeverity, type LogRow } from "../../operations/log-lines";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { Notice } from "../../ui/Surface";
import { askAgentPrompt, completedLegacyDiscard, needsAttention } from "./activity-model";
import { readActivityPreferences, saveActivityPreferences } from "./activity-preferences";

const FILTER_ID = "activity-log-filter";
/** Keyboard reach for the log's own tools, from anywhere in the tray. */
export const focusLogFilter = () => document.getElementById(FILTER_ID)?.focus();

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const clockText = (at: string) => { const time = Date.parse(at); return Number.isFinite(time) ? clock.format(time) : ""; };

const LEVEL: Readonly<Record<LineSeverity, string>> = {
  error: "bg-refuse-wash text-refuse", warning: "text-caution", command: "font-medium", note: "text-graphite", plain: "",
};
// Each line is a block, which is also what puts one newline between lines in a copied selection.
const LINE = "relative block min-h-lh pr-4 pl-[7ch] before:absolute before:left-0 before:w-[5.5ch] before:text-right before:text-graphite before:content-[attr(data-seq)] before:select-none group-data-[times=true]:pl-[11ch] group-data-[times=true]:before:w-[9.5ch] group-data-[times=true]:before:content-[attr(data-at)]";
/**
 * A long log renders and paints in chunks: the browser and React each track tens of chunks,
 * not thousands of lines. Unwrapped, a chunk is as wide as its text because
 * content-visibility clips paint to its box.
 */
const CHUNK = "block [content-visibility:auto] [contain-intrinsic-block-size:auto_3600px] group-data-[wrap=false]:w-max group-data-[wrap=false]:min-w-full";
const CHUNK_LINES = 200;
const rowSeq = (row: LogRow) => row.kind === "line" ? row.line.seq : row.id;
const TOOL = "inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent px-2 text-caption whitespace-nowrap text-quiet hover:bg-wash hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 aria-pressed:bg-selected aria-pressed:font-medium aria-pressed:text-selected-ink coarse:min-h-11";

function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
  const parts: (string | { match: string })[] = [];
  const lower = text.toLowerCase(), needle = query.toLowerCase();
  let cursor = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, cursor)) {
    parts.push(text.slice(cursor, at), { match: text.slice(at, at + needle.length) });
    cursor = at + needle.length;
  }
  parts.push(text.slice(cursor));
  return parts.map((part, index) => typeof part === "string" ? part : <mark key={index} className="rounded-[2px] bg-[color-mix(in_srgb,var(--local)_35%,transparent)] text-inherit">{part.match}</mark>);
}

/** A line never changes, so a long log's cost is only the lines just added. */
const LogLine = memo(function LogLine({ line, root, query, target }: {
  readonly line: JobLogLine;
  readonly root: string | undefined;
  readonly query: string;
  readonly target: boolean;
}) {
  return <span data-seq={line.seq} data-at={clockText(line.at)} className={cx(LINE, LEVEL[severityOf(line)], target && "outline outline-refuse -outline-offset-1")}>
    {query ? <Highlighted text={line.text} query={query} /> : linkParts(line.text, root).map((part, index) => typeof part === "string" ? part
      // Links stay out of the tab order: one log can hold hundreds, and Tab must still leave it.
      : <a key={index} href={part.href} target="_blank" rel="noreferrer" tabIndex={-1} className="text-dev underline underline-offset-2">{part.text}</a>)}
  </span>;
});

/** Buckets by line number, so a chunk keeps its identity as lines arrive and old ones drop. */
function chunks(rows: readonly LogRow[]): readonly (readonly LogRow[])[] {
  const result: LogRow[][] = [];
  let bucket: number | undefined;
  for (const row of rows) {
    const next = Math.floor(rowSeq(row) / CHUNK_LINES);
    if (next !== bucket) { result.push([]); bucket = next; }
    result.at(-1)!.push(row);
  }
  return result;
}

interface ChunkProps {
  readonly rows: readonly LogRow[];
  readonly root: string | undefined;
  readonly query: string;
  readonly target: number | undefined;
  readonly onFold: (id: number) => void;
}

/** Log rows are contiguous and immutable, so the ends and the count identify a chunk's contents. */
const sameChunk = (a: ChunkProps, b: ChunkProps) => a.root === b.root && a.query === b.query && a.target === b.target && a.onFold === b.onFold
  && a.rows.length === b.rows.length && rowSeq(a.rows[0]!) === rowSeq(b.rows[0]!) && rowSeq(a.rows.at(-1)!) === rowSeq(b.rows.at(-1)!);

const LogChunk = memo(function LogChunk({ rows, root, query, target, onFold }: ChunkProps) {
  return <span className={CHUNK}>
    {rows.map(row => row.kind === "line"
      ? <LogLine key={row.line.seq} line={row.line} root={root} query={query} target={target === row.line.seq} />
      : <button key={`fold-${row.id}`} type="button" aria-expanded={row.open} className="flex w-full cursor-pointer items-center gap-1 border-0 bg-transparent py-0 pr-4 pl-[7ch] text-left font-mono text-[0.76rem] leading-[1.5] text-graphite hover:bg-wash hover:text-ink"
          onClick={() => onFold(row.id)}>
          <ChevronRight size={12} aria-hidden className={row.open ? "rotate-90" : undefined} />{row.label}
        </button>)}
  </span>;
}, sameChunk);

/**
 * One job's failure, tools and log. It owns the log subscription, so output arriving
 * renders only here and only for lines that are new.
 */
export const ActivityOutput = memo(function ActivityOutput({ job, active, repositoryRoot, onAskAgent }: {
  readonly job: JobView;
  readonly active: boolean;
  readonly repositoryRoot?: string;
  readonly onAskAgent?: (prompt: string) => void;
}) {
  const replay = useOperationLog(active ? job.id : undefined, job.lastSeq);
  const lines = replay.lines;
  const [view, setView] = useState({ job: job.id, query: "", problemsOnly: false, opened: new Set<number>() as ReadonlySet<number>, target: undefined as number | undefined, jumps: 0 });
  if (view.job !== job.id) setView({ job: job.id, query: "", problemsOnly: false, opened: new Set(), target: undefined, jumps: 0 });
  const [preferences, setPreferences] = useState(() => { const stored = readActivityPreferences(); return { wrap: stored.wrap ?? false, times: stored.times ?? false }; });
  const [copy, setCopy] = useState<"Copied" | "Copy failed">();
  const [below, setBelow] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const jumped = useRef(0);
  // Typing stays immediate; a long log filters behind it.
  const query = useDeferredValue(view.query.trim());
  const rows = useMemo(() => logRows(lines, { query, problemsOnly: view.problemsOnly, opened: view.opened }), [lines, query, view.problemsOnly, view.opened]);
  const pieces = useMemo(() => chunks(rows), [rows]);
  const problems = useMemo(() => problemCount(lines), [lines]);
  const error = useMemo(() => firstError(lines), [lines]);
  const attention = needsAttention(job);
  const message = job.status === "failed" ? error?.text ?? job.summary : job.recovery;
  const completion = job.outcome === "confirmed" ? job.completionDetail : completedLegacyDiscard(job) ? message : undefined;

  useLayoutEffect(() => { pinned.current = true; setBelow(false); }, [job.id]);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && pinned.current && view.target === undefined) element.scrollTop = element.scrollHeight;
  }, [rows, job.id, view.target]);
  // Each request moves the reader once, as soon as a filter clearing has put the line back.
  useLayoutEffect(() => {
    if (view.target === undefined || jumped.current === view.jumps) return;
    const target = log.current?.querySelector(`[data-seq="${view.target}"]`);
    if (!target) return;
    jumped.current = view.jumps;
    pinned.current = false;
    target.scrollIntoView({ block: "center" });
  }, [view.target, view.jumps, rows]);
  useEffect(() => {
    if (!copy) return;
    const timer = setTimeout(() => setCopy(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copy]);

  const update = (patch: Partial<typeof view>) => setView(current => ({ ...current, ...patch }));
  const toggleFold = useCallback((id: number) => setView(current => {
    const opened = new Set(current.opened);
    if (!opened.delete(id)) opened.add(id);
    return { ...current, opened };
  }), []);
  const remember = (patch: Partial<typeof preferences>) => { setPreferences(current => ({ ...current, ...patch })); saveActivityPreferences(patch); };
  const latest = () => {
    pinned.current = true;
    update({ target: undefined });
    setBelow(false);
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  };
  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(visibleLines(lines, { query: view.query, problemsOnly: view.problemsOnly }).map(line => line.text).join("\n"));
      setCopy("Copied");
    } catch { setCopy("Copy failed"); }
  };

  return <>
    {completion ? <p data-ui="activity-completion-note" className="mx-4 mt-0 mb-2 flex-none text-caption text-quiet">{completion}</p> : null}
    {attention && (message || onAskAgent) ? <Notice tone={job.status === "failed" ? "error" : "warning"} className="mx-4 mb-2 flex flex-none flex-wrap items-center gap-x-3 gap-y-1 py-2">
      <p role={job.status === "failed" ? undefined : "status"} className={cx("m-0 min-w-50 flex-1", job.status === "failed" && error ? "font-mono text-caption" : "text-caption")}>{message}</p>
      <span className="flex flex-none items-center gap-2">
        {error ? <Button type="button" variant="quiet" size="compact" onClick={() => update({ query: "", problemsOnly: false, target: error.seq, jumps: view.jumps + 1 })}>Line {error.seq}</Button> : null}
        {onAskAgent ? <Button type="button" variant="quiet" size="compact" onClick={() => onAskAgent(askAgentPrompt(job, lines, error))}><Sparkles size={13} aria-hidden /> Ask in Conversation</Button> : null}
      </span>
    </Notice> : null}
    {replay.problem ? <div role="alert" className="flex flex-none items-center justify-between gap-3 px-4 pb-2 text-caption">
      <span>{replay.problem}</span>
      <Button type="button" variant="quiet" size="compact" disabled={replay.retrying} onClick={replay.retry}>Retry log</Button>
    </div> : null}
    <div className="flex flex-none flex-wrap items-center gap-1 border-t border-rule bg-paper py-0.5 pr-2 pl-4">
      <label className="flex min-w-30 flex-1 items-center gap-2 text-quiet">
        <Search size={13} aria-hidden className="flex-none" />
        <input id={FILTER_ID} type="search" aria-label="Filter log" placeholder="Filter log" value={view.query} autoComplete="off" spellCheck={false}
          onChange={event => update({ query: event.target.value, target: undefined })}
          onKeyDown={event => { if (event.key === "Escape" && view.query) { event.stopPropagation(); update({ query: "" }); } }}
          className="h-6 min-w-0 flex-1 border-0 bg-transparent font-mono text-caption text-ink placeholder:text-quiet placeholder:opacity-100 [&::-webkit-search-cancel-button]:appearance-none" />
      </label>
      <button type="button" className={TOOL} aria-pressed={view.problemsOnly} disabled={!problems && !view.problemsOnly} onClick={() => update({ problemsOnly: !view.problemsOnly, target: undefined })}>Problems{problems ? ` ${problems}` : ""}</button>
      <button type="button" className={TOOL} aria-pressed={preferences.times} onClick={() => remember({ times: !preferences.times })}>Time</button>
      <button type="button" className={TOOL} aria-pressed={preferences.wrap} onClick={() => remember({ wrap: !preferences.wrap })}>Wrap</button>
      <button type="button" className={TOOL} disabled={!lines.length} onClick={() => void copyLog()}><span aria-live="polite">{copy ?? "Copy"}</span></button>
    </div>
    {/* Stacked on a narrow screen the panel scrolls, so a long failure cannot squeeze out the log. */}
    <div className="relative flex min-h-0 flex-1 flex-col vp-900:h-75 vp-900:flex-none">
      <pre ref={log} role="log" aria-live="off" aria-label="Log" tabIndex={0} data-times={preferences.times} data-wrap={preferences.wrap}
        className={cx("group m-0 min-h-0 flex-1 overflow-auto bg-paper py-2 font-mono text-[0.76rem] leading-[1.5]", preferences.wrap ? "whitespace-pre-wrap wrap-anywhere" : "whitespace-pre")}
        onScroll={event => {
          const element = event.currentTarget;
          const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          pinned.current = atEnd;
          if (below === atEnd) setBelow(!atEnd);
        }}>
        {lines.length >= 5000 ? <span className="block pl-[7ch] text-graphite">Showing the latest 5,000 lines.</span> : null}
        {pieces.map(piece => {
          const first = rowSeq(piece[0]!), last = rowSeq(piece.at(-1)!), target = view.target;
          return <LogChunk key={Math.floor(first / CHUNK_LINES)} rows={piece} root={repositoryRoot} query={query} onFold={toggleFold}
            target={target !== undefined && target >= first && target <= last ? target : undefined} />;
        })}
        {lines.length && !rows.length ? <span className="block pl-[7ch] text-graphite">No lines match.</span> : null}
      </pre>
      {below ? <Button type="button" size="compact" className="absolute right-4 bottom-2" onClick={latest}><ArrowDown size={13} aria-hidden /> Latest</Button> : null}
    </div>
  </>;
});

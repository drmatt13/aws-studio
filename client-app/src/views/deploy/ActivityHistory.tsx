import { Check, CircleDot, LoaderCircle, Square, TriangleAlert, X } from "lucide-react";
import { memo, useState, type KeyboardEvent } from "react";
import type { JobView } from "../../../shared/operations";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { Age, Elapsed } from "./ActivityClock";
import { isBusy, statusLabel, statusTone, toneClasses, type HistoryGroup, type HistoryRow } from "./activity-model";

const PAGE = 20;

/** A job's state as a shape and a colour. The one spinner a running job has on screen. */
export function JobGlyph({ job, className }: { readonly job: JobView; readonly className?: string }) {
  const tone = statusTone(job);
  const classes = cx("flex-none", toneClasses[tone], className);
  if (isBusy(job)) return <LoaderCircle size={14} aria-hidden className={cx(classes, "animate-spin motion-reduce:animate-none")} />;
  if (job.status === "running") return <CircleDot size={14} aria-hidden className={classes} />;
  if (tone === "accept") return <Check size={14} aria-hidden className={classes} />;
  if (tone === "refuse") return <X size={14} aria-hidden className={classes} />;
  if (tone === "caution") return <TriangleAlert size={14} aria-hidden className={classes} />;
  return <Square size={12} aria-hidden className={cx(classes, "mx-px")} />;
}

function Row({ row, job, title, current, focusable, expanded, nested, onClick }: {
  readonly row?: HistoryRow;
  readonly job: JobView;
  readonly title: string;
  readonly current: boolean;
  readonly focusable: boolean;
  readonly expanded?: boolean;
  readonly nested?: boolean;
  readonly onClick: () => void;
}) {
  const at = job.endedAt ?? job.startedAt;
  const repeated = row && row.members.length > 1 ? row.members.length : 0;
  return <button type="button" data-history-row data-job={job.id} data-status={job.status} onClick={onClick}
    aria-current={current ? "true" : undefined} aria-expanded={expanded} tabIndex={focusable ? 0 : -1}
    title={`${title} · ${statusLabel(job)} · ${new Date(at).toLocaleString()}`}
    className={cx("relative grid min-h-8 w-full cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 rounded-sm border-0 py-1 pr-2 text-left text-step-minus1 text-inherit hover:bg-wash focus-visible:-outline-offset-2 coarse:min-h-11",
      nested ? "pl-6" : "pl-2", current ? "bg-selected font-medium" : "bg-transparent")}>
    <JobGlyph job={job} />
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="truncate">{title}</span>
      <span className="sr-only"> {statusLabel(job)} </span>
      {repeated ? <span className="flex-none font-mono text-meta text-quiet" aria-label={`${repeated} runs`}>×{repeated}</span> : null}
    </span>
    <span className="font-mono text-meta text-quiet tabular-nums">{job.status === "running" ? <Elapsed since={job.startedAt} /> : <Age at={at} />}</span>
  </button>;
}

/** Everything Studio is doing and has done, one line each, with arrow keys between them. */
export const ActivityHistory = memo(function ActivityHistory({ groups, selected, onSelect }: {
  readonly groups: readonly HistoryGroup[];
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [limit, setLimit] = useState(PAGE);
  const [focused, setFocused] = useState<string>();
  const candidate = selected ?? focused;
  const history = groups.filter(group => group.label !== "Running").flatMap(group => group.rows);
  // Revealing a job must never depend on how much history happens to be showing.
  const reach = Math.max(limit, history.findIndex(row => row.members.some(job => job.id === candidate)) + 1);
  const shown = new Set(history.slice(0, reach));
  const toggle = (key: string) => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const navigate = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-history-row]")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    onSelect(next.dataset.job!);
  };
  const reachable = groups.flatMap(group => group.rows).some(row => row.members.some(job => job.id === candidate)) ? candidate : groups[0]?.rows[0]?.job.id;
  return <div className="flex min-h-0 flex-col overflow-auto border-r border-rule p-2 vp-900:max-h-40 vp-900:border-r-0 vp-900:border-b">
    <ul className="m-0 grid list-none content-start gap-px p-0" aria-label="Operations" onKeyDown={navigate}
      onFocus={event => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-history-row]"); if (row) setFocused(row.dataset.job); }}>
      {groups.map(group => {
        const rows = group.rows.filter(row => group.label === "Running" || shown.has(row));
        if (!rows.length) return null;
        return [<li key={group.label} className="px-2 pt-2 pb-1 font-condensed text-meta font-semibold tracking-[0.06em] text-quiet uppercase first:pt-0">{group.label}</li>,
          ...rows.map(row => {
            const grouped = row.members.length > 1;
            const within = row.members.some(job => job.id === selected);
            const open = grouped && (expanded.has(row.key) || within && selected !== row.job.id);
            return <li key={row.key}>
              <Row row={row} job={row.job} title={row.title} expanded={grouped ? open : undefined} current={within && !open} focusable={!open && reachable === row.job.id}
                onClick={() => { onSelect(selected === row.job.id ? undefined : row.job.id); if (grouped) toggle(row.key); }} />
              {open ? <ul className="m-0 grid list-none gap-px p-0" aria-label={row.title}>
                {row.members.map(job => <li key={job.id}><Row job={job} title={job.title} nested current={job.id === selected} focusable={job.id === reachable} onClick={() => {
                  // An explicitly revealed member can be open only because it is selected.
                  // Keep its group and keyboard focus in place when clearing that selection.
                  if (selected === job.id) setExpanded(current => new Set([...current, row.key]));
                  onSelect(selected === job.id ? undefined : job.id);
                }} /></li>)}
              </ul> : null}
            </li>;
          })];
      })}
    </ul>
    {history.length > reach ? <Button type="button" variant="quiet" size="compact" className="mt-2 self-start" onClick={() => setLimit(reach + PAGE)}>Show {Math.min(PAGE, history.length - reach)} older</Button> : null}
  </div>;
});

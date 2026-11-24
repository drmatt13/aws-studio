import { useMemo } from "react";
import { codingTaskActive, type CodingEvent, type CodingTask } from "../../../shared/agent-runtime";
import { codingLiveStatus, codingProgressItems, codingRecentActivity } from "../../coding-presentation";

const logLabels: Record<CodingEvent["type"], string> = {
  state: "Task status", message: "Agent update", command: "Command", file: "File change", permission: "Permission",
  session: "Session", diagnostic: "Runner update", validation: "Project check", proposal: "Changes ready",
};

export function CodingTaskActivity({ task, events, loading, unavailable }: {
  readonly task: CodingTask;
  readonly events: readonly CodingEvent[];
  readonly loading: boolean;
  readonly unavailable?: boolean;
}) {
  const active = codingTaskActive(task) || task.contract?.approval?.status === "checking";
  const liveStatus = active ? codingLiveStatus(task, events) : "";
  const recent = useMemo(() => active ? codingRecentActivity(events) : [], [active, events]);
  const log = useMemo(() => codingProgressItems(events), [events]);
  const connection = unavailable ? "Task activity is temporarily unavailable." : loading ? "Loading task activity…" : !events.length ? "Waiting for the first task update." : "";
  const disclosure = <details className="rounded-md border border-rule px-3 py-2">
    <summary className="cursor-pointer text-caption font-semibold">{active ? "Activity log" : "Task activity"}</summary>
    {connection && !active ? <p role="status" className="mb-0 text-caption text-graphite">{connection}</p> : null}
    {(log[0]?.seq ?? 0) > 1 ? <p className="mb-0 text-caption text-graphite">Showing the most recent entries.</p> : null}
    {log.length ? <ol aria-label="Task activity log" tabIndex={0} className="mb-0 grid max-h-[280px] gap-2 overflow-auto pl-5 text-caption">
      {[...log].reverse().map(item => <li key={item.seq}><span className="font-semibold">{logLabels[item.type]}</span><pre className="m-0 whitespace-pre-wrap font-mono wrap-anywhere">{item.text}</pre></li>)}
    </ol> : null}
  </details>;
  if (!active) return disclosure;
  return <section aria-label="Live task activity" className="grid min-w-0 gap-2">
    {liveStatus ? <p role="status" className="m-0 text-label text-graphite">{liveStatus}</p> : null}
    {connection ? <p role="status" className="m-0 text-caption text-graphite">{connection}</p> : null}
    {recent.length ? <ol aria-label="Recent task activity" className="m-0 grid list-none gap-2 rounded-md border border-rule p-3 text-caption">
      {recent.map(item => <li key={item.seq} className="min-w-0 wrap-anywhere">
        <p className="m-0 font-semibold text-label">{item.label}</p>
        {item.code ? <code className="font-mono text-graphite">{item.text}</code> : <p className="m-0 text-graphite">{item.text}</p>}
      </li>)}
    </ol> : null}
    {log.length ? disclosure : null}
  </section>;
}

import type { JobLogLine, JobView } from "../../../shared/operations";
import { isLocalProcessKind } from "../../../shared/operations";

const STATUS_LABEL: Readonly<Record<JobView["status"], string>> = {
  running: "Running", succeeded: "Done", failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted",
};

/** Older runners did not record discard scope. A successful command is complete;
 * its historical AWS outcome remains unverified and its recovery stays visible. */
export const completedLegacyDiscard = (job: JobView): boolean => job.kind === "deploy-discard" && job.status === "succeeded"
  && job.execution === "finished" && job.exitCode === 0 && job.outcome === "unverified" && job.params.discardCloud === undefined;

export function statusLabel(job: JobView): string {
  if (completedLegacyDiscard(job)) return "Done";
  if (job.outcome === "uncertain") return "Outcome uncertain";
  if (job.outcome === "unverified") return "Unverified";
  if (job.kind === "destroy" && job.status === "succeeded" && job.outcome === "confirmed") return "Deleted";
  if (job.cancelRequested && job.status === "running") return "Stopping";
  if (job.execution === "accepted") return "Accepted";
  if (job.execution === "dispatching") return "Starting";
  return STATUS_LABEL[job.status];
}

export const isProcess = (job: JobView) => isLocalProcessKind(job.kind);
const unresolved = (job: JobView) => !completedLegacyDiscard(job) && (job.outcome === "uncertain" || job.outcome === "unverified");

/** A persistent process stays running after startup; it is not unfinished work. */
export function isRunningProcess(job: JobView): boolean {
  return isProcess(job) && job.status === "running" && !job.cancelRequested && !job.observationProblem
    && (job.execution === undefined || job.execution === "running") && !unresolved(job);
}

/** Work that is progressing, as opposed to a process holding steady or a state in doubt. */
export const isBusy = (job: JobView) => job.status === "running" && !isRunningProcess(job) && !job.observationProblem && !unresolved(job);

export type StatusTone = "accept" | "refuse" | "caution" | "quiet";
export const toneClasses: Readonly<Record<StatusTone, string>> = {
  accept: "text-accept", refuse: "text-refuse", caution: "text-caution", quiet: "text-quiet",
};

/** What a status means. The bar, history and detail all colour it from here. */
export function statusTone(job: JobView): StatusTone {
  if (job.status === "failed") return "refuse";
  if (job.status === "interrupted" || job.observationProblem || unresolved(job)) return "caution";
  return job.status === "succeeded" || isRunningProcess(job) ? "accept" : "quiet";
}

/** Finished in a state someone must look at. A process stopped with Studio simply resumes on request. */
export function needsAttention(job: JobView): boolean {
  if (job.status === "running") return false;
  return job.status === "failed" || job.status === "interrupted" && !isProcess(job) || unresolved(job);
}

const START_KINDS = new Set<JobView["kind"]>(["local-start", "local-restart", "local-attach-watch"]);
const sameLocalDestination = (a: JobView, b: JobView) => (a.deployment ?? a.params.deployment) === (b.deployment ?? b.params.deployment)
  && a.params.profile === b.params.profile
  && ["account", "region"].every(key => !a.params[key] || !b.params[key] || a.params[key] === b.params[key]);

/** A successful retry resolves the alert, while the original failure stays in history.
 * Cloud uncertainty and another destination's success never count as recovery. */
export function recoveredLocalFailure(job: JobView, jobs: readonly JobView[]): boolean {
  if (!needsAttention(job) || unresolved(job) || job.execution === "lost") return false;
  if (!START_KINDS.has(job.kind) && job.kind !== "local-stop" && !isProcess(job)) return false;
  const ended = Date.parse(job.endedAt ?? job.startedAt);
  return jobs.some(next => {
    if (Date.parse(next.startedAt) <= ended || next.observationProblem || unresolved(next)) return false;
    if (isProcess(job)) return next.kind === job.kind && isRunningProcess(next) && next.params.profile === job.params.profile;
    return next.status === "succeeded" && sameLocalDestination(job, next)
      && (START_KINDS.has(job.kind) ? START_KINDS.has(next.kind) : next.kind === "local-stop");
  });
}

/** The job's result in the fewest honest words. */
export function jobOutcome(job: JobView, summary: string | undefined): string {
  if (job.status === "failed") {
    const step = job.steps?.find(entry => entry.status === "failed");
    return step ? `Failed at ${step.label}` : "Failed";
  }
  return job.status === "succeeded" && !unresolved(job) && summary ? summary : statusLabel(job);
}

/** Whole minutes and up, so a running clock changes at most once a minute. */
export function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function jobDuration(job: Pick<JobView, "startedAt" | "endedAt">): number | undefined {
  if (!job.endedAt) return undefined;
  const elapsed = Date.parse(job.endedAt) - Date.parse(job.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

export function compactAge(at: string, now = Date.now()): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.round((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface HistoryRow {
  readonly key: string;
  readonly title: string;
  /** The job this row opens and reports. In a group, the one most worth reading. */
  readonly job: JobView;
  /** Newest first; more than one makes the row a group. */
  readonly members: readonly JobView[];
}
export interface HistoryGroup { readonly label: string; readonly rows: readonly HistoryRow[] }

const SESSION_START = new Set<JobView["kind"]>(["local-start", "local-restart", "local-attach-watch"]);
const SESSION = new Set<JobView["kind"]>([...SESSION_START, "local-stop", "local-watch", "local-client", "local-logs"]);
const sameResult = (a: JobView, b: JobView) => a.title === b.title && a.kind === b.kind && statusLabel(a) === statusLabel(b);
const single = (job: JobView): HistoryRow => ({ key: job.id, title: job.title, job, members: [job] });

function collapse(finished: readonly JobView[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let index = 0; index < finished.length;) {
    const job = finished[index]!;
    let end = index;
    // Newest first, so a development session runs back to the start that opened it.
    while (end < finished.length && SESSION.has(finished[end]!.kind) && !SESSION_START.has(finished[end]!.kind)) end++;
    if (end > index && end < finished.length && SESSION_START.has(finished[end]!.kind)) {
      const members = finished.slice(index, end + 1);
      rows.push({ key: job.id, title: "Development session", job: members.find(needsAttention) ?? members.at(-1)!, members });
      index = end + 1;
      continue;
    }
    end = index + 1;
    while (end < finished.length && sameResult(finished[end]!, job)) end++;
    rows.push({ ...single(job), members: finished.slice(index, end) });
    index = end;
  }
  return rows;
}

/** Running work first and uncapped, then finished work with repetition folded away. */
export function activityHistory(jobs: readonly JobView[], now = new Date()): readonly HistoryGroup[] {
  const running = jobs.filter(job => job.status === "running");
  const rows = collapse(jobs.filter(job => job.status !== "running"));
  const today = now.toDateString();
  const finishedToday = (row: HistoryRow) => { const job = row.members[0]!; return new Date(job.endedAt ?? job.startedAt).toDateString() === today; };
  const groups: readonly HistoryGroup[] = [
    { label: "Running", rows: [...running.filter(job => !isProcess(job)),
      ...running.filter(isProcess).sort((a, b) => Number(b.kind === "local-logs") - Number(a.kind === "local-logs"))].map(single) },
    { label: "Today", rows: rows.filter(finishedToday) },
    { label: "Earlier", rows: rows.filter(row => !finishedToday(row)) },
  ];
  return groups.filter(group => group.rows.length);
}

const EXCERPT_CHARACTERS = 2800, LINE_CHARACTERS = 240;

function excerpt(lines: readonly JobLogLine[], anchor: JobLogLine | undefined): string {
  const at = anchor ? lines.indexOf(anchor) : -1;
  const window = at < 0 ? lines.slice(-24) : lines.slice(Math.max(0, at - 16), at + 9);
  const text = window.map(line => line.text.slice(0, LINE_CHARACTERS));
  while (text.length > 1 && text.join("\n").length > EXCERPT_CHARACTERS) text.shift();
  return text.join("\n");
}

/** An editable message for the Agent composer. Log text was sanitized before it was stored. */
export function askAgentPrompt(job: JobView, lines: readonly JobLogLine[], error: JobLogLine | undefined): string {
  const log = excerpt(lines, error);
  return [
    "Help me resolve this Studio operation.",
    "",
    `Operation: ${job.title}`,
    `Result: ${jobOutcome(job, job.status === "succeeded" ? undefined : job.summary)}`,
    ...(typeof job.exitCode === "number" ? [`Exit code: ${job.exitCode}`] : []),
    ...(job.recovery ? [`Note: ${job.recovery}`] : []),
    ...(log ? ["", "Log excerpt:", "```text", log, "```"] : []),
    "",
    "What went wrong, and what should I do next?",
  ].join("\n");
}

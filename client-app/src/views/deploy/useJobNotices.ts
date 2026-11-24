import { useEffect, useRef, useState } from "react";
import type { JobView } from "../../../shared/operations";
import { isProcess, recoveredLocalFailure, statusLabel, statusTone } from "./activity-model";

/** The latest job seen to finish while this page watched, for those not looking at the tray. */
export function useFinishedJob(jobs: readonly JobView[]): JobView | undefined {
  const running = useRef<ReadonlySet<string> | undefined>(undefined);
  const [finished, setFinished] = useState<JobView>();
  useEffect(() => {
    const previous = running.current;
    running.current = new Set(jobs.filter(job => job.status === "running").map(job => job.id));
    const ended = previous && jobs.find(job => previous.has(job.id) && job.status !== "running");
    if (ended) setFinished(ended);
  }, [jobs]);
  return finished;
}

const MARK = { accept: "✓", refuse: "✕", caution: "!", quiet: "–" } as const;

/** A tab in the background reports running work and what finished while it was away. */
export function useTabStatus(jobs: readonly JobView[], finished: JobView | undefined): void {
  const missed = useRef<JobView | undefined>(undefined);
  const base = useRef<string | undefined>(undefined);
  const running = jobs.filter(job => job.status === "running" && !isProcess(job)).length;
  useEffect(() => { if (finished && document.hidden) missed.current = finished; }, [finished]);
  useEffect(() => {
    base.current ??= document.title;
    const name = base.current;
    const report = () => {
      if (!document.hidden) { missed.current = undefined; document.title = name; return; }
      const job = missed.current && !recoveredLocalFailure(missed.current, jobs) ? missed.current : undefined;
      document.title = job ? `${MARK[statusTone(job)]} ${job.title} · ${name}` : running ? `(${running}) Running · ${name}` : name;
    };
    report();
    document.addEventListener("visibilitychange", report);
    return () => { document.removeEventListener("visibilitychange", report); document.title = name; };
  }, [running, finished, jobs]);
}

export const finishedAnnouncement = (job: JobView | undefined) => job ? `${job.title}: ${statusLabel(job)}` : "";

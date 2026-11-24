import { useEffect, useRef, useState } from "react";
import type { JobView } from "../../shared/operations";

export interface DeploymentProgress {
  readonly job: JobView;
  readonly checking: boolean;
}

/** The accepted apply owns the page until its terminal event and final read.
 * Intermediate AWS observations are evidence for Activity, not settled findings. */
export function useDeploymentProgress(connection: string, active: JobView | undefined, jobs: readonly JobView[], refresh: () => Promise<unknown>): DeploymentProgress | undefined {
  const observed = useRef<{ connection: string; job: JobView } | undefined>(undefined);
  const [finishing, setFinishing] = useState<{ connection: string; job: JobView }>();
  const generation = useRef(0);
  const previous = observed.current?.connection === connection ? observed.current : undefined;
  const checking = finishing?.connection === connection ? finishing : undefined;

  useEffect(() => {
    if (observed.current?.connection !== connection) observed.current = undefined;
    if (active) {
      generation.current++;
      observed.current = { connection, job: active };
      setFinishing(undefined);
      return;
    }
    const prior = observed.current;
    const terminal = prior && jobs.find(job => job.id === prior.job.id && job.status !== "running");
    if (!prior || !terminal) return;
    observed.current = undefined;
    const current = ++generation.current;
    setFinishing({ connection, job: terminal });
    // A rejected read ends the transition too: its real retry/error state belongs
    // on the page once execution has finished, rather than a permanent spinner.
    void Promise.resolve().then(refresh).catch(() => {}).finally(() => {
      if (generation.current === current) setFinishing(undefined);
    });
  }, [connection, active, jobs, refresh]);

  useEffect(() => () => { generation.current++; }, []);
  return active ? { job: active, checking: false }
    : previous ? { job: previous.job, checking: true }
    : checking ? { job: checking.job, checking: true } : undefined;
}

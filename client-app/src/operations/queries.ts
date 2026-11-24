import { queryOptions } from "@tanstack/react-query";
import type { JobView } from "../../shared/operations";
import { operationsApi } from "./api";

/** The one order every reader sees: the server's list follows last change, which moves rows. */
export const orderJobs = (jobs: readonly JobView[]): JobView[] =>
  [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));

const operationsKey = ["operations"] as const;
type Operations = { jobs: JobView[] };

export const operationsQuery = () => queryOptions({
  queryKey: operationsKey,
  queryFn: async ({ client }) => {
    const before = client.getQueryData<Operations>(operationsKey);
    const response = await operationsApi.list();
    const current = client.getQueryData<Operations>(operationsKey);
    if (before === current) return response;

    // Protect only changes received while this GET was pending. A later uncontended
    // read remains authoritative, including removal of jobs pruned by the server.
    const previous = new Map(before?.jobs.map(job => [job.id, job]));
    const jobs = new Map(response.jobs.map(job => [job.id, job]));
    let retained = false;
    for (const job of current?.jobs ?? []) {
      if (job === previous.get(job.id)) continue;
      const returned = jobs.get(job.id);
      if (!returned || returned.lastSeq < job.lastSeq || job.status !== "running" && returned.status === "running") {
        jobs.set(job.id, job);
        retained = true;
      }
    }
    return retained ? { jobs: orderJobs([...jobs.values()]) } : response;
  },
});

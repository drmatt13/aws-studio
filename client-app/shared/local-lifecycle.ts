import type { JobView, LocalRunView } from "./deploy";

/**
 * The one verdict about a checkout's local runtime. The checkout host derives it
 * from Docker, its supervised processes and its own operations, so every tab, page
 * load and window reads the same answer instead of reconstructing one from
 * per-browser memory.
 *
 * - off: no application compute is running. Docker-revived database
 *   infrastructure (restart policies) and leftover support processes are not a session.
 * - starting: a start/reconnect is in flight, or compute is demonstrably warming.
 * - running: compute and its support processes are ready.
 * - stopping: a stop is in flight.
 * - attention: compute is live but not ready and nothing is converging it. The switch
 *   stays on so it can be turned off, which always returns to a clean off.
 */
export type RuntimeLifecycle = "off" | "starting" | "running" | "stopping" | "attention";

export type RuntimeOperationKind = "local-start" | "local-stop" | "local-restart" | "local-attach-watch";

const OPERATION_KINDS: ReadonlySet<string> = new Set<RuntimeOperationKind>(["local-start", "local-stop", "local-restart", "local-attach-watch"]);

/** An in-flight local runtime operation; supervised watch/client/log processes are not operations. */
export function runtimeOperationKind(job: Pick<JobView, "kind" | "status"> | undefined): RuntimeOperationKind | undefined {
  return job?.status === "running" && OPERATION_KINDS.has(job.kind) ? job.kind as RuntimeOperationKind : undefined;
}

/**
 * `activeContainerCount` counts application compute, so it is the single measure of
 * whether a session exists. Undefined means Docker could not be observed: unknown,
 * which is never rendered as off.
 */
export function deriveRuntimeLifecycle(
  view: Pick<LocalRunView, "docker" | "observationProblem" | "activeContainerCount" | "readiness" | "restartNeeded" | "recovery">,
  operation?: RuntimeOperationKind,
): RuntimeLifecycle | undefined {
  if (operation === "local-stop") return "stopping";
  if (operation) return "starting";
  if (view.observationProblem || view.docker.engine === "unknown" || view.activeContainerCount === undefined) return undefined;
  if (view.activeContainerCount === 0) return "off";
  if (view.recovery?.state === "reconnecting") return "starting";
  if (view.recovery?.state === "failed") return "attention";
  const readiness = view.readiness;
  if (readiness?.state === "ready") return view.restartNeeded.length ? "attention" : "running";
  if (readiness?.state === "starting") return readiness.progressing === false ? "attention" : "starting";
  return "attention";
}

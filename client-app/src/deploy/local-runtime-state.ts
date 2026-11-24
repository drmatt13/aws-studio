import type { JobView, LocalRunView } from "../../shared/deploy";
import { LOCAL_START_STEPS, LOCAL_STOP_STEPS } from "../../shared/operations";
import { deploymentPresence } from "./presence";

/** The host's verdict: anything but off is engaged. Unknown (no verdict) is never engaged by itself. */
export function localRuntimeActive(local: LocalRunView | undefined): boolean {
  return Boolean(local?.lifecycle && local.lifecycle !== "off");
}

/** An idle runtime belongs on the map only after its development deployment exists.
 * Active checkout work stays reachable for Stop when AWS cannot be observed.
 * A foreign project's ownership conflict never establishes a local session.
 */
export function runtimeVisible(input: Parameters<typeof deploymentPresence>[0] & { readonly engaged: boolean }): boolean {
  const presence = deploymentPresence(input);
  if (presence.state === "absent") return false;
  return input.engaged || input.scope.mode === "dev" && input.availability === "available"
    && !input.retained && presence.state === "deployed"
    && Boolean(input.status?.detail?.stacks.every(stack => ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(stack.status)));
}

/** Unknown Docker observations cannot turn last-known active work into a stopped runtime. */
export function mergeLocalRuntime(previous: LocalRunView | undefined, next: LocalRunView): LocalRunView {
  return next.observationProblem && localRuntimeActive(previous) && !localRuntimeActive(next)
    ? { ...previous!, operation: next.operation, observationProblem: next.observationProblem, readiness: next.readiness, recovery: next.recovery, ownershipConflict: next.ownershipConflict }
    : next;
}

/** Short captions for the running step, so the switch narrates real progress rather than a spinner. */
const STEP_CAPTIONS: Readonly<Record<string, string>> = {
  [LOCAL_START_STEPS.verify]: "Checking AWS…",
  [LOCAL_START_STEPS.environment]: "Generating client environment…",
  [LOCAL_START_STEPS.sources]: "Generating code…",
  [LOCAL_START_STEPS.database]: "Preparing database…",
  [LOCAL_START_STEPS.containers]: "Starting containers…",
  [LOCAL_START_STEPS.client]: "Starting web client…",
  [LOCAL_STOP_STEPS.client]: "Stopping web client…",
  [LOCAL_STOP_STEPS.containers]: "Stopping containers…",
};

export function runtimeStepCaption(job: JobView | undefined): string | undefined {
  const step = job?.status === "running" ? job.steps?.find(entry => entry.status === "running") : undefined;
  return step ? STEP_CAPTIONS[step.label] ?? (step.label.startsWith("Export ") ? "Exporting outputs…" : undefined) : undefined;
}

/**
 * What the switch shows. The checkout host decides whether the runtime is off, starting, running or
 * stopping (`local.lifecycle`) and reports the operation it is performing, so every tab and a freshly
 * loaded page agree. This tab adds only what it alone knows: the request it just submitted, and a
 * finished operation that no observation has confirmed yet, so the switch never flickers backwards.
 */
export function runtimePresentation(input: { readonly local?: LocalRunView; readonly problem?: string;
  readonly job?: JobView; readonly submitting?: "local-start" | "local-stop" | "local-restart";
  /** The job was seen to finish and no runtime observation has arrived since. */
  readonly unobserved?: boolean }) {
  const { local, job } = input;
  const lifecycle = local?.lifecycle;
  const active = localRuntimeActive(local);
  const pending = input.submitting ?? (job?.status === "running" ? job.kind : undefined) ?? local?.operation?.kind;
  // Reconnecting to existing compute is starting without being busy: the switch stays available to stop it.
  const busy = Boolean(pending && pending !== "local-attach-watch");
  // A command that just succeeded is not yet reflected by an observation read before it
  // finished. Until a new read lands, a start is still starting and a stop still stopping.
  const unobserved = !pending && !input.problem && input.unobserved === true && job?.status === "succeeded";
  const settling = unobserved && (job.kind === "local-start" || job.kind === "local-restart");
  const draining = unobserved && job.kind === "local-stop";
  // An unavailable observation retains engagement, not a finished transition. Only a
  // current operation may keep that transition busy while Docker cannot be observed.
  const stopping = pending === "local-stop" || draining || !input.problem && lifecycle === "stopping";
  const starting = !stopping && (Boolean(pending) || settling || !input.problem && lifecycle === "starting");
  const ready = lifecycle === "running" && !pending && !draining && !input.problem && !local?.ownershipConflict;
  const caption = input.submitting ? undefined : runtimeStepCaption(job);
  const label = stopping ? caption ?? "Stopping…"
    : local?.ownershipConflict ? "Ownership conflict" : input.problem ? "Status unavailable" : !local ? "Checking…"
    : starting ? caption ?? "Starting…" : !lifecycle ? "Checking…"
    : lifecycle === "running" ? "Running" : lifecycle === "attention" ? "Needs attention" : "Stopped";
  const phase: "starting" | "stopping" | undefined = stopping ? "stopping" : starting ? "starting" : undefined;
  // The switch describes whether runtime work is engaged. Health is a separate
  // label, so a runtime that needs attention remains on and can be explicitly stopped.
  return { active, ready, busy, label, phase, on: active || busy || phase !== undefined };
}

/** Starting is available only after positive AWS and host evidence, never from a saved export alone. */
export function runtimeStartEligibility(input: Parameters<typeof deploymentPresence>[0] & {
  readonly local?: LocalRunView; readonly localProblem?: string;
  readonly operationsKnown: boolean; readonly operationProblem?: string; readonly work?: JobView;
}) {
  const blocked = (hint: string, message: string) => ({ blocked: true, hint, message });
  if (!input.scope.profile) return blocked("Choose a dev profile", "Choose a Development AWS profile before starting locally.");
  if (input.problem) return blocked("Check development status", input.problem.message);
  if (input.availability !== "available") return blocked("Check your AWS profile", "The Development AWS profile is not confirmed available. Open Deploy to check it.");
  if (!input.target) return blocked("Deploy development first", "Declare and deploy a development stack before starting locally.");
  if (!input.status || input.retained) return blocked("Checking deployment…", "Wait for your development deployment to be verified before starting locally.");
  const presence = deploymentPresence(input);
  if (presence.state !== "deployed" || !input.status.detail?.stacks.every(stack => ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"].includes(stack.status)))
    return blocked(input.status.detail?.state.kind === "in-progress" ? "Deployment in progress"
    : presence.state === "absent" ? "Deploy development first" : "Deployment needs attention",
    "Local runtime requires a fully completed development deployment in the selected AWS account and region. Open Deploy to finish or review it.");
  if (input.status.detail?.local?.compatible !== true) return blocked("Deploy current changes", input.status.detail?.local?.problem
    ?? "The deployed development resources are not confirmed compatible with this source. Synthesize, review and deploy the required changes first.");
  if (input.localProblem) return blocked("Check runtime status", input.localProblem);
  if (!input.local?.lifecycle) return blocked("Checking runtime…", "Wait for the local runtime status check before starting.");
  if (!input.operationsKnown) return blocked("Check Activity status", input.operationProblem ?? "Wait for Activity to confirm that no other operation owns this checkout.");
  if (input.work) return blocked(input.work.status === "running" ? "Wait for current operation" : "Inspect previous operation",
    input.work.status === "running" ? "Wait for the current operation to finish before starting local runtime."
      : "An earlier operation has an uncertain outcome. Inspect Activity before starting local runtime.");
  return { blocked: false, hint: "Stopped", message: undefined };
}


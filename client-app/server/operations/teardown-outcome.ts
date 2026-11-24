import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TeardownPlan } from "aws-studio/cli/destroy";
import type { JobView, OperationIntent, OperationRecord } from "../../shared/operations";
import { OPERATIONS_VERSION } from "../../shared/operations";
import { teardownReviewPath } from "../deploy/plans";

interface TeardownReceipt {
  readonly digest: string;
  readonly deployment: string;
  readonly account: string;
  readonly region: string;
  readonly state: string;
  readonly completed: readonly string[];
  readonly pending?: string;
  readonly problem?: string;
  readonly updatedAt: string;
}

/** The CLI waits for AWS to confirm each immutable StackId before recording completion.
 * This proves the reviewed stack deletion, not removal of retained resources/secrets. */
export function verifiedTeardownOutcome(state: string, intent: OperationIntent): Pick<JobView, "outcome" | "summary" | "completionDetail" | "recovery"> | undefined {
  if (intent.version !== OPERATIONS_VERSION || intent.request.kind !== "destroy" || intent.view.kind !== "destroy") return;
  try {
    const file = teardownReviewPath(state, String(intent.request.params.review));
    const text = readFileSync(file, "utf8");
    if (intent.binding !== createHash("sha256").update(JSON.stringify(text)).digest("hex")) return;
    const review: TeardownPlan = JSON.parse(text);
    const receipt: TeardownReceipt = JSON.parse(readFileSync(file + ".result.json", "utf8"));
    if (review.version !== 1 || typeof review.digest !== "string" || !/^[a-f0-9]{64}$/.test(review.digest)
      || review.deployment !== intent.request.params.deployment || review.deployment !== intent.view.deployment
      || review.deployment !== intent.view.params.deployment || review.mode !== intent.request.params.mode || review.mode !== intent.view.params.mode
      || !/^[0-9]{12}$/.test(review.account) || typeof review.region !== "string" || !review.region
      || intent.request.params.region !== undefined && intent.request.params.region !== review.region
      || receipt.digest !== review.digest || receipt.deployment !== review.deployment || receipt.account !== review.account || receipt.region !== review.region
      || receipt.state !== "succeeded" || receipt.pending !== undefined || receipt.problem !== undefined
      || !Number.isFinite(Date.parse(receipt.updatedAt)) || !(Date.parse(receipt.updatedAt) >= Date.parse(review.createdAt))) return;
    const ids = review.stacks.map(stack => stack.id);
    if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length || !Array.isArray(receipt.completed)
      || receipt.completed.length !== ids.length || new Set(receipt.completed).size !== ids.length
      || !ids.every(id => receipt.completed.includes(id))) return;
    return {
      outcome: "confirmed", recovery: undefined,
      summary: ids.length === 1 ? "The reviewed stack was deleted." : ids.length ? `All ${ids.length} reviewed stacks deleted.` : "No reviewed stacks remain.",
      completionDetail: `CloudFormation verified deletion in ${review.account} · ${review.region}. Retained resources and managed secrets are separate.`,
    };
  } catch { /* Missing, unreadable or differently scoped evidence cannot prove deletion. */ }
}

export const needsTeardownProjection = (job: JobView): boolean => job.kind === "destroy" && job.status === "succeeded"
  && job.execution === "finished" && job.exitCode === 0 && job.outcome === "unverified";

/** Older runners marked every deletion unverified. Project exact saved evidence without
 * rewriting history, releasing claims, or promoting lost/failed execution. */
export function projectTeardownOutcome(state: string, record: OperationRecord): JobView {
  if (!needsTeardownProjection(record.view)) return record.view;
  if (record.view.deployment !== record.intent.view.deployment
    || record.view.params.deployment !== record.intent.view.params.deployment || record.view.params.mode !== record.intent.view.params.mode) return record.view;
  const outcome = verifiedTeardownOutcome(state, record.intent);
  return outcome ? { ...record.view, ...outcome } : record.view;
}

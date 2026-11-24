/** Browser-safe operation protocol. Domain approval and result documents remain authoritative. */
export const OPERATIONS_VERSION = 1 as const;
/** Retained to recognize failed database gates in existing Activity journals. */
export const LOCAL_DATABASE_VERIFICATION_STEP = "Verify local database";
/** Initializes proven empty local storage, then verifies the saved contract. */
export const LOCAL_DATABASE_PREPARATION_STEP = "Prepare local database";
/** Stable local runtime step labels. Activity lists them and the map's Local runtime card narrates them. */
export const LOCAL_START_STEPS = {
  verify: "Verify the development deployment and Docker",
  environment: "Generate client-app/.env.development.local and local runtime settings",
  sources: "Generate source projections",
  database: LOCAL_DATABASE_PREPARATION_STEP,
  containers: "Start local application containers",
  client: "Watch source and start the web client",
} as const;
export const LOCAL_STOP_STEPS = { client: "Stop the watch and the web client", containers: "Stop containers" } as const;

/** Steady local processes are runtime support, not unfinished operations. */
export const LOCAL_PROCESS_KINDS = ["local-watch", "local-client", "local-logs"] as const;
export type LocalProcessKind = typeof LOCAL_PROCESS_KINDS[number];
export const isLocalProcessKind = (kind: string): kind is LocalProcessKind => (LOCAL_PROCESS_KINDS as readonly string[]).includes(kind);

export type OperationKind =
  | "deploy-plan" | "deploy-apply" | "deploy-discard" | "destroy-plan" | "destroy"
  | "export" | "local-start" | "local-stop" | "local-restart" | "local-attach-watch"
  | "deps-install" | "docker-start" | "aws-login" | "drift" | "framework-check";

export interface OperationRequest {
  readonly kind: OperationKind;
  readonly params: Readonly<Record<string, string | boolean | undefined>>;
  readonly requestKey?: string;
}

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export interface JobStep {
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "failed" | "skipped";
  readonly startedAt?: string;
  readonly endedAt?: string;
}
export interface JobView {
  readonly id: string;
  readonly kind: OperationKind | LocalProcessKind;
  readonly title: string;
  readonly params: Readonly<Record<string, string | boolean | undefined>>;
  readonly status: JobStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number | null;
  readonly summary?: string;
  /** Informational context for a confirmed result; does not require recovery. */
  readonly completionDetail?: string;
  readonly planId?: string;
  readonly deployment?: string;
  readonly lastSeq: number;
  readonly steps?: readonly JobStep[];
  readonly execution?: "accepted" | "dispatching" | "running" | "finished" | "lost";
  readonly outcome?: "pending" | "confirmed" | "unverified" | "uncertain";
  readonly recovery?: string;
  readonly observationProblem?: string;
  readonly origin?: "/deploy" | "/";
  readonly cancelRequested?: boolean;
}
export interface JobLogLine {
  readonly seq: number;
  readonly at: string;
  readonly stream: "out" | "err" | "info";
  readonly text: string;
}

/** One step's next state, keeping when it ran so a page can say how long each took. */
export function advanceStep(step: JobStep, status: JobStep["status"], at: string): JobStep {
  if (status === "running") return { ...step, status, startedAt: at };
  return status === "done" || status === "failed" ? { ...step, status, endedAt: at } : { ...step, status };
}

/** Whether an operation can change AWS. Stopping one cannot promise that AWS stops too. */
export function changesAws({ kind, params }: Pick<JobView, "kind" | "params">): boolean {
  return kind === "deploy-apply" || kind === "deploy-discard" && params.discardCloud !== false || kind === "destroy"
    || kind === "deploy-plan" && (params.review === "change-set" || params.createSecrets === true || params.autoApply === true);
}

/** Stored intent contains identifiers and approved options, never commands or credentials. */
export interface OperationIntent {
  readonly version: typeof OPERATIONS_VERSION;
  readonly workspace: string;
  readonly request: OperationRequest;
  readonly locks: readonly string[];
  readonly consumptionKey?: string;
  /** Digest of public review/target evidence. Private input values never enter this digest. */
  readonly binding?: string;
  readonly view: Omit<JobView, "id" | "startedAt" | "lastSeq" | "status">;
}

import type { ExecutionIdentity } from "aws-studio/source/execution-identity";
export type { ExecutionIdentity };

export interface OperationRecord {
  readonly intent: OperationIntent;
  readonly view: JobView;
  readonly dispatchToken?: string;
  readonly owner?: ExecutionIdentity;
}

/** Browser-safe coding-task contract. Paths, provider credentials and approval bytes stay in the host. */
export const AGENT_RUNTIME_VERSION = 1 as const;
export type CodingProvider = "codex" | "claude";
export type ContractRunMode = "stage" | "sequential";
export interface AgentRuntimeUpgradeIntentView {
  readonly requestId: string;
  readonly replacesRequestId?: string;
  readonly targetDigest: string;
  readonly phase: "prepared" | "draining" | "starting" | "ready" | "failed";
  readonly error?: string;
}
export interface AgentRuntimeUpgradeView { readonly intent?: AgentRuntimeUpgradeIntentView }
export type CodingValidationPlan = { readonly kind: "project" } | { readonly kind: "framework" } | { readonly kind: "tests"; readonly paths: readonly string[] };
export type CodingTaskStatus =
  | "queued" | "preparing" | "running" | "validating" | "waiting_for_permission"
  | "awaiting_review" | "conflicted" | "integrating" | "completed"
  | "interrupted" | "failed" | "cancelled" | "rejected" | "recovery_required";

export interface CodingTaskRequest {
  readonly requestKey: string;
  readonly provider: CodingProvider;
  readonly prompt: string;
  readonly model?: string;
  /** Bounded, allow-listed context is evidence, never authorization. */
  readonly context?: string;
  readonly validation?: CodingValidationPlan;
  readonly contract?: import("./contract-propagation").ContractCodingContext;
  /** Sequential execution retains checkpoint validation and explicit final source approval. */
  readonly contractRun?: ContractRunMode;
}

/** Host observations of private candidate bytes; never saved-source review evidence. */
export interface ContractCheckpoint {
  readonly stage: import("./contract-propagation").ContractStage;
  readonly candidateDigest: string;
  readonly inputDigest: string;
  readonly validatedAt: string;
  readonly status: "passed" | "failed" | "unavailable" | "stale";
  readonly checks: readonly CodingValidation[];
  readonly decisions: readonly import("./contract-propagation").ContractDecision[];
  /** Resolves only in this task's candidate-scoped proof map. */
  readonly receiptId?: string;
}
export interface CodingContractProgress {
  readonly context: import("./contract-propagation").ContractCodingContext;
  readonly stage: import("./contract-propagation").ContractStage;
  readonly run?: ContractRunMode;
  readonly status: "working" | "checkpoint" | "ready" | "applied-awaiting-check";
  readonly checkpoints: readonly ContractCheckpoint[];
  readonly decisions: readonly import("./contract-propagation").ContractDecision[];
  readonly nextStage?: import("./contract-propagation").ContractStage;
  readonly gateReason?: string;
  readonly repairStage?: "client";
  /** Latest independent observations, stored once; never saved-source acceptance. */
  readonly proofs?: import("aws-studio/contract-chain/contract-proof").ContractProofReceipts;
  readonly approval?: { readonly status: "checking" | "approved" | "failed"; readonly message: string };
}

export interface CodingTask {
  readonly id: string;
  readonly provider: CodingProvider;
  readonly prompt: string;
  readonly model?: string;
  readonly status: CodingTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;
  readonly sessionId?: string;
  readonly proposalDigest?: string;
  readonly summary?: string;
  /** Bounded native final answer, separate from the host's outcome and check evidence. */
  readonly agentSummary?: string;
  readonly cancelRequested: boolean;
  readonly canResumeValidation?: boolean;
  readonly activation?: "none" | "restart_required" | "dependency_install_required";
  readonly sourceOutcome?: "unchanged" | "applied" | "restored" | "kept" | "recovery_required";
  readonly workspaceDisposition?: "cleanup_pending" | "source_only";
  readonly runtimeActivation?: { readonly status: "starting" | "ready" | "failed"; readonly detail: string };
  readonly contract?: CodingContractProgress;
}

export interface CodingEvent {
  readonly seq: number;
  readonly taskId: string;
  readonly at: string;
  readonly type: "state" | "message" | "command" | "file" | "permission" | "session" | "diagnostic" | "validation" | "proposal";
  readonly data: Readonly<Record<string, unknown>>;
}

export interface CodingChange {
  readonly path: string;
  readonly kind: "add" | "modify" | "delete";
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly beforeMode: number | null;
  readonly afterMode: number | null;
  readonly binary: boolean;
  readonly diff: string;
}

export interface CodingProposal {
  readonly id: string;
  readonly taskId: string;
  readonly digest: string;
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly createdAt: string;
  readonly changes: readonly CodingChange[];
  readonly activation: NonNullable<CodingTask["activation"]>;
  readonly limitations: readonly string[];
  readonly validation: readonly CodingValidation[];
  readonly architecturePreview?: import("./architecture-preview").ArchitecturePreview;
  /** Added by the Studio server, which holds the graph: the ownership check approval enforces. */
  readonly ownership?: CodingOwnershipReview;
}

/** A Coding-task proposal checked against ownership. `refusal` blocks approval. */
export interface CodingOwnershipReview {
  readonly checked: boolean;
  readonly transitions: readonly { readonly entity: string; readonly from: import("./model").Owner; readonly to: import("./model").Owner; readonly file: string }[];
  readonly refusal?: string;
}

export interface CodingValidation {
  readonly command: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly exitCode?: number | null;
  readonly candidateDigest: string;
  readonly detail?: string;
}

export const ACTIVE_CODING_STATUSES: readonly CodingTaskStatus[] = [
  "queued", "preparing", "running", "validating", "waiting_for_permission", "integrating",
];

export function codingTaskActive(task: Pick<CodingTask, "status">): boolean {
  return ACTIVE_CODING_STATUSES.includes(task.status);
}

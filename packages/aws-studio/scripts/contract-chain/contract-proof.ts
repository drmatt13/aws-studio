import type { ChainConfidence, Diagnostic } from "./graphql-chain";

export const CONTRACT_PROOF_VERSION = 1 as const;
export const REVIEW_DECISION_LIMIT = 4000;
export type ProofStage = "database" | "api" | "codegen" | "client";
export const PROOF_STAGES: readonly ProofStage[] = ["database", "api", "codegen", "client"];
/** Evidence stages project the existing richer application dependency graph. */
export const PROOF_PREDECESSORS: Readonly<Record<ProofStage, readonly ProofStage[]>> = { database: [], api: ["database"], codegen: ["api"], client: ["api", "codegen"] };
export interface ReviewDecision { readonly statement: string; readonly evidence: string }
export interface ReviewDecisions { readonly api?: ReviewDecision; readonly client?: ReviewDecision }
export interface ProofPolicy { readonly id: string; readonly digest: string }
export interface ProofToolchain {
  /** Exact supported Node version; changing it requires fresh proof renewal. */
  readonly node: string;
  readonly packages: Readonly<Record<string, string>>;
  readonly lockfileDigest: string;
  /** Portable installed common-source bytes; platform-specific native code is execution-scoped. */
  readonly dependencyDigest: string;
}
export interface ProofCheck {
  readonly id: string;
  readonly version: 1;
  readonly outcome: "passed" | "failed" | "blocked" | "unavailable";
  /** Content-bound declared suite/configuration inventory, never a captured payload. */
  readonly evidence: string;
  readonly diagnostics: readonly { readonly code: string; readonly file?: string }[];
}
/** Content-addressed evidence, not a signature or an authenticated reviewer identity. */
export interface ContractProofReceipt {
  readonly version: 1;
  readonly id: string;
  readonly stage: ProofStage;
  readonly scope: "saved" | "candidate";
  /** Relevant normalized source identity; unrelated workspace files do not change it. */
  readonly sourceRevision: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly implementation: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly predecessors: Readonly<Partial<Record<ProofStage, string>>>;
  readonly policy: ProofPolicy;
  readonly toolchain: ProofToolchain;
  readonly checks: readonly ProofCheck[];
  /** Candidate decisions are retained once in the Coding checkpoint; source notes in review. */
  readonly decisionDigest: string;
  readonly review: { readonly scope: "api" | "client"; readonly decision: ReviewDecision } | null;
  readonly limitations: readonly string[];
}
export type ContractProofReceipts = Readonly<Partial<Record<ProofStage, ContractProofReceipt>>>;
export interface ProofStageView {
  readonly stage: ProofStage;
  readonly status: ChainConfidence["status"];
  /** Recomputed by the current verifier, never restored as current from storage. */
  readonly current: ContractProofReceipt | null;
  readonly recorded: ContractProofReceipt | null;
  readonly predecessors: readonly { readonly stage: ProofStage; readonly recorded: string | null; readonly current: string | null; readonly matches: boolean }[];
  readonly diagnostics: readonly Diagnostic[];
  readonly action: string;
}
export interface ContractProofView {
  readonly version: 1;
  readonly policy: ProofPolicy;
  readonly stages: readonly ProofStageView[];
  /** Authority labels on imported reports are claims, never authenticated CI identity. */
  readonly ci: { readonly status: "not-observed" | "matching" | "different" | "unavailable"; readonly message: string };
}

import type { CodingTask, ContractCheckpoint } from "../../shared/agent-runtime";
import { buildContractCodingContext } from "../../shared/contract-propagation";
import { graphqlChainFixture } from "./graphql-chain";
import { proofReceiptFixture } from "./contract-proof";
import type { ContractStage } from "../../shared/contract-propagation";

export function contractTaskFixture(stage: ContractStage = "api"): CodingTask {
  const context = buildContractCodingContext(graphqlChainFixture(), stage);
  const proofs = { database: proofReceiptFixture("database", "candidate"), api: proofReceiptFixture("api", "candidate"), codegen: proofReceiptFixture("codegen", "candidate"), client: proofReceiptFixture("client", "candidate") };
  const checkpoint: ContractCheckpoint = { stage, candidateDigest: "candidate", inputDigest: "inputs", receiptId: proofs[stage].id, validatedAt: "2026-11-12T12:00:00Z", status: "passed", checks: [{ command: "Independent repository/API checks", status: "passed", candidateDigest: "candidate" }], decisions: context.decisions };
  return { id: "contract-task", provider: "codex", prompt: "Reconcile the repository and API contract", status: "awaiting_review", createdAt: checkpoint.validatedAt, updatedAt: checkpoint.validatedAt, lastSeq: 2, proposalDigest: "proposal", cancelRequested: false, sourceOutcome: "unchanged", contract: { context, stage, status: "checkpoint", proofs, checkpoints: [checkpoint], decisions: context.decisions, ...(stage === "api" ? { nextStage: "codegen" as const } : stage === "codegen" ? { nextStage: "client" as const } : {}) } };
}

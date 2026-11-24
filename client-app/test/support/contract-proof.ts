import type { ContractProofReceipt, ContractProofView, ProofStage } from "aws-studio/contract-chain/contract-proof";
import { createProofReceipt, proofDigest } from "aws-studio/contract-chain/proof-core";

export const proofPolicyFixture = { id: "contract-chain/offline-v1", digest: "f".repeat(64) };
export function proofReceiptFixture(stage: ProofStage, scope: ContractProofReceipt["scope"] = "saved"): ContractProofReceipt {
  const predecessors = stage === "database" ? {} : stage === "api" ? { database: proofReceiptFixture("database", scope).id } : stage === "codegen" ? { api: proofReceiptFixture("api", scope).id } : { api: proofReceiptFixture("api", scope).id, codegen: proofReceiptFixture("codegen", scope).id };
  const review = scope === "saved" && (stage === "api" || stage === "client") ? { scope: stage, decision: { statement: stage === "api" ? "Preserve the approved public API and ownership rules." : "Preserve approved selections and Project cache invalidation.", evidence: "Developer reviewed the actual source and independent checks." } } : null;
  return createProofReceipt({ version: 1, stage, scope, sourceRevision: "1".repeat(64), inputs: { source: "2".repeat(64) }, implementation: "3".repeat(64), outputs: { artifact: "4".repeat(64) }, predecessors,
    policy: proofPolicyFixture, toolchain: { node: "Node 24", packages: { graphql: "16.14.0", typescript: "5.9.3" }, lockfileDigest: "5".repeat(64), dependencyDigest: "7".repeat(64) },
    checks: [{ id: `${stage}-checks`, version: 1, outcome: "passed", evidence: "6".repeat(64), diagnostics: [] }], decisionDigest: proofDigest(review?.decision ?? null), review,
    limitations: ["Offline contract checks; no live database or deployment behavior is established."] });
}

export function proofViewFixture(): ContractProofView {
  const stages = ["database", "api", "codegen", "client"] as const;
  return { version: 1, policy: proofPolicyFixture, stages: stages.map(stage => {
    const receipt = proofReceiptFixture(stage);
    return { stage, status: "verified" as const, current: receipt, recorded: receipt, diagnostics: [], action: "Current independent checks and required review declarations match.", predecessors: Object.entries(receipt.predecessors).map(([stage, id]) => ({ stage: stage as ProofStage, recorded: id!, current: id!, matches: true })) };
  }), ci: { status: "not-observed", message: "No CI report has been loaded. CI independently executes the required policy." } };
}

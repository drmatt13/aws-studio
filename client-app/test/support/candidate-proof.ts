import type { ContractValidationOptions } from "../../server/agent-runtime/contract-validation";
import { contractDecisionDigest } from "../../server/agent-runtime/contract-validation";
import { buildContractProof } from "aws-studio/contract-chain/proof";
import { proofDigest } from "aws-studio/contract-chain/proof-core";
import { fixtureProofIdentity, verifiedEvaluation } from "./chain-verification";
import { parseReviewRecord } from "aws-studio/contract-chain/core";
import { recordContents } from "aws-studio/contract-chain/inspector";

/** Explicit metadata for trusted unit validators; actual end-to-end suites use the worker. */
export async function candidateProofsFixture(input: Pick<ContractValidationOptions, "workspace" | "decisions">) {
  const evaluation = verifiedEvaluation("type Query { value: String }");
  let record = null;
  try { const source = recordContents(input.workspace.workingDirectory); if (source !== null) record = parseReviewRecord(source); } catch { /* Explicit malformed record fixtures remain unavailable as origins. */ }
  return buildContractProof({ identity: await fixtureProofIdentity(input.workspace.workingDirectory), evaluation, record, models: {}, sdlDigest: proofDigest(evaluation.sdl), codegenChecks: [{ status: "passed" }], scope: "candidate",
    candidateDecisions: { api: contractDecisionDigest("api", input.decisions ?? []), client: contractDecisionDigest("client", input.decisions ?? []) } }).receipts;
}

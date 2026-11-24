import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ContractStage, ContractDecision } from "../../shared/contract-propagation";
import type { ReviewDecisions } from "aws-studio/contract-chain/contract-proof";
import { projectContractInspection, type ContractToolchain } from "./contract-validation";
import { readSourceManifest, type AgentProposal, type AgentWorkspace } from "aws-studio/source/workspace";
import { withSourceWrite } from "aws-studio/source/source-gate";
import { sourceContents, writeSourceChange } from "aws-studio/source/io";
import { readRuntimeArtifacts } from "aws-studio/contract-chain/evaluation";
import { GraphQLChainService } from "../graphql-chain/service";
import { GraphQLChainReviews } from "../graphql-chain/review";
import { proofDigest, readReviewDecision } from "aws-studio/contract-chain/proof-core";
import { dependencyContentIdentity, withDependencyObservationScope } from "aws-studio/contract-chain/dependencies";

/** Review receipts may have been published immediately before a host interruption.
 * Every authored byte must still match the accepted proposal when retrying. */
export function assertContractAppliedSource(workspace: AgentWorkspace, proposal: AgentProposal): void {
  const expected = { ...workspace.baseline.files };
  for (const change of proposal.changes) {
    if (change.after) expected[change.path] = change.after;
    else delete expected[change.path];
  }
  const source = (files: typeof expected) => Object.entries(files).filter(([name]) => name !== "graphql-chain.review.json").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (proofDigest(source(readSourceManifest(workspace.repositoryRoot).files)) !== proofDigest(source(expected))) throw new Error("Saved source changed after application. Run the affected stage again before approving it.");
}

/** Trusted host finalization. The run request establishes intent, the source proposal
 * establishes the applied bytes, and new saved-source checks establish acceptance.
 */
export async function finalizeContractStages(workspace: AgentWorkspace, proposal: AgentProposal, stages: readonly ContractStage[], decisions: readonly ContractDecision[], toolchain?: ContractToolchain): Promise<void> {
  let service: GraphQLChainService | undefined;
  try {
    const review = await withDependencyObservationScope(workspace.repositoryRoot, undefined, async () => {
      if (workspace.dependencyDigest !== undefined && await dependencyContentIdentity(workspace.repositoryRoot) !== workspace.dependencyDigest) throw new Error("Installed project dependencies changed after candidate validation. Restore the reviewed installation and retry saved-source approval.");
      const root = workspace.repositoryRoot;
      const assertApplied = () => assertContractAppliedSource(workspace, proposal);
      if (decisions.some(item => item.status !== "established" || !item.value || !item.evidence)) throw new Error("Resolve application decisions before saved-source approval.");
      assertApplied();
      // These are the fixed outputs of the candidate's database generator. They are
      // independently checked again below and cannot alter authored source.
      const artifacts = readRuntimeArtifacts(workspace.workingDirectory);
      await withSourceWrite(root, async () => {
        assertApplied();
        for (const [name, bytes] of artifacts) {
          let target = realpathSync(root);
          for (const component of name.split("/")) {
            target = path.join(target, component);
            try { if (lstatSync(target).isSymbolicLink()) throw new Error("Generated artifact target is linked; nothing can be approved."); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          const before = sourceContents(target), after = bytes.toString("utf8");
          if (!Buffer.from(after).equals(bytes)) throw new Error("Generated database artifact is not UTF-8 source.");
          if (before !== after) writeSourceChange(root, target, before, after);
        }
        assertApplied();
      });
      const notes: ReviewDecisions = Object.fromEntries((["api", "client"] as const).filter(stage => stages.includes(stage)).map(stage => {
        const selected = decisions.filter(item => stage === "client" ? ["selection", "cache"].includes(item.kind) : !["selection", "cache"].includes(item.kind));
        if (!selected.length) throw new Error(`No established ${stage} intent was supplied.`);
        return [stage, readReviewDecision({ statement: selected.map(item => `${item.target} (${item.kind}): ${item.value}`).join("\n").slice(0, 3400) + `\nDecision set SHA-256: ${proofDigest(selected)}`,
          evidence: `Explicit contract run with typed source/user decisions SHA-256: ${proofDigest(selected)}. Independently checked saved source after application. Full evidence remains in the task checkpoints.` })];
      }));
      service = new GraphQLChainService(root, projectContractInspection(toolchain));
      const observation = await service.inspect(true);
      assertApplied();
      const reviews = new GraphQLChainReviews(service), plan = await reviews.reviewStages(observation.chain.revision, stages, notes, observation);
      return { reviews, plan };
    }, { freshContent: true });
    // The observation must physically close before any review receipt is written.
    if (review.plan) await review.reviews.accept({ reviewId: review.plan.reviewId, expectedRevision: review.plan.expectedRevision });
  } finally { await service?.dispose(); }
}

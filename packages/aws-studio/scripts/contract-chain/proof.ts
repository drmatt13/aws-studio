import type { ContractProofReceipt, ContractProofReceipts, ContractProofView, ProofCheck, ProofStage, ProofStageView, ReviewDecisions } from "./contract-proof";
import { PROOF_PREDECESSORS, PROOF_STAGES } from "./contract-proof";
import type { CheckEvidence, GraphQLChainReviewRecord, PrismaModelShape } from "./graphql-chain";
import type { ChainEvaluation } from "./worker";
import type { PortableProofIdentity } from "./portable-identity";
import { createProofReceipt, proofDigest, readReviewDecision } from "./proof-core";
import { sdlFingerprint } from "./core";
import { sourceFingerprintsFromFiles } from "./source-fingerprints";

const limitations = ["Declared offline contract checks only", "No live database, deployed compatibility or rendered application UX assertion", "Content-addressed integrity is not a signature or authenticated reviewer identity", "Common installed source is content-bound; native/platform artifacts use lockfile resolution and local execution guards, not cross-machine byte equality"];
const dependencies = PROOF_PREDECESSORS;
const nextAction: Readonly<Record<ProofStage, string>> = {
  database: "Reconcile the Prisma contract and emitted artifacts, then run independent database validation.",
  api: "Review current model changes and API behavior, validate, then explicitly renew the API decision and receipt.",
  codegen: "Reconcile authored operations and fragments, run Codegen when needed, then check complete outputs.",
  client: "Review selections, query options, cache behavior and consumers; validate and explicitly renew the client decision.",
};
const checkDefinitions: Readonly<Record<ProofStage, readonly string[]>> = {
  database: ["database/compiled-emitted"], api: ["api/behavior-types-schema"], codegen: ["codegen/schema-documents-outputs"], client: ["client/cache-transport", "consumers/types", "integration/persisted-limits"],
};
function combine(checks: readonly CheckEvidence[]): CheckEvidence {
  if (!checks.length) return { status: "unavailable", diagnostics: [{ code: "PROOF_CHECKS_REQUIRED", message: "Required independent check evidence is missing. Run the complete stage validation before renewing proof." }] };
  const status = (["unavailable", "failed", "blocked"] as const).find(status => checks.some(check => check.status === status));
  return status ? { status, diagnostics: checks.flatMap(check => check.status === "passed" ? [] : check.diagnostics) } : { status: "passed" };
}
function evidence(id: string, check: CheckEvidence, identity: PortableProofIdentity, stage: ProofStage): ProofCheck {
  return { id, version: 1, outcome: check.status, evidence: proofDigest({ validator: id, policy: identity.policy, sources: identity.inputs[stage], generated: stage === "codegen" || stage === "client" ? identity.outputs.generated : null }),
    diagnostics: check.status === "passed" ? [] : check.diagnostics.map(item => ({ code: item.code.slice(0, 128), ...(item.file && !item.file.startsWith("/") && !/^[A-Za-z]:/.test(item.file) && !item.file.split("/").includes("..") ? { file: item.file.replaceAll("\\", "/").slice(0, 512) } : {}) })).slice(0, 100) };
}
export interface ProofBuildInput {
  readonly identity: PortableProofIdentity;
  readonly evaluation: ChainEvaluation;
  readonly record: GraphQLChainReviewRecord | null;
  readonly models: Readonly<Record<string, PrismaModelShape>> | null;
  readonly sdlDigest: string | null;
  readonly codegenChecks: readonly CheckEvidence[];
  readonly decisions?: ReviewDecisions;
  readonly scope?: ContractProofReceipt["scope"];
  readonly candidateDecisions?: Readonly<Partial<Record<ProofStage, string>>>;
}
export interface ProofObservation {
  readonly receipts: ContractProofReceipts;
  readonly view: ContractProofView;
  readonly bindings: { readonly api: string; readonly client: string; readonly upstream: string };
}

/** Candidate lineage retains the accepted API origin without promoting its scope. */
export function candidateApiOrigin(record: GraphQLChainReviewRecord | null): string {
  return record?.version === 3 && record.proofs.api ? record.proofs.api.id
    : proofDigest({ version: record?.version ?? null, prisma: record?.prisma ?? null, api: record && record.version !== 1 ? record.bindings.api : null });
}

/** Recompute from current independent outcomes. Stored flags are never execution evidence. */
export function buildContractProof(input: ProofBuildInput): ProofObservation {
  const { identity, evaluation, sdlDigest, models } = input;
  const scope = input.scope ?? "saved";
  const recorded = input.record?.version === 3 ? input.record.proofs : {};
  const decisions: ReviewDecisions = { ...(recorded.api?.review?.scope === "api" ? { api: recorded.api.review.decision } : {}), ...(recorded.client?.review?.scope === "client" ? { client: recorded.client.review.decision } : {}), ...input.decisions };
  const schema: CheckEvidence = !sdlDigest ? { status: "unavailable", diagnostics: [{ code: "EXECUTABLE_SCHEMA_REQUIRED", message: "The executable GraphQL schema is unavailable." }] }
    : evaluation.schemaDiagnostics.length ? { status: "failed", diagnostics: evaluation.schemaDiagnostics } : { status: "passed" };
  const checks: Record<ProofStage, readonly CheckEvidence[]> = {
    database: [evaluation.verification.database], api: [combine([evaluation.verification.api, schema])], codegen: [combine(input.codegenChecks)],
    client: [evaluation.verification.client, evaluation.verification.consumers, evaluation.verification.integration],
  };
  const authored = evaluation.authoredDocumentsDigest ?? proofDigest(identity.files.client);
  const sourceIds = { ...identity.inputs, codegen: proofDigest({ config: identity.inputs.codegen, documents: authored }) };
  const apiBinding = proofDigest({ version: 3, api: identity.inputs.api, database: identity.inputs.database, semantics: evaluation.contract, artifacts: identity.outputs.database, sdl: sdlDigest, policy: identity.policy, toolchain: identity.toolchain });
  const clientBinding = proofDigest({ version: 3, client: identity.inputs.client, generated: identity.outputs.generated, documents: authored, sdl: sdlDigest, policy: identity.policy, toolchain: identity.toolchain });
  const receipts: Partial<Record<ProofStage, ContractProofReceipt>> = {};
  const content = sourceFingerprintsFromFiles(Object.assign({}, ...Object.values(identity.files)));
  const contentHash = (id: "prisma" | "pothos" | "generated" | "client"): string | undefined => {
    const value = content.find(node => node.id === id)?.fingerprint;
    return value?.status === "available" ? value.value : undefined;
  };
  const contentIds = { database: "prisma", api: "pothos", codegen: "generated", client: "client" } as const;
  const upstreamIds = { api: "prisma", codegen: "pothos", client: "generated" } as const;
  for (const stage of PROOF_STAGES) {
    const decision = stage === "api" ? decisions.api : stage === "client" ? decisions.client : undefined;
    const review = scope === "saved" && decision ? { scope: stage as "api" | "client", decision: readReviewDecision(decision) } : null;
    const predecessors = Object.fromEntries(dependencies[stage].map(stage => [stage, receipts[stage]!.id]));
    const inputs: Record<string, string> = stage === "database" ? { source: identity.inputs.database, semantics: proofDigest(evaluation.contract) }
      : stage === "api" ? { source: identity.inputs.api, models: proofDigest(models), implementation: apiBinding, ...(scope === "candidate" ? { origin: candidateApiOrigin(input.record) } : {}) }
        : stage === "codegen" ? { configuration: identity.inputs.codegen, documents: authored, schema: sdlDigest ?? proofDigest(null) }
          : { source: identity.inputs.client, implementation: clientBinding };
    const outputs: Record<string, string> = stage === "database" ? { database: identity.outputs.database, compiled: proofDigest(evaluation.contract) }
      : stage === "api" ? { schema: sdlDigest ?? proofDigest(null) }
        : { generated: identity.outputs.generated };
    const generatedContent = contentHash(contentIds[stage]);
    if (generatedContent) outputs.content = generatedContent;
    const upstreamContent = stage === "database" ? undefined : contentHash(upstreamIds[stage]);
    if (upstreamContent) inputs.upstreamContent = upstreamContent;
    receipts[stage] = createProofReceipt({ version: 1, scope, stage, sourceRevision: sourceIds[stage], inputs, implementation: sourceIds[stage], outputs, predecessors, policy: identity.policy, toolchain: identity.toolchain,
      checks: checks[stage].map((check, index) => evidence(checkDefinitions[stage][index]!, check, identity, stage)), review, decisionDigest: scope === "candidate" ? input.candidateDecisions?.[stage] ?? proofDigest(null) : proofDigest(review?.decision ?? null), limitations });
  }
  const views: ProofStageView[] = [];
  for (const stage of PROOF_STAGES) {
    const current = receipts[stage]!, previous = recorded[stage] ?? null;
    const diagnostics: ProofStageView["diagnostics"][number][] = [];
    const unavailable = current.checks.some(check => check.outcome === "unavailable");
    const failed = current.checks.some(check => check.outcome === "failed");
    const blocked = current.checks.some(check => check.outcome === "blocked");
    const upstream = dependencies[stage].some(stage => views.find(item => item.stage === stage)?.status !== "verified");
    const manual = stage === "api" || stage === "client";
    const missing = (manual && !current.review) || stage !== "database" && !previous;
    const modelReviewMissing = stage === "api" && (models === null || !input.record?.prisma || proofDigest(input.record.prisma.models) !== proofDigest(models));
    const surfaceReviewMissing = stage === "client" && (!input.record?.client || sdlFingerprint(input.record.client) !== sdlDigest);
    const bindings = input.record && input.record.version !== 1 ? input.record.bindings : null;
    const bindingMismatch = stage === "api" && bindings?.api !== apiBinding || stage === "client" && (bindings?.client?.inputs !== clientBinding || bindings?.client?.upstream !== receipts.api!.id);
    const changed = stage !== "database" && !!previous && previous.id !== current.id;
    const dangling = stage === "api" && !!previous && recorded.database?.id !== current.predecessors.database
      || stage === "client" && !!previous && (recorded.api?.id !== current.predecessors.api || recorded.codegen?.id !== current.predecessors.codegen);
    if (unavailable || failed || blocked) diagnostics.push({ code: unavailable ? "PROOF_VALIDATION_UNAVAILABLE" : "PROOF_VALIDATION_FAILED", message: "Current independent validation is incomplete or did not pass. A stored passing receipt cannot replace it." });
    if (upstream) diagnostics.push({ code: "PROOF_PREDECESSOR_REQUIRED", message: "Required predecessor evidence is not currently verified." });
    if (missing) diagnostics.push({ code: input.record && input.record.version < 3 ? "LEGACY_PROOF_RENEWAL_REQUIRED" : "PROOF_REVIEW_REQUIRED", message: "A current explicit review decision and versioned source receipt are required. Existing model acknowledgements remain preserved." });
    if (modelReviewMissing || surfaceReviewMissing) diagnostics.push({ code: modelReviewMissing ? "MODEL_REVIEW_REQUIRED" : "CLIENT_SURFACE_REVIEW_REQUIRED", message: "The explicit reviewed source surface does not match current source. Reconcile its review before renewing confidence." });
    if (bindingMismatch) diagnostics.push({ code: "REVIEW_BINDING_MISMATCH", message: "The recorded source or predecessor binding does not match current verified evidence." });
    if (changed) diagnostics.push({ code: previous!.policy.digest !== current.policy.digest ? "PROOF_POLICY_CHANGED" : proofDigest(previous!.toolchain) !== proofDigest(current.toolchain) ? "PROOF_TOOLCHAIN_CHANGED" : "PROOF_INPUTS_OR_DECISIONS_CHANGED", message: "Source, outputs, predecessor evidence, decisions or verification policy changed. Revalidate and explicitly renew this review." });
    if (dangling) diagnostics.push({ code: "PROOF_LINEAGE_INCOMPLETE", message: "The accepted receipt has missing or stale recorded predecessors. Reconcile and renew the upstream evidence before reviewing this stage." });
    const status = unavailable ? "unavailable" : failed ? "failed" : blocked || upstream ? "blocked" : missing || changed || dangling || modelReviewMissing || surfaceReviewMissing || bindingMismatch ? "stale" : "verified";
    views.push({ stage, status, current, recorded: previous, diagnostics, action: nextAction[stage], predecessors: dependencies[stage].map(predecessor => ({ stage: predecessor, recorded: previous?.predecessors[predecessor] ?? null, current: receipts[predecessor]!.id, matches: previous?.predecessors[predecessor] === receipts[predecessor]!.id })) });
  }
  return { receipts, bindings: { api: apiBinding, client: clientBinding, upstream: receipts.api!.id }, view: { version: 1, policy: identity.policy, stages: views, ci: { status: "not-observed", message: "No CI observation is available. CI independently reruns this policy; persisted authority labels are not authenticated." } } };
}

export function unavailableProofView(message: string, previous?: ContractProofView): ContractProofView {
  return { version: 1, policy: previous?.policy ?? { id: "contract-chain/offline-v1", digest: "0".repeat(64) }, ci: { status: "not-observed", message: "Current local and CI agreement has not been established." }, stages: PROOF_STAGES.map(stage => ({ stage, status: "unavailable", current: null, recorded: previous?.stages.find(item => item.stage === stage)?.recorded ?? null,
    predecessors: [], diagnostics: [{ code: "PROOF_OBSERVATION_REQUIRED", message }], action: nextAction[stage] })) };
}

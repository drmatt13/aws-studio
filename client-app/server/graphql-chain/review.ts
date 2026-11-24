import { randomUUID } from "node:crypto";
import type { AcceptRequest, AcceptResult, CheckEvidence, ContractRenewalRequest, ContractRenewalResult, GraphQLChainReviewRecordV3, ReviewPlan, ReviewRequest, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import type { ProofStage, ReviewDecisions } from "aws-studio/contract-chain/contract-proof";
import { EditError, writeSourceChange } from "aws-studio/source/io";
import { withSourceWrite } from "aws-studio/source/source-gate";
import { sha256 } from "../files";
import { currentReviewRecord, fingerprint, sdlFingerprint, serializeReviewRecord } from "aws-studio/contract-chain/core";
import { GraphQLChainService, recordContents, REVIEW_FILE, reviewRecordPath, type ChainObservation } from "./service";
import { buildContractProof } from "aws-studio/contract-chain/proof";
import { readReviewDecisions } from "aws-studio/contract-chain/proof-core";
import type { ContractStage } from "../../shared/contract-propagation";

const TTL = 15 * 60_000;
const hash = /^[a-f0-9]{64}$/;
const contractStages = ["api", "codegen", "client"] as const;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new EditError(400, "Choose a supported GraphQL review intent.");
  return value as Record<string, unknown>;
}
export function readChainReviewRequest(value: unknown): ReviewRequest {
  const item = object(value, value && typeof value === "object" && Object.hasOwn(value, "decisions") ? ["scope", "expectedRevision", "decisions"] : ["scope", "expectedRevision"]);
  if (typeof item.expectedRevision !== "string" || !hash.test(item.expectedRevision)) throw new EditError(400, "A GraphQL review requires the current source revision.");
  const scope = item.scope as Record<string, unknown> | null;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new EditError(400, "Choose a review scope.");
  let decisions: ReviewDecisions | undefined;
  if (item.decisions !== undefined) {
    try { decisions = readReviewDecisions(item.decisions); }
    catch (error) { throw new EditError(400, error instanceof Error ? error.message : "Invalid review decisions."); }
    if (Object.keys(decisions).some(key => scope.kind !== "baseline" && key !== scope.kind)) throw new EditError(400, "Review decisions must match the selected scope.");
  }
  if (["baseline", "api", "client"].includes(String(scope.kind))) { object(scope, ["kind"]); return { expectedRevision: item.expectedRevision, scope: { kind: scope.kind as "baseline" | "api" | "client" }, ...(decisions ? { decisions } : {}) }; }
  if (scope.kind === "model" && typeof scope.model === "string" && /^[_A-Za-z][_0-9A-Za-z]*(?:\.[_A-Za-z][_0-9A-Za-z]*)?$/.test(scope.model)) {
    object(scope, ["kind", "model"]); return { expectedRevision: item.expectedRevision, scope: { kind: "model", model: scope.model } };
  }
  throw new EditError(400, "Choose the baseline, one model, API implementation or the client surface.");
}
export function readChainAcceptRequest(value: unknown): AcceptRequest {
  const item = object(value, ["reviewId", "expectedRevision"]);
  if (typeof item.reviewId !== "string" || !/^[a-f0-9-]{36}$/.test(item.reviewId) || typeof item.expectedRevision !== "string" || !hash.test(item.expectedRevision)) throw new EditError(400, "Apply requires a reviewed GraphQL plan and its source revision.");
  return { reviewId: item.reviewId, expectedRevision: item.expectedRevision };
}

/** The exact same deterministic record update is used by Studio and the CLI. */
export function reviewedRecord(observation: ChainObservation, scope: ReviewScope, decisions: ReviewDecisions = {}): GraphQLChainReviewRecordV3 {
  if (observation.chain.record === "invalid") throw new EditError(422, "Resolve the invalid review record before acknowledging source.");
  const before = currentReviewRecord(observation.record);
  const requireDecision = (kind: "api" | "client") => {
    if (!decisions[kind]) throw new EditError(422, `Record an explicit ${kind === "api" ? "API behavior" : "client selection/cache"} decision and source evidence before preparing this review. Validation and an agent's completion cannot accept application intent.`);
  };
  const attach = (record: GraphQLChainReviewRecordV3, stages: readonly ProofStage[]): GraphQLChainReviewRecordV3 => {
    if (!observation.proofInput) throw new EditError(422, "Current independent proof inputs are unavailable. Check again before recording review.");
    const proof = buildContractProof({ ...observation.proofInput, record, decisions });
    const proofs = { ...record.proofs };
    for (const stage of stages) proofs[stage] = proof.receipts[stage];
    return { ...record, proofs, bindings: { api: stages.includes("api") ? proof.bindings.api : record.bindings.api,
      client: stages.includes("client") ? { inputs: proof.bindings.client, upstream: proof.bindings.upstream } : record.bindings.client } };
  };
  const { verification } = observation.chain;
  const requireChecks = (name: string, checks: readonly CheckEvidence[]) => {
    if (checks.some(check => check.status !== "passed")) throw new EditError(422, `${name} independent checks must pass against current source before recording review. Resolve failed or unavailable evidence and check again.`);
  };
  const backend = observation.chain.links.find(link => link.id === "prisma-pothos");
  const generated = observation.chain.links.find(link => link.id === "pothos-generated");
  const client = observation.chain.links.find(link => link.id === "generated-client");
  const clientAvailable = !!observation.surface && client?.id === "generated-client" && client.validation.status === "passed";
  const requireBackend = () => {
    requireChecks("Database and repository/API", [verification.database, verification.api]);
    if (!observation.surface || !observation.bindings.api) throw new EditError(422, "The current executable schema and API implementation binding are required before recording review.");
  };
  const requireClient = () => {
    if (!clientAvailable) throw new EditError(422, "Client documents must validate against the current SDL before recording their review.");
    if (generated?.state.status !== "current") throw new EditError(422, "Codegen schema, documents and generated-file checks must pass before recording client review.");
    requireChecks("Client, consumer and integration", [verification.client, verification.consumers, verification.integration]);
    if (!observation.bindings.client || !observation.bindings.upstream) throw new EditError(422, "Current client implementation and upstream bindings are required before recording review.");
  };
  if (scope.kind === "baseline") {
    if (before.prisma !== null || before.client !== null || before.bindings.api !== null || before.bindings.client !== null) throw new EditError(422, "A baseline is only available before reviews are recorded. Review each changed model, API implementation or the client surface instead.");
    requireBackend(); requireClient();
    requireDecision("api"); requireDecision("client");
    if (!observation.models) throw new EditError(422, "The current Prisma shape is required to record a baseline.");
    return attach({ version: 3, prisma: { models: observation.models }, client: observation.surface, bindings: { api: null, client: null }, proofs: {}, ...(before.ledger ? { ledger: before.ledger } : {}) }, ["database", "api", "codegen", "client"]);
  }
  if (scope.kind === "api") {
    requireBackend();
    if (backend?.state.status !== "reviewed") throw new EditError(422, "Reconcile and review every changed database model before recording API implementation review.");
    requireDecision("api");
    return attach({ ...before, prisma: before.prisma ?? { models: {} } }, ["database", "api"]);
  }
  if (scope.kind === "client") {
    requireClient();
    if (backend?.confidence.status !== "verified" || generated?.state.status !== "current") throw new EditError(422, "Required API and Codegen predecessors must be fully verified before recording client review.");
    requireDecision("client");
    return attach({ ...before, client: observation.surface }, ["codegen", "client"]);
  }
  requireBackend();
  if (!observation.models) throw new EditError(422, "The current Prisma shape is unavailable.");
  if (!Object.hasOwn(observation.models, scope.model) && !Object.hasOwn(before.prisma?.models ?? {}, scope.model)) throw new EditError(400, "Choose an existing or removed model from the current review.");
  const models = { ...before.prisma?.models };
  if (Object.hasOwn(observation.models, scope.model)) Object.defineProperty(models, scope.model, { value: observation.models[scope.model], enumerable: true, configurable: true, writable: true });
  else delete models[scope.model];
  return attach({ ...before, prisma: { models } }, ["database"]);
}

/** Host-only completion of an explicitly requested, independently checked stage.
 * Candidate receipts are never copied: saved receipts are recomputed from saved checks.
 */
export function reviewedStageRecord(observation: ChainObservation, stages: readonly ContractStage[], decisions: ReviewDecisions, recordedAt?: string): GraphQLChainReviewRecordV3 {
  if (!stages.length || stages.some((stage, index) => !["api", "codegen", "client"].includes(stage) || index > 0 && ["api", "codegen", "client"].indexOf(stage) <= ["api", "codegen", "client"].indexOf(stages[index - 1]!))) throw new EditError(422, "Choose distinct contract stages in dependency order.");
  if (observation.chain.record === "invalid" || !observation.proofInput) throw new EditError(422, "Current saved-source proof is required before approving a stage.");
  let record = currentReviewRecord(observation.record);
  for (const stage of stages) {
    const before = buildContractProof({ ...observation.proofInput, record });
    if (stage !== "api" && before.view.stages.find(item => item.stage === "api")?.status !== "verified") throw new EditError(422, "Approve the current API predecessor first.");
    if (stage === "client" && before.view.stages.find(item => item.stage === "codegen")?.status !== "verified") throw new EditError(422, "Approve the current Codegen predecessor first.");
    if (stage === "api") {
      if (!decisions.api || !observation.models || !observation.surface) throw new EditError(422, "An established API decision and current database/schema evidence are required.");
      record = { ...record, prisma: { models: observation.models } };
    }
    if (stage === "client") {
      if (!decisions.client || !observation.surface) throw new EditError(422, "An established client decision and current schema are required.");
      record = { ...record, client: observation.surface };
    }
    const proof = buildContractProof({ ...observation.proofInput, record, decisions });
    const selected: readonly ProofStage[] = stage === "api" ? ["database", "api"] : [stage];
    if (selected.some(name => !proof.receipts[name]?.checks.length || proof.receipts[name]!.checks.some(check => check.outcome !== "passed"))) throw new EditError(422, "Every required saved-source check must pass before approving this stage.");
    record = { ...record, proofs: { ...record.proofs, ...Object.fromEntries(selected.map(name => [name, proof.receipts[name]])) }, bindings: {
      api: stage === "api" ? proof.bindings.api : record.bindings.api,
      client: stage === "client" ? { inputs: proof.bindings.client, upstream: proof.bindings.upstream } : record.bindings.client,
    } };
  }
  if (!recordedAt) return record;
  const ledger = { ...record.ledger };
  for (const stage of stages) {
    const receipt = record.proofs[stage]!;
    const source = receipt.inputs.upstreamContent, output = receipt.outputs.content;
    if (source && output && (ledger[stage]?.source !== source || ledger[stage]?.output !== output)) {
      ledger[stage] = { source, output, recordedAt };
    }
  }
  return { ...record, ledger };
}

export class GraphQLChainReviews {
  private readonly plans = new Map<string, { plan: ReviewPlan; scope: ReviewScope; decisions?: ReviewDecisions; stages?: readonly ContractStage[]; recordedAt?: string }>();
  constructor(private readonly service: GraphQLChainService) {}
  /** Re-attest existing intent without starting Coding or changing authored source. */
  async renew(request: unknown): Promise<ContractRenewalResult> {
    const input = object(request, ["expectedRevision", "stage", "run"]);
    if (typeof input.expectedRevision !== "string" || !hash.test(input.expectedRevision) || !contractStages.includes(input.stage as ContractStage) || input.run !== "stage" && input.run !== "sequential") throw new EditError(400, "Choose a contract stage and its current saved-source revision.");
    const { stage, run, expectedRevision } = input as unknown as ContractRenewalRequest;
    const observation = await this.service.observeForRenewal(expectedRevision);
    const { chain, record } = observation;
    if (chain.revision !== expectedRevision) throw new EditError(409, "Saved source changed before the contract check. Try the stage again.");
    const remediation = { status: "remediation-required" } as const;
    if (record?.version !== 3 || !observation.proofInput) return remediation;

    const apiReview = record.proofs.api?.review, clientReview = record.proofs.client?.review;
    const decisions: ReviewDecisions = { ...(apiReview?.scope === "api" ? { api: apiReview.decision } : {}), ...(clientReview?.scope === "client" ? { client: clientReview.decision } : {}) };
    const backend = chain.links.find(link => link.id === "prisma-pothos");
    const generated = chain.links.find(link => link.id === "pothos-generated");
    const client = chain.links.find(link => link.id === "generated-client");
    const { database, api, consumers, integration, client: clientChecks } = chain.verification;
    const stageCurrent = {
      api: !!decisions.api && backend?.state.status === "reviewed" && !!observation.surface && database.status === "passed" && api.status === "passed"
        && record.proofs.api?.outputs.schema === observation.proofInput.sdlDigest
        && (!record.client || sdlFingerprint(record.client) === observation.proofInput.sdlDigest),
      codegen: generated?.state.status === "current" && Object.values(generated.checks).every(check => check.status === "passed"),
      client: !!decisions.client && client?.state.status === "reviewed" && client.validation.status === "passed" && [clientChecks, consumers, integration].every(check => check.status === "passed"),
    };
    const nodes = ["prisma", "pothos", "generated", "client"].map(id => chain.nodes.find(node => node.id === id));
    const from = contractStages.indexOf(stage), stages: ContractStage[] = [];
    if (from > 0 && chain.proof.stages.find(item => item.stage === contractStages[from - 1])?.status !== "verified") return remediation;
    for (const [index, next] of contractStages.entries()) {
      if (index < from) continue;
      const predecessor = nodes[index], output = nodes[index + 1], receipt = record.proofs[next];
      if (!stageCurrent[next] || !receipt?.checks.length || receipt.checks.some(check => check.outcome !== "passed")
        || predecessor?.fingerprint.status !== "available" || output?.fingerprint.status !== "available"
        || output.reviewedAgainst !== predecessor.fingerprint.value || output.recordedOutput !== output.fingerprint.value) break;
      stages.push(next);
    }
    if (!stages.length || run === "sequential" && stages.length !== contractStages.length - from) return remediation;
    const plan = await this.reviewStages(expectedRevision, stages, decisions, observation);
    if (plan) await this.accept({ reviewId: plan.reviewId, expectedRevision });
    else if ((await this.service.revalidate()).chain.revision !== expectedRevision) throw new EditError(409, "Saved source changed while checking this approval. Try the stage again.");
    const message = stages.length === 3 ? "Pothos, Codegen and client approvals recorded." : stages.length === 2 ? "Two contract stage approvals recorded." : `${stage === "api" ? "Pothos" : stage === "codegen" ? "Codegen" : "Client"} approval recorded.`;
    return { status: "recorded", message };
  }
  /** Only native host code can invoke this; no HTTP request supplies stage approval authority. */
  async reviewStages(expectedRevision: string, stages: readonly ContractStage[], decisions: ReviewDecisions, checked?: ChainObservation): Promise<ReviewPlan | null> {
    const observation = checked ?? await this.service.revalidate();
    if (observation.chain.revision !== expectedRevision) throw new EditError(409, "Saved source changed before stage approval.");
    const recordedAt = new Date().toISOString();
    const after = serializeReviewRecord(reviewedStageRecord(observation, stages, decisions, recordedAt));
    if (after === observation.recordText) return null;
    if (Buffer.byteLength(after) > 2 * 1024 * 1024) throw new EditError(422, "The contract review exceeds its limit.");
    const plan: ReviewPlan = { reviewId: randomUUID(), expectedRevision, expiresAt: new Date(Date.now() + TTL).toISOString(), file: REVIEW_FILE, before: observation.recordText, after, effects: ["Records independently checked saved-source stage approvals."] };
    this.plans.set(plan.reviewId, { plan, scope: { kind: "api" }, decisions, stages, recordedAt });
    return plan;
  }
  async review(request: ReviewRequest): Promise<ReviewPlan> {
    const input = readChainReviewRequest(request), observation = await this.service.inspect();
    if (observation.chain.revision !== input.expectedRevision) throw new EditError(409, "Source changed. Check again before recording this review.");
    const after = serializeReviewRecord(reviewedRecord(observation, input.scope, input.decisions));
    if (Buffer.byteLength(after) > 2 * 1024 * 1024) throw new EditError(422, "The GraphQL review record exceeds its 2 MiB limit. Nothing was saved.");
    if (after === observation.recordText) throw new EditError(422, "This review is already recorded. No record update is needed.");
    const plan: ReviewPlan = { reviewId: randomUUID(), expectedRevision: input.expectedRevision, expiresAt: new Date(Date.now() + TTL).toISOString(), file: REVIEW_FILE, before: observation.recordText, after,
      effects: [`Updates only ${REVIEW_FILE}; application source is unchanged.`, "Does not generate artifacts, apply migrations, query a database or deploy."] };
    for (const [id, value] of this.plans) if (Date.parse(value.plan.expiresAt) <= Date.now()) this.plans.delete(id);
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.reviewId, { plan, scope: input.scope, decisions: input.decisions });
    return plan;
  }
  async accept(request: AcceptRequest): Promise<AcceptResult> {
    const input = readChainAcceptRequest(request);
    const prepared = this.plans.get(input.reviewId);
    const existing = prepared?.plan;
    if (!existing || Date.parse(existing.expiresAt) <= Date.now() || input.expectedRevision !== existing.expectedRevision) throw new EditError(409, "This review expired or is unavailable. Check again and review before recording it.");
    // Finish any native check before taking write ownership. Under the write
    // lease only cache-only identity revalidation is permitted.
    if (!prepared?.stages) await this.service.inspect();
    return withSourceWrite(this.service.root, async () => {
      const saved = this.plans.get(input.reviewId), plan = saved?.plan;
      if (!saved || !plan || Date.parse(plan.expiresAt) <= Date.now() || input.expectedRevision !== plan.expectedRevision) throw new EditError(409, "This review expired or is unavailable. Check again and review before recording it.");
      const file = reviewRecordPath(this.service.root);
      if (recordContents(this.service.root) !== plan.before) throw new EditError(409, "The review record changed after review. Check again before recording this review.");
      const current = await this.service.revalidate();
      if (current.chain.revision !== plan.expectedRevision || serializeReviewRecord(saved.stages ? reviewedStageRecord(current, saved.stages, saved.decisions ?? {}, saved.recordedAt) : reviewedRecord(current, saved.scope, saved.decisions)) !== plan.after) throw new EditError(409, "Source changed. Check again before recording this review.");
      // Re-resolve the fixed target immediately before the exact-before write.
      if (reviewRecordPath(this.service.root) !== file) throw new EditError(422, "The fixed review target changed.");
      writeSourceChange(this.service.root, file, plan.before, plan.after);
      this.service.ownWrites.set(REVIEW_FILE, sha256(plan.after));
      this.plans.clear();
      return { status: "recorded", revision: fingerprint([current.evaluationRevision, plan.after]), message: saved.scope.kind === "model" ? `${saved.scope.model} review recorded.` : saved.scope.kind === "api" ? "API implementation review recorded." : saved.scope.kind === "client" ? "Client review recorded." : "Reviewed baseline recorded." };
    });
  }
}

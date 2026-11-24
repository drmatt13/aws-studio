import { createHash } from "node:crypto";
import { PROOF_PREDECESSORS, PROOF_STAGES, type ContractProofReceipts, type ProofStage } from "./contract-proof";
import { readSourceManifest } from "../source/workspace";
import type { ChainObservation } from "./inspector";
import { contractFileGroup, contractSourceFileDigest, contractSourceGroups, contractPolicySnapshot, fixedContractBytes } from "./portable-identity";
import { proofDigest } from "./proof-core";
import { DATABASE_RUNTIME_OUTPUTS, databaseRuntimeArtifactDigest } from "./runtime-artifacts";
import { assertCapturedAuthoredDocuments, projectAuthoredDocuments, type DocumentPluckOptions } from "./authored-documents";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export interface ContractSourceProjection {
  readonly normalized: { readonly inputs: Readonly<Record<ProofStage, string>>; readonly outputs: { readonly database: string; readonly generated: string } };
  readonly raw: { readonly inputs: Readonly<Record<ProofStage, string>>; readonly outputs: { readonly database: string; readonly generated: string } };
  readonly policy: string;
  readonly rawPolicy: string;
  readonly lockfile: string | null;
  readonly record: string | null;
  readonly documents: Readonly<Record<string, string>> | null;
}

/** Restore saved approvals from tracked receipts by matching portable source.
 * Current execution and installation confidence still come from inspection.
 */
export function recordedContractStages(recorded: ContractProofReceipts, source: ContractSourceProjection): readonly ProofStage[] {
  const { inputs, outputs } = source.normalized;
  const sameClient = source.documents !== null && recorded.client?.inputs.source === inputs.client;
  const matches: Record<ProofStage, boolean> = {
    database: recorded.database?.inputs.source === inputs.database,
    api: recorded.api?.inputs.source === inputs.api && recorded.api.review?.scope === "api",
    codegen: sameClient && recorded.codegen?.inputs.configuration === inputs.codegen && recorded.codegen.outputs.generated === outputs.generated,
    client: sameClient && recorded.client?.outputs.generated === outputs.generated && recorded.client.review?.scope === "client",
  };
  const approved: ProofStage[] = [];
  for (const stage of PROOF_STAGES) {
    const receipt = recorded[stage];
    if (receipt && matches[stage] && receipt.scope === "saved" && receipt.policy.digest === source.policy && receipt.toolchain.lockfileDigest === source.lockfile && receipt.checks.every(check => check.outcome === "passed")
      && PROOF_PREDECESSORS[stage].every(previous => approved.includes(previous) && receipt.predecessors[previous] === recorded[previous]?.id)) approved.push(stage);
  }
  return approved;
}
/** Raw local commitments complement portable receipt digests. No dependency walk or evaluator runs here. */
export function captureContractSourceProjection(root: string, policyRoot?: string): ContractSourceProjection {
  const before = readSourceManifest(root), source: Record<string, string> = {}, raw: Record<string, string> = {}, documents: Record<string, string> = {};
  let lockfile: string | null = null;
  for (const [name, entry] of Object.entries(before.files)) {
    if (name === "graphql-chain.review.json") continue;
    const bytes = fixedContractBytes(root, name)!;
    if (digest(bytes) !== entry.hash) throw new Error("Source changed while observing contract inputs.");
    source[name] = contractSourceFileDigest(name, bytes); raw[name] = entry.hash;
    if (contractFileGroup(name) === "client" && name.endsWith(".ts")) documents[name] = bytes.toString("utf8");
    if (name === "package-lock.json") try { lockfile = proofDigest(JSON.parse(bytes.toString("utf8"))); } catch { /* An unreadable lockfile cannot preserve approvals. */ }
  }
  // The fixed Codegen glob can see files excluded by generic public capture.
  // Such a tree declines the optimization; watch admission includes this subtree.
  let complete = true;
  try { assertCapturedAuthoredDocuments(root, before.files); } catch { complete = false; }
  const runtime = Object.fromEntries(DATABASE_RUNTIME_OUTPUTS.map(name => [name, fixedContractBytes(root, name, true)]));
  const identity = (files: Readonly<Record<string, string>>, normalized: boolean) => {
    const groups = contractSourceGroups(root, files);
    return { inputs: { database: proofDigest(groups.database), api: proofDigest(groups.api), codegen: proofDigest(groups.codegen), client: proofDigest(groups.client) },
      outputs: { database: proofDigest(Object.fromEntries(Object.entries(runtime).map(([name, bytes]) => [name, bytes ? normalized ? databaseRuntimeArtifactDigest(name, bytes) : digest(bytes) : null]))), generated: proofDigest(groups.generated) } };
  };
  const { policy, rawPolicy } = contractPolicySnapshot(policyRoot);
  const record = fixedContractBytes(root, "graphql-chain.review.json", true);
  if (readSourceManifest(root).digest !== before.digest) throw new Error("Source changed while observing contract inputs.");
  return { normalized: identity(source, true), raw: identity(raw, false), policy: policy.digest, rawPolicy,
    lockfile, record: record ? digest(record) : null, documents: complete ? documents : null };
}
export interface ContractSourceLease {
  readonly revision: string;
  readonly dependencyStamp: string;
  readonly baseline: ContractSourceProjection;
  readonly verified: readonly ProofStage[];
  readonly documentOptions: DocumentPluckOptions | null;
  readonly documentDigest: string | null;
}
/** The baseline must match a full live observation, never a durable cache record. */
export function establishContractSourceLease(root: string, observation: ChainObservation, source: ContractSourceProjection, dependencyStamp: string): ContractSourceLease | undefined {
  const input = observation.proofInput;
  if (!input || input.scope === "candidate" || source.policy !== input.identity.policy.digest || source.lockfile !== input.identity.toolchain.lockfileDigest
    || source.record !== (observation.recordText === null ? null : digest(observation.recordText))
    || PROOF_STAGES.some(stage => source.normalized.inputs[stage] !== input.identity.inputs[stage])
    || source.normalized.outputs.database !== input.identity.outputs.database || source.normalized.outputs.generated !== input.identity.outputs.generated) return;
  let documentOptions: DocumentPluckOptions | null = null, documentDigest: string | null = null;
  if (input.evaluation.documentProjectionOptions && source.documents) try {
    const projected = projectAuthoredDocuments(root, source.documents, input.evaluation.documentProjectionOptions);
    if (projected === input.evaluation.authoredDocumentsDigest) { documentOptions = input.evaluation.documentProjectionOptions; documentDigest = projected; }
  } catch { /* Unknown extraction retains the stricter whole-client input guard. */ }
  return { revision: observation.chain.revision, dependencyStamp, baseline: source,
    verified: observation.chain.proof.stages.filter(stage => stage.status === "verified").map(stage => stage.stage), documentOptions, documentDigest };
}
/** This can only retain prior verified presentation. It never issues evidence or review actions. */
export function retainedContractStages(root: string, lease: ContractSourceLease | undefined, source: ContractSourceProjection, dependencyStamp: string): readonly ProofStage[] {
  if (!lease || lease.dependencyStamp !== dependencyStamp || lease.baseline.policy !== source.policy || lease.baseline.rawPolicy !== source.rawPolicy || lease.baseline.lockfile !== source.lockfile || lease.baseline.record !== source.record) return [];
  const previous = lease.baseline.raw, current = source.raw;
  let documentsSame = source.documents !== null && lease.baseline.documents !== null && previous.inputs.client === current.inputs.client;
  if (!documentsSame && lease.documentOptions && lease.documentDigest && source.documents) try {
    documentsSame = projectAuthoredDocuments(root, source.documents, lease.documentOptions) === lease.documentDigest;
  } catch { documentsSame = false; }
  const same: Record<ProofStage, boolean> = {
    database: lease.baseline.normalized.inputs.database === source.normalized.inputs.database && lease.baseline.normalized.outputs.database === source.normalized.outputs.database,
    api: previous.inputs.api === current.inputs.api,
    codegen: previous.inputs.codegen === current.inputs.codegen && previous.outputs.generated === current.outputs.generated && documentsSame,
    client: previous.inputs.client === current.inputs.client && previous.outputs.generated === current.outputs.generated,
  };
  const retained: ProofStage[] = [];
  for (const stage of PROOF_STAGES) if (same[stage] && lease.verified.includes(stage) && PROOF_PREDECESSORS[stage].every(predecessor => retained.includes(predecessor))) retained.push(stage);
  return retained;
}

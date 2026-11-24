import type { ContractProofReceipt, ContractProofView, ProofStage, ProofToolchain } from "./contract-proof";
import { PROOF_PREDECESSORS } from "./contract-proof";

const stages: readonly ProofStage[] = ["database", "api", "codegen", "client"];
const statuses = ["verified", "blocked", "stale", "failed", "unavailable"];
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 4000): value is string => typeof value === "string" && value.length <= limit;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const list = (value: unknown, limit: number): value is any[] => Array.isArray(value) && value.length <= limit;
const hashes = (value: unknown, limit: number): boolean => object(value) && Object.keys(value).length <= limit && Object.entries(value).every(([key, item]) => text(key, 512) && hash(item));
const policy = (value: unknown): boolean => object(value) && text(value.id, 128) && hash(value.digest);
const diagnostics = (value: unknown): boolean => list(value, 1000) && value.every(item => object(item) && text(item.code, 128) && text(item.message) && (item.file === undefined || text(item.file, 512)) && [item.line, item.column].every(position => position === undefined || Number.isSafeInteger(position)));

/** Browser boundary only. Authoritative integrity and current validation belong to the host. */
export function isContractProofReceipt(value: unknown): value is ContractProofReceipt {
  if (!object(value) || value.version !== 1 || !hash(value.id) || !stages.includes(value.stage) || !["saved", "candidate"].includes(value.scope)
    || !hash(value.sourceRevision) || !hashes(value.inputs, 512) || !hash(value.implementation) || !hashes(value.outputs, 256)
    || !hashes(value.predecessors, 4) || Object.keys(value.predecessors).length !== PROOF_PREDECESSORS[value.stage as ProofStage].length || Object.keys(value.predecessors).some(stage => !PROOF_PREDECESSORS[value.stage as ProofStage].includes(stage as ProofStage))
    || !policy(value.policy) || !object(value.toolchain) || !text(value.toolchain.node, 128) || !hash(value.toolchain.lockfileDigest) || !hash(value.toolchain.dependencyDigest)
    || !object(value.toolchain.packages) || Object.keys(value.toolchain.packages).length > 128 || !Object.entries(value.toolchain.packages).every(([name, version]) => text(name, 256) && text(version, 256))
    || !hash(value.decisionDigest) || !list(value.checks, 64) || !list(value.limitations, 64) || !value.limitations.every((item: unknown) => text(item))) return false;
  if (!value.checks.every((check: unknown) => object(check) && text(check.id, 128) && check.version === 1 && ["passed", "failed", "blocked", "unavailable"].includes(check.outcome) && hash(check.evidence)
    && list(check.diagnostics, 1000) && check.diagnostics.every((item: unknown) => object(item) && text(item.code, 128) && (item.file === undefined || text(item.file, 512))))) return false;
  return value.review === null || object(value.review) && ["api", "client"].includes(value.review.scope) && object(value.review.decision)
    && text(value.review.decision.statement) && value.review.decision.statement.trim().length > 0 && text(value.review.decision.evidence) && value.review.decision.evidence.trim().length > 0;
}

/** Identity comparison only; the host still independently executes the checks. */
export function sameProofToolchain(left: ProofToolchain, right: ProofToolchain): boolean {
  return left.node === right.node && left.lockfileDigest === right.lockfileDigest && left.dependencyDigest === right.dependencyDigest
    && Object.keys(left.packages).length === Object.keys(right.packages).length && Object.entries(left.packages).every(([name, version]) => right.packages[name] === version);
}

export function isContractProofView(value: unknown): value is ContractProofView {
  if (!object(value) || value.version !== 1 || !policy(value.policy) || !list(value.stages, 4) || new Set(value.stages.map(stage => stage?.stage)).size !== value.stages.length
    || !object(value.ci) || !["not-observed", "matching", "different", "unavailable"].includes(value.ci.status) || !text(value.ci.message)) return false;
  return value.stages.every((view: unknown) => {
    if (!object(view) || !stages.includes(view.stage) || !statuses.includes(view.status) || !text(view.action)
      || !diagnostics(view.diagnostics) || !list(view.predecessors, 4) || new Set(view.predecessors.map(item => item?.stage)).size !== view.predecessors.length
      || view.status === "verified" && view.predecessors.length !== PROOF_PREDECESSORS[view.stage as ProofStage].length || view.predecessors.some(item => !PROOF_PREDECESSORS[view.stage as ProofStage].includes(item?.stage))) return false;
    for (const name of ["current", "recorded"]) if (view[name] !== null && (!isContractProofReceipt(view[name]) || view[name].stage !== view.stage || view[name].scope !== "saved")) return false;
    if (!view.predecessors.every((predecessor: unknown) => object(predecessor) && stages.includes(predecessor.stage)
      && (predecessor.recorded === null || hash(predecessor.recorded)) && (predecessor.current === null || hash(predecessor.current)) && typeof predecessor.matches === "boolean"
      && (!predecessor.matches || predecessor.recorded !== null && predecessor.recorded === predecessor.current))) return false;
    if (view.status === "verified") {
      if (!view.current || !view.current.checks.length || view.current.checks.some((check: { outcome: string }) => check.outcome !== "passed")
        || view.current.policy.id !== value.policy.id || view.current.policy.digest !== value.policy.digest
        || view.predecessors.some((predecessor: { stage: ProofStage; current: string | null }) => !predecessor.current || view.current.predecessors[predecessor.stage] !== predecessor.current)) return false;
      if (["api", "client"].includes(view.stage) && (view.recorded?.id !== view.current.id || view.current.review?.scope !== view.stage)) return false;
      if (view.recorded?.id === view.current.id && !sameProofToolchain(view.recorded.toolchain, view.current.toolchain)) return false;
    }
    return true;
  });
}

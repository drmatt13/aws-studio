import { createHash } from "node:crypto";
import { PROOF_PREDECESSORS, PROOF_STAGES, REVIEW_DECISION_LIMIT, type ContractProofReceipt, type ContractProofReceipts, type ProofStage, type ReviewDecision, type ReviewDecisions } from "./contract-proof";

const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 128 * 1024;
function fail(message: string): never { throw new Error(`Invalid contract proof: ${message}`); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("expected a plain object.");
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(item => item.get || item.set)) fail("accessors are unsupported.");
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const item = object(value);
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) fail("unexpected or missing fields.");
  return item;
}
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value); }
function digest(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function map(value: unknown, validate: (value: unknown) => boolean, limit = 64): void {
  const item = object(value);
  if (Object.keys(item).length > limit || Object.entries(item).some(([key, value]) => !/^[A-Za-z0-9_@./:-]{1,200}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || !validate(value))) fail("invalid bounded evidence map.");
}

/** JSON-key order is irrelevant. Arrays retain declared semantic order. */
export function canonicalEvidence(value: unknown): string {
  const normalize = (item: unknown, depth: number): unknown => {
    if (depth > 32) fail("evidence nesting exceeds its limit.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (item.length > 4096 || item.some((_, index) => !Object.hasOwn(item, index))) fail("invalid evidence array.");
      return Array.from(item, entry => normalize(entry, depth + 1));
    }
    const record = object(item);
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, normalize(record[key], depth + 1)]));
  };
  return JSON.stringify(normalize(value, 0));
}
export function proofDigest(value: unknown): string { return createHash("sha256").update(canonicalEvidence(value)).digest("hex"); }

export function readReviewDecision(value: unknown): ReviewDecision {
  const item = exact(value, ["statement", "evidence"]);
  if (!text(item.statement, REVIEW_DECISION_LIMIT) || !text(item.evidence, REVIEW_DECISION_LIMIT)) fail("review needs a bounded deliberate decision and source evidence.");
  const sensitive = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|(?:password|secret_access_key|access_token|refresh_token)\s*[:=]\s*["']?[^\s"']{8,}/i;
  if (sensitive.test(item.statement) || sensitive.test(item.evidence)) fail("review notes must not contain credentials or tokens.");
  return { statement: item.statement.replaceAll("\r\n", "\n").trim(), evidence: item.evidence.replaceAll("\r\n", "\n").trim() };
}
export function readReviewDecisions(value: unknown): ReviewDecisions {
  const item = object(value);
  if (Object.keys(item).some(key => key !== "api" && key !== "client")) fail("choose API or client review decisions.");
  return Object.fromEntries(Object.entries(item).map(([key, decision]) => [key, readReviewDecision(decision)]));
}

function normalizedBody(receipt: Omit<ContractProofReceipt, "id">): Omit<ContractProofReceipt, "id"> {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return { ...receipt, checks: [...receipt.checks].map(check => ({ ...check, diagnostics: [...check.diagnostics].sort((a, b) => compare(canonicalEvidence(a), canonicalEvidence(b))) })).sort((a, b) => compare(a.id, b.id)), limitations: [...receipt.limitations].sort() };
}
export function createProofReceipt(body: Omit<ContractProofReceipt, "id">): ContractProofReceipt {
  const normalized = normalizedBody(body);
  return readProofReceipt({ ...normalized, id: proofDigest(normalized) });
}
/** Strict content integrity and scope validation, never proof that checks actually ran. */
export function readProofReceipt(value: unknown, scope?: ContractProofReceipt["scope"]): ContractProofReceipt {
  if (Buffer.byteLength(canonicalEvidence(value)) > LIMIT) fail("receipt exceeds 128 KiB.");
  const item = exact(value, ["version", "id", "stage", "scope", "sourceRevision", "inputs", "implementation", "outputs", "predecessors", "policy", "toolchain", "checks", "decisionDigest", "review", "limitations"]);
  if (item.version !== 1 || !digest(item.id) || !PROOF_STAGES.includes(item.stage as ProofStage) || !["saved", "candidate"].includes(String(item.scope)) || scope && item.scope !== scope || !digest(item.sourceRevision) || !digest(item.implementation) || !digest(item.decisionDigest)) fail("unsupported version, identity or scope.");
  map(item.inputs, digest); map(item.outputs, digest);
  map(item.predecessors, digest, 4);
  const stage = item.stage as ProofStage;
  if (canonicalEvidence(Object.keys(object(item.predecessors)).sort()) !== canonicalEvidence([...PROOF_PREDECESSORS[stage]].sort())) fail("stage predecessors do not match the fixed contract graph.");
  const policy = exact(item.policy, ["id", "digest"]);
  if (!text(policy.id, 128) || !digest(policy.digest)) fail("invalid verification policy.");
  const toolchain = exact(item.toolchain, ["node", "packages", "lockfileDigest", "dependencyDigest"]);
  if (!text(toolchain.node, 128) || !digest(toolchain.lockfileDigest) || !digest(toolchain.dependencyDigest)) fail("invalid toolchain.");
  map(toolchain.packages, value => text(value, 128), 64);
  if (!Array.isArray(item.checks) || !item.checks.length || item.checks.length > 16) fail("required validation outcomes are missing.");
  const ids = new Set<string>();
  for (const value of item.checks) {
    const check = exact(value, ["id", "version", "outcome", "evidence", "diagnostics"]);
    if (!text(check.id, 128) || ids.has(check.id) || check.version !== 1 || !["passed", "failed", "blocked", "unavailable"].includes(String(check.outcome)) || !digest(check.evidence) || !Array.isArray(check.diagnostics) || check.diagnostics.length > 100) fail("invalid validation outcome.");
    ids.add(check.id);
    for (const value of check.diagnostics) {
      const problem = object(value);
      if (Object.keys(problem).some(key => key !== "code" && key !== "file") || !text(problem.code, 128) || problem.file !== undefined && (!text(problem.file, 512) || problem.file.startsWith("/") || /^[A-Za-z]:/.test(problem.file) || problem.file.split("/").includes(".."))) fail("invalid diagnostic reference.");
    }
  }
  if (item.review !== null) {
    const review = exact(item.review, ["scope", "decision"]);
    if (!["api", "client"].includes(String(review.scope)) || review.scope !== stage) fail("review scope does not match its stage.");
    const decision = readReviewDecision(review.decision);
    if (canonicalEvidence(decision) !== canonicalEvidence(review.decision) || item.decisionDigest !== proofDigest(decision)) fail("review decision binding is invalid.");
  } else if (item.scope === "saved" && item.decisionDigest !== proofDigest(null)) fail("saved-source decision evidence is missing.");
  if (!Array.isArray(item.limitations) || item.limitations.length < 1 || item.limitations.length > 16 || item.limitations.some(value => !text(value, 256)) || new Set(item.limitations).size !== item.limitations.length) fail("verification limitations are missing or invalid.");
  const { id, ...body } = item;
  if (proofDigest(normalizedBody(body as unknown as Omit<ContractProofReceipt, "id">)) !== id) fail("receipt content identity does not match its evidence.");
  return { ...normalizedBody(body as unknown as Omit<ContractProofReceipt, "id">), id: id as string };
}
export function readProofReceipts(value: unknown, scope: ContractProofReceipt["scope"] = "saved"): ContractProofReceipts {
  const item = object(value);
  if (Object.keys(item).some(stage => !PROOF_STAGES.includes(stage as ProofStage))) fail("unknown receipt stage.");
  return Object.fromEntries(Object.entries(item).map(([stage, value]) => { const receipt = readProofReceipt(value, scope); if (receipt.stage !== stage) fail("receipt stage key mismatch."); return [stage, receipt]; }));
}

import type { ChainConfidence, ChainDependency, ChainVerification, CheckEvidence, DependencyId, Diagnostic } from "./graphql-chain";

/** Source dependencies, not another workflow engine. Documents are inputs to Codegen. */
export const CHAIN_DEPENDENCIES: readonly ChainDependency[] = [
  { id: "prisma", requires: [] },
  { id: "database-artifacts", requires: ["prisma"] },
  { id: "repository-pothos", requires: ["prisma", "database-artifacts"] },
  { id: "executable-schema", requires: ["repository-pothos"] },
  { id: "authored-documents", requires: ["executable-schema"] },
  { id: "codegen", requires: ["executable-schema", "authored-documents"] },
  { id: "typed-documents", requires: ["codegen"] },
  { id: "react-query", requires: ["typed-documents", "authored-documents"] },
  { id: "consumers", requires: ["react-query"] },
];

export function unavailableVerification(diagnostics: readonly Diagnostic[]): ChainVerification {
  const evidence: CheckEvidence = { status: "unavailable", diagnostics };
  return { database: evidence, api: evidence, client: evidence, consumers: evidence, integration: evidence };
}

export function unavailableConfidence(diagnostics: readonly Diagnostic[], status: "stale" | "unavailable" = "unavailable"): ChainConfidence {
  return { status, blockedBy: [], diagnostics };
}

export function diagnostic(code: string, message: string, file?: string): Diagnostic {
  return { code, message, ...(file ? { file } : {}) };
}

/** Failures remain visible even when a predecessor also needs reconciliation. */
export function confidence(options: {
  readonly checks: readonly CheckEvidence[];
  readonly unknown?: readonly Diagnostic[];
  readonly stale?: readonly Diagnostic[];
  readonly upstream?: { readonly id: DependencyId; readonly confidence: ChainConfidence };
}): ChainConfidence {
  const unknown = [...options.unknown ?? [], ...options.checks.flatMap(check => check.status === "unavailable" ? check.diagnostics.length ? check.diagnostics : [diagnostic("VALIDATION_UNAVAILABLE", "A required independent check is unavailable. Resolve the checker and check again.")] : [])];
  const failed = options.checks.flatMap(check => check.status === "failed" ? check.diagnostics.length ? check.diagnostics : [diagnostic("VALIDATION_FAILED", "A required independent check failed. Resolve the failure and check again.")] : []);
  const waiting = options.checks.flatMap(check => check.status === "blocked" ? check.diagnostics.length ? check.diagnostics : [diagnostic("VALIDATION_BLOCKED", "A required independent check is waiting for its predecessor. Reconcile that predecessor, then check again.")] : []);
  const blockedBy: DependencyId[] = options.upstream && options.upstream.confidence.status !== "verified" ? [options.upstream.id] : [];
  const blocked = blockedBy.length ? [diagnostic("UPSTREAM_REVIEW_REQUIRED", `Waiting for ${blockedBy[0]} reconciliation and passing independent checks. Review the predecessor, then check again.`)] : [];
  const diagnostics = [...unknown, ...failed, ...options.stale ?? [], ...waiting, ...blocked];
  const status = unknown.length ? "unavailable" : failed.length ? "failed" : waiting.length || blocked.length ? "blocked" : options.stale?.length ? "stale" : "verified";
  return { status, blockedBy, diagnostics };
}

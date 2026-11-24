import type { ChainConfidence, ChainDiff, ChainNodeId, DependencyId, Diagnostic, GraphQLChain, LinkId, ReviewScope } from "aws-studio/contract-chain/graphql-chain";

/** A projection of the existing contract graph, not a second workflow engine. */
export type ContractStage = "api" | "codegen" | "client";
export type ContractValidatorId = "database" | "api" | "codegen" | "client" | "consumers" | "integration";
export type ContractDecisionKind = "exposure" | "graphql" | "write" | "ownership" | "validation" | "selection" | "cache";
export interface ContractDecision {
  readonly id: string;
  readonly target: string;
  readonly kind: ContractDecisionKind;
  readonly status: "unresolved" | "established";
  readonly value?: string;
  readonly evidence?: string;
}
export interface ContractCodingContext {
  readonly version: 1;
  readonly stage: ContractStage;
  /** The whole saved-source chain revision; never a candidate approval. */
  readonly sourceRevision: string;
  readonly inputs: readonly { readonly id: ChainNodeId; readonly digest: string | null }[];
  readonly affected: readonly ChainDiff[];
  readonly diagnostics: readonly Diagnostic[];
  readonly predecessors: readonly { readonly id: DependencyId; readonly status: ChainConfidence["status"]; readonly digest: string | null }[];
  readonly decisions: readonly ContractDecision[];
  readonly sourceRoots: readonly string[];
  readonly artifacts: readonly string[];
  readonly validators: readonly ContractValidatorId[];
  readonly reviewScopes: readonly ReviewScope[];
}
export const CONTRACT_STAGES: readonly ContractStage[] = ["api", "codegen", "client"];
export const CONTRACT_STAGE_POLICIES = {
  api: {
    link: "prisma-pothos", title: "Repository and API", requires: [] as readonly DependencyId[],
    sourceRoots: ["packages/database/src/", "packages/database/test/", "compute/http/graphql-api/", "packages/api-contract/src/generated/access-policy.ts"],
    artifacts: ["packages/database/src/contracts.ts", "compute/http/graphql-api/schema/index.ts"],
    validators: ["database", "api"] as readonly ContractValidatorId[],
  },
  codegen: {
    link: "pothos-generated", title: "Generate GraphQL", requires: ["repository-pothos", "executable-schema"] as readonly DependencyId[],
    sourceRoots: ["codegen.ts", "client-app/src/api/"],
    artifacts: ["client-app/src/api/generated/"], validators: ["codegen"] as readonly ContractValidatorId[],
  },
  client: {
    link: "generated-client", title: "Client operations", requires: ["typed-documents"] as readonly DependencyId[],
    sourceRoots: ["client-app/src/api/", "client-app/src/"],
    artifacts: ["client-app/src/api/**/operations.ts", "client-app/src/api/**/operations.test.ts"],
    validators: ["codegen", "client", "consumers", "integration"] as readonly ContractValidatorId[],
  },
} as const;

export function contractStageForLink(link: LinkId): ContractStage {
  return link === "prisma-pothos" ? "api" : link === "pothos-generated" ? "codegen" : "client";
}
export function contractLinkForStage(stage: ContractStage): LinkId { return CONTRACT_STAGE_POLICIES[stage].link; }

/** Local freshness does not skip an unreconciled predecessor. Missing evidence starts at API. */
export function nextContractStage(chain: GraphQLChain): ContractStage | null {
  if (chain.inspection && chain.inspection.status !== "ready") return "api";
  return CONTRACT_STAGES.find(stage => chain.links.find(link => link.id === contractLinkForStage(stage))?.confidence.status !== "verified") ?? null;
}

export function contractStagePrerequisites(chain: GraphQLChain, stage: ContractStage): ContractCodingContext["predecessors"] {
  const api = chain.links.find(link => link.id === "prisma-pothos"), generated = chain.links.find(link => link.id === "pothos-generated");
  const current = !chain.inspection || chain.inspection.status === "ready";
  return CONTRACT_STAGE_POLICIES[stage].requires.map(id => {
    const link = id === "typed-documents" ? generated : api;
    const node = chain.nodes.find(node => node.id === (id === "typed-documents" ? "generated" : "pothos"));
    return { id, status: current ? link?.confidence.status ?? "unavailable" : "unavailable", digest: node?.fingerprint.status === "available" ? node.fingerprint.value : null };
  });
}

export function contractDiffs(chain: GraphQLChain): readonly ChainDiff[] {
  const diffs = chain.links.flatMap(link => [
    ...(link.state.status === "changed" || link.state.status === "no-review" ? link.state.diffs ?? [] : []),
    ...(link.id === "prisma-pothos" ? Object.values(link.models).flatMap(state => state.status === "changed" || state.status === "no-review" ? state.diffs ?? [] : []) : []),
  ]);
  return [...new Map(diffs.map(diff => [JSON.stringify(diff), diff])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.change.localeCompare(b.change));
}

export function contractDecisions(stage: ContractStage, affected: readonly ChainDiff[], previous: readonly ContractDecision[] = []): readonly ContractDecision[] {
  if (stage === "codegen") return [...previous];
  const targets = [...new Set(affected.map(diff => diff.path))];
  if (!targets.length) targets.push(stage === "api" ? "Repository/API source changes" : "Client implementation changes");
  const kinds: readonly ContractDecisionKind[] = stage === "api" ? ["exposure", "graphql", "write", "ownership", "validation"] : ["selection", "cache"];
  const decisions = new Map(previous.map(decision => [decision.id, decision]));
  for (const target of targets) for (const kind of kinds) {
    const id = `${target}:${kind}`;
    if (!decisions.has(id)) decisions.set(id, { id, target, kind, status: "unresolved" });
  }
  return [...decisions.values()];
}

export function buildContractCodingContext(chain: GraphQLChain, stage: ContractStage, decisions: readonly ContractDecision[] = []): ContractCodingContext {
  if (!chain.links.some(link => link.id === contractLinkForStage(stage))) throw new Error("The selected contract-chain link is unavailable. Check again before preparing a request.");
  const policy = CONTRACT_STAGE_POLICIES[stage], affected = contractDiffs(chain);
  const api = chain.links.find(link => link.id === "prisma-pothos");
  const selected = chain.links.find(link => link.id === policy.link)!;
  const diagnostics = [...selected.confidence.diagnostics,
    ...(selected.id === "pothos-generated" ? Object.values(selected.checks).flatMap(check => check.status === "passed" ? [] : check.diagnostics) : []),
    ...(selected.state.status === "unknown" ? selected.state.diagnostics : []),
    ...(selected.state.status === "invalid" ? selected.state.problems.map(problem => ({ code: "INVALID_DOCUMENT", message: problem.message, file: problem.file, ...(problem.line ? { line: problem.line } : {}) })) : []),
    ...(selected.state.status === "out-of-date" ? (selected.state.files.length ? selected.state.files : ["client-app/src/api/generated/"]).map(file => ({ code: "CODEGEN_OUT_OF_DATE", message: `Generated output requires reconciliation: ${selected.state.status === "out-of-date" ? selected.state.reasons.join(", ") : ""}.`, file })) : []),
  ];
  const reviewScopes: ReviewScope[] = stage === "api" ? [
    ...(api?.id === "prisma-pothos" ? Object.entries(api.models).filter(([, state]) => state.status !== "reviewed").map(([model]) => ({ kind: "model" as const, model })) : []),
    { kind: "api" },
  ] : stage === "client" ? [{ kind: "client" }] : [];
  return { version: 1, stage, sourceRevision: chain.revision,
    inputs: chain.nodes.map(node => ({ id: node.id, digest: node.fingerprint.status === "available" ? node.fingerprint.value : null })),
    affected, diagnostics, predecessors: contractStagePrerequisites(chain, stage), decisions: contractDecisions(stage, affected, decisions),
    sourceRoots: [...policy.sourceRoots], artifacts: [...policy.artifacts], validators: [...policy.validators], reviewScopes };
}

const decisionKinds: readonly ContractDecisionKind[] = ["exposure", "graphql", "write", "ownership", "validation", "selection", "cache"];
const bounded = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)); }
/** Request boundary validation. Caller context describes evidence, never arbitrary validator commands. */
export function readContractDecisions(value: unknown): readonly ContractDecision[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Choose at most 256 bounded contract decisions.");
  const ids = new Set<string>();
  for (const decision of value) {
    if (!plain(decision) || !exact(decision, ["id", "target", "kind", "status"], ["value", "evidence"]) || !bounded(decision.id, 512) || ids.has(decision.id) || !bounded(decision.target, 256) || !decisionKinds.includes(decision.kind as ContractDecisionKind) || !["unresolved", "established"].includes(String(decision.status)) || (decision.value !== undefined && !bounded(decision.value, 2000)) || (decision.evidence !== undefined && !bounded(decision.evidence, 2000)) || (decision.status === "established" && (!bounded(decision.value, 2000) || !bounded(decision.evidence, 2000)))) throw new Error("Every contract decision needs a unique target, supported kind, and explicit value and evidence when established.");
    ids.add(decision.id);
  }
  return value as unknown as readonly ContractDecision[];
}
export function readContractCodingContext(value: unknown): ContractCodingContext {
  if (!plain(value) || !exact(value, ["version", "stage", "sourceRevision", "inputs", "affected", "diagnostics", "predecessors", "decisions", "sourceRoots", "artifacts", "validators", "reviewScopes"]) || value.version !== 1 || !CONTRACT_STAGES.includes(value.stage as ContractStage) || !bounded(value.sourceRevision, 128)) throw new Error("A contract task requires a supported stage and originating source revision.");
  const stage = value.stage as ContractStage, policy = CONTRACT_STAGE_POLICIES[stage];
  for (const key of ["sourceRoots", "artifacts", "validators"] as const) if (JSON.stringify(value[key]) !== JSON.stringify(policy[key])) throw new Error("Contract tasks must use the fixed stage source, artifact and verification policy.");
  if (!Array.isArray(value.inputs) || value.inputs.length !== 4 || value.inputs.some(input => !plain(input) || !exact(input, ["id", "digest"]) || !["prisma", "pothos", "generated", "client"].includes(String(input.id)) || (input.digest !== null && (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)))) || new Set(value.inputs.map(input => input.id)).size !== 4) throw new Error("Contract inputs must identify all four unique chain inputs and their available SHA-256 digests.");
  if (!Array.isArray(value.predecessors) || value.predecessors.length !== policy.requires.length || value.predecessors.some((item, index) => !plain(item) || !exact(item, ["id", "status", "digest"]) || item.id !== policy.requires[index] || !["verified", "blocked", "stale", "failed", "unavailable"].includes(String(item.status)) || (item.digest !== null && (typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest))))) throw new Error("Contract prerequisites must match the selected stage dependencies.");
  if (!Array.isArray(value.affected) || value.affected.length > 256 || value.affected.some(item => !plain(item) || !exact(item, ["surface", "subject", "path", "change", "before", "after"]) || !["prisma", "sdl"].includes(String(item.surface)) || !bounded(item.subject, 256) || !bounded(item.path, 512) || !["added", "removed", "changed"].includes(String(item.change)) || [item.before, item.after].some(text => text !== null && (typeof text !== "string" || text.length > 16_000)))) throw new Error("Contract changes must be bounded source differences.");
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 100 || value.diagnostics.some(item => !plain(item) || !exact(item, ["code", "message"], ["file", "line", "column"]) || !bounded(item.code, 128) || !bounded(item.message, 4000) || (item.file !== undefined && !bounded(item.file, 512)) || [item.line, item.column].some(position => position !== undefined && (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1)))) throw new Error("Contract diagnostics must be bounded source evidence.");
  const decisions = readContractDecisions(value.decisions);
  const requiredDecisions = contractDecisions(stage, value.affected as unknown as readonly ChainDiff[]);
  if (requiredDecisions.some(required => !decisions.some(decision => decision.id === required.id && decision.target === required.target && decision.kind === required.kind))) throw new Error("Required application decisions cannot be omitted or replaced.");
  if (!Array.isArray(value.reviewScopes) || value.reviewScopes.length > 257 || stage === "codegen" && value.reviewScopes.length !== 0 || value.reviewScopes.some(scope => !plain(scope) || (scope.kind === "model" ? stage !== "api" || !exact(scope, ["kind", "model"]) || !bounded(scope.model, 256) || !/^[_A-Za-z][_0-9A-Za-z]*(?:\.[_A-Za-z][_0-9A-Za-z]*)?$/.test(scope.model) : !exact(scope, ["kind"]) || scope.kind !== (stage === "api" ? "api" : "client"))) || value.reviewScopes.filter(scope => scope.kind === stage).length !== (stage === "codegen" ? 0 : 1) || new Set(value.reviewScopes.map(scope => JSON.stringify(scope))).size !== value.reviewScopes.length) throw new Error("Contract review scopes must belong to the selected stage.");
  return value as unknown as ContractCodingContext;
}

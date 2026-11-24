import type { GraphQLChain } from "./graphql-chain";
import { isContractProofView, sameProofToolchain } from "./contract-proof-response";
import { PROOF_PREDECESSORS } from "./contract-proof";

const nodeIds = ["prisma", "pothos", "generated", "client"];
const linkIds = ["prisma-pothos", "pothos-generated", "generated-client"];
const confidenceStates = ["verified", "blocked", "stale", "failed", "unavailable"];
const dependencyIds = ["prisma", "database-artifacts", "repository-pothos", "executable-schema", "authored-documents", "codegen", "typed-documents", "react-query", "consumers"];
const localStates = ["reviewed", "changed", "no-review", "unknown", "current", "out-of-date", "invalid"];
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 16_384;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): value is any[] => Array.isArray(value) && value.length <= 1000;
const diagnostics = (value: unknown): boolean => list(value) && value.every(item => object(item) && text(item.code) && text(item.message)
  && (item.file === undefined || text(item.file)) && (item.line === undefined || Number.isSafeInteger(item.line)) && (item.column === undefined || Number.isSafeInteger(item.column)));
const check = (value: unknown): boolean => object(value) && (value.status === "passed" || ["failed", "unavailable", "blocked"].includes(value.status) && diagnostics(value.diagnostics));
const fingerprint = (value: unknown): boolean => object(value) && (value.status === "available" && text(value.value) || value.status === "unavailable" && diagnostics(value.diagnostics));
const nodes = (value: unknown): boolean => list(value) && value.length === 4 && value.every((node, index) => object(node)
  && node.id === nodeIds[index] && text(node.caption) && text(node.name) && text(node.source) && fingerprint(node.fingerprint)
  && (node.reviewedAgainst === null || text(node.reviewedAgainst))
  && (node.normalizedReviewedAgainst === undefined || (index === 1 && typeof node.reviewedAgainst === "string" && /^[a-f0-9]{64}$/.test(node.reviewedAgainst)
    && typeof node.normalizedReviewedAgainst === "string" && /^[a-f0-9]{64}$/.test(node.normalizedReviewedAgainst)
    && value[0]?.fingerprint?.status === "available" && node.normalizedReviewedAgainst === value[0].fingerprint.value))
  && (node.recordedOutput === undefined || node.recordedOutput === null || text(node.recordedOutput))
  && (node.approvalRecorded === undefined || typeof node.approvalRecorded === "boolean"));
const action = (value: unknown): boolean => object(value) && (value.kind === "agent" && linkIds.includes(value.link)
  || value.kind === "command" && text(value.command)
  || value.kind === "acknowledge" && object(value.scope) && (["baseline", "api", "client"].includes(value.scope.kind) || value.scope.kind === "model" && text(value.scope.model)));
function localState(value: unknown): boolean {
  if (!object(value) || !localStates.includes(value.status)) return false;
  if (value.status === "unknown") return diagnostics(value.diagnostics);
  if (value.status === "changed" || value.status === "no-review" && value.diffs !== undefined) return list(value.diffs) && value.diffs.every(diff => object(diff) && ["prisma", "sdl"].includes(diff.surface)
    && text(diff.path) && text(diff.subject) && ["added", "removed", "changed"].includes(diff.change) && (diff.before === null || text(diff.before)) && (diff.after === null || text(diff.after)));
  if (value.status === "invalid") return list(value.problems) && value.problems.every(problem => object(problem) && text(problem.document) && text(problem.file) && text(problem.message));
  if (value.status === "out-of-date") return list(value.reasons) && list(value.files) && value.files.every(text);
  return value.status !== "reviewed" || text(value.current) && text(value.reviewedAgainst);
}
function links(value: unknown): boolean {
  return list(value) && value.length === 3 && value.every((link, index) => {
    if (!object(link) || link.id !== linkIds[index] || !localState(link.state) || !object(link.confidence)
      || !confidenceStates.includes(link.confidence.status) || !diagnostics(link.confidence.diagnostics) || !list(link.confidence.blockedBy)
      || !link.confidence.blockedBy.every((id: unknown) => dependencyIds.includes(String(id))) || !list(link.actions) || !link.actions.every(action)) return false;
    if (index === 0) return object(link.models) && Object.values(link.models).every(localState);
    if (index === 1) return object(link.checks) && ["schema", "documents", "generated-files"].every(name => check(link.checks[name]));
    return check(link.validation);
  });
}

/** Shared GET/IPC/cache boundary. Old or incomplete independent-status responses fail closed. */
function chainResponseShape(value: unknown, version: 2 | 3): value is Record<string, any> {
  if (!object(value) || value.version !== version || !text(value.revision) || !["missing", "available", "invalid"].includes(value.record)
    || !nodes(value.nodes) || !links(value.links) || !list(value.dependencies) || !object(value.verification)
    || !["database", "api", "client", "consumers", "integration"].every(name => check(value.verification[name]))
    || !value.dependencies.every(dependency => object(dependency) && dependencyIds.includes(dependency.id) && list(dependency.requires) && dependency.requires.every((id: unknown) => dependencyIds.includes(String(id))))) return false;
  if (value.history !== undefined && (!object(value.history) || !text(value.history.revision) || !nodes(value.history.nodes) || !links(value.history.links))) return false;
  if (value.fingerprints !== undefined && !["checking", "ready", "failed"].includes(value.fingerprints)) return false;
  return value.inspection === undefined || object(value.inspection) && ["checking", "ready", "stale", "failed"].includes(value.inspection.status)
    && (value.inspection.message === undefined || text(value.inspection.message)) && (value.inspection.diagnostics === undefined || diagnostics(value.inspection.diagnostics));
}

/** Version 2 can be restored only as explicitly historical observation. */
export function isLegacyGraphQLChainResponse(value: unknown): value is Omit<GraphQLChain, "version" | "proof"> & { readonly version: 2 } {
  return chainResponseShape(value, 2);
}

export function isGraphQLChainResponse(value: unknown): value is GraphQLChain {
  if (!chainResponseShape(value, 3) || !isContractProofView(value.proof)) return false;
  const stageViews = new Map(value.proof.stages.map(stage => [stage.stage, stage]));
  for (const view of value.proof.stages) if (view.status === "verified") {
    if (PROOF_PREDECESSORS[view.stage].some(stage => stageViews.get(stage)?.status !== "verified" || !stageViews.get(stage)?.current || view.current?.predecessors[stage] !== stageViews.get(stage)?.current?.id || !sameProofToolchain(view.current!.toolchain, stageViews.get(stage)!.current!.toolchain))) return false;
    if (["api", "client"].includes(view.stage) && PROOF_PREDECESSORS[view.stage].some(stage => stageViews.get(stage)?.recorded?.id !== view.current?.predecessors[stage])) return false;
  }
  const required = { "prisma-pothos": ["database", "api"], "pothos-generated": ["database", "api", "codegen"], "generated-client": ["database", "api", "codegen", "client"] } as const;
  for (let index = 0; index < value.links.length; index++) {
    const link = value.links[index];
    if (link.confidence.status !== "verified") continue;
    if (value.links.slice(0, index).some((previous: { confidence: { status: string } }) => previous.confidence.status !== "verified")) return false;
    if (index === 0 && [value.verification.database, value.verification.api].some(evidence => evidence.status !== "passed")) return false;
    if (index === 1 && Object.values(link.checks).some((evidence: any) => evidence.status !== "passed")) return false;
    if (index === 2 && [link.validation, value.verification.client, value.verification.consumers, value.verification.integration].some(evidence => evidence.status !== "passed")) return false;
    if (required[link.id as keyof typeof required].some(stage => stageViews.get(stage)?.status !== "verified")) return false;
    if (link.id === "generated-client" && [...stageViews.values()].some(stage => !stage.current || stage.recorded?.id !== stage.current.id)) return false;
  }
  return true;
}

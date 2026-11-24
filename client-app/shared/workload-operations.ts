import type { DraftEdit } from "./api";
import { normalizeResourceAccess } from "aws-studio/config/resource-access";
import type { ModeModel, ModelTarget } from "./model";

/** Native grants are needed only in the caller's deployed AWS lanes. */
export function nativeResourceAccessReason(caller: ModelTarget, destination: string, models: readonly ModeModel[]): string | undefined {
  for (const model of models) {
    const from = model.targets.find(item => item.ref === caller.ref);
    if (!from?.lanes[model.mode]) continue;
    const resource = model.resources.find(item => item.id === destination);
    if (!resource || resource.absent) return `This resource is unavailable in the caller’s ${model.mode === "dev" ? "development" : "production"} AWS lane. Configure conditional access in source.`;
  }
  return undefined;
}

/** Availability is editable readiness; auth, caller roles and cycles are structural blockers. */
export function invocationAccessReason(caller: ModelTarget, destination: ModelTarget, models: readonly ModeModel[]): string | undefined {
  if (["workflow", "agent"].includes(destination.kind) && !["http", "webSocket", "webSocketAuthorizer", "service", "tool", "agent"].includes(caller.role)) return "The framework does not support event functions or container tasks calling workflows or agents: they are built before the orchestration stack. Use an HTTP handler, service or tool as the caller.";
  for (const model of models) {
    const from = model.targets.find(item => item.ref === caller.ref), to = model.targets.find(item => item.ref === destination.ref);
    if (!from) continue;
    if (destination.kind === "agent" && to?.auth && !(from.auth && ["http", "tool", "service", "agent"].includes(from.role))) return "This agent requires a caller with a signed-in user.";
    const visited = new Set<string>();
    const path: string[] = [];
    const reaches = (ref: string): boolean => {
      if (ref === caller.ref) { path.push(ref); return true; }
      if (visited.has(ref)) return false;
      visited.add(ref);
      path.push(ref);
      if (model.edges.some(edge => edge.from === ref && ["runsTask", "startsWorkflow", "invokesAgent", "step", "usesGateway", "usesTool"].includes(edge.relation) && reaches(edge.to))) return true;
      path.pop(); return false;
    };
    if (reaches(destination.ref)) return `This invocation would create a dependency cycle: ${[caller.ref, ...path].join(" → ")}.`;
  }
  return undefined;
}

/** Explain unfinished bindings without preventing their source declaration. */
export function invocationAccessWarning(caller: ModelTarget, destination: ModelTarget, models: readonly ModeModel[]): string | undefined {
  const problems = new Set<string>();
  const enabled = (target: ModelTarget, lane: "local" | "cloud") => target.lanes.when ? true
    : target.lanes.deploy ? target.lanes.deploy === "both" || target.lanes.deploy === `${lane}-only` : target.lanes[lane];
  for (const model of models) {
    const from = model.targets.find(item => item.ref === caller.ref), to = model.targets.find(item => item.ref === destination.ref);
    if (!from) continue;
    if (enabled(from, "local") && (!to || !enabled(to, "local"))) problems.add("The destination is unavailable to the local caller.");
    if (enabled(from, "cloud") && (!to || !enabled(to, "cloud"))) problems.add("The destination is unavailable to the AWS caller.");
    if (to?.lanes.when && (enabled(from, "local") || enabled(from, "cloud")) && (!from.lanes.when || to.lanes.when.resource !== from.lanes.when.resource || to.lanes.when.equals !== from.lanes.when.equals)) problems.add("The caller and destination use different deployment conditions.");
    if (from.lanes[model.mode] && to && !to.lanes[model.mode]) problems.add(`The destination is not built in ${model.mode === "prod" ? "Production" : "Development AWS"}.`);
  }
  return problems.size ? `${[...problems].join(" ")} You can save this connection; resolve its errors before running or deploying the caller.` : undefined;
}

export type WorkloadOperation = Extract<DraftEdit, { kind: "implementation" | "connection" | "removeWorkload" }>;
const connections = ["database", "userPool", "runsTask", "startsWorkflow", "invokesAgent", "resource", "grant", "resourceAccess", "managedPolicy"];
function jsonArgument(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => jsonArgument(item, depth + 1));
  return !!value && typeof value === "object" && Object.entries(value).every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && jsonArgument(item, depth + 1));
}
/** Shared typed request boundary; source text, commands and arbitrary destinations are never accepted. */
export function readWorkloadOperation(raw: unknown): WorkloadOperation {
  const fail = (): never => { throw new Error("Choose a supported workload implementation, connection or removal operation with a canonical declared target."); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (!["implementation", "connection", "removeWorkload"].includes(String(item.kind)) || typeof item.target !== "string" || !/^(?:lambda|service|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*$/.test(item.target)) return fail();
  const allowed = item.kind === "connection" ? ["kind", "target", "connection", "destination", "enabled", "variable", "grant", "grantArguments", "previousGrant", "scope", "actions", "limits", "previous"] : ["kind", "target"];
  if (Object.keys(item).some(key => !allowed.includes(key))) return fail();
  if (item.kind === "connection") {
    if (item.connection === "resourceAccess") {
      if (item.grant !== undefined || item.variable !== undefined || item.scope !== undefined) return fail();
      try {
        normalizeResourceAccess({ actions: item.actions, limits: item.limits } as Parameters<typeof normalizeResourceAccess>[0]);
        if (item.previous !== undefined) normalizeResourceAccess(item.previous as Parameters<typeof normalizeResourceAccess>[0]);
      } catch { return fail(); }
    } else if (item.actions !== undefined || item.limits !== undefined || item.previous !== undefined) return fail();
    if (!connections.includes(String(item.connection)) || typeof item.enabled !== "boolean") return fail();
    if (item.destination !== undefined && (typeof item.destination !== "string" || item.destination.length > 300 || !/^(?:resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|(?:lambda|service|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*)$/.test(item.destination))) return fail();
    if (item.variable !== undefined && (typeof item.variable !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(item.variable))) return fail();
    if (item.grant !== undefined && (typeof item.grant !== "string" || !/^grant[A-Za-z0-9_$]*$/.test(item.grant))) return fail();
    if (item.grantArguments !== undefined && (item.connection !== "grant" || !Array.isArray(item.grantArguments) || !jsonArgument(item.grantArguments))) return fail();
    if (item.previousGrant !== undefined) {
      const previous = item.previousGrant as Record<string, unknown>;
      if (item.connection !== "grant" || !previous || typeof previous !== "object" || Array.isArray(previous) || Object.keys(previous).some(key => !["method", "arguments"].includes(key)) || typeof previous.method !== "string" || !/^grant[A-Za-z0-9_$]*$/.test(previous.method) || !Array.isArray(previous.arguments) || !jsonArgument(previous.arguments)) return fail();
    }
    if (item.connection !== "grant" && (item.grant !== undefined || item.scope !== undefined)) return fail();
    if (item.scope !== undefined && (typeof item.scope !== "string" || item.scope.length > 256 || /[\r\n\0]/.test(item.scope))) return fail();
  }
  return item as unknown as WorkloadOperation;
}

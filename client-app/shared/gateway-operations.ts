import type { DraftEdit } from "./api";

export type GatewayOperation = Extract<DraftEdit, { kind: "agentGateways" | "gatewayTools" | "gatewayDeploy" | "removeGateway" }>;
export const isGatewayOperation = (kind: string): boolean => ["agentGateways", "gatewayTools", "gatewayDeploy", "removeGateway"].includes(kind);
/** Bounded source intent. Runtime endpoints and IAM policies are derived, never supplied by the browser. */
export function readGatewayOperation(raw: unknown): GatewayOperation {
  const fail = (): never => { throw new Error("Choose a declared AgentCore gateway operation with distinct literal identifiers."); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (typeof item.kind !== "string" || !isGatewayOperation(item.kind)) return fail();
  const allowed = item.kind === "agentGateways" ? ["kind", "target", "gateways"] : item.kind === "gatewayTools" ? ["kind", "gateway", "tools"] : item.kind === "gatewayDeploy" ? ["kind", "gateway", "value"] : ["kind", "gateway"];
  if (Object.keys(item).some(key => !allowed.includes(key))) return fail();
  if (item.kind === "agentGateways" ? typeof item.target !== "string" || !/^agent:[A-Za-z][A-Za-z0-9_-]*$/.test(item.target) : typeof item.gateway !== "string" || item.gateway.length > 300 || !/^gateway:agentcore:[A-Za-z][A-Za-z0-9_-]*$/.test(item.gateway)) return fail();
  if (item.kind === "agentGateways" || item.kind === "gatewayTools") {
    const list = item[item.kind === "agentGateways" ? "gateways" : "tools"];
    if (!Array.isArray(list) || list.length > 50 || list.some(value => typeof value !== "string" || value.length > 200 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) || new Set(list).size !== list.length) return fail();
  }
  if (item.kind === "gatewayDeploy") {
    const value = item.value;
    if (typeof value === "string") { if (!["both", "local-only", "cloud-only", "none", "inherit"].includes(value)) return fail(); }
    else {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("when" in value)) return fail();
      const when = (value as { when: unknown }).when;
      if (!when || typeof when !== "object" || Array.isArray(when) || Object.keys(when).some(key => !["resource", "equals"].includes(key))) return fail();
      const condition = when as { resource?: unknown; equals?: unknown };
      if (typeof condition.resource !== "string" || !/^resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(condition.resource) || typeof condition.equals !== "string" || !condition.equals.trim() || condition.equals.trim() !== condition.equals || condition.equals.length > 500 || /[\r\n\0]/.test(condition.equals)) return fail();
    }
  }
  return item as unknown as GatewayOperation;
}

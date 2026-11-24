import type { SourceLocation } from "./model";
import { normalizeIamConditions, type IamConditions } from "aws-studio/config/iam-access";
export type PermissionResourceInput =
  | { readonly kind: "catalog"; readonly resource: string; readonly attribute: string; readonly suffix?: string }
  | { readonly kind: "target"; readonly target: string; readonly suffix?: string }
  | { readonly kind: "literal"; readonly value: string };
export interface PermissionStatementInput {
  readonly actions: readonly string[];
  readonly resources: readonly PermissionResourceInput[];
  readonly effect?: "Allow" | "Deny";
  readonly conditions?: IamConditions;
}
export interface PolicyRule {
  readonly id: string;
  readonly consumers: readonly string[];
  readonly location?: SourceLocation;
  readonly writable: boolean;
  readonly reason?: string;
  readonly shared: boolean;
  readonly statement: PermissionStatementInput;
}
export interface IamPolicyEdit { readonly kind: "iamPolicy"; readonly target: string; readonly operation: "add" | "update" | "remove"; readonly rule?: string; readonly statement?: PermissionStatementInput }
/** Compare authored policy semantics independently of object ordering and default Allow. */
export function permissionStatementKey(statement: PermissionStatementInput): string {
  const resources = statement.resources.map(resource => resource.kind === "literal" ? { kind: resource.kind, value: resource.value }
    : resource.kind === "target" ? { kind: resource.kind, target: resource.target, ...(resource.suffix ? { suffix: resource.suffix } : {}) }
    : { kind: resource.kind, resource: resource.resource, attribute: resource.attribute, ...(resource.suffix ? { suffix: resource.suffix } : {}) });
  return JSON.stringify({ actions: [...new Set(statement.actions)].sort(), resources: resources.map(resource => JSON.stringify(resource)).sort(), effect: statement.effect ?? "Allow", conditions: statement.conditions ? normalizeIamConditions(statement.conditions) : {} });
}
/** Canonical browser presentation of the framework's serializable IAM references. */
export function permissionStatementInput(statement: { readonly actions: readonly string[]; readonly resources: readonly unknown[]; readonly effect?: "Allow" | "Deny"; readonly conditions?: PermissionStatementInput["conditions"] }): PermissionStatementInput {
  const resource = (raw: unknown): PermissionResourceInput => {
    if (typeof raw === "string") return { kind: "literal", value: raw };
    if (!raw || typeof raw !== "object") throw new Error("Unsupported IAM resource reference.");
    const item = raw as Record<string, unknown>;
    if (typeof item.$targetArn === "string") return { kind: "target", target: item.$targetArn, ...(typeof item.suffix === "string" ? { suffix: item.suffix } : {}) };
    if (item.resource) { const base = resource(item.resource); return { ...base, ...(typeof item.suffix === "string" ? { suffix: item.suffix } : {}) }; }
    if (item.$resource === "aws-studio/resource" && Array.isArray(item.path) && typeof item.attribute === "string") return { kind: "catalog", resource: `resource:${item.path.join(".")}`, attribute: item.attribute };
    if (item.$resource === "aws-studio/resource" && item.secretArn && Array.isArray(item.path)) return { kind: "catalog", resource: `resource:${item.path.join(".")}`, attribute: "arn" };
    throw new Error("Unsupported IAM resource reference.");
  };
  return { actions: [...statement.actions], resources: statement.resources.map(resource), ...(statement.effect ? { effect: statement.effect } : {}), ...(statement.conditions ? { conditions: statement.conditions } : {}) };
}
export const permissionTargetPattern = /^(?:lambda|service|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*$/;
export const permissionResourcePattern = /^resource:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function readPermissionStatement(raw: unknown): PermissionStatementInput {
  const fail = (): never => { throw new Error("Choose IAM actions, declared resource references or literal ARNs, and valid optional conditions."); };
  if (!record(raw) || Object.keys(raw).some(key => !["actions", "resources", "effect", "conditions"].includes(key))) return fail();
  if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > 200 || raw.actions.some(action => typeof action !== "string" || action.length > 160 || !/^(?:\*|[A-Za-z0-9-]+:[A-Za-z0-9*?]+)$/.test(action))) return fail();
  if (!Array.isArray(raw.resources) || !raw.resources.length || raw.resources.length > 200) return fail();
  for (const resource of raw.resources) {
    if (!record(resource) || !["catalog", "target", "literal"].includes(String(resource.kind))) return fail();
    const keys = resource.kind === "catalog" ? ["kind", "resource", "attribute", "suffix"] : resource.kind === "target" ? ["kind", "target", "suffix"] : ["kind", "value"];
    if (Object.keys(resource).some(key => !keys.includes(key))) return fail();
    if (resource.suffix !== undefined && (typeof resource.suffix !== "string" || resource.suffix.length > 512 || /[\r\n\0]/.test(resource.suffix))) return fail();
    if (resource.kind === "catalog" && (typeof resource.resource !== "string" || !permissionResourcePattern.test(resource.resource) || typeof resource.attribute !== "string" || !/^[A-Za-z_$][\w$]*$/.test(resource.attribute))) return fail();
    if (resource.kind === "target" && (typeof resource.target !== "string" || !/^(?:lambda|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*$/.test(resource.target))) return fail();
    if (resource.kind === "literal" && (typeof resource.value !== "string" || !resource.value.length || resource.value.length > 2048 || /[\r\n\0]/.test(resource.value))) return fail();
  }
  if (raw.effect !== undefined && !["Allow", "Deny"].includes(String(raw.effect))) return fail();
  if (raw.conditions !== undefined) try { normalizeIamConditions(raw.conditions as IamConditions); } catch { return fail(); }
  return raw as unknown as PermissionStatementInput;
}
export function readIamPolicyEdit(raw: unknown): IamPolicyEdit {
  if (!record(raw) || Object.keys(raw).some(key => !["kind", "target", "operation", "rule", "statement"].includes(key)) || raw.kind !== "iamPolicy" || typeof raw.target !== "string" || !permissionTargetPattern.test(raw.target) || !["add", "update", "remove"].includes(String(raw.operation))) throw new Error("Choose an explicit workload IAM policy operation.");
  if (raw.operation !== "add" && (typeof raw.rule !== "string" || !raw.rule.length || raw.rule.length > 512)) throw new Error("Select the exact source policy rule.");
  if (raw.operation === "add" && raw.rule !== undefined || raw.operation === "remove" && raw.statement !== undefined) throw new Error("Use the policy fields required by this operation.");
  if (raw.operation !== "remove") readPermissionStatement(raw.statement);
  return raw as unknown as IamPolicyEdit;
}

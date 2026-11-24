import { isCdkResource, type CdkResourceSpec } from "./cdk-resources";
import { isResourceReference, type ResourceReference } from "./resources";
import type { TargetReference } from "./index";

export type ArnTargetReference = Exclude<TargetReference, `service:${string}`>;
export interface WorkloadArnReference { readonly $targetArn: ArnTargetReference }
export type AccessResourceReference = ResourceReference<"string"> | WorkloadArnReference;
export type AccessResource = string | AccessResourceReference | { readonly resource: AccessResourceReference; readonly suffix?: string };
export type IamConditionScalar = string | number | boolean | null;
export type IamConditions = Readonly<Record<string, Readonly<Record<string, IamConditionScalar | readonly IamConditionScalar[]>>>>;
export interface CloudAccessStatement {
  readonly actions: readonly [string, ...string[]];
  readonly resources: readonly [AccessResource, ...AccessResource[]];
  readonly effect?: "Allow" | "Deny";
  readonly conditions?: IamConditions;
}
export interface ManagedPolicyBinding {
  readonly capability: "managedPolicy";
  readonly resource: CdkResourceSpec;
}

/** An ARN scope, not an invocation binding or runtime descriptor. */
export function targetArn(reference: ArnTargetReference): WorkloadArnReference {
  if (typeof reference !== "string" || !/^(lambda|task|workflow|agent):[A-Za-z][A-Za-z0-9_-]*$/.test(reference)) throw new Error("targetArn() requires a declared Lambda, task, workflow or agent target.");
  return Object.freeze({ $targetArn: reference });
}
export function isWorkloadArnReference(value: unknown): value is WorkloadArnReference {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "$targetArn");
}

const safeKey = (key: string) => !!key && !/[\r\n\0]/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
function normalizeReference(value: AccessResourceReference): AccessResourceReference {
  if (isWorkloadArnReference(value)) {
    if (Object.keys(value).some(key => key !== "$targetArn")) throw new Error("A target ARN reference only names its target.");
    return targetArn(value.$targetArn);
  }
  if (!isResourceReference(value) || value.kind !== "string" || !value.path.length) throw new Error("IAM resource scopes use a string, a catalog string attribute or targetArn().");
  return value;
}
export function normalizeAccessResource(value: AccessResource): AccessResource {
  if (typeof value === "string") {
    if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error("IAM resource scopes must be nonempty strings.");
    return value;
  }
  if (isResourceReference(value) || isWorkloadArnReference(value)) return normalizeReference(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["resource", "suffix"].includes(key))) throw new Error("An IAM resource expression accepts a reference and optional suffix.");
  if (value.suffix !== undefined && (typeof value.suffix !== "string" || /[\r\n\0]/.test(value.suffix))) throw new Error("An IAM resource suffix must be a string.");
  return Object.freeze({ resource: normalizeReference(value.resource), ...(value.suffix ? { suffix: value.suffix } : {}) });
}
export function accessResourceReference(value: AccessResource): AccessResourceReference | undefined {
  return typeof value === "string" ? undefined : isResourceReference(value) || isWorkloadArnReference(value) ? value : value.resource;
}
export function normalizeIamConditions(conditions: IamConditions): IamConditions {
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions) || !Object.keys(conditions).length) throw new Error("IAM conditions require an operator and condition key.");
  const scalar = (value: unknown): value is IamConditionScalar => value === null || typeof value === "boolean" || typeof value === "string" && !/[\r\n\0]/.test(value) || typeof value === "number" && Number.isFinite(value);
  const result: Record<string, Record<string, IamConditionScalar | readonly IamConditionScalar[]>> = {};
  for (const operator of Object.keys(conditions).sort()) {
    if (!safeKey(operator) || !/^(?:(?:ForAnyValue|ForAllValues):)?[A-Za-z][A-Za-z0-9]*$/.test(operator)) throw new Error("Choose a valid IAM condition operator.");
    const entries = conditions[operator];
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.keys(entries).length) throw new Error("IAM condition operators require condition keys.");
    result[operator] = {};
    for (const key of Object.keys(entries).sort()) {
      const value = entries[key];
      if (!safeKey(key) || !(scalar(value) || Array.isArray(value) && value.length > 0 && value.every(scalar))) throw new Error("IAM condition values are JSON scalars or nonempty scalar arrays.");
      result[operator]![key] = Array.isArray(value) ? Object.freeze([...value]) : value as IamConditionScalar;
    }
    Object.freeze(result[operator]);
  }
  return Object.freeze(result);
}
/** Browser-safe normalization shared by declarations, Studio and CDK. */
export function normalizeCloudAccessStatement(statement: CloudAccessStatement): CloudAccessStatement {
  if (!statement || typeof statement !== "object" || Array.isArray(statement) || Object.keys(statement).some(key => !["actions", "resources", "effect", "conditions"].includes(key))) throw new Error("IAM statements accept actions, resources, effect and conditions.");
  if (!Array.isArray(statement.actions) || !statement.actions.length || statement.actions.some(action => typeof action !== "string" || !action.trim() || /[\r\n\0]/.test(action))) throw new Error("IAM statements require nonempty action strings.");
  if (!Array.isArray(statement.resources) || !statement.resources.length) throw new Error("IAM statements require at least one resource scope.");
  if (statement.effect !== undefined && !["Allow", "Deny"].includes(statement.effect)) throw new Error("IAM statement effect is Allow or Deny.");
  return Object.freeze({ actions: Object.freeze([...statement.actions]) as readonly [string, ...string[]], resources: Object.freeze(statement.resources.map(normalizeAccessResource)) as readonly [AccessResource, ...AccessResource[]], ...(statement.effect ? { effect: statement.effect } : {}), ...(statement.conditions !== undefined ? { conditions: normalizeIamConditions(statement.conditions) } : {}) });
}
/** Attach a native managed policy without copying its native-owned document. */
export function managedPolicy(resource: CdkResourceSpec): ManagedPolicyBinding {
  if (!isCdkResource(resource) || !resource.path.length) throw new Error("managedPolicy() requires a public native managed-policy catalog reference.");
  return Object.freeze({ capability: "managedPolicy", resource });
}

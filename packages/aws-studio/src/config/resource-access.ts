import { isCdkResource, type CdkResourceSpec } from "./cdk-resources";

export type ResourceAccessAction = "read" | "write" | "delete" | "send" | "receive" | "publish" | "invoke";
export interface ResourceAccessLimits {
  /** Literal object-key prefix, including any desired trailing slash. */
  readonly objectPrefix?: string;
  readonly requireHttps?: boolean;
}
export interface ResourceAccessOptions {
  readonly actions: readonly ResourceAccessAction[];
  readonly limits?: ResourceAccessLimits;
}
export interface ResourceAccessBinding extends ResourceAccessOptions {
  readonly capability: "resourceAccess";
  readonly resource: CdkResourceSpec;
}
export interface ResourceAccessDefinition {
  readonly id: "s3" | "dynamodb" | "sqs" | "sns" | "eventbridge" | "lambda";
  readonly types: readonly string[];
  readonly actions: readonly { readonly id: ResourceAccessAction; readonly label: string }[];
  readonly limits: readonly (keyof ResourceAccessLimits)[];
}

/** Public, browser-safe capabilities. CDK and Studio use these same action IDs. */
export const RESOURCE_ACCESS_DEFINITIONS: readonly ResourceAccessDefinition[] = [
  { id: "s3", types: ["aws-s3:IBucket", "aws-s3:Bucket"], actions: [{ id: "read", label: "Read objects" }, { id: "write", label: "Write objects" }, { id: "delete", label: "Delete objects" }], limits: ["objectPrefix", "requireHttps"] },
  { id: "dynamodb", types: ["aws-dynamodb:ITable", "aws-dynamodb:ITableV2", "aws-dynamodb:Table", "aws-dynamodb:TableV2"], actions: [{ id: "read", label: "Read items" }, { id: "write", label: "Write items" }, { id: "delete", label: "Delete items" }], limits: [] },
  { id: "sqs", types: ["aws-sqs:IQueue", "aws-sqs:Queue"], actions: [{ id: "send", label: "Send messages" }, { id: "receive", label: "Receive messages" }, { id: "delete", label: "Delete messages" }], limits: [] },
  { id: "sns", types: ["aws-sns:ITopic", "aws-sns:Topic"], actions: [{ id: "publish", label: "Publish" }], limits: [] },
  { id: "eventbridge", types: ["aws-events:IEventBus", "aws-events:EventBus"], actions: [{ id: "publish", label: "Publish" }], limits: [] },
  { id: "lambda", types: ["aws-lambda:IFunction", "aws-lambda:Function"], actions: [{ id: "invoke", label: "Invoke" }], limits: [] },
];

export function resourceAccessDefinition(types: readonly string[]): ResourceAccessDefinition | undefined {
  const definitions = RESOURCE_ACCESS_DEFINITIONS.filter(definition => definition.types.some(type => types.includes(type)));
  return definitions.length === 1 ? definitions[0] : undefined;
}

/** Strict at every entry point, including JavaScript declarations and HTTP edits. */
export function normalizeResourceAccess(value: ResourceAccessOptions, definition?: ResourceAccessDefinition): ResourceAccessOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["actions", "limits"].includes(key))) throw new Error("Resource access accepts actions and optional limits.");
  const known = new Set<string>(RESOURCE_ACCESS_DEFINITIONS.flatMap(item => item.actions.map(action => action.id)));
  if (!Array.isArray(value.actions) || !value.actions.length || value.actions.some(action => typeof action !== "string" || !known.has(action)) || new Set(value.actions).size !== value.actions.length) throw new Error("Choose at least one distinct supported resource action.");
  if (definition && value.actions.some(action => !definition.actions.some(item => item.id === action))) throw new Error(`Choose supported ${definition.id} actions.`);
  const limits = value.limits;
  if (limits !== undefined && (!limits || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).some(key => !["objectPrefix", "requireHttps"].includes(key)))) throw new Error("Choose supported resource access limits.");
  if (limits?.objectPrefix !== undefined && (typeof limits.objectPrefix !== "string" || !limits.objectPrefix.length || limits.objectPrefix.length > 256 || /[\r\n\0*?]/.test(limits.objectPrefix) || limits.objectPrefix.includes("${"))) throw new Error("Use a literal object prefix of 1–256 characters, without wildcards or IAM variables.");
  if (limits?.requireHttps !== undefined && typeof limits.requireHttps !== "boolean") throw new Error("Require HTTPS must be a boolean.");
  if (definition && limits && Object.keys(limits).some(key => !definition.limits.includes(key as keyof ResourceAccessLimits))) throw new Error(`Access limits are not supported for ${definition.id}.`);
  const normalizedLimits = { ...(limits?.objectPrefix ? { objectPrefix: limits.objectPrefix } : {}), ...(limits?.requireHttps ? { requireHttps: true } : {}) };
  return { actions: Object.freeze([...value.actions].sort()), ...(Object.keys(normalizedLimits).length ? { limits: Object.freeze(normalizedLimits) } : {}) };
}

/** Application runtime access to an existing typed native resource. Never creates it. */
export function resourceAccess(resource: CdkResourceSpec, options: ResourceAccessOptions): ResourceAccessBinding {
  if (!isCdkResource(resource) || !resource.path.length) throw new Error("Resource access requires a declared native catalog resource.");
  return Object.freeze({ capability: "resourceAccess", resource, ...normalizeResourceAccess(options) });
}

export function resourceAccessKey(options: ResourceAccessOptions): string {
  return JSON.stringify(normalizeResourceAccess(options));
}

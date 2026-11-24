import type { ResourceAccessAction, ResourceAccessOptions } from "aws-studio/config/resource-access";

/** Native helpers selected from source-discovered CDK types, shared by UI and writer. */
const GRANTS = [
  { type: /^aws-s3:I?Bucket$/, method: "grantRead", label: "Read bucket objects", scope: true },
  { type: /^aws-s3:I?Bucket$/, method: "grantWrite", label: "Write and delete bucket objects", scope: true },
  { type: /^aws-s3:I?Bucket$/, method: "grantReadWrite", label: "Read, write and delete bucket objects", scope: true },
  { type: /^aws-sqs:I?Queue$/, method: "grantSendMessages", label: "Send queue messages", scope: false },
  { type: /^aws-sqs:I?Queue$/, method: "grantConsumeMessages", label: "Consume queue messages", scope: false },
  { type: /^aws-dynamodb:I?Table(?:V2)?$/, method: "grantReadData", label: "Read table data", scope: false },
  { type: /^aws-dynamodb:I?Table(?:V2)?$/, method: "grantWriteData", label: "Write and delete table data", scope: false },
  { type: /^aws-dynamodb:I?Table(?:V2)?$/, method: "grantReadWriteData", label: "Read, write and delete table data", scope: false },
  { type: /^aws-sns:I?Topic$/, method: "grantPublish", label: "Publish topic messages", scope: false },
  { type: /^aws-events:I?EventBus$/, method: "grantPutEventsTo", label: "Publish events", scope: false },
] as const;
export type NativeGrantMethod = typeof GRANTS[number]["method"];
export const grantOptions = (types: readonly string[]) => GRANTS.filter(grant => types.some(type => grant.type.test(type)));
export const nativeGrantLabels: Readonly<Record<NativeGrantMethod, string>> = Object.fromEntries(GRANTS.map(grant => [grant.method, grant.label])) as Record<NativeGrantMethod, string>;

/** Recognized application actions only; native helpers can include additional actions. */
export const nativeGrantApplicationActions: Readonly<Record<string, readonly ResourceAccessAction[] | undefined>> = {
  grantRead: ["read"], grantWrite: ["write", "delete"], grantReadWrite: ["read", "write", "delete"],
  grantReadData: ["read"], grantWriteData: ["write", "delete"], grantReadWriteData: ["read", "write", "delete"],
  grantSendMessages: ["send"], grantConsumeMessages: ["receive", "delete"], grantPublish: ["publish"], grantPutEventsTo: ["publish"],
};

/** Prove that another recognized declaration also grants this rule's application access. */
export function permissionRuleCoveredBy(rule: ResourceAccessOptions, other: ResourceAccessOptions | { readonly method: string; readonly arguments: readonly unknown[] }): boolean {
  let options: ResourceAccessOptions;
  if ("method" in other) {
    const actions = nativeGrantApplicationActions[other.method];
    if (!actions || other.arguments.length > 1) return false;
    const scope = other.arguments[0];
    if (scope !== undefined && (typeof scope !== "string" || scope !== "*" && (!scope.endsWith("*") || /[?*]/.test(scope.slice(0, -1)) || scope.includes("${")))) return false;
    options = { actions, ...(typeof scope === "string" && scope !== "*" ? { limits: { objectPrefix: scope.slice(0, -1) } } : {}) };
  } else options = other;
  return rule.actions.every(action => options.actions.includes(action))
    && (rule.limits?.objectPrefix ?? "").startsWith(options.limits?.objectPrefix ?? "")
    && (!options.limits?.requireHttps || !!rule.limits?.requireHttps);
}

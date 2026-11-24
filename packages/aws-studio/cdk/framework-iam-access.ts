import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct, type IConstruct } from "constructs";
import { createHash } from "node:crypto";
import {
  accessResourceReference, formatAccessResource, isResourceReference, isWorkloadArnReference,
  normalizeCloudAccessStatement, type AccessResource, type CloudAccessStatement, type ManagedPolicyBinding, type ResourceAccessBinding,
} from "aws-studio/config";
import { applyResourceAccess, frameworkResourceOptions, resolveLinkedNativeResource, resolveLinkedResource } from "./framework-resources";
import { permissionTargets } from "./framework-target-registry";
import { markInfrastructure } from "./framework-inventory";

interface AttachmentRegistry { readonly stack: cdk.Stack; readonly roles: Map<string, iam.IRole> }
const attachmentRegistries = new WeakMap<IConstruct, AttachmentRegistry>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);

/** A proxy permits policy resources in a neutral scope without changing role ownership/trust. */
export function permissionAttachmentPrincipal(scope: IConstruct, grantee: iam.IGrantable, origin: string): { readonly scope: cdk.Stack; readonly role: iam.IRole } {
  const original = ownedExecutionRole(grantee, origin);
  const root = scope.node.root;
  let entry = attachmentRegistries.get(root);
  if (!entry) {
    const options = frameworkResourceOptions(scope), owner = cdk.Stack.of(scope);
    const id = `${options?.deployment ?? owner.stackName}-PermissionAttachmentsStack`;
    const stack = new cdk.Stack(root as Construct, id, { env: options?.env ?? { account: owner.account, region: owner.region } });
    markInfrastructure(stack, "framework-stack:PermissionAttachmentsStack");
    entry = { stack, roles: new Map() };
    attachmentRegistries.set(root, entry);
  }
  const key = `${cdk.Stack.of(original).node.path}:${original.node.path}`;
  let role = entry.roles.get(key);
  if (!role) {
    const id = `Principal${digest(key)}`;
    // Use the original name directly: splitting a tokenized ARN cannot preserve IAM role paths.
    role = iam.Role.fromRoleName(entry.stack, id, original.roleName, { mutable: true, defaultPolicyName: `FrameworkAccess${digest(key)}` });
    entry.roles.set(key, role);
  }
  return { scope: entry.stack, role };
}

function ownedExecutionRole(grantee: iam.IGrantable, origin: string): iam.Role {
  const principal = grantee.grantPrincipal;
  if (!iam.Role.isRole(principal) || !cdk.Resource.isOwnedResource(principal)) throw new Error(`${origin}: permissions require the framework-owned execution or task role; an imported immutable principal cannot receive these policies.`);
  return principal;
}

export function resolveAccessResource(scope: IConstruct, value: AccessResource, origin: string): string {
  const reference = accessResourceReference(value);
  if (!reference) {
    const stack = cdk.Stack.of(scope);
    return formatAccessResource(value as string, { partition: cdk.Aws.PARTITION, region: stack.region, account: stack.account });
  }
  let arn: string;
  if (isWorkloadArnReference(reference)) {
    const target = permissionTargets(scope).get(reference.$targetArn);
    if (!target || target.kind === "service") throw new Error(`${origin}: ${reference.$targetArn} is not built in this deployment.`);
    arn = target.kind === "lambda" ? target.function.functionArn : target.kind === "task" ? target.taskDefinition.taskDefinitionArn : target.kind === "workflow" ? target.stateMachine.stateMachineArn : target.arn;
  } else {
    const resolved = resolveLinkedResource(scope, reference, origin, true);
    if (typeof resolved !== "string") throw new Error(`${origin}: an IAM resource scope must resolve to a string ARN.`);
    arn = resolved;
  }
  return `${arn}${typeof value === "object" && !isResourceReference(value) && !isWorkloadArnReference(value) ? value.suffix ?? "" : ""}`;
}

/** Referenced rules are attached only after native linking and target composition. */
export function applyCloudAccessStatement(scope: IConstruct, grantee: iam.IGrantable, input: CloudAccessStatement, origin: string): iam.PolicyStatement {
  const statement = normalizeCloudAccessStatement(input);
  const dynamic = statement.resources.some(resource => accessResourceReference(resource) !== undefined);
  const attachment = dynamic ? permissionAttachmentPrincipal(scope, grantee, origin) : { scope, role: grantee };
  const policy = new iam.PolicyStatement({
    effect: statement.effect === "Deny" ? iam.Effect.DENY : iam.Effect.ALLOW,
    actions: [...statement.actions], resources: statement.resources.map(resource => resolveAccessResource(attachment.scope, resource, origin)),
    ...(statement.conditions ? { conditions: statement.conditions } : {}),
  });
  const result = attachment.role.grantPrincipal.addToPrincipalPolicy(policy);
  if (!result.statementAdded) throw new Error(`${origin}: the principal refused its declared IAM statement.`);
  return policy;
}

/** Guided references share the neutral attachment path, including supporting KMS grants. */
export function applyGuidedResourceAccess(scope: IConstruct, grantee: iam.IGrantable, binding: ResourceAccessBinding, origin: string): void {
  const attachment = permissionAttachmentPrincipal(scope, grantee, origin);
  applyResourceAccess(attachment.scope, attachment.role, binding, origin);
}

export function applyManagedPolicy(scope: IConstruct, grantee: iam.IGrantable, binding: ManagedPolicyBinding, origin: string): void {
  const { value } = resolveLinkedNativeResource(scope, binding.resource, origin);
  if (!value || typeof value !== "object" || typeof (value as iam.IManagedPolicy).managedPolicyArn !== "string") throw new Error(`${origin}: stacks.${binding.resource.path.join(".")} is not a native IManagedPolicy.`);
  // An imported-role proxy silently drops imported IManagedPolicy attachments in CDK.
  // Update the owned role's ManagedPolicyArns, preserving its identity and trust policy.
  ownedExecutionRole(grantee, origin).addManagedPolicy(value as iam.IManagedPolicy);
}

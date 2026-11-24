import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";
import { Template } from "aws-cdk-lib/assertions";
import { cdk as native, defineStacks, stack, managedPolicy, resourceAccess, targetArn, type FrameworkConfig } from "aws-studio/config";
import { applyCloudAccessStatement, applyGuidedResourceAccess, applyManagedPolicy, resolveAccessResource } from "aws-studio/cdk/framework-iam-access";
import { initializeFrameworkResources, linkResource, linkResources } from "aws-studio/cdk/framework-resources";
import { FrameworkTargetRegistry, registerPermissionTargets } from "aws-studio/cdk/framework-target-registry";
import { applyLambdaConcurrency } from "aws-studio/cdk/framework-lambda";

const env = { account: "111111111111", region: "us-east-1" };
const roleIn = (owner: cdk.Stack) => new iam.Role(owner, "ExecutionRole", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
function initialize(app: cdk.App) { initializeFrameworkResources(app, { config: {} as FrameworkConfig, mode: "prod", deployment: "example-prod", env }); }
const resourcesOf = (template: Record<string, any>, type: string) => (Object.entries(template.Resources ?? {}) as [string, any][]).filter(([, value]) => value.Type === type);

test("referenced Cognito IAM uses a neutral stack without changing execution role, trigger or pool identities", () => {
  const app = new cdk.App(); initialize(app);
  const eventStack = new cdk.Stack(app, "Events", { env });
  const role = roleIn(eventStack);
  const fn = new lambda.Function(eventStack, "PreSignup", { role, runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=async e=>e;") });
  const nativeStack = new cdk.Stack(app, "Cognito", { env });
  const pool = new cognito.UserPool(nativeStack, "Pool", { lambdaTriggers: { preSignUp: fn } });
  const catalog = defineStacks({ pool: native<cognito.IUserPool>() });
  linkResource(nativeStack, catalog.pool, pool);
  const roleId = eventStack.getLogicalId(role.node.defaultChild as cdk.CfnElement), fnId = eventStack.getLogicalId(fn.node.defaultChild as cdk.CfnElement), poolId = nativeStack.getLogicalId(pool.node.defaultChild as cdk.CfnElement);
  const roleBefore = eventStack.resolve({ AssumeRolePolicyDocument: (role.node.defaultChild as iam.CfnRole).assumeRolePolicyDocument });
  applyCloudAccessStatement(eventStack, role, { actions: ["cognito-idp:AdminLinkProviderForUser", "cognito-idp:ListUsers"], resources: [catalog.pool.userPoolArn] }, "lambda:pre-signup");
  const assembly = app.synth({ skipValidation: true });
  const permission = assembly.stacks.find(item => item.stackName === "example-prod-PermissionAttachmentsStack")!;
  assert.ok(permission);
  assert.deepEqual(new Set(permission.dependencies.filter(item => item.manifest.type === "aws:cloudformation:stack").map(item => item.id)), new Set(["Events", "Cognito"]));
  const eventTemplate = assembly.getStackArtifact(eventStack.artifactId).template;
  assert.deepEqual(eventTemplate.Resources[roleId].Properties, roleBefore);
  assert.ok(Object.hasOwn(eventTemplate.Resources, fnId));
  assert.ok(Object.hasOwn(assembly.getStackArtifact(nativeStack.artifactId).template.Resources, poolId));
  assert.equal(resourcesOf(permission.template, "AWS::IAM::Role").length, 0);
  const policy = resourcesOf(permission.template, "AWS::IAM::Policy")[0]![1].Properties.PolicyDocument.Statement[0];
  assert.equal(policy.Effect, "Allow");
  assert.ok(JSON.stringify(policy.Resource).includes("Fn::ImportValue"));
});

test("guided encrypted S3 access avoids reverse stack dependencies and preserves existing role policies", () => {
  const app = new cdk.App(); initialize(app);
  const owner = new cdk.Stack(app, "Events", { env }), role = roleIn(owner);
  const fn = new lambda.Function(owner, "Receiver", { role, runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=async()=>{};") });
  applyCloudAccessStatement(owner, role, { actions: ["logs:CreateLogStream"], resources: ["*"] }, "lambda:receiver");
  const nativeStack = new cdk.Stack(app, "Native", { env });
  // Native stacks can already depend on a framework workload (for example, an event target).
  new cdk.CfnOutput(nativeStack, "ReceiverArn", { value: fn.functionArn });
  const key = new kms.Key(nativeStack, "Key"), bucket = new s3.Bucket(nativeStack, "Files", { encryptionKey: key });
  const catalog = defineStacks({ files: native<s3.IBucket>() });
  linkResource(nativeStack, catalog.files, bucket);
  const roleId = owner.getLogicalId(role.node.defaultChild as cdk.CfnElement), fnId = owner.getLogicalId(fn.node.defaultChild as cdk.CfnElement), bucketId = nativeStack.getLogicalId(bucket.node.defaultChild as cdk.CfnElement);
  const trustBefore = owner.resolve((role.node.defaultChild as iam.CfnRole).assumeRolePolicyDocument);
  applyGuidedResourceAccess(owner, role, resourceAccess(catalog.files, { actions: ["read"], limits: { objectPrefix: "uploads/", requireHttps: true } }), "lambda:receiver");
  const assembly = app.synth({ skipValidation: true });
  const attachment = assembly.stacks.find(item => item.stackName === "example-prod-PermissionAttachmentsStack")!;
  assert.deepEqual(new Set(attachment.dependencies.filter(item => item.manifest.type === "aws:cloudformation:stack").map(item => item.id)), new Set(["Events", "Native"]));
  const original = assembly.getStackArtifact(owner.artifactId).template;
  assert.deepEqual(original.Resources[roleId].Properties.AssumeRolePolicyDocument, trustBefore);
  assert.ok(Object.hasOwn(original.Resources, fnId));
  assert.ok(Object.hasOwn(assembly.getStackArtifact(nativeStack.artifactId).template.Resources, bucketId));
  const originalPolicies = JSON.stringify(resourcesOf(original, "AWS::IAM::Policy"));
  assert.ok(originalPolicies.includes("logs:CreateLogStream"));
  assert.ok(!originalPolicies.includes("s3:"));
  const statements = resourcesOf(attachment.template, "AWS::IAM::Policy").flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement);
  const actions = statements.flatMap(statement => statement.Action);
  assert.ok(actions.includes("s3:GetObject"));
  assert.ok(actions.includes("kms:Decrypt"));
  assert.ok(!actions.some((action: string) => /Delete|PutObject/.test(action)));
  assert.ok(statements.filter(statement => JSON.stringify(statement.Action).includes("s3:")).every(statement => statement.Condition.Bool["aws:SecureTransport"] === "true"));
  assert.ok(statements.some(statement => statement.Condition?.StringLike?.["s3:prefix"] === "uploads/*"));
  assert.equal(resourcesOf(attachment.template, "AWS::IAM::Role").length, 0);
});

test("guided grants refuse absent or unlinked resources during synthesis attachment", () => {
  const app = new cdk.App(); initialize(app);
  const owner = new cdk.Stack(app, "Events", { env }), role = roleIn(owner);
  const catalog = defineStacks({ files: native<s3.IBucket>() });
  const binding = resourceAccess(catalog.files, { actions: ["read"] });
  assert.throws(() => applyGuidedResourceAccess(owner, role, binding, "lambda:receiver"), /no linked construct/);
  assert.throws(() => applyGuidedResourceAccess(owner, role, { ...binding, resource: { ...binding.resource, absent: true } }, "lambda:receiver"), /absent in this deployment/);
});

test("literal IAM stays on its original role and referenced Deny statements retain suffixes and conditions", () => {
  const app = new cdk.App(); initialize(app);
  const owner = new cdk.Stack(app, "Caller", { env }), role = roleIn(owner);
  const catalog = defineStacks({ pool: native<cognito.IUserPool>() });
  const nativeStack = new cdk.Stack(app, "Native", { env }), pool = new cognito.UserPool(nativeStack, "Pool");
  linkResource(nativeStack, catalog.pool, pool);
  applyCloudAccessStatement(owner, role, { actions: ["logs:CreateLogStream"], resources: ["arn:{partition}:logs:{region}:{account}:*"] }, "lambda:caller");
  const policy = applyCloudAccessStatement(owner, role, { actions: ["cognito-idp:*"], resources: [{ resource: catalog.pool.userPoolArn, suffix: "/*" }], effect: "Deny", conditions: { Bool: { "aws:SecureTransport": false }, StringEquals: { "aws:PrincipalTag/team": ["a", "b"] } } }, "lambda:caller");
  assert.deepEqual(policy.toStatementJson().Condition, { Bool: { "aws:SecureTransport": false }, StringEquals: { "aws:PrincipalTag/team": ["a", "b"] } });
  assert.equal(policy.toStatementJson().Effect, "Deny");
  assert.ok(policy.resources[0]!.endsWith("/*"));
  const localPolicies = resourcesOf(app.synth({ skipValidation: true }).getStackArtifact(owner.artifactId).template, "AWS::IAM::Policy");
  assert.ok(JSON.stringify(localPolicies).includes("logs:CreateLogStream"));
  assert.ok(!JSON.stringify(localPolicies).includes("cognito-idp:*"));
});

test("managed policy linking handles public IManagedPolicy, ARN imports and detached AWS policies", () => {
  class Security extends cdk.Stack {
    public readonly imported: iam.IManagedPolicy;
    public readonly aws: iam.IManagedPolicy;
    public readonly owned: iam.IManagedPolicy;
    constructor(scope: cdk.App, id: string) {
      super(scope, id, { env });
      this.imported = iam.ManagedPolicy.fromManagedPolicyArn(this, "Imported", "arn:aws:iam::111111111111:policy/ReadData");
      this.aws = iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess");
      this.owned = new iam.ManagedPolicy(this, "Owned", { statements: [new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: ["*"] })] });
      linkResources(this, catalog.security);
    }
  }
  const catalog = defineStacks({ security: stack<Security>() });
  const app = new cdk.App(), security = new Security(app, "Security"), owner = new cdk.Stack(app, "Caller", { env }), role = roleIn(owner);
  const logicalId = owner.getLogicalId(role.node.defaultChild as cdk.CfnElement);
  for (const policy of [catalog.security.imported, catalog.security.aws, catalog.security.owned]) applyManagedPolicy(owner, role, managedPolicy(policy), "lambda:caller");
  const roleTemplate = Template.fromStack(owner).findResources("AWS::IAM::Role")[logicalId] as any;
  assert.equal(roleTemplate.Properties.ManagedPolicyArns.length, 3);
  assert.ok(JSON.stringify(roleTemplate.Properties.ManagedPolicyArns).includes("ReadData"));
  assert.ok(JSON.stringify(roleTemplate.Properties.ManagedPolicyArns).includes("ReadOnlyAccess"));
  assert.equal(roleTemplate.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service, "lambda.amazonaws.com");
  assert.equal(resourcesOf(Template.fromStack(security).toJSON(), "AWS::IAM::ManagedPolicy").length, 1);
  assert.throws(() => applyManagedPolicy(owner, role, managedPolicy(defineStacks({ other: native<unknown>() }).other), "lambda:caller"), /no linked/);
});

test("workload ARN references resolve qualified Lambda, ECS definition, workflow and agent identities", () => {
  const app = new cdk.App(), owner = new cdk.Stack(app, "Targets", { env });
  const fn = new lambda.Function(owner, "Function", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=async()=>{};") });
  applyLambdaConcurrency(fn, { id: "worker", provisionedConcurrentExecutions: 1 } as never);
  const taskDefinition = new ecs.FargateTaskDefinition(owner, "Task"); taskDefinition.addContainer("Container", { image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/node:24") });
  const workflow = new sfn.StateMachine(owner, "Workflow", { definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Succeed(owner, "Done")) });
  const registry = new FrameworkTargetRegistry(); registry.lambda("worker", fn);
  registry.task("worker", { taskDefinition, launch: {} as never, grantRun: () => {} });
  registry.workflow("worker", { stateMachine: workflow, grantStart: () => {} });
  registry.agent("worker", { arn: "arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/worker", region: "us-east-1", auth: false, grantInvoke: () => {} });
  registerPermissionTargets(app, registry);
  assert.ok(registry.requireLambda("lambda:worker") instanceof lambda.Alias);
  assert.equal(resolveAccessResource(owner, targetArn("lambda:worker"), "caller"), registry.requireLambda("lambda:worker").functionArn);
  assert.equal(resolveAccessResource(owner, targetArn("task:worker"), "caller"), taskDefinition.taskDefinitionArn);
  assert.equal(resolveAccessResource(owner, targetArn("workflow:worker"), "caller"), workflow.stateMachineArn);
  assert.equal(resolveAccessResource(owner, targetArn("agent:worker"), "caller"), registry.requireAgent("worker").arn);
  assert.throws(() => resolveAccessResource(owner, targetArn("lambda:missing"), "caller"), /not built/);
});

test("managed policy attachment refuses imported principals and surfaces genuine policy dependency cycles", () => {
  const app = new cdk.App(), owner = new cdk.Stack(app, "Events", { env }), role = roleIn(owner);
  const fn = new lambda.Function(owner, "PreSignup", { role, runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=async e=>e;") });
  const pools = new cdk.Stack(app, "Pools", { env }), pool = new cognito.UserPool(pools, "Pool", { lambdaTriggers: { preSignUp: fn } });
  const policies = new cdk.Stack(app, "Policies", { env });
  const policy = new iam.ManagedPolicy(policies, "PoolPolicy", { statements: [new iam.PolicyStatement({ actions: ["cognito-idp:ListUsers"], resources: [pool.userPoolArn] })] });
  const catalog = defineStacks({ reader: native<iam.IManagedPolicy>() });
  linkResource(policies, catalog.reader, policy);
  const importedRole = iam.Role.fromRoleArn(policies, "Imported", role.roleArn, { mutable: true });
  assert.throws(() => applyManagedPolicy(policies, importedRole, managedPolicy(catalog.reader), "caller"), /framework-owned/);
  applyManagedPolicy(owner, role, managedPolicy(catalog.reader), "caller");
  assert.throws(() => app.synth(), /cyclic reference/);
});

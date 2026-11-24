import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as kms from "aws-cdk-lib/aws-kms";
import { Template } from "aws-cdk-lib/assertions";
import { defineStacks, cdk as nativeResource, resourceAccess, type ResourceAccessAction } from "aws-studio/config";
import { applyResourceAccessPolicy } from "aws-studio/cdk/framework-resource-access";
import { applyResourceAccess, linkResource } from "aws-studio/cdk/framework-resources";

function setup() {
  const stack = new cdk.Stack(new cdk.App(), "Access", { env: { account: "111111111111", region: "us-east-1" } });
  const role = new iam.Role(stack, "Caller", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  const resources = defineStacks({ target: nativeResource<unknown>() });
  const binding = (actions: readonly ResourceAccessAction[], limits?: { objectPrefix?: string; requireHttps?: boolean }) => resourceAccess(resources.target, { actions, limits });
  return { stack, role, resources, binding };
}
const actionsOf = (statements: readonly iam.PolicyStatement[]) => statements.flatMap(statement => statement.actions);

test("S3 write excludes delete/ACL/admin and scopes read/list/TLS before attachment", () => {
  const { stack, role, binding } = setup();
  const bucket = new s3.Bucket(stack, "Files");
  const statements = applyResourceAccessPolicy(bucket, role, binding(["read", "write"], { objectPrefix: "uploads/", requireHttps: true }), "reader");
  const actions = actionsOf(statements);
  assert.ok(actions.includes("s3:PutObject"));
  assert.ok(!actions.some(action => /Delete|Acl|Policy|CreateBucket|s3:\*/.test(action)));
  assert.equal(statements[0]!.resources[0], bucket.arnForObjects("uploads/*"));
  const listing = statements.find(statement => statement.actions.includes("s3:ListBucket"))!.toStatementJson();
  assert.deepEqual(listing.Condition, { Bool: { "aws:SecureTransport": "true" }, StringLike: { "s3:prefix": "uploads/*" } });
  assert.ok(statements.every(statement => statement.toStatementJson().Condition.Bool["aws:SecureTransport"] === "true"));
  Template.fromStack(stack);
});

test("S3 KMS support and unrelated native grants are preserved independently", () => {
  const { stack, role, binding } = setup();
  const key = new kms.Key(stack, "Key");
  const bucket = new s3.Bucket(stack, "Files", { encryptionKey: key });
  const legacy = bucket.grantRead(role).principalStatements.map(statement => statement.toStatementJson());
  const statements = applyResourceAccessPolicy(bucket, role, binding(["write", "delete"], { requireHttps: true }), "writer");
  assert.ok(actionsOf(statements).includes("s3:DeleteObject"));
  assert.ok(actionsOf(statements).includes("kms:GenerateDataKey*"));
  assert.ok(statements.filter(statement => statement.actions.some(action => action.startsWith("kms:"))).every(statement => !statement.toStatementJson().Condition?.Bool?.["aws:SecureTransport"]));
  const template = Template.fromStack(stack).toJSON();
  const all = Object.values(template.Resources).filter((item: any) => item.Type === "AWS::IAM::Policy").flatMap((item: any) => item.Properties.PolicyDocument.Statement);
  assert.ok(all.some((statement: any) => !statement.Condition && JSON.stringify(statement.Action).includes("s3:GetObject")));
  assert.ok(legacy.every(statement => !statement.Condition));
});

test("DynamoDB independently selects writes/deletes and permits batch writes only together", () => {
  for (const actions of [["write"], ["delete"], ["write", "delete"], ["read"]] as const) {
    const { stack, role, binding } = setup();
    const table = new dynamodb.TableV2(stack, "Records", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING } });
    const statements = applyResourceAccessPolicy(table, role, binding(actions), "reader");
    const policyActions = actionsOf(statements);
    assert.equal(policyActions.includes("dynamodb:DeleteItem"), actions.some(action => action === "delete"));
    assert.equal(policyActions.includes("dynamodb:PutItem"), actions.some(action => action === "write"));
    assert.equal(policyActions.includes("dynamodb:BatchWriteItem"), actions.length === 2);
    assert.ok(!policyActions.includes("dynamodb:*"));
    if (actions[0] === "read") assert.ok(statements.some(statement => statement.resources.includes(`${table.tableArn}/index/*`) && statement.actions.includes("dynamodb:Query")));
    Template.fromStack(stack);
  }
});

test("queue receiving does not delete, and other native runtime adapters retain native grants", () => {
  const { stack, role, binding } = setup();
  const queue = new sqs.Queue(stack, "Messages");
  const receive = applyResourceAccessPolicy(queue, role, binding(["receive"]), "consumer");
  assert.ok(actionsOf(receive).includes("sqs:ReceiveMessage"));
  assert.ok(!actionsOf(receive).includes("sqs:DeleteMessage"));
  for (const [native, actions, expected] of [
    [new sns.Topic(stack, "Topic"), ["publish"], "sns:Publish"],
    [new events.EventBus(stack, "Bus"), ["publish"], "events:PutEvents"],
    [new lambda.Function(stack, "Worker", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=async()=>({});") }), ["invoke"], "lambda:InvokeFunction"],
  ] as const) assert.ok(actionsOf(applyResourceAccessPolicy(native, role, binding(actions), "caller")).includes(expected));
  assert.throws(() => applyResourceAccessPolicy(queue, role, binding(["read"]), "caller"), /sqs actions/);
  assert.throws(() => applyResourceAccessPolicy(queue, role, binding(["send"], { requireHttps: true }), "caller"), /limits/);
  assert.throws(() => applyResourceAccessPolicy(stack, role, binding(["read"]), "caller"), /adapter/);
  Template.fromStack(stack);
});

test("encrypted table and queue grants retain their supporting key permissions", () => {
  const { stack, role, binding } = setup();
  const key = new kms.Key(stack, "Key");
  const table = new dynamodb.Table(stack, "Records", { partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING }, encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: key });
  const write = actionsOf(applyResourceAccessPolicy(table, role, binding(["write"]), "writer"));
  assert.ok(write.includes("kms:GenerateDataKey*"));
  assert.ok(write.includes("kms:Decrypt"));
  assert.ok(!write.includes("dynamodb:DeleteItem"));
  assert.ok(!write.includes("dynamodb:BatchWriteItem"));
  const queue = new sqs.Queue(stack, "Queue", { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: key });
  const receive = actionsOf(applyResourceAccessPolicy(queue, role, binding(["receive"]), "consumer"));
  assert.ok(receive.includes("kms:Decrypt"));
  assert.ok(!receive.some(action => action.startsWith("kms:Generate")));
  const send = actionsOf(applyResourceAccessPolicy(queue, role, binding(["send"]), "producer"));
  assert.ok(send.includes("kms:GenerateDataKey*"));
  assert.ok(send.includes("kms:Decrypt"));
  Template.fromStack(stack);
});

test("registered native resources resolve across stacks without changing construct identity", () => {
  const app = new cdk.App();
  const owner = new cdk.Stack(app, "Owner");
  const consumer = new cdk.Stack(app, "Consumer");
  const resources = defineStacks({ files: nativeResource<s3.IBucket>() });
  const bucket = new s3.Bucket(owner, "Files");
  const logicalId = owner.getLogicalId(bucket.node.defaultChild as cdk.CfnElement);
  const role = new iam.Role(consumer, "Caller", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") });
  linkResource(owner, resources.files, bucket);
  applyResourceAccess(consumer, role, resourceAccess(resources.files, { actions: ["write"] }), "caller");
  const template = Template.fromStack(consumer).findResources("AWS::IAM::Policy");
  assert.ok(JSON.stringify(template).includes("Fn::ImportValue"));
  assert.ok(JSON.stringify(template).includes("s3:PutObject"));
  assert.ok(!JSON.stringify(template).includes("s3:Delete"));
  assert.ok(Object.hasOwn(Template.fromStack(owner).findResources("AWS::S3::Bucket"), logicalId));
});

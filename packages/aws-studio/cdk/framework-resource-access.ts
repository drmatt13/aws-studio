import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type * as sns from "aws-cdk-lib/aws-sns";
import type * as events from "aws-cdk-lib/aws-events";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { RESOURCE_ACCESS_DEFINITIONS, normalizeResourceAccess, type ResourceAccessBinding } from "aws-studio/config";

/** Native imports and owned constructs share these public CDK interfaces. */
const SHAPES = {
  s3: ["bucketArn", "bucketName", "arnForObjects", "grantRead"],
  dynamodb: ["tableArn", "tableName", "grantReadData", "grantWriteData"],
  sqs: ["queueArn", "queueUrl", "grantSendMessages", "grantConsumeMessages"],
  sns: ["topicArn", "topicName", "grantPublish"],
  eventbridge: ["eventBusArn", "eventBusName", "grantPutEventsTo"],
  lambda: ["functionArn", "functionName", "grantInvoke"],
} as const;

/** Complete statements are attached once. Existing native grants are never rewritten. */
export function applyResourceAccessPolicy(resource: unknown, grantee: iam.IGrantable, binding: ResourceAccessBinding, origin: string): readonly iam.PolicyStatement[] {
  if (!Construct.isConstruct(resource)) throw new Error(`${origin}: resourceAccess requires a native CDK construct.`);
  const value = resource as unknown as Record<string, unknown>;
  const definitions = RESOURCE_ACCESS_DEFINITIONS.filter(definition => SHAPES[definition.id].every(key => key.startsWith("grant") || key === "arnForObjects" ? typeof value[key] === "function" : typeof value[key] === "string"));
  if (definitions.length !== 1) throw new Error(`${origin}: this native resource has no unambiguous supported access adapter.`);
  const definition = definitions[0]!;
  const options = normalizeResourceAccess({ actions: binding.actions, limits: binding.limits }, definition);
  const actions = new Set(options.actions);
  const statements: iam.PolicyStatement[] = [];
  const add = (props: iam.PolicyStatementProps) => {
    const statement = new iam.PolicyStatement(props);
    if (!grantee.grantPrincipal.addToPrincipalPolicy(statement).statementAdded) throw new Error(`${origin}: the principal cannot accept resource access policies. Configure its native grant in source.`);
    statements.push(statement);
  };
  const native = (grant: iam.Grant) => { grant.assertSuccess(); statements.push(...grant.principalStatements); };
  switch (definition.id) {
    case "s3": {
      const bucket = resource as s3.IBucket;
      const prefix = options.limits?.objectPrefix ?? "";
      const conditions = options.limits?.requireHttps ? { Bool: { "aws:SecureTransport": "true" } } : undefined;
      add({ actions: [
        ...(actions.has("read") ? ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAttributes", "s3:GetObjectVersionAttributes", "s3:GetObjectTagging", "s3:GetObjectVersionTagging"] : []),
        ...(actions.has("write") ? ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"] : []),
        ...(actions.has("delete") ? ["s3:DeleteObject", "s3:DeleteObjectVersion"] : []),
      ], resources: [bucket.arnForObjects(`${prefix}*`)], conditions });
      if (actions.has("read")) {
        add({ actions: ["s3:ListBucket", "s3:ListBucketVersions"], resources: [bucket.bucketArn], conditions: { ...conditions, ...(prefix ? { StringLike: { "s3:prefix": `${prefix}*` } } : {}) } });
        add({ actions: ["s3:GetBucketLocation"], resources: [bucket.bucketArn], conditions });
      }
      // S3 conditions do not belong on service-mediated KMS requests.
      if (actions.has("write") && bucket.encryptionKey) native(bucket.encryptionKey.grantEncryptDecrypt(grantee));
      else if (actions.has("read") && bucket.encryptionKey) native(bucket.encryptionKey.grantDecrypt(grantee));
      break;
    }
    case "dynamodb": {
      const table = resource as dynamodb.ITable;
      add({ actions: ["dynamodb:DescribeTable",
        ...(actions.has("read") ? ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"] : []),
        ...(actions.has("write") ? ["dynamodb:PutItem", "dynamodb:UpdateItem"] : []),
        ...(actions.has("delete") ? ["dynamodb:DeleteItem"] : []),
        ...(actions.has("write") && actions.has("delete") ? ["dynamodb:BatchWriteItem"] : []),
      ], resources: [table.tableArn] });
      if (actions.has("read")) add({ actions: ["dynamodb:Query", "dynamodb:Scan"], resources: [`${table.tableArn}/index/*`] });
      if ((actions.has("write") || actions.has("delete")) && table.encryptionKey) native(table.encryptionKey.grantEncryptDecrypt(grantee));
      else if (actions.has("read") && table.encryptionKey) native(table.encryptionKey.grantDecrypt(grantee));
      break;
    }
    case "sqs": {
      const queue = resource as sqs.IQueue;
      add({ actions: ["sqs:GetQueueUrl", "sqs:GetQueueAttributes",
        ...(actions.has("send") ? ["sqs:SendMessage"] : []),
        ...(actions.has("receive") ? ["sqs:ReceiveMessage", "sqs:ChangeMessageVisibility"] : []),
        ...(actions.has("delete") ? ["sqs:DeleteMessage"] : []),
      ], resources: [queue.queueArn] });
      if (actions.has("send") && queue.encryptionMasterKey) native(queue.encryptionMasterKey.grantEncryptDecrypt(grantee));
      else if (actions.has("receive") && queue.encryptionMasterKey) native(queue.encryptionMasterKey.grantDecrypt(grantee));
      break;
    }
    case "sns": native((resource as sns.ITopic).grantPublish(grantee)); break;
    case "eventbridge": native((resource as events.IEventBus).grantPutEventsTo(grantee)); break;
    case "lambda": native((resource as lambda.IFunction).grantInvoke(grantee)); break;
  }
  return statements;
}

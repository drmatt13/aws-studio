import { applicationVpc as fixtureVpc, defaults } from "./support/declarations";
import assert from "node:assert/strict";
import test from "node:test";
import { App, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, defineInputs, defineStacks, input as authoredInput, stack as nativeStack, cdk as nativeResource, getFrameworkTargets, isResourceValueReference, resolveResourceReference, type FrameworkConfig, type ResourceReference } from "aws-studio/config";
import { initializeFrameworkResources, linkResources, finalizeFrameworkResources } from "aws-studio/cdk/framework-resources";
import { attachLambdaResources } from "aws-studio/cdk/framework-cloud";


/**
 * A stack whose public fields are its resource catalog.
 *
 * `hidden` is private, so it never reaches the catalog: `keyof` does not offer
 * it. `plain` is a string rather than a construct and is a resource all the
 * same — a stack answers for its computed values too — and `hiddenTopicArn`
 * shows the same for an accessor, which is how a private construct publishes
 * one attribute without publishing itself.
 */
class ExampleStack extends Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly processingQueue: sqs.Queue;
  public readonly plain = "not-a-construct";
  private readonly hidden: sns.Topic;

  constructor(scope: Construct, id: string) {
    super(scope, id, { env: { account: "111122223333", region: "eu-west-2" } });
    this.documentsBucket = new s3.Bucket(this, "Documents");
    this.processingQueue = new sqs.Queue(this, "Processing");
    this.hidden = new sns.Topic(this, "Hidden");
    linkResources(this, catalog.referenceExamples);
  }

  public get hiddenTopicArn(): string {
    return this.hidden.topicArn;
  }
}

const catalogInputs = defineInputs({ apiKey: authoredInput.secret() });
const catalogStacks = defineStacks({ referenceExamples: nativeStack<ExampleStack>() });
const catalog = { ...catalogInputs, ...catalogStacks };

function config(): FrameworkConfig {
  return defineFrameworkConfig({ networks: [fixtureVpc],
    inputs: catalogInputs, stacks: catalogStacks, defaults, http: [{ "/work": {
      directory: "compute/http/work", methods: ["POST"], auth: true,
      environment: {
        DOCUMENTS_BUCKET: catalog.referenceExamples.documentsBucket.bucketName,
        QUEUE_URL: catalog.referenceExamples.processingQueue.queueUrl,
      },
      cloud: { bindings: [catalog.referenceExamples.documentsBucket.grantRead("uploads/*")] },
    } }], webSocket: [], services: [], events: [], tasks: [], workflows: [],
  } as never);
}

function setup(configuration = config()) {
  const app = new App();
  initializeFrameworkResources(app, { config: configuration, mode: "dev", deployment: "example", readers: { env: {} } });
  return app;
}

test("standalone metadata never turns Cognito stack members into authored values", () => {
  class IdentityStack extends Stack {
    public readonly userPool: cognito.UserPool;
    public readonly userPoolClient: cognito.UserPoolClient;
    public readonly userPoolDomainUrl = "https://identity.example.com";
    constructor(scope: Construct, id: string) {
      super(scope, id, { env: { account: "111122223333", region: "eu-west-2" } });
      this.userPool = new cognito.UserPool(this, "UserPool");
      this.userPoolClient = new cognito.UserPoolClient(this, "Client", { userPool: this.userPool });
      linkResources(this, resources.identity);
    }
  }
  const resourcesInputs = defineInputs({ enabled: authoredInput.value("true") });
  const resourcesStacks = defineStacks({ identity: nativeStack<IdentityStack>() });
  const resources = { ...resourcesInputs, ...resourcesStacks };
  assert.equal((resources.identity.userPool as unknown as ResourceReference).authoredValue, undefined);
  assert.equal((resources.identity.userPoolClient as unknown as ResourceReference).authoredValue, undefined);
  assert.equal(resources.identity.userPoolDomainUrl.authoredValue, undefined);
  assert.equal(isResourceValueReference(resources.identity.userPool), false);
  assert.equal(isResourceValueReference(resources.identity.userPoolDomainUrl), false);
  assert.equal(isResourceValueReference(resources.enabled), true);
  assert.equal(resolveResourceReference(resources.identity.userPoolDomainUrl, () => "linked-domain", "fixture"), "linked-domain");
  const configuration = defineFrameworkConfig({ inputs: resourcesInputs, stacks: resourcesStacks, defaults, http: [{ "/identity": {
    directory: "compute/http/identity", methods: ["POST"], auth: false,
    environment: { POOL: resources.identity.userPool.userPoolId, CLIENT: resources.identity.userPoolClient.userPoolClientId,
      DOMAIN: resources.identity.userPoolDomainUrl, ENABLED: resources.enabled },
  } }], webSocket: [], services: [], events: [], tasks: [], workflows: [] } as never);
  const app = new App();
  initializeFrameworkResources(app, { config: configuration, mode: "dev", deployment: "example", readers: { env: {} } });
  const owner = new IdentityStack(app, "Identity");
  const consumer = new Stack(app, "Consumer", { env: { account: "111122223333", region: "eu-west-2" } });
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};" ) });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0], { config: configuration, mode: "dev" });
  finalizeFrameworkResources(app);
  Template.fromStack(owner).resourceCountIs("AWS::Cognito::UserPool", 1);
  const text = JSON.stringify(Template.fromStack(consumer).toJSON());
  assert.match(text, /Fn::ImportValue/);
  assert.match(text, /"DOMAIN":"https:\/\/identity.example.com"/);
  assert.match(text, /"ENABLED":"true"/);
});

test("a stack's public constructs become the catalog, and reach a workload in another stack", () => {
  const configuration = config();
  const app = setup(configuration);
  const owner = new ExampleStack(app, "Owner");
  const consumer = new Stack(app, "Consumer", { env: { account: "111122223333", region: "eu-west-2" } });
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};") });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0]!, { config: configuration, mode: "dev" });
  finalizeFrameworkResources(app);

  const text = JSON.stringify(Template.fromStack(consumer).toJSON());
  // The bucket name arrives as a cross-stack import, not a hardcoded string.
  assert.match(text, /Fn::ImportValue/);
  assert.match(text, /DOCUMENTS_BUCKET/);
  assert.match(text, /QUEUE_URL/);
  // The grant travelled with the reference, scoped to the prefix it was given.
  assert.match(text, /s3:GetObject/);
  assert.match(text, /uploads\/\*/);
  // Delivering a queue URL is not permission to use the queue.
  assert.doesNotMatch(text, /sqs:SendMessage|sqs:ReceiveMessage/);
  // Exactly the two members a workload asked for are published for local dev,
  // and the private topic is not among them.
  const outputs = Object.values(Template.fromStack(owner).toJSON().Outputs as Record<string, { Description?: string }>)
    .map((output) => output.Description ?? "")
    .filter((description) => description.startsWith("framework:resource:v1:"));
  assert.deepEqual(outputs.sort(), [
    'framework:resource:v1:[["referenceExamples","documentsBucket"],"bucketName"]',
    'framework:resource:v1:[["referenceExamples","processingQueue"],"queueUrl"]',
  ]);
  assert.ok(owner.hiddenTopicArn);
});

test("a reference into an undeclared stack is refused by the catalog", () => {
  const other = defineStacks({ referenceExamples: nativeStack<ExampleStack>() });
  assert.throws(
    () => defineFrameworkConfig({ networks: [fixtureVpc],
      inputs: defineInputs({ apiKey: authoredInput.secret() }), defaults,
      http: [{ "/work": { directory: "compute/http/work", methods: ["POST"], auth: true,
        environment: { BUCKET: other.referenceExamples.documentsBucket.bucketName } } }],
      webSocket: [], services: [], events: [], tasks: [], workflows: [],
    } as never),
    /not declared in this config's inputs or stacks catalogs/,
  );
});

test("a stack's group is refused a whole-resource link and an empty stack", () => {
  const app = setup();
  const empty = new Stack(app, "Empty", { env: { account: "111122223333", region: "eu-west-2" } });
  assert.throws(
    () => linkResources(empty as never, catalog.referenceExamples),
    /found nothing to link/,
  );
  assert.throws(
    () => linkResources(empty as never, catalog.apiKey as never),
    /takes a stack\(\) entry/,
  );
});

test("a stack cannot be declared inside a group", () => {
  assert.throws(
    () => defineStacks({ nested: { inner: nativeStack<ExampleStack>() } }),
    /declares a stack inside a group/,
  );
});

test("a stack member nobody linked names the stack and linkResources, not the escape hatch", () => {
  const configuration = config();
  const app = setup(configuration);
  // The owning stack is never constructed: the commonest way to get here.
  const consumer = new Stack(app, "Consumer", { env: { account: "111122223333", region: "eu-west-2" } });
  const fn = new lambda.Function(consumer, "Work", { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler = () => {};") });
  attachLambdaResources(consumer, fn, getFrameworkTargets(configuration)[0]!, { config: configuration, mode: "dev" });
  assert.throws(
    () => finalizeFrameworkResources(app),
    (error: Error) => {
      assert.match(error.message, /stacks\.referenceExamples\.documentsBucket.* is not linked/);
      assert.match(error.message, /linkResources\(this, stacks\.referenceExamples\)/);
      assert.doesNotMatch(error.message, /linkResource\(scope/);
      return true;
    },
  );
});

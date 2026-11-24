import assert from "node:assert/strict";
import { test, mock } from "node:test";
import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Template } from "aws-cdk-lib/assertions";
import { defineFrameworkConfig, defineNetwork, definePrivateHostedZone, getFrameworkTargets } from "aws-studio/config";
import { initializeFrameworkResources, finalizeFrameworkResources } from "aws-studio/cdk/framework-resources";
import { lambdaPlacement } from "aws-studio/cdk/framework-network";
import { EcsServicesStack } from "aws-studio/cdk/ecs-services-stack";
import { EcsTasksStack } from "aws-studio/cdk/ecs-tasks-stack";
import { HttpApiGatewayStack } from "aws-studio/cdk/http-api-gateway-stack";
import { PrivateHostedZoneStack, assertPrivateDnsDeployment } from "aws-studio/cdk/private-hosted-zones";
import { createFrameworkWorkloads } from "aws-studio/cdk/framework-composition";

const env = { account: "111122223333", region: "us-east-1" };
const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } } } as const;
const a = defineNetwork({ id: "a", cidr: "10.31.0.0/16", zones: 2 });
const b = defineNetwork({ id: "b", cidr: "10.32.0.0/16", zones: 2 });
const app = () => new cdk.App({ context: { "availability-zones:account=111122223333:region=us-east-1": ["us-east-1a", "us-east-1b"] } });
function authentication(application: cdk.App) {
  const scope = new cdk.Stack(application, "Authentication", { env });
  const userPool = new cognito.UserPool(scope, "Pool");
  return { userPool, userPoolClient: userPool.addClient("Client") };
}

test("owned private zones synthesize multi-VPC aliases and individual ingress grants without stack cycles or shared-SG admission", () => {
  // Image construction is outside this infrastructure test. All actual VPC,
  // service, listener, group, route, association and alias constructs are real.
  const image = ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/node:24");
  const serviceImage = mock.method(EcsServicesStack.prototype as unknown as { serviceImage(): ecs.ContainerImage }, "serviceImage", () => image);
  const taskImage = mock.method(EcsTasksStack.prototype as unknown as { taskImage(): ecs.ContainerImage }, "taskImage", () => image);
  try {
    const zone = definePrivateHostedZone({ id: "shared", name: "internal.parity.test", vpcs: [a, b], records: [{ id: "api", name: "api", type: "A", target: { kind: "ecs-internal-alb", service: "example-service" }, allowFrom: ["lambda:caller", "task:invocation-test-task"] }] });
    const config = defineFrameworkConfig({ defaults, networks: [a, b], privateHostedZones: [zone], http: [], webSocket: [],
      events: [{ caller: { vpc: a, localReplay: true }, denied: { vpc: a, localReplay: true } }],
      services: [{ "/orders/*": { directory: "compute/services/example-service", methods: ["GET"], port: 5000, cloud: { vpc: a, constructId: "ExampleService" } } }],
      tasks: [{ "invocation-test-task": { cloud: { vpc: a, constructId: "InvocationTask" } } }],
    });
    assertPrivateDnsDeployment(config);
    const application = app();
    initializeFrameworkResources(application, { config, mode: "prod", deployment: "fixture", readers: { env: {} } });
    const normalized = getFrameworkTargets(config);
    const callers = new cdk.Stack(application, "Callers", { env });
    for (const id of ["caller", "denied"]) {
      const target = normalized.find(target => target.reference === `lambda:${id}`)!;
      new lambda.Function(callers, id, { runtime: lambda.Runtime.NODEJS_24_X, handler: "index.handler", code: lambda.Code.fromInline("exports.handler=async()=>({ok:true});"), ...lambdaPlacement(callers, target) });
    }
    const services = new EcsServicesStack(application, "Services", { env, config, cloud: { mode: "prod" } });
    const tasks = new EcsTasksStack(application, "Tasks", { env, config, cloud: { mode: "prod" } });
    new HttpApiGatewayStack(application, "Api", { env, config, targets: services.targets, frontendUrls: [], cognito: authentication(application) });
    const dns = new PrivateHostedZoneStack(application, "PrivateDns", { env, declaration: zone, targets: services.targets });
    finalizeFrameworkResources(application);
    assert.doesNotThrow(() => application.synth(), "network → endpoints → DNS has no dependency cycle");
    const template = Template.fromStack(dns);
    const hosted = Object.values(template.findResources("AWS::Route53::HostedZone"))[0]!;
    assert.equal(hosted.Properties.Name.replace(/\.$/, ""), zone.name);
    assert.equal(hosted.Properties.VPCs.length, 2);
    assert.notEqual(JSON.stringify(hosted.Properties.VPCs[0]), JSON.stringify(hosted.Properties.VPCs[1]));
    assert.equal(hosted.DeletionPolicy, "Delete");
    const alias = Object.values(template.findResources("AWS::Route53::RecordSet"))[0]!;
    assert.equal(alias.Properties.Type, "A");
    assert.equal(alias.Properties.Name, "api.internal.parity.test.");
    assert.equal(alias.Properties.AliasTarget.EvaluateTargetHealth, false);
    assert.equal(alias.Properties.TTL, undefined);
    const functions = Template.fromStack(callers).findResources("AWS::Lambda::Function");
    const granted = Object.entries(functions).find(([id]) => id.startsWith("caller"))![1].Properties.VpcConfig.SecurityGroupIds;
    const denied = Object.entries(functions).find(([id]) => id.startsWith("denied"))![1].Properties.VpcConfig.SecurityGroupIds;
    assert.equal(granted.length, 2);
    assert.equal(denied.length, 1);
    assert.equal(JSON.stringify(granted[0]), JSON.stringify(denied[0]), "ordinary Lambdas retain their shared group");
    assert.equal(tasks.targets.requireTask("task:invocation-test-task").launch.securityGroups.length, 2, "a task retains its original outbound group plus the new identity group");
    const serviceTemplate = Template.fromStack(services);
    const ingress = [...Object.values(serviceTemplate.findResources("AWS::EC2::SecurityGroup")).flatMap(resource => resource.Properties.SecurityGroupIngress ?? []), ...Object.values(serviceTemplate.findResources("AWS::EC2::SecurityGroupIngress")).map(resource => resource.Properties)];
    const http = ingress.filter(rule => rule.FromPort === 80);
    assert.equal(http.length, 3, "API link, individual Lambda and individual task grants");
    assert.ok(http.every(rule => rule.SourceSecurityGroupId && !rule.CidrIp && !rule.CidrIpv6), "no broad listener ingress grants DNS visibility network access");
    assert.ok(!JSON.stringify(http).includes("VpcLambdas"), "the ordinary shared Lambda group is never admitted");
  } finally { serviceImage.mock.restore(); taskImage.mock.restore(); }
});

test("development synthesizes no private AWS DNS or VPC, while an enabled empty zone builds its production VPC", () => {
  const zone = definePrivateHostedZone({ id: "empty", name: "private.parity.test", vpcs: [a] });
  for (const mode of ["dev", "prod"] as const) {
    const config = defineFrameworkConfig({ defaults, networks: [a], privateHostedZones: [zone], http: [], webSocket: [], events: [], services: [] });
    const application = app();
    initializeFrameworkResources(application, { config, mode, deployment: "fixture", readers: { env: {} } });
    createFrameworkWorkloads(application, { env, config, cloud: { mode }, stackId: id => `fixture-${id}`, frontendUrls: [], cognito: authentication(application) });
    finalizeFrameworkResources(application);
    const assembly = application.synth();
    const resources = assembly.stacks.flatMap(stack => Object.values(stack.template.Resources ?? {}) as { Type: string }[]);
    assert.equal(resources.filter(resource => resource.Type === "AWS::Route53::HostedZone").length, mode === "prod" ? 1 : 0);
    assert.equal(resources.filter(resource => resource.Type === "AWS::EC2::VPC").length, mode === "prod" ? 1 : 0);
  }
});

test("production refuses an alias whose service is local-only rather than silently omitting the record", () => {
  const zone = definePrivateHostedZone({ id: "blocked", name: "private.parity.test", vpcs: [a], records: [{ id: "api", name: "api", type: "A", target: { kind: "ecs-internal-alb", service: "example-service" } }] });
  const config = defineFrameworkConfig({ defaults, networks: [a], privateHostedZones: [zone], http: [], webSocket: [], events: [], services: [{ "/orders/*": { directory: "compute/services/example-service", methods: ["GET"], deploy: "local-only", cloud: { vpc: a } } }] });
  assert.throws(() => assertPrivateDnsDeployment(config), /not deployed.*Disable the record/);
});

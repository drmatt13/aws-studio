import { applicationVpc as fixtureVpc, defaults } from "./support/declarations";
import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { defineFrameworkConfig, defineInputs, defineStacks, input as authoredInput, stack as nativeStack, cdk as nativeResource, deployInputsFrom, type CloudMode, type DeployInputs, type FrameworkConfig } from "aws-studio/config";

import { createFrameworkWorkloads } from "aws-studio/cdk/framework-composition";
import { finalizeFrameworkResources, initializeFrameworkResources } from "aws-studio/cdk/framework-resources";

const env = { account: "111122223333", region: "us-east-1" };
const cognitoEnvironment = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };

const framework: FrameworkConfig = defineFrameworkConfig({ networks: [fixtureVpc],
  defaults,
  http: [{ "/verify-session": { directory: "compute/http/verify-session", methods: ["GET"] } }],
  webSocket: [{
    $connect: {
      directory: "compute/websocket/ws-connect-route",
      authorizer: { directory: "compute/websocket/ws-authorizer", environment: cognitoEnvironment },
    },
    $default: { directory: "compute/websocket/ws-default-route", cloud: { manageConnections: true } },
  }],
  events: [],
  services: [],
} as never);

const { resources: _derivedResources, ...frameworkInput } = framework;

function workloadsFor(mode: CloudMode, config: FrameworkConfig = framework, inputs?: DeployInputs) {
  const app = new cdk.App({ context: { "@aws-cdk/aws-lambda:useCdkManagedLogGroup": true } });
  initializeFrameworkResources(app, { config, mode, deployment: `example-${mode}`, readers: { env: {} } });
  const identity = new cdk.Stack(app, "Identity", { env });
  const userPool = new cognito.UserPool(identity, "Pool");
  const workloads = createFrameworkWorkloads(app, {
    env,
    stackId: (name) => `example-${mode}-${name}`,
    config,
    cloud: { mode, inputs },
    cognito: { userPool, userPoolClient: userPool.addClient("Client") },
    readers: { env: {} },
    frontendUrls: [],
  });
  finalizeFrameworkResources(app);
  return workloads;
}

const webSocketTargets = ["lambda:ws-connect-route", "lambda:ws-authorizer", "lambda:ws-default-route"] as const;

test("an HTTP notification publisher gets only its application's WebSocket management grant", () => {
  const config = defineFrameworkConfig({
    ...frameworkInput,
    http: [{ "/notify": {
      id: "notifications", directory: "compute/http/verify-session", methods: ["POST"],
      cloud: { manageConnections: true },
    } }],
  } as never);
  const workloads = workloadsFor("prod", config);
  const template = Template.fromStack(workloads.webSocketApi!);
  const policies = template.findResources("AWS::IAM::Policy");
  const publisher = Object.entries(policies).find(([id]) => id.startsWith("NotificationsManageConnectionsPolicy"));
  assert.ok(publisher, "the WebSocket stack owns the policy to avoid reverse stack dependencies");
  const statement = publisher[1].Properties.PolicyDocument.Statement[0];
  assert.equal(statement.Action, "execute-api:ManageConnections");
  assert.notEqual(statement.Resource, "*");
  assert.match(JSON.stringify(statement.Resource), /MyWebSocketAPI/);
  assert.match(JSON.stringify(statement.Resource), /prod/);
});

test("a dev deployment builds no WebSocket API or handlers: local-ws-dev-server runs them under Compose", () => {
  const workloads = workloadsFor("dev");
  assert.equal(workloads.webSocketApi, undefined);
  assert.equal(workloads.webSocketHandlers, undefined);
  assert.equal(workloads.httpHandlers, undefined);
  assert.equal(workloads.httpApi, undefined);
  for (const reference of webSocketTargets) assert.equal(workloads.targets.get(reference), undefined, `${reference} is not built`);
  assert.deepEqual(workloads.skippedTargets.conditionNotMet, []);
  assert.deepEqual([...workloads.skippedTargets.notInThisDeployment].sort(), ["lambda:verify-session", ...webSocketTargets].sort());
});

test("a prod deployment builds the WebSocket API, its handlers and their connection-management permission", () => {
  const workloads = workloadsFor("prod");
  assert.ok(workloads.webSocketApi && workloads.webSocketHandlers);
  for (const reference of webSocketTargets) assert.ok(workloads.targets.get(reference), `${reference} is built`);
  assert.deepEqual(workloads.skippedTargets.notInThisDeployment, []);

  const api = Template.fromStack(workloads.webSocketApi);
  api.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
  api.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
  api.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: [{ Action: "execute-api:ManageConnections", Effect: "Allow" }] },
  });
  assert.ok(Object.keys(api.findOutputs("WebSocketAPIEndpoint")).length === 1);
});

test("explicitly disabled WebSocket handlers build no gateway or orphan authorizer", () => {
  const config = defineFrameworkConfig({ ...frameworkInput, webSocket: [{
    $connect: { ...framework.webSocket.$connect, deploy: "none", authorizer: { ...framework.webSocket.$connect.authorizer!, deploy: "none" } },
    $default: { ...framework.webSocket.$default, deploy: "none" },
  }] } as never);
  for (const mode of ["dev", "prod"] as const) {
    const workloads = workloadsFor(mode, config);
    assert.equal(workloads.webSocketApi, undefined, mode);
    assert.equal(workloads.webSocketHandlers, undefined, mode);
    assert.equal(workloads.skippedTargets.disabled.length, 3, mode);
  }
});

test("a condition removes the WebSocket route, handler and connection-management permission together", () => {
  const resources = defineInputs({ realtime: authoredInput.fromEnv("REALTIME").enum("enabled", "disabled") });
  const config = defineFrameworkConfig({ ...frameworkInput, inputs: resources, webSocket: [{
    $connect: framework.webSocket.$connect,
    $default: { ...framework.webSocket.$default, deploy: { when: { resource: resources.realtime, equals: "enabled" } } },
  }] } as never);
  const workloads = workloadsFor("prod", config, deployInputsFrom({ env: { REALTIME: "disabled" } }));
  assert.ok(workloads.webSocketApi && workloads.webSocketHandlers);
  assert.equal(workloads.targets.get("lambda:ws-default-route"), undefined);
  assert.deepEqual(workloads.skippedTargets.conditionNotMet, ["lambda:ws-default-route"]);
  Template.fromStack(workloads.webSocketApi).resourceCountIs("AWS::ApiGatewayV2::Route", 1);
  Template.fromStack(workloads.webSocketApi).resourceCountIs("AWS::IAM::Policy", 0);
});

test("an enabled authorizer without an enabled route creates no orphan Lambda or API", () => {
  const config = defineFrameworkConfig({ ...frameworkInput, webSocket: [{
    $connect: { ...framework.webSocket.$connect, deploy: "none" },
    $default: { ...framework.webSocket.$default, deploy: "none" },
  }] } as never);
  const workloads = workloadsFor("prod", config);
  assert.equal(workloads.webSocketApi, undefined);
  assert.equal(workloads.webSocketHandlers, undefined);
  assert.ok(workloads.skippedTargets.notInThisDeployment.includes("lambda:ws-authorizer"));
});

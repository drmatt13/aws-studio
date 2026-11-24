import { testProjectRoot } from "./support/test-project";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { CLIENT_SECTION_HEADING, clientEnvironment, renderGeneratedBlock } from "../../cli/environment-export";
import { localClientEndpoints, localExportValues } from "../../cli/local-export";
import { collectProductionOutputs } from "../../cli/production-export";
import { type DeploymentStack } from "../../cli/resource-export";

const ports = {
  LOCAL_API_DEV_SERVER_HOST_PORT: "8080",
  LOCAL_WS_DEV_SERVER_HOST_PORT: "8081",
  LOCAL_INVOCATION_RUNNER_HOST_PORT: "8090",
  POSTGRES_HOST_PORT: "5432",
  PGADMIN_HOST_PORT: "5050",
};
const cognito = {
  region: "us-east-1",
  userPoolId: "us-east-1_pool",
  userPoolClientId: "client",
  cognitoDomainUrl: "https://example.auth.us-east-1.amazoncognito.com",
  signInProviders: "google,meta",
};
test("Compose export follows the app name instead of authored or previously exported names", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "app-name-export-"));
  try {
    mkdirSync(path.join(root, "cdk-app"));
    writeFileSync(path.join(root, ".env"), "COMPOSE_PROJECT_NAME=old-export\n");
    for (const name of ["example-app", "renamed-app"]) {
      writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:app": name } }));
      const values = localExportValues({ ...ports, COMPOSE_PROJECT_NAME: "old-authored-name" }, { repositoryRoot: root });
      assert.equal(values.get("COMPOSE_PROJECT_NAME"), name);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
function devClient(authored: Record<string, string>, apiGatewayWebSocketUrl = "") {
  const values = localExportValues({ ...ports, ...authored }, { repositoryRoot: testProjectRoot });
  return clientEnvironment({ ...cognito, ...localClientEndpoints(values), apiGatewayWebSocketUrl });
}

test("declared client port defaults supply blank or missing overrides consistently with Compose exports", () => {
  for (const blank of [false, true]) {
    const authored: Record<string, string> = { ...ports };
    for (const name of ["LOCAL_API_DEV_SERVER_HOST_PORT", "LOCAL_WS_DEV_SERVER_HOST_PORT"]) {
      if (blank) authored[name] = "";
      else delete authored[name];
    }
    const values = localExportValues(authored, { repositoryRoot: testProjectRoot });
    assert.deepEqual(localClientEndpoints(values), { apiUrl: "http://localhost:8080", localWebSocketUrl: "ws://localhost:8081", studioUrl: "http://127.0.0.1:4590" });
  }
  assert.equal(localExportValues({ ...ports, LOCAL_API_DEV_SERVER_HOST_PORT: "9080" }, { repositoryRoot: testProjectRoot }).get("LOCAL_API_DEV_SERVER_HOST_PORT"), "9080");
  assert.throws(() => localExportValues({ ...ports, LOCAL_API_DEV_SERVER_HOST_PORT: "", POSTGRES_HOST_PORT: "8080" }, { repositoryRoot: testProjectRoot }), /Two Compose services/, "defaulted ports still participate in collision checks");
  const { PGADMIN_HOST_PORT: _port, ...missing } = ports;
  assert.throws(() => localExportValues(missing, { repositoryRoot: testProjectRoot }), /PGADMIN_HOST_PORT.*no input default/, "ports without a catalog default stay explicit");
});

test("development client endpoints follow the authored host ports and what the deployment holds", () => {
  // Compose runs local-ws-dev-server whatever DEPLOY_PROD_WEBSOCKET_API says; the
  // flag only decides whether AWS holds a WebSocket API, which export reads.
  for (const flag of [{}, { DEPLOY_PROD_WEBSOCKET_API: "false" }, { DEPLOY_PROD_WEBSOCKET_API: "true" }] as Record<string, string>[]) {
    const client = devClient(flag);
    assert.equal(client.VITE_LOCAL_WS_URL, "ws://localhost:8081", JSON.stringify(flag));
    assert.equal(client.VITE_API_GATEWAY_WS_URL, "", JSON.stringify(flag));
    assert.equal(client.VITE_STUDIO_URL, "http://127.0.0.1:4590");
  }
  const both = devClient({ LOCAL_WS_DEV_SERVER_HOST_PORT: "9081", STUDIO_URL: "http://localhost:4690" }, "wss://abc.execute-api.us-east-1.amazonaws.com/prod");
  assert.equal(both.VITE_LOCAL_WS_URL, "ws://localhost:9081");
  assert.equal(both.VITE_API_GATEWAY_WS_URL, "wss://abc.execute-api.us-east-1.amazonaws.com/prod");
  assert.equal(both.VITE_STUDIO_URL, "http://localhost:4690");
  assert.equal(both.VITE_API_GATEWAY_URL, "http://localhost:8080");
  assert.equal(devClient({ VITE_API_GATEWAY_URL: "http://192.168.1.5:8080", LOCAL_API_DEV_SERVER_HOST_PORT: "9080" }).VITE_API_GATEWAY_URL, "http://localhost:9080", "the generated local URL follows the port, not an authored VITE value");
  assert.equal(localExportValues(ports, { repositoryRoot: testProjectRoot }).has("VITE_API_GATEWAY_URL"), false, "the proxy target belongs to the client-app block only");
});

test("local browser trust includes the configured Studio origin and its loopback alias", () => {
  assert.equal(localExportValues({ ...ports, LOCAL_DEV_URL: "" }, { repositoryRoot: testProjectRoot }).get("LOCAL_BROWSER_ORIGINS")!.split(",")[0], "http://localhost:3000", "blank frontend URLs use the same default as Vite and Studio");
  for (const STUDIO_URL of [undefined, ""]) {
    const authored = STUDIO_URL === undefined ? ports : { ...ports, STUDIO_URL };
    const values = localExportValues(authored, { repositoryRoot: testProjectRoot });
    assert.equal(values.get("STUDIO_URL"), "http://127.0.0.1:4590");
    assert.deepEqual(new Set(values.get("LOCAL_BROWSER_ORIGINS")!.split(",")), new Set([
      "http://localhost:3000", "http://127.0.0.1:4590", "http://localhost:4590",
    ]));
  }
  for (const STUDIO_URL of ["http://localhost:4690", "http://127.0.0.1:4690"]) {
    const values = localExportValues({ ...ports, STUDIO_URL, LOCAL_DEV_URL: "http://192.168.1.20:3100/" }, { repositoryRoot: testProjectRoot });
    assert.equal(values.get("STUDIO_URL"), STUDIO_URL);
    assert.deepEqual(new Set(values.get("LOCAL_BROWSER_ORIGINS")!.split(",")), new Set([
      "http://192.168.1.20:3100", "http://localhost:4690", "http://127.0.0.1:4690",
    ]), "only Studio receives loopback aliases, and only on its configured port");
  }
});

test("local browser trust refuses invalid Studio URLs and authored origin allowlists", () => {
  for (const STUDIO_URL of ["not-a-url", "ws://localhost:4590", "https://localhost:4590", "http://example.com:4590", "http://192.168.1.20:4590", "http://[::1]:4690", "http://localhost:4590/websockets", "http://localhost:4590?other=1", "http://localhost:4590#websockets", "http://user:password@localhost:4590"]) {
    assert.throws(() => localExportValues({ ...ports, STUDIO_URL }, { repositoryRoot: testProjectRoot }), /STUDIO_URL/, STUDIO_URL);
  }
  assert.throws(() => localExportValues({ ...ports, LOCAL_BROWSER_ORIGINS: "http://arbitrary.example" }, { repositoryRoot: testProjectRoot }), /LOCAL_BROWSER_ORIGINS.*no longer read/);
});

test("development and production write the same client-app names in the same order", () => {
  const stack = (suffix: string, values: Record<string, string>): DeploymentStack => ({
    StackName: `example-${suffix}`,
    StackId: `arn:aws:cloudformation:us-east-1:111122223333:stack/example-${suffix}/id`,
    StackStatus: "UPDATE_COMPLETE",
    Outputs: [
      { Description: "framework:deployment:v1", OutputValue: JSON.stringify({ version: 1, deployment: "example", mode: "prod", account: "111122223333", region: "us-east-1" }) },
      ...Object.entries(values).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })),
    ],
  });
  const production = collectProductionOutputs([
    stack("CognitoStack", { UserPoolId: "pool", UserPoolClientId: "client", UserPoolDomainUrl: cognito.cognitoDomainUrl, SignInProviders: "google,meta" }),
    stack("FrontendWebsiteS3Stack", { FrontendWebsiteBucketName: "bucket", CloudFrontUrl: "https://example.cloudfront.net", CloudFrontId: "distribution" }),
  ], "example");
  assert.deepEqual(Object.keys(devClient({})), Object.keys(production.client));
});

test("generated blocks omit empty sections, keep empty values, quote literals, and refuse a name twice", () => {
  const { block, names } = renderGeneratedBlock(["Header line."], [
    { heading: "Absent", values: { NOT_DEPLOYED: undefined } },
    { heading: "Controls", values: { LOCAL_BROWSER_ORIGINS: "http://localhost:3000,http://127.0.0.1:4590", PRICE: "$5" } },
    { heading: CLIENT_SECTION_HEADING, values: { VITE_STUDIO_URL: "" } },
  ]);
  assert.deepEqual(names, ["LOCAL_BROWSER_ORIGINS", "PRICE", "VITE_STUDIO_URL"]);
  assert.doesNotMatch(block, /Absent|NOT_DEPLOYED/);
  assert.match(block, /^# BEGIN GENERATED CDK OUTPUTS\n# Header line\.\n\n# Controls\n/);
  assert.match(block, /\n\n# Client app: also written to client-app\/\.env\.development\.local\nVITE_STUDIO_URL=\n# END GENERATED CDK OUTPUTS\n$/);
  assert.equal(parseEnv(block).LOCAL_BROWSER_ORIGINS, "http://localhost:3000,http://127.0.0.1:4590");
  assert.match(block, /^PRICE="\\\$5"$/m);
  assert.throws(() => renderGeneratedBlock([], [
    { heading: "One", values: { VITE_API_GATEWAY_URL: "http://localhost:8080" } },
    { heading: "Two", values: { VITE_API_GATEWAY_URL: "http://localhost:8080" } },
  ]), /VITE_API_GATEWAY_URL is exported twice/);
});

test("client settings are validated before anything is written", () => {
  const endpoints = { apiUrl: "http://localhost:8080", localWebSocketUrl: "", apiGatewayWebSocketUrl: "", studioUrl: "" };
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, cognitoDomainUrl: "http://example.com" }), /HTTPS origin/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, localWebSocketUrl: "http://localhost:8081" }), /VITE_LOCAL_WS_URL must use ws: or wss:/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, apiGatewayWebSocketUrl: "https://example.com" }), /VITE_API_GATEWAY_WS_URL must use ws: or wss:/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, apiUrl: "localhost:8080" }), /VITE_API_GATEWAY_URL must use http: or https:/);
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, studioUrl: "ws://localhost:4590" }), /VITE_STUDIO_URL/);
  assert.equal(clientEnvironment({ ...cognito, ...endpoints, cognitoDomainUrl: "https://auth.example.com/" }).VITE_COGNITO_DOMAIN, "https://auth.example.com");
  assert.equal(clientEnvironment({ ...cognito, ...endpoints }).VITE_SIGN_IN_PROVIDERS, "google,meta");
  assert.throws(() => clientEnvironment({ ...cognito, ...endpoints, signInProviders: "Google" }), /VITE_SIGN_IN_PROVIDERS must be none or a comma-separated list/);
});

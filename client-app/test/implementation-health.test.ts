import { testProjectRoot } from "../../scripts/test-project";
import { loadFrameworkConfig as loadStarterConfig } from "aws-studio/config/source";
import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defineFrameworkConfig, type FrameworkConfig } from "aws-studio/config";
import { defaults } from "../../scripts/test-project-declarations";
import { applicationVpc } from "../../scripts/test-project-declarations";
import { withImplementationHealth } from "../server/implementation";
import { projectModel } from "../server/model/project";
const framework = loadStarterConfig(testProjectRoot);

function assertSourceLinks(config: FrameworkConfig, root: string): Set<string> {
  const inputs = { holds: () => true };
  const model = withImplementationHealth(config, projectModel(config, { mode: "dev", inputs: { dev: inputs, prod: inputs } }), root);
  const roles = new Set<string>();
  for (const target of model.targets.filter(target => target.directory)) {
    const file = target.implementation?.sourceFile;
    assert.ok(file, `${target.ref} needs a source link`);
    assert.ok(file.startsWith("compute/"), `${target.ref}: ${file}`);
    assert.ok(existsSync(path.join(root, file)), `${target.ref}: ${file} must exist`);
    roles.add(target.role);
  }
  assert.ok(roles.size > 0, "the fixture declares compute targets");
  return roles;
}

test("implementation links locate every configured application artifact", () => {
  assertSourceLinks(framework, testProjectRoot);
});

test("implementation links locate existing repository-relative artifacts for all seven compute kinds", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-implementation-links-"));
  const save = (file: string, text: string) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  try {
    for (const kind of ["http", "websocket", "events", "tools", "agents"]) {
      save("compute/" + kind + "/fixture-" + kind + "/index.ts", "export const lambdaHandler = () => ({});\n");
      save("compute/" + kind + "/fixture-" + kind + "/contract.ts", "export const contract = {};\n");
    }
    for (const kind of ["services", "tasks"]) save("compute/" + kind + "/fixture-" + kind + "/Dockerfile", "FROM scratch\n");
    save("compute/services/fixture-services/package.json", JSON.stringify({ scripts: { dev: "node index.js" } }));
    const config = defineFrameworkConfig({ defaults, networks: [applicationVpc],
      http: [{ "/fixture": { directory: "compute/http/fixture-http", methods: ["GET"] } }],
      webSocket: [{ $default: { directory: "compute/websocket/fixture-websocket" } }],
      events: [{ "fixture-event": { directory: "compute/events/fixture-events" } }],
      tools: [{ "fixture-tool": { directory: "compute/tools/fixture-tools" } }],
      services: [{ "/fixture-service/*": { directory: "compute/services/fixture-services", methods: "*", port: 5000, cloud: { vpc: applicationVpc } } }],
      tasks: [{ "fixture-task": { directory: "compute/tasks/fixture-tasks", cloud: { vpc: applicationVpc } } }],
      agents: [{ "fixture-agent": { directory: "compute/agents/fixture-agents" } }],
    });
    assert.deepEqual(assertSourceLinks(config, root), new Set(["http", "webSocket", "event", "tool", "service", "task", "agent"]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("implementation health reuses canonical tool, agent and Cognito verifier checks against overlays", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-implementation-health-"));
  const tool = path.join(root, "compute/tools/check-tool/index.ts"), http = path.join(root, "compute/http/check-http/index.ts"), agent = path.join(root, "compute/agents/check-agent/index.ts");
  for (const file of [tool, http, agent]) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, ""); writeFileSync(path.join(path.dirname(file), "contract.ts"), "export const contract = {};\n"); }
  const cognito = { USER_POOL_ID: "fixture", USER_POOL_CLIENT_ID: "fixture" };
  const config = defineFrameworkConfig({ defaults, http: [{ "/check": { directory: "compute/http/check-http", methods: ["GET"] } }], tools: [{ "check-tool": { auth: true, environment: cognito } }], gateways: [{ "check-gateway": { tools: ["check-tool"] } }], agents: [{ "check-agent": { auth: true, gateways: ["check-gateway"], environment: cognito } }], webSocket: [], events: [], services: [] });
  const projected = projectModel(config, { mode: "dev", });
  try {
    const bad = withImplementationHealth(config, projected, root, { [tool]: "export const lambdaHandler = tool(contract, async () => ({}));", [http]: 'import { authenticated as signedIn } from "aws-studio/runtime/auth";\nexport const lambdaHandler = signedIn(async () => ({}));', [agent]: 'export const handler = agent("other-agent", contract).respond(async () => ({}));' });
    assert.match(bad.targets.find(target => target.ref === "lambda:check-tool")!.implementation!.problems.join("\n"), /authenticatedTool/);
    assert.match(bad.targets.find(target => target.ref === "lambda:check-http")!.implementation!.problems.join("\n"), /userPool/);
    assert.match(bad.targets.find(target => target.ref === "agent:check-agent")!.implementation!.problems.join("\n"), /other-agent/);
    const good = withImplementationHealth(config, projected, root, { [tool]: "export const lambdaHandler = authenticatedTool(contract, async () => ({}));", [http]: 'export * from "./implementation";', [agent]: 'export const handler = agent("check-agent", contract).respond(async () => ({}));' });
    assert.ok(good.targets.every(target => target.implementation?.ready));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

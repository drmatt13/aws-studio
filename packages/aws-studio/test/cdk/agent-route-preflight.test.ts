import { projectCli, writeTestToolchain, testProjectRoot, testProjectScratchRoot } from "./support/test-project";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("deploy reports both conflicting route owners before synth or secret synchronization", () => {
  const artifacts = path.join(testProjectScratchRoot, ".framework", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const fixture = mkdtempSync(path.join(artifacts, "agent-route-preflight-"));
  try {
    writeTestToolchain(fixture);
    copyFileSync(path.join(testProjectRoot, "framework-config/defaults.ts"), path.join(fixture, "defaults.ts"));
    writeFileSync(path.join(fixture, "framework.config.ts"), `
import { defineFrameworkConfig } from "aws-studio/config";
import { defaults } from "./defaults";
export default defineFrameworkConfig({
  defaults, webSocket: [], events: [], services: [],
  http: [{ "/duplicate": { directory: "compute/http/report", methods: ["GET"] } }],
  agents: [{ support: { auth: true, route: "/api/duplicate", environment: { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" } } }],
});
`);
    const transport = path.join(fixture, "unexpected-transport.cjs");
    const called = path.join(fixture, "transport-called");
    writeFileSync(transport, `require("node:fs").writeFileSync(${JSON.stringify(called)}, "unexpected"); process.exit(97);`);
    const result = spawnSync(process.execPath, [projectCli(fixture), "deploy", "--all"], {
      cwd: fixture, encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, FRAMEWORK_REPOSITORY_ROOT: fixture, FRAMEWORK_AWS_CLI: transport,
        FRAMEWORK_CDK_CLI: transport, AWS_EC2_METADATA_DISABLED: "true",
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /Browser route collision: agents\["support"\]\.route.*http\["\/duplicate"\]/);
    assert.doesNotMatch(output, /\n\s+at /, "declaration failures print a useful message without a stack trace");
    assert.equal(existsSync(called), false, "preflight never starts a transport");
    assert.equal(existsSync(path.join(fixture, ".cache", "deploy")), false, "deployment assembly preparation never starts");
  } finally {
    assert.ok(realpathSync(fixture).startsWith(realpathSync(artifacts) + path.sep));
    rmSync(fixture, { recursive: true, force: true });
  }
});

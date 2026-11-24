import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProjectCompose } from "../scripts/compose-services";
import { copyLocalTestProject } from "./cdk/support/isolated-project";

const release = path.resolve(__dirname, "..");
const checkout = path.resolve(release, "../..");
const projectRequire = createRequire(path.join(checkout, "package.json"));
const releaseRequire = createRequire(path.join(release, "package.json"));

test("the app can resolve the release's deployment settings and CDK factories", () => {
  const subpaths = [
    "deployment", "database-settings", "framework-composition", "framework-resources",
    "framework-network", "framework-database", "framework-events", "event-lambda-functions-stack",
  ];
  for (const name of subpaths) {
    const entry = realpathSync(projectRequire.resolve(`aws-studio/cdk/${name}`));
    assert.ok(entry.startsWith(realpathSync(path.join(release, "cdk")) + path.sep), name);
  }
});

test("an app-owned CDK scope and a release-owned stack use the same two peers", t => {
  const manifest = JSON.parse(readFileSync(path.join(release, "package.json"), "utf8"));
  for (const peer of ["aws-cdk-lib", "constructs"]) {
    assert.ok(manifest.peerDependencies?.[peer], `${peer} must be a peer dependency`);
    assert.equal(manifest.dependencies?.[peer], undefined, `${peer} cannot be a runtime dependency`);
    assert.equal(realpathSync(projectRequire.resolve(peer)), realpathSync(releaseRequire.resolve(peer)));
  }
  const cdk: typeof import("aws-cdk-lib") = projectRequire("aws-cdk-lib");
  const constructs: typeof import("constructs") = projectRequire("constructs");
  const { DevLambdaReplayStack }: typeof import("aws-studio/cdk/dev-lambda-replay-stack") = projectRequire("aws-studio/cdk/dev-lambda-replay-stack");
  const outdir = mkdtempSync(path.join(os.tmpdir(), "release-cdk-"));
  t.after(() => rmSync(outdir, { recursive: true, force: true }));
  const app = new cdk.App({ autoSynth: false, outdir });
  const stack = new DevLambdaReplayStack(app, "Replay");
  assert.ok(stack instanceof cdk.Stack);
  assert.ok(stack instanceof constructs.Construct);
  assert.equal(cdk.Stack.of(stack.bucket), stack);
  assert.equal(stack.node.scope, app);
});

const launchers = {
  "api-server": "local-api-dev-server",
  "invocation-runner": "local-invocation-runner",
  "websocket-server": "local-ws-dev-server",
};
for (const [server, serviceName] of Object.entries(launchers)) {
  test(`${server} launches its package entry and reads the selected project configuration`, t => {
    const project = copyLocalTestProject("release runtime app ");
    t.after(() => rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    // Stop at configuration loading, before the server opens a listener or contacts Docker.
    writeFileSync(path.join(project, "framework.config.ts"), [
      'const { realpathSync, writeFileSync } = require("node:fs");',
      'writeFileSync("runtime-observed.json", JSON.stringify({',
      '  cwd: process.cwd(), root: process.env.FRAMEWORK_REPOSITORY_ROOT, entry: realpathSync(process.argv[1]),',
      '}));',
      'process.exit(0);',
    ].join("\n"));
    const appRequire = createRequire(path.join(project, "package.json"));
    const entry = realpathSync(appRequire.resolve(`aws-studio/local/${server}`));
    const installedRelease = path.join(project, "node_modules/aws-studio");
    assert.equal(realpathSync(installedRelease), installedRelease);
    assert.ok(entry.startsWith(path.join(installedRelease, "local") + path.sep), entry);
    const compose = readProjectCompose(project);
    const service = compose.services?.[serviceName];
    assert.ok(service, serviceName);
    assert.equal(service.working_dir, "/workspace");
    assert.equal((service.environment as Record<string, string>).FRAMEWORK_REPOSITORY_ROOT, service.working_dir);
    assert.ok(Array.isArray(service.command) && service.command.every(arg => typeof arg === "string"));
    const [node, ...args] = service.command as string[];
    assert.equal(node, "node");
    assert.equal(realpathSync(path.resolve(project, args.at(-1)!)), entry);
    // Exercise one launch; watch mode would keep a supervisor alive after the probe exits.
    execFileSync(process.execPath, args.filter(arg => !arg.startsWith("--watch")), {
      cwd: project, env: { ...process.env, FRAMEWORK_REPOSITORY_ROOT: project }, timeout: 30_000, stdio: "pipe",
    });
    assert.deepEqual(JSON.parse(readFileSync(path.join(project, "runtime-observed.json"), "utf8")), {
      cwd: project, root: project, entry,
    });
  });
}

import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { chainReporterBundle, chainWorkerBundle } from "aws-studio/contract-chain/evaluation";
import { nodeTestEvidence } from "aws-studio/contract-chain/verification";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { executionPolicy, providerExecutable } from "../server/agent-runtime/policy";
import { runValidation, resolveValidationCommand } from "../server/agent-runtime/providers/validation";
import { assertNarrowReadPaths, runtimeNode, trustedShell } from "../server/agent-runtime/providers/toolchain";

test("Windows coding fixes the MXC backend and separates native login from command environment", { skip: process.platform !== "win32" }, t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-policy spaces-λ-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "candidate"), scratch = path.join(directory, "scratch"); mkdirSync(cwd);
  const policy = executionPolicy(cwd, scratch);
  assert.deepEqual(policy.config.windows, { sandbox: "mxc" });
  assert.equal(policy.commandEnvironment.USERPROFILE, policy.scratchDir);
  assert.equal(policy.commandEnvironment.APPDATA, policy.scratchDir);
  assert.equal(policy.commandEnvironment.OPENSSL_CONF, "NUL");
  assert.match(policy.commandEnvironment.NODE_OPTIONS, /^--preserve-symlinks-main --import=data:text\/javascript;base64,[A-Za-z0-9+/=]+$/);
  assert.equal(policy.environment.NODE_OPTIONS, undefined);
  assert.equal(path.basename(runtimeNode(policy.runtimeDirectory)), "node.exe");
  assert.equal(path.basename(trustedShell().file), "powershell.exe");
  const filesystem = (policy.config.permissions as any)[policy.profile].filesystem;
  assert.equal(filesystem[path.parse(policy.cwd).root], undefined, "Node module startup must not require drive-root read access");
  const launched = spawnSync(runtimeNode(policy.runtimeDirectory), ["-e", 'const fs=require("node:fs"); console.log(JSON.stringify({sync:fs.realpathSync===fs.realpathSync.native,async:fs.realpath===fs.realpath.native,cwd:fs.realpathSync(process.cwd())}));'], {
    cwd, env: { ...process.env, ...policy.commandEnvironment }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout), { sync: true, async: true, cwd: realpathSync(cwd) });
});

test("Windows policy rejects profile and root aliases without HOME while allowing a narrow profile installation", { skip: process.platform !== "win32" }, t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-read-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "candidate"), scratch = path.join(directory, "scratch"), profile = path.join(directory, "profile");
  const install = path.join(profile, "tools/node"), alias = path.join(directory, "profile-junction");
  mkdirSync(cwd); mkdirSync(install, { recursive: true }); symlinkSync(profile, alias, "junction");
  const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
  try {
    delete process.env.HOME; process.env.USERPROFILE = profile;
    const drive = path.parse(directory).root;
    for (const root of [drive, path.toNamespacedPath(drive), "\\\\studio-policy.invalid\\share\\", "\\\\?\\UNC\\studio-policy.invalid\\share\\",
      profile, profile.toUpperCase(), path.toNamespacedPath(profile), alias, directory]) {
      assert.throws(() => executionPolicy(cwd, scratch, { readPaths: [root] }), /Broad/);
    }
    assert.equal(readdirSync(directory).some(value => value.startsWith("provider-runtime-")), false);
    const policy = executionPolicy(cwd, scratch, { readPaths: [install] });
    const filesystem = (policy.config.permissions as any)[policy.profile].filesystem;
    assert.equal(filesystem[realpathSync(install)], "read");
    assert.equal(filesystem[profile], undefined);
    assert.deepEqual(policy.config.windows, { sandbox: "mxc" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  }
});

test("Windows read-root guard protects the token profile when environment homes are redirected or absent", { skip: process.platform !== "win32" }, t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-token-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, "token-profile"), tools = path.join(profile, "tools/bin"), redirected = path.join(directory, "redirected-home");
  mkdirSync(tools, { recursive: true }); mkdirSync(redirected);
  const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
  const token = t.mock.method(os, "userInfo", (() => ({ username: "fixture", uid: -1, gid: -1, homedir: profile, shell: null })) as typeof os.userInfo);
  syncBuiltinESMExports();
  try {
    for (const home of [redirected, undefined]) {
      if (home === undefined) { delete process.env.HOME; delete process.env.USERPROFILE; }
      else { process.env.HOME = home; process.env.USERPROFILE = home; }
      assert.throws(() => assertNarrowReadPaths([profile]), /Broad/);
      assert.doesNotThrow(() => assertNarrowReadPaths([tools]));
    }
  } finally {
    token.mock.restore(); syncBuiltinESMExports();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  }
});

/** Opt-in requires a compatible installed CLI/native MXC, but never inference,
 * credentials, global configuration changes, AWS, Docker or a real database.
 */
test("Windows native sandbox validates Node/npm and blocks host access with spaces in the task path", {
  skip: process.platform !== "win32" || process.env.STUDIO_TEST_NATIVE_SANDBOX !== "1", timeout: 90_000,
}, async t => {
  assert.ok(providerExecutable("codex").endsWith("codex.exe"));
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-native spaces-λ-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "candidate"), scratchDir = path.join(directory, "scratch"); mkdirSync(cwd);
  mkdirSync(path.join(cwd, "nested"));
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "studio-native-fixture", version: "1.0.0", scripts: { test: "node --test nested/math.test.cjs" } }));
  writeFileSync(path.join(cwd, "nested/math.test.cjs"), "const test=require('node:test');test('isolated validation',()=>{if(2+3!==5)throw Error('Unexpected result');});\n");
  for (const command of [{ file: "node", args: ["--test", "nested/math.test.cjs"] }, { file: "npm", args: ["test"] }]) {
    const result = await runValidation({ provider: "codex", cwd, scratchDir, readOnlyCwd: true, command: resolveValidationCommand(command), signal: new AbortController().signal, onEvent: () => {}, timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /isolated validation/);
  }
});


test("Windows native sandbox runs the pinned contract reporter after startup preloads", {
  skip: process.platform !== "win32" || process.env.STUDIO_TEST_NATIVE_SANDBOX !== "1", timeout: 45_000,
}, async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-native reporter-λ-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "candidate"), scratchDir = path.join(directory, "scratch"); mkdirSync(cwd);
  mkdirSync(path.join(cwd, "nested"));
  const reporter = path.join(cwd, "node-test-reporter.cjs");
  writeFileSync(reporter, await chainReporterBundle());
  writeFileSync(path.join(cwd, "nested/math.test.cjs"), "const test=require('node:test');test('isolated behavior',()=>{if(2+3!==5)throw Error('Unexpected result');});\n");
  const result = await runValidation({ provider: "codex", cwd, scratchDir, readOnlyCwd: true, command: { file: process.execPath, args: [reporter, "nested/math.test.cjs"] }, signal: new AbortController().signal, onEvent: () => {}, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(nodeTestEvidence(JSON.parse(result.stdout)).status, "passed");
});


test("Windows native sandbox completes actual Vitest client proof without drive-root access", {
  skip: process.platform !== "win32" || process.env.STUDIO_TEST_NATIVE_SANDBOX !== "1", timeout: 60_000,
}, async t => {
  const repository = path.resolve(__dirname, "../..");
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-native client-λ-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "candidate"), scratchDir = path.join(directory, "scratch"); mkdirSync(cwd); mkdirSync(scratchDir);
  const put = (name: string, text: string) => { const file = path.join(cwd, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  put("package.json", '{"name":"contract-native-client","type":"module"}');
  put("client-app/package.json", '{"name":"contract-native-client-app","type":"module"}');
  put("client-app/src/api/projects/operations.ts", "export const value = 1;\n");
  put("client-app/src/api/projects/operations.test.ts", 'import {test,expect} from "vitest";import {value} from "#/api/projects/operations";test("selection",()=>expect(value).toBe(1));');
  put("client-app/src/api/graphql/client.test.ts", 'import {test,expect} from "vitest";test("transport",()=>expect(1).toBe(1));');
  const dependencies = [path.join(repository, "node_modules"), path.join(testProjectRoot, "client-app/node_modules")];
  symlinkSync(dependencies[0]!, path.join(cwd, "node_modules"), "junction");
  symlinkSync(dependencies[1]!, path.join(cwd, "client-app/node_modules"), "junction");
  const worker = path.join(cwd, "inspect.cjs"), reporter = path.join(cwd, "node-test-reporter.cjs"), artifact = path.join(scratchDir, "client.json");
  writeFileSync(worker, await chainWorkerBundle()); writeFileSync(reporter, await chainReporterBundle());
  const loader = pathToFileURL(createRequire(path.join(repository, "package.json")).resolve("tsx")).href;
  const workspacePackages = ["aws-studio", "database", "api-contract"].map(name => path.join(repository, "packages", name));
  const result = await runValidation({ provider: "codex", cwd, scratchDir, readOnlyCwd: true, readPaths: [...dependencies, ...workspacePackages],
    command: { file: process.execPath, args: ["--import", loader, worker, artifact, "client", reporter] },
    signal: AbortSignal.timeout(50_000), onEvent: () => {}, timeoutMs: 45_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), { evidence: { status: "passed" } });
});

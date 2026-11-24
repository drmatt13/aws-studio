import assert from "./support/assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { assertContractFixtureRuntime } from "./support/contract-fixture-runtime";

test("full verification retains the real propagation gate after the ordinary Studio suites", () => {
  const workspace = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const root = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.deepEqual(workspace.scripts.test.split(" && "), [workspace.scripts["test:unit"], workspace.scripts["test:contract-propagation"]], "direct Node commands retain mandatory sequence without inheriting npm workspace selection");
  assert.match(workspace.scripts["test:unit"], /test\/\*\.test\.ts$/);
  assert.match(workspace.scripts["test:contract-propagation"], /--test-concurrency=1 test\/contract-propagation\.e2e\.ts$/);
  assert.equal(readdirSync(__dirname).filter(file => file.endsWith(".test.ts")).some(file => file.includes("propagation-e2e")), false);
  assert.equal(root.scripts.test, "node scripts/verify-platform.mjs test");
  for (const entry of ["verify", "verify:offline"]) {
    assert.equal(root.scripts[entry], "node scripts/verify-platform.mjs verify");
  }
  const verification = readFileSync(path.join(__dirname, "../../scripts/verify-platform.mjs"), "utf8");
  assert.match(verification, /const suites = \[[\s\S]*?\["npm", "--workspace", "framework-studio", "run", "test:unit"\],\s*\["npm", "--workspace", "framework-studio", "run", "test:contract-propagation"\],/);
  assert.match(verification, /\bsuites\.forEach\(run\)/);
  assert.ok(root.workspaces.includes("client-app"));
});

test("unsupported runtimes fail before fixture capture", () => {
  for (const version of ["26.13.0", "24.22.1", "22.22.0"]) assert.throws(() => assertContractFixtureRuntime(version), /Node 24\.22\.2/);
  for (const version of ["24.22.2", "24.22.3", "24.23.0"]) assert.doesNotThrow(() => assertContractFixtureRuntime(version));
});

test("the fixed runner rejects unsupported Node before loading or creating an application fixture", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "studio-contract-runtime-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const loader = pathToFileURL(createRequire(path.join(__dirname, "../package.json")).resolve("tsx")).href;
  const runner = pathToFileURL(path.join(__dirname, "support/real-contract-propagation-runner.ts")).href;
  const script = `Object.defineProperty(process.versions,"node",{value:"26.13.0"});process.argv=[process.execPath,"fixture-runner",${JSON.stringify(directory)},${JSON.stringify(path.join(directory, "evidence.json"))}];await import(${JSON.stringify(runner)});`;
  assert.throws(() => execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } }), /Node 24\.22\.2/);
  assert.deepEqual(readdirSync(directory), [], "unsupported execution must create no candidate or installed-tree copy");
});

for (const failed of [false, true]) test(`the fixed runner ${failed ? "fails without evidence" : "publishes complete evidence"} and exits despite retained tool handles`, t => {
  const directory = mkdtempSync(path.join(tmpdir(), "studio-contract-runner-lifecycle-")), artifact = path.join(directory, "evidence.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ["real-contract-propagation-runner.ts", "contract-fixture-runtime.ts"]) copyFileSync(path.join(__dirname, "support", file), path.join(directory, file));
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(directory, "real-contract-propagation.ts"), `export async function exerciseRealContractPropagation(){setInterval(()=>{},60000);${failed ? 'throw new Error("fixed lifecycle failure");' : 'return {fixture:"completed"};'}}`);
  const loader = pathToFileURL(createRequire(path.join(__dirname, "../package.json")).resolve("tsx")).href;
  const invoke = () => execFileSync(process.execPath, ["--import", loader, path.join(directory, "real-contract-propagation-runner.ts"), directory, artifact], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) } });
  if (failed) {
    assert.throws(invoke, (error: unknown) => { const value = error as { status?: number; stderr?: string }; assert.equal(value.status, 1); assert.match(String(value.stderr), /fixed lifecycle failure/); return true; });
    assert.equal(existsSync(artifact), false);
  } else {
    assert.match(invoke(), /completed evidence written/);
    assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), { fixture: "completed" });
  }
});

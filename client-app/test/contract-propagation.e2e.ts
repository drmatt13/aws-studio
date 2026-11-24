import { platformSourceRoot, testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { spawnOwnedProcess } from "aws-studio/cli/owned-process.cjs";
import type { RealContractPropagationEvidence } from "./support/real-contract-propagation";
import { assertContractFixtureRuntime } from "./support/contract-fixture-runtime";

// Windows captures complete dependency trees. The cutover replay took 117 minutes
// while the complete Studio suite ran in parallel.
const contractTimeout = process.platform === "win32" ? 150 * 60_000 : 1_800_000;

test("real offline Prisma-to-consumer propagation integrates one candidate and explicitly renews saved-source proof", { timeout: contractTimeout }, async t => {
  assertContractFixtureRuntime();
  const directory = await mkdtemp(path.join(tmpdir(), "studio-contract-e2e-runner-")), artifact = path.join(directory, "evidence.json");
  const loader = pathToFileURL(createRequire(path.join(platformSourceRoot, "package.json")).resolve("tsx")).href;
  // node:test's async-resource tracking makes the real installed-tree capture
  // disproportionately expensive. The fixed owned child runs the same complete
  // production workflow, without inheriting the test runner's instrumentation.
  const env: NodeJS.ProcessEnv = { PATH: [path.dirname(realpathSync(process.execPath)), process.env.PATH].filter(Boolean).join(path.delimiter), TSX_DISABLE_CACHE: "1", NO_COLOR: "1", FORCE_COLOR: "0", TMPDIR: directory, TMP: directory, TEMP: directory };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "USERPROFILE", "LOCALAPPDATA"]) if (process.platform === "win32" && process.env[name]) env[name] = process.env[name];
  const child = spawnOwnedProcess(process.execPath, ["--import", loader, path.join(__dirname, "support/real-contract-propagation-runner.ts"), testProjectRoot, artifact], { cwd: platformSourceRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  const collect = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-16_384); };
  child.stdout!.on("data", chunk => { collect(chunk); process.stdout.write(chunk); }); child.stderr!.on("data", collect);
  const abort = () => child.kill("SIGTERM"); t.signal.addEventListener("abort", abort, { once: true });
  t.after(async () => {
    t.signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once("close", resolve)); child.kill("SIGTERM"); await closed; }
    await rm(directory, { recursive: true, force: true });
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, diagnostics);
  const bytes = await readFile(artifact); assert.ok(bytes.length < 64 * 1024);
  const evidence = JSON.parse(bytes.toString()) as RealContractPropagationEvidence;
  assert.deepEqual(evidence.stages, ["api", "codegen", "client"]);
  assert.equal(evidence.providerTurns, 2);
  assert.ok(evidence.independentChecks.length > 0 && evidence.independentChecks.every(check => check.endsWith(": passed")));
  assert.deepEqual(evidence.finalConfidence, ["verified", "verified", "verified"]);
  assert.equal(evidence.sourceAuthorityUnchanged, true);
  assert.equal(evidence.cliExitCode, 0, "the independent CLI gate enforces the same complete saved-source proof");
});

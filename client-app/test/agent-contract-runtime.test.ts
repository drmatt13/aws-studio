import assert from "./support/assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { portableProofPolicy, projectVerifierRoot } from "aws-studio/contract-chain/portable-identity";
import { testProjectRoot, testProjectScratch } from "../../scripts/test-project";
import { projectContractInspection } from "../server/agent-runtime/contract-validation";
import { readProjectContractIdentity } from "../server/agent-runtime/project-contract-identity";
import { resolveValidationCommand } from "../server/agent-runtime/providers/validation";
import { projectRuntime, projectRuntimeEnvironment } from "../server/project-runtime";

test("generic Coding validation uses the selected project Node and npm", async () => {
  const runtime = projectRuntime(testProjectRoot);
  const node = resolveValidationCommand({ file: "node", args: ["--version"] }, runtime);
  const npm = resolveValidationCommand({ file: "npm", args: ["--version"] }, runtime);
  assert.equal(node.file, runtime.node);
  assert.deepEqual(npm, { file: runtime.node, args: [runtime.npm, "--version"] });
  for (const [command, version] of [[node, `v${runtime.version}`], [npm, runtime.npmVersion]] as const) {
    const result = await promisify(execFile)(command.file, command.args, { cwd: testProjectRoot, env: projectRuntimeEnvironment(runtime) });
    assert.equal(result.stdout.trim(), version);
  }
});

test("Coding binds origin to the same source revision as an inspector running in the project", async t => {
  const runtime = projectRuntime(testProjectRoot);
  const scratch = testProjectScratch("contract-runtime-");
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "project");
  mkdirSync(path.join(root, "node_modules/aws-studio"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/aws-studio/package.json"), '{"name":"aws-studio"}');
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: `npm@${runtime.npmVersion}` }));
  writeFileSync(path.join(root, ".nvmrc"), readFileSync(path.join(testProjectRoot, ".nvmrc")));
  writeFileSync(path.join(root, "example.ts"), "export const current = true;\n");
  const bytes = "fixed worker fixture\n", file = path.join(scratch, "worker.cjs");
  writeFileSync(file, bytes);
  const asset = { file, digest: createHash("sha256").update(bytes).digest("hex") };
  const local = createRequire(path.join(testProjectRoot, "package.json"));
  const inspector = local.resolve("aws-studio/contract-chain/inspector");
  const observed = await promisify(execFile)(runtime.node, ["--import", local.resolve("tsx"), "-e", `
    const { chainInputIdentity } = require(${JSON.stringify(inspector)});
    chainInputIdentity(process.cwd(), Buffer.from(${JSON.stringify(bytes)})).then(value => console.log(value));
  `], { cwd: root, env: projectRuntimeEnvironment(runtime) });
  const inspection = projectContractInspection({ worker: asset, reporter: asset });
  assert.equal(await inspection.identity?.(root), observed.stdout.trim());
});

test("read-only contract identity uses the selected executable and the physical project verifier policy", async () => {
  const runtime = projectRuntime(testProjectRoot);
  const policy = portableProofPolicy(projectVerifierRoot(testProjectRoot));
  const identity = await readProjectContractIdentity(testProjectRoot, policy, new AbortController().signal);
  assert.equal(identity.toolchain.node, runtime.version);
  assert.deepEqual(identity.policy, policy);
  assert.match(identity.sourceRevision, /^[a-f0-9]{64}$/);
  if (runtime.version !== process.versions.node) assert.notEqual(identity.toolchain.node, process.versions.node);
  await assert.rejects(readProjectContractIdentity(testProjectRoot, { ...policy, digest: "0".repeat(64) }, new AbortController().signal), /checker policy differs/);
});

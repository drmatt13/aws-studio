const assert = require("node:assert/strict");
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const path = require("node:path");
import test from "node:test";
const issuer = createRequire(path.resolve("package.json"));
const { CONTRACT_PROOF_POLICY_FILES, portableProofPolicy } = issuer("aws-studio/contract-chain/portable-identity");
const { captureContractSourceProjection } = issuer("aws-studio/contract-chain/source-lease");
const source = path.resolve(path.dirname(issuer.resolve("aws-studio/contract-chain/portable-identity")), "../..");

test("public verifier capture excludes private CDK lookups and secret bindings", async t => {
  const { prepareAgentWorkspace, readSourceManifest } = issuer("aws-studio/source/workspace");
  const work = mkdtempSync(path.join(realpathSync(tmpdir()), "aws studio verifier capture "));
  t.after(() => { assert.equal(path.dirname(work), realpathSync(tmpdir())); rmSync(work, { recursive: true, force: true }); });
  const app = path.join(work, "app");
  mkdirSync(path.join(app, "cdk-app"), { recursive: true });
  writeFileSync(path.join(app, "cdk-app/cdk.json"), "{}\n");
  const privateInputs = ["cdk-app/cdk.context.json", "cdk-app/.secret-bindings.json"];
  for (const name of privateInputs) writeFileSync(path.join(app, name), "{}\n");
  const manifest = readSourceManifest(app);
  assert.deepEqual(Object.keys(manifest.files), ["cdk-app/cdk.json"]);
  const capture = await prepareAgentWorkspace(app, { storageDirectory: path.join(work, "tasks"), copyDependencies: false });
  for (const name of privateInputs) assert.equal(existsSync(path.join(capture.workingDirectory, name)), false, name);
  assert.equal(existsSync(path.join(capture.workingDirectory, "cdk-app/cdk.json")), true);
});

test("verifier policy and raw source leases use the physical release files independently of the app", t => {
  const work = mkdtempSync(path.join(realpathSync(tmpdir()), "aws studio policy "));
  t.after(() => { assert.equal(path.dirname(work), realpathSync(tmpdir())); rmSync(work, { recursive: true, force: true }); });
  const app = path.join(work, "app"), installed = path.join(app, "node_modules/aws-studio");
  mkdirSync(path.join(app, "packages/database/prisma"), { recursive: true });
  writeFileSync(path.join(app, "packages/database/prisma/contract.prisma"), "model Item { id Int @id }\n");
  writeFileSync(path.join(app, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  for (const file of CONTRACT_PROOF_POLICY_FILES) {
    assert.ok(!file.startsWith("packages/") && !file.includes(".."), file);
    mkdirSync(path.dirname(path.join(installed, file)), { recursive: true });
    copyFileSync(path.join(source, file), path.join(installed, file));
  }
  const policy = portableProofPolicy();
  assert.deepEqual(portableProofPolicy(installed), policy);
  const before = captureContractSourceProjection(app, installed);
  assert.equal(before.policy, policy.digest);
  const worker = path.join(installed, "scripts/contract-chain/worker.ts");
  const original = readFileSync(worker, "utf8");
  writeFileSync(worker, original.includes("\r\n") ? original.replaceAll("\r\n", "\n") : original.replaceAll("\n", "\r\n"));
  const lineEndings = captureContractSourceProjection(app, installed);
  assert.equal(lineEndings.policy, before.policy);
  assert.notEqual(lineEndings.rawPolicy, before.rawPolicy);
  writeFileSync(worker, original + "\n// changed verifier implementation\n");
  const changed = captureContractSourceProjection(app, installed);
  assert.notEqual(changed.policy, before.policy);
  assert.deepEqual(changed.normalized, before.normalized);
  assert.deepEqual(portableProofPolicy(), policy, "the source issuer still uses its own verifier");
});

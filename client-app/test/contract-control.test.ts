import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONTRACT_PROOF_POLICY_FILES, portableProofPolicy } from "aws-studio/contract-chain/portable-identity";
import { runFrameworkChainCli } from "aws-studio/contract-chain/cli";
import { STUDIO_CONTRACT_CONTROL_FILES, studioContractControl } from "../server/agent-runtime/contract-control";
import { runChainCli } from "../server/graphql-chain/cli";

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "studio-contract-control-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string, text: string) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text); };
  const release = path.join(root, "node_modules/aws-studio");
  for (const name of CONTRACT_PROOF_POLICY_FILES) put(path.join("node_modules/aws-studio", name), `// fixture: ${name}\n`);
  for (const name of STUDIO_CONTRACT_CONTROL_FILES) put(name, `// fixture: ${name}\n`);
  return { root, release, put };
}

test("Studio's contract control covers its orchestration without entering the receipts' policy", t => {
  const f = fixture(t);
  const policy = portableProofPolicy(f.release).digest, control = studioContractControl(f.root, f.release);
  f.put(STUDIO_CONTRACT_CONTROL_FILES.find(name => name.endsWith("contract-validation.ts"))!, "// edited Coding contract stage\n");
  assert.equal(portableProofPolicy(f.release).digest, policy, "a Studio-only edit leaves application receipts current");
  assert.notEqual(studioContractControl(f.root, f.release), control, "but a Studio host can no longer authorize contract work with the old code");
});

test("a verifier edit changes both the receipts' policy and Studio's contract control", t => {
  const f = fixture(t);
  const policy = portableProofPolicy(f.release).digest, control = studioContractControl(f.root, f.release);
  f.put("node_modules/aws-studio/scripts/contract-chain/proof-core.ts", "// edited verifier\n");
  assert.notEqual(portableProofPolicy(f.release).digest, policy);
  assert.notEqual(studioContractControl(f.root, f.release), control);
});

test("missing Studio control source cannot establish an identity", t => {
  const f = fixture(t);
  rmSync(path.join(f.root, STUDIO_CONTRACT_CONTROL_FILES[0]));
  assert.throws(() => studioContractControl(f.root, f.release));
});

test("Studio's CLI runs the framework's verify, record and init", async t => {
  const studio = fixture(t), framework = fixture(t);
  const output = (sink: unknown[]) => (value: unknown) => { sink.push(value); };
  const fromStudio: unknown[] = [], fromFramework: unknown[] = [];
  assert.equal(await runChainCli(["init"], studio.root, output(fromStudio)), 0);
  assert.equal(await runFrameworkChainCli(["init"], framework.root, output(fromFramework)), 0);
  assert.deepEqual(fromStudio, fromFramework);
  assert.equal(readFileSync(path.join(studio.root, "graphql-chain.review.json"), "utf8"), readFileSync(path.join(framework.root, "graphql-chain.review.json"), "utf8"));
  const refusedStudio: unknown[] = [], refusedFramework: unknown[] = [];
  assert.equal(await runChainCli(["verify", "--unknown"], studio.root, output(refusedStudio)), 2);
  assert.equal(await runFrameworkChainCli(["verify", "--unknown"], framework.root, output(refusedFramework)), 2);
  assert.deepEqual(refusedStudio, refusedFramework);
});

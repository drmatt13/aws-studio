import assert from "./support/assert";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { contractGateExitCode, runContractGate } from "aws-studio/contract-chain/ci";
import { CI_OBSERVATION_PATH, compareCIObservation, loadCIObservation, readCIObservation, writeCIObservation, type CIObservation } from "aws-studio/contract-chain/ci-observation";
import { readCliReviewDecisions } from "../server/graphql-chain/cli";
import { createProofReceipt } from "aws-studio/contract-chain/proof-core";
import type { ChainObservation, GraphQLChainInspector } from "aws-studio/contract-chain/inspector";
import { graphqlChainFixture } from "./support/graphql-chain";
import type { ContractProofReceipt } from "aws-studio/contract-chain/contract-proof";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "README.md"), "A disposable source authority.\n");
  return root;
}
const receipt = (previous: ContractProofReceipt, change: Partial<Omit<ContractProofReceipt, "id">>): ContractProofReceipt => {
  const { id: _id, ...body } = previous;
  return createProofReceipt({ ...body, ...change });
};
function observation(): ChainObservation {
  const chain = { ...graphqlChainFixture(), revision: "a".repeat(64) };
  return { chain, evaluationRevision: "b".repeat(64), models: {}, surface: null, record: null, recordText: null, bindings: { api: null, client: null, upstream: null } };
}
function report(): CIObservation {
  const proof = graphqlChainFixture().proof;
  return { version: 1, authority: "ci", policy: proof.policy, node: process.versions.node, environment: { platform: process.platform, arch: process.arch, execution: "trusted-checkout" }, revision: "a".repeat(64), outcome: "verified", stages: proof.stages.map(stage => ({ stage: stage.stage, status: stage.status, current: stage.current!.id, recorded: stage.recorded!.id, predecessors: stage.predecessors, checks: stage.current!.checks.map(check => ({ id: check.id, outcome: check.outcome, evidence: check.evidence })), diagnostics: [], action: stage.action })) };
}

test("CI requires a complete current saved-source receipt graph, not passing flags", () => {
  const chain = graphqlChainFixture(); assert.equal(contractGateExitCode(chain), 0);
  for (const stageId of ["database", "api", "codegen", "client"] as const) {
    const missing = { ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === stageId ? { ...stage, recorded: null } : stage) } };
    assert.equal(contractGateExitCode(missing), 1, `${stageId} recorded evidence is required even when every badge claims verified`);
  }
  const corrupt = { ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, recorded: { ...stage.recorded!, implementation: "e".repeat(64) } } : stage) } };
  assert.equal(contractGateExitCode(corrupt), 1, "edited receipt bodies cannot retain a claimed content identity");
});

test("CI detects hidden unavailable, partial, failed and candidate-only evidence", () => {
  const chain = graphqlChainFixture();
  for (const outcome of ["failed", "blocked", "unavailable"] as const) {
    const changed = { ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, status: "blocked" as const, current: receipt(stage.current!, { checks: stage.current!.checks.map(check => ({ ...check, outcome })) }) } : stage) } };
    assert.equal(contractGateExitCode(changed), outcome === "unavailable" ? 2 : 1);
  }
  const candidate = { ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => {
    const current = receipt(stage.current!, { scope: "candidate", review: null });
    return { ...stage, current, recorded: current };
  }) } };
  assert.equal(contractGateExitCode(candidate), 1);
  const emptied = { ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => ({ ...stage, current: { ...stage.current!, checks: [] } })) } };
  assert.equal(contractGateExitCode(emptied), 1);
});

test("specific predecessor and policy bindings must match freshly derived receipts", () => {
  const chain = graphqlChainFixture(), api = chain.proof.stages.find(stage => stage.stage === "api")!;
  const changedApi = receipt(api.current!, { implementation: "c".repeat(64) });
  const changed = { ...chain, proof: { ...chain.proof, stages: chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, current: changedApi, recorded: changedApi } : stage) } };
  assert.equal(contractGateExitCode(changed), 1, "unchanged downstream bytes cannot preserve a predecessor from another receipt");
  assert.equal(contractGateExitCode({ ...chain, proof: { ...chain.proof, policy: { ...chain.proof.policy, digest: "d".repeat(64) } } }), 1);
});

test("CI report claims never establish current confidence or authenticate their origin", async t => {
  const root = fixture(t), claim = report(), view = graphqlChainFixture().proof;
  assert.equal((await loadCIObservation(root)).status, "missing");
  await writeCIObservation(root, claim);
  const loaded = await loadCIObservation(root);
  assert.equal(loaded.status, "available");
  assert.equal(compareCIObservation(loaded, view).status, "matching");
  assert.match(compareCIObservation(loaded, view).message, /not authenticated|not.*signed/);
  assert.equal(compareCIObservation(loaded, { ...view, stages: view.stages.map(stage => stage.stage === "api" ? { ...stage, status: "failed" } : stage) }).status, "different");
  assert.equal(readCIObservation(JSON.parse(JSON.stringify(claim))).revision, claim.revision);
  assert.equal(JSON.stringify(claim).includes(root), false);
  writeFileSync(path.join(root, CI_OBSERVATION_PATH), '{"version":99,"outcome":"verified"}');
  assert.equal((await loadCIObservation(root)).status, "unavailable");
  await assert.rejects(writeCIObservation(root, { ...claim, stages: [] }));
});

test("interrupted publication and source changes cannot issue a successful report", async t => {
  const root = fixture(t), evidence = observation(); let inspections = 0, disposed = false;
  const inspector = { inspect: async () => { inspections++; if (inspections > 1) writeFileSync(path.join(root, "README.md"), "Concurrent source edit\n"); return evidence; }, dispose: async () => { disposed = true; } } as unknown as GraphQLChainInspector;
  const outputs: unknown[] = [];
  assert.equal(await runContractGate(root, output => outputs.push(output), { inspector }), 2);
  assert.equal(disposed, true); assert.equal(existsSync(path.join(root, CI_OBSERVATION_PATH)), false);
  assert.equal((outputs[0] as { outcome: string }).outcome, "unavailable");
});

test("the gate can publish bounded historical evidence but never source review acknowledgements", async t => {
  const root = fixture(t), evidence = observation();
  writeFileSync(path.join(root, "graphql-chain.review.json"), "existing developer review bytes\n");
  const before = readFileSync(path.join(root, "graphql-chain.review.json"), "utf8");
  const inspector = { inspect: async () => evidence, dispose: async () => {} } as unknown as GraphQLChainInspector;
  const outputs: unknown[] = [];
  assert.equal(await runContractGate(root, output => outputs.push(output), { inspector }), 0);
  assert.equal((outputs[0] as CIObservation).outcome, "verified");
  assert.equal((await loadCIObservation(root)).status, "available");
  assert.equal(readFileSync(path.join(root, "graphql-chain.review.json"), "utf8"), before);
});

test("CI preserves specific failed-check diagnostics without persisting authored failure payloads", async t => {
  const root = fixture(t), before = observation();
  const chain = { ...before.chain, verification: { ...before.chain.verification, api: { status: "unavailable" as const, diagnostics: [{ code: "API_TEST_TIMEOUT", message: "Sensitive fixture payload must not enter receipt history.", file: "schema/project.test.ts" }] } }, proof: { ...before.chain.proof, stages: before.chain.proof.stages.map(stage => stage.stage === "api" ? { ...stage, status: "unavailable" as const } : stage) } };
  const evidence = { ...before, chain }, outputs: unknown[] = [];
  const inspector = { inspect: async () => evidence, dispose: async () => {} } as unknown as GraphQLChainInspector;
  assert.equal(await runContractGate(root, output => outputs.push(output), { inspector }), 2);
  const report = outputs[0] as CIObservation;
  assert.ok(report.stages.find(stage => stage.stage === "api")?.diagnostics.some(item => item.code === "API_TEST_TIMEOUT"));
  assert.match(JSON.stringify(report), /schema\/project.test.ts/);
  assert.doesNotMatch(JSON.stringify(report), /Sensitive fixture payload/);
});

test("CLI review input requires explicit scoped notes and rejects malformed, linked or oversized declarations", t => {
  const root = fixture(t), notes = { statement: "Preserve approved Project ownership and withhold private database fields.", evidence: "Reviewed source, executable-schema tests and Project repository owner-filter tests." };
  assert.deepEqual(readCliReviewDecisions(root, { kind: "api" }, { statement: notes.statement, evidence: notes.evidence }), { api: notes });
  assert.throws(() => readCliReviewDecisions(root, { kind: "client" }, { statement: notes.statement }));
  assert.throws(() => readCliReviewDecisions(root, { kind: "baseline" }, { statement: notes.statement, evidence: notes.evidence }));
  const file = path.join(root, "review-decisions.json"); writeFileSync(file, JSON.stringify({ api: notes, client: notes }));
  assert.deepEqual(readCliReviewDecisions(root, { kind: "baseline" }, { file }), { api: notes, client: notes });
  assert.deepEqual(readCliReviewDecisions(root, { kind: "api" }, { file }), { api: notes });
  assert.throws(() => readCliReviewDecisions(root, { kind: "api" }, { file, evidence: notes.evidence }));
  const linked = path.join(root, "linked-review.json"); linkSync(file, linked);
  assert.throws(() => readCliReviewDecisions(root, { kind: "api" }, { file: linked }), /bounded|regular/);
  rmSync(linked);
  writeFileSync(file, JSON.stringify({ api: { statement: "x".repeat(40_000), evidence: notes.evidence } }));
  assert.throws(() => readCliReviewDecisions(root, { kind: "api" }, { file }), /bounded/);
});

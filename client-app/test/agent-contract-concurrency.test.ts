import assert from "./support/assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTaskService, type AgentServiceOptions } from "../server/agent-runtime/service";
import { readSourceManifest, type AgentWorkspace } from "aws-studio/source/workspace";
import { buildContractCodingContext } from "../shared/contract-propagation";
import type { CodingTask } from "../shared/agent-runtime";
import { graphqlChainFixture } from "./support/graphql-chain";
import { candidateProofsFixture } from "./support/candidate-proof";

const identity = (workspace: AgentWorkspace) => createHash("sha256").update(readSourceManifest(workspace.workingDirectory).digest).digest("hex");
function put(root: string, file: string, text: string) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
function fixture(t: TestContext, dependencies = false, runProvider?: AgentServiceOptions["runProvider"]) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-cas-")), root = path.join(directory, "project"); mkdirSync(root);
  put(root, "package.json", '{"name":"contract-concurrency-fixture"}');
  put(root, "client-app/src/api/projects/operations.ts", "export const key = ['projects'];\n");
  if (dependencies) put(root, "node_modules/trusted/index.js", "module.exports = 1;\n");
  let barrier: { enter: () => void; wait: Promise<void> } | undefined;
  const service = new AgentTaskService(root, path.join(directory, "state"), {
    copyDependencies: dependencies, contractOrigin: async () => {}, canApplyRuntimeChanges: true,
    runProvider: runProvider ?? (async () => ({ status: "completed" })),
    contractIdentity: async workspace => { const result = identity(workspace), current = barrier; barrier = undefined; if (current) { current.enter(); await current.wait; } return result; },
    validateContract: async input => ({ proofs: await candidateProofsFixture(input), inputDigest: identity(input.workspace), checks: [{ command: "contract: independent fixture checks", status: "passed", candidateDigest: readSourceManifest(input.workspace.workingDirectory).digest }] }),
    integrate: async () => { assert.fail("A no-op or rejected action must never import source."); },
  });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); }); service.start();
  const context = buildContractCodingContext(graphqlChainFixture(), "client");
  const task = service.submit({ requestKey: "contract-concurrency-fixture", provider: "codex", prompt: "Preserve the existing client behavior.", contract: { ...context, decisions: context.decisions.map(item => ({ ...item, status: "established", value: "Preserve existing behavior.", evidence: "The developer reviewed the existing operation and cache behavior." })) } });
  return { root, service, id: task.id, arm() {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), wait = new Promise<void>(resolve => { release = resolve; }); barrier = { enter, wait };
    return { entered, release };
  } };
}
async function settled(service: AgentTaskService, id: string): Promise<CodingTask> {
  for (let attempt = 0; attempt < 300; attempt++) { const task = service.get(id); if (["awaiting_review", "conflicted", "failed", "completed", "rejected"].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Fixture did not settle.");
}

test("a concurrent rejection cannot be overwritten by a suspended Continue request", async t => {
  const f = fixture(t), checkpoint = await settled(f.service, f.id), gate = f.arm();
  const pending = f.service.continueContract(f.id, checkpoint.proposalDigest!); await gate.entered;
  const rejected = f.service.reject(f.id); gate.release();
  await assert.rejects(pending, /task action|current state|checkpoint/i);
  assert.deepEqual(f.service.get(f.id), rejected);
});

test("a concurrent refresh cannot be queued or overwritten by an old Continue request", async t => {
  const f = fixture(t), checkpoint = await settled(f.service, f.id), gate = f.arm();
  const pending = f.service.continueContract(f.id, checkpoint.proposalDigest!); await gate.entered;
  f.service.refresh(f.id, checkpoint.proposalDigest!); gate.release();
  await assert.rejects(pending, /task action|current state|checkpoint/i);
  const refreshed = await settled(f.service, f.id);
  assert.equal(refreshed.status, "awaiting_review", refreshed.summary);
  assert.notEqual(refreshed.proposalDigest, checkpoint.proposalDigest);
  assert.equal(refreshed.contract?.status, "checkpoint");
});

test("a concurrent final approval keeps its outcome when an earlier Continue completes", async t => {
  const f = fixture(t), checkpoint = await settled(f.service, f.id);
  await f.service.continueContract(f.id, checkpoint.proposalDigest!);
  const ready = f.service.get(f.id), gate = f.arm();
  const pending = f.service.continueContract(f.id, ready.proposalDigest!, ready.contract!.decisions.map(item => ({ ...item, value: "A newly proposed choice." }))); await gate.entered;
  const completed = await f.service.approve(f.id, ready.proposalDigest!); gate.release();
  await assert.rejects(pending, /task action|current state|checkpoint/i);
  assert.deepEqual(f.service.get(f.id), completed);
  assert.equal(completed.contract?.status, "applied-awaiting-check");
});

test("source edits during Continue invalidate its history and retain a refreshable proposal", async t => {
  const f = fixture(t), checkpoint = await settled(f.service, f.id), gate = f.arm();
  const pending = f.service.continueContract(f.id, checkpoint.proposalDigest!); await gate.entered;
  put(f.root, "developer.ts", "export const saved = 'concurrent';\n"); gate.release();
  await assert.rejects(pending, /source|changed/i);
  const conflicted = f.service.get(f.id);
  assert.equal(conflicted.status, "conflicted"); assert.equal(conflicted.proposalDigest, checkpoint.proposalDigest);
  assert.equal(conflicted.contract?.status, "working"); assert.ok(conflicted.contract?.checkpoints.every(item => item.status === "stale"));
});

test("a no-op final approval rejects changed installed dependencies without claiming current proof", async t => {
  const f = fixture(t, true), checkpoint = await settled(f.service, f.id);
  await f.service.continueContract(f.id, checkpoint.proposalDigest!);
  put(f.root, "node_modules/trusted/index.js", "module.exports = 2;\n");
  await assert.rejects(f.service.approve(f.id, checkpoint.proposalDigest!), /dependencies changed/i);
  const conflicted = f.service.get(f.id);
  assert.equal(conflicted.status, "conflicted"); assert.equal(conflicted.contract?.status, "working");
  assert.ok(conflicted.contract?.checkpoints.every(item => item.status === "stale"));
  assert.equal(f.service.store.approved(f.id, checkpoint.proposalDigest!), false);
});

test("resume cannot launder an earlier out-of-scope edit into a client checkpoint", async t => {
  let turns = 0;
  const f = fixture(t, false, async input => {
    if (++turns === 1) put(input.cwd, "packages/database/src/outside.ts", "export const ownership = 'unexpected backend edit';\n");
    return { status: "completed" };
  });
  const before = readSourceManifest(f.root).digest;
  const first = await settled(f.service, f.id);
  assert.equal(first.status, "failed"); assert.match(first.summary!, /outside.*scope/i);
  f.service.resume(f.id);
  const resumed = await settled(f.service, f.id);
  assert.equal(resumed.status, "failed"); assert.match(resumed.summary!, /stage ownership/i);
  assert.equal(turns, 2); assert.equal(resumed.proposalDigest, undefined);
  assert.equal(readSourceManifest(f.root).digest, before);
});

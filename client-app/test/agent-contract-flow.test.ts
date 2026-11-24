import assert from "./support/assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { invalidateDependencyIdentity } from "aws-studio/contract-chain/dependencies";
import { AgentTaskService, type AgentServiceOptions } from "../server/agent-runtime/service";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import { prepareAgentWorkspace, readSourceManifest, type AgentWorkspace } from "aws-studio/source/workspace";
import type { CodingTask, CodingValidation, ContractRunMode } from "../shared/agent-runtime";
import { buildContractCodingContext, contractDecisions, type ContractDecision, type ContractStage } from "../shared/contract-propagation";
import { graphqlChainFixture } from "./support/graphql-chain";
import { candidateProofsFixture } from "./support/candidate-proof";
import { contractDecisionReportPath } from "../server/agent-runtime/contract-decision-report";
import { assertContractAppliedSource } from "../server/agent-runtime/contract-finalization";

const backend = "packages/database/src/projects.ts";
const client = "client-app/src/api/projects/operations.ts";
function put(root: string, file: string, text: string) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
const resolved = (decisions: readonly ContractDecision[]): ContractDecision[] => decisions.map(decision => ({ ...decision, status: "established", value: decision.kind === "exposure" ? "Withhold the new private field from the public API." : "Preserve the existing application behavior.", evidence: "Developer reviewed the source and existing Project behavior." }));
function stageIdentity(workspace: AgentWorkspace, stage: ContractStage): string {
  const manifest = readSourceManifest(workspace.workingDirectory);
  return createHash("sha256").update(JSON.stringify(Object.entries(manifest.files).filter(([name]) => stage !== "api" || !name.startsWith("client-app/")))).digest("hex");
}
function passingChecks(stage: ContractStage, digest: string): CodingValidation[] {
  const commands = ["database artifacts", "repository/API", ...(stage !== "api" ? ["Codegen"] : []), ...(stage === "client" ? ["React Query", "consumers", "integration"] : [])];
  return commands.map(command => ({ command: `contract: ${command}`, status: "passed", candidateDigest: digest }));
}
function fixture(t: TestContext, options: Partial<AgentServiceOptions> = {}) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-flow-"));
  const root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  put(root, "package.json", '{"name":"contract-fixture"}');
  put(root, backend, "export const owner = 'unchanged';\n");
  put(root, client, "export const keys = ['projects'];\n");
  put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
  const turns: string[] = [], validations: ContractStage[] = [], workspaces = new Set<string>(); let imports = 0;
  const runtimeOptions: AgentServiceOptions = {
    copyDependencies: false,
    canApplyRuntimeChanges: true,
    contractOrigin: async () => {},
    contractIdentity: async (workspace, stage) => stageIdentity(workspace, stage),
    runProvider: async input => { turns.push(input.prompt); workspaces.add(input.cwd); if (input.scratchDir) writeFileSync(contractDecisionReportPath(input.scratchDir), '{"status":"resolved"}'); return { status: "completed", sessionId: "retained-contract-session" }; },
    validateContract: async input => { validations.push(input.stage); const candidateDigest = readSourceManifest(input.workspace.workingDirectory).digest; return { proofs: await candidateProofsFixture(input), checks: passingChecks(input.stage, candidateDigest), inputDigest: stageIdentity(input.workspace, input.stage) }; },
    integrate: async (_workspace, proposal, digest) => { imports++; return integrateAgentProposal(proposal, digest); },
    ...options,
  };
  let service = new AgentTaskService(root, state, runtimeOptions);
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  service.start();
  const submit = (stage: ContractStage = "api", establishDecisions = true, contractRun?: ContractRunMode) => {
    const context = buildContractCodingContext(graphqlChainFixture(), stage);
    const decisions = establishDecisions ? resolved(contractDecisions("client", context.affected, context.decisions)) : context.decisions;
    return service.submit({ requestKey: `contract-${stage}-request`, provider: "codex", prompt: "Reconcile only the selected contract stage. Keep the private database field withheld.", contract: { ...context, decisions }, ...(contractRun ? { contractRun } : {}) });
  };
  return { root, state, get service() { return service; }, submit, turns, validations, workspaces, imports: () => imports,
    reopen: async () => { await service.close(); service = new AgentTaskService(root, state, runtimeOptions); service.start(); } };
}
async function settled(service: AgentTaskService, id: string): Promise<CodingTask> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const task = service.get(id);
    if (["awaiting_review", "failed", "conflicted", "interrupted", "cancelled", "completed"].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Contract task did not settle: ${JSON.stringify(service.get(id))}`);
}
async function advance(service: AgentTaskService, id: string) {
  const task = service.get(id);
  assert.equal(task.status, "awaiting_review", task.summary);
  await service.continueContract(id, task.proposalDigest!, resolved(task.contract!.decisions));
  return settled(service, id);
}

test("a sequential run checks API, deterministic Codegen and client in one candidate before explicit Apply", async t => {
  const f = fixture(t), before = readSourceManifest(f.root).digest, task = f.submit("api", true, "sequential");
  const current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(current.contract?.run, "sequential");
  assert.equal(current.contract?.stage, "client");
  assert.equal(current.contract?.status, "ready");
  assert.deepEqual(f.validations, ["api", "codegen", "client"]);
  assert.equal(f.turns.length, 2, "Codegen never invokes a model");
  assert.equal(f.workspaces.size, 1);
  assert.deepEqual(current.contract?.checkpoints.map(item => [item.stage, item.status]), [["api", "passed"], ["codegen", "passed"], ["client", "passed"]]);
  assert.equal(f.imports(), 0);
  assert.equal(readSourceManifest(f.root).digest, before, "sequential execution neither applies source nor records saved reviews");
});

test("a no-diff stage run finalizes only the requested saved-source approval", async t => {
  const completed: ContractStage[][] = [];
  const f = fixture(t, { finalizeContract: async (_workspace, proposal, stages) => { assert.equal(proposal.changes.length, 0); completed.push([...stages]); } });
  const task = f.submit("api", true, "stage");
  for (let i = 0; i < 400 && f.service.get(task.id).contract?.approval?.status !== "approved"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const current = f.service.get(task.id);
  assert.equal(current.status, "completed", current.summary);
  assert.equal(current.contract?.approval?.status, "approved", current.contract?.gateReason);
  assert.deepEqual(completed, [["api"]]);
  assert.equal(f.imports(), 0, "unchanged source requires no integration");
  await f.service.approve(task.id, current.proposalDigest!);
  assert.equal(completed.length, 1, "duplicate approval does not rerun finalization");
});

test("saved-source finalization failure stays visible and never reports approved", async t => {
  const f = fixture(t, { finalizeContract: async () => { throw new Error("Saved source changed after application"); } });
  const task = f.submit("api", true, "stage");
  for (let i = 0; i < 400 && f.service.get(task.id).contract?.approval?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const current = f.service.get(task.id);
  assert.equal(current.contract?.approval?.status, "failed", current.summary);
  assert.match(current.contract?.gateReason ?? "", /Saved source changed/);
  assert.equal(f.imports(), 0);
});

test("an applied stage retries failed approval once without repeating the agent or applying twice", async t => {
  let attempts = 0, turns = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; setTimeout(resolve, 4000).unref(); });
  const f = fixture(t, {
    runProvider: async input => { turns++; put(input.cwd, backend, "export const owner = 'updated';\n"); writeFileSync(contractDecisionReportPath(input.scratchDir!), '{"status":"resolved"}'); return { status: "completed" }; },
    finalizeContract: async (workspace, proposal) => { assertContractAppliedSource(workspace, proposal); if (++attempts === 1) throw new Error("Temporary check failure"); await wait; },
  });
  const task = f.submit("api", true, "stage");
  for (let i = 0; i < 400 && f.service.get(task.id).contract?.approval?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const applied = f.service.get(task.id);
  assert.equal(applied.contract?.approval?.status, "failed");
  await Promise.all([f.service.approve(task.id, applied.proposalDigest!), f.service.approve(task.id, applied.proposalDigest!)]);
  for (let i = 0; i < 100 && attempts !== 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(attempts, 2); assert.equal(turns, 1); assert.equal(f.imports(), 1);
  await assert.rejects(f.service.cleanup(task.id), /idle/);
  release();
  for (let i = 0; i < 100 && f.service.get(task.id).contract?.approval?.status !== "approved"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.service.get(task.id).contract?.approval?.status, "approved");
});

test("approval retry tolerates its receipt publication but refuses any later authored change", async t => {
  let attempts = 0;
  const f = fixture(t, { finalizeContract: async (workspace, proposal) => {
    assertContractAppliedSource(workspace, proposal); attempts++;
    if (attempts === 1) { put(workspace.repositoryRoot, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n\n'); throw new Error("Interrupted after receipt publication"); }
  } });
  const task = f.submit("api", true, "stage");
  for (let i = 0; i < 400 && f.service.get(task.id).contract?.approval?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await f.reopen();
  await f.service.approve(task.id, f.service.get(task.id).proposalDigest!);
  for (let i = 0; i < 100 && f.service.get(task.id).contract?.approval?.status !== "approved"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.service.get(task.id).contract?.approval?.status, "approved"); assert.equal(attempts, 2);
  const current = f.service.get(task.id);
  f.service.store.patch(task.id, {}, { contract: { ...current.contract!, approval: { status: "checking", message: "Interrupted" } } });
  await f.reopen();
  assert.equal(f.service.get(task.id).contract?.approval?.status, "failed", "a restarted host exposes an interrupted approval for retry");
  put(f.root, client, "// changed after apply\n");
  await f.service.approve(task.id, current.proposalDigest!);
  for (let i = 0; i < 100 && f.service.get(task.id).contract?.approval?.status !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.service.get(task.id).contract?.approval?.message ?? "", /Saved source changed/);
  assert.equal(attempts, 2); assert.equal(f.imports(), 0); assert.equal(f.turns.length, 1);
});

test("a native decision blocker pauses sequential execution even when independent checks pass", async t => {
  const decisionId = buildContractCodingContext(graphqlChainFixture(), "api").decisions[0]!.id;
  let turns = 0;
  const f = fixture(t, { runProvider: async input => {
    turns++;
    assert.match(input.prompt, /contract-decision-report\.json/);
    writeFileSync(contractDecisionReportPath(input.scratchDir!), JSON.stringify(turns === 1 ? { status: "needs-decision", decisions: [{ id: decisionId, reason: "Should the changed field remain private or retain its previous public exposure?" }] } : { status: "resolved" }));
    return { status: "completed" };
  } });
  const task = f.submit("api", true, "sequential"), blocked = await settled(f.service, task.id);
  assert.equal(blocked.status, "awaiting_review", blocked.summary);
  assert.equal(blocked.contract?.stage, "api");
  assert.equal(blocked.contract?.status, "checkpoint");
  assert.equal(blocked.contract?.checkpoints[0]?.status, "passed", "passing tests do not resolve application intent");
  assert.equal(blocked.contract?.decisions.find(item => item.id === decisionId)?.status, "unresolved");
  assert.match(blocked.contract?.gateReason ?? "", /changed field remain private/);
  assert.deepEqual(f.validations, ["api"]);
  assert.equal(turns, 1);
  await f.service.continueContract(task.id, blocked.proposalDigest!, resolved(blocked.contract!.decisions));
  const final = await settled(f.service, task.id);
  assert.equal(final.contract?.status, "ready", final.summary);
  assert.deepEqual(f.validations, ["api", "api", "codegen", "client"]);
  assert.equal(turns, 3, "explicit new intent reruns its owning stage before continuing");
  assert.equal(f.imports(), 0);
});

test("missing or malformed native decision reports fail before validation and require explicit resume", async t => {
  for (const report of [undefined, '{"status":"resolved","invented":true}'] as const) await t.test(report ? "malformed" : "missing", async child => {
    let turns = 0;
    const f = fixture(child, { runProvider: async input => {
      turns++;
      if (turns > 1 || report) writeFileSync(contractDecisionReportPath(input.scratchDir!), turns > 1 ? '{"status":"resolved"}' : report!);
      return { status: "completed" };
    } });
    const task = f.submit("api", true, "sequential"), failed = await settled(f.service, task.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.summary ?? "", /valid contract decision report.*Resume/i);
    assert.deepEqual(f.validations, []);
    assert.equal(turns, 1);
    f.service.resume(task.id);
    const final = await settled(f.service, task.id);
    assert.equal(final.contract?.status, "ready", final.summary);
    assert.deepEqual(f.validations, ["api", "codegen", "client"]);
    assert.equal(f.imports(), 0);
  });
});

test("client intent blockers preserve the current API predecessor and pause at an editable client checkpoint", async t => {
  const decisionId = contractDecisions("client", [])[0]!.id; let turns = 0;
  const f = fixture(t, { runProvider: async input => {
    turns++;
    writeFileSync(contractDecisionReportPath(input.scratchDir!), JSON.stringify(turns === 2 ? { status: "needs-decision", decisions: [{ id: decisionId, reason: "Which replacement selection preserves this consumer's existing behavior?" }] } : { status: "resolved" }));
    return { status: "completed" };
  } });
  const task = f.submit("api", true, "sequential"), current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(current.contract?.stage, "client");
  assert.equal(current.contract?.status, "checkpoint");
  assert.equal(current.contract?.checkpoints.find(item => item.stage === "api")?.status, "passed");
  assert.equal(current.contract?.checkpoints.find(item => item.stage === "client")?.status, "passed");
  assert.match(current.contract?.gateReason ?? "", /replacement selection/);
  assert.equal(current.contract?.decisions.find(item => item.id === decisionId)?.status, "unresolved");
  await f.service.continueContract(task.id, current.proposalDigest!, resolved(current.contract!.decisions));
  const final = await settled(f.service, task.id);
  assert.equal(final.contract?.status, "ready", final.summary);
  assert.deepEqual(f.validations, ["api", "codegen", "client", "client"]);
  assert.equal(turns, 3);
  assert.equal(f.imports(), 0);
});

test("a previous native decision report cannot satisfy a later client turn", async t => {
  let turns = 0;
  const f = fixture(t, { runProvider: async input => {
    turns++;
    const file = contractDecisionReportPath(input.scratchDir!);
    assert.equal(existsSync(file), false, "the host clears the prior report before each native turn");
    if (turns === 1) writeFileSync(file, '{"status":"resolved"}');
    return { status: "completed" };
  } });
  const task = f.submit("api", true, "sequential"), current = await settled(f.service, task.id);
  assert.equal(current.status, "failed");
  assert.equal(current.contract?.stage, "client");
  assert.match(current.summary ?? "", /contract decision report/);
  assert.deepEqual(f.validations, ["api", "codegen"], "deterministic Codegen needs no model decision report");
  assert.equal(turns, 2);
  assert.equal(f.imports(), 0);
});

test("stage mode is independently ready to apply and sequential continuation can reuse that candidate", async t => {
  const f = fixture(t), task = f.submit("api", true, "stage"), api = await settled(f.service, task.id);
  assert.equal(api.contract?.stage, "api");
  assert.equal(api.contract?.status, "ready");
  assert.deepEqual(f.validations, ["api"]);
  const workspace = f.service.store.get(task.id)?.workspaceDirectory;
  await f.service.continueContract(task.id, api.proposalDigest!, undefined, "sequential");
  const final = await settled(f.service, task.id);
  assert.equal(final.contract?.status, "ready", final.summary);
  assert.equal(final.contract?.run, "sequential");
  assert.deepEqual(f.validations, ["api", "codegen", "client"]);
  assert.equal(f.service.store.get(task.id)?.workspaceDirectory, workspace);
  assert.equal(f.imports(), 0);
});

test("sequential execution pauses on unresolved current or next-stage decisions", async t => {
  await t.test("current decisions", async child => {
    const f = fixture(child), task = f.submit("api", false, "sequential"), current = await settled(f.service, task.id);
    assert.equal(current.contract?.stage, "api");
    assert.equal(current.contract?.status, "checkpoint");
    assert.match(current.contract?.gateReason ?? "", /explicit application decisions/);
    assert.deepEqual(f.validations, ["api"]);
    assert.equal(f.turns.length, 1);
    await f.service.continueContract(task.id, current.proposalDigest!, resolved(current.contract!.decisions));
    const renewed = await settled(f.service, task.id);
    assert.equal(renewed.contract?.stage, "codegen", renewed.summary);
    assert.deepEqual(f.validations, ["api", "api", "codegen"], "new decisions renew their owning checkpoint before sequential work continues");
    assert.equal(f.imports(), 0);
  });
  await t.test("next-stage decisions", async child => {
    const f = fixture(child), context = buildContractCodingContext(graphqlChainFixture(), "api");
    const task = f.service.submit({ requestKey: "sequential-api-choices-only", provider: "codex", prompt: "Preserve the existing API.", contract: { ...context, decisions: resolved(context.decisions) }, contractRun: "sequential" });
    const current = await settled(f.service, task.id);
    assert.equal(current.contract?.stage, "codegen");
    assert.equal(current.contract?.status, "checkpoint");
    assert.match(current.contract?.gateReason ?? "", /next stage needs explicit/);
    assert.deepEqual(f.validations, ["api", "codegen"]);
    assert.equal(f.turns.length, 1);
    assert.equal(f.imports(), 0);
  });
});

test("sequential runs stop on failed validation without retrying later stages", async t => {
  for (const status of ["failed", "unavailable"] as const) await t.test(status, async child => {
    const stages: ContractStage[] = [];
    const f = fixture(child, { validateContract: async input => {
      stages.push(input.stage);
      return { proofs: await candidateProofsFixture(input), inputDigest: stageIdentity(input.workspace, input.stage), checks: [{ command: "contract: independent check", status, candidateDigest: readSourceManifest(input.workspace.workingDirectory).digest }] };
    } });
    const task = f.submit("api", true, "sequential"), current = await settled(f.service, task.id);
    assert.equal(current.contract?.stage, "api");
    assert.notEqual(current.contract?.status, "ready");
    assert.deepEqual(stages, ["api"]);
    assert.equal(f.turns.length, 1);
    assert.equal(f.imports(), 0);
  });
});

test("cancellation and saved-source edits stop sequential continuation before downstream work", async t => {
  for (const action of ["cancel", "edit"] as const) await t.test(action, async child => {
    const f = fixture(child);
    const unsubscribe = f.service.subscribe(event => {
      if (event.type !== "diagnostic" || (event.data.contractCheckpoint as { stage?: string } | undefined)?.stage !== "api") return;
      if (action === "cancel") f.service.cancel(event.taskId);
      else put(f.root, backend, "export const owner = 'developer edit';\n");
    });
    const task = f.submit("api", true, "sequential"), current = await settled(f.service, task.id);
    unsubscribe();
    assert.equal(current.status, action === "cancel" ? "cancelled" : "conflicted", current.summary);
    assert.deepEqual(f.validations, ["api"]);
    assert.equal(f.turns.length, 1);
    assert.equal(f.imports(), 0);
    if (action === "edit") assert.match(readFileSync(path.join(f.root, backend), "utf8"), /developer edit/);
  });
});

test("a deliberate private-field no-op retains one candidate, explicit decisions and one final application boundary", async t => {
  const f = fixture(t), before = readSourceManifest(f.root).digest, task = f.submit();
  assert.equal(f.submit().id, task.id, "retries reuse the existing task");
  let current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(current.contract?.stage, "api");
  await assert.rejects(f.service.approve(task.id, current.proposalDigest!), /contract|stage|decision|checkpoint/i);
  const apiDecisions = resolved(current.contract!.decisions);
  current = await advance(f.service, task.id);
  assert.equal(current.contract?.stage, "codegen");
  assert.deepEqual(current.contract?.decisions, apiDecisions);
  current = await advance(f.service, task.id);
  assert.equal(current.contract?.stage, "client");
  for (const decision of apiDecisions) assert.deepEqual(current.contract?.decisions.find(item => item.id === decision.id), decision);
  current = await advance(f.service, task.id);
  assert.equal(current.contract?.status, "ready");
  assert.equal(f.workspaces.size, 1);
  assert.equal(f.turns.length, 2, "Codegen does not invoke a model");
  assert.ok(f.turns[1]!.indexOf("Current contract assignment") > f.turns[1]!.indexOf("Developer request at task creation"));
  assert.match(f.turns[1]!, /Own only the Client operations contract stage/);
  assert.match(f.turns[1]!, /Keep the private database field withheld/, "application intent survives stage reassignment");
  assert.deepEqual(f.validations, ["api", "codegen", "client"]);
  assert.equal(f.imports(), 0);
  assert.equal(readSourceManifest(f.root).digest, before, "candidate confidence never edits or acknowledges saved source");
  await f.service.approve(task.id, current.proposalDigest!);
  const final = await settled(f.service, task.id);
  assert.equal(final.status, "completed"); assert.equal(final.sourceOutcome, "unchanged");
  assert.equal(readSourceManifest(f.root).digest, before); assert.equal(f.imports(), 0);
});

test("a verified API predecessor permits a client-focused task without repeating backend agent work", async t => {
  const f = fixture(t), task = f.submit("client");
  let current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(current.contract?.stage, "client");
  assert.equal(f.turns.length, 1); assert.deepEqual(f.validations, ["client"]);
  current = await advance(f.service, task.id);
  assert.equal(current.contract?.status, "ready");
  assert.equal(f.imports(), 0);
});

test("failed, unavailable and missing candidate validation cannot advance or apply", async t => {
  for (const status of ["failed", "unavailable", "missing"] as const) await t.test(status, async child => {
    const f = fixture(child, { validateContract: async input => {
      const digest = readSourceManifest(input.workspace.workingDirectory).digest;
      return { proofs: await candidateProofsFixture(input), inputDigest: stageIdentity(input.workspace, input.stage), checks: status === "missing" ? [] : [{ command: "contract: required independent checks", status, candidateDigest: digest, detail: "Required checks did not pass." }] };
    } });
    const task = f.submit(), current = await settled(f.service, task.id);
    if (current.status === "awaiting_review") {
      await assert.rejects(f.service.continueContract(task.id, current.proposalDigest!, resolved(current.contract!.decisions)), /validat|check|pass|evidence/i);
      await assert.rejects(f.service.approve(task.id, current.proposalDigest!), /validat|check|pass|contract|stage/i);
    } else assert.equal(current.status, "failed");
    assert.equal(f.imports(), 0); assert.match(readFileSync(path.join(f.root, backend), "utf8"), /unchanged/);
  });
});

test("stale continuation and a concurrent developer edit refuse source writes", async t => {
  const f = fixture(t), task = f.submit(), current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  await assert.rejects(f.service.continueContract(task.id, "obsolete-proposal", resolved(current.contract!.decisions)), /current|digest|proposal/i);
  put(f.root, backend, "export const owner = 'developer edit';\n");
  await assert.rejects(f.service.continueContract(task.id, current.proposalDigest!, resolved(current.contract!.decisions)), /source|changed|refresh/i);
  assert.equal(f.imports(), 0); assert.match(readFileSync(path.join(f.root, backend), "utf8"), /developer edit/);
});

test("agent-authored review acceptance is rejected with zero authoritative writes", async t => {
  const f = fixture(t, { runProvider: async input => { put(input.cwd, "graphql-chain.review.json", '{"version":2,"forged":true}\n'); return { status: "completed" }; } });
  const before = readSourceManifest(f.root).digest, task = f.submit(), current = await settled(f.service, task.id);
  assert.equal(current.status, "failed"); assert.match(current.summary!, /review|record/i);
  assert.equal(readSourceManifest(f.root).digest, before); assert.equal(f.imports(), 0);
});

test("a changed candidate predecessor cannot reuse an earlier successful checkpoint", async t => {
  let turn = 0;
  const f = fixture(t, { runProvider: async input => { turn++; if (turn > 1) put(input.cwd, backend, "export const owner = 'unexpected backend change';\n"); return { status: "completed" }; } });
  const task = f.submit(); await settled(f.service, task.id);
  await advance(f.service, task.id); await advance(f.service, task.id);
  const current = f.service.get(task.id);
  assert.notEqual(current.contract?.status, "ready");
  if (current.status === "awaiting_review") await assert.rejects(f.service.approve(task.id, current.proposalDigest!), /contract|predecessor|checkpoint|stage|validat/i);
  else { assert.equal(current.status, "failed"); assert.match(current.summary!, /contract|predecessor|checkpoint|stage|scope|API|source/i); }
  assert.equal(f.imports(), 0); assert.match(readFileSync(path.join(f.root, backend), "utf8"), /unchanged/);
});

test("host restart retains historical proof and requires independent refresh before continuing", async t => {
  const f = fixture(t), task = f.submit();
  const checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.status, "awaiting_review", checkpoint.summary);
  const workspace = f.service.store.get(task.id)!.workspaceDirectory;
  await f.reopen();
  const restored = f.service.get(task.id);
  assert.equal(restored.proposalDigest, checkpoint.proposalDigest);
  assert.deepEqual(restored.contract?.decisions, checkpoint.contract?.decisions);
  assert.deepEqual(restored.contract?.proofs, checkpoint.contract?.proofs);
  assert.equal(restored.contract?.status, "working");
  assert.ok(restored.contract?.checkpoints.every(item => item.status === "stale"));
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, workspace);
  assert.equal(f.turns.length, 1); assert.deepEqual(f.validations, ["api"]);
  await assert.rejects(advance(f.service, task.id), /historical|Refresh|proof/i);
  f.service.refresh(task.id, restored.proposalDigest!);
  const checked = await settled(f.service, task.id);
  assert.equal(checked.contract?.checkpoints[0]?.status, "passed", checked.summary);
  await advance(f.service, task.id);
  assert.equal(f.service.get(task.id).contract?.stage, "codegen");
  assert.equal(f.turns.length, 1, "independent refresh and deterministic continuation do not replay completed agent work");
  assert.equal(f.imports(), 0);
});

test("an unresolvable originating revision fails before provider execution or source writes", async t => {
  const f = fixture(t, { contractOrigin: async () => { throw new Error("Saved contract source changed. Check again."); } });
  const before = readSourceManifest(f.root).digest, task = f.submit(), current = await settled(f.service, task.id);
  assert.equal(current.status, "failed"); assert.match(current.summary!, /source changed/);
  assert.equal(f.turns.length, 0); assert.equal(f.validations.length, 0); assert.equal(f.imports(), 0);
  assert.equal(readSourceManifest(f.root).digest, before);
});

test("concurrent continuation requests advance once and retain the final explicit application boundary", async t => {
  const f = fixture(t), task = f.submit(), checkpoint = await settled(f.service, task.id);
  const outcomes = await Promise.allSettled([
    f.service.continueContract(task.id, checkpoint.proposalDigest!, resolved(checkpoint.contract!.decisions)),
    f.service.continueContract(task.id, checkpoint.proposalDigest!, resolved(checkpoint.contract!.decisions)),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  const current = await settled(f.service, task.id);
  assert.equal(current.contract?.stage, "codegen");
  assert.deepEqual(f.validations, ["api", "codegen"]); assert.equal(f.turns.length, 1);
  assert.equal(f.imports(), 0);
});

test("new developer choices rerun their owning stage before dependent work can advance", async t => {
  const f = fixture(t), task = f.submit("api", false);
  let checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.contract?.stage, "api");
  const choices = resolved(checkpoint.contract!.decisions);
  await f.service.continueContract(task.id, checkpoint.proposalDigest!, choices);
  checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.contract?.stage, "api", "a post-validation choice is not implementation evidence");
  assert.equal(f.turns.length, 2);
  assert.deepEqual(f.validations, ["api", "api"]);
  assert.match(f.turns[1]!, /Withhold the new private field/);
  await f.service.continueContract(task.id, checkpoint.proposalDigest!, choices);
  checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.contract?.stage, "codegen");
  assert.equal(f.turns.length, 2, "identical validated decisions never create an automatic retry loop");
  assert.equal(f.imports(), 0);
});

test("an API decision changed at the client checkpoint rewinds API and invalidates downstream proof", async t => {
  const f = fixture(t), task = f.submit(); await settled(f.service, task.id); await advance(f.service, task.id); await advance(f.service, task.id);
  const clientCheckpoint = f.service.get(task.id);
  const decisions = clientCheckpoint.contract!.decisions.map(item => item.kind === "ownership" ? { ...item, value: "Preserve current owner filters and additionally require the reviewed tenant boundary." } : item);
  await f.service.continueContract(task.id, clientCheckpoint.proposalDigest!, decisions);
  const renewed = await settled(f.service, task.id);
  assert.equal(renewed.contract?.stage, "api");
  assert.equal(renewed.contract?.checkpoints.find(item => item.stage === "client")?.status, "stale");
  assert.notEqual(renewed.contract?.proofs?.api?.id, clientCheckpoint.contract?.proofs?.api?.id);
  assert.ok(f.turns.at(-1)?.includes("Repository and API contract stage"));
  assert.equal(f.imports(), 0);
});

test("passing flags without compatible candidate receipts cannot create a current checkpoint", async t => {
  const f = fixture(t, { validateContract: async input => ({ inputDigest: stageIdentity(input.workspace, input.stage), checks: passingChecks(input.stage, readSourceManifest(input.workspace.workingDirectory).digest) }) });
  const before = readSourceManifest(f.root).digest, task = f.submit(), current = await settled(f.service, task.id);
  assert.equal(current.status, "failed"); assert.match(current.summary!, /proof|receipts/i);
  assert.equal(readSourceManifest(f.root).digest, before); assert.equal(f.imports(), 0);
});

test("unavailable contract validation permits explicit repair without automatic retry or advancement", async t => {
  let attempts = 0;
  const f = fixture(t, { validateContract: async input => ({ proofs: await candidateProofsFixture(input), inputDigest: stageIdentity(input.workspace, input.stage), checks: ++attempts === 1
    ? [{ command: "contract: required checks", status: "unavailable", candidateDigest: readSourceManifest(input.workspace.workingDirectory).digest, detail: "Authored document evidence needs source repair." }]
    : passingChecks(input.stage, readSourceManifest(input.workspace.workingDirectory).digest) }) });
  const before = readSourceManifest(f.root).digest, task = f.submit(), unavailable = await settled(f.service, task.id);
  assert.equal(unavailable.contract?.checkpoints[0]?.status, "unavailable"); assert.equal(unavailable.canResumeValidation, true); assert.equal(attempts, 1); assert.equal(f.turns.length, 1);
  await assert.rejects(f.service.continueContract(task.id, unavailable.proposalDigest!), /unavailable|validation/i);
  await assert.rejects(f.service.approve(task.id, unavailable.proposalDigest!), /validation|pass|contract/i);
  f.service.store.patch(task.id, {}, { canResumeValidation: false });
  f.service.resume(task.id);
  const repaired = await settled(f.service, task.id);
  assert.equal(repaired.contract?.stage, "api"); assert.equal(repaired.contract?.checkpoints[0]?.status, "passed"); assert.equal(f.turns.length, 2); assert.equal(attempts, 2);
  assert.equal(readSourceManifest(f.root).digest, before); assert.equal(f.imports(), 0);
});

test("persisted ready flags cannot bypass missing current execution authority", async t => {
  const f = fixture(t), task = f.submit("client"), checkpoint = await settled(f.service, task.id);
  await f.service.continueContract(task.id, checkpoint.proposalDigest!); await f.reopen();
  const historical = f.service.get(task.id);
  f.service.store.patch(task.id, {}, { contract: { ...historical.contract!, status: "ready", checkpoints: historical.contract!.checkpoints.map(item => ({ ...item, status: "passed" })) } });
  await assert.rejects(f.service.approve(task.id, historical.proposalDigest!), /historical|proof|Refresh/i);
  assert.equal(f.service.store.approved(task.id, historical.proposalDigest!), false); assert.equal(f.imports(), 0);
});

test("one final proposal applies all validated stages without accepting saved-source reviews", async t => {
  let turn = 0;
  const f = fixture(t, { runProvider: async input => {
    turn++;
    put(input.cwd, turn === 1 ? backend : client, turn === 1 ? "export const owner = 'reconciled';\n" : "export const keys = ['projects', 'list'];\n");
    return { status: "completed", sessionId: "retained-contract-session" };
  } });
  const record = readFileSync(path.join(f.root, "graphql-chain.review.json"), "utf8"), task = f.submit();
  await settled(f.service, task.id); await advance(f.service, task.id); await advance(f.service, task.id);
  const ready = await advance(f.service, task.id);
  assert.equal(ready.contract?.status, "ready");
  const proposal = f.service.proposal(task.id);
  assert.deepEqual(proposal.changes.map(change => change.path).sort(), [client, backend].sort());
  assert.match(readFileSync(path.join(f.root, backend), "utf8"), /unchanged/);
  await f.service.approve(task.id, proposal.digest);
  const final = await settled(f.service, task.id);
  assert.equal(final.status, "completed"); assert.equal(final.sourceOutcome, "applied");
  assert.equal(final.contract?.status, "applied-awaiting-check");
  assert.match(readFileSync(path.join(f.root, backend), "utf8"), /reconciled/);
  assert.match(readFileSync(path.join(f.root, client), "utf8"), /list/);
  assert.equal(readFileSync(path.join(f.root, "graphql-chain.review.json"), "utf8"), record);
  assert.equal(f.imports(), 1);
});

test("explicit new decisions can repair a failed owning stage without advancing failed evidence", async t => {
  let checks = 0;
  const f = fixture(t, { validateContract: async input => {
    checks++;
    const digest = readSourceManifest(input.workspace.workingDirectory).digest;
    return { proofs: await candidateProofsFixture(input), inputDigest: stageIdentity(input.workspace, input.stage), checks: checks === 1
      ? [{ command: "contract: API behavior", status: "failed", candidateDigest: digest, detail: "Requested behavior remains unresolved." }]
      : passingChecks(input.stage, digest) };
  } });
  const task = f.submit("api", false); let checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.contract?.checkpoints[0]?.status, "failed");
  await f.service.continueContract(task.id, checkpoint.proposalDigest!, resolved(checkpoint.contract!.decisions));
  checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.contract?.stage, "api");
  assert.equal(checkpoint.contract?.checkpoints[0]?.status, "passed");
  assert.equal(f.turns.length, 2); assert.equal(f.imports(), 0);
});

test("refresh rewinds to a changed API predecessor and preserves retained client work and decisions", async t => {
  let turn = 0;
  const f = fixture(t, { runProvider: async input => {
    turn++;
    if (turn === 2) put(input.cwd, client, "export const keys = ['retained-client-work'];\n");
    return { status: "completed", sessionId: "retained-contract-session" };
  } });
  const task = f.submit(); await settled(f.service, task.id); await advance(f.service, task.id); await advance(f.service, task.id);
  const checkpoint = f.service.get(task.id), decisions = checkpoint.contract!.decisions;
  assert.equal(checkpoint.contract?.stage, "client");
  put(f.root, backend, "export const owner = 'new developer backend';\n");
  f.service.refresh(task.id, checkpoint.proposalDigest!);
  const refreshed = await settled(f.service, task.id);
  assert.equal(refreshed.status, "awaiting_review", refreshed.summary);
  assert.equal(refreshed.contract?.stage, "api");
  assert.deepEqual(refreshed.contract?.decisions, decisions);
  const candidate = path.join(f.service.store.get(task.id)!.workspaceDirectory!, "working");
  assert.match(readFileSync(path.join(candidate, client), "utf8"), /retained-client-work/);
  assert.match(readFileSync(path.join(candidate, backend), "utf8"), /new developer backend/);
  assert.equal(refreshed.contract?.checkpoints.find(item => item.stage === "client")?.status, "stale", "old client proof is retained only as history");
  assert.match(readFileSync(path.join(f.root, client), "utf8"), /projects/);
  assert.equal(f.imports(), 0);
});

test("a source edit during execution retains an unverified conflict proposal for explicit refresh", async t => {
  let turn = 0;
  const f = fixture(t, { runProvider: async input => {
    turn++;
    if (turn === 1) {
      put(input.cwd, backend, "export const owner = 'candidate work';\n");
      put(f.root, "developer.txt", "concurrent developer work\n");
    }
    return { status: "completed" };
  } });
  const task = f.submit(), conflicted = await settled(f.service, task.id);
  assert.equal(conflicted.status, "conflicted", conflicted.summary);
  assert.ok(conflicted.proposalDigest); assert.equal(f.imports(), 0);
  assert.match(readFileSync(path.join(f.root, backend), "utf8"), /unchanged/);
  await assert.rejects(f.service.approve(task.id, conflicted.proposalDigest!), /validat|contract|check|stage|review/i);
  f.service.refresh(task.id, conflicted.proposalDigest!);
  const refreshed = await settled(f.service, task.id);
  assert.equal(refreshed.status, "awaiting_review", refreshed.summary);
  assert.equal(refreshed.contract?.stage, "api");
  assert.equal(readFileSync(path.join(f.root, "developer.txt"), "utf8"), "concurrent developer work\n");
  assert.equal(f.imports(), 0);
});

test("direct client tasks rewind after an API change even without an earlier candidate API checkpoint", async t => {
  let turn = 0;
  const f = fixture(t, { runProvider: async input => { turn++; if (turn === 1) put(input.cwd, client, "export const keys = ['retained'];\n"); return { status: "completed" }; } });
  const task = f.submit("client"), checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.contract?.checkpoints.some(item => item.stage === "api"), false);
  put(f.root, backend, "export const owner = 'new backend';\n");
  f.service.refresh(task.id, checkpoint.proposalDigest!);
  const refreshed = await settled(f.service, task.id);
  assert.equal(refreshed.status, "awaiting_review", refreshed.summary); assert.equal(refreshed.contract?.stage, "api");
  const candidate = path.join(f.service.store.get(task.id)!.workspaceDirectory!, "working");
  assert.match(readFileSync(path.join(candidate, client), "utf8"), /retained/); assert.equal(f.imports(), 0);
});

test("refresh discovers new decision targets while retaining immutable request history", async t => {
  const delta = { surface: "prisma" as const, subject: "Project", path: "Project.privateNote", change: "added" as const, before: null, after: "String?" };
  const f = fixture(t, { contractRefreshContext: async (_root, stage, decisions, previous) => ({ ...previous, stage, sourceRevision: "refreshed-source-revision", affected: [delta], decisions: contractDecisions(stage, [delta], decisions) }) });
  const task = f.submit(), checkpoint = await settled(f.service, task.id);
  const original = f.service.store.get(task.id)!.request.contract;
  put(f.root, backend, "export const owner = 'new developer backend';\n");
  f.service.refresh(task.id, checkpoint.proposalDigest!);
  const refreshed = await settled(f.service, task.id);
  assert.equal(refreshed.status, "awaiting_review", refreshed.summary);
  assert.equal(refreshed.contract?.context.sourceRevision, "refreshed-source-revision");
  assert.ok(refreshed.contract?.decisions.some(item => item.target === delta.path && item.status === "unresolved"));
  assert.deepEqual(f.service.store.get(task.id)!.request.contract, original);
  assert.equal(f.imports(), 0);
});


test("failed origin admission retains the completed copy and is rechecked after explicit resume and host restart", async t => {
  let attempts = 0;
  const f = fixture(t, { contractOrigin: async () => { if (++attempts < 3) throw new Error("Fixture origin unavailable"); } });
  const task = f.submit("api", true, "sequential");
  assert.equal((await settled(f.service, task.id)).status, "failed");
  const workspace = f.service.store.get(task.id)!.workspaceDirectory!;
  assert.equal(existsSync(path.join(workspace, "workspace.json")), true);
  assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
  f.service.resume(task.id);
  assert.equal((await settled(f.service, task.id)).status, "failed");
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, workspace);
  assert.equal(f.turns.length, 0); assert.equal(f.validations.length, 0);
  f.service.store.resume(task.id);
  f.service.store.transition(task.id, "preparing"); // Host interruption after capture, before admission.
  await f.reopen();
  assert.equal(f.service.get(task.id).status, "interrupted");
  assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
  f.service.resume(task.id);
  const ready = await settled(f.service, task.id);
  assert.equal(ready.contract?.status, "ready", ready.summary);
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, workspace);
  assert.equal(f.service.store.get(task.id)!.contractOriginPending, undefined);
  assert.equal(attempts, 3, "admission is repeated until success, not for admitted downstream checkpoints");
  assert.deepEqual(f.validations, ["api", "codegen", "client"]);
  assert.equal(f.imports(), 0);
});

test("changed saved source after failed admission retains a conflict and cannot start the provider", async t => {
  let attempts = 0;
  const f = fixture(t, { contractOrigin: async () => { attempts++; throw new Error("Fixture origin unavailable"); } });
  const task = f.submit(); await settled(f.service, task.id);
  const workspace = f.service.store.get(task.id)!.workspaceDirectory;
  put(f.root, backend, "export const owner = 'new saved source';\n");
  f.service.resume(task.id);
  const conflicted = await settled(f.service, task.id);
  assert.equal(conflicted.status, "conflicted", conflicted.summary);
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, workspace);
  assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
  assert.ok(conflicted.proposalDigest, "the completed candidate remains inspectable for Refresh");
  assert.equal(attempts, 1, "the cheap exact baseline check precedes another full origin inspection");
  assert.equal(f.turns.length, 0); assert.equal(f.imports(), 0);
});

test("a completed unrecorded contract capture is adopted only as pending admission", async t => {
  for (const changed of [false, true]) await t.test(changed ? "changed saved source retains conflict" : "unchanged source reuses copy", async child => {
    let origins = 0;
    const f = fixture(child, { contractOrigin: async () => { origins++; } });
    const context = buildContractCodingContext(graphqlChainFixture(), "api");
    const task = f.service.store.accept({ requestKey: "unrecorded-contract-capture", provider: "codex", prompt: "Reconcile the API stage.", contract: { ...context, decisions: resolved(context.decisions) } });
    const captured = await prepareAgentWorkspace(f.root, { storageDirectory: path.join(f.state, "workspaces"), taskId: task.id, copyDependencies: false });
    f.service.store.transition(task.id, "preparing");
    f.service.store.transition(task.id, "interrupted");
    if (changed) put(f.root, backend, "export const owner = 'new saved source';\n");
    f.service.resume(task.id);
    const current = await settled(f.service, task.id);
    assert.equal(f.service.store.get(task.id)!.workspaceDirectory, captured.directory);
    assert.equal(current.status, changed ? "conflicted" : "awaiting_review", current.summary);
    assert.equal(origins, changed ? 0 : 1);
    assert.equal(f.turns.length, changed ? 0 : 1);
    assert.equal(f.imports(), 0);
  });
});

test("refreshing a capture with pending admission still checks its current origin", async t => {
  for (const succeeds of [false, true]) await t.test(succeeds ? "admitted refreshed copy" : "origin still unavailable", async child => {
    let origins = 0;
    const f = fixture(child, {
      contractOrigin: async (_root, context) => { origins++; if (origins === 1 || !succeeds) throw new Error("Fixture origin unavailable"); assert.equal(context.sourceRevision, "1".repeat(64)); },
      contractRefreshContext: async (_root, _stage, _decisions, previous) => ({ ...previous, sourceRevision: "1".repeat(64) }),
    });
    const task = f.submit(); await settled(f.service, task.id);
    put(f.root, backend, "export const owner = 'new saved source';\n");
    f.service.resume(task.id);
    const conflicted = await settled(f.service, task.id);
    assert.equal(conflicted.status, "conflicted", conflicted.summary);
    f.service.refresh(task.id, conflicted.proposalDigest!);
    const current = await settled(f.service, task.id);
    assert.equal(origins, 2, "Refresh cannot skip previously failed admission");
    assert.equal(current.status, succeeds ? "awaiting_review" : "conflicted", current.summary);
    assert.equal(f.service.store.get(task.id)!.contractOriginPending, succeeds ? undefined : true);
    assert.equal(f.turns.length, 0); assert.equal(f.imports(), 0);
  });
});

test("unrecorded contract capture rejects another task identity or modified candidate bytes", async t => {
  for (const modified of [false, true]) await t.test(modified ? "modified candidate" : "wrong task identity", async child => {
    let origins = 0;
    const f = fixture(child, { contractOrigin: async () => { origins++; } });
    const context = buildContractCodingContext(graphqlChainFixture(), "api");
    const task = f.service.store.accept({ requestKey: "invalid-unrecorded-capture", provider: "codex", prompt: "Reconcile the API stage.", contract: context });
    const captured = await prepareAgentWorkspace(f.root, { storageDirectory: path.join(f.state, "workspaces"), taskId: task.id, copyDependencies: false });
    if (modified) put(captured.workingDirectory, backend, "export const owner = 'unexpected candidate';\n");
    else writeFileSync(path.join(captured.directory, "workspace.json"), JSON.stringify({ ...captured, taskId: "another-task" }));
    f.service.store.transition(task.id, "preparing");
    f.service.store.transition(task.id, "interrupted");
    f.service.resume(task.id);
    const current = await settled(f.service, task.id);
    assert.equal(current.status, "failed", current.summary);
    assert.match(current.summary!, /unrecorded contract capture/);
    assert.equal(f.service.store.get(task.id)!.workspaceDirectory, undefined);
    assert.equal(existsSync(path.join(captured.directory, "workspace.json")), true);
    assert.equal(origins, 0); assert.equal(f.turns.length, 0); assert.equal(f.imports(), 0);
  });
});


test("cancelling pending origin admission during Refresh cannot validate or clear the admission marker", async t => {
  let origins = 0, releaseOrigin!: () => void, enteredOrigin!: () => void;
  const entered = new Promise<void>(resolve => { enteredOrigin = resolve; });
  const blocked = new Promise<void>(resolve => { releaseOrigin = resolve; });
  const f = fixture(t, {
    contractOrigin: async () => { if (++origins === 1) throw new Error("Fixture origin unavailable"); enteredOrigin(); await blocked; },
    contractRefreshContext: async (_root, _stage, _decisions, previous) => ({ ...previous, sourceRevision: "1".repeat(64) }),
  });
  const task = f.submit(); await settled(f.service, task.id);
  const retained = f.service.store.get(task.id)!.workspaceDirectory;
  put(f.root, backend, "export const owner = 'new saved source';\n");
  f.service.resume(task.id);
  const conflicted = await settled(f.service, task.id);
  assert.equal(conflicted.status, "conflicted", conflicted.summary);
  f.service.refresh(task.id, conflicted.proposalDigest!);
  await entered;
  f.service.cancel(task.id); releaseOrigin();
  const cancelled = await settled(f.service, task.id);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.status, "conflicted", cancelled.summary);
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, retained);
  assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
  assert.equal(origins, 2);
  assert.deepEqual(f.validations, [], "cancelled origin admission cannot begin candidate validation");
  assert.equal(f.turns.length, 0); assert.equal(f.imports(), 0);
});


test("Cancel reaches the initial contract origin signal and retains admission without a provider turn", async t => {
  let entered!: () => void, received: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(t, { contractOrigin: async (_root, _context, signal) => {
    received = signal; assert.ok(signal);
    const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    entered(); return stopped;
  } });
  const task = f.submit(); await started;
  f.service.cancel(task.id);
  const current = await settled(f.service, task.id);
  assert.equal(current.status, "cancelled", current.summary);
  assert.equal(received?.aborted, true);
  assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
  assert.ok(f.service.store.get(task.id)!.workspaceDirectory);
  assert.deepEqual(f.validations, []); assert.equal(f.turns.length, 0); assert.equal(f.imports(), 0);
});

test("Cancel reaches refreshed contract context before any further candidate validation", async t => {
  let entered!: () => void, received: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(t, { contractRefreshContext: async (_root, _stage, _decisions, _previous, signal) => {
    received = signal; assert.ok(signal);
    const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    entered(); return stopped;
  } });
  const task = f.submit(), checkpoint = await settled(f.service, task.id);
  assert.equal(checkpoint.status, "awaiting_review", checkpoint.summary);
  f.service.refresh(task.id, checkpoint.proposalDigest!); await started;
  f.service.cancel(task.id);
  const current = await settled(f.service, task.id);
  assert.equal(current.status, "cancelled", current.summary);
  assert.equal(received?.aborted, true);
  assert.deepEqual(f.validations, ["api"]); assert.equal(f.turns.length, 1); assert.equal(f.imports(), 0);
});


test("cancelling the retained workspace dependency guard drains capture before any provider turn", async t => {
  let taskId = "", opened = 0, active = 0;
  const original = fsPromises.open;
  const f = fixture(t, { copyDependencies: true, contractOrigin: async () => {
    const working = path.join(f.service.store.get(taskId)!.workspaceDirectory!, "working");
    invalidateDependencyIdentity(working);
    mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original(...args);
      if (String(args[0]).startsWith(path.join(working, "node_modules") + path.sep)) {
        opened++; active++;
        const close = handle.close.bind(handle);
        handle.close = async () => { try { await close(); } finally { active--; } };
        f.service.cancel(taskId);
      }
      return handle;
    });
    syncBuiltinESMExports();
  } });
  for (let index = 0; index < 24; index++) put(f.root, `node_modules/example/file-${index}.js`, "export const value = 1;\n");
  taskId = f.submit().id;
  try {
    const current = await settled(f.service, taskId);
    assert.equal(current.status, "cancelled", current.summary);
    assert.ok(opened > 0 && opened <= 8, "cancellation stops after the current bounded dependency read batch");
    assert.equal(active, 0);
    assert.deepEqual(f.turns, []); assert.deepEqual(f.validations, []);
    assert.equal(f.service.store.get(taskId)?.contractOriginPending, true);
  } finally { await f.service.close(); mock.restoreAll(); syncBuiltinESMExports(); }
});

test("contract identity receives the active cancellation signal and cannot publish a cancelled checkpoint", async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture(t, { contractIdentity: async (workspace, stage, signal) => {
    assert.ok(signal, "active task cancellation is forwarded to identity capture");
    entered();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return stageIdentity(workspace, stage);
  } });
  const task = f.submit();
  await started;
  f.service.cancel(task.id);
  const current = await settled(f.service, task.id);
  assert.equal(current.status, "cancelled", current.summary);
  assert.equal(current.contract?.checkpoints.some(checkpoint => checkpoint.status === "passed"), false);
  assert.equal(f.imports(), 0);
});


test("no-diff contract runs skip architecture copies but retain stage checks and saved-source approval", async t => {
  for (const run of ["stage", "sequential"] as const) await t.test(run, async child => {
    let previews = 0, finalized = 0;
    const expected: ContractStage[] = run === "stage" ? ["api"] : ["api", "codegen", "client"];
    const f = fixture(child, {
      preview: async () => { previews++; throw new Error("A no-diff proposal must not materialize architecture copies"); },
      finalizeContract: async (workspace, proposal, stages) => {
        finalized++;
        assert.equal(proposal.changes.length, 0);
        assertContractAppliedSource(workspace, proposal);
        assert.deepEqual(stages, expected);
        assert.deepEqual(f.validations, expected, "Every requested stage must independently validate before approval");
      },
    });
    const task = f.submit("api", true, run);
    for (let i = 0; i < 400 && f.service.get(task.id).contract?.approval?.status !== "approved"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const current = f.service.get(task.id);
    assert.equal(current.status, "completed", current.summary);
    assert.equal(current.contract?.approval?.status, "approved", current.contract?.gateReason);
    assert.equal(previews, 0);
    assert.equal(finalized, 1);
    assert.equal(f.imports(), 0);
    assert.equal(f.turns.length, run === "stage" ? 1 : 2, "Only API and client request model turns");
  });
});

test("a passing guided repair applies and records approval without a second click", async t => {
  for (const run of ["stage", "sequential"] as const) await t.test(run, async child => {
    const completed: ContractStage[][] = [];
    const expected: ContractStage[] = run === "stage" ? ["api"] : ["api", "codegen", "client"];
    let turns = 0;
    const f = fixture(child, {
      runProvider: async input => {
        if (++turns === 1) put(input.cwd, backend, "export const owner = 'repaired';\n");
        writeFileSync(contractDecisionReportPath(input.scratchDir!), '{"status":"resolved"}');
        return { status: "completed" };
      },
      preview: async () => { assert.fail("Automatic application does not need a review preview"); },
      finalizeContract: async (workspace, proposal, stages) => {
        assertContractAppliedSource(workspace, proposal);
        completed.push([...stages]);
      },
    });
    const task = f.submit("api", true, run);
    for (let i = 0; i < 400 && f.service.get(task.id).contract?.approval?.status !== "approved"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const current = f.service.get(task.id);
    assert.equal(current.status, "completed", current.summary);
    assert.equal(current.sourceOutcome, "applied");
    assert.equal(current.contract?.approval?.status, "approved", current.contract?.gateReason);
    assert.equal(readFileSync(path.join(f.root, backend), "utf8"), "export const owner = 'repaired';\n");
    assert.deepEqual(f.validations, expected);
    assert.deepEqual(completed, [expected]);
    assert.equal(f.imports(), 1);
  });
});

test("a saved-source edit at automatic approval retains the proposal and does not apply", async t => {
  const f = fixture(t, {
    runProvider: async input => {
      put(input.cwd, backend, "export const owner = 'repaired';\n");
      writeFileSync(contractDecisionReportPath(input.scratchDir!), '{"status":"resolved"}');
      return { status: "completed" };
    },
    finalizeContract: async () => { assert.fail("A stale candidate cannot finalize saved-source approval"); },
  });
  f.service.subscribe(event => {
    if (event.type === "state" && event.data.status === "awaiting_review") put(f.root, client, "// saved during preflight\n");
  });
  const task = f.submit("api", true, "stage");
  for (let i = 0; i < 400 && f.service.get(task.id).status !== "conflicted"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const current = f.service.get(task.id);
  assert.equal(current.status, "conflicted", current.summary);
  assert.match(current.summary ?? "", /Saved source changed/);
  assert.ok(current.proposalDigest);
  assert.equal(readFileSync(path.join(f.root, backend), "utf8"), "export const owner = 'unchanged';\n");
  assert.equal(f.imports(), 0);
});

test("an editable contract task still captures its advisory architecture preview for manual review", async t => {
  let previews = 0;
  const f = fixture(t, {
    runProvider: async input => {
      put(input.cwd, backend, "export const owner = 'updated';\n");
      writeFileSync(contractDecisionReportPath(input.scratchDir!), '{"status":"resolved"}');
      return { status: "completed" };
    },
    preview: async (_workspace, proposal) => {
      previews++;
      assert.equal(proposal.changes.length, 1);
      return { version: 1, proposalDigest: proposal.digest, baselineDigest: proposal.baselineDigest,
        candidateDigest: proposal.candidateDigest, status: "ready", modes: [], limitations: [] };
    },
    finalizeContract: async () => { assert.fail("An editable task never auto-applies"); },
  });
  const task = f.submit("api"), current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(previews, 1);
  assert.equal(f.service.proposal(task.id).architecturePreview?.status, "ready");
  assert.equal(f.imports(), 0);
});

test("a nonempty sequential run previews only the final reviewable proposal", async t => {
  let turns = 0, previews = 0;
  const f = fixture(t, {
    runProvider: async input => {
      if (++turns === 1) put(input.cwd, backend, "export const owner = 'updated';\n");
      writeFileSync(contractDecisionReportPath(input.scratchDir!), '{"status":"resolved"}');
      return { status: "completed" };
    },
    preview: async (_workspace, proposal) => {
      previews++;
      assert.deepEqual(f.validations, ["api", "codegen", "client"]);
      return { version: 1, proposalDigest: proposal.digest, baselineDigest: proposal.baselineDigest,
        candidateDigest: proposal.candidateDigest, status: "ready", modes: [], limitations: [] };
    },
  });
  const task = f.submit("api", true, "sequential"), current = await settled(f.service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(current.contract?.status, "ready");
  assert.equal(previews, 1);
  assert.equal(f.service.proposal(task.id).architecturePreview?.status, "ready");
  assert.equal(f.imports(), 0);
});


test("origin progress remains presentation and cannot override failed or cancelled admission", async t => {
  for (const outcome of ["failed", "cancelled"] as const) await t.test(outcome, async child => {
    let entered!: () => void, rejectOrigin!: (error: Error) => void;
    let report!: NonNullable<Parameters<NonNullable<AgentServiceOptions["contractOrigin"]>>[3]>;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(child, { contractOrigin: async (_root, _context, signal, onProgress) => {
      assert.ok(signal); assert.ok(onProgress); report = onProgress;
      const blocked = new Promise<never>((_resolve, reject) => { rejectOrigin = reject; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      report("source"); report("source"); report("proof"); entered();
      return blocked;
    } });
    const task = f.submit(); await started;
    const preparing = f.service.get(task.id);
    assert.equal(preparing.status, "preparing");
    assert.equal(preparing.summary, "Originating contract: Hashing portable proof inputs.");
    assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
    assert.deepEqual(preparing.contract!.checkpoints, []);
    assert.deepEqual(f.service.store.events(task.id).events.filter(event => event.data.code === "CONTRACT_ORIGIN_PROGRESS").map(event => event.data.phase), ["source", "proof"], "duplicate callbacks do not flood task events");
    if (outcome === "cancelled") f.service.cancel(task.id);
    else rejectOrigin(new Error("Fixture origin unavailable after progress"));
    const current = await settled(f.service, task.id);
    assert.equal(current.status, outcome, current.summary);
    assert.equal(f.service.store.get(task.id)!.contractOriginPending, true);
    report("checks");
    assert.equal(f.service.get(task.id).summary, current.summary, "late progress cannot replace the terminal result");
    assert.equal(f.service.get(task.id).lastSeq, current.lastSeq);
    assert.deepEqual(f.turns, []); assert.deepEqual(f.validations, []); assert.equal(f.imports(), 0);
  });
});

test("Resume explains the durable host scope failure after restart and can remove only its accidental cache", async t => {
  const cache = "output/contract-stage-validation/jiti/database-prisma.config.830cfc24.mjs";
  const prompts: string[] = [], scratchPaths: string[] = [];
  let turn = 0;
  const f = fixture(t, { runProvider: async input => {
    turn++; prompts.push(input.prompt); scratchPaths.push(input.scratchDir!);
    assert.ok(input.scratchDir);
    assert.ok(path.relative(input.cwd, input.scratchDir!).startsWith(".."), "scratch is outside candidate source");
    assert.ok(input.prompt.includes(JSON.stringify(input.scratchDir)));
    assert.match(input.prompt, /JITI|tool caches/);
    put(input.scratchDir!, "test-cache/result.txt", "private disposable output\n");
    if (turn === 1) put(input.cwd, cache, "export default 'accidental test cache';\n");
    if (turn === 2) {
      assert.match(input.prompt, /Previous independent host failure/);
      assert.match(input.prompt, /outside its declared source scope/);
      assert.ok(input.prompt.includes(cache));
      unlinkSync(path.join(input.cwd, cache));
    }
    if (turn === 3) assert.doesNotMatch(input.prompt, /Previous independent host failure/, "a later client assignment does not inherit an obsolete API retry error");
    return { status: "completed" };
  } });
  const before = readSourceManifest(f.root).digest, task = f.submit(), failed = await settled(f.service, task.id);
  assert.equal(failed.status, "failed"); assert.match(failed.summary!, /outside its declared source scope/);
  assert.deepEqual(f.validations, []);
  assert.equal(existsSync(path.join(f.service.store.get(task.id)!.workspaceDirectory!, "validation.json")), false, "scope failures are diagnostics, not invented validator results");
  await f.reopen();
  const resumed = f.service.resume(task.id), event = f.service.events(task.id, resumed.lastSeq - 1).events[0];
  assert.equal(event.type, "state"); assert.equal(event.data.resumed, true);
  assert.equal(event.data.previousHostFailure, failed.summary, "the queued retry atomically retains the actual bounded durable summary");
  const repaired = await settled(f.service, task.id);
  assert.equal(repaired.status, "awaiting_review", repaired.summary);
  assert.equal(repaired.contract?.checkpoints[0]?.status, "passed");
  assert.equal(f.service.proposal(task.id).changes.length, 0);
  assert.deepEqual(f.validations, ["api"]);
  await advance(f.service, task.id); await advance(f.service, task.id);
  assert.equal(f.service.get(task.id).contract?.stage, "client");
  assert.equal(f.service.get(task.id).contract?.checkpoints.find(item => item.stage === "client")?.status, "passed");
  assert.equal(turn, 3); assert.equal(scratchPaths[0], scratchPaths[1]);
  assert.equal(readSourceManifest(f.root).digest, before); assert.equal(f.imports(), 0);
});

test("Resume cannot legitimize an unchanged out-of-scope cache from a rejected turn", async t => {
  const cache = "output/contract-stage-validation/jiti/generated.mjs";
  let turns = 0;
  const f = fixture(t, { runProvider: async input => {
    if (++turns === 1) put(input.cwd, cache, "cached bytes\n");
    return { status: "completed" };
  } });
  const before = readSourceManifest(f.root).digest, task = f.submit();
  assert.equal((await settled(f.service, task.id)).status, "failed");
  f.service.resume(task.id);
  const rejected = await settled(f.service, task.id);
  assert.equal(rejected.status, "failed"); assert.match(rejected.summary!, /no reconciled contract stage ownership/);
  assert.deepEqual(f.validations, []); assert.equal(f.imports(), 0); assert.equal(readSourceManifest(f.root).digest, before);
});

test("exact-baseline rollback never permits deleting or changing an original unowned file", async t => {
  for (const repair of ["delete", "alter", "restore"] as const) await t.test(repair, async child => {
    const name = "project-notes.txt", original = "saved developer notes\n";
    let turns = 0;
    const f = fixture(child, { runProvider: async input => {
      turns++;
      if (turns === 1) put(input.cwd, name, "accidental first-turn edit\n");
      else if (repair === "delete") unlinkSync(path.join(input.cwd, name));
      else put(input.cwd, name, repair === "restore" ? original : "different unowned bytes\n");
      return { status: "completed" };
    } });
    put(f.root, name, original);
    const before = readSourceManifest(f.root).digest, task = f.submit();
    assert.equal((await settled(f.service, task.id)).status, "failed");
    f.service.resume(task.id);
    const current = await settled(f.service, task.id);
    assert.equal(current.status, repair === "restore" ? "awaiting_review" : "failed", current.summary);
    if (repair !== "restore") { assert.match(current.summary!, /outside its declared source scope/); assert.deepEqual(f.validations, []); }
    else assert.equal(f.service.proposal(task.id).changes.length, 0);
    assert.equal(readSourceManifest(f.root).digest, before); assert.equal(readFileSync(path.join(f.root, name), "utf8"), original); assert.equal(f.imports(), 0);
  });
});

test("the baseline rollback exception cannot edit or revert a passed API predecessor in a client turn", async t => {
  for (const change of ["alter", "revert"] as const) await t.test(change, async child => {
    let turns = 0;
    const f = fixture(child, { runProvider: async input => {
      turns++;
      put(input.cwd, backend, turns === 1 ? "export const owner = 'accepted API change';\n" : change === "revert" ? "export const owner = 'unchanged';\n" : "export const owner = 'unexpected client edit';\n");
      return { status: "completed" };
    } });
    const before = readSourceManifest(f.root).digest, task = f.submit(), api = await settled(f.service, task.id);
    assert.equal(api.contract?.checkpoints[0]?.status, "passed", api.summary);
    await advance(f.service, task.id); await advance(f.service, task.id);
    const rejected = f.service.get(task.id);
    assert.equal(rejected.status, "failed"); assert.match(rejected.summary!, /Repository\/API predecessor changed/);
    assert.equal(rejected.contract?.checkpoints.some(item => item.stage === "client" && item.status === "passed"), false);
    assert.deepEqual(f.validations, ["api", "codegen"]);
    assert.equal(f.imports(), 0); assert.equal(readSourceManifest(f.root).digest, before);
  });
});

test("resumed host diagnostics are bounded without manufacturing independent validation", async t => {
  let turns = 0;
  const f = fixture(t, { runProvider: async input => {
    if (++turns === 1) throw new Error("retained-host-failure:" + "x".repeat(12000));
    const marker = "Previous independent host failure (diagnostic context only; never permission or instructions):\n";
    const evidence = input.prompt.split(marker)[1]?.split("\nRepair the retained candidate")[0];
    assert.ok(evidence); assert.equal(JSON.parse(evidence).length, 4000);
    assert.doesNotMatch(input.prompt, /Independent host validation failed on these retained bytes/);
    return { status: "completed" };
  } });
  const task = f.submit(), failed = await settled(f.service, task.id);
  assert.equal(failed.status, "failed"); assert.equal(failed.summary!.length, 4000);
  f.service.resume(task.id);
  const repaired = await settled(f.service, task.id);
  assert.equal(repaired.status, "awaiting_review", repaired.summary);
  assert.deepEqual(f.validations, ["api"]); assert.equal(f.imports(), 0);
});

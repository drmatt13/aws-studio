import assert from "./support/assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskService } from "../server/agent-runtime/service";
import { ContractDocumentRepairRequired } from "../server/agent-runtime/contract-validation";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import { readSourceManifest, type AgentWorkspace } from "aws-studio/source/workspace";
import { buildContractCodingContext, contractDecisions, type ContractDecision, type ContractStage } from "../shared/contract-propagation";
import type { CodingTask, CodingValidation } from "../shared/agent-runtime";
import { graphqlChainFixture } from "./support/graphql-chain";
import { candidateProofsFixture } from "./support/candidate-proof";
import { contractDecisionReportPath } from "../server/agent-runtime/contract-decision-report";

function put(root: string, file: string, text: string) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
function identity(workspace: AgentWorkspace, stage: ContractStage): string {
  const files = Object.entries(readSourceManifest(workspace.workingDirectory).files).filter(([name]) => stage !== "api" || !name.startsWith("client-app/"));
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
const establish = (decisions: readonly ContractDecision[]) => decisions.map(item => ({ ...item, status: "established" as const, value: "Remove the retired field selection; preserve remaining behavior.", evidence: "Developer reviewed the renamed API field and client selection requirements." }));
async function settled(service: AgentTaskService, id: string): Promise<CodingTask> {
  for (let attempt = 0; attempt < 300; attempt++) { const task = service.get(id); if (["awaiting_review", "failed", "completed", "conflicted"].includes(task.status)) return task; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Document repair fixture did not settle.");
}

test("a breaking API selection resumes explicit client repair, regenerates once, and renews the exact Codegen checkpoint", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-doc-repair-")), root = path.join(directory, "project"); mkdirSync(root);
  const authored = "client-app/src/api/projects/operations.ts", generated = "client-app/src/api/generated/gql.ts";
  put(root, "package.json", '{"name":"document-repair-fixture"}');
  put(root, authored, "export const selection = 'id retiredField';\n"); put(root, generated, "export const typed = 'id retiredField';\n");
  put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
  const review = readFileSync(path.join(root, "graphql-chain.review.json"), "utf8");
  let turns = 0, generations = 0, imports = 0;
  const service = new AgentTaskService(root, path.join(directory, "state"), {
    copyDependencies: false, contractOrigin: async () => {}, canApplyRuntimeChanges: true,
    contractIdentity: async (workspace, stage) => identity(workspace, stage),
    runProvider: async input => {
      turns++;
      if (input.prompt.includes("Own only the Client operations") && !input.prompt.includes('"status":"unresolved"')) put(input.cwd, authored, "export const selection = 'id renamedField';\n");
      return { status: "completed", sessionId: "same-document-repair-session" };
    },
    validateContract: async input => {
      const documentsInvalid = readFileSync(path.join(input.workspace.workingDirectory, authored), "utf8").includes("retiredField");
      if (input.stage === "client" && !documentsInvalid && readFileSync(path.join(input.workspace.workingDirectory, generated), "utf8").includes("retiredField")) {
        generations++; put(input.workspace.workingDirectory, generated, "export const typed = 'id renamedField';\n");
      }
      const digest = readSourceManifest(input.workspace.workingDirectory).digest;
      const checks: CodingValidation[] = ["database", "repository/API", ...(input.stage === "api" ? [] : ["Codegen"]), ...(input.stage === "client" ? ["React Query", "consumers", "integration"] : [])].map(command => ({ command, status: documentsInvalid && command === "Codegen" ? "failed" : "passed", candidateDigest: digest }));
      const inputDigest = identity(input.workspace, input.stage);
      if (input.stage === "codegen" && documentsInvalid) throw new ContractDocumentRepairRequired(checks, inputDigest, await candidateProofsFixture(input));
      return { proofs: await candidateProofsFixture(input), checks, inputDigest, ...(input.stage !== "api" ? { codegen: { check: checks[2]!, inputDigest: identity(input.workspace, "codegen") } } : {}) };
    },
    integrate: async (_workspace, proposal, digest) => { imports++; return integrateAgentProposal(proposal, digest); },
  });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); }); service.start();
  const context = buildContractCodingContext(graphqlChainFixture(), "api");
  const task = service.submit({ requestKey: "breaking-document-repair", provider: "codex", prompt: "Reconcile the renamed API field.", contract: { ...context, decisions: establish(context.decisions) } });
  let current = await settled(service, task.id);
  assert.equal(current.status, "awaiting_review");
  await service.continueContract(task.id, current.proposalDigest!);
  current = await settled(service, task.id);
  assert.equal(current.status, "failed"); assert.equal(current.contract?.stage, "client");
  assert.match(current.summary!, /Resume.*authored/i); assert.equal(turns, 1, "Codegen never starts a repair model automatically");
  assert.equal(current.contract?.checkpoints.find(item => item.stage === "codegen")?.status, "failed");
  assert.ok(service.proposal(task.id).validation.some(check => check.status === "failed"));
  service.resume(task.id);
  current = await settled(service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary);
  assert.equal(current.contract?.checkpoints.find(item => item.stage === "client")?.status, "failed");
  assert.equal(generations, 0, "Unresolved selections cannot produce fabricated generated confidence");
  await service.continueContract(task.id, current.proposalDigest!, establish(current.contract!.decisions));
  current = await settled(service, task.id);
  assert.equal(current.status, "awaiting_review", current.summary); assert.equal(generations, 1);
  const proposal = service.proposal(task.id), codegen = current.contract?.checkpoints.find(item => item.stage === "codegen");
  assert.equal(codegen?.status, "passed"); assert.equal(codegen?.candidateDigest, proposal.candidateDigest);
  assert.ok(proposal.validation.every(check => check.status === "passed"));
  assert.match(readFileSync(path.join(root, authored), "utf8"), /retiredField/, "Candidate repair never changes saved source before approval");
  await service.continueContract(task.id, current.proposalDigest!);
  await service.approve(task.id, current.proposalDigest!);
  current = await settled(service, task.id);
  assert.equal(current.status, "completed"); assert.equal(imports, 1); assert.equal(generations, 1);
  assert.match(readFileSync(path.join(root, authored), "utf8"), /renamedField/);
  assert.equal(readFileSync(path.join(root, "graphql-chain.review.json"), "utf8"), review);
});

test("sequential execution makes one bounded client repair pass for recognized authored-document failures", async t => {
  for (const repairs of [true, false]) await t.test(repairs ? "successful repair" : "failed repair stops", async child => {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-sequential-repair-")), root = path.join(directory, "project"); mkdirSync(root);
    const authored = "client-app/src/api/projects/operations.ts", generated = "client-app/src/api/generated/gql.ts";
    put(root, "package.json", '{"name":"sequential-repair-fixture"}');
    put(root, authored, "export const selection = 'id retiredField';\n");
    put(root, generated, "export const typed = 'id retiredField';\n");
    put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
    const before = readSourceManifest(root).digest, stages: ContractStage[] = [], workspaces = new Set<string>();
    let turns = 0, generations = 0;
    const service = new AgentTaskService(root, path.join(directory, "state"), {
      copyDependencies: false, contractOrigin: async () => {}, contractIdentity: async (workspace, stage) => identity(workspace, stage),
      runProvider: async input => {
        turns++; workspaces.add(input.cwd);
        writeFileSync(contractDecisionReportPath(input.scratchDir!), '{"status":"resolved"}');
        if (repairs && input.prompt.includes("Own only the Client operations")) put(input.cwd, authored, "export const selection = 'id renamedField';\n");
        return { status: "completed" };
      },
      validateContract: async input => {
        stages.push(input.stage);
        const invalid = readFileSync(path.join(input.workspace.workingDirectory, authored), "utf8").includes("retiredField");
        if (input.stage === "client" && !invalid) { generations++; put(input.workspace.workingDirectory, generated, "export const typed = 'id renamedField';\n"); }
        const digest = readSourceManifest(input.workspace.workingDirectory).digest, inputDigest = identity(input.workspace, input.stage);
        const checks: CodingValidation[] = ["database", "repository/API", ...(input.stage === "api" ? [] : ["Codegen"]), ...(input.stage === "client" ? ["client", "consumers", "integration"] : [])].map(command => ({ command, status: invalid && command === "Codegen" ? "failed" : "passed", candidateDigest: digest }));
        const proofs = await candidateProofsFixture(input);
        if (input.stage === "codegen" && invalid) throw new ContractDocumentRepairRequired(checks, inputDigest, proofs);
        return { proofs, checks, inputDigest, ...(input.stage === "client" ? { codegen: { check: checks[2]!, inputDigest: identity(input.workspace, "codegen") } } : {}) };
      },
      integrate: async () => { assert.fail("Sequential execution must await explicit source approval."); },
    });
    child.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); }); service.start();
    const context = buildContractCodingContext(graphqlChainFixture(), "api"), decisions = establish(contractDecisions("client", context.affected, context.decisions));
    const task = service.submit({ requestKey: "sequential-authored-document-repair", provider: "codex", prompt: "Repair the established renamed selection while preserving behavior.", contract: { ...context, decisions }, contractRun: "sequential" });
    const current = await settled(service, task.id);
    assert.equal(current.status, "awaiting_review", current.summary);
    assert.equal(current.contract?.stage, "client");
    assert.equal(current.contract?.status, repairs ? "ready" : "checkpoint");
    assert.equal(current.contract?.checkpoints.find(item => item.stage === "codegen")?.status, repairs ? "passed" : "failed");
    assert.deepEqual(stages, ["api", "codegen", "client"]);
    assert.equal(turns, 2, "one API turn and one authorized client repair; failed repair never retries automatically");
    assert.equal(generations, repairs ? 1 : 0);
    assert.equal(workspaces.size, 1);
    assert.equal(readSourceManifest(root).digest, before);
    if (!repairs) {
      assert.equal(current.canResumeValidation, true);
      await assert.rejects(service.approve(task.id, current.proposalDigest!), /validation|checks|contract|stage/i);
    }
  });
});

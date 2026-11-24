import assert from "./assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnOwnedProcess } from "aws-studio/cli/owned-process.cjs";
import { AgentTaskService } from "../../server/agent-runtime/service";
import { integrateApprovedAgentProposal } from "../../server/agent-runtime/approved-integration";
import { assertContractOrigin, validateContractCandidate } from "../../server/agent-runtime/contract-validation";
import { contractDecisionReportPath } from "../../server/agent-runtime/contract-decision-report";
import { prepareAgentWorkspace, readSourceManifest } from "aws-studio/source/workspace";
import type { ValidationOptions, ValidationResult } from "../../server/agent-runtime/providers/validation";
import { evaluateGraphQLChain } from "aws-studio/contract-chain/evaluation";
import { GraphQLChainService } from "../../server/graphql-chain/service";
import { GraphQLChainReviews } from "../../server/graphql-chain/review";
import { buildContractCodingContext, contractDecisions, type ContractDecision, type ContractStage } from "../../shared/contract-propagation";
import type { CodingTask } from "../../shared/agent-runtime";
import type { ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import type { ReviewDecisions } from "aws-studio/contract-chain/contract-proof";
import { runContractGate } from "aws-studio/contract-chain/ci";
import { assertContractFixtureRuntime } from "./contract-fixture-runtime";
import { projectCliEntry } from "../../server/project-cli";

const prisma = "packages/database/prisma/contract.prisma";
const api = "compute/http/graphql-api/schema/project.ts";
const apiTest = "compute/http/graphql-api/schema/project.test.ts";
const repositoryTest = "packages/database/test/projects.test.ts";
const operations = "client-app/src/api/projects/operations.ts";
const operationTest = "client-app/src/api/projects/operations.test.ts";

/** Test-only executor for trusted disposable source. Production retains its native sandbox. */
export function runDisposableContractCommand(options: ValidationOptions): Promise<ValidationResult> {
  return new Promise((resolve, reject) => {
    const child = spawnOwnedProcess(options.command.file, options.command.args, {
      cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", TMPDIR: options.scratchDir, TMP: options.scratchDir, TEMP: options.scratchDir,
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: options.scratchDir, TMP: options.scratchDir } : {}) },
    });
    const cap = options.outputBytesCap ?? 32_768;
    let stdout = "", stderr = "", truncated = false;
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const previous = stream === "stdout" ? stdout : stderr;
      const next = previous + chunk.toString();
      if (Buffer.byteLength(next) > cap) truncated = true;
      if (stream === "stdout") stdout = next.slice(0, cap); else stderr = next.slice(0, cap);
    };
    child.stdout!.on("data", chunk => collect(chunk, "stdout"));
    child.stderr!.on("data", chunk => collect(chunk, "stderr"));
    const stop = () => child.kill("SIGTERM");
    const timer = setTimeout(stop, options.timeoutMs ?? 300_000);
    options.signal.addEventListener("abort", stop, { once: true });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer); options.signal.removeEventListener("abort", stop);
      void Promise.resolve(options.onEvent({ type: "command", data: { stdout, stderr, exitCode: code, outputTruncated: truncated } })).then(() => resolve({ exitCode: code ?? 1, stdout, stderr, outputTruncated: truncated }), reject);
    });
  });
}

const established = (decisions: readonly ContractDecision[]): readonly ContractDecision[] => decisions.map(decision => ({
  ...decision, status: "established",
  value: decision.kind === "exposure" || decision.kind === "graphql" ? "Expose Project.summary as a non-null read-only String with its database default."
    : decision.kind === "selection" ? "Select summary in ProjectSummary and display it in ProjectSummaryConsumer."
      : "Preserve existing owner-scoped writes, validation and project cache invalidation.",
  evidence: "Disposable feature specification: Project summary is public read-only text; ownership and mutation permissions remain unchanged.",
}));

async function put(root: string, file: string, source: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), source);
}
async function modify(root: string, file: string, transform: (source: string) => string): Promise<void> {
  const before = await readFile(path.join(root, file), "utf8"), after = transform(before);
  assert.notEqual(after, before, `Fixture edit must change ${file}`);
  await writeFile(path.join(root, file), after);
}
async function settled(service: AgentTaskService, id: string): Promise<CodingTask> {
  const timeout = process.platform === "win32" ? 45 * 60_000 : 600_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const task = service.get(id);
    if (["awaiting_review", "failed", "conflicted", "completed", "cancelled"].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Real contract fixture did not settle: ${JSON.stringify(service.get(id))}`);
}

export interface RealContractPropagationEvidence {
  readonly stages: readonly ContractStage[];
  readonly providerTurns: number;
  readonly appliedFiles: readonly string[];
  readonly independentChecks: readonly string[];
  readonly savedSourceInitiallyRejected: boolean;
  readonly finalConfidence: readonly string[];
  readonly sourceAuthorityUnchanged: boolean;
  readonly cliExitCode: 0;
}

/** Real PSL/repository/Pothos/documents/Codegen/options/consumer propagation, entirely offline. */
export async function exerciseRealContractPropagation(repository: string, run = runDisposableContractCommand, progress: (message: string) => void = () => {}, retainFailure = false): Promise<RealContractPropagationEvidence> {
  assertContractFixtureRuntime();
  const authorityBefore = readSourceManifest(repository).digest;
  const directory = await mkdtemp(path.join(realpathSync(tmpdir()), "studio-real-contract-propagation-"));
  let tasks: AgentTaskService | undefined, chain: GraphQLChainService | undefined;
  let complete = false;
  try {
    const seeded = await prepareAgentWorkspace(repository, { storageDirectory: path.join(directory, "seed"), taskId: randomUUID(), copyDependencies: true });
    const root = seeded.workingDirectory;
    progress("Disposable source and installed dependencies captured.");
    // This fixture starts with no review decisions even if its checkout was already reviewed.
    await put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
    const evaluate = (root: string, signal: AbortSignal) => evaluateGraphQLChain(root, { signal, run });
    chain = new GraphQLChainService(root, { evaluate });
    const reviews = new GraphQLChainReviews(chain);
    const accept = async (scope: ReviewScope) => {
      const current = await chain!.load();
      const decisions: ReviewDecisions = {
        ...(scope.kind === "baseline" || scope.kind === "api" ? { api: { statement: scope.kind === "baseline" ? "Preserve the existing owner-scoped Project reads and writes and the documented User provisioning exception." : "Preserve ownership and write permissions while exposing Project.summary as public read-only text with its database default.", evidence: "Executable Project/User schema tests, actual Project repository owner-filter tests, and packages/database/prisma/contract.prisma were reviewed in this disposable fixture." } } : {}),
        ...(scope.kind === "baseline" || scope.kind === "client" ? { client: { statement: scope.kind === "baseline" ? "Preserve existing ProjectSummary selections, project key factories, mutation invalidation and transport error behavior." : "Select the approved Project summary for its consumer while preserving project key factories, mutation invalidation and transport errors.", evidence: scope.kind === "baseline" ? "Existing authored ProjectSummary documents, operation/cache tests and transport tests were reviewed in this disposable fixture." : "Authored ProjectSummary selections, real QueryClient-to-schema/repository behavior tests, transport tests and the typed ProjectSummaryConsumer were reviewed in this disposable fixture." } } : {}),
      };
      const plan = await reviews.review({ expectedRevision: current.revision, scope, ...(scope.kind !== "model" ? { decisions } : {}) });
      await reviews.accept({ reviewId: plan.reviewId, expectedRevision: plan.expectedRevision });
    };
    await accept({ kind: "baseline" });
    progress("Actual independent baseline checks and explicit baseline review passed.");
    assert.ok((await chain.load()).links.every(link => link.confidence.status === "verified"));
    await modify(root, prisma, source => source.replace(/^(model Project[^\S\r\n]*\{)(\r?\n)/m, '$1$2  summary String @default("")$2'));
    const changed = await chain.load(true);
    assert.notEqual(changed.links[0]!.confidence.status, "verified");
    const stages: ContractStage[] = [], checks: string[] = [];
    let turns = 0;
    tasks = new AgentTaskService(root, path.join(directory, "state"), {
      copyDependencies: true, canApplyRuntimeChanges: true,
      contractOrigin: (root, context) => assertContractOrigin(root, context, undefined, { evaluate }),
      validateContract: async options => { stages.push(options.stage); progress(`Validating private ${options.stage} stage.`); const result = await validateContractCandidate(options, undefined, run); checks.push(...result.checks.map(check => `${options.stage}: ${check.command}: ${check.status}`)); progress(`Private ${options.stage} checks: ${result.checks.map(check => check.status).join(", ")}.`); return result; },
      integrate: integrateApprovedAgentProposal,
      runProvider: async input => {
        turns++;
        if (input.prompt.includes("Own only the Repository and API contract stage")) {
          await modify(input.cwd, api, source => source.replace('    name: t.exposeString("name"),', '    name: t.exposeString("name"),\n    summary: t.exposeString("summary"),'));
          await modify(input.cwd, apiTest, source => source.replace('  name: "Example",', '  name: "Example",\n  summary: "Important",') + '\ntest("the reconciled summary is public and owner-scoped", async () => { const f = fixture(); const result = await f.run("{ projects { id summary } }"); assert.equal(result.errors, undefined); assert.equal(result.data!.projects[0].summary, "Important"); assert.deepEqual(f.calls.filter(call => call.method === "list"), [{method:"list",value:"user-1"}]); });\n');
          await modify(input.cwd, repositoryTest, source => source.replace('name: "Example",', 'name: "Example", summary: "Important",') + '\ntest("the repository preserves the new projected summary", async () => { const {repository}=fixture(); assert.equal((await repository.listByOwner("owner"))[0]!.summary,"Important"); });\n');
        } else if (input.prompt.includes("Own only the Client operations contract stage")) {
          await modify(input.cwd, operations, source => source.replace("    name\n", "    name\n    summary\n"));
          await modify(input.cwd, operationTest, source => source.replace('.toEqual(["id", "name",', '.toEqual(["id", "name", "summary",').replace('      name: "Example",', '      name: "Example",\n      summary: "Important",') + `
it("the new summary reaches Query options through the assembled schema and actual repository", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { graphql } = require("graphql");
  const { schema } = await import("../../../../compute/http/graphql-api/schema/index");
  const { createProjectRepository } = await import("../../../../packages/database/src/projects");
  const filters: unknown[] = [];
  const project = { id:"project",ownerId:"owner",name:"Example",summary:"Important",archived:false,createdAt:"2026-01-01",updatedAt:"2026-01-01" };
  const repository = createProjectRepository({orm:{public:{Project:{where:(filter:unknown)=>{filters.push(filter);return{all:async()=>[project]};}}}}} as unknown as import("../../../../packages/database/src/client").DatabaseClient);
  const contextValue = {session:{payload:{sub:"subject"}},database:{users:{findByCognitoSub:async()=>({id:"owner"})},projects:repository}};
  execute.mockImplementation(async (document, variables) => { const result=await graphql({schema,source:String(document),variableValues:variables as Record<string,unknown>,contextValue}); expect(result.errors).toBeUndefined(); return result.data; });
  const queryClient = client(); const results = await queryClient.fetchQuery(projectsQuery);
  expect(results[0]!.summary).toBe("Important"); expect(filters).toEqual([{ownerId:"owner"}]); queryClient.clear();
});\n`);
          await put(input.cwd, "client-app/src/ProjectSummaryConsumer.tsx", 'import {useQuery} from "@tanstack/react-query";\nimport {projectsQuery} from "./api/projects/operations";\nexport function ProjectSummaryConsumer(){const {data=[]}=useQuery(projectsQuery);return <ul>{data.map(project=><li key={project.id}>{project.summary}</li>)}</ul>;}\n');
        } else throw new Error("Unexpected provider stage in realistic contract fixture.");
        assert.ok(input.scratchDir);
        await writeFile(contractDecisionReportPath(input.scratchDir), '{"status":"resolved"}');
        return { status: "completed", sessionId: "disposable-real-contract-session" };
      },
    });
    tasks.start();
    const context = buildContractCodingContext(changed, "api");
    const decisions = established(contractDecisions("client", context.affected, context.decisions));
    const task = tasks.submit({ requestKey: "real-contract-propagation", provider: "codex", prompt: "Expose the new read-only Project summary, preserve ownership and cache rules, and display it in a consumer.", contract: { ...context, decisions }, contractRun: "stage" });
    let checkpoint = await settled(tasks, task.id);
    assert.equal(checkpoint.status, "awaiting_review", JSON.stringify(checkpoint));
    assert.equal(checkpoint.contract?.stage, "api");
    assert.equal(checkpoint.contract?.status, "ready");
    assert.deepEqual(stages, ["api"], "a stage-only run pauses before Codegen");
    assert.ok(checkpoint.contract!.checkpoints[0]?.checks.every(check => check.status === "passed"));
    progress("The individual API stage completed. Continuing the same candidate through Codegen and client.");
    await tasks.continueContract(task.id, checkpoint.proposalDigest!, undefined, "sequential");
    checkpoint = await settled(tasks, task.id);
    assert.equal(checkpoint.status, "awaiting_review", JSON.stringify(checkpoint));
    assert.equal(checkpoint.contract?.status, "ready");
    assert.equal(checkpoint.contract?.stage, "client");
    assert.deepEqual(stages, ["api", "codegen", "client"]);
    const checkpointStatuses = checkpoint.contract.checkpoints.map(({ stage, status }) => [stage, status] as const);
    assert.deepEqual(checkpointStatuses.sort(([left], [right]) => left.localeCompare(right)), [["api", "passed"], ["client", "passed"], ["codegen", "passed"]]);
    assert.equal(turns, 2, "Codegen is mechanical and never invokes the provider");
    const proposal = tasks.proposal(task.id);
    assert.ok(proposal.changes.some(change => change.path === "client-app/src/api/generated/graphql.ts"));
    assert.equal((await readFile(path.join(root, api), "utf8")).includes('summary: t.exposeString("summary")'), false);
    await tasks.approve(task.id, proposal.digest);
    checkpoint = await settled(tasks, task.id);
    assert.equal(checkpoint.status, "completed", JSON.stringify(checkpoint));
    assert.equal(checkpoint.sourceOutcome, "applied");
    progress("One final guarded application completed; saved-source reviews remain unchanged.");
    const afterApply = await chain.load(true);
    const savedSourceInitiallyRejected = afterApply.links.some(link => link.confidence.status !== "verified");
    assert.equal(savedSourceInitiallyRejected, true, "candidate proof cannot accept saved-source evidence");
    await assert.rejects(accept({ kind: "client" }), /Database|checks|predecessor|API|Codegen/i);
    const sourceScratch = path.join(directory, "source-emit"); await mkdir(sourceScratch);
    const emitted = await run({ provider: "codex", cwd: root, scratchDir: sourceScratch, command: { file: process.execPath, args: [projectCliEntry(root), "db:generate"] }, signal: AbortSignal.timeout(300_000), onEvent: async () => {}, timeoutMs: 300_000 });
    assert.equal(emitted.exitCode, 0, emitted.stderr);
    const saved = await chain.load(true);
    const savedBackend = (["database", "api"] as const).map(stage => {
      const check = saved.verification[stage];
      return { stage, status: check.status, codes: check.status === "passed" ? [] : check.diagnostics.slice(0, 8).map(item => item.code) };
    });
    progress(`Saved-source database and API checks ${JSON.stringify(savedBackend)}.`);
    assert.ok(savedBackend.every(check => check.status === "passed"), JSON.stringify(savedBackend));
    await accept({ kind: "model", model: "Project" });
    await accept({ kind: "api" });
    await accept({ kind: "client" });
    progress("Saved-source model, API and client reviews independently renewed.");
    const final = await chain.load();
    assert.ok(final.links.every(link => link.confidence.status === "verified"), JSON.stringify(final.links));
    const reports: unknown[] = [];
    const cliExitCode = await runContractGate(root, report => reports.push(report));
    assert.equal(cliExitCode, 0, JSON.stringify(reports));
    progress("Independent checkout/CLI gate passed after explicit saved-source proof renewal.");
    assert.equal(readSourceManifest(repository).digest, authorityBefore, "the real application is never modified");
    complete = true;
    return { stages, providerTurns: turns, appliedFiles: proposal.changes.map(change => change.path), independentChecks: checks, savedSourceInitiallyRejected, finalConfidence: final.links.map(link => link.confidence.status), sourceAuthorityUnchanged: true, cliExitCode };
  } finally {
    await tasks?.close(); await chain?.dispose();
    if (complete || !retainFailure) await rm(directory, { recursive: true, force: true });
    else progress(`Retained failed disposable fixture for inspection: ${directory}`);
  }
}

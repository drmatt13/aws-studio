import assert from "./support/assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test, type TestContext } from "node:test";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import { dependencyContentIdentity } from "aws-studio/contract-chain/dependencies";
import { syncBuiltinESMExports } from "node:module";
import { assertContractControl, assertContractOrigin, ContractDocumentRepairRequired, contractInputDigest, refreshContractContext, validateContractCandidate as validateActualContractCandidate, type ContractToolchain } from "../server/agent-runtime/contract-validation";
import { prepareAgentWorkspace, readSourceManifest } from "aws-studio/source/workspace";
import { GraphQLChainInspector } from "aws-studio/contract-chain/inspector";
import { ChainEvaluationError, RUNTIME_CONTRACT } from "aws-studio/contract-chain/evaluation";
import { buildContractCodingContext, type ContractStage } from "../shared/contract-propagation";
import { putRuntimeArtifacts, verifiedEvaluation, fixtureProofIdentity } from "./support/chain-verification";
import { proofReceiptFixture } from "./support/contract-proof";
import { createProofReceipt, proofDigest } from "aws-studio/contract-chain/proof-core";
import { serializeReviewRecord, sdlSurface } from "aws-studio/contract-chain/core";

const validateContractCandidate = (...args: Parameters<typeof validateActualContractCandidate>) => validateActualContractCandidate(args[0], args[1], args[2], args[3], fixtureProofIdentity);

function put(root: string, file: string, text: string) { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
async function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-validation-")), root = path.join(directory, "project"); mkdirSync(root);
  put(root, "package.json", '{"name":"contract-validation-fixture","packageManager":"npm@11.19.1"}');
  put(root, ".nvmrc", "24.22.2\n");
  put(root, "packages/database/package.json", '{"name":"@repo/database"}');
  put(root, "packages/database/prisma/contract.prisma", '// use prisma-8\nmodel Project {\n id Uuid @id\n title String\n}\n');
  put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
  put(root, "public.ts", "export const current = true;\n");
  putRuntimeArtifacts(root);
  const workspace = await prepareAgentWorkspace(root, { storageDirectory: path.join(directory, "tasks"), copyDependencies: false });
  putRuntimeArtifacts(workspace.workingDirectory);
  for (const packageName of ["@graphql-codegen/cli", "prisma"]) put(workspace.workingDirectory, `node_modules/${packageName}/package.json`, JSON.stringify({ name: packageName }));
  put(workspace.workingDirectory, "node_modules/aws-studio/package.json", JSON.stringify({ name: "aws-studio", bin: { "aws-studio": "./cli/fixture.cjs" }, exports: { "./cli": "./cli/fixture.cjs" } }));
  put(workspace.workingDirectory, "node_modules/aws-studio/cli/fixture.cjs", "// fixture CLI\n");
  const worker = Buffer.from("// immutable fixture worker\n"), reporter = Buffer.from("// immutable fixture reporter\n");
  const asset = (name: string, bytes: Buffer) => { const file = path.join(directory, name); writeFileSync(file, bytes); return { file, digest: createHash("sha256").update(bytes).digest("hex") }; };
  const fixtureIdentity = await fixtureProofIdentity(root);
  const toolchain: ContractToolchain = { worker: asset("worker.cjs", worker), reporter: asset("reporter.cjs", reporter), policy: fixtureIdentity.policy, controlDependencyDigest: fixtureIdentity.toolchain.dependencyDigest };
  const options = (stage: ContractStage) => ({ workspace, stage, signal: new AbortController().signal, onOutput: () => {} });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { root, workspace, toolchain, options, worker };
}
const sdl = "type Query { value: String }";

test("current private outputs establish checks without running either generator", async t => {
  const f = await fixture(t); let calls = 0;
  const result = await validateContractCandidate(f.options("client"), f.toolchain, async () => { calls++; throw new Error("unexpected generator"); }, async () => verifiedEvaluation(sdl));
  assert.equal(calls, 0); assert.equal(result.checks.length, 6); assert.ok(result.checks.every(check => check.status === "passed"));
  assert.equal(result.proofs?.client?.scope, "candidate");
  assert.equal(result.proofs?.client?.predecessors.api, result.proofs?.api?.id);
  assert.equal(result.proofs?.client?.predecessors.codegen, result.proofs?.codegen?.id);
  assert.equal(result.proofs?.api?.review, null, "candidate validation cannot accept a saved-source decision");
});

test("unchanged sequential stages reuse one complete evaluation and source edits rerun it", async t => {
  const f = await fixture(t), evaluationCache = new Map();
  let evaluations = 0;
  const validate = (stage: ContractStage) => validateContractCandidate({ ...f.options(stage), evaluationCache }, f.toolchain,
    async () => { throw new Error("unexpected generator"); },
    async () => { evaluations++; return verifiedEvaluation(sdl); });
  for (const stage of ["api", "codegen", "client"] as const) {
    const result = await validate(stage);
    assert.ok(result.checks.every(check => check.status === "passed"));
    assert.equal(result.proofs?.[stage]?.scope, "candidate");
  }
  assert.equal(evaluations, 1);
  put(f.workspace.workingDirectory, "client-app/src/api/operations.ts", "export const key = ['changed'];\n");
  await validate("client");
  assert.equal(evaluations, 2);
});

test("passing backend tests cannot establish an API checkpoint without valid executable schema evidence", async t => {
  const f = await fixture(t), before = readSourceManifest(f.root).digest;
  for (const schema of [null, "type Query {", sdl]) {
    const result = await validateContractCandidate(f.options("api"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => {
      const value = verifiedEvaluation(sdl); value.sdl = schema;
      if (schema === sdl) value.schemaDiagnostics = [{ code: "SCHEMA_OUTPUT", message: "Executable schema has unresolved diagnostics" }];
      return value;
    });
    assert.equal(result.checks[0]?.status, "passed");
    assert.equal(result.checks[1]?.status, schema === null ? "unavailable" : "failed");
    assert.match(result.checks[1]?.detail ?? "", /executable GraphQL schema/);
  }
  assert.equal(readSourceManifest(f.root).digest, before, "invalid schema evidence never writes saved source");
});

test("authored document drift receives one deterministic feedback pass and no model loop", async t => {
  const f = await fixture(t); let evaluations = 0, generations = 0;
  const result = await validateContractCandidate(f.options("client"), f.toolchain, async options => {
    generations++; assert.match(options.command.args[0]!, /graphql-codegen/);
    assert.equal(options.command.file, options.toolchain?.node); assert.match(options.toolchain?.version ?? "", /^24\./);
    put(f.workspace.workingDirectory, "client-app/src/api/generated/gql.ts", "export {};\n");
    return { exitCode: 0, stdout: "generated", stderr: "" };
  }, async () => { const value = verifiedEvaluation(sdl); if (++evaluations === 1) { value.documentSet = "differs"; value.codegen.status = "out-of-date"; } return value; });
  assert.equal(generations, 1); assert.equal(evaluations, 2); assert.ok(result.checks.every(check => check.status === "passed"));
  assert.equal(result.codegen?.check.status, "passed");
  assert.match(result.codegen?.inputDigest ?? "", /^[a-f0-9]{64}$/);
  const stillStale = await validateContractCandidate(f.options("client"), f.toolchain, async () => { generations++; return { exitCode: 0, stdout: "generated", stderr: "" }; }, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "out-of-date"; return value; });
  assert.equal(generations, 2, "a second invocation still allows only one pass"); assert.ok(stillStale.checks.some(check => check.status === "failed"));
});

test("invalid authored documents and unavailable validation never trigger unrelated generation", async t => {
  const f = await fixture(t); let calls = 0;
  const run = async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; };
  await assert.rejects(validateContractCandidate(f.options("codegen"), f.toolchain, run, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "out-of-date"; value.documents = [{ document: "Bad", file: "operations.ts", line: 1, message: "Invalid selection" }]; return value; }), (error: unknown) => {
    assert.ok(error instanceof ContractDocumentRepairRequired);
    assert.equal(error.code, "AUTHORED_DOCUMENT_REPAIR_REQUIRED");
    assert.equal(error.checks[2]?.status, "failed");
    assert.match(error.checks[2]?.detail ?? "", /operations.ts:1 \(Bad\): Invalid selection/);
    assert.match(error.inputDigest, /^[a-f0-9]{64}$/);
    return true;
  });
  await assert.rejects(validateContractCandidate(f.options("api"), f.toolchain, run, async () => { throw new ChainEvaluationError("SANDBOX_UNAVAILABLE", "sandbox unavailable"); }), /sandbox unavailable/);
  const unavailable = await validateContractCandidate(f.options("api"), f.toolchain, run, async () => { const value = verifiedEvaluation(sdl); value.verification = { ...value.verification, database: { status: "unavailable", diagnostics: [{ code: "UNAVAILABLE", message: "Runner missing" }] } }; return value; });
  assert.equal(unavailable.checks[0]?.status, "unavailable"); assert.equal(calls, 0);
});

test("known invalid client documents remain an inspectable failed proposal and configuration failures never route repair", async t => {
  const f = await fixture(t); let calls = 0;
  const run = async () => { calls++; return { exitCode: 0, stdout: "", stderr: "" }; };
  const client = await validateContractCandidate(f.options("client"), f.toolchain, run, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "unknown"; value.documents = [{ document: "RemovedField", file: "client-app/src/api/projects/operations.ts", line: 8, message: "Cannot query field previousName on type Project" }]; return value; });
  assert.equal(client.checks[2]?.status, "failed"); assert.equal(client.codegen?.check.status, "failed");
  assert.match(client.checks[2]?.detail ?? "", /operations.ts:8/); assert.equal(calls, 0);
  const unknown = await validateContractCandidate(f.options("codegen"), f.toolchain, run, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "unknown"; value.documentDiagnostics = [{ code: "DOCUMENT_EVIDENCE", file: "codegen.ts", message: "Unsupported Codegen configuration" }]; return value; });
  assert.equal(unknown.checks[2]?.status, "unavailable");
  await assert.rejects(validateContractCandidate(f.options("codegen"), f.toolchain, run, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "unknown"; value.documentDiagnostics = [{ code: "DOCUMENT_SYNTAX", file: "client-app/src/api/projects/operations.ts", line: 3, message: "Syntax Error: Expected Name" }]; return value; }), ContractDocumentRepairRequired);
  const invalidApi = await validateContractCandidate(f.options("codegen"), f.toolchain, run, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "unknown"; value.documents = [{ document: "Bad", file: "operations.ts", line: 1, message: "Invalid selection" }]; value.verification = { ...value.verification, api: { status: "failed", diagnostics: [{ code: "API_FAILED", message: "Backend tests failed" }] } }; return value; });
  assert.equal(invalidApi.checks[1]?.status, "failed"); assert.equal(invalidApi.checks[2]?.status, "failed");
  assert.equal(calls, 0);
});

test("only a proven stale database contract invokes the related private emitter once", async t => {
  const f = await fixture(t); let calls = 0, evaluations = 0;
  const result = await validateContractCandidate(f.options("api"), f.toolchain, async options => { calls++; assert.equal(options.cwd, f.workspace.workingDirectory); assert.deepEqual(options.command.args, [path.join(f.workspace.workingDirectory, "node_modules/aws-studio/cli/fixture.cjs"), "db:generate"]); return { exitCode: 0, stdout: "", stderr: "" }; }, async () => { const value = verifiedEvaluation(sdl); if (++evaluations === 1) value.verification = { ...value.verification, database: { status: "failed", diagnostics: [{ code: "GENERATED_DATABASE_STALE", message: "stale" }] } }; return value; });
  assert.equal(calls, 1); assert.ok(result.checks.every(check => check.status === "passed"));
});

test("generators cannot change authored source or publish truncated evidence", async t => {
  for (const truncated of [false, true]) {
    const f = await fixture(t);
    await assert.rejects(validateContractCandidate(f.options("codegen"), f.toolchain, async () => { if (!truncated) put(f.workspace.workingDirectory, "public.ts", "export const overwritten = true;\n"); return { exitCode: 0, stdout: "", stderr: "", outputTruncated: truncated }; }, async () => { const value = verifiedEvaluation(sdl); value.codegen.status = "out-of-date"; return value; }), truncated ? /incomplete output/ : /outside its declared generated outputs/);
    assert.equal(readFileSync(path.join(f.root, "public.ts"), "utf8"), "export const current = true;\n");
  }
});

test("source, emitted-artifact and dependency edits during evaluation reject every receipt", async t => {
  for (const changed of ["public.ts", RUNTIME_CONTRACT, "node_modules/prisma/package.json"]) {
    const f = await fixture(t);
    await assert.rejects(validateContractCandidate(f.options("api"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => { put(f.workspace.workingDirectory, changed, changed.endsWith("json") ? '{"changed":true}\n' : "export const changed = true;\n"); return verifiedEvaluation(sdl); }), /changed during independent contract validation/);
  }
});

test("installed dependency mutation and restoration during validation cannot establish proof", async t => {
  const f = await fixture(t), file = "node_modules/prisma/package.json";
  const original = readFileSync(path.join(f.workspace.workingDirectory, file), "utf8"), before = readSourceManifest(f.root).digest;
  await assert.rejects(validateContractCandidate(f.options("api"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => {
    put(f.workspace.workingDirectory, file, '{"name":"prisma","changed":true}'); put(f.workspace.workingDirectory, file, original);
    return verifiedEvaluation(sdl);
  }), /changed during independent contract validation/);
  assert.equal(readSourceManifest(f.root).digest, before, "rejected proof never writes saved source");
});

test("edits during receipt identity capture reject publication after otherwise passing checks", async t => {
  const f = await fixture(t), before = readSourceManifest(f.root).digest;
  await assert.rejects(validateActualContractCandidate(f.options("client"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => verifiedEvaluation(sdl), async root => {
    put(root, "client-app/src/consumer.ts", "export const changedDuringPublication = true;\n");
    return fixtureProofIdentity(root);
  }), /changed while publishing independent evidence/);
  assert.equal(readSourceManifest(f.root).digest, before, "partially created receipts cannot affect saved-source authority");
});

test("model and review edits restored during receipt creation cannot renew candidate proof", async t => {
  for (const file of ["packages/database/prisma/contract.prisma", "graphql-chain.review.json"]) {
    const f = await fixture(t), before = readSourceManifest(f.root).digest;
    const original = readFileSync(path.join(f.workspace.workingDirectory, file), "utf8");
    await assert.rejects(validateActualContractCandidate(f.options("client"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => verifiedEvaluation(sdl), async root => {
      put(root, file, `${original}\n// concurrent edit\n`); put(root, file, original);
      return fixtureProofIdentity(root);
    }), /changed while publishing independent evidence/);
    assert.equal(readSourceManifest(f.root).digest, before, "restored content never permits stale validation to publish");
  }
});

test("a pinned host cannot attribute fresh proof to a different installed control implementation", async t => {
  const f = await fixture(t), before = readSourceManifest(f.root).digest;
  await assert.rejects(validateActualContractCandidate(f.options("client"), { ...f.toolchain, controlDependencyDigest: "0".repeat(64) }, async () => { throw new Error("unexpected generator"); }, async () => verifiedEvaluation(sdl), fixtureProofIdentity), /pinned host control implementation|Restart the agent host/);
  assert.equal(readSourceManifest(f.root).digest, before);
});

test("a pinned host compares candidate dependencies with the selected project's installation", async t => {
  const f = await fixture(t), identity = await fixtureProofIdentity(f.root);
  const toolchain = { ...f.toolchain, controlDependencyDigest: "0".repeat(64), projectDependencyDigest: identity.toolchain.dependencyDigest };
  const run = () => { throw new Error("unexpected generator"); };
  const evaluate = async () => verifiedEvaluation(sdl);
  await validateActualContractCandidate(f.options("client"), toolchain, run, evaluate, fixtureProofIdentity);
  await assert.rejects(validateActualContractCandidate(f.options("client"), { ...toolchain, projectDependencyDigest: "f".repeat(64) }, run, evaluate, fixtureProofIdentity), /Restart the agent host/);
  await assert.rejects(validateActualContractCandidate(f.options("client"), { ...toolchain, projectDependencyDigest: null }, run, evaluate, fixtureProofIdentity), /no pinned project installation/);
});

test("legacy worker assets cannot bypass complete control identity requirements", async t => {
  const f = await fixture(t), before = readSourceManifest(f.root).digest;
  const legacy = { worker: f.toolchain.worker, reporter: f.toolchain.reporter, policy: f.toolchain.policy };
  assert.throws(() => assertContractControl(legacy), /predates|restart the agent host/);
  await assert.rejects(validateContractCandidate(f.options("client"), legacy, async () => { throw new Error("must not execute"); }, async () => { throw new Error("must not inspect"); }), /predates|restart the agent host/);
  assert.equal(readSourceManifest(f.root).digest, before);
});

test("candidate input identities track accepted API origins while unrelated client notes remain local", async t => {
  const f = await fixture(t), before = readSourceManifest(f.root).digest;
  const { id: _originalApiId, ...apiSource } = proofReceiptFixture("api"), { id: _originalClientId, ...clientSource } = proofReceiptFixture("client");
  const api = createProofReceipt({ ...apiSource, inputs: { ...apiSource.inputs, implementation: "1".repeat(64) } }), client = createProofReceipt({ ...clientSource, inputs: { ...clientSource.inputs, implementation: "2".repeat(64) } });
  const record = { version: 3 as const, prisma: null, client: sdlSurface(sdl), bindings: { api: "1".repeat(64), client: { inputs: "2".repeat(64), upstream: client.predecessors.api! } }, proofs: { api, client } };
  put(f.workspace.workingDirectory, "graphql-chain.review.json", serializeReviewRecord(record));
  const first = await contractInputDigest(f.workspace, "api", f.toolchain);
  const { id: _clientId, ...clientBody } = client;
  const clientDecision = { statement: "Retain approved query selections and cache behavior.", evidence: "The client was explicitly reviewed without changing source." };
  const clientOnly = { ...record, proofs: { ...record.proofs, client: createProofReceipt({ ...clientBody, review: { scope: "client", decision: clientDecision }, decisionDigest: proofDigest(clientDecision) }) } };
  put(f.workspace.workingDirectory, "graphql-chain.review.json", serializeReviewRecord(clientOnly));
  assert.equal(await contractInputDigest(f.workspace, "api", f.toolchain), first);
  const { id: _apiId, ...apiBody } = api;
  const apiDecision = { statement: "Retain the same public API and owner filters.", evidence: "The source and passing backend tests were deliberately reviewed again." };
  put(f.workspace.workingDirectory, "graphql-chain.review.json", serializeReviewRecord({ ...clientOnly, proofs: { ...clientOnly.proofs, api: createProofReceipt({ ...apiBody, review: { scope: "api", decision: apiDecision }, decisionDigest: proofDigest(apiDecision) }) } }));
  assert.notEqual(await contractInputDigest(f.workspace, "api", f.toolchain), first, "refresh must rewind API before a downstream receipt can be published");
  assert.equal(readSourceManifest(f.root).digest, before, "origin identity capture never writes saved source");
});

test("origin uses the existing inspector and refuses caller-forged predecessor approval", async t => {
  const f = await fixture(t), evaluate = async () => verifiedEvaluation(sdl);
  const inspector = new GraphQLChainInspector(f.root, { evaluate, portableIdentity: fixtureProofIdentity, workerBundle: async () => f.worker });
  const chain = await inspector.load(true), before = readSourceManifest(f.root).digest;
  await inspector.dispose();
  const api = buildContractCodingContext(chain, "api");
  const phases: string[] = [];
  await assertContractOrigin(f.root, api, f.toolchain, { evaluate, portableIdentity: fixtureProofIdentity, onProgress: phase => phases.push(phase) });
  assert.deepEqual(phases, ["starting", "source", "checks", "recheck", "proof", "recheck"], "origin reports actual host inspection phases while preserving its independent checks");
  const downstream = buildContractCodingContext(chain, "codegen");
  await assert.rejects(assertContractOrigin(f.root, { ...downstream, predecessors: downstream.predecessors.map(predecessor => ({ ...predecessor, status: "verified" })) }, f.toolchain, { evaluate, portableIdentity: fixtureProofIdentity }), /predecessors are not verified/);
  await assert.rejects(assertContractOrigin(f.root, { ...api, sourceRevision: "stale" }, f.toolchain, { evaluate, portableIdentity: fixtureProofIdentity }), /source or review evidence changed/);
  assert.equal(readSourceManifest(f.root).digest, before, "rejected origins perform zero writes");
});

test("unreviewed model additions carry their canonical shape and refreshed decisions stay explicit", async t => {
  const f = await fixture(t), evaluate = async () => verifiedEvaluation(sdl);
  const first = await refreshContractContext(f.root, "api", [], f.toolchain, undefined, { evaluate, portableIdentity: fixtureProofIdentity });
  assert.equal(first.affected[0]?.subject, "Project");
  assert.equal(first.affected[0]?.change, "added");
  assert.match(first.affected[0]?.after ?? "", /"title"/);
  const established = first.decisions.map(decision => ({ ...decision, status: "established" as const, value: "Keep this field private.", evidence: "Developer reviewed the application requirement." }));
  const unchanged = await refreshContractContext(f.root, "client", established, f.toolchain, first, { evaluate, portableIdentity: fixtureProofIdentity });
  assert.equal(unchanged.stage, "client", "saved review stamps do not override the host's effective candidate stage");
  assert.deepEqual(unchanged.decisions.filter(decision => decision.kind === "exposure"), established.filter(decision => decision.kind === "exposure"));
  const before = readFileSync(path.join(f.root, "packages/database/prisma/contract.prisma"), "utf8");
  put(f.root, "packages/database/prisma/contract.prisma", before.replace(" title String", " title String\n privateNote String?"));
  const changed = await refreshContractContext(f.root, "api", established, f.toolchain, first, { evaluate, portableIdentity: fixtureProofIdentity });
  assert.notEqual(changed.sourceRevision, first.sourceRevision);
  assert.match(changed.affected[0]?.after ?? "", /privateNote/);
  assert.ok(changed.decisions.every(decision => decision.status === "unresolved"), "changed model evidence requires renewed decisions, retaining their proposed values as context");
  assert.equal(first.decisions[0]?.status, "unresolved", "the original request context is never mutated");
});


test("origin and refreshed context propagate cancellation into restricted evaluation and await cleanup", async t => {
  for (const refresh of [false, true]) await t.test(refresh ? "refreshed context" : "origin", async child => {
    const f = await fixture(child), controller = new AbortController();
    let entered!: () => void, release!: () => void, aborted!: () => void, cleaned = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stop = new Promise<void>(resolve => { aborted = resolve; });
    const drain = new Promise<void>(resolve => { release = resolve; });
    const reader = new GraphQLChainInspector(f.root, { workerBundle: async () => f.worker, portableIdentity: fixtureProofIdentity, evaluate: async () => verifiedEvaluation(sdl) });
    const context = buildContractCodingContext(await reader.load(true), "api"); await reader.dispose();
    const evaluate = async (_root: string, signal: AbortSignal) => {
      const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { aborted(); void drain.then(() => { cleaned = true; reject(signal.reason); }); }, { once: true }));
      entered(); return stopped;
    };
    const operation = refresh
      ? refreshContractContext(f.root, "api", context.decisions, f.toolchain, context, { evaluate, portableIdentity: fixtureProofIdentity }, controller.signal)
      : assertContractOrigin(f.root, context, f.toolchain, { evaluate, portableIdentity: fixtureProofIdentity }, controller.signal);
    const rejected = assert.rejects(operation, /cancel contract origin/);
    await started; controller.abort(new Error("cancel contract origin")); await stop;
    assert.equal(cleaned, false);
    release(); await rejected;
    assert.equal(cleaned, true, "origin waits until the restricted child has drained");
  });
});


test("candidate cancellation reaches installed dependency and source identity capture before evaluation", async t => {
  for (const dependencyCheck of [false, true]) await t.test(dependencyCheck ? "workspace dependency guard" : "evaluation source identity", async child => {
    const f = await fixture(child), controller = new AbortController();
    for (let index = 0; index < 24; index++) put(f.workspace.workingDirectory, `node_modules/example/file-${index}.js`, "export const value = 1;\n");
    const original = fsPromises.open;
    let opened = 0, active = 0, evaluations = 0, identities = 0;
    mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original(...args);
      if (String(args[0]).startsWith(path.join(f.workspace.workingDirectory, "node_modules") + path.sep)) {
        opened++; active++;
        const close = handle.close.bind(handle);
        handle.close = async () => { try { await close(); } finally { active--; } };
        controller.abort(new Error("cancel candidate dependency capture"));
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const options = { ...f.options("api"), signal: controller.signal, workspace: dependencyCheck ? { ...f.workspace, dependencyDigest: "0".repeat(64) } : f.workspace };
      await assert.rejects(validateActualContractCandidate(options, f.toolchain, async () => { throw new Error("unexpected generation"); }, async () => { evaluations++; return verifiedEvaluation(sdl); }, async root => { identities++; return fixtureProofIdentity(root); }), /cancel candidate dependency capture/);
      assert.ok(opened > 0 && opened <= 8, "the current bounded read batch drains before cancellation returns");
      assert.equal(active, 0); assert.equal(evaluations, 0); assert.equal(identities, 0);
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test("candidate cancellation reaches portable proof identity and waits for its cleanup without publishing", async t => {
  const f = await fixture(t), controller = new AbortController();
  let entered!: () => void, release!: () => void, aborted!: () => void, cleaned = false, settled = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stop = new Promise<void>(resolve => { aborted = resolve; });
  const drain = new Promise<void>(resolve => { release = resolve; });
  const operation = validateActualContractCandidate({ ...f.options("client"), signal: controller.signal }, f.toolchain,
    async () => { throw new Error("unexpected generation"); }, async () => verifiedEvaluation(sdl), async (_root, _policy, signal) => {
      assert.equal(signal, controller.signal);
      const stopped = new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => { aborted(); void drain.then(() => { cleaned = true; reject(signal!.reason); }); }, { once: true }));
      entered(); return stopped;
    });
  const rejected = assert.rejects(operation, /cancel candidate portable identity/);
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await started; controller.abort(new Error("cancel candidate portable identity")); await stop;
  assert.equal(cleaned, false); assert.equal(settled, false);
  release(); await rejected;
  assert.equal(cleaned, true);
});

test("an identity seam returning after cancellation cannot publish candidate receipts", async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(validateActualContractCandidate({ ...f.options("api"), signal: controller.signal }, f.toolchain,
    async () => { throw new Error("unexpected generation"); }, async () => verifiedEvaluation(sdl), async root => {
      const identity = await fixtureProofIdentity(root);
      controller.abort(new Error("cancel before candidate publication"));
      return identity;
    }), /cancel before candidate publication/);
});


test("queued cancellation interrupts inspector dependency baseline capture before evaluation", async t => {
  const f = await fixture(t), controller = new AbortController(), reason = new Error("Cancel inspector metadata baseline");
  for (let index = 0; index < 128; index++) put(f.root, `node_modules/large/part-${index}.js`, `export const part = ${index};`);
  let evaluations = 0;
  const inspector = new GraphQLChainInspector(f.root, { signal: controller.signal, proofPolicy: f.toolchain.policy, identity: async () => "fixture-identity", evaluate: async () => { evaluations++; return verifiedEvaluation(sdl); } });
  setImmediate(() => controller.abort(reason));
  try { await assert.rejects(inspector.load(true), error => error === reason); }
  finally { await inspector.dispose(); }
  assert.equal(evaluations, 0, "cancelled baseline capture cannot enter independent evaluation");
});


test("candidate validation closes exactly two warm dependency inventories before returning receipts", async t => {
  const f = await fixture(t);
  await dependencyContentIdentity(f.workspace.workingDirectory);
  let inventories = 0;
  const original = fs.lstatSync;
  mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => {
    if (options?.bigint && path.resolve(String(file)) === path.join(f.workspace.workingDirectory, "node_modules")) inventories++;
    return original(file, options as undefined);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  try {
    const result = await validateContractCandidate(f.options("client"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => verifiedEvaluation(sdl));
    assert.ok(result.checks.every(check => check.status === "passed"));
    assert.ok(result.proofs?.client);
    assert.equal(inventories, 2, "nested guards share the opening inventory until a fresh closing scan succeeds");
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

test("document repair receipts cannot escape a failed closing dependency guard", async t => {
  const f = await fixture(t);
  await assert.rejects(validateContractCandidate(f.options("codegen"), f.toolchain, async () => { throw new Error("unexpected generator"); }, async () => {
    put(f.workspace.workingDirectory, "node_modules/prisma/changed.js", "export const changed = true;\n");
    const value = verifiedEvaluation(sdl);
    value.codegen.status = "out-of-date";
    value.documents = [{ document: "Bad", file: "operations.ts", line: 1, message: "Invalid selection" }];
    return value;
  }), (error: unknown) => {
    assert.equal(error instanceof ContractDocumentRepairRequired, false, "repair exceptions carry API receipts and require a successful closing guard");
    assert.match(String(error), /dependencies changed during independent contract validation/);
    return true;
  });
});

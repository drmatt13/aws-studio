import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { GraphQLChainService, PRISMA_FILE, REVIEW_FILE, recordContents } from "../server/graphql-chain/service";
import { GraphQLChainReviews } from "../server/graphql-chain/review";
import { canonicalPrisma, fingerprint, parseReviewRecord, serializeReviewRecord, sdlSurface } from "aws-studio/contract-chain/core";
import { canonicalEvidence, createProofReceipt, proofDigest, readProofReceipt, readReviewDecision } from "aws-studio/contract-chain/proof-core";
import { buildContractProof, candidateApiOrigin } from "aws-studio/contract-chain/proof";
import { contractGateExitCode } from "aws-studio/contract-chain/ci";
import { CONTRACT_PROOF_POLICY_FILES } from "aws-studio/contract-chain/portable-identity";
import { dependencyMetadata } from "aws-studio/contract-chain/dependencies";
import { fixtureDecisionsFor, fixtureProofIdentity, fixtureReviewDecisions, putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";
import { readSourceManifest } from "aws-studio/source/workspace";
import type { GraphQLChainReviewRecordV3, ReviewScope } from "aws-studio/contract-chain/graphql-chain";

const schema = "type Project { id: ID! name: String! } type Query { projects: [Project!]! }";
const prisma = "// use prisma-8\nmodel Project {\n id Uuid @id\n name String\n}\n";
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "studio-contract-proof-"));
  const put = (file: string, value: string) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value); };
  put(PRISMA_FILE, prisma); putRuntimeArtifacts(root);
  put("compute/http/graphql-api/schema/project.ts", "export const ownerRule = true;\n");
  put("client-app/src/api/projects/operations.ts", "export const key = ['projects'];\n");
  put("client-app/src/api/generated/schema.graphql", schema);
  put("codegen.ts", "export default { fixture: true };\n");
  const evaluation = verifiedEvaluation(schema); evaluation.authoredDocumentsDigest = "d".repeat(64);
  let policy = "f".repeat(64), version = "1", dependencyDigest = "1".repeat(64);
  const reader = new GraphQLChainService(root, { identity: async () => fingerprint([Object.fromEntries(Object.entries(readSourceManifest(root).files).filter(([name]) => name !== REVIEW_FILE)), evaluation, policy, version, dependencyDigest]),
    evaluate: async () => evaluation, portableIdentity: async root => { const identity = await fixtureProofIdentity(root); return { ...identity, policy: { ...identity.policy, digest: policy }, toolchain: { ...identity.toolchain, dependencyDigest, packages: { fixture: version } } }; } });
  const reviews = new GraphQLChainReviews(reader);
  const accept = async (scope: ReviewScope) => { const source = await reader.load(); const plan = await reviews.review({ scope, expectedRevision: source.revision, decisions: fixtureDecisionsFor(scope) }); await reviews.accept({ reviewId: plan.reviewId, expectedRevision: source.revision }); return reader.load(); };
  const record = () => parseReviewRecord(recordContents(root)!) as GraphQLChainReviewRecordV3;
  t.after(async () => { await reader.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, put, evaluation, reader, reviews, accept, record, policy: (next: string) => { policy = next; }, toolVersion: (next: string) => { version = next; }, dependency: (next: string) => { dependencyDigest = next; } };
}

test("complete content-bound lineage is independently reconstructed and every predecessor is exact", async t => {
  const f = fixture(t), chain = await f.accept({ kind: "baseline" });
  assert.equal(contractGateExitCode(chain), 0);
  const record = f.record(); assert.equal(record.version, 3);
  for (const view of chain.proof.stages) {
    assert.equal(view.status, "verified"); assert.equal(view.current?.id, view.recorded?.id);
    assert.deepEqual(readProofReceipt(record.proofs[view.stage]), view.current);
  }
  assert.equal(record.proofs.api!.predecessors.database, record.proofs.database!.id);
  assert.equal(record.proofs.codegen!.predecessors.api, record.proofs.api!.id);
  assert.equal(record.proofs.client!.predecessors.api, record.proofs.api!.id);
  assert.equal(record.proofs.client!.predecessors.codegen, record.proofs.codegen!.id);
});

test("Prisma prose preserves proof while changed declarations require ordered stage renewal", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" });
  const original = f.record();
  f.put(PRISMA_FILE, prisma + "\n// Explain why every project has a name.\n");
  assert.equal(contractGateExitCode(await f.reader.load()), 0, "portable proof ignores prose-only changes");
  f.put(PRISMA_FILE, prisma.replace(" id Uuid @id\n name String", " name String\n id Uuid @id"));
  let chain = await f.reader.load();
  assert.deepEqual(chain.links.map(link => link.confidence.status), ["stale", "blocked", "blocked"]);
  assert.equal(chain.nodes[0].fingerprint.status, "available");
  const run = async (stages: readonly ("api" | "codegen" | "client")[]) => {
    const current = await f.reader.load();
    const plan = await f.reviews.reviewStages(current.revision, stages, fixtureReviewDecisions);
    if (plan) await f.reviews.accept({ reviewId: plan.reviewId, expectedRevision: plan.expectedRevision });
    return f.reader.load();
  };
  await assert.rejects(run(["client"]), /API predecessor/);
  chain = await run(["api"]);
  assert.deepEqual(chain.links.map(link => link.confidence.status), ["verified", "stale", "blocked"]);
  assert.equal(f.record().proofs.client!.id, original.proofs.client!.id);
  chain = await run(["codegen"]);
  assert.deepEqual(chain.links.map(link => link.confidence.status), ["verified", "verified", "stale"]);
  chain = await run(["client"]);
  assert.equal(contractGateExitCode(chain), 0);
  const ledger = f.record().ledger;
  for (const [index, stage] of (["api", "codegen", "client"] as const).entries()) {
    const upstream = chain.nodes[index]!.fingerprint, downstream = chain.nodes[index + 1]!.fingerprint;
    assert.equal(upstream.status, "available");
    assert.equal(downstream.status, "available");
    if (upstream.status !== "available" || downstream.status !== "available") assert.fail("Expected saved hashes");
    assert.equal(ledger?.[stage]?.source, upstream.value);
    assert.equal(ledger?.[stage]?.output, downstream.value);
  }
  const accepted = recordContents(f.root);
  await run(["api", "codegen", "client"]);
  assert.equal(recordContents(f.root), accepted, "unchanged checks and decisions produce identical receipts");
  assert.notEqual(f.record().proofs.codegen!.id, original.proofs.codegen!.id);
  assert.deepEqual(f.record().proofs.codegen!.outputs, original.proofs.codegen!.outputs);
  f.put("client-app/src/api/projects/operations.ts", "export const key = ['projects', 'changed'];\n");
  chain = await f.reader.load();
  assert.deepEqual(chain.links.map(link => link.confidence.status), ["verified", "verified", "stale"]);
  f.evaluation.verification = { ...f.evaluation.verification, client: { status: "failed", diagnostics: [{ code: "CACHE_BROKEN", message: "Cache invalidation failed" }] } };
  await assert.rejects(run(["client"]), /check must pass|checks must pass/);
  assert.equal(recordContents(f.root), accepted, "failed saved-source checks cannot publish approvals");
});

test("canonical key and unordered check order reproduce identity while malformed evidence is rejected", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" });
  const receipt = f.record().proofs.client!;
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  assert.equal(readProofReceipt(reordered).id, receipt.id);
  assert.equal(readProofReceipt({ ...receipt, checks: [...receipt.checks].reverse() }).id, receipt.id);
  assert.equal(proofDigest({ a: 1, b: { x: 2, y: 3 } }), proofDigest({ b: { y: 3, x: 2 }, a: 1 }));
  assert.throws(() => canonicalEvidence({ value: undefined }), /plain object/);
  assert.throws(() => readProofReceipt({ ...receipt, id: "0".repeat(64) }), /content identity/);
  assert.throws(() => readProofReceipt({ ...receipt, version: 8 }), /unsupported/);
  assert.throws(() => readProofReceipt({ ...receipt, extraPassed: true }), /unexpected/);
  assert.throws(() => readProofReceipt({ ...receipt, checks: [] }), /outcomes are missing/);
  assert.throws(() => createProofReceipt({ ...receipt, checks: [receipt.checks[0]!, receipt.checks[0]!] }), /validation outcome/);
  const { id: _id, ...body } = receipt;
  const sorted = createProofReceipt({ ...body, checks: ["é", "a", "Z"].map(id => ({ ...receipt.checks[0]!, id, diagnostics: [{ code: "é" }, { code: "Z" }] })) });
  assert.deepEqual(sorted.checks.map(check => check.id), ["Z", "a", "é"], "canonical receipt ordering cannot depend on the machine's collation locale");
  assert.deepEqual(sorted.checks[0]!.diagnostics.map(item => item.code), ["Z", "é"]);
});

test("missing and corrupt recorded receipts cannot establish confidence or improper renewal", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" });
  const accepted = f.record(), missing = { ...accepted, proofs: { ...accepted.proofs } }; delete missing.proofs.database;
  f.put(REVIEW_FILE, serializeReviewRecord(missing));
  assert.equal(contractGateExitCode(await f.reader.load()), 1);
  assert.notEqual((await f.reader.load()).links[0].confidence.status, "verified");
  await f.accept({ kind: "api" });
  assert.equal(contractGateExitCode(await f.reader.load()), 0, "identical renewed evidence restores missing predecessor without source edits");
  const corrupt = JSON.parse(recordContents(f.root)!); corrupt.proofs.api.id = "0".repeat(64);
  f.put(REVIEW_FILE, JSON.stringify(corrupt)); const before = recordContents(f.root);
  const chain = await f.reader.load(); assert.equal(chain.record, "invalid");
  await assert.rejects(f.reviews.review({ expectedRevision: chain.revision, scope: { kind: "api" }, decisions: { api: fixtureReviewDecisions.api } }), /invalid review record/);
  assert.equal(recordContents(f.root), before);
});

test("private Prisma no-op renews API and downstream receipt lineage with byte-identical SDL and generated output", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" });
  const old = f.record();
  f.put(PRISMA_FILE, prisma.replace(" name String", " name String\n privateNote String?"));
  f.evaluation.contract!.storageHash = "b".repeat(64);
  const changed = await f.reader.load(); assert.deepEqual(changed.links.map(link => link.confidence.status), ["stale", "blocked", "blocked"]);
  await f.accept({ kind: "model", model: "Project" }); await f.accept({ kind: "api" });
  assert.equal((await f.reader.load()).links[2].confidence.status, "blocked");
  await f.accept({ kind: "client" }); const current = f.record();
  assert.equal(contractGateExitCode(await f.reader.load()), 0);
  assert.equal(current.proofs.codegen!.outputs.generated, old.proofs.codegen!.outputs.generated);
  assert.notEqual(current.proofs.api!.id, old.proofs.api!.id);
  assert.notEqual(current.proofs.codegen!.id, old.proofs.codegen!.id);
  assert.notEqual(current.proofs.client!.id, old.proofs.client!.id);
});

test("resolver-only implementation changes leave database proof current but invalidate API descendants", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const before = f.record();
  f.put("compute/http/graphql-api/schema/project.ts", "export const ownerRule = false;\n");
  const chain = await f.reader.load();
  assert.equal(chain.proof.stages[0]!.current!.id, before.proofs.database!.id);
  assert.equal(chain.links[0].confidence.status, "stale"); assert.equal(chain.links[1].confidence.status, "blocked");
  assert.notEqual(chain.nodes[1].fingerprint.status === "available" && chain.nodes[1].fingerprint.value, before.proofs.api!.outputs.schema, "the node displays source bytes, not executable SDL");
  const api = chain.proof.stages[1]!.current!;
  assert.notEqual(api.id, before.proofs.api!.id);
  for (const stage of ["codegen", "client"] as const) {
    const current = chain.proof.stages.find(view => view.stage === stage)!.current!;
    const { upstreamContent, ...ownInputs } = current.inputs;
    const { upstreamContent: previousUpstream, ...previousOwnInputs } = before.proofs[stage]!.inputs;
    assert.deepEqual(ownInputs, previousOwnInputs, `${stage} own inputs remain unchanged`);
    if (stage === "codegen") assert.notEqual(upstreamContent, previousUpstream, "Codegen commits to the changed Pothos source content");
    else assert.equal(upstreamContent, previousUpstream, "Client generated input content remains unchanged");
    assert.equal(current.implementation, before.proofs[stage]!.implementation);
    assert.deepEqual(current.outputs, before.proofs[stage]!.outputs);
    assert.notEqual(current.id, before.proofs[stage]!.id, `${stage} receipt binds the changed API predecessor`);
    assert.equal(current.predecessors.api, api.id);
  }
});

test("cache-only client edits preserve Codegen proof while document changes invalidate Codegen and client", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const before = f.record();
  f.put("client-app/src/api/projects/operations.ts", "export const key = ['projects', 'detail'];\n");
  let chain = await f.reader.load(); assert.equal(chain.proof.stages[2]!.current!.id, before.proofs.codegen!.id);
  assert.equal(chain.links[1].confidence.status, "verified"); assert.equal(chain.links[2].confidence.status, "stale");
  f.evaluation.authoredDocumentsDigest = "e".repeat(64); chain = await f.reader.load();
  assert.notEqual(chain.proof.stages[2]!.current!.id, before.proofs.codegen!.id);
  assert.equal(chain.links[2].confidence.status, "blocked");
});

test("validator policy and tool versions invalidate current acceptance even when outputs match", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" });
  f.policy("e".repeat(64)); let chain = await f.reader.load();
  assert.equal(chain.links[0].confidence.status, "stale"); assert.ok(chain.proof.stages[1]!.diagnostics.some(item => item.code === "PROOF_POLICY_CHANGED"));
  f.policy("f".repeat(64)); f.toolVersion("2"); chain = await f.reader.load();
  assert.equal(chain.links[0].confidence.status, "stale"); assert.ok(chain.proof.stages[1]!.diagnostics.some(item => item.code === "PROOF_TOOLCHAIN_CHANGED"));
});

test("changed explicit decisions renew upstream identity and block an old downstream acceptance", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const before = f.record(); const chain = await f.reader.load();
  const plan = await f.reviews.review({ scope: { kind: "api" }, expectedRevision: chain.revision, decisions: { api: { statement: "Keep the private field withheld; preserve owner-scoped writes.", evidence: "The current implementation and authorization tests were explicitly reviewed." } } });
  await f.reviews.accept({ reviewId: plan.reviewId, expectedRevision: chain.revision });
  const changed = await f.reader.load(); assert.notEqual(f.record().proofs.api!.id, before.proofs.api!.id); assert.equal(changed.links[2].confidence.status, "blocked");
  assert.equal(contractGateExitCode(changed), 1); await f.accept({ kind: "client" }); assert.equal(contractGateExitCode(await f.reader.load()), 0);
});

test("candidate descendants bind the accepted saved API proof even when only its decision changes", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" });
  const before = await f.reader.inspect();
  const candidate = buildContractProof({ ...before.proofInput!, scope: "candidate" });
  assert.equal(candidate.receipts.api!.inputs.origin, f.record().proofs.api!.id);
  const source = await f.reader.load();
  const plan = await f.reviews.review({ scope: { kind: "api" }, expectedRevision: source.revision, decisions: { api: { statement: "Retain the exact public API and reviewed owner filters.", evidence: "The same implementation and executable checks were deliberately reviewed again." } } });
  await f.reviews.accept({ reviewId: plan.reviewId, expectedRevision: source.revision });
  const after = await f.reader.inspect(), renewed = buildContractProof({ ...after.proofInput!, scope: "candidate" });
  assert.deepEqual(candidate.receipts.api!.outputs, renewed.receipts.api!.outputs);
  assert.equal(candidate.receipts.api!.implementation, renewed.receipts.api!.implementation);
  assert.equal(candidate.receipts.api!.decisionDigest, renewed.receipts.api!.decisionDigest, "the candidate adds no API choices in this downstream-only scenario");
  for (const stage of ["api", "codegen", "client"] as const) assert.notEqual(candidate.receipts[stage]!.id, renewed.receipts[stage]!.id);
  assert.equal(renewed.receipts.api!.inputs.origin, f.record().proofs.api!.id);
  assert.equal(renewed.receipts.codegen!.predecessors.api, renewed.receipts.api!.id);
  assert.equal(renewed.receipts.api!.scope, "candidate"); assert.equal(renewed.receipts.api!.review, null);
});

test("legacy candidate origins retain only the Prisma/API review surface", () => {
  const first = { version: 2 as const, prisma: null, client: null, bindings: { api: "1".repeat(64), client: null } };
  assert.notEqual(candidateApiOrigin(first), candidateApiOrigin({ ...first, bindings: { ...first.bindings, api: "2".repeat(64) } }));
  assert.equal(candidateApiOrigin(first), candidateApiOrigin({ ...first, client: sdlSurface(schema) }), "unrelated client review cannot invalidate the API origin");
});

test("a shared installed implementation edit requires explicit renewal despite unchanged versions and outputs", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const before = f.record();
  f.dependency("2".repeat(64)); const changed = await f.reader.load();
  assert.deepEqual(changed.links.map(link => link.confidence.status), ["stale", "blocked", "blocked"]);
  assert.notEqual(changed.proof.stages[0]!.current!.id, before.proofs.database!.id);
  assert.deepEqual(changed.proof.stages[1]!.current!.toolchain.packages, before.proofs.api!.toolchain.packages);
  assert.deepEqual(changed.proof.stages[2]!.current!.outputs, before.proofs.codegen!.outputs);
  assert.equal(contractGateExitCode(changed), 1);
  await f.accept({ kind: "api" }); await f.accept({ kind: "client" });
  assert.equal(contractGateExitCode(await f.reader.load()), 0);
});

test("persisted passing flags never replace failed, skipped or unavailable independent outcomes", async t => {
  for (const status of ["failed", "blocked", "unavailable"] as const) await t.test(status, async child => {
    const f = fixture(child); await f.accept({ kind: "baseline" }); const accepted = recordContents(f.root);
    f.evaluation.verification = { ...f.evaluation.verification, client: { status, diagnostics: [{ code: "REQUIRED_SUITE_INCOMPLETE", message: "The current required suite did not establish evidence." }] } };
    const chain = await f.reader.load(); assert.notEqual(chain.links[2].confidence.status, "verified");
    assert.equal(contractGateExitCode(chain), status === "unavailable" ? 2 : 1);
    await assert.rejects(f.reviews.review({ expectedRevision: chain.revision, scope: { kind: "client" }, decisions: { client: fixtureReviewDecisions.client } }), /independent checks must pass/);
    assert.equal(recordContents(f.root), accepted);
  });
});

test("candidate receipts remain a separate namespace and cannot be accepted as saved-source lineage", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const observation = await f.reader.inspect();
  const candidate = buildContractProof({ ...observation.proofInput!, scope: "candidate", candidateDecisions: { api: proofDigest([{ kind: "exposure", value: "withheld" }]) } });
  assert.notEqual(candidate.receipts.api!.id, f.record().proofs.api!.id);
  assert.throws(() => readProofReceipt(candidate.receipts.api, "saved"), /scope/);
  assert.throws(() => serializeReviewRecord({ ...f.record(), proofs: candidate.receipts }), /scope/);
  assert.equal(contractGateExitCode(await f.reader.load()), 0);
});

test("an omitted required evidence set cannot synthesize a passing mechanical receipt", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const observation = await f.reader.inspect();
  const incomplete = buildContractProof({ ...observation.proofInput!, codegenChecks: [] });
  assert.equal(incomplete.receipts.codegen!.checks[0]!.outcome, "unavailable");
  assert.equal(incomplete.view.stages.find(stage => stage.stage === "codegen")!.status, "unavailable");
  assert.equal(incomplete.view.stages.find(stage => stage.stage === "client")!.status, "blocked");
});

test("legacy reviews remain readable and unchanged until explicit scoped receipt renewal", async t => {
  const f = fixture(t);
  const legacy = { version: 1 as const, prisma: { models: canonicalPrisma(prisma).models }, client: sdlSurface(schema) };
  f.put(REVIEW_FILE, serializeReviewRecord(legacy)); const before = recordContents(f.root);
  let chain = await f.reader.load(); assert.equal(recordContents(f.root), before); assert.equal(chain.links[0].state.status, "reviewed"); assert.equal(contractGateExitCode(chain), 1);
  await assert.rejects(f.reviews.review({ expectedRevision: chain.revision, scope: { kind: "api" } }), /explicit API/);
  await f.accept({ kind: "api" }); chain = await f.reader.load(); assert.equal(f.record().version, 3); assert.equal(chain.links[2].confidence.status, "blocked");
  await f.accept({ kind: "client" }); assert.equal(contractGateExitCode(await f.reader.load()), 0);
});

test("source changes during review acceptance reject proof publication with zero record writes", async t => {
  const f = fixture(t), chain = await f.reader.load();
  const plan = await f.reviews.review({ expectedRevision: chain.revision, scope: { kind: "baseline" }, decisions: fixtureReviewDecisions });
  f.put("client-app/src/api/projects/operations.ts", "export const key = ['concurrent'];\n");
  await assert.rejects(f.reviews.accept({ reviewId: plan.reviewId, expectedRevision: chain.revision }), /Source changed/);
  assert.equal(recordContents(f.root), null);
});

test("review evidence rejects tokens and receipt identity contains no timestamp or machine path", async t => {
  const f = fixture(t); await f.accept({ kind: "baseline" }); const body = JSON.stringify(f.record().proofs);
  assert.equal(body.includes(f.root), false); assert.equal(/timestamp|checkedAt|createdAt|mtime|ctime/.test(body), false);
  assert.throws(() => readReviewDecision({ statement: "Use this access token: eyJabcdef.abc123.def456", evidence: "Credentials must never be persisted." }), /credentials or tokens/);
  assert.deepEqual(readReviewDecision({ statement: " Preserve owner-scoped behavior.\r\n", evidence: "schema/project.ts" }), { statement: "Preserve owner-scoped behavior.", evidence: "schema/project.ts" });
});

test("a running inspector cannot label its loaded validator with newly edited policy source", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-proof-policy-seal-"));
  const put = (name: string, value: string) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  const policyRoot = path.join(root, "node_modules/aws-studio");
  for (const name of CONTRACT_PROOF_POLICY_FILES) put(path.join("node_modules/aws-studio", name), "// original checker policy\n");
  put(PRISMA_FILE, prisma); putRuntimeArtifacts(root);
  let executions = 0;
  const reader = new GraphQLChainService(root, { proofPolicyRoot: policyRoot, identity: async () => fingerprint(readSourceManifest(root)), evaluate: async () => { executions++; return verifiedEvaluation(schema); } });
  t.after(async () => { await reader.dispose(); rmSync(root, { recursive: true, force: true }); });
  await reader.load(true); assert.equal(executions, 1);
  put(path.join("node_modules/aws-studio", CONTRACT_PROOF_POLICY_FILES[0]), "// newly edited checker policy\n");
  const chain = await reader.load(true);
  assert.equal(executions, 1, "a checker restart is required before another validation can be attributed to the changed policy");
  assert.equal(chain.verification.api.status, "unavailable");
  assert.ok(chain.verification.api.diagnostics.some(item => item.code === "CHECKER_POLICY_RESTART_REQUIRED"));
  assert.equal(contractGateExitCode(chain), 2);
});

test("loaded checker dependencies cannot be relabelled after same-version installed source edits", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-proof-loaded-dependency-"));
  const put = (name: string, value: string) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  const policyRoot = path.join(root, "node_modules/aws-studio");
  for (const name of CONTRACT_PROOF_POLICY_FILES) put(path.join("node_modules/aws-studio", name), "// original checker policy\n");
  put(PRISMA_FILE, prisma); putRuntimeArtifacts(root); put("node_modules/control/index.js", "export const version = 1;\n");
  let executions = 0;
  const reader = new GraphQLChainService(root, { proofPolicyRoot: policyRoot, identity: async () => fingerprint([readSourceManifest(root), dependencyMetadata(root)]), evaluate: async () => { executions++; return verifiedEvaluation(schema); } });
  t.after(async () => { await reader.dispose(); rmSync(root, { recursive: true, force: true }); });
  await reader.load(true); assert.equal(executions, 1);
  put("node_modules/control/index.js", "export const version = 2;\n");
  const changed = await reader.load(true); assert.equal(executions, 1);
  assert.equal(changed.verification.api.status, "unavailable");
  assert.ok(changed.verification.api.diagnostics.some(item => item.code === "CHECKER_DEPENDENCIES_RESTART_REQUIRED"));
  assert.equal(contractGateExitCode(changed), 2); assert.equal(recordContents(root), null);
});

test("source changed and restored during proof publication cannot establish current evidence", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "studio-proof-publication-race-")), file = path.join(root, PRISMA_FILE);
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, prisma); putRuntimeArtifacts(root);
  const reader = new GraphQLChainService(root, { identity: async () => fingerprint(readSourceManifest(root)), evaluate: async () => verifiedEvaluation(schema), portableIdentity: async () => {
    const identity = await fixtureProofIdentity(root);
    writeFileSync(file, prisma + "// concurrent edit\n"); writeFileSync(file, prisma);
    return identity;
  } });
  t.after(async () => { await reader.dispose(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(reader.load(true), /Source changed while publishing/);
  assert.equal(recordContents(root), null);
});

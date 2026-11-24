import { fixtureProofIdentity, fixtureDecisionsFor, fixtureReviewDecisions } from "./support/chain-verification";
import assert from "./support/assert";
import { afterEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GraphQLChain, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import { readSourceManifest } from "aws-studio/source/workspace";
import { canonicalPrisma, fingerprint, parseReviewRecord, sdlSurface, serializeReviewRecord } from "aws-studio/contract-chain/core";
import { confidence } from "aws-studio/contract-chain/confidence";
import { GraphQLChainService, PRISMA_FILE, REVIEW_FILE } from "../server/graphql-chain/service";
import { GraphQLChainReviews } from "../server/graphql-chain/review";
import { runChainCli } from "../server/graphql-chain/cli";
import { putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import { runtimeContractHash } from "aws-studio/contract-chain/evaluation";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const prisma = "// use prisma-8\nmodel Project {\n id Uuid @id\n name String\n}\nmodel User {\n id Uuid @id\n}\n";
const sdl = "type Project { id: ID! name: String! } type Query { projects: [Project!]! }";

function fixture(options: { readonly legacy?: boolean; readonly empty?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-chain-confidence-")); roots.push(root);
  const put = (file: string, text: string) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  const source = options.empty ? "// use prisma-8\n" : prisma;
  put(PRISMA_FILE, source);
  putRuntimeArtifacts(root);
  put("compute/http/graphql-api/schema/implementation.ts", "export const ownerRule = true;\n");
  put("client-app/src/api/projects/operations.ts", "export const projectKeys = ['projects'];\n");
  put("client-app/src/components/Consumer.tsx", "export const Consumer = () => null;\n");
  if (options.legacy) put(REVIEW_FILE, serializeReviewRecord({ version: 1, prisma: { models: canonicalPrisma(source).models }, client: sdlSurface(sdl) }));
  const value = verifiedEvaluation(sdl);
  // The fixed loader supplies document identity independently of cache/consumer
  // source. Fixtures must model that evidence rather than invoke the fallback.
  value.authoredDocumentsDigest = fingerprint([]);
  const identity = async () => fingerprint([Object.fromEntries(Object.entries(readSourceManifest(root).files).filter(([file]) => file !== REVIEW_FILE)), runtimeContractHash(root), value]);
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, identity, evaluate: async () => value });
  const reviews = new GraphQLChainReviews(service);
  const stamp = async (scope: ReviewScope) => { const current = await service.load(); const plan = await reviews.review({ expectedRevision: current.revision, scope, decisions: fixtureDecisionsFor(scope) }); await reviews.accept({ reviewId: plan.reviewId, expectedRevision: current.revision }); return service.load(); };
  const approveCodegen = async () => {
    const current = await service.load();
    const plan = await reviews.reviewStages(current.revision, ["codegen"], {});
    assert.ok(plan, "Codegen needs an explicit new saved-source receipt");
    await reviews.accept({ reviewId: plan.reviewId, expectedRevision: current.revision });
    return service.load();
  };
  return { root, put, value, identity, service, reviews, stamp, approveCodegen };
}
const statuses = (chain: GraphQLChain) => chain.links.map(link => link.confidence.status);

test("private Prisma fields invalidate transitive proof and reconcile with identical public output", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.put(PRISMA_FILE, prisma.replace(" name String", " name String\n internal String?"));
  f.value.contract = { storageHash: "c".repeat(64), executionHash: "b".repeat(64) };
  let chain = await f.service.load();
  assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
  assert.equal(chain.links[1].state.status, "current");
  assert.equal(chain.links[2].state.status, "reviewed");
  const before = readFileSync(path.join(f.root, REVIEW_FILE), "utf8");
  await assert.rejects(f.stamp({ kind: "client" }), /predecessors/);
  await assert.rejects(f.stamp({ kind: "api" }), /every changed database model/);
  assert.equal(readFileSync(path.join(f.root, REVIEW_FILE), "utf8"), before);
  chain = await f.stamp({ kind: "model", model: "Project" });
  assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
  chain = await f.stamp({ kind: "api" });
  assert.deepEqual(statuses(chain), ["verified", "stale", "blocked"]);
  chain = await f.approveCodegen();
  assert.deepEqual(statuses(chain), ["verified", "verified", "stale"]);
  assert.ok(chain.links[2].confidence.diagnostics.some(item => item.code === "CLIENT_UPSTREAM_CHANGED"));
  assert.deepEqual(statuses(await f.stamp({ kind: "client" })), ["verified", "verified", "verified"]);
  assert.equal(f.value.sdl, sdl); assert.equal(f.value.generatedSdl, sdl);
});

test("compiled storage and execution changes invalidate API even without model-shape changes", async () => {
  for (const property of ["storageHash", "executionHash"] as const) {
    const f = fixture(); await f.stamp({ kind: "baseline" });
    f.value.contract = { ...f.value.contract!, [property]: "d".repeat(64) };
    const chain = await f.service.load();
    assert.equal(chain.links[0].state.status, "reviewed");
    assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
    assert.deepEqual(statuses(await f.stamp({ kind: "api" })), ["verified", "stale", "blocked"]);
    assert.deepEqual(statuses(await f.approveCodegen()), ["verified", "verified", "stale"]);
    assert.deepEqual(statuses(await f.stamp({ kind: "client" })), ["verified", "verified", "verified"]);
  }
});

test("edits to emitted database or policy artifacts invalidate their reviewed API predecessor", async () => {
  for (const [file, source] of [
    ["packages/database/src/generated/contract.d.ts", "export interface Contract { changed: true }\n"],
    ["packages/database/src/generated/contract.json", '{"fixture":"changed"}\n'],
    ["packages/database/src/generated/client-access.ts", "export const clientAccess = {};\n"],
    ["packages/database/src/generated/access-graph.json", '{"fingerprint":"changed"}\n'],
  ]) {
    const f = fixture(); await f.stamp({ kind: "baseline" });
    f.put(file, source);
    const chain = await f.service.load();
    assert.equal(chain.links[0].state.status, "reviewed");
    assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
    assert.equal(f.value.sdl, sdl);
    assert.deepEqual(statuses(await f.stamp({ kind: "api" })), ["verified", "stale", "blocked"]);
    assert.deepEqual(statuses(await f.approveCodegen()), ["verified", "verified", "stale"]);
    assert.deepEqual(statuses(await f.stamp({ kind: "client" })), ["verified", "verified", "verified"]);
  }
});

test("resolver-only and application data-file edits require implementation review and independent checks", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.put("compute/http/graphql-api/schema/implementation.ts", "export const ownerRule = false;\n");
  f.value.verification = { ...f.value.verification, api: { status: "failed", diagnostics: [] } };
  assert.deepEqual(statuses(await f.service.load()), ["failed", "blocked", "blocked"]);
  await assert.rejects(f.stamp({ kind: "api" }), /independent checks must pass/);
  f.value.verification = { ...f.value.verification, api: { status: "passed" } };
  let chain = await f.service.load();
  assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
  assert.ok(chain.links[0].confidence.diagnostics.some(item => item.file?.endsWith("implementation.ts")));
  assert.deepEqual(statuses(await f.stamp({ kind: "api" })), ["verified", "stale", "blocked"]);
  assert.deepEqual(statuses(await f.approveCodegen()), ["verified", "verified", "stale"]);
  await f.stamp({ kind: "client" });
  f.put("compute/http/graphql-api/policy.yaml", "ownersOnly: false\n");
  chain = await f.service.load();
  assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
  assert.equal(f.value.sdl, sdl);
});

test("client input diagnostics exclude changed compute implementation", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  const implementation = "compute/http/graphql-api/schema/implementation.ts", operation = "client-app/src/api/projects/operations.ts";
  f.put(implementation, "export const ownerRule = false;\n");
  f.put(operation, "export const projectKeys = ['projects', 'detail'];\n");
  const chain = await f.service.load();
  assert.ok(chain.links[0].confidence.diagnostics.some(item => item.code === "IMPLEMENTATION_INPUT_CHANGED" && item.file === implementation));
  const diagnostics = chain.links[2].confidence.diagnostics;
  assert.ok(diagnostics.some(item => item.code === "IMPLEMENTATION_INPUT_CHANGED" && item.file === operation));
  assert.equal(diagnostics.some(item => item.code === "IMPLEMENTATION_INPUT_CHANGED" && item.file === implementation), false);
  assert.ok(diagnostics.some(item => item.code === "CLIENT_UPSTREAM_CHANGED"));
});

test("React Query keys, mutation invalidation and valid document edits stale client review", async () => {
  for (const [file, source, documentsChanged] of [
    ["client-app/src/api/projects/operations.ts", "export const projectKeys = ['different'];", false],
    ["client-app/src/api/projects/operations.ts", "export const onSuccess = () => undefined;", false],
    ["client-app/src/api/projects/operations.ts", "export const document = graphql(`query Changed { projects { id } }`);", true],
  ] as const) {
    const f = fixture(), approved = await f.stamp({ kind: "baseline" }); f.put(file, source);
    if (documentsChanged) f.value.authoredDocumentsDigest = fingerprint(["query Changed { projects { id } }"]);
    let chain = await f.service.load();
    assert.equal(chain.proof.stages.find(stage => stage.stage === "api")!.current!.id, approved.proof.stages.find(stage => stage.stage === "api")!.current!.id);
    if (documentsChanged) {
      assert.deepEqual(statuses(chain), ["verified", "stale", "blocked"]);
      assert.notEqual(chain.proof.stages.find(stage => stage.stage === "codegen")!.current!.id, approved.proof.stages.find(stage => stage.stage === "codegen")!.current!.id);
      chain = await f.approveCodegen();
    } else assert.equal(chain.proof.stages.find(stage => stage.stage === "codegen")!.current!.id, approved.proof.stages.find(stage => stage.stage === "codegen")!.current!.id);
    assert.deepEqual(statuses(chain), ["verified", "verified", "stale"]);
    assert.equal(chain.links[2].state.status, "reviewed");
    assert.notEqual(chain.nodes[3].fingerprint.status === "available" && chain.nodes[3].fingerprint.value, chain.nodes[3].reviewedAgainst);
    assert.deepEqual(statuses(await f.stamp({ kind: "client" })), ["verified", "verified", "verified"]);
  }
});

test("screen consumers retain approvals when their independent type checks still pass", async () => {
  const f = fixture(), before = await f.stamp({ kind: "baseline" });
  f.put("client-app/src/components/Consumer.tsx", "export const Consumer = () => 'changed';\n");
  const after = await f.service.load();
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(after.proof.stages.map(stage => stage.current?.id), before.proof.stages.map(stage => stage.current?.id));
  assert.deepEqual(statuses(after), ["verified", "verified", "verified"]);
  f.value.verification = { ...f.value.verification, consumers: { status: "failed", diagnostics: [] } };
  assert.deepEqual(statuses(await f.service.load()), ["verified", "verified", "failed"]);
});

test("document or generated-file drift blocks client acceptance even with passing behavior tests", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.value.documentSet = "differs"; f.value.codegen.status = "out-of-date";
  const chain = await f.service.load();
  assert.notEqual(chain.links[1].confidence.status, "verified");
  assert.equal(chain.links[2].confidence.status, "blocked");
  await assert.rejects(f.stamp({ kind: "client" }), /Codegen/);
});

test("legacy records retain semantic reviews but cannot establish full verification", async () => {
  const f = fixture({ legacy: true });
  const before = readFileSync(path.join(f.root, REVIEW_FILE), "utf8");
  const chain = await f.service.load();
  assert.deepEqual(statuses(chain), ["stale", "blocked", "blocked"]);
  assert.equal(chain.links[0].state.status, "reviewed");
  assert.equal(readFileSync(path.join(f.root, REVIEW_FILE), "utf8"), before);
  await assert.rejects(f.stamp({ kind: "baseline" }), /only available/);
  assert.deepEqual(statuses(await f.stamp({ kind: "api" })), ["verified", "stale", "blocked"]);
  assert.deepEqual(statuses(await f.approveCodegen()), ["verified", "verified", "stale"]);
  assert.equal(parseReviewRecord(readFileSync(path.join(f.root, REVIEW_FILE), "utf8")).version, 3);
  assert.deepEqual(statuses(await f.stamp({ kind: "client" })), ["verified", "verified", "verified"]);
});

test("missing or failed checks never pass even with empty diagnostics and current hashes", async () => {
  assert.equal(confidence({ checks: [{ status: "failed", diagnostics: [] }] }).status, "failed");
  assert.equal(confidence({ checks: [{ status: "unavailable", diagnostics: [] }] }).status, "unavailable");
  assert.equal(confidence({ checks: [{ status: "blocked", diagnostics: [] }] }).status, "blocked");
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.value.verification = { ...f.value.verification, api: { status: "unavailable", diagnostics: [] } };
  assert.deepEqual(statuses(await f.service.load()), ["unavailable", "blocked", "blocked"]);
  assert.equal(await runChainCli(["--check"], f.root, () => {}, f.service), 2);
});

test("CLI distinguishes known predecessor blockers from unavailable validation hidden downstream", async () => {
  const scenarios = [
    { kind: "codegen", expected: 1 },
    { kind: "database", expected: 1 },
    { kind: "unavailable", expected: 2 },
  ] as const;
  for (const scenario of scenarios) {
    const f = fixture(); await f.stamp({ kind: "baseline" });
    if (scenario.kind === "database") f.value.verification = { ...f.value.verification, database: { status: "failed", diagnostics: [] }, api: { status: "blocked", diagnostics: [] } };
    else {
      f.value.codegen.status = "out-of-date";
      f.value.verification = { ...f.value.verification, integration: { status: "blocked", diagnostics: [] }, ...(scenario.kind === "unavailable" ? { consumers: { status: "unavailable" as const, diagnostics: [] } } : {}) };
    }
    const chain = await f.service.load();
    assert.notEqual(chain.links[2].confidence.status, "verified");
    assert.equal(chain.links[2].confidence.status, scenario.kind === "unavailable" ? "unavailable" : "blocked");
    assert.equal(await runChainCli(["--check"], f.root, () => {}, f.service), scenario.expected);
  }
});

test("a blocked independent check cannot renew review even without a displayed upstream blocker", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.value.verification = { ...f.value.verification, api: { status: "blocked", diagnostics: [] } };
  assert.equal((await f.service.load()).links[0].confidence.status, "blocked");
  await assert.rejects(f.stamp({ kind: "api" }), /independent checks must pass/);
});

test("known invalid documents block Codegen proof without masquerading as an unavailable checker", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.value.documents = [{ document: "Projects", file: "client-app/src/api/projects/operations.ts", line: 1, message: "Cannot query field missing on type Project." }];
  f.value.codegen = { status: "unknown", files: [], diagnostics: [{ code: "CODEGEN_CHECK", message: "GraphQL document validation failed." }] };
  f.value.verification = { ...f.value.verification, integration: { status: "blocked", diagnostics: [] } };
  const chain = await f.service.load();
  assert.equal(chain.links[1].state.status, "out-of-date");
  assert.deepEqual(statuses(chain), ["verified", "failed", "failed"]);
  await assert.rejects(f.stamp({ kind: "client" }), /documents must validate/);
  assert.equal(await runChainCli(["--check"], f.root, () => {}, f.service), 1);
  const unavailable = fixture(); await unavailable.stamp({ kind: "baseline" });
  unavailable.value.codegen = { status: "unknown", files: [], diagnostics: [] };
  assert.equal(await runChainCli(["--check"], unavailable.root, () => {}, unavailable.service), 2);
});

test("missing validator fields and compiled semantics cannot establish proof or renew acceptance", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  const before = readFileSync(path.join(f.root, REVIEW_FILE), "utf8");
  const { verification: _verification, ...legacyValue } = f.value;
  const reader = new GraphQLChainService(f.root, { portableIdentity: fixtureProofIdentity, identity: f.identity, evaluate: async () => legacyValue as ChainEvaluation });
  const chain = await reader.load();
  assert.equal(chain.links[0].confidence.status, "unavailable");
  await assert.rejects(new GraphQLChainReviews(reader).review({ expectedRevision: chain.revision, scope: { kind: "api" }, decisions: fixtureDecisionsFor({ kind: "api" }) }), /independent checks must pass/);
  f.value.contract = null;
  assert.equal((await f.service.load()).links[0].confidence.status, "unavailable");
  assert.equal(readFileSync(path.join(f.root, REVIEW_FILE), "utf8"), before);
});

test("partial multi-model reconciliation and removed-model review never silently acknowledge neighbors", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.put(PRISMA_FILE, prisma.replace(" name String", " name String?\n internal String?").replace("model User {\n id Uuid", "model User {\n note String?\n id Uuid"));
  f.value.contract = { storageHash: "e".repeat(64), executionHash: null };
  await f.stamp({ kind: "model", model: "Project" });
  await assert.rejects(f.stamp({ kind: "api" }), /every changed database model/);
  await f.stamp({ kind: "model", model: "User" }); await f.stamp({ kind: "api" });
  f.put(PRISMA_FILE, "// use prisma-8\nmodel Project {\n id Uuid @id\n name String?\n internal String?\n}\n");
  await f.stamp({ kind: "model", model: "User" });
  const record = parseReviewRecord(readFileSync(path.join(f.root, REVIEW_FILE), "utf8"));
  assert.equal(Object.hasOwn(record.prisma!.models, "User"), false);
});

test("source changes during inspection or between review and acceptance discard evidence without writes", async () => {
  const f = fixture(); await f.stamp({ kind: "baseline" });
  f.put("client-app/src/api/projects/operations.ts", "export const changed = true;");
  const current = await f.service.load();
  const plan = await f.reviews.review({ expectedRevision: current.revision, scope: { kind: "client" }, decisions: fixtureDecisionsFor({ kind: "client" }) });
  const record = readFileSync(path.join(f.root, REVIEW_FILE), "utf8");
  f.put("client-app/src/components/Consumer.tsx", "export const Consumer = () => 'raced';");
  await assert.rejects(f.reviews.accept({ reviewId: plan.reviewId, expectedRevision: current.revision }), /Source changed/);
  assert.equal(readFileSync(path.join(f.root, REVIEW_FILE), "utf8"), record);
  let edited = false;
  const racing = new GraphQLChainService(f.root, { portableIdentity: fixtureProofIdentity, identity: f.identity, evaluate: async () => { if (!edited) { edited = true; f.put("source-race.yaml", "changed: true"); } return f.value; } });
  await assert.rejects(racing.load(), /Source changed during inspection/);
  assert.equal(readFileSync(path.join(f.root, REVIEW_FILE), "utf8"), record);
});

test("an API with no database models still needs API and client verification", async () => {
  const f = fixture({ empty: true });
  assert.equal((await f.service.load()).links[0].state.status, "reviewed");
  assert.deepEqual(statuses(await f.stamp({ kind: "api" })), ["verified", "stale", "blocked"]);
  assert.deepEqual(statuses(await f.approveCodegen()), ["verified", "verified", "stale"]);
  assert.deepEqual(statuses(await f.stamp({ kind: "client" })), ["verified", "verified", "verified"]);
});

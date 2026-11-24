import { fixtureProofIdentity, fixtureDecisionsFor, fixtureReviewDecisions } from "./support/chain-verification";
import assert from "./support/assert";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphQLChainService, PRISMA_FILE, REVIEW_FILE } from "../server/graphql-chain/service";
import { canonicalPrisma, fingerprint, serializeReviewRecord, sdlSurface } from "aws-studio/contract-chain/core";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import type { GraphQLChain } from "aws-studio/contract-chain/graphql-chain";
import { putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const prisma = `// use prisma-8\nmodel User {\n id Uuid @id\n}\nmodel Project {\n id Uuid @id\n name String\n}\n`;
const sdl = "type Project { id: ID! name: String! } type Query { projects: [Project!]! }";
function evidence(): ChainEvaluation { return verifiedEvaluation(sdl); }
function fixture(baseline = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-chain-service-")); roots.push(root);
  mkdirSync(path.join(root, path.dirname(PRISMA_FILE)), { recursive: true });
  writeFileSync(path.join(root, PRISMA_FILE), prisma);
  putRuntimeArtifacts(root);
  if (baseline) writeFileSync(path.join(root, REVIEW_FILE), serializeReviewRecord({ version: 1, prisma: { models: canonicalPrisma(prisma).models }, client: sdlSurface(sdl) }));
  let value = evidence(), calls = 0, input = "initial";
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, identity: async () => fingerprint([input, readFileSync(path.join(root, PRISMA_FILE), "utf8"), (() => { try { return readFileSync(path.join(root, REVIEW_FILE), "utf8"); } catch { return null; } })()]), evaluate: async () => { calls++; return value; } });
  return { root, service, update: (next: ChainEvaluation) => { value = next; input += "changed"; }, calls: () => calls };
}
const state = (chain: GraphQLChain, id: string) => chain.links.find(link => link.id === id)!.state;

test("legacy local evidence remains readable while unbound proof stays stale; reads never initialize a record", async () => {
  const fixtureA = fixture();
  const legacy = await fixtureA.service.load();
  assert.deepEqual(legacy.links.map(link => link.state.status), ["reviewed", "current", "reviewed"]);
  assert.deepEqual(legacy.links.map(link => link.confidence.status), ["stale", "blocked", "blocked"]);
  const fixtureB = fixture(false);
  assert.deepEqual((await fixtureB.service.load()).links.map(link => link.state.status), ["no-review", "current", "no-review"]);
  assert.throws(() => readFileSync(path.join(fixtureB.root, REVIEW_FILE)), /ENOENT/);
});

test("local model shapes ignore comments/layout/index; dueDate flags only Project", async () => {
  const { root, service } = fixture();
  writeFileSync(path.join(root, PRISMA_FILE), prisma.replace(" name String", " // comment\n name   String\n @@index([name])"));
  assert.equal(state(await service.load(), "prisma-pothos").status, "reviewed");
  writeFileSync(path.join(root, PRISMA_FILE), prisma.replace(" name String", " name String\n dueDate temporal.timestamptzString(6)?"));
  const link = (await service.load()).links[0];
  assert.equal(link.id, "prisma-pothos");
  if (link.id !== "prisma-pothos") return;
  assert.equal(link.models.User.status, "reviewed");
  assert.equal(link.models.Project.status, "changed");
  assert.equal(link.state.status, "changed");
  if (link.state.status === "changed") assert.deepEqual(link.state.diffs.map(diff => [diff.path, diff.change]), [["Project.dueDate", "added"]]);
});

test("schema generation and client review report their independent evidence", async () => {
  const { service, update } = fixture();
  const value = evidence(); value.sdl = sdl.replace("name: String!", "name: String! dueDate: String"); value.codegen.status = "out-of-date";
  update(value);
  let chain = await service.load();
  const stale = state(chain, "pothos-generated");
  assert.equal(stale.status, "out-of-date");
  if (stale.status === "out-of-date") assert.deepEqual(stale.reasons, ["schema-changed"]);
  value.generatedSdl = value.sdl; value.codegen.status = "current"; update(value);
  chain = await service.load();
  assert.equal(state(chain, "pothos-generated").status, "current");
  const client = state(chain, "generated-client");
  assert.equal(client.status, "changed");
  if (client.status === "changed") assert.equal(client.diffs[0].path, "Project.dueDate");
});

test("document drift, generated-file edits and invalid selections cannot silently turn green", async () => {
  const { service, update } = fixture();
  let value = evidence(); value.documentSet = "differs"; value.codegen.status = "out-of-date"; update(value);
  let generated = state(await service.load(), "pothos-generated");
  assert.equal(generated.status, "out-of-date");
  if (generated.status === "out-of-date") assert.deepEqual(generated.reasons, ["documents-changed"]);
  value = evidence(); value.codegen = { status: "out-of-date", files: ["client-app/src/api/generated/graphql.ts"], diagnostics: [] }; update(value);
  generated = state(await service.load(), "pothos-generated");
  if (generated.status === "out-of-date") assert.deepEqual(generated.reasons, ["generated-files-changed"]); else assert.fail("Expected generated-file drift");
  value.documents = [{ document: "ProjectSummary", file: "client-app/src/api/projects/operations.ts", line: 2, message: "Cannot query field name on Project." }]; update(value);
  assert.equal(state(await service.load(), "generated-client").status, "invalid");
});

test("a failed restricted schema evaluation leaves Prisma review intact", async () => {
  const { service, update } = fixture();
  const value = evidence(); value.sdl = null; value.schemaDiagnostics = [{ code: "SYNTAX", file: "schema/project.ts", line: 3, message: "Unexpected token" }]; value.codegen.status = "unknown"; update(value);
  const chain = await service.load();
  assert.deepEqual(chain.links.map(link => link.state.status), ["reviewed", "unknown", "unknown"]);
  assert.equal(chain.nodes[1].fingerprint.status, "unavailable");
});

test("invalid record does not hide independently current generated evidence", async () => {
  const { root, service } = fixture(); writeFileSync(path.join(root, REVIEW_FILE), "{");
  const chain = await service.load();
  assert.deepEqual(chain.links.map(link => link.state.status), ["unknown", "current", "unknown"]);
});

test("content cache deduplicates reads; explicit fresh checks reevaluate", async () => {
  const { service, calls } = fixture();
  await Promise.all([service.load(), service.load()]); assert.equal(calls(), 1);
  await service.load(); assert.equal(calls(), 1);
  await service.load(true); assert.equal(calls(), 2);
  await service.dispose(); await assert.rejects(service.load(), /closed/);
});

test("record-only updates change the response revision without reevaluating application source", async () => {
  const { root } = fixture(false); let calls = 0;
  const reader = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, evaluate: async () => { calls++; return evidence(); } });
  const before = await reader.load();
  writeFileSync(path.join(root, REVIEW_FILE), serializeReviewRecord({ version: 1, prisma: { models: canonicalPrisma(prisma).models }, client: sdlSurface(sdl) }));
  const after = await reader.load();
  assert.notEqual(before.revision, after.revision);
  assert.equal(calls, 1);
  assert.deepEqual(after.links.map(link => link.state.status), ["reviewed", "current", "reviewed"]);
  await reader.dispose();
});

import { fixtureProofIdentity, fixtureDecisionsFor, fixtureReviewDecisions } from "./support/chain-verification";
import assert from "./support/assert";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphQLChainService, PRISMA_FILE, REVIEW_FILE, recordContents, reviewRecordPath } from "../server/graphql-chain/service";
import { GraphQLChainReviews, readChainAcceptRequest, readChainReviewRequest } from "../server/graphql-chain/review";
import { runChainCli } from "../server/graphql-chain/cli";
import { canonicalPrisma, fingerprint, parseReviewRecord, serializeReviewRecord, sdlSurface } from "aws-studio/contract-chain/core";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import { putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";
import { readSourceManifest } from "aws-studio/source/workspace";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const prisma = `// use prisma-8\nmodel User {\n id Uuid @id\n}\nmodel Project {\n id Uuid @id\n name String\n}\n`;
const sdl = "type Project { id: ID! name: String! } type Query { projects: [Project!]! }";
function fixture(baseline = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-chain-review-")); roots.push(root);
  mkdirSync(path.join(root, path.dirname(PRISMA_FILE)), { recursive: true }); writeFileSync(path.join(root, PRISMA_FILE), prisma);
  putRuntimeArtifacts(root);
  if (baseline) writeFileSync(path.join(root, REVIEW_FILE), serializeReviewRecord({ version: 1, prisma: { models: canonicalPrisma(prisma).models }, client: sdlSurface(sdl) }));
  const value: ChainEvaluation = verifiedEvaluation(sdl);
  const service = () => new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, identity: async () => fingerprint([Object.fromEntries(Object.entries(readSourceManifest(root).files).filter(([file]) => file !== REVIEW_FILE)), value]), evaluate: async () => value });
  return { root, service, value };
}

test("baseline review is read-only, exact apply creates the record once, and reads never acknowledge", async () => {
  const { root, service } = fixture(false), reader = service(), reviews = new GraphQLChainReviews(reader);
  const chain = await reader.load(), plan = await reviews.review({ expectedRevision: chain.revision, scope: { kind: "baseline" }, decisions: fixtureDecisionsFor({ kind: "baseline" }) });
  assert.equal(recordContents(root), null); assert.equal(plan.before, null);
  assert.equal(parseReviewRecord(plan.after).prisma?.models.Project.fields.name.type, "String");
  const result = await reviews.accept({ reviewId: plan.reviewId, expectedRevision: chain.revision });
  assert.equal(result.status, "recorded"); assert.equal(recordContents(root), plan.after);
  assert.equal(result.revision, (await reader.load()).revision);
  assert.deepEqual((await reader.load()).links.map(link => link.state.status), ["reviewed", "current", "reviewed"]);
  await assert.rejects(reviews.accept({ reviewId: plan.reviewId, expectedRevision: chain.revision }), /expired|unavailable/);
  await assert.rejects(reviews.review({ expectedRevision: (await reader.load()).revision, scope: { kind: "baseline" }, decisions: fixtureDecisionsFor({ kind: "baseline" }) }), /only available/);
});

test("Project acknowledgement is deterministic and preserves User/client entries", async () => {
  const { root, service } = fixture(), reader = service(), reviews = new GraphQLChainReviews(reader);
  const before = parseReviewRecord(recordContents(root)!);
  writeFileSync(path.join(root, PRISMA_FILE), prisma.replace(" name String", " name String\n dueDate temporal.timestamptzString(6)?"));
  const chain = await reader.load();
  const plan = await reviews.review({ expectedRevision: chain.revision, scope: { kind: "model", model: "Project" } });
  const next = parseReviewRecord(plan.after);
  assert.deepEqual(next.prisma?.models.User, before.prisma?.models.User); assert.deepEqual(next.client, before.client);
  assert.equal(next.prisma?.models.Project.fields.dueDate.nullability, "optional");
  assert.equal(plan.after, serializeReviewRecord(next));
  await reviews.accept({ reviewId: plan.reviewId, expectedRevision: chain.revision });
  assert.equal((await reader.load()).links[0].state.status, "reviewed");
});

test("stale source or a concurrently edited record refuses apply without overwriting it", async () => {
  const { root, service } = fixture(false), reader = service(), reviews = new GraphQLChainReviews(reader);
  const chain = await reader.load(), plan = await reviews.review({ expectedRevision: chain.revision, scope: { kind: "baseline" }, decisions: fixtureDecisionsFor({ kind: "baseline" }) });
  writeFileSync(path.join(root, PRISMA_FILE), prisma + "\n// outside edit");
  await assert.rejects(reviews.accept({ reviewId: plan.reviewId, expectedRevision: chain.revision }), /Source changed/);
  assert.equal(recordContents(root), null);
  const latest = await reader.load(), next = await reviews.review({ expectedRevision: latest.revision, scope: { kind: "baseline" }, decisions: fixtureDecisionsFor({ kind: "baseline" }) });
  writeFileSync(path.join(root, REVIEW_FILE), "outside record");
  await assert.rejects(reviews.accept({ reviewId: next.reviewId, expectedRevision: latest.revision }), /record changed/);
  assert.equal(readFileSync(path.join(root, REVIEW_FILE), "utf8"), "outside record");
});

test("fixed target refuses linked files and request-supplied paths", async () => {
  const { root } = fixture(false), outside = path.join(root, "other.json"); writeFileSync(outside, "unchanged");
  symlinkSync(outside, path.join(root, REVIEW_FILE));
  assert.throws(() => reviewRecordPath(root), /regular file without links/);
  assert.equal(readFileSync(outside, "utf8"), "unchanged");
  assert.throws(() => readChainReviewRequest({ expectedRevision: "a".repeat(64), scope: { kind: "client" }, path: outside }), /supported/);
  assert.throws(() => readChainReviewRequest({ expectedRevision: "a".repeat(64), scope: { kind: "model", model: "../other" } }), /baseline, one model/);
  assert.throws(() => readChainAcceptRequest({ expectedRevision: "a".repeat(64), reviewId: "unknown" }), /reviewed/);
});

test("invalid documents cannot be acknowledged; a whole-client review preserves model entries", async () => {
  const { service, value } = fixture(), reader = service(), reviews = new GraphQLChainReviews(reader);
  value.sdl = sdl.replace("name: String!", "name: String! dueDate: String");
  value.documents = [{ document: "ProjectSummary", file: "operations.ts", line: 1, message: "Invalid selection" }];
  await assert.rejects(reviews.review({ expectedRevision: (await reader.load()).revision, scope: { kind: "client" }, decisions: fixtureDecisionsFor({ kind: "client" }) }), /must validate/);
  value.documents = [];
  value.generatedSdl = value.sdl;
  const apiSource = await reader.load();
  const apiPlan = await reviews.review({ expectedRevision: apiSource.revision, scope: { kind: "api" }, decisions: fixtureDecisionsFor({ kind: "api" }) });
  await reviews.accept({ reviewId: apiPlan.reviewId, expectedRevision: apiSource.revision });
  const current = await reader.inspect();
  const plan = await reviews.review({ expectedRevision: current.chain.revision, scope: { kind: "client" }, decisions: fixtureDecisionsFor({ kind: "client" }) });
  const parsed = parseReviewRecord(plan.after);
  assert.deepEqual(parsed.prisma, current.record?.prisma); assert.ok(parsed.client?.types.Project.definition.includes("dueDate"));
});

test("CLI status/check and accept use the same writer; init records no reviewed baseline", async () => {
  const { root, service } = fixture(false), output: unknown[] = [];
  assert.equal(await runChainCli(["status", "--json"], root, value => output.push(value), service()), 0);
  assert.equal(recordContents(root), null);
  assert.equal(await runChainCli(["--check"], root, () => {}, service()), 1);
  assert.equal(await runChainCli(["init"], root, () => {}, service()), 0);
  assert.deepEqual(parseReviewRecord(recordContents(root)!), { version: 3, prisma: null, client: null, bindings: { api: null, client: null }, proofs: {} });
  const decisionsFile = path.join(root, ".cache/decisions.json"); mkdirSync(path.dirname(decisionsFile), { recursive: true }); writeFileSync(decisionsFile, JSON.stringify(fixtureReviewDecisions));
  const revision = (await service().load()).revision;
  assert.equal(await runChainCli(["accept", "--baseline", "--expected", revision, "--decisions-file", decisionsFile], root, () => {}, service()), 0);
  assert.equal(await runChainCli(["--check"], root, () => {}, service()), 0);
  assert.equal(await runChainCli(["accept", "--baseline", "--expected", revision, "--path", "other"], root, () => {}, service()), 2);
});

test("CLI API acceptance upgrades legacy evidence and enforces the same predecessor rules", async () => {
  const { root, service } = fixture();
  const before = recordContents(root);
  let revision = (await service().load()).revision;
  assert.equal(await runChainCli(["accept", "--client", "--expected", revision], root, () => {}, service()), 2);
  assert.equal(recordContents(root), before);
  assert.equal(await runChainCli(["accept", "--api", "--expected", revision, "--decision", fixtureReviewDecisions.api.statement, "--evidence", fixtureReviewDecisions.api.evidence], root, () => {}, service()), 0);
  revision = (await service().load()).revision;
  assert.equal(await runChainCli(["accept", "--client", "--expected", revision, "--decision", fixtureReviewDecisions.client.statement, "--evidence", fixtureReviewDecisions.client.evidence], root, () => {}, service()), 0);
  assert.equal(await runChainCli(["--check"], root, () => {}, service()), 0);
});

import assert from "./support/assert";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { contractSourceFileDigest, portableProofPolicy, type PortableProofIdentity } from "aws-studio/contract-chain/portable-identity";
import { sourceFingerprints, sourceFingerprintsFromFiles } from "aws-studio/contract-chain/source-fingerprints";
import { buildContractProof, unavailableProofView } from "aws-studio/contract-chain/proof";
import { proofDigest, createProofReceipt } from "aws-studio/contract-chain/proof-core";
import { canonicalPrisma, parseReviewRecord, sdlFingerprint, sdlSurface, serializeReviewRecord } from "aws-studio/contract-chain/core";
import { captureContractSourceProjection, recordedContractStages, type ContractSourceProjection } from "aws-studio/contract-chain/source-lease";
import { fixtureReviewDecisions, verifiedEvaluation } from "./support/chain-verification";
import type { ChainNode, GraphQLChainReviewRecordV3 } from "aws-studio/contract-chain/graphql-chain";

const prisma = "packages/database/prisma/contract.prisma";
const api = "compute/http/graphql-api/schema/project.ts";
const generated = "client-app/src/api/generated/schema.graphql";
const client = "client-app/src/api/projects/operations.ts";
const schema = "type Project { id: ID! } type Query { projects: [Project!]! }\n";
const sources = {
  [prisma]: "// use prisma-8\nmodel Project {\n id Uuid @id\n}\n",
  [api]: "export const project = true;\n",
  [generated]: schema,
  [client]: "export const key = ['projects'];\n",
};
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "studio-chain-fingerprints-"));
  const put = (name: string, value: string) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  for (const [name, value] of Object.entries(sources)) put(name, value);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, put };
}
const available = (nodes: readonly ChainNode[], id: ChainNode["id"]) => {
  const value = nodes.find(node => node.id === id)!.fingerprint;
  assert.equal(value.status, "available");
  if (value.status !== "available") throw new Error("Missing fixture fingerprint.");
  return value.value;
};
function identity(input: Record<string, string>): PortableProofIdentity {
  const source = Object.fromEntries(Object.entries(input).map(([name, value]) => [name, contractSourceFileDigest(name, Buffer.from(value))]));
  const files = { database: { [prisma]: source[prisma]! }, api: { [api]: source[api]! }, codegen: {}, client: { [client]: source[client]! }, generated: { [generated]: source[generated]! } };
  return { version: 1, sourceRevision: proofDigest(source), policy: { id: "fixture/offline-v1", digest: "f".repeat(64) },
    toolchain: { node: process.versions.node, packages: {}, lockfileDigest: proofDigest(null), dependencyDigest: proofDigest(null) },
    inputs: { database: proofDigest(files.database), api: proofDigest(files.api), codegen: proofDigest(files.codegen), client: proofDigest(files.client) },
    outputs: { database: proofDigest(null), generated: proofDigest(files.generated) }, files };
}
function proof(current = identity(sources)) {
  return buildContractProof({ identity: current, evaluation: verifiedEvaluation(schema), record: null,
    models: canonicalPrisma(sources[prisma]).models, sdlDigest: sdlFingerprint(sdlSurface(schema)), codegenChecks: [{ status: "passed" }], decisions: fixtureReviewDecisions });
}
function record(current = proof()): GraphQLChainReviewRecordV3 {
  return { version: 3, prisma: { models: canonicalPrisma(sources[prisma]).models }, client: sdlSurface(schema),
    bindings: { api: current.bindings.api, client: { inputs: current.bindings.client, upstream: current.bindings.upstream } }, proofs: current.receipts };
}

test("visible hashes and saved approvals survive new Lambda, parameter, repository, and screen files", t => {
  const f = fixture(t);
  f.put("codegen.ts", "export default {};\n");
  f.put("package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  const source = captureContractSourceProjection(f.root);
  assert.ok(source.lockfile);
  const fixtureIdentity = identity(sources);
  const current = proof({
    ...fixtureIdentity, ...source.normalized, policy: portableProofPolicy(),
    toolchain: { ...fixtureIdentity.toolchain, lockfileDigest: source.lockfile },
  });
  f.put("graphql-chain.review.json", serializeReviewRecord(record(current)));
  const accepted = sourceFingerprints(f.root);
  assert.deepEqual(accepted.slice(1).map(node => node.approvalRecorded), [true, true, true]);

  f.put("compute/http/graphql-api-v2/index.ts", "export const handler = () => 'hello';\n");
  f.put("framework-config/inputs/index.ts", "export const timeout = 30;\n");
  f.put("packages/database/src/projects.ts", "export const query = () => [];\n");
  f.put("client-app/src/routes/projects.tsx", "export const list = 'project list';\n");
  assert.deepEqual(sourceFingerprints(f.root), accepted);

  for (const [index, file] of ([prisma, api, generated, client] as const).entries()) {
    f.put(file, file === prisma ? sources[prisma].replace(" id Uuid @id", " id Uuid @id\n title String") : sources[file] + (file === generated ? "# changed output\n" : "// changed source\n"));
    const changed = sourceFingerprints(f.root);
    assert.deepEqual(changed.flatMap((node, position) => node.fingerprint.status === "available"
      && node.fingerprint.value !== available(accepted, node.id) ? [position] : []), [index], file);
    f.put(file, sources[file]);
  }

  f.put(generated, schema + "# changed output\n");
  assert.deepEqual(sourceFingerprints(f.root).slice(1).map(node => Boolean(node.approvalRecorded)), [true, false, false]);
});

test("source hashes require recorded receipts and retain the actual approved input after an upstream field edit", t => {
  const f = fixture(t);
  assert.deepEqual(sourceFingerprints(f.root).map(node => node.reviewedAgainst), [null, null, null, null]);
  const current = proof();
  assert.ok(current.view.stages.every(stage => stage.recorded === null));
  assert.ok(unavailableProofView("Checking", current.view).stages.every(stage => stage.recorded === null), "an unaccepted current receipt is never relabeled as recorded");
  const saved = record(); f.put("graphql-chain.review.json", serializeReviewRecord(saved));
  const accepted = sourceFingerprints(f.root);
  for (const [index, stage] of (["database", "api", "codegen", "client"] as const).entries()) {
    assert.equal(saved.proofs[stage]!.outputs.content, available(accepted, accepted[index]!.id));
    if (index) assert.equal(accepted[index]!.reviewedAgainst, available(accepted, accepted[index - 1]!.id));
  }
  f.put(prisma, sources[prisma].replace(" id Uuid @id", " id Uuid @id\n title String"));
  const changed = sourceFingerprints(f.root);
  assert.notEqual(available(changed, "prisma"), available(accepted, "prisma"));
  assert.equal(changed[1]!.reviewedAgainst, available(accepted, "prisma"));
  assert.notEqual(changed[1]!.reviewedAgainst, available(changed, "prisma"));
  f.put("graphql-chain.review.json", "{invalid");
  assert.ok(sourceFingerprints(f.root).every(node => node.reviewedAgainst === null), "invalid persisted evidence cannot supply consumed hashes");
});

test("Prisma documentation and checkout line endings preserve displayed hashes and receipt identities", t => {
  const f = fixture(t), lf = sourceFingerprints(f.root), lfProof = proof();
  const crlf = Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, value.replaceAll("\n", "\r\n")])) as typeof sources;
  for (const [name, value] of Object.entries(crlf)) f.put(name, value);
  assert.deepEqual(sourceFingerprints(f.root), lf);
  assert.deepEqual(proof(identity(crlf)).receipts, lfProof.receipts);
  const commented = sources[prisma].replace("model Project", "/// Project details\nmodel Project").replace(" id Uuid @id", " id Uuid @id // An identifier");
  f.put(prisma, commented);
  assert.deepEqual(sourceFingerprints(f.root), lf);
  assert.deepEqual(proof(identity({ ...sources, [prisma]: commented })).receipts, lfProof.receipts);
  const changed = proof(identity({ ...sources, [prisma]: sources[prisma].replace("model Project", "/// @access(read)\nmodel Project") }));
  assert.notEqual(changed.receipts.database!.outputs.content, lfProof.receipts.database!.outputs.content);
  assert.notEqual(changed.receipts.api!.inputs.upstreamContent, lfProof.receipts.api!.inputs.upstreamContent);
  assert.notEqual(changed.receipts.client!.id, lfProof.receipts.client!.id);
});

test("Prisma source identity preserves literals, version selection, and Access Graph directive placement", () => {
  const source = ["// use prisma-8", "/// @access(read,", "///   update)", "model Project {", " id Uuid @id", ' name String @default("https://example.test")', "}", ""].join("\n");
  const digest = (text: string) => contractSourceFileDigest(prisma, Buffer.from(text));
  const unchanged = digest(source);
  assert.equal(digest(source.replace("model Project", "/// Notes about `@access(read)`.\nmodel Project")), unchanged);
  assert.equal(digest(source.replace("/// @access(read,", "/// @todo Revisit the docs\n/// @access(read,").replace("model Project", "/// More notes\nmodel Project")), unchanged);
  for (const changed of [
    source.replace("example.test", "other.test"),
    "// breaks the required pragma position\n" + source,
    source.replace("///   update)", "///   delete)"),
    source.replace("///   update)", "/// prose inside the open directive\n///   update)"),
    source.replace("model Project", "// breaks rule attachment\nmodel Project"),
    source.replace("/// @access(read,", "// @access owner\n/// @access(read,"),
    source.replace("}", ' @@check(expression: "id IS NOT NULL", name: "valid_id")\n}'),
  ]) assert.notEqual(digest(changed), unchanged);
});

test("legacy receipt maps and missing source groups stay readable without inventing consumed hashes", t => {
  const f = fixture(t), saved = record();
  const apiReceipt = saved.proofs.api!, { upstreamContent: _upstream, ...inputs } = apiReceipt.inputs;
  const { id: _id, ...receipt } = apiReceipt;
  const legacy = { ...saved, proofs: { ...saved.proofs, api: createProofReceipt({ ...receipt, inputs }) } };
  f.put("graphql-chain.review.json", serializeReviewRecord(legacy));
  assert.equal(sourceFingerprints(f.root)[1]!.reviewedAgainst, null);
  const missing = sourceFingerprintsFromFiles({});
  assert.ok(missing.every(node => node.fingerprint.status === "unavailable" && node.reviewedAgainst === null));
});

test("serialized approvals restore from matching portable source and stop at the first changed predecessor", () => {
  const saved = parseReviewRecord(serializeReviewRecord(record()));
  if (saved.version !== 3) assert.fail("Expected versioned receipts");
  const current = identity(sources);
  const projection = { normalized: current, raw: current, policy: current.policy.digest, rawPolicy: current.policy.digest, record: null, lockfile: current.toolchain.lockfileDigest, documents: {} } satisfies ContractSourceProjection;
  assert.deepEqual(recordedContractStages(saved.proofs, projection), ["database", "api", "codegen", "client"]);
  const edited = identity({ ...sources, [api]: "export const project = false;\n" });
  assert.deepEqual(recordedContractStages(saved.proofs, { ...projection, normalized: edited }), ["database"]);
  assert.deepEqual(recordedContractStages(saved.proofs, { ...projection, policy: "changed" }), []);
  assert.deepEqual(recordedContractStages(saved.proofs, { ...projection, lockfile: null }), []);
});

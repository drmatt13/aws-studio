import assert from "./support/assert";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { recordChainLedger } from "aws-studio/contract-chain/ledger";
import { sourceFingerprints } from "aws-studio/contract-chain/source-fingerprints";
import { portableFileDigest } from "aws-studio/contract-chain/portable-dependencies";
import { parseReviewRecord, serializeReviewRecord } from "aws-studio/contract-chain/core";
import { ledgerStatus } from "../src/graphql-chain";
import type { LinkId } from "aws-studio/contract-chain/graphql-chain";
import { isGraphQLChainResponse } from "aws-studio/contract-chain/graphql-chain-response";
import { graphqlChainFixture } from "./support/graphql-chain";

const prisma = "packages/database/prisma/contract.prisma";
const api = "compute/http/graphql-api/schema/project.ts";
const generated = "client-app/src/api/generated/schema.graphql";
const client = "client-app/src/api/projects/operations.ts";
const sources = {
  [prisma]: "// use prisma-8\nmodel Project {\n id Uuid @id\n}\n",
  [api]: "export const project = true;\n",
  [generated]: "type Project { id: ID! } type Query { projects: [Project!]! }\n",
  [client]: "export const key = ['projects'];\n",
};
const links: readonly LinkId[] = ["prisma-pothos", "pothos-generated", "generated-client"];
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-chain-ledger-"));
  const put = (name: string, value: string) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  for (const [name, value] of Object.entries(sources)) put(name, value);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rail = () => { const nodes = sourceFingerprints(root); return links.map(link => ledgerStatus(link, nodes)?.label); };
  return { root, put, rail };
}

test("a recorded ledger keeps the chain in sync across reads, flags downstream drift, and re-records", async t => {
  const f = fixture(t);
  assert.deepEqual(f.rail(), ["Not recorded", "Not recorded", "Not recorded"]);

  assert.equal((await recordChainLedger(f.root, ["api", "codegen", "client"])).changed, true);
  assert.deepEqual(f.rail(), ["In sync", "In sync", "In sync"]);
  const nodes = sourceFingerprints(f.root);
  for (let index = 1; index < nodes.length; index++) {
    const upstream = nodes[index - 1]!.fingerprint;
    assert.equal(upstream.status, "available");
    if (upstream.status === "available") assert.equal(nodes[index]!.reviewedAgainst, upstream.value, "each source hash is the previous stage's generated hash");
  }
  assert.equal((await recordChainLedger(f.root, ["api", "codegen", "client"])).changed, false, "an unchanged chain is not rewritten");

  // Prisma prose leaves the saved content aligned. A field edit reaches Pothos.
  f.put(prisma, sources[prisma] + "// comment\n");
  assert.deepEqual(f.rail(), ["In sync", "In sync", "In sync"]);
  assert.equal((await recordChainLedger(f.root, ["api"])).changed, false);
  f.put(prisma, sources[prisma].replace(" id Uuid @id", " id Uuid @id\n title String"));
  assert.deepEqual(f.rail(), ["Upstream changed", "In sync", "In sync"]);
  await recordChainLedger(f.root, ["api"]);
  assert.deepEqual(f.rail(), ["In sync", "In sync", "In sync"]);

  // A client-only edit flags only the client link.
  f.put(client, sources[client] + "// edited\n");
  assert.deepEqual(f.rail(), ["In sync", "In sync", "Output changed"]);
  await recordChainLedger(f.root, ["client"]);
  assert.deepEqual(f.rail(), ["In sync", "In sync", "In sync"]);

  // A Pothos change flags its own output and Codegen's input.
  f.put(api, sources[api] + "export const added = 1;\n");
  assert.deepEqual(f.rail(), ["Output changed", "Upstream changed", "In sync"]);
});

test("observed legacy Prisma source SHA alignment survives prose but not changed fields", async t => {
  const f = fixture(t);
  await recordChainLedger(f.root, ["api"]);
  const file = path.join(f.root, "graphql-chain.review.json"), record = parseReviewRecord(readFileSync(file, "utf8"));
  if (record.version !== 3 || !record.ledger?.api) assert.fail("Expected a versioned API ledger entry");
  const oldSource = portableFileDigest(prisma, Buffer.from(sources[prisma]));
  const oldRecord = serializeReviewRecord({ ...record, ledger: { api: { ...record.ledger.api, source: oldSource } } });
  f.put("graphql-chain.review.json", oldRecord);
  const nodes = sourceFingerprints(f.root);
  assert.equal(nodes[1]!.reviewedAgainst, oldSource);
  assert.equal(nodes[0]!.fingerprint.status, "available");
  if (nodes[0]!.fingerprint.status === "available") assert.equal(nodes[1]!.normalizedReviewedAgainst, nodes[0]!.fingerprint.value);
  const response = { ...graphqlChainFixture(), nodes };
  assert.equal(isGraphQLChainResponse(response), true);
  assert.equal(isGraphQLChainResponse({ ...response, nodes: nodes.map(node => node.id === "pothos" ? { ...node, normalizedReviewedAgainst: oldSource } : node) }), false);
  assert.deepEqual(f.rail(), ["In sync", "Not recorded", "Not recorded"]);
  assert.equal(readFileSync(file, "utf8"), oldRecord);

  f.put(prisma, sources[prisma] + "// old raw hash no longer matches\n");
  assert.equal(sourceFingerprints(f.root)[1]!.normalizedReviewedAgainst, nodes[1]!.normalizedReviewedAgainst);
  assert.deepEqual(f.rail(), ["In sync", "Not recorded", "Not recorded"]);
  f.put(prisma, sources[prisma].replace(" id Uuid @id", " id Uuid @id\n title String"));
  assert.equal(sourceFingerprints(f.root)[1]!.normalizedReviewedAgainst, undefined);
  assert.deepEqual(f.rail(), ["Upstream changed", "Not recorded", "Not recorded"]);

  const unobserved = portableFileDigest(prisma, Buffer.from(sources[prisma] + "// Never observed legacy bytes\n"));
  f.put(prisma, sources[prisma]);
  f.put("graphql-chain.review.json", serializeReviewRecord({ ...record, ledger: { api: { ...record.ledger.api, source: unobserved } } }));
  assert.equal(sourceFingerprints(f.root)[1]!.normalizedReviewedAgainst, undefined);
  assert.deepEqual(f.rail(), ["Upstream changed", "Not recorded", "Not recorded"]);
});

test("the ledger round-trips through the strict record parser and preserves other review evidence", async t => {
  const f = fixture(t);
  f.put("graphql-chain.review.json", serializeReviewRecord({ version: 3, prisma: null, client: null, bindings: { api: null, client: null }, proofs: {} }));
  await recordChainLedger(f.root, ["codegen"]);
  const record = parseReviewRecord(readFileSync(path.join(f.root, "graphql-chain.review.json"), "utf8"));
  assert.equal(record.version, 3);
  if (record.version !== 3) return;
  assert.deepEqual(Object.keys(record.ledger ?? {}), ["codegen"]);
  assert.deepEqual(record.proofs, {});
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, ledger: { codegen: { source: "x", output: "y", recordedAt: "now" } } })), /ledger/);
  assert.throws(() => parseReviewRecord(JSON.stringify({ ...record, ledger: { other: record.ledger!.codegen } })), /ledger/);
});

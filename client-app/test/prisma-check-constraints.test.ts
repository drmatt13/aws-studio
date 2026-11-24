import assert from "./support/assert";
import test from "node:test";
import { canonicalPrisma, diffPrisma, parseReviewRecord, serializeReviewRecord } from "aws-studio/contract-chain/core";

const source = (condition: string) => `// use prisma-8
model Message {
  id Uuid @id
  seq Int
  @@check(expression: "${condition}", name: "message_positive_seq")
}`;

test("CHECK constraints remain reviewable and changing or removing one produces a model diff", () => {
  const before = canonicalPrisma(source("seq > 0"));
  const after = canonicalPrisma(source("seq >= 0"));
  assert.deepEqual(before.diagnostics, []);
  assert.deepEqual(before.models.Message.checks, { message_positive_seq: "seq > 0" });
  assert.ok(diffPrisma(before.models, after.models).some(diff => diff.path.includes("check message_positive_seq") && diff.change === "changed"));
  const removed = canonicalPrisma(source("seq > 0").replace(/\s*@@check[^\n]+/, ""));
  assert.ok(diffPrisma(before.models, removed.models).some(diff => diff.change === "removed"));
  const record = { version: 3 as const, prisma: { models: before.models }, client: null, bindings: { api: null, client: null }, proofs: {} };
  assert.deepEqual(parseReviewRecord(serializeReviewRecord(record)), record);
});

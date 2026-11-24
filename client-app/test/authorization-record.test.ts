import assert from "./support/assert";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTHORIZATION_RECORD, authorizationRecord } from "../server/database-workbench";

test("the workbench serves the API's authorization record as evidence, and nothing when it is absent or malformed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "authorization-record-"));
  try {
    assert.deepEqual(authorizationRecord(root), {}, "absent");
    mkdirSync(path.dirname(path.join(root, AUTHORIZATION_RECORD)), { recursive: true });
    writeFileSync(path.join(root, AUTHORIZATION_RECORD), JSON.stringify({ operations: { "Mutation.x": ["rows Case", "Case update(member)"], "Query.bad": [1] } }));
    assert.deepEqual(authorizationRecord(root), { authorization: { operations: { "Mutation.x": ["rows Case", "Case update(member)"] } } }, "entries that are not lists of rules are dropped");
    writeFileSync(path.join(root, AUTHORIZATION_RECORD), "{ not json");
    assert.deepEqual(authorizationRecord(root), {}, "malformed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

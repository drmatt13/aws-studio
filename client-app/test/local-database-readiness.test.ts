import assert from "./support/assert";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { databaseInputsDigest, localDatabaseInputs } from "aws-studio/database/studio-migrations";
import { LocalDatabaseReadiness } from "../server/deploy/database-readiness";
import { Tools } from "../server/deploy/process";

/** `aggregate` models an image built before per-file identities were recorded. */
function fixture(options: { readonly aggregate?: boolean } = {}) {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-db-readiness-"));
  mkdirSync(path.join(root, "packages/database/prisma/migrations"), { recursive: true });
  writeFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "// original contract\n");
  let databaseStarted = "2026-11-01T00:00:00Z";
  let verifiedStarted = "2026-11-01T00:00:01Z";
  let finished = "2026-11-01T00:00:02Z";
  let inputs = databaseInputsDigest(root);
  let perFile = localDatabaseInputs(root);
  let failure = false;
  let legacy = false;
  let logReads = 0;
  const env = { ...process.env };
  const observer = new LocalDatabaseReadiness(root, new Tools(path.resolve(__dirname, "../.."), env), async spec => {
    if (failure) return { code: 1, stdout: "", stderr: "private-driver-value" };
    if (spec.args[0] === "inspect") return { code: 0, stdout: [
      { id: "a".repeat(64), startedAt: databaseStarted, finishedAt: "0001-01-01T00:00:00Z" },
      { id: "b".repeat(64), startedAt: verifiedStarted, finishedAt: finished },
    ].map(value => JSON.stringify(value)).join("\n"), stderr: "" };
    assert.deepEqual(spec.args, ["logs", "--since", verifiedStarted, "--tail", "40", "verification"]);
    logReads++;
    return { code: 0, stdout: JSON.stringify({ kind: "result", commandId: "db.prepare-local", envelope: { ok: true, result: { ok: true, status: "verified", ...(!legacy ? { inputsDigest: inputs } : {}), ...(!legacy && !options.aggregate ? { inputs: perFile } : {}) } } }), stderr: "" };
  }, env);
  return { root, observer, logs: () => logReads, close: () => rmSync(root, { recursive: true, force: true }),
    restartDatabase: () => { databaseStarted = "2026-11-01T00:00:03Z"; },
    verify: () => { verifiedStarted = "2026-11-01T00:00:04Z"; finished = "2026-11-01T00:00:05Z"; inputs = databaseInputsDigest(root); perFile = localDatabaseInputs(root); },
    legacy: () => { legacy = true; }, fail: () => { failure = true; },
  };
}

test("database verification follows the current PostgreSQL start and reuses only that completed verifier's source proof", async () => {
  const f = fixture();
  try {
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
    assert.equal(f.logs(), 1);
    f.restartDatabase();
    assert.match((await f.observer.problem("postgres", "verification"))!, /restarted or was recreated/);
    f.verify();
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
    assert.equal(f.logs(), 2);
  } finally { f.close(); }
});

for (const file of ["packages/database/prisma/contract.prisma", "packages/database/prisma/migrations/team-change.json", "package-lock.json"]) test(`a team change to ${file} invalidates runtime readiness, naming it, until a new image verifies it`, async () => {
  const f = fixture();
  try {
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
    writeFileSync(path.join(f.root, file), "changed source\n");
    assert.equal(await f.observer.problem("postgres", "verification"), `${file} changed after local storage was verified. Restart local runtime to rebuild its images, then review any pending local migration in Database.`);
    f.verify();
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
  } finally { f.close(); }
});

test("root npm scripts are host tooling, but the rest of the root manifest remains a database input", async () => {
  const f = fixture();
  const manifest = (scripts: Record<string, string>, dependencies: Record<string, string> = {}) =>
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts, dependencies }, null, 2));
  try {
    manifest({ verify: "npm test" });
    f.verify();
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
    manifest({ verify: "npm test && npm run contract:check", "contract:check": "node check.ts" });
    assert.equal(await f.observer.problem("postgres", "verification"), undefined);
    manifest({ verify: "npm test" }, { pg: "8.13.0" });
    assert.match((await f.observer.problem("postgres", "verification"))!, /^package\.json changed after local storage was verified\. Restart/);
  } finally { f.close(); }
});

test("many changed inputs are summarized, and an aggregate-only image keeps the strict generic check", async () => {
  const f = fixture();
  try {
    for (const name of ["a", "b", "c", "d", "e"]) writeFileSync(path.join(f.root, `packages/database/prisma/migrations/${name}.json`), "{}\n");
    assert.match((await f.observer.problem("postgres", "verification"))!, /^packages\/database\/prisma\/migrations\/a\.json, packages\/database\/prisma\/migrations\/b\.json, packages\/database\/prisma\/migrations\/c\.json and 2 more changed after/);
  } finally { f.close(); }
  const older = fixture({ aggregate: true });
  try {
    writeFileSync(path.join(older.root, "package.json"), JSON.stringify({ scripts: { verify: "npm test" } }));
    assert.match((await older.observer.problem("postgres", "verification"))!, /^Database source, migration history or dependencies changed after local storage was verified\. Restart/);
  } finally { older.close(); }
});

test("legacy images and failed observations cannot establish fresh database readiness or reveal provider values", async () => {
  const f = fixture();
  try {
    f.legacy();
    assert.match((await f.observer.problem("postgres", "verification"))!, /no current database source verification/);
    f.fail();
    const problem = await f.observer.problem("postgres", "verification");
    assert.match(problem!, /Could not confirm/);
    assert.doesNotMatch(problem!, /private-driver-value/);
  } finally { f.close(); }
});

import { testProjectRoot } from "../../../../scripts/test-project";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { frameworkRepositoryRoot } from "aws-studio/config/source";
import type { Contract } from "@prisma/orm-framework/contract/types";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import type { ControlClient } from "@prisma/orm-toolchain/cli/control-api";
import { localPreparationConnection, localPreparationEnvelope, prepareLocalDatabase } from "../../cli/database/prepare-local-database.js";

const root = testProjectRoot;
const connection = "postgresql://admin:private-test-value@postgres:5432/app_db";
const contract = { storage: { storageHash: "saved-contract" } } as unknown as Contract;
const config = {} as PrismaNextConfig;
const verified = () => ({ ok: true as const, value: { markerDrift: null, unclaimed: [], schemaResults: new Map([["app", { ok: true }]]) } });

function fixture(options: { marker?: boolean; empty?: boolean; check?: unknown; failure?: Error; changeInputs?: boolean } = {}) {
  const calls: string[] = [], connections: string[] = [];
  let inputs = "saved-inputs";
  const fake = {
    async connect() { calls.push("connect"); if (options.failure) throw options.failure; },
    async close() { calls.push("close"); },
    async readMarker() { calls.push("marker"); return options.marker ? { storageHash: "saved-contract" } : null; },
    async readAllMarkers() { return new Map(); },
    async readLedger() { return []; },
    async dbVerify(arguments_: { strict: boolean; skipMarker: boolean; skipSchema: boolean }) {
      calls.push("verify");
      assert.equal(arguments_.strict, true);
      assert.equal(arguments_.skipMarker, false);
      assert.equal(arguments_.skipSchema, false);
      return options.check ?? verified();
    },
    async dbInit() { calls.push("initialize"); return { ok: true }; },
    async sign() { assert.fail("startup must never sign an existing database"); },
    async migrate() { assert.fail("startup must never apply migration packages"); },
    async dbUpdate() { assert.fail("startup must never synchronize existing storage"); },
  } as unknown as ControlClient;
  const dependencies = {
    async load() { calls.push("load"); return { config, contract }; },
    client(_settings: PrismaNextConfig, selected: string) { connections.push(selected); return fake; },
    async empty() { calls.push("empty"); return options.empty ?? true; },
    inputsDigest() { return inputs; },
    localInputs() { return { "package-lock.json": "a".repeat(64), "packages/database/prisma/contract.prisma": "b".repeat(64) }; },
    plan: async () => { calls.push("plan"); return { operations: [], operationsDigest: "operations", statements: [], sql: [], controlSql: [] }; },
    guard(settings: PrismaNextConfig, review: unknown, assertCurrent: () => void) {
      calls.push("guard");
      assert.deepEqual((review as { migrations: unknown }).migrations, []);
      if (options.changeInputs) inputs = "changed-inputs";
      assertCurrent();
      return settings;
    },
  };
  return { calls, connections, dependencies };
}

test("preparation refuses remote, overridden, wrong database and arbitrary loopback targets before loading or connecting", async () => {
  for (const target of [undefined, "invalid", "postgresql://admin:secret@production.example/app_db", "postgresql://other:secret@postgres/app_db", "postgresql://admin:secret@postgres/another_db", "postgresql://admin:secret@postgres:5433/app_db", "postgresql://admin:secret@localhost/app_db", `${connection}?host=production.example`, `${connection}?options=-c%20search_path=other`]) {
    const f = fixture();
    const outcome = await prepareLocalDatabase({ root, connection: target }, f.dependencies);
    assert.equal(outcome.code, "LOCAL_DATABASE_TARGET_REFUSED");
    assert.deepEqual(f.calls, []); assert.deepEqual(f.connections, []);
    assert.ok(!JSON.stringify(outcome).includes("secret"));
  }
  assert.equal(localPreparationConnection("postgresql://admin:secret@127.0.0.1:55432/app_db", true), "postgresql://admin:secret@127.0.0.1:55432/app_db");
});

test("a current database is verified strictly over a read-only connection and never enters the write path", async () => {
  const f = fixture({ marker: true });
  const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
  assert.equal(outcome.status, "verified"); assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.inputsDigest, "saved-inputs");
  assert.deepEqual(outcome.inputs, { "package-lock.json": "a".repeat(64), "packages/database/prisma/contract.prisma": "b".repeat(64) });
  assert.deepEqual(f.calls, ["load", "connect", "marker", "verify", "close"]);
  assert.match(new URL(f.connections[0]!).searchParams.get("options")!, /default_transaction_read_only=on/);
});

test("unsigned populated storage is blocked before planning or creating a writable client", async () => {
  const f = fixture({ empty: false });
  const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
  assert.equal(outcome.code, "LOCAL_DATABASE_NOT_EMPTY"); assert.equal(outcome.exitCode, 4);
  assert.equal(f.connections.length, 1);
  assert.ok(!f.calls.includes("plan")); assert.ok(!f.calls.includes("initialize"));
});

test("empty storage uses the guarded additive initialization path and verifies afterward without a CLI ref write", async () => {
  const f = fixture();
  const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
  assert.equal(outcome.status, "initialized");
  assert.equal(outcome.code, "LOCAL_DATABASE_INITIALIZED");
  assert.equal(outcome.inputsDigest, "saved-inputs");
  assert.ok(f.calls.indexOf("plan") < f.calls.indexOf("guard"));
  assert.ok(f.calls.indexOf("guard") < f.calls.indexOf("initialize"));
  assert.ok(f.calls.indexOf("initialize") < f.calls.indexOf("verify"));
  assert.equal(f.connections.length, 2);
  assert.match(new URL(f.connections[0]!).searchParams.get("options")!, /default_transaction_read_only=on/);
  assert.ok(!new URL(f.connections[1]!).searchParams.get("options")!.includes("default_transaction_read_only=on"));
});

test("successful Prisma verification transport still blocks marker drift, schema differences and unclaimed objects", async () => {
  for (const [change, code] of [
    [{ markerDrift: { code: "CONTRACT.MARKER_MISMATCH" } }, "CONTRACT.MARKER_MISMATCH"],
    [{ schemaResults: new Map([["app", { ok: false }]]) }, "CONTRACT.SCHEMA_VERIFICATION_FAILED"],
    [{ unclaimed: ["unexpected_table"] }, "CONTRACT.SCHEMA_VERIFICATION_FAILED"],
  ] as const) {
    const f = fixture({ marker: true, check: { ok: true, value: { ...verified().value, ...change } } });
    const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
    assert.equal(outcome.code, code); assert.equal(outcome.status, "blocked");
    assert.equal(f.connections.length, 1); assert.ok(!f.calls.includes("initialize"));
  }
});

test("source changes after preparation cannot reach initialization", async () => {
  const f = fixture({ changeInputs: true });
  const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
  assert.equal(outcome.code, "LOCAL_DATABASE_SOURCE_CHANGED");
  assert.ok(!f.calls.includes("initialize"));
});

test("driver errors and result envelopes never expose private connection values or raw diagnostics", async () => {
  const f = fixture({ failure: new Error(`Cannot connect to ${connection}: SQL private-row-value`) });
  const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
  assert.equal(outcome.status, "failed");
  const output = JSON.stringify(localPreparationEnvelope(outcome));
  assert.ok(!output.includes("private-test-value")); assert.ok(!output.includes("private-row-value"));
  assert.equal(JSON.parse(output).commandId, "db.prepare-local");
  assert.ok(f.calls.includes("close"));
});

test("the Compose CLI rejects all URL overrides without echoing their values", () => {
  let output = "";
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("aws-studio/cli")), "db:prepare-local", "--db", "postgresql://private-secret@production.example/app_db"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.fail("CLI override must fail");
  } catch (error) {
    output = String((error as { stdout?: unknown }).stdout ?? "");
  }
  const envelope = JSON.parse(output.trim());
  assert.equal(envelope.envelope.result.code, "LOCAL_DATABASE_OPTIONS_REFUSED");
  assert.ok(!output.includes("private-secret")); assert.ok(!output.includes("production.example"));
});

test("missing database and retained login failures have fixed development remedies without driver values", async () => {
  for (const [error, code] of [
    [Object.assign(new Error("private-database-value"), { code: "3D000" }), "LOCAL_DATABASE_MISSING"],
    [Object.assign(new Error("private-password-value"), { code: "28P01" }), "LOCAL_DATABASE_LOGIN_FAILED"],
    [new Error("private-role-value", { cause: { code: "28000" } }), "LOCAL_DATABASE_LOGIN_FAILED"],
  ] as const) {
    const f = fixture({ failure: error });
    const outcome = await prepareLocalDatabase({ root, connection }, f.dependencies);
    assert.equal(outcome.code, code);
    assert.equal(outcome.inputsDigest, undefined);
    assert.equal(outcome.inputs, undefined);
    assert.ok(!JSON.stringify(outcome).includes("private-"));
    assert.ok(!f.calls.includes("initialize"));
  }
});

import { testProjectRoot } from "../../../../scripts/test-project";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { frameworkRepositoryRoot } from "aws-studio/config/source";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { createControlClient } from "@prisma/orm-toolchain/cli/control-api";
import { hasMigrations } from "@prisma/orm-framework/components/control";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { loadLocalDatabaseContract, prepareLocalDatabase } from "../../cli/database/prepare-local-database.js";
import { guardCloudDatabasePath } from "aws-studio/database/studio-migrations";

const root = testProjectRoot;

/** Opt-in real PostgreSQL. Every write is confined to this run's labelled fixture. */
test("fresh local storage boots once and retained or incompatible storage stays protected", {
  skip: process.env.FRAMEWORK_LOCAL_DATABASE_TEST !== "1", timeout: 180_000,
}, async t => {
  const name = `aws-studio-db-startup-${randomUUID().slice(0, 12)}`;
  const volume = `${name}-data`;
  const ownership = "com.matts-aws-framework.database-startup-test";
  const label = `${ownership}=${name}`;
  let connection = "";
  const evidence: Record<string, unknown>[] = [];
  const migrationDirectory = path.join(root, "packages/database/prisma/migrations");
  const migrationBytes = (directory = migrationDirectory): unknown[] => readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      const file = path.join(directory, entry.name);
      return [entry.name, entry.isDirectory() ? migrationBytes(file) : createHash("sha256").update(readFileSync(file)).digest("hex")];
    });
  const originalMigrationBytes = migrationBytes();
  function docker(args: string[], allowFailure = false) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 45_000 });
    if (!allowFailure) assert.equal(result.status, 0, result.stderr);
    return { ...result, stdout: result.stdout.trim() };
  }
  function startContainer() {
    docker(["run", "--detach", "--name", name, "--label", label,
      "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=admin",
      "--env", "POSTGRES_PASSWORD=startup-fixture", "--env", "POSTGRES_DB=app_db", "postgres:16"]);
    updateConnection();
  }
  function updateConnection() {
    const binding = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]).stdout)["5432/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    connection = `postgresql://admin:startup-fixture@127.0.0.1:${binding.HostPort}/app_db`;
  }
  async function query(sql: string, values?: unknown[], selected = connection) {
    const client = new pg.Client({ connectionString: selected, connectionTimeoutMillis: 1000 });
    try { await client.connect(); return await client.query(sql, values); }
    finally { await client.end(); }
  }
  async function ready() {
    // Docker may allocate a different ephemeral host port on container restart.
    updateConnection();
    for (let attempt = 0; attempt < 80; attempt++) {
      try { await query("SELECT 1"); return; }
      catch { await setTimeout(250); }
    }
    throw new Error("Disposable PostgreSQL did not become ready.");
  }
  const prepare = (selected = connection) => prepareLocalDatabase({ root, connection: selected, allowLoopback: true });
  const compiled = await loadLocalDatabaseContract(root);
  const historical = compiled.config.target.contractSerializer.deserializeContract(JSON.parse(readFileSync(path.join(migrationDirectory, "snapshots/8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47/contract.json"), "utf8")));
  async function initializeHistorical() {
    const client = createControlClient({ ...compiled.config, connection });
    try {
      await client.connect();
      const initialized = await client.dbInit({ contract: historical, mode: "apply", migrationsDir: migrationDirectory });
      assert.equal(initialized.ok, true, "the real historical contract must initialize through the native runner");
    } finally { await client.close(); }
    await query("INSERT INTO users(id,cognito_sub,email,first_name,last_name,updated_at) VALUES ($1,$2,$3,$4,$5,now())", [randomUUID(), "team-retained-sub", "team-retained@example.invalid", "Team", "Fixture"]);
  }
  function failAfterFirstDdl(config: PrismaNextConfig, reachedDdl: () => void): PrismaNextConfig {
    const target = config.target;
    if (!hasMigrations(target)) throw new Error("The fixture requires native PostgreSQL migrations.");
    const wrapped: typeof target = { ...target, migrations: { ...target.migrations, createRunner(family) {
      const runner = target.migrations.createRunner(family);
      return { async execute(options) {
        const driver = options.driver;
        assert.ok("query" in driver && typeof driver.query === "function");
        const query = driver.query.bind(driver) as (sql: string, parameters?: readonly unknown[]) => Promise<unknown>;
        let failed = false;
        const proxy = new Proxy(driver, { get(value, key) {
          if (key !== "query") { const member = Reflect.get(value, key); return typeof member === "function" ? member.bind(value) : member; }
          return async (sql: string, parameters?: readonly unknown[]) => {
            const result = await query(sql, parameters);
            if (!failed && /^\s*create\s+(schema|table)\b/i.test(sql)) { failed = true; reachedDdl(); throw new Error("fixture-private-initialization-failure"); }
            return result;
          };
        } });
        return runner.execute({ ...options, driver: proxy });
      } };
    } } };
    return { ...config, target: wrapped };
  }
  async function assertOwnedCluster(selected: string) {
    const inspected = JSON.parse(docker(["inspect", "--format", "{{json .}}", name]).stdout);
    assert.equal(inspected.Config.Labels[ownership], name);
    assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume]).stdout, name);
    const binding = inspected.NetworkSettings.Ports["5432/tcp"][0];
    const target = new URL(selected);
    assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, binding.HostPort);
    assert.ok(["/app_db", "/postgres"].includes(target.pathname));
    const expected = docker(["exec", name, "psql", "--username=admin", "--dbname=postgres", "--tuples-only", "--no-align", "--command=SELECT system_identifier::text FROM pg_control_system()"]);
    const observed = await query("SELECT system_identifier::text AS identifier FROM pg_control_system()", undefined, selected);
    assert.equal(observed.rows[0]?.identifier, expected.stdout, "destructive fixture setup must address the exact owned PostgreSQL cluster");
  }
  async function reset() {
    const maintenance = new URL(connection); maintenance.pathname = "/postgres";
    await assertOwnedCluster(maintenance.toString());
    await query("DROP DATABASE app_db WITH (FORCE)", undefined, maintenance.toString());
    await query("CREATE DATABASE app_db OWNER admin", undefined, maintenance.toString());
  }
  const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
  async function dataSnapshot() {
    const tables = await query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name");
    const values = [];
    for (const table of tables.rows) {
      const qualified = `${quoted(table.table_schema)}.${quoted(table.table_name)}`;
      const rows = await query(`SELECT row_to_json(record) AS value FROM ${qualified} AS record ORDER BY row_to_json(record)::text`);
      values.push([qualified, rows.rows]);
    }
    // pg_dump includes every schema object, including shell types and
    // collations that table/row snapshots alone cannot observe. New PostgreSQL
    // releases add random psql restriction tokens; those are not database state.
    const schema = docker(["exec", name, "pg_dump", "--username=admin", "--dbname=app_db", "--schema-only"]).stdout
      .split(/\r?\n/).filter(line => !/^\\(?:un)?restrict\b/.test(line)).join("\n");
    return JSON.stringify({ schema, rows: values });
  }
  async function expectUntouched() {
    const before = await dataSnapshot();
    const result = await prepare();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.status, "blocked", JSON.stringify(result));
    assert.notEqual(result.exitCode, 0);
    assert.equal(await dataSnapshot(), before, "refused startup leaves the full schema, application and Prisma metadata rows unchanged");
    assert.ok(!JSON.stringify(result).includes("startup-fixture"), "diagnostics never expose connection credentials");
    return result;
  }
  try {
    docker(["volume", "create", "--label", label, volume]);
    startContainer(); await ready();
    await t.test("fresh clone initializes the committed contract and application repositories work", async () => {
      const first = await prepare();
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.status, "initialized");
      assert.equal(first.exitCode, 0);
      const { getDatabase, disconnectDatabase } = await import("../src/index.js");
      try {
        const db = getDatabase({ connectionString: connection });
        const user = await db.users.create({ cognitoSub: "startup-fixture-sub", email: "startup@example.invalid", firstName: "Startup", lastName: "Fixture" });
        const project = await db.projects.create({ ownerId: user.id, name: "retained startup project" });
        assert.equal((await db.users.findByEmail(user.email))?.id, user.id);
        assert.equal((await db.projects.listByOwner(user.id))[0]?.id, project.id);
        assert.equal(project.archived, false);
      } finally { await disconnectDatabase(); }
      const before = await dataSnapshot();
      const second = await prepare();
      assert.equal(second.status, "verified", JSON.stringify(second));
      assert.equal(await dataSnapshot(), before, "ordinary startup performs no data or metadata writes");
      evidence.push({ fresh: first.status, repeat: second.status, repositories: "user/project create and read" });
    });
    await t.test("stop/start and complete container recreation retain records and marker", async () => {
      const before = await dataSnapshot();
      docker(["stop", "--time", "2", name]); docker(["start", name]); await ready();
      assert.equal((await prepare()).status, "verified");
      assert.equal(await dataSnapshot(), before);
      docker(["stop", "--time", "2", name]); docker(["rm", name]);
      assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume]).stdout, name);
      startContainer(); await ready();
      assert.equal((await prepare()).status, "verified");
      assert.equal(await dataSnapshot(), before);
      evidence.push({ restart: "verified", recreatedContainer: "verified", retainedRows: true });
    });
    await t.test("pulling a new contract onto a genuine historical database preserves its old schema and records", async () => {
      await reset(); await initializeHistorical();
      assert.equal((await query("SELECT to_regclass('public.projects') AS projects")).rows[0]?.projects, null);
      const result = await expectUntouched();
      assert.equal(result.code, "CONTRACT.MARKER_MISMATCH");
      assert.equal((await query("SELECT email FROM users")).rows[0]?.email, "team-retained@example.invalid");
      evidence.push({ pendingContract: result.code, automaticMigration: false });
      const client = createControlClient({ ...compiled.config, connection });
      try {
        await client.connect();
        const migration = await client.migrate({ contract: compiled.contract, migrationsDir: migrationDirectory });
        assert.equal(migration.ok, true, "the fixture's explicit native migration reaches current storage");
      } finally { await client.close(); }
      assert.equal((await prepare()).status, "verified");
    });
    await t.test("switching back to an older branch never downgrades a newer local database", async () => {
      const before = await dataSnapshot();
      const result = await prepareLocalDatabase({ root, connection, allowLoopback: true }, { async load() { return { config: compiled.config, contract: historical }; } });
      assert.equal(result.ok, false); assert.equal(result.status, "blocked");
      assert.equal(result.code, "CONTRACT.MARKER_MISMATCH");
      assert.equal(await dataSnapshot(), before);
      assert.equal((await prepare()).status, "verified");
      evidence.push({ branchDowngrade: result.code, currentBranch: "verified" });
    });
    await t.test("an unknown branch marker is blocked without replacing its history or rows", async () => {
      await query("UPDATE prisma_contract.marker SET core_hash=$1", ["f".repeat(64)]);
      const result = await expectUntouched();
      assert.equal(result.code, "CONTRACT.MARKER_MISMATCH");
      await query("UPDATE prisma_contract.marker SET core_hash=$1", [compiled.contract.storage.storageHash]);
      assert.equal((await prepare()).status, "verified");
      evidence.push({ unknownBranchMarker: result.code });
    });
    await t.test("physical schema drift is refused with retained application data", async () => {
      await query("ALTER TABLE users ADD COLUMN startup_unexpected text DEFAULT 'retain me'");
      const result = await expectUntouched();
      assert.equal(result.code, "CONTRACT.SCHEMA_VERIFICATION_FAILED");
      assert.equal((await query("SELECT startup_unexpected FROM users")).rows[0]?.startup_unexpected, "retain me");
      evidence.push({ drift: result.code, retainedRows: true });
    });
    await t.test("unsigned populated storage is never adopted or reset", async () => {
      await reset();
      await query("CREATE TABLE retained_records (id integer PRIMARY KEY, evidence text NOT NULL)");
      await query("INSERT INTO retained_records VALUES (1, $1)", ["must survive failed startup"]);
      const result = await expectUntouched();
      assert.equal(result.code, "LOCAL_DATABASE_NOT_EMPTY");
      assert.deepEqual((await query("SELECT * FROM retained_records")).rows, [{ id: 1, evidence: "must survive failed startup" }]);
      evidence.push({ unsignedPopulated: result.code });
    });
    await t.test("unmodeled objects without rows still prevent initialization", async () => {
      for (const statement of [
        "CREATE VIEW retained_view AS SELECT 1 AS value",
        "CREATE TYPE retained_enum AS ENUM ('value')",
        "CREATE SCHEMA retained_namespace",
        "CREATE TYPE startup_shell",
        "CREATE COLLATION startup_collation (provider = libc, locale = 'C')",
        "CREATE PUBLICATION startup_publication",
        "CREATE FOREIGN DATA WRAPPER startup_fdw",
      ]) {
        await reset(); await query(statement);
        assert.equal((await expectUntouched()).code, "LOCAL_DATABASE_NOT_EMPTY");
        const relations = await query("SELECT to_regclass('public.users') AS users");
        assert.equal(relations.rows[0]?.users, null, "failed emptiness check creates no application tables");
      }
      evidence.push({ occupiedByViewEnumNamespaceShellTypeCollationPublicationOrFdw: "blocked" });
    });
    await t.test("concurrent first starts produce one valid database and no partial schema", async () => {
      await reset();
      const results = await Promise.all([prepare(), prepare()]);
      assert.ok(results.some(result => result.status === "initialized"), JSON.stringify(results));
      assert.ok(results.every(result => result.ok && ["initialized", "verified"].includes(result.status)), JSON.stringify(results));
      assert.equal((await prepare()).status, "verified");
      evidence.push({ concurrent: results.map(result => result.status), retry: "verified" });
    });
    await t.test("a failed initialization rolls back native DDL and the next startup can initialize", async () => {
      await reset();
      const before = await dataSnapshot(); let reachedDdl = false;
      const failed = await prepareLocalDatabase({ root, connection, allowLoopback: true }, { guard(config, review, current) {
        return failAfterFirstDdl(guardCloudDatabasePath(config, review, current), () => { reachedDdl = true; });
      } });
      assert.equal(reachedDdl, true, "the injected failure follows a real native DDL write inside the transaction");
      assert.equal(failed.ok, false); assert.equal(failed.status, "failed");
      assert.ok(!JSON.stringify(failed).includes("fixture-private-initialization-failure"));
      assert.equal(await dataSnapshot(), before, "failed native initialization leaves no partial control or application schema");
      assert.equal((await prepare()).status, "initialized");
      assert.equal((await prepare()).status, "verified");
      evidence.push({ interruptedInitialization: "rolled back", retry: "initialized" });
    });
    await t.test("a missing database and failed login have distinct safe diagnostics", async () => {
      const before = await dataSnapshot();
      const badLogin = new URL(connection); badLogin.password = "fixture-invalid-password";
      const login = await prepare(badLogin.toString());
      assert.equal(login.ok, false); assert.equal(login.code, "LOCAL_DATABASE_LOGIN_FAILED");
      assert.ok(!JSON.stringify(login).includes("fixture-invalid-password"));
      assert.equal(await dataSnapshot(), before);
      const maintenance = new URL(connection); maintenance.pathname = "/postgres";
      await assertOwnedCluster(maintenance.toString());
      await query("DROP DATABASE app_db WITH (FORCE)", undefined, maintenance.toString());
      const missing = await prepare();
      assert.equal(missing.ok, false); assert.equal(missing.code, "LOCAL_DATABASE_MISSING");
      await query("CREATE DATABASE app_db OWNER admin", undefined, maintenance.toString());
      assert.equal((await prepare()).status, "initialized");
      evidence.push({ failedLogin: login.code, missingDatabase: missing.code, explicitRecreatedDatabase: "initialized" });
    });
    await t.test("unreachable storage fails without credential leakage or mutation", async () => {
      const before = await dataSnapshot();
      const unavailable = new URL(connection); unavailable.port = "1";
      const result = await prepare(unavailable.toString());
      assert.equal(result.ok, false); assert.equal(result.status, "failed");
      assert.notEqual(result.exitCode, 0);
      assert.ok(!JSON.stringify(result).includes("startup-fixture"));
      assert.equal(await dataSnapshot(), before);
      evidence.push({ unavailable: result.code });
    });
    assert.deepEqual(migrationBytes(), originalMigrationBytes, "startup never changes migration packages, snapshots or refs");
  } finally {
    const container = docker(["inspect", "--format", `{{index .Config.Labels "${ownership}"}}`, name], true);
    if (container.status === 0 && container.stdout === name) {
      docker(["stop", "--time", "2", name]); docker(["rm", name]);
    }
    const owned = docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume], true);
    if (owned.status === 0 && owned.stdout === name) docker(["volume", "rm", volume]);
    console.log(JSON.stringify({ localDatabaseStartupEvidence: evidence }));
  }
});

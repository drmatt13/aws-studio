import assert from "./support/assert";
import { testProjectRoot, testProjectScratch } from "../../scripts/test-project";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import pg from "pg";
import { hasMigrations } from "@prisma/orm-framework/components/control";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { DatabaseApplicationService } from "../server/database-application";
import { DatabaseHistoryService } from "../server/database-history";
import { compileDatabaseSource, DatabaseWorkbenchService, resolvePrivateDatabaseTargets } from "../server/database-workbench";

/** Local development only. No current checkout database, AWS or RDS connection is opened. */
test("team development applies recorded local upgrades and refuses branch or concurrent drift safely", {
  skip: process.env.FRAMEWORK_LOCAL_DATABASE_TEST !== "1", timeout: 180_000,
}, async t => {
  const { createControlClient } = await import("@prisma/orm-toolchain/cli/control-api");
  for (const name of ["POSTGRES_HOST_PORT", "FRAMEWORK_STUDIO_STATE_DIRECTORY", "COMPOSE_FILE"]) assert.equal(process.env[name], undefined, `Unset ${name} before running the isolated team database test.`);
  const repository = testProjectRoot;
  const root = testProjectScratch("database-team-live-");
  const name = `aws-studio-db-team-${randomUUID().slice(0, 12)}`, volume = `${name}-data`;
  const ownership = "com.matts-aws-framework.database-team-test", label = `${ownership}=${name}`;
  const evidence: Record<string, unknown>[] = [];
  const sourceFile = path.join(root, "packages/database/prisma/contract.prisma");
  const migrationDirectory = path.join(root, "packages/database/prisma/migrations");
  const historicalHash = "8aead4d0e1d8035b936d6fbe9a450205bbccbdc37348830ddfaa20547242ac47";
  let connection = "";
  function docker(args: string[], optional = false) {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 45_000 });
    if (!optional) assert.equal(result.status, 0, result.stderr);
    return { ...result, stdout: result.stdout.trim() };
  }
  async function query(sql: string, values?: unknown[], selected = connection) {
    const client = new pg.Client({ connectionString: selected, connectionTimeoutMillis: 1000 });
    try { await client.connect(); return await client.query(sql, values); } finally { await client.end(); }
  }
  const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
  async function snapshot() {
    const tables = await query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name");
    const rows = [];
    for (const table of tables.rows) rows.push([table.table_schema, table.table_name, (await query(`SELECT row_to_json(r) AS value FROM ${quoted(table.table_schema)}.${quoted(table.table_name)} AS r ORDER BY row_to_json(r)::text`)).rows]);
    const schema = docker(["exec", name, "pg_dump", "--username=admin", "--dbname=app_db", "--schema-only"]).stdout.split(/\r?\n/).filter(line => !/^\\(?:un)?restrict\b/.test(line)).join("\n");
    return JSON.stringify({ schema, rows });
  }
  /** Injection wraps the real native runner; its transaction and rollback remain real PostgreSQL. */
  function intercepted(config: PrismaNextConfig, intercept: (sql: string, run: () => Promise<unknown>) => Promise<unknown>): PrismaNextConfig {
    const target = config.target;
    if (!hasMigrations(target)) throw new Error("The fixture requires native PostgreSQL migrations.");
    const wrapped: typeof target = { ...target, migrations: { ...target.migrations, createRunner(family) {
      const runner = target.migrations.createRunner(family);
      return { async execute(options) {
        const driver = options.driver; assert.ok("query" in driver && typeof driver.query === "function");
        const original = driver.query.bind(driver) as (sql: string, parameters?: readonly unknown[]) => Promise<unknown>;
        const proxy = new Proxy(driver, { get(value, key) {
          if (key !== "query") { const member = Reflect.get(value, key); return typeof member === "function" ? member.bind(value) : member; }
          return (sql: string, parameters?: readonly unknown[]) => intercept(sql, () => original(sql, parameters));
        } });
        return runner.execute({ ...options, driver: proxy });
      } };
    } } };
    return { ...config, target: wrapped };
  }
  mkdirSync(path.join(root, "packages/database"), { recursive: true });
  cpSync(path.join(repository, "packages/database/prisma"), path.join(root, "packages/database/prisma"), { recursive: true });
  // contract.prisma's Access Graph directives read prisma/access, which imports the framework's authoring helpers.
  cpSync(path.join(repository, "packages/database/scripts"), path.join(root, "packages/database/scripts"), { recursive: true });
  symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(root, "packages/database/package.json"), '{"private":true}');
  writeFileSync(path.join(root, "packages/database/prisma.config.ts"), 'import {definePrismaConfig} from "@prisma/cli-engine";\nimport {defineConfig} from "@prisma/orm-postgres/config";\nexport default definePrismaConfig({orm:defineConfig({contract:"prisma/contract.prisma",output:"src/generated",migrations:{dir:"prisma/migrations"}})});\n');
  const currentSource = readFileSync(sourceFile, "utf8");
  const workbench = new DatabaseWorkbenchService(root), history = new DatabaseHistoryService(root);
  const application = () => new DatabaseApplicationService(root, workbench, () => history.load());
  async function assertOwnedCluster(selected: string) {
    const inspected = JSON.parse(docker(["inspect", "--format", "{{json .}}", name]).stdout);
    assert.equal(inspected.Config.Labels[ownership], name);
    assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume]).stdout, name);
    const binding = inspected.NetworkSettings.Ports["5432/tcp"][0], target = new URL(selected);
    assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, binding.HostPort);
    assert.ok(["/app_db", "/postgres"].includes(target.pathname));
    const expected = docker(["exec", name, "psql", "--username=admin", "--dbname=postgres", "--tuples-only", "--no-align", "--command=SELECT system_identifier::text FROM pg_control_system()"]);
    const observed = await query("SELECT system_identifier::text AS identifier FROM pg_control_system()", undefined, selected);
    assert.equal(observed.rows[0]?.identifier, expected.stdout, "fixture reset requires the exact owned PostgreSQL cluster");
  }
  async function oldDatabase() {
    writeFileSync(sourceFile, currentSource);
    const maintenance = new URL(connection); maintenance.pathname = "/postgres";
    await assertOwnedCluster(maintenance.toString());
    await query("DROP DATABASE app_db WITH (FORCE)", undefined, maintenance.toString());
    await query("CREATE DATABASE app_db OWNER admin", undefined, maintenance.toString());
    const compiled = await compileDatabaseSource(root, currentSource);
    const old = compiled.config.target.contractSerializer.deserializeContract(JSON.parse(readFileSync(path.join(migrationDirectory, `snapshots/${historicalHash}/contract.json`), "utf8")));
    const client = createControlClient({ ...compiled.config, connection });
    try { await client.connect(); assert.equal((await client.dbInit({ contract: old, mode: "apply", migrationsDir: migrationDirectory })).ok, true); }
    finally { await client.close(); }
    await query("INSERT INTO users(id,cognito_sub,email,first_name,last_name,updated_at) VALUES ($1,$2,$3,$4,$5,now())", [randomUUID(), "team-local-sub", "team-local@example.invalid", "Retained", "Developer"]);
    return workbench.load();
  }
  function faultService(intercept: Parameters<typeof intercepted>[1]) {
    return new DatabaseApplicationService(root, workbench, () => history.load(), {
      createWriteClient(config, selected) { return createControlClient({ ...intercepted(config, intercept), connection: selected }); },
    });
  }
  try {
    docker(["volume", "create", "--label", label, volume]);
    docker(["run", "--detach", "--name", name, "--label", label, "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=admin", "--env", "POSTGRES_PASSWORD=team-fixture", "--env", "POSTGRES_DB=app_db", "postgres:16"]);
    const binding = JSON.parse(docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]).stdout)["5432/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    connection = `postgresql://admin:team-fixture@127.0.0.1:${binding.HostPort}/app_db`;
    writeFileSync(path.join(root, ".env"), `POSTGRES_HOST_PORT=${binding.HostPort}\n`);
    writeFileSync(path.join(root, "docker-compose.yml"), `services:\n  postgres:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: admin\n      POSTGRES_PASSWORD: team-fixture\n      POSTGRES_DB: app_db\n    ports: ['127.0.0.1:\${POSTGRES_HOST_PORT}:5432']\n`);
    for (let attempt = 0; ; attempt++) { try { await query("SELECT 1"); break; } catch { if (attempt === 80) throw new Error("Isolated team PostgreSQL did not become ready."); await setTimeout(250); } }
    assert.equal(new URL(resolvePrivateDatabaseTargets(root)[0]!.connection!).port, binding.HostPort);
    await t.test("a teammate's unrelated migration branch does not block the recorded forward upgrade", async () => {
      let saved = await oldDatabase();
      const alternate = currentSource.replace("model Project {\n", 'model Project {\n  teamNote String? @map("team_note")\n');
      writeFileSync(sourceFile, alternate); saved = await workbench.load();
      const h = await history.load();
      const planned = await history.plan({ name: "other_developer_branch", from: historicalHash, expectedSourceHash: saved.revision, expectedHistoryRevision: h.revision });
      assert.equal((await history.install({ reviewId: planned.id })).status, "installed");
      writeFileSync(sourceFile, currentSource); saved = await workbench.load();
      const branched = await history.load();
      assert.ok(branched.issues.some(issue => issue.code === "branch"));
      const unrelated = branched.migrations.find(migration => migration.to === planned.to)!;
      const branchFile = path.join(root, unrelated.sourcePath);
      const branchSource = readFileSync(branchFile, "utf8");
      writeFileSync(branchFile, `${branchSource}\n// An unrelated branch still has placeholder("developer-transform") to fill.\n`);
      const graph = await history.load();
      const observation = await workbench.inspect("local:postgres", saved.revision, graph.revision, graph);
      assert.equal(observation.migrationState.status, "pending");
      const service = application();
      const review = await service.review("local:postgres", saved.revision);
      assert.deepEqual(review.migrations.map(migration => migration.name), ["20260916T1757_add_projects"]);
      assert.equal((await query("SELECT to_regclass('public.projects') AS projects")).rows[0]?.projects, null);
      const result = await service.apply(review.id, review.confirmation);
      assert.equal(result.status, "applied"); assert.equal(result.observation?.migrationState.status, "current");
      assert.equal((await query("SELECT email FROM users")).rows[0]?.email, "team-local@example.invalid");
      assert.equal((await query("SELECT to_regclass('public.projects') AS projects")).rows[0]?.projects, "projects");
      assert.equal(readFileSync(branchFile, "utf8"), `${branchSource}\n// An unrelated branch still has placeholder("developer-transform") to fill.\n`);
      evidence.push({ recordedUpgrade: result.status, unrelatedBranch: "ignored", retainedUsers: 1 });
    });
    await t.test("an unrelated checkout contract has no implicit reverse or guessed migration", async () => {
      writeFileSync(sourceFile, '// use prisma-8\nmodel OtherBranch {\n  id String @id(map: "other_branch_pkey")\n  @@map("other_branch")\n}\n');
      const saved = await workbench.load(); const h = await history.load();
      const before = await snapshot();
      const observed = await workbench.inspect("local:postgres", saved.revision, h.revision, h);
      assert.equal(observed.migrationState.status, "unknown");
      await assert.rejects(application().review("local:postgres", saved.revision), /known marker|forward|path|history/i);
      assert.equal(await snapshot(), before);
      writeFileSync(sourceFile, currentSource);
      evidence.push({ unrelatedCheckout: "no forward path", unchanged: true });
    });
    await t.test("two recorded routes to the saved contract require an explicit history decision", async () => {
      const saved = await oldDatabase(); const h = await history.load();
      const alternative = h.migrations.find(migration => migration.name.includes("other_developer_branch"))!;
      const plan = await history.plan({ name: "merge_branch_back", from: alternative.to, expectedSourceHash: saved.revision, expectedHistoryRevision: h.revision });
      assert.equal((await history.install({ reviewId: plan.id })).status, "installed");
      const branched = await history.load();
      const bridge = branched.migrations.find(migration => migration.from === alternative.to && migration.to === plan.to)!;
      try {
        const before = await snapshot();
        await assert.rejects(application().review("local:postgres", saved.revision), /forward|path|route|history/i);
        assert.equal(await snapshot(), before, "ambiguous routes cannot select or execute migration packages implicitly");
      } finally { rmSync(path.dirname(path.join(root, bridge.sourcePath)), { recursive: true, force: true }); }
      evidence.push({ competingForwardRoutes: "refused", unchanged: true });
    });
    await t.test("parallel reviewers cannot apply the same local upgrade twice", async () => {
      const saved = await oldDatabase();
      const first = application(), second = application();
      const [left, right] = await Promise.all([first.review("local:postgres", saved.revision), second.review("local:postgres", saved.revision)]);
      const outcomes = await Promise.allSettled([first.apply(left.id, left.confirmation), second.apply(right.id, right.confirmation)]);
      const applied = outcomes.filter(outcome => outcome.status === "fulfilled" && outcome.value.status === "applied");
      assert.equal(applied.length, 1);
      assert.ok(outcomes.some(outcome => outcome.status === "rejected"), "the checkout operation lock refuses the overlapping reviewer");
      const after = await snapshot();
      await assert.rejects(first.apply(left.id, left.confirmation), /known marker|pending|path|expired|review/i);
      await assert.rejects(second.apply(right.id, right.confirmation), /known marker|pending|path|expired|review/i);
      assert.equal(await snapshot(), after);
      assert.equal((await query("SELECT count(*)::int AS count FROM users")).rows[0]?.count, 1);
      const compiled = await compileDatabaseSource(root, currentSource);
      const client = createControlClient({ ...compiled.config, connection });
      try { await client.connect(); assert.equal((await client.readLedger()).filter(entry => entry.migrationName === "20260916T1757_add_projects").length, 1); }
      finally { await client.close(); }
      evidence.push({ concurrentReviewers: "one applied, one refused", migrationLedgerEntries: 1 });
    });
    await t.test("DDL failure rolls back the entire reviewed upgrade and an explicit fresh review can retry", async () => {
      const saved = await oldDatabase();
      const before = await snapshot(); let injected = false;
      const service = faultService(async (sql, run) => {
        const result = await run();
        if (!injected && /^\s*create\s+table\b/i.test(sql) && /projects/.test(sql)) { injected = true; throw new Error("fixture-private-team-migration-failure"); }
        return result;
      });
      const review = await service.review("local:postgres", saved.revision);
      const result = await service.apply(review.id, review.confirmation);
      assert.equal(injected, true, "failure is injected only after native application DDL executes");
      assert.equal(result.status, "unconfirmed");
      assert.ok(!JSON.stringify(result).includes("fixture-private-team-migration-failure"));
      assert.equal(await snapshot(), before, "schema, retained rows, marker and ledger all roll back together");
      const fresh = application(); const retry = await fresh.review("local:postgres", saved.revision);
      assert.equal((await fresh.apply(retry.id, retry.confirmation)).status, "applied");
      assert.equal((await query("SELECT count(*)::int AS count FROM users")).rows[0]?.count, 1);
      evidence.push({ failedUpgrade: "rolled back", explicitRetry: "applied" });
    });
    await t.test("drift appearing after review is checked under migration locks before any reviewed DDL", async () => {
      const saved = await oldDatabase(); let changed = false; let afterExternalChange = "";
      const service = faultService(async (sql, run) => {
        if (!changed && sql === "BEGIN") {
          changed = true; await query("ALTER TABLE users ADD COLUMN concurrent_developer_note text DEFAULT 'keep me'");
          afterExternalChange = await snapshot();
        }
        return run();
      });
      const review = await service.review("local:postgres", saved.revision);
      const result = await service.apply(review.id, review.confirmation);
      assert.equal(changed, true); assert.notEqual(result.status, "applied");
      assert.equal(result.diagnostic?.code, "DATABASE_PHYSICAL_DRIFT");
      assert.equal(await snapshot(), afterExternalChange, "the refused migration preserves the concurrent edit, rows, old marker and ledger");
      assert.equal((await query("SELECT to_regclass('public.projects') AS projects")).rows[0]?.projects, null);
      assert.equal((await query("SELECT concurrent_developer_note FROM users")).rows[0]?.concurrent_developer_note, "keep me");
      evidence.push({ concurrentPhysicalDrift: "refused before migration DDL", unchanged: true });
    });
  } finally {
    const container = docker(["inspect", "--format", `{{index .Config.Labels "${ownership}"}}`, name], true);
    if (container.status === 0 && container.stdout === name) { docker(["stop", "--time", "2", name]); docker(["rm", name]); }
    const owned = docker(["volume", "inspect", "--format", `{{index .Labels "${ownership}"}}`, volume], true);
    if (owned.status === 0 && owned.stdout === name) docker(["volume", "rm", volume]);
    console.log(JSON.stringify({ teamDatabaseDevelopmentEvidence: evidence }));
    rmSync(root, { recursive: true, force: true });
  }
});

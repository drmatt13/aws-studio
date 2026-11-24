import { testProjectRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { frameworkRepositoryRoot } from "aws-studio/config/source";

const cli = path.resolve(__dirname, "../cli/aws-studio.cjs");

function project(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio database cli "));
  t.after(() => {
    assert.equal(path.dirname(directory), realpathSync(os.tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, "app"), database = path.join(root, "packages/database");
  mkdirSync(database, { recursive: true });
  const app = testProjectRoot;
  const { packageManager } = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
  copyFileSync(path.join(app, ".nvmrc"), path.join(root, ".nvmrc"));
  writeFileSync(path.join(root, "framework.config.ts"), "");
  writeFileSync(path.join(database, "package.json"), JSON.stringify({ private: true }));
  function adapters(databaseAdapters: Record<string, string>) {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, packageManager, awsStudio: { database: databaseAdapters } }));
  }
  function run(...args: string[]) {
    const env = { ...process.env, FRAMEWORK_REPOSITORY_ROOT: root, npm_config_offline: "true" };
    return spawnSync(process.execPath, [cli, ...args], { cwd: database, env, encoding: "utf8", timeout: 30_000 });
  }
  adapters({});
  return { directory, root, database, run, adapters };
}

test("database commands dispatch the two project-owned adapters by file and preserve argv and exit status", t => {
  const f = project(t);
  f.adapters({ seedTestUser: "seed user.cjs", pruneCognitoOrphans: "prune.cjs" });
  for (const [verb, file] of [["db:seed-test-user", "seed user.cjs"], ["db:prune-cognito-orphans", "prune.cjs"]]) {
    writeFileSync(path.join(f.root, file), 'console.log(JSON.stringify([__filename, process.cwd(), ...process.argv.slice(2)])); process.exitCode = 17;');
    const result = f.run(verb, "two words", "&literal");
    assert.equal(result.status, 17, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [path.join(f.root, file), f.root, "two words", "&literal"]);
  }
});

test("database adapter dispatch rejects absent mappings, absolute paths and paths escaping the project", t => {
  const f = project(t);
  const outside = path.join(f.directory, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "adapter.cjs"), 'console.log("outside adapter executed");');
  symlinkSync(outside, path.join(f.root, "linked"), "junction");
  for (const entry of [undefined, path.join(outside, "adapter.cjs"), "../outside/adapter.cjs", "linked/adapter.cjs"]) {
    f.adapters(entry ? { seedTestUser: entry } : {});
    const result = f.run("db:seed-test-user");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /awsStudio\.database\.seedTestUser/);
    assert.equal(result.stdout, "");
  }
});

test("database generation resolves the selected database's Prisma and stops before emitting access when it fails", t => {
  const f = project(t);
  const prisma = path.join(f.database, "node_modules/prisma");
  mkdirSync(prisma, { recursive: true });
  writeFileSync(path.join(prisma, "package.json"), JSON.stringify({ name: "prisma", bin: { prisma: "fixture.cjs" } }));
  writeFileSync(path.join(prisma, "fixture.cjs"), 'console.log(JSON.stringify([process.cwd(), ...process.argv.slice(2)])); process.exitCode = 19;');
  const result = f.run("db:generate");
  assert.equal(result.status, 19, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [f.database, "contract", "emit"]);
  assert.equal(existsSync(path.join(f.database, "src/generated/client-access.ts")), false);
});

test("database configuration copying resolves explicit source and destination relative to the caller", t => {
  const f = project(t);
  const result = f.run("db:copy-configuration-inputs", "../..", "output directory");
  assert.equal(result.status, 0, result.stderr);
  const copy = path.join(f.database, "output directory");
  assert.deepEqual(readFileSync(path.join(copy, "package.json")), readFileSync(path.join(f.root, "package.json")));
  assert.deepEqual(readFileSync(path.join(copy, "packages/database/package.json")), readFileSync(path.join(f.database, "package.json")));
});

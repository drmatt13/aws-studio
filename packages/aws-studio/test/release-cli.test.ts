import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const release = path.resolve(__dirname, "..");
const installation = path.resolve(release, "../..");
const executable = path.join(release, "cli", "aws-studio.cjs");

function run(cwd: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_offline: "true" };
  delete env.FRAMEWORK_REPOSITORY_ROOT;
  return spawnSync(process.execPath, [executable, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
}

test("the release provides a single aws-studio binary and reports unsupported verbs before loading an app", t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "aws studio cli help "));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(path.join(release, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.bin ?? {}), ["aws-studio"]);
  assert.equal(path.resolve(release, manifest.bin["aws-studio"]), executable);
  const help = run(cwd, "--help");
  assert.equal(help.status, 0, help.stderr);
  for (const name of ["verify", "record", "init", "dev", "deploy", "destroy", "framework:generate", "infrastructure:identity", "db:generate"]) {
    assert.ok(help.stdout.includes(name), name);
  }
  const unsupported = run(cwd, "unused-command");
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unused-command/);
});

test("the installed CLI discovers its project, preserves arguments with spaces, and returns the underlying check result", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aws studio cli app "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, "packages", "database");
  mkdirSync(database, { recursive: true });
  const manager = JSON.parse(readFileSync(path.join(installation, "package.json"), "utf8")).packageManager;
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, packageManager: manager }));
  copyFileSync(path.join(installation, ".nvmrc"), path.join(root, ".nvmrc"));
  writeFileSync(path.join(root, "framework.config.ts"), 'throw new Error("compare must not evaluate the app");');
  const before = "before & reference.json";
  const after = "after comparison.json";
  const empty = JSON.stringify({ version: 1, stacks: {} });
  writeFileSync(path.join(root, before), empty);
  writeFileSync(path.join(root, after), empty);
  const compare = () => run(database, "infrastructure:identity", "compare", before, after, "--strict");
  const same = compare();
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /Identity changes: none/);
  writeFileSync(path.join(root, after), JSON.stringify({ version: 1, stacks: { AddedStack: { resources: {}, outputs: {}, tags: {}, dependencies: [] } } }));
  const changed = compare();
  assert.equal(changed.status, 1, changed.stderr);
  assert.match(changed.stdout, /AddedStack/);
});

test("every fixed verb resolves its release implementation independently of the project path", () => {
  const commands: Record<string, string[][]> = require("../cli/commands.cjs");
  const help = run(path.dirname(release), "--help");
  assert.equal(help.status, 0, help.stderr);
  const listed = help.stdout.trim().split(/\r?\n/).slice(2);
  assert.deepEqual(listed, Object.keys(commands).sort());
  for (const verb of listed) {
    assert.ok(commands[verb].length > 0, verb);
    for (const [entry] of commands[verb]) {
      if (entry === "npm" || entry === "node-test") continue;
      const target = path.resolve(release, entry);
      assert.ok(target.startsWith(release + path.sep), verb);
      assert.ok(statSync(target).isFile(), `${verb} requires ${entry}`);
    }
  }
});

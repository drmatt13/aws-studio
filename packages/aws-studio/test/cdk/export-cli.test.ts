import { projectCli, testProjectRoot } from "./support/test-project";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("export CLI loads workspace modules and validates arguments before AWS access", () => {
  const root = testProjectRoot;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    projectCli(root), "export:cdk-outputs", "--deployment", "INVALID_NAME",
  ], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must be 1-63 lowercase letters/);
  assert.doesNotMatch(result.stderr, /SyntaxError/);
});

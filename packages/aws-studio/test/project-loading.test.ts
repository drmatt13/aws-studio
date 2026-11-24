import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { frameworkRepositoryRoot, loadFrameworkConfig } from "../src/config/source";

function project<T>(config: string | undefined, use: (root: string) => T): T {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "framework-project-")));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    if (config !== undefined) writeFileSync(path.join(root, "framework.config.ts"), config);
    return use(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("loadFrameworkConfig returns the default export of the project's framework.config.ts", () => project("export default { defaults: {}, http: [], marker: 'project' };\n", (root) => {
  assert.equal((loadFrameworkConfig(root) as unknown as { marker: string }).marker, "project");
}));

test("loadFrameworkConfig refuses a configuration without a default export", () => project("export const framework = {};\n", (root) => {
  assert.throws(() => loadFrameworkConfig(root), /framework\.config\.ts does not export its configuration as the default export/);
}));

test("loadFrameworkConfig names a missing configuration", () => project(undefined, (root) => {
  assert.throws(() => loadFrameworkConfig(root), /has no framework\.config\.ts/);
}));

test("frameworkRepositoryRoot honours FRAMEWORK_REPOSITORY_ROOT before discovery", () => project("export default {};\n", (root) => {
  const nested = path.join(root, "nested/source");
  mkdirSync(nested, { recursive: true });
  assert.equal(frameworkRepositoryRoot(nested, {}), root, "discovered from the start directory");
  const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), "framework-other-")));
  try { assert.equal(frameworkRepositoryRoot(nested, { FRAMEWORK_REPOSITORY_ROOT: other }), other, "an explicit root wins"); }
  finally { rmSync(other, { recursive: true, force: true }); }
}));

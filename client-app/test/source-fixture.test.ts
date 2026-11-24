import assert from "./support/assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { includeFixtureSource } from "./support/source-fixture";

test("source fixture copies exclude private inputs and dependencies with Windows or POSIX separators", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "studio-fixture-copy-")), source = path.join(directory, "source"), copied = path.join(directory, "copied");
  const excluded = [".env", ".env.prod", "nested/.env.dev", "node_modules/dependency.js", "nested/node_modules/dependency.js", "dist/bundle.js", "cdk.out/template.json", ".git/config", ".cache/recovery.json", ".framework/state.json", "build/bundle.js", "coverage/index.html"];
  try {
    for (const file of [...excluded, "nested/index.ts", "nested/.env.example"]) {
      const destination = path.join(source, file); mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, "fixture bytes");
    }
    cpSync(source, copied, { recursive: true, filter: includeFixtureSource });
    for (const file of excluded) {
      assert.equal(existsSync(path.join(copied, file)), false, file);
      assert.equal(includeFixtureSource(`C:\\checkout\\${file.replaceAll("/", "\\")}`), false, `Windows: ${file}`);
      assert.equal(includeFixtureSource(`/checkout/${file}`), false, `POSIX: ${file}`);
    }
    assert.equal(readFileSync(path.join(copied, "nested/index.ts"), "utf8"), "fixture bytes");
    assert.equal(readFileSync(path.join(copied, "nested/.env.example"), "utf8"), "fixture bytes");
    assert.equal(includeFixtureSource("C:\\checkout\\nested\\.env.example"), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

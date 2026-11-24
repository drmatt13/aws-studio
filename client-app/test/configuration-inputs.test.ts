import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { configurationSourceFiles, sourceImportClosure } from "aws-studio/database/configuration-inputs";
import { verifyPhase } from "aws-studio/contract-chain/verification";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-config-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file: string, source: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), source); };
  return { root, put, names: (files: readonly string[]) => files.map(file => path.relative(root, file).split(path.sep).join("/")) };
}

test("absent configuration inventory retains missing inputs without requiring a compiler", t => {
  const f = fixture(t);
  assert.deepEqual(f.names(configurationSourceFiles(f.root)), ["packages/database/prisma.config.ts", "package.json", "package-lock.json", "packages/database/package.json"]);
});

test("JSON-only configuration inventory never loads an unrelated compiler", t => {
  const f = fixture(t);
  f.put("package.json", '{"name":"json-inventory"}');
  f.put("package-lock.json", '{"lockfileVersion":3}');
  f.put("node_modules/typescript/package.json", '{"name":"typescript","main":"index.js"}');
  f.put("node_modules/typescript/index.js", 'throw new Error("JSON inventory must not execute this compiler");');
  assert.deepEqual(f.names(sourceImportClosure(f.root, ["package.json", "package-lock.json"], true)), ["package.json", "package-lock.json"]);
});

test("typed source inventory cannot execute candidate-owned compiler code", t => {
  const f = fixture(t), marker = path.join(f.root, "candidate-compiler-executed");
  f.put("package.json", '{"name":"untrusted-parser-fixture"}');
  f.put("prisma.config.ts", 'import {config} from "./helper";\nexport default config;\n');
  f.put("helper.ts", "export const config = {};\n");
  f.put("node_modules/typescript/package.json", '{"name":"typescript","main":"index.js"}');
  f.put("node_modules/typescript/index.js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); throw new Error("candidate code executed in host");`);
  assert.deepEqual(f.names(sourceImportClosure(f.root, ["prisma.config.ts"], true)), ["prisma.config.ts", "helper.ts"]);
  assert.equal(existsSync(marker), false, "inventory must never import executable packages from the candidate");
});

test("trusted inventory does not let an unavailable project verification compiler establish proof", async t => {
  const f = fixture(t);
  f.put("package.json", '{"name":"missing-config-runner"}');
  f.put("prisma.config.ts", "export default {};\n");
  f.put("node_modules/typescript/package.json", '{"name":"typescript","exports":"./missing-runner.js"}');
  assert.deepEqual(f.names(sourceImportClosure(f.root, ["prisma.config.ts"], true)), ["prisma.config.ts"]);
  const result = await verifyPhase(f.root, "api-types", f.root, "unused-reporter");
  assert.equal(result.evidence.status, "unavailable", "the real verification phase still requires the project compiler");
});

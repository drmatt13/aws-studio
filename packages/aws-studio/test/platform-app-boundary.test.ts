import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importSpecifiers, platformAppImports } from "../scripts/platform-boundary";

/**
 * Platform code serves whichever project it runs for, so it never imports an application file.
 * The pending list tracked each crossing until Phase 1 removed it.
 */
const PENDING: readonly string[] = [];

const repository = path.resolve(__dirname, "../../..");
const keys = (root: string) => [...new Set(platformAppImports(root).map(entry => `${entry.file} -> ${entry.target}`))].sort();

test("no platform file imports an application file beyond the pending list", () => {
  assert.deepEqual(keys(repository), [...PENDING].sort());
});

test("application and platform source import the public release package", () => {
  const retiredPackage = ["@repo", "framework"].join("/");
  const inventory = execFileSync("git", [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".", ":(exclude)docs", ":(exclude)output",
  ], { cwd: repository, encoding: "utf8" });
  const violations: string[] = [];
  for (const file of inventory.split("\0")) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const absolute = path.join(repository, file);
    if (!existsSync(absolute)) continue; // An unstaged deletion is still in the index.
    const source = readFileSync(absolute, "utf8");
    if (!source.includes(retiredPackage)) continue;
    for (const { specifier, line } of importSpecifiers(file, source)) {
      if (specifier === retiredPackage || specifier.startsWith(retiredPackage + "/")) {
        violations.push(`${file}:${line} imports ${specifier}`);
      }
    }
  }
  assert.equal(violations.length, 0, `${violations.length} retired imports\n${violations.slice(0, 8).join("\n")}`);
});

test("type-only, dynamic and require imports count; template text does not", () => {
  const source = [
    'import type { A } from "../../framework-config/a";',
    'const later = () => import("../../framework-config/b");',
    'const c = require("../../cdk-app/lib/app/c");',
    'export { d } from "../../compute/d";',
    'const generated = `import x from "../../framework-config/e";\n`;',
  ].join("\n");
  assert.deepEqual(importSpecifiers("scripts/sample.ts", source).map(entry => entry.specifier), [
    "../../framework-config/a",
    "../../framework-config/b",
    "../../cdk-app/lib/app/c",
    "../../compute/d",
  ]);
});

test("framework may import @repo/framework-generated only as a declared peer", () => {
  const manifest = JSON.parse(readFileSync(path.join(repository, "packages/aws-studio/package.json"), "utf8")) as { peerDependencies?: Record<string, string> };
  assert.equal(manifest.peerDependencies?.["@repo/framework-generated"], "*");
  assert.ok(!keys(repository).some(key => key.endsWith("-> @repo/framework-generated") || key.includes("-> packages/framework-generated")));
});

test("a root given with backslashes reports POSIX paths, and app packages count by name", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-boundary-"));
  try {
    mkdirSync(path.join(root, "scripts", "nested"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "nested", "tool.ts"), 'import { x } from "../../framework-config/inputs/deployment";\nimport { y } from "@repo/database";\nimport { z } from "../../packages/aws-studio/src/config";\n');
    const found = platformAppImports(root.replaceAll("/", "\\")).map(entry => `${entry.file}:${entry.line} -> ${entry.target}`);
    assert.deepEqual(found, [
      "scripts/nested/tool.ts:1 -> framework-config/inputs/deployment",
      "scripts/nested/tool.ts:2 -> @repo/database",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing repository root cannot pass the boundary check", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-boundary-"));
  try {
    assert.throws(() => platformAppImports(path.join(root, "missing")), { code: "ENOENT" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only the framework can use its declared application-generated peer", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-boundary-"));
  try {
    mkdirSync(path.join(root, "packages/aws-studio"), { recursive: true });
    mkdirSync(path.join(root, "client-app/server"), { recursive: true });
    const source = 'import type { TargetId } from "@repo/framework-generated/target-ids";';
    writeFileSync(path.join(root, "packages/aws-studio/tool.ts"), source);
    writeFileSync(path.join(root, "client-app/server/tool.ts"), source);
    const manifest = path.join(root, "packages/aws-studio/package.json");
    writeFileSync(manifest, '{}');
    assert.deepEqual(keys(root), [
      "client-app/server/tool.ts -> @repo/framework-generated/target-ids",
      "packages/aws-studio/tool.ts -> @repo/framework-generated/target-ids",
    ]);
    writeFileSync(manifest, '{"peerDependencies":{"@repo/framework-generated":"*"}}');
    assert.deepEqual(keys(root), ["client-app/server/tool.ts -> @repo/framework-generated/target-ids"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("application frontend imports are distinguished from the Studio workspace path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-boundary-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "tool.ts"), [
      'import { studio } from "../client-app/server/index";',
      'import { route } from "../client-app/src/routes/home";',
      'import { router } from "../client-app/src/router";',
      'import { app } from "client-app";',
    ].join("\n"));
    assert.deepEqual(keys(root), [
      "scripts/tool.ts -> client-app",
      "scripts/tool.ts -> client-app/src/router",
      "scripts/tool.ts -> client-app/src/routes/home",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("overlapping application paths still report app imports when Studio has a same-stem file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "platform-boundary-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "client-app/src/api"), { recursive: true });
    const api = path.join(root, "client-app/src/api.ts");
    const viteConfig = path.join(root, "client-app/vite.config.mts");
    writeFileSync(api, "export {};");
    writeFileSync(viteConfig, "export {};");
    writeFileSync(path.join(root, "client-app/src/api/index.ts"), "export {};");
    writeFileSync(path.join(root, "scripts/tool.ts"), [
      'import "../client-app/src/api";',
      'import "../client-app/src/api.ts";',
      'import "../client-app/src/api.js";',
      'import "../client-app/src/api/";',
      'import "../client-app/src/api/index";',
      'import "../client-app/src/api/generated/operation";',
      'import "../client-app/vite.config.mts";',
      'import "../client-app/vite.config.ts";',
      'import "client-app";',
    ].join("\n"));
    const crossings = () => platformAppImports(root).map(({ line, target }) => [line, target]);
    const appImports = [
      [4, "client-app/src/api/"],
      [5, "client-app/src/api/index"],
      [6, "client-app/src/api/generated/operation"],
      [8, "client-app/vite.config"],
      [9, "client-app"],
    ];
    assert.deepEqual(crossings(), appImports);
    rmSync(api);
    rmSync(viteConfig);
    assert.deepEqual(crossings(), [
      [1, "client-app/src/api"],
      [2, "client-app/src/api"],
      [3, "client-app/src/api"],
      ...appImports.slice(0, 3),
      [7, "client-app/vite.config"],
      ...appImports.slice(3),
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

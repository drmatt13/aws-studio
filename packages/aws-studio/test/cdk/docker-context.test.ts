import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { IgnoreStrategy } from "aws-cdk-lib";
import { platformSourceRoot, testProjectRoot } from "../../../../scripts/test-project";

// CDK uses the application root to stage image assets. Check the application
// and platform policies against the paths owned by each checkout.
function ignoredBy(root: string): (relative: string) => boolean {
  const patterns = readFileSync(path.join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const strategy = IgnoreStrategy.docker(root, patterns);
  return (relative) => strategy.ignores(path.join(root, relative));
}

const appIgnores = ignoredBy(testProjectRoot);
const platformIgnores = ignoredBy(platformSourceRoot);

test("research workspaces, caches, local state and secrets never enter an image context", () => {
  for (const relative of [
    ".superpowers/sdd/notes.md",
    ".claude/settings.local.json",
    ".cache/agentcore-redesign/verify.log",
    "packages/database/.cache/prisma/engine",
    "cdk-app/.cache/deploy/manifest.json",
    "cdk-app/.env.dev",
    "cdk-app/.env.prod",
    "cdk-app/cdk.context.json",
    "cdk-app/.secret-bindings.json",
    "cdk-app/.env.local",
    "cdk-app/cdk.out/manifest.json",
    "node_modules/zod/package.json",
    "client-app/dist/index.html",
    ".playwright-mcp/page-2026-10-30T00-00-00-000Z.yml",
    ".playwright-cli/page-2026-10-30T00-00-00-000Z.yml",
    "output/playwright/review/trace.zip",
    ".git/HEAD",
  ]) {
    assert.equal(appIgnores(relative), true, `${relative} must not reach the application image context`);
  }

  for (const relative of [
    "client-app/test/browser/.dist/gallery/index.html",
    "client-app/test-results/results.json",
    "client-app/playwright-report/index.html",
    "client-app/blob-report/report.zip",
    "client-app/coverage/lcov.info",
  ]) {
    assert.equal(platformIgnores(relative), true, `${relative} must not reach the platform image context`);
  }
});

test("the sources an image builds from still do", () => {
  for (const relative of ["package.json", "package-lock.json", "framework.config.ts", "client-app/src/routeTree.gen.ts"]) {
    assert.equal(appIgnores(relative), false, `${relative} is needed in the application image context`);
  }

  for (const relative of [
    "package.json",
    "package-lock.json",
    "packages/aws-studio/src/runtime/tools.ts",
    "client-app/test/browser/shell.spec.ts",
    "client-app/test/browser/gallery.spec.ts-snapshots/shared-controls-chromium-light-darwin.png",
    "client-app/test/browser/assets/fonts/fonts.css",
  ]) {
    assert.equal(platformIgnores(relative), false, `${relative} is needed in the platform image context`);
  }
});

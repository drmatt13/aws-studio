import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { testProjectRoot } from "../../../../../scripts/test-project";
export { testProjectModule, testProjectRoot, testProjectScratchRoot } from "../../../../../scripts/test-project";

/** Select the same released CLI the app's npm scripts run. */
export function projectCli(root: string): string {
  return createRequire(path.join(root, "package.json")).resolve("aws-studio/cli");
}

/** Minimal fake applications use the same Node and npm pins as the source fixture. */
export function writeTestToolchain(root: string): void {
  const { packageManager } = JSON.parse(readFileSync(path.join(testProjectRoot, "package.json"), "utf8"));
  copyFileSync(path.join(testProjectRoot, ".nvmrc"), path.join(root, ".nvmrc"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, packageManager }));
}

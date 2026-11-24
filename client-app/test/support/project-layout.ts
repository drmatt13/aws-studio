import { testProjectRoot, platformSourceRoot } from "../../../scripts/test-project";
import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { PROJECT_LAYOUT } from "../../server/project-modules";

export function installFixtureFramework(root: string): void {
  const modules = path.join(root, "node_modules");
  mkdirSync(modules, { recursive: true });
  symlinkSync(path.join(platformSourceRoot, "packages/aws-studio"), path.join(modules, "aws-studio"), process.platform === "win32" ? "junction" : "dir");
}

/** Give a fixture project this application's framework-setting and sign-in declarations. */
export function withApplicationDeclarations(root: string): string {
  for (const relative of [PROJECT_LAYOUT.deploymentInputs, PROJECT_LAYOUT.signInCatalog, PROJECT_LAYOUT.signInInputs, PROJECT_LAYOUT.frameworkInputs]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    cpSync(path.join(testProjectRoot, relative), path.join(root, relative));
  }
  return root;
}

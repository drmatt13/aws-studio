import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

/** Source for platform, Studio, and repository-only tests. */
export const platformSourceRoot = realpathSync(path.resolve(__dirname, ".."));

function selectedTestProject(): string {
  const root = process.env.AWS_STUDIO_TEST_PROJECT;
  if (!root || !path.isAbsolute(root) || !existsSync(path.join(root, "framework.config.ts"))) {
    throw new Error("Prepare the pinned starter through scripts/with-test-project.mjs before running project-dependent tests.");
  }
  const project = realpathSync(root);
  const instance = path.dirname(project);
  const relative = path.relative(realpathSync(tmpdir()), instance).split(path.sep).join("/");
  if (path.basename(project) !== "project" ||
      !/^aws-studio-test-projects\/[0-9a-f]{12}\/[0-9a-f]{12}-[0-9a-f]{24}\/app-[A-Za-z0-9]{6}$/.test(relative) ||
      !lstatSync(path.join(instance, "source.json"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("The selected test application must be a prepared disposable starter.");
  }
  return project;
}

/** The app snapshot shared by readers in the current test run. */
export const testProjectRoot = selectedTestProject();
export const testProjectScratchRoot = path.join(path.dirname(testProjectRoot), "scratch");
const projectRequire = createRequire(path.join(testProjectRoot, "package.json"));

export function testProjectModule<T>(relative: string): T {
  if (!relative || relative.split("/").some(segment => segment === "." || segment === "..") ||
      path.isAbsolute(relative) || relative.includes("\\")) {
    throw new Error("Use a path relative to the pinned starter.");
  }
  return projectRequire(path.join(testProjectRoot, relative)) as T;
}

/** Scratch is outside both the shared app and the checkout; callers own removal. */
export function testProjectScratch(prefix: string): string {
  const parent = path.join(testProjectScratchRoot, ".cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  if (realpathSync(parent) !== parent) throw new Error("Test scratch must use a physical directory.");
  return mkdtempSync(path.join(parent, prefix));
}

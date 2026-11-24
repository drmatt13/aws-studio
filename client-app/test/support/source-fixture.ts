import { copyIsolatedProject } from "../../../packages/aws-studio/test/cdk/support/isolated-project";
import { testProjectRoot } from "../../../scripts/test-project";
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dependencyRoots } from "aws-studio/source/workspace";
import type { SnapshotBuilder } from "../../server/snapshot";

let scratchRoot: string | undefined;
interface StudioTestProjectOptions { readonly physicalDependencies?: boolean }

/** Keep synthetic Studio projects short while giving them the fixture's registry-only fallback. */
export function studioTestScratchRoot(): string {
  if (scratchRoot) return scratchRoot;
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-scratch-"));
  try {
    const fallback = path.join(path.dirname(testProjectRoot), "node_modules");
    symlinkSync(fallback, path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    scratchRoot = root;
    process.once("exit", () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function studioProjectScratch(prefix: string): string {
  const parent = path.join(studioTestScratchRoot(), ".cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, prefix));
}

/** Copy public source without private inputs, dependencies or build output on either host OS. */
export function includeFixtureSource(source: string): boolean {
  const normalized = source.replaceAll("\\", "/");
  return !/(?:^|\/)(?:node_modules|cdk\.out|dist|build|coverage|\.git|\.cache|\.framework)(?:\/|$)/.test(normalized)
    && (!/(?:^|\/)\.env(?:\.|$)/.test(normalized) || path.posix.basename(normalized) === ".env.example");
}

/** SQLite must be able to open the app-local source database and its WAL on Windows. */
export function copyStudioTestProject(prefix: string, options: StudioTestProjectOptions = {}): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), `studio-test-${prefix}`));
  try {
    copyIsolatedProject(testProjectRoot, root, { physicalRelease: true });
    if (options.physicalDependencies) restorePreparedDependencies(root);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Workspace activation requires owned dependency trees and links within the fixture. */
function restorePreparedDependencies(root: string): void {
  for (const directory of dependencyRoots(root)) rmSync(directory, { recursive: true, force: true });
  for (const directory of dependencyRoots(testProjectRoot)) {
    const destination = path.join(root, path.relative(testProjectRoot, directory));
    const junctions: { file: string; target: string }[] = [];
    cpSync(directory, destination, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, filter(source, file) {
      if (process.platform !== "win32" || !lstatSync(source).isSymbolicLink() || !path.isAbsolute(readlinkSync(source))) return true;
      const relative = path.relative(testProjectRoot, realpathSync(source));
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("A prepared test dependency leaves the starter.");
      junctions.push({ file, target: path.join(root, relative) });
      return false;
    } });
    for (const junction of junctions) symlinkSync(junction.target, junction.file, "junction");
  }
}

/** Real declarations with public template inputs, independent of private checkout files. */
export function createSnapshotFixture() {
  const root = copyStudioTestProject("snapshot-");
  try {
    for (const mode of ["dev", "prod"]) {
      copyFileSync(path.join(root, `cdk-app/.env.${mode}.template`), path.join(root, `cdk-app/.env.${mode}`));
    }
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}


/** Reset disposable test source directly, independently of Studio's edit APIs. */
export function sourceFixtureCheckpoint(root: string, builder: SnapshotBuilder, options: StudioTestProjectOptions = {}): () => Promise<void> {
  const resolved = realpathSync(root);
  const shortProject = path.dirname(resolved) === realpathSync(tmpdir()) && path.basename(resolved).startsWith("studio-test-");
  const syntheticProject = scratchRoot && resolved.startsWith(path.join(scratchRoot, ".cache/framework-studio") + path.sep);
  if (!shortProject && !syntheticProject) {
    throw new Error("Source checkpoints require a disposable Studio fixture.");
  }
  const scan = () => {
    const files = new Map<string, Buffer>();
    const directories: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", ".framework", ".cache", ".git", "dist", "cdk.out"].includes(entry.name) || entry.isSymbolicLink()) continue;
        if (/^\.env(?:\.|$)/.test(entry.name) && !/\.(?:template|example)$/.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { directories.push(file); visit(file); }
        else if (entry.isFile()) files.set(file, readFileSync(file));
      }
    };
    visit(resolved);
    return { files, directories };
  };
  const original = scan();
  const lockFile = path.join(resolved, "package-lock.json");
  const lock = options.physicalDependencies ? original.files.get(lockFile) : undefined;
  if (options.physicalDependencies && !lock?.equals(readFileSync(path.join(testProjectRoot, "package-lock.json")))) {
    throw new Error("A workspace test fixture checkpoint requires the prepared starter's npm lockfile.");
  }
  return async () => {
    if (lock && (!existsSync(lockFile) || !readFileSync(lockFile).equals(lock))) restorePreparedDependencies(resolved);
    const current = scan();
    let changed = false;
    for (const file of current.files.keys()) if (!original.files.has(file)) { unlinkSync(file); changed = true; }
    for (const [file, contents] of original.files) if (!contents.equals(current.files.get(file) ?? Buffer.alloc(0)) || !current.files.has(file)) {
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); changed = true;
    }
    for (const directory of current.directories.reverse()) if (!original.directories.includes(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
    if (changed) await builder.refresh();
  };
}

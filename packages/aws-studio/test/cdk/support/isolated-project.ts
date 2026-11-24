import { createHash } from "node:crypto";
import { copyFileSync, cpSync, rmSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDependencyCachePath, readSourceManifest } from "aws-studio/source/workspace";

/** Execute repository-rooted commands against current public source, never the checkout's private state. */
export function copyIsolatedProject(root: string, destination: string, options: { physicalRelease?: boolean } = {}): void {
  root = realpathSync(root);
  const source = readSourceManifest(root);
  mkdirSync(destination, { recursive: true });
  const parents = new Set([root]);
  for (const [name, entry] of Object.entries(source.files)) {
    const file = path.join(root, name), target = path.join(destination, name);
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.hash) throw new Error(`Source changed during test fixture capture: ${name}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx", mode: entry.mode });
    for (let directory = path.dirname(file); directory.startsWith(`${root}${path.sep}`) && !parents.has(directory); directory = path.dirname(directory)) parents.add(directory);
  }
  // These commands reuse installed dependency code. Workspace
  // links must instead point into this copy, or __dirname would escape isolation.
  for (const directory of parents) {
    const modules = path.join(directory, "node_modules");
    if (!existsSync(modules)) continue;
    if (realpathSync(modules) !== modules || !lstatSync(modules).isDirectory()) throw new Error("The test requires installed dependencies inside the checkout.");
    const targetModules = path.join(destination, path.relative(root, modules));
    mkdirSync(targetModules, { recursive: true });
    const link = (file: string, target: string): void => {
      const resolved = realpathSync(file), relative = path.relative(root, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("A test dependency leaves the captured project.");
      const releasePath = path.join("node_modules", "aws-studio");
      const copyRelease = options.physicalRelease && (relative === releasePath || relative.startsWith(releasePath + path.sep));
      if (copyRelease && relative === releasePath) {
        cpSync(resolved, target, { recursive: true });
        return;
      }
      const workspace = !relative.split(path.sep).includes("node_modules");
      const mapped = workspace || copyRelease ? path.join(destination, relative) : resolved;
      if (workspace && !existsSync(mapped)) throw new Error("A workspace dependency was excluded from public source capture.");
      const directory = lstatSync(resolved).isDirectory();
      if (process.platform === "win32" && !directory) copyFileSync(mapped, target);
      else symlinkSync(mapped, target, directory ? process.platform === "win32" ? "junction" : "dir" : "file");
    };
    for (const name of readdirSync(modules)) {
      if (name === ".package-lock.json" || isDependencyCachePath(path.join(modules, name))) continue;
      const file = path.join(modules, name), target = path.join(targetModules, name);
      if ((name.startsWith("@") || name === ".bin") && lstatSync(file).isDirectory()) {
        mkdirSync(target);
        for (const child of readdirSync(file)) link(path.join(file, child), path.join(target, child));
      } else link(file, target);
    }
  }
}

/** A writable app source copy for tests that create handlers, plans or state. */
export function copyLocalTestProject(prefix = "app-source-"): string {
  const { testProjectRoot, testProjectScratch } = require("../../../../../scripts/test-project") as typeof import("../../../../../scripts/test-project");
  const root = testProjectScratch(prefix);
  try {
    copyIsolatedProject(testProjectRoot, root, { physicalRelease: true });
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

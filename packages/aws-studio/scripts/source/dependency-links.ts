import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { isDependencyCachePath } from "./workspace";

/** Rebase workspace links into public source; grant only installed module directories for other dependencies. */
export function linkDependencies(root: string, copy: string, sourceFiles: readonly string[]): string[] {
  const found = new Set<string>();
  const parents = new Set<string>([root]);
  for (const file of sourceFiles) for (let directory = path.dirname(file); directory.startsWith(`${root}${path.sep}`) && !parents.has(directory); directory = path.dirname(directory)) parents.add(directory);
  for (const directory of parents) {
    const modules = path.join(directory, "node_modules");
    if (!existsSync(modules)) continue;
    const canonicalModules = realpathSync(modules);
    if (canonicalModules !== modules || !lstatSync(modules).isDirectory()) throw new Error("Restricted evaluation requires installed dependencies inside the checkout.");
    found.add(canonicalModules);
    const destination = path.join(copy, path.relative(root, modules)); mkdirSync(destination, { recursive: true, mode: 0o700 });
    const link = (source: string, target: string): void => {
      const resolved = realpathSync(source), relative = path.relative(root, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("A dependency link leaves the captured project.");
      const workspace = !relative.split(path.sep).includes("node_modules");
      const mapped = workspace ? path.join(copy, relative) : resolved;
      if (workspace && !existsSync(mapped)) throw new Error("A workspace dependency was excluded from public source capture.");
      if (process.platform === "win32" && lstatSync(resolved).isFile()) copyFileSync(mapped, target);
      else symlinkSync(mapped, target, lstatSync(resolved).isDirectory() ? process.platform === "win32" ? "junction" : "dir" : "file");
    };
    for (const name of readdirSync(modules)) {
      if (name === ".package-lock.json" || isDependencyCachePath(path.join(modules, name))) continue;
      const source = path.join(modules, name), target = path.join(destination, name);
      if ((name.startsWith("@") || name === ".bin") && lstatSync(source).isDirectory()) {
        mkdirSync(target, { mode: 0o700 }); for (const child of readdirSync(source)) link(path.join(source, child), path.join(target, child));
      } else link(source, target);
    }
  }
  return [...found];
}

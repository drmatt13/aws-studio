import path from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

/** The CLI exported by the AWS Studio release installed in this project. */
export function projectCliEntry(root: string): string {
  const installed = realpathSync(path.join(root, "node_modules/aws-studio"));
  const manifest = path.join(installed, "package.json");
  const declaration = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; bin?: string | Record<string, string> };
  const bin = typeof declaration.bin === "string" ? declaration.bin : declaration.bin?.["aws-studio"];
  if (declaration.name !== "aws-studio" || !bin || path.isAbsolute(bin)) throw new Error("The project release must declare the aws-studio CLI.");
  const entry = path.resolve(installed, bin);
  const relative = path.relative(installed, entry);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("The project CLI must be inside its installed aws-studio release.");
  const stat = lstatSync(entry);
  if (!stat.isFile() || stat.nlink !== 1 || realpathSync(entry) !== entry || createRequire(manifest).resolve("aws-studio/cli") !== entry) {
    throw new Error("The project release must export its declared aws-studio CLI as a regular local file.");
  }
  return entry;
}

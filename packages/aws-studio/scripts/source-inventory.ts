import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { LAMBDA_SOURCE_ROOTS } from "../src/config/conventions";

/** Discovery offers completions and validates declarations; it never creates workloads. */
export function lambdaDirectoriesById(repositoryRoot: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const collisions: string[] = [];
  for (const root of LAMBDA_SOURCE_ROOTS) {
    const absolute = path.join(repositoryRoot, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${root}/${entry.name}`;
      const existing = found.get(entry.name);
      if (existing) collisions.push(`${entry.name} is both ${existing} and ${directory}`);
      else found.set(entry.name, directory);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `compute Lambda trees have handler directories sharing a target id, which is the identity every registry key, replay envelope and deployed resource is built from:\n  - ${collisions.join("\n  - ")}`,
    );
  }
  return new Map([...found].sort(([a], [b]) => a < b ? -1 : 1));
}

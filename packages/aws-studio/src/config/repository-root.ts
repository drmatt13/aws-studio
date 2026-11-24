import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Walks up from `start` to the directory holding `framework.config.ts` and
 * the root `package.json`. Source directories need not exist yet.
 */
export function findRepositoryRoot(start: string = process.cwd()): string {
  let current = path.resolve(start);
  for (;;) {
    if (
      existsSync(path.join(current, "framework.config.ts")) &&
      existsSync(path.join(current, "package.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Unable to locate the repository root from "${start}". Expected framework.config.ts and package.json.`,
      );
    }
    current = parent;
  }
}

/**
 * The project platform code is serving: `FRAMEWORK_REPOSITORY_ROOT` when a launcher, installer or
 * the CDK entry point names it, otherwise the project containing `start`. Platform code calls
 * this rather than assuming the project encloses the platform's own files.
 */
export function frameworkRepositoryRoot(start: string = process.cwd(), environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const named = environment.FRAMEWORK_REPOSITORY_ROOT;
  return named ? path.resolve(named) : findRepositoryRoot(start);
}

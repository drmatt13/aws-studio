import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosticLocation } from "../../shared/model";

const TRANSFORM_POSITION = /^(.+?):(\d+):(\d+): ERROR:/m;
const REQUIRE_STACK = /^Require stack:\n((?:- .+\n?)+)/m;
const STACK_FRAME = /^\s+at (?:.*? \()?((?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/).+?):(\d+):(\d+)\)?$/gm;
/** Frames from these belong to the tools, so a developer could not act on them. */
const TOOLING = /^(?:.*\/)?(?:node_modules|packages\/aws-studio)\//;

/** The application file a path names, relative to the repository, or nothing if it is not one. */
function applicationFile(file: string, repositoryRoot: string): string | undefined {
  let absolute = file;
  if (file.startsWith("file://")) {
    try { absolute = fileURLToPath(file); }
    catch { return undefined; }
  }
  const relative = path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
  return TOOLING.test(relative) ? undefined : relative;
}

/**
 * Where a load failure was written, when the error reveals it. A syntax error
 * states its position, a missing module names its importer, and a throw records
 * its frames. Nothing is inferred beyond that, so an absent location means
 * unknown rather than a guess.
 */
export function failureLocation(error: unknown, repositoryRoot: string): DiagnosticLocation | undefined {
  if (!(error instanceof Error)) return undefined;
  const position = TRANSFORM_POSITION.exec(error.message);
  if (position) {
    const file = applicationFile(position[1]!, repositoryRoot);
    return file ? { file, line: Number(position[2]), column: Number(position[3]) } : undefined;
  }
  const requires = REQUIRE_STACK.exec(error.message)?.[1]?.split("\n") ?? [];
  for (const entry of requires) {
    const file = entry ? applicationFile(entry.slice(2), repositoryRoot) : undefined;
    if (file) return { file, line: 1, column: 1 };
  }
  for (const frame of (error.stack ?? "").matchAll(STACK_FRAME)) {
    const file = applicationFile(frame[1]!, repositoryRoot);
    if (file) return { file, line: Number(frame[2]), column: Number(frame[3]) };
  }
  return undefined;
}

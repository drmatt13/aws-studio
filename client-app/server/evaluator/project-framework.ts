import { existsSync, realpathSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { resolveProjectInstallation, studioFrameworkPackageDirectory } from "../project-release";

/**
 * Evaluating a project with the project's own framework.
 *
 * A project's framework.config.ts imports aws-studio from the project's dependencies. The
 * evaluator's projection code (model/project.ts and its neighbours) imports it from Studio's.
 * When those are two installations — a project checked out elsewhere, or one pinned to another
 * framework version — the configuration would be built by one copy and read by the other, and
 * module state such as `withDeferredInvocationAvailability` would silently stop applying.
 *
 * So inside an evaluator process every module that resolves into Studio's framework package is
 * loaded from the same path inside the project's instead. Node keys its module cache by the
 * resolved filename, so this leaves exactly one framework instance: the project's. A module this
 * Studio needs and the project's version does not have is refused by name rather than mixed in.
 */

type Resolver = (this: unknown, request: string, parent: unknown, ...rest: unknown[]) => string;

/** The real directory of the aws-studio package that `root` installs. */
export function frameworkPackageDirectory(root: string): string {
  return resolveProjectInstallation(root).framework;
}

/** Load every module resolved inside `from` from the same relative path inside `to`. */
export function installFrameworkRedirect(options: { readonly from: string; readonly to: string }): () => void {
  const from = realpathSync(options.from), to = realpathSync(options.to);
  if (from === to) return () => undefined;
  const loader = Module as unknown as { _resolveFilename: Resolver };
  const original = loader._resolveFilename;
  const projectRequire = createRequire(path.join(to, "package.json"));
  const mapped = new Map<string, string | undefined>();
  const target = (resolved: string): string | undefined => {
    if (mapped.has(resolved)) return mapped.get(resolved);
    let real: string;
    try { real = realpathSync(resolved); } catch { mapped.set(resolved, undefined); return undefined; }
    const relative = path.relative(from, real);
    // The framework's own source moves; its installed dependencies belong to each installation.
    const outside = relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep)[0] === "node_modules";
    const result = outside ? undefined : path.join(to, relative);
    mapped.set(resolved, result);
    return result;
  };
  const redirect: Resolver = function (request, parent, ...rest) {
    const resolved = original.call(this, request, parent, ...rest);
    const replacement = target(resolved);
    if (replacement === undefined) return resolved;
    if (request === "aws-studio" || request.startsWith("aws-studio/")) return projectRequire.resolve(request);
    if (!existsSync(replacement)) {
      const relative = path.relative(to, replacement).replaceAll("\\", "/");
      throw new Error(`This Studio needs ${relative} from aws-studio, which the project's framework at ${to} does not provide. Update the project's framework, or open it with a Studio that supports its version.`);
    }
    return replacement;
  };
  loader._resolveFilename = redirect;
  return () => { if (loader._resolveFilename === redirect) loader._resolveFilename = original; };
}

/**
 * Make this process evaluate `projectRoot` with the project's framework. Returns the project's
 * framework directory, and reports it once when it is not Studio's own.
 */
export function useProjectFramework(projectRoot: string, report: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): string {
  const project = frameworkPackageDirectory(projectRoot);
  const studio = studioFrameworkPackageDirectory();
  installFrameworkRedirect({ from: studio, to: project });
  if (studio !== project) report(`Evaluating with the project's framework at ${project}.`);
  return project;
}

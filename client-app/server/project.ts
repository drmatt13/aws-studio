import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { IncompatibleProjectError } from "./project-errors";
import { findRepositoryRoot } from "./inputs";
import { SourceJournal } from "./edits/journal";
import { resolveProjectInstallation, studioInstallation, type ProjectRelease } from "./project-release";

/**
 * Which project this Studio process opens.
 *
 * `--project <dir>` names it, then `STUDIO_PROJECT`, and otherwise it is the external project
 * containing the working directory. Studio opens one
 * project per process: every watcher, evaluator, journal and operation it starts is that
 * project's, and opening another is a restart, not a switch.
 *
 * A project is the directory holding framework.config.ts and package.json, with its framework
 * installed: Studio evaluates every project with the framework that project installs.
 */
export { IncompatibleProjectError } from "./project-errors";

export interface StudioProject {
  readonly root: string;
  /** The project's aws-studio installation, which evaluates its configuration. */
  readonly framework: string;
  readonly release?: ProjectRelease;
}

function named(args: readonly string[], env: Readonly<Record<string, string | undefined>>): string | undefined {
  const flag = args.indexOf("--project");
  if (flag >= 0) {
    const value = args[flag + 1];
    if (!value || value.startsWith("--")) throw new IncompatibleProjectError("--project needs a directory.");
    return value;
  }
  return env.STUDIO_PROJECT || undefined;
}

function insideStudioInstallation(root: string): boolean {
  const relative = path.relative(realpathSync(studioInstallation), root);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireExternalProject(root: string): void {
  if (insideStudioInstallation(root)) {
    throw new IncompatibleProjectError("Choose a project outside the AWS Studio installation with --project <dir>.");
  }
}

interface ProjectRequest { readonly args: readonly string[]; readonly env: Readonly<Record<string, string | undefined>>; readonly cwd: string }

export function resolveStudioProjectRoot(input: ProjectRequest, options: { readonly recovery?: boolean } = {}): string {
  const requested = named(input.args, input.env);
  let root: string;
  if (requested !== undefined) {
    const directory = path.resolve(input.cwd, requested);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new IncompatibleProjectError(`${directory} is not a directory.`);
    root = realpathSync(directory);
    requireExternalProject(root);
    // An explicit recovery checkout may have lost a project marker to an
    // external edit. The journal checks its own reviewed root and paths.
    if (options.recovery) return root;
    for (const marker of ["framework.config.ts", "package.json"]) {
      if (!existsSync(path.join(root, marker))) throw new IncompatibleProjectError(`${root} is not an AWS Studio project: it has no ${marker}.`);
    }
  } else {
    const noProject = () => new IncompatibleProjectError(`No AWS Studio project contains ${input.cwd}. Choose a project with --project <dir>.`);
    let cwd: string;
    try { cwd = realpathSync(input.cwd); }
    catch { throw noProject(); }
    if (insideStudioInstallation(cwd)) throw noProject();
    try { root = realpathSync(findRepositoryRoot(cwd)); }
    catch { throw noProject(); }
    requireExternalProject(root);
  }
  return root;
}
export function resolveStudioProject(input: ProjectRequest): StudioProject {
  const root = resolveStudioProjectRoot(input);
  try {
    const journal = new SourceJournal(root);
    if (journal.installationInProgress()) throw new IncompatibleProjectError("Another AWS Studio instance is applying project dependencies. Wait for Apply to finish before opening this project.");
    if (journal.interruptedInstallations().length) throw new IncompatibleProjectError("A project dependency change was interrupted. Run Studio with --recover-upgrade --project <directory> to restore the previous installation before opening it.");
    return resolveProjectInstallation(root);
  }
  catch (error) {
    if (error instanceof IncompatibleProjectError) throw error;
    throw new IncompatibleProjectError(error instanceof Error ? error.message : "The project's AWS Studio release could not be established.");
  }
}

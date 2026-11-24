import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { APP_CONTEXT_KEY, APP_ID_CONTEXT_KEY, TARGETS_CONTEXT_KEY, newAppId, projectTargets } from "aws-studio/deploy/targets";
import { publicStarterPath, readStarterFiles, readStarterSelection, writeStarterFiles } from "../../scripts/test-project-source.mjs";
import { IncompatibleProjectError } from "./project-errors";
import { resolveProjectInstallation, studioInstallation } from "./project-release";
import { prepareProjectRuntime, projectRuntime, projectRuntimeEnvironment } from "./project-runtime";

function filesFromInstalledStarter(root: string, directory = root): ReturnType<typeof readStarterFiles> {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!publicStarterPath(relative) || (!entry.isDirectory() && !entry.isFile())) {
      throw new IncompatibleProjectError(`The installed starter contains an unsupported path at ${relative}.`);
    }
    return entry.isDirectory() ? filesFromInstalledStarter(root, file)
      : [{ relative, mode: lstatSync(file).mode & 0o777, bytes: readFileSync(file) }];
  });
}

function availableTarget(directory: string): "absent" | "empty" {
  try {
    if (lstatSync(directory).isDirectory() && readdirSync(directory).length === 0) return "empty";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  throw new IncompatibleProjectError(`Choose an empty or new project directory. ${directory} already contains files or is not a regular directory.`);
}

function rebaseWorkspaceLinks(staging: string, target: string, lockEntries: Record<string, { link?: boolean; resolved?: string }>): void {
  for (const [file, entry] of Object.entries(lockEntries)) {
    if (!entry.link) continue;
    const link = path.join(staging, file);
    const workspace = realpathSync(link);
    const relative = path.relative(staging, workspace);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        relative !== path.normalize(entry.resolved ?? "") || !lstatSync(workspace).isDirectory()) {
      throw new IncompatibleProjectError(`The new project's installed workspace link at ${file} leaves its locked workspace.`);
    }
    // npm writes relative links on POSIX and can write absolute junctions on NTFS.
    if (path.isAbsolute(readlinkSync(link))) {
      if (process.platform !== "win32") throw new IncompatibleProjectError(`The new project's workspace link at ${file} cannot be moved safely.`);
      unlinkSync(link);
      symlinkSync(path.join(target, relative), link, "junction");
    }
  }
}

/** Create from the installation's immutable public starter and publish only after npm ci and admission. */
export async function createStudioProject(directory: string, packageName?: string): Promise<string> {
  const requested = path.resolve(directory);
  const parent = realpathSync(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  const relative = path.relative(realpathSync(studioInstallation), target);
  if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new IncompatibleProjectError("Create the project outside the AWS Studio installation.");
  }
  availableTarget(target);
  const name = packageName ?? path.basename(target);
  const appId = newAppId();
  try { projectTargets({ app: name, appId, targets: {} }); }
  catch (error) { throw new IncompatibleProjectError(`${String(error)} Pass --name to choose a valid project and deployment name.`); }
  const starter = path.join(studioInstallation, "release/starter");
  let files: ReturnType<typeof readStarterFiles>;
  try { files = filesFromInstalledStarter(starter); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || (error as NodeJS.ErrnoException).path !== starter) throw error;
    files = readStarterFiles(readStarterSelection(studioInstallation));
  }
  const staging = mkdtempSync(path.join(parent, ".aws-studio-create-"));
  try {
    writeStarterFiles(staging, files);
    const manifestPath = path.join(staging, "package.json"), lockPath = path.join(staging, "package-lock.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    manifest.name = lock.name = lock.packages[""].name = name;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
    const cdkPath = path.join(staging, "cdk-app/cdk.json");
    const cdk = JSON.parse(readFileSync(cdkPath, "utf8"));
    cdk.context[APP_CONTEXT_KEY] = name;
    cdk.context[APP_ID_CONTEXT_KEY] = appId;
    // A newly created repository starts with no destination inherited from its starter.
    delete cdk.context[TARGETS_CONTEXT_KEY];
    writeFileSync(cdkPath, JSON.stringify(cdk, null, 2) + "\n");
    const runtime = await prepareProjectRuntime(staging, { installedFramework: false });
    const env = projectRuntimeEnvironment(runtime);
    for (const key of Object.keys(env)) {
      if (/^(?:npm_config_(?:workspace|workspaces|include_workspace_root|prefix|global)|INIT_CWD|FRAMEWORK_REPOSITORY_ROOT|FRAMEWORK_INPUTS_FILE)$/i.test(key)) delete env[key];
    }
    execFileSync(runtime.node, [runtime.npm, "ci", "--no-audit", "--no-fund"], { cwd: staging, env, stdio: ["ignore", 2, 2], windowsHide: true });
    resolveProjectInstallation(staging);
    projectRuntime(staging);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: staging, stdio: ["ignore", 2, 2], windowsHide: true });
    rebaseWorkspaceLinks(staging, target, lock.packages);
    if (availableTarget(target) === "empty") rmdirSync(target);
    renameSync(staging, target);
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

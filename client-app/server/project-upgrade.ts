import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readCIObservation } from "aws-studio/contract-chain/ci-observation";
import { dependencyContentIdentity } from "aws-studio/contract-chain/dependencies";
import { runtimeContractHash } from "aws-studio/contract-chain/evaluation";
import { EditError, sourceContents } from "aws-studio/source/io";
import { withSourceRead, ownsSourceGate, restrictedSourceEvaluationRequired } from "aws-studio/source/source-gate";
import { assertAgentSourcePath, prepareAgentWorkspace, readSourceManifest } from "aws-studio/source/workspace";
import { projectCliEntry } from "./project-cli";
import { runCommand } from "./deploy/process";
import { deploymentInputPath, inputText } from "./deployment-inputs";
import { assertProjectReleaseLock, readProjectRelease, releaseIsOlder, resolveProjectInstallation, studioInstallation, studioReleaseArchive, type ProjectRelease } from "./project-release";
import { projectRuntime, projectRuntimeEnvironment } from "./project-runtime";

const changeFiles = ["package.json", "package-lock.json"] as const;
const upgradeFiles = [...changeFiles, ".gitignore"] as const;
type Runtime = ReturnType<typeof projectRuntime>;
export interface UpgradeChange { readonly file: string; readonly before: string | null; readonly after: string | null }
interface ReviewArchive {
  readonly file: string;
  readonly source: string;
  readonly integrity: string;
  readonly alreadyPresent: boolean;
}

export interface ProjectInstallationReview {
  readonly source: string;
  readonly generated: string | null;
  readonly inputs: string;
  readonly dependencies: string;
  readonly candidateSource: string;
  readonly candidateDependencies: string;
  readonly runtime: Runtime;
  readonly release: ProjectRelease;
  readonly releaseIntegrity: string;
  readonly archive?: ReviewArchive;
}

export interface ProjectUpgrade extends ProjectInstallationReview {
  readonly previous: string;
  readonly version: string;
  readonly archive: ReviewArchive;
  readonly changes: readonly UpgradeChange[];
  readonly outcome: "verified" | "pending";
}

export function projectUpgradeFile(root: string, relative: string): string {
  if (!upgradeFiles.some(file => file === relative)) throw new EditError(422, "A release upgrade can write only the root package manifest, lockfile and framework archive ignore rule.");
  const file = path.join(realpathSync(root), relative);
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1) throw new EditError(422, `${relative} must be a regular project file.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return file;
}

export function upgradeArchivePath(root: string, relative: string): string {
  if (!/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*aws-studio-\d+\.\d+\.\d+\.tgz$/.test(relative)) throw new EditError(422, "The framework archive must use a versioned project-local filename.");
  const physical = realpathSync(root);
  let file = physical;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    try {
      const info = lstatSync(file);
      if (file === path.join(physical, relative) ? !info.isFile() : !info.isDirectory()) throw new EditError(422, `${relative} must be a regular project archive with no linked parents.`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return file;
}

export function archiveIntegrity(file: string): string | null {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new EditError(422, "The framework archive must be a regular npm tarball under 128 MiB.");
    return `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Bind the private inputs in memory without copying their values into the candidate or journal. */
function deploymentInputsDigest(root: string): string {
  const values = (["dev", "prod"] as const).map(mode => inputText(root, deploymentInputPath(mode)) ?? null);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function databaseArtifactsDigest(root: string): string | null {
  try { return runtimeContractHash(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function assertInstallationExecutionPolicy(root: string): void {
  if (restrictedSourceEvaluationRequired(root)) {
    throw new EditError(422, "This project requires restricted source execution. Reviewing dependency changes requires a qualified restricted npm installer.");
  }
}

export function assertCurrentProjectInstallation(root: string, review: ProjectInstallationReview): void {
  assertInstallationExecutionPolicy(root);
  if (readSourceManifest(root).digest !== review.source || databaseArtifactsDigest(root) !== review.generated) {
    throw new EditError(409, "Project source or generated files changed after installation review. Review the edit again.");
  }
  if (deploymentInputsDigest(root) !== review.inputs) throw new EditError(409, "Private deployment inputs changed after review. Review the installation again.");
  if (JSON.stringify(projectRuntime(root)) !== JSON.stringify(review.runtime)) throw new EditError(409, "The selected project Node or npm changed after review. Review the edit again.");
  const archive = review.archive;
  if (archive && (archiveIntegrity(archive.source) !== archive.integrity || archiveIntegrity(upgradeArchivePath(root, archive.file)) !== (archive.alreadyPresent ? archive.integrity : null))) {
    throw new EditError(409, "The reviewed framework archive changed. Review the edit against the current archive.");
  }
}

async function inCandidate<T>(root: string, use: (cwd: string, directory: string, baseline: string) => Promise<T>): Promise<T> {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-release-review-")));
  try {
    const capture = () => prepareAgentWorkspace(root, { storageDirectory: path.join(directory, "capture"), taskId: "project", copyDependencies: false });
    const workspace = await (ownsSourceGate(root) ? capture() : withSourceRead(root, capture));
    return await use(workspace.workingDirectory, directory, workspace.baseline.digest);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function applyCandidateEdits(root: string, cwd: string, changes: readonly UpgradeChange[]): void {
  for (const edit of changes) {
    const relative = path.relative(root, edit.file).split(path.sep).join("/");
    assertAgentSourcePath(relative);
    const file = path.join(cwd, relative);
    if (sourceContents(file) !== edit.before) throw new EditError(409, `${relative} changed during release capture. Review again.`);
    if (edit.after === null) rmSync(file, { force: true });
    else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, edit.after); }
  }
}

function candidateRunner(cwd: string, directory: string, runtime: Runtime) {
  const temporary = os.tmpdir();
  const windows = process.env.SystemRoot ?? process.env.WINDIR;
  const systemPaths = process.platform === "win32" ? (windows ? [path.join(windows, "System32"), windows] : []) : ["/usr/bin", "/bin"];
  // npm spawns its native default shell for lifecycle hooks. Preserve system
  // utilities while pinning Node and npm ahead of everything in the child PATH.
  const env = projectRuntimeEnvironment(runtime, { PATH: systemPaths.join(path.delimiter), HOME: directory, USERPROFILE: directory, TEMP: temporary, TMP: temporary, TMPDIR: temporary, AWS_EC2_METADATA_DISABLED: "true", TSX_DISABLE_CACHE: "1", CHECKPOINT_DISABLE: "1" });
  for (const name of ["SystemRoot", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
  if (process.platform === "win32") {
    env.APPDATA = path.join(directory, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(directory, "AppData", "Local");
    mkdirSync(env.APPDATA, { recursive: true });
    mkdirSync(path.join(env.LOCALAPPDATA, "Temp"), { recursive: true });
  }
  env.npm_config_cache = process.env.npm_config_cache ?? (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "npm-cache") : path.join(os.homedir(), ".npm"));
  env.npm_config_offline = "true";
  return (args: readonly string[], display: string) => runCommand({ file: runtime.node, args, cwd, env, display }, { timeoutMs: 15 * 60_000 });
}

function copyArchive(cwd: string, archive: ReviewArchive): void {
  const destination = upgradeArchivePath(cwd, archive.file);
  if (!archive.alreadyPresent) {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(archive.source), { flag: "wx" });
  }
  if (archiveIntegrity(destination) !== archive.integrity) throw new EditError(422, "The candidate framework archive does not match the release digest.");
}

/** Preserve the starter's exact archive exception when it ignores other npm tarballs. */
export function archiveTrackingChange(root: string, candidate: string, previous: string, next: string): (UpgradeChange & { readonly after: string }) | undefined {
  const file = projectUpgradeFile(root, ".gitignore");
  const destination = projectUpgradeFile(candidate, ".gitignore");
  const before = sourceContents(destination);
  if (before === null) return;
  const lines = before.split(/\r?\n/);
  const rule = lines.reverse().find(line => line === `!${previous}` || line === `!/${previous}`);
  if (!rule) return;
  const nextRule = rule.replace(previous, next);
  if (lines.includes(nextRule)) return;
  const newline = before.includes("\r\n") ? "\r\n" : "\n";
  const after = before + (before.endsWith("\n") ? "" : newline) + nextRule + newline;
  return { file, before, after };
}

function frameworkLockIntegrity(root: string): string {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const integrity = lock.packages?.["node_modules/aws-studio"]?.integrity;
  if (typeof integrity !== "string") throw new EditError(422, "The project lockfile must pin exact framework release bytes.");
  return integrity;
}

export function assertUpgradeRelease(root: string, version: string, archive: ReviewArchive): void {
  const next = resolveProjectInstallation(root).release;
  if (next.version !== version || next.spec !== `file:${archive.file}`) throw new EditError(422, "The project did not install the reviewed framework release.");
  if (frameworkLockIntegrity(root) !== archive.integrity || archiveIntegrity(upgradeArchivePath(root, archive.file)) !== archive.integrity) {
    throw new EditError(422, "The framework archive and lockfile must match the reviewed release digest.");
  }
}

const installFlags = ["--offline", "--no-audit", "--no-fund"] as const;
async function installCandidate(cwd: string, runtime: Runtime, run: ReturnType<typeof candidateRunner>, generated: string | null): Promise<void> {
  const source = readSourceManifest(cwd).digest;
  const installed = await run([runtime.npm, "ci", ...installFlags], "Install dependencies in the private upgrade candidate");
  if (installed.code !== 0) {
    const diagnostic = /^npm error code ([A-Z][A-Z0-9_]{0,39})$/m.exec(installed.stderr)?.[1];
    throw new EditError(422, `npm ci could not install the candidate offline${diagnostic ? ` (${diagnostic})` : ""}. Check the app runtime, offline cache and declared lifecycle scripts.`);
  }
  if (readSourceManifest(cwd).digest !== source) throw new EditError(422, "The project's installation lifecycle changed authored source. Review those changes in the application before trying the upgrade again.");
  if (databaseArtifactsDigest(cwd) !== generated) throw new EditError(422, "The installation changes generated database artifacts. Regenerate and review the affected application contract before attempting the upgrade.");
}

async function verifyCandidate(cwd: string, run: ReturnType<typeof candidateRunner>) {
  const result = await run([projectCliEntry(cwd), "verify", "--json"], "Verify the candidate with its installed framework release");
  let value: { readonly diagnostics?: unknown; readonly stages?: unknown } | undefined;
  try { value = JSON.parse(result.stdout); } catch { /* A startup failure may have no JSON. */ }
  const unavailable = () => {
    const diagnostics = [...(Array.isArray(value?.diagnostics) ? value.diagnostics : []), ...(Array.isArray(value?.stages) ? value.stages.flatMap((stage: { diagnostics?: unknown } | null) => Array.isArray(stage?.diagnostics) ? stage.diagnostics : []) : [])];
    const codes = [...new Set(diagnostics.map((item: { code?: unknown } | null) => item?.code).filter((code): code is string => typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)))].slice(0, 8);
    return new EditError(422, `Independent Contract Chain evidence was unavailable for the candidate. Verifier exit ${result.code ?? "unavailable"}${codes.length ? ` (${codes.join(", ")})` : ""}. Resolve the verifier issue before saving this release upgrade.`);
  };
  if (result.code !== 0 && result.code !== 1) throw unavailable();
  let report;
  try { report = readCIObservation(value); } catch { throw unavailable(); }
  if (report.outcome !== (result.code === 0 ? "verified" : "pending")) throw unavailable();
  const failed = report.stages.find((stage, index) => !stage.current || stage.checks.length !== (index === 3 ? 3 : 1) || stage.checks.some(check => check.outcome !== "passed") || stage.diagnostics.some(item => item.code === "REVIEW_RECORD_INVALID"));
  if (failed) throw new EditError(422, `The candidate failed independent Contract Chain verification at the ${failed.stage} stage. Resolve the application checks before saving this release upgrade.`);
  return report.outcome;
}

/** Prepares the new release before a feature planner or generator uses the candidate. */
export async function prepareProjectUpgrade<T = undefined>(
  root: string,
  prepare: readonly UpgradeChange[] | ((candidateRoot: string) => Promise<{ readonly changes: readonly UpgradeChange[]; readonly result: T }>),
  installation: string = studioInstallation,
): Promise<{ readonly upgrade: ProjectUpgrade; readonly result: T | undefined } | undefined> {
  if (!existsSync(path.join(root, "package.json")) || !readProjectRelease(root)) return;
  assertInstallationExecutionPolicy(root);
  const pin = resolveProjectInstallation(root).release;
  const supplied = studioReleaseArchive(installation);
  if (!releaseIsOlder(pin.version, supplied.version)) return;
  if (!pin.spec.startsWith("file:")) throw new EditError(422, "Reviewed framework upgrades require a project-local vendored framework pin.");
  const relative = pin.spec.slice(5).replace(/aws-studio-[\d.]+\.tgz$/, `aws-studio-${supplied.version}.tgz`);
  const archiveFile = upgradeArchivePath(root, relative), current = archiveIntegrity(archiveFile);
  if (current !== null && current !== supplied.integrity) throw new EditError(422, `${relative} contains different bytes. Preserve that archive and resolve the collision before upgrading.`);
  const archive: ReviewArchive = { file: relative, source: supplied.file, integrity: supplied.integrity, alreadyPresent: current !== null };
  const runtime = projectRuntime(root);
  if (supplied.engines) {
    const semver = createRequire(runtime.npm)("semver") as { satisfies(version: string, range: string): boolean };
    for (const [kind, version] of [["node", runtime.version], ["npm", runtime.npmVersion]] as const) {
      const range = supplied.engines[kind];
      if (!semver.satisfies(version, range)) throw new EditError(422, `Framework ${supplied.version} requires ${kind} ${range}. This project selects ${version}. Review a project toolchain migration before upgrading the framework.`);
    }
  }
  const generated = runtimeContractHash(root);
  const inputs = deploymentInputsDigest(root);
  const dependencies = await dependencyContentIdentity(root);
  return inCandidate(root, async (cwd, directory, source) => {
    const paths = changeFiles.map(name => projectUpgradeFile(root, name));
    const [manifest, lock] = changeFiles.map(name => path.join(cwd, name)) as [string, string];
    const previous = [readFileSync(manifest, "utf8"), readFileSync(lock, "utf8")];
    const prior = JSON.stringify(pin.spec);
    if (!previous[0]!.includes(prior) || previous[0]!.indexOf(prior) !== previous[0]!.lastIndexOf(prior)) throw new EditError(422, "The local framework pin must appear once in package.json.");
    copyArchive(cwd, archive);
    const tracking = archiveTrackingChange(root, cwd, pin.spec.slice(5), archive.file);
    if (tracking) writeFileSync(path.join(cwd, ".gitignore"), tracking.after);
    writeFileSync(manifest, previous[0]!.replace(prior, JSON.stringify(`file:${archive.file}`)));
    const run = candidateRunner(cwd, directory, runtime);
    const lockResult = await run([runtime.npm, "install", "--package-lock-only", "--ignore-scripts", ...installFlags], "Lock the target framework release in the private candidate");
    if (lockResult.code !== 0) throw new EditError(422, "npm could not lock the framework upgrade offline. Check the vendored archive and offline cache.");
    const next = readProjectRelease(cwd);
    if (!next || next.version !== supplied.version) throw new EditError(422, "npm did not select the reviewed framework release.");
    assertProjectReleaseLock(cwd, next);
    await installCandidate(cwd, runtime, run, generated);
    assertUpgradeRelease(cwd, supplied.version, archive);
    const prepared = typeof prepare === "function" ? await prepare(cwd) : { changes: prepare, result: undefined };
    applyCandidateEdits(root, cwd, prepared.changes);
    const selected = projectRuntime(cwd, { ...process.env, AWS_STUDIO_PROJECT_NODE: runtime.node }, { installedFramework: false });
    if (JSON.stringify(selected) !== JSON.stringify(runtime)) throw new EditError(422, "Review project Node and npm changes separately from this framework upgrade.");
    if (prepared.changes.some(edit => /(?:^|[\\/])package(?:-lock)?\.json$/.test(edit.file))) await installCandidate(cwd, runtime, run, generated);
    assertUpgradeRelease(cwd, supplied.version, archive);
    const candidateSource = readSourceManifest(cwd).digest;
    const candidateDependencies = await dependencyContentIdentity(cwd);
    const outcome = await verifyCandidate(cwd, run);
    if (readSourceManifest(cwd).digest !== candidateSource || databaseArtifactsDigest(cwd) !== generated || await dependencyContentIdentity(cwd) !== candidateDependencies) {
      throw new EditError(422, "Verification changed the candidate. Review a reproducible candidate before applying the upgrade.");
    }
    const changes = [manifest, lock].map((file, index): UpgradeChange => ({ file: paths[index]!, before: previous[index]!, after: readFileSync(file, "utf8") }));
    if (tracking) changes.push(tracking);
    const upgrade: ProjectUpgrade = {
      previous: pin.version, version: supplied.version, release: next, releaseIntegrity: archive.integrity, source, generated, inputs, dependencies, candidateSource, candidateDependencies, runtime, archive, outcome,
      changes,
    };
    assertCurrentProjectInstallation(root, upgrade);
    return { upgrade, result: prepared.result };
  });
}

/** An ordinary source change can add/remove a workspace without changing the framework. */
export async function prepareProjectDependencies(root: string, changes: readonly UpgradeChange[], validate: (candidate: string) => Promise<void>): Promise<ProjectInstallationReview> {
  assertInstallationExecutionPolicy(root);
  const release = resolveProjectInstallation(root).release;
  const releaseIntegrity = frameworkLockIntegrity(root);
  const runtime = projectRuntime(root);
  const generated = databaseArtifactsDigest(root);
  const inputs = deploymentInputsDigest(root);
  const dependencies = await dependencyContentIdentity(root);
  return inCandidate(root, async (cwd, directory, source) => {
    applyCandidateEdits(root, cwd, changes);
    const candidateSource = readSourceManifest(cwd).digest;
    const run = candidateRunner(cwd, directory, runtime);
    assertReviewedReleasePin(cwd, { release, releaseIntegrity });
    await installCandidate(cwd, runtime, run, generated);
    const candidateDependencies = await dependencyContentIdentity(cwd);
    const review = { source, generated, inputs, dependencies, candidateSource, candidateDependencies, runtime, release, releaseIntegrity };
    assertInstalledRelease(cwd, review);
    await validate(cwd);
    if (readSourceManifest(cwd).digest !== candidateSource || databaseArtifactsDigest(cwd) !== generated || await dependencyContentIdentity(cwd) !== candidateDependencies) {
      throw new EditError(422, "Validation changed the candidate. Review a reproducible dependency installation.");
    }
    assertCurrentProjectInstallation(root, review);
    return review;
  });
}

export async function assertCurrentProjectDependencies(root: string, review: ProjectInstallationReview): Promise<void> {
  if (await dependencyContentIdentity(root) !== review.dependencies) throw new EditError(409, "Installed dependencies changed after review. Review the current project again.");
}

function assertReviewedReleasePin(root: string, review: Pick<ProjectInstallationReview, "release" | "releaseIntegrity" | "archive">): void {
  const pin = readProjectRelease(root);
  if (!pin || pin.spec !== review.release.spec || pin.version !== review.release.version || pin.section !== review.release.section) {
    throw new EditError(422, "The candidate framework pin differs from the review.");
  }
  assertProjectReleaseLock(root, pin);
  if (frameworkLockIntegrity(root) !== review.releaseIntegrity ||
      review.archive && archiveIntegrity(upgradeArchivePath(root, review.archive.file)) !== review.archive.integrity) {
    throw new EditError(422, "The candidate framework bytes differ from the review.");
  }
}

function assertInstalledRelease(root: string, review: ProjectInstallationReview): void {
  assertReviewedReleasePin(root, review);
  resolveProjectInstallation(root);
}

/** Reproduce the approved installation without running lifecycle scripts in live source. */
export async function withReviewedProjectInstallation<T>(root: string, review: ProjectInstallationReview, changes: readonly UpgradeChange[], use: (candidate: string) => Promise<T>): Promise<T> {
  assertCurrentProjectInstallation(root, review);
  await assertCurrentProjectDependencies(root, review);
  return inCandidate(root, async (cwd, directory) => {
    if (review.archive) copyArchive(cwd, review.archive);
    applyCandidateEdits(root, cwd, changes);
    if (readSourceManifest(cwd).digest !== review.candidateSource) throw new EditError(409, "The installation candidate no longer reproduces the reviewed source.");
    assertReviewedReleasePin(cwd, review);
    await installCandidate(cwd, review.runtime, candidateRunner(cwd, directory, review.runtime), review.generated);
    assertInstalledRelease(cwd, review);
    if (await dependencyContentIdentity(cwd) !== review.candidateDependencies) throw new EditError(422, "Installing the reviewed lockfile did not reproduce its dependency tree.");
    assertCurrentProjectInstallation(root, review);
    return use(cwd);
  });
}

export async function assertActivatedProjectInstallation(root: string, review: ProjectInstallationReview): Promise<void> {
  assertInstalledRelease(root, review);
  if (readSourceManifest(root).digest !== review.candidateSource || databaseArtifactsDigest(root) !== review.generated || deploymentInputsDigest(root) !== review.inputs || await dependencyContentIdentity(root) !== review.candidateDependencies || JSON.stringify(projectRuntime(root)) !== JSON.stringify(review.runtime)) {
    throw new EditError(409, "The activated source, project runtime or installed dependencies differ from the review.");
  }
}

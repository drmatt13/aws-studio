import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, cpSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFileSync } from "aws-studio/cli/private-files";
import { EditError } from "aws-studio/source/io";
import { assertAgentSourcePath, dependencyRoots } from "aws-studio/source/workspace";
import { archiveIntegrity, upgradeArchivePath, type ProjectInstallationReview } from "../project-upgrade";

type Identity = { readonly device: string; readonly inode: string; readonly digest: string };
interface Mount { readonly file: string; readonly before: Identity | null; readonly after: Identity | null }
export interface InstallationJournal {
  readonly id: string;
  readonly trees: readonly Mount[];
  readonly archive?: { readonly file: string; readonly integrity: string; readonly staged: Identity };
}

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function compare(left: Identity | null, right: Identity | null): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function stat(file: string) {
  try { return lstatSync(file, { bigint: true }); }
  catch (error) { if (absent(error)) return null; throw error; }
}
/** Repeated moves and recovery checks bind physical file identities. The
 * reviewed and activated installations are independently checked by content. */
function fingerprint(directory: string): string {
  const digest = createHash("sha256");
  const visit = (file: string): void => {
    const name = path.relative(directory, file).split(path.sep).join("/");
    const info = stat(file);
    if (!info) throw new EditError(409, "Installed dependencies changed during activation.");
    const inode = [name, info.dev.toString(), info.ino.toString(), info.mode.toString()];
    // Moving a directory changes its own timestamps. A complete sorted entry
    // inventory plus directory identity works at either the live or backup path.
    if (info.isDirectory()) {
      digest.update(JSON.stringify(inode) + "\n");
      for (const entry of readdirSync(file).sort()) visit(path.join(file, entry));
      return;
    }
    if (!info.isFile() && !info.isSymbolicLink()) throw new EditError(422, "The dependency installation contains a special file.");
    const link = info.isSymbolicLink() ? readlinkSync(file) : null;
    const actual = stat(file);
    if (!actual || actual.dev !== info.dev || actual.ino !== info.ino || actual.ctimeNs !== info.ctimeNs || actual.mtimeNs !== info.mtimeNs || actual.size !== info.size) {
      throw new EditError(409, "An installed file changed during activation.");
    }
    // Read literal links so a displaced workspace link is comparable before
    // and after an atomic rename. At final paths its target is checked as well.
    digest.update(JSON.stringify([...inode, info.size.toString(), info.nlink.toString(), info.ctimeNs.toString(), info.mtimeNs.toString(), link]) + "\n");
  };
  visit(directory);
  return digest.digest("hex");
}

function identity(file: string, kind: "directory" | "archive"): Identity | null {
  const info = stat(file);
  if (!info) return null;
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new EditError(409, "A path in the reviewed installation was replaced.");
  const digest = kind === "directory" ? fingerprint(file) : archiveIntegrity(file)!;
  const after = stat(file);
  if (!after || after.ino !== info.ino || after.dev !== info.dev) throw new EditError(409, "The dependency installation changed during activation.");
  return { device: info.dev.toString(), inode: info.ino.toString(), digest };
}

function regularAncestors(root: string, file: string): void {
  let current = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = stat(current);
    if (info && !info.isDirectory()) throw new EditError(409, "An installation path has a linked or non-directory parent.");
  }
}
function dependencyPath(root: string, relative: string): string {
  if (relative !== "node_modules" && !relative.endsWith("/node_modules")) throw new EditError(422, "Invalid dependency recovery path.");
  const parent = relative.slice(0, -"node_modules".length).replace(/\/$/, "");
  if (parent) assertAgentSourcePath(parent);
  const file = path.join(root, relative);
  regularAncestors(root, file);
  return file;
}
function paths(root: string, plan: InstallationJournal) {
  const folder = path.join(root, ".cache/framework-studio/transactions", `installation-${plan.id}`);
  regularAncestors(root, path.join(folder, "archive"));
  return {
    folder, archive: path.join(folder, "archive"),
    mounts: plan.trees.map((tree, index) => ({
      ...tree, live: dependencyPath(root, tree.file),
      staged: path.join(folder, `new-${index}`), saved: path.join(folder, `previous-${index}`),
    })),
  };
}

function syncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(code) && !(process.platform === "win32" && ["EPERM", "EACCES"].includes(code))) throw error;
  }
}

export function validateInstallationJournal(plan: InstallationJournal): void {
  const validId = /^[a-f0-9-]{36}$/;
  const validIntegrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
  const valid = (value: Identity | null, isArchive = false) => value === null || typeof value === "object" && typeof value.device === "string" && /^\d+$/.test(value.device) && typeof value.inode === "string" && /^\d+$/.test(value.inode) && (isArchive ? validIntegrity : /^[a-f0-9]{64}$/).test(value.digest);
  if (!plan || typeof plan !== "object" || !validId.test(plan.id) || !Array.isArray(plan.trees) || plan.trees.length === 0
      || new Set(plan.trees.map(tree => tree.file)).size !== plan.trees.length
      || plan.trees.some(tree => typeof tree.file !== "string" || !valid(tree.before) || !valid(tree.after) || !tree.before && !tree.after)
      || plan.archive && (typeof plan.archive.file !== "string" || !validIntegrity.test(plan.archive.integrity) || !plan.archive.staged || !valid(plan.archive.staged, true) || plan.archive.staged.digest !== plan.archive.integrity)) {
    throw new EditError(422, "This dependency installation recovery record is invalid.");
  }
}

/** Stage on the project's filesystem so each live tree can be activated by rename. */
export function stageInstallation(root: string, candidate: string, review: Pick<ProjectInstallationReview, "archive">): InstallationJournal {
  root = realpathSync(root);
  const id = randomUUID();
  const directory = path.join(root, ".cache/framework-studio/transactions", `installation-${id}`);
  ensurePrivateDirectory(directory);
  const list = (base: string) => dependencyRoots(base).map(file => path.relative(base, file).split(path.sep).join("/")).filter(file => file === "node_modules" || file.endsWith("/node_modules"));
  try {
    const prior = new Set(list(root)), next = new Set(list(candidate));
    const trees = [...new Set([...prior, ...next])].sort().map((file, index): Mount => {
      const live = dependencyPath(root, file), source = dependencyPath(candidate, file);
      const before = identity(live, "directory");
      const staged = path.join(directory, `new-${index}`);
      if (next.has(file)) {
        // npm's POSIX links are relative. Windows npm workspace junctions
        // point at an absolute directory and must be rebound to the final root.
        const junctions: { source: string; target: string }[] = [];
        const check = (entry: string, destination: string): boolean => {
          if (!lstatSync(entry).isSymbolicLink() || !path.isAbsolute(readlinkSync(entry))) return true;
          const target = realpathSync(entry), relative = path.relative(candidate, target);
          if (process.platform !== "win32" || !relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || !lstatSync(target).isDirectory()) {
            throw new EditError(422, "This dependency installation uses an absolute link outside the supported local workspace layout.");
          }
          junctions.push({ source: destination, target: path.join(root, relative) });
          return false;
        };
        cpSync(source, staged, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, errorOnExist: true, force: false, filter: check });
        for (const junction of junctions) symlinkSync(junction.target, junction.source, "junction");
      }
      const after = identity(staged, "directory");
      if (after && stat(path.dirname(live)) && stat(path.dirname(live))!.dev.toString() !== after.device) throw new EditError(422, "The project has workspaces on another filesystem. A recoverable activation requires them on the project filesystem.");
      return { file, before, after };
    });
    let archive: InstallationJournal["archive"];
    if (review.archive && !review.archive.alreadyPresent) {
      const staged = path.join(directory, "archive");
      const source = upgradeArchivePath(candidate, review.archive.file);
      writePrivateFileSync(staged, readFileSync(source));
      if (process.platform !== "win32") chmodSync(staged, lstatSync(source).mode & 0o777);
      archive = { file: review.archive.file, integrity: review.archive.integrity, staged: identity(staged, "archive")! };
      if (archive.staged.digest !== archive.integrity) throw new EditError(409, "Staged framework archive does not match the approved digest.");
    }
    syncDirectory(directory);
    return { id, trees, ...(archive ? { archive } : {}) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function activateInstallation(root: string, plan: InstallationJournal): void {
  const locations = paths(root, plan);
  if (plan.archive) {
    const live = upgradeArchivePath(root, plan.archive.file);
    if (!compare(identity(locations.archive, "archive"), plan.archive.staged) || identity(live, "archive")) throw new EditError(409, "The framework archive changed during apply.");
    // A hard link publishes all bytes exclusively. There is no crash window
    // in which a partial write could be mistaken for a later developer edit.
    linkSync(locations.archive, live);
    unlinkSync(locations.archive);
    syncDirectory(path.dirname(live));
  }
  for (const tree of locations.mounts) {
    if (!compare(identity(tree.live, "directory"), tree.before) || !compare(identity(tree.staged, "directory"), tree.after) || identity(tree.saved, "directory")) {
      throw new EditError(409, `${tree.file} changed during activation. Its current contents were preserved.`);
    }
    if (tree.before) renameSync(tree.live, tree.saved);
    if (tree.after) {
      const parent = path.dirname(tree.live);
      regularAncestors(root, tree.live);
      if (!stat(parent)) mkdirSync(parent, { recursive: true });
      if (stat(tree.live)) throw new EditError(409, `${tree.file} was created by another installer during activation.`);
      renameSync(tree.staged, tree.live);
    }
    syncDirectory(path.dirname(tree.live));
    syncDirectory(locations.folder);
  }
}

export function installationRecovery(root: string, plan: InstallationJournal): readonly { file: string; state: "original" | "written" | "conflicted"; fingerprint: unknown }[] {
  const locations = paths(root, plan);
  const files = locations.mounts.map(tree => {
    try {
      const live = identity(tree.live, "directory"), saved = identity(tree.saved, "directory"), staged = identity(tree.staged, "directory");
      const hasBackup = compare(saved, tree.before);
      const original = compare(live, tree.before) && saved === null;
      const written = hasBackup && (compare(live, tree.after) && staged === null || live === null && compare(staged, tree.after));
      return { file: tree.file, state: original ? "original" as const : written ? "written" as const : "conflicted" as const, fingerprint: [live, saved, staged] };
    } catch { return { file: tree.file, state: "conflicted" as const, fingerprint: null }; }
  });
  if (plan.archive) {
    const { file, staged } = plan.archive;
    try {
      const live = identity(upgradeArchivePath(root, file), "archive");
      files.push({ file, state: live === null ? "original" : compare(live, staged) ? "written" : "conflicted", fingerprint: [live, null, null] });
    } catch { files.push({ file, state: "conflicted", fingerprint: null }); }
  }
  return files;
}

/** Restore only the exact trees and archive this operation owns. Unknown private or live state remains available for recovery. */
export function restoreInstallation(root: string, plan: InstallationJournal): boolean {
  const locations = paths(root, plan);
  let conflict = false;
  for (const tree of [...locations.mounts].reverse()) {
    try {
      const live = identity(tree.live, "directory"), saved = identity(tree.saved, "directory"), staged = identity(tree.staged, "directory");
      if (compare(live, tree.before) && saved === null) continue;
      if (!compare(saved, tree.before) || live !== null && (!compare(live, tree.after) || staged !== null)) { conflict = true; continue; }
      // Move the approved tree back into private storage before restoring the
      // previous tree. Recovery can resume if interrupted between the renames.
      if (live !== null) renameSync(tree.live, tree.staged);
      if (saved !== null) {
        if (stat(tree.live)) { conflict = true; continue; }
        renameSync(tree.saved, tree.live);
      }
      syncDirectory(path.dirname(tree.live));
      syncDirectory(locations.folder);
    } catch { conflict = true; }
  }
  if (plan.archive) {
    try {
      const live = upgradeArchivePath(root, plan.archive.file), observed = identity(live, "archive");
      if (compare(observed, plan.archive.staged)) { unlinkSync(live); syncDirectory(path.dirname(live)); }
      else if (observed !== null) conflict = true;
    } catch { conflict = true; }
  }
  return !conflict;
}

export function finishInstallation(root: string, plan: InstallationJournal, status: "complete" | "restored"): void {
  const locations = paths(root, plan);
  for (const tree of locations.mounts) {
    const file = status === "complete" ? tree.saved : tree.staged;
    const expected = status === "complete" ? tree.before : tree.after;
    const actual = identity(file, "directory");
    if (actual && compare(actual, expected)) rmSync(file, { recursive: true });
  }
  if (plan.archive && compare(identity(locations.archive, "archive"), plan.archive.staged)) unlinkSync(locations.archive);
  try { rmdirSync(locations.folder); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}

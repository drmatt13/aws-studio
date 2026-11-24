import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertWindowsPrivatePaths, ensureWindowsPrivateDirectory, restrictWindowsOwnedPath } from "./windows-security";

/** Only for app-owned private state directories, never a checkout or user-selected parent. */
export function ensurePrivateDirectory(directory: string): void {
  assertDirectoryPath(directory);
  const existed = existsSync(directory);
  if (process.platform === "win32" && !existed) ensureWindowsPrivateDirectory(directory);
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Private state must use a regular directory.");
  if (process.platform === "win32") { if (existed) restrictWindowsOwnedPath(directory); }
  else {
    if (stat.uid !== process.getuid?.()) throw new Error("Private state must belong to the current user.");
    chmodSync(directory, 0o700);
  }
}

function assertDirectoryPath(directory: string): void {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Private state cannot use linked or non-directory parents.");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function samePathIdentity(file: string, identity: Stats): boolean {
  try {
    const stat = lstatSync(file);
    return !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch { return false; }
}

/** Exclusively create a private inode before its public pathname is visible. */
export function openPrivateFileSync(file: string): number {
  assertDirectoryPath(path.dirname(file));
  if (process.platform !== "win32") return openSync(file, "wx", 0o600);
  const parent = path.dirname(path.resolve(file)), parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Private files must use a regular parent directory.");
  // Always create in a new protected child. A previously checked parent's DACL
  // may have changed without changing its identity.
  const staging = path.join(parent, `.aws-studio-private-${randomUUID()}`), staged = path.join(staging, "record");
  let directoryIdentity: Stats | undefined, created: Stats | undefined, fd: number | undefined, published = false;
  try {
    ensureWindowsPrivateDirectory(staging);
    const directory = lstatSync(staging);
    fd = openSync(staged, "wx", 0o600);
    created = fstatSync(fd);
    // Reject replacement or shared inheritance before publishing or writing.
    // Repairing the ACL now could leave another user's earlier handle readable.
    assertWindowsPrivatePaths([staging, staged]);
    if (!samePathIdentity(staging, directory) || !samePathIdentity(staged, created)) throw new Error("Private staging file changed identity.");
    directoryIdentity = directory;
    // A hard link publishes the already-private inode exclusively on the same
    // volume. Another user never gets a handle before its DACL is private.
    linkSync(staged, file);
    published = true;
    if (!samePathIdentity(staging, directoryIdentity) || !samePathIdentity(staged, created) || !samePathIdentity(file, created)) throw new Error("Private file changed identity during publication.");
    unlinkSync(staged);
    const result = fd; fd = undefined;
    return result;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (published && created && samePathIdentity(file, created)) try { unlinkSync(file); } catch { /* Preserve unknown paths. */ }
    throw error;
  } finally {
    if (created && samePathIdentity(staged, created)) try { unlinkSync(staged); } catch { /* Retain private staging on cleanup failure. */ }
    if (directoryIdentity && samePathIdentity(staging, directoryIdentity)) try { rmdirSync(staging); } catch { /* Remove only the empty child we created. */ }
  }
}

/** A fresh private file group; its authority ends at creation except for disposal. */
export function createPrivateDirectorySync(prefix: string, files: Readonly<Record<string, string | Buffer>>): { readonly directory: string; dispose(): void } {
  const entries = Object.entries(files);
  if (entries.some(([name]) => !name || name === "." || name === ".." || /[\\/:\0]/.test(name))) throw new Error("Private file groups require plain filenames.");
  assertDirectoryPath(path.dirname(prefix));
  // Windows must install the DACL at birth, before another user can open a
  // directory handle. Repairing a broadly created mkdtemp directory is too late.
  const directory = process.platform === "win32" ? `${prefix}${randomUUID().replaceAll("-", "")}` : mkdtempSync(prefix);
  let identity: Stats | undefined, disposed = false;
  const dispose = (): void => {
    if (disposed || !identity) return;
    try { lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { disposed = true; return; } throw error; }
    if (!samePathIdentity(directory, identity)) throw new Error("Private directory changed identity. Preserve the replacement for inspection.");
    rmSync(directory, { recursive: true });
    disposed = true;
  };
  try {
    if (process.platform === "win32") {
      if (existsSync(directory)) throw new Error("Private directory already exists.");
      ensureWindowsPrivateDirectory(directory);
    }
    const createdDirectory = lstatSync(directory);
    if (!createdDirectory.isDirectory() || createdDirectory.isSymbolicLink() || process.platform !== "win32" && (createdDirectory.uid !== process.getuid?.() || createdDirectory.mode & 0o077)) throw new Error("Private directory must belong exclusively to this user.");
    if (process.platform === "win32") assertWindowsPrivatePaths([directory]);
    if (!samePathIdentity(directory, createdDirectory) || readdirSync(directory).length) throw new Error("Private file groups require a fresh empty directory.");
    // Cleanup authority starts only after the new directory is verified.
    identity = createdDirectory;
    for (const [name, bytes] of entries) {
      if (!samePathIdentity(directory, identity)) throw new Error("Private directory changed during creation.");
      const file = path.join(directory, name), fd = openSync(file, "wx", 0o600);
      try {
        const created = fstatSync(fd);
        if (!samePathIdentity(directory, identity) || !created.isFile() || created.nlink !== 1 || !samePathIdentity(file, created)) throw new Error("Private file changed during creation.");
        writeFileSync(fd, bytes); fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    if (!samePathIdentity(directory, identity)) throw new Error("Private directory changed during creation.");
    return { directory, dispose };
  } catch (error) {
    try { dispose(); } catch { /* Preserve paths whose identity is no longer ours. */ }
    throw error;
  }
}

export function writePrivateFileSync(file: string, bytes: string | Buffer): void {
  const fd = openPrivateFileSync(file);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}

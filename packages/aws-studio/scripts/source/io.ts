import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withSourceWriteSync } from "./source-gate";
import { applyWindowsSecurityDescriptor, assertWindowsOwnedPath, captureWindowsSecurityDescriptor } from "../../cli/windows-security";
import { writePrivateFileSync } from "../../cli/private-files";
import { EditError } from "./errors";
export { EditError } from "./errors";

/** Private scratch for atomic writes inside a project; the name predates the framework owning it. */
export const SOURCE_SCRATCH = path.join(".cache", "framework-studio");

/** null means absence, distinct from an existing empty file. */
export function sourceContents(file: string): string | null {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/**
 * Checks every source write against ownership before it reaches disk, whichever Studio
 * writer produced it. The server installs it once a snapshot exists (see server.ts); it
 * throws to refuse. Before the first snapshot nothing is installed: no structured editor
 * can plan without one, and recovery must still be able to restore files.
 */
type SourceWriteGuard = (root: string, file: string, before: string | null, after: string | null) => void;
let sourceWriteGuard: SourceWriteGuard | undefined;
export function installSourceWriteGuard(guard: SourceWriteGuard | undefined): () => void {
  const previous = sourceWriteGuard;
  sourceWriteGuard = guard;
  return () => { sourceWriteGuard = previous; };
}

export interface SourceWriteOptions {
  /** Restoring exact recorded bytes after a failed or interrupted write. Not a new edit, so not re-checked. */
  readonly restoring?: boolean;
}

/** A new file is linked exclusively, so another editor's new file wins. */
export function writeSourceChange(root: string, file: string, before: string | null, after: string | null, options: SourceWriteOptions = {}): void {
  if (!options.restoring) sourceWriteGuard?.(root, file, before, after);
  return withSourceWriteSync(root, () => writeSourceChangeOwned(root, file, before, after));
}
function writeSourceChangeOwned(root: string, file: string, before: string | null, after: string | null): void {
  if (sourceContents(file) !== before) throw new EditError(409, "A source file changed while applying the draft.");
  if (after === null) { unlinkSync(file); return; }
  if (before !== null) { writeAtomicallyOwned(root, file, after, before); return; }
  mkdirSync(path.dirname(file), { recursive: true });
  const directory = path.join(root, SOURCE_SCRATCH, "tmp");
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `create-${randomUUID()}.tmp`);
  writeFileSync(temporary, after, { flag: "wx" });
  try { linkSync(temporary, file); }
  finally { unlinkSync(temporary); }
}


/** Replaces a file by renaming a sibling written outside the watched tree. */
export function writeAtomically(repositoryRoot: string, file: string, text: string, options: SourceWriteOptions = {}): void {
  if (!options.restoring) sourceWriteGuard?.(repositoryRoot, file, sourceContents(file), text);
  return withSourceWriteSync(repositoryRoot, () => writeAtomicallyOwned(repositoryRoot, file, text));
}
function writeAtomicallyOwned(repositoryRoot: string, file: string, text: string, expected = sourceContents(file)): void {
  const original = lstatSync(file);
  if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || process.platform !== "win32" && original.uid !== process.getuid?.()) throw new EditError(422, "Source replacement requires a regular unlinked file owned by this user.");
  if (process.platform === "win32") assertWindowsOwnedPath(file, true);
  const windowsSecurity = process.platform === "win32" ? captureWindowsSecurityDescriptor(file) : undefined;
  const directory = path.join(repositoryRoot, SOURCE_SCRATCH, "tmp");
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writePrivateFileSync(temporary, text);
    if (windowsSecurity) applyWindowsSecurityDescriptor(temporary, windowsSecurity);
    else { chownSync(temporary, original.uid, original.gid); chmodSync(temporary, original.mode); }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const current = lstatSync(file);
        if (current.isSymbolicLink() || current.nlink !== 1 || current.dev !== original.dev || current.ino !== original.ino || current.mode !== original.mode || current.uid !== original.uid || current.gid !== original.gid || sourceContents(file) !== expected) throw new EditError(409, "A source file changed while applying the draft.");
        renameSync(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An editor or virus scanner holding the file open on Windows.
        if (attempt >= 9 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}


import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  ensurePrivateDirectory,
  openPrivateFileSync,
  writePrivateFileSync,
} from "../../../cli/private-files";
import { assertWindowsPrivatePath } from "../../../cli/windows-security";

export function developmentLogRepositoryKey(root: string): string {
  let resolved = path.resolve(root);
  try {
    resolved = realpathSync(root);
  } catch {
    /* New disposable fixture. */
  }
  return createHash("sha256").update(resolved).digest("hex").slice(0, 24);
}
export function developmentLogCacheDirectory(
  root: string,
  project: string,
): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(project))
    throw new Error("Invalid development log project.");
  let canonicalRoot = path.resolve(root);
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    /* New disposable fixture. */
  }
  return path.join(
    canonicalRoot,
    ".cache",
    "framework-development-logs",
    developmentLogRepositoryKey(root),
    project,
  );
}
export async function assertLogDirectory(
  directory: string,
  create = false,
): Promise<void> {
  let current = path.resolve(directory);
  const ancestors: string[] = [];
  for (;;) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const item of ancestors.reverse()) {
    try {
      const info = await lstat(item);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Development log storage must not use links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw error;
      await mkdir(item, { mode: 0o700 });
    }
  }
  if (create) ensurePrivateDirectory(directory);
  else {
    const info = await lstat(directory);
    if (process.platform === "win32") assertWindowsPrivatePath(directory);
    else if (info.uid !== process.getuid?.() || info.mode & 0o077)
      throw new Error(
        "Development log directory must be private to the current user.",
      );
  }
}
export async function assertLogFile(file: string, maxBytes: number) {
  await assertLogDirectory(path.dirname(file));
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maxBytes
  )
    throw new Error("Invalid development log file.");
  if (process.platform === "win32") assertWindowsPrivatePath(file);
  else if (info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error(
      "Development log file must be private to the current user.",
    );
  return info;
}
export async function readLogFile(
  file: string,
  maxBytes: number,
  committedBytes?: number,
): Promise<string> {
  const info = await assertLogFile(file, maxBytes);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > maxBytes ||
      (committedBytes !== undefined &&
        (!Number.isSafeInteger(committedBytes) ||
          committedBytes < 0 ||
          committedBytes > opened.size))
    )
      throw new Error("Development log file changed.");
    const buffer = Buffer.alloc(
      Math.min(maxBytes, committedBytes ?? opened.size),
    );
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!result.bytesRead)
        throw new Error("Development log read was incomplete.");
      length += result.bytesRead;
    }
    const named = await lstat(file);
    if (
      named.ino !== info.ino ||
      named.dev !== info.dev ||
      named.isSymbolicLink() ||
      named.nlink !== 1
    )
      throw new Error("Development log path changed.");
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function writeLogJson(
  file: string,
  value: unknown,
): Promise<void> {
  await assertLogDirectory(path.dirname(file));
  try {
    await assertLogFile(file, 16 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new Error("Development log metadata exceeds its byte limit.");
  writePrivateFileSync(temporary, text);
  const identity = await assertLogFile(temporary, 16 * 1024 * 1024);
  try {
    await rename(temporary, file);
    const published = await assertLogFile(file, 16 * 1024 * 1024);
    if (published.dev !== identity.dev || published.ino !== identity.ino)
      throw new Error("Development log metadata changed during publication.");
    if (process.platform !== "win32") {
      const parent = await open(path.dirname(file), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** A native lock, separate from evidence: SQLite releases it automatically after process death. */
export async function acquireDevelopmentLogWriter(
  directory: string,
): Promise<{ assertOwned(): Promise<void>; close(): void }> {
  await assertLogDirectory(directory, true);
  const file = path.join(directory, "writer.sqlite");
  try {
    closeSync(openPrivateFileSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = await assertLogFile(file, 64 * 1024);
  const database = new DatabaseSync(file);
  let closed = false;
  const assertOwned = async () => {
    if (closed) throw new Error("Development log writer is closed.");
    const current = await assertLogFile(file, 64 * 1024);
    if (current.ino !== identity.ino || current.dev !== identity.dev)
      throw new Error("Development log writer lock changed identity.");
  };
  try {
    database.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;",
    );
    await assertOwned();
  } catch {
    database.close();
    throw new Error(
      "Another development log writer owns this cache, or its native lock is unavailable.",
    );
  }
  return {
    assertOwned,
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

/** Exclusive creation with POSIX/Windows privacy established before any record bytes. */
export function createLogFile(file: string): void {
  closeSync(openPrivateFileSync(file));
}

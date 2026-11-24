import assert from "./support/assert";
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertWritable } from "../server/files";
import { writeSourceChange } from "aws-studio/source/io";
import { SourceJournal } from "../server/edits/journal";
import { applyWindowsSecurityDescriptor, captureWindowsSecurityDescriptor } from "aws-studio/cli/windows-security";

test("source replacement preserves permissions and guards absence, empty bytes and later edits", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-source-safety-"));
  const file = path.join(root, "framework.config.ts");
  try {
    writeFileSync(file, "original\n"); chmodSync(file, 0o640);
    const original = statSync(file), mode = original.mode & 0o777;
    writeSourceChange(root, file, "original\n", "reviewed\n");
    assert.equal(readFileSync(file, "utf8"), "reviewed\n");
    if (process.platform !== "win32") {
      const current = statSync(file);
      assert.equal(current.mode & 0o777, mode);
      assert.equal(current.uid, original.uid);
      assert.equal(current.gid, original.gid);
    }
    writeFileSync(file, "external\n");
    assert.throws(() => writeSourceChange(root, file, "reviewed\n", "overwrite\n"), /changed/);
    assert.equal(readFileSync(file, "utf8"), "external\n");
    writeFileSync(file, "");
    assert.throws(() => writeSourceChange(root, file, null, "overwrite empty\n"), /changed/);
    writeSourceChange(root, file, "", "restored\n");
    assert.equal(readFileSync(file, "utf8"), "restored\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows separators stay within source authority while traversals and linked parents are rejected", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-path-safety-"));
  const config = path.join(root, "framework-config");
  mkdirSync(path.join(config, "nested"), { recursive: true });
  writeFileSync(path.join(config, "nested", "settings.ts"), "export {};\n");
  writeFileSync(path.join(root, "outside.ts"), "private source\n");
  try {
    assert.equal(assertWritable(root, "framework-config\\nested\\settings.ts"), path.join(config, "nested", "settings.ts"));
    for (const file of ["framework-config\\..\\outside.ts", "framework-config/../outside.ts", "C:\\outside.ts", "\\\\host\\share\\source.ts", "/framework-config/nested/settings.ts"])
      assert.throws(() => assertWritable(root, file));
    symlinkSync(root, path.join(config, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => assertWritable(root, "framework-config/linked/outside.ts"), /symbolic link/);
    assert.throws(() => new SourceJournal(root).begin("Unsafe linked source", [{ file: path.join(config, "linked", "outside.ts"), before: "private source\n", after: "overwrite\n" }]), /symbolic/i);
    assert.equal(readFileSync(path.join(root, "outside.ts"), "utf8"), "private source\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source replacement preserves a native Windows DACL through apply and rollback", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-source-acl-")), file = path.join(root, "framework.config.ts");
  try {
    writeFileSync(file, "original\n");
    const descriptor = captureWindowsSecurityDescriptor(file);
    // A non-inherited, read-only Everyone ACE distinguishes the source DACL
    // from the temporary file's private permissions.
    applyWindowsSecurityDescriptor(file, `${descriptor}(A;;FR;;;WD)`);
    const stable = (value: string) => value.replace(/D:([A-Z]*)/, (_match, flags: string) => `D:${flags.replace("AI", "")}`);
    const expected = stable(captureWindowsSecurityDescriptor(file));
    writeSourceChange(root, file, "original\n", "reviewed\n");
    assert.equal(stable(captureWindowsSecurityDescriptor(file)), expected);
    writeSourceChange(root, file, "reviewed\n", "original\n");
    assert.equal(stable(captureWindowsSecurityDescriptor(file)), expected);
    assert.equal(readFileSync(file, "utf8"), "original\n");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("source replacement preserves a concurrent edit made while preparing its temporary file", context => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-source-race-")), file = path.join(root, "framework.config.ts");
  writeFileSync(file, "original\n");
  const write = fs.writeFileSync;
  let changed = false;
  context.mock.method(fs, "writeFileSync", ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const result = (write as (...values: unknown[]) => void)(target, ...args);
    if (typeof target === "number" && !changed) { changed = true; write(file, "external edit\n"); }
    return result;
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeSourceChange(root, file, "original\n", "reviewed\n"), /changed while applying/);
    assert.equal(changed, true);
    assert.equal(readFileSync(file, "utf8"), "external edit\n");
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("source replacement refuses hard links without changing either name", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-source-link-")), file = path.join(root, "framework.config.ts"), alias = path.join(root, "alias.ts");
  try {
    writeFileSync(file, "original\n"); linkSync(file, alias);
    assert.throws(() => writeSourceChange(root, file, "original\n", "reviewed\n"), /regular unlinked file/);
    assert.equal(readFileSync(file, "utf8"), "original\n");
    assert.equal(readFileSync(alias, "utf8"), "original\n");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

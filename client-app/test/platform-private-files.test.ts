import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { ensurePrivateDirectory, writePrivateFileSync } from "aws-studio/cli/private-files";
import { assertWindowsPrivatePath } from "aws-studio/cli/windows-security";
import { spawnWindowsJob } from "aws-studio/cli/owned-process.cjs";

const parent = path.resolve(__dirname, "../../.cache/framework-studio/private-files-tests");
mkdirSync(parent, { recursive: true });

test("private state files use the host's permissions and exclusive creation", () => {
  const root = realpathSync(mkdtempSync(path.join(parent, "case-")));
  try {
    const directory = path.join(root, "private"), file = path.join(directory, "record.json");
    ensurePrivateDirectory(directory);
    writePrivateFileSync(file, "private fixture bytes");
    assert.equal(readFileSync(file, "utf8"), "private fixture bytes");
    if (process.platform === "win32") { assertWindowsPrivatePath(directory); assertWindowsPrivatePath(file); }
    else { assert.equal(lstatSync(directory).mode & 0o777, 0o700); assert.equal(lstatSync(file).mode & 0o777, 0o600); }
    assert.throws(() => writePrivateFileSync(file, "unreviewed replacement"), { code: "EEXIST" });
    assert.equal(readFileSync(file, "utf8"), "private fixture bytes");
  } finally {
    if (path.dirname(root) !== realpathSync(parent)) throw new Error("Private file fixture escaped its test directory.");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Windows files in shared parents are private before their public name exists", { skip: process.platform !== "win32" }, context => {
  const root = realpathSync(mkdtempSync(path.join(parent, "shared-parent-"))), file = path.join(root, "private.env");
  const link = fs.linkSync;
  let publications = 0;
  context.mock.method(fs, "linkSync", ((source: fs.PathLike, target: fs.PathLike) => {
    assert.equal(String(target), file);
    if (!publications) assert.equal(existsSync(file), false);
    assert.equal(lstatSync(source).nlink, 1);
    assertWindowsPrivatePath(String(source));
    assertWindowsPrivatePath(path.dirname(String(source)));
    assert.equal(lstatSync(source).size, 0, "no private bytes precede native permission verification");
    publications++;
    return link(source, target);
  }) as typeof fs.linkSync);
  syncBuiltinESMExports();
  try {
    writePrivateFileSync(file, "private fixture bytes");
    assert.equal(publications, 1);
    assertWindowsPrivatePath(file);
    assert.equal(lstatSync(file).nlink, 1);
    assert.deepEqual(readdirSync(root), ["private.env"], "the empty staging child and alias are removed");
    assert.equal(readFileSync(file, "utf8"), "private fixture bytes");
    assert.throws(() => writePrivateFileSync(file, "replacement"), { code: "EEXIST" });
    assert.equal(readFileSync(file, "utf8"), "private fixture bytes");
    assert.deepEqual(readdirSync(root), ["private.env"]);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    if (path.dirname(root) !== realpathSync(parent)) throw new Error("Private file fixture escaped its test directory.");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("private files remain private after an earlier parent's DACL changes", { skip: process.platform !== "win32" }, () => {
  const root = realpathSync(mkdtempSync(path.join(parent, "changed-acl-"))), directory = path.join(root, "private"), file = path.join(directory, "record");
  try {
    ensurePrivateDirectory(directory);
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const literal = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; $directory = ${literal(directory)}; $acl = [IO.Directory]::GetAccessControl($directory); $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); [IO.Directory]::SetAccessControl($directory, $acl)`], { windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => assertWindowsPrivatePath(directory), /filesystem permissions/);
    writePrivateFileSync(file, "private after ACL change");
    assertWindowsPrivatePath(file);
    ensurePrivateDirectory(directory);
    assertWindowsPrivatePath(directory);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("private state rejects linked parents and Unix initialization repairs a shared mode", () => {
  const root = realpathSync(mkdtempSync(path.join(parent, "linked-parent-"))), directory = path.join(root, "private");
  try {
    mkdirSync(directory);
    const link = path.join(root, "linked"); symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => ensurePrivateDirectory(path.join(link, "child")), /linked/);
    assert.throws(() => writePrivateFileSync(path.join(link, "record"), "must not appear"), /linked/);
    assert.deepEqual(readdirSync(directory), []);
    if (process.platform !== "win32") {
      chmodSync(directory, 0o755);
      ensurePrivateDirectory(directory);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("Windows locked Unicode-directory deletion returns a catchable error without terminating Node", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(path.join(parent, "locked-\u00e9-\u0394-"))), file = path.join(root, "record");
  fs.writeFileSync(file, "disposable fixture");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const lock = spawnWindowsJob(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$stream=[IO.File]::Open($env:STUDIO_TEST_LOCK_PATH,'Open','ReadWrite','None');try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();[void][Console]::In.ReadLine()}finally{$stream.Dispose()}"],
  { env: { ...process.env, STUDIO_TEST_LOCK_PATH: file }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolve => lock.once("close", resolve));
  let output = "", error = "";
  lock.stdout!.on("data", chunk => { output += chunk; }); lock.stderr!.on("data", chunk => { error += chunk; });
  try {
    for (let attempt = 0; attempt < 150 && !output.includes("LOCKED") && lock.exitCode === null && lock.signalCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /LOCKED/, error);
    // Keep a broken runtime's native fast-fail inside this disposable child.
    const probe = "try{require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:3,retryDelay:10});process.exitCode=2}catch(error){if(!['EPERM','EBUSY'].includes(error.code))throw error;console.log('caught '+error.code)}";
    const result = spawnSync(process.execPath, ["-e", probe, root], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || "The runtime must report a catchable busy-file error for Unicode paths.");
    assert.match(result.stdout, /caught (EPERM|EBUSY)/);
  } finally {
    lock.kill("SIGTERM"); await closed;
    if (path.dirname(root) !== realpathSync(parent)) throw new Error("Private file fixture escaped its test directory.");
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

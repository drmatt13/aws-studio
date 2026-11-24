import assert from "./support/assert";
import childProcess from "node:child_process";
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPrivateDirectorySync } from "aws-studio/cli/private-files";
import { assertWindowsPrivatePaths, currentUserSid } from "aws-studio/cli/windows-security";
import { createAwsExecutionSnapshot, disposeAwsExecutionSnapshots } from "aws-studio/cli/aws-connections";

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio private directory \u00e9 ")));
  return { root, dispose() {
    if (path.dirname(root) !== realpathSync(os.tmpdir()) || !path.basename(root).startsWith("studio private directory \u00e9 ")) throw new Error("Private directory fixture escaped its task root.");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } };
}

test("fresh private groups protect every file before writing bytes and dispose idempotently", context => {
  const f = fixture(), opened = new Map<number, string>(), open = fs.openSync, write = fs.writeFileSync;
  let writes = 0, owned: ReturnType<typeof createPrivateDirectorySync> | undefined;
  context.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
    const fd = (open as (...values: unknown[]) => number)(file, ...args); opened.set(fd, String(file)); return fd;
  }) as typeof fs.openSync);
  context.mock.method(fs, "writeFileSync", ((fd: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof fd === "number" && opened.has(fd)) {
      const file = opened.get(fd)!, directory = path.dirname(file);
      assert.equal(lstatSync(file).size, 0);
      if (process.platform === "win32") assertWindowsPrivatePaths([directory, file]);
      else { assert.equal(lstatSync(directory).mode & 0o777, 0o700); assert.equal(lstatSync(file).mode & 0o777, 0o600); }
      writes++;
    }
    return (write as (...values: unknown[]) => void)(fd, ...args);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    owned = createPrivateDirectorySync(path.join(f.root, "group-"), { "owner.json": "fixture owner", config: "fixture config", credentials: Buffer.from("fixture credentials") });
    assert.equal(writes, 3);
    assert.deepEqual(readdirSync(owned.directory).sort(), ["config", "credentials", "owner.json"]);
    assert.equal(readFileSync(path.join(owned.directory, "credentials"), "utf8"), "fixture credentials");
    owned.dispose(); owned.dispose();
    assert.equal(existsSync(owned.directory), false);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); owned?.dispose(); f.dispose(); }
});

test("private groups reject path-like names without changing preexisting directories", () => {
  const f = fixture();
  try {
    const existing = path.join(f.root, "existing"); mkdirSync(existing); writeFileSync(path.join(existing, "canary"), "preserve");
    for (const name of ["", ".", "..", "../outside", "..\\outside", "nested/file", "stream:credentials"])
      assert.throws(() => createPrivateDirectorySync(path.join(f.root, "group-"), { [name]: "must not appear" }), /plain filenames/);
    const owned = createPrivateDirectorySync(existing, { config: "new private bytes" });
    try { assert.notEqual(owned.directory, existing); assert.equal(readFileSync(path.join(existing, "canary"), "utf8"), "preserve"); }
    finally { owned.dispose(); }
    assert.deepEqual(readdirSync(f.root), ["existing"]);
  } finally { f.dispose(); }
});

for (const operation of ["writeFileSync", "fsyncSync"] as const) test(`private group ${operation} failure removes its own partial files`, context => {
  const f = fixture();
  writeFileSync(path.join(f.root, "canary"), "preserve");
  context.mock.method(fs, operation, () => { throw Object.assign(new Error("Synthetic storage failure"), { code: "EIO" }); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createPrivateDirectorySync(path.join(f.root, "group-"), { config: "private fixture" }), /Synthetic storage failure/);
    assert.deepEqual(readdirSync(f.root), ["canary"]);
    assert.equal(readFileSync(path.join(f.root, "canary"), "utf8"), "preserve");
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); f.dispose(); }
});

test("private directory disposal preserves a replacement path", () => {
  const f = fixture(), owned = createPrivateDirectorySync(path.join(f.root, "group-"), { config: "private fixture" });
  const moved = path.join(f.root, "moved-owned-directory");
  try {
    renameSync(owned.directory, moved); mkdirSync(owned.directory); writeFileSync(path.join(owned.directory, "canary"), "preserve replacement");
    assert.throws(() => owned.dispose(), /changed identity/);
    assert.equal(readFileSync(path.join(owned.directory, "canary"), "utf8"), "preserve replacement");
    rmSync(path.join(owned.directory, "canary")); fs.rmdirSync(owned.directory); renameSync(moved, owned.directory);
    owned.dispose();
  } finally { f.dispose(); }
});

test("Windows private groups batch native preparation and verification without passing contents in arguments", { skip: process.platform !== "win32" }, context => {
  const f = fixture(); currentUserSid();
  const spawn = childProcess.spawnSync, marker = "SYNTHETIC_PRIVATE_CONTENTS"; let launches = 0;
  context.mock.method(childProcess, "spawnSync", ((command: string, args: readonly string[], options: object) => {
    launches++; assert.equal(JSON.stringify(args).includes(marker), false); assert.equal(JSON.stringify(options).includes(marker), false);
    return spawn(command, args, options);
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  try {
    const owned = createPrivateDirectorySync(path.join(f.root, "group-"), { "owner.json": marker, config: marker, credentials: marker });
    try { assert.equal(launches, 2); }
    finally { owned.dispose(); }
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); f.dispose(); }
});

test("snapshot cleanup preserves a replacement while disposing every other owned snapshot", () => {
  const f = fixture(), previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const config = path.join(f.root, "config"), credentials = path.join(f.root, "credentials");
  writeFileSync(config, "[default]\nregion=us-east-1\n"); writeFileSync(credentials, "");
  process.env.TEMP = f.root; process.env.TMP = f.root; process.env.TMPDIR = f.root;
  let first: ReturnType<typeof createAwsExecutionSnapshot> | undefined, second: typeof first;
  const moved = path.join(f.root, "moved-snapshot");
  try {
    first = createAwsExecutionSnapshot({ AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials });
    second = createAwsExecutionSnapshot({ AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: credentials });
    renameSync(first.directory, moved); mkdirSync(first.directory); writeFileSync(path.join(first.directory, "canary"), "preserve replacement");
    assert.throws(disposeAwsExecutionSnapshots, /Could not remove 1 private AWS execution snapshot/);
    assert.equal(existsSync(second.directory), false, "one failed cleanup must not retain other owned secrets");
    assert.equal(readFileSync(path.join(first.directory, "canary"), "utf8"), "preserve replacement");
    rmSync(path.join(first.directory, "canary")); fs.rmdirSync(first.directory); renameSync(moved, first.directory);
    first.dispose(); second.dispose();
  } finally {
    if (first && existsSync(moved)) { if (existsSync(first.directory)) rmSync(first.directory, { recursive: true, force: true }); renameSync(moved, first.directory); }
    first?.dispose(); second?.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.dispose();
  }
});

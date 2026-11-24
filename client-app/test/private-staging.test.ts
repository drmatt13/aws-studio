import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPrivateDirectorySync, ensurePrivateDirectory, writePrivateFileSync } from "aws-studio/cli/private-files";

for (const kind of ["file", "group"] as const) for (const boundary of ["open", "inspect"] as const) {
  test(`Windows private ${kind} rejects a replaced staging directory before writing (${boundary})`, { skip: process.platform !== "win32" }, async context => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "studio-staging-")));
    const open = fs.openSync, inspect = fs.lstatSync;
    let replacement: string | undefined;
    try {
      const literal = Buffer.from(root).toString("base64");
      const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $directory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${literal}')); $acl=[IO.Directory]::GetAccessControl($directory); $everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($directory,$acl)`], { windowsHide: true, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const replace = (candidate: string) => {
        if (replacement || path.dirname(candidate) !== root || !path.basename(candidate).startsWith(kind === "file" ? ".aws-studio-private-" : "group-")) return;
        fs.renameSync(candidate, path.join(root, "original"));
        fs.mkdirSync(candidate);
        fs.writeFileSync(path.join(candidate, "canary"), "preserve replacement");
        replacement = candidate;
      };
      if (boundary === "open") context.mock.method(fs, "openSync", ((file: fs.PathLike, ...args: unknown[]) => {
        replace(path.dirname(String(file))); return (open as (...values: unknown[]) => number)(file, ...args);
      }) as typeof fs.openSync);
      else context.mock.method(fs, "lstatSync", ((file: fs.PathLike, ...args: unknown[]) => {
        replace(String(file)); return (inspect as (...values: unknown[]) => fs.Stats)(file, ...args);
      }) as typeof fs.lstatSync);
      syncBuiltinESMExports();
      assert.throws(() => kind === "file"
        ? writePrivateFileSync(path.join(root, "published"), "synthetic private content")
        : createPrivateDirectorySync(path.join(root, "group-"), { record: "synthetic private content" }));
      context.mock.restoreAll(); syncBuiltinESMExports();
      assert.ok(replacement, "the native directory was replaced at the tested boundary");
      assert.equal(fs.readFileSync(path.join(replacement, "canary"), "utf8"), "preserve replacement");
      assert.equal(fs.existsSync(path.join(root, "published")), false);
      const record = path.join(replacement, "record");
      if (fs.existsSync(record)) assert.equal(fs.statSync(record).size, 0, "no private bytes reach the replacement");
    } finally {
      context.mock.restoreAll(); syncBuiltinESMExports();
      assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test("fresh private groups preserve unexpected existing private contents", async context => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "studio-staging-existing-")));
  const inspect = fs.lstatSync;
  let replacement: string | undefined;
  context.mock.method(fs, "lstatSync", ((file: fs.PathLike, ...args: unknown[]) => {
    const candidate = String(file);
    if (!replacement && path.dirname(candidate) === root && path.basename(candidate).startsWith("group-")) {
      replacement = candidate;
      fs.renameSync(candidate, path.join(root, "original"));
      ensurePrivateDirectory(candidate);
      fs.writeFileSync(path.join(candidate, "canary"), "preserve existing private contents");
    }
    return (inspect as (...values: unknown[]) => fs.Stats)(file, ...args);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => createPrivateDirectorySync(path.join(root, "group-"), { record: "synthetic private content" }), /fresh empty/);
    assert.ok(replacement);
    assert.equal(fs.readFileSync(path.join(replacement, "canary"), "utf8"), "preserve existing private contents");
    assert.equal(fs.existsSync(path.join(replacement, "record")), false);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

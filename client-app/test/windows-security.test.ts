import assert from "./support/assert";
import childProcess, { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { assertWindowsUserContext } from "aws-studio/cli/windows-security";

test("native Windows startup context accepts an unelevated owner or explicitly rejects an unsupported token", { skip: process.platform !== "win32", timeout: 15_000 }, context => {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); [ordered]@{ user = $identity.User.Value; owner = $identity.Owner.Value; elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const token = JSON.parse(result.stdout) as { user: string; owner: string; elevated: boolean };
  if (token.elevated || token.user !== token.owner) {
    assert.throws(assertWindowsUserContext, /Studio requires an unelevated Windows terminal/);
    context.diagnostic("Native token is unsupported; startup rejection was verified. This does not establish supported developer startup.");
  } else {
    assert.doesNotThrow(assertWindowsUserContext);
    context.diagnostic("Native token is unelevated with current-user default ownership.");
  }
});

test("Windows startup refuses elevated and foreign-default-owner tokens with an exact remedy", { skip: process.platform !== "win32" }, context => {
  let token = { user: "S-1-5-21-123-1001", owner: "S-1-5-21-123-1001", elevated: true };
  context.mock.method(childProcess, "spawnSync", () => ({ status: 0, signal: null, stdout: JSON.stringify(token), stderr: "" }));
  syncBuiltinESMExports();
  try {
    assert.throws(assertWindowsUserContext, /open PowerShell or Windows Terminal normally.*npm run studio.*Preserve existing private and recovery state/);
    token = { ...token, elevated: false, owner: "S-1-5-32-544" };
    assert.throws(assertWindowsUserContext, /unelevated Windows terminal with current-user file ownership/);
    token = { ...token, owner: token.user };
    assert.doesNotThrow(assertWindowsUserContext);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("unsupported Windows startup exits before finding a checkout or initializing state", { skip: process.platform !== "win32", timeout: 15_000 }, () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio startup é ")));
  try {
    const preload = path.join(root, "elevated-token.mjs");
    writeFileSync(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; cp.spawnSync = () => ({ status: 0, signal: null, stdout: JSON.stringify({ user: 'S-1-5-21-123-1001', owner: 'S-1-5-32-544', elevated: true }), stderr: '' }); syncBuiltinESMExports();`);
    const entry = path.resolve(__dirname, "../server/index.ts");
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, "--import", pathToFileURL(preload).href, entry, "--print"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 12_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Studio requires an unelevated Windows terminal/);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(root), ["elevated-token.mjs"]);
  } finally {
    if (path.dirname(root) !== realpathSync(os.tmpdir()) || !path.basename(root).startsWith("studio startup é ")) throw new Error("Unexpected startup fixture directory.");
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const powershell = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell/7/pwsh.exe");
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

test("Windows CI changes only its own shell's default owner and Node children create user-owned files", {
  skip: process.platform !== "win32" || !existsSync(powershell),
}, () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio/ci-token-owner-tests");
  mkdirSync(parent, { recursive: true });
  const directory = realpathSync(mkdtempSync(path.join(parent, "case-"))), file = path.join(directory, "node-created.txt");
  const child = encoded(`
    $ErrorActionPreference = 'Stop'
    & $env:STUDIO_CI_OWNER_HELPER
    & $env:STUDIO_CI_OWNER_NODE -e 'require("node:fs").writeFileSync(process.env.STUDIO_CI_OWNER_FILE,"fixture",{flag:"wx"})'
    if ($LASTEXITCODE -ne 0) { throw 'The CI fixture Node process failed.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
      [pscustomobject]@{ user = $identity.User.Value; owner = $identity.Owner.Value; fileOwner = (Get-Acl -LiteralPath $env:STUDIO_CI_OWNER_FILE).GetOwner([Security.Principal.SecurityIdentifier]).Value } | ConvertTo-Json -Compress
    } finally { $identity.Dispose() }
  `);
  const script = encoded(`
    $ErrorActionPreference = 'Stop'
    function Snapshot {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      try { [pscustomobject]@{ user = $identity.User.Value; owner = $identity.Owner.Value; groups = @($identity.Groups | ForEach-Object Value | Sort-Object) } }
      finally { $identity.Dispose() }
    }
    $before = Snapshot
    $child = & (Join-Path $PSHOME 'pwsh.exe') -NoLogo -NoProfile -NonInteractive -EncodedCommand '${child}'
    if ($LASTEXITCODE -ne 0) { throw 'The CI token-owner fixture shell failed.' }
    [pscustomobject]@{ before = $before; after = Snapshot; child = ($child | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 5
  `);
  try {
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], {
      env: { ...process.env, STUDIO_CI_OWNER_HELPER: path.resolve(__dirname, "../../.github/scripts/windows-user-owner.ps1"), STUDIO_CI_OWNER_NODE: process.execPath, STUDIO_CI_OWNER_FILE: file },
      encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.after, observed.before, "the original parent shell's identity and default owner remain unchanged");
    assert.equal(observed.child.user, observed.before.user);
    assert.equal(observed.child.owner, observed.child.user);
    assert.equal(observed.child.fileOwner, observed.child.user, "the Node child uses the adjusted default owner at file creation");
  } finally {
    if (path.dirname(directory) !== realpathSync(parent)) throw new Error("CI token-owner fixture escaped its test directory.");
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

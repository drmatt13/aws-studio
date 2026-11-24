import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

let cachedUserSid: string | undefined;

/** Refuse unsupported tokens before Studio creates private state or evaluates source. */
export function assertWindowsUserContext(): void {
  if (process.platform !== "win32") return;
  const result = JSON.parse(powershell("$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); [ordered]@{ user = $identity.User.Value; owner = $identity.Owner.Value; elevated = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress")) as { user?: unknown; owner?: unknown; elevated?: unknown };
  if (typeof result.user !== "string" || !/^S-1-(?:\d+-)+\d+$/.test(result.user) || result.owner !== result.user || result.elevated !== false) {
    throw new Error('Studio requires an unelevated Windows terminal with current-user file ownership. Close this terminal, open PowerShell or Windows Terminal normally (do not choose "Run as administrator"), then run npm run studio from the checkout. Preserve existing private and recovery state.');
  }
  cachedUserSid = result.user;
}

/** Current token identity, independent of Studio or environment usernames. */
export function currentUserSid(): string {
  if (process.platform !== "win32") throw new Error("Windows identity is unavailable on this platform.");
  if (!cachedUserSid) {
    const sid = powershell("$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); if ($identity.Owner.Value -ne $identity.User.Value) { throw 'The token default owner must be the current user' }; $identity.User.Value");
    if (!/^S-1-(?:\d+-)+\d+$/.test(sid)) throw new Error("The Windows user SID could not be verified.");
    cachedUserSid = sid;
  }
  return cachedUserSid;
}

function powershell(script: string): string {
  const result = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`,
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0 || result.signal) throw new Error("Windows could not verify private Studio filesystem permissions. Use a local NTFS directory owned by this user and run Studio from an unelevated terminal.");
  return result.stdout.trim();
}

function literal(value: string): string { return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`; }

// Mutators verify the resulting native ACL in the same process. Never cache an
// authorization decision: changing a DACL does not change the path's inode.
const privatePathCheck = `function Assert-PrivatePath($file, $directory) {
  if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked path' };
  $acl = if ($directory) { [IO.Directory]::GetAccessControl($file) } else { [IO.File]::GetAccessControl($file) };
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Unexpected owner' };
  $allowed = $false;
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -eq $sid) { $allowed = $true }
      elseif ($rule.IdentityReference.Value -ne 'S-1-5-18') { throw 'Shared private path' }
    }
  };
  if (-not $allowed) { throw 'Private DACL required' }
}`;

export function assertWindowsOwnedPath(file: string, requireWritable = false): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Only regular unlinked files can be edited by Studio.");
  powershell(`$file = ${literal(file)}; if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.File]::GetAccessControl($file).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne '${currentUserSid()}') { throw 'Unexpected owner or linked file' }; ${requireWritable ? "[IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete).Dispose()" : ""}`);
}

/** Windows mode bits do not describe an ACL. Validate the real owner and every allow ACE. */
export function assertWindowsPrivatePath(file: string): void {
  assertWindowsPrivatePaths([file]);
}

/** Validate one immutable release/state group with one native ACL query. */
export function assertWindowsPrivatePaths(files: readonly string[]): void {
  const entries = files.map(file => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1) throw new Error("Private paths cannot be links or special files.");
    return { file, directory: stat.isDirectory() };
  });
  if (!entries.length) return;
  const sid = currentUserSid();
  powershell(`$sid = '${sid}'; ${privatePathCheck}; $entries = ConvertFrom-Json -InputObject (${literal(JSON.stringify(entries))}); foreach ($entry in $entries) { Assert-PrivatePath $entry.file $entry.directory }`);
}

/** Create with a protected DACL atomically, before any authentication material is written. */
export function ensureWindowsPrivateDirectory(directory: string): void {
  const sid = currentUserSid();
  powershell(`$sid = '${sid}'; ${privatePathCheck}; $directory = ${literal(directory)}; if (-not [IO.Directory]::Exists($directory)) { $owner = New-Object Security.Principal.SecurityIdentifier($sid); $acl = New-Object Security.AccessControl.DirectorySecurity; $acl.SetOwner($owner); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); [void][IO.Directory]::CreateDirectory($directory, $acl) }; Assert-PrivatePath $directory $true`);
}

/** Upgrade existing current-user state without replacing its contents or recovery records. */
export function restrictWindowsOwnedPath(file: string): void {
  restrictWindowsOwnedPaths([file]);
}

/** Restrict related app-owned state with one native invocation, preserving its bytes. */
export function restrictWindowsOwnedPaths(files: readonly string[]): void {
  const entries = files.map(file => {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.nlink !== 1) throw new Error("Only regular unlinked Studio state can have its Windows permissions restricted.");
    return { file, directory: stat.isDirectory() };
  });
  if (!entries.length) return;
  const sid = currentUserSid();
  powershell(`$sid = '${sid}'; ${privatePathCheck}; $entries = ConvertFrom-Json -InputObject (${literal(JSON.stringify(entries))}); foreach ($entry in $entries) {
    $file = $entry.file;
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked path' };
    $previous = if ($entry.directory) { [IO.Directory]::GetAccessControl($file) } else { [IO.File]::GetAccessControl($file) };
    if ($previous.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'Unexpected owner' };
    $owner = New-Object Security.Principal.SecurityIdentifier($sid);
    $acl = if ($entry.directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity };
    $acl.SetAccessRuleProtection($true, $false);
    $rule = if ($entry.directory) { New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') } else { New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'Allow') };
    $acl.AddAccessRule($rule);
    if ($entry.directory) { [IO.Directory]::SetAccessControl($file, $acl) } else { [IO.File]::SetAccessControl($file, $acl) };
    Assert-PrivatePath $file $entry.directory
  }`);
}

/** Preserve an existing file's Windows owner, group and DACL across atomic replacement. */
export function captureWindowsSecurityDescriptor(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Only regular unlinked files have replaceable Windows security descriptors.");
  return powershell(`$acl = [IO.File]::GetAccessControl((${literal(file)})); $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group)`);
}

export function applyWindowsSecurityDescriptor(file: string, descriptor: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Only regular unlinked files have replaceable Windows security descriptors.");
  powershell(`$acl = New-Object Security.AccessControl.FileSecurity; $acl.SetSecurityDescriptorSddlForm((${literal(descriptor)}), [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group); [IO.File]::SetAccessControl((${literal(file)}), $acl)`);
}

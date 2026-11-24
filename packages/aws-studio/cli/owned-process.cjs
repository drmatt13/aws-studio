const { spawn } = require("node:child_process");
const { lstatSync } = require("node:fs");
const path = require("node:path");

exports.WINDOWS_JOB = path.join(__dirname, "windows-job.ps1");
exports.TETHER = path.join(__dirname, "tether.mjs");
// A fixed startup diagnostic, emitted only when the application executable is absent.
exports.COMMAND_NOT_FOUND = "The requested executable was not found (ENOENT).";

/** Windows owns a native job; POSIX uses a stdin lifeline and owned process group. */
exports.spawnOwnedProcess = function spawnOwnedProcess(file, args, options = {}, { forwardInput = false } = {}) {
  if (process.platform === "win32") return exports.spawnWindowsJob(file, args, options);
  const stdio = Array.isArray(options.stdio) ? options.stdio : ["pipe", "pipe", "pipe"];
  return spawn(process.execPath, [exports.TETHER, ...(forwardInput ? ["--forward-input"] : []), file, ...args], {
    ...options, shell: false, detached: true, stdio: ["pipe", stdio[1], stdio[2]],
  });
};

/** A Windows Job owns descendants before the command resumes, even after parent death. */
exports.spawnWindowsJob = function spawnWindowsJob(file, args, options = {}) {
  const env = options.env ?? process.env;
  // JSON transport would hide NULs from Node's spawn validation before native truncation.
  if ([file, ...args].some(value => String(value).includes("\0")) ||
      Object.entries(env).some(([key, value]) => key.includes("\0") || String(value).includes("\0"))) {
    throw new TypeError("Command and environment entries must not contain null bytes.");
  }
  const declared = name => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  // The .NET supervisor needs Windows' installation/profile locations even for
  // a hermetic command. Restore their declared values before launching it.
  const restored = Object.fromEntries(["TEMP", "TMP", "TMPDIR", "SystemRoot", "WINDIR", "LOCALAPPDATA", "USERPROFILE", "PSModulePath", "PSExecutionPolicyPreference", "PATHEXT"].map(name => [name, declared(name) ?? null]));
  const systemRoot = declared("SystemRoot") ?? process.env.SystemRoot ?? "C:\\Windows";
  const localAppData = process.env.LOCALAPPDATA ?? declared("LOCALAPPDATA");
  // Match Node/libuv's required Windows defaults for a custom environment.
  // Removing SYSTEMROOT breaks native initialization (including Node crypto).
  restored.SystemRoot ??= systemRoot;
  restored.WINDIR ??= process.env.WINDIR ?? systemRoot;
  restored.TEMP ??= process.env.TEMP ?? null;
  restored.USERPROFILE ??= process.env.USERPROFILE ?? null;
  // Windows PowerShell 5 may hang before loading scripts with a long TEMP.
  // The native child still receives its original temporary environment.
  const temporary = [
    localAppData && path.join(localAppData, "Temp"),
    env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Local", "Temp"),
    path.join(systemRoot, "Temp"),
  ].find(directory => {
    try { const stat = lstatSync(directory); return path.isAbsolute(directory) && directory.length < 180 && stat.isDirectory() && !stat.isSymbolicLink(); }
    catch { return false; }
  });
  if (!temporary) throw new Error("The Windows process supervisor has no usable temporary directory.");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", exports.WINDOWS_JOB], {
    ...options, shell: false, windowsHide: true, detached: false,
    env: { ...env, SystemRoot: systemRoot, WINDIR: declared("WINDIR") ?? systemRoot, LOCALAPPDATA: localAppData, USERPROFILE: process.env.USERPROFILE ?? declared("USERPROFILE"), TEMP: temporary, TMP: temporary, TMPDIR: temporary,
      FRAMEWORK_STUDIO_WINDOWS_JOB_COMMAND: JSON.stringify({ file, args, parentPid: process.pid,
        temporary: restored }) },
  });
};

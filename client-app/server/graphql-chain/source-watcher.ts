import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";

// libuv's Windows watcher includes LAST_ACCESS. Reading a large dependency
// installation can consequently overflow its queue and make every reconciliation
// trigger another one. Use the OS filter for writes/identity/permissions instead.
// The helper owns no source writes and exits when its parent's stdin closes.
const windowsWatcher = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
public static class StudioSourceWatcher {
  static readonly object Gate = new object();
  static void Emit(string value) { lock (Gate) { Console.WriteLine(value); Console.Out.Flush(); } }
  static void Changed(object sender, FileSystemEventArgs args) { Emit("FILE " + Convert.ToBase64String(Encoding.UTF8.GetBytes(args.Name))); }
  static void Renamed(object sender, RenamedEventArgs args) {
    Emit("FILE " + Convert.ToBase64String(Encoding.UTF8.GetBytes(args.OldName))); Changed(sender, args);
  }
  public static void Run(string root) {
    using (var watcher = new FileSystemWatcher(root)) {
      watcher.IncludeSubdirectories = true;
      watcher.InternalBufferSize = 65536;
      watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Attributes | NotifyFilters.Security;
      watcher.Changed += Changed; watcher.Created += Changed; watcher.Deleted += Changed; watcher.Renamed += Renamed;
      watcher.Error += (sender, args) => Emit(args.GetException() is InternalBufferOverflowException ? "OVERFLOW" : "ERROR");
      watcher.EnableRaisingEvents = true; Emit("READY");
      while (Console.ReadLine() != null) { }
    }
  }
}
'@
[StudioSourceWatcher]::Run($env:STUDIO_SOURCE_WATCH_ROOT)
`;

export interface SourceWatcher { close(): void }
/** Ready resolves only after native notifications are installed. */
export async function watchContractSources(root: string, changed: (filename: string | undefined) => void, failed: () => void): Promise<SourceWatcher> {
  if (process.platform !== "win32") {
    const watcher = watch(root, { recursive: true }, (_event, filename) => changed(filename === null ? undefined : String(filename)));
    watcher.on("error", failed);
    return watcher;
  }
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsWatcher, "utf16le").toString("base64")], {
      env: { ...process.env, STUDIO_SOURCE_WATCH_ROOT: root }, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let ready = false, closed = false, buffer = "";
    const close = () => { if (closed) return; closed = true; clearTimeout(timer); child.stdin.end(); };
    const problem = () => { if (closed) return; close(); if (ready) failed(); else reject(new Error("The Windows source watcher could not start.")); };
    const timer = setTimeout(problem, 30_000);
    child.on("error", problem); child.on("exit", problem);
    child.stdin.on("error", problem);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { problem(); return; }
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line === "READY" && !ready) { ready = true; clearTimeout(timer); resolve({ close }); }
        else if (line === "OVERFLOW") changed(undefined);
        else if (line.startsWith("FILE ")) changed(Buffer.from(line.slice(5), "base64").toString("utf8"));
        else { problem(); return; }
      }
    });
  });
}

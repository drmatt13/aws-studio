import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { currentUserSid } from "../../cli/windows-security";
export { currentUserSid } from "../../cli/windows-security";

import type { ExecutionIdentity } from "./execution-identity";
export type { ExecutionIdentity };

type ProcessIdentity = Omit<ExecutionIdentity, "token">;
const SID = /^S-1-(?:\d+-)+\d+$/;
const execute = promisify(execFile);
const windowsPowerShell = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function windowsProbe(script: string): unknown {
  // Use the installed Windows component directly, without profiles, a shell,
  // request-controlled script text, or a dependency on PowerShell 7 / WMIC.
  const result = spawnSync(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${script}`], {
    encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024, windowsHide: true, shell: false,
  });
  if (result.error || result.signal || result.status !== 0) return undefined;
  try { return JSON.parse(result.stdout.trim()); } catch { return undefined; }
}

/** A PID alone is not an execution identity. A failed probe never proves death. */
export function inspectProcess(pid: number): ProcessIdentity | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") {
    // CIM supplies the owning token SID and the creation timestamp for the same
    // process instance. Its absence is distinct from access/service failures.
    const value = windowsProbe(`$p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { 'null'; exit 0 }; $o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($o.ReturnValue -ne 0) { throw 'Process owner unavailable' }; [ordered]@{ pid=[int]$p.ProcessId; userSid=[string]$o.Sid; started=$p.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture); currentUserSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress`);
    if (value === null) return null;
    if (!value || typeof value !== "object") return undefined;
    const observed = value as Record<string, unknown>;
    if (observed.pid !== pid || typeof observed.userSid !== "string" || !SID.test(observed.userSid) || typeof observed.currentUserSid !== "string" || !SID.test(observed.currentUserSid) || typeof observed.started !== "string" || !/^\d+$/.test(observed.started)) return undefined;
    return { pid, uid: -1, userSid: observed.userSid, started: observed.started };
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "uid=", "-o", "lstart="], {
    encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, windowsHide: true,
  });
  if (result.error || result.signal) return undefined;
  const output = result.stdout.trim();
  if (result.status === 1 && !output && !result.stderr.trim()) return null;
  if (result.status !== 0) return undefined;
  const match = /^(\d+)\s+(.+)$/.exec(output);
  return match ? { pid, uid: Number(match[1]), started: match[2]!.replace(/\s+/g, " ").trim() } : undefined;
}

/** Retained records must carry a complete owner, start time, and dispatch token. */
export function isExecutionIdentity(value: unknown): value is ExecutionIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as ExecutionIdentity;
  const owner = Number.isSafeInteger(identity.uid) && (identity.uid >= 0 && identity.userSid === undefined
    || identity.uid === -1 && typeof identity.userSid === "string" && SID.test(identity.userSid));
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 && owner && typeof identity.started === "string" && !!identity.started && typeof identity.token === "string" && !!identity.token;
}

export function sameUser(identity: Pick<ExecutionIdentity, "uid" | "userSid">): boolean {
  return process.platform === "win32" ? identity.uid === -1 && identity.userSid === currentUserSid()
    : identity.userSid === undefined && typeof process.getuid === "function" && identity.uid === process.getuid();
}

export function processIdentity(token: string): ExecutionIdentity {
  const identity = inspectProcess(process.pid);
  if (!identity || !sameUser(identity) || !token) {
    throw new Error("Operations runner cannot verify this process's user and start time. Host process inspection is required.");
  }
  return { ...identity, token };
}

export function identityAlive(identity: ExecutionIdentity): boolean | undefined {
  if (!isExecutionIdentity(identity)) return undefined;
  const observed = inspectProcess(identity.pid);
  if (observed === undefined) return undefined;
  if (observed === null) return false;
  return observed.uid === identity.uid && observed.userSid === identity.userSid && observed.started === identity.started;
}

/** Fresh reconciliation evidence: one asynchronous host probe, with no liveness cache. */
export async function observeExecutions(identities: readonly ExecutionIdentity[]): Promise<(identity: ExecutionIdentity) => boolean | undefined> {
  const owners = identities.filter(isExecutionIdentity);
  const pids = [...new Set(owners.map(owner => owner.pid))];
  const observed = new Map<number, ProcessIdentity>();
  let available = pids.length === 0;
  if (pids.length) try {
    if (process.platform === "win32") {
      const filter = pids.map(pid => `ProcessId = ${pid}`).join(" OR ");
      const script = `$ErrorActionPreference='Stop'; $items=@(Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | ForEach-Object { $o=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; if ($o.ReturnValue -ne 0) { throw 'Process owner unavailable' }; [ordered]@{ pid=[int]$_.ProcessId; userSid=[string]$o.Sid; started=$_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) } }); ConvertTo-Json -InputObject $items -Compress`;
      const { stdout } = await execute(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false });
      const values: unknown = JSON.parse(stdout.trim());
      if (!Array.isArray(values)) throw new Error("Process evidence is not an array.");
      for (const value of values) {
        if (!value || !pids.includes(value.pid) || typeof value.userSid !== "string" || !SID.test(value.userSid) || typeof value.started !== "string" || !/^\d+$/.test(value.started)) throw new Error("Process evidence is incomplete.");
        observed.set(value.pid, { pid: value.pid, uid: -1, userSid: value.userSid, started: value.started });
      }
    } else {
      let stdout: string;
      try { ({ stdout } = await execute("ps", ["-p", pids.join(","), "-o", "pid=", "-o", "uid=", "-o", "lstart="], { timeout: 3000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } })); }
      catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        if (result.code !== 1 || result.stdout?.trim() || result.stderr?.trim()) throw error;
        stdout = ""; // ps reports no matching processes with status 1.
      }
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (!match || !pids.includes(Number(match[1]))) throw new Error("Process evidence is incomplete.");
        observed.set(Number(match[1]), { pid: Number(match[1]), uid: Number(match[2]), started: match[3]!.replace(/\s+/g, " ").trim() });
      }
    }
    available = true;
  } catch { /* Failed inspection preserves unknown ownership and resource claims. */ }
  return identity => {
    if (!available || !isExecutionIdentity(identity) || !pids.includes(identity.pid)) return undefined;
    const actual = observed.get(identity.pid);
    return !!actual && actual.uid === identity.uid && actual.userSid === identity.userSid && actual.started === identity.started;
  };
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { spawnOwnedProcess, TETHER } from "../../cli/owned-process.cjs";

/**
 * Starting a fixed program: a file and argv, no shell, an explicit working directory and a curated
 * environment, optionally tethered so it cannot outlive the process that started it. Studio's
 * Deploy & Run and the contract verifier's checkout worker share this one implementation, so a
 * tethered child started by either is stopped the same way.
 */

export interface CommandSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** What the activity log shows: the command a person would type. */
  readonly display: string;
  /** Started through tether.mjs, so it stops when its starter does, however that process ends. */
  readonly tethered?: boolean;
}

/** The wrapper that ties a program's life to its starter's: see tether.mjs. */
export { TETHER };

/** The same command, run so that it cannot outlive its starter. */
export function tethered(spec: CommandSpec, options: { readonly forwardInput?: boolean } = {}): CommandSpec {
  if (spec.tethered) return spec;
  return { ...spec, file: process.execPath, args: [TETHER, ...(options.forwardInput ? ["--forward-input"] : []), spec.file, ...spec.args], tethered: true };
}


/** Starts a command with the module's rules: no shell, no window, its own process group on POSIX. */
const tetheredChildren = new WeakSet<ChildProcess>();
export function start(spec: CommandSpec): ChildProcess {
  const owned = spec.tethered && spec.file === process.execPath && spec.args[0] === TETHER;
  const forwardInput = owned && spec.args[1] === "--forward-input";
  const command = owned ? spec.args.slice(forwardInput ? 2 : 1) : [spec.file, ...spec.args];
  const options = {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
    // Only protocol commands receive input; the POSIX helper supplies its own lifeline.
    stdio: [forwardInput ? "pipe" : "ignore", "pipe", "pipe"] as ["pipe" | "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  };
  // Keep the public command shape while avoiding a second Node supervisor on Windows.
  const child = owned ? spawnOwnedProcess(command[0]!, command.slice(1), options, { forwardInput }) : spawn(spec.file, [...spec.args], options);
  if (owned) tetheredChildren.add(child);
  return child;
}

/** Stops a process and everything it started. */
export function stopTree(child: ChildProcess, graceful = true): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // Signal the owner, which tears down its native job or separate POSIX group.
  // Killing the tether itself with SIGKILL would bypass its descendant cleanup.
  if (tetheredChildren.has(child)) { child.kill("SIGTERM"); return; }
  if (process.platform === "win32") {
    // Untethered short probes still need their descendants stopped on timeout.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000, shell: false });
    return;
  }
  try {
    process.kill(-child.pid, graceful ? "SIGINT" : "SIGKILL");
  } catch {
    child.kill(graceful ? "SIGINT" : "SIGKILL");
  }
  if (graceful) {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, 8000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
}

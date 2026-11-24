import { spawn } from "node:child_process";
import { request } from "node:http";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutionIdentity } from "../../shared/operations";
import { identityAlive, sameUser } from "aws-studio/source/identity";
import { AgentRuntimeError } from "./store";
import { randomUUID } from "node:crypto";

/** Only Studio's backend registers this private capability. No browser request
 * supplies a process, executable, token or restart command. */
export interface StudioRuntimeRegistration {
  readonly id: string;
  readonly identity: ExecutionIdentity;
  readonly port: number;
  readonly token: string;
  readonly protocol: string;
  readonly restartKey: string;
  readonly entry: string;
  readonly loader: string;
}
export interface StudioRuntimeTarget {
  readonly installation: string;
  readonly entry: string;
  readonly loader: string;
}
export class StudioRuntimeActivation {
  private readonly instances = new Map<string, StudioRuntimeRegistration>();
  private readonly restarting = new Set<string>();
  constructor(private readonly root: string, private readonly target?: StudioRuntimeTarget) {}
  private installedTarget(): StudioRuntimeTarget {
    const target = this.target;
    try {
      if (target && [target.installation, target.entry, target.loader].every(file => realpathSync(file) === file)) return target;
    } catch { /* The installation may have moved since this agent host was pinned. */ }
    throw new AgentRuntimeError(422, "Studio's pinned restart target is unavailable. Use Restart agent host from the installed Studio.");
  }
  register(value: StudioRuntimeRegistration): void {
    if (!value || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || !/^[a-f0-9]{48}$/.test(value.token) || !/^[a-f0-9]{48}$/.test(value.restartKey) || typeof value.protocol !== "string" || typeof value.entry !== "string" || typeof value.loader !== "string") throw new AgentRuntimeError(400, "Invalid Studio runtime registration.");
    if (identityAlive(value.identity) !== true || !sameUser(value.identity)) throw new AgentRuntimeError(409, "Studio's process identity cannot be verified.");
    const target = this.installedTarget();
    if (path.relative(target.entry, value.entry) || path.relative(target.loader, value.loader)) throw new AgentRuntimeError(422, "Runtime activation requires the pinned Studio installation and loader.");
    const prior = this.instances.get(value.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new AgentRuntimeError(409, "A registered Studio identity cannot change.");
    this.instances.set(value.id, value);
  }
  async restart(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance || this.restarting.has(instanceId) || identityAlive(instance.identity) !== true) throw new AgentRuntimeError(409, "Reconnect to the running Studio instance before requesting its restart.");
    this.installedTarget();
    this.restarting.add(instanceId);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: instance.port, path: "/api/agent-runtime/restart", method: "POST", headers: {
          origin: `http://127.0.0.1:${instance.port}`, "x-studio-token": instance.token, "x-studio-protocol": instance.protocol, "x-studio-agent-restart": instance.restartKey, "content-type": "application/json",
        } }, response => {
          response.resume(); response.once("end", () => response.statusCode === 202 ? resolve() : reject(new AgentRuntimeError(409, "Studio refused restart while work is active. Finish its operations and retry.")));
        });
        req.once("error", reject); req.setTimeout(5000, () => req.destroy(new Error("Studio did not acknowledge restart."))); req.end("{}");
      });
      let stopped = false;
      for (let i = 0; i < 100; i++) { if (identityAlive(instance.identity) === false) { stopped = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
      if (!stopped) throw new AgentRuntimeError(409, "Studio has not finished closing. No replacement was started; reload after it stops or retry manually.");
      const nonce = randomUUID();
      const target = this.installedTarget();
      const child = spawn(process.execPath, ["--import", pathToFileURL(target.loader).href, target.entry, "--project", this.root, "--port", String(instance.port)], { cwd: target.installation, env: { ...process.env, FRAMEWORK_STUDIO_ACTIVATION_NONCE: nonce }, detached: true, stdio: "ignore", windowsHide: true });
      let failed: Error | undefined; child.once("error", error => { failed = error; }); child.unref();
      for (let i = 0; i < 150; i++) {
        if (failed || child.exitCode !== null) throw new AgentRuntimeError(503, "The new Studio process failed to start. Source and agent tasks are retained; fix startup and run npm run studio again.");
        const ready = await new Promise<boolean>(resolve => {
          const req = request({ hostname: "127.0.0.1", port: instance.port, path: "/_studio/runtime-ready", method: "GET" }, response => {
            let body = ""; response.on("data", chunk => { body += String(chunk); if (body.length > 4096) response.destroy(); });
            response.once("end", () => { try { const value = JSON.parse(body); resolve(response.statusCode === 200 && value.pid === child.pid && value.activation === nonce); } catch { resolve(false); } });
            response.once("error", () => resolve(false));
          });
          req.once("error", () => resolve(false)); req.setTimeout(500, () => { req.destroy(); resolve(false); }); req.end();
        });
        if (ready) { this.instances.delete(instanceId); return; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new AgentRuntimeError(504, "Studio is still starting. Its owned process was preserved; reload or inspect startup before another restart.");
    } finally { this.restarting.delete(instanceId); }
  }
}

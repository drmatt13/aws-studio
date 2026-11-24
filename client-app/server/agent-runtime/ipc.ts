import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { AGENT_RUNTIME_VERSION } from "../../shared/agent-runtime";
import { ipcAuthentication, privateEndpoint } from "../operations/ipc";
import { AgentRuntimeError } from "./store";
import type { ExecutionIdentity } from "../../shared/operations";

export interface AgentHostInfo { readonly version: number; readonly root: string; readonly state: string; readonly pid: number; readonly identity: ExecutionIdentity; readonly releaseDigest?: string; readonly contractPolicyDigest?: string; readonly contractControlDigest?: string; readonly capabilities?: readonly string[] }

/** Match Studio's bounded JSON envelope; structured handoffs have their own cap. */
export function agentRequestLimit(route: string): number { return route === "/structured" ? 33 * 1024 * 1024 : 640 * 1024; }

/** Private per-checkout state is never a child of editable project source. */
export function agentStateDirectory(root: string, override?: string): string {
  if (override) return path.resolve(override);
  const identity = createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
  return path.join(realpathSync(homedir()), ".local", "state", "aws-studio", "agents", identity);
}

export function agentEndpoint(root: string, state: string): string {
  return privateEndpoint(root, state, "agent").socket;
}

export function callAgentHost<T>(socketPath: string, route: string, body?: unknown, timeout = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && Buffer.byteLength(encoded) > agentRequestLimit(route)) throw new AgentRuntimeError(413, "Task request is too large.");
    const method = encoded === undefined ? "GET" : "POST";
    const authentication = ipcAuthentication(socketPath, `agents:${AGENT_RUNTIME_VERSION}`).signRequest(method, route, encoded ?? "");
    const req = request({ socketPath, path: route, method, agent: false, headers: {
      "x-agent-version": String(AGENT_RUNTIME_VERSION),
      ...authentication.headers,
      ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(authentication.body) }),
    } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (process.platform === "win32" ? 12 : 8) * 1024 * 1024) response.destroy(new AgentRuntimeError(502, "Agent response exceeds its bounded replay page.")); else chunks.push(chunk); });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const payload = authentication.verifyResponse(response.statusCode ?? 500, response.headers, Buffer.concat(chunks).toString("utf8"));
          if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new AgentRuntimeError(502, "Agent response exceeds its bounded replay page.");
          const result = JSON.parse(payload);
          if ((response.statusCode ?? 500) >= 400) reject(new AgentRuntimeError(response.statusCode ?? 500, typeof result.error === "string" ? result.error : "Agent host request failed."));
          else resolve(result as T);
        } catch (error) { reject(error instanceof Error && /authenticated/.test(error.message) ? new AgentRuntimeError(502, error.message) : new AgentRuntimeError(502, "Agent host returned unreadable evidence.")); }
      });
    });
    req.once("error", reject);
    req.setTimeout(timeout, () => req.destroy(Object.assign(new AgentRuntimeError(504, "The task may still be running. Reconnect with its existing task ID; do not resubmit a new intent."), { route })));
    req.end(encoded === undefined ? undefined : authentication.body);
  });
}

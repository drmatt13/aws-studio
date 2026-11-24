import { localDeployInputs } from "aws-studio/config/source";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { observeDevelopment, encodeDevelopmentCorrelation, newDevelopmentCorrelation, withDevelopmentObservation } from "aws-studio/development-logs";
import { forwardLines } from "./docker";
import { DEVELOPMENT_OBSERVATION_HEADER } from "./observation";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentLifecycle, getAgentGateways, getLocalTargets, type FrameworkConfig } from "aws-studio/config";
import { resolveAgentSourcePath } from "aws-studio/config/source";
import {
  agentToolSpecs,
  loadToolManifest,
  localGatewayDescriptor,
  resolveLocalWorkloadEnvironment,
  type GatewayToolManifest,
} from "aws-studio/local";

/**
 * Local AgentCore sessions: one process per conversation, as Runtime gives each
 * session its own microVM.
 *
 * A conversation's process keeps its in-memory state between turns and is
 * released after the agent's declared idle time or maximum lifetime — the
 * values the deployed Runtime is configured with. An edit to the agent's
 * source, its environment or its tools' contracts restarts the session on its
 * next turn, unless a turn is in flight, which finishes on the code it started
 * with (a deployed session likewise keeps the version it began on).
 *
 * A process is not a microVM: the host's filesystem, profile and network are
 * shared, and nothing here enforces per-agent IAM.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{33,128}$/;
const SERVE_AGENT = path.resolve(__dirname, "../../../scripts/serve-agent.ts");
const STARTUP_TIMEOUT_MS = 30_000;

interface SessionProcess {
  readonly child: ChildProcess;
  readonly port: Promise<number>;
  readonly fingerprint: string;
  readonly started: number;
  lastUsed: number;
  active: number;
  readonly agentId: string;
  readonly sessionId: string;
}

export interface AgentForward {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface LocalAgentSupervisorOptions {
  /** Tool contracts, read live from source by default. */
  readonly loadTools?: () => Promise<GatewayToolManifest>;
  /** At most this many session processes; the least recently used idle one makes room. */
  readonly maxSessions?: number;
  readonly now?: () => number;
}

export class LocalAgentSupervisor {
  private readonly sessions = new Map<string, SessionProcess>();
  private readonly children = new Set<ChildProcess>();
  private closing = false;
  private readonly timer = setInterval(() => this.sweep(), 30_000).unref();
  private readonly loadTools: () => Promise<GatewayToolManifest>;
  private readonly maxSessions: number;
  private readonly now: () => number;

  public constructor(
    private readonly config: FrameworkConfig,
    private readonly repositoryRoot: string,
    private readonly runnerUrl: string,
    options: LocalAgentSupervisorOptions = {},
  ) {
    this.loadTools = options.loadTools ?? (() => loadToolManifest(config, repositoryRoot));
    this.maxSessions = options.maxSessions ?? 16;
    this.now = options.now ?? Date.now;
  }

  /**
   * Forwards one invocation to the conversation's session process and hands
   * the reply to `consume`, which may stream it. The session counts as busy
   * until `consume` finishes.
   */
  public async invoke(
    id: string,
    request: AgentForward,
    consume: (response: Response) => Promise<void>,
  ): Promise<void> {
    if (this.closing) throw new Error("Local agent supervisor is shutting down.");
    if (!getLocalTargets(this.config, ["agent"], localDeployInputs(this.repositoryRoot)).some((target) => target.id === id)) {
      throw new Error(`agent:${id} is not enabled for local execution.`);
    }
    const sessionId = request.headers["x-amzn-bedrock-agentcore-runtime-session-id"];
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("A local agent invocation needs a Runtime session id of 33 to 128 safe characters.");
    }
    this.sweep();

    const session = await this.session(id, sessionId);
    const correlation = newDevelopmentCorrelation({ agentSessionId: sessionId, turnId: randomUUID() });
    session.active++;
    const started = this.now();
    let input: unknown = "[oversized or invalid input omitted]";
    if (request.body.length <= 64 * 1024) { try { input = (JSON.parse(request.body) as { input?: unknown })?.input; } catch { /* The adapter owns malformed request behavior. */ } }
    observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.turn_started", correlation, details: { input } });
    return withDevelopmentObservation({ resourceId: `agent:${id}`, correlation }, async () => {
    try {
      const port = await session.port;
      const response = await fetch(`http://127.0.0.1:${port}/invocations`, {
        method: "POST",
        headers: { ...request.headers, ...(process.env.FRAMEWORK_DEVELOPMENT_LOGS === "1" ? { [DEVELOPMENT_OBSERVATION_HEADER]: encodeDevelopmentCorrelation(correlation) } : {}) },
        body: request.body,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      await consume(response);
      observeDevelopment({ resourceId: `agent:${id}`, kind: request.signal?.aborted ? "agent.turn_cancelled" : "agent.transport_finished", correlation,
        durationMs: this.now() - started, outcome: request.signal?.aborted ? "cancelled" : "transport-finished",
        details: { status: response.status, completion: "adapter events establish execution outcome" } });
    } catch (error) {
      observeDevelopment({ resourceId: `agent:${id}`, kind: request.signal?.aborted ? "agent.turn_cancelled" : "agent.turn_failed", correlation,
        level: "error", durationMs: this.now() - started, details: { error } });
      throw error;
    } finally {
      session.active--;
      session.lastUsed = this.now();
    }
    });
  }

  /** Releases idle and expired sessions, as Runtime releases microVMs. */
  public sweep(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.active > 0) continue;
      const { idleSeconds, maxLifetimeSeconds } = getAgentLifecycle(this.config, key.slice(0, key.indexOf(":")));
      if (now - session.lastUsed > idleSeconds * 1000 || now - session.started > maxLifetimeSeconds * 1000) {
        this.stop(key, session, now - session.started > maxLifetimeSeconds * 1000 ? "maximum-lifetime" : "idle");
      }
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    for (const [key, session] of this.sessions) this.stop(key, session);
    await Promise.all([...this.children].map(child => new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    })));
  }

  private stop(key: string, session: SessionProcess, reason = "shutdown"): void {
    observeDevelopment({ resourceId: `agent:${session.agentId}`, kind: "agent.session_stopped", correlation: { agentSessionId: session.sessionId }, attribution: "session", details: { reason } });
    session.child.kill();
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  private async session(id: string, sessionId: string): Promise<SessionProcess> {
    const directory = resolveAgentSourcePath(this.config, id, { repositoryRoot: this.repositoryRoot });
    const environment = await resolveLocalWorkloadEnvironment(this.config, `agent:${id}`, {
      repositoryRoot: this.repositoryRoot,
      runnerUrl: this.runnerUrl,
    });
    environment.FRAMEWORK_AGENTCORE_ADAPTER = JSON.stringify({
      agent: id,
      auth: this.config.agents?.[id]?.auth === true,
      gateways: Object.fromEntries(getAgentGateways(this.config, id).map(gateway => [gateway.id, localGatewayDescriptor(gateway.id, this.runnerUrl, id)])),
      tools: agentToolSpecs(this.config, id, await this.loadTools()),
    });
    const fingerprint = createHash("sha256")
      .update(sourceDigest(directory))
      .update(JSON.stringify(environment))
      .digest("hex");

    const key = `${id}:${sessionId}`;
    const existing = this.sessions.get(key);
    if (existing && (existing.fingerprint === fingerprint || existing.active > 0)) {
      observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.session_reused", correlation: { agentSessionId: sessionId }, attribution: "session" });
      return existing;
    }
    if (existing) this.stop(key, existing, "source-or-environment-changed");
    this.makeRoom();

    const child = fork(SERVE_AGENT, [path.join(directory, "index.ts")], {
      execArgv: ["--import", "tsx"],
      cwd: this.repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    const prefix = `agent:${id} session:${sessionId.slice(0, 8)}`;
    forwardLines(child.stdout!, prefix, { resourceId: `agent:${id}`, correlation: { agentSessionId: sessionId }, stream: "stdout" });
    forwardLines(child.stderr!, prefix, { resourceId: `agent:${id}`, correlation: { agentSessionId: sessionId }, stream: "stderr" });
    observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.session_starting", correlation: { agentSessionId: sessionId }, attribution: "session" });
    const port = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.session_startup_timeout", correlation: { agentSessionId: sessionId }, level: "error", attribution: "session" });
        reject(new Error(`agent:${id} did not start within ${STARTUP_TIMEOUT_MS / 1000} seconds.`));
      }, STARTUP_TIMEOUT_MS);
      child.on("message", (message: { port?: unknown }) => {
        if (typeof message?.port === "number") {
          clearTimeout(timer);
          resolve(message.port);
          observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.session_ready", correlation: { agentSessionId: sessionId }, attribution: "session" });
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (this.sessions.get(key)?.child === child) this.sessions.delete(key);
        observeDevelopment({ resourceId: `agent:${id}`, kind: "agent.session_exited", correlation: { agentSessionId: sessionId }, attribution: "session", details: { code } });
        reject(new Error(`agent:${id} exited before serving (exit ${code}). Its error is in the runner log.`));
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    // A failed start is reported by the invocation that awaits it.
    port.catch(() => undefined);
    const session: SessionProcess = { child, port, fingerprint, started: this.now(), lastUsed: this.now(), active: 0, agentId: id, sessionId };
    this.sessions.set(key, session);
    return session;
  }

  private makeRoom(): void {
    if (this.sessions.size < this.maxSessions) return;
    const idle = [...this.sessions].filter(([, session]) => session.active === 0).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
    if (!idle) {
      throw new Error(`All ${this.maxSessions} local agent sessions are busy. Try again when a turn finishes.`);
    }
    this.stop(...idle, "capacity-eviction");
  }
}

/** The agent's own source, which decides whether a session is current. */
function sourceDigest(directory: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else hash.update(path.relative(directory, file)).update(readFileSync(file));
    }
  };
  visit(directory);
  return hash.digest("hex");
}

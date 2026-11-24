import { spawn } from "node:child_process";
import { studioContractControl } from "./contract-control";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentRuntimeUpgradeIntentView, AgentRuntimeUpgradeView, CodingEvent, CodingProposal, CodingTask, CodingTaskRequest } from "../../shared/agent-runtime";
import { AGENT_RUNTIME_VERSION } from "../../shared/agent-runtime";
import { agentEndpoint, agentStateDirectory, callAgentHost, type AgentHostInfo } from "./ipc";
import { AgentRuntimeError } from "./store";
import type { agentIntegrationState, AgentIntegrationResult } from "./integration";
import { pinAgentRuntime } from "./runtime-release";
import type { ReviewedStructuredSource } from "./structured-proposal";
import type { StudioRuntimeRegistration } from "./activation";
import { AgentRuntimeUpgradeController, pendingAgentRuntimeRelease, type RuntimeUpgradeIntent, type RuntimeLaunchReceipt } from "./runtime-upgrade";
import { readAgentRuntimeRelease, type AgentRuntimeRelease } from "./runtime-release-manifest";
import { inspectProcess, sameUser } from "aws-studio/source/identity";
import { portableProofPolicy, projectVerifierRoot } from "aws-studio/contract-chain/portable-identity";

export class AgentTaskClient {
  readonly root: string;
  readonly state: string;
  private starting?: Promise<void>;
  private closed = false;
  private registeredHost?: number;
  private upgradeController?: AgentRuntimeUpgradeController;
  private inspectedContractPolicy?: { readonly releaseDigest: string; readonly policyDigest: string; readonly controlDigest?: string };
  constructor(root: string, state?: string, private readonly registration?: () => StudioRuntimeRegistration) { this.root = realpathSync(root); this.state = agentStateDirectory(this.root, state); }
  private endpoint(): string { return agentEndpoint(this.root, this.state); }
  private async inspect(): Promise<AgentHostInfo | undefined> {
    try {
      const info = await callAgentHost<AgentHostInfo>(this.endpoint(), "/ping", undefined, process.platform === "win32" ? 5000 : 1000);
      if (info.version !== AGENT_RUNTIME_VERSION || info.root !== this.root || info.state !== this.state) throw new AgentRuntimeError(409, "The running agent host uses another protocol or workspace. Preserve its tasks before upgrading it.");
      return info;
    } catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
  }
  private async launch(release: AgentRuntimeRelease): Promise<RuntimeLaunchReceipt> {
    return new Promise<{ child: ReturnType<typeof spawn>; exited: boolean }>(resolve => {
      const child = spawn(process.execPath, [release.entry, this.root, this.state, release.directory], { cwd: release.directory, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve({ child, exited: true as const }));
      child.once("spawn", () => { child.unref(); resolve({ child, exited: false as const }); });
    }).then(async started => {
      const { child } = started;
      if (started.exited || child.exitCode !== null || child.signalCode !== null) return { exited: true };
      const identity = child.pid ? inspectProcess(child.pid) : undefined;
      if (identity && sameUser(identity)) return { identity: { ...identity, token: randomUUID() } };
      // Let the owned child's exit event settle. A failed ps probe by itself is
      // never proof that the new runtime stopped before claiming its IPC socket.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (child.exitCode !== null || child.signalCode !== null) return { exited: true };
      throw new AgentRuntimeError(409, "The launched agent host identity could not be verified. Its launch is retained for inspection; another host was not started.");
    });
  }
  private upgrades(): AgentRuntimeUpgradeController {
    if (this.closed) throw new AgentRuntimeError(503, "This task observer is closed.");
    return this.upgradeController ??= new AgentRuntimeUpgradeController(this.root, this.state, {
      pin: async () => { const release = await pinAgentRuntime(this.root, this.state); return { release, protocol: release.protocol }; },
      inspect: async () => {
        const info = await this.inspect(); if (!info) return;
        if (!info.releaseDigest || !info.identity) throw new AgentRuntimeError(409, "The running host predates managed upgrades. Preserve tasks and restart it explicitly before using this action.");
        return { protocol: info.version, releaseDigest: info.releaseDigest, identity: info.identity };
      },
      drain: async (host, intent) => { await callAgentHost(this.endpoint(), "/runtime/drain", { requestId: intent.requestId, targetDigest: intent.targetDigest, expectedToken: host.identity.token }); },
      launch: release => this.launch(release),
    });
  }
  private upgradeView(intent: RuntimeUpgradeIntent): AgentRuntimeUpgradeIntentView { return { requestId: intent.requestId, ...(intent.replacesRequestId ? { replacesRequestId: intent.replacesRequestId } : {}), targetDigest: intent.targetDigest, phase: intent.phase, ...(intent.message ? { error: intent.message } : {}) }; }
  runtimeUpgrade(): AgentRuntimeUpgradeView { const intent = this.upgrades().status(); return intent ? { intent: this.upgradeView(intent) } : {}; }
  async restartHost(requestId: string, replaceFailedRequestId?: string): Promise<AgentRuntimeUpgradeIntentView> {
    if (this.closed || !/^[a-f0-9-]{36}$/.test(requestId) || (replaceFailedRequestId !== undefined && !/^[a-f0-9-]{36}$/.test(replaceFailedRequestId))) throw new AgentRuntimeError(400, "Agent restart needs a retained request identity.");
    // Do not call ensure here: an explicit retry may need to complete a retained
    // handoff after the previous host stopped.
    return this.upgradeView(await (replaceFailedRequestId === undefined ? this.upgrades().request(requestId) : this.upgrades().replaceFailed(requestId, replaceFailedRequestId)));
  }
  private async connected(): Promise<void> {
    const info = await callAgentHost<AgentHostInfo>(this.endpoint(), "/ping", undefined, process.platform === "win32" ? 5000 : 1000);
    if (info.version !== AGENT_RUNTIME_VERSION || info.root !== this.root || info.state !== this.state) throw new AgentRuntimeError(409, "The running agent host uses another protocol or workspace. Preserve its tasks before upgrading it.");
    const intent = this.upgrades().status();
    if (intent && intent.phase !== "ready" && info.releaseDigest === intent.targetDigest) {
      // Recover only the observed outcome of an already requested handoff. This
      // cannot select a new target or launch while the matching host is alive.
      try { await (intent.replacesRequestId ? this.upgrades().replaceFailed(intent.requestId, intent.replacesRequestId) : this.upgrades().request(intent.requestId)); }
      catch (error) { if (!(error instanceof AgentRuntimeError && /Another observer owns/.test(error.message))) throw error; }
    }
    const canRegister = info.capabilities?.includes("studio-restart-target-v1");
    if (this.registration && canRegister && this.registeredHost !== info.pid) {
      await callAgentHost(this.endpoint(), "/runtime/register", this.registration()); this.registeredHost = info.pid;
    }
    if (!canRegister) this.registeredHost = undefined;
  }
  private async ensure(): Promise<void> {
    if (this.closed) throw new AgentRuntimeError(503, "This task observer is closed.");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try { await this.connected(); return; } catch (error) {
        if (error instanceof AgentRuntimeError) throw error;
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const retained = pendingAgentRuntimeRelease(this.root, this.state);
      if (retained) {
        const intent = this.upgrades().status();
        if (!intent || intent.targetDigest !== retained.digest) throw new AgentRuntimeError(409, "The retained agent host handoff changed. Reconnect before retrying it.");
        // The controller journals every launch attempt and its owned process
        // identity, including resumption after the previous observer died.
        await (intent.replacesRequestId ? this.upgrades().replaceFailed(intent.requestId, intent.replacesRequestId) : this.upgrades().request(intent.requestId));
        await this.connected(); return;
      }
      const release = await pinAgentRuntime(this.root, this.state);
      await this.launch(release);
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await this.connected(); const info = await this.inspect(); if (info?.releaseDigest !== release.digest) throw new AgentRuntimeError(409, "The replacement agent host differs from the retained pinned release."); return; } catch (error) { if (error instanceof AgentRuntimeError && error.status === 409) throw error; }
      }
      throw new AgentRuntimeError(503, "The independent agent host did not become available. Existing tasks were not restarted; inspect private state permissions and Node compatibility.");
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async call<T>(route: string, body?: unknown): Promise<T> { await this.ensure(); return callAgentHost<T>(this.endpoint(), route, body); }
  ping(): Promise<AgentHostInfo> { return this.call("/ping"); }
  list(): Promise<{ tasks: CodingTask[] }> { return this.call("/tasks"); }
  get(id: string): Promise<CodingTask> { return this.call(`/tasks/${encodeURIComponent(id)}`); }
  events(id: string, after = 0): Promise<{ task: CodingTask; events: CodingEvent[] }> { return this.call(`/tasks/${encodeURIComponent(id)}/events?after=${after}`); }
  proposal(id: string): Promise<CodingProposal> { return this.call(`/tasks/${encodeURIComponent(id)}/proposal`); }
  recovery(): Promise<ReturnType<typeof agentIntegrationState>> { return this.call("/recovery"); }
  recover(id: string, body: unknown): Promise<AgentIntegrationResult> { return this.call(`/recovery/${encodeURIComponent(id)}`, body); }
  submitStructured(review: ReviewedStructuredSource, requestKey: string): Promise<CodingTask> { return this.call("/structured", { review, requestKey }); }
  async activate(id: string, digest: string): Promise<CodingTask> {
    if (!this.registration) throw new AgentRuntimeError(409, "This Studio observer has no managed restart registration.");
    await this.ensure();
    if (this.registeredHost === undefined) throw new AgentRuntimeError(409, "Use Restart agent host before requesting managed Studio restart.");
    return callAgentHost<CodingTask>(this.endpoint(), `/tasks/${encodeURIComponent(id)}/activate`, { digest, instanceId: this.registration().id });
  }
  private assertGuidedContractHost(info: AgentHostInfo): void {
    if (!info.capabilities?.includes("contract-runs-v1")) throw new AgentRuntimeError(409, "The pinned agent host predates one-click contract runs. Finish retained tasks, then use Restart agent host to activate stage and sequential execution.");
    if (!info.releaseDigest && !info.contractPolicyDigest) return;
    let policyDigest = info.contractPolicyDigest, controlDigest = info.contractControlDigest;
    if (!policyDigest && info.releaseDigest && /^[a-f0-9]{64}$/.test(info.releaseDigest)) {
      if (this.inspectedContractPolicy?.releaseDigest === info.releaseDigest) { policyDigest = this.inspectedContractPolicy.policyDigest; controlDigest = this.inspectedContractPolicy.controlDigest; }
      else try {
        const release = readAgentRuntimeRelease(path.join(this.state, "releases", info.releaseDigest));
        if (release.digest === info.releaseDigest && release.contractToolchain?.policy) {
          policyDigest = release.contractToolchain.policy.digest; controlDigest = release.contractToolchain.control;
          this.inspectedContractPolicy = { releaseDigest: release.digest, policyDigest, ...(controlDigest ? { controlDigest } : {}) };
        }
      } catch { /* An unverifiable release cannot admit a guided run. */ }
    }
    let current: string | undefined, control: string | undefined;
    try { current = portableProofPolicy(projectVerifierRoot(this.root)).digest; control = studioContractControl(path.resolve(__dirname, "../../..")); } catch { /* Report an actionable mismatch. */ }
    // Both the receipts' verifier and Studio's contract code around it must match saved source.
    if (!policyDigest || policyDigest !== current || !controlDigest || controlDigest !== control) throw new AgentRuntimeError(409, "The agent host's pinned contract checker differs from saved Studio source. Finish active work, then use Restart agent host before running contract stages.");
  }
  async submit(request: CodingTaskRequest): Promise<CodingTask> {
    if (request.contract) {
      const info = await this.ping();
      if (!info.capabilities?.includes("contract-proof-v1")) throw new AgentRuntimeError(409, "The pinned agent host predates versioned contract proof. Finish retained tasks, then use Restart agent host to activate this capability.");
      if (request.contractRun) this.assertGuidedContractHost(info);
    }
    try { return await this.call("/tasks", request); } catch (error) {
      if (error instanceof AgentRuntimeError || !["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return this.call("/tasks", request); // Exact idempotency key and intent.
    }
  }
  async action(id: string, action: "cancel" | "resume" | "continue" | "reject" | "approve" | "refresh" | "cleanup", body: unknown = {}): Promise<CodingTask> {
    if (["resume", "continue", "approve", "refresh"].includes(action)) {
      const info = await this.ping();
      if (action === "continue" && body && typeof body === "object" && "contractRun" in body) this.assertGuidedContractHost(info);
      if (!info.capabilities?.includes("contract-proof-v1") && (await this.get(id)).contract) throw new AgentRuntimeError(409, "This retained contract task belongs to an older agent host without versioned proof enforcement. Preserve its candidate and use Restart agent host before renewing or applying it.");
    }
    return this.call(`/tasks/${encodeURIComponent(id)}/${action}`, body);
  }
  permission(id: string, requestId: string, body: unknown): Promise<CodingTask> { return this.call(`/tasks/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, body); }
  close(): void { this.closed = true; this.upgradeController?.close(); } // Closing the observer never stops work.
}

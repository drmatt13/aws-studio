import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { AGENT_RUNTIME_VERSION } from "../../shared/agent-runtime";
import { processIdentity } from "aws-studio/source/identity";
import { closeIpcAuthentication, ipcAuthentication, isNamedPipe, secureSocket, type AuthenticatedIpcRequest } from "../operations/ipc";
import { AgentTaskService, type AgentServiceOptions } from "./service";
import { AgentRuntimeError } from "./store";
import { agentEndpoint, agentRequestLimit, type AgentHostInfo } from "./ipc";
import { integrateApprovedAgentProposal } from "./approved-integration";
import { runProvider } from "./providers";
import { resolveValidationCommand, runValidation } from "./providers/validation";
import { runArchitecturePreview } from "./architecture-preview-runner";
import { readAgentRuntimeRelease, type AgentRuntimeRelease } from "./runtime-release-manifest";
import type { ReviewedStructuredSource } from "./structured-proposal";
import { StudioRuntimeActivation, type StudioRuntimeRegistration, type StudioRuntimeTarget } from "./activation";
import { assertContractOrigin, contractInputDigest, refreshContractContext, validateContractCandidate } from "./contract-validation";
import { finalizeContractStages } from "./contract-finalization";
import { projectRuntime } from "../project-runtime";

declare const __STUDIO_RUNTIME_TARGET__: StudioRuntimeTarget | undefined;
type AgentHostOptions = AgentServiceOptions & { readonly studioRuntimeTarget?: StudioRuntimeTarget };

function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new AgentRuntimeError(400, "Unexpected task action fields.");
  return input as Record<string, unknown>;
}
async function readBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > limit) throw new AgentRuntimeError(413, "Task request is too large."); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
function body(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new AgentRuntimeError(400, "Send a JSON task request."); }
}
function reply(response: ServerResponse, status: number, value: unknown, authentication?: AuthenticatedIpcRequest): void {
  if (response.destroyed) return;
  const plain = JSON.stringify(value), encoded = authentication ? authentication.encodeResponse(plain) : plain;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...authentication?.responseHeaders(status, encoded) }); response.end(encoded);
}

/** Test injection is a constructor seam only; no environment or HTTP fake mode. */
export function nativeAgentOptions(release?: AgentRuntimeRelease, restartStudio?: (instanceId: string) => Promise<void>): AgentServiceOptions {
  const concurrency = Number(process.env.FRAMEWORK_STUDIO_AGENT_CONCURRENCY ?? 1);
  const evaluationCache: NonNullable<Parameters<typeof validateContractCandidate>[0]["evaluationCache"]> = new Map();
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new AgentRuntimeError(422, "Agent concurrency must be an integer from 1 to 4.");
  const requireContractRelease = () => { if (release && (!release.contractToolchain?.policy || !release.contractToolchain.controlDependencyDigest)) throw new AgentRuntimeError(409, "This legacy agent host cannot establish complete contract proof. Preserve retained candidates and explicitly restart the agent host before contract work."); };
  return {
    concurrency,
    canApplyRuntimeChanges: !!release,
    restartStudio,
    runProvider,
    validateContract: options => { requireContractRelease(); return validateContractCandidate({ ...options, evaluationCache }, release?.contractToolchain); },
    contractOrigin: (root, context, signal, onProgress) => { requireContractRelease(); return assertContractOrigin(root, context, release?.contractToolchain, { onProgress }, signal); },
    contractIdentity: (workspace, stage, signal) => { requireContractRelease(); return contractInputDigest(workspace, stage, release?.contractToolchain, signal); },
    contractRefreshContext: (root, stage, decisions, previous, signal) => { requireContractRelease(); return refreshContractContext(root, stage, decisions, release?.contractToolchain, previous, {}, signal); },
    finalizeContract: (workspace, proposal, stages, decisions) => { requireContractRelease(); return finalizeContractStages(workspace, proposal, stages, decisions, release?.contractToolchain); },
    preview: (workspace, proposal, signal, onExecution) => runArchitecturePreview({ workspace, proposal, signal, onExecution, projectorAsset: release?.projector }),
    validate: async options => {
      const toolchain = projectRuntime(options.cwd);
      const command = resolveValidationCommand({ file: options.command.file, args: [...options.command.args] }, toolchain);
      return runValidation({ ...options, provider: "codex", command, toolchain, onEvent: async event => {
        if (typeof event.data.stdout === "string") options.onOutput(event.data.stdout);
        if (typeof event.data.stderr === "string") options.onOutput(event.data.stderr);
        if (event.data.outputTruncated === true) options.onOutput("Validation output exceeded the native capture limit. The displayed log is truncated; the exit status is retained.\n");
      } });
    },
    integrate: integrateApprovedAgentProposal,
  };
}

export async function startAgentHost(root: string, state: string, options?: AgentHostOptions, release?: AgentRuntimeRelease) {
  root = realpathSync(root); state = path.resolve(state);
  const installedTarget = typeof __STUDIO_RUNTIME_TARGET__ === "undefined" ? options?.studioRuntimeTarget : __STUDIO_RUNTIME_TARGET__;
  const runtime = new StudioRuntimeActivation(root, installedTarget);
  const restartStudio = (instanceId: string) => runtime.restart(instanceId);
  const service = new AgentTaskService(root, state, {
    ...(options ?? nativeAgentOptions(release, restartStudio)),
    ownsStudioSource: installedTarget?.installation === root,
    restartStudio: options?.restartStudio ?? restartStudio,
  });
  const owner = processIdentity(randomUUID());
  if (!service.store.claimHost(owner)) { await service.close(); throw new AgentRuntimeError(409, "An agent host already owns this checkout's task state."); }
  const socket = agentEndpoint(root, state);
  const authentication = ipcAuthentication(socket, `agents:${AGENT_RUNTIME_VERSION}`);
  const policy = release?.contractToolchain?.policy;
  const info: AgentHostInfo = { version: AGENT_RUNTIME_VERSION, root, state, pid: process.pid, identity: owner, capabilities: ["contract-propagation-v1", "contract-runs-v1", ...(!release || policy && release.contractToolchain?.controlDependencyDigest ? ["contract-proof-v1"] : []), ...(installedTarget ? ["studio-restart-target-v1"] : [])], ...(release ? { releaseDigest: release.digest } : {}), ...(policy ? { contractPolicyDigest: policy.digest } : {}), ...(release?.contractToolchain?.control ? { contractControlDigest: release.contractToolchain.control } : {}) };
  if (release && release.protocol !== AGENT_RUNTIME_VERSION) { service.store.releaseHost(owner); await service.close(); throw new AgentRuntimeError(409, "Pinned host protocol does not match its executable."); }
  let closing = false;
  let closeOwned!: () => Promise<void>;
  const server = createServer((request, response) => {
    let authenticated: AuthenticatedIpcRequest | undefined;
    void (async () => {
      const limit = agentRequestLimit(request.url ?? "/");
      const wire = await readBody(request, process.platform === "win32" ? Math.ceil(limit * 4 / 3) + 4096 : limit);
      authenticated = authentication.authenticateRequest(request, wire);
      const raw = authenticated.body;
      if (Buffer.byteLength(raw) > limit) throw new AgentRuntimeError(413, "Task request is too large.");
      if (request.headers["x-agent-version"] !== String(AGENT_RUNTIME_VERSION)) throw new AgentRuntimeError(409, "Incompatible agent runtime protocol.");
      if (closing) throw new AgentRuntimeError(503, "The agent host is closing.");
      const url = new URL(request.url ?? "/", "http://agent.local");
      if (request.method === "GET" && url.pathname === "/ping") return info;
      if (request.method === "POST" && url.pathname === "/runtime/drain") {
        const input = object(body(raw), ["requestId", "targetDigest", "expectedToken"]);
        if (typeof input.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(input.requestId) || typeof input.targetDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.targetDigest) || input.expectedToken !== owner.token) throw new AgentRuntimeError(409, "Reconnect to this exact host before requesting its upgrade.");
        const target = readAgentRuntimeRelease(path.join(state, "releases", input.targetDigest));
        if (!release || target.protocol !== AGENT_RUNTIME_VERSION) throw new AgentRuntimeError(409, "The new host protocol is incompatible; no running host was stopped.");
        service.beginUpgrade(); closing = true;
        response.once("finish", () => { void closeOwned(); });
        return { draining: true, requestId: input.requestId, targetDigest: target.digest };
      }
      if (request.method === "GET" && url.pathname === "/tasks") return { tasks: service.list() };
      if (request.method === "POST" && url.pathname === "/tasks") return service.submit(body(raw));
      if (request.method === "POST" && url.pathname === "/runtime/register") { runtime.register(body(raw) as StudioRuntimeRegistration); return { registered: true }; }
      if (request.method === "POST" && url.pathname === "/structured") {
        const input = object(body(raw), ["requestKey", "review"]);
        if (typeof input.requestKey !== "string") throw new AgentRuntimeError(400, "A structured handoff needs an idempotency key.");
        return service.submitStructured(input.review as ReviewedStructuredSource, input.requestKey);
      }
      if (request.method === "GET" && url.pathname === "/recovery") return service.recovery();
      const recovery = /^\/recovery\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "POST" && recovery) {
        const input = object(body(raw), ["approval", "fingerprint"]);
        if (typeof input.approval !== "string" || input.fingerprint !== undefined && typeof input.fingerprint !== "string") throw new AgentRuntimeError(400, "Choose an explicit source recovery action.");
        return service.recover(recovery[1]!, input.approval, input.fingerprint as string | undefined);
      }
      const route = /^\/tasks\/([0-9a-f-]{36})(?:\/(events|proposal|cancel|resume|continue|reject|approve|refresh|cleanup|activate|permissions)(?:\/([^/]+))?)?$/.exec(url.pathname);
      if (!route) throw new AgentRuntimeError(404, "Coding task endpoint not found.");
      const [, id, action, requestId] = route;
      if (request.method === "GET") {
        if (!action) return service.get(id!);
        if (action === "proposal") return service.proposal(id!);
        if (action === "events") return service.events(id!, Number(url.searchParams.get("after") ?? 0));
      } else if (request.method === "POST") {
        const input = object(body(raw), action === "continue" ? ["digest", "decisions", "contractRun"] : action === "approve" || action === "refresh" ? ["digest"] : action === "activate" ? ["digest", "instanceId"] : action === "permissions" ? ["allow"] : []);
        if (action === "cancel") return service.cancel(id!);
        if (action === "resume") return service.resume(id!);
        if (action === "continue" && typeof input.digest === "string") return service.continueContract(id!, input.digest, input.decisions, input.contractRun);
        if (action === "cleanup") return service.cleanup(id!);
        if (action === "reject") return service.reject(id!);
        if (action === "approve" && typeof input.digest === "string") return service.approve(id!, input.digest);
        if (action === "refresh" && typeof input.digest === "string") return service.refresh(id!, input.digest);
        if (action === "activate" && typeof input.digest === "string" && typeof input.instanceId === "string") return service.activate(id!, input.digest, input.instanceId);
        if (action === "permissions" && requestId && typeof input.allow === "boolean") return service.answerPermission(id!, decodeURIComponent(requestId), input.allow);
        throw new AgentRuntimeError(400, "Choose a valid task action.");
      }
      throw new AgentRuntimeError(405, "Unsupported task request method.");
    })().then(value => reply(response, 200, value, authenticated), error => reply(response, typeof error?.status === "number" ? error.status : 500, { error: error instanceof Error ? error.message : "Agent host request failed." }, authenticated));
  });
  try {
    // Only the reconciled SQLite owner may remove its abandoned endpoint.
    try { if (!isNamedPipe(socket)) { const stat = lstatSync(socket); if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new AgentRuntimeError(422, "Agent endpoint has an unexpected owner or type."); unlinkSync(socket); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.off("error", reject); resolve(); }); });
    secureSocket(socket); service.start();
  } catch (error) { server.close(); closeIpcAuthentication(socket); service.store.releaseHost(owner); await service.close(); throw error; }
  let disposal: Promise<void> | undefined;
  closeOwned = (): Promise<void> => {
    if (disposal) return disposal;
    closing = true;
    disposal = (async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      closeIpcAuthentication(socket);
      // Closing drains owned imports before releasing the host claim. Provider
      // pipes remain tethered to this host if it is killed unexpectedly.
      await service.close(() => service.store.releaseHost(owner));
    })();
    return disposal;
  };
  return { service, info, socket, close: closeOwned };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const [root, state, releaseDirectory] = process.argv.slice(2);
  if (!root || !state) process.exitCode = 2;
  else void Promise.resolve().then(() => startAgentHost(root, state, undefined, releaseDirectory ? readAgentRuntimeRelease(releaseDirectory) : undefined)).then(host => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void host.close().then(() => process.exit(0), () => process.exit(1)); });
  }, error => { process.exitCode = error instanceof AgentRuntimeError && error.status === 409 ? 0 : 1; });
}

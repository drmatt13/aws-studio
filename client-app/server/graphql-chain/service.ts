import { fork, type ChildProcess } from "node:child_process";
import { sandboxedChainEvaluation } from "./sandbox";
import { projectRuntime, projectRuntimeEnvironment } from "../project-runtime";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChainNode, Diagnostic, GraphQLChain } from "aws-studio/contract-chain/graphql-chain";
import { isGraphQLChainResponse } from "aws-studio/contract-chain/graphql-chain-response";
import { EditError } from "aws-studio/source/io";
import { GraphQLChainInspector, type ChainObservation, type ChainServiceDependencies } from "aws-studio/contract-chain/inspector";
import { readEvidenceCache } from "./evidence-cache";
import { CHAIN_DEPENDENCIES, unavailableConfidence, unavailableVerification } from "aws-studio/contract-chain/confidence";
import { ChainInspectionError, inspectionFailure, readInspectionDiagnostic } from "aws-studio/contract-chain/inspection-diagnostics";
import { unavailableProofView } from "aws-studio/contract-chain/proof";
import { PROOF_STAGES, PROOF_PREDECESSORS, type ProofStage } from "aws-studio/contract-chain/contract-proof";
import { CONTRACT_INSPECTION_TIMEOUT_MS, inspectionProgressMessage, isInspectionPhase, type InspectionPhase } from "aws-studio/contract-chain/inspection-budget";

export { chainInputIdentity, recordContents, reviewRecordPath, REVIEW_FILE, PRISMA_FILE, CODEGEN_COMMAND } from "aws-studio/contract-chain/inspector";
export type { ChainObservation, ChainServiceDependencies } from "aws-studio/contract-chain/inspector";
export type ChainInspectionHost = Pick<ChildProcess, "pid" | "exitCode" | "on" | "once" | "send" | "kill">;
class RetryInspectionAfterDependencyChange extends ChainInspectionError {}
export interface BackgroundChainDependencies extends ChainServiceDependencies {
  /** Disposable fixture seam; production uses only the fixed inspection child. */
  readonly background?: () => Promise<ChainObservation>;
  /** Deterministic IPC fixture seam; never accepted through HTTP or environment inputs. */
  readonly createHost?: () => ChainInspectionHost;
}

/** HTTP reads touch memory and one bounded durable cache, never the checkout tree. */
export class GraphQLChainService {
  readonly root: string;
  readonly ownWrites = new Map<string, string>();
  private readonly inline?: GraphQLChainInspector;
  private child?: ChainInspectionHost;
  private hydration?: Promise<void>;
  private latest?: ChainObservation;
  private sourceNodes?: readonly ChainNode[];
  private fingerprints: NonNullable<GraphQLChain["fingerprints"]> = "checking";
  private retained: readonly ProofStage[] = [];
  private checkedAt?: string;
  private status: "checking" | "ready" | "stale" | "failed" = "stale";
  private problem?: string;
  private diagnostic?: Diagnostic;
  private watching = true;
  private generation = 0;
  private watchGeneration = 0;
  private verifiedWatchGeneration = -1;
  private pending?: Promise<ChainObservation>;
  private request?: { id: number; resolve(value: ChainObservation): void; reject(error: Error): void; timer: NodeJS.Timeout };
  private progress?: { id: number; phase: InspectionPhase; startedAt: number; phaseStartedAt: number; retry: boolean };
  private nextId = 0;
  private closed = false;

  constructor(root: string, private readonly dependencies: BackgroundChainDependencies = {}) {
    this.root = realpathSync(root);
    if (dependencies.identity || dependencies.evaluate) this.inline = new GraphQLChainInspector(this.root, { ...dependencies, evaluate: dependencies.evaluate ?? sandboxedChainEvaluation });
  }
  /** Explicit CLI/review callers may await full evidence; ordinary page reads use read(). */
  async load(fresh = false): Promise<GraphQLChain> { return (await this.inspect(fresh)).chain; }
  async inspect(fresh = false): Promise<ChainObservation> {
    if (this.closed) throw new EditError(409, "The GraphQL reader is closed.");
    if (this.inline) return this.inline.inspect(fresh);
    await this.hydrate();
    return this.start(fresh);
  }
  /** Re-attest checked content for apply; this path cannot capture or evaluate source. */
  async revalidate(): Promise<ChainObservation> {
    if (this.closed) throw new EditError(409, "The GraphQL reader is closed.");
    if (this.inline) return this.inline.inspect(false, true);
    if (this.pending) throw new EditError(409, "A check is still running. Wait before recording this review.");
    return this.start(false, true);
  }
  /** Reuse the visible check to plan renewal. The review writer re-attests it before publishing. */
  async observeForRenewal(expectedRevision: string): Promise<ChainObservation> {
    const latest = this.latest;
    if (!this.closed && this.status === "ready" && latest?.proofInput && latest.chain.revision === expectedRevision) return latest;
    return this.inspect();
  }
  async read(fresh = false, refresh = false): Promise<GraphQLChain> {
    if (this.closed) throw new EditError(409, "The GraphQL reader is closed.");
    if (this.inline) return this.load(fresh);
    await this.hydrate();
    // Source hashes are captured in the isolated watcher. Only an explicit
    // check runs dependency verification and executable validation.
    if (!this.dependencies.background && !this.dependencies.createHost) this.ensureChild();
    if (fresh || refresh) void this.start(fresh).catch(() => {});
    return this.presentation();
  }
  /** Cheap invalidation from known source publication; full evidence is recomputed in the child. */
  invalidate(message = "Saved source changed. Checking is required before using this evidence."): void {
    this.retained = [];
    this.progress = undefined;
    this.generation++; this.status = "stale"; this.problem = message; this.diagnostic = { code: "INSPECTION_STALE", message };
  }
  private hydrate(): Promise<void> {
    return this.hydration ??= readEvidenceCache(this.root).then(value => {
      if (!value || this.latest || this.closed) return;
      this.latest = value.observation; this.checkedAt = value.checkedAt;
      this.status = "stale"; this.problem = "Restored the last check. Choose Check again to verify current saved source.";
    });
  }
  private start(fresh: boolean, cacheOnly = false): Promise<ChainObservation> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.status = "checking"; this.problem = undefined; this.diagnostic = undefined;
    const operation = Promise.resolve().then(() => this.dependencies.background ? this.dependencies.background() : this.runChild(fresh, cacheOnly)).then(observation => {
      if (this.closed || generation !== this.generation) throw new EditError(409, "Saved source changed while checking. Check again.");
      this.latest = observation; this.checkedAt = new Date().toISOString(); this.status = this.watching ? "ready" : "failed";
      if (!this.watching) { this.problem = "Source watching is unavailable. Current source cannot be tracked; use Check again for an explicit inspection."; this.diagnostic = { code: "SOURCE_WATCH_UNAVAILABLE", message: this.problem }; }
      return observation;
    }).catch(error => {
      if (!this.closed) { this.retained = []; this.status = generation === this.generation ? "failed" : "stale"; this.diagnostic = inspectionFailure(error); this.problem = this.diagnostic.message; }
      throw error;
    }).finally(() => { if (this.pending === operation) { this.pending = undefined; this.progress = undefined; } });
    this.pending = operation;
    return operation;
  }
  private ensureChild(): ChainInspectionHost {
    if (!this.child) {
      const file = fileURLToPath(new URL("./inspection-host.ts", import.meta.url));
      const child = this.dependencies.createHost?.() ?? (() => {
        const runtime = projectRuntime(this.root);
        return fork(file, [this.root], { cwd: this.root, execPath: runtime.node, execArgv: ["--import", "tsx"],
          env: projectRuntimeEnvironment(runtime), stdio: ["ignore", "ignore", "ignore", "ipc"] });
      })();
      this.child = child;
      this.retained = [];
      this.fingerprints = "checking";
      this.watchGeneration = 0; this.verifiedWatchGeneration = -1; this.watching = true;
      child.on("message", (value: any) => {
        if (this.child !== child) return;
        if (value?.type === "sources") {
          if (Number.isSafeInteger(value.generation) && value.generation >= this.watchGeneration) {
            this.sourceNodes = value.nodes ?? undefined;
            this.fingerprints = this.sourceNodes ? "ready" : "failed";
            if (this.watching && value.generation === this.watchGeneration && value.basisRevision === this.latest?.chain.revision) this.retained = this.validRetained(value.retained);
          }
          return;
        }
        if (value?.type === "invalidated") {
          if (!Number.isSafeInteger(value.generation) || value.generation <= this.verifiedWatchGeneration) return;
          this.retained = [];
          this.watchGeneration = Math.max(this.watchGeneration, value.generation);
          this.fingerprints = "checking";
          this.sourceNodes = undefined;
          this.status = this.pending ? "checking" : "stale";
          this.problem = this.pending ? undefined : "Saved source changed. Checking is required before using this evidence.";
          this.diagnostic = this.pending ? undefined : { code: "INSPECTION_STALE", message: this.problem! };
          return;
        }
        if (value?.type === "watch-unavailable") {
          this.retained = [];
          this.sourceNodes = undefined;
          this.fingerprints = "failed";
          this.watching = false;
          this.status = this.pending ? "checking" : "failed";
          this.problem = this.pending ? undefined : "Source watching is unavailable. Current source cannot be tracked; use Check again for an explicit inspection.";
          this.diagnostic = this.pending ? undefined : { code: "SOURCE_WATCH_UNAVAILABLE", message: this.problem! };
          return;
        }
        const request = this.request;
        if (!request || value?.id !== request.id) return;
        if (value.type === "progress") {
          if (this.status === "checking" && isInspectionPhase(value.phase) && this.progress?.id === request.id && this.progress.phase !== value.phase) this.progress = { ...this.progress, phase: value.phase, phaseStartedAt: Date.now() };
          return;
        }
        clearTimeout(request.timer); this.request = undefined; this.progress = undefined;
        if (value.type === "result" && Number.isSafeInteger(value.generation) && value.generation >= this.watchGeneration && isGraphQLChainResponse(value.observation?.chain) && typeof value.observation.evaluationRevision === "string") {
          this.watchGeneration = value.generation; this.verifiedWatchGeneration = value.generation;
          this.watching = value.observed === true;
          this.sourceNodes = this.watching ? value.observation.chain.nodes : undefined;
          this.fingerprints = this.watching ? "ready" : "failed";
          this.retained = this.watching ? this.validRetained(value.retained, value.observation.chain) : []; request.resolve(value.observation);
        }
        else {
          const diagnostic = value.type === "failed" ? readInspectionDiagnostic(value.diagnostic) : undefined;
          if (value.restartOnDependencyChange === true && diagnostic?.code === "DEPENDENCIES_CHANGED_DURING_CHECK") request.reject(new RetryInspectionAfterDependencyChange(409, diagnostic));
          else request.reject(new ChainInspectionError(409, diagnostic ?? { code: "INSPECTION_RESULT_INVALID", message: "Background GraphQL inspection failed or returned an obsolete result. Check again." }));
        }
      });
      const stopped = () => {
        if (this.child !== child) return;
        this.child = undefined; this.progress = undefined;
        this.sourceNodes = undefined;
        this.fingerprints = "failed";
        if (!this.closed) this.invalidate("Source watching stopped. Choose Check again to verify saved source.");
        if (this.request) { clearTimeout(this.request.timer); this.request.reject(new ChainInspectionError(503, { code: "INSPECTION_PROCESS_EXIT", message: "The GraphQL inspection process stopped. Check again." })); this.request = undefined; }
      };
      child.once("error", stopped); child.once("exit", stopped);
    }
    return this.child;
  }
  private async runChild(fresh: boolean, cacheOnly = false): Promise<ChainObservation> {
    const child = this.ensureChild(), startedAt = Date.now();
    try { return await this.inspectChild(child, fresh, cacheOnly, startedAt, false); }
    catch (error) {
      if (!(error instanceof RetryInspectionAfterDependencyChange) || cacheOnly || this.closed || this.child !== child || Date.now() - startedAt >= CONTRACT_INSPECTION_TIMEOUT_MS) throw error;
      // The first host already loaded the old generation's control modules.
      // Its watcher/cache cannot be repurposed as proof of the new generation.
      this.child = undefined;
      this.sourceNodes = undefined;
      child.kill("SIGTERM");
      return this.inspectChild(this.ensureChild(), fresh, false, startedAt, true);
    }
  }
  private inspectChild(child: ChainInspectionHost, fresh: boolean, cacheOnly: boolean, startedAt: number, retry: boolean): Promise<ChainObservation> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.request = undefined; this.progress = undefined; child.kill("SIGTERM"); reject(new ChainInspectionError(503, { code: "INSPECTION_TIMEOUT", message: "Background GraphQL inspection timed out before every check finished. Check dependencies and check again." }));
      }, Math.max(1, startedAt + CONTRACT_INSPECTION_TIMEOUT_MS - Date.now()));
      this.request = { id, resolve, reject, timer };
      const now = Date.now();
      this.progress = { id, phase: "starting", startedAt, phaseStartedAt: now, retry };
      child.send({ type: "inspect", id, fresh, cacheOnly }, error => { if (error && this.request?.id === id) { clearTimeout(timer); this.request = undefined; this.progress = undefined; reject(new ChainInspectionError(503, { code: "INSPECTION_PROCESS_UNAVAILABLE", message: "The GraphQL inspection process is unavailable. Check again." })); } });
    });
  }
  private validRetained(value: unknown, chain = this.latest?.chain): readonly ProofStage[] {
    if (!chain || !Array.isArray(value) || value.length > 4 || value.some(stage => !PROOF_STAGES.includes(stage))) return [];
    const kept: ProofStage[] = [];
    for (const stage of PROOF_STAGES) if (value.includes(stage) && chain.proof.stages.find(item => item.stage === stage)?.status === "verified" && PROOF_PREDECESSORS[stage].every(previous => kept.includes(previous))) kept.push(stage);
    return kept;
  }
  private presentation(): GraphQLChain {
    if (this.latest && this.status === "ready") return { ...this.latest.chain, nodes: this.sourceNodes ?? this.latest.chain.nodes, fingerprints: "ready", inspection: { status: "ready", checkedAt: this.checkedAt } };
    const progress = this.progress;
    const message = this.problem ?? (this.status === "checking" ? progress ? `${progress.retry ? "Retrying after dependency observation changed. " : ""}${inspectionProgressMessage(progress.phase, progress.startedAt, progress.phaseStartedAt, Date.now())}` : "Checking saved source in the background. Studio remains available." : "No current contract check. Choose Check again to inspect saved source.");
    const diagnostics: Diagnostic[] = [this.diagnostic ?? { code: this.status === "checking" ? "INSPECTION_CHECKING" : "INSPECTION_STALE", message }];
    const unknown = { status: "unknown" as const, diagnostics }, unavailable = { status: "unavailable" as const, diagnostics };
    const confidence = unavailableConfidence(diagnostics, this.status === "stale" || this.status === "checking" ? "stale" : "unavailable");
    const nodes = this.sourceNodes ?? this.latest?.chain.nodes ?? [
      { id: "prisma" as const, caption: "Database contract", name: "contract.prisma", source: "packages/database/prisma/contract.prisma", reviewedAgainst: null },
      { id: "pothos" as const, caption: "Pothos schema", name: "graphql-api", source: "compute/http/graphql-api/", reviewedAgainst: null },
      { id: "generated" as const, caption: "Generated GraphQL", name: "client-app/src/api/generated", source: "client-app/src/api/generated/", reviewedAgainst: null },
      { id: "client" as const, caption: "Client operations", name: "client-app/src/api", source: "client-app/src/api/", reviewedAgainst: null },
    ];
    const retained = this.watching && this.status !== "failed" ? this.retained : [];
    const previous = this.latest?.chain, proof = unavailableProofView(message, previous?.proof);
    const verification = { ...unavailableVerification(diagnostics),
      ...(previous && retained.includes("database") ? { database: previous.verification.database } : {}),
      ...(previous && retained.includes("api") ? { api: previous.verification.api } : {}),
      ...(previous && retained.includes("client") ? { client: previous.verification.client, consumers: previous.verification.consumers, integration: previous.verification.integration } : {}),
    };
    const projectedProof = { ...proof, stages: proof.stages.map(stage => retained.includes(stage.stage) ? previous!.proof.stages.find(item => item.stage === stage.stage)! : stage) };
    const unknownLinks: GraphQLChain["links"] = [
      { id: "prisma-pothos", kind: "reviewed", state: unknown, confidence, models: {}, actions: [] },
      { id: "pothos-generated", kind: "derived", state: unknown, confidence, checks: { schema: unavailable, documents: unavailable, "generated-files": unavailable }, actions: [] },
      { id: "generated-client", kind: "derived-then-reviewed", state: unknown, confidence, validation: unavailable, actions: [] },
    ];
    const stages: readonly ProofStage[] = ["api", "codegen", "client"];
    const links = unknownLinks.map((link, index) => retained.includes(stages[index]!) && previous?.links[index]?.confidence.status === "verified" ? { ...previous.links[index]!, actions: [] } : link);
    return { version: 3, proof: projectedProof, revision: this.latest?.chain.revision ?? createHash("sha256").update(this.root).digest("hex"), record: this.latest?.chain.record ?? "missing",
      dependencies: CHAIN_DEPENDENCIES, verification,
      ...(this.latest ? { history: { revision: this.latest.chain.revision, checkedAt: this.checkedAt, nodes: this.latest.chain.nodes, links: this.latest.chain.links.map(link => ({ ...link, actions: [] })) } } : {}),
      fingerprints: this.fingerprints, inspection: { status: this.status, checkedAt: this.checkedAt, message, diagnostics }, nodes: nodes.map(node => ({ ...node, fingerprint: this.sourceNodes?.find(item => item.id === node.id)?.fingerprint ?? unavailable })), links };
  }
  async dispose(): Promise<void> {
    this.closed = true; this.progress = undefined;
    if (this.inline) { await this.inline.dispose(); return; }
    const child = this.child;
    if (child) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5000);
      await exited; clearTimeout(timer);
    }
    await this.pending?.catch(() => {});
  }
}

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ChainAction, ChainLink, ChainVerification, CheckEvidence, Diagnostic, Fingerprint, GraphQLChain, GraphQLChainReviewRecord, PrismaModelShape, ReviewState, SdlSurface } from "./graphql-chain";
import { EditError } from "../source/errors";
import { readSourceManifest } from "../source/workspace";
import { canonicalPrisma, diffPrisma, diffSdl, fingerprint, parseReviewRecord, sdlFingerprint, sdlSurface } from "./core";
import { ChainEvaluationError, chainPublicationVersion, chainWorkerBundle, runtimeContractHash } from "./evaluation";
import type { ChainEvaluation } from "./worker";
import { DependencyObservationChangedError, dependencyContentIdentity, dependencyMetadata, dependencyMetadataAsync } from "./dependencies";
import { CHAIN_DEPENDENCIES, confidence, diagnostic, unavailableVerification } from "./confidence";
import { CONTRACT_SOURCE_PATHS, contractProofNodeProblem, portableProofIdentity, portableProofPolicy, projectVerifierRoot, verifierPackageRoot, type PortableProofIdentity } from "./portable-identity";
import { buildContractProof, unavailableProofView, type ProofBuildInput, type ProofObservation } from "./proof";
import type { ProofPolicy } from "./contract-proof";
import { loadCIObservation, compareCIObservation } from "./ci-observation";
import { CONTRACT_EVALUATION_TIMEOUT_MS, type InspectionPhase } from "./inspection-budget";
import { sourceFingerprints } from "./source-fingerprints";
import { assertCapturedAuthoredDocuments } from "./authored-documents";
import { assertContractInspectionNode, ChainInspectionError } from "./inspection-diagnostics";

// Source-mode processes can import this module before constructing an inspector.
// A pinned native host uses its release's portable control digest instead.
function loadedVerifierControl() {
  if (contractProofNodeProblem()) return;
  const release = verifierPackageRoot();
  // A detached host runs its pinned worker and supplies the immutable policy separately.
  if (!existsSync(path.join(release, "scripts/contract-chain/inspector.ts"))) return;
  let installation = release;
  while (!existsSync(path.join(installation, "package-lock.json"))) {
    const parent = path.dirname(installation);
    if (parent === installation) return { installation, release, metadata: undefined, policy: undefined };
    installation = parent;
  }
  return { installation, release,
    metadata: (() => { try { return dependencyMetadata(installation); } catch { return undefined; } })(),
    policy: (() => { try { return portableProofPolicy(release); } catch { return undefined; } })(),
  };
}
const loadedControl = loadedVerifierControl();

export const REVIEW_FILE = "graphql-chain.review.json" as const;
export const PRISMA_FILE = CONTRACT_SOURCE_PATHS.database;
export const CODEGEN_COMMAND = "npm run codegen";
export interface ChainObservation {
  readonly evaluationRevision: string;
  readonly chain: GraphQLChain;
  readonly models: Readonly<Record<string, PrismaModelShape>> | null;
  readonly surface: SdlSurface | null;
  readonly record: GraphQLChainReviewRecord | null;
  readonly recordText: string | null;
  readonly bindings: { readonly api: string | null; readonly client: string | null; readonly upstream: string | null };
  /** Transient authoritative capture; deliberately omitted from durable history caches. */
  readonly proofInput?: ProofBuildInput;
  readonly proof?: ProofObservation;
}
export interface ChainServiceDependencies {
  /** Trusted host phase callback; never sourced from project output. */
  readonly onProgress?: (phase: InspectionPhase) => void;
  /** An originating task can refuse obsolete source before starting executable checks. */
  readonly expectedRevision?: string;
  /** Owner cancellation applies to the entire inspection, including identity work. */
  readonly signal?: AbortSignal;
  readonly evaluate?: (root: string, signal: AbortSignal) => Promise<ChainEvaluation>;
  readonly identity?: (root: string, signal?: AbortSignal) => Promise<string>;
  /** Host release asset seam; never an HTTP input or authored project module. */
  readonly workerBundle?: () => Promise<Uint8Array>;
  readonly portableIdentity?: (root: string, signal?: AbortSignal) => Promise<PortableProofIdentity>;
  readonly proofPolicy?: ProofPolicy;
  /** Installed checker files can be rooted separately from project inputs. */
  readonly proofPolicyRoot?: string;
  /** Portable control dependencies sealed into a native host release. */
  readonly proofDependencyDigest?: string;
}

/** One fixed root authority, including safe absence before exclusive creation. */
export function reviewRecordPath(root: string): string {
  const canonical = realpathSync(root), file = path.join(canonical, REVIEW_FILE);
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 * 1024 || realpathSync(file) !== file) throw new EditError(422, "The GraphQL review record must be a bounded regular file without links.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return file;
}
export function recordContents(root: string): string | null {
  reviewRecordPath(root);
  return fixedSourceText(root, REVIEW_FILE, 2 * 1024 * 1024);
}
function fixedSourceText(root: string, relative: string, limit: number): string | null {
  let file = realpathSync(root);
  for (const component of relative.split("/")) {
    file = path.join(file, component);
    try { if (lstatSync(file).isSymbolicLink()) throw new EditError(422, "A fixed GraphQL source input uses a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  let descriptor: number;
  try { descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new EditError(422, "A fixed GraphQL source input is not a bounded regular file.");
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const size = readSync(descriptor, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(descriptor);
    if (count !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new EditError(409, "A GraphQL source input changed while reading. Check again.");
    return bytes.subarray(0, count).toString("utf8");
  } finally { closeSync(descriptor); }
}
/** Host orchestration supplies the selected project version when it executes the worker out of process. */
export async function chainInputIdentity(root: string, workerBundle?: Uint8Array, signal?: AbortSignal, nodeVersion = process.version): Promise<string> {
  signal?.throwIfAborted();
  let contract = "missing";
  try { contract = runtimeContractHash(root); } catch { /* The evaluation reports unavailable artifacts. */ }
  // Review evidence changes the response revision, but cannot change evaluated SDL.
  const manifest = readSourceManifest(root);
  assertCapturedAuthoredDocuments(root, manifest.files);
  const source = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name !== REVIEW_FILE));
  const dependencies = await dependencyContentIdentity(root, signal);
  const worker = workerBundle ?? await chainWorkerBundle();
  signal?.throwIfAborted();
  return fingerprint([source, dependencies, contract, Buffer.from(worker).toString("base64"), nodeVersion]);
}
const unavailable = (code: string, message: string): Diagnostic[] => [{ code, message }];
const available = (value: string): Fingerprint => ({ status: "available", value });
const unknownFingerprint = (diagnostics: readonly Diagnostic[]): Fingerprint => ({ status: "unavailable", diagnostics });
const check = (status: "passed" | "failed" | "unavailable", diagnostics: readonly Diagnostic[] = []): CheckEvidence => status === "passed" ? { status } : { status, diagnostics };

type ReviewedSources = PortableProofIdentity["files"]["api"];

function changedInputs(before: ReviewedSources | undefined, after: ReviewedSources, layer: string): Diagnostic[] {
  if (!before) return [];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(name => before[name] !== after[name]).slice(0, 20)
    .map(file => diagnostic("IMPLEMENTATION_INPUT_CHANGED", `${layer} input ${Object.hasOwn(after, file) ? "changed" : "was removed"}. Reconcile the implementation and run its independent checks before renewing review.`, file));
}

function verificationAvailable(value: ChainVerification): boolean {
  return Object.values(value).every(check => check.status === "passed");
}

/** Expensive inspection runs in the dedicated host, never in an HTTP request's process. */
export class GraphQLChainInspector {
  readonly root: string;
  readonly ownWrites = new Map<string, string>();
  private pending?: Promise<ChainObservation>;
  private cached?: { identity: string; value: ChainEvaluation };
  private controller?: AbortController;
  private closed = false;
  private readonly baselineController = new AbortController();
  private reviewedSources: { api?: ReviewedSources; client?: ReviewedSources } = {};
  private get policyRoot(): string {
    return this.dependencies.proofPolicyRoot ?? (this.dependencies.proofPolicy ? projectVerifierRoot(this.root) : verifierPackageRoot());
  }
  private readonly appliedPolicy?: ProofPolicy;
  private readonly appliedDependencies?: string | Promise<string | undefined>;
  constructor(root: string, private readonly dependencies: ChainServiceDependencies & { readonly evaluate: NonNullable<ChainServiceDependencies["evaluate"]> }) {
    this.root = realpathSync(root);
    if (!dependencies.portableIdentity && !contractProofNodeProblem()) {
      try { this.appliedPolicy = dependencies.proofPolicy ?? portableProofPolicy(this.policyRoot); this.appliedDependencies = loadedControl?.installation === this.root ? loadedControl.metadata : dependencyMetadataAsync(this.root, dependencies.signal ? AbortSignal.any([dependencies.signal, this.baselineController.signal]) : this.baselineController.signal).catch(() => undefined); }
      catch { /* Report unavailable when explicitly checked. */ }
    }
  }
  async load(fresh = false): Promise<GraphQLChain> { return (await this.inspect(fresh)).chain; }
  inspect(fresh = false, cacheOnly = false): Promise<ChainObservation> {
    if (this.closed) return Promise.reject(new EditError(409, "The GraphQL reader is closed."));
    if (this.dependencies.signal?.aborted) return Promise.reject(this.dependencies.signal.reason);
    if (this.pending) return this.pending;
    const controller = new AbortController();
    this.controller = controller;
    const signal = this.dependencies.signal ? AbortSignal.any([this.dependencies.signal, controller.signal]) : controller.signal;
    const operation = this.inspectOwned(fresh, cacheOnly, signal);
    this.pending = operation;
    void operation.finally(() => {
      if (this.pending === operation) this.pending = undefined;
      if (this.controller === controller) this.controller = undefined;
      if (signal.aborted) this.cached = undefined;
    }).catch(() => {});
    return operation;
  }
  private async inspectOwned(fresh: boolean, cacheOnly: boolean, signal: AbortSignal): Promise<ChainObservation> {
    signal.throwIfAborted();
    if (!this.dependencies.portableIdentity) assertContractInspectionNode();
    const bundle = this.dependencies.workerBundle ?? chainWorkerBundle;
    const identify = this.dependencies.identity ?? (async (root: string, signal?: AbortSignal) => chainInputIdentity(root, await bundle(), signal));
    this.dependencies.onProgress?.("source");
    let identity: string;
    try { identity = await identify(this.root, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof DependencyObservationChangedError) throw error;
      throw new ChainInspectionError(422, {
        code: "SAVED_SOURCE_CAPTURE_FAILED",
        message: "Studio could not capture the saved source and dependency inputs. Resolve linked or unreadable files and check installed dependencies, then check again.",
      });
    }
    signal.throwIfAborted();
    const publicationVersion = chainPublicationVersion(this.root);
    if (cacheOnly && this.cached?.identity !== identity) throw new EditError(409, "Source changed. Check again before recording this review.");
    let models: Readonly<Record<string, PrismaModelShape>> | null = null, prismaDiagnostics: readonly Diagnostic[] = [];
    try {
      const source = fixedSourceText(this.root, PRISMA_FILE, 512 * 1024);
      if (source === null) throw new Error("The saved Prisma contract is missing.");
      const parsed = canonicalPrisma(source);
      prismaDiagnostics = parsed.diagnostics;
      if (!prismaDiagnostics.length) models = parsed.models;
    } catch { prismaDiagnostics = unavailable("PRISMA_READ", "Cannot read the saved Prisma contract. Check packages/database/prisma/contract.prisma."); }
    let record: GraphQLChainReviewRecord | null = null, recordText: string | null = null;
    let recordState: GraphQLChain["record"] = "missing", recordDiagnostics: readonly Diagnostic[] = [];
    try {
      recordText = recordContents(this.root);
      if (recordText !== null) { recordState = "available"; record = parseReviewRecord(recordText); }
    } catch { recordState = "invalid"; recordDiagnostics = unavailable("REVIEW_RECORD", "The GraphQL review record is invalid, unsupported or linked. Resolve graphql-chain.review.json in your editor; it was not overwritten."); }
    const revision = fingerprint([identity, recordText]);
    if (this.dependencies.expectedRevision !== undefined && revision !== this.dependencies.expectedRevision) {
      throw new EditError(409, "Saved contract source or review evidence changed. Check the Contract Chain again before starting propagation.");
    }
    let evaluated: ChainEvaluation;
    const evaluationController = new AbortController();
    const evaluationSignal = AbortSignal.any([signal, evaluationController.signal]);
    const timer = setTimeout(() => evaluationController.abort(), CONTRACT_EVALUATION_TIMEOUT_MS);
    try {
      const appliedDependencies = await this.appliedDependencies;
      evaluationSignal.throwIfAborted();
      if (!this.dependencies.portableIdentity && (!this.appliedPolicy || portableProofPolicy(this.policyRoot).digest !== this.appliedPolicy.digest)) throw new ChainEvaluationError("CHECKER_POLICY_RESTART_REQUIRED", "The running checker policy is missing or changed. Restart Studio or the pinned agent host before establishing current proof.");
      if (!this.dependencies.portableIdentity && loadedControl && (!loadedControl.policy || portableProofPolicy(loadedControl.release).digest !== loadedControl.policy.digest)) throw new ChainEvaluationError("CHECKER_POLICY_RESTART_REQUIRED", "The checker source changed after its control modules were loaded. Restart the checker before renewing proof.");
      const currentDependencies = this.dependencies.portableIdentity ? undefined : await dependencyMetadataAsync(this.root, evaluationSignal);
      if (!this.dependencies.portableIdentity && (!appliedDependencies || currentDependencies !== appliedDependencies)) throw new ChainEvaluationError("CHECKER_DEPENDENCIES_RESTART_REQUIRED", "The running checker's installed dependencies changed. Restart the checker or pinned agent host before attributing new proof to its loaded implementation.");
      if (!this.dependencies.portableIdentity && loadedControl && (!loadedControl.metadata || (loadedControl.installation === this.root ? currentDependencies : await dependencyMetadataAsync(loadedControl.installation, evaluationSignal)) !== loadedControl.metadata)) throw new ChainEvaluationError("CHECKER_DEPENDENCIES_RESTART_REQUIRED", "The checker's dependencies changed after its control modules were loaded. Restart the checker before renewing proof.");
      if (!fresh && this.cached?.identity === identity && (cacheOnly || this.cached.value.sdl !== null && this.cached.value.codegen.status !== "unknown" && !this.cached.value.documentDiagnostics.length && this.cached.value.verification && verificationAvailable(this.cached.value.verification))) evaluated = this.cached.value;
      else {
        this.dependencies.onProgress?.("checks");
        evaluated = await this.dependencies.evaluate(this.root, evaluationSignal);
        signal.throwIfAborted();
        this.cached = { identity, value: evaluated };
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DependencyObservationChangedError) throw error;
      const diagnostics = error instanceof ChainEvaluationError ? unavailable(error.code, error.message) : unavailable("RESTRICTED_EVALUATION", "Restricted GraphQL evaluation is unavailable. Check the installed sandbox capability and check again. No privileged fallback was run.");
      evaluated = { sdl: null, schemaDiagnostics: diagnostics, generatedSdl: null, generatedDiagnostics: diagnostics, documents: [], documentDiagnostics: diagnostics, documentSet: "unknown", codegen: { status: "unknown", files: [], diagnostics }, verification: unavailableVerification(diagnostics), contract: null };
      this.cached = { identity, value: evaluated };
    } finally { clearTimeout(timer); }
    signal.throwIfAborted();
    this.dependencies.onProgress?.("recheck");
    if (await identify(this.root, signal) !== identity || recordState !== "invalid" && recordContents(this.root) !== recordText) { this.cached = undefined; throw new EditError(409, "Source changed during inspection. Check again before using this evidence."); }
    let surface: SdlSurface | null = null;
    try { if (evaluated.sdl !== null) surface = sdlSurface(evaluated.sdl); }
    catch { evaluated = { ...evaluated, sdl: null, schemaDiagnostics: unavailable("SCHEMA_OUTPUT", "The evaluated schema is invalid.") }; }
    const prismaHash = models ? fingerprint(models) : null;
    const liveHash = surface ? sdlFingerprint(surface) : null;
    let generatedHash: string | null = null;
    try { if (evaluated.generatedSdl !== null) generatedHash = sdlFingerprint(sdlSurface(evaluated.generatedSdl)); } catch { /* Unknown below. */ }
    const verification = evaluated.verification ?? unavailableVerification(unavailable("VALIDATION_UNAVAILABLE", "Independent contract checks are missing. Check again with the current Studio validator; hashes alone cannot renew proof."));
    let runtimeArtifacts: string | null = null;
    try { runtimeArtifacts = runtimeContractHash(this.root); } catch { /* Missing/unsafe emitted inputs cannot establish reviewed identity. */ }
    let apiBinding: string | null = null, clientBinding: string | null = null, upstreamBinding: string | null = null;
    const bindings = record && record.version !== 1 ? record.bindings : { api: null, client: null };
    const modelStates: Record<string, ReviewState> = Object.create(null);
    const reviewUnknown = recordDiagnostics.length ? recordDiagnostics : prismaDiagnostics;
    for (const model of [...new Set([...Object.keys(models ?? {}), ...Object.keys(record?.prisma?.models ?? {})])].sort()) {
      const current = models?.[model], previous = record?.prisma?.models[model];
      if (reviewUnknown.length) modelStates[model] = { status: "unknown", diagnostics: reviewUnknown };
      else if (!record?.prisma || !previous) modelStates[model] = { status: "no-review", diffs: diffPrisma({}, current ? { [model]: current } : {}) };
      else {
        const diffs = diffPrisma(previous ? { [model]: previous } : {}, current ? { [model]: current } : {});
        modelStates[model] = diffs.length ? { status: "changed", diffs } : { status: "reviewed", current: fingerprint(current), reviewedAgainst: fingerprint(previous) };
      }
    }
    const prismaDiffs = Object.values(modelStates).flatMap(state => state.status === "changed" ? state.diffs : []);
    const prismaState: ReviewState = reviewUnknown.length ? { status: "unknown", diagnostics: reviewUnknown } : prismaDiffs.length ? { status: "changed", diffs: prismaDiffs } : Object.values(modelStates).some(state => state.status === "no-review") ? { status: "no-review" } : { status: "reviewed", current: prismaHash!, reviewedAgainst: fingerprint(record?.prisma?.models ?? {}) };
    const schemaEvidence = liveHash && generatedHash ? check(liveHash === generatedHash ? "passed" : "failed", liveHash === generatedHash ? [] : unavailable("SCHEMA_CHANGED", "Schema changed.")) : check("unavailable", [...evaluated.schemaDiagnostics, ...evaluated.generatedDiagnostics]);
    const documentProblems = evaluated.documents.map(item => ({ code: "INVALID_DOCUMENT", message: item.message, file: item.file }));
    const invalidDocuments = !!liveHash && evaluated.documentSet !== "unknown" && !evaluated.documentDiagnostics.length && documentProblems.length > 0;
    const documentEvidence = invalidDocuments ? check("failed", documentProblems) : check(evaluated.documentSet === "matches" ? "passed" : evaluated.documentSet === "differs" ? "failed" : "unavailable", evaluated.documentSet === "differs" ? unavailable("DOCUMENTS_CHANGED", "Documents changed.") : evaluated.documentDiagnostics);
    const generatedEvidence: CheckEvidence = evaluated.codegen.status === "unknown" && invalidDocuments
      ? { status: "blocked", diagnostics: unavailable("CODEGEN_DOCUMENTS_BLOCKED", "Codegen cannot verify generated outputs while authored documents are invalid. Correct the reported GraphQL selections, then regenerate and check again.") }
      : check(evaluated.codegen.status === "current" ? "passed" : evaluated.codegen.status === "out-of-date" ? "failed" : "unavailable", evaluated.codegen.diagnostics);
    const checks = { schema: schemaEvidence, documents: documentEvidence, "generated-files": generatedEvidence };
    let proofInput: ProofBuildInput | undefined, proof: ProofObservation | undefined;
    let proofProblem: Diagnostic[] = [];
    try {
      this.dependencies.onProgress?.("proof");
      const portable = await (this.dependencies.portableIdentity ?? ((root, signal) => portableProofIdentity(root, { policy: this.appliedPolicy, signal })))(this.root, signal);
      signal.throwIfAborted();
      if (this.dependencies.proofDependencyDigest && portable.toolchain.dependencyDigest !== this.dependencies.proofDependencyDigest) throw new ChainEvaluationError("CHECKER_DEPENDENCIES_RESTART_REQUIRED", "The pinned checker was built against different installed dependency source. Preserve the candidate and restart the agent host before renewing proof.");
      proofInput = { identity: portable, evaluation: { ...evaluated, verification }, record, models, sdlDigest: liveHash, codegenChecks: Object.values(checks) };
      proof = buildContractProof(proofInput);
      proof = { ...proof, view: { ...proof.view, ci: compareCIObservation(await loadCIObservation(this.root), proof.view) } };
      if (evaluated.contract && liveHash && runtimeArtifacts) apiBinding = proof.bindings.api;
      if (liveHash) clientBinding = proof.bindings.client;
      if (apiBinding && prismaHash) upstreamBinding = proof.bindings.upstream;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DependencyObservationChangedError) throw error;
      proofProblem = unavailable(error instanceof ChainEvaluationError ? error.code : "PROOF_IDENTITY_UNAVAILABLE", `Portable contract evidence could not be established. Restore the supported toolchain, lockfile and checker sources, then check again. ${error instanceof Error ? error.message.slice(0, 500) : ""}`);
    }
    signal.throwIfAborted();
    const sources = proofInput?.identity.files;
    const reasons: ("schema-changed" | "documents-changed" | "generated-files-changed")[] = [];
    if (schemaEvidence.status === "failed") reasons.push("schema-changed");
    if (documentEvidence.status === "failed") reasons.push("documents-changed");
    if (generatedEvidence.status === "failed" && !reasons.length) reasons.push("generated-files-changed");
    const unknownChecks = Object.values(checks).filter(item => item.status === "unavailable");
    const generatedState: Extract<ChainLink, { id: "pothos-generated" }>["state"] = !liveHash ? { status: "unknown", diagnostics: evaluated.schemaDiagnostics } : reasons.length ? { status: "out-of-date", reasons, files: evaluated.codegen.files } : unknownChecks.length ? { status: "unknown", diagnostics: unknownChecks.flatMap(item => "diagnostics" in item ? item.diagnostics : []) } : { status: "current" };
    const validation: CheckEvidence = !liveHash || evaluated.documentDiagnostics.length ? check("unavailable", [...evaluated.schemaDiagnostics, ...evaluated.documentDiagnostics]) : evaluated.documents.length ? check("failed", documentProblems) : check("passed");
    const clientDiffs = record?.client && surface ? diffSdl(record.client, surface) : [];
    const clientState: Extract<ChainLink, { id: "generated-client" }>["state"] = validation.status === "failed" ? { status: "invalid", problems: evaluated.documents } : validation.status === "unavailable" ? { status: "unknown", diagnostics: validation.diagnostics } : recordDiagnostics.length ? { status: "unknown", diagnostics: recordDiagnostics } : !record?.client ? { status: "no-review" } : clientDiffs.length ? { status: "changed", diffs: clientDiffs } : { status: "reviewed", current: liveHash!, reviewedAgainst: sdlFingerprint(record.client) };
    const backendPassed = verification.database.status === "passed" && verification.api.status === "passed" && !!liveHash && !!apiBinding;
    const clientPassed = [verification.client, verification.consumers, verification.integration, validation].every(item => item.status === "passed");
    const modelsReviewed = prismaState.status === "reviewed";
    const apiStale: Diagnostic[] = [];
    const apiProof = proof?.view.stages.find(stage => stage.stage === "api");
    if (apiProof && apiProof.status !== "verified") apiStale.push(...apiProof.diagnostics);
    if (!modelsReviewed && prismaState.status !== "unknown") apiStale.push(diagnostic("MODEL_REVIEW_REQUIRED", "Database model changes need explicit review. Reconcile each changed model, run the backend checks, then record its model review.", PRISMA_FILE));
    if (apiBinding !== bindings.api || !apiBinding) apiStale.push(diagnostic(bindings.api ? "API_IMPLEMENTATION_CHANGED" : "API_REVIEW_REQUIRED", bindings.api ? "Database semantics, repository/Pothos implementation, schema or verification inputs changed. Reconcile and validate the API, then record its API review." : "No API implementation review is bound to current source. Run the backend checks, review repository/Pothos behavior, then record the API review.", "compute/http/graphql-api/"));
    if (bindings.api && apiBinding !== bindings.api && sources) apiStale.push(...changedInputs(this.reviewedSources.api, sources.api, "GraphQL Lambda"));
    const apiConfidence = confidence({ checks: [verification.database, verification.api], unknown: [...reviewUnknown, ...proofProblem, ...(!runtimeArtifacts ? unavailable("GENERATED_CONTRACT_UNAVAILABLE", "Emitted database contract and type artifacts are unavailable. Generate them separately, then check again.") : []), ...(!evaluated.contract ? unavailable("CONTRACT_SEMANTICS_UNAVAILABLE", "Compiled database semantics are unavailable. Validate the saved Prisma contract and emitted artifacts, then check again.") : []), ...(!liveHash ? evaluated.schemaDiagnostics.length ? evaluated.schemaDiagnostics : unavailable("SCHEMA_UNAVAILABLE", "The executable schema is unavailable. Resolve the schema and check again.") : [])], stale: apiStale });
    const codegenProof = proof?.view.stages.find(stage => stage.stage === "codegen");
    const generatedConfidence = confidence({ checks: Object.values(checks), stale: codegenProof?.status === "stale" ? codegenProof.diagnostics : [], upstream: { id: "repository-pothos", confidence: apiConfidence } });
    const clientStale: Diagnostic[] = [];
    const clientProof = proof?.view.stages.find(stage => stage.stage === "client");
    if (clientProof && clientProof.status !== "verified") clientStale.push(...clientProof.diagnostics);
    if (!record?.client || clientDiffs.length) clientStale.push(diagnostic("CLIENT_SURFACE_REVIEW_REQUIRED", "The current API surface needs a client-selection review. Reconcile intended selections and query options, validate them, then record the client review."));
    if (!bindings.client || bindings.client.inputs !== clientBinding) clientStale.push(diagnostic(bindings.client ? "CLIENT_IMPLEMENTATION_CHANGED" : "CLIENT_REVIEW_REQUIRED", bindings.client ? "Authored operations, fragments, React Query implementation, consumers or verification inputs changed. Run client/cache and consumer checks, then record their review." : "No client implementation review is bound to current source. Run client/cache and consumer checks, then record their review.", "client-app/src/api/"));
    if (bindings.client && bindings.client.inputs !== clientBinding && sources) clientStale.push(...changedInputs(this.reviewedSources.client, sources.client, "Client"));
    if (bindings.client && bindings.client.upstream !== upstreamBinding) clientStale.push(diagnostic("CLIENT_UPSTREAM_CHANGED", "The reviewed API predecessor changed, even if public SDL and generated files are identical. Validate client behavior and explicitly renew the client review."));
    const clientConfidence = confidence({ checks: [validation, verification.client, verification.consumers, verification.integration], unknown: recordDiagnostics, stale: clientStale, upstream: { id: "typed-documents", confidence: generatedConfidence } });
    const agent = (link: ChainLink["id"]): ChainAction => ({ kind: "agent", link });
    const baselineAvailable = !record?.prisma && !record?.client && !bindings.api && !bindings.client && recordState !== "invalid" && !!models && backendPassed && clientPassed && generatedState.status === "current";
    const prismaActions: ChainAction[] = baselineAvailable ? [{ kind: "acknowledge", scope: { kind: "baseline" } }] : backendPassed && !reviewUnknown.length ? Object.entries(modelStates).flatMap(([model, state]): ChainAction[] => ["changed", "no-review"].includes(state.status) ? [{ kind: "acknowledge", scope: { kind: "model", model } }] : []) : [];
    if (!baselineAvailable && backendPassed && modelsReviewed && (bindings.api !== apiBinding || apiProof?.status !== "verified")) prismaActions.push({ kind: "acknowledge", scope: { kind: "api" } });
    const clientActions: ChainAction[] = !baselineAvailable && apiConfidence.status === "verified" && generatedConfidence.status === "verified" && clientPassed && clientConfidence.status !== "verified" ? [{ kind: "acknowledge", scope: { kind: "client" } }] : [];
    const chain: GraphQLChain = { version: 3, proof: proof?.view ?? unavailableProofView(proofProblem[0]?.message ?? "Current contract proof is unavailable."), revision, record: recordState, dependencies: CHAIN_DEPENDENCIES, verification, nodes: sourceFingerprints(this.root, record?.version === 3 ? record.proofs : {}, this.policyRoot), links: [
      { id: "prisma-pothos", kind: "reviewed", state: prismaState, confidence: apiConfidence, models: modelStates, actions: apiConfidence.status === "verified" ? [] : [...prismaActions, agent("prisma-pothos")] },
      { id: "pothos-generated", kind: "derived", state: generatedState, confidence: generatedConfidence, checks, actions: generatedState.status === "current" ? [] : [{ kind: "command", command: CODEGEN_COMMAND }, agent("pothos-generated")] },
      { id: "generated-client", kind: "derived-then-reviewed", state: clientState, confidence: clientConfidence, validation, actions: clientConfidence.status === "verified" ? [] : [...clientActions, agent("generated-client")] },
    ] };
    this.dependencies.onProgress?.("recheck");
    if (await identify(this.root, signal) !== identity || recordState !== "invalid" && recordContents(this.root) !== recordText || chainPublicationVersion(this.root) !== publicationVersion) { this.cached = undefined; throw new EditError(409, "Source changed while publishing inspection. Check again before using this evidence."); }
    signal.throwIfAborted();
    if (sources && apiConfidence.status === "verified") this.reviewedSources.api = sources.api;
    if (sources && clientConfidence.status === "verified") this.reviewedSources.client = sources.client;
    return { evaluationRevision: identity, chain, models, surface, record, recordText, bindings: { api: apiBinding, client: clientBinding, upstream: upstreamBinding }, ...(proofInput ? { proofInput } : {}), ...(proof ? { proof } : {}) };
  }
  async dispose(): Promise<void> { this.closed = true; this.baselineController.abort(); this.controller?.abort(); await this.pending?.catch(() => {}); await this.appliedDependencies; this.cached = undefined; }
}

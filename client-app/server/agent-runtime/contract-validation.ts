import { createHash, randomUUID } from "node:crypto";
import { studioContractControl } from "./contract-control";
import { sandboxedChainEvaluation } from "../graphql-chain/sandbox";
import { createRequire } from "node:module";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { projectCliEntry } from "../project-cli";
import { projectRuntime } from "../project-runtime";
import { DATABASE_RUNTIME_OUTPUTS } from "aws-studio/contract-chain/runtime-artifacts";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ChainEvaluationError, chainPublicationVersion, chainReporterBundle, chainWorkerBundle, evaluateGraphQLChain, RUNTIME_CONTRACT, RUNTIME_CONTRACT_TYPES, runtimeContractHash, type EvaluationOptions } from "aws-studio/contract-chain/evaluation";
import { canonicalPrisma, fingerprint, normalizeSdl, parseReviewRecord, sdlFingerprint, sdlSurface } from "aws-studio/contract-chain/core";
import { chainInputIdentity, GraphQLChainInspector, recordContents, type ChainServiceDependencies } from "aws-studio/contract-chain/inspector";
import { dependencyContentIdentity, dependencyMetadata, dependencyMetadataAsync, withDependencyObservationScope } from "aws-studio/contract-chain/dependencies";
import type { CheckEvidence } from "aws-studio/contract-chain/graphql-chain";
import { buildContractCodingContext, type ContractCodingContext, type ContractDecision, type ContractStage } from "../../shared/contract-propagation";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import type { CodingValidation } from "../../shared/agent-runtime";
import { AgentWorkspaceError, assertWorkspaceBaseline, readSourceManifest, type AgentWorkspace } from "aws-studio/source/workspace";
import { runValidation, type ValidationOptions, type ValidationResult } from "./providers/validation";
import type { ProviderOptions } from "./providers/types";
import type { ContractProofReceipts, ProofPolicy } from "aws-studio/contract-chain/contract-proof";
import { buildContractProof, candidateApiOrigin } from "aws-studio/contract-chain/proof";
import { proofDigest } from "aws-studio/contract-chain/proof-core";
import { installedContractDependencyDigest, portableProofPolicy, type PortableProofIdentity } from "aws-studio/contract-chain/portable-identity";
import { buildProjectIdentityWorker, readProjectContractIdentity } from "./project-contract-identity";

const appliedHostPolicy = (() => { try { return portableProofPolicy(); } catch { return undefined; } })();
// A source host may retain parsed libraries in Node's module cache. A pinned
// host instead receives this identity through its immutable release asset.
const appliedControlMetadata = (() => { try { return appliedHostPolicy ? dependencyMetadata(path.resolve(__dirname, "../../..")) : undefined; } catch { return undefined; } })();
// Studio's own contract code around the framework verifier, as this process loaded it.
const appliedHostControl = (() => { try { return studioContractControl(path.resolve(__dirname, "../../..")); } catch { return undefined; } })();

export type ContractToolchain = NonNullable<EvaluationOptions["toolchain"]> & { readonly policy?: ProofPolicy; readonly identityWorker?: { readonly file: string; readonly digest: string }; readonly controlDependencyDigest?: string; readonly projectDependencyDigest?: string | null; /** The Studio contract control (contract-control.ts) a release was pinned with. */ readonly control?: string };
/** Legacy releases remain useful for generic Coding; they cannot renew contract proof. */
export function assertContractControl(toolchain?: ContractToolchain): void {
  if (toolchain) {
    if (!toolchain.policy || !toolchain.controlDependencyDigest) throw new AgentWorkspaceError(409, "This pinned agent host predates the complete contract control identity. Preserve its candidate and explicitly restart the agent host before contract work.");
    if (toolchain.projectDependencyDigest === null) throw new AgentWorkspaceError(409, "This host has no pinned project installation. Install the selected application from its lockfile and restart the agent host before contract work.");
    return;
  }
  let current: string | undefined, policy: ProofPolicy | undefined, control: string | undefined;
  try { const root = path.resolve(__dirname, "../../.."); current = dependencyMetadata(root); policy = portableProofPolicy(); control = studioContractControl(root); } catch { /* Report unavailable at the action boundary, preserving generic Studio startup. */ }
  assertSourceContractControl(current, policy, control);
}
function assertSourceContractControl(current: string | undefined, policy: ProofPolicy | undefined, control: string | undefined): void {
  if (!appliedHostPolicy || policy?.digest !== appliedHostPolicy.digest || !appliedControlMetadata || current !== appliedControlMetadata || !appliedHostControl || control !== appliedHostControl) throw new AgentWorkspaceError(409, "The source host's loaded contract policy or dependencies are missing or changed. Preserve its candidate and explicitly restart Studio before contract work.");
}
async function assertContractControlAsync(toolchain?: ContractToolchain, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (toolchain) { assertContractControl(toolchain); return; }
  let current: string | undefined, policy: ProofPolicy | undefined, control: string | undefined;
  try { const root = path.resolve(__dirname, "../../.."); current = await dependencyMetadataAsync(root, signal); policy = portableProofPolicy(); control = studioContractControl(root); }
  catch { signal?.throwIfAborted(); /* Missing or unreadable control inputs cannot authorize proof. */ }
  signal?.throwIfAborted();
  assertSourceContractControl(current, policy, control);
}
export interface ContractValidationOptions {
  readonly workspace: AgentWorkspace;
  readonly stage: ContractStage;
  readonly signal: AbortSignal;
  readonly onExecution?: ProviderOptions["onExecution"];
  readonly onOutput: (text: string) => void;
  readonly decisions?: readonly ContractDecision[];
  /** Process-local evidence owned by the native host for sequential checkpoints. */
  readonly evaluationCache?: Map<string, CandidateEvaluation>;
}
interface CandidateEvaluation {
  readonly identity: string;
  readonly source: string;
  readonly dependencies: string;
  readonly publication: string;
  readonly result: ChainEvaluation;
}
export interface ContractValidationResult {
  readonly checks: readonly CodingValidation[];
  readonly inputDigest: string;
  readonly proofs?: ContractProofReceipts;
  /** Fixed derived evidence from this same candidate, allowing client document feedback to renew Codegen. */
  readonly codegen?: { readonly check: CodingValidation; readonly inputDigest: string };
}
export class ContractDocumentRepairRequired extends Error {
  readonly code = "AUTHORED_DOCUMENT_REPAIR_REQUIRED" as const;
  constructor(readonly checks: readonly CodingValidation[], readonly inputDigest: string, readonly proofs?: ContractProofReceipts) {
    super("Authored GraphQL operations or fragments need client source repair before Codegen can finish. Resume the retained candidate at Client operations; no generator or model retry was started automatically.");
    this.name = "ContractDocumentRepairRequired";
  }
}

export async function buildContractToolchain(projectRoot: string): Promise<{ worker: Buffer; reporter: Buffer; policy: Buffer; identityWorker: Buffer }> {
  const root = path.resolve(__dirname, "../../..");
  const assertApplied = async () => { if (!appliedHostPolicy || portableProofPolicy().digest !== appliedHostPolicy.digest || await dependencyMetadataAsync(root) !== appliedControlMetadata || !appliedHostControl || studioContractControl(root) !== appliedHostControl) throw new Error("The loaded contract checker policy or installed control dependencies changed. Preserve retained tasks and explicitly restart Studio before pinning a new agent host."); };
  await assertApplied();
  const hostDependencies = installedContractDependencyDigest(root);
  const projectDependencies = realpathSync(projectRoot) === realpathSync(root) ? hostDependencies
    : existsSync(path.join(projectRoot, "package-lock.json")) ? installedContractDependencyDigest(projectRoot).catch(() => null) : null;
  const [worker, reporter, dependencyDigest, projectDependencyDigest, identityWorker] = await Promise.all([
    chainWorkerBundle(), chainReporterBundle(), hostDependencies, projectDependencies, buildProjectIdentityWorker(),
  ]);
  await assertApplied();
  return { worker: Buffer.from(worker), reporter: Buffer.from(reporter), identityWorker, policy: Buffer.from(JSON.stringify({ version: 1, policy: appliedHostPolicy, dependencyDigest, projectDependencyDigest, control: appliedHostControl })) };
}

/** Decisions bind their owning stage; adding client choices cannot invalidate API intent. */
export function contractDecisionDigest(stage: ContractStage, decisions: readonly ContractDecision[]): string {
  const kinds = stage === "api" ? ["exposure", "graphql", "write", "ownership", "validation"] : stage === "client" ? ["selection", "cache"] : [];
  return proofDigest(decisions.filter(item => kinds.includes(item.kind)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
async function workerBytes(toolchain?: ContractToolchain): Promise<Buffer> {
  const bytes = toolchain ? await readFile(toolchain.worker.file) : Buffer.from(await chainWorkerBundle());
  if (toolchain && createHash("sha256").update(bytes).digest("hex") !== toolchain.worker.digest) throw new Error("Pinned contract checker changed.");
  return Buffer.from(bytes);
}
function runtimeIdentity(root: string): string { try { return runtimeContractHash(root); } catch { return "missing"; } }
function missingRuntimeArtifacts(root: string): boolean {
  let missing = false;
  for (const relative of DATABASE_RUNTIME_OUTPUTS) {
    let current = root;
    for (const segment of relative.split("/")) {
      current = path.join(current, segment);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("Linked database artifacts cannot be regenerated automatically. Repair their fixed source paths first."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; break; } throw error; }
    }
  }
  return missing;
}
async function projectChainInputIdentity(root: string, toolchain?: ContractToolchain, signal?: AbortSignal, nodeVersion = projectRuntime(root).version): Promise<string> {
  return chainInputIdentity(root, await workerBytes(toolchain), signal, `v${nodeVersion}`);
}

async function stableSourceIdentity(root: string, toolchain?: ContractToolchain, signal?: AbortSignal, nodeVersion?: string): Promise<string> {
  signal?.throwIfAborted();
  const source = readSourceManifest(root).digest, runtime = runtimeIdentity(root), dependencies = await dependencyMetadataAsync(root, signal);
  const identity = await chainInputIdentity(root, await workerBytes(toolchain), signal, nodeVersion === undefined ? undefined : `v${nodeVersion}`);
  signal?.throwIfAborted();
  if (readSourceManifest(root).digest !== source || runtimeIdentity(root) !== runtime || await dependencyMetadataAsync(root, signal) !== dependencies) throw new Error("Contract source, emitted artifacts or installed dependencies changed while capturing current inputs.");
  return identity;
}

function projectContractIdentity(root: string, toolchain?: ContractToolchain, signal = new AbortController().signal): Promise<PortableProofIdentity> {
  const applied = toolchain?.policy ?? appliedHostPolicy;
  if (!applied) throw new Error("The installed Studio host has no current contract policy. Restart Studio before renewing proof.");
  if (toolchain && !toolchain.identityWorker) throw new Error("This pinned agent host has no portable identity worker. Restart it before renewing proof.");
  return readProjectContractIdentity(root, applied, signal, toolchain?.identityWorker);
}

export function projectContractInspection(
  toolchain?: ContractToolchain,
  overrides: Pick<ChainServiceDependencies, "evaluate" | "portableIdentity" | "onProgress"> = {},
  nodeVersion?: string,
): ChainServiceDependencies & { readonly evaluate: NonNullable<ChainServiceDependencies["evaluate"]> } {
  return {
    ...overrides,
    workerBundle: () => workerBytes(toolchain),
    proofPolicy: toolchain?.policy,
    proofDependencyDigest: toolchain?.projectDependencyDigest ?? toolchain?.controlDependencyDigest,
    ...(overrides.portableIdentity ? {} : { identity: (root, signal) => projectChainInputIdentity(root, toolchain, signal, nodeVersion) }),
    evaluate: overrides.evaluate ?? ((root, signal) => sandboxedChainEvaluation(root, signal, toolchain)),
    portableIdentity: overrides.portableIdentity ?? ((root, signal) => projectContractIdentity(root, toolchain, signal)),
  };
}

/** Same source/review identity as saved-source inspection, recomputed by the host. */
export async function assertContractOrigin(root: string, context: ContractCodingContext, toolchain?: ContractToolchain, dependencies: Pick<ChainServiceDependencies, "evaluate" | "portableIdentity" | "onProgress"> = {}, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  dependencies.onProgress?.("starting");
  await withDependencyObservationScope(root, signal, async () => {
    await assertContractControlAsync(toolchain, signal);
    const nodeVersion = dependencies.portableIdentity ? undefined : projectRuntime(root).version;
    const inspector = new GraphQLChainInspector(root, { ...projectContractInspection(toolchain, dependencies, nodeVersion), signal, expectedRevision: context.sourceRevision });
    try {
      // The inspector checks exact source, dependency, emitted-artifact and review identities
      // before and after its immutable independent capture, including publication.
      const observation = await inspector.inspect(true);
      signal?.throwIfAborted();
      const expected = buildContractCodingContext(observation.chain, context.stage);
      if (observation.chain.revision !== context.sourceRevision) throw new Error("Saved contract source or review evidence changed. Check the Contract Chain again before starting propagation.");
      if (expected.predecessors.some(predecessor => predecessor.status !== "verified")) throw new Error("Required contract predecessors are not verified. Resume the earliest invalid stage before starting downstream work.");
      for (const key of ["inputs", "affected", "predecessors", "reviewScopes"] as const) if (JSON.stringify(expected[key]) !== JSON.stringify(context[key])) throw new Error("The originating contract context no longer matches current source and predecessor evidence. Check again before starting propagation.");
      if (fingerprint([await stableSourceIdentity(root, toolchain, signal, nodeVersion), recordContents(root)]) !== context.sourceRevision) throw new Error("Saved contract inputs changed while starting propagation. Check again.");
    } finally { await inspector.dispose(); }
  }, { freshContent: true });
}

/** Refresh the existing task's contextual evidence after a guarded three-way merge.
 * The host chooses the effective stage from candidate checkpoint identities;
 * an intentionally unstamped saved-source predecessor is not candidate failure.
 */
export async function refreshContractContext(root: string, stage: ContractStage, previousDecisions: readonly ContractDecision[], toolchain?: ContractToolchain, previousContext?: ContractCodingContext, dependencies: Pick<ChainServiceDependencies, "evaluate" | "portableIdentity"> = {}, signal?: AbortSignal): Promise<ContractCodingContext> {
  signal?.throwIfAborted();
  return withDependencyObservationScope(root, signal, async () => {
    await assertContractControlAsync(toolchain, signal);
    const inspector = new GraphQLChainInspector(root, { ...projectContractInspection(toolchain, dependencies), signal });
    try {
      const chain = await inspector.load(true);
      signal?.throwIfAborted();
      const affected = buildContractCodingContext(chain, stage).affected;
      const byTarget = (contextDiffs: ContractCodingContext["affected"], target: string) => JSON.stringify(contextDiffs.filter(diff => diff.path === target));
      const decisions = previousDecisions.map(decision => previousContext && byTarget(previousContext.affected, decision.target) !== byTarget(affected, decision.target)
        ? { ...decision, status: "unresolved" as const } : decision);
      const context = buildContractCodingContext(chain, stage, decisions);
      if (fingerprint([await stableSourceIdentity(root, toolchain, signal), recordContents(root)]) !== context.sourceRevision) throw new Error("Saved contract inputs changed while refreshing propagation context. Refresh the candidate again.");
      return context;
    } finally { await inspector.dispose(); }
  }, { freshContent: true });
}

/** Conservative stage identity preserves API checkpoints across client-only edits. */
export async function contractInputDigest(workspace: AgentWorkspace, stage: ContractStage, toolchain?: ContractToolchain, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await assertContractControlAsync(toolchain, signal);
  const manifest = readSourceManifest(workspace.workingDirectory);
  const files = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name !== "graphql-chain.review.json" && !name.startsWith("docs/") && !name.startsWith(".agents/") && (stage !== "api" || !name.startsWith("client-app/") && name !== "codegen.ts")));
  let contract = "missing"; try { contract = runtimeContractHash(workspace.workingDirectory); } catch { /* Missing artifacts cannot pass validation. */ }
  let record = null;
  try { const contents = recordContents(workspace.workingDirectory); if (contents !== null) record = parseReviewRecord(contents); } catch { /* Invalid source review cannot supply an accepted predecessor. */ }
  const dependencies = await dependencyContentIdentity(workspace.workingDirectory, signal), worker = await workerBytes(toolchain);
  signal?.throwIfAborted();
  const runtime = projectRuntime(workspace.workingDirectory);
  return fingerprint([stage, files, candidateApiOrigin(record), dependencies, contract, worker.toString("base64"), `v${runtime.version}`]);
}

/** Reuses content only while every meaningful installed-file identity still matches. */
export async function assertContractDependencies(workspace: AgentWorkspace, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (workspace.dependencyDigest !== undefined && await dependencyContentIdentity(workspace.workingDirectory, signal) !== workspace.dependencyDigest) throw new AgentWorkspaceError(409, "The task changed installed dependency code. Restore or provision dependencies from the reviewed lockfile before contract validation.");
}

function check(name: string, value: CheckEvidence, digest: string): CodingValidation {
  return { command: name, candidateDigest: digest, status: value.status === "passed" ? "passed" : value.status === "unavailable" ? "unavailable" : "failed", ...(value.status !== "passed" ? { detail: value.diagnostics.map(item => `${item.code}: ${item.message}`).join("\n").slice(0, 4000) } : {}) };
}

/** Only fixed offline generators execute here, inside the existing native sandbox. */
export async function validateContractCandidate(options: ContractValidationOptions, toolchain?: ContractToolchain, run: (options: ValidationOptions) => Promise<ValidationResult> = runValidation, evaluateInput: (root: string, options: EvaluationOptions) => Promise<ChainEvaluation> = evaluateGraphQLChain, identityInput?: (root: string, policy?: ProofPolicy, signal?: AbortSignal) => Promise<PortableProofIdentity>): Promise<ContractValidationResult> {
  let repair: ContractDocumentRepairRequired | undefined;
  let checkedCandidate: CandidateEvaluation | undefined;
  const result = await withDependencyObservationScope(options.workspace.workingDirectory, options.signal, async () => {
  const { workspace, signal, stage } = options, root = workspace.workingDirectory;
  signal.throwIfAborted();
  await assertContractControlAsync(toolchain, signal);
  assertWorkspaceBaseline(workspace); await assertContractDependencies(workspace, signal);
  const runtime = projectRuntime(root);
  const directory = path.join(workspace.directory, "contract-checks", randomUUID()); await mkdir(directory, { recursive: true, mode: 0o700 });
  const execute = async (file: string, args: string[], cwd = root) => {
    signal.throwIfAborted();
    const result = await run({ provider: "codex", cwd, scratchDir: directory, command: { file: runtime.node, args: [file, ...args] }, toolchain: runtime, signal, onExecution: options.onExecution,
      onEvent: async event => { for (const key of ["stdout", "stderr"]) if (typeof event.data[key] === "string") options.onOutput(String(event.data[key])); }, timeoutMs: 300_000, outputBytesCap: 32_768 });
    signal.throwIfAborted();
    if (result.exitCode !== 0 || result.outputTruncated) throw new Error("The fixed private generator failed or returned incomplete output. Inspect its diagnostic and retry; saved source was not changed.");
  };
  let evaluatedDigest: string | undefined, evaluatedIdentity: string | undefined, evaluatedDependencies: string | undefined, evaluatedPublication: string | undefined;
  const evaluate = async () => {
    signal.throwIfAborted();
    const publication = chainPublicationVersion(root), before = await stableSourceIdentity(root, toolchain, signal, runtime.version), source = readSourceManifest(root).digest, dependencies = await dependencyMetadataAsync(root, signal);
    const previous = options.evaluationCache?.get(root);
    const reusable = previous?.identity === before && previous.source === source && previous.dependencies === dependencies && previous.publication === publication;
    const result = reusable ? previous.result : await evaluateInput(root, { signal, toolchain, run: input => run({ ...input, command: { file: runtime.node, args: input.command.args }, toolchain: runtime, onExecution: options.onExecution }) });
    if (await stableSourceIdentity(root, toolchain, signal, runtime.version) !== before || readSourceManifest(root).digest !== source || await dependencyMetadataAsync(root, signal) !== dependencies || chainPublicationVersion(root) !== publication) throw new Error("Candidate inputs changed during independent contract validation. Recheck the retained source.");
    evaluatedDigest = source;
    evaluatedIdentity = before;
    evaluatedDependencies = dependencies;
    evaluatedPublication = publication;
    checkedCandidate = { identity: before, source, dependencies, publication, result };
    return result;
  };
  let evaluation: ChainEvaluation | undefined, missingArtifacts = false;
  try { evaluation = await evaluate(); }
  catch (error) { if (error instanceof ChainEvaluationError && error.code === "GENERATED_CONTRACT_UNAVAILABLE" && missingRuntimeArtifacts(root)) missingArtifacts = true; else throw error; }
  const databaseStale = !!evaluation?.contract && evaluation.verification.database.status === "failed" && evaluation.verification.database.diagnostics.some(item => ["GENERATED_DATABASE_STALE", "GENERATED_DATABASE_TYPES_STALE", "GENERATED_ACCESS_GRAPH_STALE", "GENERATED_ROLE_POLICIES_STALE", "GENERATED_CLIENT_ACCESS_STALE"].includes(item.code));
  if (missingArtifacts || databaseStale) {
    const before = readSourceManifest(root);
    await execute(projectCliEntry(root), ["db:generate"]);
    const after = readSourceManifest(root);
    for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
      if (name !== "packages/api-contract/src/generated/access-policy.ts" && JSON.stringify(before.files[name]) !== JSON.stringify(after.files[name])) throw new Error("Private database generation changed authored source. Review the generator before continuing.");
    }
    evaluation = await evaluate();
  }
  const knownDocumentFailure = () => !!evaluation && (evaluation.documents.length > 0 || evaluation.documentDiagnostics.some(item => item.code === "DOCUMENT_SYNTAX"));
  if ((stage === "codegen" || stage === "client") && evaluation?.codegen.status === "out-of-date" && !knownDocumentFailure()) {
    if (evaluation.documentDiagnostics.length || !evaluation.sdl) throw new Error("GraphQL document evidence or executable schema is unavailable. Resolve the reported source/configuration diagnostics before Codegen.");
    const local = createRequire(path.join(root, "package.json")), codegen = path.join(path.dirname(local.resolve("@graphql-codegen/cli/package.json")), "cjs/bin.js");
    const before = readSourceManifest(root);
    await execute(codegen, ["--config", "codegen.ts"]);
    const after = readSourceManifest(root);
    for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) if (!name.startsWith("client-app/src/api/generated/") && JSON.stringify(before.files[name]) !== JSON.stringify(after.files[name])) throw new Error("Codegen changed a file outside its declared generated outputs. The candidate was retained for inspection.");
    evaluation = await evaluate(); // One bounded feedback pass; never retry generation automatically.
  }
  if (!evaluation) throw new Error("Independent contract validation is unavailable.");
  const digest = readSourceManifest(root).digest;
  if (!evaluatedDigest || digest !== evaluatedDigest) throw new Error("Candidate source changed after independent contract validation. Recheck before publishing evidence.");
  let executableSchemaValid = false;
  try { if (evaluation.sdl) { normalizeSdl(evaluation.sdl); executableSchemaValid = evaluation.schemaDiagnostics.length === 0; } } catch { /* Invalid executable SDL cannot establish API evidence. */ }
  let apiCheck = check("contract: repository/API behavioral, type and executable-schema checks", evaluation.verification.api, digest);
  if (!executableSchemaValid) apiCheck = { ...apiCheck, status: apiCheck.status === "unavailable" || evaluation.sdl === null ? "unavailable" : "failed",
    detail: [apiCheck.detail, "The current executable GraphQL schema must be available, valid and free of schema diagnostics.", ...evaluation.schemaDiagnostics.map(item => `${item.code}: ${item.message}`)].filter(Boolean).join("\n").slice(0, 4000) };
  const checks = [check("contract: database artifacts", evaluation.verification.database, digest), apiCheck];
  let codegenCheck: CodingValidation | undefined;
  if (stage !== "api") {
    let schemaMatches = false;
    try { schemaMatches = !!evaluation.sdl && !!evaluation.generatedSdl && normalizeSdl(evaluation.sdl) === normalizeSdl(evaluation.generatedSdl); } catch { /* Invalid SDL cannot pass. */ }
    codegenCheck = { command: "contract: executable SDL, authored documents and complete Codegen outputs", candidateDigest: digest, status: evaluation.codegen.status === "current" && evaluation.documentSet === "matches" && !evaluation.documents.length && !evaluation.documentDiagnostics.length && schemaMatches ? "passed" : knownDocumentFailure() ? "failed" : evaluation.codegen.status === "unknown" ? "unavailable" : "failed", detail: [
      ...evaluation.documents.map(item => `${item.file}${item.line ? `:${item.line}` : ""} (${item.document}): ${item.message}`),
      ...evaluation.documentDiagnostics.map(item => `${item.code}${item.file ? ` ${item.file}${item.line ? `:${item.line}` : ""}` : ""}: ${item.message}`),
      ...evaluation.codegen.diagnostics.map(item => item.message),
    ].join("\n").slice(0, 4000) };
    checks.push(codegenCheck);
  }
  if (stage === "client") checks.push(check("contract: React Query and transport behavior", evaluation.verification.client, digest), check("contract: consumer typecheck", evaluation.verification.consumers, digest), check("contract: persisted operations and production limits", evaluation.verification.integration, digest));
  assertWorkspaceBaseline(workspace); await assertContractDependencies(workspace, signal);
  const inputDigest = await contractInputDigest(workspace, stage, toolchain, signal);
  const codegen = codegenCheck ? { check: codegenCheck, inputDigest: stage === "codegen" ? inputDigest : await contractInputDigest(workspace, "codegen", toolchain, signal) } : undefined;
  const identity = await (identityInput ? identityInput(root, toolchain?.policy, signal) : projectContractIdentity(root, toolchain, signal));
  signal.throwIfAborted();
  if (!identityInput && identity.toolchain.node !== runtime.version) throw new Error("The project Node changed during independent contract validation. Recheck the retained source.");
  const expectedDependencies = toolchain?.projectDependencyDigest ?? toolchain?.controlDependencyDigest;
  if (expectedDependencies && identity.toolchain.dependencyDigest !== expectedDependencies) throw new Error("Installed candidate dependencies differ from the pinned host control implementation. Restart the agent host and refresh the retained candidate before renewing proof.");
  let record = null;
  try { record = parseReviewRecord(await readFile(path.join(root, "graphql-chain.review.json"), "utf8")); } catch { /* Missing/legacy review never supplies candidate acceptance. */ }
  const models = canonicalPrisma(await readFile(path.join(root, "packages/database/prisma/contract.prisma"), "utf8")).models;
  const codegenEvidence: CheckEvidence = codegenCheck?.status === "passed" ? { status: "passed" } : { status: codegenCheck?.status === "failed" ? "failed" : "unavailable", diagnostics: [{ code: "CANDIDATE_CODEGEN_REQUIRED", message: "Current complete Codegen validation is required." }] };
  const proofs = buildContractProof({ identity, evaluation, record, models, sdlDigest: executableSchemaValid ? sdlFingerprint(sdlSurface(evaluation.sdl!)) : null, codegenChecks: [codegenEvidence], scope: "candidate", candidateDecisions: { api: contractDecisionDigest("api", options.decisions ?? []), client: contractDecisionDigest("client", options.decisions ?? []) } }).receipts;
  if (readSourceManifest(root).digest !== evaluatedDigest || await stableSourceIdentity(root, toolchain, signal, runtime.version) !== evaluatedIdentity || await dependencyMetadataAsync(root, signal) !== evaluatedDependencies || chainPublicationVersion(root) !== evaluatedPublication) throw new Error("Candidate inputs changed while publishing independent evidence. Recheck the retained source.");
  signal.throwIfAborted();
  if (stage === "codegen" && knownDocumentFailure() && checks.slice(0, 2).every(check => check.status === "passed")) repair = new ContractDocumentRepairRequired(checks, inputDigest, proofs);
  return { checks, inputDigest, proofs, ...(codegen ? { codegen } : {}) };
  });
  // This error carries usable API receipts; it may escape only after physical close.
  if (repair) throw repair;
  // Publish only after the owning dependency scope closes. Keep only complete
  // passing evaluations so a retry can recover from a transient runner failure.
  const cache = options.evaluationCache, checked = checkedCandidate;
  if (cache && checked && checked.result.sdl && checked.result.generatedSdl && checked.result.codegen.status === "current"
    && !checked.result.schemaDiagnostics.length && !checked.result.generatedDiagnostics.length
    && checked.result.documentSet === "matches" && !checked.result.documents.length && !checked.result.documentDiagnostics.length
    && Object.values(checked.result.verification).every(check => check.status === "passed")) {
    options.signal.throwIfAborted();
    const root = options.workspace.workingDirectory;
    cache.delete(root);
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(root, checked);
  }
  return result;
}

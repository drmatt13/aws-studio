import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareAgentWorkspace, readSourceManifest } from "../source/workspace";
import { readEvaluationArtifact } from "../source/result-artifact";
import { linkDependencies } from "../source/dependency-links";
import { dependencyContentIdentity, dependencyMetadataAsync } from "./dependencies";
import { SourceGateError, withSourceRead } from "../source/source-gate";
import { setTimeout as delay } from "node:timers/promises";
import type { ChainEvaluation } from "./worker";
import { assertCapturedAuthoredDocuments } from "./authored-documents";
import { parseChainEvaluation } from "./evaluation-result";
import { CLIENT_ACCESS_OUTPUT, ACCESS_GRAPH_OUTPUT, DATABASE_RUNTIME_OUTPUTS, RUNTIME_CONTRACT } from "./runtime-artifacts";
export { parseChainEvaluation } from "./evaluation-result";
export { RUNTIME_CONTRACT, RUNTIME_CONTRACT_TYPES } from "./runtime-artifacts";
/** One fixed worker command, run read-only against a private capture. Studio runs it in its native
 * command sandbox; the checkout gate runs it as an owned child (ci.ts). The verifier has no
 * default: an inspection that names no runner does not run. */
export interface ValidationOptions {
  readonly provider: "codex";
  readonly cwd: string;
  readonly scratchDir: string;
  readonly command: { readonly file: string; readonly args: string[] };
  readonly signal: AbortSignal;
  readonly onEvent: (event: unknown) => void | Promise<void>;
  readonly readOnlyCwd?: boolean;
  readonly readPaths?: string[];
  readonly timeoutMs?: number;
  readonly outputBytesCap?: number;
}
export interface ValidationResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly outputTruncated?: boolean }
export type ChainRunner = (options: ValidationOptions) => Promise<ValidationResult>;

export class ChainEvaluationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); }
}
const LIMIT = 2 * 1024 * 1024;
let worker: Promise<Uint8Array> | undefined;
let reporter: Promise<Uint8Array> | undefined;
export function chainReporterBundle(): Promise<Uint8Array> {
  return reporter ??= (async () => {
    const { build } = await import("esbuild");
    const entry = path.join(__dirname, "node-test-reporter.ts");
    const result = await build({ stdin: { contents: `const reporter=require(${JSON.stringify(entry)});module.exports=reporter.default;if(require.main===module)reporter.runReporter(process.argv.slice(2));`, resolveDir: path.dirname(entry), loader: "js" }, bundle: true, platform: "node", format: "cjs", target: "node24", write: false, logLevel: "silent" });
    if (result.outputFiles.length !== 1) throw new Error("Could not pin the behavioral test reporter.");
    return result.outputFiles[0]!.contents;
  })();
}
export function chainWorkerBundle(): Promise<Uint8Array> {
  return worker ??= (async () => {
    const { build } = await import("esbuild");
    const entry = path.join(__dirname, "worker.ts");
    const result = await build({ stdin: { contents: `require(${JSON.stringify(entry)}).runChainWorker(process.argv[2],process.argv[3],process.argv[4]);`, resolveDir: path.dirname(entry), loader: "js" }, bundle: true, packages: "external", platform: "node", format: "cjs", target: "node24", write: false, logLevel: "silent" });
    if (result.outputFiles.length !== 1) throw new Error("Could not pin the GraphQL inspection worker.");
    const reporterHash = createHash("sha256").update(await chainReporterBundle()).digest("hex");
    return Buffer.concat([result.outputFiles[0]!.contents, Buffer.from(`\n// Pinned test reporter: ${reporterHash}\n`)]);
  })();
}

function readRuntimeContract(root: string, relative = RUNTIME_CONTRACT): Buffer {
  const file = path.join(root, relative);
  let current = realpathSync(root);
  for (const component of relative.split("/")) { current = path.join(current, component); if (lstatSync(current).isSymbolicLink()) throw new Error("Generated database contract is linked."); }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > 5 * 1024 * 1024) throw new Error("Generated database contract is not a bounded regular file.");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) { const size = readSync(descriptor, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(descriptor);
    if (count !== info.size || after.size !== info.size || after.nlink !== 1 || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error("Generated database contract changed while reading.");
    return bytes.subarray(0, count);
  } finally { closeSync(descriptor); }
}

export function readRuntimeArtifacts(root: string): Map<string, Buffer> {
  const artifacts = new Map<string, Buffer>();
  for (const file of DATABASE_RUNTIME_OUTPUTS) {
    try { artifacts.set(file, readRuntimeContract(root, file)); }
    catch (error) {
      // Preserve absence so older projects can be inspected. The verifier reports any required missing policy output.
      if ((file !== CLIENT_ACCESS_OUTPUT && file !== ACCESS_GRAPH_OUTPUT) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return artifacts;
}
function artifactHash(artifacts: ReadonlyMap<string, Buffer>): string {
  const digest = createHash("sha256");
  for (const [name, bytes] of artifacts) digest.update(name + "\0" + bytes.length + "\0").update(bytes);
  return digest.digest("hex");
}
export function runtimeContractHash(root: string): string {
  return artifactHash(readRuntimeArtifacts(root));
}

/** Execution guard only. These physical identities never enter portable proof IDs.
 * Content equality alone cannot detect a source file that was changed, executed,
 * and restored while the private checkout was being inspected. */
function sourceFileMetadata(root: string, files: readonly string[]): string {
  root = path.resolve(root);
  const digest = createHash("sha256"), directories = new Set<string>([root]);
  for (const name of [...files].sort()) {
    const file = path.join(root, name), info = lstatSync(file, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n) throw new Error("Captured source is no longer a regular unlinked file.");
    digest.update(JSON.stringify([name, String(info.dev), String(info.ino), String(info.size), String(info.mode), String(info.nlink), String(info.ctimeNs), String(info.mtimeNs)]) + "\n");
    for (let directory = path.dirname(file); directory !== root; directory = path.dirname(directory)) directories.add(directory);
  }
  for (const directory of [...directories].sort()) {
    const info = lstatSync(directory, { bigint: true });
    if (!info.isDirectory()) throw new Error("Captured source directory became linked or unavailable.");
    // Scratch/cache creation may alter directory timestamps. File inventory and
    // directory identity/permissions establish the relevant immutable boundary.
    digest.update(JSON.stringify([path.relative(root, directory), String(info.dev), String(info.ino), String(info.mode)]) + "\n");
  }
  return digest.digest("hex");
}

/** One in-flight observation's physical guard, never portable receipt content. */
export function chainPublicationVersion(root: string): string {
  const files = Object.keys(readSourceManifest(root).files);
  for (const name of DATABASE_RUNTIME_OUTPUTS) {
    try { lstatSync(path.join(root, name)); files.push(name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return sourceFileMetadata(root, files);
}

export interface EvaluationOptions {
  readonly signal: AbortSignal;
  /** Host-owned content identity captured under this inspection's source lease; never an HTTP input. */
  readonly expectedDependencyDigest?: string;
  /** Host-owned executor: Studio's native sandbox, the checkout gate's owned worker, or a test double. Never an HTTP/environment-controlled choice. */
  readonly run: ChainRunner;
  /** Immutable host release assets; never supplied by a browser or candidate. */
  readonly toolchain?: { readonly worker: { readonly file: string; readonly digest: string }; readonly reporter: { readonly file: string; readonly digest: string } };
}

async function pinnedBytes(asset: { readonly file: string; readonly digest: string }): Promise<Buffer> {
  const bytes = await readFile(asset.file);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.digest) throw new Error("Pinned GraphQL validation bytes changed.");
  return bytes;
}


/** Wait only for a verified live owner before entering the finite capture.
 * Interrupted/unverifiable ownership and errors inside capture fail immediately.
 * Retries acquire the same exclusive lease; no unguarded read is introduced. */
async function captureWhenAvailable<T>(root: string, signal: AbortSignal, capture: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    signal.throwIfAborted();
    let entered = false;
    try { return await withSourceRead(root, () => { entered = true; return capture(); }); }
    catch (error) {
      if (entered || !(error instanceof SourceGateError) || !error.activeOwner) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ChainEvaluationError("SOURCE_CAPTURE_BUSY", "Another Studio operation still owns source capture. Wait for it to finish, then check again.", { cause: error });
      await delay(Math.min(500, remaining), undefined, { signal });
    }
  }
}

/** Fixed, model-free private capture; native sandbox by default. Never import an application module here. */
export async function evaluateGraphQLChain(root: string, options: EvaluationOptions): Promise<ChainEvaluation> {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), "studio-graphql-chain-")));
  let stage: "capture" | "sandbox" | "result" = "capture";
  try {
    options.signal.throwIfAborted();
    let artifacts: Map<string, Buffer>;
    try { artifacts = readRuntimeArtifacts(root); }
    catch (error) { throw new ChainEvaluationError("GENERATED_CONTRACT_UNAVAILABLE", "Generated database artifacts are missing, unreadable or linked. Run npm --workspace @repo/database run generate separately, then check again.", { cause: error }); }
    const expectedContract = artifactHash(artifacts), artifactFiles = [...artifacts.keys()];
    const runtimeMetadata = sourceFileMetadata(root, artifactFiles);
    const expectedDependencies = options.expectedDependencyDigest ?? await dependencyContentIdentity(root, options.signal);
    if (!/^[a-f0-9]{64}$/.test(expectedDependencies)) throw new Error("Invalid captured dependency identity.");
    options.signal.throwIfAborted();
    // Serialize only the finite public-source copy. Dependency hashing and native
    // evaluation must not hold the checkout's source authority while they run.
    const captured = await captureWhenAvailable(root, options.signal, async () => {
      const source = readSourceManifest(root), files = Object.keys(source.files), metadata = sourceFileMetadata(root, files);
      assertCapturedAuthoredDocuments(root, source.files);
      const workspace = await prepareAgentWorkspace(root, { storageDirectory: path.join(directory, "capture"), copyDependencies: false, signal: options.signal });
      if (workspace.baseline.digest !== source.digest || sourceFileMetadata(root, files) !== metadata) throw new Error("Saved source changed while being captured.");
      assertCapturedAuthoredDocuments(root, workspace.baseline.files);
      return { workspace, files, metadata };
    });
    const { workspace } = captured;
    // Review evidence is deliberately excluded from the evaluation cache identity.
    // Withhold its temporary copy so authored code cannot consume changing review
    // bytes as a schema/configuration input. The live record and baseline stay intact.
    await rm(path.join(workspace.workingDirectory, "graphql-chain.review.json"), { force: true });
    options.signal.throwIfAborted();
    // Match the existing restricted evaluator: public source is private and immutable,
    // installed packages receive narrow read-only grants, and workspace links are rebased.
    const dependencies = linkDependencies(root, workspace.workingDirectory, Object.keys(workspace.baseline.files).map(name => path.join(root, name)));
    const capturedContract = path.join(workspace.workingDirectory, RUNTIME_CONTRACT);
    await mkdir(path.dirname(capturedContract), { recursive: true, mode: 0o700 });
    for (const [name, bytes] of artifacts) {
      await writeFile(path.join(workspace.workingDirectory, name), bytes, { flag: "wx", mode: 0o400 });
    }
    if (runtimeContractHash(workspace.workingDirectory) !== expectedContract) throw new Error("Generated database contract changed during capture.");
    if (runtimeContractHash(root) !== expectedContract) throw new Error("Generated database contract changed during capture.");
    const capturedSource = readSourceManifest(workspace.workingDirectory);
    options.signal.throwIfAborted();
    const toolchain = path.join(directory, "toolchain"), scratchDir = path.join(directory, "scratch");
    await mkdir(toolchain, { mode: 0o700 }); await mkdir(scratchDir, { mode: 0o700 });
    const file = path.join(toolchain, "inspect.cjs"), artifact = path.join(scratchDir, "chain.json");
    await writeFile(file, options.toolchain ? await pinnedBytes(options.toolchain.worker) : await chainWorkerBundle(), { flag: "wx", mode: 0o400 });
    await writeFile(path.join(toolchain, "node-test-reporter.cjs"), options.toolchain ? await pinnedBytes(options.toolchain.reporter) : await chainReporterBundle(), { flag: "wx", mode: 0o400 });
    await symlink(path.join(workspace.workingDirectory, "node_modules"), path.join(toolchain, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    // Native Windows workers cannot create junctions. Fixtures resolve through
    // this host-created parent link to the existing read-only dependency grant.
    await symlink(path.join(workspace.workingDirectory, "node_modules"), path.join(scratchDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const loader = realpathSync(createRequire(path.join(workspace.workingDirectory, "package.json")).resolve("tsx"));
    if (!dependencies.some(directory => loader.startsWith(directory + path.sep))) throw new Error("Inspection loader escaped its installed-dependency grants.");
    const capturedFiles = [...Object.keys(capturedSource.files), ...artifactFiles];
    const capturedMetadata = sourceFileMetadata(workspace.workingDirectory, capturedFiles), installedMetadata = await dependencyMetadataAsync(root, options.signal);
    const toolchainFiles = ["inspect.cjs", "node-test-reporter.cjs"], toolchainMetadata = sourceFileMetadata(toolchain, toolchainFiles);
    options.signal.throwIfAborted();
    stage = "sandbox";
    const result = await options.run({ provider: "codex", cwd: workspace.workingDirectory, scratchDir, readOnlyCwd: true, readPaths: [toolchain, ...dependencies],
      command: { file: realpathSync(process.execPath), args: ["--import", pathToFileURL(loader).href, file, artifact] }, signal: options.signal,
      onEvent: async () => {}, timeoutMs: 300_000, outputBytesCap: 32_768 });
    stage = "result";
    if (result.exitCode !== 0 || result.outputTruncated) throw new ChainEvaluationError("GRAPHQL_WORKER_FAILED", "The restricted GraphQL worker failed, timed out or returned incomplete output. Check installed dependencies and check again.");
    const value = parseChainEvaluation(readEvaluationArtifact(artifact, JSON.parse(result.stdout), LIMIT));
    options.signal.throwIfAborted();
    assertCapturedAuthoredDocuments(root, workspace.baseline.files);
    if (readSourceManifest(root).digest !== workspace.baseline.digest || runtimeContractHash(root) !== expectedContract
      || sourceFileMetadata(root, artifactFiles) !== runtimeMetadata
      || sourceFileMetadata(root, captured.files) !== captured.metadata
      || readSourceManifest(workspace.workingDirectory).digest !== capturedSource.digest
      || sourceFileMetadata(workspace.workingDirectory, capturedFiles) !== capturedMetadata
      || runtimeContractHash(workspace.workingDirectory) !== expectedContract
      || sourceFileMetadata(toolchain, toolchainFiles) !== toolchainMetadata
      || await dependencyMetadataAsync(root, options.signal) !== installedMetadata
      || await dependencyContentIdentity(root, options.signal) !== expectedDependencies) throw new Error("Saved source or dependencies changed during inspection. Check again.");
    options.signal.throwIfAborted();
    return value;
  } catch (error) {
    if (error instanceof ChainEvaluationError) throw error;
    if (options.signal.aborted) throw new ChainEvaluationError("GRAPHQL_EVALUATION_CANCELLED", "Restricted GraphQL inspection was cancelled or exceeded its preparation deadline. Check again.", { cause: error });
    if (stage === "sandbox") {
      const missing = error instanceof Error && /Standalone codex CLI is unavailable/.test(error.message);
      throw new ChainEvaluationError(missing ? "CODEX_UNAVAILABLE" : "SANDBOX_UNAVAILABLE", missing ? "Standalone Codex CLI is unavailable. Install a compatible Codex CLI to enable restricted GraphQL inspection. Model authentication is not required. No privileged fallback was run." : "The native Codex command sandbox is unavailable or its boundary verification failed. Check the installed Codex sandbox capability, then check again. No privileged fallback was run.", { cause: error });
    }
    throw new ChainEvaluationError(stage === "capture" ? "GRAPHQL_CAPTURE_FAILED" : "GRAPHQL_ARTIFACT_INVALID", stage === "capture" ? "Saved source and dependencies could not be captured safely. Resolve linked, missing or unreadable inputs and check available temporary storage." : "Restricted GraphQL output failed integrity checks, or saved source changed during evaluation. Check again.", { cause: error });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

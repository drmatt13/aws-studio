import { realpathSync } from "node:fs";
import path from "node:path";
import type { GraphQLChain } from "./graphql-chain";
import { PROOF_PREDECESSORS, PROOF_STAGES, type ProofStageView } from "./contract-proof";
import { start, stopTree, tethered } from "../source/process";

import { readSourceManifest } from "../source/workspace";
import { ChainEvaluationError, evaluateGraphQLChain, type ValidationOptions, type ValidationResult } from "./evaluation";
import { GraphQLChainInspector, type ChainServiceDependencies } from "./inspector";
import { writeCIObservation, type CIObservation } from "./ci-observation";
import { readProofReceipt } from "./proof-core";

/** Explicit checkout authority, equivalent to running repository tests. It is
 * never a fallback for Studio/Coding's native command sandbox and is not an OS
 * isolation claim. The owned worker receives no application/CI credentials. */
async function runCheckoutWorker(options: ValidationOptions): Promise<ValidationResult> {
  options.signal.throwIfAborted();
  if (!options.readOnlyCwd || realpathSync(options.command.file) !== realpathSync(process.execPath) || !path.isAbsolute(options.cwd) || !path.isAbsolute(options.scratchDir) || options.cwd === options.scratchDir || options.scratchDir.startsWith(options.cwd + path.sep)) throw new Error("Checkout verification requires the fixed Node worker and a private source capture.");
  const timeout = options.timeoutMs ?? 300_000, cap = Math.min(options.outputBytesCap ?? 32_768, 32_768);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000 || !Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid checkout verification process limits.");
  const env: NodeJS.ProcessEnv = { PATH: path.dirname(realpathSync(process.execPath)), HOME: options.scratchDir, USERPROFILE: options.scratchDir, APPDATA: options.scratchDir, LOCALAPPDATA: options.scratchDir, TMPDIR: options.scratchDir, TMP: options.scratchDir, TEMP: options.scratchDir, NO_COLOR: "1", FORCE_COLOR: "0", LANG: "en_US.UTF-8", TSX_DISABLE_CACHE: "1", OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null" };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
  const child = start(tethered({ file: realpathSync(process.execPath), args: options.command.args, cwd: options.cwd, env, display: "Independent contract checkout worker" }));
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, timedOut = false;
  const append = (current: Buffer, chunk: Buffer) => { if (current.length + chunk.length >= cap) { truncated = true; stopTree(child, false); } return Buffer.concat([current, chunk]).subarray(0, cap); };
  child.stdout?.on("data", chunk => { stdout = append(stdout, Buffer.from(chunk)); });
  child.stderr?.on("data", chunk => { stderr = append(stderr, Buffer.from(chunk)); });
  const abort = () => stopTree(child, false);
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; stopTree(child, false); }, timeout);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    options.signal.throwIfAborted();
    if (timedOut) throw new ChainEvaluationError("CI_VERIFICATION_TIMEOUT", "The independent checkout worker exceeded its validation deadline. Run the required stage checks separately and retry.");
    return { exitCode: code ?? 2, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), outputTruncated: truncated };
  } finally { clearTimeout(timer); options.signal.removeEventListener("abort", abort); }
}

export const evaluateCheckoutGraphQLChain: NonNullable<ChainServiceDependencies["evaluate"]> = (root, signal) => evaluateGraphQLChain(root, { signal, run: async options => {
  try { return await runCheckoutWorker(options); }
  catch (error) { if (error instanceof ChainEvaluationError) throw error; throw new ChainEvaluationError("CHECKOUT_EXECUTION_UNAVAILABLE", "The independent checkout worker could not run. Check supported Node 24, installed dependencies and process execution capability. This command does not require a Coding agent.", { cause: error }); }
} });

/** Missing evidence remains visible beneath blocked successors. */
export function contractGateExitCode(chain: GraphQLChain): 0 | 1 | 2 {
  const unavailable = Object.values(chain.verification).some(check => check.status === "unavailable") || chain.links.some(link => link.confidence.status === "unavailable" || link.state.status === "unknown" || link.id === "pothos-generated" && Object.values(link.checks).some(check => check.status === "unavailable")) || chain.proof.stages.some(stage => stage.status === "unavailable" || stage.current?.checks.some(check => check.outcome === "unavailable"));
  if (unavailable) return 2;
  const complete = chain.record === "available" && chain.links.every(link => link.confidence.status === "verified") && PROOF_STAGES.every(id => {
    const stage = chain.proof.stages.find(item => item.stage === id);
    if (stage?.status !== "verified" || !stage.current || !stage.recorded) return false;
    try {
      const current = readProofReceipt(stage.current, "saved"), recorded = readProofReceipt(stage.recorded, "saved");
      return current.stage === id && recorded.stage === id && current.id === recorded.id && current.policy.id === chain.proof.policy.id && current.policy.digest === chain.proof.policy.digest && current.checks.every(check => check.outcome === "passed") && (!(id === "api" || id === "client") || current.review?.scope === id) && PROOF_PREDECESSORS[id].every(predecessor => current.predecessors[predecessor] === chain.proof.stages.find(item => item.stage === predecessor)?.current?.id) && stage.predecessors.every(predecessor => predecessor.matches);
    } catch { return false; }
  });
  return complete ? 0 : 1;
}
export interface ContractGateOptions {
  /** Constructor seam for deterministic tests; never accepted through HTTP. */
  readonly inspector?: GraphQLChainInspector;
  readonly authority?: CIObservation["authority"];
  readonly persistObservation?: boolean;
  /** Installed verifier source, selected by its own entry point. */
  readonly proofPolicyRoot?: string;
}
function reportDiagnostics(chain: GraphQLChain, stage: ProofStageView): { code: string; message: string }[] {
  const diagnostics = [...stage.diagnostics];
  const generated = chain.links.find(link => link.id === "pothos-generated");
  const checks = stage.stage === "database" ? [chain.verification.database] : stage.stage === "api" ? [chain.verification.api]
    : stage.stage === "codegen" ? generated?.id === "pothos-generated" ? Object.values(generated.checks) : []
      : [chain.verification.client, chain.verification.consumers, chain.verification.integration];
  const details = [...(stage.current?.checks.flatMap(check => check.diagnostics) ?? []), ...checks.flatMap(check => check.status === "passed" ? [] : check.diagnostics)];
  const seen = new Set(diagnostics.map(item => item.code));
  for (const item of details) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    const file = item.file && !item.file.startsWith("/") && !/^[A-Za-z]:/.test(item.file) && !item.file.split(/[\\/]/).includes("..") ? ` in ${item.file.replaceAll("\\", "/").slice(0, 512)}` : "";
    // Preserve actionable diagnostic identity without persisting authored test
    // output, request data, machine paths or other sensitive failure payloads.
    diagnostics.push({ code: item.code.slice(0, 128), message: `Independent ${stage.stage} verification reported ${item.code.slice(0, 128)}${file}. ${stage.action}` });
  }
  if (stage.stage === "api" && chain.record === "invalid") diagnostics.unshift({ code: "REVIEW_RECORD_INVALID", message: "The root graphql-chain.review.json is malformed or incompatible. Resolve it without manufacturing review acknowledgements." });
  return diagnostics.slice(0, 100);
}
export async function runContractGate(root: string, emit: (value: unknown) => void, options: ContractGateOptions = {}): Promise<0 | 1 | 2> {
  const inspector = options.inspector ?? new GraphQLChainInspector(root, { evaluate: evaluateCheckoutGraphQLChain, proofPolicyRoot: options.proofPolicyRoot });
  try {
    const source = readSourceManifest(root).digest;
    const observation = await inspector.inspect(true), chain = observation.chain, code = contractGateExitCode(chain);
    const identity = observation.proofInput?.identity;
    // Reattest cached outcomes without rerunning tests. A source/review or
    // dependency edit after inspection cannot label a different checkout green.
    const current = await inspector.inspect(false, true);
    if (current.evaluationRevision !== observation.evaluationRevision || current.chain.revision !== chain.revision || readSourceManifest(root).digest !== source) throw new Error("Source changed while publishing checkout verification.");
    const report: CIObservation = { version: 1, authority: options.authority ?? "checkout", policy: chain.proof.policy, node: process.versions.node, environment: { platform: process.platform, arch: process.arch, execution: "trusted-checkout" }, revision: identity?.sourceRevision ?? chain.revision, outcome: code === 0 ? "verified" : code === 1 ? "pending" : "unavailable",
      stages: chain.proof.stages.map(stage => ({ stage: stage.stage, status: stage.status, current: stage.current?.id ?? null, recorded: stage.recorded?.id ?? null,
        predecessors: stage.predecessors, checks: stage.current?.checks.map(check => ({ id: check.id, outcome: check.outcome, evidence: check.evidence })) ?? [], diagnostics: reportDiagnostics(chain, stage), action: stage.action })) };
    if (options.persistObservation !== false) await writeCIObservation(root, report).catch(() => { /* Optional run history never substitutes for current evidence. */ });
    emit(report); return code;
  } catch (error) { emit({ version: 1, outcome: "unavailable", diagnostics: [{ code: error instanceof ChainEvaluationError ? error.code : "CONTRACT_VERIFICATION_UNAVAILABLE", message: error instanceof ChainEvaluationError ? error.message : "Current contract inputs or independent verification could not be established. Check Node 24, installed dependencies and source diagnostics; persisted receipts cannot bypass this failure." }] }); return 2; }
  finally { await inspector.dispose(); }
}

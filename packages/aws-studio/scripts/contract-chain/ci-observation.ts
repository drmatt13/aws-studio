import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { PROOF_STAGES, type ContractProofView, type ProofPolicy, type ProofStage } from "./contract-proof";
import type { ChainConfidence } from "./graphql-chain";

export const CI_OBSERVATION_PATH = ".cache/framework-studio/graphql-chain/ci-report.json";
export interface CIStageObservation {
  readonly stage: ProofStage;
  readonly status: ChainConfidence["status"];
  readonly current: string | null;
  readonly recorded: string | null;
  readonly predecessors: readonly { readonly stage: ProofStage; readonly current: string | null; readonly recorded: string | null; readonly matches: boolean }[];
  readonly checks: readonly { readonly id: string; readonly outcome: "passed" | "failed" | "blocked" | "unavailable"; readonly evidence: string }[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
  readonly action: string;
}
/** An inspectable claim from a command run, not authenticated CI provenance. */
export interface CIObservation {
  readonly version: 1;
  readonly authority: "checkout" | "ci";
  readonly policy: ProofPolicy;
  readonly node: string;
  readonly environment: { readonly platform: string; readonly arch: string; readonly execution: "trusted-checkout" };
  readonly revision: string;
  readonly outcome: "verified" | "pending" | "unavailable";
  readonly stages: readonly CIStageObservation[];
}
export type LoadedCIObservation = { readonly status: "missing" } | { readonly status: "unavailable"; readonly message: string } | { readonly status: "available"; readonly observation: CIObservation };
const LIMIT = 128 * 1024;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
export function readCIObservation(value: unknown): CIObservation {
  const invalid = () => { throw new Error("The checkout verification report is incompatible or incomplete. Run contract:check again; imported authority labels are not authenticated."); };
  if (!record(value) || !exact(value, ["version", "authority", "policy", "node", "environment", "revision", "outcome", "stages"]) || value.version !== 1 || !["checkout", "ci"].includes(String(value.authority)) || !["verified", "pending", "unavailable"].includes(String(value.outcome)) || !hash(value.revision) || !bounded(value.node, 64) || !record(value.environment) || !exact(value.environment, ["platform", "arch", "execution"]) || !bounded(value.environment.platform, 32) || !bounded(value.environment.arch, 32) || value.environment.execution !== "trusted-checkout" || !record(value.policy) || !exact(value.policy, ["id", "digest"]) || !bounded(value.policy.id, 128) || !hash(value.policy.digest) || !Array.isArray(value.stages) || value.stages.length !== PROOF_STAGES.length) invalid();
  const stages = (value as unknown as CIObservation).stages;
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    if (!record(stage) || !exact(stage, ["stage", "status", "current", "recorded", "predecessors", "checks", "diagnostics", "action"]) || stage.stage !== PROOF_STAGES[index] || !["verified", "blocked", "stale", "failed", "unavailable"].includes(String(stage.status)) || stage.current !== null && !hash(stage.current) || stage.recorded !== null && !hash(stage.recorded) || !bounded(stage.action, 4000) || !Array.isArray(stage.predecessors) || stage.predecessors.length > 4 || stage.predecessors.some(item => !record(item) || !exact(item, ["stage", "current", "recorded", "matches"]) || !PROOF_STAGES.includes(item.stage as ProofStage) || item.current !== null && !hash(item.current) || item.recorded !== null && !hash(item.recorded) || typeof item.matches !== "boolean") || !Array.isArray(stage.checks) || stage.checks.length > 20 || stage.checks.some(item => !record(item) || !exact(item, ["id", "outcome", "evidence"]) || !bounded(item.id, 128) || !["passed", "failed", "blocked", "unavailable"].includes(String(item.outcome)) || !hash(item.evidence)) || !Array.isArray(stage.diagnostics) || stage.diagnostics.length > 100 || stage.diagnostics.some(item => !record(item) || !exact(item, ["code", "message"]) || !bounded(item.code, 128) || !bounded(item.message, 4000))) invalid();
  }
  return value as unknown as CIObservation;
}

async function reportDirectory(root: string, create: boolean): Promise<string> {
  let directory = await realpath(root);
  for (const part of path.posix.dirname(CI_OBSERVATION_PATH).split("/")) {
    directory = path.join(directory, part);
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Linked checkout verification report storage is unsupported.");
  }
  return directory;
}
export async function loadCIObservation(root: string): Promise<LoadedCIObservation> {
  let handle;
  try {
    const directory = await reportDirectory(root, false);
    handle = await open(path.join(directory, "ci-report.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT) throw new Error("Invalid checkout report file.");
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Checkout report changed while reading.");
    return { status: "available", observation: readCIObservation(JSON.parse(bytes.subarray(0, count).toString("utf8"))) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "unavailable", message: "The recorded checkout/CI observation is unreadable or incompatible. Re-run contract:check; this report never establishes current trust." };
  } finally { await handle?.close(); }
}
export async function writeCIObservation(root: string, value: CIObservation): Promise<void> {
  const observation = readCIObservation(value), bytes = Buffer.from(JSON.stringify(observation, null, 2) + "\n");
  if (bytes.length > LIMIT) throw new Error("Checkout verification report exceeded its bounded size.");
  const directory = await reportDirectory(root, true), destination = path.join(directory, "ci-report.json"), temporary = path.join(directory, `ci-report-${randomUUID()}.tmp`);
  try {
    try { const before = await lstat(destination); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Refusing to replace linked checkout report evidence."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** Agreement is independently derived from current receipts, not a claimed passing flag. */
export function compareCIObservation(loaded: LoadedCIObservation, local: ContractProofView): ContractProofView["ci"] {
  if (loaded.status === "missing") return { status: "not-observed", message: "No checkout/CI observation is recorded. CI independently reruns the same contract policy." };
  if (loaded.status === "unavailable") return { status: "unavailable", message: loaded.message };
  const report = loaded.observation;
  const matching = report.outcome === "verified" && local.policy.digest === report.policy.digest && local.policy.id === report.policy.id && local.stages.every(stage => stage.status === "verified" && stage.current?.id === report.stages.find(item => item.stage === stage.stage)?.current && report.stages.find(item => item.stage === stage.stage)?.status === "verified");
  return matching ? { status: "matching", message: report.authority === "ci" ? "The imported CI claim matches current independently verified receipts. Its authority label is not authenticated or signed." : "The independent checkout report matches current verified receipts. No authenticated CI run is asserted." }
    : { status: "different", message: "The recorded checkout/CI observation does not match current independently verified source evidence. Run contract:check against the current checkout." };
}

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ProofPolicy, ProofToolchain } from "./contract-proof";
import { sourceImportClosure } from "../../database/configuration-inputs";
import { readSourceManifest } from "../source/workspace";
import { PORTABLE_NORMALIZATION_PROFILE, portableDependencyDigest, portableFileDigest, type LockedDependency } from "./portable-dependencies";
export { portableFileDigest } from "./portable-dependencies";
import { DATABASE_RUNTIME_OUTPUTS, databaseRuntimeArtifactDigest } from "./runtime-artifacts";
import { PRISMA_CONTRACT_FILE, prismaContractDigest } from "./prisma-source";

export type PortableFileGroup = "database" | "api" | "codegen" | "client" | "generated";
export interface PortableProofIdentity {
  readonly version: 1;
  /** Whole public checkout observation; stage receipts bind their narrower inputs. */
  readonly sourceRevision: string;
  readonly policy: ProofPolicy;
  readonly toolchain: ProofToolchain;
  readonly inputs: Readonly<Record<"database" | "api" | "codegen" | "client", string>>;
  readonly outputs: Readonly<Record<"database" | "generated", string>>;
  readonly files: Readonly<Record<PortableFileGroup, Readonly<Record<string, string>>>>;
}
export interface PortableIdentityOptions {
  readonly signal?: AbortSignal;
  /** Immutable release policy supplied by a host constructor, never by HTTP. */
  readonly policy?: ProofPolicy;
}

export const CONTRACT_PROOF_POLICY_ID = "contract-chain/offline-v1";
/** The verifier's own source: a change to any of these files changes the policy every receipt
 * binds, so receipts recorded by another verifier are stale. Studio's inspection service, review
 * flow and agent runtime only orchestrate this verifier and are not part of it. */
export const CONTRACT_PROOF_POLICY_FILES = [
  "scripts/contract-chain/cli.ts",
  "scripts/contract-chain/access-modules.ts",
  "scripts/contract-chain/authored-documents.ts",
  "scripts/contract-chain/ci.ts",
  "scripts/contract-chain/ci-observation.ts",
  "scripts/contract-chain/codegen-config.ts",
  "scripts/contract-chain/confidence.ts",
  "scripts/contract-chain/contract-proof.ts",
  "scripts/contract-chain/contract-proof-response.ts",
  "scripts/contract-chain/core.ts",
  "scripts/contract-chain/database-contract-source.ts",
  "scripts/contract-chain/declared-schema.ts",
  "scripts/contract-chain/declared-schema-model.ts",
  "scripts/contract-chain/dependencies.ts",
  "scripts/contract-chain/evaluation.ts",
  "scripts/contract-chain/evaluation-result.ts",
  "scripts/contract-chain/graphql-chain.ts",
  "scripts/contract-chain/graphql-chain-response.ts",
  "cli/aws-studio.cjs",
  "cli/commands.cjs",
  "cli/project-node.mjs",
  "scripts/contract-chain/inspection-budget.ts",
  "scripts/contract-chain/inspection-diagnostics.ts",
  "scripts/contract-chain/inspector.ts",
  "scripts/contract-chain/ledger.ts",
  "scripts/contract-chain/node-test-reporter.ts",
  "scripts/contract-chain/portable-dependencies.ts",
  "scripts/contract-chain/portable-identity.ts",
  "scripts/contract-chain/prisma-source.ts",
  "scripts/contract-chain/proof.ts",
  "scripts/contract-chain/proof-core.ts",
  "scripts/contract-chain/runtime-artifacts.ts",
  "scripts/contract-chain/source-fingerprints.ts",
  "scripts/contract-chain/source-lease.ts",
  "scripts/contract-chain/verification.ts",
  "scripts/contract-chain/worker.ts",
  "scripts/source/workspace.ts",
  "scripts/source/source-gate.ts",
  "scripts/source/io.ts",
  "scripts/source/errors.ts",
  "scripts/source/identity.ts",
  "scripts/source/execution-identity.ts",
  "scripts/source/result-artifact.ts",
  "scripts/source/dependency-links.ts",
  "scripts/source/process.ts",
  "src/config/repository-root.ts",
  "database/package.json",
  "database/configuration-inputs.ts",
  "database/access-syntax.ts",
  "database/access-graph.ts",
  "database/access-rules.ts",
  "database/access-graph-artifact.ts",
  "database/client-access.ts",
  "cli/owned-process.cjs",
  "cli/tether.mjs",
  "cli/windows-job.ps1",
  "cli/windows-security.ts",
  "cli/private-files.ts",
] as const;
const TOOL_PACKAGES = [
  ["root", "typescript"], ["root", "tsx"], ["root", "esbuild"],
  ["root", "@graphql-codegen/cli"], ["root", "@graphql-codegen/client-preset"], ["root", "@graphql-codegen/schema-ast"],
  ["schema", "graphql"], ["schema", "@pothos/core"], ["schema", "zod"],
  ["database", "@prisma/orm-toolchain"], ["database", "@prisma/orm-framework"], ["database", "@prisma/orm-postgres"], ["database", "@prisma/cli-engine"],
  ["client", "vitest"], ["client", "@tanstack/react-query"],
] as const;
const ISSUERS = { root: "package.json", schema: "compute/http/graphql-api/package.json", database: "packages/database/package.json", client: "client-app/package.json" } as const;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, order(value)])) : item;
  return JSON.stringify(order(value));
}
const fingerprint = (value: unknown) => digest(canonical(value));

export function fixedContractBytes(root: string, relative: string, optional = false): Buffer | null {
  if (relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..") || path.posix.isAbsolute(relative)) throw new Error("Invalid contract proof source path.");
  let current = root;
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Contract proof input is linked: ${relative}`); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  const descriptor = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) throw new Error(`Contract proof input is not a bounded regular file: ${relative}`);
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const read = readSync(descriptor, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
    const after = fstatSync(descriptor);
    if (count !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`Contract proof input changed while reading: ${relative}`);
    return bytes.subarray(0, count);
  } finally { closeSync(descriptor); }
}

/** A portable identity of the actual checker source, captured again when pinning. */
export function verifierPackageRoot(): string {
  return realpathSync(path.resolve(__dirname, "../.."));
}

/** A detached host compares the candidate's installed release with its immutable policy. */
export function projectVerifierRoot(project: string): string {
  return path.join(project, "node_modules/aws-studio");
}

export function contractPolicySnapshot(rootInput = verifierPackageRoot()): { policy: ProofPolicy; rawPolicy: string } {
  const root = realpathSync(rootInput), files: Record<string, string> = {}, raw: Record<string, string> = {};
  for (const name of CONTRACT_PROOF_POLICY_FILES) {
    const bytes = fixedContractBytes(root, name)!;
    files[name] = portableFileDigest(name, bytes);
    raw[name] = digest(bytes);
  }
  return { policy: { id: CONTRACT_PROOF_POLICY_ID, digest: fingerprint({ version: 1, files, node: ">=24.22.2 <25", checks: ["database", "api", "api-types", "codegen", "client", "consumers", "integration"] }) }, rawPolicy: fingerprint(raw) };
}

export function portableProofPolicy(rootInput?: string): ProofPolicy {
  return contractPolicySnapshot(rootInput).policy;
}

function packageVersion(root: string, issuer: keyof typeof ISSUERS, name: string): { version: string; location: string } {
  const require = createRequire(path.join(root, ISSUERS[issuer]));
  let file: string;
  try { file = require.resolve(`${name}/package.json`); }
  catch { file = require.resolve(name); }
  let directory = path.dirname(realpathSync(file));
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Required contract tool is outside the checkout: ${name}`);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === name && typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) return { version: manifest.version, location: path.relative(root, directory).split(path.sep).join("/") };
    } catch { /* Resolve an export whose entry lives below its package root. */ }
    const parent = path.dirname(directory);
    if (parent === directory || directory === root) break;
    directory = parent;
  }
  throw new Error(`The installed contract tool version is unavailable: ${name}`);
}

export const CONTRACT_SOURCE_PATHS = {
  database: PRISMA_CONTRACT_FILE,
  api: "compute/http/graphql-api",
  generated: "client-app/src/api/generated",
  client: "client-app/src/api",
} as const;

export function contractSourceFileDigest(name: string, bytes: Buffer): string {
  return name === PRISMA_CONTRACT_FILE ? prismaContractDigest(bytes) : portableFileDigest(name, bytes);
}

/** Predecessor bindings carry upstream changes without mixing owned files. */
export function contractFileGroup(name: string): Exclude<PortableFileGroup, "codegen"> | undefined {
  if (name === CONTRACT_SOURCE_PATHS.database) return "database";
  if (name.startsWith(CONTRACT_SOURCE_PATHS.api + "/")) return "api";
  if (name.startsWith(CONTRACT_SOURCE_PATHS.generated + "/")) return "generated";
  if (name.startsWith(CONTRACT_SOURCE_PATHS.client + "/")) return "client";
}

/** Proof, changed-file diagnostics, and the presentation lease share source boundaries. */
export function contractSourceGroups(root: string, source: Readonly<Record<string, string>>): Record<PortableFileGroup, Record<string, string>> {
  const files: Record<PortableFileGroup, Record<string, string>> = { database: {}, api: {}, codegen: {}, client: {}, generated: {} };
  // Schema is predecessor-bound. Codegen configuration helpers belong here;
  // the actual authored documents are committed by the loader's digest.
  const codegenConfiguration = new Set(sourceImportClosure(root, ["codegen.ts"], false, name => !contractFileGroup(name))
    .map(file => path.relative(root, file).split(path.sep).join("/")));
  for (const [name, hash] of Object.entries(source)) {
    const group = contractFileGroup(name) ?? (codegenConfiguration.has(name) ? "codegen" : undefined);
    if (group) files[group][name] = hash;
  }
  if (!Object.hasOwn(files.database, CONTRACT_SOURCE_PATHS.database)) throw new Error("The Prisma contract is missing from the captured checkout.");
  return files;
}

export function contractProofNodeProblem(): string | undefined {
  const version = process.versions.node;
  const [major, minor, patch] = version.split(".").map(Number);
  if (major === 24 && (minor! > 22 || minor === 22 && patch! >= 2)) return;
  return `Contract proof requires supported Node 24.22.2 or later on the 24.x line. The current process is running Node ${version}. Start Studio or the CLI with the repository's Node 24 runtime and check again.`;
}

function contractDependencyLock(root: string) {
  const lockfile = fixedContractBytes(root, "package-lock.json")!;
  let parsedLock: { lockfileVersion?: unknown; packages?: Record<string, LockedDependency> };
  try { parsedLock = JSON.parse(lockfile.toString("utf8")); } catch { throw new Error("Contract verification requires the committed npm lockfile."); }
  if (!parsedLock || parsedLock.lockfileVersion !== 3 || !parsedLock.packages || typeof parsedLock.packages !== "object" || Array.isArray(parsedLock.packages)) throw new Error("Contract verification requires a supported npm lockfile with package identities.");
  return { packages: parsedLock.packages, digest: fingerprint(parsedLock) };
}

/** Seal one installation without requiring application schema, generated files or application-only issuers. */
export async function installedContractDependencyDigest(root: string, signal?: AbortSignal): Promise<string> {
  const locked = contractDependencyLock(root);
  return portableDependencyDigest(root, locked.packages, locked.digest, PORTABLE_NORMALIZATION_PROFILE, signal);
}

export async function portableProofIdentity(rootInput: string, options: PortableIdentityOptions = {}): Promise<PortableProofIdentity> {
  options.signal?.throwIfAborted();
  const nodeProblem = contractProofNodeProblem();
  if (nodeProblem) throw new Error(nodeProblem);
  const root = realpathSync(rootInput), before = readSourceManifest(root);
  const source: Record<string, string> = Object.create(null);
  for (const [name, entry] of Object.entries(before.files)) {
    if (name === "graphql-chain.review.json") continue;
    const bytes = fixedContractBytes(root, name)!;
    if (digest(bytes) !== entry.hash) throw new Error("Source changed while capturing portable contract inputs.");
    source[name] = contractSourceFileDigest(name, bytes);
  }
  const locked = contractDependencyLock(root);
  const packages = Object.fromEntries(TOOL_PACKAGES.map(([issuer, name]) => {
    const installed = packageVersion(root, issuer, name);
    if (locked.packages[installed.location]?.version !== installed.version) throw new Error(`The installed contract tool does not match the committed lockfile: ${name}`);
    return [`${issuer}:${name}`, installed.version];
  }));
  const toolchain: ProofToolchain = { node: process.versions.node, packages, lockfileDigest: locked.digest,
    dependencyDigest: await portableDependencyDigest(root, locked.packages, locked.digest, PORTABLE_NORMALIZATION_PROFILE, options.signal) };
  options.signal?.throwIfAborted();
  const files = contractSourceGroups(root, source);
  const databaseOutputs = Object.fromEntries(DATABASE_RUNTIME_OUTPUTS.map(name => {
    const bytes = fixedContractBytes(root, name, true);
    return [name, bytes ? databaseRuntimeArtifactDigest(name, bytes) : null];
  }));
  const policy = options.policy ?? portableProofPolicy();
  if (!policy.id || !/^[a-f0-9]{64}$/.test(policy.digest)) throw new Error("The pinned contract verification policy is invalid.");
  if (readSourceManifest(root).digest !== before.digest) throw new Error("Source changed while capturing portable contract inputs.");
  return { version: 1, sourceRevision: fingerprint(source), policy, toolchain,
    inputs: { database: fingerprint(files.database), api: fingerprint(files.api), codegen: fingerprint(files.codegen), client: fingerprint(files.client) },
    outputs: { database: fingerprint(databaseOutputs), generated: fingerprint(files.generated) }, files };
}

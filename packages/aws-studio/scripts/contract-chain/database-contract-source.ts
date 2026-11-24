import { createHmac, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { computeExecutionHash } from "@prisma/orm-framework/contract/hashing";
import type { ContractSourceDiagnostic, PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { buildSymbolTable, isPrismaNextSchema, mapPslDiagnostics } from "@prisma/orm-framework/psl-parser";
import { hasPslInterpreter, withSeedDiagnostics } from "@prisma/orm-framework/psl-parser/interpret";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { notOk } from "@prisma/orm-framework/utils/result";
import type { DatabaseDiagnostic, DatabaseValidation, EmittedContractEvidence } from "./declared-schema-model";
import { configurationSourceFiles } from "../../database/configuration-inputs";
import { readClientAccess, registerAccessModules, type AccessModules, type ClientAccessProblem } from "../../database/client-access";
import { sourceAccessModules } from "./access-modules";
import { CONTRACT_FILE, parseDeclaredSchema } from "./declared-schema";
import { EditError } from "../source/io";
import { createHash } from "node:crypto";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const CONFIG_FILE = "packages/database/prisma.config.ts";
const MAX_SOURCE = 512 * 1024;
const configurationSalt = randomBytes(32);

/** Private values contribute only through a per-process keyed digest, never browser-readable hashes. */
export function databaseConfigurationRevision(root: string, files?: Set<string>): string {
  const digest = createHmac("sha256", configurationSalt);
  const visit = (file: string) => {
    files?.add(file);
    if (!existsSync(file)) { digest.update(file + ":missing\n"); return; }
    const contents = readFileSync(file, "utf8"); digest.update(file + "\0" + contents + "\0");
  };
  for (const file of configurationSourceFiles(root)) visit(file);
  for (const relative of [".env", "packages/database/.env"]) visit(path.join(root, relative));
  // Authored config may condition extension composition on inherited environment.
  for (const name of Object.keys(process.env).sort()) digest.update(name + "\0" + process.env[name] + "\0");
  return digest.digest("hex");
}

/** Server-only watch inputs; contains paths, never dotenv or environment values. */
export function databaseConfigurationSourceFiles(root: string): readonly string[] {
  const files = new Set<string>();
  databaseConfigurationRevision(root, files);
  return [...files];
}

export function checkSource(source: unknown): asserts source is string {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_SOURCE) throw new EditError(400, "A schema draft must be text smaller than 512 KiB. Nothing was saved.");
}

function rangedDiagnostic(diagnostic: ContractSourceDiagnostic, length: number): DatabaseDiagnostic {
  const from = Math.min(length, Math.max(0, diagnostic.span?.start.offset ?? 0));
  return { from, to: Math.min(length, Math.max(from + 1, diagnostic.span?.end.offset ?? from + 1)), severity: diagnostic.severity ?? "error", code: diagnostic.code, message: diagnostic.message };
}

/** A misplaced or unknown `// @access` setting would fail database generation, so it fails validation. */
/** An access problem at the column the compiler names, to the end of that word; the whole line without one. */
function accessDiagnostic(source: string, problem: ClientAccessProblem): DatabaseDiagnostic {
  let lineStart = 0;
  for (let line = 1; line < problem.line; line++) {
    const next = source.indexOf("\n", lineStart);
    if (next < 0) break;
    lineStart = next + 1;
  }
  const newline = source.indexOf("\n", lineStart);
  const lineEnd = newline < 0 ? source.length : newline;
  const from = problem.column ? Math.min(lineEnd, lineStart + problem.column - 1) : lineStart;
  const word = /^[\w.@-]+/.exec(source.slice(from, lineEnd))?.[0].length ?? 0;
  const to = problem.column ? from + word : lineEnd;
  return { from, to: Math.min(source.length, Math.max(from + 1, to)), severity: "error", code: problem.code ?? "FIELD_ACCESS", message: problem.message };
}

function isSourceDiagnostic(value: unknown): value is ContractSourceDiagnostic {
  return !!value && typeof value === "object" && "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string" && "sourceId" in value && typeof value.sourceId === "string";
}

/** Load the actual authored Prisma config. Never construct a second set of target/extension settings. */
export async function databasePrismaConfig(root: string): Promise<PrismaNextConfig> {
  const { loadConfig, requireConfigSections } = await import("@prisma/orm-toolchain/config-loader");
  const loaded = await loadConfig(path.join(root, CONFIG_FILE), { cwd: path.join(root, "packages/database") });
  if (!loaded.ok) throw new EditError(422, `Prisma configuration could not be loaded. Check ${CONFIG_FILE}. Nothing was saved.`);
  const required = requireConfigSections(loaded.value, ["family", "target", "adapter", "extensions", "contract"]);
  if (!required.ok) throw new EditError(422, `Prisma configuration is invalid. Check ${CONFIG_FILE}. Nothing was saved.`);
  const config = required.value;
  if (config.target.targetId !== "postgres" || !config.contract || config.contract.source.inputs?.length !== 1 || path.resolve(config.contract.source.inputs[0]!) !== path.join(root, CONTRACT_FILE)) {
    throw new EditError(422, `This workbench supports the single authored PostgreSQL contract at ${CONTRACT_FILE}. Review the Prisma configuration in your editor.`);
  }
  return config;
}

export interface CompiledDatabaseSource {
  readonly validation: DatabaseValidation;
  readonly access: ReturnType<typeof readClientAccess>;
  readonly contract?: Contract;
  readonly config: PrismaNextConfig;
  readonly configRevision: string;
}

/**
 * Canonical Prisma source loading, with the exact draft replacing the one source
 * provider's disk read. The provider's interpreter and the canonical control
 * stack own semantics. No output is emitted, no file is written, no DB connects.
 */
export async function compileDatabaseSource(root: string, source: string, signal?: AbortSignal): Promise<CompiledDatabaseSource> {
  // contract.prisma's Access Graph directives read the access policy module; a module that
  // cannot load is a validation error of the draft, never a silent fallback.
  let accessModules: AccessModules | undefined;
  let accessModuleProblem: string | undefined;
  try { accessModules = await sourceAccessModules(root); }
  catch (error) { accessModuleProblem = `The access policy module (packages/database/prisma/access) could not be loaded: ${error instanceof Error ? error.message : String(error)}`; }
  checkSource(source);
  signal?.throwIfAborted();
  const config = await databasePrismaConfig(root);
  const configRevision = databaseConfigurationRevision(root);
  const { loadContractSource } = await import("@prisma/orm-toolchain/cli/control-api");
  const provider = config.contract!.source;
  if (!hasPslInterpreter(provider)) throw new EditError(422, "The configured Prisma source does not expose the Prisma 8 interpreter. Open this contract in your editor.");
  const warnings: ContractSourceDiagnostic[] = [];
  const draftProvider = {
    ...provider,
    async load(context: Parameters<typeof provider.load>[0]) {
      if (!isPrismaNextSchema(source)) return notOk({ summary: "The Prisma 8 directive is required.", diagnostics: [{ code: "PSL_NO_OPTED_IN_SCHEMA_FILES", message: 'Add "// use prisma-8" at the beginning of this Prisma 8 contract.', sourceId: CONTRACT_FILE }] });
      const parsed = parse(source, CONTRACT_FILE);
      const symbols = buildSymbolTable({ documents: [parsed.document], sources: parsed.sources });
      const seed = mapPslDiagnostics([...parsed.diagnostics, ...symbols.diagnostics], parsed.sources);
      return withSeedDiagnostics(provider.interpret({ documents: [parsed.document], sources: parsed.sources, symbolTable: symbols.symbolTable }, context), seed);
    },
  };
  const result = await loadContractSource({ ...config, contract: { ...config.contract!, source: draftProvider } }, { signal, onWarning: warning => {
    if (isSourceDiagnostic(warning)) warnings.push(warning);
  } });
  signal?.throwIfAborted();
  if (databaseConfigurationRevision(root) !== configRevision) throw new EditError(409, "Prisma configuration changed during validation. Validate the draft again; nothing was written.");
  registerAccessModules(accessModules);
  const access = readClientAccess(source, accessModules);
  const accessDiagnostics = [
    ...(accessModuleProblem ? [{ from: 0, to: Math.min(source.length, 1), severity: "error" as const, code: "AG-POLICY", message: accessModuleProblem }] : []),
    ...access.problems.map(problem => accessDiagnostic(source, problem)),
  ];
  const diagnostics = [...[...(result.ok ? [] : result.failure.diagnostics), ...warnings].filter(isSourceDiagnostic).map(item => rangedDiagnostic(item, source.length)), ...accessDiagnostics];
  const contract = result.ok ? result.value : undefined;
  return {
    config, configRevision, contract, access,
    validation: {
      sourceHash: sha256(source), valid: result.ok && !accessDiagnostics.length, diagnostics,
      ...(contract ? { schema: parseDeclaredSchema(source), storageHash: contract.storage.storageHash, executionHash: contract.execution?.executionHash } : {}),
      validatedAt: new Date().toISOString(),
    },
  };
}

export async function emittedContractEvidence(root: string, compiled: CompiledDatabaseSource): Promise<EmittedContractEvidence> {
  const output = compiled.config.contract?.output;
  const relative = output ? path.relative(root, output).replaceAll("\\", "/") : "";
  const base = { file: relative && !relative.startsWith("../") && !path.isAbsolute(relative) ? relative : "Configured generated contract", observedAt: new Date().toISOString(), revision: "missing" };
  if (!output) return { ...base, status: "missing", message: "The Prisma configuration does not name emitted output. No artifacts were generated." };
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return { ...base, status: "unknown", message: "Configured output is outside this checkout. Review it in your editor; Studio did not read or write that file." };
  if (!existsSync(output)) return { ...base, status: "missing", message: "Emitted contract artifacts are missing. Generate separately after reviewing saved source; no migration or database change is implied." };
  try {
    let component = root;
    for (const segment of relative.split("/")) { component = path.join(component, segment); if (lstatSync(component).isSymbolicLink()) throw new Error("Linked generated artifact"); }
    if (lstatSync(output).size > 5 * 1024 * 1024) throw new Error("Generated artifact too large");
    const contents = readFileSync(output, "utf8");
    const json = JSON.parse(contents);
    const contract = compiled.config.target.contractSerializer.deserializeContract(json);
    const { createSnapshotContentVerifier } = await import("@prisma/orm-postgres/migration-tools/contract-snapshot-store");
    createSnapshotContentVerifier(compiled.config.target.contractSerializer.hashCanonicalizationHooks).assertSnapshotContentMatches(json, contract.storage.storageHash, output);
    const execution = json.execution;
    if (execution) {
      const { executionHash, ...body } = execution;
      if (computeExecutionHash({ target: contract.target, targetFamily: contract.targetFamily, execution: body }) !== executionHash) throw new Error("Invalid emitted execution hash");
    }
    const evidence = { ...base, revision: sha256(contents), storageHash: contract.storage.storageHash, executionHash: contract.execution?.executionHash };
    if (!compiled.validation.valid) return { ...evidence, status: "unknown", message: "Emitted artifact integrity is valid, but saved source is invalid and cannot provide a comparison baseline." };
    const storageMatches = contract.storage.storageHash === compiled.validation.storageHash;
    const executionMatches = contract.execution?.executionHash === compiled.validation.executionHash;
    return { ...evidence, status: storageMatches && executionMatches ? "matches" : "differs", storageMatches, executionMatches,
      message: storageMatches && executionMatches ? "Emitted storage and execution hashes match saved source. This does not establish migration or live database state." : storageMatches ? "Saved execution behavior differs from generated artifacts, while storage matches. Regenerate artifacts separately; storage SQL may be unnecessary." : "Saved storage differs from generated artifacts. Generate separately, then review a migration plan; no artifact or database has been changed." };
  } catch { return { ...base, status: "invalid", message: "The emitted contract is unreadable, invalid, linked, too large, or does not reproduce its canonical storage/execution hashes. Regenerate artifacts separately from reviewed saved source." }; }
}


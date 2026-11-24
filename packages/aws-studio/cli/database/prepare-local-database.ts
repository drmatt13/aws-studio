import path from "node:path";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { createControlClient, loadContractSource, type ControlClient } from "@prisma/orm-toolchain/cli/control-api";
import { loadConfig, requireConfigSections } from "@prisma/orm-toolchain/config-loader";
import { isDatabaseEmpty } from "aws-studio/database/empty-database";
import { databaseInputsDigest, digest, guardCloudDatabasePath, localDatabaseInputs, planDatabaseInitialization } from "aws-studio/database/studio-migrations";

export interface LocalDatabasePreparation {
  readonly ok: boolean;
  readonly status: "verified" | "initialized" | "blocked" | "failed";
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
  /** Source/dependency identity verified by this image; contains no dotenv inputs. */
  readonly inputsDigest?: string;
  /** Per-file local identities of the same inputs, so Studio can name what changed later. */
  readonly inputs?: Readonly<Record<string, string>>;
}

interface PreparedContract { readonly config: PrismaNextConfig; readonly contract: Contract }
interface PreparationDependencies {
  readonly load?: (root: string) => Promise<PreparedContract>;
  readonly client?: (config: PrismaNextConfig, connection: string) => ControlClient;
  readonly empty?: typeof isDatabaseEmpty;
  readonly inputsDigest?: typeof databaseInputsDigest;
  readonly localInputs?: typeof localDatabaseInputs;
  readonly plan?: typeof planDatabaseInitialization;
  readonly guard?: typeof guardCloudDatabasePath;
}

/** A startup action must never follow an inherited URL to another database.
 * Loopback is an explicit module-only option for isolated PostgreSQL tests;
 * the Compose entrypoint accepts only its postgres service and fixed database.
 * Reject query parameters: libpq/pg accepts parameters that override URL fields.
 */
export function localPreparationConnection(connection: string | undefined, allowLoopback = false): string {
  let url: URL;
  try { url = new URL(connection ?? ""); } catch { throw new Error("LOCAL_DATABASE_TARGET_REFUSED"); }
  const allowedHost = url.hostname === "postgres" || allowLoopback && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !allowedHost || url.pathname !== "/app_db" || url.username !== "admin" || url.search || url.hash || (!allowLoopback || url.hostname === "postgres") && url.port !== "" && url.port !== "5432") throw new Error("LOCAL_DATABASE_TARGET_REFUSED");
  return url.toString();
}

/** Compile authored source without writing generated files or advancing refs. */
export async function loadLocalDatabaseContract(root: string): Promise<PreparedContract> {
  const database = path.join(root, "packages/database");
  const loaded = await loadConfig(path.join(database, "prisma.config.ts"), { cwd: database });
  if (!loaded.ok) throw new Error("LOCAL_DATABASE_CONFIG_INVALID");
  const required = requireConfigSections(loaded.value, ["family", "target", "adapter", "extensions", "contract"]);
  if (!required.ok) throw new Error("LOCAL_DATABASE_CONFIG_INVALID");
  const config = required.value;
  if (config.target.targetId !== "postgres" || config.contract?.source.inputs?.length !== 1 || path.resolve(config.contract.source.inputs[0]!) !== path.join(database, "prisma/contract.prisma")) throw new Error("LOCAL_DATABASE_CONFIG_INVALID");
  const compiled = await loadContractSource(config);
  if (!compiled.ok) throw new Error("LOCAL_DATABASE_CONTRACT_INVALID");
  return { config, contract: compiled.value };
}

interface VerifiedInputs { readonly inputsDigest: string; readonly inputs: Readonly<Record<string, string>> }
function result(status: LocalDatabasePreparation["status"], code: string, message: string, verified?: VerifiedInputs): LocalDatabasePreparation {
  const ok = status === "verified" || status === "initialized";
  return { ok, status, code, message, exitCode: ok ? 0 : status === "blocked" ? 4 : 1, ...(ok && verified ? verified : {}) };
}

/** Inspect only stable driver codes; provider messages can contain credentials. */
function connectionFailure(error: unknown): LocalDatabasePreparation | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length && seen.size < 12) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const entry = value as Record<string, unknown>;
    if (entry.code === "3D000" || entry.sqlState === "3D000") return result("failed", "LOCAL_DATABASE_MISSING", "PostgreSQL is reachable, but the configured local database does not exist in this retained cluster. Inspect the local Compose database settings and existing databases before repairing it. Startup did not reset the volume or recreate a missing database inside an existing cluster.");
    if ([entry.code, entry.sqlState].some(code => code === "28P01" || code === "28000")) return result("failed", "LOCAL_DATABASE_LOGIN_FAILED", "PostgreSQL rejected the configured local login. Changing POSTGRES_USER or POSTGRES_PASSWORD does not update roles in an existing volume. Review the local Compose settings and retained PostgreSQL roles; startup did not change logins or reset storage.");
    for (const key of ["cause", "originalError", "driverError", "error", "failure", "meta"]) if (entry[key] && typeof entry[key] === "object") pending.push(entry[key]);
  }
  return undefined;
}

function blocked(code: string): LocalDatabasePreparation {
  if (code === "CONTRACT.MARKER_MISMATCH") return result("blocked", code, "Local database and checkout use different contract versions. Open Database → Database status and inspect Local PostgreSQL to review a matching migration path. After a branch switch, the database may be ahead or on another branch; use the matching checkout or an isolated local project. Startup did not migrate, downgrade or reset existing data.");
  if (code === "CONTRACT.SCHEMA_VERIFICATION_FAILED") return result("blocked", code, "Local database schema differs from its saved contract. Open Database → Database status and inspect Local PostgreSQL before reviewing a repair or migration. Startup did not change existing data.");
  return result("blocked", "LOCAL_DATABASE_NOT_EMPTY", "Local database contains objects but has no application signature. Open Database → Database status and inspect Local PostgreSQL. Startup will not adopt, sign, migrate or reset an existing database.");
}

async function verify(client: ControlClient, contract: Contract, migrationsDir: string): Promise<LocalDatabasePreparation | undefined> {
  const checked = await client.dbVerify({ contract, migrationsDir, strict: true, skipSchema: false, skipMarker: false });
  if (!checked.ok) return result("failed", "LOCAL_DATABASE_VERIFICATION_FAILED", "Local database verification could not complete. Inspect Local PostgreSQL and migration history in Database → Database status.");
  if (checked.value.markerDrift) return blocked("CONTRACT.MARKER_MISMATCH");
  if (checked.value.unclaimed.length || [...checked.value.schemaResults.values()].some(schema => !schema.ok)) return blocked("CONTRACT.SCHEMA_VERIFICATION_FAILED");
  return undefined;
}

/** Fresh local storage is bootstrapped exactly once. Every existing database is
 * read-only here, including older, unsigned, divergent and partially initialized
 * storage. The native runner rechecks emptiness inside its transaction/locks.
 */
export async function prepareLocalDatabase(options: { readonly root: string; readonly connection: string | undefined; readonly allowLoopback?: boolean }, dependencies: PreparationDependencies = {}): Promise<LocalDatabasePreparation> {
  const clients: ControlClient[] = [];
  let initializing = false;
  let recoverInitialization: (() => Promise<LocalDatabasePreparation | undefined>) | undefined;
  try {
    const connection = localPreparationConnection(options.connection, options.allowLoopback);
    const readOnly = new URL(connection); readOnly.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=60000");
    const writable = new URL(connection); writable.searchParams.set("options", "-c statement_timeout=60000");
    const inputsDigest = dependencies.inputsDigest ?? databaseInputsDigest;
    const inputs = inputsDigest(options.root);
    const verifiedInputs: VerifiedInputs = { inputsDigest: inputs, inputs: (dependencies.localInputs ?? localDatabaseInputs)(options.root) };
    const { config, contract } = await (dependencies.load ?? loadLocalDatabaseContract)(options.root);
    const assertCurrent = () => { if (inputsDigest(options.root) !== inputs) throw new Error("LOCAL_DATABASE_SOURCE_CHANGED"); };
    assertCurrent();
    const create = dependencies.client ?? ((settings: PrismaNextConfig, selected: string) => createControlClient({ ...settings, connection: selected }));
    const open = (settings: PrismaNextConfig, selected: string) => { const client = create(settings, selected); clients.push(client); return client; };
    const reader = open(config, readOnly.toString());
    await reader.connect();
    const marker = await reader.readMarker();
    const migrationsDir = path.join(options.root, "packages/database/prisma/migrations");
    if (marker) {
      const problem = await verify(reader, contract, migrationsDir);
      assertCurrent();
      return problem ?? result("verified", "LOCAL_DATABASE_VERIFIED", "Local database verified. Existing storage was left unchanged.", verifiedInputs);
    }
    const empty = () => (dependencies.empty ?? isDatabaseEmpty)(options.root, readOnly.toString());
    if ((await reader.readAllMarkers()).size || (await reader.readLedger()).length || !await empty()) return blocked("LOCAL_DATABASE_NOT_EMPTY");
    const initialization = await (dependencies.plan ?? planDatabaseInitialization)(options.root, config, contract, reader, empty, settings => open(settings, readOnly.toString()));
    assertCurrent();
    const guarded = (dependencies.guard ?? guardCloudDatabasePath)(config, { kind: "initialize", initialization, markerIdentity: digest([]), ledgerIdentity: digest([]), migrations: [] }, assertCurrent);
    const writer = open(guarded, writable.toString());
    await writer.connect();
    assertCurrent();
    if (!await empty()) return blocked("LOCAL_DATABASE_NOT_EMPTY");
    // Another startup may win the initialization lock. A fresh full read-only
    // verification can establish readiness without repeating any write.
    recoverInitialization = async () => {
      const problem = await verify(reader, contract, migrationsDir);
      assertCurrent();
      return problem ? undefined : result("verified", "LOCAL_DATABASE_VERIFIED", "Local database verified after concurrent initialization. Existing storage was left unchanged.", verifiedInputs);
    };
    initializing = true;
    const applied = await writer.dbInit({ contract, mode: "apply", migrationsDir });
    if (!applied.ok) return await recoverInitialization() ?? result("failed", "LOCAL_DATABASE_INITIALIZATION_FAILED", "Prisma did not confirm local database initialization. Inspect Local PostgreSQL before retrying. Existing databases are never reset or adopted during startup.");
    const problem = await verify(reader, contract, migrationsDir);
    assertCurrent();
    return problem ?? result("initialized", "LOCAL_DATABASE_INITIALIZED", "Initialized the empty local database and verified its saved contract. Future starts verify existing storage without applying migrations.", verifiedInputs);
  } catch (error) {
    const connection = connectionFailure(error);
    if (connection) return connection;
    const code = error instanceof Error ? error.message : "";
    if (code === "LOCAL_DATABASE_TARGET_REFUSED") return result("failed", code, "Local database preparation accepts only the Compose postgres service, app_db database and admin login. Check the local Compose configuration; no database connection was opened.");
    if (["LOCAL_DATABASE_CONFIG_INVALID", "LOCAL_DATABASE_CONTRACT_INVALID", "LOCAL_DATABASE_SOURCE_CHANGED"].includes(code)) return result("failed", code, "The saved database contract or configuration is invalid or changed during startup. Fix source and retry local runtime; no automatic migration or reset was requested.");
    if (recoverInitialization) { try { const recovered = await recoverInitialization(); if (recovered) return recovered; } catch { /* The original failure remains unconfirmed. */ } }
    return result("failed", "LOCAL_DATABASE_PREPARATION_FAILED", initializing ? "Local database initialization could not be confirmed. Inspect Local PostgreSQL in Database → Database status before retrying." : "Local database preparation could not complete. Check that the Compose PostgreSQL service is healthy and inspect Local PostgreSQL in Database → Database status.");
  } finally {
    for (const client of clients.reverse()) { try { await client.close(); } catch { /* Never reveal private driver diagnostics. */ } }
  }
}

/** Stable bounded output: never include connection strings, SQL or driver text. */
export function localPreparationEnvelope(preparation: LocalDatabasePreparation) {
  return { kind: "result" as const, commandId: "db.prepare-local" as const, envelope: { ok: preparation.ok, commandId: "db.prepare-local", exitCode: preparation.exitCode, result: preparation, diagnostics: preparation.ok ? [] : [{ code: preparation.code, message: preparation.message }] } };
}

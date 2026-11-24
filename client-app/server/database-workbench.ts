import { applySourceAccessModules } from "aws-studio/contract-chain/access-modules";
import { checkSource, compileDatabaseSource, databaseConfigurationRevision, databasePrismaConfig, emittedContractEvidence, type CompiledDatabaseSource } from "aws-studio/contract-chain/database-contract-source";
export { compileDatabaseSource, databaseConfigurationRevision, databaseConfigurationSourceFiles, databasePrismaConfig, type CompiledDatabaseSource } from "aws-studio/contract-chain/database-contract-source";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { PrismaNextConfig } from "@prisma/orm-framework/config/config-types";
import { format as formatPrisma } from "@prisma/orm-framework/psl-parser/format";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { parseCompose, readProjectCompose } from "aws-studio/compose-services";
import type { DatabaseContractImpact, DatabaseObservation, DatabaseSaveResult, DatabaseSourceReview, DatabaseTarget, DatabaseValidation, DatabaseWorkbench } from "../shared/database-workbench";
import { readClientAccess } from "aws-studio/database/client-access";
import { canonicalPrisma, diffPrisma } from "aws-studio/contract-chain/core";
import type { DatabaseHistory } from "../shared/database-history";
import type { ControlClient } from "@prisma/orm-postgres/control";
import { CONTRACT_FILE } from "./database";
import { diffDatabaseAccess } from "./database-access-impact";
import { EditError, writeSourceChange } from "aws-studio/source/io";
import { withSourceWrite } from "aws-studio/source/source-gate";
import { sha256 } from "./files";
import { repositoryTargets } from "aws-studio/deploy/node";
import { execFileSync } from "node:child_process";

const REVIEW_TTL = 15 * 60_000;
const configurationSalt = randomBytes(32);
// Capture the inherited shell override before any custom Prisma config loads.
// The repository's config reads dotenv privately; fresh root .env supplies the fallback.
const inheritedPostgresHostPort = process.env.POSTGRES_HOST_PORT;

/** Compose resolves its own merges/interpolation without starting an engine or container. */
function effectivePostgres(root: string) {
  const replacement = process.env.FRAMEWORK_DOCKER_CLI;
  const output = execFileSync(replacement ? process.execPath : "docker", [...(replacement ? [replacement] : []), "compose", "config", "--format", "json"], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const service = parseCompose(output).services?.postgres;
  if (!service) throw new Error("No effective PostgreSQL service");
  return { environment: service.environment, ports: service.ports };
}

/** Separate, fixed PSL authority; generic framework config writers remain unchanged. */
export function databaseContractPath(root: string): string {
  const canonicalRoot = realpathSync(root);
  let current = canonicalRoot;
  for (const segment of CONTRACT_FILE.split("/")) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new EditError(422, "The authored contract uses a symbolic link. Save it in your editor; Studio does not write through links.");
  }
  if (path.relative(canonicalRoot, realpathSync(current)).replaceAll("\\", "/") !== CONTRACT_FILE) throw new EditError(422, "The contract resolves outside its fixed source authority.");
  return current;
}

export interface PrivateDatabaseTarget { readonly public: DatabaseTarget; readonly connection?: string }

/** Resolve only the declared Compose PostgreSQL binding; never inherit DATABASE_URL. */
export function resolvePrivateDatabaseTargets(root: string): readonly PrivateDatabaseTarget[] {
  let local: PrivateDatabaseTarget;
  let handoffs: NonNullable<DatabaseTarget["handoffs"]> = [];
  try { handoffs = repositoryTargets(root).filter(target => target.mode === "prod").map(target => ({ deployment: target.name, account: target.account, region: target.region, command: `npm run db:migrate:cloud -- --deployment ${target.name} -c deployment=${target.name} --profile <PROFILE>${target.region ? ` --region ${target.region}` : ""}`, detail: "Separately authorized database write: launches the declared db-migrate task inside its VPC with direct IAM/TLS access. Review migration SQL and old/new application compatibility first; task logs and exit code establish execution outcome." })); } catch { /* Invalid target catalogs remain an explicit setup prerequisite. */ }
  const production: PrivateDatabaseTarget = { public: { id: "production", label: "Production RDS", available: false, identity: sha256(JSON.stringify(["production-task-review-v1", handoffs])), handoffs, detail: "Production database access uses the declared VPC db-migrate task with private-database IAM/TLS access. Select a named deployment and profile below, check the deployed task destination, then explicitly authorize a billed read-only task. Applying reviewed SQL requires a separate approval. Direct local inspection is unavailable; Studio never opens database ingress or accepts connection URLs." } };
  try {
    const compose = readProjectCompose(root);
    const override = path.join(root, "docker-compose.override.yml");
    const postgresOverride = existsSync(override) ? parseCompose(readFileSync(override, "utf8")).services?.postgres : undefined;
    // Non-identity overrides do not change the safely established connection.
    // Identity-changing Compose merge/interpolation remains fail-closed until
    // its effective binding can be established; never silently use base ports.
    const safeOverrideKeys = new Set(["healthcheck", "restart", "labels", "logging", "deploy", "mem_limit", "cpus", "shm_size", "stop_grace_period"]);
    let postgres: { environment?: unknown; ports?: unknown } | undefined = compose.services?.postgres;
    let effective = false;
    if (postgresOverride && Object.keys(postgresOverride).some(key => !safeOverrideKeys.has(key))) {
      try {
        postgres = effectivePostgres(root); effective = true;
      } catch {
        return [{ public: { id: "local:postgres", label: "Local PostgreSQL", available: false, identity: sha256("unsupported-postgres-override"), detail: "Compose overrides PostgreSQL and its effective configuration could not be resolved. Install the Compose CLI and resolve docker compose config errors, then refresh. Studio does not start containers or expose connection values." } }, production];
      }
    }
    const environment = postgres?.environment;
    const env = Array.isArray(environment) ? Object.fromEntries(environment.flatMap(item => typeof item === "string" && item.includes("=") ? [[item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]] : [])) : environment;
    const inputs = existsSync(path.join(root, ".env")) ? parseEnv(readFileSync(path.join(root, ".env"), "utf8")) : {};
    const effectiveBinding = effective && Array.isArray(postgres?.ports) ? postgres.ports.find((value: unknown) => !!value && typeof value === "object" && (value as Record<string, unknown>).host_ip === "127.0.0.1" && Number((value as Record<string, unknown>).target) === 5432 && ((value as Record<string, unknown>).protocol ?? "tcp") === "tcp") as Record<string, unknown> | undefined : undefined;
    const portInput = effective ? String(effectiveBinding?.published ?? "") : inheritedPostgresHostPort ?? inputs.POSTGRES_HOST_PORT;
    const ports = postgres?.ports;
    if (!postgres || !env || !Array.isArray(ports) || (effective ? !effectiveBinding || ports.some((value: unknown) => !!value && typeof value === "object" && Number((value as Record<string, unknown>).target) === 5432 && (value as Record<string, unknown>).host_ip !== "127.0.0.1") : !ports.some(value => value === "127.0.0.1:${POSTGRES_HOST_PORT}:5432")) || !portInput || !/^\d+$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535) throw new Error("Unsupported Compose connection");
    const value = (key: string) => { const raw = (env as Record<string, unknown>)[key]; if (typeof raw !== "string" || raw.includes("${")) throw new Error("Nonliteral Compose connection"); return raw; };
    const connection = new URL(`postgresql://127.0.0.1:${Number(portInput)}`);
    connection.username = value("POSTGRES_USER"); connection.password = value("POSTGRES_PASSWORD"); connection.pathname = `/${value("POSTGRES_DB")}`;
    // Enforce read-only at the PostgreSQL session level as well as API selection.
    connection.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=15000");
    connection.searchParams.set("connect_timeout", "5");
    local = { public: { id: "local:postgres", label: "Local PostgreSQL", available: true, identity: createHmac("sha256", configurationSalt).update(connection.toString()).digest("hex"), detail: `Compose postgres · loopback port ${Number(portInput)} · existing database only` }, connection: connection.toString() };
  } catch {
    local = { public: { id: "local:postgres", label: "Local PostgreSQL", available: false, identity: sha256("unconfigured-local"), detail: "Set POSTGRES_HOST_PORT in root .env and use the declared loopback Compose binding. Studio never starts Compose." } };
  }
  return [local, production];
}

const OBSERVATION_LIMITS = [
  "Prisma strict schema verification covers modeled storage objects; it does not establish data correctness, backfill completion, or downstream application compatibility.",
  "PostgreSQL views, triggers, functions and other unsupported objects may require separate review.",
  "A matching marker alone is not physical-schema evidence. Creation and application timestamps have different meanings.",
];

export type DatabaseInspectionClient = Pick<ControlClient, "connect" | "close" | "readMarker" | "readLedger" | "schemaVerify">;

/** Projection only: compilation was already performed for source review. No artifact generation or downstream checks. */
export function databaseContractImpact(
  before: string,
  after: string,
  previous?: DatabaseValidation,
  current?: DatabaseValidation,
  compiledAccess?: { readonly before: CompiledDatabaseSource["access"]; readonly after: CompiledDatabaseSource["access"] },
): DatabaseContractImpact {
  const oldShape = canonicalPrisma(before), nextShape = canonicalPrisma(after);
  const diffs = diffPrisma(oldShape.models, nextShape.models);
  const accessChanges = previous?.valid && current?.valid
    ? diffDatabaseAccess(compiledAccess?.before ?? readClientAccess(before), compiledAccess?.after ?? readClientAccess(after))
    : [];
  const comparable = previous?.valid && current?.valid && !!previous.storageHash && !!current.storageHash;
  const storageChanged = comparable && (previous.storageHash !== current.storageHash || previous.executionHash !== current.executionHash);
  const semantics = diffs.length || accessChanges.length || storageChanged ? "changed"
    : comparable && !oldShape.diagnostics.length && !nextShape.diagnostics.length ? "unchanged" : "unknown";
  const changed = semantics !== "unchanged";
  const allModels = new Set([...Object.keys(oldShape.models), ...Object.keys(nextShape.models)]);
  const affected = [...diffs, ...accessChanges].map(diff => diff.subject).filter(subject => allModels.has(subject));
  return { revision: sha256(after), beforeRevision: sha256(before),
    models: [...new Set(affected.length ? affected : storageChanged || semantics === "unknown" ? allModels : [])].sort(),
    diffs, ...(accessChanges.length ? { accessChanges } : {}), semantics, stages: changed ? ["api", "codegen", "client"] : [], earliestStage: changed ? "api" : null };
}

/** The GraphQL API's generated authorization record, if present and well formed; otherwise nothing. */
export const AUTHORIZATION_RECORD = "compute/http/graphql-api/authorization/record.json";
export function authorizationRecord(root: string): Pick<DatabaseWorkbench, "authorization"> {
  try {
    const file = path.join(root, AUTHORIZATION_RECORD);
    if (!existsSync(file)) return {};
    const operations = (JSON.parse(readFileSync(file, "utf8")) as { operations?: unknown }).operations;
    if (!operations || typeof operations !== "object") return {};
    const entries = Object.entries(operations).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((rule) => typeof rule === "string"));
    return { authorization: { operations: Object.fromEntries(entries) } };
  } catch {
    return {};
  }
}

export class DatabaseWorkbenchService {
  readonly ownWrites = new Map<string, string>();
  private readonly reviews = new Map<string, DatabaseSourceReview & { readonly contractImpact: DatabaseContractImpact }>();
  private readonly compiled = new Map<string, CompiledDatabaseSource>();
  private saving = false;

  constructor(readonly root: string, private readonly refresh?: () => Promise<unknown>, private readonly inspectionClient?: (connection: string, config: PrismaNextConfig) => DatabaseInspectionClient) {}

  async compile(source: string, signal?: AbortSignal): Promise<CompiledDatabaseSource> {
    checkSource(source);
    // Config identity is part of every cache key; source text is never keyed by a generation alone.
    const key = databaseConfigurationRevision(this.root) + ":" + sha256(source);
    signal?.throwIfAborted();
    const existing = this.compiled.get(key);
    if (existing) return existing;
    const result = await compileDatabaseSource(this.root, source, signal);
    if (this.compiled.size >= 12) this.compiled.delete(this.compiled.keys().next().value!);
    this.compiled.set(result.configRevision + ":" + sha256(source), result);
    return result;
  }

  async load(): Promise<DatabaseWorkbench> {
    const source = readFileSync(databaseContractPath(this.root), "utf8");
    const accessModules = await applySourceAccessModules(this.root);
    const compiled = await this.compile(source);
    const { validation, configRevision } = compiled;
    return { file: CONTRACT_FILE, source, ...(accessModules ? { accessModules } : {}), revision: sha256(source), configRevision, validation,
      capabilities: { dialect: "Prisma 8 · installed 8.0.0-rc.14", semanticValidation: true, formatting: true, languageServer: false,
        notes: ["Validation and formatting use the installed Prisma 8 parser and configured PostgreSQL interpreter.", "Completion provides syntax and local model suggestions. A compatible distributable language server is not exported by the installed packages; semantic completion, refactoring and safe rename are unavailable.", "The diagram is a projection. Valid declarations outside its supported surface remain accessible in source."] },
      targets: resolvePrivateDatabaseTargets(this.root).map(target => target.public), ...authorizationRecord(this.root), emitted: await emittedContractEvidence(this.root, compiled) };
  }

  async validate(source: string, signal?: AbortSignal): Promise<DatabaseValidation> { return (await this.compile(source, signal)).validation; }

  async format(source: string): Promise<{ source: string; sourceHash: string; formattedHash: string }> {
    checkSource(source);
    if (parse(source, CONTRACT_FILE).diagnostics.length) throw new EditError(422, "Fix the draft syntax diagnostics before formatting. Your text and undo history are unchanged.");
    const config = await databasePrismaConfig(this.root);
    const formatted = formatPrisma(source, config.formatter);
    return { source: formatted, sourceHash: sha256(source), formattedHash: sha256(formatted) };
  }

  async review(source: string, expectedRevision: string): Promise<DatabaseSourceReview> {
    checkSource(source);
    const before = readFileSync(databaseContractPath(this.root), "utf8");
    if (sha256(before) !== expectedRevision) throw new EditError(409, "Saved source changed outside this draft. Your draft is preserved. Compare it with the new saved source before reviewing again.");
    if (source === before) throw new EditError(422, "The draft already matches saved source. Nothing needs saving.");
    const { validation, configRevision, access } = await this.compile(source);
    if (!validation.valid) throw new EditError(422, "The draft has Prisma diagnostics. Fix them before reviewing a source save. Nothing was written.");
    const previous = await this.compile(before);
    if (sha256(readFileSync(databaseContractPath(this.root), "utf8")) !== expectedRevision) throw new EditError(409, "Source changed during validation. Your draft is preserved; review the new saved source.");
    const now = Date.now();
    for (const [id, item] of this.reviews) if (Date.parse(item.expiresAt) <= now) this.reviews.delete(id);
    if (previous.configRevision !== configRevision || databaseConfigurationRevision(this.root) !== configRevision) throw new EditError(409, "Prisma configuration changed while reviewing source. Validate and review again; nothing was saved.");
    const contractImpact = databaseContractImpact(before, source, previous.validation, validation, { before: previous.access, after: access });
    const review = { reviewId: randomUUID(), file: CONTRACT_FILE, before, after: source, expectedRevision, configRevision, sourceHash: sha256(source), expiresAt: new Date(now + REVIEW_TTL).toISOString(), validation, contractImpact,
      effects: ["Writes only the authored contract.prisma source after this review.", "Does not emit generated artifacts, create a migration, connect to a database, or apply storage changes.", "After saving, review downstream types, repositories, GraphQL authorization and client impact; generation remains a separate action."] };
    this.reviews.set(review.reviewId, review);
    return review;
  }

  async save(reviewId: string): Promise<DatabaseSaveResult> {
    return withSourceWrite(this.root, () => this.saveOwned(reviewId));
  }
  private async saveOwned(reviewId: string): Promise<DatabaseSaveResult> {
    if (this.saving) throw new EditError(409, "Another source save is running. Retry after it completes.");
    const review = this.reviews.get(reviewId);
    if (!review || Date.parse(review.expiresAt) <= Date.now()) throw new EditError(409, "This source review expired. Review the draft again; nothing was saved.");
    this.saving = true;
    try {
      const file = databaseContractPath(this.root);
      if (readFileSync(file, "utf8") !== review.before) throw new EditError(409, "Saved source changed after review. Your draft is preserved. Review the new saved source before saving.");
      if (databaseConfigurationRevision(this.root) !== review.configRevision) throw new EditError(409, "The Prisma configuration changed after review. Validate and review again; nothing was saved.");
      const validation = await compileDatabaseSource(this.root, review.after);
      if (!validation.validation.valid) throw new EditError(422, "The reviewed source no longer validates with the current Prisma configuration. Nothing was saved; validate and review again.");
      if (validation.configRevision !== review.configRevision || validation.validation.storageHash !== review.validation.storageHash || validation.validation.executionHash !== review.validation.executionHash) throw new EditError(409, "The reviewed Prisma semantics changed before saving. Review again; nothing was saved.");
      writeSourceChange(this.root, file, review.before, review.after);
      this.ownWrites.set(CONTRACT_FILE, review.sourceHash);
      this.reviews.clear();
      let refreshed = true;
      try { if (this.refresh) refreshed = (await this.refresh()) !== undefined; } catch { refreshed = false; }
      return { saved: true, revision: review.sourceHash, source: review.after, file: CONTRACT_FILE, refresh: refreshed ? "complete" : "unavailable", contractImpact: review.contractImpact, message: refreshed ? "Authored schema saved. Generated artifacts and databases were not changed." : "Authored schema saved. The framework graph could not refresh; retry refresh. Generated artifacts and databases were not changed." };
    } finally { this.saving = false; }
  }

  async inspect(targetId: string, expectedRevision: string, historyRevision = "", history?: DatabaseHistory): Promise<DatabaseObservation> {
    const target = resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === targetId);
    if (!target) throw new EditError(400, "Choose a database target before inspection.");
    const source = readFileSync(databaseContractPath(this.root), "utf8");
    if (sha256(source) !== expectedRevision) throw new EditError(409, "Saved source changed. Reload it before inspecting this target.");
    const { contract, validation, config, configRevision } = await this.compile(source);
    const base = { id: randomUUID(), targetId: target.public.id, targetIdentity: target.public.identity, observedAt: new Date().toISOString(), savedRevision: expectedRevision, historyRevision,
      baseline: { label: "Saved authored contract", storageHash: validation.storageHash }, marker: { status: "unknown" as const }, physical: { status: "unknown" as const, issues: [], warnings: [] }, ledger: [], migrationState: { status: "unknown" as const, message: "No database migration evidence has been observed." }, limits: OBSERVATION_LIMITS };
    if (!target.public.available || !target.connection) return { ...base, status: "unsupported", message: target.public.detail };
    if (!contract) return { ...base, status: "unsupported", message: "Saved source is invalid. Fix and review a source save before comparing its storage contract with a database." };
    const { createPostgresControlClient } = await import("@prisma/orm-postgres/control");
    const client = this.inspectionClient?.(target.connection, config) ?? createPostgresControlClient({ connection: target.connection, extensions: config.extensions });
    try {
      await client.connect();
      // All operations use Prisma's read-only control capabilities. No migration modules execute.
      const marker = await client.readMarker();
      const ledger = await client.readLedger();
      const physical = await client.schemaVerify({ contract, strict: true });
      const historical = marker ? history?.snapshots.find(snapshot => snapshot.hash === marker.storageHash && snapshot.available && !snapshot.issues.length)?.contract : undefined;
      let historicalPhysical: DatabaseObservation["historicalPhysical"];
      if (marker && historical && marker.storageHash !== contract.storage.storageHash) {
        try {
          const historicalContract = config.target.contractSerializer.deserializeContract(historical);
          const checked = await client.schemaVerify({ contract: historicalContract, strict: true });
          historicalPhysical = { storageHash: marker.storageHash, status: checked.ok ? "matches" : "differs", issues: checked.schema.issues.map(issue => JSON.stringify(issue)), warnings: checked.schema.warnings?.issues.map(issue => JSON.stringify(issue)) ?? [] };
        } catch { historicalPhysical = { storageHash: marker.storageHash, status: "unknown", issues: ["The marker's historical snapshot could not be verified with the installed Prisma target."], warnings: [] }; }
      }
      const stale = sha256(readFileSync(databaseContractPath(this.root), "utf8")) !== expectedRevision || databaseConfigurationRevision(this.root) !== configRevision || resolvePrivateDatabaseTargets(this.root).find(item => item.public.id === targetId)?.public.identity !== target.public.identity;
      const issues = physical.schema.issues.map(issue => typeof issue === "object" ? JSON.stringify(issue) : String(issue));
      const warnings = physical.schema.warnings?.issues.map(issue => typeof issue === "object" ? JSON.stringify(issue) : String(issue)) ?? [];
      const markerMatches = marker?.storageHash === contract.storage.storageHash;
      let migrationState: DatabaseObservation["migrationState"] = { status: "unknown", message: "The migration graph cannot explain this database yet. Review marker, snapshots and package integrity before selecting a baseline." };
      if (markerMatches) migrationState = { status: physical.ok ? "current" : "divergent", message: physical.ok ? "The marker and modeled physical schema match saved source." : "The marker names saved source, but physical verification found differences: schema drift exists within Prisma's modeled surface." };
      else if (historicalPhysical?.status === "differs") migrationState = { status: "divergent", message: "The physical schema differs from the known historical contract named by its marker: schema drift exists within Prisma's modeled surface." };
      else if (historicalPhysical?.status === "matches" && history && !history.issues.some(issue => issue.code !== "branch") && history.migrations.every(item => item.integrity === "verified" && !item.issues.length)) {
        const { hasMigrationPath } = await import("@prisma/orm-toolchain/cli/control-api");
        const edges = history.migrations.filter(item => item.space === "app").map(item => ({ from: item.from ?? "@empty", to: item.to, migrationHash: item.migrationHash, dirName: item.name, createdAt: item.createdAt, invariants: [] }));
        const forwardChain = new Map<string, typeof edges>(); const reverseChain = new Map<string, typeof edges>();
        for (const edge of edges) { forwardChain.set(edge.from, [...(forwardChain.get(edge.from) ?? []), edge]); reverseChain.set(edge.to, [...(reverseChain.get(edge.to) ?? []), edge]); }
        const reachable = hasMigrationPath({ nodes: new Set(edges.flatMap(edge => [edge.from, edge.to])), forwardChain, reverseChain, migrationByHash: new Map(edges.map(edge => [edge.migrationHash, edge])) }, marker!.storageHash, contract.storage.storageHash);
        migrationState = reachable ? { status: "pending", message: "Physical storage matches the marker's historical snapshot, and Prisma finds a forward graph path to saved source. Pending migration packages still require operation, invariant and data-transform review before execution." } : { status: "unknown", message: "Physical storage matches a known historical contract, but no recorded forward path reaches saved source. Plan from a reviewed baseline; do not assume the newest folder is the origin." };
      }
      return { ...base, status: stale ? "stale" : "observed", observedAt: new Date().toISOString(),
        marker: { status: marker ? markerMatches ? "matches" : "differs" : "missing", ...(marker ? { storageHash: marker.storageHash, updatedAt: marker.updatedAt.toISOString() } : {}) },
        physical: { status: physical.ok ? "matches" : "differs", issues, warnings },
        historicalPhysical, migrationState,
        ledger: ledger.map(item => ({ migrationHash: item.migrationHash, name: item.migrationName, from: item.from, to: item.to, appliedAt: item.appliedAt.toISOString() })),
        message: stale ? "Source or connection identity changed during inspection. Inspect again before using this evidence." : migrationState.status === "pending" || migrationState.status === "divergent" ? migrationState.message : physical.ok && markerMatches ? "The saved storage contract and marker match this database's modeled physical schema. Data and application correctness remain separate." : physical.ok ? "The modeled physical schema matches saved source, but migration marker evidence differs or is missing. Review history before selecting a migration baseline." : "The physical schema differs from saved source. A pending migration can explain this; compare the marker's historical contract before calling it drift." };
    } catch {
      // Driver and PostgreSQL error messages may embed credentials or URLs. Never return them.
      return { ...base, status: "unreachable", message: "This target could not be inspected. No database writes were requested. Confirm the selected Compose project's PostgreSQL is running and POSTGRES_HOST_PORT matches its published loopback port, then retry. Start the project separately if needed; inspection never starts containers or applies migrations." };
    } finally { try { await client.close(); } catch { /* Connection cleanup failure does not change observation evidence. */ } }
  }
}

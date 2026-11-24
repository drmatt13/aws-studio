import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { identityAlive, processIdentity } from "./identity";
import type { ExecutionIdentity } from "./execution-identity";
import { restrictWindowsOwnedPaths } from "../../cli/windows-security";
import { ensurePrivateDirectory, openPrivateFileSync } from "../../cli/private-files";

/** One durable checkout authority for source writers, tooling and publication. */
interface Lease { readonly id: string; readonly identity: ExecutionIdentity; readonly kind: "write" | "read" | "recovery"; }
interface State { epoch: string; lease: Lease | null; recovery: string | null; }
interface Context { readonly root: string; readonly lease: Lease; readonly entryEpoch: string; active: boolean; }
const context = new AsyncLocalStorage<Context>();
const relative = ".cache/framework-studio/source-gate";
let identity: Omit<ExecutionIdentity, "token"> | undefined;

export interface SourceCoordinationState {
  readonly status: "ready" | "busy" | "recovery_required" | "unavailable";
  readonly epoch: string;
  readonly mode?: Lease["kind"];
  readonly recoveryId?: string;
  readonly ownerPid?: number;
  readonly message?: string;
}
export class SourceGateError extends Error {
  readonly status = 409;
  constructor(message: string, readonly activeOwner = false) { super(message); }
}
export class SourcePublicationChanged extends SourceGateError {}

function folder(rootInput: string, create = false): string {
  let current = realpathSync(rootInput);
  for (const component of relative.split("/")) {
    current = path.join(current, component);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SourceGateError("Source coordination storage must be a real directory inside this checkout.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create) {
        try {
          if (component === "source-gate") ensurePrivateDirectory(current);
          else mkdirSync(current, { mode: 0o700 });
        }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST" || lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw failure; }
      }
    }
  }
  return current;
}
function open(root: string, create = false): DatabaseSync | undefined {
  const directory = folder(root, create), file = path.join(directory, "coordination.sqlite");
  if (existsSync(path.join(directory, "write.lock")) || existsSync(path.join(directory, "recovery-required"))) throw new SourceGateError("An older source coordination record needs inspection before upgrading its storage.");
  if (process.platform !== "win32" && existsSync(directory)) ensurePrivateDirectory(directory);
  if (!existsSync(file)) {
    if (!create) return;
    try { closeSync(openPrivateFileSync(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(file);
  // Windows reports synthetic POSIX modes; its actual ACL is enforced below.
  const invalidPosixAccess = process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid());
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || invalidPosixAccess) throw new SourceGateError("Source coordination database must be a private regular file owned by this user.");
  // ACL changes do not change inode identity. Recheck both app-owned paths
  // together rather than retaining an authorization decision between opens.
  if (process.platform === "win32") restrictWindowsOwnedPaths([directory, file]);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    if (create) {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS coordination (singleton INTEGER PRIMARY KEY CHECK(singleton=1), root TEXT NOT NULL, epoch TEXT NOT NULL, lease TEXT, recovery TEXT)");
      db.prepare("INSERT OR IGNORE INTO coordination(singleton,root,epoch,lease,recovery) VALUES (1, ?, 'initial', NULL, NULL)").run(realpathSync(root));
      if (!db.prepare("PRAGMA table_info(coordination)").all().some(row => row.name === "restricted_evaluation")) db.exec("ALTER TABLE coordination ADD COLUMN restricted_evaluation INTEGER NOT NULL DEFAULT 0");
    }
    bindCheckout(db, realpathSync(root));
    return db;
  } catch (error) { db.close(); throw error; }
}
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = action(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* Preserve original storage failure. */ } throw error; }
}
function directoryIdentity(directory: string): string {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw new SourceGateError("Source checkout identity could not be verified.");
  return `${process.platform}:${stat.dev}:${stat.ino}`;
}
/** A path is a location, not the identity of a renamed checkout. Upgrade older
 * idle records only when their original location no longer exists. New records
 * also pin the directory identity, so a copied database cannot claim a rename. */
function bindCheckout(db: DatabaseSync, root: string): void {
  const row = db.prepare("SELECT * FROM coordination WHERE singleton=1").get();
  if (!row) throw new SourceGateError("Source coordination belongs to another checkout or needs inspection.");
  if (row.root === root && typeof row.checkout_identity === "string") return;
  transaction(db, () => {
    const current = db.prepare("SELECT * FROM coordination WHERE singleton=1").get()!;
    const identity = directoryIdentity(root);
    if (current.root !== root) {
      const refuse = () => { throw new SourceGateError("Source coordination belongs to another checkout or needs inspection. A renamed checkout can be adopted only while source is idle and no recovery is pending."); };
      if (typeof current.root !== "string" || current.checkout_identity != null && current.checkout_identity !== identity) refuse();
      try {
        if (directoryIdentity(String(current.root)) !== identity) refuse();
      } catch (error) {
        // A missing former location supports a legacy rename. Access failures
        // and existing different directories never establish that identity.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const state = read(db);
      if (state.lease || state.recovery || legacyProblem(root) || pendingImport(root)) refuse();
    }
    if (current.checkout_identity === undefined) db.exec("ALTER TABLE coordination ADD COLUMN checkout_identity TEXT");
    db.exec("CREATE TABLE IF NOT EXISTS checkout_locations (root TEXT PRIMARY KEY)");
    if (current.root !== root) db.prepare("INSERT OR IGNORE INTO checkout_locations(root) VALUES (?)").run(current.root!);
    db.prepare("UPDATE coordination SET root=?,checkout_identity=? WHERE singleton=1").run(root, identity);
  });
}
/** Only completed journals may use an earlier, verified checkout location.
 * Their bytes and original provenance remain unchanged after a folder rename. */
export function isCompletedSourceCheckout(root: string, recordedRoot: string): boolean {
  if (recordedRoot === realpathSync(root)) return true;
  const db = open(root);
  try { return !!db?.prepare("SELECT 1 FROM checkout_locations WHERE root=?").get(recordedRoot); }
  finally { db?.close(); }
}
function read(db?: DatabaseSync): State {
  if (!db) return { epoch: "initial", lease: null, recovery: null };
  const row = db.prepare("SELECT epoch,lease,recovery FROM coordination WHERE singleton=1").get()!;
  const state: State = { epoch: String(row.epoch), lease: row.lease === null ? null : JSON.parse(String(row.lease)) as Lease, recovery: row.recovery === null ? null : String(row.recovery) };
  if (state.lease && (!/^[a-f0-9-]{36}$/.test(state.lease.id) || !["write", "read", "recovery"].includes(state.lease.kind) || !Number.isSafeInteger(state.lease.identity?.pid) || state.lease.identity.pid < 1 || state.lease.identity.token !== state.lease.id)) throw new SourceGateError("Source coordination ownership is unreadable; preserve it for inspection.");
  return state;
}
function own(root: string): Context | undefined {
  const owner = context.getStore();
  return owner?.active && owner.root === realpathSync(root) ? owner : undefined;
}
export function ownsSourceGate(root: string): boolean { return !!own(root); }
/** The complete source generation the owner reserved before its own writes. */
export function sourceOwnedEntryEpoch(root: string): string | undefined { return own(root)?.entryEpoch; }
function alive(lease: Lease): boolean | undefined {
  try { process.kill(lease.identity.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  // On unsupported process-inspection platforms, fail closed on PID reuse.
  return lease.identity.started ? identityAlive(lease.identity) : true;
}
function owner(id: string): ExecutionIdentity {
  if (!identity) {
    try {
      const { token: _token, ...current } = processIdentity(id); identity = current;
    } catch {
      // Inspection may be restricted even for ourselves. Such leases remain
      // unrecoverable while their PID exists, so PID reuse cannot steal ownership.
      identity = { pid: process.pid, uid: process.getuid?.() ?? -1, started: "" };
    }
  }
  return { ...identity, token: id };
}
/** Older Studio versions retain their bounded domain journal and lock files. */
function legacyProblem(root: string): string | undefined {
  const directory = path.join(root, ".cache/framework-studio/transactions");
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "Legacy source recovery storage needs inspection.";
  for (const name of readdirSync(directory)) {
    if (name === "source.lock" || name === "recovery.lock") return "A source transaction is active or needs recovery.";
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    if (lstatSync(file).isSymbolicLink()) return "Legacy source recovery metadata needs inspection.";
    try { const record = JSON.parse(readFileSync(file, "utf8")) as { status?: string }; if (!["complete", "restored"].includes(record.status ?? "")) return "A source transaction needs recovery."; }
    catch { return "Legacy source recovery metadata is unreadable."; }
  }
}
function pendingImport(root: string): string | undefined {
  const directory = path.join(root, ".cache/framework-studio/agent-integrations");
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return "Agent integration storage needs inspection.";
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    if (lstatSync(file).isSymbolicLink()) return "Agent integration metadata needs inspection.";
    try { const record = JSON.parse(readFileSync(file, "utf8")) as { status?: string }; if (!["applied", "restored", "kept"].includes(record.status ?? "")) return "An agent source integration needs recovery."; }
    catch { return "Agent integration metadata is unreadable."; }
  }
}
function coordinationState(root: string, db?: DatabaseSync): SourceCoordinationState {
  const state = read(db);
  if (state.lease) {
    const active = alive(state.lease);
    return { status: active === false ? "recovery_required" : "busy", epoch: state.epoch, mode: state.lease.kind, ownerPid: state.lease.identity.pid, ...(state.recovery ? { recoveryId: state.recovery } : {}),
      message: active === false ? "The source owner stopped. Review source recovery; no operation will be replayed." : "Source is reserved by an active or unverifiable Studio operation." };
  }
  const problem = state.recovery ? "An interrupted agent source import needs recovery." : legacyProblem(root) ?? pendingImport(root);
  return { status: problem ? "recovery_required" : "ready", epoch: state.epoch, ...(state.recovery ? { recoveryId: state.recovery } : {}), ...(problem ? { message: problem } : {}) };
}
const unavailableState = (): SourceCoordinationState => ({ status: "unavailable", epoch: "unknown", message: "Source coordination evidence is unreadable or changed. Preserve its records for inspection, then restart Studio." });

export function sourceCoordinationState(root: string): SourceCoordinationState {
  let db: DatabaseSync | undefined;
  try { db = open(root); return coordinationState(root, db); }
  catch { return unavailableState(); }
  finally { db?.close(); }
}

/** A snapshot observer owns one verified SQLite connection until close. This
 * grants no pathname authority to writers: they acquire and verify separately. */
export class SourceGateObserver {
  private connection?: { db: DatabaseSync; directory: Stats; file: Stats };
  private stopped = false;
  constructor(private readonly root: string) {}
  state(): SourceCoordinationState {
    if (this.stopped) return unavailableState();
    try {
      const directory = folder(this.root), file = path.join(directory, "coordination.sqlite");
      if (existsSync(path.join(directory, "write.lock")) || existsSync(path.join(directory, "recovery-required"))) throw new SourceGateError("Older source coordination evidence needs inspection.");
      if (!this.connection && existsSync(file)) {
        const beforeDirectory = lstatSync(directory), beforeFile = lstatSync(file);
        const db = open(this.root);
        if (!db) throw new SourceGateError("Source observer storage disappeared during acquisition.");
        this.connection = { db, directory: beforeDirectory, file: beforeFile };
      }
      if (this.connection) {
        for (const [location, previous, isDirectory] of [[directory, this.connection.directory, true], [file, this.connection.file, false]] as const) {
          const current = lstatSync(location);
          if (current.isSymbolicLink() || (isDirectory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1) || current.dev !== previous.dev || current.ino !== previous.ino || process.platform !== "win32" && (current.uid !== process.getuid?.() || current.mode & 0o077)) throw new SourceGateError("Source observer storage changed.");
        }
        if (this.connection.db.prepare("SELECT root FROM coordination WHERE singleton=1").get()?.root !== realpathSync(this.root)) throw new SourceGateError("Source observer checkout binding changed.");
      }
      // Neither state nor process liveness is cached. The live connection reads
      // committed mutations made by every Studio/worker process.
      return coordinationState(this.root, this.connection?.db);
    } catch { this.close(); return unavailableState(); }
  }
  close(): void { this.stopped = true; this.connection?.db.close(); this.connection = undefined; }
}
function available(root: string, state: State, readOnly = false): void {
  const current = own(root);
  if (current && current.lease.id === state.lease?.id) {
    if (!readOnly && current.lease.kind === "read") throw new SourceGateError("A source reader cannot upgrade to source write ownership.");
    return;
  }
  if (state.lease) {
    const active = alive(state.lease);
    if (!(readOnly && state.lease.kind === "read" && active === true)) {
      // A live PID without a birth identity still holds source, but is unverifiable.
      const identified = active === true && Boolean(state.lease.identity.started);
      throw new SourceGateError("Source integration or tooling is active or interrupted. Wait for completion or open source recovery.", identified);
    }
  }
  if (state.recovery) throw new SourceGateError("An interrupted source import needs recovery before publishing or writing source.");
  const problem = legacyProblem(root) ?? pendingImport(root); if (problem) throw new SourceGateError(problem);
}
export function assertSourceGateAvailable(root: string): void {
  const db = open(root);
  try { available(root, read(db)); } finally { db?.close(); }
}
/** A stopped reader cannot have changed source. A fresh evaluation may release
 * its reservation, provided no source transaction needs explicit recovery. */
export function releaseAbandonedSourceRead(root: string): boolean {
  const db = open(root);
  if (!db) return false;
  try {
    return transaction(db, () => {
      const state = read(db);
      if (state.lease?.kind !== "read" || alive(state.lease) !== false || state.recovery || legacyProblem(root) || pendingImport(root)) return false;
      db.prepare("UPDATE coordination SET lease=NULL WHERE singleton=1").run();
      return true;
    });
  } finally { db.close(); }
}
export function sourcePublicationEpoch(root: string): string {
  const db = open(root);
  try { const state = read(db); available(root, state, true); return state.epoch; } finally { db?.close(); }
}
export function assertSourcePublicationEpoch(root: string, expected: string): void {
  try { if (sourcePublicationEpoch(root) !== expected) throw new Error(); }
  catch { throw new SourcePublicationChanged("Source changed during evaluation. The incomplete snapshot was discarded; refresh after integration completes."); }
}
/** The source writer cannot acquire its lease between this check and publication. */
export function publishSourceSnapshot<T>(root: string, expected: string, publish: () => T): T {
  const db = open(root, true)!;
  try {
    return transaction(db, () => {
      const state = read(db);
      try { available(root, state, true); if (state.epoch !== expected) throw new Error(); }
      catch { throw new SourcePublicationChanged("Source changed during evaluation. The incomplete snapshot was discarded; refresh after integration completes."); }
      return publish();
    });
  } finally { db.close(); }
}
function acquire(rootInput: string, kind: Lease["kind"], recoverAbandoned = false): { context: Context; release(): void } {
  const root = realpathSync(rootInput), db = open(root, true)!, id = randomUUID();
  const file = path.join(root, relative, "coordination.sqlite");
  let fileIdentity: ReturnType<typeof lstatSync>;
  const lease: Lease = { id, kind, identity: owner(id) };
  let entryEpoch = "";
  try {
    fileIdentity = lstatSync(file);
    transaction(db, () => {
      const state = read(db);
      entryEpoch = state.epoch;
      if (state.lease) {
        const active = alive(state.lease);
        if (!(recoverAbandoned && active === false)) throw new SourceGateError("Another Studio source writer is active or interrupted. Wait or open source recovery.", active === true && Boolean(state.lease.identity.started));
      }
      if (kind !== "recovery") available(root, { ...state, lease: null });
      const nextEpoch = kind === "read" ? state.epoch : randomUUID();
      db.prepare("UPDATE coordination SET epoch=?,lease=? WHERE singleton=1").run(nextEpoch, JSON.stringify(lease));
    });
  } catch (error) { db.close(); throw error; }
  const ownerContext: Context = { root, lease, entryEpoch, active: true };
  return { context: ownerContext, release() {
    ownerContext.active = false;
    try {
      const current = lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== fileIdentity.dev || current.ino !== fileIdentity.ino) throw new SourceGateError("Source coordination storage changed during the operation. Preserve its recovery evidence.");
      // Keep the acquired connection through the lease. Reopening on release
      // repeats acquisition and risks switching to a replacement database.
      transaction(db, () => {
        if (read(db).lease?.id !== id) throw new SourceGateError("Source ownership changed. Preserve coordination evidence.");
        db.prepare("UPDATE coordination SET lease=NULL WHERE singleton=1").run();
      });
    } finally { db.close(); }
  } };
}
function scopedSync<T>(root: string, kind: Lease["kind"], action: () => T, recoverAbandoned = false): T {
  const current = own(root);
  if (current) { if (current.lease.kind === "read" && kind !== "read") throw new SourceGateError("A source reader cannot upgrade to source write ownership."); return action(); }
  const lease = acquire(root, kind, recoverAbandoned);
  try { return context.run(lease.context, action); } finally { lease.release(); }
}
async function scoped<T>(root: string, kind: Lease["kind"], action: () => Promise<T>, recoverAbandoned = false): Promise<T> {
  const current = own(root);
  if (current) { if (current.lease.kind === "read" && kind !== "read") throw new SourceGateError("A source reader cannot upgrade to source write ownership."); return action(); }
  const lease = acquire(root, kind, recoverAbandoned);
  try { return await context.run(lease.context, action); } finally { lease.release(); }
}
export function withSourceWriteSync<T>(root: string, action: () => T): T { return scopedSync(root, "write", action); }
export function withSourceWrite<T>(root: string, action: () => Promise<T>): Promise<T> { return scoped(root, "write", action); }
export function withSourceRead<T>(root: string, action: () => Promise<T>): Promise<T> { return scoped(root, "read", action); }
/** Caller validates explicit recovery approval first; takeover and claim are one SQL transaction. */
export function withSourceRecovery<T>(root: string, action: () => Promise<T>): Promise<T> { return scoped(root, "recovery", action, true); }
export function withSourceRecoverySync<T>(root: string, action: () => T): T { return scopedSync(root, "recovery", action, true); }
export function markSourceRecoveryRequired(root: string, id: string): void {
  if (!own(root)) throw new SourceGateError("Source recovery records require source ownership.");
  const db = open(root, true)!;
  try { transaction(db, () => {
    const state = read(db);
    if (state.recovery && state.recovery !== id) throw new SourceGateError("Another source recovery record remains unresolved.");
    db.prepare("UPDATE coordination SET recovery=? WHERE singleton=1").run(id);
  }); } finally { db.close(); }
}
export function clearSourceRecoveryRequired(root: string, id: string): void {
  if (!own(root)) throw new SourceGateError("Source recovery records require source ownership.");
  const db = open(root, true)!;
  try { transaction(db, () => {
    const state = read(db);
    if (state.recovery && state.recovery !== id) throw new SourceGateError("Another source recovery record remains unresolved.");
    db.prepare("UPDATE coordination SET recovery=NULL WHERE singleton=1").run();
  }); } finally { db.close(); }
}
/** Only an abandoned lease with no pending source record can be cleared independently. */
export function recoverSourceGate(root: string, approval: string): void {
  if (approval !== "RECOVER SOURCE WRITES") throw new SourceGateError("Type RECOVER SOURCE WRITES after inspecting the interrupted source operation.");
  withSourceRecoverySync(root, () => {
    const db = open(root)!;
    try { if (read(db).recovery || legacyProblem(root) || pendingImport(root)) throw new SourceGateError("Recover the recorded source transaction through its recovery action; its lease cannot be cleared separately."); }
    finally { db.close(); }
  });
}

/** Once agent-authored code reaches disk it must never regain privileged evaluation implicitly. */
export function requireRestrictedSourceEvaluation(root: string): void {
  const current = own(root);
  if (!current || current.lease.kind === "read") throw new SourceGateError("Changing source evaluation policy requires source write ownership.");
  const db = open(root, true)!;
  try { transaction(db, () => { db.prepare("UPDATE coordination SET restricted_evaluation=1 WHERE singleton=1").run(); }); }
  finally { db.close(); }
}
export function restrictedSourceEvaluationRequired(root: string): boolean {
  const db = open(root);
  try {
    if (!db || !db.prepare("PRAGMA table_info(coordination)").all().some(row => row.name === "restricted_evaluation")) return false;
    return db.prepare("SELECT restricted_evaluation FROM coordination WHERE singleton=1").get()?.restricted_evaluation !== 0;
  } finally { db?.close(); }
}

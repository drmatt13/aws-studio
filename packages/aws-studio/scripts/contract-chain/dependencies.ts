import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { setImmediate as yieldToIo } from "node:timers/promises";
import path from "node:path";
import { DependencyObservationChangedError, dependencyRoots, isDependencyCachePath, readDependencyDigest } from "../source/workspace";

export { DependencyObservationChangedError } from "../source/workspace";

const cache = new Map<string, { metadata: string; content: string }>();
// Native write notifications are stronger than timestamps. Some filesystems can
// report distinct same-size writes with identical inode/ctime/mtime observations.
// Keep this process-local guard outside portable digests and source manifests.
const generations = new Map<string, number>();
let nextGeneration = 0;

/** Reuse a content digest only while installed file/link nanosecond identities,
 * directory identities/permissions and meaningful entries are unchanged. Actual
 * touches/installations and same-size code edits rehash bytes.
 * Workspace source is separately captured, not followed here.
 */
export interface CachedDependencyObservation {
  readonly root: string;
  readonly generation: number;
  readonly metadata: string;
  /** Includes empty directories, which the raw content digest does not bind. */
  readonly entries: number;
  readonly content?: string;
}

interface DependencyObservationScope {
  readonly observation: CachedDependencyObservation & { readonly content: string };
  readonly signal?: AbortSignal;
  readonly publications: (() => void)[];
  readonly freshContent: boolean;
  active: boolean;
}
const observations = new AsyncLocalStorage<DependencyObservationScope>();

/** Internal callers can lend only an active observation for the same canonical root. */
function scopedObservation(root: string, signal?: AbortSignal): DependencyObservationScope | undefined {
  signal?.throwIfAborted();
  const scope = observations.getStore();
  if (!scope) return undefined;
  scope.signal?.throwIfAborted();
  if (!scope.active) throw new Error("Dependency observation scope is closed.");
  if ((generations.get(scope.observation.root) ?? 0) !== scope.observation.generation) throw new DependencyObservationChangedError("Installed dependencies changed during independent contract validation.");
  return realpathSync(root) === scope.observation.root ? scope : undefined;
}

/** New raw and portable cache facts stay provisional until the owning operation closes. */
export function publishDependencyObservation(root: string, publish: () => void): void {
  const scope = scopedObservation(root);
  if (scope) scope.publications.push(publish);
  else publish();
}

function publishContent(observation: CachedDependencyObservation, content: string): void {
  if (cache.size >= 4 && !cache.has(observation.root)) cache.delete(cache.keys().next().value!);
  cache.set(observation.root, { metadata: observation.metadata, content });
}

/** Host-owned validation boundary, never a request token or persistent trust cache.
 * A callback must await all its work and return its result before any caller publishes
 * evidence. Fresh physical inventories bracket it; only nested reads borrow identity.
 * Origin and saved-source approval request freshContent, which reads installed bytes
 * once even on a warm root before lending them to nested checks.
 */
export async function withDependencyObservationScope<T>(root: string, signal: AbortSignal | undefined, operation: () => Promise<T>, options: { readonly freshContent?: boolean } = {}): Promise<T> {
  const enclosingSignal = observations.getStore()?.signal;
  signal = enclosingSignal && signal && enclosingSignal !== signal ? AbortSignal.any([enclosingSignal, signal]) : signal ?? enclosingSignal;
  signal?.throwIfAborted();
  root = realpathSync(root);
  const parent = scopedObservation(root, signal);
  if (parent) {
    if (options.freshContent && !parent.freshContent) throw new Error("A fresh dependency observation cannot borrow a cached parent scope.");
    if (signal !== parent.signal) throw new Error("Nested dependency observations must use the owning cancellation signal.");
    const result = await operation();
    scopedObservation(root, signal);
    return result;
  }
  // These captures deliberately bypass AsyncLocalStorage. A different root gets
  // its own physical boundary, and cold raw bytes must be verified before lending.
  const before = await captureDependencyObservation(root, signal);
  const freshContent = options.freshContent === true || before.content === undefined;
  const content = freshContent ? await readDependencyDigest(root, signal) : before.content!;
  if (freshContent && (await captureDependencyObservation(root, signal)).metadata !== before.metadata) throw new DependencyObservationChangedError("Installed dependencies changed while capturing their content identity.");
  signal?.throwIfAborted();
  const scope: DependencyObservationScope = { observation: Object.freeze({ ...before, content }), signal, publications: [], freshContent, active: true };
  if (freshContent) scope.publications.push(() => publishContent(before, content));
  try {
    const result = await observations.run(scope, operation);
    scope.active = false;
    signal?.throwIfAborted();
    if ((await captureDependencyObservation(root, signal)).metadata !== before.metadata) throw new DependencyObservationChangedError("Installed dependencies changed during independent contract validation.");
    signal?.throwIfAborted();
    for (const publish of scope.publications) publish();
    return result;
  } finally {
    scope.active = false;
    scope.publications.length = 0;
  }
}

/** One serialization/traversal for synchronous observations and cancellable work. */
function* dependencyObservation(root: string): Generator<void, CachedDependencyObservation, void> {
  root = realpathSync(root);
  const digest = createHash("sha256");
  const generation = generations.get(root) ?? 0;
  digest.update(JSON.stringify(["dependency-observation/v2", generation]) + "\n");
  let entries = 0;
  const visit = function* (file: string): Generator<void, void, void> {
    if (isDependencyCachePath(file)) return;
    entries++;
    const info = lstatSync(file, { bigint: true });
    const name = path.relative(root, file).split(path.sep).join("/");
    // Ignored cache creation changes its parent's directory timestamps, size and
    // link count. Real child entries are inventoried below; directory identity
    // and permissions suffice without treating those cache-only stamps as code.
    digest.update(JSON.stringify(info.isDirectory()
      ? [name, String(info.dev), String(info.ino), String(info.mode)]
      : [name, String(info.dev), String(info.ino), String(info.size), String(info.mode), String(info.nlink), String(info.ctimeNs), String(info.mtimeNs)]) + "\n");
    if (info.isSymbolicLink()) {
      const target = realpathSync(file), relative = path.relative(root, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Installed dependency link leaves the checkout.");
      digest.update(target + "\n");
    } else if (!info.isDirectory() && !info.isFile()) throw new Error("Installed dependencies contain a special file.");
    yield;
    if (info.isDirectory()) for (const name of readdirSync(file).sort()) yield* visit(path.join(file, name));
  };
  for (const directory of dependencyRoots(root).filter(file => path.basename(file) === "node_modules").sort()) yield* visit(directory);
  if ((generations.get(root) ?? 0) !== generation) throw new DependencyObservationChangedError("Installed dependencies changed while observing their identity.");
  const metadata = digest.digest("hex"), previous = cache.get(root);
  return { root, generation, metadata, entries, ...(previous?.metadata === metadata ? { content: previous.content } : {}) };
}

/** Fresh metadata outside the internal operation boundary; a miss never reads bytes. */
export function observeCachedDependencyIdentity(root: string): CachedDependencyObservation {
  const scoped = scopedObservation(root);
  if (scoped) return scoped.observation;
  const observation = dependencyObservation(root);
  for (;;) { const next = observation.next(); if (next.done) return next.value; }
}

/** IPC and timers must run during large installed-tree scans, including cache hits. */
export async function observeCachedDependencyIdentityAsync(root: string, signal?: AbortSignal): Promise<CachedDependencyObservation> {
  const scoped = scopedObservation(root, signal);
  return scoped ? scoped.observation : captureDependencyObservation(root, signal);
}

async function captureDependencyObservation(root: string, signal?: AbortSignal): Promise<CachedDependencyObservation> {
  signal?.throwIfAborted();
  const observation = dependencyObservation(root);
  let batch = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = observation.next();
      if (next.done) { signal?.throwIfAborted(); return next.value; }
      if (++batch === 32) {
        batch = 0;
        await yieldToIo();
        signal?.throwIfAborted();
      }
    }
  } finally { observation.return(undefined as never); }
}

export function dependencyMetadata(root: string): string { return observeCachedDependencyIdentity(root).metadata; }
export async function dependencyMetadataAsync(root: string, signal?: AbortSignal): Promise<string> { return (await observeCachedDependencyIdentityAsync(root, signal)).metadata; }
export function dependencyObservationGeneration(root: string): number { return generations.get(realpathSync(root)) ?? 0; }

export function invalidateDependencyIdentity(root: string): void {
  root = realpathSync(root);
  cache.delete(root);
  generations.set(root, ++nextGeneration);
}
export async function dependencyContentIdentity(root: string, signal?: AbortSignal): Promise<string> {
  const scoped = scopedObservation(root, signal);
  if (scoped) return scoped.observation.content;
  signal?.throwIfAborted();
  root = realpathSync(root);
  const before = (await observeCachedDependencyIdentityAsync(root, signal)).metadata, previous = cache.get(root);
  signal?.throwIfAborted();
  if (previous?.metadata === before) return previous.content;
  const content = await readDependencyDigest(root, signal);
  signal?.throwIfAborted();
  if ((await observeCachedDependencyIdentityAsync(root, signal)).metadata !== before) throw new DependencyObservationChangedError("Installed dependencies changed while capturing their content identity.");
  signal?.throwIfAborted();
  publishContent({ root, generation: generations.get(root) ?? 0, metadata: before, entries: 0 }, content);
  return content;
}

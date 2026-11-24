import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { dependencyRoots, isDependencyCachePath } from "../source/workspace";
import { observeCachedDependencyIdentityAsync, publishDependencyObservation } from "./dependencies";
import { setImmediate as yieldToIo } from "node:timers/promises";

export interface LockedDependency {
  readonly version?: string;
  readonly link?: boolean;
  readonly resolved?: string;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}
const cache = new Map<string, { readonly metadata: string; readonly inputs: string; readonly digest: string; readonly content?: string }>();
// Immutable facts about validated bytes, never serialized or supplied by tasks.
const contentCache = new Map<string, string>();
export const PORTABLE_NORMALIZATION_PROFILE = "contract-source-text/v1" as const;
const MAX_PORTABLE_ENTRIES = 500_000;
/** A conservative total permits reuse; a larger total requires the exact walk. */
export function portableDependencyReuseWithinEntryBudget(entries: number): boolean {
  return Number.isSafeInteger(entries) && entries >= 0 && entries <= MAX_PORTABLE_ENTRIES;
}
const native = /\.(?:node|exe|dll|dylib|so(?:\.[\d.]+)?|a|o)$/i;
const commonSource = /\.(?:[cm]?[jt]sx?|json|graphql|gql|ya?ml|toml|map|txt|html|css|svg)$/i;
const packageRoot = /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+$/;
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const TEXT = /(?:\.(?:[cm]?[jt]sx?|json|graphql|prisma|ya?ml|toml|md|txt|html|css|svg|sql|sh|ps1|cmd|bat)|(?:^|\/)(?:Dockerfile|\.gitignore|\.gitattributes))$/i;
/** Normalizes checkout text, never arbitrary binary payloads or filesystem modes. */
export function portableFileDigest(name: string, bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return sha(TEXT.test(name) && !bytes.includes(0) && Buffer.from(text).equals(bytes) ? text.replaceAll("\r\n", "\n") : bytes);
}

/** Portable common installed source, not installation authenticity. Native and
 * lock-declared platform packages remain lock/version-bound plus locally guarded.
 * Workspace source is already bound by the narrower application/policy groups. */
export async function portableDependencyDigest(rootInput: string, locked: Readonly<Record<string, LockedDependency>>, lockDigest: string,
  profile: typeof PORTABLE_NORMALIZATION_PROFILE = PORTABLE_NORMALIZATION_PROFILE, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (profile !== PORTABLE_NORMALIZATION_PROFILE) throw new Error("Unsupported portable dependency normalization profile.");
  // Bind and snapshot the actual lock object, not only a caller's claimed hash.
  // Subsequent awaits must not observe a caller mutating the captured lock map.
  const lockBytes = JSON.stringify(locked);
  locked = JSON.parse(lockBytes) as Readonly<Record<string, LockedDependency>>;
  const inputs = sha(JSON.stringify(["portable-dependencies/v1", profile, lockDigest, lockBytes]));
  const root = realpathSync(rootInput);
  const constrained = new Set(Object.entries(locked).filter(([name, entry]) => packageRoot.test(name) && [entry.os, entry.cpu, entry.libc].some(value => value?.length)).map(([name]) => name));
  const resolve = (owner: string, dependency: string): string | undefined => {
    for (let directory = owner; ; directory = path.posix.dirname(directory)) {
      if (path.posix.basename(directory) !== "node_modules") {
        const candidate = path.posix.join(directory, "node_modules", dependency);
        if (Object.hasOwn(locked, candidate)) return candidate;
      }
      if (!directory || directory === ".") return undefined;
    }
  };
  const edges = new Map(Object.entries(locked).map(([owner, entry]) => [owner, [...new Set([
    ...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.devDependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {}),
  ].flatMap(dependency => resolve(owner, dependency) ?? [])), ...(entry.link && entry.resolved && Object.hasOwn(locked, entry.resolved) ? [entry.resolved] : [])]]));
  const reach = (starts: readonly string[], skipPlatform: boolean) => {
    const found = new Set<string>(), queue = [...starts];
    for (let index = 0; index < queue.length; index++) {
      const name = queue[index]!;
      if (found.has(name) || skipPlatform && constrained.has(name)) continue;
      found.add(name); queue.push(...(edges.get(name) ?? []));
    }
    return found;
  };
  const common = reach(Object.keys(locked).filter(name => !name.includes("node_modules/")), true), platformReach = reach([...constrained], false);
  // Hoisted JS/WASM helpers used solely by platform packages are just as
  // platform-specific as their owner. Shared common dependencies stay bound.
  const platform = [...new Set([...constrained, ...[...platformReach].filter(name => !common.has(name))])].filter(name => packageRoot.test(name)).sort();
  const excluded = (name: string) => isDependencyCachePath(name) || name.split("/").includes(".bin") || name.endsWith("/node_modules/.package-lock.json")
    || platform.some(prefix => name === prefix || name.startsWith(prefix + "/"))
    // esbuild's installer replaces this same path with a native executable on
    // POSIX, while Windows retains the tarball launcher. Its platform package is
    // lock-bound and freshly executed; neither host-specific form is common code.
    || /(?:^|\/)node_modules\/esbuild\/bin\/esbuild$/.test(name);
  // Fail before hashing the whole installation. In particular, an npm workspace
  // install can leave a nested locked package absent while resolving a different
  // hoisted major version. Never silently accept that fallback.
  let admissions = 0;
  for (const [name] of Object.entries(locked)) {
    if (++admissions % 32 === 0) { await yieldToIo(); signal?.throwIfAborted(); }
    if (!packageRoot.test(name) || excluded(name)) continue;
    try { lstatSync(path.join(root, name, "package.json")); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error(`A common dependency from the committed lockfile is missing: ${name}. Restore the lockfile installation before retrying.`);
      throw error;
    }
  }
  const before = await observeCachedDependencyIdentityAsync(root, signal), previous = cache.get(root);
  // Raw identity binds file bytes and logical links, but not empty directories.
  // The conservative metadata count preserves the portable inventory bound.
  const contentKey = before.content && portableDependencyReuseWithinEntryBudget(before.entries) ? sha(JSON.stringify([inputs, before.content])) : undefined;
  const complete = async (digest: string, reusedContent?: string): Promise<string> => {
    signal?.throwIfAborted();
    const after = await observeCachedDependencyIdentityAsync(root, signal);
    if (after.metadata !== before.metadata || reusedContent !== undefined && after.content !== reusedContent) throw new Error("Installed dependencies changed while capturing portable common source.");
    signal?.throwIfAborted();
    publishDependencyObservation(root, () => {
      if (cache.size >= 4 && !cache.has(root)) cache.delete(cache.keys().next().value!);
      cache.set(root, { metadata: before.metadata, inputs, digest, ...(before.content === undefined ? {} : { content: before.content }) });
      if (contentKey && after.content === before.content) {
        if (contentCache.size >= 8 && !contentCache.has(contentKey)) contentCache.delete(contentCache.keys().next().value!);
        contentCache.set(contentKey, digest);
      }
    });
    return digest;
  };
  // A byte-fresh host observation may discover changed bytes despite identical
  // timestamps. Same-root portable reuse must agree with that raw commitment.
  if (previous?.metadata === before.metadata && previous.inputs === inputs && previous.content === before.content) return complete(previous.digest);
  const shared = contentKey ? contentCache.get(contentKey) : undefined;
  if (shared !== undefined) return complete(shared, before.content);
  const records = new Map<string, unknown>(), installed = new Set<string>();
  const pending: { readonly file: string; readonly name: string }[] = [];
  let count = 0, bytesRead = 0;
  const flush = async () => {
    signal?.throwIfAborted();
    const files = pending.splice(0);
    // Drain every opened descriptor before cancellation or a sibling failure.
    const settled = await Promise.allSettled(files.map(async ({ file, name }) => {
      signal?.throwIfAborted();
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        signal?.throwIfAborted();
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.size > 512n * 1024n * 1024n || info.nlink < 1n) throw new Error(`Installed common dependency source is not a bounded regular file: ${name} (${info.size} bytes).`);
        bytesRead += Number(info.size);
        if (bytesRead > 4 * 1024 ** 3) throw new Error("Installed common dependency source exceeds its bounded inventory.");
        const buffer = Buffer.alloc(Math.min(Number(info.size) + 1, 64 * 1024)), raw = createHash("sha256"), normalized = createHash("sha256");
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const normalizeLines = TEXT.test(name);
        const manifestFile = path.posix.basename(name) === "package.json" && packageRoot.test(path.posix.dirname(name));
        if (manifestFile && info.size > 1024n * 1024n) throw new Error("Installed dependency manifest exceeds its bounded size.");
        let length = 0, validText = true, carry = "", manifestText = "";
        const appendText = (text: string, final = false) => {
          if (text.includes("\0")) validText = false;
          if (manifestFile) manifestText += text;
          if (normalizeLines) {
            const value = carry + text; carry = !final && value.endsWith("\r") ? "\r" : "";
            normalized.update((carry ? value.slice(0, -1) : value).replaceAll("\r\n", "\n"));
          }
        };
        while (length <= Number(info.size)) {
          signal?.throwIfAborted();
          const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(info.size) + 1 - length), length);
          if (!result.bytesRead) break;
          const bytes = buffer.subarray(0, result.bytesRead); length += result.bytesRead; raw.update(bytes);
          if (validText) { try { appendText(decoder.decode(bytes, { stream: true })); } catch { validText = false; } }
        }
        if (validText) { try { appendText(decoder.decode(), true); } catch { validText = false; } }
        const after = await handle.stat({ bigint: true }), current = lstatSync(file, { bigint: true });
        if (length !== Number(info.size) || [after, current].some(item => !item.isFile() || item.dev !== info.dev || item.ino !== info.ino || item.size !== info.size || item.nlink !== info.nlink || item.mode !== info.mode || item.ctimeNs !== info.ctimeNs || item.mtimeNs !== info.mtimeNs)) throw new Error("Installed common dependency source changed during capture.");
        // Include extensionless executable text and common data/templates too;
        // portable WASM remains byte-bound. Omit actual native/binary payloads.
        const rawDigest = raw.digest("hex"), normalizedDigest = normalized.digest("hex");
        if (name.endsWith(".wasm")) records.set(name, ["wasm", rawDigest]);
        else if (validText || commonSource.test(name)) records.set(name, ["text", validText && normalizeLines ? normalizedDigest : rawDigest]);
        if (manifestFile) {
          if (!validText) throw new Error("An installed dependency manifest is invalid.");
          const location = path.posix.dirname(name), expected = locked[location];
          // Published packages may carry their own node_modules test fixtures or
          // bundled source without standalone lock entries. Their bytes remain
          // inventoried under the locked owning package; top-level/workspace
          // resolution overrides have no such owner and are refused.
          const bundled = !expected && Object.keys(locked).some(owner => packageRoot.test(owner) && !locked[owner]?.link && location.startsWith(owner + "/"));
          if ((!expected && !bundled) || expected?.link) throw new Error(`An installed package overrides the committed dependency resolution: ${location}.`);
          let manifest: { name?: unknown; version?: unknown };
          try { manifest = JSON.parse(manifestText); } catch { throw new Error("An installed dependency manifest is invalid."); }
          const expectedName = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
          if (expected && (manifest.name !== expectedName || manifest.version !== expected.version)) throw new Error(`Installed dependency identity differs from the committed lockfile: ${location}.`);
          installed.add(location);
        }
      } finally { await handle.close(); }
    }));
    signal?.throwIfAborted();
    const rejected = settled.find(result => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  };
  const visit = async (file: string): Promise<void> => {
    signal?.throwIfAborted();
    const name = path.relative(root, file).split(path.sep).join("/");
    if (excluded(name)) return;
    if (++count > MAX_PORTABLE_ENTRIES) throw new Error("Installed common dependency source exceeds its bounded inventory.");
    if (count % 32 === 0) { await yieldToIo(); signal?.throwIfAborted(); }
    const info = lstatSync(file);
    if (info.isSymbolicLink()) {
      const target = realpathSync(file);
      if (!within(root, target)) throw new Error("Installed dependency link leaves the checkout.");
      const logical = path.relative(root, target).split(path.sep).join("/"), expected = locked[name];
      if (packageRoot.test(name)) {
        if (!expected?.link || expected.resolved !== logical) throw new Error("Installed workspace resolution differs from the committed lockfile.");
        installed.add(name);
      } else throw new Error("Non-workspace dependency source links are unsupported; restore the lockfile installation before verification.");
      records.set(name, ["link", logical]);
    } else if (info.isDirectory()) {
      for (const child of readdirSync(file).sort()) await visit(path.join(file, child));
    } else if (info.isFile()) {
      if (native.test(name)) return;
      pending.push({ file, name }); if (pending.length >= 8) await flush();
    } else throw new Error("Installed common dependency source contains an unsupported special file.");
  };
  for (const directory of dependencyRoots(root).filter(file => path.basename(file) === "node_modules").sort()) await visit(directory);
  await flush();
  for (const [name] of Object.entries(locked)) if (packageRoot.test(name) && !excluded(name) && !installed.has(name)) throw new Error(`A common dependency from the committed lockfile is missing: ${name}.`);
  return complete(sha(JSON.stringify([...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
}

import assert from "./support/assert";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, mock, test, type TestContext } from "node:test";
import { dependencyContentIdentity, invalidateDependencyIdentity, observeCachedDependencyIdentity, publishDependencyObservation, withDependencyObservationScope } from "aws-studio/contract-chain/dependencies";
import { PORTABLE_NORMALIZATION_PROFILE, portableDependencyDigest, portableDependencyReuseWithinEntryBudget, portableFileDigest, type LockedDependency } from "aws-studio/contract-chain/portable-dependencies";

let sequence = 0;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const put = (root: string, name: string, bytes: string | Buffer) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-portable-cache-")));
  const roots = ["first", "private"].map(name => path.join(directory, name));
  const source = `export const value = ${++sequence};\r\n`, manifest = JSON.stringify({ name: "example", version: "1.0.0" });
  const locked: Record<string, LockedDependency> = { "": { dependencies: { example: "1.0.0" } }, "node_modules/example": { version: "1.0.0" } };
  for (const root of roots) { put(root, "package.json", '{"private":true}'); put(root, "node_modules/example/package.json", manifest); put(root, "node_modules/example/index.js", source); }
  t.after(() => { for (const root of roots) invalidateDependencyIdentity(root); fs.rmSync(directory, { recursive: true, force: true }); });
  const warm = () => Promise.all(roots.map(root => dependencyContentIdentity(root)));
  const portable = (root: string, lock: Readonly<Record<string, LockedDependency>> = locked, lockDigest = "same-claimed-lock", signal?: AbortSignal) => portableDependencyDigest(root, lock, lockDigest, PORTABLE_NORMALIZATION_PROFILE, signal);
  return { directory, roots, first: roots[0]!, second: roots[1]!, source, manifest, locked, warm, portable };
}
function reads() {
  const opened: string[] = [], original = fsPromises.open;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => { opened.push(String(args[0])); return original(...args); });
  syncBuiltinESMExports(); return opened;
}

test("identical physical copies reuse validated portable content while preserving the existing digest format", async t => {
  const f = fixture(t), identities = await f.warm(); assert.equal(identities[0], identities[1]);
  const opened = reads(), first = await f.portable(f.first);
  assert.ok(opened.length > 0); opened.length = 0;
  assert.equal(await f.portable(f.second), first); assert.deepEqual(opened, []);
  assert.equal(first, digest(JSON.stringify([
    ["node_modules/example/index.js", ["text", digest(f.source.replaceAll("\r\n", "\n"))]],
    ["node_modules/example/package.json", ["text", digest(f.manifest)]],
  ])));
  put(f.second, "node_modules/example/index.js", "export const value = 'private';\n");
  assert.equal(fs.readFileSync(path.join(f.first, "node_modules/example/index.js"), "utf8"), f.source);
});

test("missing raw cache never triggers an extra raw hash or installs raw identity", async t => {
  const f = fixture(t), opened = reads();
  await f.portable(f.first); assert.equal(opened.length, 2);
  opened.length = 0; await f.portable(f.second); assert.equal(opened.length, 2);
  for (const root of f.roots) assert.equal(observeCachedDependencyIdentity(root).content, undefined);
});

test("a later raw capture reestablishes the portable/raw binding before cross-root memoization", async t => {
  const f = fixture(t), expected = await f.portable(f.first);
  await f.warm(); const opened = reads();
  assert.equal(await f.portable(f.first), expected);
  assert.equal(opened.length, 2, "a metadata-only prior result cannot prove its newly observed raw binding");
  opened.length = 0;
  assert.equal(await f.portable(f.second), expected);
  assert.equal(await f.portable(f.first), expected); assert.deepEqual(opened, []);
});

test("same-size edits with restored mtime cannot reuse old raw or portable identities", async t => {
  const f = fixture(t); await f.warm(); const original = await f.portable(f.first), file = path.join(f.second, "node_modules/example/index.js"), before = fs.statSync(file);
  fs.writeFileSync(file, f.source.replace("value", "other")); fs.utimesSync(file, before.atime, before.mtime);
  assert.equal(observeCachedDependencyIdentity(f.second).content, undefined);
  const opened = reads(); const changed = await f.portable(f.second);
  assert.notEqual(changed, original); assert.ok(opened.length > 0);
  await dependencyContentIdentity(f.second); assert.equal(await f.portable(f.second), changed);
});

test("additions and deletions invalidate reuse and required manifests retain their preflight", async t => {
  const f = fixture(t); await f.warm(); const original = await f.portable(f.first);
  put(f.second, "node_modules/example/added.js", "export const extra = true;");
  await dependencyContentIdentity(f.second); const added = await f.portable(f.second); assert.notEqual(added, original);
  fs.unlinkSync(path.join(f.second, "node_modules/example/index.js"));
  await dependencyContentIdentity(f.second); assert.notEqual(await f.portable(f.second), added);
  fs.unlinkSync(path.join(f.second, "node_modules/example/package.json"));
  await assert.rejects(f.portable(f.second), /common dependency.*missing/);
});

test("the actual lock map and claimed lock digest both participate in cache identity", async t => {
  const f = fixture(t); await f.warm(); const original = await f.portable(f.first), opened = reads();
  assert.equal(await f.portable(f.second, f.locked, "changed-lock-digest"), original); assert.ok(opened.length > 0);
  const wrongVersion = { ...f.locked, "node_modules/example": { version: "2.0.0" } };
  await assert.rejects(f.portable(f.second, wrongVersion), /differs.*lockfile/);
  const platform = { ...f.locked, "node_modules/example": { version: "1.0.0", os: ["fixture-platform"] } };
  assert.notEqual(await f.portable(f.second, platform), original, "same claimed hash cannot reuse different exclusions");
});

test("only the fixed normalization profile can use either cache", async t => {
  const f = fixture(t); await f.warm(); await f.portable(f.first);
  await assert.rejects(portableDependencyDigest(f.first, f.locked, "same-claimed-lock", "other-profile" as never), /Unsupported.*profile/);
  await assert.rejects(portableDependencyDigest(f.second, f.locked, "same-claimed-lock", (() => "fake") as never), /Unsupported.*profile/);
  assert.equal(portableFileDigest("source.js", Buffer.from("a\r\nb")), digest("a\nb"));
  assert.equal(portableFileDigest("source.bin", Buffer.from("a\r\nb")), digest("a\r\nb"));
});

test("rebased workspace links reuse portable facts but still require current target manifests", async t => {
  const f = fixture(t);
  f.locked["node_modules/shared"] = { link: true, resolved: "packages/shared" };
  for (const root of f.roots) {
    put(root, "packages/shared/package.json", '{"name":"shared","version":"1.0.0"}');
    fs.symlinkSync(path.join(root, "packages/shared"), path.join(root, "node_modules/shared"), process.platform === "win32" ? "junction" : "dir");
  }
  const identities = await f.warm(); assert.equal(identities[0], identities[1]);
  const first = await f.portable(f.first), opened = reads(); assert.equal(await f.portable(f.second), first); assert.deepEqual(opened, []);
  fs.unlinkSync(path.join(f.second, "packages/shared/package.json"));
  assert.equal(observeCachedDependencyIdentity(f.second).content, identities[1], "workspace manifest is source, not installed bytes");
  await assert.rejects(f.portable(f.second), /common dependency.*missing/);
});

test("changed logical, external and non-workspace links cannot inherit a portable result", async t => {
  const f = fixture(t); await f.warm(); await f.portable(f.first);
  put(f.second, "packages/helper/package.json", '{"name":"helper","version":"1.0.0"}');
  fs.symlinkSync(path.join(f.second, "packages/helper"), path.join(f.second, "node_modules/example/helper"), process.platform === "win32" ? "junction" : "dir");
  await dependencyContentIdentity(f.second); await assert.rejects(f.portable(f.second), /Non-workspace dependency source links/);
  fs.rmSync(path.join(f.second, "node_modules/example/helper"));
  fs.symlinkSync(f.first, path.join(f.second, "node_modules/outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.portable(f.second), /link leaves the checkout/);
});

test("a workspace link retargeted within the checkout misses the old raw key and fails locked resolution", async t => {
  const f = fixture(t); f.locked["node_modules/shared"] = { link: true, resolved: "packages/shared" };
  for (const root of f.roots) {
    put(root, "packages/shared/package.json", '{"name":"shared","version":"1.0.0"}');
    fs.symlinkSync(path.join(root, "packages/shared"), path.join(root, "node_modules/shared"), process.platform === "win32" ? "junction" : "dir");
  }
  await f.warm(); await f.portable(f.first);
  put(f.second, "packages/override/package.json", '{"name":"shared","version":"1.0.0"}');
  fs.rmSync(path.join(f.second, "node_modules/shared"));
  fs.symlinkSync(path.join(f.second, "packages/override"), path.join(f.second, "node_modules/shared"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(observeCachedDependencyIdentity(f.second).content, undefined);
  await dependencyContentIdentity(f.second);
  await assert.rejects(f.portable(f.second), /workspace resolution differs/);
});

test("fresh metadata counts empty directories and the conservative entry guard never widens the portable bound", async t => {
  const f = fixture(t); const before = await dependencyContentIdentity(f.first), observation = observeCachedDependencyIdentity(f.first);
  fs.mkdirSync(path.join(f.first, "node_modules/example/empty"));
  const after = observeCachedDependencyIdentity(f.first);
  assert.equal(after.entries, observation.entries + 1); assert.equal(after.content, undefined);
  assert.equal(await dependencyContentIdentity(f.first), before, "raw digest intentionally omits empty directories");
  assert.equal(portableDependencyReuseWithinEntryBudget(500_000), true);
  for (const count of [500_001, -1, NaN, Infinity, 1.5]) assert.equal(portableDependencyReuseWithinEntryBudget(count), false);
});

test("a cross-root hit rechecks metadata before publishing its root cache", async t => {
  const f = fixture(t); await f.warm(); const expected = await f.portable(f.first);
  const original = fs.lstatSync, target = path.join(f.second, "node_modules"); let visits = 0;
  mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const result = original(...args);
    if (String(args[0]) === target && ++visits === 2) put(f.second, "node_modules/example/index.js", "export const raced = true;\n");
    return result;
  }); syncBuiltinESMExports();
  await assert.rejects(f.portable(f.second), /changed while capturing portable/);
  mock.restoreAll(); syncBuiltinESMExports();
  assert.notEqual(await f.portable(f.second), expected);
});

test("failed portable validation never becomes a reusable success", async t => {
  const f = fixture(t); for (const root of f.roots) put(root, "node_modules/example/package.json", '{"name":"example","version":"9.0.0"}');
  await f.warm();
  await assert.rejects(f.portable(f.first), /differs.*lockfile/);
  await assert.rejects(f.portable(f.second), /differs.*lockfile/);
});

test("portable cancellation drains opened descriptors and cannot seed memoization", async t => {
  const f = fixture(t); await f.warm(); const controller = new AbortController(), original = fsPromises.open;
  let opened = 0, closed = 0;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await original(...args); opened++;
    const close = handle.close.bind(handle); handle.close = async () => { await close(); closed++; };
    controller.abort(new Error("Stop portable dependency capture")); return handle;
  }); syncBuiltinESMExports();
  await assert.rejects(f.portable(f.first, f.locked, "same-claimed-lock", controller.signal), /Stop portable dependency capture/);
  assert.ok(opened > 0); assert.equal(closed, opened);
  mock.restoreAll(); syncBuiltinESMExports();
  const observed = reads(); await f.portable(f.second); assert.ok(observed.length > 0, "cancelled donor never populated content memoization");
});

test("cancelled callers cannot obtain a portable cache hit", async t => {
  const f = fixture(t); await f.warm(); await f.portable(f.first);
  const controller = new AbortController(); controller.abort(new Error("Stop portable reuse"));
  await assert.rejects(f.portable(f.first, f.locked, "same-claimed-lock", controller.signal), /Stop portable reuse/);
  await assert.rejects(f.portable(f.second, f.locked, "same-claimed-lock", controller.signal), /Stop portable reuse/);
});

function freezeEntryStamp(t: TestContext, entry: string) {
  const stamp = fs.lstatSync(entry, { bigint: true }), original = fs.lstatSync;
  mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => path.resolve(String(file)) === entry && options?.bigint ? stamp : original(file, options as undefined)) as typeof fs.lstatSync);
  const open = fsPromises.open;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await open(...args);
    if (path.resolve(String(args[0])) === entry) {
      const stat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", { value: async (options?: { bigint?: boolean }) => options?.bigint ? stamp : stat(options as undefined) });
    }
    return handle;
  });
  syncBuiltinESMExports();
}

test("fresh scopes observe changed bytes hidden behind identical metadata and cannot reuse the old portable result", async t => {
  const base = fixture(t), f = { root: base.first, entry: path.join(base.first, "node_modules/example/index.js"), portable: () => base.portable(base.first) };
  const raw = await dependencyContentIdentity(f.root), portable = await f.portable();
  const metadata = observeCachedDependencyIdentity(f.root).metadata;
  freezeEntryStamp(t, f.entry);
  fs.writeFileSync(f.entry, fs.readFileSync(f.entry, "utf8").replace("value", "other"));
  assert.equal(observeCachedDependencyIdentity(f.root).metadata, metadata);
  assert.equal(await dependencyContentIdentity(f.root), raw, "the former warm metadata path reproduces the stale original-root cache");
  let changedRaw: string | undefined, changedPortable: string | undefined, published = false;
  await assert.rejects(withDependencyObservationScope(f.root, undefined, async () => {
    changedRaw = await dependencyContentIdentity(f.root); changedPortable = await f.portable();
    publishDependencyObservation(f.root, () => { published = true; });
    assert.notEqual(changedRaw, raw); assert.notEqual(changedPortable, portable);
    throw new Error("candidate dependency identity mismatch");
  }, { freshContent: true }), /candidate dependency identity mismatch/);
  assert.equal(published, false);
  assert.equal(observeCachedDependencyIdentity(f.root).content, raw, "rejected work publishes no replacement raw fact");
  const opened = reads();
  await withDependencyObservationScope(f.root, undefined, async () => {
    assert.equal(await dependencyContentIdentity(f.root), changedRaw);
    const beforePortable = opened.length;
    assert.equal(await f.portable(), changedPortable);
    assert.equal(opened.length - beforePortable, 2, "the failed first portable observation was not admitted");
  }, { freshContent: true });
  assert.equal(observeCachedDependencyIdentity(f.root).content, changedRaw);
});

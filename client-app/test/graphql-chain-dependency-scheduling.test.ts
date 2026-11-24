import assert from "./support/assert";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { dependencyContentIdentity, invalidateDependencyIdentity, observeCachedDependencyIdentity, observeCachedDependencyIdentityAsync } from "aws-studio/contract-chain/dependencies";
import { portableDependencyDigest, PORTABLE_NORMALIZATION_PROFILE } from "aws-studio/contract-chain/portable-dependencies";

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dependency-scheduling-")));
  const put = (name: string, contents: string) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); };
  put("package.json", '{"private":true}');
  put("node_modules/example/package.json", '{"name":"example","version":"1.0.0"}');
  for (let index = 0; index < 128; index++) put(`node_modules/example/part-${index}.js`, `export const part = ${index};\n`);
  const lock = { "": { dependencies: { example: "1.0.0" } }, "node_modules/example": { version: "1.0.0" } };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); invalidateDependencyIdentity(root); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, put, portable: (signal?: AbortSignal) => portableDependencyDigest(root, lock, "fixture-lock", PORTABLE_NORMALIZATION_PROFILE, signal) };
}

test("cooperative metadata scans preserve synchronous identity, ignored caches, directories and links", async t => {
  const f = fixture(t);
  f.put("packages/shared/package.json", '{"name":"shared"}');
  f.put("packages/nested/node_modules/nested/index.js", "nested dependency");
  f.put("node_modules/.vite-temp/transient.js", "ignored");
  fs.mkdirSync(path.join(f.root, "node_modules/example/empty"));
  fs.symlinkSync(path.join(f.root, "packages/shared"), path.join(f.root, "node_modules/shared"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await observeCachedDependencyIdentityAsync(f.root), observeCachedDependencyIdentity(f.root));
  await dependencyContentIdentity(f.root);
  const cached = observeCachedDependencyIdentity(f.root);
  assert.ok(cached.content);
  assert.deepEqual(await observeCachedDependencyIdentityAsync(f.root), cached);
  f.put("node_modules/example/part-0.js", "changed installed source");
  const changed = await observeCachedDependencyIdentityAsync(f.root);
  assert.deepEqual(changed, observeCachedDependencyIdentity(f.root));
  assert.notEqual(changed.metadata, cached.metadata);
  assert.equal(changed.content, undefined);
});

test("queued cancellation interrupts dependency metadata before any content read or publication", async t => {
  const f = fixture(t), controller = new AbortController(), reason = new Error("Cancel installed metadata traversal");
  const original = fsPromises.open;
  let opens = 0;
  t.mock.method(fsPromises, "open", (...args: Parameters<typeof fsPromises.open>) => { opens++; return original(...args); });
  syncBuiltinESMExports();
  setImmediate(() => controller.abort(reason));
  await assert.rejects(dependencyContentIdentity(f.root, controller.signal), error => error === reason);
  assert.equal(opens, 0, "the host must service cancellation while scanning metadata, before reading installed bytes");
  assert.equal(observeCachedDependencyIdentity(f.root).content, undefined);
  await dependencyContentIdentity(f.root);
  assert.ok(opens > 0, "a later successful capture still establishes its own content identity");
});

test("raw identity cache hits still allow queued cancellation before returning success", async t => {
  const f = fixture(t);
  await dependencyContentIdentity(f.root);
  const controller = new AbortController(), reason = new Error("Cancel cached metadata traversal");
  setImmediate(() => controller.abort(reason));
  await assert.rejects(dependencyContentIdentity(f.root, controller.signal), error => error === reason);
});

test("portable cache hits service queued cancellation during fresh metadata observations", async t => {
  const f = fixture(t);
  await dependencyContentIdentity(f.root);
  const first = await f.portable();
  const controller = new AbortController(), reason = new Error("Cancel portable metadata traversal");
  setImmediate(() => controller.abort(reason));
  await assert.rejects(f.portable(controller.signal), error => error === reason);
  assert.equal(await f.portable(), first, "cancellation leaves existing verified facts usable only by a fresh complete caller");
});

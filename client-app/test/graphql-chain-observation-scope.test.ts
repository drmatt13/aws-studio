import assert from "./support/assert";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, mock, test, type TestContext } from "node:test";
import { dependencyContentIdentity, dependencyMetadataAsync, observeCachedDependencyIdentity,
  DependencyObservationChangedError, publishDependencyObservation, withDependencyObservationScope, invalidateDependencyIdentity } from "aws-studio/contract-chain/dependencies";
import { portableDependencyDigest, PORTABLE_NORMALIZATION_PROFILE } from "aws-studio/contract-chain/portable-dependencies";

let sequence = 0;
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-observation-scope-")));
  const packageRoot = path.join(root, "node_modules/example"); fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"private":true}');
  fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"example","version":"1.0.0"}');
  const entry = path.join(packageRoot, "index.js"), source = `export const value = ${++sequence};\n`;
  fs.writeFileSync(entry, source);
  t.after(() => { invalidateDependencyIdentity(root); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, entry, source, portable: () => portableDependencyDigest(root,
    { "": { dependencies: { example: "1.0.0" } }, "node_modules/example": { version: "1.0.0" } },
    `scope-lock-${sequence}`, PORTABLE_NORMALIZATION_PROFILE) };
}
function observeInventories(roots: readonly string[]) {
  const counts = new Map(roots.map(root => [root, 0])), original = fs.lstatSync;
  mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => {
    if (options?.bigint) for (const root of roots) if (path.resolve(String(file)) === path.join(root, "node_modules")) counts.set(root, counts.get(root)! + 1);
    return original(file, options as undefined);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports(); return counts;
}
function observeReads() {
  const opened: string[] = [], original = fsPromises.open;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => { opened.push(String(args[0])); return original(...args); });
  syncBuiltinESMExports(); return opened;
}

test("warm nested observations use two physical inventories and publish only after close", async t => {
  const f = fixture(t), expected = await dependencyContentIdentity(f.root), inventories = observeInventories([f.root]);
  let published = false;
  const result = await withDependencyObservationScope(f.root, undefined, async () => {
    publishDependencyObservation(f.root, () => { published = true; });
    for (let i = 0; i < 20; i++) {
      assert.equal(await dependencyContentIdentity(f.root), expected);
      assert.equal(await dependencyMetadataAsync(f.root), observeCachedDependencyIdentity(f.root).metadata);
      await withDependencyObservationScope(f.root, undefined, async () => assert.equal(await dependencyContentIdentity(f.root), expected));
    }
    assert.equal(published, false); return "verified result";
  });
  assert.equal(result, "verified result"); assert.equal(published, true);
  assert.equal(inventories.get(f.root), 2);
});

test("cold raw identity is verified before lending and remains provisional until close", async t => {
  const f = fixture(t), inventories = observeInventories([f.root]), opened = observeReads();
  await withDependencyObservationScope(f.root, undefined, async () => {
    assert.equal(inventories.get(f.root), 2, "cold bytes need a physical closing capture before use");
    assert.ok(await dependencyContentIdentity(f.root));
    assert.ok(opened.length > 0);
  });
  assert.equal(inventories.get(f.root), 3);
  const reads = opened.length;
  await dependencyContentIdentity(f.root); assert.equal(opened.length, reads);
});

test("a changed or restored dependency rejects the result and provisional cache publications", async t => {
  for (const restore of [false, true]) await t.test(restore ? "restored bytes and mtime" : "changed bytes", async child => {
    const f = fixture(child), original = fs.statSync(f.entry), opened = observeReads(); let published = false;
    await assert.rejects(withDependencyObservationScope(f.root, undefined, async () => {
      publishDependencyObservation(f.root, () => { published = true; });
      fs.writeFileSync(f.entry, f.source.replace("value", "other"));
      if (restore) { fs.writeFileSync(f.entry, f.source); fs.utimesSync(f.entry, original.atime, original.mtime); }
      return { passed: true };
    }), /changed during independent contract validation/);
    assert.equal(published, false);
    const reads = opened.length; await dependencyContentIdentity(f.root);
    assert.ok(opened.length > reads, "a rejected cold operation must not seed the raw cache");
    mock.restoreAll(); syncBuiltinESMExports();
  });
});

test("foreign roots and concurrent callers cannot borrow another operation's inventory", async t => {
  const first = fixture(t), second = fixture(t);
  await Promise.all([dependencyContentIdentity(first.root), dependencyContentIdentity(second.root)]);
  const inventories = observeInventories([first.root, second.root]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const scope = withDependencyObservationScope(first.root, undefined, async () => {
    await dependencyContentIdentity(second.root);
    await withDependencyObservationScope(second.root, undefined, async () => { await dependencyContentIdentity(second.root); });
    entered(); await gate;
  });
  await ready;
  await dependencyContentIdentity(first.root);
  release(); await scope;
  assert.equal(inventories.get(first.root), 3);
  assert.equal(inventories.get(second.root), 3);
});

test("queued cancellation discards raw and portable cache facts and preserves its reason", async t => {
  const f = fixture(t), controller = new AbortController(), reason = new Error("stop scoped proof"), opened = observeReads();
  await assert.rejects(withDependencyObservationScope(f.root, controller.signal, async () => {
    await f.portable();
    queueMicrotask(() => controller.abort(reason));
    return "unpublished";
  }), error => error === reason);
  const abortedReads = opened.length;
  await dependencyContentIdentity(f.root);
  assert.ok(opened.length > abortedReads, "the aborted cold raw result was not published");
  const rawReads = opened.length;
  await f.portable();
  assert.ok(opened.length > rawReads, "the aborted portable result was not published");
});

test("late asynchronous descendants cannot borrow or publish through a closed scope", async t => {
  const f = fixture(t); await dependencyContentIdentity(f.root);
  let release!: () => void, late!: Promise<unknown>, published = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await withDependencyObservationScope(f.root, undefined, async () => {
    late = (async () => { await gate; publishDependencyObservation(f.root, () => { published = true; }); return dependencyContentIdentity(f.root); })();
  });
  const rejected = assert.rejects(late, /scope is closed/);
  release(); await rejected; assert.equal(published, false);
});

test("a foreign-root nested scope inherits cancellation from its enclosing operation", async t => {
  const first = fixture(t), second = fixture(t), controller = new AbortController(), reason = new Error("stop nested foreign scope");
  await Promise.all([dependencyContentIdentity(first.root), dependencyContentIdentity(second.root)]);
  await assert.rejects(withDependencyObservationScope(first.root, controller.signal, async () => {
    await withDependencyObservationScope(second.root, undefined, async () => {
      controller.abort(reason);
      await dependencyContentIdentity(second.root);
    });
  }), error => error === reason);
});

test("same-root nested scopes cannot introduce a separate cancellation owner", async t => {
  const f = fixture(t), owner = new AbortController(), child = new AbortController();
  let entered = false;
  await withDependencyObservationScope(f.root, owner.signal, async () => {
    await assert.rejects(withDependencyObservationScope(f.root, child.signal, async () => { entered = true; }), /owning cancellation signal/);
  });
  assert.equal(entered, false);
});

test("only conventional dependency caches can change inside an otherwise valid scope", async t => {
  const f = fixture(t); await dependencyContentIdentity(f.root);
  await withDependencyObservationScope(f.root, undefined, async () => {
    fs.mkdirSync(path.join(f.root, "node_modules/.vite-temp"));
    fs.writeFileSync(path.join(f.root, "node_modules/.vite-temp/transient.js"), "cache");
    fs.mkdirSync(path.join(f.root, "packages/database/src/generated"), { recursive: true });
    fs.writeFileSync(path.join(f.root, "packages/database/src/generated/contract.js"), "generated");
  });
  await assert.rejects(withDependencyObservationScope(f.root, undefined, async () => {
    fs.mkdirSync(path.join(f.root, "node_modules/example/.cache"));
    fs.writeFileSync(path.join(f.root, "node_modules/example/.cache/source.js"), "installed code");
  }), /changed during independent contract validation/);
});

test("a native dependency notification rejects equal-metadata scoped evidence and provisional caches", async t => {
  const f = fixture(t);
  await dependencyContentIdentity(f.root);
  const before = observeCachedDependencyIdentity(f.root), opened = observeReads();
  let published = false;
  await assert.rejects(withDependencyObservationScope(f.root, undefined, async () => {
    publishDependencyObservation(f.root, () => { published = true; });
    invalidateDependencyIdentity(f.root);
    assert.throws(() => observeCachedDependencyIdentity(f.root), DependencyObservationChangedError, "nested reads cannot borrow the invalidated observation");
  }), DependencyObservationChangedError);
  assert.equal(published, false);
  const after = observeCachedDependencyIdentity(f.root);
  assert.notEqual(after.metadata, before.metadata);
  assert.equal(after.content, undefined);
  await dependencyContentIdentity(f.root);
  assert.ok(opened.length > 0, "fresh content is required after a notification even if bytes were restored");
});

test("a native dependency notification during scope closure discards deferred facts", async t => {
  const f = fixture(t); await dependencyContentIdentity(f.root);
  let published = false;
  await assert.rejects(withDependencyObservationScope(f.root, undefined, async () => {
    publishDependencyObservation(f.root, () => { published = true; });
    invalidateDependencyIdentity(f.root);
    return "provisional result";
  }), /changed during independent contract validation/);
  assert.equal(published, false);
  assert.equal(observeCachedDependencyIdentity(f.root).content, undefined);
});

test("warm fresh scopes read installed bytes once and lend stable raw and portable identity to nested work", async t => {
  const f = fixture(t), raw = await dependencyContentIdentity(f.root), portable = await f.portable(), opened = observeReads();
  for (let turn = 0; turn < 2; turn++) {
    const began = opened.length;
    await withDependencyObservationScope(f.root, undefined, async () => {
      assert.equal(opened.length - began, 2, "one opening byte pass covers both fixture package files");
      for (let check = 0; check < 20; check++) {
        assert.equal(await dependencyContentIdentity(f.root), raw);
        assert.equal(await f.portable(), portable);
        await withDependencyObservationScope(f.root, undefined, async () => assert.equal(await dependencyContentIdentity(f.root), raw), { freshContent: true });
      }
      assert.equal(opened.length - began, 2, "nested checks do not reread package bytes");
    }, { freshContent: true });
    assert.equal(opened.length - began, 2);
  }
});

test("a fresh child cannot upgrade a cached parent observation without opening its own boundary", async t => {
  const f = fixture(t); await dependencyContentIdentity(f.root); let entered = false;
  await withDependencyObservationScope(f.root, undefined, async () => {
    await assert.rejects(withDependencyObservationScope(f.root, undefined, async () => { entered = true; }, { freshContent: true }), /cannot borrow a cached parent/);
  });
  assert.equal(entered, false);
});

test("cancellation after fresh raw and portable work does not admit either cache", async t => {
  const f = fixture(t), controller = new AbortController(), reason = new Error("cancel fresh boundary"), opened = observeReads();
  await assert.rejects(withDependencyObservationScope(f.root, controller.signal, async () => {
    await f.portable(); queueMicrotask(() => controller.abort(reason)); return "unpublished";
  }, { freshContent: true }), error => error === reason);
  assert.equal(observeCachedDependencyIdentity(f.root).content, undefined);
  const before = opened.length;
  await withDependencyObservationScope(f.root, undefined, async () => { await f.portable(); }, { freshContent: true });
  assert.equal(opened.length - before, 4, "fresh raw and portable bytes must both be observed again after cancellation");
});

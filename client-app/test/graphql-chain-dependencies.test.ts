import { fixtureProofIdentity, fixtureDecisionsFor, fixtureReviewDecisions } from "./support/chain-verification";
import assert from "./support/assert";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { dependencyContentIdentity, dependencyMetadata, invalidateDependencyIdentity } from "aws-studio/contract-chain/dependencies";
import { isDependencyCachePath, readDependencyDigest } from "aws-studio/source/workspace";
import { GraphQLChainService } from "../server/graphql-chain/service";
import { graphqlChainFixture } from "./support/graphql-chain";
import { putRuntimeArtifacts } from "./support/chain-verification";

const roots: string[] = [];
afterEach(() => {
  mock.restoreAll(); syncBuiltinESMExports();
  for (const root of roots.splice(0)) { invalidateDependencyIdentity(root); rmSync(root, { recursive: true, force: true }); }
});
function put(root: string, name: string, source: string): void {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), source);
}
function fixture(): { root: string; entry: string } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-chain-dependencies-"))); roots.push(root);
  putRuntimeArtifacts(root);
  put(root, "package.json", '{"private":true,"type":"module"}\n');
  put(root, "source.ts", "export const source=1;\n");
  put(root, "node_modules/example/package.json", '{"name":"example","version":"1.0.0"}\n');
  put(root, "node_modules/example/index.js", "export const value=1;\n");
  return { root, entry: path.join(root, "node_modules/example/index.js") };
}
function observeReads(callback: (name: string) => void): void {
  const original = fsPromises.open;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await original(...args);
    callback(String(args[0]));
    return handle;
  });
  // The workspace reader uses the named built-in ESM export; update that binding too.
  syncBuiltinESMExports();
}

test("unchanged installed metadata reuses the content identity without reopening dependency bytes", async () => {
  const { root } = fixture(); let reads = 0;
  observeReads(() => { reads++; });
  const first = await dependencyContentIdentity(root), count = reads;
  assert.ok(count > 0, "The first identity must read installed content.");
  assert.equal(await dependencyContentIdentity(root), first);
  assert.equal(reads, count, "An unchanged metadata scan must reuse the verified content digest.");
  invalidateDependencyIdentity(root);
  assert.equal(await dependencyContentIdentity(root), first);
  assert.ok(reads > count, "Explicit invalidation must force installed content to be read again.");
});

test("an aborted content read cannot seed the reusable dependency identity cache", async () => {
  const { root } = fixture(), controller = new AbortController();
  let reads = 0;
  observeReads(() => { reads++; if (!controller.signal.aborted) controller.abort(new Error("Stop cached dependency capture")); });
  await assert.rejects(dependencyContentIdentity(root, controller.signal), /Stop cached dependency capture/);
  const cancelledReads = reads;
  const complete = await dependencyContentIdentity(root);
  assert.ok(reads > cancelledReads, "a cancelled read cannot substitute for a complete content identity");
  const completeReads = reads;
  assert.equal(await dependencyContentIdentity(root), complete);
  assert.equal(reads, completeReads);
});

test("a cancelled caller cannot obtain an otherwise reusable dependency identity", async () => {
  const { root } = fixture();
  await dependencyContentIdentity(root);
  const controller = new AbortController(); controller.abort(new Error("Stop cached identity reuse"));
  await assert.rejects(dependencyContentIdentity(root, controller.signal), /Stop cached identity reuse/);
});

test("Vite temporary config creation, edits and removal neither change identity nor reopen package bytes", async () => {
  const { root, entry } = fixture();
  put(root, "packages/feature/package.json", '{"name":"feature","private":true}\n');
  mkdirSync(path.join(root, "packages/feature/node_modules"));
  let reads = 0; observeReads(() => { reads++; });
  const initialMetadata = dependencyMetadata(root), first = await dependencyContentIdentity(root), count = reads;
  for (const directory of ["node_modules/.vite-temp", "packages/feature/node_modules/.vite-temp", "node_modules/.vite", "node_modules/.cache"]) {
    const temporary = `${directory}/vite.config.mts.timestamp-fixture.mjs`;
    put(root, temporary, "export default {};\n");
    assert.equal(dependencyMetadata(root), initialMetadata, directory);
    assert.equal(await dependencyContentIdentity(root), first);
    put(root, temporary, "export default {changed:true};\n");
    rmSync(path.join(root, directory), { recursive: true });
    assert.equal(dependencyMetadata(root), initialMetadata, directory);
    assert.equal(await dependencyContentIdentity(root), first);
    assert.equal(reads, count, "cache-only changes must not trigger a full package-byte read");
  }
  writeFileSync(entry, "export const value=2;\n");
  assert.notEqual(await dependencyContentIdentity(root), first);
  assert.ok(reads > count, "actual installed code still forces content re-attestation");
});

test("ignored Vite config files are skipped before lstat while similarly named package code stays included", async () => {
  const { root } = fixture();
  put(root, "node_modules/.vite-temp/vite.config.mts.timestamp-fixture.mjs", "transient config\n");
  const original = fsPromises.lstat;
  mock.method(fsPromises, "lstat", (...args: Parameters<typeof fsPromises.lstat>) => {
    assert.equal(isDependencyCachePath(String(args[0])), false, "ignored paths must not be statted after an ephemeral unlink");
    return original(...args);
  });
  syncBuiltinESMExports();
  const first = await readDependencyDigest(root);
  put(root, "node_modules/.vite-temp-extra/index.js", "meaningful package code\n");
  assert.notEqual(await readDependencyDigest(root), first);
});

test("temporary Vite config files reuse native evidence while actual installed code changes reevaluate it", async () => {
  const { root, entry } = fixture(); let evaluations = 0;
  const sdl = "type Query { value: String }";
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, identity: () => dependencyContentIdentity(root), evaluate: async () => {
    evaluations++;
    return { sdl, generatedSdl: sdl, schemaDiagnostics: [], generatedDiagnostics: [], documentDiagnostics: [], documents: [], documentSet: "matches", codegen: { status: "current", files: [], diagnostics: [] }, verification: graphqlChainFixture().verification, contract: { storageHash: "a".repeat(64), executionHash: null } };
  } });
  try {
    await service.load(); assert.equal(evaluations, 1);
    put(root, "node_modules/.vite-temp/vite.config.mts.timestamp-fixture.mjs", "export default {};\n");
    await service.load(); assert.equal(evaluations, 1);
    rmSync(path.join(root, "node_modules/.vite-temp"), { recursive: true });
    await service.load(); assert.equal(evaluations, 1);
    writeFileSync(entry, "export const value=2;\n");
    await service.load(); assert.equal(evaluations, 2);
  } finally { await service.dispose(); }
});

test("same-size content edits invalidate identity even when the old modification time is restored", async () => {
  const { root, entry } = fixture();
  const exactTime = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(entry, exactTime, exactTime);
  const original = statSync(entry), firstMetadata = dependencyMetadata(root), first = await dependencyContentIdentity(root);
  const originalModified = statSync(entry, { bigint: true }).mtimeNs;
  const old = readFileSync(entry, "utf8"); writeFileSync(entry, old.replace("value=1", "value=2"));
  utimesSync(entry, original.atime, original.mtime);
  assert.equal(statSync(entry).size, original.size);
  assert.equal(statSync(entry, { bigint: true }).mtimeNs, originalModified);
  assert.notEqual(dependencyMetadata(root), firstMetadata, "Nanosecond ctime must invalidate a same-size, restored-mtime edit.");
  assert.notEqual(await dependencyContentIdentity(root), first);
});

test("dependency additions, removals and nested workspace installs invalidate the digest", async () => {
  const { root } = fixture(), first = await dependencyContentIdentity(root);
  put(root, "node_modules/example/addition.js", "export const added=true;\n");
  const added = await dependencyContentIdentity(root); assert.notEqual(added, first);
  rmSync(path.join(root, "node_modules/example/addition.js"));
  assert.equal(await dependencyContentIdentity(root), first);
  put(root, "packages/feature/package.json", '{"name":"feature","private":true}\n');
  put(root, "packages/feature/node_modules/extra/index.js", "export const extra=1;\n");
  const nested = await dependencyContentIdentity(root); assert.notEqual(nested, first);
  put(root, "packages/feature/node_modules/extra/index.js", "export const extra=2;\n");
  assert.notEqual(await dependencyContentIdentity(root), nested);
});

test("a link outside the checkout is refused before any cached identity is accepted", async () => {
  const { root } = fixture(), outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-chain-dependencies-outside-"))); roots.push(outside);
  writeFileSync(path.join(outside, "index.js"), "private outside code\n");
  await dependencyContentIdentity(root);
  symlinkSync(outside, path.join(root, "node_modules/outside"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => dependencyMetadata(root), /link leaves the checkout/);
  await assert.rejects(dependencyContentIdentity(root), /link leaves the checkout/);
});

test("dependency-only directories use the same installed-root inventory as full content hashing", async () => {
  const { root } = fixture(), before = await dependencyContentIdentity(root), metadata = dependencyMetadata(root);
  put(root, "unreferenced/node_modules/orphan/index.js", "export const value=1;\n");
  assert.notEqual(dependencyMetadata(root), metadata);
  const added = await dependencyContentIdentity(root); assert.notEqual(added, before);
  put(root, "unreferenced/node_modules/orphan/index.js", "export const value=2;\n");
  assert.notEqual(await dependencyContentIdentity(root), added);
  rmSync(path.join(root, "unreferenced"), { recursive: true });
  assert.equal(await dependencyContentIdentity(root), before);
});

test("metadata changes during content capture discard the digest instead of caching a mixed observation", async () => {
  const { root } = fixture(); let changed = false;
  observeReads(name => {
    if (!changed && name.includes(`${path.sep}node_modules${path.sep}`)) {
      changed = true;
      // Enumeration has finished before the reader flushes its file batch. The new
      // inode is therefore detected by the metadata recheck, outside that batch.
      put(root, "node_modules/example/late.js", "export const late=true;\n");
    }
  });
  await assert.rejects(dependencyContentIdentity(root), /changed while capturing their content identity/);
  assert.equal(changed, true);
  const settled = await dependencyContentIdentity(root);
  assert.equal(await dependencyContentIdentity(root), settled);
});

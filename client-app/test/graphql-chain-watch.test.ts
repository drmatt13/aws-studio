import assert from "./support/assert";
import path from "node:path";
import { test } from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { GraphQLChainWatchInputs, isGraphQLChainWatchInput, watchFileStamp } from "../server/graphql-chain/watch-inputs";
import { dependencyContentIdentity, observeCachedDependencyIdentity } from "aws-studio/contract-chain/dependencies";

test("access notifications cannot invalidate a contract check, but writes and replacements do", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chain-watch-stamps-"));
  try {
    const file = "contract.ts", absolute = path.join(root, file);
    writeFileSync(absolute, "before");
    mkdirSync(path.join(root, "node_modules/tool"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/tool/index.js"), "before");
    const inputs = new GraphQLChainWatchInputs(root);
    const stat = lstatSync(absolute, { bigint: true });
    assert.equal(watchFileStamp(stat), watchFileStamp(Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { atimeNs: stat.atimeNs + 10_000n })));
    readFileSync(absolute);
    assert.equal(inputs.changed(file), false);
    assert.equal(inputs.changed("node_modules/tool/index.js"), false);
    writeFileSync(absolute, "after!");
    assert.equal(inputs.notified(file), true);
    assert.equal(inputs.changed(file), false);
    writeFileSync(path.join(root, "replacement"), "after!");
    renameSync(path.join(root, "replacement"), absolute);
    assert.equal(inputs.notified(file), true);
    writeFileSync(path.join(root, "node_modules/tool/index.js"), "after!");
    assert.equal(inputs.notified("node_modules/tool/index.js"), true);
    rmSync(absolute);
    assert.equal(inputs.notified(file), true);
    assert.equal(inputs.changed(undefined), false, "an overflow of access-only notifications is not a source edit");
    writeFileSync(absolute, "missed event");
    assert.equal(inputs.changed(undefined), true, "a lost filename still detects actual source changes");
    assert.equal(inputs.changed(undefined), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("filtered native writes invalidate equal metadata without disturbing source-only dependency reuse", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "chain-watch-notifications-"));
  try {
    writeFileSync(path.join(root, "contract.ts"), "before");
    mkdirSync(path.join(root, "node_modules/tool"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/tool/index.js"), "before");
    const inputs = new GraphQLChainWatchInputs(root);
    await dependencyContentIdentity(root);
    const before = observeCachedDependencyIdentity(root), dependencyStamp = inputs.dependencyStamp();
    assert.equal(inputs.changed("contract.ts"), false, "a metadata poll does not claim a native write");
    assert.equal(inputs.notified("contract.ts"), true, "a genuine write remains meaningful even when every visible stamp matches");
    assert.deepEqual(observeCachedDependencyIdentity(root), before, "source-only writes retain the installed byte identity");
    assert.equal(inputs.dependencyStamp(), dependencyStamp);
    const dependency = path.join(root, "node_modules/tool/index.js"), stamp = lstatSync(dependency, { bigint: true });
    const original = fs.lstatSync;
    t.mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => path.resolve(String(file)) === dependency && options?.bigint
      ? stamp : original(file, options as undefined)) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    writeFileSync(dependency, "after!");
    assert.equal(inputs.changed("node_modules/tool/index.js"), false, "the filesystem reproduces a same-size timestamp collision");
    assert.equal(inputs.notified("node_modules/tool/index.js"), true);
    const after = observeCachedDependencyIdentity(root);
    assert.notEqual(after.metadata, before.metadata, "a notification changes the local guard despite identical filesystem metadata");
    assert.equal(after.content, undefined, "the raw cache cannot hide a timestamp collision");
    assert.notEqual(inputs.dependencyStamp(), dependencyStamp, "upstream presentation cannot retain the old dependency lease");
    const changed = inputs.dependencyStamp();
    assert.equal(inputs.notified("node_modules/.vite-temp/transient.js"), false);
    assert.equal(inputs.dependencyStamp(), changed, "excluded cache notifications do not invalidate dependency identity");
    assert.notEqual(await dependencyContentIdentity(root), before.content, "fresh hashing observes the changed bytes despite equal timestamps");
    const directoryStamp = inputs.dependencyStamp(), directoryIdentity = observeCachedDependencyIdentity(root);
    assert.equal(inputs.notified("node_modules/tool"), true, "a directory-only native event cannot hide a descendant timestamp collision");
    assert.notEqual(inputs.dependencyStamp(), directoryStamp);
    assert.notEqual(observeCachedDependencyIdentity(root).metadata, directoryIdentity.metadata);
    assert.equal(observeCachedDependencyIdentity(root).content, undefined);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test("unknown native notifications cannot preserve confidence from identical metadata", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chain-watch-overflow-"));
  try {
    writeFileSync(path.join(root, "contract.ts"), "before");
    const inputs = new GraphQLChainWatchInputs(root), stamp = inputs.dependencyStamp();
    assert.equal(inputs.changed(undefined), false);
    assert.equal(inputs.notified(undefined), true);
    assert.notEqual(inputs.dependencyStamp(), stamp, "overflow may conceal a dependency write");
    assert.equal(inputs.changed(undefined), false, "a later metadata poll does not clear the notification guard");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory membership and fixed generated artifacts remain watched without cache noise", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chain-watch-tree-"));
  try {
    mkdirSync(path.join(root, "output"));
    mkdirSync(path.join(root, "packages/database/src/generated"), { recursive: true });
    const inputs = new GraphQLChainWatchInputs(root);
    mkdirSync(path.join(root, "output/playwright"));
    assert.equal(inputs.changed("output"), false);
    writeFileSync(path.join(root, "packages/database/src/generated/contract.json"), "{}");
    assert.equal(inputs.notified("packages/database/src/generated/contract.json"), true);
    writeFileSync(path.join(root, "output/authored.ts"), "source");
    assert.equal(inputs.changed("output"), true);
    assert.equal(inputs.changed("output/authored.ts"), false, "directory reconciliation already captured its descendant");
    assert.equal(inputs.changed("output/authored.ts"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory-only notifications reconcile changed descendants, rename, deletion and recreation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chain-watch-descendants-"));
  try {
    mkdirSync(path.join(root, "source/nested"), { recursive: true });
    writeFileSync(path.join(root, "source/nested/file.ts"), "before");
    const inputs = new GraphQLChainWatchInputs(root);
    writeFileSync(path.join(root, "source/nested/file.ts"), "after!");
    assert.equal(inputs.notified("source"), true);
    assert.equal(inputs.changed(undefined), false);
    renameSync(path.join(root, "source"), path.join(root, "renamed"));
    assert.equal(inputs.notified("source"), true);
    assert.equal(inputs.notified("renamed"), true);
    rmSync(path.join(root, "renamed"), { recursive: true });
    assert.equal(inputs.notified("renamed"), true);
    mkdirSync(path.join(root, "renamed/nested"), { recursive: true });
    writeFileSync(path.join(root, "renamed/nested/file.ts"), "again!");
    assert.equal(inputs.notified("renamed"), true);
    assert.equal(inputs.changed(undefined), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime and private ancestors are excluded before nested node_modules are admitted", () => {
  for (const file of [
    ".cache/framework-studio/graphql-chain-worker-fixture/node_modules",
    ".cache/framework-studio/graphql-chain-worker-fixture/node_modules/graphql/index.js",
    ".framework/agent-runtime/candidate/node_modules/tsx/index.mjs",
    "output/playwright/graphql-contract-chain/fixture/node_modules/tool/index.js",
    ".aws/fixture/node_modules/tool/index.js",
    ".git/fixture/node_modules/tool/index.js",
    "client-app/dist/node_modules/tool/index.js",
    "coverage/fixture/node_modules/tool/index.js",
    ".env.private/node_modules/tool/index.js",
    "fixture.log/node_modules/tool/index.js",
  ]) assert.equal(isGraphQLChainWatchInput(file.split("/").join(path.sep)), false, file);
});

test("actual public source, installed dependencies and the runtime contract still invalidate", () => {
  for (const file of [
    "packages/database/prisma/contract.prisma",
    "packages/database/src/generated/contract.json",
    "packages/database/src/generated/contract.d.ts",
    "packages/database/src/generated/client-access.ts",
    "packages/database/src/generated/access-graph.json",
    "compute/http/graphql-api/schema/project.ts",
    "client-app/src/api/projects/operations.ts",
    "client-app/src/api/generated/graphql.ts",
    "graphql-chain.review.json",
    "node_modules",
    "node_modules/graphql/index.js",
    "packages/library/node_modules/tool/index.js",
    "node_modules/tool/node_modules/nested/index.js",
    "node_modules/.vite-temp-extra/index.js",
    "node_modules/tool/.vite-temp/runtime.js",
  ]) assert.equal(isGraphQLChainWatchInput(file.split("/").join(path.sep)), true, file);
  assert.equal(isGraphQLChainWatchInput(undefined), true);
});

test("excluded generated files, dependency caches and invalid paths do not create false changes", () => {
  for (const file of [
    "packages/database/src/generated/extra.d.ts",
    "node_modules/.cache/tool/cache.json",
    "node_modules/.vite/metadata.json",
    "node_modules/.vite-temp",
    "node_modules/.vite-temp/vite.config.mts.timestamp-fixture.mjs",
    "client-app/node_modules/.vite-temp/vite.config.mts.timestamp-fixture.mjs",
    "packages/library/node_modules/.vite-temp/vite.config.mts.timestamp-fixture.mjs",
    "packages/library/node_modules/.cache/tool/cache.json",
    "node_modules/tool/node_modules/.vite/metadata.json",
    "output/playwright/receipt.json",
    ".cache/framework-studio/graphql-chain/evidence.json",
    "../outside/node_modules/tool/index.js",
    "/outside/node_modules/tool/index.js",
  ]) assert.equal(isGraphQLChainWatchInput(file.split("/").join(path.sep)), false, file);
});

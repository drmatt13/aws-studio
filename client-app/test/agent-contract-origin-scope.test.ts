import assert from "./support/assert";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test, type TestContext } from "node:test";
import { assertContractOrigin, refreshContractContext, type ContractToolchain } from "../server/agent-runtime/contract-validation";
import { GraphQLChainInspector } from "aws-studio/contract-chain/inspector";
import { dependencyContentIdentity, dependencyMetadataAsync, invalidateDependencyIdentity } from "aws-studio/contract-chain/dependencies";
import { buildContractCodingContext, type ContractCodingContext } from "../shared/contract-propagation";
import type { ContractProofReceipts } from "aws-studio/contract-chain/contract-proof";
import { fixtureProofIdentity, putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";

afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); });
const sdl = "type Query { value: String }";
async function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "studio-contract-origin-scope-"))), root = path.join(directory, "project");
  fs.mkdirSync(root);
  const put = (name: string, value: string) => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  put("package.json", '{"name":"origin-scope-fixture"}');
  put("packages/database/prisma/contract.prisma", '// use prisma-8\nmodel Project {\n id Uuid @id\n}\n');
  put("graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
  put("node_modules/example/package.json", '{"name":"example","version":"1.0.0"}');
  put("node_modules/example/index.js", "export const value = 1;\n");
  putRuntimeArtifacts(root);
  const worker = Buffer.from("// immutable fixture worker\n"), reporter = Buffer.from("// immutable fixture reporter\n");
  const asset = (name: string, bytes: Buffer) => { const file = path.join(directory, name); fs.writeFileSync(file, bytes); return { file, digest: createHash("sha256").update(bytes).digest("hex") }; };
  const identity = await fixtureProofIdentity(root);
  const toolchain: ContractToolchain = { worker: asset("worker.cjs", worker), reporter: asset("reporter.cjs", reporter), policy: identity.policy, controlDependencyDigest: identity.toolchain.dependencyDigest };
  const evaluate = async (_root: string, signal: AbortSignal) => { await dependencyMetadataAsync(root, signal); return verifiedEvaluation(sdl); };
  const inspector = new GraphQLChainInspector(root, { evaluate, workerBundle: async () => worker, portableIdentity: fixtureProofIdentity });
  const observation = await inspector.inspect(true); await inspector.dispose();
  const context = buildContractCodingContext(observation.chain, "api");
  const run = (refresh: boolean, signal?: AbortSignal, evaluateOverride = evaluate): Promise<void | ContractCodingContext> => refresh
    ? refreshContractContext(root, "api", context.decisions, toolchain, context, { evaluate: evaluateOverride, portableIdentity: fixtureProofIdentity }, signal)
    : assertContractOrigin(root, context, toolchain, { evaluate: evaluateOverride, portableIdentity: fixtureProofIdentity }, signal);
  t.after(() => { invalidateDependencyIdentity(root); fs.rmSync(directory, { recursive: true, force: true }); });
  return { root, context, run, toolchain, receipts: observation.proof!.receipts, entry: path.join(root, "node_modules/example/index.js") };
}
function inventoryCounter(root: string, onInventory?: (count: number) => void) {
  let count = 0;
  const original = fs.lstatSync;
  mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => {
    if (options?.bigint && path.resolve(String(file)) === path.join(root, "node_modules")) { count++; onInventory?.(count); }
    return original(file, options as undefined);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  return () => count;
}

test("an obsolete source or review revision never starts executable origin checks", async t => {
  for (const relative of ["packages/database/prisma/contract.prisma", "graphql-chain.review.json"]) await t.test(relative, async child => {
    const fixtureSource = await fixture(child);
    const filename = path.join(fixtureSource.root, relative);
    fs.appendFileSync(filename, "\n");
    const phases: string[] = [];
    await assert.rejects(
      assertContractOrigin(fixtureSource.root, fixtureSource.context, fixtureSource.toolchain, {
        onProgress: phase => phases.push(phase),
        evaluate: async () => assert.fail("an obsolete revision cannot execute application code"),
        portableIdentity: async () => assert.fail("an obsolete revision cannot compute proof"),
      }),
      /source or review evidence changed/,
    );
    assert.deepEqual(phases, ["starting", "source"]);
  });
});

test("origin and refresh use three byte-fresh inventories without changing receipts or contexts", async t => {
  for (const refresh of [false, true]) for (const cold of [false, true]) await t.test(`${refresh ? "refresh" : "origin"} ${cold ? "cold" : "warm"}`, async child => {
    const f = await fixture(child);
    if (cold) invalidateDependencyIdentity(f.root); else await dependencyContentIdentity(f.root);
    const count = inventoryCounter(f.root), originalInspect = GraphQLChainInspector.prototype.inspect, observed: ContractProofReceipts[] = [];
    const opened: string[] = [], originalOpen = fsPromises.open;
    mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      if (String(args[0]).startsWith(path.join(f.root, "node_modules") + path.sep)) opened.push(String(args[0]));
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    mock.method(GraphQLChainInspector.prototype, "inspect", function (this: GraphQLChainInspector, ...args: Parameters<GraphQLChainInspector["inspect"]>) {
      return originalInspect.apply(this, args).then(observation => { observed.push(observation.proof!.receipts); return observation; });
    });
    try {
      const result = await f.run(refresh);
      assert.equal(count(), 3);
      assert.equal(opened.length, 2, "each installed file is freshly hashed once at opening; nested guards never reopen it");
      assert.deepEqual(observed, [f.receipts], "scope ownership changes no content, check, decision or predecessor commitment");
      if (refresh) assert.deepEqual(result, f.context);
      else assert.equal(result, undefined);
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test("a dependency changed and restored at the physical closing scan cannot admit origin or refreshed context", async t => {
  for (const refresh of [false, true]) await t.test(refresh ? "refresh" : "origin", async child => {
    const f = await fixture(child), original = fs.readFileSync(f.entry, "utf8");
    let admitted = false, mutated = false;
    const count = inventoryCounter(f.root, current => {
      if (current === 3) { mutated = true; fs.writeFileSync(f.entry, original + "// transient\n"); fs.writeFileSync(f.entry, original); }
    });
    try {
      await assert.rejects(f.run(refresh).then(result => { admitted = true; return result; }), /changed during independent contract validation/);
      assert.equal(count(), 3); assert.equal(mutated, true); assert.equal(admitted, false);
      assert.equal(fs.readFileSync(f.entry, "utf8"), original);
      assert.equal(fs.readFileSync(path.join(f.root, "graphql-chain.review.json"), "utf8"), '{"version":1,"prisma":null,"client":null}\n');
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test("owner cancellation at the closing scan prevents every admission return", async t => {
  for (const refresh of [false, true]) await t.test(refresh ? "refresh" : "origin", async child => {
    const f = await fixture(child), controller = new AbortController(), reason = new Error("cancel origin scope closure");
    let admitted = false;
    const count = inventoryCounter(f.root, current => { if (current === 3) controller.abort(reason); });
    try {
      await assert.rejects(f.run(refresh, controller.signal).then(result => { admitted = true; return result; }), error => error === reason);
      assert.equal(count(), 3); assert.equal(admitted, false);
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test("the inspector combined cancellation signal borrows the outer observation and drains evaluation", async t => {
  for (const refresh of [false, true]) await t.test(refresh ? "refresh" : "origin", async child => {
    const f = await fixture(child), controller = new AbortController(), reason = new Error("cancel active origin scope");
    let entered!: () => void, release!: () => void, cleaned = false, admitted = false;
    const started = new Promise<void>(resolve => { entered = resolve; }), drain = new Promise<void>(resolve => { release = resolve; });
    const operation = f.run(refresh, controller.signal, async (root, signal) => {
      assert.notEqual(signal, controller.signal);
      await dependencyMetadataAsync(root, signal);
      const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { void drain.then(() => { cleaned = true; reject(signal.reason); }); }, { once: true }));
      entered(); return stopped;
    }).then(result => { admitted = true; return result; });
    const rejected = assert.rejects(operation, error => error === reason);
    await started; controller.abort(reason); await Promise.resolve();
    assert.equal(cleaned, false); release(); await rejected;
    assert.equal(cleaned, true); assert.equal(admitted, false);
  });
});

test("cancellation during a cold opening dependency hash drains files before admission or evaluation", async t => {
  for (const refresh of [false, true]) await t.test(refresh ? "refresh" : "origin", async child => {
    const f = await fixture(child), controller = new AbortController(), reason = new Error("cancel cold origin dependency capture");
    invalidateDependencyIdentity(f.root);
    const original = fsPromises.open;
    let active = 0, opened = 0, evaluated = false, admitted = false;
    mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original(...args);
      if (String(args[0]).startsWith(path.join(f.root, "node_modules") + path.sep)) {
        active++; opened++;
        const close = handle.close.bind(handle);
        handle.close = async () => { try { await close(); } finally { active--; } };
        controller.abort(reason);
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.run(refresh, controller.signal, async () => { evaluated = true; return verifiedEvaluation(sdl); }).then(result => { admitted = true; return result; }), error => error === reason);
      assert.ok(opened > 0); assert.equal(active, 0); assert.equal(evaluated, false); assert.equal(admitted, false);
      const beforeRetry = opened;
      await dependencyContentIdentity(f.root);
      assert.ok(opened > beforeRetry, "cancelled cold identity is not published for later admission");
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test("fresh origin refuses installed byte drift hidden by a warm metadata collision", async t => {
  const f = await fixture(t), expected = await dependencyContentIdentity(f.root);
  const original = fs.readFileSync(f.entry, "utf8"), before = fs.lstatSync(f.entry), beforeBigInt = fs.lstatSync(f.entry, { bigint: true });
  const changed = original.replace("value = 1", "value = 2");
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
  const originalLstat = fs.lstatSync, originalAsyncLstat = fsPromises.lstat, originalOpen = fsPromises.open;
  let opened = 0, admitted = false;
  mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => path.resolve(String(file)) === f.entry
    ? options?.bigint ? beforeBigInt : before : originalLstat(file, options as undefined)) as typeof fs.lstatSync);
  mock.method(fsPromises, "lstat", (async (file: fs.PathLike, options?: { bigint?: boolean }) => path.resolve(String(file)) === f.entry
    ? options?.bigint ? beforeBigInt : before : originalAsyncLstat(file, options as undefined)) as typeof fsPromises.lstat);
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) === f.entry) {
      opened++;
      handle.stat = (async (options?: { bigint?: boolean }) => options?.bigint ? beforeBigInt : before) as typeof handle.stat;
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(f.entry, changed);
    assert.equal(await dependencyContentIdentity(f.root), expected, "the fixture reproduces a warm cache with identical visible metadata");
    await assert.rejects(f.run(false).then(result => { admitted = true; return result; }), /source or review evidence changed/);
    assert.ok(opened > 0, "origin freshly reads the installed bytes despite the matching metadata");
    assert.equal(admitted, false);
    assert.equal(fs.readFileSync(path.join(f.root, "graphql-chain.review.json"), "utf8"), '{"version":1,"prisma":null,"client":null}\n');
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});

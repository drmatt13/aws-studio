import assert from "./support/assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { GraphQLChainInspector } from "aws-studio/contract-chain/inspector";
import { fixtureProofIdentity, putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-chain-cancel-"));
  mkdirSync(path.join(root, "packages/database/prisma"), { recursive: true });
  writeFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "// use prisma-8\nmodel Project {\n id Uuid @id\n}\n");
  putRuntimeArtifacts(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function blocked(signal: AbortSignal | undefined, entered: ReturnType<typeof deferred>, aborted: ReturnType<typeof deferred>, drain: ReturnType<typeof deferred>) {
  assert.ok(signal, "the current inspection owner signal reaches every async phase");
  const result = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted.resolve(); void drain.promise.then(() => reject(signal.reason)); }, { once: true });
  });
  entered.resolve();
  return result;
}

test("owner cancellation reaches identity, evaluation, portable proof and publication and drains cleanup", async t => {
  for (const phase of ["identity", "evaluation", "portable", "publication"] as const) await t.test(phase, async child => {
    const root = fixture(child), controller = new AbortController(), entered = deferred(), aborted = deferred(), drain = deferred();
    let identities = 0, evaluations = 0, published = false;
    const inspector = new GraphQLChainInspector(root, {
      signal: controller.signal,
      identity: async (_root, signal) => { identities++; if (phase === "identity" && identities === 1 || phase === "publication" && identities === 3) return blocked(signal, entered, aborted, drain); return "current"; },
      evaluate: async (_root, signal) => { evaluations++; if (phase === "evaluation") return blocked(signal, entered, aborted, drain); return verifiedEvaluation("type Query { value: String }"); },
      portableIdentity: async (root, signal) => phase === "portable" ? blocked(signal, entered, aborted, drain) : fixtureProofIdentity(root),
    });
    const operation = inspector.inspect(true);
    const rejected = assert.rejects(operation, /cancelled by task/);
    void operation.then(() => { published = true; }, () => { published = true; });
    await entered.promise;
    controller.abort(new Error("cancelled by task"));
    await aborted.promise;
    assert.equal(published, false, "owner cancellation waits for the phase's resource cleanup");
    drain.resolve(); await rejected; await inspector.dispose();
    if (phase === "identity") assert.equal(evaluations, 0);
    await assert.rejects(inspector.inspect(), /closed/);
  });
});

test("dispose aborts an initial identity capture and waits for its cleanup", async t => {
  const root = fixture(t), entered = deferred(), aborted = deferred(), drain = deferred();
  const inspector = new GraphQLChainInspector(root, {
    identity: (_root, signal) => blocked(signal, entered, aborted, drain),
    portableIdentity: fixtureProofIdentity,
    evaluate: async () => { throw new Error("evaluation must not start"); },
  });
  const operation = assert.rejects(inspector.inspect(), { name: "AbortError" });
  await entered.promise;
  let disposed = false;
  const disposal = inspector.dispose().then(() => { disposed = true; });
  await aborted.promise;
  assert.equal(disposed, false);
  drain.resolve(); await Promise.all([operation, disposal]);
  assert.equal(disposed, true);
});

test("already cancelled owner starts no inspection", async t => {
  const root = fixture(t), controller = new AbortController(); controller.abort(new Error("cancelled before start"));
  const inspector = new GraphQLChainInspector(root, { signal: controller.signal, portableIdentity: fixtureProofIdentity, identity: async () => { throw new Error("identity must not start"); }, evaluate: async () => { throw new Error("these inspections must not evaluate"); } });
  await assert.rejects(inspector.inspect(), /cancelled before start/);
  await inspector.dispose();
});

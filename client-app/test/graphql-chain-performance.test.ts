import { fixtureProofIdentity, fixtureDecisionsFor, fixtureReviewDecisions } from "./support/chain-verification";
import assert from "./support/assert";
import { afterEach, mock, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GraphQLChainService, PRISMA_FILE, type ChainObservation } from "../server/graphql-chain/service";
import { writeEvidenceCache } from "../server/graphql-chain/evidence-cache";
import { fingerprint } from "aws-studio/contract-chain/core";
import { withSourceWrite } from "aws-studio/source/source-gate";
import { EventEmitter } from "node:events";
import type { ChainInspectionHost } from "../server/graphql-chain/service";
import { unavailableVerification } from "aws-studio/contract-chain/confidence";
import { graphqlChainFixture } from "./support/graphql-chain";
import { putRuntimeArtifacts } from "./support/chain-verification";
import { DependencyObservationChangedError } from "aws-studio/contract-chain/dependencies";
import { ChainInspectionError, inspectionFailure } from "aws-studio/contract-chain/inspection-diagnostics";
import { GraphQLChainInspector } from "aws-studio/contract-chain/inspector";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-chain-performance-"))); roots.push(root);
  putRuntimeArtifacts(root);
  const file = path.join(root, PRISMA_FILE); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "// use prisma-8\nmodel Project {\n id Uuid @id\n}\n");
  const sdl = "type Query { value: String }";
  const inspector = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, identity: async () => fingerprint("fixture"), evaluate: async () => ({ verification: graphqlChainFixture().verification, contract: { storageHash: "storage", executionHash: "execution" }, sdl, generatedSdl: sdl, schemaDiagnostics: [], generatedDiagnostics: [], documentDiagnostics: [], documents: [], documentSet: "matches", codegen: { status: "current", files: [], diagnostics: [] } }) });
  const observation = await inspector.inspect(); await inspector.dispose();
  return { root, observation };
}
function deferred() {
  let resolve!: (value: ChainObservation) => void;
  const promise = new Promise<ChainObservation>(done => { resolve = done; });
  return { promise, resolve };
}

class InspectionHostFixture extends EventEmitter {
  exitCode: number | null = null;
  readonly requests: { id: number }[] = [];
  send(value: { id: number }, callback?: (error: Error | null) => void) { this.requests.push(value); callback?.(null); return true; }
  kill() { this.exitCode = 0; this.emit("exit", 0); return true; }
  result(observation: ChainObservation, generation: number, retained: readonly string[] = []) { this.emit("message", { type: "result", id: this.requests.at(-1)!.id, observation, generation, observed: true, retained }); }
  invalidated(generation: number) { this.emit("message", { type: "invalidated", generation }); }
  dependencyChanged(restartOnDependencyChange = true) {
    const diagnostic = inspectionFailure(new DependencyObservationChangedError("Private dependency failure detail"));
    this.emit("message", { type: "failed", id: this.requests.at(-1)!.id, diagnostic, restartOnDependencyChange });
  }
}

test("an unsupported Node process reports its version before starting source capture", async () => {
  const { root } = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  Object.defineProperty(process.versions, "node", { ...descriptor, value: "26.0.0" });
  const identity = mock.fn(async () => fingerprint("unreachable"));
  const inspector = new GraphQLChainInspector(root, { identity, evaluate: async () => { throw new Error("these inspections must not evaluate"); } });
  try {
    await assert.rejects(inspector.inspect(true), error => {
      const diagnostic = inspectionFailure(error);
      assert.equal(diagnostic.code, "CONTRACT_NODE_UNSUPPORTED");
      assert.match(diagnostic.message, /24\.22\.2.*Node 26\.0\.0/);
      return true;
    });
    assert.equal(identity.mock.callCount(), 0);
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
    await inspector.dispose();
  }
});

test("a source capture error keeps its public diagnostic without exposing a private failure", async () => {
  const { root } = await fixture();
  const inspector = new GraphQLChainInspector(root, { portableIdentity: fixtureProofIdentity, identity: async () => { throw new Error("Private fixture failure"); }, evaluate: async () => { throw new Error("these inspections must not evaluate"); } });
  try {
    await assert.rejects(inspector.inspect(true), error => {
      assert.ok(error instanceof ChainInspectionError);
      assert.equal(error.status, 422);
      const diagnostic = inspectionFailure(error);
      assert.equal(diagnostic.code, "SAVED_SOURCE_CAPTURE_FAILED");
      assert.match(diagnostic.message, /capture the saved source and dependency inputs/);
      assert.doesNotMatch(diagnostic.message, /Private fixture failure/);
      return true;
    });
  } finally { await inspector.dispose(); }
});

test("watch notifications covered by an in-flight result keep polling and accept the verified generation", async () => {
  const { root, observation } = await fixture(), host = new InspectionHostFixture();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    assert.equal((await service.read(true)).fingerprints, "checking");
    const pending = service.inspect();
    host.invalidated(1);
    assert.equal((await service.read()).inspection?.status, "checking");
    host.result(observation, 1); await pending;
    const published = await service.read();
    assert.equal(published.inspection?.status, "ready");
    assert.equal(published.fingerprints, "ready");
    assert.deepEqual(published.nodes, observation.chain.nodes);
  } finally { await service.dispose(); }
});

test("a newer dependency generation retries a full check in a fresh host and keeps source progress visible", async () => {
  const { root, observation } = await fixture(), first = new InspectionHostFixture(), retry = new InspectionHostFixture();
  const hosts = [first, retry];
  const service = new GraphQLChainService(root, { createHost: () => hosts.shift()! as unknown as ChainInspectionHost });
  try {
    await service.read(true);
    const pending = service.inspect();
    first.invalidated(1);
    first.dependencyChanged();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(first.exitCode, 0);
    assert.equal(retry.requests.length, 1);
    retry.emit("message", { type: "progress", id: retry.requests.at(-1)!.id, phase: "source" });
    first.result(observation, 1);
    const checking = (await service.read()).inspection;
    assert.equal(checking?.status, "checking");
    assert.match(checking?.message ?? "", /Retrying.*Capturing source and dependency identities/);
    retry.result(observation, 0);
    await pending;
    assert.equal((await service.read()).inspection?.status, "ready");
  } finally { await service.dispose(); }
});

test("dependency failures expose curated guidance and only retry a full check once", async () => {
  const { root } = await fixture(), first = new InspectionHostFixture(), retry = new InspectionHostFixture();
  let created = 0;
  const service = new GraphQLChainService(root, { createHost: () => [first, retry][created++]! as unknown as ChainInspectionHost });
  try {
    await service.read();
    const assertDependencyFailure = (error: unknown) => error instanceof ChainInspectionError && error.diagnostic.code === "DEPENDENCIES_CHANGED_DURING_CHECK"
      && /installation or build activity/.test(error.message) && !/Private dependency failure detail/.test(error.message);
    const sameGeneration = service.inspect(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    first.dependencyChanged(false);
    await assert.rejects(sameGeneration, assertDependencyFailure);
    const revalidate = service.revalidate();
    await new Promise<void>(resolve => setImmediate(resolve));
    first.dependencyChanged();
    await assert.rejects(revalidate, assertDependencyFailure);
    assert.equal(created, 1);
    const fullCheck = service.inspect(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    first.dependencyChanged();
    await new Promise<void>(resolve => setImmediate(resolve));
    retry.dependencyChanged();
    await assert.rejects(fullCheck, assertDependencyFailure);
    assert.equal(created, 2);
    assert.equal((await service.read()).inspection?.status, "failed");
  } finally { await service.dispose(); }
});

test("a delayed notification already covered by the result cannot stale correct review evidence", async () => {
  const { root, observation } = await fixture(), host = new InspectionHostFixture();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    await service.read(true); const pending = service.inspect(); host.result(observation, 1); await pending;
    host.invalidated(1);
    assert.equal((await service.read()).inspection?.status, "ready");
    assert.equal((await service.read()).links[1].state.status, "current");
  } finally { await service.dispose(); }
});

test("a newer watch notification still removes green evidence and waits for an explicit check", async () => {
  const { root, observation } = await fixture(), host = new InspectionHostFixture();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    await service.read(true); const pending = service.inspect(); host.result(observation, 1); await pending;
    host.invalidated(2);
    const stale = await service.read();
    assert.equal(stale.inspection?.status, "stale");
    assert.ok(stale.links.every(link => link.state.status === "unknown" && !link.actions.length));
    assert.ok(stale.proof.stages.every(stage => stage.recorded === null), "a prior unapproved check cannot become recorded evidence when source goes stale");
    assert.ok(stale.nodes.every(node => node.reviewedAgainst === null));
    await service.read(true);
    const checking = await service.read();
    assert.equal(checking.inspection?.status, "checking");
    assert.ok(checking.proof.stages.every(stage => stage.recorded === null));
    assert.ok(checking.nodes.every(node => node.reviewedAgainst === null));
    const pendingCheck = service.inspect();
    host.result(observation, 2); await pendingCheck;
    assert.equal(host.requests.length, 2);
  } finally { await service.dispose(); }
});

test("losing the watcher immediately removes previously verified green evidence", async () => {
  const { root, observation } = await fixture(), host = new InspectionHostFixture();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    await service.read(true); const pending = service.inspect(); host.result(observation, 1); await pending;
    assert.equal((await service.read()).inspection?.status, "ready");
    host.emit("message", { type: "watch-unavailable" });
    const unavailable = await service.read();
    assert.equal(unavailable.inspection?.status, "failed");
    assert.match(unavailable.inspection?.message ?? "", /Source watching is unavailable/);
    assert.ok(unavailable.links.every(link => link.state.status === "unknown" && !link.actions.length));
    assert.ok(unavailable.nodes.every(node => node.fingerprint.status === "unavailable"));
    assert.equal(host.requests.length, 1, "watch failure never starts automatic work");
  } finally { await service.dispose(); }
});

test("older results are refused and a replacement host resets watch generations without accepting old callbacks", async () => {
  const { root, observation } = await fixture(), oldHost = new InspectionHostFixture(), newHost = new InspectionHostFixture(); let launches = 0;
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => (launches++ ? newHost : oldHost) as unknown as ChainInspectionHost });
  try {
    await service.read(true); const pending = service.inspect(); oldHost.invalidated(2); oldHost.result(observation, 1);
    await assert.rejects(pending, /inspection failed/);
    assert.ok((await service.read()).links.every(link => link.state.status === "unknown"));
    oldHost.kill();
    await service.read(true); const replacement = service.inspect();
    oldHost.invalidated(999); oldHost.emit("error", new Error("late old-host callback"));
    newHost.result(observation, 0); await replacement;
    assert.equal((await service.read()).inspection?.status, "ready");
  } finally { await service.dispose(); }
});

test("ordinary cold/focus/stale reads never start inspection, and explicit checks return before evidence", async () => {
  const { root, observation } = await fixture(), work = deferred(); let calls = 0;
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, background: () => { calls++; return work.promise; } });
  try {
    const began = performance.now();
    for (let at = 0; at < 10; at++) {
      const chain = await service.read();
      assert.equal(chain.inspection?.status, "stale");
      assert.ok(chain.links.every(link => link.state.status === "unknown" && link.actions.length === 0));
    }
    assert.equal(calls, 0);
    assert.ok(performance.now() - began < 500, "normal page reads have no deep-work dependency");
    const checking = await service.read(true);
    assert.equal(checking.inspection?.status, "checking"); assert.equal(calls, 1);
    await service.read(true); await service.read(); assert.equal(calls, 1, "repeated checks join one task");
    let heartbeat = false;
    await new Promise<void>(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 5));
    assert.equal(heartbeat, true, "the Studio event loop runs while inspection is pending");
    work.resolve(observation); await service.inspect();
    assert.equal((await service.read()).inspection?.status, "ready");
    assert.equal((await service.read()).links[1].state.status, "current");
    assert.equal(calls, 1);
    service.invalidate();
    const stale = await service.read();
    assert.equal(stale.inspection?.status, "stale");
    assert.ok(stale.links.every(link => link.state.status === "unknown"));
    assert.equal(calls, 1, "source invalidation waits for an explicit check");
  } finally { work.resolve(observation); await service.dispose(); }
});

test("durable evidence restores only provisional Unknown states and never starts work on page load", async () => {
  const { root, observation } = await fixture();
  await writeEvidenceCache(root, observation, "2026-11-11T12:00:00.000Z");
  let calls = 0;
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, background: async () => { calls++; return observation; } });
  try {
    const restored = await service.read();
    assert.equal(restored.inspection?.status, "stale");
    assert.equal(restored.inspection?.checkedAt, "2026-11-11T12:00:00.000Z");
    assert.ok(restored.nodes.every(node => node.fingerprint.status === "unavailable"));
    assert.ok(restored.links.every(link => link.state.status === "unknown" && link.actions.length === 0));
    assert.equal(calls, 0);
  } finally { await service.dispose(); }
});

test("late evidence after source invalidation cannot publish Current", async () => {
  const { root, observation } = await fixture(), work = deferred();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, background: () => work.promise });
  try {
    await service.read(true); service.invalidate(); work.resolve(observation);
    await assert.rejects(service.inspect(), /Source changed|Saved source changed/);
    assert.ok((await service.read()).links.every(link => link.state.status === "unknown"));
  } finally { work.resolve(observation); await service.dispose(); }
});

test("apply revalidation never evaluates source under the write lease, including checked Unknown evidence", async () => {
  const { root } = await fixture(); let identity = "initial", calls = 0;
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, identity: async () => fingerprint(identity), evaluate: async () => {
    calls++;
    const diagnostics = [{ code: "SANDBOX_UNAVAILABLE", message: "Fixture sandbox unavailable" }];
    return { verification: unavailableVerification(diagnostics), contract: null, sdl: null, generatedSdl: null, schemaDiagnostics: diagnostics, generatedDiagnostics: diagnostics, documentDiagnostics: diagnostics, documentSet: "unknown", documents: [], codegen: { status: "unknown", files: [], diagnostics } };
  } });
  try {
    await service.inspect(); assert.equal(calls, 1);
    await withSourceWrite(root, async () => { const current = await service.revalidate(); assert.equal(current.chain.links[1].state.status, "unknown"); });
    assert.equal(calls, 1);
    identity = "changed";
    await withSourceWrite(root, async () => { await assert.rejects(service.revalidate(), /Source changed/); });
    assert.equal(calls, 1, "changed source is refused before any native execution");
  } finally { await service.dispose(); }
});

test("historical source evidence remains inspectable but has no current confidence or acceptance actions", async () => {
  const { root, observation } = await fixture();
  await writeEvidenceCache(root, observation, "2026-11-11T12:00:00.000Z");
  const background = mock.fn(async () => observation);
  const service = new GraphQLChainService(root, { background });
  try {
    const restored = await service.read();
    assert.equal(background.mock.callCount(), 0);
    assert.equal(restored.history?.revision, observation.chain.revision);
    assert.deepEqual(restored.history?.nodes, observation.chain.nodes);
    assert.equal(restored.history?.links[1]?.state.status, "current");
    assert.ok(restored.history?.links.every(link => !link.actions.length));
    assert.ok(restored.links.every(link => link.confidence.status !== "verified" && !link.actions.length));
    assert.ok(Object.values(restored.verification).every(check => check.status === "unavailable"));
  } finally { await service.dispose(); }
});

test("typed inspection failures survive IPC without falling back to an undiagnosed stale result", async () => {
  const { root } = await fixture(), host = new InspectionHostFixture();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    await service.read(true); const pending = service.inspect();
    host.emit("message", { type: "failed", id: host.requests.at(-1)!.id, diagnostic: { code: "SOURCE_CHANGED_DURING_CHECK", message: "Saved source changed while checking. Check again." } });
    await assert.rejects(pending, /Saved source changed/);
    const failed = await service.read();
    assert.equal(failed.inspection?.diagnostics?.[0]?.code, "SOURCE_CHANGED_DURING_CHECK");
    assert.match(failed.inspection?.message ?? "", /Saved source changed/);
    assert.ok(failed.links.every(link => link.confidence.status !== "verified"));
  } finally { await service.dispose(); }
});

test("an obsolete child response or malformed diagnostic cannot establish verification", async () => {
  for (const mode of ["old-response", "bad-diagnostic"] as const) {
    const { root, observation } = await fixture(), host = new InspectionHostFixture();
    const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
    try {
      await service.read(true); const pending = service.inspect();
      if (mode === "old-response") host.result({ ...observation, chain: { ...observation.chain, version: 1 } } as unknown as ChainObservation, 0);
      else host.emit("message", { type: "failed", id: host.requests.at(-1)!.id, diagnostic: { code: 123, message: "PRIVATE_UNTRUSTED_DETAIL" } });
      await assert.rejects(pending, /obsolete result/);
      const failed = await service.read();
      assert.equal(failed.inspection?.diagnostics?.[0]?.code, "INSPECTION_RESULT_INVALID");
      assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_UNTRUSTED_DETAIL/);
      assert.ok(failed.links.every(link => link.confidence.status !== "verified"));
    } finally { await service.dispose(); }
  }
});

test("an inspection process exit and timeout retain distinct actionable diagnostics", async t => {
  const { root } = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["exit", "timeout"] as const) {
    const host = new InspectionHostFixture(), service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
    try {
      await service.read(true); const pending = service.inspect();
      if (mode === "exit") host.kill(); else t.mock.timers.tick(20 * 60_000);
      await assert.rejects(pending, mode === "exit" ? /process stopped/ : /timed out/);
      const failed = await service.read();
      assert.equal(failed.inspection?.diagnostics?.[0]?.code, mode === "exit" ? "INSPECTION_PROCESS_EXIT" : "INSPECTION_TIMEOUT");
      assert.ok(failed.links.every(link => link.confidence.status !== "verified"));
    } finally { await service.dispose(); }
  }
});

test("an older cache format cannot restore independent green statuses as current evidence", async () => {
  const { root, observation } = await fixture();
  await writeEvidenceCache(root, observation, "2026-11-11T12:00:00.000Z");
  const file = path.join(root, ".cache/framework-studio/graphql-chain/evidence.json");
  const cache = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...cache, version: 1 }));
  const background = mock.fn(async () => observation);
  const service = new GraphQLChainService(root, { background });
  try {
    const cold = await service.read();
    assert.equal(background.mock.callCount(), 0);
    assert.equal(cold.history, undefined);
    assert.ok(cold.links.every(link => link.confidence.status !== "verified" && !link.actions.length));
  } finally { await service.dispose(); }
});


test("a matching live source lease preserves only unaffected verified stages during rechecking", async () => {
  const f = await fixture(), observation = { ...f.observation, chain: graphqlChainFixture() }, host = new InspectionHostFixture();
  const service = new GraphQLChainService(f.root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    await service.read(true); const first = service.inspect(); host.result(observation, 1, ["database", "api", "codegen", "client"]); await first;
    host.invalidated(2);
    assert.ok((await service.read()).links.every(link => link.confidence.status !== "verified"));
    host.emit("message", { type: "sources", generation: 2, nodes: observation.chain.nodes, basisRevision: observation.chain.revision, retained: ["database", "api", "codegen"] });
    const partial = await service.read();
    assert.deepEqual(partial.links.map(link => link.confidence.status), ["verified", "verified", "stale"]);
    assert.ok(partial.links.every(link => !link.actions.length));
    assert.equal(partial.verification.client.status, "unavailable");
    const { isGraphQLChainResponse } = await import("aws-studio/contract-chain/graphql-chain-response"); assert.equal(isGraphQLChainResponse(partial), true);
    await service.read(true); const next = service.inspect();
    assert.deepEqual((await service.read()).links.map(link => link.confidence.status), ["verified", "verified", "stale"]);
    host.result(observation, 2, ["database", "api", "codegen", "client"]); await next;
    host.emit("message", { type: "watch-unavailable" });
    assert.ok((await service.read()).links.every(link => link.confidence.status !== "verified"));
  } finally { await service.dispose(); }
});

test("an obsolete lease cannot preserve evidence and downstream-only claims require their predecessors", async () => {
  const f = await fixture(), observation = { ...f.observation, chain: graphqlChainFixture() }, host = new InspectionHostFixture();
  const service = new GraphQLChainService(f.root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  try {
    await service.read(true); const first = service.inspect(); host.result(observation, 1, ["database", "api", "codegen", "client"]); await first;
    host.invalidated(2);
    for (const value of [
      { generation: 1, basisRevision: observation.chain.revision, retained: ["database", "api", "codegen", "client"] },
      { generation: 2, basisRevision: "obsolete", retained: ["database", "api", "codegen", "client"] },
      { generation: 2, basisRevision: observation.chain.revision, retained: ["codegen", "client"] },
    ]) { host.emit("message", { type: "sources", nodes: observation.chain.nodes, ...value }); assert.ok((await service.read()).links.every(link => link.confidence.status !== "verified")); }
  } finally { await service.dispose(); }
});


test("inspection phases belong to the active request and use host-owned elapsed times", async () => {
  const { root, observation } = await fixture(), host = new InspectionHostFixture();
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => host as unknown as ChainInspectionHost });
  let now = 1000; const clock = mock.method(Date, "now", () => now);
  try {
    await service.read(true); const pending = service.inspect(), id = host.requests.at(-1)!.id;
    now += 60_000;
    host.emit("message", { type: "progress", id: id + 1, phase: "proof" });
    host.emit("message", { type: "progress", id, phase: "constructor" });
    assert.match((await service.read()).inspection?.message ?? "", /Starting.*1m 0s elapsed/);
    host.emit("message", { type: "progress", id, phase: "proof", startedAt: 0 });
    now += 2000;
    host.emit("message", { type: "progress", id, phase: "proof" });
    assert.equal((await service.read()).inspection?.message, "Hashing portable proof inputs · 1m 2s elapsed · 2s in this phase.");
    host.result(observation, 0); await pending;
    host.emit("message", { type: "progress", id, phase: "checks" });
    assert.equal((await service.read()).inspection?.message, undefined);
    service.invalidate();
    assert.doesNotMatch((await service.read()).inspection?.message ?? "", /elapsed|Hashing/);
  } finally { clock.mock.restore(); await service.dispose(); }
});

test("failed or stopped inspections discard phases and reject late old-host progress", async () => {
  const { root, observation } = await fixture(), oldHost = new InspectionHostFixture(), newHost = new InspectionHostFixture(); let launches = 0;
  const service = new GraphQLChainService(root, { portableIdentity: fixtureProofIdentity, createHost: () => (launches++ ? newHost : oldHost) as unknown as ChainInspectionHost });
  try {
    await service.read(true); const failed = service.inspect(), id = oldHost.requests.at(-1)!.id;
    oldHost.emit("message", { type: "progress", id, phase: "proof" });
    oldHost.emit("message", { type: "failed", id, diagnostic: { code: "CHECK_FAILED", message: "Inspection failed." } });
    await assert.rejects(failed); assert.equal((await service.read()).inspection?.message, "Inspection failed.");
    oldHost.kill();
    await service.read(true); const pending = service.inspect(), next = newHost.requests.at(-1)!.id;
    oldHost.emit("message", { type: "progress", id: next, phase: "proof" });
    assert.match((await service.read()).inspection?.message ?? "", /Starting/);
    newHost.result(observation, 0); await pending;
    await service.read(true); const cancelled = service.inspect();
    const rejected = assert.rejects(cancelled, /process stopped/);
    await service.dispose(); await rejected;
  } finally { await service.dispose(); }
});

test("inspector reports phases at actual source, execution, proof and recheck boundaries", async () => {
  const { root, observation } = await fixture(), events: string[] = [];
  const service = new GraphQLChainService(root, {
    onProgress: phase => events.push(phase),
    identity: async () => { events.push("identity"); return fingerprint("fixture"); },
    portableIdentity: async () => { events.push("portable"); return fixtureProofIdentity(root); },
    evaluate: async () => { events.push("evaluate"); return observation.proofInput!.evaluation; },
  });
  try {
    await service.inspect(true);
    assert.deepEqual(events, ["source", "identity", "checks", "evaluate", "recheck", "identity", "proof", "portable", "recheck", "identity"]);
  } finally { await service.dispose(); }
});

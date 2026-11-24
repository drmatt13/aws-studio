import assert from "./support/assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { OperationsClient } from "../server/operations/client";
import { callIpc, closeIpcAuthentication, LOCAL_RUNTIME_CAPABILITY, OperationsError, privateEndpoint, type CoordinatorInfo } from "../server/operations/ipc";
import { identityAlive, inspectProcess } from "aws-studio/source/identity";

const loader = pathToFileURL(require.resolve("tsx")).href;
async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const value = await read(); if (accepts(value)) return value; } catch { /* Await fixture readiness/termination. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Legacy coordinator fixture did not settle.");
}

async function fixture(mode: "idle" | "active" | "uncertain" | "stale-owner" | "foreign" | "unsupported" | "runtime-idle" | "runtime-support" | "runtime-active" | "runtime-uncertain" | "runtime-late-active" | "runtime-draining") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-host-upgrade-"))), state = path.join(root, ".state");
  mkdirSync(state, { mode: 0o700 });
  const endpoint = privateEndpoint(root, state);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "legacy-host-upgrade-fixture", private: true }));
  symlinkSync(path.resolve(__dirname, "../../node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const unavailable = path.join(root, "unavailable.mjs");
  writeFileSync(unavailable, "process.exit(127);\n");
  // This fixture never invokes Docker or AWS, including after launching the replacement host.
  const env = { ...process.env, FRAMEWORK_DOCKER_CLI: unavailable, FRAMEWORK_AWS_CLI: unavailable };
  const legacy = spawn(process.execPath, ["--import", loader, path.join(__dirname, "support/legacy-operations-host.ts"), root, state, mode], { env: process.env, stdio: "ignore", windowsHide: true });
  const info = await eventually(() => callIpc<CoordinatorInfo>(endpoint.socket, "/ping", undefined, 1000), value => value.pid === legacy.pid);
  const clients = [new OperationsClient(root, state, env), new OperationsClient(root, state, env)];
  return { root, state, info, clients, env,
    async close() {
      let current: CoordinatorInfo | undefined;
      try { current = await callIpc(endpoint.socket, "/ping", undefined, 1000); } catch { /* Host exited. */ }
      if (current?.pid && current.pid !== process.pid) {
        const identity = inspectProcess(current.pid);
        if (identity) {
          process.kill(current.pid, "SIGTERM");
          await eventually(async () => identityAlive({ ...identity, token: "fixture-cleanup" }), value => value === false);
        }
      }
      if (legacy.exitCode === null && legacy.signalCode === null) {
        legacy.kill("SIGTERM");
        await eventually(async () => legacy.exitCode !== null || legacy.signalCode !== null, Boolean);
      }
      clients.forEach(client => client.close());
      closeIpcAuthentication(endpoint.socket);
      await rm(endpoint.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

const windowsUpgradeRefusal = (error: unknown) => error instanceof OperationsError && error.status === 409 && /cannot be refreshed gracefully on Windows/.test(error.message);
function retainedHostEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const lease = path.join(privateEndpoint(f.root, f.state).directory, "coordinator.sqlite");
  const journal = path.join(f.state, "operations/operations.sqlite");
  const owner = inspectProcess(f.info.pid);
  assert.ok(owner, "the fixture's original native identity is available");
  return { lease, owner, files: [lease, journal, `${journal}-wal`].map(file => ({ file, bytes: existsSync(file) ? readFileSync(file) : undefined })) };
}
async function assertHostPreserved(f: Awaited<ReturnType<typeof fixture>>, evidence: ReturnType<typeof retainedHostEvidence>) {
  assert.equal((await f.clients[0]!.ping()).pid, f.info.pid, "the existing owner remains reachable");
  assert.equal(identityAlive({ ...evidence.owner, token: "fixture-preservation" }), true, "the original native process remains alive");
  for (const { file, bytes } of evidence.files) assert.deepEqual(existsSync(file) ? readFileSync(file) : undefined, bytes, `${path.basename(file)} was not changed`);
  const lease = new DatabaseSync(evidence.lease, { readOnly: true });
  try { assert.equal(lease.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='runtime_upgrades'").get()!.count, 0, "refusal creates no durable signal claim"); }
  finally { lease.close(); }
  assert.equal(existsSync(path.join(f.state, "graceful-close")), false, "no graceful closure is fabricated for the living owner");
}

for (const mode of ["idle", "runtime-idle", "runtime-support"] as const) test(`concurrent local observers preserve graceful handoff requirements for one ${mode} coordinator`, { timeout: 35_000 }, async () => {
  const f = await fixture(mode);
  try {
    assert.equal(f.info.localRuntime, mode === "idle" ? undefined : 1);
    if (process.platform === "win32") {
      const evidence = retainedHostEvidence(f);
      await Promise.all(f.clients.map(client => assert.rejects(client.localStatus(), windowsUpgradeRefusal)));
      await assertHostPreserved(f, evidence);
      return;
    }
    const states = await Promise.all(f.clients.map(client => client.localStatus()));
    assert.ok(states.every(local => !local.watch.running && !local.client.running));
    const current = await Promise.all(f.clients.map(client => client.ping()));
    assert.equal(current[0]!.localRuntime, LOCAL_RUNTIME_CAPABILITY);
    assert.equal(current[0]!.version, f.info.version);
    assert.notEqual(current[0]!.pid, f.info.pid);
    assert.equal(current[0]!.pid, current[1]!.pid);
    assert.deepEqual(await f.clients[0]!.list(), []);
    assert.ok(existsSync(path.join(f.state, "graceful-close")), "the verified old host closes gracefully");
  } finally { await f.close(); }
});

for (const mode of ["active", "uncertain"] as const) test(`legacy host update preserves ${mode} independent work`, { timeout: 25_000 }, async () => {
  const f = await fixture(mode);
  try {
    for (const action of [() => f.clients[0]!.localStatus(), () => f.clients[1]!.localPerform({ kind: "local-stop", params: {} })])
      await assert.rejects(action(), error => error instanceof OperationsError && error.status === 409 && /Finish or reconcile/.test(error.message));
    assert.equal((await f.clients[0]!.ping()).pid, f.info.pid);
    const jobs = await f.clients[0]!.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, mode === "active" ? "running" : "interrupted");
  } finally { await f.close(); }
});

for (const mode of ["runtime-active", "runtime-uncertain", "runtime-late-active"] as const) test(`runtime capability update preserves ${mode} local work`, { timeout: 25_000 }, async () => {
  const f = await fixture(mode);
  try {
    for (const action of [() => f.clients[0]!.localStatus(), () => f.clients[1]!.localPerform({ kind: "local-start", params: {} })])
      await assert.rejects(action(), error => error instanceof OperationsError && error.status === 409 && /Finish or reconcile/.test(error.message));
    assert.equal((await f.clients[0]!.ping()).pid, f.info.pid);
    if (mode === "runtime-late-active") assert.ok(existsSync(path.join(f.state, "jobs", "fixture-local-start.json")), "startup accepted after the first observation is checked again from its journal");
    else assert.equal((await f.clients[0]!.list())[0]!.kind, "local-start");
    assert.equal(existsSync(path.join(f.state, "graceful-close")), false, "the active runtime host is never signalled");
  } finally { await f.close(); }
});

test("a capability-1 runtime can still stop an active startup before a guarded host update", { timeout: 25_000 }, async () => {
  const f = await fixture("runtime-active");
  try {
    const stopped = await f.clients[0]!.localPerform({ kind: "local-stop", params: {} });
    assert.equal(stopped.kind, "local-stop");
    assert.equal(stopped.status, "succeeded");
    assert.equal((await f.clients[0]!.ping()).pid, f.info.pid, "stop reaches the existing owner");
    if (process.platform === "win32") {
      const evidence = retainedHostEvidence(f);
      await assert.rejects(f.clients[0]!.localStatus(), windowsUpgradeRefusal);
      await assertHostPreserved(f, evidence);
    } else {
      await f.clients[0]!.localStatus();
      assert.notEqual((await f.clients[0]!.ping()).pid, f.info.pid, "the now-idle owner can upgrade afterward");
    }
  } finally { await f.close(); }
});

test("separate Studio processes preserve a draining runtime host's graceful handoff requirements", { timeout: 35_000 }, async () => {
  const f = await fixture("runtime-draining");
  const evidence = retainedHostEvidence(f);
  const go = path.join(f.root, "observers-go");
  const observers = [0, 1].map(index => {
    const ready = path.join(f.root, `observer-${index}-ready`);
    const child = spawn(process.execPath, ["--import", loader, path.join(__dirname, "support/runtime-upgrade-observer.ts"), f.root, f.state, ready, go], { env: f.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    const result = new Promise<{ info: CoordinatorInfo; refusal?: { status: number; message: string } }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) return reject(new Error(`Observer exited ${code}: ${errors}`));
        try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
      });
    });
    return { child, ready, result };
  });
  try {
    await Promise.race([eventually(async () => observers.every(observer => existsSync(observer.ready)), Boolean),
      ...observers.map(observer => observer.result.then(() => { throw new Error("Observer exited before the start signal."); }))]);
    writeFileSync(go, "go\n");
    const results = await Promise.all(observers.map(observer => observer.result));
    if (process.platform === "win32") {
      for (const result of results) {
        assert.equal(result.info.pid, f.info.pid);
        assert.equal(result.refusal?.status, 409);
        assert.match(result.refusal?.message ?? "", /cannot be refreshed gracefully on Windows/);
      }
      await assertHostPreserved(f, evidence);
      return;
    }
    assert.ok(results.every(result => result.refusal === undefined));
    const current = results.map(result => result.info);
    assert.equal(current[0]!.pid, current[1]!.pid);
    assert.notEqual(current[0]!.pid, f.info.pid);
    assert.ok(current.every(info => info.localRuntime === LOCAL_RUNTIME_CAPABILITY));
    assert.ok(existsSync(path.join(f.state, "graceful-close")), "the old host finishes draining instead of dying from a second SIGTERM");
  } finally {
    for (const observer of observers) if (observer.child.exitCode === null && observer.child.signalCode === null) observer.child.kill("SIGTERM");
    await f.close();
  }
});

for (const mode of ["stale-owner", "foreign", "unsupported"] as const) test(`legacy host update refuses ${mode} identity evidence`, { timeout: 25_000 }, async () => {
  const f = await fixture(mode);
  try {
    await assert.rejects(f.clients[0]!.localStatus(), error => error instanceof OperationsError && error.status === 409);
    assert.equal((await callIpc<CoordinatorInfo>(privateEndpoint(f.root, f.state).socket, "/ping")).pid, f.info.pid);
  } finally { await f.close(); }
});

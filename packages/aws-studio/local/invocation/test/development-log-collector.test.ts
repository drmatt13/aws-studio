import { testProjectRoot } from "../../../../../scripts/test-project";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { ensurePrivateDirectory } from "../../../cli/private-files";
import { defineFrameworkConfig } from "aws-studio/config";
import { DevelopmentLogReader } from "aws-studio/local/development-logs";
import type { DevelopmentLogControl } from "aws-studio/development-logs";
import { defaults } from "../../../../../scripts/test-project-declarations";
import { startDevelopmentLogCollector } from "../src/development-logs/collector";

const config = defineFrameworkConfig({
  defaults,
  http: [],
  webSocket: [],
  services: [],
  events: [{ probe: { subnet: "none" } }],
});
const producerId = "22222222-2222-4222-8222-222222222222";
const entry = (
  sequence: number,
  observation: Record<string, unknown> = {},
  instanceId = producerId,
) => ({
  eventId: `${instanceId}:${sequence}`,
  producer: { component: "fixture", instanceId },
  observation: {
    resourceId: "lambda:probe",
    kind: "fixture.observation",
    message: `visible fixture event ${sequence}`,
    ...observation,
  },
});
// The native Windows writer checks ACLs while publishing each durable batch.
const persistenceTimeoutMs = process.platform === "win32" ? 60_000 : 30_000;

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    path.join(realpathSync(tmpdir()), "development-collector-"),
  );
  ensurePrivateDirectory(root);
  const cache = path.join(root, "cache"),
    descriptor = path.join(root, "control.json");
  await mkdir(cache, { mode: 0o700 });
  const names = [
    "FRAMEWORK_DEVELOPMENT_LOGS",
    "FRAMEWORK_DEVELOPMENT_LOG_CONTROL",
    "FRAMEWORK_DEVELOPMENT_LOG_DIRECTORY",
    "FRAMEWORK_DEVELOPMENT_LOG_SESSION",
  ] as const;
  const before = new Map(names.map((name) => [name, process.env[name]]));
  process.env.FRAMEWORK_DEVELOPMENT_LOGS = "1";
  process.env.FRAMEWORK_DEVELOPMENT_LOG_CONTROL = descriptor;
  process.env.FRAMEWORK_DEVELOPMENT_LOG_DIRECTORY = cache;
  const control: DevelopmentLogControl = {
    version: 1,
    repositoryKey: "collector-repository",
    composeProject: "collector-project",
    runtimeSessionId: randomUUID(),
    bindingId: "original-binding",
    declarationDigest: "original-source",
    endpoint: "http://127.0.0.1:8090",
    token: "b".repeat(64),
    startedAt: new Date().toISOString(),
    binding: {
      deployment: "collector-dev",
      account: "123456789012",
      region: "us-east-1",
    },
  };
  const instances: { close(): Promise<void> }[] = [];
  const reader = new DevelopmentLogReader(cache);
  const start = async (waitForPersistence = true) => {
    await writeFile(descriptor, JSON.stringify(control), { mode: 0o600 });
    const app = express();
    app.use(express.json({ limit: 256 * 1024 }));
    const collector = await startDevelopmentLogCollector({
      app,
      repositoryRoot: testProjectRoot,
      projectName: control.composeProject,
      config,
      followOutput: false,
    });
    app.use(
      (
        error: { status?: number },
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => {
        response
          .status(error.status === 413 ? 413 : 400)
          .json({ error: "Invalid fixture payload" });
      },
    );
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let closed = false;
    let observedReady = false;
    const instance = {
      async flush(signal: AbortSignal) {
        await collector.flush(signal);
        observedReady = true;
      },
      async post(body: unknown, headers: Record<string, string> = {}, awaitPersistence = true) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/development-logs/batch`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${control.token}`,
              ...headers,
            },
            body: JSON.stringify(body),
          },
        );
        const result = {
          status: response.status,
          data: (await response.json()) as Record<string, unknown>,
        };
        if (waitForPersistence && awaitPersistence && response.status === 202)
          await collector.flush(AbortSignal.timeout(persistenceTimeoutMs));
        return result;
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await collector.close(observedReady ? { signal: AbortSignal.timeout(persistenceTimeoutMs) } : undefined);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    };
    instances.push(instance);
    if (!waitForPersistence) return instance;
    // Real IPC readiness/commit acknowledgements establish evidence. The guard
    // bounds each native operation; it is not a sleep or a persistence claim.
    await collector.flush(AbortSignal.timeout(persistenceTimeoutMs));
    observedReady = true;
    return instance;
  };
  t.after(async () => {
    const results = await Promise.allSettled(instances.map((instance) => instance.close()));
    for (const name of names) {
      const value = before.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Collector fixture cleanup failed");
  });
  const body = (entries: unknown[]) => ({
    version: 1,
    runtimeSessionId: control.runtimeSessionId,
    repositoryKey: control.repositoryKey,
    composeProject: control.composeProject,
    entries,
  });
  return { start, control, reader, body, cache };
}

test("collector refuses a shared cache before starting a writer", async (t) => {
  const f = await fixture(t);
  if (process.platform === "win32") {
    const encoded = Buffer.from(f.cache).toString("base64");
    const result = spawnSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; $directory=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $acl=[IO.Directory]::GetAccessControl($directory); $everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($directory,$acl)`],
      { windowsHide: true, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
  } else await chmod(f.cache, 0o755);
  const runtime = await f.start(false);
  await assert.rejects(runtime.flush(AbortSignal.timeout(30_000)), /persistence is unavailable/);
  const result = await runtime.post(f.body([entry(1)]));
  assert.equal(result.status, 202, "application observations stay non-blocking");
  assert.equal(result.data.persistent, false);
  await runtime.close();
  assert.deepEqual(await readdir(f.cache), [], "refusal must not create or repair cache state");
});

test("collector persistence observation rejects an actual writer initialization failure and preserves the blocker", async (t) => {
  const f = await fixture(t), blocker = path.join(f.cache, "writer.sqlite");
  await mkdir(blocker);
  await writeFile(path.join(blocker, "preserve.txt"), "fixture-owned blocker");
  await assert.rejects(f.start(), /persistence is unavailable/);
  assert.equal(await readFile(path.join(blocker, "preserve.txt"), "utf8"), "fixture-owned blocker");
});

test("aborting a pending persistence observation does not manufacture completion or cancel its writer", async (t) => {
  const f = await fixture(t), runtime = await f.start(false);
  const controller = new AbortController();
  const pending = runtime.flush(controller.signal);
  queueMicrotask(() => controller.abort("cancelled fixture observation"));
  await assert.rejects(pending, /observation aborted/);
  await runtime.flush(AbortSignal.timeout(30_000));
  await runtime.close();
  assert.equal((await f.reader.runs())[0]?.status, "stopped");
});

test("collector rejects capability/origin/binding and malformed typed records without partial acceptance", async (t) => {
  const f = await fixture(t),
    runtime = await f.start();
  await assert.rejects(runtime.flush(AbortSignal.abort("cancelled fixture observation")), /observation aborted/);
  const good = f.body([entry(1)]);
  assert.equal((await runtime.post(good, { authorization: "" })).status, 401);
  assert.equal(
    (await runtime.post(good, { authorization: `Bearer ${"c".repeat(64)}` }))
      .status,
    401,
  );
  assert.equal(
    (await runtime.post(good, { origin: "http://localhost:3000" })).status,
    401,
  );
  assert.equal((await runtime.post(good, { origin: "" })).status, 401);
  for (const change of [
    { repositoryKey: "another-repository" },
    { composeProject: "another-project" },
    { runtimeSessionId: randomUUID() },
  ])
    assert.equal((await runtime.post({ ...good, ...change })).status, 409);
  for (const change of [
    { relatedResourceIds: 7 },
    { phase: {} },
    { outcome: false },
    { attribution: "administrator" },
    { level: "notice" },
    { stream: "file" },
    { correlation: { invocationId: 7 } },
    { message: {} },
    { durationMs: -1 },
    { occurredAt: "invalid" },
    { omissions: [{}] },
  ])
    assert.equal(
      (await runtime.post(f.body([entry(1, change)]))).status,
      400,
      JSON.stringify(change),
    );
  assert.equal((await runtime.post({ ...good, entries: {} })).status, 400);
  assert.equal(
    (
      await runtime.post(
        f.body([
          {
            ...entry(1),
            producer: { component: "fixture", instanceId: "spoofed-instance" },
          },
        ]),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await runtime.post(
        f.body([entry(1, { resourceId: "lambda:undeclared" })]),
      )
    ).status,
    400,
  );
  assert.equal(
    (await runtime.post(f.body([entry(100), entry(101, { outcome: {} })])))
      .status,
    400,
  );
  assert.equal(
    (
      await runtime.post(
        f.body(Array.from({ length: 33 }, (_, index) => entry(index + 1))),
      )
    ).status,
    413,
  );
  assert.equal(
    (await runtime.post({ ...good, padding: "x".repeat(300 * 1024) })).status,
    413,
  );
  const accepted = entry(2, {
    message: "useful failure token=TOKEN_CANARY",
    details: { useful: "actual execution failure", echo: f.control.token },
    source: "production",
    runtimeSessionId: "spoofed-run",
    futurePrivateField: "RAW_PRIVATE_CANARY",
  });
  assert.equal(
    (
      await runtime.post({
        ...f.body([accepted]),
        bindingId: "spoofed-binding",
      })
    ).status,
    202,
  );
  await runtime.close();
  const page = await f.reader.entries({
    resourceIds: ["lambda:probe"],
    runId: f.control.runtimeSessionId,
  });
  assert.deepEqual(
    page.entries.map((value) => value.eventId),
    [`${producerId}:2`],
    "an invalid batch must not accept its valid prefix",
  );
  assert.equal(page.entries[0]!.source, "development");
  assert.equal(page.entries[0]!.runtimeSessionId, f.control.runtimeSessionId);
  assert.equal(page.entries[0]!.bindingId, f.control.bindingId);
  const serialized = JSON.stringify(page);
  assert.ok(serialized.includes("actual execution failure"));
  for (const canary of [
    "TOKEN_CANARY",
    f.control.token,
    "RAW_PRIVATE_CANARY",
    "spoofed-binding",
    "spoofed-run",
  ])
    assert.ok(!serialized.includes(canary), canary);
});

test("collector cache survives writer restart and deduplicates a producer sequence already committed", async (t) => {
  const f = await fixture(t),
    first = await f.start();
  for (let offset = 0; offset < 100; offset += 32)
    assert.equal(
      (
        await first.post(
          f.body(
            Array.from({ length: Math.min(32, 100 - offset) }, (_, index) =>
              entry(offset + index + 1),
            ),
          ),
        )
      ).status,
      202,
    );
  await first.close();
  const initial = await f.reader.entries({
    resourceIds: ["lambda:probe"],
    runId: f.control.runtimeSessionId,
    limit: 200,
  });
  assert.equal(initial.entries.length, 100);
  assert.equal(initial.run?.status, "stopped");
  const second = await f.start();
  assert.equal((await second.post(f.body([entry(1), entry(101)]))).status, 202);
  await second.close();
  const restarted = await f.reader.entries({
    resourceIds: ["lambda:probe"],
    runId: f.control.runtimeSessionId,
    limit: 200,
  });
  assert.equal(restarted.entries.length, 101);
  assert.equal(
    new Set(restarted.entries.map((value) => value.eventId)).size,
    101,
  );
  assert.ok(restarted.gaps.some((gap) => gap.reason === "restart"));
  assert.ok(
    restarted.entries.every(
      (value) =>
        value.bindingId === "original-binding" &&
        value.declarationDigest === "original-source",
    ),
  );
});

test("collector enforces independent producer and aggregate rate budgets with visible loss markers", async (t) => {
  const f = await fixture(t),
    runtime = await f.start();
  const stamp = Date.now();
  t.mock.method(Date, "now", () => stamp);
  // Rate authority counts transport deliveries, including retries, before
  // persistence deduplication. Keep that independent of disk throughput.
  for (let offset = 0; offset < 200; offset += 32)
    assert.equal(
      (
        await runtime.post(
          f.body(
            Array.from({ length: Math.min(32, 200 - offset) }, () =>
              entry(1),
            ),
          ),
          {}, false,
        )
      ).status,
      202,
    );
  assert.equal(
    (await runtime.post(f.body([entry(201)]))).status,
    429,
    "retries consume the producer budget before deduplication",
  );
  const aggregateProducers = Array.from({ length: 10 }, () => randomUUID());
  for (let offset = 0; offset < 1800; offset += 32) {
    const instanceId = aggregateProducers[Math.floor(offset / 192)]!;
    assert.equal(
      (
        await runtime.post(
          f.body(
            Array.from({ length: Math.min(32, 1800 - offset) }, () =>
              entry(1, {}, instanceId),
            ),
          ),
          {}, false,
        )
      ).status,
      202,
    );
  }
  assert.equal(
    (await runtime.post(f.body([entry(1, {}, randomUUID())]))).status,
    429,
    "2,000 accepted deliveries exhaust the aggregate budget even when they are retries",
  );
  t.mock.restoreAll();
  await runtime.flush(AbortSignal.timeout(30_000));
  await runtime.close();
  const run = (await f.reader.runs()).find(
    (value) => value.runtimeSessionId === f.control.runtimeSessionId,
  );
  assert.ok(run && run.dropped >= 2);
  assert.ok(run.gaps.some((gap) => gap.reason === "dropped"));
  const page = await f.reader.entries({ resourceIds: ["lambda:probe"], runId: f.control.runtimeSessionId });
  assert.equal(page.entries.length, 11, "transport budgets and persisted sequence deduplication are independent");
});

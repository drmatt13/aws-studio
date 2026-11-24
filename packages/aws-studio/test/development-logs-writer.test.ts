import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DevelopmentLogReader,
  DevelopmentLogStore,
} from "../src/local/development-logs/store";
import { sanitizeDevelopmentObservation } from "../src/development-logs/context";
import type { DevelopmentLogControl } from "../src/development-logs/contract";
import { CombinedDevelopmentLogReader } from "../src/local/development-logs/combined-reader";
import { ensurePrivateDirectory } from "../cli/private-files";

const producer = randomUUID();
const control = (time = Date.now()): DevelopmentLogControl => ({
  version: 1,
  runtimeSessionId: randomUUID(),
  repositoryKey: "writer-fixture",
  composeProject: "writer-fixture",
  bindingId: "fixture-binding",
  declarationDigest: "fixture-declarations",
  startedAt: new Date(time).toISOString(),
  token: "a".repeat(64),
  endpoint: "http://127.0.0.1:8090",
  binding: { deployment: "fixture-dev" },
});
const entry = (sequence: number) => ({
  eventId: `${producer}:${sequence}`,
  producer: { component: "fixture", instanceId: producer },
  observation: sanitizeDevelopmentObservation({
    resourceId: "lambda:fixture",
    kind: "invocation.started",
    message: `Fixture invocation ${sequence}`,
  }),
});
const temporary = () =>
  mkdtemp(path.join(realpathSync(tmpdir()), "development-log-writer-"));

test("one native writer owns a cache and closure releases it", async () => {
  const directory = await temporary(),
    binding = control(),
    first = new DevelopmentLogStore(directory, binding),
    second = new DevelopmentLogStore(directory, binding);
  try {
    await first.initialize();
    await assert.rejects(
      second.initialize(),
      /writer owns|lock is unavailable/,
    );
    await first.append([entry(1)]);
    await first.close();
    const resumed = new DevelopmentLogStore(directory, binding);
    await resumed.initialize();
    await resumed.append([entry(1), entry(2)]);
    await resumed.close();
    const page = await new DevelopmentLogReader(directory).entries({
      resourceIds: ["lambda:fixture"],
    });
    assert.deepEqual(
      page.entries.map((item) => item.eventId),
      [`${producer}:1`, `${producer}:2`],
    );
    assert.ok(page.gaps.some((gap) => gap.reason === "restart"));
  } finally {
    await first.close();
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("process death releases the native writer lock without a PID-based stale-owner decision", async () => {
  const directory = await temporary(),
    binding = control(),
    contender = new DevelopmentLogStore(directory, binding),
    recovered = new DevelopmentLogStore(directory, binding);
  // Keep the native SQLite handle reachable until SIGKILL. An empty interval
  // keeps the process alive but lets an otherwise unused store be collected.
  const script = `import { DevelopmentLogStore } from './packages/aws-studio/src/local/development-logs/store.ts'; const store = new DevelopmentLogStore(process.env.TEST_LOG_DIRECTORY, JSON.parse(process.env.TEST_LOG_CONTROL)); await store.initialize(); globalThis.__writerFixtureStore = store; process.send('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: path.resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        TEST_LOG_DIRECTORY: directory,
        TEST_LOG_CONTROL: JSON.stringify(binding),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const childClosed = once(child, "close");
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  try {
    const ready = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(`Writer fixture exited before ready: ${errors}`);
      }),
    ]);
    assert.equal(ready[0], "ready");
    await assert.rejects(
      contender.initialize(),
      /writer owns|lock is unavailable/,
    );
    child.kill("SIGKILL");
    await childClosed;
    await recovered.initialize();
    await recovered.append([entry(1)]);
    await recovered.close();
    assert.equal(
      (
        await new DevelopmentLogReader(directory).entries({
          resourceIds: ["lambda:fixture"],
        })
      ).entries.length,
      1,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await childClosed;
    await contender.close();
    await recovered.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery truncates uncommitted tails and removes only strictly named owned orphan artifacts", async () => {
  const directory = await temporary(),
    binding = control(),
    store = new DevelopmentLogStore(directory, binding);
  try {
    await store.initialize();
    await store.append([entry(1)]);
    await store.close();
    const runDirectory = path.join(directory, binding.runtimeSessionId),
      manifest = JSON.parse(
        await readFile(path.join(runDirectory, "manifest.json"), "utf8"),
      );
    const segment = manifest.segments.find(
      (item: { resourceId: string }) => item.resourceId === "lambda:fixture",
    );
    await appendFile(
      path.join(runDirectory, segment.file),
      "Uncommitted process output",
    );
    const orphan = `${randomUUID()}-${randomUUID()}.ndjson`,
      temporaryManifest = `manifest.json.${randomUUID()}.tmp`;
    await writeFile(path.join(runDirectory, orphan), "orphan", { mode: 0o600 });
    await writeFile(path.join(runDirectory, temporaryManifest), "{}", {
      mode: 0o600,
    });
    await writeFile(
      path.join(runDirectory, "developer-note.txt"),
      "preserve this file",
      { mode: 0o600 },
    );
    const recovered = new DevelopmentLogStore(directory, binding);
    await recovered.initialize();
    assert.equal(
      (await stat(path.join(runDirectory, segment.file))).size,
      segment.bytes,
    );
    const files = await readdir(runDirectory);
    assert.ok(!files.includes(orphan));
    assert.ok(!files.includes(temporaryManifest));
    assert.equal(
      await readFile(path.join(runDirectory, "developer-note.txt"), "utf8"),
      "preserve this file",
    );
    await recovered.close();
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed append is fenced and a fresh writer recovers only published bytes", async () => {
  const directory = await temporary(),
    binding = control(),
    store = new DevelopmentLogStore(directory, binding);
  try {
    await store.initialize();
    await store.append([entry(1)]);
    const runDirectory = path.join(directory, binding.runtimeSessionId),
      manifest = JSON.parse(
        await readFile(path.join(runDirectory, "manifest.json"), "utf8"),
      );
    const segment = manifest.segments.find(
      (item: { resourceId: string }) => item.resourceId === "lambda:fixture",
    );
    await appendFile(path.join(runDirectory, segment.file), "Unexpected tail");
    await assert.rejects(store.append([entry(2)]), /segment changed/);
    const failed = await new DevelopmentLogReader(directory).entries({
      resourceIds: ["lambda:fixture"],
    });
    assert.equal(failed.collection, "failed");
    assert.ok(failed.gaps.some((gap) => gap.reason === "storage"));
    await assert.rejects(store.append([entry(3)]), /unavailable/);
    const recovered = new DevelopmentLogStore(directory, binding);
    await recovered.initialize();
    await recovered.append([entry(2)]);
    await recovered.close();
    assert.deepEqual(
      (
        await new DevelopmentLogReader(directory).entries({
          resourceIds: ["lambda:fixture"],
        })
      ).entries.map((item) => item.eventId),
      [`${producer}:1`, `${producer}:2`],
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention bounds resource and project data and keeps an explicit gap", async () => {
  const directory = await temporary(),
    binding = control(),
    store = new DevelopmentLogStore(directory, binding, {
      limits: {
        resourceRecords: 5,
        records: 10,
        resourceBytes: 6 * 1024,
        bytes: 8 * 1024,
        segmentBytes: 2 * 1024,
      },
    });
  try {
    await store.initialize();
    for (let sequence = 1; sequence <= 30; sequence += 3)
      await store.append([
        entry(sequence),
        entry(sequence + 1),
        entry(sequence + 2),
      ]);
    await store.close();
    const manifest = JSON.parse(
      await readFile(
        path.join(directory, binding.runtimeSessionId, "manifest.json"),
        "utf8",
      ),
    );
    assert.ok(
      manifest.segments.reduce(
        (sum: number, segment: { bytes: number }) => sum + segment.bytes,
        0,
      ) <=
        8 * 1024,
    );
    assert.ok(
      manifest.segments.reduce(
        (sum: number, segment: { count: number }) => sum + segment.count,
        0,
      ) <= 10,
    );
    const page = await new DevelopmentLogReader(directory).entries({
      resourceIds: ["lambda:fixture"],
    });
    assert.ok(page.entries.length <= 5);
    assert.ok(page.gaps.some((gap) => gap.reason === "retention"));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a batch does not republish inactive run manifests", async () => {
  const directory = await temporary(),
    firstControl = control(),
    first = new DevelopmentLogStore(directory, firstControl);
  try {
    await first.initialize();
    await first.append([entry(1)]);
    await first.close();
    const second = new DevelopmentLogStore(directory, control());
    await second.initialize();
    const previous = path.join(
        directory,
        firstControl.runtimeSessionId,
        "manifest.json",
      ),
      before = await stat(previous, { bigint: true });
    await second.append([entry(2)]);
    await second.heartbeat();
    assert.equal(
      (await stat(previous, { bigint: true })).mtimeNs,
      before.mtimeNs,
    );
    await second.close();
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("age and run retention remove only expired owned history", async () => {
  const directory = await temporary();
  let time = Date.now();
  try {
    for (let index = 0; index < 3; index++) {
      const binding = control(time),
        store = new DevelopmentLogStore(directory, binding, {
          limits: { runs: 2, ageMs: 1000 },
          now: () => time,
        });
      await store.initialize();
      await store.append([entry(index + 1)]);
      await store.close();
      time += 100;
    }
    assert.equal(
      (await new DevelopmentLogReader(directory, () => time).runs()).length,
      2,
    );
    time += 2000;
    const current = new DevelopmentLogStore(directory, control(time), {
      limits: { runs: 2, ageMs: 1000 },
      now: () => time,
    });
    await current.initialize();
    await current.close();
    assert.equal(
      (await new DevelopmentLogReader(directory, () => time).runs()).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown files count toward the directory budget and are preserved when capture fails", async () => {
  const directory = await temporary(),
    file = path.join(directory, "developer-note.txt");
  try {
    await writeFile(file, "x".repeat(80 * 1024), { mode: 0o600 });
    const store = new DevelopmentLogStore(directory, control(), {
      limits: { directoryBytes: 64 * 1024 },
    });
    await assert.rejects(store.initialize(), /byte limit reached/);
    assert.equal((await stat(file)).size, 80 * 1024);
    await store.close();
    await rm(file);
    const fresh = new DevelopmentLogStore(directory, control());
    await fresh.initialize();
    await fresh.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("1,024 bounded observations append in batches without republishing inactive history", async (context) => {
  const directory = await temporary(),
    store = new DevelopmentLogStore(directory, control());
  try {
    await store.initialize();
    const started = performance.now();
    for (let sequence = 1; sequence <= 1024; sequence += 32)
      await store.append(
        Array.from({ length: 32 }, (_, index) => entry(sequence + index)),
      );
    const elapsed = performance.now() - started;
    await store.close();
    let cursor: string | undefined,
      count = 0;
    const reader = new DevelopmentLogReader(directory);
    do {
      const page = await reader.entries({
        resourceIds: ["lambda:fixture"],
        limit: 200,
        cursor,
      });
      count += page.entries.length;
      cursor = page.olderCursor;
    } while (cursor);
    assert.equal(count, 1024);
    context.diagnostic(
      `1,024 observations, 32 batches, ${Math.round(elapsed)}ms append time on this host; source/cache fixture only.`,
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("combined reader preserves an old runtime cursor when a newer run becomes latest", async () => {
  const directory = await temporary(),
    firstControl = control(),
    first = new DevelopmentLogStore(directory, firstControl);
  try {
    await first.initialize();
    await first.append([entry(1), entry(2), entry(3)]);
    await first.close();
    const reader = new CombinedDevelopmentLogReader(directory),
      page = await reader.entries({
        resourceIds: ["lambda:fixture"],
        limit: 1,
      });
    const latest = new DevelopmentLogStore(directory, control(Date.now() + 1));
    await latest.initialize();
    await latest.append([entry(4)]);
    await latest.close();
    const older = await reader.entries({
      resourceIds: ["lambda:fixture"],
      limit: 1,
      cursor: page.olderCursor,
    });
    assert.equal(older.run?.runtimeSessionId, firstControl.runtimeSessionId);
    assert.equal(older.entries[0]?.eventId, `${producer}:2`);
  } finally {
    await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("combined reader validates startup cursors before transitioning and exposes pending startup errors", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const directory = await temporary(),
    binding = control(),
    bootstrap = new DevelopmentLogStore(
      path.join(directory, "bootstrap"),
      binding,
    ),
    main = new DevelopmentLogStore(directory, binding);
  ensurePrivateDirectory(directory);
  try {
    const failure = {
      ...entry(1),
      observation: sanitizeDevelopmentObservation({
        resourceId: "runtime:development",
        kind: "startup.failed",
        level: "error",
        message: "Useful startup error before collector became ready",
      }),
    };
    await bootstrap.initialize();
    await bootstrap.append([failure]);
    await bootstrap.close();
    const reader = new CombinedDevelopmentLogReader(directory),
      prior = await reader.entries();
    await main.initialize();
    const pending = await reader.entries({ level: "error" });
    assert.equal(pending.entries[0]?.kind, "startup.failed");
    assert.equal(pending.collection, "collecting");
    assert.ok(pending.gaps.some((gap) => gap.message.includes("imported")));
    await assert.rejects(
      reader.entries({ cursor: `${prior.nextCursor}x` }),
      (error: unknown) => (error as { status?: number }).status === 400,
    );
    await main.append([failure]);
    const transitioned = await reader.entries({
      cursor: prior.nextCursor,
      direction: "newer",
    });
    assert.equal(transitioned.run?.runtimeSessionId, binding.runtimeSessionId);
    assert.ok(transitioned.nextCursor?.startsWith("runtime:"));
    now += 60_000;
    assert.equal((await reader.entries()).collection, "disconnected",
      "a real heartbeat age still disconnects the collector independently of filesystem speed");
  } finally {
    await bootstrap.close();
    await main.close();
    await rm(directory, { recursive: true, force: true });
  }
});

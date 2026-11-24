import { testProjectRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { LambdaIpcBudget } from "../src/local/lambda-ipc-budget";
import { findRepositoryRoot } from "../src/config/source";

test("IPC budget accounts for full metadata envelopes and records, not only one-byte payloads", () => {
  const callbacks: ((error?: Error | null) => void)[] = [];
  const budget = new LambdaIpcBudget((_message, done) => {
    callbacks.push(done);
  });
  const message = {
    type: "output",
    text: "x",
    observation: { traceId: "t".repeat(256), branchPath: "b".repeat(256) },
  };
  for (let index = 0; index < 100_000; index++) budget.trySend(message);
  assert.ok(budget.statistics.peakBytes <= 256 * 1024);
  assert.ok(budget.statistics.peakRecords <= 512);
  assert.ok(budget.statistics.droppedFrames > 99_000);
  assert.equal(
    budget.statistics.bytes,
    callbacks.length * Buffer.byteLength(JSON.stringify(message)),
  );
  for (const done of callbacks) done();
  assert.equal(budget.statistics.bytes, 0);
  assert.equal(budget.statistics.records, 0);
  let invoked = false;
  const broken = new LambdaIpcBudget(() => {
    throw new Error("transport failed");
  });
  assert.equal(
    broken.trySend(message, () => {
      invoked = true;
    }),
    false,
  );
  assert.equal(
    invoked,
    false,
    "a rejected write falls back without invoking its callback twice",
  );
});

test("real child zero-byte writes bypass logging and a tiny-write burst remains bounded", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "lambda-ipc-budget-"));
  const handler = path.join(directory, "handler.mjs");
  writeFileSync(
    handler,
    'export function lambdaHandler(event) { for (let i=0;i<10000;i++) process.stdout.write(event.zero ? "" : "x"); return {ok:true}; }',
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(__dirname, "../src/local/lambda-child.ts"),
    ],
    {
      cwd: testProjectRoot,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  const closed = once(child, "close");
  const invoke = (id: number, zero: boolean) =>
    new Promise<{
      peakBytes: number;
      peakRecords: number;
      droppedFrames: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("fixture child did not reply")),
        10_000,
      );
      const receive = (message: any) => {
        if (message.id !== id || typeof message.ok !== "boolean") return;
        clearTimeout(timeout);
        child.off("message", receive);
        message.ok
          ? resolve(message.outputBudget)
          : reject(new Error(message.error?.message));
      };
      child.on("message", receive);
      child.send({
        id,
        entry: pathToFileURL(handler).href,
        handler: "lambdaHandler",
        event: { zero },
        keepAlive: zero,
        observation: {
          resourceId: "lambda:ipc-probe",
          correlation: {
            invocationId: `invocation-${id}`,
            traceId: "t".repeat(256),
            branchPath: "b".repeat(256),
            stateId: "s".repeat(256),
          },
        },
        lambda: {
          functionName: "ipc-probe",
          memoryLimitInMB: 128,
          timeoutSeconds: 10,
        },
      });
    });
  try {
    const zero = await invoke(1, true);
    assert.equal(zero.peakBytes, 0);
    assert.equal(zero.peakRecords, 0);
    const burst = await invoke(2, false);
    assert.ok(burst.peakBytes <= 256 * 1024);
    assert.ok(burst.peakRecords <= 512);
    assert.ok(burst.droppedFrames > 0);
    await closed;
  } finally {
    child.kill();
    await closed.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

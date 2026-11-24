import { testProjectRoot, testProjectScratchRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findRepositoryRoot } from "../src/config/source";
import { LambdaWorkerPool } from "../src/local/lambda-process";
import { LocalLambdaExecutor } from "../src/local";
import { defineFrameworkConfig } from "../src/config";
import { defaults } from "../../../scripts/test-project-declarations";
import {
  registerDevelopmentSecrets,
  setDevelopmentObservationSink,
  type DevelopmentObservation,
} from "../src/development-logs";

test("warm reuse, concurrent overflow, late writes and native output preserve honest attribution", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "lambda-observation-"));
  const file = path.join(directory, "handler.mjs");
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  const resourceId = "lambda:observation-probe";
  const secret = "development-log-secret-canary";
  registerDevelopmentSecrets(resourceId, [secret]);
  const frameworkEntry = pathToFileURL(
    path.resolve(__dirname, "../src/development-logs/index.ts"),
  ).href;
  writeFileSync(
    file,
    `import { writeSync } from "node:fs";
import developmentLogs from ${JSON.stringify(frameworkEntry)};
const { observeDevelopment, developmentCorrelation } = developmentLogs;
console.log("module initialization");
export async function lambdaHandler(event) {
  console.log("start:" + event.name);
  if (event.late) setTimeout(() => console.log("late:" + event.name), 100);
  if (event.raw) writeSync(1, "native output\\n");
  if (event.secret) { process.stdout.write("password="); process.stdout.write(event.secret.slice(0, 9)); process.stdout.write(event.secret.slice(9) + "\\n"); }
  if (event.emoji) { const b = Buffer.from("hello 😀\\n"); process.stdout.write(b.subarray(0, 8)); process.stdout.write(b.subarray(8)); }
  observeDevelopment({ resourceId: ${JSON.stringify(resourceId)}, kind: "tool.contract.checked", correlation: developmentCorrelation(), details: { input: event.name } });
  if (event.wait) await new Promise(resolve => setTimeout(resolve, event.wait));
  return { pid: process.pid };
}`,
  );
  const pool = new LambdaWorkerPool({
    repositoryRoot: testProjectRoot,
    maxWarm: 1,
    idleSeconds: 30,
  });
  const environment = {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const request = (name: string, event: Record<string, unknown> = {}) => ({
    entry: pathToFileURL(file).href,
    handler: "lambdaHandler",
    event: { name, ...event },
    observation: {
      resourceId,
      correlation: { traceId: "trace", invocationId: name },
    },
    lambda: { functionName: "probe", timeoutSeconds: 10, memoryLimitInMB: 128 },
  });
  try {
    const first = (await pool.invoke(
      resourceId,
      environment,
      request("A", { late: true, raw: true, secret, emoji: true }),
    )) as { pid: number };
    const second = pool.invoke(
      resourceId,
      environment,
      request("B", { wait: 300 }),
    );
    const overflow = (await pool.invoke(
      resourceId,
      environment,
      request("C"),
    )) as { pid: number };
    const warm = (await second) as { pid: number };
    assert.equal(warm.pid, first.pid);
    assert.notEqual(overflow.pid, first.pid);
    await pool.close();
    assert.ok(
      events.some(
        (event) =>
          event.message?.includes("late:A") &&
          event.correlation.invocationId === "A" &&
          event.late,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.message?.includes("start:B") &&
          event.correlation.invocationId === "B",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.message?.includes("start:C") &&
          event.correlation.invocationId === "C",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.message?.includes("native output") &&
          !event.correlation.invocationId &&
          event.attribution === "worker",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.message?.includes("module initialization") &&
          !event.correlation.invocationId,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === "tool.contract.checked" &&
          event.correlation.invocationId === "A",
      ),
    );
    assert.ok(
      events.some((event) => event.message?.includes("hello 😀")),
      "split UTF-8 bytes survive framing",
    );
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.ok(
      events.filter((event) => event.message?.includes("start:A")).length === 1,
      "JS output is captured once",
    );
  } finally {
    await pool.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("executor observations retain terminal success, exception, timeout and cancellation", async () => {
  const parent = path.join(testProjectScratchRoot, ".cache");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "executor-observation-"));
  const handler = path.join(
    directory,
    "compute/events/probe",
  );
  mkdirSync(handler, { recursive: true });
  writeFileSync(
    path.join(handler, "index.ts"),
    `export async function lambdaHandler(event: { mode?: string }) {
    console.log("ready:" + event.mode);
    if (event.mode === "throw") throw new Error("fixture execution exception");
    if (event.mode === "timeout" || event.mode === "cancel") await new Promise(resolve => setTimeout(resolve, 30000));
    return { ok: true, visible: "useful result" };
  }`,
  );
  const config = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    services: [],
    events: [
      {
        probe: {
          directory: "compute/events/probe",
          subnet: "none",
          timeoutSeconds: 1,
        },
      },
    ],
  });
  const executor = new LocalLambdaExecutor({
    config,
    repositoryRoot: directory,
    pool: null,
  });
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    await executor.invoke(
      "lambda:probe",
      { mode: "success" },
      { observation: { traceId: "request-trace", requestId: "request-id" } },
    );
    await assert.rejects(
      executor.invoke("lambda:probe", { mode: "throw" }),
      /fixture execution exception/,
    );
    await assert.rejects(
      executor.invoke("lambda:probe", { mode: "timeout" }),
      /timeout/,
    );
    const cancelled = executor.invoke("lambda:probe", { mode: "cancel" });
    const rejected = assert.rejects(cancelled, /closed/);
    const deadline = Date.now() + 5000;
    while (!events.some((event) => event.message?.includes("ready:cancel"))) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    executor.close();
    await rejected;
    assert.ok(
      events.some(
        (event) =>
          event.kind === "lambda.invocation.completed" &&
          event.correlation.requestId === "request-id",
      ),
    );
    assert.ok(events.some((event) => event.kind === "lambda.invocation.input"));
    assert.ok(
      events.some(
        (event) =>
          event.kind === "lambda.invocation.failed" &&
          JSON.stringify(event.details).includes("fixture execution exception"),
      ),
    );
    assert.ok(
      events.some((event) => event.kind === "lambda.invocation.timed-out"),
    );
    assert.ok(
      events.some((event) => event.kind === "lambda.invocation.cancelled"),
    );
    const started = events.filter(
      (event) => event.kind === "lambda.invocation.started",
    );
    assert.equal(
      new Set(started.map((event) => event.correlation.invocationId)).size,
      4,
    );
  } finally {
    executor.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

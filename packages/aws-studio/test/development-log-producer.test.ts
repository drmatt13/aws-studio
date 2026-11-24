import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDevelopmentLogProducer,
  initializeDevelopmentLogProducer,
  readDevelopmentLogControl,
} from "../src/local/development-logs/producer";
import {
  registerDevelopmentSecrets,
  sanitizeDevelopmentObservation,
  type DevelopmentLogControl,
  type DevelopmentObservation,
} from "../src/development-logs";

const control: DevelopmentLogControl = {
  version: 1,
  repositoryKey: "producer-repository",
  composeProject: "producer-project",
  runtimeSessionId: "11111111-1111-4111-8111-111111111111",
  bindingId: "binding",
  declarationDigest: "digest",
  startedAt: "2026-11-10T12:00:00.000Z",
  endpoint: "http://127.0.0.1:8090",
  token: "e".repeat(64),
  binding: { deployment: "fixture-dev" },
};
const observation = (index: number): DevelopmentObservation =>
  sanitizeDevelopmentObservation({
    resourceId: "lambda:producer",
    kind: "fixture.output",
    message: `visible record ${index}`,
    details: { index },
  });
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("producer close drains every bounded batch with sanitized content and unique event ids", async () => {
  const requests: { body: string; authorization: string | undefined }[] = [];
  const secret = "LONG_PRODUCER_CANARY_" + "z".repeat(2000);
  registerDevelopmentSecrets("lambda:producer", [secret]);
  const producer = createDevelopmentLogProducer(control, {
    component: "fixture",
    fetch: (async (_url, init) => {
      requests.push({
        body: String(init?.body),
        authorization: (init?.headers as Record<string, string>)?.authorization,
      });
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  for (let index = 0; index < 160; index++)
    producer.emit(
      index
        ? observation(index)
        : { ...observation(index), message: `before ${secret} after` },
    );
  await producer.close();
  await producer.close();
  const entries = requests.flatMap(
    (request) => JSON.parse(request.body).entries,
  );
  assert.equal(entries.length, 160);
  assert.equal(new Set(entries.map((entry) => entry.eventId)).size, 160);
  assert.equal(producer.dropped, 0);
  for (const request of requests) {
    assert.ok(Buffer.byteLength(request.body) <= 256 * 1024);
    assert.ok(JSON.parse(request.body).entries.length <= 32);
    assert.equal(request.authorization, `Bearer ${control.token}`);
    assert.ok(
      !request.body.includes(secret.slice(0, 100)),
      "redact before message truncation",
    );
  }
});

test("byte pressure stays below the batch limit and records exact queue losses", async () => {
  const bodies: string[] = [];
  const producer = createDevelopmentLogProducer(control, {
    component: "fixture",
    fetch: (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  for (let index = 0; index < 200; index++)
    producer.emit({
      ...observation(index),
      resourceId: "lambda:" + "a".repeat(1000),
      relatedResourceIds: [
        "service:" + "b".repeat(1000),
        "workflow:" + "c".repeat(1000),
        "agent:" + "d".repeat(1000),
      ],
      message: "visible ".repeat(120),
      level: "error",
      omissions: Array.from({ length: 32 }, (_, number) => ({
        path: `$.${number}.` + "p".repeat(150),
        reason: "size" as const,
      })),
    });
  await producer.close();
  assert.ok(producer.dropped > 0);
  const reported = bodies.reduce(
    (count, body) => count + JSON.parse(body).dropped,
    0,
  );
  assert.equal(reported, producer.dropped);
  assert.equal(
    bodies.reduce((count, body) => count + JSON.parse(body).entries.length, 0) +
      reported,
    200,
  );
  for (const body of bodies) assert.ok(Buffer.byteLength(body) <= 256 * 1024);
});

test("reconnection retries the same event ids and never makes capture throw", async () => {
  const batches: { entries: { eventId: string }[] }[] = [];
  const producer = createDevelopmentLogProducer(control, {
    component: "fixture",
    fetch: (async (_url, init) => {
      batches.push(JSON.parse(String(init?.body)));
      if (batches.length === 1)
        throw new Error("fixture collector unavailable");
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  for (let index = 0; index < 3; index++) producer.emit(observation(index));
  await until(() => batches.length === 1);
  await producer.close();
  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches[0]!.entries.map((entry) => entry.eventId),
    batches[1]!.entries.map((entry) => entry.eventId),
  );
  assert.equal(producer.dropped, 0);
});

test("transport ignoring abort cannot block shutdown and invalid events produce a loss-only batch", async () => {
  const hanging = createDevelopmentLogProducer(control, {
    component: "fixture",
    fetch: (() => new Promise(() => {})) as typeof fetch,
  });
  hanging.emit(observation(1));
  const started = Date.now();
  await hanging.close();
  assert.ok(Date.now() - started < 4000);
  assert.equal(hanging.dropped, 1);
  const bodies: { entries: unknown[]; dropped: number }[] = [];
  const producer = createDevelopmentLogProducer(control, {
    component: "fixture",
    fetch: (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });
  assert.doesNotThrow(() =>
    producer.emit(
      new Proxy({} as DevelopmentObservation, {
        get() {
          throw new Error("malicious getter");
        },
      }),
    ),
  );
  await producer.close();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.entries.length, 0);
  assert.equal(bodies[0]!.dropped, 1);
});

test("private control accepts only the local collector origin and explicit runtime ownership", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "producer-control-"));
  const directory = path.join(root, ".framework/local");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "development-logs.json");
  const previous = process.env.FRAMEWORK_DEVELOPMENT_LOGS;
  t.after(() => {
    if (previous === undefined) delete process.env.FRAMEWORK_DEVELOPMENT_LOGS;
    else process.env.FRAMEWORK_DEVELOPMENT_LOGS = previous;
    rmSync(root, { recursive: true, force: true });
  });
  for (const endpoint of [
    "https://example.invalid",
    "http://127.0.0.1:8090/other",
    "http://127.0.0.1:8090/?token=private",
    "http://user:password@localhost:8090",
  ]) {
    writeFileSync(file, JSON.stringify({ ...control, endpoint }), {
      mode: 0o600,
    });
    assert.equal(readDevelopmentLogControl(root, {}), undefined);
  }
  writeFileSync(file, JSON.stringify(control), { mode: 0o600 });
  assert.equal(
    readDevelopmentLogControl(root, {})?.runtimeSessionId,
    control.runtimeSessionId,
  );
  delete process.env.FRAMEWORK_DEVELOPMENT_LOGS;
  await initializeDevelopmentLogProducer({
    component: "fixture",
    repositoryRoot: root,
  }).close();
});

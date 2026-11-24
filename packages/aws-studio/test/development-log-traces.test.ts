import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DevelopmentLogReader,
  DevelopmentLogStore,
} from "../src/local/development-logs/store";
import { CombinedDevelopmentLogReader } from "../src/local/development-logs/combined-reader";
import { sanitizeDevelopmentObservation } from "../src/development-logs/context";
import type {
  DevelopmentLogControl,
  DevelopmentObservationInput,
} from "../src/development-logs/contract";

async function fixture() {
  const directory = await mkdtemp(
      path.join(realpathSync(tmpdir()), "development-trace-"),
    ),
    producer = randomUUID();
  const control: DevelopmentLogControl = {
    version: 1,
    runtimeSessionId: randomUUID(),
    repositoryKey: "trace-fixture",
    composeProject: "trace-fixture",
    bindingId: "binding",
    declarationDigest: "digest",
    startedAt: new Date().toISOString(),
    token: "a".repeat(64),
    endpoint: "http://127.0.0.1:8090",
    binding: {},
  };
  const store = new DevelopmentLogStore(directory, control);
  await store.initialize();
  let sequence = 0;
  const entry = (observation: DevelopmentObservationInput) => ({
    eventId: `${producer}:${++sequence}`,
    producer: { component: "fixture", instanceId: producer },
    observation: sanitizeDevelopmentObservation(observation),
  });
  return {
    directory,
    control,
    store,
    entry,
    reader: new DevelopmentLogReader(directory),
    close: async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("trace index finds cross-resource evidence without scanning unrelated history or duplicating route copies", async () => {
  const f = await fixture();
  try {
    await f.store.append([
      f.entry({
        resourceId: "gateway:http",
        relatedResourceIds: ["route:http:/orders"],
        kind: "http.request.received",
        correlation: { traceId: "wanted", spanId: "request" },
      }),
    ]);
    // More unrelated bytes than a trace scan can read; index selection must skip these segments.
    for (let batch = 0; batch < 16; batch++)
      await f.store.append(
        Array.from({ length: 32 }, (_, index) =>
          f.entry({
            resourceId: "lambda:noise",
            kind: "lambda.output",
            stream: "stdout",
            message: "unrelated".repeat(120),
            details: { values: Array(20).fill("noise".repeat(30)) },
            correlation: { traceId: `noise-${batch}-${index}` },
          }),
        ),
      );
    await f.store.append([
      f.entry({
        resourceId: "lambda:orders",
        kind: "lambda.invocation.started",
        correlation: {
          traceId: "wanted",
          spanId: "lambda",
          parentSpanId: "request",
          invocationId: "call",
        },
      }),
      f.entry({
        resourceId: "lambda:orders",
        kind: "lambda.invocation.completed",
        details: {
          headers: { authorization: "Bearer TRACE_AUTH_CANARY" },
          http: { status: 401 },
        },
        durationMs: 12,
        correlation: {
          traceId: "wanted",
          spanId: "lambda",
          parentSpanId: "request",
          invocationId: "call",
        },
      }),
      f.entry({
        resourceId: "gateway:http",
        kind: "http.response.finished",
        details: { status: 401 },
        durationMs: 15,
        correlation: { traceId: "wanted", spanId: "request" },
      }),
    ]);
    await f.store.close();
    const result = await new CombinedDevelopmentLogReader(f.directory).trace({
      runId: f.control.runtimeSessionId,
      traceId: "wanted",
    });
    assert.equal(result.entries.length, 4);
    assert.equal(result.complete, true);
    assert.equal(new Set(result.entries.map((event) => event.eventId)).size, 4);
    assert.deepEqual(
      result.entries.map((event) => event.resource.id),
      ["gateway:http", "lambda:orders", "lambda:orders", "gateway:http"],
    );
    assert.ok(!JSON.stringify(result).includes("TRACE_AUTH_CANARY"));
    assert.ok(!JSON.stringify(result).includes("unrelated"));
    const route = await f.reader.trace({
      runId: f.control.runtimeSessionId,
      traceId: "wanted",
      resourceIds: ["gateway:http", "route:http:/orders"],
      routeId: "route:http:/orders",
    });
    assert.equal(route.entries.length, 1);
    assert.equal(route.entries[0]?.kind, "http.request.received");
    const differentResource = await f.reader.trace({
      runId: f.control.runtimeSessionId,
      traceId: "wanted",
      resourceIds: ["lambda:noise"],
    });
    assert.equal(differentResource.entries.length, 0);
    const manifest = JSON.parse(
      await readFile(
        path.join(f.directory, f.control.runtimeSessionId, "manifest.json"),
        "utf8",
      ),
    );
    assert.ok(
      manifest.segments.every(
        (segment: { traceIds: string[] }) => segment.traceIds.length <= 128,
      ),
    );
    assert.ok(
      manifest.segments.filter(
        (segment: { resourceId: string }) =>
          segment.resourceId === "lambda:noise",
      ).length > 1,
    );
  } finally {
    await f.close();
  }
});

test("trace reads cap output and expose incomplete or legacy observations instead of claiming full recovery", async () => {
  const f = await fixture();
  try {
    for (let batch = 0; batch < 8; batch++)
      await f.store.append(
        Array.from({ length: 32 }, () =>
          f.entry({
            resourceId: "lambda:many",
            kind: "lambda.output",
            message: "visible diagnostic",
            correlation: { traceId: "large" },
          }),
        ),
      );
    await f.store.close();
    const page = await f.reader.trace({
      runId: f.control.runtimeSessionId,
      traceId: "large",
      limit: 20,
    });
    assert.equal(page.entries.length, 20);
    assert.equal(page.complete, false);
    assert.ok(page.gaps.some((gap) => gap.reason === "truncated"));
    const file = path.join(
        f.directory,
        f.control.runtimeSessionId,
        "manifest.json",
      ),
      manifest = JSON.parse(await readFile(file, "utf8"));
    for (const segment of manifest.segments) delete segment.traceIds;
    await writeFile(file, JSON.stringify(manifest));
    const legacy = await f.reader.trace({
      runId: f.control.runtimeSessionId,
      traceId: "large",
    });
    assert.equal(legacy.complete, false);
    assert.ok(
      legacy.gaps.some((gap) => gap.message.includes("no trace index")),
    );
    await assert.rejects(
      f.reader.trace({ runId: "../private", traceId: "large" }),
    );
    await assert.rejects(
      f.reader.trace({
        runId: f.control.runtimeSessionId,
        traceId: "bad\ntrace",
      }),
    );
    await assert.rejects(
      f.reader.trace({
        runId: f.control.runtimeSessionId,
        traceId: "large",
        limit: 201,
      }),
    );
    const expired = await f.reader.trace({
      runId: randomUUID(),
      traceId: "large",
    });
    assert.equal(expired.complete, false);
    assert.ok(expired.gaps.some((gap) => gap.reason === "retention"));
  } finally {
    await f.close();
  }
});

test("cache manifests reject an unbounded trace index", async () => {
  const f = await fixture();
  try {
    await f.store.append([
      f.entry({
        resourceId: "lambda:one",
        kind: "lambda.invocation.started",
        correlation: { traceId: "one" },
      }),
    ]);
    const longestTrace = "t".repeat(256);
    await f.store.append([
      f.entry({
        resourceId: "lambda:one",
        kind: "lambda.invocation.completed",
        correlation: { traceId: longestTrace },
      }),
    ]);
    await f.store.close();
    assert.equal(
      (
        await f.reader.trace({
          runId: f.control.runtimeSessionId,
          traceId: longestTrace,
        })
      ).entries.length,
      1,
    );
    await assert.rejects(
      f.reader.trace({
        runId: f.control.runtimeSessionId,
        traceId: longestTrace + "x",
      }),
    );
    const file = path.join(
        f.directory,
        f.control.runtimeSessionId,
        "manifest.json",
      ),
      manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.segments[0].traceIds = Array.from(
      { length: 129 },
      (_, index) => `trace-${index}`,
    );
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(
      f.reader.trace({ runId: f.control.runtimeSessionId, traceId: "one" }),
      /Invalid development log manifest/,
    );
  } finally {
    await f.close();
  }
});

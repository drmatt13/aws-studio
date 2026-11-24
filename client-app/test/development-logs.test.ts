import assert from "./support/assert";
import { test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  developmentLogsRouter,
  readDevelopmentLogQuery,
} from "../server/development-logs";
import { snapshot } from "./browser/support/scenarios";
import {
  logEvent,
  logPage,
  logRun,
  workflowLogModel,
} from "./support/development-logs";

test("cache query validation binds canonical resources and finite read limits", () => {
  const model = snapshot().snapshot.models.dev;
  const parsed = readDevelopmentLogQuery(
    {
      mode: "dev",
      resource: "lambda:fixture-0",
      limit: "20",
      direction: "older",
    },
    model,
  );
  assert.deepEqual(parsed.query.resourceIds, ["lambda:fixture-0"]);
  assert.equal(parsed.query.limit, 20);
  const route = model.routes[0]!;
  const routed = readDevelopmentLogQuery(
    { mode: "dev", resource: route.id },
    model,
  );
  assert.equal(routed.query.routeId, route.id);
  assert.ok(routed.query.resourceIds?.includes(route.id));
  for (const query of [
    { mode: "prod" },
    { mode: "dev", resource: "../../etc/passwd" },
    { mode: "dev", limit: "201" },
    { mode: "dev", limit: ["10", "20"] },
    { mode: "dev", cursor: "x".repeat(2049) },
    { mode: "dev", service: "postgres" },
    { mode: "dev", runId: "../run" },
    { mode: "dev", level: "fatal" },
    { mode: "dev", search: "secret\nline" },
    { mode: "dev", reserveKinds: ["lambda.invocation.failed"] },
  ])
    assert.throws(() => readDevelopmentLogQuery(query, model));
});

test("workflow-owned event Lambda cache reads use the Lambda identity without claiming AWS trigger coverage", () => {
  const model = workflowLogModel(snapshot().snapshot.models.dev);
  const parsed = readDevelopmentLogQuery(
    { mode: "dev", resource: "lambda:fixture-0" },
    model,
  );
  assert.equal(parsed.scope?.kind, "partial");
  assert.match(
    parsed.scope?.reason ?? "",
    /AWS event-triggered executions are not collected/,
  );
  assert.deepEqual(parsed.query.resourceIds, ["lambda:fixture-0"]);
  assert.equal(
    readDevelopmentLogQuery(
      { mode: "dev", resource: "lambda:aws-only-fixture" },
      model,
    ).scope?.kind,
    "unsupported",
  );
});

test("guarded cache router rejects production without invoking a cache reader and projects bounded excerpts", async () => {
  let reads = 0,
    unavailable = false;
  const app = express();
  app.use(
    "/logs",
    developmentLogsRouter({
      model: () => snapshot().snapshot.models.dev,
      readRuns: async () => {
        reads++;
        return [logRun];
      },
      readEntries: async () => {
        reads++;
        if (unavailable)
          throw new Error(
            "Private cache /Users/PRIVATE_PATH_CANARY/cache is unavailable",
          );
        return logPage(
          Array.from({ length: 24 }, (_, index) =>
            logEvent(index + 1, { message: "Safe output ".repeat(200) }),
          ),
        );
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/logs`;
  try {
    for (const endpoint of ["runs", "entries", "evidence"])
      assert.equal((await fetch(`${base}/${endpoint}?mode=prod`)).status, 400);
    assert.equal(reads, 0);
    const response = await fetch(
      `${base}/evidence?mode=dev&resource=lambda%3Afixture-0`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, "development");
    assert.equal(body.entries.length, 8);
    assert.equal(body.entries[0].message.length, 400);
    assert.equal(body.entries[0].truncated, true);
    assert.ok(body.entries[0].detailsPreview.includes("[redacted]"));
    assert.deepEqual(body.excluded, {
      executions: 0,
      failed: 0,
      records: 16,
      errorLevel: 16,
    });
    assert.equal(body.entries[0].producer, undefined);
    unavailable = true;
    const failure = await fetch(`${base}/entries?mode=dev`);
    assert.equal(failure.status, 503);
    assert.ok(!(await failure.text()).includes("PRIVATE_PATH_CANARY"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent evidence keeps the latest outcome as one execution alongside older failures", async () => {
  const oldErrors = Array.from({ length: 8 }, (_, index) =>
    logEvent(index + 1, {
      kind: "lambda.invocation.failed",
      level: "error",
      outcome: "failed",
      correlation: {
        traceId: `old-error-${index}`,
        invocationId: `old-${index}`,
      },
    }),
  );
  const completed = logEvent(9, {
    kind: "lambda.invocation.completed",
    level: "info",
    outcome: "succeeded",
    message: undefined,
    details: { http: { status: 200, source: "handler-result" } },
    correlation: { traceId: "latest-success", invocationId: "latest" },
    durationMs: 25,
  });
  const late = logEvent(10, {
    kind: "lambda.output",
    stream: "stdout",
    level: "info",
    outcome: undefined,
    message: "Late useful diagnostic",
    details: undefined,
    correlation: { traceId: "latest-success", invocationId: "latest" },
  });
  const app = express();
  app.use(
    "/logs",
    developmentLogsRouter({
      model: () => snapshot().snapshot.models.dev,
      readRuns: async () => [logRun],
      readEntries: async (query) =>
        logPage(
          query.level === "error" ? oldErrors : [...oldErrors, completed, late],
        ),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/logs/evidence?mode=dev&resource=lambda%3Afixture-0`,
    );
    assert.equal(response.status, 200);
    const evidence = await response.json();
    // Eight old failures cannot push out the newest completed invocation, and its late output stays inside its digest.
    assert.deepEqual(
      evidence.executions.map(
        (execution: { invocationId: string }) => execution.invocationId,
      ),
      ["latest", "old-7", "old-6"],
    );
    assert.equal(evidence.executions[0].outcome, "returned");
    assert.equal(evidence.executions[0].httpStatus, 200);
    assert.equal(evidence.executions[0].durationMs, 25);
    assert.equal(evidence.executions[1].outcome, "failed");
    assert.deepEqual(evidence.entries, []);
    assert.deepEqual(evidence.excluded, {
      executions: 6,
      failed: 6,
      records: 6,
      errorLevel: 6,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

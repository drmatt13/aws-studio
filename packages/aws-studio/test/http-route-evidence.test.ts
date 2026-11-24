import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { defineFrameworkConfig, getAllHttpRoutes } from "../src/config";
import type { LocalLambdaExecutor } from "../src/local";
import {
  DevelopmentLogStore,
  DevelopmentLogReader,
} from "../src/local/development-logs/store";
import {
  setDevelopmentObservationSink,
  type DevelopmentObservation,
  type DevelopmentLogControl,
} from "../src/development-logs";
import { defaults } from "../../../scripts/test-project-declarations";
import { installDevelopmentHttpIngress } from "../local/api/lib/developmentLogs";
import {
  registerLambdaRoute,
  registerUnmatchedRouteHandler,
  registerApiGatewayErrorHandler,
} from "../local/api/lib/routeProxyHelpers";

test("actual route events reach persisted route evidence while unmatched requests remain gateway-only", async () => {
  const directory = await mkdtemp(
    path.join(realpathSync(tmpdir()), "http-route-evidence-"),
  );
  const control: DevelopmentLogControl = {
    version: 1,
    repositoryKey: "route-repository",
    composeProject: "route-project",
    runtimeSessionId: randomUUID(),
    bindingId: "route-binding",
    declarationDigest: "route-source",
    startedAt: new Date().toISOString(),
    endpoint: "http://127.0.0.1:8090",
    token: "d".repeat(64),
    binding: {},
  };
  const store = new DevelopmentLogStore(directory, control),
    events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  const config = defineFrameworkConfig({
    defaults,
    http: [
      {
        "/route-evidence": {
          directory: "compute/.cache/test-fixtures/probe",
          methods: ["POST"],
        },
      },
    ],
    webSocket: [],
    events: [],
    services: [],
  });
  const routes = getAllHttpRoutes(config),
    app = express(),
    api = express();
  installDevelopmentHttpIngress(app);
  const executor = {
    invoke: async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    }),
  } as unknown as LocalLambdaExecutor;
  registerLambdaRoute(api, routes[0]!, "lambda:probe", executor);
  registerUnmatchedRouteHandler(api, routes);
  registerApiGatewayErrorHandler(api);
  app.use("/api", api);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const base = `http://127.0.0.1:${address.port}/api`;
    const matched = await fetch(`${base}/route-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await matched.text();
    const missing = await fetch(`${base}/missing`);
    await missing.text();
    await store.initialize();
    const producerId = randomUUID();
    await store.append(
      events.map((observation, index) => ({
        observation,
        eventId: `${producerId}:${index + 1}`,
        producer: { instanceId: producerId, component: "route-fixture" },
      })),
    );
    await store.close();
    const reader = new DevelopmentLogReader(directory),
      routeId = "route:http:/route-evidence";
    const focused = await reader.entries({
      runId: control.runtimeSessionId,
      resourceIds: ["gateway:http", "lambda:probe"],
      routeId,
    });
    assert.ok(
      focused.entries.some((event) => event.kind === "http.route.matched"),
    );
    assert.ok(
      focused.entries.some(
        (event) => event.kind === "http.integration.dispatched",
      ),
    );
    assert.ok(
      focused.entries.some((event) => event.kind === "http.response.finished"),
    );
    assert.ok(
      focused.entries.every((event) =>
        event.relatedResourceIds.includes(routeId),
      ),
    );
    assert.ok(!JSON.stringify(focused.entries).includes("/missing"));
    const all = await reader.entries({
      runId: control.runtimeSessionId,
      resourceIds: ["gateway:http"],
    });
    const unmatched = all.entries.find(
      (event) => event.kind === "http.route.unmatched",
    );
    assert.ok(unmatched);
    assert.deepEqual(unmatched.relatedResourceIds, []);
  } finally {
    restore();
    await store.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

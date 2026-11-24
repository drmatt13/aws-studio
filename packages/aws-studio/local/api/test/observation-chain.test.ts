import { testProjectRoot, testProjectScratchRoot } from "../../../../../scripts/test-project";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { DevelopmentObservation } from "aws-studio/development-logs";
import { defaults, applicationVpc } from "../../../../../scripts/test-project-declarations";

// Keep the executor, handler and observation scope on the same physical release.
const appRequire = createRequire(path.join(testProjectRoot, "package.json"));
const local = path.join(testProjectRoot, "node_modules/aws-studio/local");
const {
  defineFrameworkConfig,
  getAllHttpRoutes,
  runsTask,
  startsWorkflow,
  succeed,
  workflow,
} = appRequire("aws-studio/config") as typeof import("aws-studio/config");
const {
  LocalLambdaExecutor,
  assertLocalInvocationEdge,
} = appRequire("aws-studio/local") as typeof import("aws-studio/local");
const {
  encodeDevelopmentCorrelation,
  observeDevelopment,
  setDevelopmentObservationSink,
  withDevelopmentObservation,
} = appRequire("aws-studio/development-logs") as typeof import("aws-studio/development-logs");
const { readDevelopmentCorrelation } =
  appRequire(path.join(local, "invocation/src/observation.ts")) as typeof import("../../invocation/src/observation");
const { installDevelopmentHttpIngress } =
  appRequire(path.join(local, "api/lib/developmentLogs.ts")) as typeof import("../lib/developmentLogs");
const {
  registerApiGatewayErrorHandler,
  registerLambdaRoute,
  registerUnmatchedRouteHandler,
} = appRequire(path.join(local, "api/lib/routeProxyHelpers.ts")) as typeof import("../lib/routeProxyHelpers");

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

test("concurrent HTTP requests keep their trace through real Lambda children and task/workflow HTTP submissions", async () => {
  const parent = path.join(testProjectScratchRoot, ".cache");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "observation-http-chain-"));
  const handler = path.join(
    directory,
    "compute/http/trace-starter",
  );
  mkdirSync(handler, { recursive: true });
  writeFileSync(
    path.join(handler, "index.ts"),
    `import {runTask,startWorkflow} from "aws-studio/runtime/invocation";
export async function lambdaHandler(event: {body:string}) {
  const input=JSON.parse(event.body);
  const task=await runTask("probe-task" as never,input);
  const flow=await startWorkflow("probe-workflow" as never,input);
  return {statusCode:200,headers:{"content-type":"application/json"},body:JSON.stringify({task,flow})};
}`,
  );
  const config = defineFrameworkConfig({
    defaults,
    networks: [applicationVpc],
    http: [
      {
        "/trace": {
          directory: "compute/http/trace-starter",
          methods: ["POST"],
          cloud: {
            bindings: [
              runsTask("probe-task"),
              startsWorkflow("probe-workflow"),
            ],
          },
        },
      },
    ],
    webSocket: [],
    events: [],
    services: [],
    tasks: [
      { "probe-task": { cloud: { vpc: applicationVpc }, deploy: "both" } },
    ],
    workflows: [
      {
        "probe-workflow": workflow(() => succeed({ ok: true }), {
          deploy: "both",
          timeoutSeconds: 10,
        }),
      },
    ],
  });
  const events: DevelopmentObservation[] = [],
    wire: { header: string; body: any }[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  const runner = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 16 * 1024) {
        response.writeHead(413).end();
        return;
      }
    }
    const body = JSON.parse(text),
      header = String(
        request.headers["x-framework-development-observation"] ?? "",
      );
    assertLocalInvocationEdge(config, body.caller, body.target);
    wire.push({ header, body });
    withDevelopmentObservation(
      { correlation: readDevelopmentCorrelation(header) },
      () =>
        observeDevelopment({
          resourceId: body.target,
          kind: "fixture.submission.accepted",
        }),
    );
    response.writeHead(202, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/tasks"
          ? { runId: randomUUID() }
          : { executionId: randomUUID() },
      ),
    );
  });
  let gateway: Server | undefined, executor: InstanceType<typeof LocalLambdaExecutor> | undefined;
  try {
    const runnerUrl = await listen(runner);
    executor = new LocalLambdaExecutor({
      config,
      repositoryRoot: directory,
      runnerUrl,
      pool: null,
    });
    const app = express();
    installDevelopmentHttpIngress(app);
    const routes = express();
    const route = getAllHttpRoutes(config)[0]!;
    registerLambdaRoute(routes, route, "lambda:trace-starter", executor);
    registerUnmatchedRouteHandler(routes, [route]);
    registerApiGatewayErrorHandler(routes);
    app.use("/api", routes);
    gateway = createServer(app);
    const url = await listen(gateway);
    const replies = await Promise.all(
      ["A", "B"].map((label) =>
        fetch(`${url}/api/trace`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            label,
            caller: "lambda:untrusted-payload",
            diagnostics: { traceId: "payload-is-not-correlation" },
          }),
        }),
      ),
    );
    assert.ok(replies.every((reply) => reply.status === 200));
    await Promise.all(replies.map((reply) => reply.text()));
    assert.equal(wire.length, 4);
    const gatewayRequests = events.filter(
      (event) => event.kind === "http.request.received",
    );
    assert.equal(gatewayRequests.length, 2);
    for (const label of ["A", "B"]) {
      const calls = wire.filter((call) => call.body.input.label === label);
      assert.equal(calls.length, 2);
      const correlation = readDevelopmentCorrelation(calls[0]!.header);
      assert.deepEqual(
        readDevelopmentCorrelation(calls[1]!.header),
        correlation,
      );
      assert.ok(
        gatewayRequests.some(
          (event) =>
            event.correlation.traceId === correlation.traceId &&
            event.correlation.requestId === correlation.requestId,
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.kind === "lambda.invocation.started" &&
            event.correlation.invocationId === correlation.invocationId &&
            event.correlation.spanId === correlation.spanId,
        ),
      );
      for (const call of calls) {
        assert.equal(call.body.caller, "lambda:trace-starter");
        assert.ok(!("diagnostics" in call.body));
        assert.equal(
          call.body.input.diagnostics.traceId,
          "payload-is-not-correlation",
        );
      }
    }
    assert.equal(
      new Set(
        wire.map(
          (call) => readDevelopmentCorrelation(call.header).invocationId,
        ),
      ).size,
      2,
    );
    const encoded = encodeDevelopmentCorrelation({
      traceId: "trace-kept",
      invocationId: "invocation-kept",
      branchPath: "日本".repeat(128),
      stateId: "s".repeat(256),
      requestId: "r".repeat(256),
      executionId: "e".repeat(256),
      taskRunId: "t".repeat(256),
    });
    assert.ok(encoded.length <= 2048);
    assert.match(encoded, /^[\x20-\x7e]*$/);
    assert.equal(readDevelopmentCorrelation(encoded).traceId, "trace-kept");
  } finally {
    await executor?.close();
    if (gateway) await close(gateway);
    await close(runner);
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

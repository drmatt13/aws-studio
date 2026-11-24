import { testProjectRoot, testProjectScratchRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { defineFrameworkConfig } from "../src/config";
import { findRepositoryRoot } from "../src/config/source";
import { LocalLambdaExecutor } from "../src/local";
import {
  lambdaInvocationPreview,
  lambdaInvocationResultDetails,
  sensitiveDevelopmentHttpInvocation,
} from "../src/local/lambda-observation";
import {
  developmentSecrets,
  withDevelopmentObservation,
  setDevelopmentObservationSink,
  type DevelopmentObservation,
} from "../src/development-logs";
import { LambdaWorkerPool } from "../src/local/lambda-process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { defaults } from "../../../scripts/test-project-declarations";

function event(path: string, contentType: string | undefined, body: string) {
  return {
    rawPath: path,
    headers: contentType ? { "content-type": contentType } : {},
    body,
    requestContext: { http: { path, method: "POST" } },
  };
}

test("safe HTTP status survives auth omission without evaluating getters or changing the response", () => {
  const result = Object.freeze({
    statusCode: 401,
    body: "AUTH_RESULT_CANARY",
    headers: { authorization: "Bearer AUTH_HEADER_CANARY" },
  });
  const details = lambdaInvocationResultDetails(result, { sensitive: true });
  assert.deepEqual(details.http, { status: 401, source: "handler-result" });
  assert.equal(details.result, "[sensitive invocation payload omitted]");
  assert.ok(!JSON.stringify(details).includes("CANARY"));
  assert.equal(result.body, "AUTH_RESULT_CANARY");
  for (const statusCode of [99, 600, NaN, Infinity, "200", 200.5])
    assert.equal(lambdaInvocationResultDetails({ statusCode }).http, undefined);
  let getter = false;
  const unsafe = Object.defineProperty({}, "statusCode", {
    get() {
      getter = true;
      throw new Error("no diagnostic getter");
    },
  });
  assert.equal(lambdaInvocationResultDetails(unsafe).http, undefined);
  assert.equal(
    lambdaInvocationResultDetails(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            getter = true;
            throw new Error("no diagnostic trap");
          },
        },
      ),
    ).http,
    undefined,
  );
  assert.equal(getter, false);
});

test("all Lambda preview callers omit sensitive HTTP bodies and keep binary/unknown bodies unavailable", () => {
  for (const input of [
    event("/login", "text/plain", "AUTH_TEXT_CANARY"),
    event("/auth/exchange", "application/json", '{"proof":"AUTH_JSON_CANARY"}'),
  ]) {
    assert.equal(sensitiveDevelopmentHttpInvocation(input), true);
    const result = {
      statusCode: 200,
      headers: input.headers,
      body: input.body,
    };
    const captured = JSON.stringify({
      input: lambdaInvocationPreview(input),
      result: lambdaInvocationPreview(result, {
        sensitive: sensitiveDevelopmentHttpInvocation(input),
      }),
    });
    assert.ok(!captured.includes("AUTH_TEXT_CANARY"));
    assert.ok(!captured.includes("AUTH_JSON_CANARY"));
    assert.match(captured, /sensitive.*omitted/);
  }
  const encoded = Buffer.from("BINARY_INPUT_CANARY").toString("base64");
  for (const input of [
    {
      ...event("/ordinary", "application/octet-stream", encoded),
      isBase64Encoded: true,
    },
    event("/ordinary", "application/x-private", "UNKNOWN_TYPE_CANARY"),
    event("/ordinary", undefined, "UNKNOWN_TYPE_CANARY"),
  ]) {
    const captured = JSON.stringify(lambdaInvocationPreview(input));
    assert.ok(!captured.includes(encoded));
    assert.ok(!captured.includes("UNKNOWN_TYPE_CANARY"));
    assert.match(captured, /omitted/);
  }
  const ordinary = event(
    "/ordinary",
    "application/json",
    '{"message":"visible ordinary payload"}',
  );
  assert.ok(
    JSON.stringify(lambdaInvocationPreview(ordinary)).includes(
      "visible ordinary payload",
    ),
  );
  assert.equal(
    ordinary.body,
    '{"message":"visible ordinary payload"}',
    "capture must not mutate the handler input",
  );
});

test("Node execution and container transport preserve auth responses while omitting cached request/result/error payloads", async (t) => {
  const parent = path.join(testProjectScratchRoot, ".cache");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "lambda-auth-preview-"));
  const handler = path.join(
    directory,
    "compute/events/auth-node",
  );
  mkdirSync(handler, { recursive: true });
  writeFileSync(
    path.join(handler, "index.ts"),
    `import {writeSync} from "node:fs";
  export async function lambdaHandler(event: any) {
    console.log(event.body); process.stderr.write(event.body + "\\n"); writeSync(1, event.body + "\\n");
    if (event.headers["content-type"] === "application/json") console.log(JSON.parse(event.body).proof);
    if (event.fail) throw new Error(event.body);
    return {statusCode:event.status ?? 200,headers:event.headers,body:event.body};
  }`,
  );
  const config = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    services: [],
    events: [
      {
        "auth-node": { subnet: "none" },
        "auth-container": { packaging: "container" },
      },
    ],
  });
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((value) => events.push(value));
  const executor = new LocalLambdaExecutor({
    config,
    repositoryRoot: directory,
    pool: null,
    runnerUrl: "http://fixture.invalid",
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const { event: input } = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(
          input.fail
            ? { error: input.body }
            : {
                result: {
                  statusCode: 200,
                  headers: input.headers,
                  body: input.body,
                },
              },
        ),
        {
          status: input.fail ? 500 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  try {
    for (const target of [
      "lambda:auth-node",
      "lambda:auth-container",
    ] as const) {
      for (const input of [
        event("/login", "text/plain", "AUTH_TEXT_CANARY"),
        event(
          "/auth/exchange",
          "application/json",
          '{"proof":"AUTH_JSON_CANARY"}',
        ),
      ]) {
        const result = await executor.invoke<{ body: string }>(target, input);
        assert.equal(
          result.body,
          input.body,
          "application responses retain their original body",
        );
      }
      const ordinary = event(
        "/ordinary",
        "application/json",
        '{"message":"visible ordinary payload"}',
      );
      await executor.invoke(target, ordinary);
      await assert.rejects(
        executor.invoke(target, {
          ...event("/auth/exchange", "text/plain", "AUTH_ERROR_CANARY"),
          fail: true,
        }),
        /AUTH_ERROR_CANARY/,
      );
    }
    const privateResult = await withDevelopmentObservation(
      { sensitive: true },
      () =>
        executor.invoke<{ statusCode: number; body: string }>(
          "lambda:auth-node",
          {
            ...event("/ordinary", "text/plain", "PARENT_PRIVATE_CANARY"),
            status: 401,
          },
        ),
    );
    assert.equal(privateResult.statusCode, 401);
    assert.equal(privateResult.body, "PARENT_PRIVATE_CANARY");
    const serialized = JSON.stringify(events);
    const completed = events.filter(
      (value) => value.kind === "lambda.invocation.completed",
    );
    assert.ok(
      completed
        .slice(0, -1)
        .every(
          (value) =>
            (value.details as { http?: { status: number } }).http?.status ===
            200,
        ),
    );
    assert.equal(
      (completed.at(-1)!.details as { http: { status: number } }).http.status,
      401,
    );
    for (const canary of [
      "AUTH_TEXT_CANARY",
      "AUTH_JSON_CANARY",
      "AUTH_ERROR_CANARY",
      "PARENT_PRIVATE_CANARY",
    ])
      assert.ok(!serialized.includes(canary), canary);
    assert.ok(serialized.includes("visible ordinary payload"));
    assert.equal(
      events.filter(
        (value) =>
          value.kind === "lambda.invocation.completed" &&
          JSON.stringify(value.details).includes(
            "sensitive invocation payload omitted",
          ),
      ).length,
      5,
    );
    assert.equal(
      events.filter((value) => value.kind === "lambda.invocation.failed")
        .length,
      2,
    );
  } finally {
    await executor.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sensitive output stays omitted through warm reuse, late async writes and native fallback", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "lambda-auth-output-")),
    file = path.join(directory, "handler.mjs");
  writeFileSync(
    file,
    `import {writeSync} from "node:fs";
export async function lambdaHandler(event) {
  console.log(event.body); process.stderr.write(event.body + "\\n");
  if (event.late) setTimeout(() => { console.log(event.body); writeSync(1,event.body + "\\n"); },50);
  if (event.wait) await new Promise(resolve => setTimeout(resolve,event.wait));
  return {ok:true};
}`,
  );
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((value) => events.push(value));
  const dictionary = developmentSecrets();
  const pool = new LambdaWorkerPool({
    repositoryRoot: testProjectRoot,
    maxWarm: 1,
    idleSeconds: 30,
  });
  const environment = {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const request = (id: string, input: unknown) => ({
    entry: pathToFileURL(file).href,
    handler: "lambdaHandler",
    event: input,
    observation: {
      resourceId: "lambda:auth-output",
      correlation: { invocationId: id },
    },
    lambda: {
      functionName: "auth-output",
      memoryLimitInMB: 128,
      timeoutSeconds: 10,
    },
  });
  try {
    await pool.invoke(
      "lambda:auth-output",
      environment,
      request("auth-A", {
        ...event("/login", "text/plain", "AUTH_LATE_OUTPUT_CANARY"),
        late: true,
      }),
    );
    await pool.invoke(
      "lambda:auth-output",
      environment,
      request("public-B", {
        ...event("/ordinary", "text/plain", "visible ordinary output"),
        wait: 200,
      }),
    );
    await pool.close();
    assert.ok(!JSON.stringify(events).includes("AUTH_LATE_OUTPUT_CANARY"));
    assert.ok(
      events.some(
        (value) =>
          value.correlation.invocationId === "auth-A" &&
          value.late &&
          value.message?.includes("omitted"),
      ),
    );
    assert.ok(
      events.some(
        (value) =>
          value.attribution === "worker" && value.message?.includes("omitted"),
      ),
    );
    assert.ok(
      events.some(
        (value) =>
          value.correlation.invocationId === "public-B" &&
          value.message?.includes("visible ordinary output"),
      ),
    );
    assert.equal(
      developmentSecrets(),
      dictionary,
      "auth requests do not grow the secret registry",
    );
  } finally {
    await pool.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DevelopmentTextFramer,
  developmentSecrets,
  resourceDevelopmentSecrets,
  registerDevelopmentSecrets,
  sanitizeDevelopmentCorrelation,
  sanitizeDevelopmentObservation,
  sanitizeDevelopmentText,
  sanitizeDevelopmentValue,
  setDevelopmentObservationSink,
  observeDevelopment,
  withDevelopmentObservation,
  type DevelopmentObservation,
} from "../src/development-logs";
import { lambdaInvocationPreview } from "../src/local/lambda-observation";

test("global redaction retains previous values while child dictionaries stay within their own resource", () => {
  registerDevelopmentSecrets("lambda:privacy-a", ["A_OLD_SECRET_CANARY"]);
  registerDevelopmentSecrets("lambda:privacy-b", ["B_OTHER_SECRET_CANARY"]);
  registerDevelopmentSecrets("lambda:privacy-a", ["A_NEW_SECRET_CANARY"]);
  assert.deepEqual(resourceDevelopmentSecrets("lambda:privacy-a"), [
    "A_OLD_SECRET_CANARY",
    "A_NEW_SECRET_CANARY",
  ]);
  assert.ok(
    !resourceDevelopmentSecrets("lambda:privacy-a").includes(
      "B_OTHER_SECRET_CANARY",
    ),
  );
  assert.ok(developmentSecrets().includes("B_OTHER_SECRET_CANARY"));
  const global = developmentSecrets(),
    scoped = resourceDevelopmentSecrets("lambda:privacy-a");
  registerDevelopmentSecrets("lambda:privacy-a", [
    "A_OLD_SECRET_CANARY",
    "A_NEW_SECRET_CANARY",
  ]);
  assert.equal(developmentSecrets(), global);
  assert.equal(resourceDevelopmentSecrets("lambda:privacy-a"), scoped);
  assert.throws(
    () => (developmentSecrets() as string[]).push("mutation"),
    TypeError,
  );
  assert.ok(
    !sanitizeDevelopmentText(
      "A_OLD_SECRET_CANARY A_NEW_SECRET_CANARY B_OTHER_SECRET_CANARY",
      developmentSecrets(),
    ).includes("CANARY"),
  );
});

test("malformed optional observation fields and getters cannot change application control flow", () => {
  let invoked = false;
  const input = {
    resourceId: "lambda:privacy-a",
    kind: "fixture.event",
    relatedResourceIds: 7,
    phase: {},
    outcome: [],
    attribution: "administrator",
    level: 7,
    stream: {},
    message: { private: "CANARY" },
    durationMs: Infinity,
  };
  Object.defineProperty(input, "correlation", {
    get() {
      invoked = true;
      throw new Error("getter");
    },
  });
  const event = sanitizeDevelopmentObservation(input as never);
  assert.equal(invoked, false);
  assert.deepEqual(event.correlation, {});
  assert.deepEqual(event.relatedResourceIds, []);
  assert.equal(event.phase, undefined);
  assert.equal(event.outcome, undefined);
  assert.equal(event.attribution, "resource");
  assert.equal(event.level, "info");
  assert.equal(event.stream, "event");
  assert.equal(event.message, undefined);
  assert.equal(event.durationMs, undefined);
  const unknownHttp = lambdaInvocationPreview({
    requestContext: { http: { method: "POST" } },
    headers: {},
    body: "UNKNOWN_TYPE_CANARY",
  });
  assert.ok(!JSON.stringify(unknownHttp).includes("UNKNOWN_TYPE_CANARY"));
  const websocket = lambdaInvocationPreview({
    requestContext: { eventType: "MESSAGE" },
    body: "visible WebSocket text",
  });
  assert.ok(JSON.stringify(websocket).includes("visible WebSocket text"));
  assert.deepEqual(lambdaInvocationPreview({ body: "ordinary tool result" }), {
    body: "ordinary tool result",
  });
});

test("JSON output remains a useful excerpt and omission metadata survives repeated sanitization", () => {
  const event = sanitizeDevelopmentObservation({
    resourceId: "lambda:privacy-a",
    kind: "fixture.output",
    message: '{"message":"useful failure excerpt","token":"JSON_TOKEN_CANARY"}',
  });
  assert.ok(event.message?.includes("useful failure excerpt"));
  assert.ok(!event.message?.includes("JSON_TOKEN_CANARY"));
  assert.ok(event.omissions.some((value) => value.reason === "privacy"));
  const again = sanitizeDevelopmentObservation(event);
  assert.equal(again.message, event.message);
  assert.deepEqual(again.omissions, event.omissions);
  assert.deepEqual(
    sanitizeDevelopmentObservation({
      resourceId: "lambda:privacy-a",
      kind: "fixture.event",
    }).omissions,
    [],
  );
});

test("payload policy sanitizes nested JSON/forms, URLs, errors and auth while omitting unsupported bodies", () => {
  const input: Record<string, unknown> = {
    headers: {
      authorization: "Bearer AUTH_HEADER_CANARY",
      cookie: "session=COOKIE_CANARY",
    },
    callback: "http://localhost:8090/callbacks/CALLBACK_TOKEN_CANARY/success",
    signed: "https://bucket.invalid/object?X-Amz-Signature=SIGNED_URL_CANARY",
    nested: '{"safe":"visible","token":"NESTED_TOKEN_CANARY"}',
    form: "pass%77ord=ENCODED_FORM_CANARY",
  };
  const result = JSON.stringify(sanitizeDevelopmentValue(input));
  for (const canary of [
    "AUTH_HEADER_CANARY",
    "COOKIE_CANARY",
    "CALLBACK_TOKEN_CANARY",
    "SIGNED_URL_CANARY",
    "NESTED_TOKEN_CANARY",
    "ENCODED_FORM_CANARY",
  ])
    assert.ok(!result.includes(canary), canary);
  assert.ok(result.includes("visible"));
  assert.match(
    String(
      sanitizeDevelopmentValue(Buffer.from("BINARY_CANARY"), {
        contentType: "application/octet-stream",
      }).value,
    ),
    /omitted/,
  );
  assert.match(
    String(
      sanitizeDevelopmentValue("AUTH_BODY_CANARY", {
        sensitive: true,
        contentType: "text/plain",
      }).value,
    ),
    /omitted/,
  );
  assert.ok(
    !JSON.stringify(
      sanitizeDevelopmentValue(
        Buffer.from('{"token":"SUFFIX_JSON_CANARY","visible":true}'),
        { contentType: "application/problem+json" },
      ),
    ).includes("SUFFIX_JSON_CANARY"),
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.ok(
    sanitizeDevelopmentValue(circular).omissions.some(
      (value) => value.reason === "circular",
    ),
  );
  let accessed = false;
  const error = new Error("useful exception message");
  Object.defineProperty(error, "stack", {
    value:
      "Error: password=STACK_CANARY\n at /Users/private/developer/file.ts:1",
  });
  Object.defineProperty(error, "cause", {
    get() {
      accessed = true;
      return "GETTER_CANARY";
    },
  });
  const exception = JSON.stringify(sanitizeDevelopmentValue(error));
  assert.ok(exception.includes("useful exception message"));
  assert.ok(!exception.includes("STACK_CANARY"));
  assert.ok(!exception.includes("GETTER_CANARY"));
  assert.equal(accessed, false);
  assert.deepEqual(
    sanitizeDevelopmentCorrelation(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error("trap");
          },
        },
      ),
    ),
    {},
  );
});

test("framing protects chunk boundaries, multiline keys, ambiguous continuations and unfinished prefixes", () => {
  const output: string[] = [];
  const known = "MULTILINE_FIRST_CANARY\nMULTILINE_SECOND_CANARY";
  const framer = new DevelopmentTextFramer(
    (line) => output.push(line),
    [known, "COMPLETE_SECRET_CANARY"],
  );
  framer.push("visible start MULTILINE_FIRST_");
  framer.push("CANARY\nMULTILINE_SECOND_CANARY\n");
  framer.push(
    "-----BEGIN PRIVATE KEY-----\nPRIVATE_KEY_BODY_CANARY\n-----END PRIVATE KEY-----\nvisible after key\n",
  );
  framer.push("final COMPLETE_SECRET_");
  framer.flush();
  assert.ok(output.join("").includes("visible start"));
  assert.ok(output.join("").includes("visible after key"));
  for (const canary of [
    "MULTILINE_FIRST_CANARY",
    "MULTILINE_SECOND_CANARY",
    "PRIVATE_KEY_BODY_CANARY",
    "COMPLETE_SECRET_",
  ])
    assert.ok(!output.join("").includes(canary), canary);
  const continuation: string[] = [];
  const dangling = new DevelopmentTextFramer((line) => continuation.push(line));
  dangling.push(
    "password=\nUNKNOWN_LINE_ONE_CANARY\nUNKNOWN_LINE_TWO_CANARY\n",
  );
  dangling.flush();
  assert.ok(!continuation.join("").includes("UNKNOWN_LINE"));
  assert.ok(continuation.join("").includes("omitted"));
  const oversized: string[] = [];
  const large = new DevelopmentTextFramer((line) => oversized.push(line));
  large.push("x".repeat(256 * 1024));
  large.push("\nvisible resumed\n");
  large.flush();
  assert.ok(oversized[0]?.includes("oversized"));
  assert.ok(oversized.join("").includes("visible resumed"));
});

test("isolated worker context cannot retain an earlier invocation and observer failure is fail-open", () => {
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    withDevelopmentObservation(
      {
        resourceId: "lambda:caller",
        correlation: {
          invocationId: "previous",
          requestId: "previous-request",
        },
      },
      () => {
        withDevelopmentObservation(
          { isolated: true, resourceId: "lambda:worker", correlation: {} },
          () =>
            observeDevelopment({
              resourceId: "lambda:worker",
              kind: "fixture.output",
            }),
        );
      },
    );
    assert.deepEqual(events[0]?.correlation, {});
  } finally {
    restore();
  }
  const restoreThrowing = setDevelopmentObservationSink(() => {
    throw new Error("collector failed");
  });
  try {
    assert.doesNotThrow(() =>
      observeDevelopment({
        resourceId: "lambda:worker",
        kind: "fixture.output",
      }),
    );
  } finally {
    restoreThrowing();
  }
});

test("large objects and hostile arrays stay bounded without executing accessors or custom collection methods", () => {
  const object: Record<string, unknown> = Object.create(null);
  for (let index = 0; index < 100_000; index++) object[`field${index}`] = index;
  let descriptors = 0,
    getters = 0;
  const proxy = new Proxy(object, {
    get() {
      getters++;
      throw new Error("getter must not run");
    },
    getOwnPropertyDescriptor(target, key) {
      descriptors++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const result = sanitizeDevelopmentValue(object);
  const proxyResult = sanitizeDevelopmentValue(proxy);
  assert.equal(
    descriptors,
    0,
    "omit proxies before their structural traps can run",
  );
  assert.equal(getters, 0);
  assert.ok(
    proxyResult.omissions.some((value) => value.reason === "unsupported"),
  );
  assert.ok(result.omissions.some((value) => value.reason === "size"));
  assert.ok(Object.keys(result.value as object).length <= 64);
  const array = [1, 2];
  Object.defineProperty(array, "1", {
    get() {
      getters++;
      return "ARRAY_ACCESSOR_CANARY";
    },
  });
  array.slice = (() => {
    getters++;
    throw new Error("custom slice");
  }) as typeof array.slice;
  const arrayProxy = new Proxy(array, {
    get() {
      getters++;
      throw new Error("array getter");
    },
  });
  const preview = sanitizeDevelopmentValue(arrayProxy);
  assert.equal(getters, 0);
  assert.ok(!JSON.stringify(preview).includes("ARRAY_ACCESSOR_CANARY"));
  const event = {
    ...object,
    body: '{"safe":"visible"}',
    headers: { "content-type": "application/json" },
    requestContext: { http: { method: "POST" } },
  };
  let eventDescriptors = 0;
  lambdaInvocationPreview(
    new Proxy(event, {
      get() {
        getters++;
        throw new Error("event getter");
      },
      getOwnPropertyDescriptor(target, key) {
        eventDescriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }),
  );
  assert.ok(eventDescriptors <= 150);
  assert.equal(getters, 0);
});

test("bare local callback tokens and an interrupted token fragment never reach output", () => {
  const callback = `wf-${"a".repeat(32)}`;
  assert.ok(
    !sanitizeDevelopmentText(`callback failed ${callback}`).includes(callback),
  );
  const frames: string[] = [],
    framer = new DevelopmentTextFramer((value) => frames.push(value));
  framer.push(`first ${callback.slice(0, 15)}`);
  framer.push(`${callback.slice(15)}\n`);
  framer.push("interrupted wf-aaaaaaaaaaaa");
  framer.flush();
  assert.ok(!frames.join("").includes("wf-aaaa"));
  assert.ok(frames.join("").includes("omitted"));
});

// Last in this process: overflow intentionally fails closed for the remainder of the runtime.
test("repeated registry additions stop retaining values after the fixed global budget", () => {
  for (let index = 0; index < 20_000; index++)
    registerDevelopmentSecrets("lambda:overflow", [`OVERFLOW_${index}`]);
  assert.deepEqual(developmentSecrets(), ["__capture_suppressed__"]);
  assert.deepEqual(resourceDevelopmentSecrets("lambda:privacy-a"), [
    "__capture_suppressed__",
  ]);
  assert.match(
    String(
      sanitizeDevelopmentValue(
        { visible: "raw after overflow" },
        { secrets: developmentSecrets() },
      ).value,
    ),
    /omitted/,
  );
});

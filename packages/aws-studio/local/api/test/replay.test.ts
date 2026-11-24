import assert from "node:assert/strict";
import test from "node:test";
import { setDevelopmentObservationSink, type DevelopmentObservation } from "aws-studio/development-logs";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import invokeAsyncLambdaFunctions, {
  resolveReplayTarget,
} from "../src/invokeAsyncLambdaFunctions";
import type {
  ReplayEnvelope,
  ReplayResult,
} from "aws-studio/runtime/event-replay";

function envelope(overrides: Partial<ReplayEnvelope> = {}): ReplayEnvelope {
  return {
    id: "replay-1",
    capturedAt: "2026-01-01T00:00:00.000Z",
    eventType: "PostConfirmationTriggerEvent",
    sourceHint: "cognito:PostConfirmation_ConfirmSignUp",
    originalEvent: {} as never,
    ...overrides,
  };
}

test("resolves versioned and legacy replay envelopes", () => {
  assert.equal(
    resolveReplayTarget(
      envelope({
        version: 1,
        replayId: "cognito-post-confirmation-trigger",
        target: "lambda:cognito-post-confirmation-trigger",
      }),
    ),
    "lambda:cognito-post-confirmation-trigger",
  );
  assert.equal(
    resolveReplayTarget(
      envelope({ handlerName: "CognitoPostConfirmationTrigger" }),
    ),
    "lambda:cognito-post-confirmation-trigger",
  );
});

test("logs and deletes only successful replay invocations", async (t) => {
  const priorQueue = process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;
  const priorBucket = process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = "queue";
  process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = "bucket";
  const logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  t.mock.method(console, "error", () => {});
  const deleted: string[] = [];
  const messages: ReplayResult[] = [
    {
      envelope: envelope({ replayId: "cognito-post-confirmation-trigger" }),
      receiptHandle: "success",
      receiveCount: 1,
    },
    {
      envelope: envelope({ replayId: "cognito-post-confirmation-trigger" }),
      receiptHandle: "failure",
      receiveCount: 2,
    },
  ];
  let invocation = 0;

  try {
    await invokeAsyncLambdaFunctions(
      {
        invoke: async () => {
          invocation += 1;
          if (invocation === 2) throw new Error("expected failure");
          return {};
        },
      },
      undefined,
      {
        poll: async () => messages,
        delete: async (_queueUrl, receiptHandle) => {
          deleted.push(receiptHandle);
        },
        extendVisibility: async () => {},
      },
    );
    assert.deepEqual(deleted, ["success"]);
    assert.ok(
      logs.some((message) =>
        message.includes(
          "Invocation succeeded for lambda:cognito-post-confirmation-trigger",
        ),
      ),
    );
  } finally {
    if (priorQueue === undefined) delete process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;
    else process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = priorQueue;
    if (priorBucket === undefined) delete process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
    else process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = priorBucket;
  }
});

test("replay evidence separates receipt, processing, retry and acknowledgement", async t => {
  const before = { queue: process.env.DEV_LAMBDA_REPLAY_QUEUE_URL, bucket: process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME };
  process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = "queue"; process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = "bucket";
  t.after(() => {
    if (before.queue === undefined) delete process.env.DEV_LAMBDA_REPLAY_QUEUE_URL; else process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = before.queue;
    if (before.bucket === undefined) delete process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME; else process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = before.bucket;
  });
  t.mock.method(console, "log", () => {}); t.mock.method(console, "warn", () => {}); t.mock.method(console, "error", () => {});
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink(event => events.push(event)); t.after(restore);
  const contexts: { awsRequestId?: string; observation?: { invocationId?: string } }[] = [];
  const messages = [1, 2, 3].map(receiveCount => ({ envelope: envelope({ replayId: "cognito-post-confirmation-trigger", awsRequestId: "original-request" }), receiptHandle: `private-receipt-${receiveCount}`, receiveCount }));
  messages.push({ envelope: envelope({ replayId: "removed-target" }), receiptHandle: "private-receipt-unresolved", receiveCount: 1 });
  let attempt = 0;
  await invokeAsyncLambdaFunctions({ invoke: async (_target, _event, context) => {
    contexts.push(context ?? {}); if (++attempt === 1) throw new Error("fixture handler failed"); return {};
  } }, undefined, { poll: async () => messages, extendVisibility: async () => {}, delete: async (_queue, receipt) => { if (receipt.endsWith("2")) throw new Error("fixture acknowledgement failed"); } });
  assert.equal(contexts.length, 3);
  assert.ok(contexts.every(context => context.awsRequestId === "original-request"));
  assert.equal(new Set(contexts.map(context => context.observation?.invocationId)).size, 3);
  assert.equal(events.filter(event => event.kind === "replay.delivery.received").length, 4);
  assert.equal(events.filter(event => event.kind === "replay.handler.completed").length, 2);
  assert.equal(events.filter(event => event.kind === "replay.handler.failed").length, 1);
  assert.equal(events.filter(event => event.kind === "replay.acknowledgement.completed").length, 1);
  assert.equal(events.filter(event => event.kind === "replay.acknowledgement.failed").length, 1);
  assert.ok(events.some(event => event.kind === "replay.target.unresolved"));
  assert.ok(!JSON.stringify(events).includes("private-receipt"));
});

test("the real replay decoder joins SQS receipt to target execution and acknowledgement without exposing handles", async t => {
  const queue = process.env.DEV_LAMBDA_REPLAY_QUEUE_URL, bucket = process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = "fixture-queue"; process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = "fixture-bucket";
  t.after(() => { if (queue === undefined) delete process.env.DEV_LAMBDA_REPLAY_QUEUE_URL; else process.env.DEV_LAMBDA_REPLAY_QUEUE_URL = queue; if (bucket === undefined) delete process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME; else process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME = bucket; });
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink(event => events.push(event)); t.after(restore);
  t.mock.method(console, "log", () => {});
  const commands: string[] = [];
  t.mock.method(SQSClient.prototype, "send", async (command: object) => {
    commands.push(command.constructor.name);
    if (command.constructor.name === "ReceiveMessageCommand") return { Messages: [{ MessageId: "sqs-observed-message", ReceiptHandle: "PRIVATE_RECEIPT_CANARY", Attributes: { ApproximateReceiveCount: "2" }, Body: JSON.stringify({ Records: [{ s3: { object: { key: "replay/fixture.json" } } }] }) }] };
    return {};
  });
  t.mock.method(S3Client.prototype, "send", async () => ({ Body: { transformToString: async () => JSON.stringify(envelope({ replayId: "cognito-post-confirmation-trigger" })) } }));
  await invokeAsyncLambdaFunctions({ invoke: async () => ({ done: true }) });
  for (const kind of ["replay.receipt", "replay.capture.decoded", "replay.delivery.received", "replay.delivery.attempted", "replay.handler.completed", "replay.acknowledgement.completed"]) {
    const event = events.find(value => value.kind === kind);
    assert.ok(event, kind); assert.equal(event.correlation.messageId, "sqs-observed-message", kind);
  }
  assert.equal(events.find(value => value.kind === "replay.capture.decoded")?.correlation.replayId, "replay-1");
  assert.equal(commands.filter(command => command === "DeleteMessageCommand").length, 1);
  assert.ok(!JSON.stringify(events).includes("PRIVATE_RECEIPT_CANARY"));
});

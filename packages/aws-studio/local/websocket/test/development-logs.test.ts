import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import {
  setDevelopmentObservationSink,
  type DevelopmentObservation,
} from "aws-studio/development-logs";
import type { LocalLambdaExecutor } from "aws-studio/local";
import { createLocalWebSocketRuntime } from "../src/index";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "expected gateway observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function connect(
  url: string,
  origin = "http://localhost:3000",
): Promise<WebSocket> {
  const socket = new WebSocket(
    url.replace(/^http/, "ws") + "?token=websocket-query-canary",
    { origin },
  );
  await once(socket, "open");
  return socket;
}

test("WebSocket evidence joins handshake, concurrent messages, pushes and disconnect without credentials", async () => {
  const events: DevelopmentObservation[] = [];
  const invocations: {
    target: string;
    event: Record<string, any>;
    context: any;
  }[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  const executor = {
    async invoke(target: string, event: Record<string, any>, context: any) {
      invocations.push({ target, event, context });
      if (target === "lambda:authorizer")
        return {
          policyDocument: { Statement: [{ Effect: "Allow" }] },
          context: { token: "authorizer-secret-canary" },
        };
      if (target === "lambda:message") {
        const body = JSON.parse(event.body);
        await new Promise((resolve) => setTimeout(resolve, body.delay ?? 0));
        if (body.fail) throw new Error("fixture route failure");
        return { statusCode: 200, body: `reply:${body.name}` };
      }
      return { statusCode: 200 };
    },
  } as unknown as LocalLambdaExecutor;
  const runtime = createLocalWebSocketRuntime({
    executor,
    routes: {
      $connect: "lambda:connect",
      $default: "lambda:message",
      $disconnect: "lambda:disconnect",
      custom: "lambda:message",
    },
    authorizerTarget: "lambda:authorizer",
    browserOrigins: ["http://localhost:3000"],
  });
  try {
    const url = await listen(runtime.server);
    const management = await listen(runtime.managementServer);
    await assert.rejects(connect(url, "https://untrusted.invalid"), /403/);
    const socket = await connect(url);
    const connectionId = invocations.find(
      (call) => call.target === "lambda:connect",
    )!.event.requestContext.connectionId;
    const replies: string[] = [];
    socket.on("message", (message) => replies.push(message.toString()));
    socket.send(
      JSON.stringify({
        action: "custom",
        name: "slow",
        delay: 50,
        token: "message-token-canary",
      }),
    );
    socket.send(JSON.stringify({ action: "custom", name: "fast" }));
    await until(() => replies.length >= 2);
    assert.deepEqual(replies, ["reply:fast", "reply:slow"]);
    const push = await fetch(`${management}/@connections/${connectionId}`, {
      method: "POST",
      headers: {
        "x-framework-development-observation": JSON.stringify({
          traceId: "push-trace",
          invocationId: "parent-invocation",
        }),
      },
      body: "server push",
    });
    assert.equal(push.status, 200);
    assert.equal(
      (
        await fetch(`${management}/@connections/missing`, {
          method: "POST",
          body: "x",
        })
      ).status,
      410,
    );
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await until(() =>
      events.some(
        (event) => event.kind === "websocket.disconnect-handler.completed",
      ),
    );
    const messages = events.filter(
      (event) => event.kind === "websocket.message.received",
    );
    assert.equal(messages.length, 2);
    assert.ok(
      messages.every((event) =>
        event.relatedResourceIds.includes("route:ws:custom"),
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === "websocket.connect-handler.completed" &&
          event.relatedResourceIds.includes("route:ws:$connect"),
      ),
    );
    assert.notEqual(
      messages[0].correlation.messageId,
      messages[1].correlation.messageId,
    );
    assert.ok(
      messages.every(
        (event) => event.correlation.connectionId === connectionId,
      ),
    );
    assert.ok(
      events.some((event) => event.kind === "websocket.connect.rejected"),
    );
    assert.ok(
      events.some((event) => event.kind === "websocket.connect.completed"),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === "websocket.push.accepted" &&
          event.correlation.invocationId === "parent-invocation",
      ),
    );
    assert.ok(
      events.some((event) => event.kind === "websocket.management.gone"),
    );
    assert.ok(
      events.some(
        (event) => event.kind === "websocket.disconnect-handler.completed",
      ),
    );
    for (const call of invocations.filter(
      (call) => call.target !== "lambda:authorizer",
    ))
      assert.equal(
        call.event.requestContext.requestId,
        call.context.observation.requestId,
      );
    const serialized = JSON.stringify(events);
    for (const canary of [
      "websocket-query-canary",
      "authorizer-secret-canary",
      "message-token-canary",
    ])
      assert.ok(!serialized.includes(canary));
  } finally {
    await runtime.close();
    restore();
  }
});

test("authorization policy denial and handler failure are explicit outcomes", async () => {
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  let deny = true;
  const executor = {
    async invoke(target: string) {
      if (target === "lambda:authorizer")
        return {
          policyDocument: { Statement: [{ Effect: deny ? "Deny" : "Allow" }] },
        };
      if (target === "lambda:message")
        throw new Error("fixture handler failed");
      return { statusCode: 200 };
    },
  } as unknown as LocalLambdaExecutor;
  const runtime = createLocalWebSocketRuntime({
    executor,
    routes: { $default: "lambda:message" },
    authorizerTarget: "lambda:authorizer",
    browserOrigins: ["http://localhost:3000"],
  });
  try {
    const url = await listen(runtime.server);
    await assert.rejects(connect(url), /403/);
    deny = false;
    const socket = await connect(url);
    const reply = once(socket, "message");
    socket.send("not JSON");
    await reply;
    assert.ok(
      events.some((event) => event.kind === "websocket.authorization.denied"),
    );
    assert.ok(events.some((event) => event.kind === "websocket.route.failed"));
    socket.terminate();
  } finally {
    await runtime.close();
    restore();
  }
});

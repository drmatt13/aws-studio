import { localDeployInputs } from "aws-studio/config/source";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import env from "dotenv";

import { getLocalBrowserOrigins } from "aws-studio/local/origins";
import { LocalLambdaExecutor } from "aws-studio/local";
import {
  getWebSocketAuthorizerIn,
  getWebSocketRoutesIn,
  validateFrameworkConfig,
  type LambdaTarget,
} from "aws-studio/config";
import { loadFrameworkConfig } from "aws-studio/config/source";
import { initializeDevelopmentLogProducer } from "aws-studio/local/development-logs/producer";
import { newDevelopmentCorrelation, observeDevelopment, sanitizeDevelopmentValue, developmentSecrets, sanitizeDevelopmentCorrelation, type DevelopmentCorrelation } from "aws-studio/development-logs";

import {
  createConnectEvent,
  createDisconnectEvent,
  createMessageEvent,
} from "../events/websocketEvents";

// The project this runs for, loaded by root: see loadFrameworkConfig.
const framework = loadFrameworkConfig();

export interface LocalWebSocketOptions {
  readonly executor: Pick<LocalLambdaExecutor, "invoke">;
  readonly routes: Readonly<Record<string, LambdaTarget>>;
  readonly authorizerTarget?: LambdaTarget;
  readonly browserOrigins: readonly string[];
}

/** The two local gateway servers, injectable without starting an application runtime. */
export function createLocalWebSocketRuntime(options: LocalWebSocketOptions) {
  const executor = options.executor;
  const webSocketRoutes = options.routes;
  const authorizerTarget = options.authorizerTarget;

  interface Connection {
    readonly socket: WebSocket;
    readonly correlation: DevelopmentCorrelation;
    readonly connectedAt: number;
    readonly domainName: string;
    readonly headers: IncomingMessage["headers"];
    readonly authorizer?: Record<string, unknown>;
  }
  const connections = new Map<string, Connection>();
  const socketIds = new WeakMap<WebSocket, string>();
  const routeIds = new WeakMap<DevelopmentCorrelation, string>();
  const markRoute = (correlation: DevelopmentCorrelation, routeKey: string) => {
    if (Object.prototype.hasOwnProperty.call(webSocketRoutes, routeKey)) routeIds.set(correlation, `route:ws:${routeKey}`);
  };
  const observe = (kind: string, correlation: DevelopmentCorrelation, details?: unknown, outcome?: string, level: "info" | "warn" | "error" = "info") => observeDevelopment({ resourceId: "gateway:websocket", kind, correlation, relatedResourceIds: routeIds.has(correlation) ? [routeIds.get(correlation)!] : [], details, outcome, level });
  const errorDetails = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
  const send = (socket: WebSocket, body: string, correlation: DevelopmentCorrelation, source: string) => {
    observe("websocket.push.attempted", correlation, { source, bytes: Buffer.byteLength(body), body: sanitizeDevelopmentValue(body, { contentType: "text/plain", secrets: developmentSecrets() }).value }, "attempted");
    socket.send(body, error => observe(error ? "websocket.push.failed" : "websocket.push.accepted", correlation,
      error ? { error: errorDetails(error) } : { source, completion: "local socket write; browser receipt unobserved" }, error ? "failed" : "accepted", error ? "error" : "info"));
  };


  function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  function rejectHandshake(socket: Duplex, status: 401 | 403 | 404 | 500, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    socket.destroy();
  }

  // =======================================
  //  📥 Connection management — POST/GET/DELETE /@connections/{id}
  //  The same paths API Gateway's Management API serves, optionally under a
  //  stage prefix, so aws-studio/runtime/websocket pushes here locally.
  // =======================================
  const CONNECTION_PATH = /^(?:\/[^/@]+)?\/@connections\/([^/?]+)$/;

  const managementServer = createServer((req, res) => {
    const match = CONNECTION_PATH.exec((req.url ?? "").split("?")[0] ?? "");
    if (!match) {
      json(res, 404, { message: "Not Found" });
      return;
    }
    let connectionId: string;
    try { connectionId = decodeURIComponent(match[1]!); } catch { json(res, 400, { message: "Bad Request" }); return; }
    const diagnosticHeader = req.headers["x-framework-development-observation"];
    let supplied: DevelopmentCorrelation = {};
    if (typeof diagnosticHeader === "string" && diagnosticHeader.length <= 2048) { try { supplied = sanitizeDevelopmentCorrelation(JSON.parse(diagnosticHeader)); } catch { /* Optional evidence only. */ } }
    const correlation = newDevelopmentCorrelation({ ...supplied, connectionId });
    observe("websocket.management.received", correlation, { method: req.method });
    const connection = connections.get(connectionId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      observe("websocket.management.gone", correlation, { method: req.method }, "gone", "warn");
      json(res, 410, { message: "Gone" }, { "x-amzn-errortype": "GoneException" });
      return;
    }

    if (req.method === "GET") {
      json(res, 200, {
        ConnectedAt: new Date(connection.connectedAt).toISOString(),
        Identity: { SourceIp: "127.0.0.1", UserAgent: connection.headers["user-agent"] ?? "" },
        LastActiveAt: new Date().toISOString(),
      });
      return;
    }
    if (req.method === "DELETE") {
      observe("websocket.disconnect.requested", correlation, undefined, "requested");
      connection.socket.close(1000, "Closed by the application");
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      json(res, 405, { message: "Method Not Allowed" });
      return;
    }

    // The body is delivered to the browser exactly as posted, as API Gateway
    // delivers PostToConnection's Data.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      send(connection.socket, Buffer.concat(chunks).toString("utf8"), correlation, "management");
      res.writeHead(200).end();
    });
  });

  // =======================================
  //  🔄 WebSocket Server in "noServer" Mode
  //  Connections are accepted only after $connect (and its authorizer) allow it
  // =======================================
  const server = createServer((_req, res) => json(res, 404, { message: "Not Found" }));
  const wss = new WebSocketServer({ noServer: true });
  const localBrowserOrigins = new Set(options.browserOrigins);

  /**
   * Whether an authorizer result allows the handshake, the way API Gateway
   * decides: an explicit Allow and no Deny. An empty or missing policy is a
   * refusal, not a pass.
   */
  function allowedBy(result: {
    policyDocument?: { Statement?: Array<{ Effect?: string }> };
  }): boolean {
    const statements = result.policyDocument?.Statement ?? [];
    return (
      statements.some((statement) => statement.Effect === "Allow") &&
      !statements.some((statement) => statement.Effect === "Deny")
    );
  }

  server.on("upgrade", async (request, socket, head) => {
    const connectionId = randomUUID();
    const correlation = newDevelopmentCorrelation({ connectionId, requestId: randomUUID() });
    markRoute(correlation, "$connect");
    observe("websocket.connect.received", correlation, { path: (request.url ?? "/").split("?")[0] });
    try {
      if (!Object.keys(webSocketRoutes).length) { observe("websocket.connect.rejected", correlation, { reason: "no-local-routes" }, "rejected", "warn"); rejectHandshake(socket, 404, "Not Found"); return; }
      // `ws` performs no same-origin check of its own, so without this any page
      // in the browser could open a credentialed socket against this server.
      const requestOrigin = request.headers.origin;
      if (requestOrigin && !localBrowserOrigins.has(requestOrigin)) {
        observe("websocket.connect.rejected", correlation, { reason: "origin" }, "rejected", "warn");
        console.warn(`Rejected WebSocket connection from origin: ${requestOrigin}`);
        rejectHandshake(socket, 403, "Forbidden");
        return;
      }

      const domainName = request.headers.host ?? "localhost";
      const requestUrl = new URL(request.url || "/", `http://${domainName}`);
      const singleValueQueryParams: Record<string, string> = {};
      const multiValueQueryParams: Record<string, string[]> = {};
      for (const [key, value] of requestUrl.searchParams.entries()) {
        singleValueQueryParams[key] ??= value;
        (multiValueQueryParams[key] ??= []).push(value);
      }
      const connectedAt = Date.now();

      let authorizer: Record<string, unknown> | undefined;
      if (authorizerTarget) {
        const authorizerEvent = {
          type: "REQUEST",
          methodArn: "arn:aws:execute-api:local:local:local/prod/$connect",
          requestContext: { connectionId, apiId: "local", stage: "prod", routeKey: "$connect", eventType: "CONNECT" },
          queryStringParameters: singleValueQueryParams,
          headers: request.headers as Record<string, string>,
        };
        let result: {
          principalId?: string;
          context?: Record<string, unknown>;
          policyDocument?: { Statement?: Array<{ Effect?: string }> };
        };
        try {
          observe("websocket.authorization.dispatched", correlation, { target: authorizerTarget }, "dispatched");
          result = await executor.invoke(authorizerTarget, authorizerEvent, { observation: correlation });
        } catch (error) {
          // `throw new Error("Unauthorized")` is how an authorizer says 401.
          if (error instanceof Error && error.message === "Unauthorized") {
            observe("websocket.authorization.denied", correlation, { reason: "unauthorized" }, "denied", "warn");
            rejectHandshake(socket, 401, "Unauthorized");
            return;
          }
          throw error;
        }
        if (!allowedBy(result)) {
          observe("websocket.authorization.denied", correlation, { reason: "policy" }, "denied", "warn");
          console.log("❌ Connection rejected by the $connect authorizer.");
          rejectHandshake(socket, 403, "Forbidden");
          return;
        }
        // What AWS attaches to $connect and every later event on the connection.
        observe("websocket.authorization.completed", correlation, { required: true }, "allowed");
        authorizer = { principalId: result.principalId, ...result.context };
      } else observe("websocket.authorization.completed", correlation, { required: false }, "not-required");

      if (webSocketRoutes.$connect) observe("websocket.connect-handler.dispatched", correlation, { target: webSocketRoutes.$connect }, "dispatched");
      const connectResponse = webSocketRoutes.$connect ? await executor.invoke<{ statusCode?: number } | null>(
        webSocketRoutes.$connect,
        createConnectEvent({
          connectionId,
          requestId: correlation.requestId,
          connectedAt,
          domainName,
          headers: request.headers,
          queryStringParameters: singleValueQueryParams,
          multiValueQueryStringParameters: multiValueQueryParams,
          ...(authorizer ? { authorizer } : {}),
        }),
        { observation: correlation },
      ) : null;

      if (webSocketRoutes.$connect) observe("websocket.connect-handler.completed", correlation, { target: webSocketRoutes.$connect, status: connectResponse?.statusCode }, "completed");
      // API Gateway refuses the handshake for any status outside 2xx.
      const status = connectResponse?.statusCode;
      if (status !== undefined && (status < 200 || status > 299)) {
        observe("websocket.connect.rejected", correlation, { reason: "handler-status", status }, "rejected", "warn");
        console.log(`❌ Connection rejected by $connect (status ${status}).`);
        rejectHandshake(socket, 403, "Forbidden");
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        connections.set(connectionId, {
          socket: ws,
          correlation,
          connectedAt,
          domainName,
          headers: request.headers,
          ...(authorizer ? { authorizer } : {}),
        });
        socketIds.set(ws, connectionId);
        observe("websocket.connect.completed", correlation, undefined, "connected");
        wss.emit("connection", ws, request);
      });
    } catch (error) {
      observe("websocket.connect.failed", correlation, { error: errorDetails(error) }, "failed", "error");
      console.error("🚨 Error during $connect:", error);
      rejectHandshake(socket, 500, "Internal Server Error");
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    const connectionId = socketIds.get(ws);
    const connection = connectionId ? connections.get(connectionId) : undefined;
    if (!connectionId || !connection) {
      ws.close(1011, "Missing connection id");
      return;
    }
    const eventOptions = {
      connectionId,
      connectedAt: connection.connectedAt,
      domainName: connection.domainName,
      headers: connection.headers,
      ...(connection.authorizer ? { authorizer: connection.authorizer } : {}),
    };

    ws.on("message", async (message, isBinary) => {
      const messageId = randomUUID();
      const correlation = newDevelopmentCorrelation({ ...connection.correlation, spanId: randomUUID(), parentSpanId: connection.correlation.spanId, requestId: messageId, messageId });
      // Routed as API Gateway routes it: $request.body.action when the message
      // is JSON naming a declared route, $default otherwise — including when it
      // is not JSON at all. The body the handler receives is the message itself.
      const body = message.toString();
      let action: unknown;
      try {
        action = (JSON.parse(body) as { action?: unknown } | null)?.action;
      } catch {
        action = undefined;
      }
      const routeKey =
        typeof action === "string" && Object.prototype.hasOwnProperty.call(webSocketRoutes, action)
          ? (action as keyof typeof webSocketRoutes)
          : "$default";
      const target = webSocketRoutes[routeKey as keyof typeof webSocketRoutes];
      if (target) markRoute(correlation, routeKey);
      observe("websocket.message.received", correlation, { routeKey, target, body: isBinary ? "[binary message omitted]" : sanitizeDevelopmentValue(body, { contentType: "text/plain", secrets: developmentSecrets() }).value });
      if (!target) {
        observe("websocket.route.unmatched", correlation, { routeKey }, "unmatched", "warn");
        send(ws, JSON.stringify({ message: "Forbidden", connectionId, requestId: messageId }), correlation, "route-rejection");
        return;
      }

      try {
        observe("websocket.route.dispatched", correlation, { routeKey, target }, "dispatched");
        const response = await executor.invoke<{ body?: string } | null>(
          target,
          createMessageEvent(routeKey, body, { ...eventOptions, requestId: messageId }),
          { observation: correlation },
        );
        observe("websocket.route.completed", correlation, { routeKey, target }, "completed");
        if (response?.body) send(ws, response.body, correlation, "route-result");
      } catch (error) {
        observe("websocket.route.failed", correlation, { routeKey, target, error: errorDetails(error) }, "failed", "error");
        console.error(`[${target}] WebSocket route invocation failed:`, error);
        if (ws.readyState === WebSocket.OPEN) {
          send(ws, JSON.stringify({ message: "Internal server error", connectionId, requestId: messageId }), correlation, "route-error");
        }
      }
    });

    ws.on("close", async (statusCode, reason) => {
      const correlation = newDevelopmentCorrelation({ ...connection.correlation, spanId: randomUUID(), parentSpanId: connection.correlation.spanId, requestId: randomUUID() });
      markRoute(correlation, "$disconnect");
      observe("websocket.disconnect.observed", correlation, { statusCode, reason: reason.toString() }, "disconnected");
      connections.delete(connectionId);
      if (!webSocketRoutes.$disconnect) return;
      try {
        observe("websocket.disconnect-handler.dispatched", correlation, { target: webSocketRoutes.$disconnect }, "dispatched");
        await executor.invoke(
          webSocketRoutes.$disconnect,
          createDisconnectEvent({ ...eventOptions, requestId: correlation.requestId, statusCode, reason: reason.toString() }),
          { observation: correlation },
        );
        observe("websocket.disconnect-handler.completed", correlation, { target: webSocketRoutes.$disconnect }, "completed");
      } catch (error) {
        // A failing $disconnect is the handler's bug to see, not a reason for the
        // dev server to exit.
        observe("websocket.disconnect-handler.failed", correlation, { error: errorDetails(error) }, "failed", "error");
        console.error(`[${webSocketRoutes.$disconnect}] $disconnect failed:`, error);
      }
    });

    ws.on("error", error => {
      observe("websocket.connection.failed", connection.correlation, { error: errorDetails(error) }, "failed", "error");
      connections.delete(connectionId);
    });
  });

  return { server, managementServer, wss, async close() {
    for (const { socket } of connections.values()) socket.terminate();
    await Promise.all([server, managementServer].map(instance => new Promise<void>(resolve => {
      if (!instance.listening) { resolve(); return; }
      instance.close(() => resolve());
    })));
    wss.close();
  } };
}

if (require.main === module) {
  // Compose supplies these values; dotenv never overwrites its environment.
  env.config({ path: "./.env" });
  validateFrameworkConfig(framework);
  const developmentLogProducer = initializeDevelopmentLogProducer({ component: "websocket-api" });
  const executor = new LocalLambdaExecutor({ config: framework });
  const runtime = createLocalWebSocketRuntime({ executor,
    routes: getWebSocketRoutesIn(framework, "local", localDeployInputs()),
    authorizerTarget: getWebSocketAuthorizerIn(framework, "local", localDeployInputs()),
    browserOrigins: getLocalBrowserOrigins(),
  });
  const port = Number(process.env.PORT) || 8081;
  const connectionsPort = Number(process.env.CONNECTIONS_PORT) || 8082;
  runtime.server.listen(port, () => console.log(`WebSocket server listening on ws://localhost:${port}`));
  runtime.managementServer.listen(connectionsPort, () => console.log(`Connection management on port ${connectionsPort}, Compose network only.`));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(0), 2000); deadline.unref();
    void runtime.close().then(() => executor.close()).then(() => developmentLogProducer.close()).finally(() => process.exit(0));
  });
}

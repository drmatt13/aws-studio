import { encodeDevelopmentCorrelation } from "aws-studio/development-logs";
import http from "node:http";
import express from "express";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  getPublicRoutePath,
  routeAllowsMethod,
  type HttpRouteDefinition,
  type LambdaTarget,
} from "aws-studio/config";
import {
  LocalLambdaExecutor,
  type LambdaInvocationResult,
  type LocalServiceRegistry,
} from "aws-studio/local";
import {
  AuthUnavailableError,
  getAuthenticatedHttpSession,
} from "aws-studio/runtime/auth";
import invokeLambdaFunction, { LAMBDA_PAYLOAD_LIMIT_BYTES } from "./invokeLambdaFunction";
import forwardToContainer from "./proxyToContainer";
import { observeHttpDevelopment, requestDevelopmentCorrelation, setHttpDevelopmentRoute, developmentError } from "./developmentLogs";

/** API Gateway's own bodies, so a client sees one shape in both lanes. */
function unauthorized(res: express.Response): void {
  res.status(401).json({ message: "Unauthorized" });
}

function serviceUnavailable(res: express.Response): void {
  res.status(503).json({ message: "Service Unavailable" });
}

function internalServerError(res: express.Response): void {
  if (!res.headersSent) res.status(500).json({ message: "Internal Server Error" });
}

async function getRequestSession(req: express.Request) {
  return getAuthenticatedHttpSession({
    authorizationHeader: req.header("authorization"),
  });
}

/**
 * Matches API Gateway's path matching rather than Express's defaults: a path is
 * case-sensitive and a trailing slash is a different path. Without this a
 * request that works locally can 404 in AWS.
 */
export function applyApiGatewayRouting(app: express.Express): void {
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
}

/**
 * A declaration that matched the path but not the method hands the request on
 * instead of answering it, because a later declaration may own this method at
 * the same path. Whether anything answers at all is decided once, by
 * {@link registerUnmatchedRouteHandler}.
 */
function handledPreflightOrPassedOn(
  route: HttpRouteDefinition,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): boolean {
  if (req.method.toUpperCase() === "OPTIONS") {
    // The CORS middleware answers real preflights first; this covers a bare
    // OPTIONS to a declared path.
    res.status(204).send("");
    return true;
  }
  if (!routeAllowsMethod(route, req.method)) {
    next();
    return true;
  }
  return false;
}

export function registerLambdaRoute(
  app: express.Express,
  route: HttpRouteDefinition,
  target: LambdaTarget,
  executor: LocalLambdaExecutor,
): void {
  app.all(
    route.path,
    (req, _res, next) => {
      if (routeAllowsMethod(route, req.method)) setHttpDevelopmentRoute(req, `route:http:${route.path}`);
      next();
    },
    // The body reaches the handler as bytes, exactly as API Gateway passes it:
    // no parser decides locally what the handler would have decided in AWS.
    express.raw({ type: () => true, limit: LAMBDA_PAYLOAD_LIMIT_BYTES }),
    async (req, res, next) => {
      if (handledPreflightOrPassedOn(route, req, res, next)) return;

      observeHttpDevelopment(req, "http.route.matched", { route: route.path, method: req.method, target });
      let session: Awaited<ReturnType<typeof getRequestSession>> | undefined;
      try {
        session = route.auth === true ? await getRequestSession(req) : undefined;
      } catch (error) {
        observeHttpDevelopment(req, "http.authorization.failed", { error: developmentError(error) }, { outcome: "unavailable", level: "error" });
        if (error instanceof AuthUnavailableError) {
          console.error(`[routes] ${error.message}`, error.reason);
          serviceUnavailable(res);
          return;
        }
        console.error(`[routes] Authorizing ${route.path} failed:`, error);
        internalServerError(res);
        return;
      }
      if (route.auth === true && !session) {
        observeHttpDevelopment(req, "http.authorization.denied", { target }, { outcome: "denied", level: "warn" });
        unauthorized(res);
        return;
      }

      observeHttpDevelopment(req, "http.authorization.completed", { required: route.auth === true }, { outcome: route.auth ? "allowed" : "not-required" });
      try {
        return await invokeLambdaFunction(
          req,
          res,
          (event: APIGatewayProxyEventV2) =>
            executor.invoke(target, event, { observation: requestDevelopmentCorrelation(req) }) as Promise<LambdaInvocationResult>,
          {
            target,
            requestId: requestDevelopmentCorrelation(req).requestId,
            authorizerJwtClaims: session?.payload ?? undefined,
            routeKey: `${req.method.toUpperCase()} ${route.path}`,
          },
        );
      } catch (error) {
        // The handler's own stack: the child process sends it with the error.
        observeHttpDevelopment(req, "http.integration.failed", { target, error: developmentError(error) }, { outcome: "failed", level: "error" });
        console.error(`[${target}] Invocation failed:`, error);
        internalServerError(res);
      }
    },
  );
}

/** Register config-owned routing; an unavailable Compose upstream answers 502. */
export function registerServiceRoute(
  app: express.Express,
  route: HttpRouteDefinition,
  registry: LocalServiceRegistry,
): void {
  if (route.type !== "service") {
    throw new Error(`Expected a service target, received "${route.type}:${route.target}".`);
  }
  const mountPath = getPublicRoutePath(route.path);

  app.use(mountPath, async (req, res, next) => {
    if (handledPreflightOrPassedOn(route, req, res, next)) return;

    setHttpDevelopmentRoute(req, `route:service:${route.path}`);
    observeHttpDevelopment(req, "http.route.matched", { route: route.path, method: req.method, target: `service:${route.target}` });
    const serviceUrl = registry.getEndpoint(route.target);
    if (!serviceUrl) {
      observeHttpDevelopment(req, "http.integration.unavailable", { target: `service:${route.target}` }, { outcome: "unavailable", level: "warn" });
      console.warn(
        `[routes] ${req.method} ${req.originalUrl} targets service "${route.target}", which is not running. Check docker compose ps.`,
      );
      next();
      return;
    }

    try {
      const session = route.auth === true ? await getRequestSession(req) : undefined;
      if (route.auth === true && !session) {
        observeHttpDevelopment(req, "http.authorization.denied", { target: `service:${route.target}` }, { outcome: "denied", level: "warn" });
        unauthorized(res);
        return;
      }
      observeHttpDevelopment(req, "http.authorization.completed", { required: route.auth === true }, { outcome: route.auth ? "allowed" : "not-required" });
      await forwardToContainer(req, res, serviceUrl, mountPath, `service:${route.target}`);
    } catch (error) {
      if (error instanceof AuthUnavailableError) {
        observeHttpDevelopment(req, "http.authorization.failed", { error: developmentError(error) }, { outcome: "unavailable", level: "error" });
        serviceUnavailable(res);
        return;
      }
      observeHttpDevelopment(req, "http.integration.failed", { target: `service:${route.target}`, error: developmentError(error) }, { outcome: "failed", level: "error" });
      console.error(`Local service proxy error for ${route.target}:`, error);
      if (!res.headersSent) {
        res.status(502).json({
          error: "Bad gateway",
          message: error instanceof Error ? error.message : "Unknown proxy error",
        });
      } else {
        res.destroy();
      }
    }
  });
}

/** What an agent invocation carries through to the runner, and back. */
const AGENT_REQUEST_HEADERS = ["content-type", "authorization", "x-amzn-bedrock-agentcore-runtime-session-id"];
const AGENT_RESPONSE_HEADERS = ["content-type", "cache-control"];

/**
 * The browser's explicitly declared agent path, preserved by the Vite proxy.
 *
 * Verified here as AgentCore's JWT authorizer verifies it in AWS, then
 * streamed through the invocation runner to the agent's session process,
 * whose adapter verifies the token again and binds the session to the user.
 * Server-sent events pass through as the agent yields them.
 */
export function registerAgentRoute(app: express.Express, agentId: string, route: string, runnerUrl: string): void {
  // Match the supported path literally, including characters Express's string
  // route grammar would otherwise interpret as parameters or operators.
  const matcher = new RegExp(`^${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  app.post(matcher, async (req, res) => {
    setHttpDevelopmentRoute(req, `route:agent:${route}`);
    observeHttpDevelopment(req, "http.agent-route.matched", { path: route, target: `agent:${agentId}` });
    let session: Awaited<ReturnType<typeof getRequestSession>>;
    try {
      session = await getRequestSession(req);
    } catch (error) {
      observeHttpDevelopment(req, "http.authorization.failed", { target: `agent:${agentId}`, error: developmentError(error) }, { outcome: "unavailable", level: "error" });
      if (error instanceof AuthUnavailableError) {
        console.error(`[agents] ${error.message}`, error.reason);
        serviceUnavailable(res);
        return;
      }
      throw error;
    }
    if (!session) {
      observeHttpDevelopment(req, "http.authorization.denied", { target: `agent:${agentId}` }, { outcome: "denied", level: "warn" });
      unauthorized(res);
      return;
    }

    observeHttpDevelopment(req, "http.authorization.completed", { required: true }, { outcome: "allowed" });
    observeHttpDevelopment(req, "http.integration.dispatched", { target: `agent:${agentId}`, streaming: true });
    const headers: http.OutgoingHttpHeaders = { "x-framework-development-observation": encodeDevelopmentCorrelation(requestDevelopmentCorrelation(req)) };
    for (const name of AGENT_REQUEST_HEADERS) {
      const value = req.header(name);
      if (value !== undefined) headers[name] = value;
    }
    const upstream = http.request(
      new URL(`/agents/${agentId}/invocations`, runnerUrl),
      { method: "POST", headers },
      (reply) => {
        observeHttpDevelopment(req, "http.integration.response", { target: `agent:${agentId}`, status: reply.statusCode, streaming: true });
        res.status(reply.statusCode ?? 502);
        for (const name of AGENT_RESPONSE_HEADERS) {
          const value = reply.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        reply.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      observeHttpDevelopment(req, "http.integration.failed", { target: `agent:${agentId}`, error: developmentError(error) }, { outcome: "failed", level: "error" });
      console.error(`[agents] agent:${agentId} is unreachable through the invocation runner:`, error);
      if (!res.headersSent) res.status(502).json({ message: "Bad Gateway" });
      else res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  // CloudFront's route function rejects non-POST methods before invocation.
  app.all(matcher, (req, res) => {
    setHttpDevelopmentRoute(req, `route:agent:${route}`);
    observeHttpDevelopment(req, "http.agent-route.rejected", { target: `agent:${agentId}`, method: req.method }, { outcome: "method-not-allowed", level: "warn" });
    res.status(405).json({ message: "Method Not Allowed" });
  });
}

/**
 * The last word on a request no declaration claimed.
 *
 * API Gateway answers an unmatched path *and* an unmatched method on a matched
 * path with the same 404, so this does too rather than inheriting an Express
 * 405 that AWS would never send. The near miss is logged instead, where it
 * helps the developer without changing what the client sees.
 */
export function registerUnmatchedRouteHandler(
  app: express.Express,
  routes: readonly HttpRouteDefinition[],
): void {
  app.use((req, res) => {
    observeHttpDevelopment(req, "http.route.unmatched", { method: req.method, path: req.path }, { outcome: "unmatched", level: "warn" });
    const declaredMethods = routes
      .filter((route) => route.path === req.path)
      .flatMap((route) => (route.methods === "*" ? ["ANY"] : [...route.methods]));
    if (declaredMethods.length > 0) {
      console.warn(
        `[routes] ${req.method} ${req.path} is not declared; ${req.path} serves ${declaredMethods.join(", ")}.`,
      );
    }
    res.status(404).json({ message: "Not Found" });
  });
}

/**
 * The last word on a request that failed before any handler answered it: a
 * body over Lambda's payload limit, or an unexpected error. Registered after
 * everything else, and answering in API Gateway's JSON rather than Express's
 * HTML error page.
 */
export function registerApiGatewayErrorHandler(app: express.Express): void {
  app.use(
    (
      error: { type?: string; status?: number },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      observeHttpDevelopment(req, "http.request.rejected", { error: developmentError(error) }, { outcome: error.type === "entity.too.large" || error.status === 413 ? "payload-too-large" : "failed", level: "error" });
      if (res.headersSent) {
        next(error);
        return;
      }
      if (error.type === "entity.too.large" || error.status === 413) {
        res.status(413).json({ message: "Request Entity Too Large" });
        return;
      }
      console.error("[routes] Request failed:", error);
      res.status(500).json({ message: "Internal Server Error" });
    },
  );
}

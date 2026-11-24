import { randomUUID } from "node:crypto";
import type express from "express";
import {
  newDevelopmentCorrelation,
  observeDevelopment,
  sanitizeDevelopmentValue,
  developmentSecrets,
  developmentSensitiveHttpPath,
  withDevelopmentObservation,
  type DevelopmentCorrelation,
} from "aws-studio/development-logs";

const requests = new WeakMap<
  express.Request,
  { correlation: DevelopmentCorrelation; routeId?: string }
>();
export function requestDevelopmentCorrelation(
  req: express.Request,
): DevelopmentCorrelation {
  let state = requests.get(req);
  if (!state) {
    state = {
      correlation: newDevelopmentCorrelation({ requestId: randomUUID() }),
    };
    requests.set(req, state);
  }
  return state.correlation;
}
export function setHttpDevelopmentRoute(
  req: express.Request,
  routeId: string,
): void {
  requestDevelopmentCorrelation(req);
  requests.get(req)!.routeId = routeId;
}
export function httpDevelopmentRouteIds(req: express.Request): string[] {
  const routeId = requests.get(req)?.routeId;
  return routeId ? [routeId] : [];
}
export function developmentError(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}
export function requestDevelopmentLocation(req: express.Request): unknown {
  try {
    const url = new URL(req.originalUrl, "http://local.invalid");
    return {
      method: req.method,
      path: url.pathname,
      query: developmentSensitiveHttpPath(url.pathname)
        ? "[sensitive query omitted]"
        : Object.fromEntries([...url.searchParams.entries()].slice(0, 32)),
    };
  } catch {
    return { method: req.method, path: "[invalid URL]" };
  }
}
export const sensitiveDevelopmentPath = developmentSensitiveHttpPath;
export function requestDevelopmentBody(req: express.Request): unknown {
  return sanitizeDevelopmentValue(req.body, {
    secrets: developmentSecrets(),
    contentType: req.header("content-type"),
    sensitive: sensitiveDevelopmentPath(req.path),
  }).value;
}
export function observeHttpDevelopment(
  req: express.Request,
  kind: string,
  details?: unknown,
  options: {
    resourceId?: string;
    outcome?: string;
    level?: "info" | "warn" | "error";
  } = {},
): void {
  observeDevelopment({
    resourceId: options.resourceId ?? "gateway:http",
    kind,
    details:
      options.level === "error" && sensitiveDevelopmentPath(req.path)
        ? "[sensitive error details omitted]"
        : details,
    correlation: requestDevelopmentCorrelation(req),
    relatedResourceIds: httpDevelopmentRouteIds(req),
    outcome: options.outcome,
    level: options.level,
  });
}
/** Place before CORS, route matching, body parsing and authorization. */
export function installDevelopmentHttpIngress(app: express.Express): void {
  app.use((req, res, next) => {
    const correlation = requestDevelopmentCorrelation(req);
    const startedAt = Date.now();
    observeHttpDevelopment(
      req,
      "http.request.received",
      requestDevelopmentLocation(req),
    );
    let ended = false;
    const complete = (outcome: "finished" | "aborted") => {
      if (ended) return;
      ended = true;
      observeDevelopment({
        resourceId: "gateway:http",
        kind: `http.response.${outcome}`,
        correlation,
        relatedResourceIds: httpDevelopmentRouteIds(req),
        durationMs: Date.now() - startedAt,
        outcome,
        details: {
          status: res.headersSent ? res.statusCode : undefined,
          headersSent: res.headersSent,
        },
        level:
          res.statusCode >= 500
            ? "error"
            : res.statusCode >= 400
              ? "warn"
              : "info",
      });
    };
    res.once("finish", () => complete("finished"));
    res.once("close", () =>
      complete(res.writableFinished ? "finished" : "aborted"),
    );
    req.once("aborted", () => complete("aborted"));
    withDevelopmentObservation({ correlation }, next);
  });
}

/** Never retain more than the sanitizer's parsing cap or a partial oversized body. */
export function developmentBodySample(
  contentType: string | undefined,
  sensitive: boolean,
) {
  let bytes = 0;
  let chunks: Buffer[] = [];
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  const retain =
    !sensitive &&
    !!type &&
    ([
      "application/json",
      "application/x-www-form-urlencoded",
      "text/plain",
    ].includes(type) ||
      type.endsWith("+json"));
  return {
    push(chunk: Buffer | string) {
      const size = Buffer.byteLength(chunk);
      bytes += size;
      if (!size) return;
      if (retain && bytes <= 64 * 1024) chunks.push(Buffer.from(chunk));
      else chunks = [];
    },
    preview() {
      if (sensitive) return { bytes, preview: "[sensitive payload omitted]" };
      if (!retain)
        return {
          bytes,
          preview: "[body omitted; content type unavailable or unsupported]",
        };
      return bytes > 64 * 1024
        ? { bytes, preview: "[oversized body omitted]" }
        : {
            bytes,
            preview: sanitizeDevelopmentValue(Buffer.concat(chunks), {
              contentType,
              sensitive,
              secrets: developmentSecrets(),
            }).value,
          };
    },
  };
}

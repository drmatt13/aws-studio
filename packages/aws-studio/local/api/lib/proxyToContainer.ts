import { encodeDevelopmentCorrelation } from "aws-studio/development-logs";
import http from "node:http";
import https from "node:https";
import type { Request, Response } from "express";
import { Transform } from "node:stream";
import { developmentBodySample, developmentError, observeHttpDevelopment, requestDevelopmentCorrelation, sensitiveDevelopmentPath } from "./developmentLogs";

type RequestWithRawBody = Request & { rawBody?: Buffer };

export default async function proxyToContainer(
  req: Request,
  res: Response,
  containerUrl: string,
  mountPath: string,
  resourceId = "gateway:http",
): Promise<void> {
  const [browserPathname, originalSearch = ""] = req.originalUrl.split("?");
  const normalizedMount = mountPath.replace(/\/+$/, "");
  // Express includes /api and the service mount in baseUrl. Remove only the
  // outer app mount before applying the service's own mount stripping below.
  const outerMount = normalizedMount === ""
    ? req.baseUrl ?? ""
    : req.baseUrl?.endsWith(normalizedMount)
      ? req.baseUrl.slice(0, -normalizedMount.length)
      : "";
  const originalPathname = outerMount && browserPathname.startsWith(`${outerMount}/`)
    ? browserPathname.slice(outerMount.length)
    : browserPathname;
  const strippedPath =
    originalPathname === normalizedMount
      ? "/"
      : originalPathname.startsWith(`${normalizedMount}/`)
        ? originalPathname.slice(normalizedMount.length)
        : req.path || "/";

  const url = new URL(containerUrl);
  const upstreamBasePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${upstreamBasePath}${strippedPath.startsWith("/") ? strippedPath : `/${strippedPath}`}` || "/";
  url.search = originalSearch ? `?${originalSearch}` : "";

  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (["host", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) continue;
    headers[key] = value;
  }

  const rawBody = (req as RequestWithRawBody).rawBody;
  if (rawBody) headers["content-length"] = rawBody.byteLength;
  headers["x-framework-development-observation"] = encodeDevelopmentCorrelation(requestDevelopmentCorrelation(req));
  const startedAt = Date.now();
  const requestSample = developmentBodySample(String(req.headers["content-type"] ?? ""), sensitiveDevelopmentPath(req.path));
  const observe = (kind: string, details?: unknown, outcome?: string) => {
    observeHttpDevelopment(req, kind, details, { outcome });
    if (resourceId !== "gateway:http") observeHttpDevelopment(req, kind, details, { resourceId, outcome });
  };
  observe("http.service.dispatched", { method: req.method, incomingPath: browserPathname,
    outerMount, mountPath, strippedPath, target: resourceId }, "dispatched");

  console.log("Proxy request:", {
    method: req.method,
    incomingPath: req.originalUrl,
    strippedPath,
    target: url.toString(),
  });

  await new Promise<void>((resolve, reject) => {
    let terminal = false;
    const fail = (error: unknown) => {
      if (terminal) return;
      terminal = true;
      observe("http.service.failed", { target: resourceId, error: developmentError(error) }, "failed");
      reject(error);
    };
    const client = url.protocol === "https:" ? https : http;
    const upstreamRequest = client.request(
      url,
      { method: req.method, headers },
      (upstreamResponse) => {
        observe("http.service.response", { target: resourceId, status: upstreamResponse.statusCode });
        const responseSample = developmentBodySample(String(upstreamResponse.headers["content-type"] ?? ""), sensitiveDevelopmentPath(req.path));
        const responseTap = new Transform({ transform(chunk: Buffer, _encoding, callback) { responseSample.push(chunk); callback(null, chunk); } });
        res.status(upstreamResponse.statusCode ?? 502);
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined || key.toLowerCase() === "transfer-encoding") continue;
          res.setHeader(key, value);
        }
        upstreamResponse.on("error", fail);
        res.on("finish", () => {
          if (terminal) return;
          terminal = true;
          observe("http.service.completed", { target: resourceId, status: res.statusCode,
            durationMs: Date.now() - startedAt, input: requestSample.preview(), output: responseSample.preview() }, "finished");
          resolve();
        });
        upstreamResponse.pipe(responseTap).pipe(res);
      },
    );

    upstreamRequest.on("error", fail);
    const abort = () => {
      if (terminal) return;
      terminal = true;
      observe("http.service.aborted", { target: resourceId, durationMs: Date.now() - startedAt }, "aborted");
      upstreamRequest.destroy();
      resolve();
    };
    req.on("aborted", abort);
    res.on("close", () => {
      if (!res.writableFinished) abort();
    });

    if (rawBody) {
      requestSample.push(rawBody);
      upstreamRequest.end(rawBody);
    } else if (["GET", "HEAD"].includes(req.method.toUpperCase()) || req.readableEnded) {
      upstreamRequest.end();
    } else {
      const requestTap = new Transform({ transform(chunk: Buffer, _encoding, callback) { requestSample.push(chunk); callback(null, chunk); } });
      req.pipe(requestTap).pipe(upstreamRequest);
    }
  });
}

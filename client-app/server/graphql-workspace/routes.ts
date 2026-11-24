import { Router } from "express";
import { sendJson } from "../http";
import { readGraphQLWorkspace } from "./inventory";
import type { GraphQLRuntimeService } from "./runtime";

/** All routes are behind Studio's host, token, origin and protocol guards. */
export function graphqlWorkspaceRouter(root: string, service: GraphQLRuntimeService): Router {
  const router = Router();
  router.get("/workspace", (_request, response) => sendJson(response, () => readGraphQLWorkspace(root)));
  router.get("/runtime", (_request, response) => sendJson(response, () => service.runtime()));
  router.post("/execute", (request, response) => {
    const abort = new AbortController();
    const close = () => { if (!response.writableEnded) abort.abort(); };
    response.once("close", close);
    response.once("finish", () => response.off("close", close));
    sendJson(response, () => service.execute(request.body, abort.signal));
  });
  return router;
}

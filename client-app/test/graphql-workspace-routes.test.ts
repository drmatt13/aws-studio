import assert from "./support/assert";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalRunView } from "../shared/deploy";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { hostGuard, apiGuard } from "../server/guards";
import { graphqlWorkspaceRouter } from "../server/graphql-workspace/routes";
import { GraphQLRuntimeService } from "../server/graphql-workspace/runtime";

test("workspace routes remain offline and execution requires Studio guards before the fixed local relay", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-graphql-workspace-route-")));
  writeFileSync(path.join(root, ".env"), "LOCAL_API_DEV_SERVER_HOST_PORT=12345");
  let reads = 0, sends = 0;
  const runtime = new GraphQLRuntimeService(root, async () => {
    reads++; return { lifecycle: "running", readiness: { state: "ready" }, restartNeeded: [], services: [{ name: "local-api-dev-server", state: "running" }] } as unknown as LocalRunView;
  }, async () => { sends++; return new Response('{"data":{"value":true}}'); });
  const app = express(); let port = 0;
  app.use((req, res, next) => hostGuard(port)(req, res, next));
  app.use(express.json({ limit: "640kb" })); app.use(apiGuard("fixture-studio-token"));
  app.use((req, res, next) => { if (req.method !== "GET" && req.get("x-studio-protocol") !== STUDIO_PROTOCOL_VERSION) { res.status(409).json({ error: "Restart Studio" }); return; } next(); });
  app.use("/api/graphql", graphqlWorkspaceRouter(root, runtime));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/graphql`;
  const headers = { "x-studio-token": "fixture-studio-token", "x-studio-protocol": STUDIO_PROTOCOL_VERSION, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
  const body = JSON.stringify({ document: "query { value }", variables: {}, idToken: "fixture.identity.signature" });
  try {
    assert.equal((await fetch(`${url}/workspace`)).status, 401);
    assert.equal((await fetch(`${url}/workspace`, { headers })).status, 200);
    assert.equal(reads, 0); assert.equal(sends, 0);
    assert.equal((await fetch(`${url}/execute`, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body })).status, 403);
    assert.equal((await fetch(`${url}/execute`, { method: "POST", headers: { ...headers, "x-studio-protocol": "old" }, body })).status, 409);
    assert.equal(sends, 0);
    assert.equal((await (await fetch(`${url}/runtime`, { headers })).json() as { status: string }).status, "ready");
    const result = await fetch(`${url}/execute`, { method: "POST", headers, body });
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json() as { body: unknown }).body, { data: { value: true } });
    assert.equal(sends, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

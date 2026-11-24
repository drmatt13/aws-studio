import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalRunView } from "../shared/deploy";
import { GraphQLRuntimeService, localGraphQLEndpoint, readGraphQLExecuteRequest } from "../server/graphql-workspace/runtime";

const token = "fixture.identity.signature";
const query = { document: "query Value { value }", variables: {}, idToken: token };
const ready = { lifecycle: "running", readiness: { state: "ready" }, restartNeeded: [], services: [{ name: "local-api-dev-server", state: "running", health: "healthy" }] } as unknown as LocalRunView;
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-graphql-runtime-")));
  writeFileSync(path.join(root, ".env"), "LOCAL_API_DEV_SERVER_HOST_PORT=12345\nUNRELATED_PRIVATE_INPUT=private\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("GraphQL execution selects one operation, requires explicit mutation confirmation, and rejects arbitrary proxy inputs", () => {
  assert.equal(readGraphQLExecuteRequest(query).idToken, token);
  for (const input of [
    { ...query, endpoint: "https://untrusted.invalid" }, { ...query, headers: {} },
    { ...query, variables: [] }, { ...query, idToken: "header\nvalue" },
    { ...query, document: "query A { a } query B { b }" },
    { ...query, document: "subscription Feed { changes }" },
    { ...query, document: "mutation Change { change }" },
    { ...query, document: "query {" },
  ]) assert.throws(() => readGraphQLExecuteRequest(input));
  assert.equal(readGraphQLExecuteRequest({ ...query, document: "query A { a } mutation B { b }", operationName: "A" }).operationName, "A");
  assert.equal(readGraphQLExecuteRequest({ ...query, document: "mutation Change { change }", confirmMutation: true }).confirmMutation, true);
});

test("the endpoint uses only a bounded regular exported local port and never follows symlinks", () => {
  const f = fixture();
  try {
    assert.equal(localGraphQLEndpoint(f.root), "http://127.0.0.1:12345/api/graphql");
    for (const port of ["65536", "0", "1234/api/graphql", "https://example.com", "-5"]) {
      writeFileSync(path.join(f.root, ".env"), `LOCAL_API_DEV_SERVER_HOST_PORT=${port}\n`);
      assert.equal(localGraphQLEndpoint(f.root), null);
    }
    rmSync(path.join(f.root, ".env"));
    writeFileSync(path.join(f.root, "other"), "LOCAL_API_DEV_SERVER_HOST_PORT=12345");
    symlinkSync(path.join(f.root, "other"), path.join(f.root, ".env"));
    assert.equal(localGraphQLEndpoint(f.root), null);
  } finally { f.cleanup(); }
});

test("runtime readiness gates all dispatch, forwards only the transient ID token and preserves GraphQL errors", async () => {
  const f = fixture(); let local = ready; let calls = 0;
  const service = new GraphQLRuntimeService(f.root, async () => local, async (url, init) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:12345/api/graphql");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { "content-type": "application/json", accept: "application/graphql-response+json, application/json", authorization: `Bearer ${token}` });
    assert.deepEqual(JSON.parse(init?.body as string), { query: query.document, variables: {} });
    return new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), { status: 401 });
  });
  try {
    local = { ...ready, lifecycle: "off", readiness: { state: "stopped", observedAt: "", message: "Stopped" } };
    assert.equal((await service.runtime()).status, "stopped");
    await assert.rejects(service.execute(query), /Start local runtime/);
    assert.equal(calls, 0);
    local = { ...ready, restartNeeded: ["settings"] };
    await assert.rejects(service.execute(query)); assert.equal(calls, 0);
    local = ready;
    const result = await service.execute(query);
    assert.equal(calls, 1); assert.equal(result.status, 401);
    assert.deepEqual(result.body, { errors: [{ message: "Unauthorized" }] });
    assert.ok(!JSON.stringify(result).includes(token));
  } finally { f.cleanup(); }
});

test("relay refuses concurrent sends, cancels on disconnect and redacts transport errors", async () => {
  const f = fixture();
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const service = new GraphQLRuntimeService(f.root, async () => ready, async (_url, init) => {
    start();
    await new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error(token)), { once: true }));
    return new Response("{}");
  });
  try {
    const abort = new AbortController();
    const first = service.execute(query, abort.signal);
    await started;
    await assert.rejects(service.execute(query), /already running/);
    abort.abort();
    await assert.rejects(first, error => error instanceof Error && /outcome may be unknown/.test(error.message) && !error.message.includes(token));
    const broken = new GraphQLRuntimeService(f.root, async () => ready, async () => { throw new Error(token); });
    await assert.rejects(broken.execute(query), error => error instanceof Error && !error.message.includes(token));
  } finally { f.cleanup(); }
});

test("relay bounds responses and refuses non-JSON and changed export targets", async () => {
  const f = fixture();
  try {
    const large = new GraphQLRuntimeService(f.root, async () => ready, async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await assert.rejects(large.execute(query), /exceeds 2 MiB/);
    const html = new GraphQLRuntimeService(f.root, async () => ready, async () => new Response("<html>failed</html>"));
    await assert.rejects(html.execute(query), /non-JSON/);
    let called = false;
    const changed = new GraphQLRuntimeService(f.root, async () => {
      writeFileSync(path.join(f.root, ".env"), "LOCAL_API_DEV_SERVER_HOST_PORT=12346"); return ready;
    }, async () => { called = true; return new Response("{}"); });
    await assert.rejects(changed.execute(query), /settings changed/);
    assert.equal(called, false);
  } finally { f.cleanup(); }
});

import { fixtureProofIdentity, fixtureDecisionsFor, putRuntimeArtifacts, verifiedEvaluation } from "./support/chain-verification";
import assert from "./support/assert";
import { test } from "node:test";
import express from "express";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer, request as httpRequest } from "node:http";
import { hostGuard, apiGuard } from "../server/guards";
import { STUDIO_PROTOCOL_VERSION } from "../shared/protocol";
import { graphqlChainRouter } from "../server/graphql-chain/routes";
import { GraphQLChainService, PRISMA_FILE, REVIEW_FILE, recordContents } from "../server/graphql-chain/service";
import { fingerprint } from "aws-studio/contract-chain/core";
import { contractGateExitCode } from "aws-studio/contract-chain/ci";
import { readSourceManifest } from "aws-studio/source/workspace";

test("chain HTTP routes guard exact-source review, apply and guided receipt renewal", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-chain-routes-")));
  putRuntimeArtifacts(root);
  const put = (name: string, value: string) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const sdl = "type Query { value: String }";
  const repositoryTest = "packages/database/test/project.test.ts";
  const apiFile = "compute/http/graphql-api/schema/project.ts";
  put(PRISMA_FILE, "// use prisma-8\nmodel Project {\n id Uuid @id\n}\n");
  put(apiFile, "export const ownerCheck = true;\n");
  put(repositoryTest, "export const coversProject = true;\n");
  put("client-app/src/api/generated/schema.graphql", sdl);
  put("client-app/src/api/project/operations.ts", "export const projectKey = ['project'];\n");
  const evaluation = verifiedEvaluation(sdl);
  let evaluations = 0;
  const service = new GraphQLChainService(root, {
    portableIdentity: fixtureProofIdentity,
    identity: async () => fingerprint([Object.fromEntries(Object.entries(readSourceManifest(root).files).filter(([name]) => name !== REVIEW_FILE)), evaluation]),
    evaluate: async () => { evaluations++; return evaluation; },
  });
  const app = express(); let port = 0;
  app.use((request, response, next) => hostGuard(port)(request, response, next));
  app.use(express.json()); app.use(apiGuard("chain-fixture-token"));
  app.use((request, response, next) => { if (request.method !== "GET" && request.get("x-studio-protocol") !== STUDIO_PROTOCOL_VERSION) { response.status(409).json({ error: "Protocol mismatch" }); return; } next(); });
  app.use("/api/graphql/chain", graphqlChainRouter(service));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/api/graphql/chain`;
  const headers = { "x-studio-token": "chain-fixture-token", "x-studio-protocol": STUDIO_PROTOCOL_VERSION, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
  try {
    assert.equal((await fetch(url)).status, 401);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, { headers: { ...headers, host: "untrusted.invalid" } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end();
    });
    assert.equal(wrongHost, 421);
    assert.equal((await fetch(url, { headers: { ...headers, "x-studio-protocol": "16" } })).status, 409);
    const missingProtocol = { ...headers } as Record<string, string>;
    delete missingProtocol["x-studio-protocol"];
    assert.equal((await fetch(url, { headers: missingProtocol })).status, 409);
    assert.equal((await fetch(`${url}?check=unsafe`, { headers })).status, 400);
    const chain = await (await fetch(url, { headers })).json() as { revision: string };
    const renewal = (expectedRevision: string, overrides: Record<string, unknown> = {}) => fetch(`${url}/renew`, {
      method: "POST", headers, body: JSON.stringify({ expectedRevision, stage: "api", run: "stage", ...overrides }),
    });
    assert.equal((await renewal(chain.revision, { decisions: fixtureDecisionsFor({ kind: "api" }) })).status, 400);
    assert.equal((await renewal("a".repeat(64))).status, 409);
    assert.equal((await (await renewal(chain.revision)).json()).status, "remediation-required");
    assert.equal(recordContents(root), null);
    const body = JSON.stringify({ expectedRevision: chain.revision, scope: { kind: "baseline" }, decisions: fixtureDecisionsFor({ kind: "baseline" }) });
    assert.equal((await fetch(`${url}/review`, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body })).status, 403);
    assert.equal((await fetch(`${url}/review`, { method: "POST", headers: { ...headers, "x-studio-protocol": "old" }, body })).status, 409);
    assert.equal((await fetch(`${url}/review`, { method: "POST", headers, body: JSON.stringify({ expectedRevision: chain.revision, scope: { kind: "baseline" }, path: "../other.json" }) })).status, 400);
    const response = await fetch(`${url}/review`, { method: "POST", headers, body }); assert.equal(response.status, 200);
    const plan = await response.json() as { reviewId: string; expectedRevision: string };
    assert.equal(recordContents(root), null);
    assert.equal((await fetch(`${url}/accept`, { method: "POST", headers, body: JSON.stringify({ reviewId: plan.reviewId, expectedRevision: plan.expectedRevision }) })).status, 200);
    assert.ok(recordContents(root)?.includes('"Project"'));
    assert.equal((await fetch(`${url}/accept`, { method: "POST", headers, body: JSON.stringify({ reviewId: plan.reviewId, expectedRevision: plan.expectedRevision }) })).status, 409);

    const approved = await service.load();
    const acceptedRecord = recordContents(root);
    put(repositoryTest, "export const coversProject = true;\n// Additional repository coverage.\n");
    const allPassed = evaluation.verification;
    evaluation.verification = { ...allPassed, api: { status: "failed", diagnostics: [{ code: "REPOSITORY_TEST_FAILED", message: "Project behavior failed." }] } };
    const failed = await service.load();
    assert.deepEqual(failed.nodes.map(node => node.fingerprint), approved.nodes.map(node => node.fingerprint));
    assert.equal((await (await renewal(failed.revision)).json()).status, "remediation-required");
    assert.equal(recordContents(root), acceptedRecord);

    evaluation.verification = allPassed;
    const recovered = await service.load();
    assert.equal(contractGateExitCode(recovered), 0, "passing repository-only edits preserve accepted contract proof");
    assert.equal(recordContents(root), acceptedRecord);

    put("packages/database/src/generated/contract.d.ts", "export interface Contract { changed: true }\n");
    const stale = await service.load();
    assert.deepEqual(stale.links.map(link => link.confidence.status), ["stale", "blocked", "blocked"]);
    assert.deepEqual(stale.nodes.map(node => node.fingerprint), approved.nodes.map(node => node.fingerprint));
    const checkedEvaluations = evaluations;
    const renewed = await renewal(stale.revision);
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json()).status, "recorded");
    assert.notEqual(recordContents(root), acceptedRecord);
    assert.equal(contractGateExitCode(await service.load()), 0, "unchanged downstream stages remain approved with the renewed predecessor");
    assert.equal(evaluations, checkedEvaluations, "a warmed renewal reuses the current independent check");

    const renewedRecord = recordContents(root);
    put(apiFile, "export const ownerCheck = false;\n");
    const changed = await service.load();
    assert.equal((await (await renewal(changed.revision)).json()).status, "remediation-required");
    assert.equal(recordContents(root), renewedRecord);
  } finally { await service.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

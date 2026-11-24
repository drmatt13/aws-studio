import assert from "./support/assert";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startCoordinator } from "../server/operations/coordinator";
import { callIpc, ipcAuthentication, privateEndpoint } from "../server/operations/ipc";
import { OPERATIONS_VERSION } from "../shared/operations";
import { applyWindowsSecurityDescriptor, assertWindowsPrivatePath, captureWindowsSecurityDescriptor, ensureWindowsPrivateDirectory, restrictWindowsOwnedPath } from "aws-studio/cli/windows-security";
import { writePrivateFileSync } from "aws-studio/cli/private-files";

function raw(socket: string, route: string, headers: Record<string, string> = {}, payload?: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: route, agent: false, method: payload === undefined ? "GET" : "POST", headers: { "x-operations-version": String(OPERATIONS_VERSION), ...headers } }, response => {
      let body = "";
      response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; }); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    req.once("error", reject); req.end(payload);
  });
}

test("Windows IPC requires signed requests, refuses replay and binds both directions to the route", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-ipc-auth-"))), state = path.join(root, ".state");
  let coordinator = await startCoordinator(root, state);
  const endpoint = privateEndpoint(root, state);
  try {
    assert.equal((await raw(endpoint.socket, "/ping")).status, 403);
    const auth = ipcAuthentication(endpoint.socket, `operations:${OPERATIONS_VERSION}`);
    const signed = auth.signRequest("GET", "/operations", "");
    const first = await raw(endpoint.socket, "/operations", signed.headers);
    assert.equal(first.status, 200);
    assert.equal(signed.verifyResponse(first.status, first.headers, first.body), "[]");
    assert.notEqual(first.body, "[]", "a pipe relay cannot read the response payload");
    assert.equal((await raw(endpoint.socket, "/operations", signed.headers)).status, 403);
    const wrongPath = auth.signRequest("GET", "/ping", "");
    assert.equal((await raw(endpoint.socket, "/operations", wrongPath.headers)).status, 403);
    const wrongProtocol = ipcAuthentication(endpoint.socket, "agent:1").signRequest("GET", "/operations", "");
    assert.equal((await raw(endpoint.socket, "/operations", wrongProtocol.headers)).status, 403);
    const payload = JSON.stringify({ kind: "framework-check", params: {}, requestKey: "unauthorized-intent" });
    assert.equal((await raw(endpoint.socket, "/submit", {}, payload)).status, 403);
    assert.deepEqual(await callIpc(endpoint.socket, "/operations"), [], "unauthenticated intent performs no acceptance or execution");
    assert.throws(() => signed.verifyResponse(200, first.headers, "[] "), /could not be authenticated/);
    await coordinator.close();
    coordinator = await startCoordinator(root, state);
    assert.equal((await raw(endpoint.socket, "/operations", signed.headers)).status, 403, "the nonce admission journal survives coordinator restart");
  } finally { await coordinator.close(); rmSync(endpoint.directory, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("Windows IPC refuses a server that squats on the expected pipe without its key", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-ipc-squat-"))), endpoint = privateEndpoint(root, path.join(root, ".state"));
  let intercepted = "";
  const server = createServer((request, response) => {
    request.on("data", chunk => { intercepted += String(chunk); });
    request.once("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"pid":123,"version":1}'); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socket, resolve); });
  try {
    await assert.rejects(callIpc(endpoint.socket, "/submit", { private: "private fixture payload" }), /could not be authenticated/);
    assert.ok(intercepted.length > 0);
    assert.equal(intercepted.includes("private fixture payload"), false, "a squatted pipe cannot read private request contents");
  }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(endpoint.directory, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("Windows private state validates real ACLs and preserves bytes while restricting legacy state", { skip: process.platform !== "win32", timeout: 30_000 }, () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-ipc-acl-"))), directory = path.join(root, "private");
  ensureWindowsPrivateDirectory(directory);
  const file = path.join(directory, "record"); writePrivateFileSync(file, "durable recovery evidence");
  const original = captureWindowsSecurityDescriptor(file);
  try {
    applyWindowsSecurityDescriptor(file, `${original}(A;;FR;;;WD)`);
    assert.throws(() => assertWindowsPrivatePath(file), /filesystem permissions/);
    restrictWindowsOwnedPath(file);
    assertWindowsPrivatePath(file);
    assert.equal(readFileSync(file, "utf8"), "durable recovery evidence");
    applyWindowsSecurityDescriptor(file, original);
    // Windows normalizes the advisory AUTO_INHERITED flag when restoring an
    // inherited DACL. Owner, group, protection and every ACE must still match.
    const stableDescriptor = (sddl: string) => sddl.replace(/D:([A-Z]*)/, (_match, flags: string) => `D:${flags.replace("AI", "")}`);
    assert.equal(stableDescriptor(captureWindowsSecurityDescriptor(file)), stableDescriptor(original));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

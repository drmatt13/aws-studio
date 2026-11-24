import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

const directory = path.resolve(__dirname, "support/private-dns-parity");
const fixtureModule = import(pathToFileURL(path.join(directory, "assets/fixture.mjs")).href);
const framingModule = import(pathToFileURL(path.join(directory, "assets/framing.mjs")).href);
const ownIdentity = { project: "unit-fixture", targetId: "lambda:caller", environmentId: "caller-execution", revision: "unit-revision" };
const identityEnvironment = {
  FIXTURE_PROJECT: ownIdentity.project, TARGET_ID: ownIdentity.targetId,
  ENVIRONMENT_ID: ownIdentity.environmentId, POLICY_REVISION: ownIdentity.revision,
};
const unixProtocolSkip = process.platform === "win32"
  ? "Unix socket protocol tests; Windows qualification uses Linux Docker fixture"
  : false;

// This receipt tests protocol admission only. Host tests do not initialize a
// firewall and cannot establish Docker or AWS network parity.
const unitReceipt = () => ({
  schemaVersion: 1, role: "init", revision: ownIdentity.revision,
  rulesSha256: "a".repeat(64), initializedAt: new Date().toISOString(),
  networkNamespace: null, chains: [{ name: "input", hook: "input", policy: "drop" }, { name: "output", hook: "output", policy: "drop" }],
});
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test("fixture supervisor refuses absent, stale and different-namespace policy receipts", async () => {
  const { parsePolicyReceipt, startSupervisor } = await fixtureModule;
  await assert.rejects(startSupervisor({ ...identityEnvironment, PORT: "0" }), /initializer policy receipt is required/);
  const evidence = { networkNamespace: "net:[unit-namespace]" };
  assert.throws(() => parsePolicyReceipt(JSON.stringify({ ...unitReceipt(), revision: "old" }), ownIdentity, evidence), /does not match/);
  assert.throws(() => parsePolicyReceipt(JSON.stringify({ ...unitReceipt(), networkNamespace: "net:[other]" }), ownIdentity, evidence), /namespaces differ/);
  assert.throws(() => parsePolicyReceipt(JSON.stringify({ ...unitReceipt(), initializedAt: "bad-time" }), ownIdentity, evidence), /does not match/);
});

test("control framing rejects invalid versions and oversized partial frames", async () => {
  const { readFrames, encodeFrame, MAX_FRAME_BYTES } = await framingModule;
  for (const payload of [Buffer.from('{"version":2,"type":"register"}\n'), Buffer.alloc(MAX_FRAME_BYTES + 1, 65)]) {
    const stream = new PassThrough();
    let received = 0;
    let error: Error | undefined;
    readFrames(stream, () => { received += 1; }, (value: Error) => { error = value; });
    stream.write(payload);
    assert.equal(received, 0);
    assert.ok(error);
    assert.equal(stream.destroyed, true);
  }
  assert.throws(() => encodeFrame({ version: 1, value: "a".repeat(MAX_FRAME_BYTES) }), /byte limit/);
});

test("UDS registration rejects a wrong launch nonce and a stale execution revision", { skip: unixProtocolSkip }, async (context) => {
  const { startManager, requestJson } = await fixtureModule;
  const temporary = await mkdtemp("/tmp/phz-register-");
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const managementSocket = path.join(temporary, "manager.sock");
  const nonce = "expected-unit-launch-nonce";
  const manager: Server = await startManager({ PORT: "0", MANAGEMENT_SOCKET: managementSocket, EXPECTED_IDENTITIES_JSON: JSON.stringify([{ ...ownIdentity, nonce }]) });
  context.after(() => close(manager));
  for (const [identity, suppliedNonce] of [[ownIdentity, "incorrect-unit-launch-nonce"], [{ ...ownIdentity, revision: "stale" }, nonce]] as const) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(managementSocket);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Invalid registration was not closed.")); }, 1000);
      socket.on("error", reject);
      socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, type: "register", identity, nonce: suppliedNonce })}\n`));
      socket.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }
  assert.deepEqual((await requestJson(`${origin(manager)}/registrations`)).registered, []);
});

test("fixed fixture ALB preserves native paths and endpoint identity; unhealthy backend retains its DNS-independent endpoint", async (context) => {
  const { startBackend, startGateway, requestJson } = await fixtureModule;
  const backend: Server = await startBackend({ PORT: "0", LISTEN_HOST: "127.0.0.1", ENDPOINT_ID: "service:echo", BACKEND_HEALTH: "unhealthy" });
  context.after(() => close(backend));
  const gateway: Server = await startGateway({ PORT: "0", LISTEN_HOST: "127.0.0.1", ENDPOINT_ID: "alb:echo", BACKEND_URL: origin(backend) });
  context.after(() => close(gateway));
  const value = await requestJson(`${origin(gateway)}/hello?from=private-name`);
  assert.equal(value.endpointId, "service:echo");
  assert.equal(value.path, "/hello?from=private-name");
  await assert.rejects(requestJson(`${origin(gateway)}/health`), /Fixture HTTP 503/);
  assert.equal((await requestJson(`${origin(gateway)}/identity`)).endpointId, "service:echo");
});

test("host-only fixture IPC keeps one warm worker and binds UDS runtime identity independently of application input", { timeout: 20_000, skip: unixProtocolSkip }, async (context) => {
  const { startBackend, startSupervisor, startManager, startBroker, requestJson } = await fixtureModule;
  const temporary = await mkdtemp("/tmp/phz-unit-");
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const managementSocket = path.join(temporary, "manager.sock");
  const nonce = "unit-only-registration-nonce";
  const backend: Server = await startBackend({ PORT: "0", LISTEN_HOST: "127.0.0.1", ENDPOINT_ID: "service:echo" });
  const supervisor: Server = await startSupervisor({ ...process.env, ...identityEnvironment, PORT: "0", POLICY_RECEIPT_JSON: JSON.stringify(unitReceipt()) });
  const manager: Server = await startManager({ PORT: "0", MANAGEMENT_SOCKET: managementSocket, EXPECTED_IDENTITIES_JSON: JSON.stringify([{ ...ownIdentity, nonce }]) });
  const broker: Server = await startBroker({ ...identityEnvironment, PORT: "0", MANAGEMENT_SOCKET: managementSocket, REGISTRATION_NONCE: nonce, SUPERVISOR_URL: origin(supervisor) });
  context.after(async () => { await close(broker); await close(manager); await close(supervisor); await close(backend); });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await requestJson(`${origin(broker)}/health`); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal((await requestJson(`${origin(supervisor)}/identity`)).worker, null, "handler is not imported at supervisor startup");
  const probeHash = createHash("sha256").update(await readFile(path.join(directory, "probe.mjs"))).digest("hex");
  const input = {
    schemaVersion: 1, runId: "unit-only", environment: "local", runtime: "host",
    context: { contractHash: "b".repeat(64), fixtureHash: "c".repeat(64), probeHash },
    scenarios: [{ id: "native-http", kind: "http", host: "127.0.0.1", port: (backend.address() as AddressInfo).port, path: "/identity", fresh: true }],
  };
  const endpoint = `${origin(manager)}/invoke?environmentId=${ownIdentity.environmentId}`;
  const first = await requestJson(endpoint, input);
  const second = await requestJson(endpoint, input);
  assert.equal(first.worker.id, second.worker.id);
  assert.equal(first.worker.invocation, 1);
  assert.equal(second.worker.invocation, 2);
  assert.equal(first.result.scenarios[0].http.endpointId, "service:echo");
  const nativeFetch = await requestJson(`${origin(supervisor)}/invoke-native-fetch`, { url: `${origin(backend)}/identity` });
  assert.equal(nativeFetch.worker.id, first.worker.id, "global fetch runs in the same actual warm child");
  assert.equal(nativeFetch.worker.invocation, 3);
  assert.equal(nativeFetch.result.status, "observed");
  assert.equal(nativeFetch.result.http.statusCode, 200);
  assert.equal(nativeFetch.result.http.endpointId, "service:echo");
  assert.ok(Date.parse(first.worker.loadedAt) >= Date.parse(first.policyReceipt.initializedAt));
  assert.deepEqual((await requestJson(`${origin(broker)}/runtime`, { operation: "identity" })).identity, ownIdentity);
  await assert.rejects(requestJson(`${origin(broker)}/runtime`, { operation: "identity", caller: "lambda:another" }), /overrides are forbidden/);
  await assert.rejects(requestJson(`${origin(broker)}/runtime`, { operation: "fetch", url: "http://management/private" }), /Only the fixed/);
  await assert.rejects(requestJson(endpoint, { ...input, targetId: "lambda:another" }), /cannot override targetId/);
  const registrations = await requestJson(`${origin(manager)}/registrations`);
  assert.equal(registrations.registered.length, 1);
  assert.equal(JSON.stringify(registrations).includes(nonce), false);
});

import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import { fork, spawnSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, readlink, writeFile, mkdir, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFrames, writeFrame } from "./framing.mjs";

// These roles exercise the proposed boundary; none is wired into app startup.
const JSON_LIMIT = 1_048_576;
const REQUEST_TIMEOUT = 15_000;
const TABLE = "private_dns_parity";
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const validObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };

export async function processEvidence() {
  const status = await readFile("/proc/self/status", "utf8").catch(() => "");
  const fields = Object.fromEntries(status.split("\n").flatMap(line => /^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):/.test(line) ? [line.split(/:\s*/, 2)] : []));
  return { pid: process.pid, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null, networkNamespace: await readlink("/proc/self/ns/net").catch(() => null), credentials: fields };
}

export function fixtureIdentity(environment = process.env) {
  const identity = { project: environment.FIXTURE_PROJECT ?? environment.RUN_ID, targetId: environment.TARGET_ID, environmentId: environment.ENVIRONMENT_ID ?? environment.TARGET_ID, revision: environment.POLICY_REVISION };
  for (const [name, value] of Object.entries(identity)) if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`Missing or invalid fixture identity ${name}.`);
  return identity;
}

export function parsePolicyReceipt(value, identity, evidence) {
  let receipt;
  try { receipt = JSON.parse(value ?? ""); } catch { throw new Error("A successful initializer policy receipt is required before application startup."); }
  if (!validObject(receipt) || receipt.schemaVersion !== 1 || receipt.role !== "init" || receipt.revision !== identity.revision || !/^[a-f0-9]{64}$/.test(receipt.rulesSha256 ?? "") || !Number.isFinite(Date.parse(receipt.initializedAt))) throw new Error("Initializer policy receipt does not match this execution revision.");
  if (Date.parse(receipt.initializedAt) > Date.now() + 1000) throw new Error("Initializer policy receipt is dated in the future.");
  if (receipt.networkNamespace && evidence.networkNamespace && receipt.networkNamespace !== evidence.networkNamespace) throw new Error("Initializer and application network namespaces differ.");
  return receipt;
}

export async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new Error("Fixture request exceeds its byte limit.");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!validObject(value)) throw new Error("Fixture request must be an object.");
  return value;
}

export async function requestJson(url, input, timeoutMs = REQUEST_TIMEOUT) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") throw new Error("Fixture control transport supports HTTP only.");
  return new Promise((resolve, reject) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const request = http.request(parsed, { method: body === undefined ? "GET" : "POST", agent: false, headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
      let size = 0;
      const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > JSON_LIMIT) response.destroy(new Error("Fixture response exceeds its byte limit.")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) >= 400) reject(new Error(value.error ?? `Fixture HTTP ${response.statusCode}`)); else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Fixture control request timed out.")));
    request.on("error", reject);
    request.end(body);
  });
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  server.once("close", () => { process.off("SIGTERM", stop); process.off("SIGINT", stop); });
  process.stdout.write(`${JSON.stringify({ role: process.argv[2], listening: server.address(), ...(await processEvidence()) })}\n`);
  return server;
}

export async function startBackend(environment = process.env) {
  const endpointId = environment.ENDPOINT_ID ?? "service:fixture";
  const evidence = await processEvidence();
  return listen(http.createServer((request, response) => {
    const unhealthy = environment.BACKEND_HEALTH === "unhealthy";
    json(response, request.url === "/health" && unhealthy ? 503 : 200, { fixture: "private-dns-parity", endpointId, requestId: randomUUID(), method: request.method, path: request.url, hostHeader: request.headers.host ?? null, remoteAddress: request.socket.remoteAddress, ...evidence });
  }), Number(environment.PORT ?? 5000), environment.LISTEN_HOST ?? "0.0.0.0");
}

export async function startGateway(environment = process.env) {
  const upstream = environment.BACKEND_URL ? new URL(environment.BACKEND_URL) : undefined;
  if (upstream && (upstream.protocol !== "http:" || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search)) throw new Error("Gateway requires one fixed HTTP backend origin.");
  const endpointId = environment.ENDPOINT_ID ?? "alb:fixture";
  const excluded = new Set(["connection", "transfer-encoding", "keep-alive", "proxy-connection", "upgrade", "trailer", "te"]);
  return listen(http.createServer((request, response) => {
    if (!upstream) { json(response, 503, { endpointId, error: "No registered fixture backend." }); return; }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !excluded.has(name.toLowerCase())));
    const target = http.request({ hostname: upstream.hostname, port: upstream.port || 80, method: request.method, path: request.url, headers, agent: false }, reply => {
      response.writeHead(reply.statusCode ?? 502, { ...Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !excluded.has(name.toLowerCase()))), "x-private-dns-fixture-alb": endpointId });
      reply.on("error", error => response.destroy(error));
      reply.pipe(response);
    });
    let timedOut = false;
    target.setTimeout(Number(environment.UPSTREAM_TIMEOUT_MS ?? 2000), () => { timedOut = true; target.destroy(new Error("Backend timeout.")); });
    target.on("error", error => { if (!response.headersSent) json(response, timedOut ? 504 : 502, { endpointId, error: errorMessage(error) }); else response.destroy(); });
    request.on("aborted", () => target.destroy());
    request.pipe(target);
  }), Number(environment.PORT ?? 80), environment.LISTEN_HOST ?? "0.0.0.0");
}

export async function startSupervisor(environment = process.env) {
  const identity = fixtureIdentity(environment);
  const evidence = await processEvidence();
  const policyReceipt = parsePolicyReceipt(environment.POLICY_RECEIPT_JSON, identity, evidence);
  let child;
  let worker;
  let load;
  let active;
  let sequence = Promise.resolve();
  let closing = false;
  const terminate = () => { child?.kill("SIGKILL"); child = undefined; worker = undefined; load = undefined; };
  const ensureWorker = async () => {
    if (closing) throw new Error("Fixture supervisor is closing.");
    if (load) return load;
    child = fork(fileURLToPath(new URL("./worker-child.mjs", import.meta.url)), [], { env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout.on("data", chunk => process.stderr.write(chunk)); child.stderr.on("data", chunk => process.stderr.write(chunk));
    const launched = child;
    load = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Worker load timed out.")); terminate(); }, 10_000);
      launched.once("error", error => { clearTimeout(timer); reject(error); });
      launched.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited during load (${code}).`)); });
      launched.on("message", message => {
        if (message?.type === "loaded") { clearTimeout(timer); worker = message.worker; resolve(worker); }
        else if (message?.type === "result" && active?.id === message.id) { worker = message.worker ?? worker; message.ok ? active.resolve(message) : active.reject(new Error(message.error)); }
      });
    });
    launched.once("exit", code => { if (child === launched) { active?.reject(new Error(`Worker exited (${code}).`)); child = undefined; worker = undefined; load = undefined; } });
    return load;
  };
  const invoke = async (input, type = "probe") => {
    // Identity/configuration is supplied by the supervisor, never by a probe.
    for (const field of ["targetId", "caller", "entry", "command", "network", "policyReceipt"]) if (own(input, field)) throw new Error(`Probe cannot override ${field}.`);
    await ensureWorker();
    const id = randomUUID();
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { terminate(); reject(new Error("Worker invocation timed out.")); }, Number(environment.INVOCATION_TIMEOUT_MS ?? 30_000));
      const finish = callback => value => { clearTimeout(timer); active = undefined; callback(value); };
      active = { id, resolve: finish(resolve), reject: finish(reject) };
      child.send({ type, id, input }, error => { if (error && active?.id === id) active.reject(error); });
    });
    const value = { identity, policyReceipt, process: evidence, worker: reply.worker, result: reply.result };
    if (environment.WARM_WORKER === "false") terminate();
    return value;
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/identity")) { json(response, 200, { identity, policyReceipt, process: evidence, worker: worker ?? null }); return; }
      if (request.method !== "POST" || !["/invoke", "/invoke-native-fetch"].includes(request.url)) { json(response, 404, { error: "Unknown fixture supervisor operation." }); return; }
      const input = await readJson(request);
      const result = sequence.then(() => invoke(input, request.url === "/invoke-native-fetch" ? "native-fetch" : "probe")); sequence = result.catch(() => {});
      json(response, 200, await result);
    } catch (error) { json(response, 400, { error: errorMessage(error) }); }
  });
  server.on("close", () => { closing = true; terminate(); });
  return listen(server, Number(environment.PORT ?? 8080), "127.0.0.1");
}

export async function initializePolicy(environment = process.env) {
  if (process.getuid?.() !== 0) throw new Error("The trusted policy initializer must run as container root.");
  const rules = environment.NFT_RULESET_B64 ? Buffer.from(environment.NFT_RULESET_B64, "base64").toString("utf8") : environment.POLICY_FILE ? await readFile(environment.POLICY_FILE, "utf8") : "";
  const table = environment.NFT_TABLE ?? TABLE;
  if (!rules.trim() || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table) || !environment.POLICY_REVISION) throw new Error("A ruleset, safe table name and policy revision are required.");
  for (const args of [["--check", "-f", "-"], ["-f", "-"]]) {
    const result = spawnSync("nft", args, { input: rules, encoding: "utf8", maxBuffer: JSON_LIMIT });
    if (result.error || result.status !== 0) throw new Error(`Policy initialization failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  const inspection = spawnSync("nft", ["--json", "list", "table", "inet", table], { encoding: "utf8", maxBuffer: JSON_LIMIT });
  if (inspection.error || inspection.status !== 0) throw new Error("Installed fixture policy could not be verified.");
  const entries = JSON.parse(inspection.stdout).nftables ?? [];
  const chains = entries.flatMap(entry => entry.chain ? [{ name: entry.chain.name, hook: entry.chain.hook, policy: entry.chain.policy }] : []);
  for (const hook of ["input", "output"]) if (!chains.some(chain => chain.hook === hook && chain.policy === "drop")) throw new Error(`Installed policy lacks a default-deny ${hook} chain.`);
  const receipt = { schemaVersion: 1, role: "init", revision: environment.POLICY_REVISION, rulesSha256: createHash("sha256").update(rules).digest("hex"), initializedAt: new Date().toISOString(), networkNamespace: await readlink("/proc/self/ns/net"), chains };
  if (environment.POLICY_READY_FILE) { await mkdir(path.dirname(environment.POLICY_READY_FILE), { recursive: true }); await writeFile(environment.POLICY_READY_FILE, JSON.stringify(receipt), { mode: 0o600 }); }
  return receipt;
}

export async function startBroker(environment = process.env) {
  const identity = fixtureIdentity(environment);
  const evidence = await processEvidence();
  if (!environment.MANAGEMENT_SOCKET || !environment.REGISTRATION_NONCE) throw new Error("Broker requires its management socket and launch nonce.");
  const supervisor = new URL(environment.SUPERVISOR_URL ?? "http://127.0.0.1:8080");
  if (supervisor.protocol !== "http:" || supervisor.hostname !== "127.0.0.1" || supervisor.pathname !== "/") throw new Error("Supervisor must be a fixed loopback HTTP origin.");
  let channel;
  let registered = false;
  let stopped = false;
  let retry;
  const pending = new Map();
  const connect = () => {
    if (stopped) return;
    channel = net.createConnection(environment.MANAGEMENT_SOCKET);
    const socket = channel;
    socket.on("error", () => {});
    socket.once("connect", () => writeFrame(socket, { type: "register", identity, nonce: environment.REGISTRATION_NONCE, process: evidence }));
    readFrames(socket, frame => {
      if (frame.type === "registered") { registered = true; return; }
      if (!registered) { socket.destroy(); return; }
      if (frame.type === "invoke" && typeof frame.id === "string" && validObject(frame.input)) {
        void requestJson(new URL("/invoke", supervisor), frame.input).then(value => writeFrame(socket, { type: "result", id: frame.id, ok: true, value }), error => writeFrame(socket, { type: "result", id: frame.id, ok: false, error: errorMessage(error) })).catch(() => {});
      } else if (frame.type === "runtime-result" && typeof frame.id === "string") {
        const item = pending.get(frame.id);
        if (!item) return;
        pending.delete(frame.id); clearTimeout(item.timer);
        frame.ok ? item.resolve(frame.value) : item.reject(new Error(frame.error ?? "Runtime request denied."));
      } else socket.destroy();
    });
    socket.once("close", () => { registered = false; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Management channel disconnected.")); } pending.clear(); if (!stopped) retry = setTimeout(connect, 500); });
  };
  connect();
  const runtime = (input) => {
    if (!registered) throw new Error("Management channel is unavailable.");
    if (input.operation !== "identity" || Object.keys(input).some(key => key !== "operation")) throw new Error("Only the fixed own-identity fixture method is supported; caller and transport overrides are forbidden.");
    if (pending.size >= 32) throw new Error("Too many pending runtime requests.");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Runtime request timed out.")); }, 5000);
      pending.set(id, { resolve, reject, timer });
      try { writeFrame(channel, { type: "runtime", id, input }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/identity")) { json(response, registered ? 200 : 503, { identity, registered, process: evidence }); return; }
      if (request.method !== "POST" || request.url !== "/runtime") { json(response, 404, { error: "Unknown fixture broker operation." }); return; }
      json(response, 200, await runtime(await readJson(request)));
    } catch (error) { json(response, 403, { error: errorMessage(error) }); }
  });
  server.on("close", () => { stopped = true; clearTimeout(retry); channel?.destroy(); });
  return listen(server, Number(environment.PORT ?? 8099), "127.0.0.1");
}

const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function startManager(environment = process.env) {
  const inventory = JSON.parse(environment.EXPECTED_IDENTITIES_JSON ?? "[]");
  if (!Array.isArray(inventory) || !inventory.length || !environment.MANAGEMENT_SOCKET) throw new Error("Manager requires an explicit fixture registration inventory and socket.");
  const expected = new Map();
  for (const registration of inventory) {
    const identity = fixtureIdentity({ FIXTURE_PROJECT: registration.project, TARGET_ID: registration.targetId, ENVIRONMENT_ID: registration.environmentId, POLICY_REVISION: registration.revision });
    if (typeof registration.nonce !== "string" || registration.nonce.length < 16 || expected.has(identity.environmentId)) throw new Error("Manager registration inventory is invalid or ambiguous.");
    expected.set(identity.environmentId, { identity, nonce: registration.nonce });
  }
  const connections = new Map();
  const pending = new Map();
  const sockets = new Set();
  await mkdir(path.dirname(environment.MANAGEMENT_SOCKET), { recursive: true });
  await unlink(environment.MANAGEMENT_SOCKET).catch(error => { if (error.code !== "ENOENT") throw error; });
  const manager = net.createServer(socket => {
    sockets.add(socket);
    let identity;
    readFrames(socket, frame => {
      if (!identity) {
        const supplied = frame.identity;
        const registration = validObject(supplied) ? expected.get(supplied.environmentId) : undefined;
        if (frame.type !== "register" || !registration || !safeEqual(frame.nonce, registration.nonce) || ["project", "targetId", "environmentId", "revision"].some(key => supplied[key] !== registration.identity[key]) || connections.has(supplied.environmentId)) { socket.destroy(); return; }
        identity = registration.identity;
        connections.set(identity.environmentId, { socket, identity, process: frame.process });
        writeFrame(socket, { type: "registered" });
        return;
      }
      if (frame.type === "result" && typeof frame.id === "string") {
        const item = pending.get(frame.id);
        if (!item || item.environmentId !== identity.environmentId) { socket.destroy(); return; }
        pending.delete(frame.id); clearTimeout(item.timer);
        frame.ok ? item.resolve(frame.value) : item.reject(new Error(frame.error ?? "Fixture worker failed."));
      } else if (frame.type === "runtime" && typeof frame.id === "string") {
        const allowed = validObject(frame.input) && frame.input.operation === "identity" && Object.keys(frame.input).every(key => key === "operation");
        writeFrame(socket, { type: "runtime-result", id: frame.id, ok: allowed, ...(allowed ? { value: { identity, adapter: "fixture-own-identity-only" } } : { error: "Fixture runtime capability denied." }) });
      } else socket.destroy();
    });
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      if (identity && connections.get(identity.environmentId)?.socket === socket) connections.delete(identity.environmentId);
      for (const [id, item] of pending) if (item.environmentId === identity?.environmentId) { clearTimeout(item.timer); item.reject(new Error("Fixture broker disconnected.")); pending.delete(id); }
    });
  });
  await new Promise((resolve, reject) => { manager.once("error", reject); manager.listen(environment.MANAGEMENT_SOCKET, resolve); });
  // Only trusted managers/anchors mount this volume; nonce authentication still
  // binds each connection. The application has no filesystem path to this socket.
  await chmod(environment.MANAGEMENT_SOCKET, 0o666);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && (request.url === "/health" || request.url === "/registrations")) { json(response, 200, { registered: [...connections.values()].map(({ identity, process: evidence }) => ({ identity, process: evidence })) }); return; }
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method !== "POST" || url.pathname !== "/invoke") { json(response, 404, { error: "Unknown manager operation." }); return; }
      const input = await readJson(request);
      const environmentId = url.searchParams.get("environmentId");
      const registration = connections.get(environmentId);
      if (!registration) throw new Error("A registered execution environment is required.");
      const value = await new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture invocation timed out.")); }, 30_000);
        pending.set(id, { resolve, reject, timer, environmentId });
        try { writeFrame(registration.socket, { type: "invoke", id, input }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
      json(response, 200, value);
    } catch (error) { json(response, 400, { error: errorMessage(error) }); }
  });
  server.on("close", () => { for (const socket of sockets) socket.destroy(); manager.close(); });
  return listen(server, Number(environment.PORT ?? 7070), "127.0.0.1");
}

async function startUdp(environment) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, peer) => socket.send(Buffer.from(JSON.stringify({ endpointId: environment.ENDPOINT_ID ?? "udp:fixture", payload: message.toString("utf8") })), peer.port, peer.address));
  socket.bind(Number(environment.PORT ?? 5050), environment.LISTEN_HOST ?? "0.0.0.0");
  process.once("SIGTERM", () => socket.close(() => process.exit(0)));
  return socket;
}

export async function startAnchor() {
  // An empty namespace owner has no management channel, socket mount, listener,
  // or application handler. The trusted initializer runs before applications join.
  const timer = setInterval(() => {}, 60_000);
  const stop = () => { clearInterval(timer); process.exit(0); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  process.stdout.write(`${JSON.stringify({ role: "anchor", ...(await processEvidence()) })}\n`);
  return timer;
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const [role, ...options] = args;
  if (role === "backend") return startBackend(environment);
  if (role === "gateway") return startGateway(environment);
  if (role === "supervisor" || role === "probe") return startSupervisor(environment);
  if (role === "broker") return startBroker(environment);
  if (role === "anchor") return startAnchor();
  if (role === "manager") return startManager(environment);
  if (role === "udp") return startUdp(environment);
  if (role === "init") { const receipt = await initializePolicy(environment); process.stdout.write(`${JSON.stringify(receipt)}\n`); return receipt; }
  if (role === "control") {
    const option = name => { const index = options.indexOf(name); return index < 0 ? undefined : options[index + 1]; };
    const input = options.includes("--input") ? JSON.parse(option("--input")) : undefined;
    const result = await requestJson(`http://127.0.0.1:${option("--port") ?? 8080}${option("--path") ?? "/identity"}`, input, Number(option("--timeout") ?? REQUEST_TIMEOUT));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  throw new Error("Unknown phase-zero fixture role.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ error: errorMessage(error) })}\n`); process.exitCode = 1; });
}

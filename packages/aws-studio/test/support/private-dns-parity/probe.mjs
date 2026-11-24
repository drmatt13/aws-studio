/**
 * Phase 0 only: the same dependency-free probe bytes run in Docker and Lambda.
 * Observed results are evidence, never a claim that a scenario passed.
 */
import { createHash, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 };
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([name, id]) => [id, name]));
const RCODES = ["NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED"];
const MAX_BODY_BYTES = 65_536;

function errorInfo(error) {
  return { code: typeof error?.code === "string" ? error.code : "PROBE_ERROR", message: String(error?.message ?? error).slice(0, 500) };
}

function timeoutError() { return Object.assign(new Error("Probe deadline exceeded"), { code: "ETIMEDOUT" }); }

function timeoutFor(scenario) {
  const value = scenario.timeoutMs ?? 3_000;
  if (!Number.isInteger(value) || value < 50 || value > 75_000) throw new Error("timeoutMs must be an integer from 50 through 75000");
  return value;
}

function requirePort(value, fallback) {
  const port = value ?? fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid probe port");
  return port;
}

function encodeName(name) {
  const labels = name.replace(/\.$/, "").split(".");
  if (!labels.length || labels.some(label => !/^[a-zA-Z0-9_-]{1,63}$/.test(label))) throw new Error("DNS probe requires an ASCII DNS name");
  const encoded = Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "ascii")])), Buffer.from([0])]);
  if (encoded.length > 255) throw new Error("DNS name exceeds 255 wire bytes");
  return encoded;
}

function decodeName(packet, start) {
  let offset = start;
  let end;
  let wireLength = 1;
  const labels = [];
  const visited = new Set();
  for (let count = 0; count < 128; count++) {
    if (offset >= packet.length || visited.has(offset)) throw new Error("Invalid DNS name compression");
    visited.add(offset);
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error("Truncated DNS pointer");
      end ??= offset + 2;
      offset = ((length & 0x3f) << 8) | packet[offset + 1];
      continue;
    }
    if ((length & 0xc0) !== 0 || offset + 1 + length > packet.length) throw new Error("Invalid DNS label");
    offset++;
    if (length === 0) return { name: `${labels.join(".").toLowerCase()}.`, end: end ?? offset };
    wireLength += length + 1;
    if (wireLength > 255) throw new Error("Decoded DNS name exceeds 255 wire bytes");
    labels.push(packet.toString("ascii", offset, offset + length));
    offset += length;
  }
  throw new Error("DNS name exceeds parser bounds");
}

/** Exported for malformed-packet tests; this is deliberately not a DNS server. */
export function decodeDnsPacket(packet, expectedId) {
  if (!Buffer.isBuffer(packet) || packet.length < 12) throw new Error("Truncated DNS header");
  if (packet.readUInt16BE(0) !== expectedId) throw new Error("DNS transaction ID mismatch");
  const bits = packet.readUInt16BE(2);
  if (!(bits & 0x8000)) throw new Error("DNS message is not a response");
  const counts = [4, 6, 8, 10].map(offset => packet.readUInt16BE(offset));
  if (counts.reduce((a, b) => a + b, 0) > 1024) throw new Error("DNS record count exceeds parser bounds");
  let offset = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const name = decodeName(packet, offset); offset = name.end;
    if (offset + 4 > packet.length) throw new Error("Truncated DNS question");
    questions.push({ name: name.name, type: TYPE_NAMES[packet.readUInt16BE(offset)] ?? `TYPE${packet.readUInt16BE(offset)}`, class: packet.readUInt16BE(offset + 2) });
    offset += 4;
  }
  const sections = [];
  for (const count of counts.slice(1)) {
    const records = [];
    for (let i = 0; i < count; i++) {
      const name = decodeName(packet, offset); offset = name.end;
      if (offset + 10 > packet.length) throw new Error("Truncated DNS record");
      const type = packet.readUInt16BE(offset), dnsClass = packet.readUInt16BE(offset + 2), ttl = packet.readUInt32BE(offset + 4), length = packet.readUInt16BE(offset + 8);
      offset += 10;
      const end = offset + length;
      if (end > packet.length) throw new Error("Truncated DNS record data");
      let data;
      if (type === TYPES.A) {
        if (length !== 4) throw new Error("Invalid DNS A RDATA length");
        data = [...packet.subarray(offset, end)].join(".");
      } else if (type === TYPES.AAAA) {
        if (length !== 16) throw new Error("Invalid DNS AAAA RDATA length");
        data = Array.from({ length: 8 }, (_, n) => packet.readUInt16BE(offset + n * 2).toString(16)).join(":");
      }
      else if (type === TYPES.NS || type === TYPES.CNAME) {
        const decoded = decodeName(packet, offset);
        if (decoded.end !== end) throw new Error("Invalid DNS name RDATA length");
        data = decoded.name;
      } else if (type === TYPES.SOA) {
        const primary = decodeName(packet, offset), mailbox = decodeName(packet, primary.end);
        if (mailbox.end + 20 !== end) throw new Error("Invalid DNS SOA length");
        data = { primaryNameServer: primary.name, responsibleMailbox: mailbox.name, serial: packet.readUInt32BE(mailbox.end), refresh: packet.readUInt32BE(mailbox.end + 4), retry: packet.readUInt32BE(mailbox.end + 8), expire: packet.readUInt32BE(mailbox.end + 12), minimum: packet.readUInt32BE(mailbox.end + 16) };
      } else if (type === TYPES.TXT) {
        data = [];
        for (let cursor = offset; cursor < end;) {
          const size = packet[cursor++];
          if (cursor + size > end) throw new Error("Invalid DNS TXT length");
          data.push(packet.toString("utf8", cursor, cursor + size)); cursor += size;
        }
      } else data = packet.subarray(offset, end).toString("hex");
      records.push({ name: name.name, type: TYPE_NAMES[type] ?? `TYPE${type}`, class: dnsClass, ttl, data });
      offset = end;
    }
    sections.push(records);
  }
  return { rcode: RCODES[bits & 15] ?? `RCODE${bits & 15}`, flags: { aa: Boolean(bits & 0x400), tc: Boolean(bits & 0x200), rd: Boolean(bits & 0x100), ra: Boolean(bits & 0x80), ad: Boolean(bits & 0x20), cd: Boolean(bits & 0x10) }, questions, answers: sections[0], authority: sections[1], additional: sections[2] };
}

function resolverFor(scenario) {
  if (scenario.resolver) {
    if (!net.isIP(scenario.resolver.host)) throw new Error("Explicit resolver must be an IP address");
    return { host: scenario.resolver.host, port: requirePort(scenario.resolver.port, 53) };
  }
  const server = dns.getServers()[0];
  if (!server || !net.isIP(server)) throw new Error("Default resolver is not a plain IP; supply an explicit resolver");
  return { host: server, port: 53 };
}

async function dnsProbe(scenario) {
  const type = TYPES[scenario.dnsType ?? "A"];
  if (!type || !["udp", "tcp"].includes(scenario.transport ?? "udp")) throw new Error("Unsupported DNS type or transport");
  const resolver = resolverFor(scenario), id = randomBytes(2).readUInt16BE(0), header = Buffer.alloc(12), question = Buffer.alloc(4);
  header.writeUInt16BE(id, 0); header.writeUInt16BE(0x100, 2); header.writeUInt16BE(1, 4);
  question.writeUInt16BE(type, 0); question.writeUInt16BE(1, 2);
  const query = Buffer.concat([header, encodeName(scenario.host), question]);
  const packet = await new Promise((resolve, reject) => {
    const tcp = scenario.transport === "tcp";
    const socket = tcp ? new net.Socket() : dgram.createSocket(net.isIP(resolver.host) === 6 ? "udp6" : "udp4");
    let done = false, chunks = Buffer.alloc(0);
    const timer = setTimeout(() => finish(timeoutError()), timeoutFor(scenario));
    function finish(error, result) {
      if (done) return; done = true; clearTimeout(timer);
      if (tcp) socket.destroy(); else { try { socket.close(); } catch {} }
      if (error) reject(error); else resolve(result);
    }
    socket.on("error", error => finish(error));
    if (tcp) {
      socket.on("data", chunk => {
        chunks = Buffer.concat([chunks, chunk]);
        if (chunks.length > 65537) return finish(new Error("DNS TCP frame exceeds 65535 bytes"));
        if (chunks.length >= 2 && chunks.length >= chunks.readUInt16BE(0) + 2) finish(undefined, chunks.subarray(2, chunks.readUInt16BE(0) + 2));
      });
      socket.on("end", () => { if (!done) finish(new Error("DNS TCP stream ended before a complete response")); });
      socket.connect(resolver.port, resolver.host, () => { const size = Buffer.alloc(2); size.writeUInt16BE(query.length); socket.write(Buffer.concat([size, query])); });
    } else {
      socket.on("message", (message, remote) => { if (remote.address === resolver.host && remote.port === resolver.port && message.length >= 2 && message.readUInt16BE(0) === id) finish(undefined, message); });
      socket.send(query, resolver.port, resolver.host, error => { if (error) finish(error); });
    }
  });
  const decoded = decodeDnsPacket(packet, id);
  if (decoded.questions.length !== 1 || decoded.questions[0].name !== `${scenario.host.replace(/\.$/, "").toLowerCase()}.` || decoded.questions[0].type !== (scenario.dnsType ?? "A") || decoded.questions[0].class !== 1) throw new Error("DNS response question mismatch");
  return { transport: scenario.transport ?? "udp", resolver, ...decoded };
}

async function tcpProbe(scenario) {
  const port = requirePort(scenario.port, 80);
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const timer = setTimeout(() => finish({ outcome: "timeout", error: errorInfo(timeoutError()) }), timeoutFor(scenario));
    function finish(value) { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); }
    socket.on("error", error => finish({ outcome: error.code === "ETIMEDOUT" ? "timeout" : error.code === "ECONNREFUSED" ? "refused" : "error", error: errorInfo(error) }));
    socket.connect({ host: scenario.host, port, family: 4 }, () => finish({ outcome: "connected", remoteAddress: socket.remoteAddress, remotePort: socket.remotePort }));
  });
}

async function httpProbe(scenario) {
  if (scenario.url || scenario.headers || scenario.body) throw new Error("Phase 0 supports bounded HTTP GET/HEAD without custom headers or bodies");
  const method = scenario.method ?? "GET";
  if (!["GET", "HEAD"].includes(method) || !(scenario.path ?? "/identity").startsWith("/")) throw new Error("Unsupported Phase 0 HTTP method or path");
  return new Promise(resolve => {
    let settled = false;
    const request = http.request({ host: scenario.host, port: requirePort(scenario.port, 80), path: scenario.path ?? "/identity", method, family: 4, agent: false, headers: { connection: "close" } });
    const timer = setTimeout(() => request.destroy(timeoutError()), timeoutFor(scenario));
    function finish(value) { if (settled) return; settled = true; clearTimeout(timer); resolve(value); }
    request.on("response", response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) request.destroy(new Error("HTTP body exceeds Phase 0 evidence limit")); else chunks.push(chunk); });
      response.on("error", error => finish({ outcome: "error", error: errorInfo(error) }));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8"); let json;
        try { json = JSON.parse(body); } catch {}
        finish({ outcome: "response", statusCode: response.statusCode, body, bodySha256: createHash("sha256").update(body).digest("hex"), ...(json && typeof json === "object" && !Array.isArray(json) ? { json, ...(typeof json.endpointId === "string" ? { endpointId: json.endpointId } : {}) } : {}), headers: { contentType: response.headers["content-type"] ?? null, location: response.headers.location ?? null }, remoteAddress: response.socket.remoteAddress });
      });
    });
    request.on("error", error => finish({ outcome: "error", error: errorInfo(error) }));
    request.end();
  });
}

export async function runProbe(input) {
  if (!input || input.schemaVersion !== 1 || !["local", "aws"].includes(input.environment) || typeof input.runId !== "string" || !input.runId || !input.context || !["contractHash", "fixtureHash", "probeHash"].every(key => /^[a-f0-9]{64}$/.test(input.context[key] ?? ""))) throw new Error("Invalid Phase 0 probe context");
  if (!["docker", "lambda", "host"].includes(input.runtime) || !Array.isArray(input.scenarios) || !input.scenarios.length || input.scenarios.length > 100) throw new Error("Invalid Phase 0 probe runtime/scenarios");
  if (new Set(input.scenarios.map(scenario => scenario.id)).size !== input.scenarios.length) throw new Error("Duplicate scenario IDs");
  const sourceHash = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
  if (input.context.probeHash !== sourceHash) throw new Error("Probe source bytes do not match the requested evidence context");
  const execution = process.env.AWS_EXECUTION_ENV?.startsWith("AWS_Lambda_") && process.env.AWS_LAMBDA_FUNCTION_NAME ? "lambda" : existsSync("/.dockerenv") ? "docker" : "host";
  if (input.runtime !== execution) throw new Error(`Requested ${input.runtime} runtime does not match detected ${execution} execution`);
  const startedAt = new Date().toISOString(), scenarios = [];
  for (const scenario of input.scenarios) {
    const started = performance.now();
    const base = { id: scenario.id, kind: scenario.kind, request: scenario };
    try {
      if (typeof scenario.id !== "string" || !scenario.id || typeof scenario.host !== "string" || !scenario.host) throw new Error("Scenario requires id and host");
      timeoutFor(scenario);
      if (scenario.kind === "dns") scenarios.push({ ...base, status: "observed", dns: await dnsProbe(scenario), durationMs: performance.now() - started });
      else if (scenario.kind === "tcp") scenarios.push({ ...base, status: "observed", tcp: await tcpProbe(scenario), durationMs: performance.now() - started });
      else if (scenario.kind === "http") scenarios.push({ ...base, status: "observed", http: await httpProbe(scenario), durationMs: performance.now() - started });
      else scenarios.push({ ...base, status: "unsupported", error: { code: "UNSUPPORTED_PROBE", message: "Phase 0 supports dns, tcp, and HTTP GET/HEAD probes" }, durationMs: performance.now() - started });
    } catch (error) { scenarios.push({ ...base, status: "error", error: errorInfo(error), durationMs: performance.now() - started }); }
  }
  return { schemaVersion: 1, runId: input.runId, environment: input.environment, context: input.context, runtime: { execution, node: process.version, platform: process.platform, arch: process.arch }, startedAt, completedAt: new Date().toISOString(), scenarios };
}

export const handler = runProbe;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const index = process.argv.indexOf("--input");
    if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node probe.mjs --input <JSON or JSON-file>");
    const value = process.argv[index + 1], input = JSON.parse(value.startsWith("{") ? value : await readFile(value, "utf8"));
    process.stdout.write(`${JSON.stringify(await runProbe(input))}\n`);
  } catch (error) { process.stderr.write(`${errorInfo(error).message}\n`); process.exitCode = 1; }
}

import { createHash, randomUUID } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// This module deliberately does not replace fetch, DNS, sockets, or HTTP clients.
// It loads the same probe as the AWS fixture after the supervisor's policy gate.
const workerId = randomUUID();
const source = await Promise.all([readFile(fileURLToPath(import.meta.url)), readFile(new URL("../probe.mjs", import.meta.url))]);
const sourceFingerprint = createHash("sha256").update(Buffer.concat(source)).digest("hex");
const { runProbe } = await import("../probe.mjs");
const loadedAt = new Date().toISOString();
const namespace = await readlink("/proc/self/ns/net").catch(() => null);
let invocation = 0;
let busy = false;
const metadata = () => ({ id: workerId, pid: process.pid, uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null, networkNamespace: namespace, sourceFingerprint, loadedAt, invocation });

async function nativeFetch(input) {
  if (!input || typeof input.url !== "string" || Object.keys(input).some(key => !["url", "timeoutMs"].includes(key))) throw new Error("Native fetch accepts only url and timeoutMs.");
  const url = new URL(input.url);
  if (url.protocol !== "http:" || url.username || url.password) throw new Error("The phase-zero native fetch path supports an HTTP URL without credentials.");
  const timeoutMs = input.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 75_000) throw new Error("Invalid native fetch timeout.");
  try {
    // Exercise Node's actual global implementation in this warm handler process.
    // No dispatcher, DNS function, socket implementation, or global is replaced.
    const response = await fetch(url, { redirect: "manual", headers: { connection: "close" }, signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const next = reader ? await reader.read() : { done: true };
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new Error("Native fetch response exceeds the fixture byte limit."); }
      chunks.push(Buffer.from(next.value));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    let json;
    try { json = JSON.parse(body); } catch { /* The HTTP body need not be JSON. */ }
    return { operation: "native-fetch", status: "observed", request: { url: url.href }, http: { statusCode: response.status, endpointId: typeof json?.endpointId === "string" ? json.endpointId : null, body, json: json ?? null } };
  } catch (error) {
    return { operation: "native-fetch", status: "error", request: { url: url.href }, error: { name: error?.name ?? "Error", message: String(error?.message ?? error), code: error?.cause?.code ?? error?.code ?? null } };
  }
}

process.send?.({ type: "loaded", worker: metadata() });
process.on("disconnect", () => process.exit(0));
process.on("message", async (message) => {
  if (!message || !["probe", "native-fetch"].includes(message.type) || typeof message.id !== "string") return;
  if (busy) { process.send?.({ type: "result", id: message.id, ok: false, error: "Worker is already executing." }); return; }
  busy = true;
  invocation += 1;
  try {
    const result = message.type === "native-fetch" ? await nativeFetch(message.input) : await runProbe(message.input);
    process.send?.({ type: "result", id: message.id, ok: true, result, worker: metadata() });
  } catch (error) {
    process.send?.({ type: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error), worker: metadata() });
  } finally { busy = false; }
});

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OPERATIONS_VERSION } from "../../shared/operations";
import { ensureWindowsPrivateDirectory, assertWindowsPrivatePath } from "aws-studio/cli/windows-security";
import { currentUserSid } from "aws-studio/source/identity";

export class OperationsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const windowsKeys = new Map<string, Buffer>();
const windowsDirectories = new Map<string, string>();
const nonceJournals = new Map<string, DatabaseSync>();
const PIPE_PREFIX = "\\\\.\\pipe\\aws-studio-";

export function isNamedPipe(socket: string): boolean { return socket.startsWith(PIPE_PREFIX); }

/** Unix permissions or an owner-only Windows ACL protect checkout-specific local IPC. No TCP listener exists. */
export function privateEndpoint(root: string, state: string, name: "runner" | "agent" = "runner"): { directory: string; socket: string } {
  const key = createHash("sha256").update(realpathSync(root)).update("\0").update(path.resolve(state)).digest("hex").slice(0, 24);
  if (process.platform === "win32") {
    const user = createHash("sha256").update(currentUserSid()).digest("hex").slice(0, 16);
    const directory = path.join(realpathSync(tmpdir()), `studio-ops-${user}-${key}`);
    const socket = `${PIPE_PREFIX}${user}-${key}-${name}`;
    if (!windowsKeys.has(socket)) {
      ensureWindowsPrivateDirectory(directory);
      const file = path.join(directory, "ipc.key");
      let descriptor: number | undefined;
      try {
        descriptor = openSync(file, "wx", 0o600);
        writeFileSync(descriptor, randomBytes(32));
        fsyncSync(descriptor);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
      assertWindowsPrivatePath(file);
      const secret = readFileSync(file);
      if (secret.length !== 32) throw new OperationsError(503, "The private IPC authentication record is incomplete. Preserve it and inspect the local runner before recovery.");
      windowsKeys.set(socket, secret);
      windowsDirectories.set(socket, directory);
    } else {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OperationsError(503, "The operations IPC directory has changed type.");
    }
    return { directory, socket };
  }
  if (!process.getuid) throw new OperationsError(503, "The independent operations runner cannot verify the current operating-system user.");
  const uid = process.getuid();
  // macOS sockaddr_un limits paths to 104 bytes; os.tmpdir() can already exceed that.
  const directory = path.join(realpathSync("/tmp"), `studio-ops-${uid}-${key}`);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new OperationsError(503, "The operations IPC directory must be a private directory owned by this user.");
  }
  return { directory, socket: path.join(directory, `${name}.sock`) };
}

/** Release only this server's replay journal; accepted nonces remain durable for restart. */
export function closeIpcAuthentication(socket: string): void {
  nonceJournals.get(socket)?.close(); nonceJournals.delete(socket);
}

function admitNonce(socket: string, protocol: string, nonce: string): void {
  let db = nonceJournals.get(socket);
  if (!db) {
    const directory = windowsDirectories.get(socket);
    if (!directory) throw new OperationsError(503, "The local IPC authentication directory is unavailable.");
    const file = path.join(directory, socket.endsWith("-agent") ? "agent-replay.sqlite" : "runner-replay.sqlite");
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new OperationsError(503, "The local IPC replay journal has an unsafe type.");
      assertWindowsPrivatePath(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    db = new DatabaseSync(file);
    try { db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS nonces (protocol TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(protocol,nonce))"); }
    catch (error) { db.close(); throw error; }
    nonceJournals.set(socket, db);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM nonces WHERE expires < ?").run(Date.now());
    if (db.prepare("SELECT 1 FROM nonces WHERE protocol=? AND nonce=?").get(protocol, nonce)) throw new OperationsError(403, "Local IPC request replay was refused.");
    if (Number(db.prepare("SELECT COUNT(*) AS count FROM nonces").get()!.count) >= 8192) throw new OperationsError(503, "Local IPC authentication capacity was reached. Retry after a minute.");
    db.prepare("INSERT INTO nonces VALUES (?,?,?)").run(protocol, nonce, Date.now() + 120_000);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* Retain the admission failure. */ } throw error; }
}

export function secureSocket(socket: string): void {
  // Node's Windows pipe DACL is not the sole authority: each message and reply is
  // authenticated using the key in the owner-only directory, including pipe squatting.
  if (process.platform === "win32" && isNamedPipe(socket) && windowsKeys.has(socket)) return;
  const stat = lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new OperationsError(503, "The operations socket has an unexpected owner or type.");
  chmodSync(socket, 0o600);
}

function matches(expected: string, actual: unknown): boolean {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

/** Mutual authentication is required on Windows: a predictable pipe name is not an identity. */
export interface AuthenticatedIpcRequest {
  readonly body: string;
  encodeResponse(body: string): string;
  responseHeaders(status: number, body: string): Record<string, string>;
}
export function ipcAuthentication(socket: string, protocol: string): {
  signRequest(method: string, route: string, body: string): { headers: Record<string, string>; body: string; verifyResponse(status: number, headers: IncomingHttpHeaders, body: string): string };
  authenticateRequest(request: IncomingMessage, body: string): AuthenticatedIpcRequest;
} {
  const secret = windowsKeys.get(socket);
  if (isNamedPipe(socket) && !secret) throw new OperationsError(503, "The named pipe has no verified private authentication record.");
  const sign = (...parts: unknown[]) => createHmac("sha256", secret!).update(JSON.stringify([protocol, socket, ...parts])).digest("hex");
  const encryptionKey = secret ? createHmac("sha256", secret).update(`encryption:${protocol}:${socket}`).digest() : undefined;
  const seal = (body: string): string => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey!, iv);
    const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ciphertext.toString("base64")}`;
  };
  const open = (body: string): string => {
    const match = /^([a-f0-9]{24})\.([a-f0-9]{32})\.([A-Za-z0-9+/]*={0,2})$/.exec(body);
    if (!match) throw new OperationsError(403, "The encrypted local IPC message is invalid.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey!, Buffer.from(match[1]!, "hex"));
      decipher.setAuthTag(Buffer.from(match[2]!, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(match[3]!, "base64")), decipher.final()]).toString("utf8");
    } catch { throw new OperationsError(403, "The encrypted local IPC message is invalid."); }
  };
  return {
    signRequest(method, route, body) {
      if (!secret) return { headers: {} as Record<string, string>, body, verifyResponse: (_status, _headers, body) => body };
      const nonce = randomBytes(32).toString("hex"), timestamp = String(Date.now());
      const encoded = body ? seal(body) : "";
      return {
        headers: { "x-studio-ipc-nonce": nonce, "x-studio-ipc-time": timestamp, "x-studio-ipc-auth": sign("request", method, route, timestamp, nonce, encoded) }, body: encoded,
        verifyResponse(status, headers, responseBody) {
          if (!matches(sign("response", nonce, status, responseBody), headers["x-studio-ipc-auth"])) throw new OperationsError(502, "The local runner response could not be authenticated. Existing operations may still be running.");
          return open(responseBody);
        },
      };
    },
    authenticateRequest(request, body) {
      if (!secret) return { body, encodeResponse: body => body, responseHeaders: () => ({}) };
      const nonce = request.headers["x-studio-ipc-nonce"], timestamp = request.headers["x-studio-ipc-time"];
      if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || typeof timestamp !== "string" || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000 ||
        !matches(sign("request", request.method, request.url, timestamp, nonce, body), request.headers["x-studio-ipc-auth"])) throw new OperationsError(403, "Local IPC authentication failed.");
      admitNonce(socket, protocol, nonce);
      return { body: body ? open(body) : "", encodeResponse: seal, responseHeaders: (status, responseBody) => ({ "x-studio-ipc-auth": sign("response", nonce, status, responseBody) }) };
    },
  };
}

export function callIpc<T>(socket: string, route: string, body?: unknown, timeout = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const method = encoded === undefined ? "GET" : "POST";
    const authentication = ipcAuthentication(socket, `operations:${OPERATIONS_VERSION}`).signRequest(method, route, encoded ?? "");
    const request = httpRequest({ socketPath: socket, path: route, method, agent: false, headers: {
      "x-operations-version": String(OPERATIONS_VERSION),
      ...authentication.headers,
      ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(authentication.body) }),
    } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > (process.platform === "win32" ? 12 : 8) * 1024 * 1024) { response.destroy(new OperationsError(502, "The operations response exceeds its replay page limit.")); return; }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const payload = Buffer.concat(chunks).toString("utf8");
          const decoded = authentication.verifyResponse(response.statusCode ?? 500, response.headers, payload);
          if (Buffer.byteLength(decoded) > 8 * 1024 * 1024) throw new OperationsError(502, "The operations response exceeds its replay page limit.");
          const result = JSON.parse(decoded);
          if ((response.statusCode ?? 500) >= 400) reject(new OperationsError(response.statusCode ?? 500, typeof result.error === "string" ? result.error : "The operations request failed."));
          else resolve(result as T);
        } catch (error) { reject(error instanceof OperationsError ? error : new OperationsError(502, "The operations runner returned unreadable evidence.")); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new OperationsError(504, "The operations runner did not answer. Accepted operations may still be running; retry with the same request key.")));
    request.once("error", reject);
    request.end(encoded === undefined ? undefined : authentication.body);
  });
}

/** Version of the local-runtime observation/admission contract, independent of the journal protocol. */
export const LOCAL_RUNTIME_CAPABILITY = 2;

export interface CoordinatorInfo {
  readonly version: typeof OPERATIONS_VERSION;
  readonly pid: number;
  readonly root: string;
  readonly state: string;
  /** Capability of the running host; journal and IPC version remain unchanged. */
  readonly localRuntime?: 1 | typeof LOCAL_RUNTIME_CAPABILITY;
}

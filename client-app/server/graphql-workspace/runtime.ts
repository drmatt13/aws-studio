import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { getOperationAST, parse } from "graphql";
import type { LocalRunView } from "../../shared/deploy";
import type { GraphQLExecuteRequest, GraphQLExecution, GraphQLRuntime } from "../../shared/graphql-workspace";
import { EditError } from "aws-studio/source/io";

const REQUEST_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 35_000;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function observeWithinDeadline(read: () => Promise<LocalRunView>): Promise<LocalRunView> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Local observation timed out")), 5_000);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Only the exported local API port is used; URLs and upstream headers are never caller input. */
export function localGraphQLEndpoint(root: string): string | null {
  const file = path.join(realpathSync(root), ".env");
  try {
    const before = lstatSync(file);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) return null;
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1024 * 1024) return null;
      const port = parseEnv(readFileSync(descriptor, "utf8")).LOCAL_API_DEV_SERVER_HOST_PORT?.trim();
      if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return null;
      return `http://127.0.0.1:${port}/api/graphql`;
    } finally { closeSync(descriptor); }
  } catch { return null; }
}

export function readGraphQLExecuteRequest(value: unknown): GraphQLExecuteRequest {
  if (!plain(value) || Object.keys(value).some(key => !["document", "variables", "operationName", "idToken", "confirmMutation"].includes(key))) throw new EditError(400, "Provide an operation, variables and a Cognito ID token.");
  if (typeof value.document !== "string" || !value.document.trim() || Buffer.byteLength(value.document) > 64 * 1024) throw new EditError(400, "Provide an operation of at most 64 KiB.");
  if (!plain(value.variables) || Buffer.byteLength(JSON.stringify(value.variables)) > REQUEST_LIMIT) throw new EditError(400, "Variables must be a JSON object of at most 128 KiB.");
  if (value.operationName !== undefined && (typeof value.operationName !== "string" || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(value.operationName) || value.operationName.length > 256)) throw new EditError(400, "Choose a valid operation name.");
  if (value.confirmMutation !== undefined && value.confirmMutation !== true) throw new EditError(400, "Confirm the selected mutation before running it.");
  if (typeof value.idToken !== "string" || value.idToken.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.idToken.trim())) throw new EditError(400, "Provide a Cognito ID token. The local API verifies its signature, audience and expiry.");
  let operation;
  try { operation = getOperationAST(parse(value.document, { maxTokens: 10_000 }), value.operationName as string | undefined); }
  catch { throw new EditError(400, "The operation is not valid GraphQL or exceeds the parser limit."); }
  if (!operation) throw new EditError(400, "Choose one query or mutation by operation name.");
  if (operation.operation === "subscription") throw new EditError(400, "Subscriptions are not supported by the local HTTP Explorer.");
  if (operation.operation === "mutation" && value.confirmMutation !== true) throw new EditError(400, "Confirm this mutation: it can change application data.");
  return { document: value.document, variables: value.variables, ...(value.operationName ? { operationName: value.operationName as string } : {}), idToken: value.idToken.trim(), ...(value.confirmMutation ? { confirmMutation: true } : {}) };
}

/** Transient relay: nothing from execution (including the token) enters source evidence or durable storage. */
export class GraphQLRuntimeService {
  private active = false;
  constructor(private readonly root: string, private readonly localStatus: () => Promise<LocalRunView>, private readonly transport: typeof fetch = fetch) {}

  async runtime(): Promise<GraphQLRuntime> {
    const endpoint = localGraphQLEndpoint(this.root);
    if (!endpoint) return { status: "unavailable", endpoint: null, message: "Local API settings are unavailable. Open Deploy & Run to configure development." };
    try {
      const local = await observeWithinDeadline(this.localStatus);
      if (local.lifecycle === "off" || local.readiness?.state === "stopped") return { status: "stopped", endpoint, message: "Start local runtime in Deploy & Run to execute operations. Schema and Client remain available." };
      if (local.lifecycle === "starting" || local.lifecycle === "stopping") return { status: "starting", endpoint, message: "Local runtime is changing state. Wait for it to be ready before running an operation." };
      if (local.lifecycle === "running" && local.readiness?.state === "ready" && !local.restartNeeded.length && local.services.some(service => service.name === "local-api-dev-server" && service.state === "running" && service.health !== "unhealthy" && service.health !== "starting")) return { status: "ready", endpoint, message: "Local runtime is ready. Operations use the supplied Cognito identity and can access application data." };
      return { status: local.lifecycle === undefined ? "unavailable" : "blocked", endpoint, message: local.observationProblem ?? local.readiness?.message ?? "Local runtime needs attention. Open Deploy & Run to inspect it." };
    } catch { return { status: "unavailable", endpoint, message: "Could not observe local runtime. Open Deploy & Run and check its status." }; }
  }

  async execute(input: unknown, signal?: AbortSignal): Promise<GraphQLExecution> {
    const request = readGraphQLExecuteRequest(input);
    if (this.active) throw new EditError(409, "An Explorer operation is already running. Wait for its result before sending another.");
    this.active = true;
    const started = performance.now();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const runtime = await this.runtime();
      if (combined.aborted) throw new EditError(504, "The local operation timed out or was cancelled. Its outcome may be unknown; inspect data before retrying a mutation.");
      if (runtime.status !== "ready" || !runtime.endpoint) throw new EditError(409, runtime.message);
      // A changed export between readiness and dispatch must not redirect a credential.
      if (localGraphQLEndpoint(this.root) !== runtime.endpoint) throw new EditError(409, "Local API settings changed. Check runtime again before running an operation.");
      const response = await this.transport(runtime.endpoint, {
        method: "POST", redirect: "error", signal: combined,
        headers: { "content-type": "application/json", accept: "application/graphql-response+json, application/json", authorization: `Bearer ${request.idToken}` },
        body: JSON.stringify({ query: request.document, variables: request.variables, ...(request.operationName ? { operationName: request.operationName } : {}) }),
      });
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new EditError(502, "The local response exceeds 2 MiB. Request fewer fields or a smaller page."); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new EditError(502, "The local API returned a non-JSON response. Check runtime logs in Deploy & Run."); }
      return { status: response.status, body, durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      if (error instanceof EditError) throw error;
      // Never relay transport messages: they can include request credentials or internal context.
      throw new EditError(combined.aborted ? 504 : 502, combined.aborted ? "The local operation timed out or was cancelled. Its outcome may be unknown; inspect data before retrying a mutation." : "Could not reach the local GraphQL API. Check runtime in Deploy & Run.");
    } finally { this.active = false; }
  }
}

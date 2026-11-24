/**
 * One handler process. Its environment is complete before any application
 * import, exactly as in a Lambda execution environment.
 *
 * By default it answers one invocation and exits. Asked to stay (`keepAlive`),
 * it keeps the imported module — and everything the module cached at the top
 * level — for the next invocation of the same handler, which is what a warm
 * Lambda environment does.
 */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withDevelopmentObservation, setDevelopmentObservationSink, registerDevelopmentSecrets, developmentSensitiveHttpEvent } from "../development-logs";
import type { LambdaObservation } from "./lambda-observation";
import { LambdaIpcBudget } from "./lambda-ipc-budget";

const outputContext = new AsyncLocalStorage<{ observation: LambdaObservation; completed: boolean }>();
let workerObservation: LambdaObservation | undefined;
let pendingGap: { reason: string; observation: LambdaObservation } | undefined;
let reportingGap = false;
const outputQueue = new LambdaIpcBudget((message, done) => { if (!process.send || !process.connected) throw new Error("IPC disconnected"); process.send(message, done); }, () => {
  if (!pendingGap || reportingGap) return;
  reportingGap = true;
  const gap = pendingGap;
  if (outputQueue.trySend({ type: "development-log-gap", ...gap }, undefined, false)) pendingGap = undefined;
  reportingGap = false;
});
function outputGap(reason: string): void {
  if (pendingGap || !workerObservation || !process.connected) return;
  pendingGap = { reason, observation: outputContext.getStore()?.observation ?? workerObservation };
  if (outputQueue.trySend({ type: "development-log-gap", ...pendingGap }, undefined, false)) pendingGap = undefined;
}
setDevelopmentObservationSink(event => {
  if (!process.connected || !workerObservation) return;
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { return; }
  if (bytes > 16 * 1024 || !outputQueue.trySend({ type: "development-observation", event })) outputGap("structured event queue limit");
});
// Keep JS writes in the existing output stream, but frame them over IPC so a
// previous invocation's async output is never assigned to a newer invocation.
for (const stream of ["stdout", "stderr"] as const) {
  const original = process[stream].write.bind(process[stream]);
  process[stream].write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (!process.connected || !workerObservation) return original(chunk as string, encodingOrCallback as BufferEncoding, callback);
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    if (!bytes) return original(chunk as string, encodingOrCallback as BufferEncoding, callback);
    if (bytes > 64 * 1024) { outputGap("output framing limit; bytes retain worker attribution"); return original(chunk as string, encodingOrCallback as BufferEncoding, callback); }
    const encoded = typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
    const scope = outputContext.getStore();
    const text = encoded.toString("base64");
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    // The parent owns redaction, persistence and combined output. A transport failure
    // falls back to the original pipe without reporting logging errors to the handler.
    const sent = outputQueue.trySend({ type: "development-log", stream, text, encoding: "base64",
      observation: scope?.observation ?? workerObservation, late: scope?.completed ?? false }, error => {
      if (error) original(chunk as string, encodingOrCallback as BufferEncoding, callback);
      else done?.();
    });
    if (!sent) { outputGap("output queue limit; bytes retain worker attribution"); return original(chunk as string, encodingOrCallback as BufferEncoding, callback); }
    return true;
  }) as typeof process.stdout.write;
}

interface LambdaDescription {
  readonly functionName: string;
  readonly memoryLimitInMB: number;
  readonly timeoutSeconds: number;
}

interface Request {
  /** Echoed in the reply, so a warm worker's answers can be matched to requests. */
  readonly id?: number;
  readonly entry: string;
  readonly handler: string;
  readonly event: unknown;
  readonly observation?: LambdaObservation;
  readonly redactionSecrets?: readonly string[];
  /**
   * Fields a caller may pin: a replayed invocation's original request id, or
   * the client context a Gateway hands a tool.
   */
  readonly context?: {
    readonly awsRequestId?: string;
    readonly clientContext?: { readonly custom: Readonly<Record<string, string>> };
  };
  readonly lambda?: LambdaDescription;
  /** Stay alive for the next invocation instead of exiting after this one. */
  readonly keepAlive?: boolean;
}

type Handler = (event: unknown, context: unknown) => unknown;

let loaded: { readonly entry: string; readonly handler: Handler } | undefined;

/**
 * The context a Lambda runtime hands a handler: identifiers, limits, and a
 * `getRemainingTimeInMillis` that counts down from this invocation's deadline.
 * Built here because functions cannot cross the IPC channel.
 */
function lambdaContext(request: Request) {
  const functionName = request.lambda?.functionName ?? "local";
  const deadline = Date.now() + (request.lambda?.timeoutSeconds ?? 900) * 1000;
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName,
    functionVersion: "$LATEST",
    invokedFunctionArn: `arn:aws:lambda:local:000000000000:function:${functionName}`,
    memoryLimitInMB: String(request.lambda?.memoryLimitInMB ?? 128),
    awsRequestId: request.context?.awsRequestId ?? randomUUID(),
    ...(request.context?.clientContext ? { clientContext: request.context.clientContext } : {}),
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: "local",
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

/** The error as the parent will print it, stack included. */
function describeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "Error", message: String(error) };
}

async function load(request: Request): Promise<Handler> {
  if (loaded) {
    if (loaded.entry !== request.entry) {
      throw new Error("This process already serves another handler.");
    }
    return loaded.handler;
  }
  const module = (await import(request.entry)) as Record<string, unknown>;
  const handler = module[request.handler];
  if (typeof handler !== "function") {
    throw new Error(`The handler module does not export ${request.handler}.`);
  }
  loaded = { entry: request.entry, handler: handler as Handler };
  return loaded.handler;
}

async function execute(request: Request): Promise<void> {
  let reply: Record<string, unknown>;
  const observation = request.observation ? { ...request.observation, sensitive: request.observation.sensitive === true || developmentSensitiveHttpEvent(request.event) } : undefined;
  if (observation) registerDevelopmentSecrets(observation.resourceId, request.redactionSecrets ?? []);
  workerObservation = observation ? { ...observation, correlation: {} } : undefined;
  const scope = observation ? { observation, completed: false } : undefined;
  try {
    // Module initialization belongs to the worker; only the handler body is an invocation.
    const handler = await load(request);
    const invoke = () => handler(request.event, lambdaContext(request));
    const result = scope ? await outputContext.run(scope, () => withDevelopmentObservation(scope.observation, invoke)) : await invoke();
    reply = { id: request.id, ok: true, result: JSON.parse(JSON.stringify(result ?? null)) };
  } catch (error) {
    reply = { id: request.id, ok: false, error: describeError(error) };
  }
  if (scope) scope.completed = true;
  reply.outputBudget = outputQueue.statistics;
  reply.observation = observation;
  if (request.keepAlive) {
    process.send?.(reply);
  } else {
    process.send?.(reply, () => process.exit(reply.ok ? 0 : 1));
  }
}

// A worker never outlives the process that started it: when a dev server
// restarts or crashes, the IPC channel closes and this exits with it.
process.on("disconnect", () => process.exit(0));
process.on("message", (request: Request) => {
  void execute(request);
});

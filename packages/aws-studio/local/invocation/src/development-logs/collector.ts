import {
  followDevelopmentComposeOutput,
  type ComposeOutputDependencies,
} from "./compose-output";
import { lstat } from "node:fs/promises";
import {
  developmentWriterIdentity,
  type DevelopmentWriterIdentity,
} from "./writer-identity";
import path from "node:path";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type express from "express";
import {
  normalizeFrameworkConfig,
  getAgentBrowserRoutes,
  listResourceDeclarations,
  listCdkResourceDeclarations,
  isResourceReference,
  isCdkResource,
  type FrameworkConfig,
} from "aws-studio/config";
import {
  DEVELOPMENT_LOG_LIMITS as limits,
  observeDevelopment,
  registerDevelopmentSecrets,
  sanitizeDevelopmentObservation,
  setDevelopmentObservationSink,
  withDevelopmentObservation,
  type DevelopmentLogControl,
} from "aws-studio/development-logs";
import {
  assertLogDirectory,
  readDevelopmentLogControl,
  type DevelopmentLogBatchEntry,
} from "aws-studio/local/development-logs";
const executeDockerInformation = promisify(execFile);

export function developmentLogResourceIds(
  config: FrameworkConfig,
): ReadonlySet<string> {
  const normalized = normalizeFrameworkConfig(config),
    ids = new Set<string>([
      ...normalized.targets.keys(),
      "gateway:http",
      "gateway:websocket",
      "local:postgres",
      "runtime:development",
    ]);
  for (const route of normalized.http)
    ids.add(
      `route:${route.type === "service" ? "service" : "http"}:${route.path}`,
    );
  for (const route of normalized.webSocket)
    ids.add(`route:ws:${route.routeKey}`);
  for (const route of getAgentBrowserRoutes(config))
    ids.add(`route:agent:${route.path}`);
  if (config.resources) {
    for (const resource of [
      ...listResourceDeclarations(config.resources),
      ...listCdkResourceDeclarations(config.resources),
    ])
      ids.add(`resource:${resource.path.join(".")}`);
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (
      !value ||
      typeof value !== "object" ||
      seen.has(value) ||
      depth > 20 ||
      ++nodes > 20_000
    )
      return;
    seen.add(value);
    if (isResourceReference(value) || isCdkResource(value)) {
      ids.add(`resource:${value.path.join(".")}`);
      return;
    }
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    ))
      if ("value" in descriptor) visit(descriptor.value, depth + 1);
  };
  for (const target of normalized.targets.values()) visit(target, 0);
  return ids;
}

/** HTTP/IPC evidence has no authority; validate its version-one shape before accepting any batch. */
export function validDevelopmentLogBatchEntry(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is DevelopmentLogBatchEntry {
  try {
    const record = (input: unknown): input is Record<string, unknown> =>
      !!input && typeof input === "object" && !Array.isArray(input);
    if (
      !record(value) ||
      typeof value.eventId !== "string" ||
      !/^([a-f0-9-]{36}):(\d{1,12})$/i.test(value.eventId) ||
      !record(value.producer) ||
      typeof value.producer.component !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(value.producer.component) ||
      value.producer.instanceId !== value.eventId.split(":")[0] ||
      !record(value.observation)
    )
      return false;
    const observation = value.observation;
    if (
      typeof observation.resourceId !== "string" ||
      !allowed.has(observation.resourceId) ||
      typeof observation.kind !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,96}$/.test(observation.kind)
    )
      return false;
    for (const [key, values] of Object.entries({
      level: ["debug", "info", "warn", "error"],
      stream: ["event", "stdout", "stderr"],
      attribution: ["resource", "worker", "session", "invocation", "execution"],
    })) {
      if (
        observation[key] !== undefined &&
        (typeof observation[key] !== "string" ||
          !values.includes(observation[key] as string))
      )
        return false;
    }
    for (const key of ["phase", "outcome"])
      if (
        observation[key] !== undefined &&
        (typeof observation[key] !== "string" ||
          (observation[key] as string).length > 80)
      )
        return false;
    if (
      observation.message !== undefined &&
      typeof observation.message !== "string"
    )
      return false;
    if (observation.late !== undefined && typeof observation.late !== "boolean")
      return false;
    if (
      observation.durationMs !== undefined &&
      (typeof observation.durationMs !== "number" ||
        !Number.isFinite(observation.durationMs) ||
        observation.durationMs < 0 ||
        observation.durationMs > Number.MAX_SAFE_INTEGER)
    )
      return false;
    if (
      observation.occurredAt !== undefined &&
      (typeof observation.occurredAt !== "string" ||
        observation.occurredAt.length > 128 ||
        !Number.isFinite(Date.parse(observation.occurredAt)))
    )
      return false;
    if (
      observation.relatedResourceIds !== undefined &&
      (!Array.isArray(observation.relatedResourceIds) ||
        observation.relatedResourceIds.length > 3 ||
        !observation.relatedResourceIds.every(
          (id) => typeof id === "string" && allowed.has(id),
        ))
    )
      return false;
    if (observation.correlation !== undefined) {
      if (
        !record(observation.correlation) ||
        Object.keys(observation.correlation).length > 32
      )
        return false;
      const strings = new Set([
        "traceId",
        "spanId",
        "parentSpanId",
        "requestId",
        "invocationId",
        "executionId",
        "taskRunId",
        "connectionId",
        "messageId",
        "replayId",
        "agentSessionId",
        "turnId",
        "toolCallId",
        "stateId",
        "stateAttemptId",
        "branchPath",
        "buildId",
      ]);
      for (const [key, item] of Object.entries(observation.correlation)) {
        if (
          strings.has(key) &&
          (typeof item !== "string" ||
            item.length > 256 ||
            /[\r\n\0]/.test(item))
        )
          return false;
        if (
          ["deliveryAttempt", "mapIndex"].includes(key) &&
          (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
        )
          return false;
      }
    }
    if (
      observation.omissions !== undefined &&
      (!Array.isArray(observation.omissions) ||
        observation.omissions.length > 32 ||
        !observation.omissions.every(
          (item) =>
            record(item) &&
            typeof item.path === "string" &&
            item.path.length <= 160 &&
            typeof item.reason === "string" &&
            ["privacy", "size", "depth", "circular", "unsupported"].includes(
              item.reason,
            ) &&
            (item.count === undefined ||
              (typeof item.count === "number" &&
                Number.isSafeInteger(item.count) &&
                item.count > 0 &&
                item.count <= 1_000_000)),
        ))
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/** One runner owns capture. Persistence failures never reject an application invocation. */
export interface DevelopmentLogCollector {
  /** Observe committed work explicitly; HTTP acceptance alone does not prove persistence. */
  flush(signal: AbortSignal): Promise<void>;
  /** Without a signal, shutdown retains its bounded best-effort drain. */
  close(options?: { signal: AbortSignal }): Promise<void>;
}
export async function startDevelopmentLogCollector(options: {
  app: express.Express;
  repositoryRoot: string;
  projectName: string;
  config: FrameworkConfig;
  followOutput?: false;
}): Promise<DevelopmentLogCollector> {
  const disabled: DevelopmentLogCollector = {
    async flush() {
      throw new Error("Development log capture is disabled.");
    },
    async close() {},
  };
  if (process.env.FRAMEWORK_DEVELOPMENT_LOGS !== "1")
    return disabled;
  const control = readDevelopmentLogControl(options.repositoryRoot);
  if (!control || control.composeProject !== options.projectName)
    return disabled;
  registerDevelopmentSecrets("runtime:collector-capability", [control.token]);
  process.env.FRAMEWORK_DEVELOPMENT_LOGS = "1";
  process.env.FRAMEWORK_DEVELOPMENT_LOG_SESSION = control.runtimeSessionId;
  const directory = process.env.FRAMEWORK_DEVELOPMENT_LOG_DIRECTORY;
  let writerIdentity: DevelopmentWriterIdentity | undefined;
  if (directory) {
    try {
      const info = await lstat(directory);
      let daemonOperatingSystem: string | undefined;
      if (
        process.platform === "linux" &&
        process.getuid?.() === 0 &&
        info.uid === 0
      ) {
        daemonOperatingSystem = (
          await executeDockerInformation(
            "docker",
            ["info", "--format", "{{.OperatingSystem}}"],
            { timeout: 3000, maxBuffer: 4096 },
          )
        ).stdout.trim();
      }
      if (process.platform === "win32") {
        // Windows mode bits and UID fields do not describe ownership. Verify
        // the actual current-user DACL before inheriting this process's token.
        await assertLogDirectory(directory);
        writerIdentity = {};
      } else {
        writerIdentity = developmentWriterIdentity({
          platform: process.platform,
          processUid: process.getuid?.(),
          ownerUid: info.uid,
          mode: info.mode,
          isDirectory: info.isDirectory(),
          isSymbolicLink: info.isSymbolicLink(),
          daemonOperatingSystem,
          control,
        });
      }
    } catch {
      /* Unknown filesystem ownership disables capture; application execution continues. */
    }
  }
  const allowed = developmentLogResourceIds(options.config);
  const instanceId = randomUUID();
  let sequence = 0,
    bytes = 0,
    dropped = 0,
    closed = false,
    ready = false,
    busy = false,
    failed = false;
  const queue: DevelopmentLogBatchEntry[] = [];
  const seen = new Map<string, number>();
  const persistenceObservers = new Set<() => void>();
  const notifyPersistence = () => {
    for (const observe of persistenceObservers) observe();
  };
  let writer: ChildProcess | undefined;
  const writerClosures = new Set<Promise<void>>();
  const checkpointRequests = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const requestCheckpoint = (
    type: "checkpoint.load" | "checkpoint.save",
    value?: unknown,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!writer?.connected || checkpointRequests.size >= 8) {
        reject(new Error("Checkpoint writer unavailable."));
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        checkpointRequests.delete(requestId);
        reject(new Error("Checkpoint writer timed out."));
      }, 2000);
      checkpointRequests.set(requestId, { resolve, reject, timer });
      writer.send(
        { type, requestId, ...(value === undefined ? {} : { value }) },
        (error) => {
          if (!error) return;
          const pending = checkpointRequests.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          checkpointRequests.delete(requestId);
          pending.reject(new Error("Checkpoint writer unavailable."));
        },
      );
    });
  const checkpoint: NonNullable<ComposeOutputDependencies["checkpoint"]> = {
    load: () => requestCheckpoint("checkpoint.load"),
    save: async (value) => {
      await requestCheckpoint("checkpoint.save", value);
    },
  };
  let inFlight: DevelopmentLogBatchEntry[] = [];
  let inFlightDropped = 0,
    lastStart = 0;
  const status = (failure: boolean, code?: string) => {
    if (failure && !failed)
      process.stderr.write(
        `Development log storage is unavailable${code && /^[A-Za-z_-]{1,40}$/.test(code) ? ` (${code})` : ""}; application execution continues.\n`,
      );
    failed = failure;
    notifyPersistence();
  };
  const accept = (event: DevelopmentLogBatchEntry): void => {
    if (closed || !allowed.has(event.observation.resourceId)) return;
    const match = /^([a-f0-9-]{36}):(\d{1,12})$/i.exec(event.eventId);
    if (!match) return;
    const seq = Number(match[2]),
      last = seen.get(match[1]!) ?? 0;
    if (seq <= last) return;
    if (seen.size >= 1024 && !seen.has(match[1]!)) {
      dropped++;
      return;
    }
    seen.set(match[1]!, seq);
    const safe = withDevelopmentObservation({ isolated: true }, () =>
      sanitizeDevelopmentObservation(event.observation),
    );
    const entry: DevelopmentLogBatchEntry = {
      eventId: event.eventId,
      producer: {
        component: event.producer.component.slice(0, 64),
        instanceId: match[1]!,
      },
      observation: {
        ...safe,
        relatedResourceIds: safe.relatedResourceIds.filter((id) =>
          allowed.has(id),
        ),
      },
    };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (size > limits.recordBytes) {
      dropped++;
      return;
    }
    while (
      queue.length &&
      (queue.length >= limits.collectorRecords ||
        bytes + size > limits.collectorBytes)
    ) {
      const at = queue.findIndex(
        (e) =>
          e.observation.level === "info" || e.observation.level === "debug",
      );
      const old = queue.splice(at < 0 ? 0 : at, 1)[0]!;
      bytes -= Buffer.byteLength(JSON.stringify(old));
      dropped++;
    }
    queue.push(entry);
    bytes += size;
  };
  const restore = setDevelopmentObservationSink((observation) =>
    accept({
      observation,
      eventId: `${instanceId}:${++sequence}`,
      producer: { component: "runner", instanceId },
    }),
  );
  let closingResolve: ((error?: Error) => void) | undefined;
  const recoverInFlight = () => {
    for (const entry of inFlight.reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (
        queue.length < limits.collectorRecords &&
        bytes + size <= limits.collectorBytes
      ) {
        queue.unshift(entry);
        bytes += size;
      } else dropped++;
    }
    inFlight = [];
    dropped += inFlightDropped;
    inFlightDropped = 0;
    busy = false;
  };
  const startWriter = () => {
    if (
      !directory ||
      !writerIdentity ||
      closed ||
      writer ||
      Date.now() - lastStart < 5000
    )
      return;
    lastStart = Date.now();
    try {
      writer = fork(
        path.join(__dirname, "writer.ts"),
        [],
        {
          cwd: options.repositoryRoot,
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          ...writerIdentity,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          },
        },
      );
      const released = new Promise<void>((resolve) =>
        writer!.once("close", () => resolve()),
      );
      writerClosures.add(released);
      void released.then(() => writerClosures.delete(released));
      writer.stderr?.resume();
      writer.on(
        "message",
        (message: {
          type: string;
          code?: string;
          requestId?: string;
          value?: unknown;
        }) => {
          if (
            message.type === "checkpoint.result" ||
            message.type === "checkpoint.error"
          ) {
            const pending =
              message.requestId && checkpointRequests.get(message.requestId);
            if (pending && message.requestId) {
              clearTimeout(pending.timer);
              checkpointRequests.delete(message.requestId);
              if (message.type === "checkpoint.result")
                pending.resolve(message.value);
              else pending.reject(new Error("Checkpoint storage unavailable."));
            }
            return;
          }
          if (message.type === "ready") {
            ready = true;
            status(false);
            if (queue.length || dropped) queueMicrotask(flush);
          }
          if (message.type === "committed") {
            busy = false;
            inFlight = [];
            inFlightDropped = 0;
            if (queue.length || dropped) queueMicrotask(flush);
            notifyPersistence();
          }
          if (message.type === "failed") {
            ready = false;
            status(true, message.code);
          }
          if (message.type === "closed") closingResolve?.();
        },
      );
      writer.on("error", () => {
        ready = false;
        status(true);
        closingResolve?.(
          new Error("Development log writer failed before closing."),
        );
      });
      writer.on("exit", () => {
        writer = undefined;
        ready = false;
        recoverInFlight();
        for (const pending of checkpointRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Checkpoint writer stopped."));
        }
        checkpointRequests.clear();
        if (!closed) status(true);
        notifyPersistence();
        closingResolve?.(
          new Error("Development log writer exited before confirming closure."),
        );
      });
      writer.send({ type: "initialize", directory, control });
    } catch {
      writer = undefined;
      status(true);
    }
  };
  startWriter();
  if (!directory || !writerIdentity) status(true);
  const flush = () => {
    startWriter();
    if (!ready || busy || !writer?.connected) return;
    const entries: DevelopmentLogBatchEntry[] = [];
    let batchBytes = 0;
    while (queue.length && entries.length < limits.batchRecords) {
      const size = Buffer.byteLength(JSON.stringify(queue[0]));
      if (batchBytes + size > limits.batchBytes - 1024) break;
      entries.push(queue.shift()!);
      bytes -= size;
      batchBytes += size;
    }
    busy = true;
    inFlight = entries;
    inFlightDropped = dropped;
    dropped = 0;
    try {
      writer.send(
        { type: "append", entries, dropped: inFlightDropped },
        (error) => {
          if (error) {
            ready = false;
            status(true);
            writer?.kill();
          }
        },
      );
    } catch {
      ready = false;
      status(true);
      writer.kill();
    }
  };
  const interval = setInterval(flush, 1000);
  interval.unref();
  let rateAt = Date.now(),
    rateBudget = 2000;
  const producerRates = new Map<string, { at: number; budget: number }>();
  options.app.post("/development-logs/batch", (request, response) => {
    const token = request.header("authorization") ?? "",
      expected = `Bearer ${control.token}`;
    if (
      request.headers.origin !== undefined ||
      !/^Bearer [a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      response
        .status(401)
        .json({ error: "Development observation capability required." });
      return;
    }
    const body = request.body as {
      version?: unknown;
      runtimeSessionId?: unknown;
      repositoryKey?: unknown;
      composeProject?: unknown;
      entries?: unknown;
      dropped?: unknown;
    };
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.version !== 1 ||
      typeof body.runtimeSessionId !== "string" ||
      typeof body.repositoryKey !== "string" ||
      typeof body.composeProject !== "string" ||
      !Array.isArray(body.entries) ||
      (body.dropped !== undefined &&
        (typeof body.dropped !== "number" ||
          !Number.isSafeInteger(body.dropped) ||
          body.dropped < 0))
    ) {
      response
        .status(400)
        .json({ error: "Invalid development observation batch." });
      return;
    }
    if (
      body.runtimeSessionId !== control.runtimeSessionId ||
      body.repositoryKey !== control.repositoryKey ||
      body.composeProject !== control.composeProject
    ) {
      response
        .status(409)
        .json({ error: "Development observation run changed." });
      return;
    }
    if (
      body.entries.length > limits.batchRecords ||
      Buffer.byteLength(JSON.stringify(body)) > limits.batchBytes
    ) {
      response
        .status(413)
        .json({ error: "Development observation batch exceeds limits." });
      return;
    }
    const now = Date.now();
    rateBudget = Math.min(2000, rateBudget + (now - rateAt));
    rateAt = now;
    if (body.entries.length > rateBudget) {
      dropped += body.entries.length;
      response
        .status(429)
        .json({ error: "Development observations were rate limited." });
      return;
    }
    for (const value of body.entries) {
      if (!validDevelopmentLogBatchEntry(value, allowed)) {
        response
          .status(400)
          .json({
            error: "Invalid development observation identity or shape.",
          });
        return;
      }
    }
    const counts = new Map<string, number>();
    for (const value of body.entries) {
      const id = value.eventId.split(":")[0];
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      const prior = producerRates.get(id) ?? { at: now, budget: 200 };
      const budget = Math.min(200, prior.budget + (now - prior.at) * 0.2);
      if (
        count > budget ||
        (producerRates.size >= 1024 && !producerRates.has(id))
      ) {
        dropped += body.entries.length;
        response
          .status(429)
          .json({ error: "Development producer was rate limited." });
        return;
      }
      producerRates.set(id, { at: now, budget: budget - count });
    }
    rateBudget -= body.entries.length;
    for (const value of body.entries) accept(value);
    if (
      typeof body.dropped === "number" &&
      Number.isSafeInteger(body.dropped) &&
      body.dropped > 0
    )
      dropped += Math.min(body.dropped, 1_000_000);
    flush();
    response
      .status(202)
      .json({ accepted: body.entries.length, persistent: ready && !failed });
  });
  const followers =
    options.followOutput === false
      ? { async close() {} }
      : followComposeOutput(options, control, checkpoint);
  observeDevelopment({
    resourceId: "runtime:development",
    kind: "collector.started",
    details: { persistent: Boolean(directory) },
  });
  const waitForPersistence = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        persistenceObservers.delete(observe);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(
        new Error("Development log persistence observation aborted.", {
          cause: signal.reason,
        }),
      );
      const observe = () => {
        if (failed || closed)
          finish(new Error("Development log persistence is unavailable."));
        else if (ready && !busy && !queue.length && !dropped) finish();
      };
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      persistenceObservers.add(observe);
      flush();
      observe();
    });
  return {
    flush: waitForPersistence,
    async close(options) {
      await followers.close();
      observeDevelopment({
        resourceId: "runtime:development",
        kind: "collector.stopped",
      });
      restore();
      clearInterval(interval);
      try {
        if (options?.signal) await waitForPersistence(options.signal);
        else {
          const deadline = Date.now() + 2000;
          while ((queue.length || busy) && ready && Date.now() < deadline) {
            flush();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        closed = true;
        if (writer?.connected) {
          const signal = options?.signal ?? AbortSignal.timeout(1000);
          await new Promise<void>((resolve, reject) => {
            const aborted = () => {
              closingResolve = undefined;
              if (options?.signal) reject(signal.reason);
              else resolve();
            };
            closingResolve = (error) => {
              signal.removeEventListener("abort", aborted);
              closingResolve = undefined;
              if (error && options?.signal) reject(error);
              else resolve();
            };
            if (signal.aborted) {
              aborted();
              return;
            }
            signal.addEventListener("abort", aborted, { once: true });
            writer!.send({ type: "close", dropped: dropped + queue.length });
          });
        }
      } finally {
        closed = true;
        notifyPersistence();
        const owned = writer;
        if (owned && owned.exitCode === null && owned.signalCode === null) {
          // The graceful IPC deadline has ended. This private writer cannot
          // extend shutdown by ignoring SIGTERM; await release after forceful
          // termination of only the child we created.
          owned.kill("SIGKILL");
        }
        await Promise.all(writerClosures);
      }
    },
  };
}

function followComposeOutput(
  options: {
    repositoryRoot: string;
    projectName: string;
    config: FrameworkConfig;
  },
  control: DevelopmentLogControl,
  checkpoint: ComposeOutputDependencies["checkpoint"],
): { close(): Promise<void> } {
  return followDevelopmentComposeOutput(options, control, { checkpoint });
}

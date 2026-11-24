import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import {
  DEVELOPMENT_LOG_LIMITS as limits,
  type DevelopmentLogControl,
  type DevelopmentLogEvent,
  type DevelopmentObservation,
} from "../../development-logs/contract";
import {
  registerDevelopmentSecrets,
  sanitizeDevelopmentObservation,
  setDevelopmentObservationSink,
} from "../../development-logs/context";

export interface DevelopmentLogBatchEntry {
  readonly observation: DevelopmentObservation;
  readonly eventId: string;
  readonly producer: DevelopmentLogEvent["producer"];
}
export function readDevelopmentLogControl(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentLogControl | undefined {
  const file =
    environment.FRAMEWORK_DEVELOPMENT_LOG_CONTROL ??
    path.join(repositoryRoot, ".framework", "local", "development-logs.json");
  try {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 16 * 1024
    )
      return undefined;
    const control = JSON.parse(
      readFileSync(file, "utf8"),
    ) as DevelopmentLogControl;
    if (
      control.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(control.token) ||
      !/^[a-f0-9-]{36}$/.test(control.runtimeSessionId) ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(control.composeProject) ||
      typeof control.repositoryKey !== "string" ||
      typeof control.bindingId !== "string" ||
      typeof control.declarationDigest !== "string" ||
      !control.binding
    )
      return undefined;
    const url = new URL(control.endpoint);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "local-invocation-runner"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return undefined;
    return control;
  } catch {
    return undefined;
  }
}

/** Bounded queue and single in-flight batch share one memory budget. Callers never await capture. */
export function createDevelopmentLogProducer(
  control: DevelopmentLogControl,
  options: {
    component: string;
    resourceId?: string;
    endpoint?: string;
    fetch?: typeof fetch;
  },
): {
  close(): Promise<void>;
  emit(event: DevelopmentObservation): void;
  readonly dropped: number;
} {
  registerDevelopmentSecrets("runtime:collector-capability", [control.token]);
  const instanceId = randomUUID();
  const component = options.component
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 64);
  const queue: { entry: DevelopmentLogBatchEntry; bytes: number }[] = [];
  let bytes = 0,
    sequence = 0,
    dropped = 0,
    reported = 0,
    inFlightCount = 0;
  let accepting = true,
    closed = false,
    disabled = false;
  let pending: Promise<boolean> | undefined,
    closing: Promise<void> | undefined,
    activeController: AbortController | undefined;
  const transport = options.fetch ?? fetch;
  const enqueue = (input: DevelopmentObservation) => {
    if (!accepting) return;
    try {
      if (
        !input ||
        typeof input !== "object" ||
        typeof Object.getOwnPropertyDescriptor(input, "resourceId")?.value !==
          "string" ||
        typeof Object.getOwnPropertyDescriptor(input, "kind")?.value !==
          "string"
      ) {
        dropped++;
        return;
      }
      const observation = sanitizeDevelopmentObservation(input);
      const entry = {
        observation,
        eventId: `${instanceId}:${++sequence}`,
        producer: { component, instanceId },
      };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (disabled || size > limits.recordBytes) {
        dropped++;
        return;
      }
      while (
        queue.length &&
        (queue.length + inFlightCount >= limits.producerRecords ||
          bytes + size > limits.producerBytes)
      ) {
        const lower = queue.findIndex(
          (value) =>
            value.entry.observation.level === "debug" ||
            value.entry.observation.level === "info",
        );
        if (
          lower < 0 &&
          (observation.level === "debug" || observation.level === "info")
        ) {
          dropped++;
          return;
        }
        const old = queue.splice(lower < 0 ? 0 : lower, 1)[0]!;
        bytes -= old.bytes;
        dropped++;
      }
      if (
        bytes + size > limits.producerBytes ||
        queue.length + inFlightCount >= limits.producerRecords
      ) {
        dropped++;
        return;
      }
      queue.push({ entry, bytes: size });
      bytes += size;
    } catch {
      dropped++;
    }
  };
  const body = (entries: readonly DevelopmentLogBatchEntry[], lost: number) =>
    JSON.stringify({
      version: 1,
      runtimeSessionId: control.runtimeSessionId,
      repositoryKey: control.repositoryKey,
      composeProject: control.composeProject,
      entries,
      dropped: lost,
    });
  const flush = (timeoutMs = 1000): Promise<boolean> => {
    if (pending) return pending;
    if (disabled || closed) return Promise.resolve(false);
    if (!queue.length && dropped <= reported) return Promise.resolve(true);
    const batch: typeof queue = [];
    const lost = dropped - reported;
    while (queue.length && batch.length < limits.batchRecords) {
      const next = queue[0]!;
      if (
        Buffer.byteLength(
          body([...batch.map((value) => value.entry), next.entry], lost),
        ) > limits.batchBytes
      )
        break;
      batch.push(queue.shift()!);
    }
    // Descriptor metadata is bounded at construction. Still fail open for an invalid caller-provided control.
    if (!batch.length && queue.length) {
      const oversized = queue.shift()!;
      bytes -= oversized.bytes;
      dropped++;
      return Promise.resolve(false);
    }
    inFlightCount = batch.length;
    const controller = new AbortController();
    activeController = controller;
    const operation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const send = async () => {
          const response = await transport(
            `${options.endpoint ?? control.endpoint}/development-logs/batch`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${control.token}`,
              },
              body: body(
                batch.map((value) => value.entry),
                lost,
              ),
              signal: controller.signal,
            },
          );
          await response.body?.cancel();
          return response;
        };
        const response = await Promise.race([
          send(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => {
                controller.abort();
                reject(new Error("Development collector unavailable"));
              },
              Math.max(1, timeoutMs),
            );
          }),
        ]);
        if (!response.ok) {
          if (response.status === 401 || response.status === 409) {
            disabled = true;
            dropped += batch.length;
            bytes -= batch.reduce((total, value) => total + value.bytes, 0);
            return false;
          }
          throw new Error("Development collector unavailable");
        }
        bytes -= batch.reduce((total, value) => total + value.bytes, 0);
        reported += lost;
        return true;
      } catch {
        if (!closed) queue.unshift(...batch);
        return false;
      } finally {
        if (timer) clearTimeout(timer);
        inFlightCount = 0;
        activeController = undefined;
        pending = undefined;
      }
    })();
    pending = operation;
    return operation;
  };
  const timer = setInterval(() => {
    void flush();
  }, 250);
  timer.unref();
  const restore = setDevelopmentObservationSink(enqueue);
  return {
    emit: enqueue,
    get dropped() {
      return dropped;
    },
    close() {
      if (closing) return closing;
      accepting = false;
      clearInterval(timer);
      restore();
      closing = (async () => {
        const deadline = Date.now() + 1500;
        while (
          (queue.length || pending || dropped > reported) &&
          Date.now() < deadline &&
          !disabled
        ) {
          const operation =
            pending ?? flush(Math.min(1000, deadline - Date.now()));
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const sent = await Promise.race([
            operation,
            new Promise<false>((resolve) => {
              deadlineTimer = setTimeout(
                () => resolve(false),
                Math.max(1, deadline - Date.now()),
              );
            }),
          ]);
          if (deadlineTimer) clearTimeout(deadlineTimer);
          if (!sent) break;
        }
        closed = true;
        activeController?.abort();
        dropped += queue.length + inFlightCount;
        queue.length = 0;
        bytes = 0;
      })();
      return closing;
    },
  };
}

export function initializeDevelopmentLogProducer(options: {
  component: string;
  repositoryRoot?: string;
  resourceId?: string;
}): { close(): Promise<void> } {
  if (process.env.FRAMEWORK_DEVELOPMENT_LOGS !== "1")
    return { async close() {} };
  const root = options.repositoryRoot ?? process.cwd();
  const control = readDevelopmentLogControl(root);
  if (!control) return { async close() {} };
  const privateValues: string[] = [];
  for (const file of [
    path.join(root, ".env"),
    path.join(root, "cdk-app/.env.dev"),
  ]) {
    try {
      const info = lstatSync(file);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024)
        privateValues.push(
          ...Object.values(parseEnv(readFileSync(file, "utf8"))).filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          ),
        );
    } catch {
      /* No new secret lookup is made. */
    }
  }
  registerDevelopmentSecrets("runtime:private-inputs", privateValues);
  return createDevelopmentLogProducer(control, options);
}

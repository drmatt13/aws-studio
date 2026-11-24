import type { ChildProcess } from "node:child_process";
import { types as nodeTypes } from "node:util";
import {
  DevelopmentTextFramer,
  observeDevelopment,
  withDevelopmentObservation,
  developmentSensitiveHttpEvent,
  type DevelopmentObservation,
  type DevelopmentCorrelation,
} from "../development-logs";

export interface LambdaObservation {
  readonly resourceId: string;
  readonly correlation: DevelopmentCorrelation;
  readonly workerId?: string;
  readonly sensitive?: boolean;
}

export interface LambdaOutputMessage {
  readonly type: "development-log";
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly encoding?: "base64";
  readonly observation?: LambdaObservation;
  readonly late?: boolean;
}
export interface LambdaEventMessage {
  readonly type: "development-observation";
  readonly event: DevelopmentObservation;
}
export interface LambdaGapMessage {
  readonly type: "development-log-gap";
  readonly reason: string;
  readonly observation?: LambdaObservation;
}
export function isLambdaDiagnosticMessage(
  value: unknown,
): value is LambdaOutputMessage | LambdaEventMessage | LambdaGapMessage {
  return (
    isLambdaOutputMessage(value) ||
    (!!value &&
      typeof value === "object" &&
      (((value as LambdaEventMessage).type === "development-observation" &&
        !!(value as LambdaEventMessage).event) ||
        (value as LambdaGapMessage).type === "development-log-gap"))
  );
}

export function isLambdaOutputMessage(
  value: unknown,
): value is LambdaOutputMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<LambdaOutputMessage>;
  return (
    message.type === "development-log" &&
    ["stdout", "stderr"].includes(message.stream ?? "") &&
    typeof message.text === "string"
  );
}

/** Gateways and every Lambda packaging lane apply the same auth-body omission policy. */
export const sensitiveDevelopmentHttpInvocation = developmentSensitiveHttpEvent;

/** A response-shaped handler result is observable independently of gateway completion. */
export function lambdaInvocationResultDetails(
  value: unknown,
  options: { sensitive?: boolean } = {},
): {
  readonly result: unknown;
  readonly http?: {
    readonly status: number;
    readonly source: "handler-result";
  };
} {
  let status: unknown;
  try {
    if (value && typeof value === "object" && !nodeTypes.isProxy(value))
      status = Object.getOwnPropertyDescriptor(value, "statusCode")?.value;
  } catch {
    // Inspecting diagnostic metadata must never change the handler's result.
  }
  return {
    result: lambdaInvocationPreview(value, options),
    ...(typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { http: { status, source: "handler-result" as const } }
      : {}),
  };
}

/** API Gateway body strings need content-aware handling before the generic event preview. */
export function lambdaInvocationPreview(
  value: unknown,
  options: { sensitive?: boolean } = {},
): unknown {
  try {
    if (options.sensitive || sensitiveDevelopmentHttpInvocation(value))
      return "[sensitive invocation payload omitted]";
    if (nodeTypes.isProxy(value)) return "[proxy preview omitted]";
    if (value && typeof value === "object") {
      const descriptor = (key: string) =>
        Object.getOwnPropertyDescriptor(value, key);
      const descriptors = {
        body: descriptor("body"),
        requestContext: descriptor("requestContext"),
        statusCode: descriptor("statusCode"),
        headers: descriptor("headers"),
        isBase64Encoded: descriptor("isBase64Encoded"),
      };
      const requestContext = descriptors.requestContext?.value;
      if (
        nodeTypes.isProxy(requestContext) ||
        nodeTypes.isProxy(descriptors.headers?.value)
      )
        return "[proxy preview omitted]";
      const eventType =
        requestContext && typeof requestContext === "object"
          ? Object.getOwnPropertyDescriptor(requestContext, "eventType")?.value
          : undefined;
      const websocket = ["CONNECT", "MESSAGE", "DISCONNECT"].includes(
        eventType,
      );
      const gatewayEvent =
        requestContext &&
        typeof requestContext === "object" &&
        (websocket ||
          !!Object.getOwnPropertyDescriptor(requestContext, "http"));
      if (
        descriptors.body &&
        (gatewayEvent || typeof descriptors.statusCode?.value === "number")
      ) {
        const safe: Record<string, unknown> = Object.create(null);
        let keys = 0;
        for (const key in value) {
          if (keys++ >= 64) {
            safe["[preview fields omitted]"] = true;
            break;
          }
          if (key.length > 1024) continue;
          const field = descriptor(key);
          if (field)
            safe[key] = "value" in field ? field.value : "[accessor omitted]";
        }
        if (safe) {
          const headers = descriptors.headers?.value as
            Record<string, unknown> | undefined;
          let contentType: unknown;
          if (headers && typeof headers === "object") {
            let count = 0;
            for (const key in headers) {
              if (count++ >= 64) break;
              if (key.toLowerCase() === "content-type") {
                contentType = Object.getOwnPropertyDescriptor(
                  headers,
                  key,
                )?.value;
                break;
              }
            }
          }
          const body = descriptors.body.value;
          let preview = body;
          const type =
            typeof contentType === "string"
              ? contentType.toLowerCase().split(";")[0]
              : undefined;
          if (descriptors.isBase64Encoded?.value)
            preview = "[binary body omitted]";
          else if (
            typeof body === "string" &&
            Buffer.byteLength(body) > 64 * 1024
          )
            preview = "[oversized body omitted]";
          else if (
            typeof body === "string" &&
            (type === "application/json" || type?.endsWith("+json"))
          ) {
            try {
              preview = JSON.parse(body);
            } catch {
              preview = "[invalid JSON omitted]";
            }
          } else if (
            typeof body === "string" &&
            type === "application/x-www-form-urlencoded"
          )
            preview = Object.fromEntries(new URLSearchParams(body));
          else if (!type && !websocket)
            preview = "[body omitted; content type unavailable]";
          else if (type && type !== "text/plain")
            preview = "[content type omitted]";
          return { ...safe, body: preview };
        }
        return safe;
      }
    }
    return value;
  } catch {
    return "[unavailable preview]";
  }
}

/** IPC output carries the child's async context; raw pipe bytes have only worker attribution. */
export function observeLambdaOutput(
  child: ChildProcess,
  resourceId: string,
  workerId: string,
  secrets: readonly string[],
  privacy: { sensitive?: boolean } = {},
): void {
  const redactionSecrets = Object.freeze([...secrets]);
  let reportedDrops = 0;
  const framers = new Map<
    string,
    {
      framer: DevelopmentTextFramer;
      late: boolean;
      pending: boolean;
      suppressed: boolean;
    }
  >();
  const write = (
    stream: "stdout" | "stderr",
    text: string | Buffer,
    observation?: LambdaObservation,
    late = false,
  ) => {
    const correlation = observation?.correlation;
    const key = `${stream}:${correlation?.invocationId ?? "worker"}`;
    let entry = framers.get(key);
    if (!entry) {
      // Bound residual line buffers even when a worker executes indefinitely.
      if (framers.size >= 16) {
        const oldest = framers.entries().next().value;
        if (oldest) {
          // An unfinished line may end halfway through a credential. Drop it whole.
          framers.delete(oldest[0]);
          if (oldest[1].pending && !oldest[1].suppressed)
            withDevelopmentObservation(
              { isolated: true, resourceId, correlation: {} },
              () =>
                observeDevelopment({
                  resourceId,
                  kind: "lambda.output.gap",
                  level: "warn",
                  details: { reason: "partial-line buffer evicted" },
                }),
            );
        }
      }
      const state = { late, pending: false, suppressed: false };
      const framer = new DevelopmentTextFramer(
        (message) =>
          withDevelopmentObservation(
            { isolated: true, resourceId, correlation: correlation ?? {} },
            () =>
              observeDevelopment({
                resourceId,
                kind: "lambda.output",
                stream,
                level: stream === "stderr" ? "error" : "info",
                message,
                correlation,
                details: { workerId },
                attribution: correlation?.invocationId
                  ? "invocation"
                  : "worker",
                late: state.late,
              }),
          ),
        redactionSecrets,
      );
      entry = Object.assign(state, { framer });
      framers.set(key, entry);
    }
    const newlyLate = late && !entry.late;
    entry.late ||= late;
    const sensitive = correlation?.invocationId
      ? observation?.sensitive === true
      : privacy.sensitive === true || observation?.sensitive === true;
    if (sensitive) {
      if (!entry.suppressed || newlyLate) {
        entry.suppressed = true;
        withDevelopmentObservation(
          { isolated: true, resourceId, correlation: correlation ?? {} },
          () =>
            observeDevelopment({
              resourceId,
              kind: "lambda.output",
              stream,
              level: stream === "stderr" ? "error" : "info",
              message: "[sensitive invocation output omitted]",
              attribution: correlation?.invocationId ? "invocation" : "worker",
              late,
            }),
        );
      }
      return;
    }
    entry.pending =
      typeof text === "string"
        ? !text.endsWith("\n")
        : text.length > 0 && text[text.length - 1] !== 10;
    entry.framer.push(text);
  };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.pipe(process[stream], { end: false });
    child[stream]?.on("data", (chunk: Buffer) => write(stream, chunk));
  }
  child.on("message", (message) => {
    const reply = message as {
      outputBudget?: { droppedFrames?: unknown };
      observation?: LambdaObservation;
    } | null;
    const count = reply?.outputBudget?.droppedFrames;
    if (
      typeof count === "number" &&
      Number.isSafeInteger(count) &&
      count > reportedDrops
    ) {
      const lost = count - reportedDrops;
      reportedDrops = count;
      withDevelopmentObservation(
        {
          isolated: true,
          resourceId,
          correlation: reply?.observation?.correlation ?? {},
        },
        () =>
          observeDevelopment({
            resourceId,
            kind: "lambda.output.gap",
            level: "warn",
            outcome: "worker-only",
            details: {
              workerId,
              reason:
                "IPC framing capacity; fallback output has worker attribution",
              count: lost,
            },
          }),
      );
    }
    if (
      isLambdaDiagnosticMessage(message) &&
      message.type === "development-log-gap"
    ) {
      withDevelopmentObservation(
        {
          isolated: true,
          resourceId,
          correlation: message.observation?.correlation ?? {},
        },
        () =>
          observeDevelopment({
            resourceId,
            kind: "lambda.output.gap",
            level: "warn",
            outcome: "worker-only",
            details: { workerId, reason: message.reason },
          }),
      );
      return;
    }
    if (
      isLambdaDiagnosticMessage(message) &&
      message.type === "development-observation"
    ) {
      withDevelopmentObservation(
        { isolated: true, resourceId, correlation: message.event.correlation },
        () => observeDevelopment({ ...message.event, resourceId }),
      );
      return;
    }
    if (!isLambdaOutputMessage(message)) return;
    if (message.observation?.sensitive) privacy.sensitive = true;
    // Forward the original bytes to the established combined Activity output.
    const text =
      message.encoding === "base64"
        ? Buffer.from(message.text, "base64")
        : message.text;
    process[message.stream].write(text);
    write(message.stream, text, message.observation, message.late);
  });
  child.once("close", () => {
    for (const entry of framers.values())
      if (!entry.suppressed) entry.framer.flush();
    framers.clear();
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type {
  DevelopmentCorrelation,
  DevelopmentObservation,
  DevelopmentObservationInput,
  DevelopmentLogOmission,
} from "./contract";
import { sanitizeDevelopmentText, sanitizeDevelopmentValue } from "./sanitize";

export interface DevelopmentObservationContext {
  readonly resourceId?: string;
  readonly correlation?: DevelopmentCorrelation;
  readonly secrets?: readonly string[];
  readonly sensitive?: boolean;
  readonly isolated?: boolean;
}
const context = new AsyncLocalStorage<DevelopmentObservationContext>();
let sink: ((event: DevelopmentObservation) => void) | undefined;
const secretValues = new Map<string, readonly string[]>();
const emptySecrets: readonly string[] = Object.freeze([]);
const suppressedSecrets: readonly string[] = Object.freeze([
  "__capture_suppressed__",
]);
let allSecrets: readonly string[] = emptySecrets;
let suppressPreviews = false;
export function setDevelopmentObservationSink(
  next: (event: DevelopmentObservation) => void,
): () => void {
  const previous = sink;
  sink = next;
  return () => {
    if (sink === next) sink = previous;
  };
}
export function registerDevelopmentSecrets(
  resourceId: string,
  values: readonly string[],
): void {
  if (suppressPreviews) return;
  const suppress = () => {
    suppressPreviews = true;
    secretValues.clear();
    allSecrets = emptySecrets;
  };
  try {
    if (
      typeof resourceId !== "string" ||
      resourceId.length > 1024 ||
      (secretValues.size >= 1024 && !secretValues.has(resourceId))
    ) {
      suppress();
      return;
    }
    const scoped = new Set(secretValues.get(resourceId) ?? []);
    const combined = new Set(allSecrets);
    let changedScoped = false,
      changedGlobal = false;
    let total = allSecrets.reduce((count, value) => count + value.length, 0);
    // Validate before retaining additions; repeated registrations cannot grow past the same budget.
    for (const value of values) {
      if (!value) continue;
      if (typeof value !== "string") {
        suppress();
        return;
      }
      if (!scoped.has(value)) {
        scoped.add(value);
        changedScoped = true;
      }
      if (!combined.has(value)) {
        combined.add(value);
        total += value.length;
        changedGlobal = true;
      }
      if (combined.size > 512 || total > 1024 * 1024) {
        suppress();
        return;
      }
    }
    if (changedScoped) secretValues.set(resourceId, Object.freeze([...scoped]));
    if (changedGlobal) allSecrets = Object.freeze([...combined]);
  } catch {
    suppress();
  }
}
export const developmentSecrets = (_resourceId?: string): readonly string[] =>
  suppressPreviews ? suppressedSecrets : allSecrets;
/** Only this workload's values may cross into its already isolated child process. */
export const resourceDevelopmentSecrets = (
  resourceId: string,
): readonly string[] =>
  suppressPreviews
    ? suppressedSecrets
    : (secretValues.get(resourceId) ?? emptySecrets);
export const currentDevelopmentObservation = ():
  DevelopmentObservationContext | undefined => context.getStore();
export function developmentCorrelation(): DevelopmentCorrelation | undefined {
  if (context.getStore()) return context.getStore()?.correlation;
  const bootstrap = process.env.FRAMEWORK_DEVELOPMENT_OBSERVATION;
  if (
    process.env.FRAMEWORK_DEVELOPMENT_LOGS !== "1" ||
    !bootstrap ||
    bootstrap.length > 4096
  )
    return undefined;
  try {
    return sanitizeDevelopmentCorrelation(JSON.parse(bootstrap).correlation);
  } catch {
    return undefined;
  }
}
export function withDevelopmentObservation<T>(
  value: DevelopmentObservationContext,
  body: () => T,
): T {
  const parent = value.isolated ? undefined : context.getStore();
  return context.run(
    {
      ...parent,
      ...value,
      correlation: { ...parent?.correlation, ...value.correlation },
    },
    body,
  );
}
const correlationKeys = [
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
] as const;
export function sanitizeDevelopmentCorrelation(
  value: unknown,
): DevelopmentCorrelation {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value))
    return {};
  const result: Record<string, string | number> = {};
  try {
    for (const key of correlationKeys) {
      const item = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (
        typeof item === "string" &&
        item.length <= 256 &&
        !/[\r\n\0]/.test(item)
      )
        result[key] = sanitizeDevelopmentText(item);
    }
    for (const key of ["mapIndex", "deliveryAttempt"] as const) {
      const item = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
        result[key] = item;
    }
  } catch {
    return {};
  }
  return result;
}
export function newDevelopmentCorrelation(
  overrides: DevelopmentCorrelation = {},
): DevelopmentCorrelation {
  const parent = developmentCorrelation();
  return {
    ...parent,
    traceId: parent?.traceId ?? randomUUID(),
    parentSpanId: parent?.spanId,
    spanId: randomUUID(),
    ...sanitizeDevelopmentCorrelation(overrides),
  };
}
/** ASCII and byte bounded: diagnostic headers must never make an otherwise valid request fail. */
export function encodeDevelopmentCorrelation(
  value: unknown = developmentCorrelation(),
): string {
  const safe = sanitizeDevelopmentCorrelation(value);
  const encoded = (input: DevelopmentCorrelation) =>
    JSON.stringify(input).replace(
      /[^\x20-\x7e]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  const result: Record<string, string | number> = {};
  for (const key of [
    ...correlationKeys,
    "deliveryAttempt",
    "mapIndex",
  ] as const) {
    const item = safe[key];
    if (
      item !== undefined &&
      encoded({ ...result, [key]: item }).length <= 2048
    )
      result[key] = item;
  }
  return encoded(result);
}
function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value))
    return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}
function boundedArrayLength(value: unknown, limit: number): number {
  const length = ownValue(value, "length");
  return typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length >= 0
    ? Math.min(length, limit)
    : 0;
}
export function sanitizeDevelopmentObservation(
  input: DevelopmentObservationInput,
): DevelopmentObservation {
  const scoped = context.getStore();
  const field = (key: string) => ownValue(input, key);
  const baseSecrets = developmentSecrets();
  const secrets = scoped?.secrets?.length
    ? Object.freeze([...baseSecrets, ...scoped.secrets])
    : baseSecrets;
  const sensitive =
    scoped?.sensitive === true || secrets.includes("__capture_suppressed__");
  const rawDetails = field("details"),
    rawMessage = field("message");
  const preview =
    rawDetails === undefined
      ? { value: undefined, omissions: [] }
      : sanitizeDevelopmentValue(rawDetails, { secrets, sensitive });
  const messagePreview =
    typeof rawMessage === "string"
      ? sanitizeDevelopmentValue(rawMessage, {
          secrets,
          sensitive,
          limit: 4096,
        })
      : undefined;
  const message =
    messagePreview === undefined
      ? undefined
      : typeof messagePreview.value === "string"
        ? messagePreview.value
        : JSON.stringify(messagePreview.value);
  const omissions: DevelopmentLogOmission[] = [
    ...preview.omissions,
    ...(messagePreview?.omissions.map((value) => ({
      ...value,
      path: `$.message${value.path.slice(1)}`,
    })) ?? []),
  ].slice(0, 32);
  const previous = field("omissions");
  if (!nodeTypes.isProxy(previous) && Array.isArray(previous))
    for (
      let index = 0;
      index < boundedArrayLength(previous, 32) && omissions.length < 32;
      index++
    ) {
      const value = ownValue(previous, String(index));
      const path = ownValue(value, "path"),
        reason = ownValue(value, "reason"),
        count = ownValue(value, "count");
      if (
        typeof path !== "string" ||
        typeof reason !== "string" ||
        !["privacy", "size", "depth", "circular", "unsupported"].includes(
          reason,
        )
      )
        continue;
      const safePath = sanitizeDevelopmentText(path, secrets).slice(0, 160);
      if (
        !omissions.some(
          (item) => item.path === safePath && item.reason === reason,
        )
      )
        omissions.push({
          path: safePath,
          reason: reason as DevelopmentLogOmission["reason"],
          ...(typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count > 0
            ? { count: Math.min(count, 1_000_000) }
            : {}),
        });
    }
  const relatedResourceIds: string[] = [];
  const rawRelated = field("relatedResourceIds");
  if (!nodeTypes.isProxy(rawRelated) && Array.isArray(rawRelated))
    for (
      let index = 0;
      index < boundedArrayLength(rawRelated, 16) &&
      relatedResourceIds.length < 3;
      index++
    ) {
      const value = ownValue(rawRelated, String(index));
      if (typeof value === "string" && value.length <= 1024) {
        const id = sanitizeDevelopmentText(value);
        if (!relatedResourceIds.includes(id)) relatedResourceIds.push(id);
      }
    }
  const correlation = {
    ...sanitizeDevelopmentCorrelation(scoped?.correlation),
    ...sanitizeDevelopmentCorrelation(field("correlation")),
  };
  const id = field("resourceId"),
    kind = field("kind"),
    rawLevel = field("level"),
    rawStream = field("stream"),
    rawAttribution = field("attribution");
  const level =
    typeof rawLevel === "string" &&
    ["debug", "info", "warn", "error"].includes(rawLevel)
      ? (rawLevel as DevelopmentObservation["level"])
      : "info";
  const stream =
    typeof rawStream === "string" &&
    ["stdout", "stderr", "event"].includes(rawStream)
      ? (rawStream as DevelopmentObservation["stream"])
      : "event";
  const attribution =
    typeof rawAttribution === "string" &&
    ["resource", "worker", "session", "invocation", "execution"].includes(
      rawAttribution,
    )
      ? (rawAttribution as DevelopmentObservation["attribution"])
      : correlation.invocationId
        ? "invocation"
        : "resource";
  const stamp = field("occurredAt"),
    phase = field("phase"),
    outcome = field("outcome"),
    duration = field("durationMs");
  return {
    resourceId:
      typeof id === "string" && id.length <= 1024
        ? sanitizeDevelopmentText(id)
        : "[invalid resource identity]",
    kind:
      typeof kind === "string" && /^[a-zA-Z0-9_.-]{1,96}$/.test(kind)
        ? kind
        : "observation",
    relatedResourceIds,
    level,
    stream,
    attribution,
    correlation,
    occurredAt:
      typeof stamp === "string" &&
      stamp.length <= 128 &&
      Number.isFinite(Date.parse(stamp))
        ? new Date(stamp).toISOString()
        : new Date().toISOString(),
    ...(message === undefined ? {} : { message }),
    ...(rawDetails === undefined ? {} : { details: preview.value }),
    omissions,
    ...(typeof phase === "string"
      ? { phase: sanitizeDevelopmentText(phase, secrets).slice(0, 80) }
      : {}),
    ...(typeof outcome === "string"
      ? { outcome: sanitizeDevelopmentText(outcome, secrets).slice(0, 80) }
      : {}),
    ...(typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= 0
      ? { durationMs: Math.min(duration, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(field("late") === true ? { late: true } : {}),
  };
}
export function observeDevelopment(input: DevelopmentObservationInput): void {
  if (!sink) return;
  try {
    sink(sanitizeDevelopmentObservation(input));
  } catch {
    /* Fail open, including malicious getters/proxies and a failed observer. */
  }
}

import type { DevelopmentLogEvent } from "./development-logs";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
/** Safe response metadata is independent of a possibly omitted response body. */
export function developmentHttpStatus(
  event: DevelopmentLogEvent,
): number | undefined {
  const details = record(event.details);
  const value =
    record(details?.http)?.status ??
    ([
      "http.integration.completed",
      "http.response.finished",
      "http.response.aborted",
    ].includes(event.kind)
      ? details?.status
      : ["lambda.invocation.completed", "lambda.succeeded"].includes(event.kind)
        ? record(details?.result)?.statusCode
        : undefined);
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}
export function developmentDuration(
  event: DevelopmentLogEvent,
): number | undefined {
  return typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs) &&
    event.durationMs >= 0
    ? event.durationMs
    : undefined;
}
export function developmentHttpStatusSource(
  event: DevelopmentLogEvent,
): "handler-result" | "integration-returned" | "gateway-response" | undefined {
  if (developmentHttpStatus(event) === undefined) return undefined;
  return ["http.response.finished", "http.response.aborted"].includes(
    event.kind,
  )
    ? "gateway-response"
    : event.kind === "http.integration.completed"
      ? "integration-returned"
      : "handler-result";
}
export function developmentWorkerMode(
  event: DevelopmentLogEvent,
): "cold" | "warm" | undefined {
  const value = ["lambda.worker", "lambda.started"].includes(event.kind)
    ? ["cold", "warm"].includes(event.phase ?? "")
      ? event.phase
      : record(event.details)?.mode
    : undefined;
  return value === "cold" || value === "warm" ? value : undefined;
}

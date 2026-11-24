import type { DevelopmentLogEvent } from "./development-logs";
import {
  developmentDuration,
  developmentHttpStatus,
  developmentHttpStatusSource,
  developmentWorkerMode,
} from "./development-log-outcomes";

export interface DevelopmentLogOperationSummary {
  readonly label: string;
  readonly tone: "neutral" | "warning" | "error";
  readonly execution:
    | "returned"
    | "failed"
    | "timed-out"
    | "cancelled"
    | "aborted"
    | "unobserved";
  readonly httpStatus?: number;
  readonly httpStatusSource?:
    "handler-result" | "integration-returned" | "gateway-response";
  readonly durationMs?: number;
  readonly worker?: "cold" | "warm";
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly missingStart: boolean;
  readonly errorExcerpt?: string;
}

export interface DevelopmentLogOperation {
  readonly id: string;
  readonly kind: "invocation" | "request" | "event";
  readonly resourceId: string;
  readonly runtimeSessionId: string;
  readonly traceId?: string;
  readonly events: readonly DevelopmentLogEvent[];
  readonly summary: DevelopmentLogOperationSummary;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const started = (event: DevelopmentLogEvent) =>
  /^(?:lambda\.invocation\.started|lambda\.started|lambda\.accepted|http\.request\.received|workflow\.accepted|agent\.turn_started|task\.submitted|task\.started)$/.test(
    event.kind,
  );
const terminal = (event: DevelopmentLogEvent) =>
  /^(?:lambda\.invocation\.(?:completed|failed|timed-out|cancelled)|lambda\.(?:succeeded|failed|timeout|cancelled)|http\.response\.(?:finished|aborted)|workflow\.finished|task\.finished|agent\.(?:transport_finished|turn_failed|turn_cancelled|invocation_completed|invocation_failed))$/.test(
    event.kind,
  );

/** One outcome policy shared by inspector rows, trace inspection and agent evidence. */
export function summarizeDevelopmentLogOperation(
  input: readonly DevelopmentLogEvent[],
  options: { readonly scope?: "operation" | "span" } = {},
): DevelopmentLogOperationSummary {
  const events = [...input].sort((a, b) => a.ingestSequence - b.ingestSequence);
  const starts = (event: DevelopmentLogEvent) =>
    started(event) ||
    (options.scope === "span" &&
      /^(?:workflow\.state\.entered|agent\.tool_dispatched|integration\.dispatched|build\.started)$/.test(
        event.kind,
      ));
  const ends = (event: DevelopmentLogEvent) =>
    terminal(event) ||
    (options.scope === "span" &&
      /^(?:workflow\.state\.(?:exited|failed|caught|retrying)|agent\.tool_(?:completed|failed)|integration\.(?:returned|failed|cancelled)|build\.(?:succeeded|failed|cancelled))$/.test(
        event.kind,
      ));
  const first = events.find(starts) ?? events[0];
  const endings = events.filter(ends);
  const end = endings.at(-1);
  const timedOut = endings.some(
    (event) =>
      /(?:timed-out|timeout)$/.test(event.kind) ||
      /^(?:timed-out|timed_out)$/.test(event.outcome ?? ""),
  );
  const endDetails = record(end?.details);
  const outcome =
    end?.outcome ??
    (typeof endDetails?.status === "string" ? endDetails.status : undefined);
  const execution: DevelopmentLogOperationSummary["execution"] = timedOut
    ? "timed-out"
    : end?.kind === "http.response.aborted"
      ? "aborted"
      : /cancelled$/.test(end?.kind ?? "") ||
          outcome === "cancelled" ||
          outcome === "aborted"
        ? "cancelled"
        : /failed$/.test(end?.kind ?? "") || outcome === "failed"
          ? "failed"
          : end
            ? "returned"
            : "unobserved";
  // An actual finished HTTP response is stronger evidence than its integration's return.
  const httpEvent =
    [...events]
      .reverse()
      .find(
        (event) =>
          event.kind === "http.response.finished" &&
          developmentHttpStatus(event) !== undefined,
      ) ??
    [...events]
      .reverse()
      .find((event) => developmentHttpStatus(event) !== undefined);
  const httpStatus = httpEvent ? developmentHttpStatus(httpEvent) : undefined;
  const httpStatusSource = httpEvent
    ? developmentHttpStatusSource(httpEvent)
    : undefined;
  const workerEvent = [...events]
    .reverse()
    .find((event) => developmentWorkerMode(event) !== undefined);
  const worker = workerEvent ? developmentWorkerMode(workerEvent) : undefined;
  const measured = end ? developmentDuration(end) : undefined;
  const startTime = first ? Date.parse(first.occurredAt) : NaN;
  const endTime = end ? Date.parse(end.occurredAt) : NaN;
  const durationMs =
    typeof measured === "number" && Number.isFinite(measured) && measured >= 0
      ? measured
      : first &&
          starts(first) &&
          end &&
          Number.isFinite(startTime) &&
          endTime >= startTime
        ? endTime - startTime
        : undefined;
  const error = [...events]
    .reverse()
    .find((event) => event.level === "error" && !!event.message);
  const terminalError = endDetails?.error;
  const terminalErrorMessage =
    typeof terminalError === "string"
      ? terminalError
      : record(terminalError)?.message;
  const errorExcerpt =
    error?.message ??
    (typeof terminalErrorMessage === "string"
      ? terminalErrorMessage
      : undefined);
  const label =
    execution === "timed-out"
      ? "Timed out"
      : execution === "cancelled"
        ? "Cancelled"
        : execution === "aborted"
          ? "Request aborted"
          : execution === "failed"
            ? "Execution failed"
            : end?.kind === "workflow.state.caught"
              ? "Failure caught"
              : end?.kind === "workflow.state.retrying"
                ? "Retry scheduled"
                : httpStatus !== undefined
                  ? httpStatusSource === "handler-result"
                    ? `Returned status ${httpStatus}`
                    : `HTTP ${httpStatus}`
                  : end?.kind === "agent.transport_finished"
                    ? "Transport finished"
                    : end?.kind === "integration.returned" &&
                        endDetails?.completion === "service-acceptance"
                      ? "Accepted by service"
                      : execution === "returned"
                        ? "Completed"
                        : first && starts(first)
                          ? "Completion not observed"
                          : "Partial evidence";
  return {
    label,
    tone:
      execution === "failed" ||
      execution === "timed-out" ||
      execution === "aborted" ||
      (httpStatus !== undefined && httpStatus >= 500)
        ? "error"
        : execution === "cancelled" ||
            /workflow\.state\.(?:caught|retrying)/.test(end?.kind ?? "") ||
            (httpStatus !== undefined && httpStatus >= 400)
          ? "warning"
          : "neutral",
    execution,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(httpStatusSource ? { httpStatusSource } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(worker ? { worker } : {}),
    startedAt: first?.occurredAt ?? "",
    ...(end ? { endedAt: end.occurredAt } : {}),
    missingStart: !events.some(starts),
    ...(errorExcerpt ? { errorExcerpt: errorExcerpt.slice(0, 400) } : {}),
  };
}

/** Group only explicit operation identities; resource-level/native output stays independent. */
export function groupDevelopmentLogOperations(
  events: readonly DevelopmentLogEvent[],
): readonly DevelopmentLogOperation[] {
  const groups = new Map<
    string,
    { kind: DevelopmentLogOperation["kind"]; events: DevelopmentLogEvent[] }
  >();
  const seen = new Set<string>();
  for (const event of events) {
    const eventKey = `${event.runtimeSessionId}:${event.eventId}`;
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const invocation =
      event.resource.id.startsWith("lambda:") &&
      event.correlation.invocationId &&
      (event.kind.startsWith("lambda.") || event.kind === "process.output");
    const request =
      event.correlation.requestId && event.kind.startsWith("http.");
    const kind = invocation ? "invocation" : request ? "request" : "event";
    const identity = invocation
      ? event.correlation.invocationId
      : request
        ? event.correlation.requestId
        : event.eventId;
    const key = JSON.stringify([
      event.runtimeSessionId,
      event.resource.id,
      kind,
      identity,
    ]);
    const existing = groups.get(key);
    if (existing) existing.events.push(event);
    else groups.set(key, { kind, events: [event] });
  }
  return [...groups]
    .map(([id, group]) => {
      group.events.sort((a, b) => a.ingestSequence - b.ingestSequence);
      const first = group.events[0]!;
      return {
        id,
        kind: group.kind,
        resourceId: first.resource.id,
        runtimeSessionId: first.runtimeSessionId,
        ...(first.correlation.traceId
          ? { traceId: first.correlation.traceId }
          : {}),
        events: group.events,
        summary: summarizeDevelopmentLogOperation(group.events),
      };
    })
    .sort((a, b) => a.events[0]!.ingestSequence - b.events[0]!.ingestSequence);
}

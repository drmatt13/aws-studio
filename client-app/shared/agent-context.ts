/** Compact contextual evidence, never tools, instructions, source access or operational authority. */
export const CONVERSATION_CONTEXT_LIMIT = 6_000;
export interface ConversationContext {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly source: {
    readonly mode: "dev" | "prod";
    readonly revision: string;
    readonly stale: boolean;
    readonly connected: boolean;
    readonly modelStatus?: "ok" | "error";
    readonly evaluating?: boolean;
    readonly latestRevision?: string;
    readonly draftDirty?: boolean;
    readonly draftConflicted?: boolean;
  };
  readonly focus: {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly description?: string;
    readonly declared: Readonly<Record<string, string | boolean>>;
    readonly relationships: readonly {
      readonly relation: string;
      readonly from: string;
      readonly to: string;
    }[];
  } | null;
  readonly application?: {
    readonly counts: {
      readonly workloads: number;
      readonly resources: number;
      readonly routes: number;
    };
    readonly workloads: readonly {
      readonly id: string;
      readonly name: string;
      readonly kind: string;
    }[];
  };
  readonly observations: {
    readonly availability: string;
    readonly reason?: string;
    readonly collection?: string;
    readonly observedAt?: string;
    readonly runId?: string;
    readonly gaps: number;
    /** Why cached evidence is unavailable, as distinct from evidence that was read and excluded. */
    readonly gapReasons?: readonly string[];
    /** What the bounded reads covered. `olderUnread` flags mean earlier records were never read. */
    readonly window?: {
      readonly records: number;
      readonly olderUnread: boolean;
      readonly olderErrorsUnread: boolean;
    };
    /** Read but not shown in `executions` or `entries`. */
    readonly excluded?: {
      readonly executions: number;
      readonly failed: number;
      readonly records: number;
      readonly errorLevel: number;
    };
    /** One digest per explicitly identified invocation or request, most relevant first. */
    readonly executions?: readonly ConversationExecution[];
    /** Records outside every identified execution. */
    readonly entries: readonly ConversationObservation[];
  };
  readonly trace?: {
    readonly id: string;
    readonly complete: boolean;
    readonly observedAt: string;
    readonly omitted: number;
    readonly spans: readonly {
      readonly id: string;
      readonly parentId?: string;
      readonly resourceId: string;
      readonly outcome?: string;
      readonly httpStatus?: number;
      readonly httpStatusSource?:
        "handler-result" | "integration-returned" | "gateway-response";
      readonly durationMs?: number;
      readonly incomplete: boolean;
    }[];
  };
  readonly omitted: readonly string[];
}
export interface ConversationExecution {
  /** Present only when it is not the focused resource. */
  readonly resourceId?: string;
  readonly invocationId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** `unobserved`: no terminal record was read. Never a success. */
  readonly outcome:
    "returned" | "failed" | "timed-out" | "cancelled" | "aborted" | "unobserved";
  readonly httpStatus?: number;
  readonly httpStatusSource?:
    "handler-result" | "integration-returned" | "gateway-response";
  readonly durationMs?: number;
  readonly workerMode?: "cold" | "warm";
  readonly startObserved: boolean;
  readonly endedAt?: string;
  readonly lastRecordAt?: string;
  readonly ageSeconds?: number;
  readonly error?: string;
  readonly errorLevelOutput?: string;
}
export interface ConversationObservation {
  readonly at: string;
  readonly resourceId: string;
  readonly kind: string;
  /** Log severity of this record. Not an execution outcome. */
  readonly level?: "debug" | "info" | "warn" | "error";
  readonly attribution?:
    "resource" | "worker" | "session" | "invocation" | "execution";
  readonly outcome?: string;
  readonly httpStatus?: number;
  readonly httpStatusSource?:
    "handler-result" | "integration-returned" | "gateway-response";
  readonly durationMs?: number;
  readonly workerMode?: "cold" | "warm";
  readonly excerpt?: string;
  readonly payloadPreview?: string;
  readonly correlation: Readonly<Record<string, string | number>>;
}
type Check = (value: unknown) => boolean;
const str =
  (limit: number): Check =>
  (value) =>
    typeof value === "string" && value.length <= limit;
const num: Check = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const bool: Check = (value) => typeof value === "boolean";
const list =
  (check: Check, count: number): Check =>
  (value) =>
    Array.isArray(value) && value.length <= count && value.every(check);
const obj =
  (fields: Record<string, Check>, optional: readonly string[] = []): Check =>
  (value) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(
      ([key, check]) =>
        (optional.includes(key) && !Object.hasOwn(value, key)) ||
        check((value as Record<string, unknown>)[key]),
    );
const status: Check = (value) =>
  Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599;
const correlationKeys = new Set([
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
  "deliveryAttempt",
  "agentSessionId",
  "turnId",
  "toolCallId",
  "stateId",
  "stateAttemptId",
  "branchPath",
  "mapIndex",
  "buildId",
]);
const correlation: Check = (value) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.entries(value).length <= 6 &&
  Object.entries(value).every(
    ([key, item]) => correlationKeys.has(key) && (str(100)(item) || num(item)),
  );
const oneOf =
  (...allowed: string[]): Check =>
  (value) =>
    typeof value === "string" && allowed.includes(value);
const httpStatusSource = oneOf(
  "handler-result",
  "integration-returned",
  "gateway-response",
);
const execution = obj(
  {
    resourceId: str(600),
    invocationId: str(100),
    requestId: str(100),
    traceId: str(256),
    outcome: oneOf(
      "returned",
      "failed",
      "timed-out",
      "cancelled",
      "aborted",
      "unobserved",
    ),
    httpStatus: status,
    httpStatusSource,
    durationMs: num,
    workerMode: oneOf("cold", "warm"),
    startObserved: bool,
    endedAt: str(40),
    lastRecordAt: str(40),
    ageSeconds: num,
    // Captured at 240; server redaction markers can lengthen a string, as with `excerpt`.
    error: str(360),
    errorLevelOutput: str(360),
  },
  [
    "resourceId",
    "invocationId",
    "requestId",
    "traceId",
    "httpStatus",
    "httpStatusSource",
    "durationMs",
    "workerMode",
    "endedAt",
    "lastRecordAt",
    "ageSeconds",
    "error",
    "errorLevelOutput",
  ],
);
const observation = obj(
  {
    at: str(40),
    resourceId: str(600),
    kind: str(120),
    level: oneOf("debug", "info", "warn", "error"),
    attribution: oneOf(
      "resource",
      "worker",
      "session",
      "invocation",
      "execution",
    ),
    outcome: str(80),
    httpStatus: status,
    httpStatusSource: (value) =>
      ["handler-result", "integration-returned", "gateway-response"].includes(
        String(value),
      ),
    durationMs: num,
    workerMode: (value) => value === "cold" || value === "warm",
    excerpt: str(360),
    payloadPreview: str(480),
    correlation,
  },
  [
    "level",
    "attribution",
    "outcome",
    "httpStatus",
    "httpStatusSource",
    "durationMs",
    "workerMode",
    "excerpt",
    "payloadPreview",
  ],
);
const contextCheck = obj(
  {
    schemaVersion: (value) => value === 1,
    capturedAt: str(40),
    source: obj(
      {
        mode: (value) => value === "dev" || value === "prod",
        revision: str(100),
        stale: bool,
        connected: bool,
        modelStatus: (value) => value === "ok" || value === "error",
        evaluating: bool,
        latestRevision: str(100),
        draftDirty: bool,
        draftConflicted: bool,
      },
      [
        "modelStatus",
        "evaluating",
        "latestRevision",
        "draftDirty",
        "draftConflicted",
      ],
    ),
    focus: (value) =>
      value === null ||
      obj(
        {
          id: str(600),
          name: str(240),
          kind: str(80),
          description: str(400),
          declared: (value) =>
            !!value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.entries(value).length <= 8 &&
            Object.entries(value).every(
              ([key, item]) =>
                [
                  "kind",
                  "role",
                  "runtime",
                  "deploy",
                  "local",
                  "cloud",
                  "targetId",
                  "constructId",
                ].includes(key) &&
                (str(240)(item) || bool(item)),
            ),
          relationships: list(
            obj({ relation: str(80), from: str(600), to: str(600) }),
            8,
          ),
        },
        ["description"],
      )(value),
    application: obj({
      counts: obj({ workloads: num, resources: num, routes: num }),
      workloads: list(obj({ id: str(600), name: str(240), kind: str(80) }), 6),
    }),
    observations: obj(
      {
        availability: str(80),
        reason: str(320),
        collection: str(80),
        observedAt: str(40),
        runId: str(100),
        gaps: num,
        gapReasons: list(
          oneOf(
            "retention",
            "dropped",
            "restart",
            "storage",
            "truncated",
            "source-unavailable",
          ),
          6,
        ),
        window: obj({
          records: num,
          olderUnread: bool,
          olderErrorsUnread: bool,
        }),
        excluded: obj({
          executions: num,
          failed: num,
          records: num,
          errorLevel: num,
        }),
        executions: list(execution, 3),
        entries: list(observation, 4),
      },
      [
        "reason",
        "collection",
        "observedAt",
        "runId",
        "gapReasons",
        "window",
        "excluded",
        "executions",
      ],
    ),
    trace: obj({
      id: str(256),
      complete: bool,
      observedAt: str(40),
      omitted: num,
      spans: list(
        obj(
          {
            id: str(256),
            parentId: str(256),
            resourceId: str(600),
            outcome: str(80),
            httpStatus: status,
            httpStatusSource: (value) =>
              [
                "handler-result",
                "integration-returned",
                "gateway-response",
              ].includes(String(value)),
            durationMs: num,
            incomplete: bool,
          },
          [
            "parentId",
            "outcome",
            "httpStatus",
            "httpStatusSource",
            "durationMs",
          ],
        ),
        8,
      ),
    }),
    omitted: list(str(160), 24),
  },
  ["trace", "application"],
);
export function parseConversationContext(
  serialized: unknown,
): ConversationContext {
  if (
    typeof serialized !== "string" ||
    serialized.length > CONVERSATION_CONTEXT_LIMIT
  )
    throw new Error("Studio context exceeds its budget.");
  const value: unknown = JSON.parse(serialized);
  if (!contextCheck(value))
    throw new Error("Studio context has an unsupported shape.");
  const context = value as ConversationContext;
  if (
    context.source.mode === "prod" &&
    (context.observations.availability !== "not-applicable" ||
      context.observations.entries.length ||
      context.trace ||
      context.observations.runId ||
      context.observations.collection ||
      context.observations.observedAt ||
      context.observations.gaps ||
      context.observations.gapReasons ||
      context.observations.window ||
      context.observations.excluded ||
      context.observations.executions)
  )
    throw new Error(
      "Production context cannot contain development execution evidence.",
    );
  return context;
}

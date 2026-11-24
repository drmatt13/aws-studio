import type {
  DevelopmentLogEvent,
  DevelopmentLogPage,
  DevelopmentLogRun,
} from "aws-studio/development-logs/contract";
import type { DevelopmentLogScope } from "./development-log-scope";
import type { DevelopmentLogOperationSummary } from "./development-log-operations";

export type { DevelopmentLogEvent, DevelopmentLogPage, DevelopmentLogRun };
export interface DevelopmentLogExcerpt {
  readonly ingestSequence?: number;
  readonly eventId: string;
  readonly resourceId: string;
  readonly runtimeSessionId: string;
  readonly at: string;
  readonly level: DevelopmentLogEvent["level"];
  readonly kind: string;
  readonly outcome?: string;
  readonly httpStatus?: number;
  readonly httpStatusSource?:
    "handler-result" | "integration-returned" | "gateway-response";
  readonly durationMs?: number;
  readonly workerMode?: "cold" | "warm";
  readonly attribution: DevelopmentLogEvent["attribution"];
  readonly message?: string;
  readonly detailsPreview?: string;
  readonly correlation: DevelopmentLogEvent["correlation"];
  readonly truncated: boolean;
}
/** One explicitly identified invocation or request, summarized from the records that were read. */
export interface DevelopmentLogExecution {
  /** Ingest sequence of its terminal record, or of its newest record while none was read. Ordering only; never sent to a model. */
  readonly sequence: number;
  readonly resourceId: string;
  readonly invocationId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  /** `unobserved` means no terminal record was read. It is not an outcome. */
  readonly outcome: DevelopmentLogOperationSummary["execution"];
  readonly httpStatus?: number;
  readonly httpStatusSource?:
    "handler-result" | "integration-returned" | "gateway-response";
  readonly durationMs?: number;
  readonly workerMode?: "cold" | "warm";
  readonly startObserved: boolean;
  readonly endedAt?: string;
  /** Present only without a terminal record. */
  readonly lastRecordAt?: string;
  /** Against the read's `observedAt`; absent when the clocks disagree. */
  readonly ageSeconds?: number;
  /** A failure the framework recorded for this execution. */
  readonly error?: string;
  /** Error-level output inside it, such as stderr. Severity alone is not a failed outcome. */
  readonly errorLevelOutput?: string;
  readonly records: number;
  readonly errorLevel: number;
}
export interface DevelopmentLogExclusions {
  readonly executions: number;
  readonly failed: number;
  readonly records: number;
  readonly errorLevel: number;
}
/** The outcome policy's error tone, restated over the fields a digest keeps. */
export const developmentExecutionFailed = (execution: {
  readonly outcome: string;
  readonly httpStatus?: number;
}): boolean =>
  ["failed", "timed-out", "aborted"].includes(execution.outcome) ||
  (execution.httpStatus ?? 0) >= 500;
export interface DevelopmentLogEvidence {
  readonly schemaVersion: 1;
  readonly source: "development";
  readonly observedAt: string;
  readonly collection: DevelopmentLogPage["collection"];
  readonly run?: DevelopmentLogRun;
  readonly scope?: DevelopmentLogScope;
  /** Most relevant first: latest terminal, latest failed, then one still running. */
  readonly executions: readonly DevelopmentLogExecution[];
  /** Records outside every identified execution. */
  readonly entries: readonly DevelopmentLogExcerpt[];
  /** What the two bounded reads covered. Never a statement about unread history. */
  readonly window: {
    readonly records: number;
    readonly olderUnread: boolean;
    readonly olderErrorsUnread: boolean;
  };
  /** Read, but left out of `executions` and `entries`. */
  readonly excluded: DevelopmentLogExclusions;
  readonly gaps: DevelopmentLogPage["gaps"];
  readonly dropped: number;
  readonly truncated: number;
}

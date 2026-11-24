/** Development evidence only. This contract contains no transport or application authority. */
export const DEVELOPMENT_LOG_VERSION = 1 as const;
export const DEVELOPMENT_LOG_LIMITS = Object.freeze({
  ageMs: 7 * 24 * 60 * 60 * 1000,
  runs: 20,
  bytes: 128 * 1024 * 1024,
  records: 100_000,
  resourceBytes: 8 * 1024 * 1024,
  resourceRecords: 10_000,
  metadataBytes: 16 * 1024 * 1024,
  spoolBytes: 8 * 1024 * 1024,
  directoryBytes: 192 * 1024 * 1024,
  segmentBytes: 256 * 1024,
  recordBytes: 16 * 1024,
  previewBytes: 4096,
  stringBytes: 1024,
  frameBytes: 64 * 1024,
  producerBytes: 256 * 1024,
  producerRecords: 512,
  collectorBytes: 4 * 1024 * 1024,
  collectorRecords: 4096,
  batchRecords: 32,
  batchBytes: 256 * 1024,
  pageRecords: 200,
  pageBytes: 256 * 1024,
  scanBytes: 2 * 1024 * 1024,
  scanRecords: 2000,
});
export type DevelopmentLogLevel = "debug" | "info" | "warn" | "error";
export type DevelopmentLogStream = "event" | "stdout" | "stderr";
export type DevelopmentLogAttribution =
  "resource" | "worker" | "session" | "invocation" | "execution";
export interface DevelopmentCorrelation {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly requestId?: string;
  readonly invocationId?: string;
  readonly executionId?: string;
  readonly taskRunId?: string;
  readonly connectionId?: string;
  readonly messageId?: string;
  readonly replayId?: string;
  readonly deliveryAttempt?: number;
  readonly agentSessionId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly stateId?: string;
  readonly stateAttemptId?: string;
  readonly branchPath?: string;
  readonly mapIndex?: number;
  readonly buildId?: string;
}
export interface DevelopmentLogOmission {
  readonly path: string;
  readonly reason: "privacy" | "size" | "depth" | "circular" | "unsupported";
  readonly count?: number;
}
export interface DevelopmentObservationInput {
  readonly resourceId: string;
  readonly kind: string;
  readonly relatedResourceIds?: readonly string[];
  readonly level?: DevelopmentLogLevel;
  readonly stream?: DevelopmentLogStream;
  readonly message?: string;
  readonly details?: unknown;
  readonly correlation?: DevelopmentCorrelation;
  readonly attribution?: DevelopmentLogAttribution;
  readonly durationMs?: number;
  readonly outcome?: string;
  readonly phase?: string;
  readonly late?: boolean;
  readonly occurredAt?: string;
}
/** Already sanitized at the producer boundary; ingress applies its allow-list again. */
export interface DevelopmentObservation extends Omit<
  DevelopmentObservationInput,
  "details" | "relatedResourceIds"
> {
  readonly relatedResourceIds: readonly string[];
  readonly details?: unknown;
  readonly occurredAt: string;
  readonly level: DevelopmentLogLevel;
  readonly stream: DevelopmentLogStream;
  readonly attribution: DevelopmentLogAttribution;
  readonly correlation: DevelopmentCorrelation;
  readonly omissions: readonly DevelopmentLogOmission[];
}
export interface DevelopmentLogEvent extends Omit<
  DevelopmentObservation,
  "resourceId"
> {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly source: "development";
  readonly repositoryKey: string;
  readonly composeProject: string;
  readonly runtimeSessionId: string;
  readonly bindingId: string;
  readonly declarationDigest: string;
  readonly resource: { readonly id: string; readonly kind: string };
  readonly producer: {
    readonly component: string;
    readonly instanceId: string;
    readonly workerId?: string;
    readonly containerId?: string;
  };
  readonly observedAt: string;
  readonly ingestSequence: number;
}
export interface DevelopmentLogGap {
  readonly reason:
    | "retention"
    | "dropped"
    | "restart"
    | "storage"
    | "truncated"
    | "source-unavailable";
  readonly at: string;
  readonly count?: number;
  readonly resourceId?: string;
  readonly message: string;
}
export interface DevelopmentLogRun {
  readonly runtimeSessionId: string;
  readonly repositoryKey: string;
  readonly composeProject: string;
  readonly bindingId: string;
  readonly declarationDigest: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly heartbeatAt?: string;
  readonly status: "collecting" | "stopped" | "failed";
  readonly binding: {
    readonly deployment?: string;
    readonly region?: string;
    readonly account?: string;
  };
  readonly dropped: number;
  readonly truncated: number;
  readonly gaps: readonly DevelopmentLogGap[];
}
export interface DevelopmentLogQuery {
  readonly resourceIds?: readonly string[];
  readonly runId?: string;
  readonly routeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly direction?: "older" | "newer";
  readonly search?: string;
  readonly level?: DevelopmentLogLevel;
  readonly stream?: DevelopmentLogStream;
  readonly kind?: string;
  /** Internal older-read selection: reserve one slot for the newest matching kind within the same bounded scan. Requires at least two slots. */
  readonly reserveKinds?: readonly string[];
}
export interface DevelopmentLogPage {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly run?: DevelopmentLogRun;
  readonly entries: readonly DevelopmentLogEvent[];
  readonly olderCursor?: string;
  readonly nextCursor?: string;
  readonly gaps: readonly DevelopmentLogGap[];
  readonly dropped: number;
  readonly truncated: number;
  readonly collection:
    "not-configured" | "collecting" | "stopped" | "disconnected" | "failed";
}
/** One bounded cache observation, rather than a promise of a complete distributed trace. */
export interface DevelopmentLogTraceQuery {
  readonly runId: string;
  readonly traceId: string;
  readonly limit?: number;
  readonly resourceIds?: readonly string[];
  readonly routeId?: string;
}
export interface DevelopmentLogTracePage extends DevelopmentLogPage {
  readonly traceId: string;
  readonly complete: boolean;
}
/** Internal capability: never include this descriptor in evidence or browser responses. */
export interface DevelopmentLogControl {
  readonly version: 1;
  readonly repositoryKey: string;
  readonly composeProject: string;
  readonly runtimeSessionId: string;
  readonly bindingId: string;
  readonly declarationDigest: string;
  readonly startedAt: string;
  readonly token: string;
  readonly endpoint: string;
  readonly binding: DevelopmentLogRun["binding"];
  readonly hostUid?: number;
  readonly hostGid?: number;
  readonly hostRepositoryRoot?: string;
  readonly startupPhase?: "database" | "compute";
}

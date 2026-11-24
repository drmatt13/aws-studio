import type {
  DevelopmentLogEvidence,
  DevelopmentLogEvent,
  DevelopmentLogPage,
  DevelopmentLogRun,
} from "../../shared/development-logs";
import type { ModeModel, ModelTarget } from "../../shared/model";

/** Existing projected workflow references, without executing a workload. */
export function workflowLogModel(model: ModeModel): ModeModel {
  const original = model.targets[0]!;
  if (original.compute.kind !== "lambda")
    throw new Error("Expected Lambda fixture");
  const step: ModelTarget = {
    ...original,
    role: "event",
    compute: { ...original.compute, localReplay: undefined },
    lanes: { ...original.lanes, local: false },
  };
  const awsOnly: ModelTarget = {
    ...step,
    ref: "lambda:aws-only-fixture",
    id: "aws-only-fixture",
    title: "AWS-only event fixture",
  };
  const owner: ModelTarget = {
    ...original,
    ref: "workflow:fixture-workflow",
    id: "fixture-workflow",
    title: "Fixture workflow",
    kind: "workflow",
    role: "workflow",
    compute: {
      kind: "workflow",
      type: "standard",
      timeoutSeconds: 30,
      steps: 1,
    },
    lanes: { ...original.lanes, local: true },
  };
  return {
    ...model,
    targets: [step, ...model.targets.slice(1), awsOnly, owner],
    workflows: [
      {
        ref: owner.ref,
        id: owner.id,
        type: "standard",
        timeoutSeconds: 30,
        names: { invoke: "Invoke" },
        targets: [step.ref],
        integrations: [],
        root: {
          kind: "invocation",
          id: "invoke",
          invokes: "lambda",
          target: step.id,
        },
      },
    ],
    edges: [
      ...model.edges,
      {
        id: "step:fixture-workflow",
        relation: "step",
        from: owner.ref,
        to: step.ref,
        provenance: "declared",
        label: "invokeLambda",
      },
    ],
  };
}

export const logTime = "2026-10-28T12:00:00.000Z";
export const logRun: DevelopmentLogRun = {
  runtimeSessionId: "fixture-runtime-1",
  repositoryKey: "fixture-repository",
  composeProject: "browser-fixture",
  bindingId: "fixture-dev-binding",
  declarationDigest: "fixture-declarations",
  startedAt: logTime,
  heartbeatAt: logTime,
  status: "collecting",
  binding: { deployment: "browser-dev", region: "us-east-1" },
  dropped: 0,
  truncated: 0,
  gaps: [],
};
export function logEvent(
  sequence = 1,
  overrides: Partial<DevelopmentLogEvent> = {},
): DevelopmentLogEvent {
  return {
    schemaVersion: 1,
    source: "development",
    eventId: `fixture-event-${sequence}`,
    repositoryKey: logRun.repositoryKey,
    composeProject: logRun.composeProject,
    runtimeSessionId: logRun.runtimeSessionId,
    bindingId: logRun.bindingId,
    declarationDigest: logRun.declarationDigest,
    resource: { id: "lambda:fixture-0", kind: "lambda" },
    relatedResourceIds: ["gateway:http"],
    producer: { component: "http", instanceId: "fixture-producer" },
    occurredAt: logTime,
    observedAt: logTime,
    ingestSequence: sequence,
    level: "error",
    stream: "event",
    kind: "invocation.failed",
    phase: "completion",
    outcome: "failed",
    correlation: {
      requestId: "request-fixture",
      invocationId: `invocation-${sequence}`,
    },
    attribution: "invocation",
    message: "Order lookup failed: upstream unavailable",
    details: {
      request: { orderId: "order-7", authorization: "[redacted]" },
      statusCode: 502,
    },
    omissions: [{ path: "request.authorization", reason: "privacy" }],
    ...overrides,
  };
}
export function logPage(
  entries: readonly DevelopmentLogEvent[] = [],
): DevelopmentLogPage {
  return {
    schemaVersion: 1,
    observedAt: logTime,
    run: logRun,
    collection: "collecting",
    entries,
    gaps: [],
    dropped: 0,
    truncated: 0,
  };
}
export function logEvidence(
  entries: readonly DevelopmentLogEvent[] = [],
): DevelopmentLogEvidence {
  return {
    schemaVersion: 1,
    source: "development",
    observedAt: logTime,
    collection: "collecting",
    run: logRun,
    entries: entries.map((event) => ({
      eventId: event.eventId,
      resourceId: event.resource.id,
      runtimeSessionId: event.runtimeSessionId,
      at: event.occurredAt,
      level: event.level,
      kind: event.kind,
      attribution: event.attribution,
      message: event.message,
      detailsPreview: JSON.stringify(event.details),
      correlation: event.correlation,
      truncated: false,
    })),
    executions: [],
    window: {
      records: entries.length,
      olderUnread: false,
      olderErrorsUnread: false,
    },
    excluded: { executions: 0, failed: 0, records: 0, errorLevel: 0 },
    gaps: [],
    dropped: 0,
    truncated: 0,
  };
}

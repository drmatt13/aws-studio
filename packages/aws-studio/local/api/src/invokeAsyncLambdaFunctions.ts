import { randomUUID } from "node:crypto";
import { newDevelopmentCorrelation, encodeDevelopmentCorrelation, observeDevelopment, type DevelopmentCorrelation } from "aws-studio/development-logs";
import { developmentError } from "../lib/developmentLogs";
import { getEventReplayManifest, type LambdaTarget } from "aws-studio/config";
import {
  deleteReplayMessage,
  extendReplayMessageVisibility,
  isCallbackReplayMessage,
  pollReplayQueue,
  REPLAY_MAX_RECEIVE_COUNT,
  type ReplayEnvelope,
  type ReplayResult,
  type ReplayObserver,
} from "aws-studio/runtime/event-replay";
import type { CallbackReplayEnvelope } from "aws-studio/runtime/callbacks";
import { loadFrameworkConfig } from "aws-studio/config/source";

// The project this runs for, loaded by root: see loadFrameworkConfig.
const framework = loadFrameworkConfig();

// localReplay uses the Lambda ids themselves; this is the derived lookup view.
const eventReplay: Readonly<Record<string, LambdaTarget>> = getEventReplayManifest(framework);

type ReplayExecutor = {
  invoke(
    target: LambdaTarget,
    event: unknown,
    context?: { readonly awsRequestId?: string; readonly observation?: DevelopmentCorrelation },
  ): Promise<unknown>;
};

function legacyFunctionFragment(target: LambdaTarget): string {
  return target
    .slice("lambda:".length)
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export function resolveReplayTarget(
  envelope: ReplayEnvelope,
): LambdaTarget | undefined {
  if (envelope.replayId && envelope.replayId in eventReplay) {
    return eventReplay[envelope.replayId as keyof typeof eventReplay];
  }

  if (
    envelope.target &&
    Object.values(eventReplay).some((target) => target === envelope.target)
  ) {
    return envelope.target;
  }

  const legacyName = envelope.handlerName ?? envelope.lambdaName;
  if (!legacyName) return undefined;
  return Object.values(eventReplay).find((target) =>
    legacyName.includes(legacyFunctionFragment(target)),
  );
}

/**
 * What a message that failed on its last delivery is told. SQS moves it to the
 * replay dead-letter queue next, where `npm run replay:redrive` returns it
 * once the handler is fixed.
 */
function finalAttemptNotice(receiveCount: number): string {
  return receiveCount >= REPLAY_MAX_RECEIVE_COUNT
    ? " This was the final attempt: the message moves to the replay dead-letter queue. Fix the cause, then run npm run replay:redrive."
    : "";
}

type ErrorLike = { name?: string; message?: string };

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === "object"
    ? (error as ErrorLike)
    : { message: String(error) };
}

function isExpiredAwsLoginSession(error: unknown): boolean {
  const { name, message } = asErrorLike(error);
  const normalizedName = (name ?? "").toLowerCase();
  const normalizedMessage = (message ?? "").toLowerCase();
  return (
    normalizedName.includes("credentialsprovidererror") &&
    (normalizedMessage.includes("session has expired") ||
      normalizedMessage.includes("reauthenticate"))
  );
}

function logReplayPollingError(error: unknown): void {
  if (isExpiredAwsLoginSession(error)) {
    console.error(
      `❌ [replay] AWS session expired. Run 'aws login --profile ${process.env.AWS_PROFILE ?? "<profile>"}' and restart local-api-dev-server.`,
    );
  } else {
    const { name, message } = asErrorLike(error);
    console.error(
      `[replay] Polling error (${name || "Error"}): ${message || String(error)}`,
    );
  }
  if (process.env.DEV_REPLAY_VERBOSE_ERRORS === "true") {
    console.error("[replay][debug] Original polling error:", error);
  }
}

/**
 * Forwards one callback completion to the private runner.
 *
 * A worker running in AWS cannot reach a developer's Compose network, so it
 * writes its completion to the replay bucket and this carries it the rest of
 * the way. The runner answers `gone` or `conflict` for a callback it is not
 * holding — a retried attempt, a duplicate delivery, or a runner that has since
 * restarted. All three are terminal: the message is deleted rather than
 * redelivered forever, because nothing will ever be waiting for it again.
 *
 * Returns whether the message should be deleted.
 */
async function forwardCallbackCompletion(
  envelope: CallbackReplayEnvelope,
  runnerUrl: string | undefined,
  correlation: DevelopmentCorrelation,
): Promise<boolean> {
  if (!runnerUrl) {
    observeDevelopment({ resourceId: "gateway:http", kind: "replay.callback.unavailable", correlation, outcome: "retry", level: "error" });
    console.error(
      "[replay] A callback completion arrived but LOCAL_INVOCATION_RUNNER_URL is not set; it will be retried.",
    );
    return false;
  }
  const url = `${runnerUrl.replace(/\/+$/, "")}/callbacks/${encodeURIComponent(
    envelope.handle.token,
  )}/${envelope.outcome}`;
  try {
    observeDevelopment({ resourceId: "gateway:http", kind: "replay.callback.forwarded", correlation, outcome: "attempted", details: { outcome: envelope.outcome } });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-framework-development-observation": encodeDevelopmentCorrelation(correlation) },
      body: JSON.stringify({
        ...(envelope.result === undefined ? {} : { result: envelope.result }),
        ...(envelope.error === undefined ? {} : { error: envelope.error }),
      }),
    });
    observeDevelopment({ resourceId: "gateway:http", kind: "replay.callback.response", correlation, outcome: response.ok ? "accepted" : [404, 409, 410].includes(response.status) ? "stale" : "retry", details: { status: response.status } });
    if (response.ok) {
      console.log(`[replay] Forwarded a ${envelope.outcome} callback to the runner.`);
      return true;
    }
    if (response.status === 404 || response.status === 409 || response.status === 410) {
      console.warn(
        `[replay] The runner is not holding this callback (HTTP ${response.status}); dropping the message.`,
      );
      return true;
    }
    console.error(`[replay] The runner refused a callback (HTTP ${response.status}).`);
    return false;
  } catch (error) {
    observeDevelopment({ resourceId: "gateway:http", kind: "replay.callback.failed", correlation, outcome: "retry", level: "error", details: { error: developmentError(error) } });
    console.error("[replay] Could not reach the local runner for a callback:", error);
    return false;
  }
}

export default async function invokeAsyncLambdaFunctions(
  executor: ReplayExecutor,
  onFatalError?: () => void,
  dependencies: {
    poll: (queueUrl: string, bucketName: string, observer?: ReplayObserver) => Promise<ReplayResult[]>;
    delete: (queueUrl: string, receiptHandle: string) => Promise<void>;
    extendVisibility: (
      queueUrl: string,
      receiptHandle: string,
      visibilityTimeoutSeconds: number,
    ) => Promise<void>;
  } = {
    poll: pollReplayQueue,
    delete: deleteReplayMessage,
    extendVisibility: extendReplayMessageVisibility,
  },
): Promise<void> {
  const queueUrl = process.env.DEV_LAMBDA_REPLAY_QUEUE_URL;
  const bucketName = process.env.DEV_LAMBDA_REPLAY_BUCKET_NAME;
  if (!queueUrl || !bucketName) return;

  try {
    const results = await dependencies.poll(queueUrl, bucketName, (kind, details, outcome, correlation) => observeDevelopment({ resourceId: "gateway:http", kind, details, outcome, correlation }));

    for (const { envelope, receiptHandle, receiveCount, messageId } of results) {
      const correlation = newDevelopmentCorrelation({ messageId, replayId: isCallbackReplayMessage(envelope) ? randomUUID() : envelope.id, deliveryAttempt: receiveCount, invocationId: randomUUID() });
      observeDevelopment({ resourceId: "gateway:http", kind: "replay.delivery.received", correlation, outcome: "received", details: { capturedAt: envelope.capturedAt, kind: isCallbackReplayMessage(envelope) ? "callback" : "event" } });
      if (isCallbackReplayMessage(envelope)) {
        if (
          await forwardCallbackCompletion(
            envelope,
            process.env.LOCAL_INVOCATION_RUNNER_URL,
            correlation,
          )
        ) {
          observeDevelopment({ resourceId: "gateway:http", kind: "replay.acknowledgement.attempted", correlation, outcome: "attempted" });
          try {
            await dependencies.delete(queueUrl, receiptHandle);
            observeDevelopment({ resourceId: "gateway:http", kind: "replay.acknowledgement.completed", correlation, outcome: "acknowledged" });
          } catch (error) {
            observeDevelopment({ resourceId: "gateway:http", kind: "replay.acknowledgement.failed", correlation, outcome: "may-redeliver", level: "error", details: { error: developmentError(error) } });
            console.error("[replay] Deleting a forwarded callback failed:", error);
          }
        }
        continue;
      }

      const target = resolveReplayTarget(envelope);
      if (!target) {
        observeDevelopment({ resourceId: "gateway:http", kind: "replay.target.unresolved", correlation, outcome: "retry", level: "warn", details: { replayId: envelope.replayId } });
        console.warn(
          `[replay] No manifest target for replayId="${envelope.replayId}" handlerName="${envelope.handlerName}" lambdaName="${envelope.lambdaName}"; message will be retried (attempt ${receiveCount} of ${REPLAY_MAX_RECEIVE_COUNT}).${finalAttemptNotice(receiveCount)}`,
        );
        continue;
      }

      observeDevelopment({ resourceId: target, kind: "replay.delivery.attempted", correlation, outcome: "attempted", details: { eventType: envelope.eventType, capturedAt: envelope.capturedAt, awsRequestId: envelope.awsRequestId } });
      console.log(
        `[replay] Invoking ${target} for ${envelope.eventType} (attempt ${receiveCount} of ${REPLAY_MAX_RECEIVE_COUNT}).`,
      );
      const visibilityHeartbeat = setInterval(() => {
        void dependencies.extendVisibility(queueUrl, receiptHandle, 300).catch(
          (error) => {
            observeDevelopment({ resourceId: target, kind: "replay.visibility.failed", correlation, level: "error", details: { error: developmentError(error) } });
            console.error("[replay] Failed to extend visibility:", error);
          },
        );
      }, 60_000);

      const invocationStartedAt = Date.now();
      let invocationDurationMs: number | undefined;
      try {
        // The captured request id, so a replay's log lines can be matched to
        // the invocation in CloudWatch that produced them.
        await executor.invoke(target, envelope.originalEvent, {
          awsRequestId: envelope.awsRequestId ?? envelope.id,
          observation: correlation,
        });
        invocationDurationMs = Date.now() - invocationStartedAt;
        observeDevelopment({ resourceId: target, kind: "replay.handler.completed", correlation, outcome: "succeeded", durationMs: invocationDurationMs });
      } catch (error) {
        observeDevelopment({ resourceId: target, kind: "replay.handler.failed", correlation, outcome: "retry", level: "error", details: { error: developmentError(error), finalAttempt: receiveCount >= REPLAY_MAX_RECEIVE_COUNT } });
        console.error(
          `[replay] Invocation failed for ${target}; message will be retried.${finalAttemptNotice(receiveCount)}`,
          error,
        );
      } finally {
        clearInterval(visibilityHeartbeat);
      }

      if (invocationDurationMs === undefined) continue;

      try {
        observeDevelopment({ resourceId: target, kind: "replay.acknowledgement.attempted", correlation, outcome: "attempted" });
        await dependencies.delete(queueUrl, receiptHandle);
        observeDevelopment({ resourceId: target, kind: "replay.acknowledgement.completed", correlation, outcome: "acknowledged" });
        console.log(
          `[replay] Invocation succeeded for ${target} in ${invocationDurationMs}ms; replay message deleted.`,
        );
      } catch (error) {
        observeDevelopment({ resourceId: target, kind: "replay.acknowledgement.failed", correlation, outcome: "may-redeliver", level: "error", details: { error: developmentError(error) } });
        console.error(
          `[replay] Invocation succeeded for ${target}, but deleting the replay message failed; it may be retried:`,
          error,
        );
      }
    }
  } catch (error) {
    observeDevelopment({ resourceId: "gateway:http", kind: "replay.polling.failed", outcome: isExpiredAwsLoginSession(error) ? "stopped" : "retry", level: "error", details: { error: developmentError(error) } });
    logReplayPollingError(error);
    if (isExpiredAwsLoginSession(error)) onFatalError?.();
  }
}

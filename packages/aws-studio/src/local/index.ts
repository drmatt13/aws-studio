export * from "./agentcore";
export * from "./agentcore-contracts";

import {
  getLambdaTargetIds,
  assertPrivateDnsLocalExecution,
  getFrameworkTargets,
  parseTargetReference,
  resolveLambdaTarget,
  toTargetReference,
  type FrameworkConfig,
  type LambdaTarget,
  type ServiceTarget,
} from "aws-studio/config";
import {
  findRepositoryRoot,
  resolveServicePort,
} from "aws-studio/config/source";
import { randomUUID } from "node:crypto";
import { developmentCorrelation, currentDevelopmentObservation, encodeDevelopmentCorrelation, newDevelopmentCorrelation, observeDevelopment, withDevelopmentObservation, type DevelopmentCorrelation } from "../development-logs";
import { lambdaInvocationResultDetails, sensitiveDevelopmentHttpInvocation } from "./lambda-observation";
import { getTargetEnvironmentPrefix } from "./services";
import { invokeLocalNodeLambda, LambdaWorkerPool } from "./lambda-process";

export * from "./invocation";
export * from "./environment";
export * from "./lambda-process";
export { lambdaInvocationResultDetails } from "./lambda-observation";
export * from "./paths";
export * from "./resources";
export * from "./services";
export * from "./callback-broker";
export * from "./workflow-bindings";
export * from "./workflow-integrations";
export * from "./workflow-interpreter";

// Keep the exported result readable without coupling local execution to Lambda types.
export type LambdaInvocationResult = {
  statusCode: number;
  body?: string;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  cookies?: string[];
  isBase64Encoded?: boolean;
};

export interface LocalLambdaExecutorOptions {
  readonly config: FrameworkConfig;
  readonly repositoryRoot?: string;
  readonly runnerUrl?: string;
  /**
   * Warm handler processes, or `null` to start every invocation cold. Absent,
   * the pool LOCAL_LAMBDA_WARM* describes is used; see LambdaWorkerPool.
   */
  readonly pool?: LambdaWorkerPool | null;
}

/** Fields a caller may pin on the context a handler receives. */
export interface LocalInvocationContext {
  /** Local diagnostic correlation, never application input or authorization. */
  readonly observation?: DevelopmentCorrelation;
  /** Defaults to a fresh id; a replay passes the captured invocation's. */
  readonly awsRequestId?: string;
  /** What a Gateway hands a tool: the tool's wire name, the MCP message, the Gateway. */
  readonly clientContext?: { readonly custom: Readonly<Record<string, string>> };
}

/** Resolve a declared service through Compose DNS, with an optional endpoint override. */
export function resolveLocalServiceUrl(
  config: FrameworkConfig,
  target: ServiceTarget,
  repositoryRoot = findRepositoryRoot(process.cwd()),
): string {
  if (config.privateHostedZones?.some(zone => zone.enabled)) assertPrivateDnsLocalExecution(config, target, getFrameworkTargets(config));
  const { id } = parseTargetReference(target);

  // The documented advanced override: an endpoint, not a registration. It
  // points this target somewhere else; it never suppresses container creation.
  const override = process.env[`${getTargetEnvironmentPrefix(id)}_SERVICE_URL`];
  if (override) return override.replace(/\/+$/, "");

  return `http://${id}:${resolveServicePort(config, id, { repositoryRoot })}`;
}

function allowedLambdaTargets(config: FrameworkConfig): Set<LambdaTarget> {
  return new Set(
    getLambdaTargetIds(config).map(
      (id) => toTargetReference("lambda", id) as LambdaTarget,
    ),
  );
}

export class LocalLambdaExecutor {
  private readonly config: FrameworkConfig;
  private readonly allowedTargets: Set<LambdaTarget>;
  private readonly repositoryRoot: string;
  private readonly runnerUrl: string;
  private readonly pool: LambdaWorkerPool | undefined;
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  public constructor(options: LocalLambdaExecutorOptions) {
    this.config = options.config;
    this.allowedTargets = allowedLambdaTargets(options.config);
    this.repositoryRoot =
      options.repositoryRoot ?? findRepositoryRoot(process.cwd());
    this.pool =
      options.pool === null
        ? undefined
        : (options.pool ?? LambdaWorkerPool.fromEnvironment(this.repositoryRoot));
    this.runnerUrl = (
      options.runnerUrl ??
      process.env.LOCAL_INVOCATION_RUNNER_URL ??
      "http://local-invocation-runner:8090"
    ).replace(/\/+$/, "");
  }

  public async invoke<Result = LambdaInvocationResult>(
    target: LambdaTarget,
    event: unknown,
    context?: LocalInvocationContext,
  ): Promise<Result> {
    const inherited = context?.observation ?? developmentCorrelation() ?? {};
    const correlation = newDevelopmentCorrelation({ ...inherited, spanId: randomUUID(), parentSpanId: inherited.spanId, invocationId: randomUUID() });
    const startedAt = Date.now();
    const sensitive = sensitiveDevelopmentHttpInvocation(event) || currentDevelopmentObservation()?.sensitive === true;
    const pending = withDevelopmentObservation({ resourceId: target, correlation }, async () => {
      observeDevelopment({ resourceId: target, kind: "lambda.invocation.started", phase: "started", correlation });
      try {
        this.lifetime.signal.throwIfAborted();
        if (this.config.privateHostedZones?.some(zone => zone.enabled)) assertPrivateDnsLocalExecution(this.config, target, getFrameworkTargets(this.config));
        if (!this.allowedTargets.has(target)) {
          throw new Error(
            `Local Lambda target "${target}" is not declared under http, webSocket, events or tools in the framework config.`,
          );
        }

        // Packaging comes from the config, not from whether a Dockerfile happens to
        // be sitting in the directory, so local execution and the deployed Lambda
        // can never disagree about how the code is built.
        const { id } = parseTargetReference(target);
        if (resolveLambdaTarget(this.config, id).packaging === "container") {
          const result = await this.invokeContainer<Result>(target, event, { ...context, observation: correlation });
          withDevelopmentObservation({ sensitive: false }, () => observeDevelopment({ resourceId: target, kind: "lambda.invocation.completed", phase: "completed", outcome: "succeeded", details: lambdaInvocationResultDetails(result, { sensitive }), durationMs: Date.now() - startedAt, correlation }));
          return result;
        }

        const result = await invokeLocalNodeLambda(this.config, target, event, {
          repositoryRoot: this.repositoryRoot,
          runnerUrl: this.runnerUrl,
          signal: this.lifetime.signal,
          ...(context ? { context } : {}),
          ...(this.pool ? { pool: this.pool } : {}),
        }) as Result;
        withDevelopmentObservation({ sensitive: false }, () => observeDevelopment({ resourceId: target, kind: "lambda.invocation.completed", phase: "completed", outcome: "succeeded", details: lambdaInvocationResultDetails(result, { sensitive }), durationMs: Date.now() - startedAt, correlation }));
        return result;
      } catch (error) {
        const cancelled = this.lifetime.signal.aborted;
        observeDevelopment({ resourceId: target, kind: cancelled ? "lambda.invocation.cancelled" : (error as { name?: string })?.name === "States.Timeout" ? "lambda.invocation.timed-out" : "lambda.invocation.failed", level: "error", phase: "completed", outcome: cancelled ? "cancelled" : "failed", details: { error: sensitive ? "[sensitive invocation error details omitted]" : error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error }, durationMs: Date.now() - startedAt, correlation });
        throw error;
      }
    });
    this.active.add(pending);
    void pending.then(() => this.active.delete(pending), () => this.active.delete(pending));
    return pending;
  }

  /** Cancels owned calls, drains their output, and refuses further invocations. */
  public async close(): Promise<void> {
    this.lifetime.abort(new Error("Local Lambda executor is closed."));
    await Promise.allSettled([...(this.pool ? [this.pool.close()] : []), ...this.active]);
  }

  /**
   * An image Lambda runs in its own container, so its descriptors travel in its
   * private process environment rather than in this one's scoped map.
   */
  private async invokeContainer<Result>(
    target: LambdaTarget,
    event: unknown,
    context: LocalInvocationContext | undefined,
  ): Promise<Result> {
    const response = await fetch(`${this.runnerUrl}/invoke`, {
      method: "POST",
      signal: this.lifetime.signal,
      headers: { "content-type": "application/json", "x-framework-development-observation": encodeDevelopmentCorrelation(context?.observation) },
      body: JSON.stringify({ target, event, context }),
    });
    const payload = (await response.json()) as
      | { result: Result }
      | { error: string };
    if (!response.ok || !("result" in payload)) {
      throw new Error(
        "error" in payload
          ? payload.error
          : `Local Lambda runner returned HTTP ${response.status}.`,
      );
    }
    return payload.result;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createConnection } from "node:net";
import express from "express";
import {
  getLambdaTargetIds,
  assertPrivateDnsLocalExecution,
  getFrameworkTargets,
  normalizeFrameworkConfig,
  parseTargetReference,
  resolveLambdaTarget,
  toTargetReference,
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
  type FrameworkConfig,
  type LambdaTarget,
  type TargetReference,
} from "aws-studio/config";
import { findDockerfile, resolveLambdaSourcePath, localDeployInputs } from "aws-studio/config/source";
import {
  resolveLocalWorkloadEnvironment,
  assertLocalInvocationEdge,
  callIntegration,
  CallbackCompletionError,
  createIntegrationClients,
  readWorkflowBindings,
  redactCallbackHandles,
  TASK_CONTAINER_KIND_LABEL,
  TASK_CONTAINER_PROJECT_LABEL,
  TASK_CONTAINER_TARGET_LABEL,
  LocalLambdaExecutor,
  loadToolManifest,
} from "aws-studio/local";
import { registerAgentRoutes } from "./agent-routes";
import { LocalAgentSupervisor } from "./agents";
import { docker, dockerWithEnvironment, containerEnvironment, dockerBuild, composeIdentity, followContainerLogs, cancelDockerBuilds, buildsInFlight } from "./docker";
import { LocalImageJanitor } from "./images";
import { frameworkRepositoryRoot, loadFrameworkConfig } from "aws-studio/config/source";
import { LocalTaskSupervisor, TaskSubmissionError } from "./tasks";
import { LocalWorkflowEngine } from "./workflows";
import { observeDevelopment, currentDevelopmentObservation, developmentCorrelation, withDevelopmentObservation, type DevelopmentCorrelation } from "aws-studio/development-logs";
import { startDevelopmentLogCollector } from "./development-logs/collector";
import { DEVELOPMENT_OBSERVATION_HEADER, readDevelopmentCorrelation, containerLambdaCorrelation } from "./observation";
import { lambdaInvocationPreview, lambdaInvocationResultDetails, sensitiveDevelopmentHttpInvocation } from "aws-studio/local/lambda-observation";

// The project this runs for, loaded by root: see loadFrameworkConfig.
const framework = loadFrameworkConfig();

const repositoryRoot = frameworkRepositoryRoot();
const runtimeConfig: FrameworkConfig = framework;
// AgentCore tools run cold, one process per call, so a tool edited between two
// calls in one conversation runs as edited on the second.
const toolExecutor = new LocalLambdaExecutor({ config: framework, repositoryRoot, pool: null });
const runnerLabel = "com.matts-aws-framework.local-lambda=true";
const buildPromises = new Map<string, Promise<string>>();

function allowedTargets(): Set<LambdaTarget> {
  return new Set(
    getLambdaTargetIds(framework).map(
      (id) => toTargetReference("lambda", id) as LambdaTarget,
    ),
  );
}

const approvedTargets = allowedTargets();

function hashDirectory(directory: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .filter((entry) => !["node_modules", ".git", "__pycache__"].includes(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).replaceAll("\\", "/");
      hash.update(relative);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) hash.update(readFileSync(absolute));
    }
  };
  visit(directory);
  return hash.digest("hex").slice(0, 16);
}

// The directory comes from the declared location, never from the id, so an
// approved target that moved is still built from the source CDK would ship.
function lambdaDirectory(target: LambdaTarget): string {
  const { id } = parseTargetReference(target);
  const directory = resolveLambdaSourcePath(framework, id, { repositoryRoot });
  if (resolveLambdaTarget(framework, id).packaging !== "container") {
    throw new Error(
      `Approved Lambda target ${target} is not declared as packaging: "container".`,
    );
  }
  if (!findDockerfile(directory)) {
    throw new Error(`Approved Lambda target ${target} has no Dockerfile.`);
  }
  return directory;
}

// Architecture is per target in framework.config.ts, so the image built here
// matches the one CDK ships instead of tracking a separate env var.
function dockerPlatform(target: LambdaTarget): string {
  const { id } = parseTargetReference(target);
  return resolveLambdaTarget(framework, id).architecture === "arm64"
    ? "linux/arm64"
    : "linux/amd64";
}

async function imagePresent(reference: string, platform: string): Promise<boolean> {
  return docker("image", "inspect", "--platform", platform, reference).then(
    () => true,
    () => false,
  );
}

interface ContainerLambdaImage {
  readonly tag: string;
  readonly platform: string;
  readonly directory: string;
}

/**
 * The image a container Lambda's current source builds, named by that source.
 *
 * Read once per invocation, before anything is awaited, so the tag an
 * invocation holds is the tag it runs.
 */
function containerLambdaImage(target: LambdaTarget): ContainerLambdaImage {
  const { id } = parseTargetReference(target);
  const directory = lambdaDirectory(target);
  const platform = dockerPlatform(target);
  const tag = `matts-framework-${id}:${hashDirectory(directory)}-${platform.endsWith("arm64") ? "arm64" : "amd64"}`;
  return { tag, platform, directory };
}

async function ensureImage(target: LambdaTarget, image: ContainerLambdaImage): Promise<string> {
  if (!(await imagePresent(image.tag, image.platform))) {
    const { id } = parseTargetReference(target);
    const correlation = { buildId: randomUUID() };
    const args = ["build", "--platform", image.platform, "--label", runnerLabel,
      "--label", `${TASK_CONTAINER_KIND_LABEL}=lambda`, "--label", `${TASK_CONTAINER_PROJECT_LABEL}=${projectName}`,
      "--label", `${TASK_CONTAINER_TARGET_LABEL}=${id}`, "--tag", image.tag, image.directory];
    await withDevelopmentObservation({ isolated: true, resourceId: target, correlation }, async () => {
      observeDevelopment({ resourceId: target, kind: "build.started", attribution: "resource" });
      try {
        await dockerBuild(args);
        observeDevelopment({ resourceId: target, kind: "build.succeeded", attribution: "resource" });
      } catch (error) {
        observeDevelopment({ resourceId: target, kind: "build.failed", attribution: "resource", level: "error", details: { error } });
        throw error;
      }
    });
    // The image the previous source built is superseded from here.
    void imageJanitor?.request();
  }
  return image.tag;
}

/**
 * The container-Lambda image, cached by its handler directory's contents.
 *
 * Deliberately not the task supervisor's build-every-invocation path: a caller
 * here is waiting for the invocation's *result*, so a cache check that costs a
 * build request is not free the way it is behind a 202. The context stays this
 * handler's own directory rather than the repository root.
 *
 * A cached promise is a memory of a build, not proof the image still exists.
 * `docker image rm` between invocations used to turn into a run failure that
 * never rebuilt; the presence check is what makes the next invocation recover.
 */
async function prepareContainerImage(target: LambdaTarget, image: ContainerLambdaImage): Promise<string> {
  const key = image.tag;
  const cached = buildPromises.get(key);
  if (cached) {
    const reference = await cached;
    if (await imagePresent(reference, image.platform)) return reference;
    buildPromises.delete(key);
  }
  const build = ensureImage(target, image).catch((error: unknown) => {
    buildPromises.delete(key);
    throw error;
  });
  buildPromises.set(key, build);
  return build;
}

let projectName: string;
let networkName: string;
let awsConfigSource: string | undefined;
let closing = false;
const lambdaControllers = new Set<AbortController>();
const lambdaInvocations = new Set<Promise<unknown>>();
async function composeNetwork(): Promise<string> { return networkName; }

async function waitForRuntime(containerName: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(8080, containerName);
        const abort = () => socket.destroy(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => {
          signal.removeEventListener("abort", abort);
          socket.end();
          resolve();
        });
        socket.once("error", (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        });
      });
      return;
    } catch {
      // The Lambda Runtime Interface Emulator needs a moment to start.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the Lambda runtime to start.");
}

/**
 * Container-Lambda image tags in use by an invocation right now, counted. The
 * image janitor keeps them even after newer source has superseded them.
 */
const heldImages = new Map<string, number>();

async function invokeContainer(
  target: LambdaTarget,
  event: unknown,
  // A caller that owns the invocation — a workflow step whose state timed out,
  // or whose execution was stopped — cancels it here rather than abandoning a
  // container that goes on running.
  cancel?: AbortSignal,
  intended?: DevelopmentCorrelation,
): Promise<unknown> {
  const correlation = containerLambdaCorrelation(intended);
  return withDevelopmentObservation({ resourceId: target, correlation }, () => invokeContainerObserved(target, event, cancel, correlation));
}

async function invokeContainerObserved(target: LambdaTarget, event: unknown, cancel: AbortSignal | undefined, correlation: DevelopmentCorrelation): Promise<unknown> {
  if (runtimeConfig.privateHostedZones?.some(zone => zone.enabled)) assertPrivateDnsLocalExecution(runtimeConfig, target, getFrameworkTargets(runtimeConfig));
  let lambdaImage: ContainerLambdaImage | undefined;
  try {
    observeDevelopment({ resourceId: target, kind: "lambda.accepted", correlation, details: { packaging: "container" } });
    lambdaImage = containerLambdaImage(target);
    heldImages.set(lambdaImage.tag, (heldImages.get(lambdaImage.tag) ?? 0) + 1);
    return await runContainerLambda(target, lambdaImage, event, cancel, correlation);
  } catch (error) {
    observeDevelopment({ resourceId: target, kind: cancel?.aborted ? "lambda.cancelled" : "lambda.failed", correlation, level: "error", details: { error: lambdaInvocationPreview(error, { sensitive: sensitiveDevelopmentHttpInvocation(event) }) } });
    throw error;
  } finally {
    if (lambdaImage) {
      const remaining = (heldImages.get(lambdaImage.tag) ?? 1) - 1;
      if (remaining > 0) heldImages.set(lambdaImage.tag, remaining);
      else heldImages.delete(lambdaImage.tag);
    }
  }
}

async function runContainerLambda(
  target: LambdaTarget,
  lambdaImage: ContainerLambdaImage,
  event: unknown,
  cancel?: AbortSignal,
  correlation?: DevelopmentCorrelation,
): Promise<unknown> {
  const started = Date.now();
  const sensitive = sensitiveDevelopmentHttpInvocation(event) || currentDevelopmentObservation()?.sensitive === true;
  observeDevelopment({ resourceId: target, kind: "lambda.image_preparing", correlation });
  const image = await prepareContainerImage(target, lambdaImage);
  observeDevelopment({ resourceId: target, kind: "lambda.image_ready", correlation });
  if (closing) throw new Error("Local runner is shutting down.");
  const { id } = parseTargetReference(target);
  const containerName = `matts-lambda-${id}-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  if (cancel) {
    if (cancel.aborted) controller.abort(cancel.reason);
    else cancel.addEventListener("abort", () => controller.abort(cancel.reason), { once: true });
  }
  lambdaControllers.add(controller);
  const timeoutMilliseconds = Number(process.env.LOCAL_CONTAINER_LAMBDA_TIMEOUT_MS ?? "10000");
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error("LOCAL_CONTAINER_LAMBDA_TIMEOUT_MS must be a positive number.");
  }
  const timeout = setTimeout(
    () => {
      observeDevelopment({ resourceId: target, kind: "lambda.timeout", correlation, level: "error", durationMs: Date.now() - started });
      controller.abort(new Error(`Lambda invocation exceeded ${timeoutMilliseconds}ms.`));
    },
    timeoutMilliseconds,
  );

  let stopLogs: ReturnType<typeof followContainerLogs> | undefined;
  try {
    const environment = containerEnvironment(await resolveLocalWorkloadEnvironment(framework, target, { repositoryRoot, runnerUrl }));
    observeDevelopment({ resourceId: target, kind: "lambda.invocation.input", correlation, details: { input: lambdaInvocationPreview(event) } });
    environment.FRAMEWORK_DEVELOPMENT_OBSERVATION = JSON.stringify({ resourceId: target, correlation });
    const args = ["run", "--detach", "--name", containerName, "--network", await composeNetwork(),
      "--label", runnerLabel, "--label", `${TASK_CONTAINER_PROJECT_LABEL}=${projectName}`,
      "--label", `${TASK_CONTAINER_KIND_LABEL}=lambda`, "--label", `${TASK_CONTAINER_TARGET_LABEL}=${id}`,
      "--label", `com.matts-aws-framework.invocation=${correlation?.invocationId ?? "unknown"}`, "--platform", dockerPlatform(target)];
    for (const name of Object.keys(environment)) args.push("--env", name);
    if (awsConfigSource) args.push("--mount", `type=bind,source=${awsConfigSource},target=/root/.aws,readonly`);
    args.push(image);
    if (controller.signal.aborted) throw controller.signal.reason;
    await dockerWithEnvironment(args, environment);
    observeDevelopment({ resourceId: target, kind: "lambda.started", phase: "cold", correlation, details: { containerName } });
    stopLogs = followContainerLogs(containerName, `lambda:${id} ${containerName}`, { resourceId: target, correlation, sensitive });
    await waitForRuntime(containerName, controller.signal);
    observeDevelopment({ resourceId: target, kind: "lambda.dispatched", correlation, phase: "runtime-ready" });
    const response = await fetch(
      `http://${containerName}:8080/2015-03-31/functions/function/invocations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      },
    );
    const body = await response.text();
    if (!response.ok || response.headers.get("lambda-runtime-function-error")) {
      throw new Error(`Lambda runtime failed (${response.status}): ${body}`);
    }
    const result: unknown = JSON.parse(body);
    // Payload omission is handled before restoring safe public HTTP metadata.
    withDevelopmentObservation({ sensitive: false }, () => observeDevelopment({ resourceId: target, kind: "lambda.succeeded", correlation, durationMs: Date.now() - started, details: lambdaInvocationResultDetails(result, { sensitive }) }));
    return result;
  } finally {
    clearTimeout(timeout);
    lambdaControllers.delete(controller);
    // RIE containers remain alive after answering. Stop first so Docker flushes
    // their final partial stdout/stderr record, then drain before removal.
    await docker("stop", "--time", "1", containerName).catch(() => undefined);
    await stopLogs?.();
    if (stopLogs?.failed()) {
      const text = await docker("logs", "--tail", "500", containerName).catch(() => "");
      if (text) observeDevelopment({ resourceId: target, kind: "lambda.output_tail", correlation, details: { text: sensitive ? "[sensitive invocation output omitted]" : text, final: true } });
    }
    await docker("rm", "--force", containerName).catch(() => undefined);
  }
}

async function cleanupStaleContainers(): Promise<void> {
  const ids = (await docker("ps", "--all", "--quiet", "--filter", `label=${runnerLabel}`, "--filter", `label=${TASK_CONTAINER_PROJECT_LABEL}=${projectName}`))
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length > 0) await docker("rm", "--force", ...ids);
}

let imageJanitor: LocalImageJanitor | undefined;

/**
 * The images the janitor keeps: what each declared container Lambda's current
 * source builds, what each declared task's next run reuses, and whatever an
 * invocation is using now. Everything else this runner built is superseded or
 * belongs to a target no longer declared.
 */
function currentImages(): Set<string> {
  const keep = new Set(heldImages.keys());
  for (const target of approvedTargets) {
    if (resolveLambdaTarget(framework, parseTargetReference(target).id).packaging !== "container") continue;
    try {
      keep.add(containerLambdaImage(target).tag);
    } catch {
      // No Dockerfile: there is no current image, and nothing can be invoked.
    }
  }
  for (const tag of taskSupervisor.currentImages()) keep.add(tag);
  return keep;
}

/**
 * The task and workflow controls.
 *
 * Kept on this private runner rather than on the application HTTP API: a start
 * endpoint there would bypass the declared route inventory and could collide
 * with an authored mount. Nothing here is reachable from outside the Compose
 * network, and every submission is checked against the declared binding before
 * it is accepted.
 */

const runnerUrl = (
  process.env.LOCAL_INVOCATION_RUNNER_URL ?? "http://local-invocation-runner:8090"
).replace(/\/+$/, "");
const agentSupervisor = new LocalAgentSupervisor(framework, repositoryRoot, runnerUrl);

let taskSupervisor: LocalTaskSupervisor;
let workflowEngine: LocalWorkflowEngine;

/**
 * The deployment this runner's workflows talk to, read once at start.
 *
 * A parse, not a lookup: the document is written by
 * `npm run export:cdk-outputs` and arrives through the resource manifest
 * the runner mounts read-only. A malformed one fails here, where the message can say
 * what to re-run, rather than in the middle of an execution.
 */
const workflowBindings = readWorkflowBindings();
const integrationClients = createIntegrationClients(
  workflowBindings?.region ??
    process.env.LOCAL_AWS_REGION ??
    process.env.AWS_REGION ??
    "us-east-1",
);

/** A submission body, with the caller it claims to be. */
function readSubmission(body: unknown): {
  readonly target: TargetReference;
  readonly caller?: string;
  readonly input: unknown;
  readonly clientToken?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  // The launch configuration is the framework's, resolved from the declaration.
  // A caller cannot choose an image, a command, a network or an environment.
  for (const forbidden of ["image", "command", "environment", "network", "cpu", "memory"]) {
    if (forbidden in record) {
      throw new Error("Runner configuration cannot be supplied by callers.");
    }
  }
  if (typeof record.target !== "string") {
    throw new Error("Request body must name a target.");
  }
  return {
    target: record.target as TargetReference,
    ...(typeof record.caller === "string" ? { caller: record.caller } : {}),
    input: record.input,
    ...(typeof record.clientToken === "string"
      ? { clientToken: record.clientToken }
      : {}),
  };
}

function fail(response: express.Response, status: number, error: unknown): void {
  response
    .status(status)
    .json({ error: error instanceof Error ? error.message : String(error) });
}

function observeRejectedSubmission(kind: "task" | "workflow", body: unknown, error: unknown): void {
  const target = body && typeof body === "object" ? (body as { target?: unknown }).target : undefined;
  const declared = typeof target === "string" ? normalizeFrameworkConfig(framework).targets.get(target as TargetReference) : undefined;
  if (declared?.kind === kind) observeDevelopment({ resourceId: declared.reference, kind: `${kind}.submission_rejected`, level: "warn", details: { error } });
  else observeDevelopment({ resourceId: "runtime:development", kind: `${kind}.submission_rejected`, level: "warn", details: { reason: "Unknown or invalid declared target." } });
}

const app = express();
app.use("/development-logs", express.json({ limit: "256kb" }));
app.use(express.json({ limit: "10mb" }));
app.use((request, _response, next) => withDevelopmentObservation({ correlation: readDevelopmentCorrelation(request.header(DEVELOPMENT_OBSERVATION_HEADER)) }, next));
app.use((_request, response, next) => {
  if (closing) { response.status(503).json({ error: "Local runner is shutting down." }); return; }
  next();
});
app.get("/health", (_request, response) => response.json({ ok: true }));
registerAgentRoutes(app, {
  inputs: localDeployInputs(repositoryRoot),
  config: framework,
  agents: agentSupervisor,
  tools: toolExecutor,
  loadTools: () => loadToolManifest(framework, repositoryRoot),
});

app.post("/invoke", async (request, response) => {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    response.status(400).json({ error: "Request body must be a JSON object." });
    return;
  }
  const target = request.body?.target as LambdaTarget | undefined;
  if (!target || !approvedTargets.has(target)) {
    response.status(403).json({
      error: "Target is not approved by the API or event replay manifest.",
    });
    return;
  }
  if ("image" in request.body || "command" in request.body || "path" in request.body || "environment" in request.body) {
    response.status(400).json({ error: "Runner configuration cannot be supplied by callers." });
    return;
  }
  try {
    const invocation = invokeContainer(target, request.body.event, undefined, readDevelopmentCorrelation(request.header(DEVELOPMENT_OBSERVATION_HEADER)));
    lambdaInvocations.add(invocation);
    try { response.json({ result: await invocation }); }
    finally { lambdaInvocations.delete(invocation); }
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// Tasks: run to completion, keyed by run id
// ---------------------------------------------------------------------------

app.post("/tasks", (request, response) => {
  let submission;
  try {
    submission = readSubmission(request.body);
    // The local half of the cloud grant, from the same declarations: a caller
    // may launch only what its own config entry says it may.
    assertLocalInvocationEdge(framework, submission.caller, submission.target);
  } catch (error) {
    observeRejectedSubmission("task", request.body, error);
    fail(response, 403, error);
    return;
  }
  try {
    const { id } = parseTargetReference(submission.target);
    const run = taskSupervisor.submit(id, submission.input, {
      ...(submission.clientToken ? { clientToken: submission.clientToken } : {}),
    });
    // Acceptance, not completion, and not startup either: the run id exists and
    // the image is being prepared. Status, exit code and logs are read from the
    // routes below, which is where a build failure becomes visible too.
    response.status(202).json({ runId: run.runId, status: run.status });
  } catch (error) {
    // A rejected submission keeps its own status - overloaded, duplicated or
    // undeclared - rather than being flattened into a server error.
    observeRejectedSubmission("task", request.body, error);
    fail(response, error instanceof TaskSubmissionError ? error.status : 500, error);
  }
});

app.get("/tasks", (_request, response) => response.json({ runs: taskSupervisor.list() }));

app.get("/tasks/:runId", (request, response) => {
  const run = taskSupervisor.get(request.params.runId);
  if (!run) {
    fail(response, 404, new Error(`Unknown run "${request.params.runId}".`));
    return;
  }
  response.json(run);
});

app.get("/tasks/:runId/logs", async (request, response) => {
  try {
    response.type("text/plain").send(await taskSupervisor.logs(request.params.runId));
  } catch (error) {
    fail(response, 404, error);
  }
});

app.post("/tasks/:runId/stop", async (request, response) => {
  try {
    response.json(await taskSupervisor.stop(request.params.runId));
  } catch (error) {
    fail(response, 404, error);
  }
});

// ---------------------------------------------------------------------------
// Workflows: the authored graph, run by the local interpreter
// ---------------------------------------------------------------------------

app.post("/workflows", (request, response) => {
  let submission;
  try {
    submission = readSubmission(request.body);
    assertLocalInvocationEdge(framework, submission.caller, submission.target);
  } catch (error) {
    observeRejectedSubmission("workflow", request.body, error);
    fail(response, 403, error);
    return;
  }
  try {
    const { id } = parseTargetReference(submission.target);
    const execution = workflowEngine.start(id, submission.input);
    response.status(202).json({
      executionId: execution.executionId,
      status: execution.status,
    });
  } catch (error) {
    observeRejectedSubmission("workflow", request.body, error);
    fail(response, error instanceof WorkflowStateError && error.errorName === WORKFLOW_ERROR_NAMES.dataLimitExceeded ? 400 : 500, error);
  }
});

/**
 * Where a local worker reports a result.
 *
 * Private to the Compose network, like every other control on this runner. The
 * token is the credential: a completion is accepted for a callback this process
 * is actually holding, and for nothing else. A duplicate delivery is told that
 * it is one, and a token from a retried attempt or a previous run of this
 * process is told that too — both are `gone`, not `retry me`.
 */
app.post("/callbacks/:token/:outcome", (request, response) => {
  const { token, outcome } = request.params;
  const body = (request.body ?? {}) as {
    result?: unknown;
    error?: { error?: string; cause?: string };
  };
  try {
    if (outcome === "succeeded") {
      workflowEngine.callbacks.succeed(token, body.result ?? null);
    } else if (outcome === "failed") {
      const failure = body.error;
      if (typeof failure?.error !== "string" || failure.error.length === 0) {
        response.status(400).json({ error: "A failure needs an error name." });
        return;
      }
      workflowEngine.callbacks.fail(token, {
        error: failure.error,
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      });
    } else if (outcome === "heartbeat") {
      workflowEngine.callbacks.heartbeat(token);
    } else {
      response.status(404).json({ error: `Unknown callback outcome "${outcome}".` });
      return;
    }
    response.status(202).json({ ok: true });
  } catch (error) {
    fail(
      response,
      error instanceof CallbackCompletionError ? error.status : 500,
      error,
    );
  }
});

// Every execution this runner shows is redacted first: a callback token is a
// credential, and an execution's own history is one of the places one can
// surface — in a step's resolved arguments, or quoted back in a failure cause.
app.get("/workflows", (_request, response) =>
  response.json({ executions: redactCallbackHandles(workflowEngine.list()) }),
);

app.get("/workflows/:executionId", (request, response) => {
  const execution = workflowEngine.get(request.params.executionId);
  if (!execution) {
    fail(response, 404, new Error(`Unknown execution "${request.params.executionId}".`));
    return;
  }
  response.json(redactCallbackHandles(execution));
});

app.post("/workflows/:executionId/stop", async (request, response) => {
  try {
    response.json(redactCallbackHandles(await workflowEngine.stop(request.params.executionId)));
  } catch (error) {
    fail(response, 404, error);
  }
});

let server: ReturnType<typeof app.listen> | undefined;
let shutdownPromise: Promise<void> | undefined;
let developmentLogCollector: Awaited<ReturnType<typeof startDevelopmentLogCollector>> | undefined;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  imageJanitor?.close();
  cancelDockerBuilds();
  const deadline = setTimeout(() => {
    console.error("Runner cleanup exceeded 25 seconds; inspect project containers with docker ps.");
    process.exit(1);
  }, 25_000);
  deadline.unref();
  server?.close();
  for (const controller of lambdaControllers) controller.abort(new Error("Local runner is shutting down."));
  shutdownPromise = (async () => {
    await Promise.all([agentSupervisor.close(), toolExecutor.close(), workflowEngine?.shutdown(), taskSupervisor?.shutdown()]);
    await Promise.allSettled([...lambdaInvocations]);
    if (projectName) await cleanupStaleContainers();
    await developmentLogCollector?.close();
    server?.closeAllConnections();
    clearTimeout(deadline);
  })();
  return shutdownPromise;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}

async function main(): Promise<void> {
  const identity = await composeIdentity();
  projectName = identity.projectName;
  networkName = identity.network;
  awsConfigSource = identity.awsConfigSource;
  try { developmentLogCollector = await startDevelopmentLogCollector({ app, repositoryRoot, projectName, config: framework }); }
  catch { console.error("Development log collection is unavailable; local execution remains available."); }
  if (closing) return;
  taskSupervisor = new LocalTaskSupervisor({
    config: framework, repositoryRoot, projectName, network: composeNetwork, docker, awsConfigSource,
    runtimeSessionId: process.env.FRAMEWORK_DEVELOPMENT_LOG_SESSION,
    // Builds take the cancellable command: stopping one run must stop that
    // run's build, and shutdown must not wait out a build nothing can launch.
    buildImage: dockerBuild,
    followLogs: followContainerLogs,
    onImageBuilt: () => void imageJanitor?.request(),
  });
  imageJanitor = new LocalImageJanitor({ docker, project: projectName, keep: currentImages, buildsInFlight });
  workflowEngine = new LocalWorkflowEngine({
    config: framework,
    repositoryRoot,
    runnerUrl,
    tasks: taskSupervisor,
    // The same image lane `POST /invoke` uses. A workflow step that names a
    // container-packaged handler goes through it rather than through a second
    // implementation that would drift from it.
    invokeContainerLambda: (id, event, signal) =>
      invokeContainer(toTargetReference("lambda", id) as LambdaTarget, event, signal),
    // Real development resources, named by the binding document the deployment
    // published. Nothing is simulated and nothing is guessed from a naming
    // convention: an unbound reference is an error that says which deployment
    // it looked in.
    callIntegration: (request, options) =>
      callIntegration(request, integrationClients, workflowBindings, options),
    // The same session processes the browser and invokeAgent reach, so an
    // agent behaves identically whichever lane calls it.
    agents: agentSupervisor,
  });
  await Promise.all([cleanupStaleContainers(), taskSupervisor.initialize()]);
  if (closing) return;
  // After the sweep above, which frees the images of the containers it
  // removed. In the background: listening does not wait on cleanup.
  void imageJanitor.request();
  const port = Number(process.env.PORT ?? "8090");
  server = app.listen(port, () => console.log(`Local runner listening on ${port} (Compose project ${projectName})`));
}
void main().catch(error => {
  console.error("Unable to initialize local runner:", error.message);
  process.exitCode = 1;
});

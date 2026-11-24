import { applicationVpc as fixtureVpc } from "../../../../../scripts/test-project-declarations";
import assert from "node:assert/strict";
import path from "node:path";
import test, { after } from "node:test";
import { copySourceFixtures } from "../../../test/cdk/support/source-fixtures";
import { attempt, defineFrameworkConfig, fail, invokeLambda, runTask, runWorkflow as childWorkflow, sequence, succeed, workflow, WorkflowStateError, WORKFLOW_ERROR_NAMES } from "aws-studio/config";
import { defaults } from "../../../../../scripts/test-project-declarations";
import { registerDevelopmentSecrets, setDevelopmentObservationSink, withDevelopmentObservation, type DevelopmentObservation } from "aws-studio/development-logs";
import {
  LocalWorkflowEngine,
  stepFailure,
  type WorkflowTaskLane,
} from "../src/workflows";

/**
 * The runner's own half of workflow execution.
 *
 * The interpreter's semantics are covered in the framework package; what is
 * checked here is the part only this process owns — spawning a real handler in
 * a child process, reading its result back across IPC, and reporting a failure
 * under a name a declared clause can match.
 *
 * Docker is not required: the task lane is a stub, and the only Lambda step in
 * this test's workflow is a Node zip handler.
 */

const sources = copySourceFixtures(`workflow-engine-${process.pid}`, ["workload-handler", "task-worker", "observed-lambda"]);
const repositoryRoot = sources.root;
after(sources.cleanup);

/** The declared fixture graph: validate, then run a container and wait. */
const FIXTURE_WORKFLOW = "validate-and-process";
const framework = defineFrameworkConfig({ networks: [fixtureVpc],
  defaults, http: [], webSocket: [], services: [],
  events: [{ "validate-message": { directory: sources.directory("workload-handler") } }],
  tasks: [{ "process-message": { cloud: { vpc: fixtureVpc }, directory: sources.directory("task-worker"), deploy: "both" } }],
  workflows: [{
    "validate-and-process": workflow<{ message: string }>(({ input }) => {
      const validated = invokeLambda<{ validatedBy: string }, { message: string }>("validate-message", { payload: input });
      return sequence(
        validated,
        attempt(runTask("process-message", { payload: validated.output, timeoutSeconds: 600 }),
          () => fail({ error: "ProcessingFailed", cause: "The worker did not exit zero." })),
        succeed(validated.output),
      );
    }, { deploy: "both", timeoutSeconds: 900 }),
  }],
});

function engineWith(
  tasks: WorkflowTaskLane,
  overrides: Partial<ConstructorParameters<typeof LocalWorkflowEngine>[0]> = {},
): LocalWorkflowEngine {
  return new LocalWorkflowEngine({
    config: framework,
    repositoryRoot,
    runnerUrl: "http://local-invocation-runner:8090",
    tasks,
    ...overrides,
  });
}

function taskLane(
  result: { readonly exitCode?: number } | (() => never),
): WorkflowTaskLane & { readonly submitted: string[]; readonly stopped: string[] } {
  const submitted: string[] = [];
  const stopped: string[] = [];
  return {
    submitted,
    stopped,
    submit: (id) => {
      if (typeof result === "function") result();
      submitted.push(id);
      return { runId: `run-${submitted.length}` };
    },
    wait: async (runId) => ({
      runId,
      exitCode: typeof result === "function" ? 1 : (result.exitCode ?? 0),
    }),
    stop: async (runId) => {
      stopped.push(runId);
      return { runId };
    },
  };
}

/** Polls the engine's journal, because `start` returns on acceptance. */
async function settle(
  engine: LocalWorkflowEngine,
  executionId: string,
  timeoutMilliseconds = 60_000,
): Promise<ReturnType<LocalWorkflowEngine["get"]>> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const execution = engine.get(executionId);
    if (execution && execution.status !== "running") return execution;
    if (Date.now() > deadline) {
      throw new Error(`Execution ${executionId} did not finish in time.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("separate workflow Lambda processes retain execution/request attribution and final sanitized output under concurrency", async () => {
  const observed = defineFrameworkConfig({ networks: [fixtureVpc], defaults, http: [], webSocket: [], services: [],
    events: [{ observed: { directory: sources.directory("observed-lambda") } }],
    workflows: [{ observed: workflow<{ label: string; secret: string; fail?: boolean }>(({ input }) => invokeLambda("observed", { payload: input }), { deploy: "both", timeoutSeconds: 60 }) }],
  });
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink(event => events.push(event));
  registerDevelopmentSecrets("lambda:observed", ["workflow-canary-secret"]);
  const engine = new LocalWorkflowEngine({ config: observed, repositoryRoot, runnerUrl: "http://fixture.invalid", tasks: taskLane({ exitCode: 0 }),
    resolveEnvironment: async () => ({ PATH: process.env.PATH ?? "", FRAMEWORK_DEVELOPMENT_LOGS: "1" }),
  });
  try {
    const a = withDevelopmentObservation({ correlation: { requestId: "request-a", traceId: "trace-a" } }, () => engine.start("observed", { label: "a", secret: "workflow-canary-secret" }));
    const b = withDevelopmentObservation({ correlation: { requestId: "request-b", traceId: "trace-b" } }, () => engine.start("observed", { label: "b", secret: "workflow-canary-secret", fail: true }));
    await Promise.all([settle(engine, a.executionId), settle(engine, b.executionId)]);
    assert.equal(a.status, "succeeded"); assert.equal(b.status, "failed");
    const outputs = events.filter(event => event.kind === "lambda.output");
    assert.ok(outputs.some(event => event.message?.includes("final a") && event.correlation.executionId === a.executionId));
    assert.ok(outputs.some(event => event.message?.includes("final b") && event.correlation.executionId === b.executionId));
    assert.ok(outputs.filter(event => event.correlation.executionId === a.executionId).every(event => event.correlation.requestId === "request-a"));
    assert.ok(outputs.filter(event => event.correlation.executionId === b.executionId).every(event => event.correlation.requestId === "request-b"));
    assert.equal(new Set(outputs.map(event => event.correlation.invocationId)).size, 2);
    assert.doesNotMatch(JSON.stringify(events), /workflow-canary-secret/);
  } finally { await engine.shutdown(); restore(); }
});

// ---------------------------------------------------------------------------
// Error naming
// ---------------------------------------------------------------------------

test("a named handler error keeps its name across the process boundary", () => {
  const failure = stepFailure("lambda:alpha", {
    name: "ThrottledError",
    message: "slow down",
  });
  assert.equal(failure.errorName, "ThrottledError");
  assert.equal(failure.cause, "slow down");
});

test("an unnamed failure becomes the task failure a catch clause is written against", () => {
  for (const error of [undefined, { message: "broke" }, { name: "Error", message: "broke" }]) {
    assert.equal(
      stepFailure("lambda:alpha", error).errorName,
      WORKFLOW_ERROR_NAMES.taskFailed,
    );
  }
});

// ---------------------------------------------------------------------------
// End to end, through a real child process
// ---------------------------------------------------------------------------

test("the fixture workflow runs its handler in a child process and its task in the lane", async () => {
  const tasks = taskLane({ exitCode: 0 });
  const engine = engineWith(tasks);
  try {
    const started = engine.start(FIXTURE_WORKFLOW, { message: "hello" });
    const execution = await settle(engine, started.executionId);

    assert.equal(execution?.status, "succeeded");
    assert.deepEqual(execution?.output, { validatedBy: "validate-message" });
    assert.deepEqual(tasks.submitted, ["process-message"]);
  } finally {
    await engine.shutdown();
  }
});

test("a handler that throws fails the execution with its own message", async () => {
  const engine = engineWith(taskLane({ exitCode: 0 }));
  try {
    // The fixture handler requires `message`; omitting it is the handler's own
    // failure rather than a framework one.
    const started = engine.start(FIXTURE_WORKFLOW, {});
    const execution = await settle(engine, started.executionId);

    assert.equal(execution?.status, "failed");
    assert.match(execution?.error?.cause ?? "", /message is required/);
  } finally {
    await engine.shutdown();
  }
});

test("a non-zero container exit reaches the graph's own catch clause", async () => {
  const engine = engineWith(taskLane({ exitCode: 2 }));
  try {
    const started = engine.start(FIXTURE_WORKFLOW, { message: "hello" });
    const execution = await settle(engine, started.executionId);

    // The test graph wraps its task in attempt(..., () => fail("ProcessingFailed")).
    assert.equal(execution?.status, "failed");
    assert.equal(execution?.error?.name, "ProcessingFailed");
  } finally {
    await engine.shutdown();
  }
});

test("an undeclared workflow is refused rather than started", () => {
  const engine = engineWith(taskLane({ exitCode: 0 }));
  assert.throws(
    () => engine.start("not-a-workflow", {}),
    /is not declared under workflows/,
  );
});

test("stopping an execution marks it and leaves its record readable", async () => {
  const tasks = taskLane({ exitCode: 0 });
  const engine = engineWith(tasks);
  try {
    const started = engine.start(FIXTURE_WORKFLOW, { message: "hello" });
    await engine.stop(started.executionId);
    const execution = await settle(engine, started.executionId);
    assert.ok(
      execution?.status === "aborted" || execution?.status === "succeeded",
      `terminal, was ${execution?.status}`,
    );
  } finally {
    await engine.shutdown();
  }
});

const payloadFramework = defineFrameworkConfig({ networks: [fixtureVpc], defaults, http: [], webSocket: [], events: [], services: [],
  tasks: [{ "process-message": { cloud: { vpc: fixtureVpc }, directory: sources.directory("task-worker"), deploy: "both" } }],
  workflows: [{
    admission: workflow(() => sequence(runTask("process-message"), succeed({ ok: true })), { deploy: "both", timeoutSeconds: 60 }),
    parent: workflow<{ part: string }>(({ input }) => childWorkflow("child", { payload: { first: input.part, second: input.part } }), { deploy: "both", timeoutSeconds: 60 }),
    child: workflow(() => sequence(runTask("process-message"), succeed({ ok: true })), { deploy: "both", timeoutSeconds: 60 }),
    "parent-output": workflow(() => sequence(childWorkflow("child-output"), runTask("process-message")), { deploy: "both", timeoutSeconds: 60 }),
    "child-output": workflow(() => succeed("漢".repeat(100_000)), { deploy: "both", timeoutSeconds: 60 }),
  }],
});

test("workflow admission enforces ASCII and multibyte byte budgets before creating an execution", async () => {
  for (const character of ["a", "漢"]) {
    for (const offset of [-1, 0, 1]) {
      const bytes = 256 * 1024 + offset;
      const width = Buffer.byteLength(character, "utf8");
      const input = character.repeat(Math.floor((bytes - 2) / width)) + "a".repeat((bytes - 2) % width);
      assert.equal(Buffer.byteLength(JSON.stringify(input), "utf8"), bytes);
      const tasks = taskLane({ exitCode: 0 });
      const engine = engineWith(tasks, { config: payloadFramework });
      const observations: DevelopmentObservation[] = [];
      const restore = setDevelopmentObservationSink(event => observations.push(event));
      try {
        if (offset > 0) {
          assert.throws(() => engine.start("admission", input), error =>
            error instanceof WorkflowStateError && error.errorName === WORKFLOW_ERROR_NAMES.dataLimitExceeded);
          assert.equal(engine.list().length, 0);
          assert.deepEqual(tasks.submitted, []);
          assert.equal(observations.some(event => event.kind === "workflow.accepted"), false);
        } else {
          const started = engine.start("admission", input);
          assert.equal((await settle(engine, started.executionId))?.status, "succeeded");
          assert.deepEqual(tasks.submitted, ["process-message"]);
        }
      } finally { await engine.shutdown(); restore(); }
    }
  }
});

test("oversized nested input fails the parent without admitting or executing the child", async () => {
  const tasks = taskLane({ exitCode: 0 });
  const engine = engineWith(tasks, { config: payloadFramework });
  try {
    const parent = engine.start("parent", { part: "a".repeat(140_000) });
    const finished = await settle(engine, parent.executionId);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
    assert.equal(engine.list().length, 1);
    assert.deepEqual(tasks.submitted, []);
  } finally { await engine.shutdown(); }
});

test("oversized nested terminal output fails both executions and prevents the parent's next step", async () => {
  const tasks = taskLane({ exitCode: 0 });
  const engine = engineWith(tasks, { config: payloadFramework });
  try {
    const parent = engine.start("parent-output", {});
    const finished = await settle(engine, parent.executionId);
    assert.equal(finished?.status, "failed");
    assert.equal(finished?.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
    assert.equal(engine.list().length, 2);
    assert.ok(engine.list().every(execution => execution.status === "failed"));
    assert.deepEqual(tasks.submitted, []);
  } finally { await engine.shutdown(); }
});

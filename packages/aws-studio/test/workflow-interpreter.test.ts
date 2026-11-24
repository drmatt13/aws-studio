import assert from "node:assert/strict";
import test from "node:test";
import {
  attempt,
  assertPayloadWithinLimit,
  aws,
  eq,
  expr,
  fail,
  invokeLambda,
  isNull,
  map,
  normalizeWorkflow,
  parallel,
  retry,
  runTask,
  sequence,
  succeed,
  transform,
  wait,
  when,
  workflow,
  WorkflowStateError,
  WORKFLOW_ERROR_NAMES,
  type WorkflowDefinition,
} from "aws-studio/config";
import {
  newExecution,
  runWorkflow,
  type WorkflowExecution,
  type WorkflowStepRunner,
  type WorkflowObservation,
} from "aws-studio/local";

/**
 * What a graph *means*, as the local lane executes it.
 *
 * The same rules the ASL compiler emits, checked by running graphs rather than
 * by inspecting states. Anything asserted here that the compiler also decides
 * has a matching assertion in `workflow-asl.test.ts`; that pairing is what the
 * two lanes agreeing actually consists of.
 */

interface RunResult {
  readonly execution: WorkflowExecution;
  readonly lambdaCalls: { id: string; input: unknown }[];
  readonly taskCalls: { id: string; input: unknown }[];
}

interface Stubs {
  readonly lambda?: (
    id: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<unknown> | unknown;
  readonly task?: (
    id: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<{ runId: string; exitCode: number }> | { runId: string; exitCode: number };
  readonly child?: (id: string, input: unknown) => Promise<unknown> | unknown;
}

async function run(
  definition: WorkflowDefinition,
  input: unknown = {},
  stubs: Stubs = {},
): Promise<RunResult> {
  const compiled = normalizeWorkflow("example", definition, 'workflows["example"]');
  const lambdaCalls: { id: string; input: unknown }[] = [];
  const taskCalls: { id: string; input: unknown }[] = [];

  const runner: WorkflowStepRunner = {
    invokeLambda: async (id, value, options) => {
      lambdaCalls.push({ id, input: value });
      return stubs.lambda ? stubs.lambda(id, value, options.signal) : { id, echoed: value };
    },
    runTask: async (id, value, options) => {
      taskCalls.push({ id, input: value });
      return stubs.task
        ? stubs.task(id, value, options.signal)
        : { runId: `run-${id}`, exitCode: 0 };
    },
    ...(stubs.child ? { runWorkflow: async (id, value) => stubs.child?.(id, value) } : {}),
  };

  const execution = await runWorkflow(compiled, newExecution("example", "#1"), {
    input,
    runner,
  });
  return { execution, lambdaCalls, taskCalls };
}

function deferred(): {
  promise: Promise<never>;
  reject: (error: unknown) => void;
} {
  let reject!: (error: unknown) => void;
  const promise = new Promise<never>((_resolve, rejectFn) => {
    reject = rejectFn;
  });
  // Nothing awaits the rejection unless a test causes it; keep Node quiet.
  promise.catch(() => undefined);
  return { promise, reject };
}

test("observation distinguishes concurrent map attempts without changing execution history or failure semantics", async () => {
  const definition = workflow<{ items: readonly number[] }>(({ input }) =>
    map(input.items, ({ item, index }) => retry(invokeLambda("alpha", { payload: { item, index } }), { retries: 1, intervalSeconds: 0 }), { maxConcurrency: 2 }),
  { timeoutSeconds: 60 });
  const compiled = normalizeWorkflow("observed", definition, 'workflows["observed"]');
  const observations: WorkflowObservation[] = [];
  const calls = new Map<number, number>();
  const execution = await runWorkflow(compiled, newExecution("observed", "#1"), {
    input: { items: [10, 20] },
    onObservation: event => { observations.push(event); if (event.kind === "exited") throw new Error("observer unavailable"); },
    runner: {
      invokeLambda: async (_id, payload, options) => {
        const { index } = payload as { index: number };
        assert.match(options.observation?.path.join("/") ?? "", new RegExp(`:${index}$`));
        const attempt = (calls.get(index) ?? 0) + 1;
        calls.set(index, attempt);
        if (attempt === 1) throw new Error("retry fixture");
        return index;
      },
      runTask: async () => ({ runId: "unused", exitCode: 0 }),
    },
  });
  assert.equal(execution.status, "succeeded", "observer failures cannot fail successful application work");
  assert.deepEqual(execution.output, [0, 1]);
  const inputs = observations.filter(event => event.kind === "input");
  assert.equal(inputs.length, 4);
  assert.equal(new Set(inputs.map(event => event.stepId)).size, 4);
  assert.equal(new Set(inputs.map(event => event.path.join("/"))).size, 2);
  assert.ok(inputs.every(event => event.parentStepId));
  assert.deepEqual(inputs.map(event => event.attempt).sort(), [1, 1, 2, 2]);
  assert.equal(execution.history.filter(event => event.type === "retrying").length, 2);
  assert.ok(execution.history.every(event => !("input" in event) && !("output" in event)), "payload evidence stays out of operational history");
});

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

test("a step's result is readable by the steps after it", async () => {
  const { execution } = await run(
    workflow<{ orderId: string }>(({ input }) => {
      const first = invokeLambda<{ total: number }>("alpha", { payload: input });
      return sequence(
        first,
        invokeLambda("beta", { payload: { total: first.output.total } }),
      );
    }, { timeoutSeconds: 60 }),
    { orderId: "A-1" },
    { lambda: (id) => (id === "alpha" ? { total: 7 } : { ok: true }) },
  );
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { ok: true });
});

test("an absent payload is an empty document, not the previous result", async () => {
  const { lambdaCalls } = await run(
    workflow(() => sequence(invokeLambda("alpha"), invokeLambda("beta")), {
      timeoutSeconds: 60,
    }),
  );
  assert.deepEqual(lambdaCalls[1]?.input, {});
});

test("reading a member that is not there fails the step rather than dropping it", async () => {
  const { execution } = await run(
    workflow<{ present: string }>(({ input }) =>
      invokeLambda("alpha", {
        payload: { value: (input as unknown as { missing: string }).missing },
      }),
    { timeoutSeconds: 60 }),
    { present: "yes" },
  );
  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.queryEvaluation);
  assert.match(execution.error?.cause ?? "", /input\.missing/);
});

test("an explicit null is a value and survives the round trip", async () => {
  const { execution } = await run(
    workflow<{ note: string | null }>(({ input }) =>
      sequence(invokeLambda("alpha", { payload: { note: input.note } }), succeed(input.note)),
    { timeoutSeconds: 60 }),
    { note: null },
  );
  assert.equal(execution.status, "succeeded");
  assert.equal(execution.output, null);
});

test("a skipped optional branch produces null, the same value the cloud lane assigns", async () => {
  const { execution } = await run(
    workflow<{ ready: boolean }>(({ input }) => {
      const optional = when(eq(input.ready, true), invokeLambda("alpha"));
      return sequence(optional, succeed({ skipped: isNullFlow(optional) }));
    }, { timeoutSeconds: 60 }),
    { ready: false },
  );
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { skipped: null });

  // A helper rather than a condition, because `succeed` takes a payload and the
  // point of the assertion is the *value* the skipped branch produced.
  function isNullFlow(flow: { output: unknown }): unknown {
    return flow.output;
  }
});

test("isNull sees the skipped branch as null in the local lane too", async () => {
  const { execution } = await run(
    workflow<{ ready: boolean }>(({ input }) => {
      const optional = when(eq(input.ready, true), invokeLambda("alpha"));
      return sequence(
        optional,
        when(isNull(optional.output), succeed("skipped"), succeed("ran")),
      );
    }, { timeoutSeconds: 60 }),
    { ready: false },
  );
  assert.equal(execution.output, "skipped");
});

test("succeed() with no value ends with null", async () => {
  const { execution } = await run(
    workflow(() => sequence(invokeLambda("alpha"), succeed()), { timeoutSeconds: 60 }),
  );
  assert.equal(execution.status, "succeeded");
  assert.equal(execution.output, null);
});

test("equality does not depend on the order members were written in", async () => {
  const { execution } = await run(
    workflow(() => {
      const produced = invokeLambda<{ a: number; b: number }>("alpha");
      return sequence(
        produced,
        when(eq(produced.output, { b: 2, a: 1 } as never), succeed("same"), succeed("different")),
      );
    }, { timeoutSeconds: 60 }),
    {},
    { lambda: () => ({ a: 1, b: 2 }) },
  );
  assert.equal(execution.output, "same");
});

test("authored text that resembles an expression stays text", async () => {
  const { lambdaCalls } = await run(
    workflow(() => invokeLambda("alpha", { payload: { note: "{% $states.result %}" } }), {
      timeoutSeconds: 60,
    }),
  );
  assert.deepEqual(lambdaCalls[0]?.input, { note: "{% $states.result %}" });
});

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

test("named parallel results arrive as the object the author declared", async () => {
  const { execution } = await run(
    workflow(() => parallel({ user: invokeLambda("alpha"), account: invokeLambda("beta") }), {
      timeoutSeconds: 60,
    }),
    {},
    { lambda: (id) => ({ from: id }) },
  );
  assert.deepEqual(execution.output, {
    user: { from: "alpha" },
    account: { from: "beta" },
  });
});

test("a failing parallel branch stops its siblings", async () => {
  const stopped: string[] = [];
  const blocked = deferred();
  const { execution } = await run(
    workflow(
      () => parallel({ quick: invokeLambda("alpha"), slow: invokeLambda("beta") }),
      { timeoutSeconds: 60 },
    ),
    {},
    {
      lambda: (id, _input, signal) => {
        if (id === "alpha") throw new WorkflowStateError("CustomError", "no");
        signal.addEventListener("abort", () => {
          stopped.push(id);
          blocked.reject(signal.reason);
        });
        return blocked.promise;
      },
    },
  );
  assert.equal(execution.status, "failed");
  assert.deepEqual(stopped, ["beta"]);
});

test("map results keep the order of their items, whatever order they finish in", async () => {
  const { execution } = await run(
    workflow<{ files: readonly number[] }>(({ input }) =>
      map(input.files, ({ item, index }) =>
        invokeLambda("alpha", { payload: { item, index } }),
      ),
    { timeoutSeconds: 60 }),
    { files: [30, 20, 10] },
    {
      lambda: async (_id, value) => {
        const payload = value as { item: number; index: number };
        await new Promise((resolve) => setTimeout(resolve, payload.item));
        return payload.index;
      },
    },
  );
  assert.deepEqual(execution.output, [0, 1, 2]);
});

test("an empty array maps to an empty array without running the body", async () => {
  const { execution, lambdaCalls } = await run(
    workflow<{ files: readonly string[] }>(({ input }) =>
      map(input.files, ({ item }) => invokeLambda("alpha", { payload: { item } })),
    { timeoutSeconds: 60 }),
    { files: [] },
  );
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, []);
  assert.equal(lambdaCalls.length, 0);
});

test("a failed iteration stops the map scheduling further ones", async () => {
  let started = 0;
  const { execution } = await run(
    workflow<{ files: readonly number[] }>(({ input }) =>
      map(input.files, ({ item }) => invokeLambda("alpha", { payload: { item } }), {
        maxConcurrency: 1,
      }),
    { timeoutSeconds: 60 }),
    { files: [1, 2, 3, 4, 5] },
    {
      lambda: () => {
        started += 1;
        throw new WorkflowStateError("CustomError", "iteration failed");
      },
    },
  );
  assert.equal(execution.status, "failed");
  assert.equal(started, 1);
});

test("a map honours its concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  await run(
    workflow<{ files: readonly number[] }>(({ input }) =>
      map(input.files, ({ item }) => invokeLambda("alpha", { payload: { item } }), {
        maxConcurrency: 2,
      }),
    { timeoutSeconds: 60 }),
    { files: [1, 2, 3, 4, 5, 6] },
    {
      lambda: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return null;
      },
    },
  );
  assert.equal(peak, 2);
});

test("a value made inside a branch is not visible to a later step", async () => {
  // The validator refuses this at declaration time, which is the point: the
  // interpreter never has to answer the question.
  assert.throws(
    () =>
      normalizeWorkflow(
        "example",
        workflow(() => {
          let inner!: ReturnType<typeof invokeLambda>;
          const fan = parallel({
            left: (() => {
              inner = invokeLambda("alpha");
              return inner;
            })(),
          });
          return sequence(fan, invokeLambda("beta", { payload: inner.output }));
        }, { timeoutSeconds: 60 }),
        'workflows["example"]',
      ),
    /do not survive it/,
  );
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("a named error reaches a retry clause that names it", async () => {
  let attempts = 0;
  const { execution } = await run(
    workflow(
      () =>
        retry(invokeLambda("alpha"), {
          retries: 2,
          on: ["ThrottledError"],
          intervalSeconds: 0,
        }),
      { timeoutSeconds: 60 },
    ),
    {},
    {
      lambda: () => {
        attempts += 1;
        if (attempts < 3) throw new WorkflowStateError("ThrottledError", "slow down");
        return { ok: true };
      },
    },
  );
  assert.equal(execution.status, "succeeded");
  assert.equal(attempts, 3, "retries: 2 runs the step three times");
});

test("a retry clause that names a different error does not retry", async () => {
  let attempts = 0;
  const { execution } = await run(
    workflow(
      () => retry(invokeLambda("alpha"), { retries: 5, on: ["ThrottledError"], intervalSeconds: 0 }),
      { timeoutSeconds: 60 },
    ),
    {},
    {
      lambda: () => {
        attempts += 1;
        throw new WorkflowStateError("ValidationError", "bad input");
      },
    },
  );
  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, "ValidationError");
  assert.equal(attempts, 1);
});

test("attempt catches only the errors it selects and gives the handler the cause", async () => {
  const { execution } = await run(
    workflow(
      () =>
        attempt(
          invokeLambda("alpha"),
          (error) => succeed({ caught: error.error, why: error.cause }),
          { on: ["CustomError"] },
        ),
      { timeoutSeconds: 60 },
    ),
    {},
    {
      lambda: () => {
        throw new WorkflowStateError("CustomError", "it broke");
      },
    },
  );
  assert.equal(execution.status, "succeeded");
  assert.deepEqual(execution.output, { caught: "CustomError", why: "it broke" });
});

test("a non-zero container exit fails the step", async () => {
  const { execution } = await run(
    workflow(() => runTask("worker", { payload: { go: true } }), { timeoutSeconds: 60 }),
    {},
    { task: () => ({ runId: "run-1", exitCode: 3 }) },
  );
  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.taskFailed);
  assert.match(execution.error?.cause ?? "", /exited 3/);
});

test("a task step receives a JSON document and answers with the framework summary", async () => {
  const { execution, taskCalls } = await run(
    workflow(() => runTask("worker"), { timeoutSeconds: 60 }),
  );
  assert.deepEqual(taskCalls[0]?.input, {});
  assert.deepEqual(execution.output, { runId: "run-worker", exitCode: 0 });
});

test("fail() ends the execution with the declared error name", async () => {
  const { execution } = await run(
    workflow(() => fail({ error: "Rejected", cause: "not allowed" }), { timeoutSeconds: 60 }),
  );
  assert.equal(execution.status, "failed");
  assert.deepEqual(execution.error, { name: "Rejected", cause: "not allowed" });
});

// ---------------------------------------------------------------------------
// Deadlines and cancellation
// ---------------------------------------------------------------------------

test("the execution deadline ends a workflow whose work is still pending", async () => {
  const started = Date.now();
  const blocked = deferred();
  const { execution } = await run(
    workflow(() => invokeLambda("alpha"), { timeoutSeconds: 1 }),
    {},
    {
      lambda: (_id, _input, signal) => {
        signal.addEventListener("abort", () => blocked.reject(signal.reason));
        return blocked.promise;
      },
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(execution.status, "timedOut");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.timeout);
  assert.ok(elapsed < 1500, `ended promptly, took ${elapsed}ms`);
});

test("a step timeout fails the execution rather than timing it out", async () => {
  const blocked = deferred();
  const { execution } = await run(
    workflow(() => invokeLambda("alpha", { timeoutSeconds: 1 }), { timeoutSeconds: 300 }),
    {},
    {
      lambda: (_id, _input, signal) => {
        signal.addEventListener("abort", () => blocked.reject(signal.reason));
        return blocked.promise;
      },
    },
  );
  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.timeout);
  assert.match(execution.error?.cause ?? "", /1-second timeout/);
});

test("a step timeout is catchable, so a graph can handle a slow step", async () => {
  const blocked = deferred();
  const { execution } = await run(
    workflow(
      () =>
        attempt(
          invokeLambda("alpha", { timeoutSeconds: 1 }),
          () => succeed("recovered"),
          { on: "timeout" },
        ),
      { timeoutSeconds: 300 },
    ),
    {},
    {
      lambda: (_id, _input, signal) => {
        signal.addEventListener("abort", () => blocked.reject(signal.reason));
        return blocked.promise;
      },
    },
  );
  assert.equal(execution.status, "succeeded");
  assert.equal(execution.output, "recovered");
});

test("a wait longer than the execution deadline times the execution out", async () => {
  const { execution } = await run(
    workflow(() => sequence(wait({ seconds: 30 }), succeed("late")), { timeoutSeconds: 1 }),
  );
  assert.equal(execution.status, "timedOut");
});

test("stopping an execution abandons it and stops the work it owns", async () => {
  const compiled = normalizeWorkflow(
    "example",
    workflow(() => invokeLambda("alpha"), { timeoutSeconds: 300 }),
    'workflows["example"]',
  );
  const controller = new AbortController();
  const blocked = deferred();
  let cancelled = false;

  const pending = runWorkflow(compiled, newExecution("example", "#1"), {
    input: {},
    signal: controller.signal,
    runner: {
      invokeLambda: (_id, _input, options) => {
        options.signal.addEventListener("abort", () => {
          cancelled = true;
          blocked.reject(options.signal.reason);
        });
        return blocked.promise;
      },
      runTask: async () => ({ runId: "run", exitCode: 0 }),
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("stopped by an operator"));
  const execution = await pending;

  assert.equal(execution.status, "aborted");
  assert.ok(cancelled, "the in-flight step was cancelled, not merely ignored");
});

test("history records the states a run entered, in order", async () => {
  const { execution } = await run(
    workflow(() => sequence(invokeLambda("alpha"), invokeLambda("beta")), {
      timeoutSeconds: 60,
    }),
  );
  const entered = execution.history
    .filter((event) => event.type === "entered")
    .map((event) => event.state);
  assert.deepEqual(entered, ["InvokeLambda_Alpha_1", "InvokeLambda_Beta_2"]);
});

const payloadByteLimit = 256 * 1024;

/** A JSON string of exactly this many UTF-8 bytes, including its quotes. */
function sizedPayload(bytes: number, character: string): string {
  const content = bytes - 2;
  const width = Buffer.byteLength(character, "utf8");
  const value = character.repeat(Math.floor(content / width)) + "a".repeat(content % width);
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), bytes);
  return value;
}

test("payload accounting uses serialized UTF-8 bytes at the exact quota boundary", () => {
  for (const character of ["a", "漢", "😀"]) {
    for (const offset of [-1, 0, 1]) {
      const value = sizedPayload(payloadByteLimit + offset, character);
      if (offset <= 0) assert.doesNotThrow(() => assertPayloadWithinLimit(value, "fixture"));
      else assert.throws(() => assertPayloadWithinLimit(value, "fixture"), error =>
        error instanceof WorkflowStateError && error.errorName === WORKFLOW_ERROR_NAMES.dataLimitExceeded);
    }
  }
});

test("direct interpreter admission rejects oversized input before any step runs", async () => {
  const definition = workflow(() => invokeLambda("alpha"), { timeoutSeconds: 60 });
  for (const character of ["a", "漢"]) {
    for (const offset of [-1, 0, 1]) {
      const result = await run(definition, sizedPayload(payloadByteLimit + offset, character));
      assert.equal(result.execution.status, offset > 0 ? "failed" : "succeeded");
      assert.equal(result.lambdaCalls.length, offset > 0 ? 0 : 1);
      if (offset > 0) assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
    }
  }
});

test("an oversized resolved invocation input is refused before invoking its target", async () => {
  const definition = workflow<{ part: string }>(({ input }) => invokeLambda("alpha", {
    payload: { first: input.part, second: input.part },
  }), { timeoutSeconds: 60 });
  const result = await run(definition, { part: "a".repeat(140_000) }, { lambda: () => null });
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(result.lambdaCalls.length, 0);
});

test("an oversized integration input is refused before making the service call", async () => {
  const operation = aws.operation<{ first: string; second: string }, object>("payload-budget", { service: "translate", action: "translateText" });
  const definition = workflow<{ part: string }>(({ input }) => aws.call(operation, { first: input.part, second: input.part }), { timeoutSeconds: 60 });
  let calls = 0;
  const execution = await runWorkflow(normalizeWorkflow("example", definition, 'workflows["example"]'), newExecution("example", "#1"), {
    input: { part: "a".repeat(140_000) },
    runner: {
      invokeLambda: async () => null,
      runTask: async () => ({ runId: "unused", exitCode: 0 }),
      callIntegration: async () => { calls++; return {}; },
    },
  });
  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(calls, 0);
});

test("an oversized Map iteration input is refused before its body executes", async () => {
  const definition = workflow<{ parts: readonly string[] }>(({ input }) =>
    map(expr.project(input.parts, part => expr.concat(part, part)), () => invokeLambda("alpha")), { timeoutSeconds: 60 });
  const result = await run(definition, { parts: ["a".repeat(140_000)] });
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(result.lambdaCalls.length, 0);
});

test("Map iteration accounting includes the compiled item/index selector document", async () => {
  const definition = workflow<{ parts: readonly string[] }>(({ input }) =>
    map(input.parts, () => invokeLambda("alpha")), { timeoutSeconds: 60 });
  const input = { parts: ["a".repeat(payloadByteLimit - Buffer.byteLength(JSON.stringify({ parts: [""] }), "utf8"))] };
  assert.equal(Buffer.byteLength(JSON.stringify(input), "utf8"), payloadByteLimit);
  assert.ok(Buffer.byteLength(JSON.stringify({ item: input.parts[0], index: 0 }), "utf8") > payloadByteLimit);
  const result = await run(definition, input);
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(result.lambdaCalls.length, 0);
});

test("an oversized Lambda result fails before the next step", async () => {
  const result = await run(workflow(() => sequence(invokeLambda("alpha"), invokeLambda("beta")), { timeoutSeconds: 60 }), {}, {
    lambda: id => id === "alpha" ? "漢".repeat(100_000) : "next",
  });
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.deepEqual(result.lambdaCalls.map(call => call.id), ["alpha"]);
});

test("the normalized task result has a byte budget without counting unrelated task logs", async () => {
  const definition = workflow(() => {
    const task = runTask("worker");
    return sequence(task, invokeLambda("beta", { payload: task.output }));
  }, { timeoutSeconds: 60 });
  const oversized = await run(definition, {}, { task: () => ({ runId: "漢".repeat(100_000), exitCode: 0 }) });
  assert.equal(oversized.execution.status, "failed");
  assert.equal(oversized.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(oversized.taskCalls.length, 1);
  assert.equal(oversized.lambdaCalls.length, 0);

  const valid = await run(definition, {}, {
    task: () => ({ runId: "run-worker", exitCode: 0, stdout: "漢".repeat(100_000) }),
    lambda: (_id, input) => input,
  });
  assert.equal(valid.execution.status, "succeeded");
  assert.deepEqual(valid.execution.output, { runId: "run-worker", exitCode: 0 });
});

test("an oversized task callback result fails before the next state", async () => {
  const definition = workflow(() => sequence(
    runTask("worker", { completion: "callback", timeoutSeconds: 5 }),
    invokeLambda("beta"),
  ), { timeoutSeconds: 60 });
  let dispatched = 0, next = 0;
  const execution = await runWorkflow(normalizeWorkflow("example", definition, 'workflows["example"]'), newExecution("example", "#1"), {
    input: {},
    runner: {
      invokeLambda: async () => { next++; return null; },
      runTask: async () => { throw new Error("callback tasks do not use the ordinary task result lane"); },
      startTaskWithCallback: async () => { dispatched++; },
      awaitCallback: async request => { await request.dispatch({ token: "fixture" }); return "漢".repeat(100_000); },
    },
  });
  assert.equal(execution.status, "failed");
  assert.equal(execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(dispatched, 1);
  assert.equal(next, 0);
});

test("explicit succeed validates its result before recording success", async () => {
  const result = await run(workflow(() => succeed("漢".repeat(100_000)), { timeoutSeconds: 60 }));
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(result.execution.history.some(event => event.type === "succeeded"), false);
  assert.equal(result.execution.output, undefined);
});

test("ordinary terminal output also observes the UTF-8 payload budget", async () => {
  const result = await run(workflow(() => transform("漢".repeat(100_000)), { timeoutSeconds: 60 }));
  assert.equal(result.execution.status, "failed");
  assert.equal(result.execution.error?.name, WORKFLOW_ERROR_NAMES.dataLimitExceeded);
  assert.equal(result.execution.output, undefined);
});

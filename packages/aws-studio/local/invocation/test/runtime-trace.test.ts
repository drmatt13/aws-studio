import { testProjectScratchRoot } from "../../../../../scripts/test-project";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defineFrameworkConfig,
  invokeLambda,
  map,
  parallel,
  retry,
  runWorkflow,
  succeed,
  workflow,
} from "aws-studio/config";
import { localPlatformEnvironment } from "aws-studio/local";
import {
  setDevelopmentObservationSink,
  withDevelopmentObservation,
  type DevelopmentObservation,
} from "aws-studio/development-logs";
import { defaults } from "../../../../../scripts/test-project-declarations";
import { containerLambdaCorrelation } from "../src/observation";
import { LocalWorkflowEngine } from "../src/workflows";

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Disposable trace fixture did not finish.");
}

test("container transport keeps the intended invocation while internal calls create distinct child spans", () => {
  const intended = {
    traceId: "request-trace",
    spanId: "lambda-span",
    parentSpanId: "gateway-span",
    invocationId: "lambda-invocation",
    requestId: "request",
  };
  withDevelopmentObservation({ correlation: intended }, () => {
    assert.deepEqual(containerLambdaCorrelation(intended), intended);
    const a = containerLambdaCorrelation(),
      b = containerLambdaCorrelation();
    assert.equal(a.traceId, intended.traceId);
    assert.equal(a.parentSpanId, intended.spanId);
    assert.notEqual(a.invocationId, intended.invocationId);
    assert.notEqual(a.invocationId, b.invocationId);
    assert.notEqual(a.spanId, b.spanId);
  });
});

function fixture(beforeSpawn?: (directory: string) => void) {
  const repositoryRoot = testProjectScratchRoot;
  mkdirSync(path.join(repositoryRoot, ".cache"), { recursive: true });
  const directory = mkdtempSync(
    path.join(repositoryRoot, ".cache/runtime-trace-"),
  );
  const source = path.join(directory, "compute/.cache/test-fixtures/probe");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, "index.ts"),
    `import {existsSync,writeFileSync} from "node:fs";
import path from "node:path";
export async function lambdaHandler(input) {
  if(input.hang) await new Promise(()=>{});
  if(input.retry) {
    const marker=path.join(${JSON.stringify(directory)}, "retry-"+String(input.label));
    if(!existsSync(marker)){writeFileSync(marker,"once");throw new Error("RetryProbe");}
  }
  console.log("probe output",input.label);
  return {statusCode:input.status??200,headers:{"content-type":"application/json"},body:JSON.stringify({label:input.label})};
}`,
  );
  const config = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    services: [],
    events: [
      { probe: { directory: "compute/.cache/test-fixtures/probe", timeoutSeconds: 1 } },
    ],
    workflows: [
      {
        main: workflow<{ label: string; items: number[] }>(
          ({ input }) =>
            parallel({
              retried: retry(
                invokeLambda("probe", {
                  payload: { label: input.label, retry: true },
                }),
                { retries: 1, intervalSeconds: 0.001 },
              ),
              children: map(
                input.items,
                ({ item, index }) =>
                  runWorkflow("child", {
                    payload: { label: input.label, item, index },
                  }),
                { maxConcurrency: 2 },
              ),
            }),
          { deploy: "both", timeoutSeconds: 10 },
        ),
        child: workflow(
          ({ input }) => invokeLambda("probe", { payload: input }),
          { deploy: "both", timeoutSeconds: 5 },
        ),
        slow: workflow(
          ({ input }) => invokeLambda("probe", { payload: input }),
          { deploy: "both", timeoutSeconds: 5 },
        ),
        identity: workflow(({ input }) => succeed(input), {
          deploy: "both",
          timeoutSeconds: 5,
        }),
      },
    ],
  });
  const engine = new LocalWorkflowEngine({
    config,
    repositoryRoot: directory,
    runnerUrl: "http://fixture.invalid",
    tasks: {
      submit: () => {
        throw new Error("No task expected");
      },
      wait: async (runId) => ({ runId, exitCode: 0 }),
      stop: async () => ({}),
    },
    resolveEnvironment: async () => {
      beforeSpawn?.(directory);
      return localPlatformEnvironment({
        PATH: process.env.PATH,
        Path: process.env.Path,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        TMPDIR: process.env.TMPDIR,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        FRAMEWORK_DEVELOPMENT_LOGS: "1",
      });
    },
  });
  return {
    engine,
    dispose: async () => {
      await engine.shutdown();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("real workflow Lambda children retain concurrent traces, execution parents, retries and map identities after submission returns", async () => {
  const f = fixture(),
    events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    const executions = ["A", "B"].map((label) =>
      withDevelopmentObservation(
        {
          correlation: {
            traceId: `trace-${label}`,
            spanId: `caller-${label}`,
            requestId: `request-${label}`,
          },
        },
        () => f.engine.start("main", { label, items: [1, 2] }),
      ),
    );
    await until(() =>
      executions.every((execution) => execution.status !== "running")
        ? true
        : undefined,
    );
    assert.deepEqual(
      executions.map((execution) => execution.status),
      ["succeeded", "succeeded"],
    );
    for (const label of ["A", "B"]) {
      const trace = events.filter(
        (event) => event.correlation.traceId === `trace-${label}`,
      );
      assert.ok(trace.length > 20);
      assert.ok(
        trace.every(
          (event) => event.correlation.requestId === `request-${label}`,
        ),
      );
      const accepted = trace.filter(
        (event) => event.kind === "workflow.accepted",
      );
      assert.equal(accepted.length, 3);
      const observedSpans = new Set(
        trace.map((event) => event.correlation.spanId),
      );
      for (const execution of accepted) {
        const states = trace.filter(
          (event) =>
            event.kind === "workflow.state.entered" &&
            event.correlation.executionId === execution.correlation.executionId,
        );
        assert.ok(
          states.some(
            (event) =>
              event.correlation.parentSpanId === execution.correlation.spanId,
          ),
          "root state belongs to its execution span",
        );
        assert.ok(
          states.every((event) =>
            observedSpans.has(event.correlation.parentSpanId),
          ),
          "each state parent is an observed span in this trace",
        );
      }
      const entered = trace.filter(
        (event) => event.kind === "workflow.state.entered",
      );
      assert.ok(entered.some((event) => event.correlation.mapIndex === 0));
      assert.ok(entered.some((event) => event.correlation.mapIndex === 1));
      const inputs = trace.filter(
        (event) =>
          event.kind === "workflow.state.input" &&
          JSON.stringify(event.details).includes('"retry":true'),
      );
      assert.equal(inputs.length, 2);
      assert.notEqual(
        inputs[0]?.correlation.stateAttemptId,
        inputs[1]?.correlation.stateAttemptId,
      );
      const starts = trace.filter((event) => event.kind === "lambda.started");
      assert.equal(starts.length, 4);
      assert.equal(
        new Set(starts.map((event) => event.correlation.invocationId)).size,
        4,
      );
      assert.ok(
        starts.every((event) =>
          observedSpans.has(event.correlation.parentSpanId),
        ),
      );
      assert.ok(
        trace
          .filter((event) => event.kind === "workflow.finished")
          .every((event) => typeof event.durationMs === "number"),
      );
      assert.ok(
        trace
          .filter((event) => event.kind === "workflow.state.exited")
          .every((event) => typeof event.durationMs === "number"),
      );
    }
  } finally {
    restore();
    await f.dispose();
  }
});

test("workflow timeout and cancellation preserve their single terminal cause instead of reporting a second worker failure", async () => {
  const f = fixture(),
    events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    const timed = f.engine.start("slow", { label: "timeout", hang: true });
    await until(() => (timed.status !== "running" ? true : undefined));
    const cancelled = f.engine.start("slow", {
      label: "cancelled",
      hang: true,
    });
    await until(() =>
      events.find(
        (event) =>
          event.kind === "lambda.started" &&
          event.correlation.executionId === cancelled.executionId,
      ),
    );
    await f.engine.stop(cancelled.executionId);
    await f.engine.shutdown();
    for (const [execution, kind] of [
      [timed, "lambda.timeout"],
      [cancelled, "lambda.cancelled"],
    ] as const) {
      const terminal = events.filter(
        (event) =>
          event.correlation.executionId === execution.executionId &&
          [
            "lambda.timeout",
            "lambda.cancelled",
            "lambda.failed",
            "lambda.exited_without_result",
          ].includes(event.kind),
      );
      assert.deepEqual(
        terminal.map((event) => event.kind),
        [kind],
      );
    }
  } finally {
    restore();
    await f.dispose();
  }
});

test("sensitive parent context is applied before workflow acceptance is persisted", async () => {
  const f = fixture(),
    events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    const execution = withDevelopmentObservation(
      { sensitive: true, correlation: { traceId: randomUUID() } },
      () =>
        f.engine.start("child", {
          label: "OPAQUE_AUTH_ADMISSION_CANARY",
          status: 401,
        }),
    );
    await until(() => (execution.status !== "running" ? true : undefined));
    assert.doesNotMatch(JSON.stringify(events), /OPAQUE_AUTH_ADMISSION_CANARY/);
    const accepted = events.find((event) => event.kind === "workflow.accepted");
    assert.match(JSON.stringify(accepted?.details), /sensitive.*omitted/);
    const completed = events.find((event) => event.kind === "lambda.succeeded");
    assert.equal(
      (completed?.details as { http?: { status: number } })?.http?.status,
      401,
    );
  } finally {
    restore();
    await f.dispose();
  }
});

test("privacy and correlation ownership follows executions without permanently suppressing later ordinary runs", async () => {
  const f = fixture(),
    events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    const privateRuns = Array.from({ length: 205 }, () =>
      withDevelopmentObservation({ sensitive: true }, () =>
        f.engine.start("identity", { value: "PRIVATE_BURST_CANARY" }),
      ),
    );
    await until(() =>
      privateRuns.every((run) => run.status !== "running") ? true : undefined,
    );
    const ordinary = f.engine.start("identity", {
      value: "visible ordinary execution",
    });
    await until(() => (ordinary.status !== "running" ? true : undefined));
    assert.ok(f.engine.list().length <= 200);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_BURST_CANARY/);
    const terminal = events.find(
      (event) =>
        event.kind === "workflow.finished" &&
        event.correlation.executionId === ordinary.executionId,
    );
    assert.match(
      JSON.stringify(terminal?.details),
      /visible ordinary execution/,
    );
  } finally {
    restore();
    await f.dispose();
  }
});

test("a real worker spawn/IPC failure is one observed failure and does not crash the runner", async () => {
  const f = fixture((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  );
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    const execution = f.engine.start("child", { label: "spawn-failure" });
    await until(() => (execution.status !== "running" ? true : undefined));
    await f.engine.shutdown();
    assert.equal(execution.status, "failed");
    assert.deepEqual(
      events
        .filter((event) =>
          ["lambda.failed", "lambda.exited_without_result"].includes(
            event.kind,
          ),
        )
        .map((event) => event.kind),
      ["lambda.failed"],
    );
  } finally {
    restore();
    await f.dispose();
  }
});

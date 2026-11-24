import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import path from "node:path";
import test, { after } from "node:test";
import { copySourceFixtures } from "../../../test/cdk/support/source-fixtures";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  defineFrameworkConfig,
  invokeLambda,
  workflow,
} from "aws-studio/config";
import {
  registerDevelopmentSecrets,
  setDevelopmentObservationSink,
  withDevelopmentObservation,
  type DevelopmentObservation,
} from "aws-studio/development-logs";
import { applicationVpc } from "../../../../../scripts/test-project-declarations";
import { defaults } from "../../../../../scripts/test-project-declarations";
import { forwardLines } from "../src/docker";
import { LocalWorkflowEngine } from "../src/workflows";
import { LocalTaskSupervisor } from "../src/tasks";

test("session output has no inherited request attribution and redacts across chunks including final partial output", () => {
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  registerDevelopmentSecrets("agent:fixture", ["canary-session-secret"]);
  const output = new PassThrough();
  try {
    const stop = withDevelopmentObservation(
      {
        resourceId: "lambda:caller",
        correlation: {
          requestId: "first-request",
          invocationId: "first-invocation",
        },
      },
      () =>
        forwardLines(output, "fixture", {
          resourceId: "agent:fixture",
          correlation: { agentSessionId: "session-a" },
          stream: "stderr",
        }),
    );
    output.write("ordinary flow canary-session-");
    output.write("secret\nfinal partial");
    stop();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.correlation.agentSessionId, "session-a");
    assert.equal(events[0]?.correlation.requestId, undefined);
    assert.equal(events[0]?.correlation.invocationId, undefined);
    assert.equal(events[0]?.attribution, "session");
    assert.equal(events[0]?.stream, "stderr");
    assert.match(events[0]?.message ?? "", /ordinary flow/);
    assert.doesNotMatch(JSON.stringify(events), /canary-session-secret/);
    assert.equal(events[1]?.message, "final partial");
  } finally {
    output.destroy();
    restore();
  }
});

const sources = copySourceFixtures(`development-logs-${process.pid}`, ["task-worker"]);
after(sources.cleanup);
const config = defineFrameworkConfig({
  networks: [applicationVpc],
  defaults,
  http: [],
  webSocket: [],
  services: [],
  events: [],
  tasks: [
    {
      fixture: {
        directory: sources.directory("task-worker"),
        deploy: "both",
        cloud: { vpc: applicationVpc },
      },
    },
  ],
});

test("concurrent runs keep distinct parent traces and capture final tails before removing containers", async () => {
  const events: DevelopmentObservation[] = [];
  const commands: string[][] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  registerDevelopmentSecrets("task:fixture", ["canary-task-secret"]);
  const supervisor = new LocalTaskSupervisor({
    config,
    repositoryRoot: sources.root,
    projectName: "fixture-project",
    network: async () => "fixture-network",
    resolveEnvironment: async () => ({}),
    buildImage: async () => "built",
    runContainer: async () => "container-id",
    docker: async (...args) => {
      commands.push(args);
      if (args[0] === "wait") return "0";
      if (args[0] === "logs") return "done canary-task-secret\nfinal partial";
      if (args[0] === "rm") {
        assert.ok(
          events.some((event) => event.kind === "task.output_tail"),
          "tail evidence exists before container deletion",
        );
      }
      return "";
    },
  });
  try {
    const a = withDevelopmentObservation(
      { correlation: { traceId: "trace-a", requestId: "request-a" } },
      () => supervisor.submit("fixture", { n: 1 }),
    );
    const b = withDevelopmentObservation(
      { correlation: { traceId: "trace-b", requestId: "request-b" } },
      () => supervisor.submit("fixture", { n: 2 }),
    );
    await Promise.all([supervisor.wait(a.runId), supervisor.wait(b.runId)]);
    assert.notEqual(a.runId, b.runId);
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    const accepted = events.filter((event) => event.kind === "task.accepted");
    assert.equal(accepted.length, 2);
    assert.equal(
      accepted.find((event) => event.correlation.taskRunId === a.runId)
        ?.correlation.traceId,
      "trace-a",
    );
    assert.equal(
      accepted.find((event) => event.correlation.taskRunId === b.runId)
        ?.correlation.traceId,
      "trace-b",
    );
    assert.equal(
      events.filter((event) => event.kind === "task.output_tail").length,
      2,
    );
    assert.doesNotMatch(JSON.stringify(events), /canary-task-secret/);
    assert.equal(commands.filter((args) => args[0] === "rm").length, 2);
  } finally {
    await supervisor.shutdown();
    restore();
  }
});

test("a preparation failure is attributed to its accepted task without pretending a container started", async () => {
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  const supervisor = new LocalTaskSupervisor({
    config,
    repositoryRoot: sources.root,
    projectName: "fixture-project",
    network: async () => "fixture-network",
    resolveEnvironment: async () => ({}),
    buildImage: async () => {
      throw new Error("fixture build failed");
    },
    docker: async () => "",
  });
  try {
    const run = supervisor.submit("fixture", {});
    await supervisor.wait(run.runId);
    assert.equal(run.status, "failed");
    assert.ok(
      events.some(
        (event) =>
          event.kind === "task.preparation_failed" &&
          event.correlation.taskRunId === run.runId,
      ),
    );
    assert.ok(!events.some((event) => event.kind === "task.started"));
  } finally {
    await supervisor.shutdown();
    restore();
  }
});

test("task privacy survives asynchronous output and terminal tails without changing submitted input", async () => {
  const events: DevelopmentObservation[] = [], output = new PassThrough();
  const restore = setDevelopmentObservationSink(event => events.push(event));
  let injected: Readonly<Record<string,string>> = {}, args: readonly string[] = [];
  const supervisor = new LocalTaskSupervisor({ config, repositoryRoot: sources.root, projectName:"private-fixture",
    network: async()=>"fixture-network", resolveEnvironment:async()=>({}), buildImage:async()=>"built",
    runContainer:async (command,environment)=>{args=command;injected=environment;return "container-id";},
    followLogs:(_container,prefix,observation)=>{
      assert.equal(observation?.sensitive,true);
      const close=forwardLines(output,prefix,observation);
      output.write("TASK_AUTH_CONTEXT_CANARY\n");
      return async()=>close();
    },
    docker:async (...command)=>command[0]==="wait"?"0":command[0]==="logs"?"TASK_AUTH_CONTEXT_CANARY\nfinal output":"",
  });
  try {
    const run=withDevelopmentObservation({sensitive:true,correlation:{traceId:"private-task-trace"}},()=>supervisor.submit("fixture",{opaque:"TASK_AUTH_CONTEXT_CANARY"}));
    await supervisor.wait(run.runId);
    assert.equal(run.status,"succeeded");
    assert.ok(injected.FRAMEWORK_TASK_INPUT?.includes("TASK_AUTH_CONTEXT_CANARY"));
    assert.ok(args.includes("com.matts-aws-framework.private-output=1"));
    assert.doesNotMatch(JSON.stringify(events),/TASK_AUTH_CONTEXT_CANARY/);
    const finished=events.find(event=>event.kind==="task.finished");
    assert.equal(finished?.outcome,"succeeded");
    assert.equal(typeof finished?.durationMs,"number");
  } finally {await supervisor.shutdown();restore();output.destroy();}
});

test("same-session adopted task output retains its privacy label and omits output when legacy policy is unknown", async () => {
  const session="11111111-1111-4111-8111-111111111111";
  for(const policy of ["0","1",undefined]){
    const events:DevelopmentObservation[]=[];
    const restore=setDevelopmentObservationSink(event=>events.push(event));
    const supervisor=new LocalTaskSupervisor({config,repositoryRoot:sources.root,projectName:"private-adoption",runtimeSessionId:session,
      network:async()=>"fixture-network",resolveEnvironment:async()=>({}),
      docker:async (...command)=>command[0]==="ps"?`private-container\tprivate-run\tfixture\trunning\t${session}\t${policy??""}`:command[0]==="wait"?"0":command[0]==="logs"?"ADOPTED_OUTPUT_CANARY":"",
    });
    try {
      await supervisor.initialize();await supervisor.wait("private-run");
      assert.equal(supervisor.get("private-run")?.status,"succeeded");
      if(policy==="0") assert.match(JSON.stringify(events),/ADOPTED_OUTPUT_CANARY/);
      else assert.doesNotMatch(JSON.stringify(events),/ADOPTED_OUTPUT_CANARY/);
      assert.equal(events.some(event=>event.kind==="task.observation.privacy_unavailable"),policy===undefined);
    }finally{await supervisor.shutdown();restore();}
  }
});

test("adopted tasks require matching runtime-session provenance before recapturing prior output", async () => {
  const current = "11111111-1111-4111-8111-111111111111";
  for (const original of [
    undefined,
    "22222222-2222-4222-8222-222222222222",
    current,
  ]) {
    const events: DevelopmentObservation[] = [];
    const restore = setDevelopmentObservationSink((event) =>
      events.push(event),
    );
    const runId = `adopted-${original ?? "legacy"}`;
    const supervisor = new LocalTaskSupervisor({
      config,
      repositoryRoot: sources.root,
      projectName: "fixture-project",
      runtimeSessionId: current,
      network: async () => "fixture-network",
      resolveEnvironment: async () => ({}),
      docker: async (...args) => {
        if (args[0] === "ps")
          return `fixture-container\t${runId}\tfixture\trunning\t${original ?? ""}`;
        if (args[0] === "wait") return "0";
        if (args[0] === "logs")
          return "historical payload from original runtime";
        return "";
      },
    });
    try {
      await supervisor.initialize();
      await supervisor.wait(runId);
      assert.equal(
        supervisor.get(runId)?.status,
        "succeeded",
        "operational adoption still completes",
      );
      if (original === current) {
        assert.ok(events.some((event) => event.kind === "task.output_tail"));
        assert.ok(
          !events.some(
            (event) => event.kind === "task.observation.unavailable",
          ),
        );
      } else {
        assert.equal(
          events.filter(
            (event) => event.kind === "task.observation.unavailable",
          ).length,
          1,
        );
        assert.ok(
          !events.some(
            (event) =>
              event.kind === "task.output_tail" ||
              event.kind === "task.finished" ||
              event.kind === "task.adopted",
          ),
        );
        assert.doesNotMatch(JSON.stringify(events), /historical payload/);
      }
    } finally {
      await supervisor.shutdown();
      restore();
    }
  }
});

test("container output marked sensitive emits omission evidence without echoing auth payloads", () => {
  const events: DevelopmentObservation[] = [],
    output = new PassThrough();
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  try {
    const stop = forwardLines(output, "auth-container-fixture", {
      resourceId: "lambda:auth-container",
      correlation: { invocationId: "auth-container-run" },
      sensitive: true,
      stream: "stderr",
    });
    output.write("CONTAINER_AUTH_TEXT_CANARY\n");
    output.write('{"proof":"CONTAINER_AUTH_JSON_CANARY"}\n');
    stop();
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.message?.includes("omitted")));
    assert.ok(
      events.every(
        (event) => event.correlation.invocationId === "auth-container-run",
      ),
    );
    assert.ok(!JSON.stringify(events).includes("CONTAINER_AUTH_TEXT_CANARY"));
    assert.ok(!JSON.stringify(events).includes("CONTAINER_AUTH_JSON_CANARY"));
  } finally {
    output.destroy();
    restore();
  }
});

test("workflow Node and container lanes keep recognized auth payloads out of state and finish evidence", async () => {
  const root = sources.root,
    parent = path.join(root, ".cache");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(
    path.join(parent, "workflow-auth-observation-"),
  );
  const handler = path.join(
    directory,
    "compute/events/auth-node",
  );
  mkdirSync(handler, { recursive: true });
  writeFileSync(
    path.join(handler, "index.ts"),
    `import {writeSync} from "node:fs";
export async function lambdaHandler(event) { console.log(event.body); process.stderr.write(event.body + "\\n"); writeSync(1,event.body + "\\n"); return {statusCode:200,headers:event.headers,body:event.body}; }`,
  );
  const framework = defineFrameworkConfig({
    defaults,
    http: [],
    webSocket: [],
    services: [],
    events: [
      {
        "auth-node": { subnet: "none" },
        "auth-container": { packaging: "container" },
      },
    ],
    workflows: [
      {
        "auth-node-flow": workflow(
          ({ input }) => invokeLambda("auth-node", { payload: input }),
          { deploy: "both", timeoutSeconds: 10 },
        ),
      },
      {
        "auth-container-flow": workflow(
          ({ input }) => invokeLambda("auth-container", { payload: input }),
          { deploy: "both", timeoutSeconds: 10 },
        ),
      },
    ],
  });
  const events: DevelopmentObservation[] = [];
  const restore = setDevelopmentObservationSink((event) => events.push(event));
  const engine = new LocalWorkflowEngine({
    config: framework,
    repositoryRoot: directory,
    runnerUrl: "http://fixture.invalid",
    tasks: {
      submit() {
        throw new Error("task not used");
      },
      wait: async () => ({ runId: "unused" }),
      stop: async () => {},
    },
    resolveEnvironment: async () => ({
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    }),
    invokeContainerLambda: async (_id, input: any) => ({
      statusCode: 200,
      headers: input.headers,
      body: input.body,
    }),
  });
  try {
    const input = {
      rawPath: "/auth/exchange",
      headers: { "content-type": "application/json" },
      body: '{"proof":"WORKFLOW_AUTH_ECHO_CANARY"}',
      requestContext: { http: { path: "/auth/exchange", method: "POST" } },
    };
    const a = engine.start("auth-node-flow", input),
      b = engine.start("auth-container-flow", input);
    const publicInput = {
      ...input,
      rawPath: "/ordinary",
      body: '{"message":"visible ordinary workflow"}',
      requestContext: { http: { path: "/ordinary", method: "POST" } },
    };
    const ordinary = engine.start("auth-node-flow", publicInput);
    const deadline = Date.now() + 10000;
    while ([a, b, ordinary].some((run) => run.status === "running")) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await engine.shutdown();
    assert.equal(a.status, "succeeded");
    assert.equal(b.status, "succeeded");
    assert.equal((a.output as any).body, input.body);
    assert.equal((b.output as any).body, input.body);
    assert.ok(!JSON.stringify(events).includes("WORKFLOW_AUTH_ECHO_CANARY"));
    assert.ok(JSON.stringify(events).includes("visible ordinary workflow"));
    assert.ok(
      events.some(
        (event) =>
          event.kind === "workflow.finished" &&
          event.correlation.executionId === a.executionId,
      ),
    );
  } finally {
    await engine.shutdown();
    restore();
    rmSync(directory, { recursive: true, force: true });
  }
});

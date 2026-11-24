import { testProjectRoot } from "../../../../../scripts/test-project";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DevelopmentLogReader,
  developmentLogRepositoryKey,
} from "aws-studio/local/development-logs";
import type {
  DevelopmentLogControl,
  DevelopmentLogEvent,
} from "aws-studio/development-logs";

const execute = promisify(execFile);
/** Explicit opt-in: uses an already present image, isolated containers/network/cache, no AWS/provider calls. */
test(
  "Docker development evidence survives short-lived compute removal, service restart and runner restart",
  {
    skip: process.env.FRAMEWORK_DEVELOPMENT_LOG_DOCKER_TEST !== "1",
    timeout: 240_000,
  },
  async () => {
    const root = testProjectRoot;
    const releaseRoot = path.join(root, "node_modules/aws-studio");
    const containerReleaseRoot = "/workspace/node_modules/aws-studio";
    const directory = await mkdtemp(
      path.join(realpathSync(tmpdir()), "studio-log-docker-"),
    );
    const project = `studio-log-fixture-${randomUUID().slice(0, 8)}`;
    const runner = `matts-log-fixture-runner-${project}`,
      service = `matts-log-fixture-service-${project}`,
      postgres = `matts-log-fixture-postgres-${project}`;
    const network = `${project}-network`;
    const baseImage =
      process.env.FRAMEWORK_DEVELOPMENT_LOG_DOCKER_IMAGE ??
      "aws-studio-local-invocation-runner:latest";
    const docker = async (...args: string[]): Promise<string> => {
      const result = await execute("docker", args, {
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
    };
    const cache = path.join(directory, "cache"),
      controlDirectory = path.join(directory, "control"),
      fixtures = path.join(directory, "fixtures");
    const source = path.join(directory, "framework.config.ts");
    const control: DevelopmentLogControl = {
      version: 1,
      repositoryKey: developmentLogRepositoryKey(directory),
      composeProject: project,
      runtimeSessionId: randomUUID(),
      bindingId: "fixture-binding",
      declarationDigest: "fixture-declarations",
      startedAt: new Date().toISOString(),
      token: randomBytes(32).toString("hex"),
      endpoint: "http://local-invocation-runner:8090",
      binding: {},
      hostRepositoryRoot: directory,
      hostUid: process.getuid?.(),
      hostGid: process.getgid?.(),
    };
    const reader = new DevelopmentLogReader(cache);
    let runnerStarted = false,
      serviceStarted = false,
      postgresStarted = false,
      networkCreated = false;
    try {
      await docker("image", "inspect", baseImage); // Never pull an image implicitly.
      await docker("image", "inspect", "postgres:16"); // Explicit cached-image prerequisite; never pull.
      const imageArchitecture = await docker(
        "image",
        "inspect",
        "--format",
        "{{.Architecture}}",
        baseImage,
      );
      const architecture = imageArchitecture === "arm64" ? "arm64" : "x86_64";
      for (const folder of [
        cache,
        controlDirectory,
        ...[
          "starter",
          "node",
          "container",
          "task",
          "service",
          "agent",
          "tool",
        ].map((name) => path.join(fixtures, name)),
      ])
        await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(controlDirectory, "development-logs.json"),
        JSON.stringify(control),
        { mode: 0o600 },
      );
      await writeFile(
        source,
        `import { defineFrameworkConfig, startsWorkflow, runsTask, workflow, invokeLambda, invokeAgent } from "aws-studio/config";
import { defaults } from "./framework-config/defaults";
import { applicationVpc } from "./framework-config/networks/application";
export default defineFrameworkConfig({ networks:[applicationVpc], defaults, http:[{"/starter":{directory:"compute/.cache/test-fixtures/log-docker/starter",methods:["POST"],cloud:{bindings:[startsWorkflow("docker-node"),startsWorkflow("docker-agent-flow"),runsTask("docker-task")]}}}], webSocket:[],
events:[{
  "observed-node":{directory:"compute/.cache/test-fixtures/log-docker/node",localReplay:true},
  "observed-container":{directory:"compute/.cache/test-fixtures/log-docker/container",packaging:"container",localReplay:true,architecture:"${architecture}"}
}],
services:[{"/fixture/*":{id:"fixture",directory:"compute/.cache/test-fixtures/log-docker/service",methods:"*",port:5000,deploy:"local-only",cloud:{vpc:applicationVpc}}}],
tasks:[{"docker-task":{directory:"compute/.cache/test-fixtures/log-docker/task",deploy:"both",cloud:{vpc:applicationVpc,cpu:256,memoryMiB:512,architecture:"${architecture}"}}}],
gateways:[{"docker-gateway":{tools:["docker-tool"],deploy:"both"}}],
agents:[{"docker-agent":{directory:"compute/agents/log-docker-agent",gateways:["docker-gateway"],deploy:"both",auth:false}}],
tools:[{"docker-tool":{directory:"compute/.cache/test-fixtures/log-docker/tool",deploy:"both",auth:false}}],
workflows:[{"docker-node":workflow(({input})=>invokeLambda("observed-node",{payload:input}),{deploy:"both",timeoutSeconds:60}),"docker-agent-flow":workflow(({input})=>invokeAgent("docker-agent",input),{deploy:"both",timeoutSeconds:60})}]
});\n`,
      );
      await writeFile(
        path.join(fixtures, "node/index.ts"),
        'export async function lambdaHandler(event) { console.log("node invocation", event.label); process.stderr.write("node final " + event.label); return {label:event.label}; }\n',
      );
      await writeFile(
        path.join(fixtures, "starter/index.ts"),
        'import {startWorkflow} from "aws-studio/runtime/invocation";export async function lambdaHandler() { const child=await startWorkflow("docker-agent-flow",{n:3});return {childExecutionId:child.executionId}; }\n',
      );
      await writeFile(
        path.join(fixtures, "container/Dockerfile"),
        `FROM ${baseImage}\nCOPY server.js /log-fixture-server.js\nCMD ["node","/log-fixture-server.js"]\n`,
      );
      await writeFile(
        path.join(fixtures, "container/server.js"),
        `const http=require("node:http"); http.createServer(async(req,res)=>{ let body=""; for await(const c of req){body+=c;if(body.length>4096){res.writeHead(413);res.end();return;}} const event=JSON.parse(body||"{}"); console.log("container invocation",event.label); process.stderr.write("container final "+event.label); if(typeof event.body==="string"){console.log("container body stdout",event.body);process.stderr.write("\\ncontainer body stderr "+event.body);} res.writeHead(event.fail?500:200,{"content-type":"application/json"}); res.end(JSON.stringify(event.fail?{error:"fixture failure"}:{label:event.label,...(typeof event.body==="string"?{body:event.body}:{})})); }).listen(8080,"0.0.0.0");\n`,
      );
      await writeFile(
        path.join(fixtures, "task/Dockerfile"),
        `FROM ${baseImage}\nCMD ["node","-e","const x=JSON.parse(process.env.FRAMEWORK_TASK_INPUT||'{}');console.log('task invocation',x.label);if(x.body)console.log(x.body);process.stderr.write('task final '+x.label);process.exitCode=x.fail?1:0;if(x.wait)setInterval(()=>{},1000);"]\n`,
      );
      await writeFile(
        path.join(fixtures, "tool/contract.ts"),
        'import {z} from "zod"; export const contract={description:"Offline fixture tool.",request:z.object({n:z.number()}),response:z.object({n:z.number()})};\n',
      );
      await writeFile(
        path.join(fixtures, "tool/index.ts"),
        'import {tool} from "aws-studio/runtime/tools"; import {contract} from "./contract"; export const lambdaHandler=tool(contract,async input=>{console.log("tool invocation",input.n);process.stderr.write("tool final "+input.n);return {n:input.n*2};});\n',
      );
      await writeFile(
        path.join(fixtures, "agent/index.ts"),
        'import {z} from "zod";import {agent} from "aws-studio/runtime/agentcore";export const handler=agent("docker-agent",{request:z.object({n:z.number()}),response:z.object({n:z.number()})}).respond(async(input,{tools})=>tools.call("docker-tool",input));\n',
      );
      await docker(
        "network",
        "create",
        "--label",
        `com.matts-aws-framework.project=${project}`,
        network,
      );
      networkCreated = true;
      const mount = (from: string, to: string, writable = false) => [
        "--mount",
        `type=bind,source=${from},target=${to}${writable ? "" : ",readonly"}`,
      ];
      const mounts = [
        // Keep the image's Linux dependencies and use one release path for the launcher and handlers.
        ...["src", "scripts", "package.json", "local/invocation/src"].flatMap(
          (relative) => mount(path.join(releaseRoot, relative), `${containerReleaseRoot}/${relative}`),
        ),
        ...mount(path.join(root, "framework-config"), "/workspace/framework-config"),
        ...mount(source, "/workspace/framework.config.ts"),
        ...mount(fixtures, "/workspace/compute/.cache/test-fixtures/log-docker"),
        ...mount(
          path.join(fixtures, "agent"),
          "/workspace/compute/agents/log-docker-agent",
        ),
        ...mount(controlDirectory, "/workspace/.framework/local"),
      ];
      const provenance = (name: string) => [
        "--label",
        `com.docker.compose.project=${project}`,
        "--label",
        `com.docker.compose.service=${name}`,
        "--label",
        `com.docker.compose.project.working_dir=${directory}`,
        "--label",
        `com.docker.compose.project.config_files=${directory}/docker-compose.yml`,
      ];
      const env = [
        "--env",
        "FRAMEWORK_DEVELOPMENT_LOGS=1",
        "--env",
        "FRAMEWORK_DEVELOPMENT_LOG_CONTROL=/workspace/.framework/local/development-logs.json",
      ];
      await docker(
        "run",
        "--detach",
        "--pull=never",
        "--name",
        runner,
        "--network",
        network,
        "--network-alias",
        "local-invocation-runner",
        ...provenance("local-invocation-runner"),
        ...mounts,
        ...mount(cache, "/var/framework-development-logs", true),
        ...mount("/var/run/docker.sock", "/var/run/docker.sock", true),
        ...env,
        "--env",
        "FRAMEWORK_DEVELOPMENT_LOG_DIRECTORY=/var/framework-development-logs",
        "--publish",
        "127.0.0.1::8090",
        baseImage,
        "node",
        "--import",
        "tsx",
        "node_modules/aws-studio/local/invocation/src/index.ts",
      );
      runnerStarted = true;
      const published = await docker("port", runner, "8090/tcp");
      let endpoint = `http://${published.split(/\r?\n/)[0]}`;
      const wait = async <T>(
        check: () => Promise<T | undefined>,
        timeoutMs = 60_000,
      ): Promise<T> => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          try {
            const value = await check();
            if (value !== undefined) return value;
          } catch {
            /* Bootstrap/restart can temporarily refuse a local connection. */
          }
          if (
            (await docker(
              "inspect",
              "--format",
              "{{.State.Status}}",
              runner,
            )) === "exited"
          )
            throw new Error(
              `Disposable runner exited: ${await docker("logs", "--tail", "20", runner)}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(
          `Disposable Docker logging fixture timed out: ${await docker("logs", "--tail", "30", runner)}`,
        );
      };
      await wait(async () =>
        (await fetch(`${endpoint}/health`)).ok ? true : undefined,
      );
      await wait(
        async () => ((await reader.runs()).length ? true : undefined),
        15_000,
      );
      const proof = await lstat(path.join(cache, "writer.sqlite"));
      if (process.platform !== "win32") {
        assert.equal(
          proof.uid,
          process.getuid?.(),
          "VM-created private cache file remains owned by the host developer",
        );
        assert.equal(proof.mode & 0o777, 0o600);
      }
      const post = async (
        route: string,
        body: unknown,
        headers: Record<string, string> = {},
      ) => {
        const response = await fetch(`${endpoint}${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        const result = (await response.json()) as Record<string, unknown>;
        assert.ok(
          response.ok,
          `Fixture ${route} failed: ${response.status} ${JSON.stringify(result)}`,
        );
        return result;
      };
      const execution = await post("/workflows", {
        target: "workflow:docker-node",
        caller: "lambda:starter",
        input: { label: "node-a" },
      });
      await wait(async () => {
        const value = (await (
          await fetch(`${endpoint}/workflows/${execution.executionId}`)
        ).json()) as { status?: string };
        return value.status === "succeeded" ? true : undefined;
      });
      // HTTP-role starters and workflow event handlers are intentionally distinct:
      // the framework forbids an event handler from starting another workflow.
      const chainOutput = await docker(
        "exec",
        runner,
        "node",
        "--import",
        "tsx",
        "-e",
        `const {LocalLambdaExecutor}=require("aws-studio/local");const {initializeDevelopmentLogProducer}=require("aws-studio/local/development-logs/producer");const {withDevelopmentObservation}=require("aws-studio/development-logs");const config=require("./framework.config").default;(async()=>{const producer=initializeDevelopmentLogProducer({component:"fixture-starter",resourceId:"lambda:starter"});const executor=new LocalLambdaExecutor({config,repositoryRoot:process.cwd(),pool:null});try{const result=await withDevelopmentObservation({correlation:{traceId:"fixture-chain-trace",requestId:"fixture-chain-request"}},()=>executor.invoke("lambda:starter",{}));console.log("FIXTURE_CHAIN_RESULT="+JSON.stringify(result));}finally{await executor.close();await producer.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`,
      );
      const childExecutionId = (
        JSON.parse(
          /FIXTURE_CHAIN_RESULT=(\{.*\})/.exec(chainOutput)?.[1] ?? "{}",
        ) as { childExecutionId?: string }
      ).childExecutionId;
      assert.ok(childExecutionId);
      const child = await wait(async () => {
        const value = (await (
          await fetch(`${endpoint}/workflows/${childExecutionId}`)
        ).json()) as { status: string; error?: unknown };
        return value.status !== "running" ? value : undefined;
      });
      assert.equal(child.status, "succeeded", JSON.stringify(child.error));
      const chainEvidence = await wait(async () => {
        const page = await reader.entries({
          limit: 100,
          resourceIds: [
            "workflow:docker-agent-flow",
            "agent:docker-agent",
            "lambda:docker-tool",
          ],
        });
        return page.entries.some(
          (event) =>
            event.resource.id === "lambda:docker-tool" &&
            event.message?.includes("tool final"),
        )
          ? page.entries
          : undefined;
      });
      assert.ok(
        chainEvidence.some(
          (event) =>
            event.resource.id === "lambda:docker-tool" &&
            event.correlation.traceId === "fixture-chain-trace" &&
            event.correlation.requestId === "fixture-chain-request" &&
            event.correlation.executionId === childExecutionId &&
            event.correlation.toolCallId,
        ),
        "trace crosses Node runtime HTTP submission, workflow, agent session, Gateway and tool process",
      );
      const invocations = await Promise.all(
        ["image-a", "image-b"].map((label) =>
          post("/invoke", {
            target: "lambda:observed-container",
            event: { label },
          }),
        ),
      );
      assert.equal(invocations.length, 2);
      // Exercise the actual outer executor + private HTTP transport, not only
      // raw runner requests: both producers describe one logical invocation.
      await docker(
        "exec",
        runner,
        "node",
        "--import",
        "tsx",
        "-e",
        `const {LocalLambdaExecutor}=require("aws-studio/local");const {initializeDevelopmentLogProducer}=require("aws-studio/local/development-logs/producer");const {withDevelopmentObservation}=require("aws-studio/development-logs");const config=require("./framework.config").default;(async()=>{const producer=initializeDevelopmentLogProducer({component:"fixture-container-caller"});const executor=new LocalLambdaExecutor({config,repositoryRoot:process.cwd(),pool:null});try{await withDevelopmentObservation({correlation:{traceId:"fixture-container-transport",requestId:"fixture-container-request",spanId:"fixture-caller-span"}},()=>executor.invoke("lambda:observed-container",{label:"image-transport"}));}finally{await executor.close();await producer.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`,
      );
      const transported = await wait(async () => {
        const page = await reader.entries({
          resourceIds: ["lambda:observed-container"],
          limit: 100,
        });
        const entries = page.entries.filter(
          (event) =>
            event.correlation.traceId === "fixture-container-transport",
        );
        return entries.some(
          (event) => event.kind === "lambda.invocation.completed",
        ) && entries.some((event) => event.kind === "lambda.succeeded")
          ? entries
          : undefined;
      });
      assert.equal(
        new Set(transported.map((event) => event.correlation.invocationId))
          .size,
        1,
        "transport continues the outer executor's invocation identity",
      );
      assert.equal(
        new Set(transported.map((event) => event.correlation.spanId)).size,
        1,
        "transport does not invent another logical execution span",
      );
      assert.ok(
        transported.every(
          (event) => event.correlation.parentSpanId === "fixture-caller-span",
        ),
      );
      const sensitiveCanary = `opaque-login-fixture-${randomUUID()}`;
      const sensitiveReply = await post(
        "/invoke",
        {
          target: "lambda:observed-container",
          event: {
            version: "2.0",
            label: "image-sensitive",
            routeKey: "POST /login",
            rawPath: "/login",
            rawQueryString: "",
            headers: { "content-type": "text/plain" },
            requestContext: { http: { method: "POST", path: "/login" } },
            body: sensitiveCanary,
            isBase64Encoded: false,
          },
        },
        {
          "x-framework-development-observation": JSON.stringify({
            requestId: "fixture-sensitive-login",
            traceId: "fixture-sensitive-trace",
          }),
        },
      );
      assert.deepEqual(
        sensitiveReply.result,
        { label: "image-sensitive", body: sensitiveCanary },
        "capture must not alter the actual sensitive invocation result",
      );
      const sensitiveEvents = await wait(async () => {
        const page = await reader.entries({
          resourceIds: ["lambda:observed-container"],
          limit: 100,
        });
        const entries = page.entries.filter(
          (event) => event.correlation.requestId === "fixture-sensitive-login",
        );
        return entries.some((event) => event.kind === "lambda.succeeded") &&
          entries.some((event) => event.stream === "stdout") &&
          entries.some((event) => event.stream === "stderr")
          ? entries
          : undefined;
      });
      assert.ok(
        sensitiveEvents.some(
          (event) =>
            event.kind === "lambda.invocation.input" &&
            /omitted/i.test(JSON.stringify(event.details)),
        ),
      );
      assert.ok(
        sensitiveEvents.some(
          (event) =>
            event.kind === "lambda.succeeded" &&
            /omitted/i.test(JSON.stringify(event.details)),
        ),
      );
      assert.ok(
        sensitiveEvents
          .filter(
            (event) => event.stream === "stdout" || event.stream === "stderr",
          )
          .every((event) => /omitted/i.test(event.message ?? "")),
      );
      assert.ok(!JSON.stringify(sensitiveEvents).includes(sensitiveCanary));
      const assertPrivateCache = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          assert.equal(entry.isSymbolicLink(), false);
          const file = path.join(folder, entry.name);
          if (entry.isDirectory()) await assertPrivateCache(file);
          else {
            try {
              assert.ok(
                !(await readFile(file)).includes(Buffer.from(sensitiveCanary)),
                "opaque authentication body must be absent from persisted cache bytes",
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
        }
      };
      await assertPrivateCache(cache);
      const privateTask = await post("/tasks", {
        target: "task:docker-task",
        caller: "lambda:starter",
        input: {
          label: "task-sensitive",
          rawPath: "/login",
          headers: { "content-type": "text/plain" },
          body: sensitiveCanary,
          requestContext: { http: { method: "POST", path: "/login" } },
        },
      });
      const privateTaskRun = await wait(async () => {
        const value = (await (
          await fetch(`${endpoint}/tasks/${privateTask.runId}`)
        ).json()) as { status: string };
        return value.status !== "starting" && value.status !== "running"
          ? value
          : undefined;
      });
      assert.equal(privateTaskRun.status, "succeeded");
      const privateTaskEvidence = await wait(async () => {
        const page = await reader.entries({
          resourceIds: ["task:docker-task"],
          limit: 100,
        });
        const entries = page.entries.filter(
          (event) => event.correlation.taskRunId === privateTask.runId,
        );
        return entries.some((event) => event.kind === "task.finished")
          ? entries
          : undefined;
      });
      assert.doesNotMatch(
        JSON.stringify(privateTaskEvidence),
        new RegExp(sensitiveCanary),
      );
      assert.ok(
        privateTaskEvidence.some(
          (event) =>
            event.kind === "process.output" &&
            /omitted/.test(event.message ?? ""),
        ),
      );
      await assertPrivateCache(cache);
      const failedInvocation = await fetch(`${endpoint}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: "lambda:observed-container",
          event: { label: "image-failure", fail: true },
        }),
      });
      assert.equal(failedInvocation.status, 500);
      await failedInvocation.body?.cancel();
      const tasks = await Promise.all(
        ["task-a", "task-b"].map((label) =>
          post("/tasks", {
            target: "task:docker-task",
            caller: "lambda:starter",
            input: { label },
          }),
        ),
      );
      assert.notEqual(tasks[0]!.runId, tasks[1]!.runId);
      await Promise.all(
        tasks.map(async (run) => {
          const terminal = await wait(async () => {
            const value = (await (
              await fetch(`${endpoint}/tasks/${run.runId}`)
            ).json()) as { status?: string; error?: string };
            return ["succeeded", "failed", "stopped"].includes(
              value.status ?? "",
            )
              ? value
              : undefined;
          });
          assert.equal(terminal.status, "succeeded", terminal.error);
        }),
      );
      const failedTask = await post("/tasks", {
        target: "task:docker-task",
        caller: "lambda:starter",
        input: { label: "task-failure", fail: true },
      });
      const failedRun = await wait(async () => {
        const value = (await (
          await fetch(`${endpoint}/tasks/${failedTask.runId}`)
        ).json()) as { status: string; exitCode?: number };
        return value.status !== "starting" && value.status !== "running"
          ? value
          : undefined;
      });
      assert.equal(failedRun.status, "failed");
      assert.equal(failedRun.exitCode, 1);
      const cancelledTask = await post("/tasks", {
        target: "task:docker-task",
        caller: "lambda:starter",
        input: { label: "task-cancelled", wait: true },
      });
      await wait(async () => {
        const value = (await (
          await fetch(`${endpoint}/tasks/${cancelledTask.runId}`)
        ).json()) as { status: string };
        return value.status === "running" ? true : undefined;
      });
      await wait(async () =>
        (
          await (
            await fetch(`${endpoint}/tasks/${cancelledTask.runId}/logs`)
          ).text()
        ).includes("task invocation task-cancelled")
          ? true
          : undefined,
      );
      assert.equal(
        (await post(`/tasks/${cancelledTask.runId}/stop`, {})).status,
        "stopped",
      );
      await docker(
        "run",
        "--detach",
        "--pull=never",
        "--name",
        service,
        "--network",
        network,
        ...provenance("fixture"),
        ...mounts,
        ...env,
        baseImage,
        "node",
        "--import",
        "tsx",
        "node_modules/aws-studio/scripts/run-service.ts",
        "fixture",
        "--",
        "node",
        "-e",
        'console.log("service useful evidence");setInterval(()=>{},1000)',
      );
      serviceStarted = true;
      const evidence = async () =>
        (
          await reader.entries({
            limit: 200,
            resourceIds: [
              "lambda:observed-node",
              "lambda:observed-container",
              "task:docker-task",
              "service:fixture",
            ],
          })
        ).entries;
      const hasTaskTail = (
        data: readonly DevelopmentLogEvent[],
        runId: unknown,
      ) =>
        data.some(
          (event) =>
            event.resource.id === "task:docker-task" &&
            event.correlation.taskRunId === runId &&
            event.message?.startsWith("task final task-"),
        );
      let events = await wait<readonly DevelopmentLogEvent[]>(async () => {
        const data = await evidence();
        const taskTails = [...tasks, failedTask, cancelledTask].every((run) =>
          hasTaskTail(data, run.runId),
        );
        const imageTails = ["image-a", "image-b", "image-failure"].every(
          (label) => {
            const accepted = data.find(
              (event) =>
                event.resource.id === "lambda:observed-container" &&
                event.kind === "lambda.invocation.input" &&
                (event.details as { input?: { label?: string } })?.input
                  ?.label === label,
            );
            return (
              accepted &&
              data.some(
                (event) =>
                  event.correlation.invocationId ===
                    accepted.correlation.invocationId &&
                  event.message?.startsWith("container final image"),
              )
            );
          },
        );
        return taskTails &&
          imageTails &&
          data.some((event) => event.message?.startsWith("node final node")) &&
          data.some((event) =>
            event.message?.includes("service useful evidence"),
          )
          ? data
          : undefined;
      });
      assert.ok(
        events.some(
          (event) =>
            event.resource.id === "lambda:observed-container" &&
            event.kind === "lambda.failed",
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.correlation.taskRunId === failedTask.runId &&
            event.kind === "task.finished" &&
            (event.details as { exitCode?: number }).exitCode === 1,
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.correlation.taskRunId === cancelledTask.runId &&
            event.kind === "task.stop_requested",
        ),
      );
      for (const label of ["image-a", "image-b"])
        assert.ok(
          events.some(
            (event) =>
              event.resource.id === "lambda:observed-container" &&
              event.correlation.invocationId &&
              event.message?.includes(label),
          ),
        );
      for (const run of tasks)
        assert.ok(
          events.some(
            (event) =>
              event.resource.id === "task:docker-task" &&
              event.correlation.taskRunId === run.runId,
          ),
        );
      assert.equal(
        await docker(
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.matts-aws-framework.project=${project}`,
          "--filter",
          "label=com.matts-aws-framework.kind=task",
        ),
        "",
        "task containers were removed after final cache capture",
      );
      await docker(
        "run",
        "--detach",
        "--pull=never",
        "--name",
        postgres,
        "--network",
        "none",
        "--memory",
        "512m",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,noexec,nosuid,size=128m",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "--env",
        `FRAMEWORK_DEVELOPMENT_LOG_SESSION=${control.runtimeSessionId}`,
        ...provenance("postgres"),
        "postgres:16",
      );
      postgresStarted = true;
      assert.equal(
        await docker(
          "inspect",
          "--format",
          "{{.HostConfig.NetworkMode}}",
          postgres,
        ),
        "none",
      );
      const bindings = JSON.parse(
        await docker(
          "inspect",
          "--format",
          "{{json .HostConfig.PortBindings}}",
          postgres,
        ),
      ) as Record<string, unknown> | null;
      assert.ok(!bindings || Object.keys(bindings).length === 0);
      const pgMounts = JSON.parse(
        await docker("inspect", "--format", "{{json .Mounts}}", postgres),
      ) as { Type: string; Destination: string }[];
      const tmpfs = JSON.parse(
        await docker(
          "inspect",
          "--format",
          "{{json .HostConfig.Tmpfs}}",
          postgres,
        ),
      ) as Record<string, string>;
      assert.match(
        tmpfs["/var/lib/postgresql/data"] ?? "",
        /(?:^|,)size=128m(?:,|$)/,
      );
      assert.ok(pgMounts.every((mount) => mount.Type !== "volume"));
      const pgEvidence = async () =>
        (await reader.entries({ resourceIds: ["local:postgres"], limit: 100 }))
          .entries;
      await wait(async () =>
        (await pgEvidence()).some(
          (event) =>
            event.kind === "database.lifecycle" &&
            event.message === "database system is ready to accept connections",
        )
          ? true
          : undefined,
      );
      await docker("stop", "--time", "10", postgres);
      const pgEvents = await wait(async () => {
        const data = await pgEvidence();
        return data.some(
          (event) =>
            event.kind === "database.lifecycle" &&
            event.message === "database system is shut down",
        )
          ? data
          : undefined;
      });
      const pgSummaries = new Set([
        "starting PostgreSQL",
        "database system is ready to accept connections",
        "database system is shut down",
        "received fast shutdown request",
        "received smart shutdown request",
        "database system was interrupted",
      ]);
      assert.ok(
        pgEvents.some((event) => event.message === "starting PostgreSQL"),
      );
      assert.ok(
        pgEvents
          .filter((event) => event.kind === "database.lifecycle")
          .every((event) => pgSummaries.has(event.message ?? "")),
      );
      assert.ok(pgEvents.every((event) => event.kind !== "process.output"));
      assert.doesNotMatch(
        JSON.stringify(pgEvents),
        /(?:STATEMENT:|DETAIL:|CONTEXT:|SELECT\s|INSERT\s|UPDATE\s|DELETE\s)/i,
      );
      await docker("restart", service);
      await wait(async () => {
        const data = await evidence();
        return data.filter(
          (event) =>
            event.resource.id === "service:fixture" &&
            event.message?.includes("service useful evidence"),
        ).length >= 2
          ? true
          : undefined;
      });
      await docker("restart", runner);
      endpoint = `http://${(await docker("port", runner, "8090/tcp")).split(/\r?\n/)[0]}`;
      await wait(async () =>
        (await fetch(`${endpoint}/health`)).ok ? true : undefined,
      );
      await post("/invoke", {
        target: "lambda:observed-container",
        event: { label: "after-restart" },
      });
      events = await wait(async () => {
        const data = await evidence();
        return data.some((event) =>
          event.message?.includes("container final after-restart"),
        )
          ? data
          : undefined;
      });
      assert.ok(
        hasTaskTail(events, tasks[0]!.runId),
        "earlier evidence survived runner restart",
      );
      await docker("stop", "--time", "10", service);
      await docker("stop", "--time", "15", runner);
      assert.equal(
        (await reader.entries({ limit: 200 })).collection,
        "stopped",
      );
      console.log(
        `Disposable Docker evidence: ${events.length} compute records plus ${pgEvents.length} PostgreSQL lifecycle records; Node workflow, Lambda→workflow→agent→tool trace, concurrent container Lambdas/tasks, sensitive login input/result/output omitted with actual response preserved, failures/cancellation, isolated tmpfs PostgreSQL start/stop without queries, service restart, runner restart, stopped-cache read.`,
      );
    } finally {
      if (postgresStarted)
        await docker("rm", "--force", "--volumes", postgres).catch(() => {});
      if (serviceStarted)
        await docker("rm", "--force", service).catch(() => {});
      if (runnerStarted) await docker("rm", "--force", runner).catch(() => {});
      const owned = await docker(
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.matts-aws-framework.project=${project}`,
      ).catch(() => "");
      if (owned)
        await docker("rm", "--force", ...owned.split(/\s+/)).catch(() => {});
      const images = await docker(
        "image",
        "ls",
        "--quiet",
        "--filter",
        `label=com.matts-aws-framework.project=${project}`,
      ).catch(() => "");
      for (const image of new Set(images.split(/\s+/).filter(Boolean))) {
        const details = await docker(
          "image",
          "inspect",
          "--format",
          '{{.Id}}\t{{json .RepoTags}}\t{{index .Config.Labels "com.matts-aws-framework.project"}}',
          image,
        ).catch(() => "");
        const [identity, encodedTags, owner] = details.split("\t");
        if (!identity || owner !== project) continue;
        for (const tag of JSON.parse(encodedTags ?? "[]") ?? []) {
          const current = await docker(
            "image",
            "inspect",
            "--format",
            '{{.Id}}\t{{index .Config.Labels "com.matts-aws-framework.project"}}',
            tag,
          ).catch(() => "");
          if (current === `${identity}\t${project}`)
            await docker("image", "rm", tag).catch(() => {});
        }
        await docker("image", "rm", identity).catch(() => {});
      }
      if (networkCreated)
        await docker("network", "rm", network).catch(() => {});
      await rm(directory, { recursive: true, force: true });
      assert.equal(
        await docker(
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.matts-aws-framework.project=${project}`,
        ),
        "",
        "fixture left no owned containers",
      );
      assert.equal(
        await docker(
          "image",
          "ls",
          "--quiet",
          "--filter",
          `label=com.matts-aws-framework.project=${project}`,
        ),
        "",
        "fixture left no owned images",
      );
      assert.equal(
        await docker(
          "network",
          "ls",
          "--quiet",
          "--filter",
          `label=com.matts-aws-framework.project=${project}`,
        ),
        "",
        "fixture left no owned network",
      );
    }
  },
);

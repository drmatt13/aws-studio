import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ClientEnvironmentMappings } from "../cli/client-environment-mapping";
import {
  defineFrameworkConfig,
  invokeLambda,
  invokesAgent,
  runTask,
  runWorkflow,
  runsTask,
  startsWorkflow,
  type AgentTargetDefinition,
  type CdkResourceSpec,
  type FrameworkDefaults,
  type ResolvedBinding,
  type ResourceBinding,
  type ToolTargetDefinition,
} from "../src/config/index";

/** Checked by workspace typechecking; deliberately never executed. */
function authoringTypes(resource: CdkResourceSpec) {
  const agent = { environment: { MODEL_PROVIDER: "bedrock" } } satisfies AgentTargetDefinition;
  const tool = { runtime: "nodejs24", packaging: "zip", database: true } satisfies ToolTargetDefinition;
  const toolDefaults = { runtime: "nodejs22", packaging: "zip" } satisfies NonNullable<FrameworkDefaults["tools"]>;

  // @ts-expect-error Agents reach the database through tools, never directly.
  const databaseAgent = { database: true } satisfies AgentTargetDefinition;
  const spreadDatabaseAgent = { ...agent, database: true as const };
  // @ts-expect-error A database property is also refused on an existing value.
  const assignedAgent: AgentTargetDefinition = spreadDatabaseAgent;
  // @ts-expect-error Tool contracts require a Node runtime.
  const pythonTool = { runtime: "python3.13" } satisfies ToolTargetDefinition;
  // @ts-expect-error Tool contracts require ZIP packaging.
  const containerTool = { packaging: "container" } satisfies ToolTargetDefinition;
  // @ts-expect-error Tool-specific defaults cannot select a Python runtime.
  const pythonDefaults = { runtime: "python3.13" } satisfies NonNullable<FrameworkDefaults["tools"]>;
  // @ts-expect-error Tool-specific defaults cannot select container packaging.
  const containerDefaults = { packaging: "container" } satisfies NonNullable<FrameworkDefaults["tools"]>;
  // @ts-expect-error Database connection bindings are derived from database: true.
  const authoredConnection = { capability: "connectsTo", resource } satisfies ResourceBinding;
  const normalizedConnection = { capability: "connectsTo", resource } satisfies ResolvedBinding;
  const clientEnvironment = {
    VITE_API_URL: { kind: "output", stack: "HttpApiGatewayStack", outputs: ["HttpApiUrl"] },
    VITE_LOCAL_URL: { dev: { kind: "endpoint", protocol: "http", port: "LOCAL_API_PORT" }, prod: { kind: "empty" } },
  } as const satisfies ClientEnvironmentMappings;
  const invalidClientKind = {
    // @ts-expect-error Client recipes use the canonical discriminated binding kinds.
    VITE_API_URL: { kind: "stack-output", stack: "HttpApiGatewayStack", outputs: ["HttpApiUrl"] },
  } as const satisfies ClientEnvironmentMappings;
  const invalidClientOption = {
    // @ts-expect-error Output recipes do not accept endpoint options.
    VITE_API_URL: { kind: "output", stack: "HttpApiGatewayStack", outputs: ["HttpApiUrl"], protocol: "http" },
  } as const satisfies ClientEnvironmentMappings;

  // Fresh IDs remain valid before generated target suggestions have caught up.
  runsTask("new-task-before-generation");
  startsWorkflow("new-workflow-before-generation");
  invokesAgent("new-agent-before-generation");
  invokeLambda("new-event-before-generation");
  runTask("new-task-before-generation");
  runTask<{ result: string }>("new-task-before-generation", { completion: "callback", timeoutSeconds: 60 });
  runWorkflow("new-workflow-before-generation");

  return { agent, tool, toolDefaults, databaseAgent, assignedAgent, pythonTool, containerTool,
    pythonDefaults, containerDefaults, authoredConnection, normalizedConnection,
    clientEnvironment, invalidClientKind, invalidClientOption };
}
void authoringTypes;

test("unsafe agent and tool settings retain runtime validation", () => {
  const base = {
    defaults: {
      lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128,
        timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } },
    },
    http: {}, webSocket: {}, events: {}, services: {},
  };
  assert.throws(() => defineFrameworkConfig({
    ...base, agents: { example: { database: true } },
  } as never), /an AgentCore agent runs outside the VPC/);
  for (const unsupported of [{ runtime: "python3.13" }, { packaging: "container" }]) {
    assert.throws(() => defineFrameworkConfig({
      ...base, tools: { example: unsupported },
    } as never), /must be a Node zip Lambda/);
    assert.throws(() => defineFrameworkConfig({
      ...base, defaults: { ...base.defaults, tools: unsupported }, tools: { example: {} },
    } as never), /must be a Node zip Lambda/);
  }
});

test("unsafe authored database bindings retain the normalization rejection", () => {
  assert.throws(() => defineFrameworkConfig({
    defaults: {
      lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128,
        timeoutSeconds: 10, bundling: { minify: true, sourceMap: true } },
    },
    http: { "/worker": {
      directory: "compute/http/worker",
      methods: ["GET"],
      cloud: { bindings: [{ capability: "connectsTo", resource: {} }] },
    } },
    webSocket: {}, events: {}, services: {},
  } as never), /declares an unsupported cloud\.bindings\[0\]/);
});

test("invocation and workflow helpers suggest generated IDs without rejecting fresh IDs", () => {
  const file = path.join(__dirname, "__config-authoring-completions__.ts").replaceAll("\\", "/");
  const queries = [
    ['runsTask("")', "invocation-test-task"],
    ['startsWorkflow("")', "invocation-test-workflow"],
    ['invokesAgent("")', "example-agent"],
    ['invokeLambda("")', "invocation-test-step"],
    ['runTask("")', "invocation-test-task"],
    ['runTask("", { completion: "callback", timeoutSeconds: 60 })', "invocation-test-task"],
    ['runWorkflow("")', "invocation-test-workflow"],
  ] as const;
  const source = `import { runsTask, startsWorkflow, invokesAgent, invokeLambda, runTask, runWorkflow } from "../src/config/index";\n${queries.map(([query]) => `${query};`).join("\n")}`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [file],
    getScriptVersion: () => "0",
    getScriptSnapshot: (name) => {
      const contents = name === file ? source : ts.sys.readFile(name);
      return contents === undefined ? undefined : ts.ScriptSnapshot.fromString(contents);
    },
    getCurrentDirectory: () => path.resolve(__dirname, "../../.."),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (name) => name === file || ts.sys.fileExists(name),
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host);
  try {
    assert.deepEqual(service.getSemanticDiagnostics(file), []);
    for (const [query, expected] of queries) {
      const position = source.indexOf(query) + query.indexOf('"') + 1;
      const entries = service.getCompletionsAtPosition(file, position, {})?.entries ?? [];
      assert.ok(entries.some((entry) => entry.name === expected), `${query} suggests ${expected}`);
    }
  } finally {
    service.dispose();
  }
});

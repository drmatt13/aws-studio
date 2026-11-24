/** Projects authored workload declarations into checked, generated contracts. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { frameworkRepositoryRoot } from "../src/config/repository-root";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";
// Values come from `../src/config/conventions`, never `../src/config/index`: importing the
// framework module here would load the *previous* generation of
// `@repo/framework-generated/target-ids` and pin it in the module cache, so this run
// would describe a repository it has already stopped matching.
import {
  EVENT_SOURCE_ROOT,
  SERVICE_SOURCE_ROOT,
  TASK_SOURCE_ROOT,
  TOOL_SOURCE_ROOT,
} from "../src/config/conventions";
import { readSectionKeys } from "./config-source";
import { lambdaDirectoriesById } from "./source-inventory";
import { replaceGeneratedFile } from "./replace-generated-file";
import { generatedOutputs } from "./generated-paths";
import { vpcEndpointServicesModule } from "./vpc-endpoint-services";
import {
  agentCoreModule,
  agentRouteDeclarations,
  assertInvokedAgentsRespond,
  readAgentContract,
  readToolContract,
  type AgentContractFacts,
  type ToolContractFacts,
} from "./agentcore-contracts";
import {
  contractModuleName,
  contractNamespaceName,
  contractsBarrel,
  jsonSchemaContractModule,
  readContractModule,
  typescriptContractModule,
  type ContractExport,
  type ProjectedContract,
} from "./contract-modules";
import type { FrameworkConfig, NormalizedTarget } from "../src/config/index";

/**
 * The framework module reads the generated id union, and this script rewrites
 * it, so it is loaded only after that write — otherwise a newly added handler
 * directory would be missing from the config until a second run.
 */
type Framework = typeof import("../src/config/index");
type FrameworkSource = typeof import("../src/config/source");
let framework: Framework;
let source: FrameworkSource;

const checkOnly = process.argv.includes("--check");
const rootArgument = process.argv.indexOf("--repository-root");
const sourcePreview = process.argv.includes("--studio-source-preview");
if (sourcePreview && (rootArgument < 0 || checkOnly)) throw new Error("Studio source preview requires an explicit preview repository and cannot be used with --check.");
/** Only Studio's disposable source preview can retain unfinished runtime bindings. */
function inspect<T>(run: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  return sourcePreview ? framework.withDeferredInvocationAvailability(run) : run();
}
const repositoryRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1] ?? (() => { throw new Error("--repository-root needs a directory."); })()) : frameworkRepositoryRoot();
const configFile = path.join(repositoryRoot, "framework.config.ts");
const serviceRoot = path.join(repositoryRoot, SERVICE_SOURCE_ROOT);
const taskRoot = path.join(repositoryRoot, TASK_SOURCE_ROOT);
// Every projection is written into the application, never into this package: see ./generated-paths.
const {
  targetIds: targetIdsFile,
  vpcEndpointServices: vpcEndpointServicesFile,
  contracts: contractsFile,
  routes: routesFile,
  eventReplay: eventReplayFile,
  agentCore: agentCoreFile,
  contractModules: contractModuleDirectory,
} = generatedOutputs(repositoryRoot);

const staleFiles: string[] = [];

/**
 * What this run has changed on disk, in the order it changed it.
 *
 * `previous === undefined` means the file did not exist before this run, so
 * undoing it is a delete rather than a rewrite — the case the earlier rollback
 * skipped, which left a first-run id file behind after a failure. Removals are
 * journalled the same way, with the content they removed.
 *
 * This is not a crash-atomic multi-file transaction and does not claim to be.
 * Each destination is replaced atomically (written beside itself, then renamed
 * over), and a *handled* failure walks this journal back. A process killed
 * mid-flush leaves whatever it had already renamed; the journal is in memory,
 * and version control is what recovers that.
 */
const journal: Array<{ file: string; previous: string | undefined }> = [];
/** Writes held back until the config has fully validated. */
const staged: Array<{ file: string; contents: string }> = [];
/** Generated files this run no longer produces, removed with the staged writes. */
const stagedRemovals: string[] = [];

function currentContents(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/**
 * Replaces one destination, recording what was there first.
 *
 * The write lands on a sibling temporary file and is renamed over the
 * destination, so a reader never sees a half-written generated module and a
 * failure part-way through writing cannot truncate the previous one.
 */
function commit(file: string, contents: string): void {
  journal.push({ file, previous: currentContents(file) });
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.generating-${process.pid}`;
  writeFileSync(temporary, contents);
  replaceGeneratedFile(temporary, file);
  console.log(`Generated ${path.relative(repositoryRoot, file)}`);
}

function remove(file: string): void {
  journal.push({ file, previous: currentContents(file) });
  rmSync(file);
  console.log(`Removed ${path.relative(repositoryRoot, file)}`);
}

/**
 * Writes now, remembering the previous content. Used only for the id union,
 * which is derived from the filesystem alone and has to exist before the config
 * can be imported. Anything later that fails restores it.
 */
function writeGenerated(file: string, contents: string): void {
  if (currentContents(file) === contents) return;
  if (checkOnly) {
    staleFiles.push(path.relative(repositoryRoot, file));
    return;
  }
  commit(file, contents);
}

/** Holds a write until every check has passed, so invalid config writes nothing. */
function stageGenerated(file: string, contents: string): void {
  if (currentContents(file) === contents) return;
  if (checkOnly) {
    staleFiles.push(path.relative(repositoryRoot, file));
    return;
  }
  staged.push({ file, contents });
}

/**
 * Marks a generated file this run no longer produces.
 *
 * Contract modules are named after the target they project, so a removed,
 * renamed or newly type-only contract leaves a module behind. Left in place it
 * would keep exporting a shape nothing declares any more, and `--check` would
 * call the repository fresh.
 */
function removeGenerated(file: string): void {
  if (!existsSync(file)) return;
  if (checkOnly) {
    staleFiles.push(path.relative(repositoryRoot, file));
    return;
  }
  stagedRemovals.push(file);
}

function flushStaged(): void {
  for (const { file, contents } of staged) commit(file, contents);
  staged.length = 0;
  for (const file of stagedRemovals) remove(file);
  stagedRemovals.length = 0;
}

/**
 * Puts back everything this run changed, newest first.
 *
 * A file this run created is deleted rather than left holding output from a
 * generation that did not finish; a file it replaced gets its previous content
 * back. Only generator-owned destinations are ever in the journal, so this can
 * never reach an authored file.
 */
function restoreWrites(): void {
  for (const { file, previous } of journal.reverse()) {
    try {
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous);
    } catch (error) {
      // Says which file is now wrong rather than replacing the original
      // failure with this one.
      console.error(
        `Could not restore ${path.relative(repositoryRoot, file)} after a failed generation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  journal.length = 0;
  for (const { file } of staged) {
    rmSync(`${file}.generating-${process.pid}`, { force: true });
  }
  staged.length = 0;
  stagedRemovals.length = 0;
}

/** Directories under a conventional root, which is what autocompletion offers. */
function directoryIds(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function idsModule(
  lambdaDirectories: ReadonlyMap<string, string>,
  serviceIds: readonly string[],
  taskIds: readonly string[],
  workflowIds: readonly string[],
  agentIds: readonly string[],
): string {
  const list = (values: readonly string[]) =>
    values.map((value) => `  ${JSON.stringify(value)},`).join("\n");
  const directories = (root: string, ids: readonly string[]) =>
    ids.map((id) => `${root}/${id}`);
  const entries = (map: ReadonlyMap<string, string>) =>
    [...map]
      .map(([id, directory]) => `  ${JSON.stringify(id)}: ${JSON.stringify(directory)},`)
      .join("\n");

  const lambdaIds = [...lambdaDirectories.keys()];
  // Filed under the event grouping directory, which is the only signal the
  // filesystem carries about how a handler is invoked. Derived here rather than
  // from the config, because this file is written before the config is loaded.
  const eventIds = [...lambdaDirectories]
    .filter(([, directory]) => directory.startsWith(`${EVENT_SOURCE_ROOT}/`))
    .map(([id]) => id);
  const toolIds = [...lambdaDirectories]
    .filter(([, directory]) => directory.startsWith(`${TOOL_SOURCE_ROOT}/`))
    .map(([id]) => id);

  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    "/**",
    " * Where each Lambda under compute/http, websocket, events and tools lives. Handlers are",
    " * filed in grouping directories by the config section that claims them, so",
    " * a target id does not spell its own path and this map is how an event",
    " * Lambda finds the directory it never had to declare.",
    " */",
    "export const LAMBDA_SOURCE_DIRECTORY_BY_ID = {",
    entries(lambdaDirectories),
    "} as const;",
    "",
    "/** Every conventional compute Lambda directory, by target id. */",
    "export const LAMBDA_TARGET_IDS = [",
    list(lambdaIds),
    "] as const;",
    "",
    "export type LambdaTargetId = (typeof LAMBDA_TARGET_IDS)[number];",
    "",
    "/** Conventional Lambda source directories, offered as `directory` completions. */",
    "export const LAMBDA_SOURCE_DIRECTORIES = [",
    list([...lambdaDirectories.values()]),
    "] as const;",
    "",
    "export type LambdaSourceDirectory = (typeof LAMBDA_SOURCE_DIRECTORIES)[number];",
    "",
    "/**",
    " * Handler directories under `compute/events`: the",
    " * ids `eventFunction(scope, id)` completes, and the ones an `events` entry",
    " * can declare without spelling its own directory.",
    " */",
    "export const EVENT_LAMBDA_IDS = [",
    list(eventIds),
    "] as const;",
    "",
    "export type EventLambdaId = (typeof EVENT_LAMBDA_IDS)[number];",
    "",
    "/**",
    " * Handler directories under `compute/tools`: the",
    " * ids an agent's `tools` list completes, and the ones a `tools` entry can",
    " * declare without spelling its own directory.",
    " */",
    "export const TOOL_LAMBDA_IDS = [",
    list(toolIds),
    "] as const;",
    "",
    "export type ToolLambdaId = (typeof TOOL_LAMBDA_IDS)[number];",
    "",
    "/** Every directory directly under `compute/services`. */",
    "export const SERVICE_TARGET_IDS = [",
    list(serviceIds),
    "] as const;",
    "",
    "export type ServiceTargetId = (typeof SERVICE_TARGET_IDS)[number];",
    "",
    "/** Conventional service source directories, offered as `directory` completions. */",
    "export const SERVICE_SOURCE_DIRECTORIES = [",
    list(directories(SERVICE_SOURCE_ROOT, serviceIds)),
    "] as const;",
    "",
    "export type ServiceSourceDirectory = (typeof SERVICE_SOURCE_DIRECTORIES)[number];",
    "",
    "/** Every directory directly under `compute/tasks`. */",
    "export const TASK_TARGET_IDS = [",
    list(taskIds),
    "] as const;",
    "",
    "export type TaskTargetId = (typeof TASK_TARGET_IDS)[number];",
    "",
    "/** Conventional task source directories, offered as `directory` completions. */",
    "export const TASK_SOURCE_DIRECTORIES = [",
    list(directories(TASK_SOURCE_ROOT, taskIds)),
    "] as const;",
    "",
    "export type TaskSourceDirectory = (typeof TASK_SOURCE_DIRECTORIES)[number];",
    "",
    "/**",
    " * Workflow ids, read from the config's literal `workflows` keys rather than",
    " * from a directory scan: a workflow graph lives in the config and has no",
    " * source of its own. Read statically, before the config is imported, for the",
    " * same reason every other union here is - the config is typed against it.",
    " */",
    "export const WORKFLOW_TARGET_IDS = [",
    list(workflowIds),
    "] as const;",
    "",
    "export type WorkflowTargetId = (typeof WORKFLOW_TARGET_IDS)[number];",
    "",
    "/**",
    " * Agent ids, read from the config's literal `agents` keys for the same",
    " * reason as workflow ids: the config is typed against them.",
    " */",
    "export const AGENT_TARGET_IDS = [",
    list(agentIds),
    "] as const;",
    "",
    "export type AgentTargetId = (typeof AGENT_TARGET_IDS)[number];",
    "",
  ].join("\n");
}

/**
 * A declared directory with nothing behind it has nothing to build, and a
 * service is invisible to every tool the framework ships until `services` names
 * it, so both are errors. Every conventional Lambda directory must also be claimed
 * explicitly, including event functions.
 */
function assertConfigMatchesRepository(
  config: FrameworkConfig,
  targets: readonly NormalizedTarget[],
  serviceIds: readonly string[],
  taskIds: readonly string[],
  lambdaDirectories: ReadonlyMap<string, string>,
): Map<string, string> {
  const problems: string[] = [];
  const directories = new Map<string, string>();
  const declaredContainerDirectories = new Set<string>();
  const assertArtifacts = source.createTargetArtifactValidator(config);

  for (const target of targets) {
    // A workflow has no directory to resolve, artifact to demand or contract to
    // sweep for. It is validated as a graph by normalization instead.
    if (!framework.isSourcedTarget(target)) continue;
    try {
      const directory = source.resolveFrameworkDirectory(
        target.directory,
        target.origins[0] ?? target.reference,
        { repositoryRoot },
      );
      assertArtifacts(target, directory);
      directories.set(target.reference, directory);
      if (target.kind === "service" || target.kind === "task") {
        declaredContainerDirectories.add(target.directory);
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    source.assertLambdaInventory(config, lambdaDirectories.values());
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  for (const id of serviceIds) {
    if (!declaredContainerDirectories.has(`${SERVICE_SOURCE_ROOT}/${id}`)) {
      problems.push(
        `${SERVICE_SOURCE_ROOT}/${id} is not declared under services in framework.config.ts.`,
      );
    }
  }

  for (const id of taskIds) {
    if (!declaredContainerDirectories.has(`${TASK_SOURCE_ROOT}/${id}`)) {
      problems.push(
        `${TASK_SOURCE_ROOT}/${id} is not declared under tasks in framework.config.ts.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `framework.config.ts and the repository disagree:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return directories;
}

/**
 * The browser's view of the routing table: public paths, how each is
 * authenticated, and the WebSocket route keys.
 *
 * A projection rather than a second authored route map — `framework:check`
 * fails when it drifts. It exists so `@repo/api-contract` can stop importing
 * the whole root config at runtime: cloud environment declarations, secret
 * identifiers and build settings have no business in a frontend bundle, and a
 * browser has no use for them.
 */
function routesModule(config: FrameworkConfig): string {
  const { http: routes, webSocket } = framework.normalizeFrameworkConfig(config);
  const list = (name: string, values: readonly string[]) => [
    `export const ${name} = [`,
    ...values.map((value) => `  ${JSON.stringify(value)},`),
    "] as const;",
  ];
  const paths = (authenticated: boolean) =>
    routes
      .filter((route) => (route.auth === true) === authenticated)
      .map((route) => framework.getPublicRoutePath(route.path));
  // Explicit agent browser routes are served by AgentCore rather
  // than the HTTP API. Every declared route is listed whatever its deploy scope,
  // as routes are, so a deploy toggle never breaks the client's typecheck.
  const browserAgents = framework.getAgentBrowserRoutes(config);
  const agentRoutes = agentRouteDeclarations(browserAgents);

  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    ...(agentRoutes.imports.length > 0 ? [...agentRoutes.imports, ""] : []),
    "/**",
    " * Public route key -> the URL a client actually calls. A catch-all mount",
    ' * resolves to its public prefix, so `API_ROUTE["/example-service/*"]` is `"/example-service"`.',
    " */",
    "export const API_ROUTE = {",
    ...routes.map(
      (route) =>
        `  ${JSON.stringify(route.path)}: ${JSON.stringify(framework.getPublicRoutePath(route.path))},`,
    ),
    "} as const;",
    "",
    "/** Paths reachable without an access token. */",
    ...list("PUBLIC_API_ROUTES", paths(false)),
    "",
    "/** HTTP API paths that require the user's session. Agent paths are in AGENT_ROUTE. */",
    ...list("AUTHENTICATED_API_ROUTES", paths(true)),
    "",
    agentRoutes.body,
    "",
    "/** API Gateway WebSocket route keys. */",
    ...list(
      "WEBSOCKET_ROUTES",
      webSocket.map((binding) => binding.routeKey),
    ),
    "",
  ].join("\n");
}

/**
 * The event-replay manifest: replay id -> the Lambda target that captures it.
 *
 * Derived from `localReplay` on the config's event declarations, which is the
 * same derivation `getEventReplayManifest` performs — but performed once, here,
 * instead of at every cold start of a handler that wanted one lookup out of it.
 *
 * Emitted as plain literals with no import, so the module a Lambda reaches for
 * this has no edge into the framework's runtime facade at all.
 */
function eventReplayModule(config: FrameworkConfig): string {
  const manifest = framework.getEventReplayManifest(config) as Readonly<
    Record<string, string>
  >;
  return [
    "/* This file is generated by npm run framework:generate. Do not edit. */",
    "",
    "/**",
    " * Replay id -> the Lambda target that captures it, for every event handler",
    " * whose declaration sets `localReplay`.",
    " *",
    " * Used directly by `aws-studio/runtime/event-replay`: a capture check",
    " * is a lookup. A deployed handler does not load the root configuration or",
    " * its projection machinery to make it.",
    " */",
    "export const EVENT_REPLAY_MANIFEST = {",
    ...Object.entries(manifest)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, reference]) => `  ${JSON.stringify(id)}: ${JSON.stringify(reference)},`),
    "} as const;",
    "",
    "/** The replay ids `withLocalReplay` will capture under. */",
    "export type EventReplayId = keyof typeof EVENT_REPLAY_MANIFEST;",
    "",
  ].join("\n");
}

/**
 * Every target's payload contract, projected into one module each.
 *
 * Every target is swept, not just the routed ones, so a Lambda AWS invokes
 * directly can expose a payload contract too. A workflow has no source and so
 * no adjacent contract; it is skipped rather than reported.
 */
async function projectContracts(
  targets: readonly NormalizedTarget[],
  directories: ReadonlyMap<string, string>,
): Promise<readonly ProjectedContract[]> {
  const projected: ProjectedContract[] = [];
  const orderedTargets = [...targets].sort(
    (left: NormalizedTarget, right: NormalizedTarget) =>
      left.reference.localeCompare(right.reference),
  );

  for (const target of orderedTargets) {
    // A tool's contract is what a model reads, not a browser payload; it is
    // projected into the AgentCore module instead.
    if (target.role === "tool") continue;
    const directory = directories.get(target.reference);
    if (!directory) continue;
    const typescriptContract = path.join(directory, "contract.ts");
    const jsonContract = path.join(directory, "contract.schema.json");
    const moduleName = contractModuleName(target.reference);
    const file = path.join(contractModuleDirectory, `${moduleName}.ts`);
    const common = {
      reference: target.reference,
      file,
      specifier: `./contracts/${moduleName}.js`,
      namespace: contractNamespaceName(target.reference),
    };

    if (existsSync(typescriptContract)) {
      const relativeSource = path
        .relative(repositoryRoot, typescriptContract)
        .replaceAll("\\", "/");
      const sourceText = readFileSync(typescriptContract, "utf8");
      // Read as text and inspected as a syntax tree. A contract module is never
      // executed here: generation must not be a way to run handler code.
      const { exports } = readContractModule(sourceText, relativeSource);
      if (exports.length === 0) {
        throw new Error(
          `${relativeSource} exports nothing. A payload contract declares the request and response shapes its target accepts and returns.`,
        );
      }
      projected.push({
        ...common,
        kind: "typescript",
        exports,
        contents: typescriptContractModule({
          reference: target.reference,
          source: relativeSource,
          sourceText,
        }),
      });
      continue;
    }

    if (existsSync(jsonContract)) {
      const relativeSource = path.relative(repositoryRoot, jsonContract).replaceAll("\\", "/");
      const document = JSON.parse(readFileSync(jsonContract, "utf8")) as {
        request?: JSONSchema;
        response?: JSONSchema;
      };
      if (!document.request || !document.response) {
        throw new Error(`${jsonContract} must contain request and response JSON Schemas.`);
      }
      const typePrefix = target.id
        .split("-")
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("");
      // `compile` emits interfaces, so both halves of a JSON contract are types.
      const names: readonly ContractExport[] = [
        { name: `${typePrefix}Request`, isType: true },
        { name: `${typePrefix}Response`, isType: true },
      ];
      const declarations = [
        await compile(document.request, names[0].name, { bannerComment: "" }),
        await compile(document.response, names[1].name, { bannerComment: "" }),
      ];
      projected.push({
        ...common,
        kind: "json-schema",
        exports: names,
        contents: jsonSchemaContractModule({
          reference: target.reference,
          source: relativeSource,
          declarations,
        }),
      });
    }
  }

  return projected;
}

/**
 * Every tool's and agent's contract, evaluated and projected into
 * `packages/framework-generated/src/agentcore.ts`. See `./agentcore-contracts` for why a contract
 * is evaluated here and nowhere else.
 */
async function agentCoreProjection(
  config: FrameworkConfig,
  targets: readonly NormalizedTarget[],
  directories: ReadonlyMap<string, string>,
): Promise<string> {
  const tools: ToolContractFacts[] = [];
  const agents: AgentContractFacts[] = [];
  for (const target of targets) {
    if (target.role !== "tool" && target.role !== "agent") continue;
    const origin = target.origins[0] ?? target.reference;
    const file = path.join(directories.get(target.reference)!, "contract.ts");
    const relative = path.relative(repositoryRoot, file).replaceAll("\\", "/");
    if (!existsSync(file)) {
      throw new Error(
        `${origin} needs ${relative}: ${target.role === "tool" ? "export const contract = { description, request, response }" : "export const contract = { request, response } or { request, event }"}, as Zod schemas.`,
      );
    }
    // Containment first, as a syntax tree: only then is the module imported.
    readContractModule(readFileSync(file, "utf8"), relative);
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    if (target.role === "tool") {
      tools.push(readToolContract(module, { id: target.id, auth: config.tools?.[target.id]?.auth === true }));
    } else {
      const declaration = config.agents?.[target.id];
      agents.push(
        readAgentContract(module, {
          id: target.id,
          auth: declaration?.auth === true,
          tools: framework.getAgentTools(config, target.id).map(tool => tool.id),
          toolGateways: Object.fromEntries(framework.getAgentTools(config, target.id).map(tool => [tool.id, tool.gatewayId])),
        }),
      );
    }
  }
  assertInvokedAgentsRespond(
    [
      ...targets
        .filter((target) => target.kind === "workflow")
        .map((workflow) => ({
          origin: workflow.origins[0] ?? workflow.reference,
          targets: inspect(() => framework.getWorkflowStepTargets(config, workflow.id)),
          via: "workflow" as const,
        })),
      ...targets
        .filter((target) => target.kind !== "workflow")
        .map((target) => ({
          origin: target.origins[0] ?? target.reference,
          targets: framework.getAgentInvocationBindings(target.cloud.bindings).map((binding) => `agent:${binding.agent}`),
          via: "binding" as const,
        })),
    ],
    agents,
  );
  return agentCoreModule(tools, agents);
}

async function main(): Promise<void> {
  const lambdaDirectories = lambdaDirectoriesById(repositoryRoot);
  const serviceIds = directoryIds(serviceRoot);
  const taskIds = directoryIds(taskRoot);

  // Before the config is imported, because reading the source is what can name
  // the file a bad key came from. Importing first would surface the same
  // collision from `defineFrameworkConfig`, which knows only its position in
  // the array. It is also where config-authored workflow ids come from, since
  // no directory scan can find a target with no source.
  const sectionKeys = readSectionKeys(configFile, { repositoryRoot });
  const workflowIds = [...sectionKeys.workflows].sort();

  // Both id projections are written before the config is loaded:
  // framework.config.ts is typed against them, so a newly added handler
  // directory or workflow key has to be able to reach this file without a
  // hand-edit first, and in one run rather than two.
  writeGenerated(
    targetIdsFile,
    idsModule(lambdaDirectories, serviceIds, taskIds, workflowIds, [...sectionKeys.agents].sort()),
  );
  // VPC declarations are typed against it, so it is written here too.
  writeGenerated(vpcEndpointServicesFile, vpcEndpointServicesModule(repositoryRoot));

  // `--check` writes nothing, so on a repository whose id union has never been
  // generated there is nothing for the framework module to import. Say that
  // plainly here: the alternative is a bare "Cannot find module
  // '@repo/framework-generated/target-ids'" from the dynamic import below, which describes
  // the symptom and not the repair.
  if (checkOnly && (!existsSync(targetIdsFile) || !existsSync(vpcEndpointServicesFile))) {
    console.error(
      `Generated framework files are stale (${staleFiles.join(", ")}). Run npm run framework:generate.`,
    );
    process.exitCode = 1;
    return;
  }

  framework = await import("../src/config/index");
  source = await import("../src/config/source");
  const { default: config } = (sourcePreview
    ? inspect(() => createRequire(import.meta.url)(configFile))
    : await import(pathToFileURL(configFile).href)) as {
    default: FrameworkConfig;
  };

  // Ordinary generation uses the same strict validator as CDK and dev servers.
  // Studio previews retain availability errors on the reviewed graph instead.
  inspect(() => framework.validateFrameworkConfig(config));
  // No authored config changes after validation; share this projection across
  // the remaining stages instead of rebuilding its target graph each time.
  const targets = inspect(() => framework.getFrameworkTargets(config));
  const directories = inspect(() => assertConfigMatchesRepository(
    config,
    targets,
    serviceIds,
    taskIds,
    lambdaDirectories,
  ));

  stageGenerated(routesFile, inspect(() => routesModule(config)));
  stageGenerated(eventReplayFile, inspect(() => eventReplayModule(config)));
  stageGenerated(agentCoreFile, await agentCoreProjection(config, targets, directories));

  const projected = await projectContracts(targets, directories);
  for (const contract of projected) stageGenerated(contract.file, contract.contents);
  stageGenerated(contractsFile, contractsBarrel(projected));
  // The contract directory is generated output in full, so a module this run
  // did not produce belonged to a contract that was removed, renamed, or moved
  // to a target that no longer exists.
  const produced = new Set(projected.map((contract) => contract.file));
  if (existsSync(contractModuleDirectory)) {
    for (const entry of readdirSync(contractModuleDirectory)) {
      const file = path.join(contractModuleDirectory, entry);
      if (!produced.has(file)) removeGenerated(file);
    }
  }
  // cdk-app/.env.*.template are authored templates. Generation never writes them,
  // so a declared input or secret is added to them by hand; check-local.ts
  // refuses a required one they leave out.
  const { serviceEnvironmentExample } = await import("./env-examples");
  for (const target of targets) {
    if (target.kind !== "service") continue;
    const directory = directories.get(target.reference)!;
    stageGenerated(path.join(directory, ".env.example"), inspect(() => serviceEnvironmentExample(
      config, target, source.resolveServicePort(config, target.id, { repositoryRoot }),
    )));
  }
  // Tasks read authored inputs from cdk-app/.env.<mode> and receive their values from
  // CDK or from local startup. Deliberately no per-task
  // authored .env file: a task is launched, not run by a developer, and a second
  // authored input file would be one more place its environment could disagree.

  // Local service containers. docker-compose.yml is read, never written: a
  // service declared there is the developer's, and the rest are generated from
  // its x-framework-service. Checked here rather than at `docker compose up`,
  // so a service with no container, or one nothing can reach, stops generation.
  const compose = await import("./compose-services");
  const composeFile = path.join(repositoryRoot, compose.COMPOSE_FILE);
  if (existsSync(composeFile)) {
    const authored = compose.readProjectCompose(repositoryRoot, sourcePreview ? fileURLToPath(new URL("../dev/compose.yml", import.meta.url)) : undefined);
    const services = inspect(() => compose.composeServicesFile(config, authored, { repositoryRoot }));
    const generatedFile = path.join(repositoryRoot, compose.GENERATED_COMPOSE_FILE);
    if (services !== undefined) stageGenerated(generatedFile, services);
    else if (compose.isGeneratedCompose(currentContents(generatedFile))) removeGenerated(generatedFile);
    inspect(() => compose.assertLocalServiceContainers(config, authored, services, { repositoryRoot }));
  }
  flushStaged();

  if (staleFiles.length > 0) {
    console.error(
      `Generated framework files are stale (${staleFiles.join(", ")}). Run npm run framework:generate.`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  restoreWrites();
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import { renderRolePolicies } from "../../database/client-access";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CheckEvidence } from "./graphql-chain";
import { compileDatabaseSource, emittedContractEvidence } from "./database-contract-source";
import { accessDirectives, readClientAccess, renderClientAccess, type AccessModules } from "../../database/client-access";
import { accessGraphArtifactSemantics, renderAccessGraph } from "../../database/access-graph-artifact";
import { CLIENT_ACCESS_OUTPUT, ACCESS_GRAPH_OUTPUT } from "./runtime-artifacts";

export const VERIFICATION_PHASES = ["database", "api", "api-types", "client", "consumers", "integration"] as const;
export type VerificationPhase = typeof VERIFICATION_PHASES[number];
export interface PhaseEvidence {
  evidence: CheckEvidence;
  contract?: { storageHash: string; executionHash: string | null } | null;
}
const schemaDirectory = "compute/http/graphql-api/schema";
const failed = (code: string, message: string, file?: string): CheckEvidence => ({ status: "failed", diagnostics: [{ code, message: message.slice(0, 4000), ...(file ? { file } : {}) }] });
export const unavailableVerification = (message: string): CheckEvidence => ({ status: "unavailable", diagnostics: [{ code: "VALIDATION_UNAVAILABLE", message }] });
/** A known prerequisite failure blocks work; missing evidence remains unavailable. */
export function skippedVerification(predecessor: CheckEvidence, message: string): CheckEvidence {
  return predecessor.status === "failed" || predecessor.status === "blocked"
    ? { status: "blocked", diagnostics: [{ code: "UPSTREAM_VALIDATION_REQUIRED", message }] }
    : unavailableVerification(message);
}

/** Keep unavailable evidence visible even when another required check failed. */
export function combineVerification(checks: readonly CheckEvidence[]): CheckEvidence {
  if (!checks.length) return unavailableVerification("No required independent checks were selected. Restore the validator and check again.");
  const status = (["unavailable", "failed", "blocked"] as const).find(status => checks.some(check => check.status === status));
  return status ? { status, diagnostics: checks.flatMap(check => check.status === "passed" ? [] : check.diagnostics) } : { status: "passed" };
}

function regularFiles(directory: string, suffix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? regularFiles(path.join(directory, entry.name), suffix)
    : entry.isFile() && entry.name.endsWith(suffix) ? [path.join(directory, entry.name)] : []).sort();
}

/** Access Graph integrations carry additional behavioral and type contracts. */
function accessVerificationRequired(root: string): boolean {
  if (existsSync(path.join(root, "packages/database/prisma/access"))
    || existsSync(path.join(root, "compute/http/graphql-api/lib/table-access.ts"))) return true;
  const source = path.join(root, "packages/database/prisma/contract.prisma");
  if (!existsSync(source)) return false;
  const text = readFileSync(source, "utf8");
  // Invalid directives still require the checks; removing a required test must
  // never turn an opted-in application back into a legacy application.
  return accessDirectives(text).length > 0 || readClientAccess(text).problems.length > 0;
}

/**
 * Test discovery is fixed by the host rather than npm scripts or CLI input.
 * Beside each feature's test it names the schema-wide suites no feature file
 * pairs with: registration (schema-files), the authorization inventory with its
 * role sweep (authorization), and the field access settings from
 * contract.prisma against every table-backed type (client-access).
 */
export function requiredNodeTests(root: string, integration = false): string[] {
  const directory = path.join(root, schemaDirectory);
  if (integration) return [path.join(directory, "limits.test.ts")];
  const infrastructure = new Set(["index.ts", "builder.ts", "errors.ts"]);
  const features = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !infrastructure.has(entry.name));
  if (!features.length) throw new Error("No feature schemas were found; API proof requires executable feature tests.");
  const repositories = path.join(root, "packages/database/test");
  const repositoryTests = (existsSync(repositories) ? readdirSync(repositories) : [])
    .filter(name => name.endsWith(".test.ts") && !name.endsWith("-live.test.ts"))
    .map(name => path.join(repositories, name));
  const accessTests = accessVerificationRequired(root) ? ["authorization.test.ts", "client-access.test.ts"].map(name => path.join(directory, name)) : [];
  return [path.join(directory, "schema-files.test.ts"), ...accessTests, ...features.map(entry => path.join(directory, entry.name.replace(/\.ts$/, ".test.ts"))), ...repositoryTests].sort();
}

/**
 * The API typecheck's fixed roots: the executable schema, its context, the
 * database package, and the type fixture proving resolvers cannot reach
 * privileged user methods (its `@ts-expect-error` lines fail when one becomes
 * reachable).
 */
export function apiTypecheckRoots(root: string): string[] {
  const api = path.join(root, "compute/http/graphql-api");
  return [
    path.join(api, "schema/index.ts"),
    path.join(api, "graphql-context.ts"),
    path.join(root, "packages/database/src/index.ts"),
    ...(accessVerificationRequired(root) ? [path.join(api, "type-fixtures/client-database.ts"), path.join(api, "type-fixtures/table-access.ts")] : []),
  ];
}

/** Only the trusted reporter's final structured test events can establish success. */
export function nodeTestEvidence(summary: unknown): CheckEvidence {
  const value = summary as { success?: unknown; executedTests?: unknown; counts?: Record<string, unknown> } | null;
  const counts = value?.counts;
  if (!counts || !Number.isSafeInteger(value?.executedTests) || !["tests", "passed", "failed", "skipped", "todo", "cancelled"].every(name => Number.isSafeInteger(counts[name]) && Number(counts[name]) >= 0)) return unavailableVerification("The test runner returned no complete test counts. Check the installed Node test runner and retry.");
  if (Number(value?.executedTests) < 1 || Number(counts.tests) - Number(counts.skipped) - Number(counts.todo) - Number(counts.cancelled) < 1) return failed("NO_EXECUTED_TESTS", "A required test file executed no behavioral tests. Add or enable its behavioral tests, then check again.");
  if (counts.skipped !== 0 || counts.todo !== 0 || counts.cancelled !== 0) return failed("INCOMPLETE_TEST_EXECUTION", "A required behavioral suite skipped, deferred or cancelled tests. Execute every required case before renewing proof.");
  if (value?.success === true && counts.failed === 0 && (value.executedTests !== counts.tests || counts.passed !== counts.tests)) return unavailableVerification("The required test report has inconsistent execution counts. A partial report cannot establish proof; run the complete suite again.");
  return value?.success === true && counts.failed === 0 && counts.cancelled === 0 ? { status: "passed" } : failed("VALIDATION_FAILED", `Behavioral tests failed (${counts.failed} failed, ${counts.cancelled} cancelled). Run the named suite and resolve its failures.`);
}

/** Generated declarations carry the same semantic hashes as their JSON sibling. */
export function databaseDeclarationEvidence(root: string, source: string, expected: { storageHash: string; executionHash: string | null; profileHash: string }): CheckEvidence {
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const syntax = ts.createSourceFile("contract.d.ts", source, ts.ScriptTarget.Latest, true);
  const hashes = new Map<string, string>();
  for (const declaration of syntax.statements) if (ts.isTypeAliasDeclaration(declaration) && ts.isTypeReferenceNode(declaration.type)) {
    const argument = declaration.type.typeArguments?.[0];
    if (argument && ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) hashes.set(declaration.name.text, argument.literal.text);
  }
  return hashes.get("StorageHash") === expected.storageHash && (expected.executionHash === null ? !hashes.has("ExecutionHash") : hashes.get("ExecutionHash") === expected.executionHash) && hashes.get("ProfileHash") === expected.profileHash
    ? { status: "passed" } : failed("GENERATED_DATABASE_TYPES_STALE", "Generated database declarations do not match the compiled contract's storage, execution, or profile identity. Generate database artifacts separately, then check again.", "packages/database/src/generated/contract.d.ts");
}

/**
 * The generated access module holds exactly the field settings and row rules in
 * saved contract.prisma, and the Access Graph artifact is the one saved
 * contract.prisma and the access policy module produce. The artifact carries
 * the compiled policy module with a digest of its source: a module edited since
 * generation is stale here, without running it; the required API suite
 * (schema/client-access.test.ts) compiles the module itself and compares the
 * fingerprint.
 */
export function clientAccessEvidence(root: string, source: string): CheckEvidence {
  const file = path.join(root, CLIENT_ACCESS_OUTPUT);
  if (!existsSync(file)) return unavailableVerification("Generated access settings are missing. Generate database artifacts separately, then check again.");
  const graphFile = path.join(root, ACCESS_GRAPH_OUTPUT);
  if (!existsSync(graphFile)) return unavailableVerification("The generated Access Graph artifact is missing. Generate database artifacts separately, then check again.");
  let modules: AccessModules | undefined;
  let graphSemantics: string;
  try {
    const graphText = readFileSync(graphFile, "utf8");
    modules = (JSON.parse(graphText) as { modules?: AccessModules | null }).modules ?? undefined;
    graphSemantics = accessGraphArtifactSemantics(graphText);
  } catch { return failed("GENERATED_ACCESS_GRAPH_STALE", "The generated Access Graph artifact is unreadable. Generate database artifacts, then check again.", ACCESS_GRAPH_OUTPUT); }
  const { settings, rows, policy, problems, graph } = readClientAccess(source, modules);
  if (problems.length) return failed("INVALID_ACCESS_POLICY", problems.map((problem) => `Line ${problem.line}: ${problem.message}`).join("\n"), "packages/database/prisma/contract.prisma");
  const roles = "packages/api-contract/src/generated/access-policy.ts";
  if (Object.values(policy.enums).some((value) => Object.keys(value.grants).length || value.assignable.length !== value.values.length) && (!existsSync(path.join(root, roles)) || readFileSync(path.join(root, roles), "utf8") !== renderRolePolicies(policy))) return failed("GENERATED_ROLE_POLICIES_STALE", "Generated enum policies do not match saved contract.prisma. Generate database artifacts, then check again.", roles);
  if (graphSemantics !== accessGraphArtifactSemantics(renderAccessGraph(graph, modules, path.join(root, "packages/database")))) return failed("GENERATED_ACCESS_GRAPH_STALE", "The Access Graph artifact does not match saved contract.prisma and prisma/access. Generate database artifacts, then check again.", ACCESS_GRAPH_OUTPUT);
  return readFileSync(file, "utf8") === renderClientAccess(settings, rows, policy) ? { status: "passed" }
    : failed("GENERATED_CLIENT_ACCESS_STALE", "Generated access settings do not match the @access comments in saved contract.prisma. Generate database artifacts separately, then check again.", CLIENT_ACCESS_OUTPUT);
}

function runNodeTests(root: string, reporter: string, integration: boolean, scratch: string): CheckEvidence {
  const files = requiredNodeTests(root, integration);
  for (const file of files) if (!existsSync(file)) return failed("REQUIRED_TEST_MISSING", "A required executable test is missing. Restore or implement it before recording review.", path.relative(root, file).split(path.sep).join("/"));
  const localRequire = createRequire(path.join(root, "package.json"));
  const loader = pathToFileURL(localRequire.resolve("tsx")).href;
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const env: NodeJS.ProcessEnv = { ...process.env, TSX_DISABLE_CACHE: "1", STUDIO_CONTRACT_TEST_ROOT: scratch }; delete env.NODE_TEST_CONTEXT;
    // Ordinary entry startup applies the native realpath preload before importing
    // the pinned reporter. CLI --test-reporter loads before --import on Windows.
    // Relative selectors also avoid drive-root traversal during test discovery.
    const result = spawnSync(process.execPath, ["--import", loader, reporter, relative], { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024, env });
    if (result.error || result.signal) return unavailableVerification(`The required test ${relative} did not finish. Run it separately and check again.`);
    let summary: unknown;
    try { summary = JSON.parse(result.stdout); } catch { return unavailableVerification(`The required test ${relative} returned an incomplete test report. Run it separately and check again.`); }
    const evidence = nodeTestEvidence(summary);
    if (evidence.status !== "passed") return { ...evidence, diagnostics: evidence.diagnostics.map(item => ({ ...item, file: relative })) };
    if (result.status !== 0) return failed("VALIDATION_FAILED", "The required test process failed despite its test report. Resolve the process failure and check again.", relative);
  }
  return { status: "passed" };
}

async function checkTypes(root: string, client: boolean): Promise<CheckEvidence> {
  const ts = createRequire(path.join(root, "package.json"))("typescript") as typeof import("typescript");
  const directory = path.join(root, client ? "client-app" : "compute/http/graphql-api");
  if (client && !existsSync(path.join(root, "client-app/src/routeTree.gen.ts"))) return unavailableVerification("The generated client route tree is missing. Build client-app separately, then check again; inspection does not generate routes.");
  const configPath = path.join(directory, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return failed("TYPECHECK_CONFIGURATION", "The required TypeScript configuration could not be read. Resolve it and check again.");
  const raw = client ? config.config : { ...config.config, files: ["schema/index.ts", "graphql-context.ts"], include: [], exclude: [] };
  // Type reference directives resolve from the project's config file. Supplying only
  // the directory can select the verifier process's hoisted @types instead of the workspace's.
  const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, directory, { noEmit: true, incremental: false, noCheck: false }, configPath);
  // Resolve explicit API roots ourselves; no emitted files or authored build plugins run.
  const roots = client ? [...new Set([...parsed.fileNames, ...regularFiles(path.join(directory, "src"), ".ts"), ...regularFiles(path.join(directory, "src"), ".tsx")])].sort()
    : apiTypecheckRoots(root);
  if (!roots.length || roots.some(file => !existsSync(file))) return unavailableVerification("Required source files for the typecheck are missing. Restore them and check again.");
  const program = ts.createProgram(roots, { ...parsed.options, noEmit: true, incremental: false, noCheck: false });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].filter(item => item.category === ts.DiagnosticCategory.Error);
  if (!diagnostics.length) return { status: "passed" };
  return { status: "failed", diagnostics: diagnostics.slice(0, 50).map(item => ({ code: "TYPECHECK_FAILED", message: ts.flattenDiagnosticMessageText(item.messageText, " ").slice(0, 4000), ...(item.file ? { file: path.relative(root, item.file.fileName).split(path.sep).join("/"), ...(item.start !== undefined ? { line: item.file.getLineAndCharacterOfPosition(item.start).line + 1 } : {}) } : {}) })) };
}

async function clientTests(root: string, scratch: string): Promise<CheckEvidence> {
  const api = path.join(root, "client-app/src/api");
  const operations = regularFiles(api, "operations.ts");
  if (!operations.length) return failed("REQUIRED_TEST_MISSING", "No authored operation modules were found; client proof requires operation behavioral tests.");
  const files = [...operations.map(file => file.replace(/\.ts$/, ".test.ts")), path.join(api, "graphql/client.test.ts")];
  for (const file of files) if (!existsSync(file)) return failed("REQUIRED_TEST_MISSING", "A required operation or transport test is missing. Add it before recording client review.", path.relative(root, file).split(path.sep).join("/"));
  const localRequire = createRequire(path.join(root, "client-app/package.json"));
  const vitest = await import(pathToFileURL(localRequire.resolve("vitest/node")).href) as typeof import("vitest/node");
  const previousExitCode = process.exitCode;
  const clientRoot = path.join(root, "client-app");
  // Vitest selectors are glob paths, not native Windows filesystem paths.
  const selectors = files.map(file => path.relative(clientRoot, file).split(path.sep).join("/"));
  if (selectors.some(file => file.startsWith("../") || path.isAbsolute(file))) return unavailableVerification("A required client test escaped the client source root.");
  // Use the mode overload shared by the client's Vitest 4 and the root toolchain.
  // Vitest's warning preload otherwise runs before the Windows native-realpath
  // import, which cannot traverse an ungranted drive root. Load that exact
  // installed module as an ordered import while retaining Vitest's fork worker.
  const warningPreload = path.join(path.dirname(localRequire.resolve("vitest/package.json")), "suppress-warnings.cjs");
  const isWarningPreload = (argument: string | undefined): boolean => typeof argument === "string" && path.resolve(argument) === warningPreload;
  const pool: import("vitest/node").PoolRunnerInitializer | undefined = process.platform === "win32" ? {
    name: "studio-forks",
    createPoolWorker(options) {
      const execArgv = options.execArgv.flatMap((argument, index, args) => {
        if (argument === "--require" && isWarningPreload(args[index + 1])) return ["--import", pathToFileURL(warningPreload).href];
        if (isWarningPreload(argument) && args[index - 1] === "--require") return [];
        return [argument];
      });
      return new vitest.ForksPoolWorker({ ...options, execArgv });
    },
  } : undefined;
  const context = await vitest.startVitest("test", selectors, { root: clientRoot, config: false, ...(pool ? { pool } : {}), run: true, watch: false, reporters: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, allowOnly: false, update: false, include: selectors, execArgv: ["--no-experimental-webstorage"], cache: false }, { envDir: scratch, cacheDir: path.join(scratch, "vite"), resolve: { alias: { "#": path.join(root, "client-app/src") } } });
  try {
    const results = context.state.getFiles();
    if (context.state.getUnhandledErrors().length) return failed("VALIDATION_FAILED", "Client tests reported an unhandled error. Run the operation/transport tests separately and resolve it.");
    if (results.length !== files.length) return failed("REQUIRED_TEST_MISSING", `The client runner executed ${results.length} of ${files.length} required operation and transport test files. Check test discovery and rerun the suites.`);
    const remaining = new Set(files.map(file => path.resolve(file)));
    if (results.some(file => !remaining.delete(path.resolve(file.filepath))) || remaining.size) return failed("REQUIRED_TEST_MISSING", "The client runner did not execute exactly the required operation and transport files. Check test discovery and rerun the suites.");
    for (const file of results) {
      const tests = (function collect(tasks: readonly import("vitest/node").RunnerTask[]): import("vitest/node").RunnerTask[] { return tasks.flatMap(task => task.type === "suite" ? collect(task.tasks) : [task]); })(file.tasks);
      if (!tests.some(test => test.result?.state === "pass")) return failed("NO_EXECUTED_TESTS", "A required client test file executed no passing tests. Enable its behavioral tests and check again.", path.relative(root, file.filepath).split(path.sep).join("/"));
      if (file.result?.state !== "pass" || tests.some(test => test.result?.state === "fail")) return failed("VALIDATION_FAILED", "Client operation, selection, or cache behavior tests failed. Run the named suite and resolve its failures.", path.relative(root, file.filepath).split(path.sep).join("/"));
      if (tests.some(test => test.mode !== "run" || test.result?.state !== "pass")) return failed("INCOMPLETE_TEST_EXECUTION", "A required client suite skipped, deferred or did not finish a behavioral case. Execute every required case before renewing proof.", path.relative(root, file.filepath).split(path.sep).join("/"));
    }
    return { status: "passed" };
  } finally { await context.close(); process.exitCode = previousExitCode; }
}

/** Every invocation owns a fresh process/module graph inside the native boundary. */
export async function verifyPhase(root: string, phase: VerificationPhase, scratch: string, reporter: string): Promise<PhaseEvidence> {
  try {
    if (phase === "database") {
      const source = readFileSync(path.join(root, "packages/database/prisma/contract.prisma"), "utf8");
      const compiled = await compileDatabaseSource(root, source);
      const contract = compiled.contract ? { storageHash: compiled.contract.storage.storageHash, executionHash: compiled.contract.execution?.executionHash ?? null } : null;
      if (!compiled.validation.valid || !contract) return { evidence: failed("PRISMA_VALIDATION_FAILED", "Saved Prisma source does not compile or has misplaced @access settings. Resolve its validation errors before reviewing the API."), contract };
      const emitted = await emittedContractEvidence(root, compiled);
      const declaration = emitted.status === "matches" ? databaseDeclarationEvidence(root, readFileSync(path.join(root, "packages/database/src/generated/contract.d.ts"), "utf8"), { ...contract, profileHash: compiled.contract!.profileHash }) : undefined;
      const evidence = declaration ?? (emitted.status === "differs" ? failed("GENERATED_DATABASE_STALE", "Generated database artifacts do not match saved Prisma storage/execution semantics. Generate them separately, then check again.") : unavailableVerification("Generated database artifacts are missing or invalid. Generate them separately, then check again."));
      return { evidence: evidence.status === "passed" ? clientAccessEvidence(root, source) : evidence, contract };
    }
    if (phase === "api" || phase === "integration") return { evidence: runNodeTests(root, reporter, phase === "integration", scratch) };
    if (phase === "api-types" || phase === "consumers") return { evidence: await checkTypes(root, phase === "consumers") };
    return { evidence: await clientTests(root, scratch) };
  } catch {
    return { evidence: unavailableVerification(`Independent ${phase} validation could not run. Check the required source, configuration and installed dependencies, then retry.`), ...(phase === "database" ? { contract: null } : {}) };
  }
}

import { studioTestScratchRoot } from "./support/source-fixture";
import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import { chainReporterBundle, chainWorkerBundle } from "aws-studio/contract-chain/evaluation";
import { readEvaluationArtifact } from "aws-studio/source/result-artifact";

const repository = path.resolve(__dirname, "../..");
const schemaFile = "compute/http/graphql-api/schema/index.ts";
const operationFile = "client-app/src/api/projects/operations.ts";
const generated = "client-app/src/api/generated";
const localRequire = createRequire(path.join(repository, "package.json"));
const loader = pathToFileURL(localRequire.resolve("tsx")).href;
const worker = pathToFileURL(path.join(repository, "packages/aws-studio/scripts/contract-chain/worker.ts")).href;
const schema = "type Project { id: ID! name: String! } type Query { projects: [Project!]! }";
const operations = `import { graphql } from "#/api/generated";
graphql(\`fragment ProjectSummary on Project { id name }\`);
export const ProjectsDocument = graphql(\`query Projects { projects { ...ProjectSummary } }\`);
`;
const configuration = `import { schema } from "./${schemaFile}";
export default {
  schema,
  documents: ["client-app/src/api/**/*.ts", "!client-app/src/api/generated/**"],
  generates: {
    "client-app/src/api/generated/": {
      preset: "client", config: { useTypeImports: true, documentMode: "string" },
      presetConfig: { fragmentMasking: false, persistedDocuments: { hashAlgorithm: "sha256" } }
    },
    "client-app/src/api/generated/schema.graphql": { plugins: ["schema-ast"], config: { includeDirectives: true } }
  }
};`;
const roots: string[] = [];
let baseline: string;
function put(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}
function child(root: string, script: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TSX_DISABLE_CACHE: "1" }; delete env.NODE_TEST_CONTEXT;
  // Match the production one-shot worker: a complete result is flushed before
  // exit, even if an authored import leaves timers or graceful-signal handlers.
  const entry = `const writeFixtureResult=process.stdout.write.bind(process.stdout),exitFixture=process.exit.bind(process);await(async()=>{${script}\n})();writeFixtureResult("",()=>exitFixture(0));`;
  return execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", entry], {
    cwd: root, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 3 * 1024 * 1024,
    env,
  });
}
function inspect(root: string): ChainEvaluation {
  // Each call owns a fresh module graph, including the application schema singleton.
  return JSON.parse(child(root, `const output=process.stdout.write.bind(process.stdout);process.stdout.write=()=>true;process.stderr.write=()=>true;
    const {inspectGraphQLChain}=await import(${JSON.stringify(worker)});
    const result=await inspectGraphQLChain(process.cwd());output(JSON.stringify(result));`));
}
function fixture(): string {
  const root = mkdtempSync(path.join(studioTestScratchRoot(), ".cache/framework-studio/graphql-chain-worker-"));
  roots.push(root);
  // Keep dependency junctions out of recursive copies, including workspace links.
  cpSync(baseline, root, { recursive: true, verbatimSymlinks: true,
    filter: source => path.relative(baseline, source).split(path.sep)[0] !== "node_modules",
  });
  symlinkSync(path.join(testProjectRoot, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return root;
}
function files(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path.join(root, generated)).map(name => [name, readFileSync(path.join(root, generated, name), "utf8")]));
}

before(() => {
  mkdirSync(path.join(studioTestScratchRoot(), ".cache/framework-studio"), { recursive: true });
  baseline = mkdtempSync(path.join(studioTestScratchRoot(), ".cache/framework-studio/graphql-chain-worker-base-")); roots.push(baseline);
  put(baseline, "package.json", '{"name":"graphql-chain-worker-fixture","private":true,"type":"module"}\n');
  // This trusted worker fixture links installed packages. Native evaluation grants canonical dependency directories read-only.
  symlinkSync(path.join(testProjectRoot, "node_modules"), path.join(baseline, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  put(baseline, schemaFile, `import {buildSchema} from "graphql";export const schema=buildSchema(${JSON.stringify(schema)});`);
  put(baseline, operationFile, operations);
  put(baseline, "codegen.ts", configuration);
  // Generate only disposable fixture output, never application files.
  child(baseline, `const {generate}=await import("@graphql-codegen/cli");const config=(await import(${JSON.stringify(pathToFileURL(path.join(baseline, "codegen.ts")).href)})).default;await generate(config,true);`);
});
after(() => { for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true }); });

test("worker fixtures link dependencies and keep saved source independent", () => {
  const first = fixture(), second = fixture();
  assert.ok(lstatSync(path.join(first, "node_modules")).isSymbolicLink());
  assert.equal(realpathSync(path.join(first, "node_modules")), realpathSync(path.join(testProjectRoot, "node_modules")));
  put(first, schemaFile, "export const changed = true;");
  assert.equal(readFileSync(path.join(second, schemaFile), "utf8"), readFileSync(path.join(baseline, schemaFile), "utf8"));
  assert.notEqual(readFileSync(path.join(first, schemaFile), "utf8"), readFileSync(path.join(baseline, schemaFile), "utf8"));
});

test("actual Codegen loader, document maps and full check agree without changing generated bytes", () => {
  const root = fixture(), before = files(root);
  const result = inspect(root);
  assert.ok(result.sdl);
  assert.equal(result.sdl, result.generatedSdl);
  assert.deepEqual(result.schemaDiagnostics, []);
  assert.deepEqual(result.documentDiagnostics, []);
  assert.equal(result.documentSet, "matches");
  assert.deepEqual(result.documents, []);
  assert.equal(result.codegen.status, "current");
  assert.deepEqual(files(root), before);
});

test("completed inspection exits after its JSON result despite authored background handles", () => {
  const root = fixture();
  put(root, schemaFile, `import {buildSchema} from "graphql";setInterval(()=>{},1000);process.on("SIGTERM",()=>{});export const schema=buildSchema(${JSON.stringify(schema)});`);
  const result = inspect(root);
  assert.equal(result.codegen.status, "current");
  assert.deepEqual(result.schemaDiagnostics, []);
});

test("graphql-js executors in neighboring API tests do not become generated document helpers", () => {
  for (const source of [
    'import {graphql} from "graphql"; export const execute = () => graphql({schema: undefined, source: "{ projects { id } }"});',
    'const {graphql} = await import("graphql"); export const execute = () => graphql({schema: undefined, source: "{ projects { id } }"});',
    'import {createRequire} from "node:module"; const require=createRequire(import.meta.url); const {graphql}=require("graphql"); export const execute = () => graphql({schema: undefined, source: "{ projects { id } }"});',
    'import * as execution from "graphql"; export const execute = () => execution.graphql({schema: undefined, source: "{ projects { id } }"});',
  ]) {
    const root = fixture(), before = files(root);
    put(root, "client-app/src/api/projects/operations.test.ts", source);
    const result = inspect(root);
    assert.deepEqual(result.documentDiagnostics, []);
    assert.equal(result.documentSet, "matches");
    assert.equal(result.codegen.status, "current");
    assert.deepEqual(files(root), before);
  }
});

test("a graphql-js executor exemption never permits dynamic generated-helper aliases", () => {
  const root = fixture();
  put(root, "client-app/src/api/projects/operations.test.ts", 'import {graphql} from "graphql"; import {graphql as document} from "#/api/generated"; export const execute = () => graphql({schema: undefined, source:"{ projects { id } }"}); const source = "query Hidden { projects { id } }"; export const hidden = document(source);');
  const result = inspect(root);
  assert.equal(result.codegen.status, "unknown");
  assert.ok(result.documentDiagnostics.some(item => /Unsupported dynamic graphql/.test(item.message)));
});

test("authored schema globals cannot replace the authority that launches independent phases", async () => {
  const root = fixture(), marker = path.join(root, "phase-launch-poisoned"), armed = path.join(root, "schema-poison-armed");
  put(root, schemaFile, `import {buildSchema} from "graphql"; import cp from "node:child_process"; import {syncBuiltinESMExports} from "node:module"; import fs from "node:fs"; import {createHash} from "node:crypto";
const original=cp.spawnSync;
cp.spawnSync=((...args:any[])=>{const command=args[1];if(Array.isArray(command)&&["database","api","api-types","client","consumers","integration"].includes(command[4])){
fs.writeFileSync(${JSON.stringify(marker)},"independent launcher was replaced");const text=JSON.stringify({evidence:{status:"passed"},contract:{storageHash:"a".repeat(64),executionHash:null}});fs.writeFileSync(command[3],text);return{status:0,stdout:JSON.stringify({version:1,bytes:Buffer.byteLength(text),hash:createHash("sha256").update(text).digest("hex")}),stderr:""};}return original(...args as Parameters<typeof original>);}) as typeof cp.spawnSync;syncBuiltinESMExports();
fs.writeFileSync(${JSON.stringify(armed)},"schema mutation installed");export const schema=buildSchema(${JSON.stringify(schema)});`);
  const directory = path.join(root, "fixed-worker"), scratch = path.join(root, "worker-result"); mkdirSync(directory); mkdirSync(scratch);
  writeFileSync(path.join(directory, "inspect.cjs"), await chainWorkerBundle());
  writeFileSync(path.join(directory, "node-test-reporter.cjs"), await chainReporterBundle());
  const artifact = path.join(scratch, "chain.json");
  const output = execFileSync(process.execPath, ["--import", loader, path.join(directory, "inspect.cjs"), artifact], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 32_768, env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
  const value = JSON.parse(readEvaluationArtifact(artifact, JSON.parse(output), 2 * 1024 * 1024)) as ChainEvaluation;
  assert.equal(existsSync(armed), true, "the adversarial schema really executed in the inspection subprocess");
  assert.equal(existsSync(marker), false, "authored process globals cannot intercept any independent phase launch");
  assert.notEqual(value.verification.database.status, "passed", "this disposable fixture intentionally has no database verification inputs");
  assert.ok(Object.values(value.verification).some(check => check.status !== "passed"));
});

test("schema exposure without generation reports stale schema output and fresh processes see each edit", () => {
  const root = fixture(), before = files(root);
  put(root, schemaFile, `import {buildSchema} from "graphql";export const schema=buildSchema(${JSON.stringify(schema.replace("name: String!", "name: String! dueDate: String"))});`);
  const changed = inspect(root);
  assert.notEqual(changed.sdl, changed.generatedSdl);
  assert.equal(changed.codegen.status, "out-of-date");
  assert.ok(changed.codegen.files.some(file => file.endsWith("schema.graphql")));
  assert.deepEqual(files(root), before);
  put(root, schemaFile, `import {buildSchema} from "graphql";export const schema=buildSchema(${JSON.stringify(schema)});`);
  assert.equal(inspect(root).codegen.status, "current");
});

test("authored document edits report document-set and exact generated-file drift", () => {
  const root = fixture();
  put(root, operationFile, operations.replace("id name", "id"));
  const result = inspect(root);
  assert.equal(result.documentSet, "differs");
  assert.deepEqual(result.documents, []);
  assert.equal(result.codegen.status, "out-of-date");
  assert.ok(result.codegen.files.some(file => file.endsWith("gql.ts")));
});

test("invalid selections name the actual fragment and its GraphQL validation error", () => {
  const root = fixture();
  put(root, schemaFile, `import {buildSchema} from "graphql";export const schema=buildSchema(${JSON.stringify(schema.replace(" name: String!", ""))});`);
  const result = inspect(root);
  assert.ok(result.documents.some(problem => problem.document === "ProjectSummary" && problem.message.includes('Cannot query field "name"')
    && problem.file === operationFile));
  assert.equal(result.codegen.status, "unknown");
  assert.ok(result.codegen.diagnostics.length);
});

test("authored document syntax errors carry a trusted repair diagnostic without changing generated output", () => {
  const root = fixture(), before = files(root);
  put(root, operationFile, operations.replace("id name", "id name ("));
  const result = inspect(root);
  assert.ok(result.documentDiagnostics.some(problem => problem.code === "DOCUMENT_SYNTAX" && problem.file === operationFile));
  assert.notEqual(result.codegen.status, "current");
  assert.deepEqual(files(root), before);
});

test("syntax failures retain generated-schema evidence and never return current codegen evidence", () => {
  const root = fixture();
  put(root, schemaFile, "export const schema = { broken syntax");
  const result = inspect(root);
  assert.equal(result.sdl, null);
  assert.ok(result.schemaDiagnostics.length);
  assert.ok(result.generatedSdl);
  assert.equal(result.codegen.status, "unknown");
});

test("schemas that import review evidence become Unknown when the inspector withholds the record", () => {
  const root = fixture();
  put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}');
  put(root, schemaFile, `import {buildSchema} from "graphql";
    import review from "../../../../graphql-chain.review.json" with {type:"json"};
    export const schema=buildSchema(review.version===1?${JSON.stringify(schema)}:"invalid");`);
  assert.equal(inspect(root).codegen.status, "current");
  // This is only the disposable inspection fixture. The evaluator test separately
  // proves the authoritative checkout's record is preserved while its capture omits it.
  rmSync(path.join(root, "graphql-chain.review.json"));
  const result = inspect(root);
  assert.equal(result.sdl, null);
  assert.equal(result.codegen.status, "unknown");
  assert.ok(result.schemaDiagnostics.some(problem => problem.message.includes("graphql-chain.review.json")));
});

test("dynamic graphql documents are explicitly unsupported rather than silently omitted", () => {
  const root = fixture();
  put(root, operationFile, `${operations}\nconst source = "query Other { projects { id } }";graphql(source);`);
  const result = inspect(root);
  assert.equal(result.documentSet, "unknown");
  assert.ok(result.documentDiagnostics.some(problem => problem.message.includes("Unsupported dynamic graphql()")));
  assert.equal(result.codegen.status, "unknown");
});

test("aliased, indirect and member helpers cannot silently omit authored document work", () => {
  const forms = [
    'import { graphql as query } from "#/api/generated";query(source);',
    'import { graphql as query } from "../generated/index.js";query(source);',
    'import * as api from "#/api/generated";api.graphql(source);',
    'import * as api from "#/api/generated";api["graphql"](source);',
    'import * as api from "#/api/generated";const key="graphql";api[key](source);',
    'const {graphql: query}=require("#/api/generated");query(source);',
    'const query = graphql;query(source);',
  ];
  for (const form of forms) {
    const root = fixture();
    put(root, operationFile, `${operations}\nconst source = "query Other { projects { id } }";${form}`);
    const result = inspect(root);
    assert.equal(result.documentSet, "unknown");
    assert.equal(result.codegen.status, "unknown");
    assert.ok(result.documentDiagnostics.some(problem => /Unsupported (?:dynamic graphql|member graphql|graphql helper|indirect graphql)/.test(problem.message)), form);
  }
});

test("configuration changes cannot silently drop client, persisted-document or schema check coverage", () => {
  const configurations = [
    configuration.replace('"client-app/src/api/generated/schema.graphql":', '"client-app/src/api/generated/other.graphql":'),
    configuration.replace('preset: "client"', 'preset: "other"'),
    configuration.replace('documentMode: "string"', 'documentMode: "documentNode"'),
    configuration.replace('fragmentMasking: false', 'fragmentMasking: true'),
    configuration.replace('hashAlgorithm: "sha256"', 'hashAlgorithm: "sha1"'),
    configuration.replace('persistedDocuments: { hashAlgorithm: "sha256" }', 'persistedDocuments: false'),
    configuration.replace('includeDirectives: true', 'includeDirectives: false'),
  ];
  for (const config of configurations) {
    const root = fixture(), before = files(root);
    put(root, "codegen.ts", config);
    const result = inspect(root);
    assert.equal(result.codegen.status, "unknown");
    assert.ok(result.documentDiagnostics.some(problem => problem.message.includes("unsupported by the fixed read-only check")));
    assert.deepEqual(files(root), before);
  }
});

test("saved generated types and persisted documents cannot hide behind matching input fingerprints", () => {
  for (const file of ["graphql.ts", "persisted-documents.json"]) {
    const root = fixture(), target = path.join(root, generated, file);
    writeFileSync(target, file.endsWith(".json") ? "{}\n" : `${readFileSync(target, "utf8")}\n// accidental generated edit\n`);
    const before = files(root), result = inspect(root);
    assert.equal(result.documentSet, "matches");
    assert.equal(result.sdl, result.generatedSdl);
    assert.equal(result.codegen.status, "out-of-date");
    assert.ok(result.codegen.files.includes(`${generated}/${file}`));
    assert.deepEqual(files(root), before);
  }
});

test("hooks and both overwrite forms fail closed before executing generation hooks or skipping stale files", () => {
  const hook = `node -e "require('node:fs').writeFileSync('hook-ran','bad')"`;
  const configurations = [
    configuration.replace("  schema,", "  schema, overwrite: false,"),
    configuration.replace("  schema,", "  schema, overwrite: { updateExistingFiles: false },"),
    configuration.replace('preset: "client",', 'overwrite: { updateExistingFiles: false }, preset: "client",'),
    configuration.replace("  schema,", `  schema, hooks: { afterStart: ${JSON.stringify(hook)} },`),
  ];
  for (const config of configurations) {
    const root = fixture(), before = files(root);
    put(root, "codegen.ts", config);
    const result = inspect(root);
    assert.equal(result.codegen.status, "unknown");
    assert.ok(result.documentDiagnostics.some(problem => problem.message.includes("unsupported by the fixed read-only check")));
    assert.deepEqual(files(root), before);
    assert.equal(existsSync(path.join(root, "hook-ran")), false);
  }
});

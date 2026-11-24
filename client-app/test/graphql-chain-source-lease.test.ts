import assert from "./support/assert";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_PROOF_POLICY_FILES } from "aws-studio/contract-chain/portable-identity";
import { captureContractSourceProjection, establishContractSourceLease, retainedContractStages } from "aws-studio/contract-chain/source-lease";
import { readAuthoredDocumentSources, documentProjectionOptions, isDocumentPluckOptions, projectAuthoredDocuments } from "aws-studio/contract-chain/authored-documents";
import { graphqlChainFixture } from "./support/graphql-chain";
import type { ChainObservation } from "aws-studio/contract-chain/inspector";
import { GraphQLChainWatchInputs } from "../server/graphql-chain/watch-inputs";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const cache = path.join(repository, "output/playwright/contract-chain/source-lease-tests");
const operation = "client-app/src/api/projects/operations.ts";
const original = 'import { graphql } from "../generated";\nexport const document = graphql(/* GraphQL */ `query Project { value }`);\nexport const cacheKey = ["project"];\n';
const put = (root: string, file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
function fixture(t: TestContext) {
  mkdirSync(cache, { recursive: true }); const root = mkdtempSync(path.join(cache, "project-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const policyRoot = path.join(root, "node_modules/aws-studio");
  for (const file of CONTRACT_PROOF_POLICY_FILES) put(policyRoot, file, `// Fixed checker fixture: ${file}\n`);
  for (const file of ["package.json", "packages/database/package.json", "client-app/package.json"]) put(root, file, "{}\n");
  put(root, "package-lock.json", '{"lockfileVersion":3,"packages":{}}\n');
  put(root, "packages/database/prisma.config.ts", "export default {};\n");
  put(root, "packages/database/prisma/contract.prisma", "// use prisma-8\nmodel Project {\n id Uuid @id\n}\n");
  put(root, "compute/http/graphql-api/schema/index.ts", "export const schema = true;\n");
  put(root, "codegen.ts", 'import { schema } from "./compute/http/graphql-api/schema/index";\nexport default { schema };\n');
  put(root, "client-app/src/api/generated/gql.ts", "export const generated = true;\n");
  put(root, operation, original);
  const source = captureContractSourceProjection(root, policyRoot), options = { skipIndent: true };
  assert.ok(source.lockfile);
  const evaluation = { sdl: "type Query { value: String }", generatedSdl: "type Query { value: String }", schemaDiagnostics: [], generatedDiagnostics: [], documents: [], documentDiagnostics: [], documentSet: "matches" as const, codegen: { status: "current" as const, files: [], diagnostics: [] }, verification: graphqlChainFixture().verification, contract: { storageHash: "a".repeat(64), executionHash: "b".repeat(64) }, documentProjectionOptions: options, authoredDocumentsDigest: projectAuthoredDocuments(root, source.documents!, options) };
  const observation: ChainObservation = { chain: graphqlChainFixture(), evaluationRevision: "fixture", record: null, recordText: null, models: {}, surface: null, bindings: { api: null, client: null, upstream: null }, proofInput: {
    identity: { version: 1, sourceRevision: "1".repeat(64), policy: { id: "contract-chain/offline-v1", digest: source.policy }, toolchain: { node: process.versions.node, packages: {}, lockfileDigest: source.lockfile, dependencyDigest: "3".repeat(64) }, ...source.normalized, files: { database: {}, api: {}, client: {}, codegen: {}, generated: {} } },
    evaluation, record: null, models: {}, sdlDigest: null, codegenChecks: [],
  } };
  const lease = establishContractSourceLease(root, observation, source, "dependencies-before"); assert.ok(lease);
  const stages = () => retainedContractStages(root, lease, captureContractSourceProjection(root, policyRoot), "dependencies-before");
  return { root, policyRoot, source, observation, lease, stages };
}

test("raw stage groups invalidate only the edited stage and downstream", t => {
  const f = fixture(t); assert.deepEqual(f.stages(), ["database", "api", "codegen", "client"]);
  put(f.root, operation, original.replace('["project"]', '["project", "detail"]'));
  assert.deepEqual(f.stages(), ["database", "api", "codegen"], "cache behavior is client-only");
  put(f.root, operation, original.replace("value }", "other }"));
  assert.deepEqual(f.stages(), ["database", "api"], "authored selections invalidate Codegen and client");
  put(f.root, operation, original);
  assert.deepEqual(f.stages(), ["database", "api", "codegen", "client"], "restored exact inputs retain only the original live lineage");
  put(f.root, "client-app/src/api/generated/gql.ts", "export const generated = false;\n");
  assert.deepEqual(f.stages(), ["database", "api"]);
  put(f.root, "compute/http/graphql-api/schema/index.ts", "export const schema = false;\n");
  assert.deepEqual(f.stages(), ["database"]);
  const contract = "packages/database/prisma/contract.prisma";
  const originalContract = readFileSync(path.join(f.root, contract), "utf8");
  put(f.root, contract, originalContract + "// comment only\n");
  assert.deepEqual(f.stages(), ["database"], "a comment preserves prior database evidence after other changes");
  const commented = captureContractSourceProjection(f.root, f.policyRoot);
  assert.equal(commented.normalized.inputs.database, f.source.normalized.inputs.database);
  assert.notEqual(commented.raw.inputs.database, f.source.raw.inputs.database);
  put(f.root, contract, originalContract.replace("model Project", "/// @access(read)\nmodel Project"));
  assert.deepEqual(f.stages(), []);
});

test("new Lambda and framework parameter files preserve the complete live contract lease", t => {
  const f = fixture(t), stages = f.stages();
  assert.deepEqual(stages, ["database", "api", "codegen", "client"]);
  const lambda = "compute/http/webhook";
  put(f.root, `${lambda}/index.ts`, "export const handler = () => 'new Lambda';\n");
  put(f.root, `${lambda}/package.json`, '{"name":"webhook","private":true}\n');
  put(f.root, "framework-config/workloads/http.ts", "export const routes = ['webhook'];\n");
  assert.deepEqual(f.stages(), stages);
  put(f.root, `${lambda}/index.ts`, "export const handler = () => 'updated Lambda';\n");
  put(f.root, "framework-config/inputs/index.ts", "export const timeout = 30;\n");
  assert.deepEqual(f.stages(), stages);
  rmSync(path.join(f.root, lambda), { recursive: true });
  assert.deepEqual(f.stages(), stages);
});

test("runtime outputs, policy, dependencies, lockfile and review changes invalidate retained confidence", t => {
  const f = fixture(t);
  assert.deepEqual(retainedContractStages(f.root, f.lease, f.source, "dependencies-after"), []);
  put(f.root, "packages/database/src/generated/contract.json", '{"changed":true}\n'); assert.deepEqual(f.stages(), []);
  const other = fixture(t); put(other.policyRoot, CONTRACT_PROOF_POLICY_FILES[0], "// changed policy\n"); assert.deepEqual(other.stages(), []);
  const changedLock = fixture(t);
  put(changedLock.root, "package-lock.json", '{"lockfileVersion":3,"packages":{"node_modules/graphql":{"version":"1.0.0"}}}\n');
  assert.deepEqual(changedLock.stages(), []);
  const reviewed = fixture(t); put(reviewed.root, "graphql-chain.review.json", "{}\n"); assert.deepEqual(reviewed.stages(), []);
});

test("durable history, mismatching captures and unverified stages cannot establish or gain a lease", t => {
  const f = fixture(t);
  assert.equal(establishContractSourceLease(f.root, { ...f.observation, proofInput: undefined }, f.source, "same"), undefined);
  assert.equal(establishContractSourceLease(f.root, { ...f.observation, recordText: "changed" }, f.source, "same"), undefined);
  assert.equal(establishContractSourceLease(f.root, f.observation, { ...f.source, lockfile: "2".repeat(64) }, "same"), undefined);
  const partial = { ...f.observation, chain: { ...f.observation.chain, proof: { ...f.observation.chain.proof, stages: f.observation.chain.proof.stages.map(view => view.stage === "api" ? { ...view, status: "stale" as const } : view) } } };
  const lease = establishContractSourceLease(f.root, partial, f.source, "same");
  assert.deepEqual(retainedContractStages(f.root, lease, f.source, "same"), ["database"]);
});

test("custom pluck options are captured exactly; custom loaders and functions decline optimization", t => {
  const f = fixture(t), config = { schema: {}, documents: [], generates: {}, pluckConfig: { globalGqlIdentifierName: "document", skipIndent: false } };
  const options = documentProjectionOptions(config); assert.deepEqual(options, { skipIndent: false, globalGqlIdentifierName: "document" });
  assert.notEqual(projectAuthoredDocuments(f.root, { "client-app/src/api/custom.ts": "export const value = document`query Example { value }`;" }, options!), projectAuthoredDocuments(f.root, {}, options!));
  assert.equal(documentProjectionOptions({ ...config, loaders: [] }), null);
  assert.equal(documentProjectionOptions({ ...config, config: { loader: "custom" } }), null);
  assert.equal(documentProjectionOptions({ ...config, pluckConfig: { isGqlTemplateLiteral() { return true; } } }), null);
  assert.equal(isDocumentPluckOptions({ skipIndent: "yes" }), false);
});

test("dynamic helpers and untracked document sources cannot retain Codegen approval", t => {
  const f = fixture(t);
  put(f.root, operation, original.replace('`query Project { value }`', 'makeDocument()'));
  assert.deepEqual(f.stages(), ["database", "api"]);
  put(f.root, operation, original);
  put(f.root, "client-app/src/api/.cache/hidden.ts", 'export const hidden = graphql(`query Hidden { value }`);');
  assert.deepEqual(f.stages(), ["database", "api"], "an ignored new document cannot hide behind unchanged public hashes");
});

test("dependency metadata identity observes nested removals and ignores ordinary source edits", t => {
  const f = fixture(t); put(f.root, "node_modules/fixture/index.js", "module.exports = 1;");
  const inputs = new GraphQLChainWatchInputs(f.root), before = inputs.dependencyStamp();
  put(f.root, operation, original + "// comment\n"); assert.equal(inputs.notified(operation), true); assert.equal(inputs.dependencyStamp(), before);
  put(f.root, "node_modules/fixture/index.js", "module.exports = 2;"); assert.equal(inputs.notified("node_modules/fixture/index.js"), true); assert.notEqual(inputs.dependencyStamp(), before);
  const altered = inputs.dependencyStamp(); rmSync(path.join(f.root, "node_modules/fixture"), { recursive: true }); assert.equal(inputs.notified("node_modules/fixture"), true); assert.notEqual(inputs.dependencyStamp(), altered);
});


test("projection matches the real Codegen document loader with effective custom options and never executes source", async t => {
  const f = fixture(t);
  const { createRequire } = await import("node:module"), localRequire = createRequire(path.join(f.root, "package.json"));
  const { CodegenContext } = localRequire("@graphql-codegen/cli") as typeof import("@graphql-codegen/cli");
  const { createHash } = await import("node:crypto");
  const text = 'export const document = customDocument(`query Custom { value }`);\nexport const key = ["custom"];';
  put(f.root, operation, text);
  put(f.root, "client-app/src/api/do-not-execute.ts", 'throw new Error("Document source was executed"); export const cacheOnly = true;');
  const config = { schema: "type Query { value: String }", documents: ["client-app/src/api/**/*.ts", "!client-app/src/api/generated/**"], generates: { "client-app/src/api/generated/": { preset: "client" as const } }, pluckConfig: { globalGqlIdentifierName: "customDocument", skipIndent: false }, noRequire: true };
  const context = new CodegenContext({ config, filepath: path.join(f.root, "codegen.ts") }); context.cwd = f.root;
  const actual = await context.loadDocuments(config.documents, "standard");
  const expected = createHash("sha256").update(JSON.stringify([...new Set(actual.map(source => source.rawSDL!.replaceAll("\r\n", "\n")))].sort())).digest("hex");
  const options = documentProjectionOptions(config); assert.ok(options);
  assert.equal(projectAuthoredDocuments(f.root, captureContractSourceProjection(f.root, f.policyRoot).documents!, options), expected);
});


test("only the root generated output is excluded from authored document discovery", async t => {
  const f = fixture(t);
  put(f.root, "client-app/src/api/generated/dist/ignored.ts", 'export const ignored = graphql(`query Ignored { value }`);');
  assert.deepEqual(f.stages(), ["database", "api", "codegen", "client"]);
  const nested = "client-app/src/api/feature/generated/normal.ts";
  put(f.root, nested, 'export const nested = graphql(`query Nested { value }`);');
  assert.ok(Object.hasOwn(readAuthoredDocumentSources(f.root), nested));
  assert.equal(Object.hasOwn(readAuthoredDocumentSources(f.root), "client-app/src/api/generated/dist/ignored.ts"), false);
  assert.deepEqual(f.stages(), ["database", "api"]);
  const hidden = fixture(t), file = "client-app/src/api/feature/generated/dist/hidden.ts";
  put(hidden.root, file, 'export const hidden = graphql(`query Hidden { value }`);');
  assert.equal(captureContractSourceProjection(hidden.root, hidden.policyRoot).documents, null);
  assert.deepEqual(hidden.stages(), ["database", "api"]);
  const { createRequire } = await import("node:module"), localRequire = createRequire(path.join(hidden.root, "package.json"));
  const { CodegenContext } = localRequire("@graphql-codegen/cli") as typeof import("@graphql-codegen/cli");
  const config = { schema: "type Query { value: String }", documents: ["client-app/src/api/**/*.ts", "!client-app/src/api/generated/**"], generates: { "client-app/src/api/generated/": { preset: "client" as const } }, noRequire: true };
  const context = new CodegenContext({ config, filepath: path.join(hidden.root, "codegen.ts") }); context.cwd = hidden.root;
  assert.ok((await context.loadDocuments(config.documents, "standard")).some(source => source.rawSDL?.includes("query Hidden")));
});

import { renderAccessGraph } from "aws-studio/database/access-graph-artifact";
import assert from "./support/assert";
import { after, afterEach, before, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { chainReporterBundle } from "aws-studio/contract-chain/evaluation";
import { apiTypecheckRoots, clientAccessEvidence, combineVerification, databaseDeclarationEvidence, nodeTestEvidence, requiredNodeTests, skippedVerification, verifyPhase } from "aws-studio/contract-chain/verification";
import { readClientAccess, renderClientAccess } from "aws-studio/database/client-access";
import { renderRolePolicies } from "aws-studio/database/client-access";
import { integrationPrerequisite } from "aws-studio/contract-chain/worker";
import { databaseRuntimeArtifactDigest } from "aws-studio/contract-chain/runtime-artifacts";

const repository = path.resolve(__dirname, "../..");
let reporter: string;
let reporterDirectory: string;
before(async () => {
  reporterDirectory = mkdtempSync(path.join(tmpdir(), "chain-reporter-test-"));
  reporter = path.join(reporterDirectory, "node-test-reporter.cjs");
  writeFileSync(reporter, await chainReporterBundle());
});
after(() => { if (reporterDirectory) rmSync(reporterDirectory, { recursive: true, force: true }); });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(root: string, file: string, text: string) { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); }
function fixture() {
  const parent = path.join(repository, ".cache/framework-studio"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "chain-verification-test-")); roots.push(root);
  put(root, "package.json", '{"name":"chain-verification-fixture","type":"module"}');
  mkdirSync(path.join(root, "scratch"));
  return root;
}
const suite = 'import {test} from "node:test";test("behavior",()=>{});';

test("combined required checks preserve unavailable evidence behind a known failure", () => {
  assert.equal(combineVerification([]).status, "unavailable");
  assert.equal(combineVerification([{ status: "failed", diagnostics: [] }, { status: "unavailable", diagnostics: [] }]).status, "unavailable");
  assert.equal(combineVerification([{ status: "passed" }, { status: "blocked", diagnostics: [] }]).status, "blocked");
  assert.equal(combineVerification([{ status: "passed" }, { status: "failed", diagnostics: [] }]).status, "failed");
  assert.equal(combineVerification([{ status: "passed" }, { status: "passed" }]).status, "passed");
});
function nodeFixture(access = true) {
  const root = fixture();
  put(root, "packages/database/prisma/contract.prisma", `${access ? "/// @access(read: authenticated)\n" : ""}model User {\n  id String @id\n}\n`);
  put(root, "compute/http/graphql-api/schema/project.ts", "export {};\n");
  put(root, "packages/database/test/projects.test.ts", suite);
  for (const file of requiredNodeTests(root)) put(root, path.relative(root, file), suite);
  return root;
}

test("offline API verification excludes the opt-in live database suite and keeps repository behavior required", () => {
  const root = nodeFixture(false);
  const live = "packages/database/test/local-startup-live.test.ts";
  put(root, live, 'import {test} from "node:test";test.skip("requires Docker",()=>{});');
  const files = requiredNodeTests(root);
  assert.ok(files.includes(path.join(root, "packages/database/test/projects.test.ts")));
  assert.ok(!files.includes(path.join(root, live)));
});

test("generated access settings and row rules must match the access directives in saved contract.prisma", () => {
  const root = fixture();
  const source = [
    "// use prisma-8",
    "/// @access(read: id == auth.id)", "model User {", "  id    String @id", "  notes Note[]", "}",
    "/// @access(read: userId == auth.id)", "model Note {", "  id     String @id", "  /// @access(readonly)", "  title  String",
    "  author User @relation(fields: [userId], references: [id])", "  userId String", "}", "",
  ].join("\n");
  const output = "packages/database/src/generated/client-access.ts";
  const rendered = (text: string) => { const { settings, rows, policy } = readClientAccess(text); return renderClientAccess(settings, rows, policy); };
  const graphOutput = "packages/database/src/generated/access-graph.json";
  const renderedGraph = (text: string) => renderAccessGraph(readClientAccess(text).graph, undefined, path.join(root, "packages/database"));
  assert.equal(clientAccessEvidence(root, source).status, "unavailable");
  put(root, output, renderClientAccess({}, { viewer: [], models: {} }));
  assert.equal(clientAccessEvidence(root, source).status, "unavailable", "the Access Graph artifact is required too");
  put(root, graphOutput, renderedGraph(source.replace("@access(readonly)", "@access(serverOnly)")));
  const staleGraph = clientAccessEvidence(root, source);
  assert.equal(staleGraph.status === "failed" && staleGraph.diagnostics[0]?.code, "GENERATED_ACCESS_GRAPH_STALE");
  put(root, graphOutput, renderedGraph(source));
  const stale = clientAccessEvidence(root, source);
  assert.equal(stale.status, "failed");
  assert.equal(stale.status === "failed" && stale.diagnostics[0]?.code, "GENERATED_CLIENT_ACCESS_STALE");
  put(root, output, rendered(source));
  assert.equal(clientAccessEvidence(root, source).status, "passed");
  const comments = source.replace("/// @access(read: userId", "/// An explanation for readers\n/// @access(read: userId");
  assert.notEqual(renderedGraph(comments), renderedGraph(source), "navigation lines move when documentation changes");
  assert.equal(databaseRuntimeArtifactDigest(graphOutput, Buffer.from(renderedGraph(comments))), databaseRuntimeArtifactDigest(graphOutput, Buffer.from(renderedGraph(source))));
  assert.equal(clientAccessEvidence(root, comments).status, "passed", "existing artifact evidence survives a line shift caused by prose");
  assert.notEqual(databaseRuntimeArtifactDigest(graphOutput, Buffer.from(renderedGraph(source.replace("@access(readonly)", "@access(serverOnly)")))), databaseRuntimeArtifactDigest(graphOutput, Buffer.from(renderedGraph(source))));
  assert.equal(clientAccessEvidence(root, source.replace("@access(readonly)", "@access(serverOnly)")).status, "failed", "a field setting");
  assert.equal(clientAccessEvidence(root, source.replace("read: userId == auth.id", "read: authenticated")).status, "failed", "a row rule");
  const invalid = clientAccessEvidence(root, source.replace("@access(readonly)", "@access(editable)"));
  assert.equal(invalid.status === "failed" && invalid.diagnostics[0]?.code, "INVALID_ACCESS_POLICY");
  const withGrants = `${source}\nenum Rank {\n  /// @access(read, edit)\n  LEAD = "LEAD"\n  /// @access(read)\n  READER = "READER"\n}\n`;
  put(root, output, rendered(withGrants));
  // Roles are part of the fingerprinted graph too.
  put(root, graphOutput, renderedGraph(withGrants));
  const missingRoles = clientAccessEvidence(root, withGrants);
  assert.equal(missingRoles.status === "failed" && missingRoles.diagnostics[0]?.code, "GENERATED_ROLE_POLICIES_STALE");
  put(root, "packages/api-contract/src/generated/access-policy.ts", renderRolePolicies(readClientAccess(withGrants).policy));
  assert.equal(clientAccessEvidence(root, withGrants).status, "passed");
  const changedGrant = withGrants.replace("/// @access(read)\n  READER", "/// @access(read, edit)\n  READER");
  put(root, output, rendered(changedGrant));
  put(root, graphOutput, renderedGraph(changedGrant));
  const staleRoles = clientAccessEvidence(root, changedGrant);
  assert.equal(staleRoles.status === "failed" && staleRoles.diagnostics[0]?.code, "GENERATED_ROLE_POLICIES_STALE");
});

test("trusted test counts reject absent, zero, skipped, failed and cancelled evidence", () => {
  const summary = (counts: object, success = true) => ({ success, executedTests: 1, counts: { tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0, ...counts } });
  assert.equal(nodeTestEvidence(summary({})).status, "passed");
  assert.equal(nodeTestEvidence(null).status, "unavailable");
  for (const value of [summary({ tests: 0, passed: 0 }), summary({ skipped: 1, passed: 0 }), summary({ todo: 1, passed: 0 }), summary({ failed: 1 }, false), summary({ cancelled: 1 }, false)]) assert.notEqual(nodeTestEvidence(value).status, "passed");
  for (const omitted of ["skipped", "todo", "cancelled"]) {
    const partial = nodeTestEvidence(summary({ tests: 2, [omitted]: 1 }));
    assert.equal(partial.status, "failed"); assert.equal(partial.diagnostics[0]?.code, "INCOMPLETE_TEST_EXECUTION");
  }
  assert.equal(nodeTestEvidence(summary({ tests: 2 })).status, "unavailable", "inconsistent counts cannot manufacture complete execution");
  const allFailed = nodeTestEvidence(summary({ passed: 0, failed: 1 }, false));
  assert.equal(allFailed.status, "failed");
  assert.equal(allFailed.diagnostics[0]?.code, "VALIDATION_FAILED", "executed failing tests are not misreported as absent tests");
});

test("known failed prerequisites block skipped validation; unknown evidence stays unavailable", () => {
  const diagnostics = [{ code: "PREREQUISITE", message: "Prerequisite evidence" }];
  assert.equal(skippedVerification({ status: "failed", diagnostics }, "Generate database artifacts.").status, "blocked");
  assert.equal(skippedVerification({ status: "blocked", diagnostics }, "Resolve upstream review.").status, "blocked");
  assert.equal(skippedVerification({ status: "unavailable", diagnostics }, "Inspect database artifacts.").status, "unavailable");
  const value = { codegen: { status: "current" as const, files: [], diagnostics: [] }, documentSet: "matches" as const, documents: [] };
  assert.equal(integrationPrerequisite(value), null);
  assert.equal(integrationPrerequisite({ ...value, codegen: { ...value.codegen, status: "out-of-date" } })?.status, "blocked");
  assert.equal(integrationPrerequisite({ ...value, codegen: { ...value.codegen, status: "unknown" } })?.status, "unavailable");
  assert.equal(integrationPrerequisite({ ...value, codegen: { ...value.codegen, status: "unknown" }, documents: [{ document: "Projects", file: "operations.ts", line: 1, message: "Invalid field" }] })?.status, "blocked");
});

test("API test discovery covers registered features, registration and repository statements; limits are separate", () => {
  const root = nodeFixture();
  const files = requiredNodeTests(root).map(file => path.relative(root, file));
  assert.equal(files.length, 5);
  assert.ok(files.some(file => file.endsWith("project.test.ts")));
  assert.ok(files.some(file => file.endsWith("projects.test.ts")));
  assert.ok(files.every(file => !file.endsWith("limits.test.ts")));
  assert.ok(requiredNodeTests(root, true)[0]!.endsWith("limits.test.ts"));
});

test("applications without Access Graph keep their existing API proof contracts", () => {
  const root = nodeFixture(false);
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  assert.deepEqual(requiredNodeTests(root).map(relative), [
    "compute/http/graphql-api/schema/project.test.ts",
    "compute/http/graphql-api/schema/schema-files.test.ts",
    "packages/database/test/projects.test.ts",
  ]);
  assert.deepEqual(apiTypecheckRoots(root).map(relative), [
    "compute/http/graphql-api/schema/index.ts",
    "compute/http/graphql-api/graphql-context.ts",
    "packages/database/src/index.ts",
  ]);
  // An API integration remains opted in even if its Prisma rules are cleared.
  put(root, "compute/http/graphql-api/lib/table-access.ts", "export {};\n");
  assert.ok(requiredNodeTests(root).map(relative).includes("compute/http/graphql-api/schema/client-access.test.ts"));
  assert.ok(apiTypecheckRoots(root).map(relative).includes("compute/http/graphql-api/type-fixtures/table-access.ts"));
});

test("API proof requires the authorization sweep and the client-database type fixture", () => {
  const root = nodeFixture();
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  assert.ok(
    requiredNodeTests(root).map(relative).includes("compute/http/graphql-api/schema/authorization.test.ts"),
    "the authorization inventory and its role sweep are required API tests, though no feature file pairs with them",
  );
  assert.ok(
    requiredNodeTests(root).map(relative).includes("compute/http/graphql-api/schema/client-access.test.ts"),
    "the field access settings are checked against every table-backed type, though no feature file pairs with that suite",
  );
  assert.ok(
    apiTypecheckRoots(root).map(relative).includes("compute/http/graphql-api/type-fixtures/client-database.ts"),
    "the type fixture is an API typecheck root, so a reachable billing writer fails the API typecheck",
  );
});

test("actual Node reporter requires executed behavioral tests in every required file", async () => {
  const root = nodeFixture();
  assert.equal((await verifyPhase(root, "api", path.join(root, "scratch"), reporter)).evidence.status, "passed");
  // A fixed required suite: repository tests are discovered by listing, so deleting one is not "missing".
  const file = "compute/http/graphql-api/schema/client-access.test.ts";
  for (const source of ["export {};", 'import {test} from "node:test";test.skip("skipped",()=>{});', `${suite}test.skip("omitted ownership case",()=>{});`, `${suite}test.todo("deferred ownership case");`, 'import {test} from "node:test";test("broken",()=>{throw new Error("regression")});', 'process.stdout.write(JSON.stringify({success:true,executedTests:1,counts:{tests:1,passed:1,failed:0,skipped:0,todo:0,cancelled:0}}));', 'import {test} from "node:test";test("child exit",()=>{process.exitCode=2;});']) {
    put(root, file, source);
    assert.equal((await verifyPhase(root, "api", path.join(root, "scratch"), reporter)).evidence.status, "failed");
  }
  rmSync(path.join(root, file));
  const missing = (await verifyPhase(root, "api", path.join(root, "scratch"), reporter)).evidence;
  assert.equal(missing.status, "failed");
  assert.equal(missing.diagnostics[0]!.code, "REQUIRED_TEST_MISSING");
});

test("generated database declarations must identify the same storage/execution/profile semantics", () => {
  const root = fixture();
  const expected = { storageHash: "a".repeat(64), executionHash: "b".repeat(64), profileHash: "c".repeat(64) };
  const declaration = `export type StorageHash=StorageHashBase<'${expected.storageHash}'>;export type ExecutionHash=ExecutionHashBase<'${expected.executionHash}'>;export type ProfileHash=ProfileHashBase<'${expected.profileHash}'>;`;
  assert.equal(databaseDeclarationEvidence(root, declaration, expected).status, "passed");
  assert.equal(databaseDeclarationEvidence(root, declaration.replace(expected.executionHash, "d".repeat(64)), expected).status, "failed");
  assert.equal(databaseDeclarationEvidence(root, `// ${declaration}`, expected).status, "failed");
});

test("client validation requires neighboring operation tests and never generates missing routes", async () => {
  const root = fixture();
  put(root, "client-app/src/api/projects/operations.ts", "export const value = 1;\n");
  assert.equal((await verifyPhase(root, "client", path.join(root, "scratch"), reporter)).evidence.status, "failed");
  assert.equal((await verifyPhase(root, "consumers", path.join(root, "scratch"), reporter)).evidence.status, "unavailable");
  assert.equal(existsSync(path.join(root, "client-app/src/routeTree.gen.ts")), false);
});

test("authored noCheck cannot disable the independent consumer typecheck", async () => {
  const root = fixture();
  put(root, "client-app/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", noCheck: true, skipLibCheck: true, types: [] }, include: ["src/**/*.ts"] }));
  put(root, "client-app/src/routeTree.gen.ts", "export {};\n");
  put(root, "client-app/src/broken.ts", "export const name: string = 42;\n");
  const result = await verifyPhase(root, "consumers", path.join(root, "scratch"), reporter);
  assert.equal(result.evidence.status, "failed");
  assert.ok(result.evidence.diagnostics.some(item => item.code === "TYPECHECK_FAILED" && item.message.includes("number")));
});

test("the independent consumer typecheck resolves ambient types from the client's installed workspace", async () => {
  const root = fixture();
  put(root, "client-app/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", skipLibCheck: true, types: ["workspace-transport"] },
    include: ["src/**/*.ts"],
  }));
  put(root, "client-app/node_modules/@types/workspace-transport/index.d.ts", 'declare const transportRuntime: "client";');
  put(root, "client-app/src/routeTree.gen.ts", 'export const runtime: "client" = transportRuntime;');
  const { evidence } = await verifyPhase(root, "consumers", path.join(root, "scratch"), reporter);
  assert.deepEqual(evidence, { status: "passed" });
});

test("authored include/exclude cannot hide a consumer from the independent typecheck", async () => {
  const root = fixture();
  put(root, "client-app/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", skipLibCheck: true, types: [] }, files: ["src/clean.ts"], include: [], exclude: ["src/broken.ts"] }));
  put(root, "client-app/src/routeTree.gen.ts", "export {};\n");
  put(root, "client-app/src/clean.ts", "export const name = 'Fine';\n");
  put(root, "client-app/src/broken.ts", "export const name: string = 42;\n");
  const result = await verifyPhase(root, "consumers", path.join(root, "scratch"), reporter);
  assert.equal(result.evidence.status, "failed");
  assert.ok(result.evidence.diagnostics.some(item => item.code === "TYPECHECK_FAILED" && item.file?.endsWith("broken.ts")));
});

test("actual Vitest uses pinned configuration and checks every operation and transport test", async () => {
  const root = fixture();
  put(root, "client-app/package.json", '{"name":"client","type":"module"}');
  put(root, "client-app/vite.config.ts", 'throw new Error("Authored Vite config must not run during contract inspection");');
  put(root, "client-app/src/api/projects/operations.ts", "export const value = 1;\n");
  put(root, "client-app/src/api/projects/operations.test.ts", 'import {test,expect} from "vitest";import {value} from "#/api/projects/operations";test("selection",()=>expect(value).toBe(1));');
  put(root, "client-app/src/api/graphql/client.test.ts", 'import {test,expect} from "vitest";test("transport",()=>expect(1).toBe(1));');
  const before = readFileSync(path.join(root, "client-app/src/api/projects/operations.ts"), "utf8");
  const evidence = await verifyPhase(root, "client", path.join(root, "scratch"), reporter);
  assert.equal(evidence.evidence.status, "passed", JSON.stringify(evidence));
  assert.equal(readFileSync(path.join(root, "client-app/src/api/projects/operations.ts"), "utf8"), before);
  for (const source of [
    'import {test} from "vitest";test.skip("all skipped",()=>{});',
    'import {test} from "vitest";test("passing",()=>{});test.skip("omitted cache case",()=>{});',
    'import {test} from "vitest";test("passing",()=>{});test.todo("deferred cache case");',
    'import {test} from "vitest";test.only("focused",()=>{});',
  ]) {
    put(root, "client-app/src/api/projects/operations.test.ts", source);
    const result = (await verifyPhase(root, "client", path.join(root, "scratch"), reporter)).evidence;
    assert.equal(result.status, "failed");
    if (source.includes('test("passing"')) assert.equal(result.diagnostics[0]?.code, "INCOMPLETE_TEST_EXECUTION");
  }
});

import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { readGraphQLWorkspace } from "../server/graphql-workspace/inventory";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const API = "client-app/src/api", SCHEMA = `${API}/generated/schema.graphql`;
function put(root: string, file: string, text: string): void { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
const query = "query Projects { projects { ...ProjectSummary } }", summary = "fragment ProjectSummary on Project { id ...ProjectName }", name = "fragment ProjectName on Project { name }";
const schema = `"Project state" enum State { OPEN CLOSED @deprecated(reason: "old") }
interface Node { id: ID! }
"An owned project" type Project implements Node { "Primary key" id: ID! name: String! state: State! }
type User { id: ID! }
union Search = Project | User
input Filter { state: State = OPEN names: [String!] = ["first"] }
type Query { projects(limit: Int = 20, filter: Filter): [Project!]! }
type Mutation { rename(id: ID!, name: String!): Project! }`;
const source = `import {graphql} from "#/api/generated";
import {queryOptions,mutationOptions} from "@tanstack/react-query";
import {executeGraphQL} from "#/api/graphql/client";
graphql(${JSON.stringify(name)});
graphql(${JSON.stringify(summary)});
const ProjectsDocument=graphql(${JSON.stringify(query)});
export const projectKeys={all:["projects"] as const,list:()=>[...projectKeys.all,"list"] as const};
export const projectsQuery=queryOptions({queryKey:projectKeys.list(),queryFn:()=>executeGraphQL(ProjectsDocument)});
export const fakeKeys={all:computeSecrets()};
export const inventedQuery=otherOptions({ProjectsDocument});
export const shadowedQuery=queryOptions({queryFn:(ProjectsDocument:unknown)=>executeGraphQL(ProjectsDocument)});
export const typedOnlyQuery=queryOptions({queryFn:()=>null as unknown as typeof ProjectsDocument});
throw new Error("This source must never execute");`;
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-graphql-inventory-")); roots.push(root);
  put(root, SCHEMA, schema); put(root, `${API}/projects/operations.ts`, source);
  const documentMap = [name, summary, query].map((text, index) => `${JSON.stringify(text)}: types.Document${index}`).join(",");
  put(root, `${API}/generated/gql.ts`, `const documents={${documentMap}};throw new Error("must never run generated source");`);
  put(root, `${API}/generated/graphql.ts`, [name, summary, `${query}\n${summary}\n${name}`].map((text, index) => `export const Document${index}=new TypedDocumentString(${JSON.stringify(text)},{hash:"sha256:fixture${index}"}) as unknown as TypedDocumentString<unknown,unknown>;`).join("\n"));
  return root;
}

test("schema inventory exposes saved types, roots, descriptions, arguments, input defaults and enums", () => {
  const root = fixture(), value = readGraphQLWorkspace(root);
  assert.equal(value.schema.status, "available");
  assert.deepEqual(value.schema.roots, { query: "Query", mutation: "Mutation", subscription: null });
  const project = value.schema.types.find(type => type.name === "Project")!;
  assert.equal(project.description, "An owned project"); assert.deepEqual(project.interfaces, ["Node"]);
  assert.equal(project.fields.find(field => field.name === "id")?.description, "Primary key");
  const projects = value.schema.types.find(type => type.name === "Query")!.fields[0];
  assert.equal(projects.type, "[Project!]!"); assert.equal(projects.args.find(arg => arg.name === "limit")?.defaultValue, "20");
  assert.equal(value.schema.types.find(type => type.name === "Filter")!.fields.find(field => field.name === "state")?.defaultValue, "OPEN");
  assert.deepEqual(value.schema.types.find(type => type.name === "Search")!.members, ["Project", "User"]);
  assert.equal(value.schema.types.find(type => type.name === "State")!.enumValues.find(value => value.name === "CLOSED")?.deprecationReason, "old");
  assert.ok(value.schema.types.every(type => !type.name.startsWith("__")));
});

test("documents resolve transitive fragments and actual selected paths without executing authored/generated source", () => {
  const value = readGraphQLWorkspace(fixture());
  assert.equal(value.client.status, "available"); assert.equal(value.client.documents.length, 3);
  const operation = value.client.documents.find(document => document.name === "Projects")!;
  assert.deepEqual(operation.fragmentNames, ["ProjectName", "ProjectSummary"]);
  assert.deepEqual(operation.selections, ["projects", "projects.id", "projects.name"]);
  assert.ok(operation.executableSource?.includes("fragment ProjectName"));
  assert.ok(operation.executableSource?.includes("fragment ProjectSummary"));
  assert.equal(operation.generated.status, "available"); assert.equal(operation.generated.exportName, "Document2");
  assert.equal(operation.generated.hash, "sha256:fixture2");
});

test("bundled fragments never borrow an operation's generated export", () => {
  const root = fixture();
  const before = readGraphQLWorkspace(root);
  assert.equal(before.client.documents.find(document => document.name === "ProjectSummary")?.generated.exportName, "Document1");
  put(root, `${API}/generated/graphql.ts`, `export const Document2=new TypedDocumentString(${JSON.stringify(`${query}\n${summary}\n${name}`)});`);
  const after = readGraphQLWorkspace(root);
  assert.equal(after.client.documents.find(document => document.name === "Projects")?.generated.status, "available");
  for (const fragment of after.client.documents.filter(document => document.kind === "fragment")) {
    assert.equal(fragment.generated.status, "missing");
    assert.equal(fragment.generated.exportName, null);
  }
});

test("client exports require recognized option helpers and key factories; associations ignore type-only and shadowed references", () => {
  const value = readGraphQLWorkspace(fixture()), feature = value.client.features[0];
  assert.deepEqual(feature.keyFactories, ["projectKeys"]);
  assert.deepEqual(feature.queryOptions, ["projectsQuery", "shadowedQuery", "typedOnlyQuery"]);
  const operation = value.client.documents.find(document => document.name === "Projects")!;
  assert.deepEqual(feature.exports.find(item => item.name === "projectsQuery")!.documents, [operation.id]);
  assert.deepEqual(feature.exports.find(item => item.name === "shadowedQuery")!.documents, []);
  assert.deepEqual(feature.exports.find(item => item.name === "typedOnlyQuery")!.documents, []);
  assert.ok(feature.exports.find(item => item.name === "projectKeys")!.expression.includes('["projects"]'));
  assert.ok(!feature.exports.some(item => item.name === "fakeKeys" || item.name === "inventedQuery"));
});

test("missing/cyclic/ambiguous fragments and dynamic documents are explicit and cannot be loaded for execution", () => {
  for (const extra of [
    'graphql("query Broken { projects { ...Missing } }");',
    'graphql("fragment Circle on Project { ...Circle }");graphql("query Broken { projects { ...Circle } }");',
    `graphql(${JSON.stringify(name)});graphql("query Broken { projects { ...ProjectName } }");`,
  ]) {
    const root = fixture(); put(root, `${API}/projects/operations.ts`, `${source}\n${extra}`);
    const value = readGraphQLWorkspace(root), operation = value.client.documents.find(document => document.name === "Broken")!;
    assert.equal(value.client.status, "partial"); assert.equal(operation.executableSource, null); assert.ok(operation.diagnostics.length);
  }
  const root = fixture(); put(root, `${API}/projects/operations.ts`, `${source}\nconst text=readPrivateInput();graphql(text);`);
  assert.ok(readGraphQLWorkspace(root).client.diagnostics.some(item => item.code === "DOCUMENT_DYNAMIC"));
  put(root, `${API}/projects/operations.ts`, `${source}\nimport * as api from "#/api/generated";const key="graphql";api[key](readPrivateInput());`);
  assert.ok(readGraphQLWorkspace(root).client.diagnostics.some(item => item.code === "DOCUMENT_FORM"));
});

test("inventory caching depends only on narrow source metadata and invalidates edits without native inspection", () => {
  const root = fixture(), before = readGraphQLWorkspace(root);
  assert.equal(readGraphQLWorkspace(root), before);
  put(root, "unrelated/private/.env", "must not be inspected");
  put(root, "node_modules/bad.js", "throw new Error('must not inspect dependencies');");
  assert.equal(readGraphQLWorkspace(root), before);
  put(root, `${API}/projects/operations.ts`, `${source}\n// saved source edit`);
  const after = readGraphQLWorkspace(root); assert.notEqual(after.revision, before.revision);
  assert.notEqual(after, before);
});

test("a typed generated string must match both authored AST and its map export before providing available provenance", () => {
  const root = fixture();
  put(root, `${API}/generated/graphql.ts`, `export const Document2=new TypedDocumentString("query Projects { projects { id } }");`);
  const value = readGraphQLWorkspace(root), operation = value.client.documents.find(document => document.name === "Projects")!;
  assert.equal(operation.generated.status, "unknown");
  assert.ok(operation.executableSource?.includes("ProjectSummary"));
});

test("missing/invalid generated schema and source symlinks remain independent and never expose outside bytes", () => {
  const root = fixture(); rmSync(path.join(root, SCHEMA));
  let value = readGraphQLWorkspace(root); assert.equal(value.schema.status, "missing"); assert.equal(value.client.documents.length, 3);
  put(root, SCHEMA, "type Query { bad: Missing }");
  assert.equal(readGraphQLWorkspace(root).schema.status, "invalid");
  const outside = mkdtempSync(path.join(os.tmpdir(), "studio-inventory-outside-")); roots.push(outside);
  writeFileSync(path.join(outside, "secret.ts"), 'graphql("query PRIVATE_SENTINEL { secrets }")');
  symlinkSync(path.join(outside, "secret.ts"), path.join(root, API, "linked.ts"));
  value = readGraphQLWorkspace(root);
  assert.equal(value.client.status, "partial"); assert.ok(!JSON.stringify(value).includes("PRIVATE_SENTINEL"));
  rmSync(path.join(root, SCHEMA)); symlinkSync(path.join(outside, "secret.ts"), path.join(root, SCHEMA));
  assert.equal(readGraphQLWorkspace(root).schema.status, "invalid");
});

test("oversized source refuses bounded reads and malformed source remains an explicit partial inventory", () => {
  const root = fixture(); put(root, `${API}/large.ts`, "x".repeat(512 * 1024 + 1));
  let value = readGraphQLWorkspace(root); assert.equal(value.client.status, "partial"); assert.ok(value.client.diagnostics.some(item => item.code === "SOURCE_READ"));
  rmSync(path.join(root, API, "large.ts")); put(root, `${API}/broken.ts`, "export const broken = {");
  value = readGraphQLWorkspace(root); assert.ok(value.client.diagnostics.some(item => item.code === "TYPESCRIPT_INVALID"));
  assert.equal(existsSync(path.join(root, "node_modules")), false);
});

test("the actual repository inventories six operations and real TanStack exports from saved source", () => {
  const root = testProjectRoot, value = readGraphQLWorkspace(root);
  assert.equal(value.schema.status, "available"); assert.equal(value.client.status, "available");
  assert.equal(value.client.documents.filter(document => document.kind !== "fragment").length, 6);
  assert.deepEqual(value.client.features.find(feature => feature.file.endsWith("projects/operations.ts"))!.mutationOptions, ["deleteProjectMutation", "createProjectMutation", "setProjectArchivedMutation"]);
  assert.equal(readFileSync(path.join(root, SCHEMA), "utf8"), value.schema.sdl);
});

test("table exposure evidence follows registered aliases and is unavailable for a stale or opaque registration", () => {
  const root = fixture(), entry = "compute/http/graphql-api/schema/index.ts", feature = "compute/http/graphql-api/schema/cases.ts";
  put(root, SCHEMA, "type Query { draft: Draft } type Draft { _access: Boolean }");
  put(root, entry, 'import "./cases";');
  const registration = 'import { tableObject as register } from "../lib/table-access"; register("Case", builder.objectRef("Draft"));';
  put(root, feature, registration);
  assert.deepEqual(readGraphQLWorkspace(root).schema.tableTypes, { Case: ["Draft"] });
  put(root, feature, registration.replace('"Draft"', '"SavedDraft"'));
  assert.equal(readGraphQLWorkspace(root).schema.tableTypes, undefined);
  put(root, feature, registration.replace('"Case"', 'someModel'));
  assert.equal(readGraphQLWorkspace(root).schema.tableTypes, undefined);
  put(root, feature, registration.replace('"Case"', '"CaseIntake"'));
  assert.deepEqual(readGraphQLWorkspace(root).schema.tableTypes, { CaseIntake: ["Draft"] });
});

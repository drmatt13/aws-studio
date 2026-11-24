import type { GraphQLWorkspace } from "../../shared/graphql-workspace";

export function graphqlWorkspaceFixture(): GraphQLWorkspace {
  const query = "query Projects { projects { ...ProjectSummary } }", fragment = "fragment ProjectSummary on Project { id name }", mutation = "mutation CreateProject($data: CreateProjectInput!) { createProject(data: $data) { project { id name } } }";
  const file = "client-app/src/api/projects/operations.ts";
  return { revision: "workspace-fixture", schema: { status: "available", file: "client-app/src/api/generated/schema.graphql", sdl: "type Query { projects: [Project!]! }", roots: { query: "Query", mutation: "Mutation", subscription: null }, diagnostics: [], types: [
    { name: "Query", kind: "object", description: null, definition: "type Query { projects: [Project!]! }", fields: [{ name: "projects", type: "[Project!]!", description: null, defaultValue: null, args: [], deprecationReason: null }], enumValues: [], members: [], interfaces: [] },
    { name: "Project", kind: "object", description: "A project owned by the current user.", definition: "type Project { id: ID! name: String! }", fields: ["id", "name"].map(name => ({ name, type: name === "id" ? "ID!" : "String!", description: null, defaultValue: null, args: [], deprecationReason: null })), enumValues: [], members: [], interfaces: [] },
  ] }, client: { status: "available", diagnostics: [], documents: [
    { id: "projects", name: "Projects", kind: "query", file, line: 7, source: query, executableSource: `${query}\n${fragment}`, fragmentNames: ["ProjectSummary"], selections: ["projects", "projects.id", "projects.name"], generated: { status: "available", exportName: "ProjectsDocument", source: "export const ProjectsDocument = 'query Projects ...';", hash: "a".repeat(64) }, diagnostics: [] },
    { id: "project-summary", name: "ProjectSummary", kind: "fragment", file, line: 1, source: fragment, executableSource: null, fragmentNames: [], selections: ["id", "name"], generated: { status: "available", exportName: "ProjectSummaryFragmentDoc", source: null, hash: null }, diagnostics: [] },
    { id: "create-project", name: "CreateProject", kind: "mutation", file, line: 15, source: mutation, executableSource: mutation, fragmentNames: [], selections: ["createProject", "createProject.project", "createProject.project.id", "createProject.project.name"], generated: { status: "available", exportName: "CreateProjectDocument", source: null, hash: "b".repeat(64) }, diagnostics: [] },
  ], features: [{ file, queryOptions: ["projectsQuery"], mutationOptions: ["createProjectMutation"], keyFactories: ["projectKeys"], documents: ["projects", "project-summary", "create-project"], exports: [
    { name: "projectsQuery", kind: "query-options", line: 35, documents: ["projects"], expression: "queryOptions({ queryKey: projectKeys.list(), queryFn: () => executeGraphQL(ProjectsDocument) })" },
    { name: "projectKeys", kind: "key-factory", line: 30, documents: [], expression: '{ all: ["projects"] as const, list: () => [...projectKeys.all, "list"] as const }' },
    { name: "createProjectMutation", kind: "mutation-options", line: 40, documents: ["create-project"], expression: "mutationOptions({ mutationFn: variables => executeGraphQL(CreateProjectDocument, variables) })" },
  ] }] } };
}

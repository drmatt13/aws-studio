import type { GraphQLWorkspace, GraphQLRuntime, GraphQLExecution, GraphQLExecuteRequest } from "../shared/graphql-workspace";
import { call } from "./http";

export const graphqlWorkspaceApi = {
  load: (signal?: AbortSignal) => call<GraphQLWorkspace>("/graphql/workspace", undefined, signal),
  runtime: (signal?: AbortSignal) => call<GraphQLRuntime>("/graphql/runtime", undefined, signal),
  execute: (request: GraphQLExecuteRequest, signal?: AbortSignal) => call<GraphQLExecution>("/graphql/execute", request, signal),
};

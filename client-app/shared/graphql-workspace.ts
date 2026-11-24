export interface WorkspaceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}
export interface GraphQLArgument {
  readonly name: string;
  readonly type: string;
  readonly description: string | null;
  readonly defaultValue: string | null;
}
export interface GraphQLField extends GraphQLArgument {
  readonly args: readonly GraphQLArgument[];
  readonly deprecationReason: string | null;
  readonly source?: { readonly file: "client-app/src/api/generated/schema.graphql"; readonly line: number };
}
export interface GraphQLType {
  readonly name: string;
  readonly kind: "scalar" | "object" | "interface" | "union" | "enum" | "input";
  readonly description: string | null;
  readonly definition: string;
  readonly fields: readonly GraphQLField[];
  readonly enumValues: readonly { readonly name: string; readonly description: string | null; readonly deprecationReason: string | null }[];
  readonly members: readonly string[];
  readonly interfaces: readonly string[];
}
export interface GraphQLSchemaInventory {
  readonly status: "available" | "missing" | "invalid";
  readonly file: "client-app/src/api/generated/schema.graphql";
  readonly sdl: string | null;
  readonly roots: Readonly<Record<"query" | "mutation" | "subscription", string | null>>;
  readonly types: readonly GraphQLType[];
  /** Literal table registrations corroborated by the generated schema. */
  readonly tableTypes?: Readonly<Record<string, readonly string[]>>;
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}
export interface GraphQLDocument {
  readonly id: string;
  readonly name: string;
  readonly kind: "query" | "mutation" | "subscription" | "fragment";
  readonly file: string;
  readonly line: number;
  readonly source: string;
  readonly executableSource: string | null;
  readonly fragmentNames: readonly string[];
  /** Actual GraphQL field paths, with known fragment spreads expanded. */
  readonly selections: readonly string[];
  readonly generated: {
    readonly status: "available" | "missing" | "unknown";
    readonly exportName: string | null;
    readonly source: string | null;
    readonly hash: string | null;
  };
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}
export interface GraphQLClientExport {
  readonly name: string;
  readonly kind: "query-options" | "mutation-options" | "key-factory";
  readonly line: number;
  readonly documents: readonly string[];
  /** Exact authored expression; dynamic keys are never evaluated or invented. */
  readonly expression: string;
}
export interface GraphQLFeature {
  readonly file: string;
  readonly queryOptions: readonly string[];
  readonly mutationOptions: readonly string[];
  readonly keyFactories: readonly string[];
  readonly documents: readonly string[];
  readonly exports: readonly GraphQLClientExport[];
}
export interface GraphQLClientInventory {
  readonly status: "available" | "partial" | "missing" | "invalid";
  readonly documents: readonly GraphQLDocument[];
  readonly features: readonly GraphQLFeature[];
  readonly diagnostics: readonly WorkspaceDiagnostic[];
}
/** Bounded source inventory, independent of native deep evaluation and runtime state. */
export interface GraphQLWorkspace {
  readonly revision: string;
  readonly schema: GraphQLSchemaInventory;
  readonly client: GraphQLClientInventory;
}

export interface GraphQLRuntime {
  readonly status: "ready" | "starting" | "stopped" | "blocked" | "unavailable";
  readonly endpoint: string | null;
  readonly message: string;
}
export interface GraphQLExecuteRequest {
  readonly document: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly operationName?: string;
  readonly idToken: string;
  readonly confirmMutation?: true;
}
export interface GraphQLExecution {
  readonly status: number;
  readonly body: unknown;
  readonly durationMs: number;
}

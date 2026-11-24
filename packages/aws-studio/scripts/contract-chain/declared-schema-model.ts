// Node-free: the declared PostgreSQL schema and database-contract evidence as data. Browser code
// may name these as types; the parser and compiler live in declared-schema.ts and
// database-contract-source.ts.
import type { FieldAccessMode, RowAccessKind } from "../../database/client-access";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

export interface SchemaColumn {
  readonly name: string;
  readonly column: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly default?: string;
  readonly source: SourceLocation;
  /** The field's `// @access` setting in contract.prisma; absent means managed in application code. */
  readonly access?: FieldAccessMode;
}

export interface SchemaIndex {
  readonly name?: string;
  readonly kind: "primary" | "unique" | "index";
  readonly fields: readonly string[];
  readonly predicate?: string;
  readonly declaration: string;
  readonly source: SourceLocation;
}

export interface SchemaTable {
  readonly id: string;
  readonly model: string;
  readonly namespace: string;
  readonly table: string;
  readonly columns: readonly SchemaColumn[];
  readonly indexes: readonly SchemaIndex[];
  readonly source: SourceLocation;
  /** Who may see the table's rows through the GraphQL API, from its `// @access` row rules. */
  readonly rows?: { readonly exposed: boolean; readonly sentence: string };
}

export interface SchemaRelationAccess {
  readonly kind: RowAccessKind;
  /** The endpoint whose rows this rule makes visible, not the FK's direction. */
  readonly side: "from" | "to";
  readonly field: string;
  readonly filter?: string;
  readonly source: SourceLocation;
}

export interface SchemaRelation {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly fields: readonly string[];
  readonly references: readonly string[];
  readonly cardinality: "1:1" | "N:1";
  readonly nullable: boolean;
  readonly onDelete: string;
  readonly onUpdate: string;
  readonly source: SourceLocation;
  /** Rules on either relation endpoint, including a list-side back reference. */
  readonly access?: readonly SchemaRelationAccess[];
}

export interface DeclaredSchema {
  readonly file: string;
  readonly hash: string;
  readonly tables: readonly SchemaTable[];
  readonly relations: readonly SchemaRelation[];
  readonly enums: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly problems: readonly string[];
}

export interface DatabaseDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
}

export interface DatabaseValidation {
  readonly sourceHash: string;
  readonly valid: boolean;
  readonly diagnostics: readonly DatabaseDiagnostic[];
  readonly schema?: DeclaredSchema;
  readonly storageHash?: string;
  readonly executionHash?: string;
  readonly validatedAt: string;
}

export interface EmittedContractEvidence {

  readonly status: "matches" | "differs" | "missing" | "invalid" | "unknown";
  readonly file: string;
  readonly revision: string;
  readonly observedAt: string;
  readonly storageHash?: string;
  readonly executionHash?: string;
  readonly storageMatches?: boolean;
  readonly executionMatches?: boolean;
  readonly message: string;
}

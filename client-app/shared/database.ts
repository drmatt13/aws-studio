import type { SourceLocation } from "./model";

/** A Compose service, kept separate from the AWS resource catalog. No connection values. */
export interface LocalDatabase {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly image: string;
  readonly volumes: readonly string[];
  readonly source: SourceLocation;
  readonly enabled: boolean;
}

export type { SchemaColumn, SchemaIndex, SchemaTable, SchemaRelationAccess, SchemaRelation, DeclaredSchema } from "aws-studio/contract-chain/declared-schema-model";

import type { DatabaseDiagnostic, DatabaseValidation, EmittedContractEvidence } from "aws-studio/contract-chain/declared-schema-model";
export type { DatabaseDiagnostic, DatabaseValidation, EmittedContractEvidence };
import type { AccessModules } from "aws-studio/database/access-graph";
import type { ChainDiff } from "aws-studio/contract-chain/graphql-chain";
import type { ContractStage } from "./contract-propagation";

/** The generated identity cap compares any of these row columns to the verified application user ID. */
export function fieldReaderCondition(model: string, fields: readonly string[]): string {
  return [...fields].sort().map(field => `${model}.${field} == auth.id`).join(" or ");
}

/** Offsets are UTF-16 editor positions. All ranges refer to the exact sourceHash. */
export interface DatabaseTarget {
  readonly id: "local:postgres" | "production";
  readonly label: string;
  readonly available: boolean;
  readonly detail: string;
  /** Hash of resolved private identity, never a connection string or credential. */
  readonly identity: string;
  readonly handoffs?: readonly { readonly deployment: string; readonly account?: string; readonly region?: string; readonly command: string; readonly detail: string }[];
}

export interface DatabaseWorkbench {
  readonly file: string;
  readonly source: string;
  /** The compiled access policy module (Access Graph guards, permissions, commands), from the last generation. */
  readonly accessModules?: AccessModules;
  /** Content revision, independent from framework snapshot generations. */
  readonly revision: string;
  /** Opaque per-server identity of configuration, imported local modules and private inputs. */
  readonly configRevision: string;
  readonly validation: DatabaseValidation;
  readonly capabilities: {
    readonly dialect: string;
    readonly semanticValidation: boolean;
    readonly formatting: boolean;
    readonly languageServer: boolean;
    readonly notes: readonly string[];
  };
  readonly targets: readonly DatabaseTarget[];
  /**
   * The GraphQL API's authorization record, when the repository has one: each
   * swept root operation and the contract.prisma rules it consulted, derived by
   * its executable tests. Evidence for "used by", never an authority.
   */
  readonly authorization?: { readonly operations: Readonly<Record<string, readonly string[]>> };
  readonly emitted?: EmittedContractEvidence;
}

export interface DatabaseSourceReview {
  readonly reviewId: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly expectedRevision: string;
  readonly configRevision: string;
  readonly sourceHash: string;
  readonly expiresAt: string;
  readonly validation: DatabaseValidation;
  readonly effects: readonly string[];
  /** Source-only comparison shown before saving the reviewed draft. */
  readonly contractImpact?: DatabaseContractImpact;
}

export interface DatabaseSaveResult {
  readonly saved: true;
  readonly revision: string;
  readonly source: string;
  readonly file: string;
  /** Source success is reported independently from a graph-refresh failure. */
  readonly refresh: "complete" | "unavailable";
  readonly message: string;
  /** Immediate saved-source impact, not an expensive inspection or verification receipt. */
  readonly contractImpact?: DatabaseContractImpact;
}

export interface DatabaseContractImpact {
  readonly revision: string;
  readonly beforeRevision: string;
  readonly models: readonly string[];
  readonly diffs: readonly ChainDiff[];
  /** Effective Access Graph changes. Eligibility describes policy, independently of the GraphQL surface. */
  readonly accessChanges?: readonly ChainDiff[];
  readonly semantics: "changed" | "unchanged" | "unknown";
  readonly stages: readonly ContractStage[];
  readonly earliestStage: ContractStage | null;
}

export interface DatabaseObservation {
  readonly id: string;
  readonly targetId: DatabaseTarget["id"];
  readonly targetIdentity: string;
  readonly observedAt: string;
  readonly savedRevision: string;
  readonly historyRevision: string;
  readonly baseline: { readonly label: string; readonly storageHash?: string };
  readonly status: "observed" | "unreachable" | "unsupported" | "stale";
  readonly marker: { readonly status: "matches" | "differs" | "missing" | "unknown"; readonly storageHash?: string; readonly updatedAt?: string };
  readonly physical: { readonly status: "matches" | "differs" | "unknown"; readonly issues: readonly string[]; readonly warnings: readonly string[] };
  readonly historicalPhysical?: { readonly storageHash: string; readonly status: "matches" | "differs" | "unknown"; readonly issues: readonly string[]; readonly warnings: readonly string[] };
  readonly migrationState: { readonly status: "current" | "pending" | "divergent" | "unknown"; readonly message: string };
  readonly ledger: readonly { readonly migrationHash: string; readonly name: string; readonly from: string | null; readonly to: string; readonly appliedAt: string }[];
  readonly message: string;
  readonly limits: readonly string[];
}

/** Source-only GraphQL data-chain evidence. No deployment or database state. */
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export type ChainNodeId = "prisma" | "pothos" | "generated" | "client";
export type LinkId = "prisma-pothos" | "pothos-generated" | "generated-client";
export type Fingerprint = { readonly status: "available"; readonly value: string }
  | { readonly status: "unavailable"; readonly diagnostics: readonly Diagnostic[] };

export interface ChainNode {
  readonly id: ChainNodeId;
  readonly caption: string;
  readonly name: string;
  readonly source: string;
  readonly fingerprint: Fingerprint;
  /** The upstream stage's output hash recorded when this stage was last run (the ledger's source). */
  readonly reviewedAgainst: string | null;
  /** Current semantic equivalent of an exactly matched legacy upstream source hash. */
  readonly normalizedReviewedAgainst?: string;
  /** This stage's own output hash recorded when it was last run (the ledger's output). */
  readonly recordedOutput?: string | null;
  /** The tracked review receipt still matches the saved source projection. */
  readonly approvalRecorded?: boolean;
}

/** One stage of the hash ledger: which upstream content it was produced from, and what it produced. */
export type LedgerStage = "api" | "codegen" | "client";
export interface ChainLedgerEntry { readonly source: string; readonly output: string; readonly recordedAt: string }
export type ChainLedger = Readonly<Partial<Record<LedgerStage, ChainLedgerEntry>>>;

export interface ChainDiff {
  readonly surface: "prisma" | "sdl";
  readonly subject: string;
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  readonly before: string | null;
  readonly after: string | null;
}

export type ReviewState = { readonly status: "reviewed"; readonly current: string; readonly reviewedAgainst: string }
  | { readonly status: "changed"; readonly diffs: readonly ChainDiff[] }
  | { readonly status: "no-review"; readonly diffs?: readonly ChainDiff[] }
  | { readonly status: "unknown"; readonly diagnostics: readonly Diagnostic[] };

export type GeneratedState = { readonly status: "current" }
  | { readonly status: "out-of-date"; readonly reasons: readonly ("schema-changed" | "documents-changed" | "generated-files-changed")[]; readonly files: readonly string[] }
  | { readonly status: "unknown"; readonly diagnostics: readonly Diagnostic[] };

export interface DocumentProblem {
  readonly document: string;
  readonly file: string;
  readonly line: number | null;
  readonly message: string;
}

export type ClientState = ReviewState | { readonly status: "invalid"; readonly problems: readonly DocumentProblem[] };
export type CheckEvidence = { readonly status: "passed" }
  | { readonly status: "failed" | "blocked" | "unavailable"; readonly diagnostics: readonly Diagnostic[] };
/** Current independent checks; a matching content hash alone never establishes these. */
export interface ChainVerification {
  readonly database: CheckEvidence;
  readonly api: CheckEvidence;
  readonly client: CheckEvidence;
  readonly consumers: CheckEvidence;
  readonly integration: CheckEvidence;
}
export type DependencyId = "prisma" | "database-artifacts" | "repository-pothos" | "executable-schema" | "authored-documents" | "codegen" | "typed-documents" | "react-query" | "consumers";
export interface ChainDependency {
  readonly id: DependencyId;
  readonly requires: readonly DependencyId[];
}
export interface ChainConfidence {
  readonly status: "verified" | "blocked" | "stale" | "failed" | "unavailable";
  readonly blockedBy: readonly DependencyId[];
  readonly diagnostics: readonly Diagnostic[];
}
export type ReviewScope = { readonly kind: "baseline" } | { readonly kind: "model"; readonly model: string } | { readonly kind: "api" } | { readonly kind: "client" };
export type ChainAction = { readonly kind: "command"; readonly command: string }
  | { readonly kind: "acknowledge"; readonly scope: ReviewScope }
  | { readonly kind: "agent"; readonly link: LinkId };

export type ChainLink = { readonly confidence: ChainConfidence } & ({
  readonly id: "prisma-pothos";
  readonly kind: "reviewed";
  readonly state: ReviewState;
  readonly models: Readonly<Record<string, ReviewState>>;
  readonly actions: readonly ChainAction[];
} | {
  readonly id: "pothos-generated";
  readonly kind: "derived";
  readonly state: GeneratedState;
  readonly checks: Readonly<Record<"schema" | "documents" | "generated-files", CheckEvidence>>;
  readonly actions: readonly ChainAction[];
} | {
  readonly id: "generated-client";
  readonly kind: "derived-then-reviewed";
  readonly state: ClientState;
  readonly validation: CheckEvidence;
  readonly actions: readonly ChainAction[];
});

export interface GraphQLChain {
  readonly version: 3;
  readonly proof: import("./contract-proof").ContractProofView;
  /** Deep evidence is checked outside the Studio request process. */
  readonly inspection?: { readonly status: "checking" | "ready" | "stale" | "failed"; readonly checkedAt?: string; readonly message?: string; readonly diagnostics?: readonly Diagnostic[] };
  /** Source-only hash read, independent of the executable inspection. */
  readonly fingerprints?: "checking" | "ready" | "failed";
  readonly revision: string;
  readonly nodes: readonly ChainNode[];
  readonly links: readonly ChainLink[];
  readonly dependencies: readonly ChainDependency[];
  readonly verification: ChainVerification;
  /** Previous observations are explanatory history, never current proof or write authority. */
  readonly history?: { readonly revision: string; readonly checkedAt?: string; readonly nodes: readonly ChainNode[]; readonly links: readonly ChainLink[] };
  readonly record: "missing" | "available" | "invalid";
}

export interface PrismaModelShape {
  /** Authorization comments are API contract changes even when storage is unchanged. */
  readonly policies?: readonly string[];
  readonly enumPolicies?: Readonly<Record<string, readonly string[]>>;
  /** Named PostgreSQL CHECK constraints, included in review identity and diffs. */
  readonly checks?: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, {
    readonly type: string;
    readonly nullability: "required" | "optional";
    readonly default: string | null;
    /** The field's `// @access` setting; absent when the field has none. ("editable" only in older records.) */
    readonly access?: "server-only" | "read-only" | "editable";
  }>>;
  readonly relations: Readonly<Record<string, {
    readonly target: string;
    readonly multiplicity: "one" | "many";
    readonly nullability: "required" | "optional";
    readonly fields: readonly string[];
    readonly references: readonly string[];
    readonly onDelete: string | null;
    readonly onUpdate: string | null;
    /** The relation's `// @access` row rule, such as `members(status: ACTIVE)`; absent without one. */
    readonly access?: string;
  }>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
}

export interface SdlSurface {
  readonly schemaDefinition: string;
  readonly types: Readonly<Record<string, {
    readonly kind: "scalar" | "object" | "interface" | "union" | "enum" | "input";
    readonly definition: string;
  }>>;
  readonly directives: Readonly<Record<string, string>>;
}

/** Review evidence only; behavior/exposure choices remain ordinary source. */
interface ReviewSurfaces {
  readonly prisma: { readonly models: Readonly<Record<string, PrismaModelShape>> } | null;
  readonly client: SdlSurface | null;
}
export interface ReviewBindings {
  readonly api: string | null;
  readonly client: { readonly inputs: string; readonly upstream: string } | null;
}
export type GraphQLChainReviewRecord = ReviewSurfaces & ({ readonly version: 1 } | { readonly version: 2; readonly bindings: ReviewBindings } | { readonly version: 3; readonly bindings: ReviewBindings; readonly proofs: import("./contract-proof").ContractProofReceipts; readonly ledger?: ChainLedger });
export type GraphQLChainReviewRecordV2 = Extract<GraphQLChainReviewRecord, { readonly version: 2 }>;
export type GraphQLChainReviewRecordV3 = Extract<GraphQLChainReviewRecord, { readonly version: 3 }>;

export interface ReviewRequest { readonly expectedRevision: string; readonly scope: ReviewScope; readonly decisions?: import("./contract-proof").ReviewDecisions }
export interface ContractRenewalRequest {
  readonly expectedRevision: string;
  readonly stage: LedgerStage;
  readonly run: "stage" | "sequential";
}
export type ContractRenewalResult = { readonly status: "recorded"; readonly message: string } | { readonly status: "remediation-required" };
export interface ReviewPlan {
  readonly reviewId: string;
  readonly expectedRevision: string;
  readonly expiresAt: string;
  readonly file: "graphql-chain.review.json";
  readonly before: string | null;
  readonly after: string;
  readonly effects: readonly string[];
}
export interface AcceptRequest { readonly reviewId: string; readonly expectedRevision: string }
export interface AcceptResult { readonly status: "recorded"; readonly revision: string; readonly message: string }

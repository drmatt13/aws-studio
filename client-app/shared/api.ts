import type { Diagnostic, FieldFact, Lanes, Mode, Placement, Snapshot } from "./model";

/**
 * The studio's HTTP contract: what the browser sends, what the server answers.
 * Types only, shared by both halves so neither re-declares the other's shapes.
 */

export type LiteralValue = string | number | boolean;

export interface CommentReviewOptions {
  readonly comments?: Readonly<Record<string, "keep" | "remove">>;
}

/** A comment touched by a supported source removal, bound to its saved bytes. */
export interface SourceCommentReview {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly resolution: "keep" | "remove";
  readonly vscodeUrl: string;
  /** Directives must be resolved in source so they cannot attach to different code. */
  readonly manualReason?: string;
}

export interface EditIntent {
  readonly target: string;
  readonly field: string;
  /** The new value; omitted with `inherit`. */
  readonly value?: LiteralValue;
  /** Remove the property, so the cascade decides. */
  readonly inherit?: true;
}

export type DeployValue = import("./model").DeploySetting | "inherit" | { readonly when: { readonly resource: string; readonly equals: string } };

export type DraftEdit =
  | { readonly kind: "frameworkUpgrade" }
  | import("./permission-rules").IamPolicyEdit
  | { readonly kind: "agentGateways"; readonly target: string; readonly gateways: readonly string[] }
  | { readonly kind: "gatewayTools"; readonly gateway: string; readonly tools: readonly string[] }
  | { readonly kind: "gatewayDeploy"; readonly gateway: string; readonly value: DeployValue }
  | { readonly kind: "removeGateway"; readonly gateway: string }
  | import("./private-dns").PrivateZoneEdit
  | { readonly kind: "rename"; readonly entity: string; readonly name: string }
  | { readonly kind: "displayName"; readonly entity: string; readonly value: string | null }
  | { readonly kind: "resourceConfig"; readonly intent: import("./resources").ResourceIntent }
  | { readonly kind: "deploy"; readonly target: string; readonly value: DeployValue }
  | import("./identity-policy").IdentityPolicyEdit
  | { readonly kind: "implementation"; readonly target: string }
  | { readonly kind: "connection"; readonly target: string; readonly connection: "database" | "userPool" | "runsTask" | "startsWorkflow" | "invokesAgent" | "resource" | "grant" | "resourceAccess" | "managedPolicy"; readonly destination?: string; readonly enabled: boolean; readonly variable?: string; readonly grant?: string; readonly grantArguments?: readonly import("aws-studio/config/cdk-resources").JsonArgument[]; readonly previousGrant?: { readonly method: string; readonly arguments: readonly import("aws-studio/config/cdk-resources").JsonArgument[] }; readonly scope?: string; readonly actions?: readonly import("aws-studio/config/resource-access").ResourceAccessAction[]; readonly limits?: import("aws-studio/config/resource-access").ResourceAccessLimits; readonly previous?: import("aws-studio/config/resource-access").ResourceAccessOptions }
  | { readonly kind: "removeWorkload"; readonly target: string }
  | { readonly kind: "tags"; readonly entity: string; readonly tags: Readonly<Record<string, string>> }
  /** The Framework managed toggle: `"framework"` writes `managedBy`, `null` removes it. */
  /** An ownership transition: reviewed on its own, always writing an explicit owner. */
  | { readonly kind: "ownership"; readonly entity: string; readonly managedBy: "framework" | "developer" }
  | import("./managed-database").DatabasePlacementEdit
  | { readonly kind: "removeNetwork"; readonly network: string }
  | { readonly kind: "database"; readonly database: string; readonly settings: import("aws-studio/config/database").DatabaseSettingsInput }
  | ({ readonly kind: "placement" } & import("./networks").PlacementEdit)
  | { readonly kind: "network"; readonly network: string; readonly settings: import("./networks").NetworkSettings }
  | { readonly kind: "create"; readonly request: import("./creation").CreationRequest }
  | { readonly kind: "clientEnvironment"; readonly mappings: import("./client-environment").ClientEnvironmentMappings }
  | { readonly kind: "triggers"; readonly event: string; readonly bindings: readonly import("./triggers").TriggerBinding[] }
  /** Delete one recognized native trigger (a source edge id) from its CDK stack file. */
  | { readonly kind: "nativeTrigger"; readonly edge: string }
  /** Set an event's onFailure destination, or remove it with null. */
  | { readonly kind: "onFailure"; readonly event: string; readonly value: import("./triggers").FailureDestinationSettings | null }
  | { readonly kind: "description"; readonly entity: string; readonly value: string }
  | { readonly kind: "field"; readonly intent: EditIntent }
  | { readonly kind: "route"; readonly route: string; readonly value: string };

export interface BatchPlanResponse {
  readonly activatesDependencies?: true;
  readonly rename?: import("./naming").RenameSummary;
  readonly renameIssues?: readonly import("./naming").RenameIssue[];
  /** Preview only. Clients remap live selection after confirmed application. */
  readonly entityRemap?: Readonly<Record<string, string>>;
  readonly comments?: readonly SourceCommentReview[];
  readonly planId: string;
  readonly summaries: readonly string[];
  readonly changes: readonly { readonly file: string; readonly diff: PlanResponse["diff"]; readonly operation?: "create" | "modify" | "delete" }[];
  readonly preflight: { readonly dev: PreflightResult; readonly prod: PreflightResult };
  readonly ok: boolean;
  readonly impact: readonly string[];
  /** Canonical identity to focus only after a confirmed creation. */
  readonly select?: string;
}

export interface DiffLine {
  /** First line of a separate unified-diff hunk. */
  readonly hunk?: string;
  readonly kind: "context" | "remove" | "add";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface PreflightResult {
  readonly mode: Mode;
  readonly ok: boolean;
  /** The framework's own messages, verbatim. */
  readonly diagnostics: readonly Diagnostic[];
  /** The field as the framework would resolve it after the change. */
  readonly predicted?: FieldFact;
  /** Where the target would run, and be placed, after the change. */
  readonly lanes?: Lanes;
  readonly placement?: Placement;
}

export interface PlanResponse {
  /** Legacy single-edit callers must review these additional generated/source files when present. */
  readonly changes?: BatchPlanResponse["changes"];
  readonly planId: string;
  readonly target: string;
  readonly field: string;
  readonly summary: string;
  readonly file: string;
  readonly diff: { readonly unified: string; readonly lines: readonly DiffLine[] };
  readonly preflight: { readonly dev: PreflightResult; readonly prod: PreflightResult };
  /** Whether both graphs accept the change; a plan that is not ok cannot be applied. */
  readonly ok: boolean;
  /** What else happens when this is written, beyond the field. */
  readonly impact: readonly string[];
  readonly lanesBefore?: Lanes;
  readonly placementBefore?: Placement;
}

export interface ApplyResponse {
  readonly entityRemap?: Readonly<Record<string, string>>;
  /** `unconfirmed`: written, not as predicted, and changed by someone else since, so left alone. */
  readonly status: "applied" | "reverted" | "unconfirmed";
  readonly message: string;
  readonly revision: string;
  readonly select?: string;
}

export interface CommandInfo {
  readonly label: string;
  readonly description: string;
  readonly writes: boolean;
}

export interface CommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

export interface SourcePublication {
  readonly status: "ready" | "busy" | "recovery_required" | "unavailable" | "refresh_required";
  readonly epoch: string;
  readonly message?: string;
}

/** An operation holds the source, or the refresh after it is publishing: ordinary work, never a failure. */
export const sourceHeld = (status: SourcePublication["status"] | undefined): boolean => status === "busy" || status === "refresh_required";
export const SOURCE_HOLD_NOTE = "Editing resumes when the operation ends.";

export interface SnapshotResponse {
  readonly frameworkUpgrade?: { readonly installed: string; readonly available: string };
  readonly sourceRecovery?: readonly import("./source-recovery").SourceRecovery[];
  readonly sourceRecoveryProblem?: string;
  readonly sourceWatch?: import("./watch").SourceWatchState;
  readonly sourcePublication?: SourcePublication;
  readonly snapshot: Snapshot;
  readonly evaluating: boolean;
  readonly commands: Readonly<Record<string, CommandInfo>>;
  readonly busy: string | null;
}

/** Server-sent events on /api/events. */
export interface SnapshotEvent {
  readonly revision: string;
  /** Files changed by something other than the studio. */
  readonly external: readonly string[];
}

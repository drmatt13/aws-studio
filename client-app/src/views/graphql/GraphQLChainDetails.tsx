import type { ChainDiff, ChainLink, ChainVerification, Diagnostic, GraphQLChain, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import { chainLinkNames, chainStatus, localChainStatus, shortFingerprint, standingExplanation, type ChainStatus } from "../../graphql-chain";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/classes";
import { Notice } from "../../ui/Surface";
import { CopyCode } from "../CopyCode";
import { DocumentCard, documentDataTableClasses, documentProseClasses, documentSubheadingClasses, documentSupportClasses, documentTableRegionClasses, documentCardTitleClasses, documentCardClasses } from "../DocumentUI";
import { workbenchCardSummaryClasses, workbenchPreClasses } from "../WorkbenchUI";
import { ChainStatusLabel } from "./ChainStatusIcon";
import type { ContractProofView, ProofStage } from "aws-studio/contract-chain/contract-proof";
import { contractStageForLink, type ContractStage } from "../../../shared/contract-propagation";
import { graphQLCodingDrafts } from "../../graphql-chain-agent-request";
import { GraphQLProofLineage } from "./GraphQLProofLineage";
import { contractPrimaryClasses } from "./GraphQLContractWorkflow";

const titles = { "prisma-pothos": "Pothos review", "pothos-generated": "Generated GraphQL", "generated-client": "Client operations review" } as const;
const changeLabels = { added: "Added", removed: "Removed", changed: "Changed" } as const;

function diffValue(diff: ChainDiff, value: string | null): string {
  if (value === null) return "—";
  if (diff.surface === "prisma") {
    try {
      const field = JSON.parse(value);
      if (field && typeof field.type === "string" && ["required", "optional"].includes(field.nullability)) return `${field.type}${field.nullability === "optional" ? "?" : ""}${field.default === null ? "" : `\nDefault: ${field.default}`}`;
    } catch { /* SDL and older literal fixture values are already display text. */ }
  }
  return value;
}
const verificationStatus: Readonly<Record<ChainVerification[keyof ChainVerification]["status"], ChainStatus>> = {
  passed: { label: "Passed", shape: "passed", tone: "accept" },
  failed: { label: "Failed", shape: "failed", tone: "refuse" },
  blocked: { label: "Waiting for upstream", shape: "pending", tone: "quiet" },
  unavailable: { label: "Unavailable", shape: "unknown", tone: "quiet" },
};
const modelStatus: Readonly<Record<"changed" | "no-review" | "unknown" | "reviewed", ChainStatus>> = {
  changed: { label: "Changed since review", shape: "attention", tone: "caution" },
  "no-review": { label: "No review recorded", shape: "pending", tone: "caution" },
  unknown: { label: "Unknown", shape: "unknown", tone: "quiet" },
  reviewed: { label: "Reviewed", shape: "passed", tone: "accept" },
};

/** GraphQL's data tables (chain differences, schema fields) share one cell treatment. */
export const graphqlTableHeadClasses = "border-b border-rule bg-[light-dark(var(--field),transparent)] px-2 py-2 text-left align-bottom text-caption font-semibold";
export const graphqlTableCellClasses = "border-b border-rule px-2 py-2 text-left align-top text-caption";
export const graphqlTableCodeCellClasses = cx(graphqlTableCellClasses, "font-mono font-normal whitespace-pre-wrap wrap-anywhere");
/** Source and SDL blocks: the workbench code frame in the code face. */
export const graphqlPreClasses = cx(workbenchPreClasses, "font-mono");

/** Notices read at the label size; under a check's row they take that row's caption size. */
function Diagnostics({ diagnostics, size = "label" }: { readonly diagnostics: readonly Diagnostic[]; readonly size?: "label" | "caption" }) {
  return <ul className={cx("m-0 grid gap-2", diagnostics.length === 1 ? "list-none p-0" : "pl-5")}>{diagnostics.map((item, index) => <li key={index}>
    <p className={cx("m-0 whitespace-pre-wrap wrap-anywhere", size === "caption" ? "text-caption" : "text-label")}>{item.message}</p>
    {item.file ? <p className="m-0 font-mono text-caption text-graphite">{item.file}{item.line ? `:${item.line}${item.column ? `:${item.column}` : ""}` : ""}</p> : null}
  </li>)}</ul>;
}

export function ChainDiffTable({ diffs }: { readonly diffs: readonly ChainDiff[] }) {
  const prisma = diffs[0]?.surface === "prisma";
  return <div role="region" aria-label={prisma ? "Prisma changes since review" : "SDL changes since review"} tabIndex={0} className={documentTableRegionClasses}>
    <table className={documentDataTableClasses}>
      <thead><tr>{[prisma ? "Prisma field" : "Type or field", "Change", "Reviewed", prisma ? "Storage type" : "Current"].map(title => <th key={title} scope="col" className={graphqlTableHeadClasses}>{title}</th>)}</tr></thead>
      <tbody>{diffs.map((diff, index) => <tr key={`${diff.path}-${index}`}>
        <th scope="row" className={graphqlTableCodeCellClasses}>{diff.path}</th>
        <td className={graphqlTableCellClasses}>{changeLabels[diff.change]}</td>
        <td className={graphqlTableCodeCellClasses}>{diffValue(diff, diff.before)}</td>
        <td className={graphqlTableCodeCellClasses}>{diffValue(diff, diff.after)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function acknowledgeLabel(scope: ReviewScope): string {
  return scope.kind === "baseline" ? "Record reviewed baseline" : scope.kind === "model" ? `Mark ${scope.model} reviewed, no API change` : scope.kind === "api" ? "Record repository and API review" : "Mark client operations reviewed, no selection change";
}

/** Placeholders the server serves before a live check: they say a check has not run, not that evidence is missing. */
const awaitingCheckCodes = new Set(["INSPECTION_STALE", "INSPECTION_CHECKING"]);

export function GraphQLChainDetails({ link, standing, verification, proof, proofCurrent = true, retained = false, onAcknowledge, pending = "idle", onDraft, onRegenerate, regenerating = false, actionDisabled = false }: {
  readonly link: ChainLink;
  /** The gate's standing for this link. The card shows the same answer as the rail. */
  readonly standing?: ChainStatus;
  readonly verification?: ChainVerification;
  readonly proof?: ContractProofView;
  readonly proofCurrent?: boolean;
  /** Latest live observation has not been superseded by a known source change. */
  readonly retained?: boolean;
  readonly onAcknowledge?: (scope: ReviewScope) => void;
  readonly pending?: "idle" | "checking" | "reviewing" | "recording";
  readonly onDraft?: (stage: ContractStage) => void;
  readonly onRegenerate?: () => void;
  readonly regenerating?: boolean;
  readonly actionDisabled?: boolean;
}) {
  const state = link.state;
  const heading = state.status === "changed" ? link.id === "prisma-pothos" ? "Changed since Pothos was last reviewed" : "Changed since client operations were last reviewed" : titles[link.id];
  const status: ChainStatus = standing ?? (pending === "checking" && (!retained || link.confidence.status !== "verified") ? { label: "Checking…", shape: "checking", tone: "quiet" } : chainStatus(link));
  // Before a live check, the ledger standing is the answer; its explanation replaces placeholder diagnostics.
  const placeholder = state.status === "unknown" && state.diagnostics.every(item => awaitingCheckCodes.has(item.code));
  const explanation = standing && (placeholder || standing.label === "In sync" || standing.label === "Waiting for upstream" || standing.label === "Regeneration needed") ? standingExplanation(standing) : undefined;
  const diagnostics = explanation && placeholder ? [] : link.confidence.diagnostics.filter(item => state.status !== "unknown" || !state.diagnostics.some(local => local.code === item.code && local.message === item.message));
  const shown = new Set([...diagnostics, ...(state.status === "unknown" ? state.diagnostics : [])].map(item => item.message));
  const checks = link.id === "prisma-pothos" ? ["database", "api"] as const : link.id === "generated-client" ? ["client", "consumers", "integration"] as const : [];
  // Each message appears once: under its check, or once below the list when several checks share it.
  const checkMessages = verification ? checks.map(name => { const check = verification[name]; return check.status === "passed" ? [] : check.diagnostics.filter(item => !shown.has(item.message)); }) : [];
  const messageChecks = new Map<string, number>();
  for (const items of checkMessages) for (const message of new Set(items.map(item => item.message))) messageChecks.set(message, (messageChecks.get(message) ?? 0) + 1);
  const sharedMessages = [...new Map(checkMessages.flat().filter(item => (messageChecks.get(item.message) ?? 0) > 1).map(item => [item.message, item])).values()];
  const checkNames = { database: "Database artifacts", api: "Repository and API behavior", client: "Operations and cache behavior", consumers: "Consumer compatibility", integration: "API and generated client integration" };
  const commands = link.actions.filter(action => action.kind === "command");
  const acknowledgements = link.actions.filter(action => action.kind === "acknowledge");
  const stage = contractStageForLink(link.id);
  const proofStages: readonly ProofStage[] = link.id === "prisma-pothos" ? ["database", "api"] : link.id === "pothos-generated" ? ["codegen"] : ["client"];
  return <DocumentCard aria-labelledby="graphql-chain-detail-heading">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h3 id="graphql-chain-detail-heading" className={documentCardTitleClasses}>{heading}</h3>
      <ChainStatusLabel status={status} className="text-caption font-medium" />
    </div>
    {link.id === "pothos-generated"
      ? onRegenerate ? <div><Button type="button" variant="primary" className={contractPrimaryClasses} disabled={actionDisabled} aria-busy={regenerating} onClick={onRegenerate}>{regenerating ? "Regenerating GraphQL…" : "Regenerate GraphQL"}</Button></div> : null
      : onDraft ? <div><Button type="button" variant="primary" className={contractPrimaryClasses} disabled={actionDisabled} onClick={() => onDraft(stage)}>{graphQLCodingDrafts[stage].label}</Button></div> : null}
    {diagnostics.length ? <Notice tone={link.confidence.status === "failed" ? "error" : "neutral"}><Diagnostics diagnostics={diagnostics} /></Notice> : null}
    <h4 className={documentSubheadingClasses}>Local evidence</h4>
    {state.status === "reviewed" ? <p className={documentProseClasses}>{link.id === "prisma-pothos" ? "Recorded model shapes match the current database contract." : "Recorded client review matches the current schema surface."}</p> : null}
    {state.status === "current" ? <p className={documentProseClasses}>{link.confidence.status === "verified" ? "The generated schema, documents and files match their source." : "Generated files match the current schema and documents; upstream confidence is reported separately."}</p> : null}
    {state.status === "no-review" ? <p className={documentProseClasses}>Record the current source as the reviewed baseline after checking {link.id === "prisma-pothos" ? "Pothos exposure" : "client selections and query options"}.</p> : null}
    {state.status === "changed" ? <ChainDiffTable diffs={state.diffs} /> : null}
    {link.id === "prisma-pothos" && state.status !== "unknown" ? <ul aria-label="Model reviews" className="m-0 grid list-none gap-2 p-0">{Object.entries(link.models).map(([name, model]) => <li key={name} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption"><strong className="font-semibold">{name}</strong><ChainStatusLabel status={modelStatus[model.status]} /></li>)}</ul> : null}
    {state.status === "out-of-date" ? <>
      <ul className="m-0 grid gap-1 pl-5 text-label">{state.reasons.map(reason => <li key={reason}>{reason === "schema-changed" ? "Schema changed." : reason === "documents-changed" ? "Documents changed." : "Generated files changed."}</li>)}</ul>
      {state.files.length ? <ul aria-label="Outdated generated files" className="m-0 grid gap-1 pl-5 font-mono text-caption">{state.files.map(file => <li key={file} className="wrap-anywhere">{file}</li>)}</ul> : null}
    </> : null}
    {state.status === "invalid" ? <ul aria-label="Invalid client documents" className="m-0 grid gap-3 pl-5">{state.problems.map((problem, index) => <li key={index}>
      <strong className="font-mono text-label">{problem.document}</strong>
      <p className="m-0 whitespace-pre-wrap text-label wrap-anywhere">{problem.message}</p>
      <p className="m-0 font-mono text-caption text-graphite">{problem.file}{problem.line ? `:${problem.line}` : ""}</p>
    </li>)}</ul> : null}
    {explanation ? <p className={documentProseClasses}>{explanation}</p> : null}
    {state.status === "unknown" && !(placeholder && explanation) ? <Notice tone="neutral"><Diagnostics diagnostics={state.diagnostics} /></Notice> : null}
    {verification && checks.length && !(placeholder && explanation && checks.every(name => verification[name].status === "unavailable")) ? <div className="grid gap-2">
      <ul aria-label="Independent verification" className="m-0 grid list-none gap-2 p-0">{checks.map((name, index) => {
        const own = checkMessages[index]!.filter(item => messageChecks.get(item.message) === 1);
        return <li key={name} className="grid gap-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption"><strong className="font-semibold">{checkNames[name]}<span className="sr-only">: </span></strong><ChainStatusLabel status={verificationStatus[verification[name].status]} /></span>
          {own.length ? <Diagnostics diagnostics={own} size="caption" /> : null}
        </li>;
      })}</ul>
      {sharedMessages.length ? <Diagnostics diagnostics={sharedMessages} size="caption" /> : null}
    </div> : null}
    {proof ? <GraphQLProofLineage proof={proof} stages={proofStages} current={retained && link.confidence.status === "verified" || proofCurrent && pending !== "checking"} /> : null}
    {commands.map(action => <CopyCode key={action.command} code={action.command} label="command" />)}
    {state.status === "changed" && link.id === "prisma-pothos" ? <p className={documentSupportClasses}>A database change needs review; it does not grant permission to expose a field.</p> : null}
    {onAcknowledge && acknowledgements.length ? <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">{acknowledgements.map(action => <Button key={action.scope.kind === "model" ? action.scope.model : action.scope.kind} type="button" disabled={pending !== "idle"} aria-busy={pending === "reviewing"} onClick={() => onAcknowledge(action.scope)}>{acknowledgeLabel(action.scope)}</Button>)}</div>
      {pending === "reviewing" ? <p role="status" className={documentSupportClasses}>Preparing review…</p> : null}
      <p className={documentSupportClasses}>Updates only graphql-chain.review.json; application source is unchanged.</p>
    </div> : null}
  </DocumentCard>;
}

/** One existing cached observation, explicitly historical and incapable of acknowledgement. */
export function GraphQLChainHistory({ history }: { readonly history: NonNullable<GraphQLChain["history"]> }) {
  const checkedAt = history.checkedAt && !Number.isNaN(Date.parse(history.checkedAt)) ? new Date(history.checkedAt).toLocaleString() : history.checkedAt;
  return <details className={documentCardClasses("text-caption")}>
    <summary className={workbenchCardSummaryClasses}>Previous check{checkedAt ? <> · <span className="font-normal text-graphite">{checkedAt}</span></> : null}</summary>
    <p className={documentSupportClasses}>Historical evidence for source revision {shortFingerprint(history.revision)}. It does not establish current confidence.</p>
    <ul aria-label="Previous local evidence" className="m-0 grid gap-1 pl-5">{history.links.map(link => <li key={link.id}>{chainLinkNames[link.id]}: {localChainStatus(link).label}</li>)}</ul>
    <ul aria-label="Previous fingerprints" className="m-0 grid gap-1 pl-5">{history.nodes.map(node => <li key={node.id}>{node.caption}: <span className="font-mono break-all">{node.fingerprint.status === "available" ? node.fingerprint.value : "Unavailable"}</span></li>)}</ul>
  </details>;
}

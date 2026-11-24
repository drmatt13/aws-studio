import type { ContractProofReceipt, ContractProofView, ProofStage, ProofStageView } from "aws-studio/contract-chain/contract-proof";
import { useState } from "react";
import { shortFingerprint } from "../../graphql-chain";
import { documentDisclosureClasses, documentSubheadingClasses, documentSummaryClasses, documentSupportClasses } from "../DocumentUI";

const stageNames: Readonly<Record<ProofStage, string>> = { database: "Database contract", api: "Repository and API", codegen: "Generated GraphQL", client: "Client operations" };
const statusNames = { verified: "Verified by current checks", blocked: "Waiting for predecessor proof", stale: "Needs renewed proof", failed: "Independent checks failed", unavailable: "Current evidence unavailable" } as const;
const checkNames = { passed: "Passed", failed: "Failed", blocked: "Blocked", unavailable: "Unavailable" } as const;

function IdentityMap({ values, label }: { readonly values: Readonly<Record<string, string>>; readonly label: string }) {
  return <dl aria-label={label} className="m-0 grid min-w-0 gap-2">{Object.entries(values).map(([name, value]) => <div key={name} className="grid min-w-0 gap-1">
    <dt className="font-medium wrap-anywhere">{name}</dt><dd className="m-0 font-mono text-meta break-all">{value}</dd>
  </div>)}</dl>;
}

/** A receipt describes evidence; neither its ID nor a persisted outcome authenticates it. */
export function GraphQLReceiptDetails({ receipt, historical = false }: { readonly receipt: ContractProofReceipt; readonly historical?: boolean }) {
  return <details className={documentDisclosureClasses}>
    <summary className={documentSummaryClasses}>{historical ? "Recorded historical receipt" : "Inspect receipt"} · {shortFingerprint(receipt.id)}</summary>
    <dl className="m-0 grid min-w-0 gap-3 text-caption">
      <div><dt className="font-medium">Receipt identity</dt><dd className="m-0 font-mono break-all">{receipt.id}</dd></div>
      <div><dt className="font-medium">Scope</dt><dd className="m-0">{receipt.scope === "candidate" ? "Private candidate" : "Saved source"} · schema {receipt.version}</dd></div>
      <div><dt className="font-medium">Relevant source</dt><dd className="m-0 font-mono break-all">{receipt.sourceRevision}</dd></div>
      <div><dt className="font-medium">Decision binding</dt><dd className="m-0 font-mono break-all">{receipt.decisionDigest}</dd></div>
      <div><dt className="font-medium">Verification policy</dt><dd className="m-0 wrap-anywhere">{receipt.policy.id}<code className="block text-meta break-all">{receipt.policy.digest}</code></dd></div>
      <div><dt className="font-medium">Execution family</dt><dd className="m-0">{receipt.toolchain.node}</dd></div>
    </dl>
    <details className={documentDisclosureClasses}><summary className={documentSummaryClasses}>Inputs, implementation and generated outputs</summary>
      <IdentityMap label="Receipt input identities" values={{ ...receipt.inputs, implementation: receipt.implementation }} />
      <IdentityMap label="Receipt predecessor identities" values={Object.fromEntries(Object.entries(receipt.predecessors).map(([stage, id]) => [stageNames[stage as ProofStage], id!]))} />
      <IdentityMap label="Receipt output identities" values={receipt.outputs} />
    </details>
    <details className={documentDisclosureClasses}><summary className={documentSummaryClasses}>Dependencies and tool versions</summary>
      <IdentityMap label="Receipt toolchain versions" values={receipt.toolchain.packages} />
      <p className="m-0 text-caption">Dependency lockfile <code className="block text-meta break-all">{receipt.toolchain.lockfileDigest}</code></p>
      <p className="m-0 text-caption">Installed portable dependency source <code className="block text-meta break-all">{receipt.toolchain.dependencyDigest}</code></p>
    </details>
    <ul aria-label="Receipt validation outcomes" className="m-0 grid gap-2 pl-5 text-caption">{receipt.checks.map(check => <li key={check.id}>
      <span className="font-medium">{check.id}: {checkNames[check.outcome]}</span><span className="text-graphite"> · validator {check.version}</span>
      <p className="m-0 font-mono text-meta break-all">Evidence {check.evidence}</p>
      {check.diagnostics.length ? <ul className="m-0 grid gap-1 pl-4">{check.diagnostics.map((diagnostic, index) => <li key={index} className="wrap-anywhere">{diagnostic.code}{diagnostic.file ? ` · ${diagnostic.file}` : ""}</li>)}</ul> : null}
    </li>)}</ul>
    {receipt.review ? <section aria-label="Recorded application decision" className="grid gap-2 border-t border-rule pt-3 text-caption">
      <p className={documentSubheadingClasses}>{receipt.review.scope === "api" ? "API" : "Client"} review declaration</p>
      <p className="m-0 whitespace-pre-wrap wrap-anywhere">{receipt.review.decision.statement}</p>
      <p className="m-0 whitespace-pre-wrap text-graphite wrap-anywhere">{receipt.review.decision.evidence}</p>
    </section> : null}
    {receipt.limitations.length ? <ul aria-label="Receipt verification limitations" className="m-0 grid gap-1 pl-5 text-caption text-graphite">{receipt.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul> : null}
    <p className={documentSupportClasses}>This content identity is not a signature. Stored outcomes and review declarations are historical provenance; current independent verification establishes confidence.</p>
  </details>;
}

function StageLineage({ view, current }: { readonly view: ProofStageView; readonly current: boolean }) {
  const receipt = view.current;
  return <section aria-label={`${stageNames[view.stage]} proof`} className="grid min-w-0 gap-2 rounded-md border border-rule p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className={documentSubheadingClasses}>{stageNames[view.stage]}</h4><span className="text-caption text-graphite">{current ? statusNames[view.status] : "Historical evidence"}</span></div>
    <p className={documentSupportClasses}>{current ? view.action : "Recheck saved source before using these receipt observations. They do not establish current confidence."}</p>
    {view.diagnostics.length ? <ul className="m-0 grid gap-1 pl-5 text-caption">{view.diagnostics.map((diagnostic, index) => <li key={index} className="whitespace-pre-wrap wrap-anywhere">{diagnostic.message}{diagnostic.file ? <code className="block text-meta">{diagnostic.file}</code> : null}</li>)}</ul> : null}
    <p className="m-0 text-caption">{!view.recorded ? "No receipt is recorded for this stage." : !receipt ? "The recorded receipt is historical; current evidence could not be established." : view.recorded.id === receipt.id ? "The recorded receipt matches this independent evaluation." : "The recorded receipt differs from the current inputs, predecessor evidence or policy."}</p>
    {view.predecessors.length ? <ul aria-label="Required predecessor receipts" className="m-0 grid gap-1 pl-5 text-caption">{view.predecessors.map(predecessor => <li key={predecessor.stage}>
      <span className="font-medium">{stageNames[predecessor.stage]}: </span>{current ? predecessor.current && receipt?.predecessors[predecessor.stage] === predecessor.current ? "Current receipt binding matches" : "Current binding unavailable" : "Previously observed predecessor"}
      {current && !predecessor.matches ? <span className="block text-meta text-graphite">Previous binding changed or was not recorded.</span> : null}
      <span className="block text-meta text-graphite">Recorded {predecessor.recorded ? shortFingerprint(predecessor.recorded) : "none"} · current {current && predecessor.current ? shortFingerprint(predecessor.current) : "unavailable"}</span>
    </li>)}</ul> : null}
    {receipt ? <GraphQLReceiptDetails receipt={receipt} historical={!current} /> : <p className={documentSupportClasses}>A current receipt could not be independently established.</p>}
    {view.recorded && (!receipt || view.recorded.id !== receipt.id) ? <GraphQLReceiptDetails receipt={view.recorded} historical /> : null}
  </section>;
}

/** Advanced evidence stays under the existing stage detail rather than adding another dashboard. */
export function GraphQLProofLineage({ proof, stages, current = true }: { readonly proof: ContractProofView; readonly stages: readonly ProofStage[]; readonly current?: boolean }) {
  const [open, setOpen] = useState(false);
  const views = stages.map(stage => proof.stages.find(view => view.stage === stage)).filter((view): view is ProofStageView => !!view);
  const ciNames = { "not-observed": "No CI observation loaded", matching: "Recorded CI evidence matches", different: "Recorded CI evidence differs", unavailable: "CI comparison unavailable" } as const;
  return <details className="min-w-0 border-t border-rule pt-2 text-caption" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className={documentSummaryClasses}>Proof lineage</summary>
    {open ? <>
    <p className={documentSupportClasses}>Independent checks and accepted review declarations establish current confidence. Receipts retain the inputs, predecessors and policy used by those checks.</p>
    <div className="mt-3 grid min-w-0 gap-3">{views.map(view => <StageLineage key={view.stage} view={view} current={current} />)}</div>
    <section aria-label="Local and CI evidence comparison" className="mt-3 grid gap-1 border-t border-rule pt-3">
      <strong className="font-medium">{current ? ciNames[proof.ci.status] : "Historical CI comparison"}</strong>
      <p className={documentSupportClasses}>{proof.ci.message}</p>
      <p className={documentSupportClasses}>A report labelled CI is not authenticated by its content identity. CI must independently execute the required checks; a stored receipt cannot replace them.</p>
    </section>
    </> : null}
  </details>;
}

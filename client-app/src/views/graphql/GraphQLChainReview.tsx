import type { ReviewPlan, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import { REVIEW_DECISION_LIMIT, type ReviewDecision, type ReviewDecisions } from "aws-studio/contract-chain/contract-proof";
import { useEffect, useId, useRef, useState } from "react";
import { sourceDiff } from "../../../shared/source-diff";
import { dialogPrimaryActionClasses } from "../../inspector-ui";
import { cx } from "../../ui/classes";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Surface";
import { Textarea } from "../../ui/FormControls";
import { documentFieldsetClasses, documentLabelClasses, documentSupportClasses } from "../DocumentUI";
import { SourceDiff } from "../SourceDiff";
import { WorkbenchDialog } from "../WorkbenchUI";

export type ContractReviewDecisions = ReviewDecisions;

/** Meaningful decisions are explicit inputs to the existing concrete record review. */
export function GraphQLChainDecisionReview({ scope, expectedRevision, currentRevision, pending, problem, onBack, onPrepare }: {
  readonly scope: Exclude<ReviewScope, { readonly kind: "model" }>;
  readonly expectedRevision: string;
  readonly currentRevision?: string;
  readonly pending: "idle" | "checking" | "reviewing";
  readonly problem?: string;
  readonly onBack: () => void;
  readonly onPrepare: (decisions: ContractReviewDecisions) => void;
}) {
  const id = useId();
  const [decisions, setDecisions] = useState<ContractReviewDecisions>({});
  const required = scope.kind === "baseline" ? ["api", "client"] as const : [scope.kind];
  const stale = currentRevision !== expectedRevision;
  const complete = required.every(kind => decisions[kind]?.statement.trim() && decisions[kind]?.evidence.trim());
  const update = (kind: "api" | "client", field: keyof ReviewDecision, value: string) => setDecisions(previous => ({ ...previous, [kind]: { statement: "", evidence: "", ...previous[kind], [field]: value } }));
  const error = useRef<HTMLDivElement>(null);
  useEffect(() => { if (problem) error.current?.focus(); }, [problem]);
  return <WorkbenchDialog title="Review contract decisions" onClose={onBack} busy={pending === "reviewing"} footer={<>
    <Button type="button" disabled={pending === "reviewing"} onClick={onBack}>Back</Button>
    <Button type="button" variant="primary" className={cx(dialogPrimaryActionClasses, "forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText] forced-colors:border-[ButtonText]")} disabled={pending !== "idle" || stale || !complete} aria-busy={pending !== "idle"} onClick={() => onPrepare(decisions)}>{pending === "reviewing" ? "Preparing review…" : pending === "checking" ? "Checking…" : "Review evidence"}</Button>
  </>}>
    <p className={documentSupportClasses}>Record the application behavior you deliberately accept and the source or user evidence supporting it. A private field can require no public API or client change. Candidate decisions are not accepted automatically.</p>
    {required.map(kind => <fieldset key={kind} className={documentFieldsetClasses} disabled={pending !== "idle"}>
      <legend className="px-1 text-label font-semibold">{kind === "api" ? "Repository and API" : "Client operations"}</legend>
      <label className={documentLabelClasses} htmlFor={`${id}-${kind}-statement`}>{kind === "api" ? "Accepted API behavior" : "Accepted client behavior"}
        <Textarea id={`${id}-${kind}-statement`} rows={3} required maxLength={REVIEW_DECISION_LIMIT} value={decisions[kind]?.statement ?? ""} onChange={event => update(kind, "statement", event.target.value)} />
      </label>
      <label className={documentLabelClasses} htmlFor={`${id}-${kind}-evidence`}>Source or user evidence
        <Textarea id={`${id}-${kind}-evidence`} rows={2} required maxLength={REVIEW_DECISION_LIMIT} value={decisions[kind]?.evidence ?? ""} onChange={event => update(kind, "evidence", event.target.value)} />
      </label>
      <p className={documentSupportClasses}>{kind === "api" ? "Include deliberate exposure or withholding, write behavior, ownership and validation choices." : "Include selections, operation behavior and cache invalidation choices."}</p>
    </fieldset>)}
    {stale ? <Notice role="alert">Source changed or current evidence is unavailable. Check saved source before preparing this review.</Notice> : null}
    {problem ? <Notice ref={error} role="alert" tabIndex={-1}>{problem}</Notice> : null}
    <p className={documentSupportClasses}>The next step shows the exact record changes. These statements are unsigned review declarations; validation must still independently pass.</p>
  </WorkbenchDialog>;
}

/** Reviewing is read-only; the second action accepts exactly this server-owned plan. */
export function GraphQLChainReview({ review, pending, problem, currentRevision, onBack, onAccept }: {
  readonly review: ReviewPlan;
  readonly pending: "idle" | "checking" | "recording";
  readonly problem?: string;
  readonly currentRevision?: string;
  readonly onBack: () => void;
  readonly onAccept: () => void;
}) {
  const stale = pending !== "checking" && currentRevision !== review.expectedRevision;
  const error = useRef<HTMLDivElement>(null);
  useEffect(() => { if (problem) error.current?.focus(); }, [problem]);
  return <WorkbenchDialog title="Review contract chain record" onClose={onBack} busy={pending === "recording"} footer={<>
    <Button type="button" disabled={pending === "recording"} onClick={onBack}>Back</Button>
    <Button type="button" variant="primary" className={cx(dialogPrimaryActionClasses, "forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText] forced-colors:border-[ButtonText]")} disabled={pending !== "idle" || stale} aria-busy={pending !== "idle"} onClick={onAccept}>{pending === "recording" ? "Recording review…" : pending === "checking" ? "Checking…" : "Record review"}</Button>
  </>}>
    <ul className="m-0 grid gap-1 pl-5 text-label">{review.effects.map(effect => <li key={effect}>{effect}</li>)}</ul>
    {stale ? <Notice role="alert">Source changed. Check again before recording this review.</Notice> : null}
    {problem ? <Notice ref={error} role="alert" tabIndex={-1}>{problem}</Notice> : null}
    <SourceDiff file={review.file} lines={sourceDiff(review.file, review.before ?? "", review.after).lines} note={review.before === null ? "New review record" : "Review evidence"} />
  </WorkbenchDialog>;
}

import { useId } from "react";
import type { CodingTask } from "../../../shared/agent-runtime";
import type { ContractDecision, ContractStage } from "../../../shared/contract-propagation";
import { Check, Circle, ArrowRight, CircleHelp } from "lucide-react";
import { Button } from "../../ui/Button";
import { TextInput, Textarea } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { cx } from "../../ui/classes";
import { DocumentCard, documentSupportClasses, documentTitleClasses } from "../DocumentUI";
import { codingCheckpointPassed, codingCheckpointReceipt, codingContractProofProblem, codingStatusLabel } from "../../coding-presentation";
import { GraphQLReceiptDetails } from "./GraphQLProofLineage";
/** A status card's subject, as WorkbenchStatusHeading draws it: support text, medium weight. */
const statusSubjectClasses = cx(documentSupportClasses, "font-medium");

export const contractStageNames: Readonly<Record<ContractStage, string>> = { api: "Repository and API", codegen: "Generate documents", client: "Client operations" };
export const contractPrimaryClasses = "forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText] forced-colors:border-[ButtonText]";
const stages: readonly ContractStage[] = ["api", "codegen", "client"];
const decisionNames: Readonly<Record<ContractDecision["kind"], string>> = { exposure: "Public exposure", graphql: "GraphQL behavior", write: "Write behavior", ownership: "Authorization and ownership", validation: "Validation", selection: "Client selections", cache: "Cache behavior" };

/** Explicit developer decisions; shared by initial preparation and retained checkpoints. */
export function ContractDecisionReview({ decisions: selected, onChange, busy = false, defaultOpen = false }: {
  readonly decisions: readonly ContractDecision[];
  readonly onChange?: (decisions: readonly ContractDecision[]) => void;
  readonly busy?: boolean;
  readonly defaultOpen?: boolean;
}) {
  const controlId = useId();
  const unresolved = selected.filter(item => item.status !== "established" || !item.value?.trim() || !item.evidence?.trim());
  const update = (id: string, change: Partial<ContractDecision>) => onChange?.(selected.map(item => item.id === id ? { ...item, ...change } : item));
  return selected.length ? <details className="border-t border-rule pt-2 text-caption" open={defaultOpen}>
      <summary className="cursor-pointer font-medium">Application decisions · {unresolved.length ? `${unresolved.length} need review` : `${selected.length} established`}</summary>
      <p className={cx(documentSupportClasses, "mt-2")}>Record the intended behavior and its source or user evidence. A private field can deliberately require no public API or client changes. Agent output does not establish these decisions.</p>
      <div className="mt-3 grid gap-2">{selected.map((decision, index) => <details key={decision.id} className="min-w-0 rounded-md border border-rule p-3">
        <summary className="cursor-pointer font-medium wrap-anywhere">{decision.target} · {decisionNames[decision.kind]} · {decision.status === "established" ? "Reviewed" : "Needs review"}</summary>
        <div className="mt-2 grid min-w-0 gap-2">
        {onChange ? <>
          <label className="grid gap-1" htmlFor={`${controlId}-decision-${index}`}>Reviewed behavior
            <Textarea id={`${controlId}-decision-${index}`} rows={2} maxLength={2000} value={decision.value ?? ""} disabled={busy} onChange={event => update(decision.id, { value: event.target.value, status: "unresolved" })} />
          </label>
          <label className="grid gap-1" htmlFor={`${controlId}-evidence-${index}`}>Source or user evidence
            <TextInput id={`${controlId}-evidence-${index}`} maxLength={2000} value={decision.evidence ?? ""} disabled={busy} onChange={event => update(decision.id, { evidence: event.target.value, status: "unresolved" })} />
          </label>
          <label className="flex items-start gap-2"><TextInput type="checkbox" checked={decision.status === "established"} disabled={busy || !decision.value?.trim() || !decision.evidence?.trim()} onChange={event => update(decision.id, { status: event.target.checked ? "established" : "unresolved" })} />I reviewed this decision</label>
        </> : <><p className="m-0 whitespace-pre-wrap wrap-anywhere">{decision.value ?? "Decision required"}</p>{decision.evidence ? <p className="m-0 whitespace-pre-wrap text-graphite wrap-anywhere">{decision.evidence}</p> : null}<span className="text-meta text-graphite">{decision.status === "established" ? "Reviewed" : "Unresolved"}</span></>}
        </div>
      </details>)}</div>
    </details> : null;
}

/** Candidate checks remain visibly separate from the saved-source contract rail. */
export function ContractTaskProgress({ task, onOpen, decisions, onDecisionsChange, onContinue, busy = false, current = true }: {
  readonly task: CodingTask;
  readonly onOpen?: () => void;
  readonly decisions?: readonly ContractDecision[];
  readonly onDecisionsChange?: (decisions: readonly ContractDecision[]) => void;
  readonly onContinue?: () => void;
  readonly busy?: boolean;
  readonly current?: boolean;
}) {
  const contract = task.contract;
  if (!contract) return null;
  const checkpoint = [...contract.checkpoints].reverse().find(item => item.stage === contract.stage);
  const receipt = checkpoint ? codingCheckpointReceipt(contract, checkpoint) : undefined;
  const receiptGap = !!codingContractProofProblem(task);
  const applied = task.status === "completed" && (task.sourceOutcome === "applied" || contract.status === "applied-awaiting-check");
  const historical = !current || (!applied && receiptGap) || ["failed", "conflicted", "interrupted", "cancelled", "integrating", "recovery_required", "rejected"].includes(task.status);
  const working = ["queued", "preparing", "running", "validating", "waiting_for_permission"].includes(task.status);
  const ready = !historical && task.status === "awaiting_review" && contract.status === "ready";
  const selected = decisions ?? contract.decisions;
  const unresolved = selected.filter(item => item.status !== "established" || !item.value?.trim() || !item.evidence?.trim());
  const checksPassed = !!checkpoint && codingCheckpointPassed(contract, checkpoint);
  const decisionsChanged = !!checkpoint && JSON.stringify(selected) !== JSON.stringify(checkpoint.decisions);
  const canReconcileDecisions = !!receipt && !!checkpoint && ["passed", "failed"].includes(checkpoint.status) && checkpoint.checks.length > 0 && checkpoint.checks.every(check => check.status !== "unavailable" && check.candidateDigest === checkpoint.candidateDigest);
  const label = historical ? "Historical candidate evidence" : applied ? contract.approval?.status === "approved" ? "Saved source · approved" : contract.approval?.status === "failed" ? "Saved source · approval failed" : contract.approval?.status === "checking" ? "Applied · verifying saved source" : "Applied · verification pending" : ready ? contract.run ? "Candidate checks passed" : "Candidate ready for review" : working ? `Private candidate · ${codingStatusLabel[task.status]}` : "Private candidate";
  const historyMessage = !current ? "Current task evidence is unavailable. Retry the task read in Coding before using retained checkpoints." : receiptGap ? "Versioned candidate proof is missing or no longer matches these checkpoints. Refresh the retained candidate in Coding and independently validate it before continuing." : task.status === "integrating" ? "Applying the reviewed candidate. Checkpoint results remain historical while source integration completes." : task.status === "recovery_required" ? "Source recovery is required. Resolve recovery in Coding before using this candidate again." : task.status === "rejected" ? "This candidate was rejected. Checkpoint results remain historical; start another update when needed." : task.status === "conflicted" ? "Saved source changed. Refresh the retained candidate in Coding and renew its independent checks." : `${codingStatusLabel[task.status]}. Retained checkpoint results are historical. Resume in Coding and renew the required checks before using this candidate.`;
  const savedPredecessor = (stage: ContractStage) => !contract.checkpoints.some(checkpoint => checkpoint.stage === stage) && stages.indexOf(stage) < stages.indexOf(contract.context.stage) && contract.context.predecessors.length > 0 && contract.context.predecessors.every(predecessor => predecessor.status === "verified" && !!predecessor.digest);
  const hasSavedPredecessors = stages.some(savedPredecessor);
  return <section aria-label="Candidate contract progress" className="grid gap-3 rounded-md border border-rule bg-sheet p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="grid min-w-0 gap-1">
        <p className={statusSubjectClasses}>{label}</p>
        <h3 className={documentTitleClasses}>{applied ? "Check the saved contract" : contractStageNames[contract.stage]}</h3>
      </div>
      {onOpen ? <Button type="button" size="dense" onClick={onOpen}>{applied ? "View applied task" : "Open in Coding"}<ArrowRight size={14} aria-hidden /></Button> : null}
    </div>
    {applied && contract.approval?.status === "approved" && current
      ? <Notice role="status" tone="success">{contract.approval.message}</Notice>
      : <p role={working || applied ? "status" : undefined} className={documentSupportClasses}>{historical ? historyMessage : applied ? contract.approval?.message ?? "This older task has no saved-source approval result. Run the affected stage again to check and approve current source." : ready ? contract.run ? "Studio applies validated stage repairs and confirms approval after checking saved source." : "Independent candidate checks passed. Review the exact proposed files in Coding before applying them." : task.summary ?? (contract.run ? "Saved-source approval follows independent checks." : "Saved-source approval follows candidate review and independent checks.")}</p>}
    {current && historical && task.summary ? <p className={documentSupportClasses}>{task.summary}</p> : null}
    <ol aria-label="Candidate checkpoints" className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-caption">
      {stages.filter(stage => contract.run === "sequential" || stage === contract.stage || stage === contract.nextStage || savedPredecessor(stage) || contract.checkpoints.some(checkpoint => checkpoint.stage === stage)).map(stage => {
        const checkpoint = [...contract.checkpoints].reverse().find(item => item.stage === stage);
        const receipt = checkpoint ? codingCheckpointReceipt(contract, checkpoint) : undefined;
        const active = contract.stage === stage && !ready && !applied;
        const previous = historical || (working && contract.stage === stage) || (contract.repairStage === "client" && stage === "codegen");
        const saved = savedPredecessor(stage);
        const status = saved ? historical ? "Saved predecessor · at capture" : "Verified saved predecessor" : checkpoint?.status === "stale" ? "Needs fresh checks" : checkpoint?.status === "passed" && !receipt ? "Needs versioned proof" : checkpoint && previous ? `Previous check · ${checkpoint.status}` : checkpoint?.status === "passed" ? "Checks passed" : checkpoint?.status === "failed" ? "Checks failed" : checkpoint?.status === "unavailable" ? "Checks unavailable" : active ? "In progress" : "Waiting";
        const passed = !previous && !!checkpoint && codingCheckpointPassed(contract, checkpoint);
        const Glyph = passed || (saved && !historical) ? Check : checkpoint ? CircleHelp : Circle;
        return <li key={stage} aria-current={active ? "step" : undefined} className="flex items-center gap-2">
          <Glyph size={14} aria-hidden className={passed ? "text-accept" : "text-graphite"} />
          <span><span className="font-medium">{contractStageNames[stage]}</span><span className="block text-meta text-graphite">{status}</span></span>
        </li>;
      })}
    </ol>
    {hasSavedPredecessors ? <p className={documentSupportClasses}>Saved predecessors were verified at task capture; the saved-source rail shows current confidence. Candidate checks remain separate.</p> : null}
    {contract.gateReason ? <Notice tone="neutral">{contract.gateReason}</Notice> : null}
    <ContractDecisionReview decisions={selected} onChange={!historical && task.status === "awaiting_review" ? onDecisionsChange : undefined} busy={busy} defaultOpen={!!onDecisionsChange && !historical && task.status === "awaiting_review" && contract.status === "checkpoint" && unresolved.length > 0} />
    {contract.checkpoints.length ? <details className="border-t border-rule pt-2 text-caption"><summary className="cursor-pointer font-medium">Inspect checkpoint evidence</summary>
      <p className={cx(documentSupportClasses, "mt-2")}>Each checkpoint describes its captured candidate. Later edits require fresh checks; these results never establish saved-source confidence.</p>
      <ol className="mb-0 grid gap-3 pl-5">{contract.checkpoints.map((checkpoint, index) => <li key={`${checkpoint.stage}-${index}`}>
        <strong className="font-medium">{contractStageNames[checkpoint.stage]} · {checkpoint.status}</strong>
        <p className="m-0 text-meta text-graphite">{checkpoint.validatedAt}</p>
        <ul className="m-0 grid gap-1 pl-4">{checkpoint.checks.map((check, at) => <li key={at}><span className="font-medium">{check.status}: </span><code className="wrap-anywhere">{check.command}</code>{check.detail ? <p className="m-0 whitespace-pre-wrap wrap-anywhere">{check.detail}</p> : null}</li>)}</ul>
        {codingCheckpointReceipt(contract, checkpoint) ? <><p className={documentSupportClasses}>Candidate-scoped receipt. Saved source must be independently checked after Apply.</p><GraphQLReceiptDetails receipt={codingCheckpointReceipt(contract, checkpoint)!} historical={historical || working || checkpoint.status !== "passed"} /></> : checkpoint.receiptId ? <p className={documentSupportClasses}>Historical receipt {checkpoint.receiptId}. Its current candidate binding is unavailable.</p> : <p className={documentSupportClasses}>No versioned receipt is available for this checkpoint.</p>}
      </li>)}</ol>
    </details> : null}
    {onContinue && !historical && task.status === "awaiting_review" && contract.status === "checkpoint" ? <div className="grid justify-items-start gap-1">
      <Button type="button" variant="primary" className={contractPrimaryClasses} disabled={busy || unresolved.length > 0 || !(decisionsChanged ? canReconcileDecisions : checksPassed)} aria-busy={busy} onClick={onContinue}>{decisionsChanged ? "Apply decisions to candidate" : contract.nextStage ? `Continue to ${contractStageNames[contract.nextStage]}` : contract.run ? "Continue to acceptance" : "Continue to final review"}<ArrowRight size={14} aria-hidden /></Button>
      {unresolved.length ? <p className={documentSupportClasses}>Review the application decisions before continuing.</p> : decisionsChanged ? <p className={documentSupportClasses}>Runs this stage again with your decisions before progressing.</p> : null}
      {!checksPassed && !(decisionsChanged && canReconcileDecisions) ? <p className={documentSupportClasses}>Passing independent checks against this checkpoint are required before continuing.</p> : null}
    </div> : null}
  </section>;
}

/**
 * Saved-source recommendations need current evidence. Retained task progress
 * remains visible while saved-source checks run.
 */
export function GraphQLContractWorkflow({ stage: requestedStage, task, checking, onStart, onRegenerate, onOpen, taskCurrent = true, sourceCurrent = true }: {
  readonly stage: ContractStage | null;
  readonly task?: CodingTask;
  readonly checking: boolean;
  readonly onStart: (stage: ContractStage) => void;
  readonly onRegenerate?: () => void;
  readonly onOpen: (task: CodingTask) => void;
  readonly taskCurrent?: boolean;
  readonly sourceCurrent?: boolean;
}) {
  const stage = sourceCurrent ? requestedStage : null;
  if (!stage && !task) return null;
  const restartFromSource = task && ["failed", "cancelled"].includes(task.status) && !task.contract?.checkpoints.length;
  const superseded = sourceCurrent && !stage && task?.contract?.status === "applied-awaiting-check" && !task.contract.approval;
  const regenerate = stage === "codegen" ? onRegenerate : undefined;
  const start = () => { if (regenerate) regenerate(); else if (stage) onStart(stage); };
  return <DocumentCard aria-label="Contract update">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="grid gap-1"><p className={statusSubjectClasses}>Saved source</p><h2 className={documentTitleClasses}>{!sourceCurrent ? "Contract run" : stage ? `Next: ${contractStageNames[stage]}` : "Contract chain verified"}</h2></div>
      {stage && !task ? <Button type="button" variant="primary" className={contractPrimaryClasses} disabled={checking} onClick={start}>{regenerate ? "Regenerate GraphQL" : "Draft next task"}<ArrowRight size={14} aria-hidden /></Button> : null}
    </div>
    {task ? superseded ? <div><Button type="button" onClick={() => onOpen(task)}>View applied task</Button></div> : <ContractTaskProgress task={task} current={taskCurrent} onOpen={() => onOpen(task)} /> : null}
    {stage && task && ["completed", "rejected"].includes(task.status) ? <div><Button type="button" disabled={checking} onClick={start}>{regenerate ? "Regenerate GraphQL" : "Draft another task"}</Button></div> : null}
    {stage && restartFromSource ? <div><Button type="button" disabled={checking} onClick={start}>{regenerate ? "Regenerate GraphQL" : "Draft task from current source"}</Button></div> : null}
  </DocumentCard>;
}

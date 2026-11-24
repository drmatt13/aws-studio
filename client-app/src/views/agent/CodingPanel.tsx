import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { codingTaskActive, type CodingTask, type CodingTaskRequest, type CodingValidationPlan } from "../../../shared/agent-runtime";
import { agentLabApi } from "../../agent-lab-api";
import type { AgentChat } from "../../agent-chat";
import { useCodingTasks } from "../../agent-tasks";
import { CODING_PROMPT_LIMIT, OPEN_CODING_TASK_EVENT, type CodingTaskNavigation, type CodingTaskPreparation } from "../../coding-task-navigation";
import { codingActivationProblem, codingApprovalProblem, codingContractProofProblem, codingDiffLines, codingStatusLabel, codingValidationChoice } from "../../coding-presentation";
import { buildSightline } from "../../sightline/build";
import { useSightlineInputs } from "../../sightline/useSightlineInputs";
import { StudioContextControl } from "../../sightline/StudioContextControl";
import type { Sightline } from "../../sightline/types";
import { useStudio } from "../../studio";
import { Button } from "../../ui/Button";
import { Select, Textarea } from "../../ui/FormControls";
import { Notice } from "../../ui/Surface";
import { SourceDiff } from "../SourceDiff";
import { ArchitecturePreviewPanel } from "./ArchitecturePreviewPanel";
import { CodingRecoveryPanel } from "./CodingRecoveryPanel";
import { CodingHostPanel } from "./CodingHostPanel";
import { CodingTaskActivity } from "./CodingTaskActivity";
import { AgentModelControls } from "./AgentModelControls";
import type { ContractDecision } from "../../../shared/contract-propagation";
import { ContractTaskProgress, contractStageNames } from "../graphql/GraphQLContractWorkflow";

/** Unmount the reader while hidden so retained composer state adds no context subscriptions. */
function CodingContextReader({ includeContext, onContext }: { readonly includeContext: boolean; readonly onContext: (value: Sightline | undefined) => void }) {
  const inputs = useSightlineInputs(includeContext);
  const context = useMemo(() => buildSightline(inputs), [inputs]);
  useLayoutEffect(() => { onContext(context); return () => onContext(undefined); }, [context, onContext]);
  return null;
}

function codingListStatus(task: CodingTask, historical: boolean) {
  if (historical && task.contract) return "Historical task";
  if (task.status === "awaiting_review" && task.contract) {
    if (codingContractProofProblem(task)) return "Needs fresh checks";
    if (task.contract.status === "checkpoint") return "Contract checkpoint";
  }
  return codingStatusLabel[task.status];
}

function taskTitle(task: CodingTask) {
  if (task.contract?.run === "sequential") return "Update the GraphQL contract";
  if (task.contract) return `Check the ${contractStageNames[task.contract.context.stage]} contract`;
  const firstLine = task.prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97).trimEnd()}…` : firstLine;
}

function TaskDisclosure({ label, defaultOpen = false, children }: { readonly label: string; readonly defaultOpen?: boolean; readonly children: () => ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className="min-w-0 border-t border-rule pt-2" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{label}</summary>
    {open ? children() : null}
  </details>;
}

export function CodingPanel({ visible, selection, prepared, onPreparedHandled, initialTaskId }: { readonly visible: boolean; readonly selection: Pick<AgentChat, "provider" | "setProvider" | "model" | "setModel" | "includeContext" | "setIncludeContext">; readonly prepared?: CodingTaskPreparation; readonly onPreparedHandled?: (id: string) => void; readonly initialTaskId?: string }) {
  const studio = useStudio(), repository = studio.snapshot.repositoryRoot;
  const coding = useCodingTasks(visible, repository, { initialTaskId });
  const [context, setContext] = useState<Sightline>();
  const { provider, setProvider, model, setModel, includeContext, setIncludeContext } = selection;
  const [draft, setDraft] = useState(""), [composeOpen, setComposeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    const showTask = (event: Event) => {
      const detail = (event as CustomEvent<CodingTaskNavigation>).detail;
      if (detail?.repository === repository && detail.task) setComposeOpen(false);
    };
    window.addEventListener(OPEN_CODING_TASK_EVENT, showTask);
    return () => window.removeEventListener(OPEN_CODING_TASK_EVENT, showTask);
  }, [repository]);
  const [decisionDraft, setDecisionDraft] = useState<{ readonly taskId: string; readonly values: readonly ContractDecision[] }>();
  const [validationKind, setValidationKind] = useState<CodingValidationPlan["kind"] | "automatic">("automatic"), [testPaths, setTestPaths] = useState("");
  const submission = useRef<CodingTaskRequest | undefined>(undefined), composer = useRef<HTMLTextAreaElement>(null);
  const task = coding.task, proposal = coding.proposal.data;
  const showComposer = composeOpen || !task && !coding.list.isPending && !coding.list.data?.tasks.length;
  const choosingProvider = visible && showComposer;
  const status = useQuery({ queryKey: ["agent-lab-status"], queryFn: agentLabApi.status, enabled: choosingProvider, retry: false, staleTime: 30_000, refetchOnWindowFocus: false });
  const selectedProvider = status.data?.providers.find(item => item.id === provider);
  const refreshCatalog = useRef(false);
  const catalog = useQuery({ queryKey: ["agent-lab-models", provider], queryFn: ({ signal }) => {
    const refresh = refreshCatalog.current;
    refreshCatalog.current = false;
    return agentLabApi.models(provider, signal, refresh);
  }, enabled: choosingProvider && selectedProvider?.available === true, retry: false, staleTime: 60_000, refetchOnWindowFocus: false });
  const selectedModel = catalog.data?.models.find(item => item.id === model);
  const missingModel = !!model && !!catalog.data && !catalog.data.problem && !selectedModel;
  const modelProblem = catalog.error?.message ?? catalog.data?.problem ?? (missingModel ? "The selected model is unavailable. Choose another model or CLI default." : undefined);
  const taskEvidenceCurrent = !coding.listError && !coding.eventsError && !coding.proposalError;
  const candidateProofProblem = task ? codingContractProofProblem(task) : undefined;
  const durableDecisions = JSON.stringify(task?.contract?.decisions);
  useEffect(() => { setDecisionDraft(undefined); }, [task?.id, durableDecisions]);
  const decisions = task && decisionDraft?.taskId === task.id ? decisionDraft.values : task?.contract?.decisions;
  const approvalProblem = task && proposal ? codingApprovalProblem(task, proposal) : undefined;
  const activationProblem = task && proposal ? codingActivationProblem(task, proposal) : undefined;
  const permission = task?.status === "waiting_for_permission" ? [...(coding.events.data?.events ?? [])].reverse().find(event => event.type === "permission" && typeof event.data.id === "string" && !event.data.decision) : undefined;
  const busy = !!coding.pending;
  const activeTasks = coding.list.data?.tasks.filter(codingTaskActive) ?? [];
  const activeTask = activeTasks[0];
  const starting = coding.pending === "Starting task";
  const panel = useRef<HTMLElement>(null);
  const taskHeading = useRef<HTMLHeadingElement>(null), followNewTask = useRef(false);
  const error = coding.problem ?? coding.listError?.message ?? coding.eventsError?.message ?? coding.proposalError?.message;
  const validation = codingValidationChoice(validationKind, testPaths);
  const canSubmit = visible && showComposer && !!draft.trim() && draft.length <= CODING_PROMPT_LIMIT
    && selectedProvider?.available === true && (!model || !!selectedModel && !modelProblem)
    && !busy && !validation.problem && (!includeContext || context !== undefined);
  const handledRequest = useRef<string | undefined>(undefined);
  const incoming = prepared?.repository === repository && prepared.request.id !== handledRequest.current ? prepared.request : undefined;
  const applyPrepared = () => {
    if (!incoming || busy) return;
    handledRequest.current = incoming.id;
    setDraft(incoming.prompt);
    submission.current = undefined;
    setComposeOpen(true);
    onPreparedHandled?.(incoming.id);
    requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  };
  useEffect(() => {
    if (!visible || !incoming || busy) return;
    setComposeOpen(true);
    if (!draft.trim() || draft.trim() === incoming.prompt.trim()) applyPrepared();
  }, [visible, incoming, busy, draft]);
  useEffect(() => { submission.current = undefined; }, [provider, model, includeContext]);
  const submittedContext = submission.current?.context;
  const previewContext = useMemo(() => submittedContext ? JSON.parse(submittedContext) as Sightline : context, [submittedContext, context]);
  const submit = async () => {
    if (!canSubmit) return;
    // A retry keeps the original snapshot and request key until the draft or settings change.
    submission.current ??= {
      requestKey: crypto.randomUUID(), provider, prompt: draft.trim(), ...(model ? { model } : {}),
      ...(includeContext ? { context: JSON.stringify(context) } : {}), ...(validation.plan ? { validation: validation.plan } : {}),
    };
    followNewTask.current = true;
    if (await coding.submit(submission.current)) {
      setDraft(""); setValidationKind("automatic"); setTestPaths(""); submission.current = undefined; setSettingsOpen(false); setComposeOpen(false);
    } else {
      followNewTask.current = false;
      requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
    }
  };
  useEffect(() => {
    if (!visible || starting || showComposer || !taskHeading.current || !followNewTask.current) return;
    followNewTask.current = false;
    taskHeading.current.focus();
  }, [visible, starting, showComposer, task?.id]);
  useLayoutEffect(() => { if (visible && panel.current) panel.current.scrollTop = 0; }, [visible, starting, showComposer, task?.id]);
  const taskIsActive = !!task && codingTaskActive(task);
  const activityIsLive = taskIsActive || task?.contract?.approval?.status === "checking";
  const needsReview = task?.status === "awaiting_review" || task?.status === "conflicted";
  const needsContractAction = needsReview || !!task?.contract && (
    task.contract.status === "applied-awaiting-check" && task.contract.approval?.status !== "approved" ||
    !taskIsActive && !!task.contract.repairStage && task.status === "failed"
  );
  const agentSummary = task?.status === "completed" || task?.status === "awaiting_review" ? task.agentSummary : undefined;
  const summaryExcerpt = agentSummary && agentSummary.length > 420 ? `${agentSummary.slice(0, 417).trimEnd()}…` : agentSummary;
  const restartError = task?.runtimeActivation?.status === "failed" ? task.runtimeActivation.detail : undefined;
  const contractProgress = task?.contract ? <ContractTaskProgress task={task} current={taskEvidenceCurrent} decisions={decisions} onDecisionsChange={task.contract.status === "checkpoint" ? values => setDecisionDraft({ taskId: task.id, values }) : undefined} busy={busy} onContinue={task.status === "awaiting_review" && proposal && task.contract.status === "checkpoint" ? () => { void coding.continueContract(decisions); } : undefined} /> : null;
  const activity = task ? <CodingTaskActivity key={task.id} task={task} events={coding.events.data?.events ?? []} loading={coding.events.isPending} unavailable={!!coding.eventsError} /> : null;
  return <section ref={panel} aria-label="Coding tasks" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-sheet p-4 text-label">
    {visible && showComposer ? <CodingContextReader includeContext={includeContext} onContext={setContext} /> : null}
    <div className="mx-auto grid w-full max-w-[880px] gap-4">
      <div className="flex flex-wrap items-end gap-2 border-b border-rule pb-3">
        <label className="grid min-w-0 flex-[1_1_180px] gap-1 text-caption text-graphite" htmlFor="coding-task-select">Saved tasks
          <Select className="text-label text-ink" id="coding-task-select" value={showComposer && !starting ? "" : coding.selected ?? ""} disabled={busy || !coding.list.data?.tasks.length} onChange={event => { coding.select(event.target.value); setComposeOpen(false); }}>
            {!coding.list.data?.tasks.length || showComposer ? <option value="" disabled>{coding.listError ? "Task history unavailable" : coding.list.isPending ? "Loading tasks…" : coding.list.data?.tasks.length ? "Choose a task" : "No coding tasks yet"}</option> : null}
            {coding.list.data?.tasks.map(item => <option key={item.id} value={item.id}>{codingListStatus(item, !!coding.listError)} · {taskTitle(item)}</option>)}
          </Select>
        </label>
        {!showComposer ? <Button type="button" variant="primary" disabled={busy} onClick={() => { setComposeOpen(true); requestAnimationFrame(() => composer.current?.focus()); }}>{draft.trim() ? "Continue draft" : "New task"}</Button> : null}
        {activeTask && (showComposer || !taskIsActive) ? <Button type="button" variant="quiet" disabled={busy} onClick={() => { coding.select(activeTask.id); setComposeOpen(false); }}>View active task</Button> : null}
        {task ? <Button type="button" variant="quiet" size="dense" title="Refresh tasks" aria-label="Refresh tasks" disabled={busy} onClick={coding.retry}><RefreshCw size={14} aria-hidden /><span className="vp-480:sr-only">Refresh tasks</span></Button> : null}
      </div>
      {!task && coding.list.isPending && !composeOpen ? <p role="status" className="m-0 text-graphite">Loading coding tasks…</p> : null}
      {starting ? <Notice tone="neutral" role="status"><strong>Starting your task…</strong><p className="mb-0 mt-1 text-graphite">Connecting to the local coding runner.</p></Notice> : null}
      {error ? <Notice role="alert">{error} <Button type="button" variant="link" onClick={coding.retry}>Retry</Button></Notice> : null}
      <CodingRecoveryPanel repository={repository} visible={visible} reportedProblem={error} />
      {incoming ? <Notice tone="warning" role="status">
        <p className="mt-0">Use the suggested prompt or keep your draft.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={applyPrepared}>Use suggested prompt</Button>
          <Button type="button" disabled={busy} onClick={() => {
            handledRequest.current = incoming.id; onPreparedHandled?.(incoming.id);
            requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
          }}>Keep current draft</Button>
        </div>
      </Notice> : null}
      {showComposer ? <div hidden={starting}><section aria-label="New coding task" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-body font-semibold">New coding task</h2>
          {previewContext ? <StudioContextControl value={previewContext} includeContext={includeContext} onIncludeContextChange={setIncludeContext}
            description={submittedContext ? "This retry uses the snapshot captured when you first started the task." : "Captured when you start the task. Retries use the original snapshot."}
            previewLabel="Coding task context" /> : null}
        </div>
        <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="grid min-w-0 rounded-lg border border-rule-strong bg-paper focus-within:border-faint">
            <label className="sr-only" htmlFor="coding-prompt">Coding request</label>
            <textarea ref={composer} id="coding-prompt" rows={3} maxLength={CODING_PROMPT_LIMIT} required value={draft} disabled={busy}
              placeholder="Describe a change…" aria-describedby="coding-prompt-help"
              className="block min-w-0 resize-y rounded-lg border-0 bg-transparent px-3 pt-3 pb-1 text-body leading-5 outline-none placeholder:text-faint focus-visible:outline-none"
              onChange={event => { setDraft(event.target.value); submission.current = undefined; }}
              onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
            <div className="flex min-w-0 flex-wrap items-center gap-1 p-2">
              <AgentModelControls id="studio-coding" provider={provider} onProviderChange={setProvider} model={model} onModelChange={setModel}
                models={catalog.data?.models} modelUnavailable={missingModel} loading={catalog.isFetching && !catalog.data}
                available={selectedProvider?.available === true} disabled={busy} />
              <Button type="submit" size="compact" variant="primary" disabled={!canSubmit} className="ml-auto">Start coding task</Button>
            </div>
          </div>
          <p id="coding-prompt-help" className="m-0 text-caption text-graphite">Studio chooses checks based on the files changed. Ctrl+Enter or Command+Enter starts the task.</p>
          {choosingProvider && (status.isPending ? <p role="status" className="m-0 text-caption text-graphite">Checking your local agents…</p> : status.error || selectedProvider?.available !== true ? <Notice tone="warning">{status.error?.message ?? selectedProvider?.detail ?? "Check your local CLI installation to get started."} <Button type="button" variant="link" onClick={() => void status.refetch()}>Check again</Button></Notice> : null)}
          {choosingProvider && modelProblem ? <Notice tone="warning">{modelProblem} <Button type="button" variant="link" disabled={catalog.isFetching} onClick={() => { refreshCatalog.current = true; void catalog.refetch(); }}>Refresh models</Button></Notice> : null}
          {studio.draft.dirty ? <p className="m-0 text-caption text-graphite">Unsaved Studio drafts are excluded. The task starts from saved project files.</p> : null}
          {activeTask ? <p className="m-0 text-caption text-graphite">A new task may wait for the coding runner to be free.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            {task ? <Button type="button" size="compact" variant="quiet" disabled={busy} onClick={() => setComposeOpen(false)}>Back to task</Button> : null}
            <p className="m-0 text-caption text-graphite">The agent works in a private copy. You review changes before they’re applied.</p>
          </div>
          <details className="border-t border-rule pt-2 text-caption" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer font-medium">Task settings{validationKind !== "automatic" ? " · Custom checks" : ""}</summary>
            {settingsOpen ? <div className="mt-3 grid gap-2">
              <label className="grid gap-1" htmlFor="coding-validation">Checks
                <Select id="coding-validation" value={validationKind} disabled={busy} onChange={event => { setValidationKind(event.target.value as typeof validationKind); submission.current = undefined; }}>
                  <option value="automatic">Automatic</option><option value="project">Project verify or test</option><option value="framework">Framework declarations</option><option value="tests">Selected source tests</option>
                </Select>
              </label>
              {validationKind === "tests" ? <>
                <label className="grid gap-1" htmlFor="coding-test-paths">Test paths<Textarea id="coding-test-paths" rows={3} value={testPaths} disabled={busy} aria-describedby="coding-validation-help" aria-invalid={!!validation.problem} onChange={event => { setTestPaths(event.target.value); submission.current = undefined; }} placeholder="test/example.test.ts" /></label>
                <p id="coding-validation-help" className="m-0 text-caption text-graphite">{validation.problem ?? "Enter one path per line. Studio runs these tests for the review."}</p>
              </> : null}
            </div> : null}
          </details>
        </form>
      </section></div> : null}
      {task && !starting && !showComposer ? <article aria-label="Selected coding task" className="grid min-w-0 gap-3">
        <header className="grid min-w-0 gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 ref={taskHeading} tabIndex={-1} aria-live="polite" className="m-0 text-body font-semibold">{task.contract && !taskEvidenceCurrent ? "Task evidence unavailable" : task.status === "awaiting_review" && candidateProofProblem ? "Candidate proof needs renewal" : codingListStatus(task, false)}</h2>
            {taskIsActive && task.status !== "integrating" ? <Button type="button" variant="quiet" disabled={busy || task.cancelRequested} onClick={() => void coding.cancel()}>{task.cancelRequested ? "Cancellation requested" : "Cancel task"}</Button> : null}
            {["interrupted", "failed", "cancelled"].includes(task.status) ? <Button type="button" variant="primary" disabled={busy} onClick={() => void coding.resume()}>{task.contract?.repairStage === "client" ? "Repair authored operations" : "Resume task"}</Button> : null}
          </div>
          <p className="m-0 wrap-anywhere">{taskTitle(task)}</p>
          {task.status === "completed" && task.sourceOutcome === "applied" ? <p className="m-0 text-graphite">Changes applied to your project.</p> : null}
          {task.status === "completed" && task.sourceOutcome === "unchanged" ? <p className="m-0 text-graphite">{task.contract?.approval?.status === "approved" ? "Contract checks approved. No files changed." : "No files changed."}</p> : null}
          {task.status === "rejected" ? <p className="m-0 text-graphite">The proposal was rejected. No changes were applied.</p> : null}
          {summaryExcerpt ? <p className="m-0 whitespace-pre-wrap text-caption text-graphite wrap-anywhere"><strong>Agent summary</strong><br />{summaryExcerpt}</p> : null}
          {!taskIsActive && ["failed", "interrupted", "recovery_required"].includes(task.status) && task.summary ? <p className="m-0 text-caption text-graphite wrap-anywhere">{task.summary}</p> : null}
        </header>
        {coding.pending ? <p role="status" className="m-0 text-caption">{coding.pending}…</p> : null}
        {task.sourceOutcome === "restored" ? <Notice tone="warning">Integration stopped and its writes were restored. The task’s changes are not applied.</Notice> : null}
        {task.sourceOutcome === "kept" ? <Notice tone="warning">Current source was kept after recovery. Verify the files before using the proposal.</Notice> : null}
        {task.status === "conflicted" ? <Notice tone="warning">Saved source changed. Refresh the proposal to check it against the current files.</Notice> : null}
        {permission ? <Notice tone="warning"><p className="mt-0">{typeof permission.data.description === "string" ? permission.data.description : "The agent requests permission to continue."}</p><div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => void coding.permission(String(permission.data.id), true)}>Allow task action</Button><Button type="button" disabled={busy} onClick={() => void coding.permission(String(permission.data.id), false)}>Deny task action</Button></div></Notice> : null}
        {activityIsLive ? activity : null}
        {needsContractAction ? contractProgress : null}
        {task.status === "completed" && task.contract?.approval?.status === "failed" && !task.workspaceDisposition ? <div><Button type="button" disabled={busy || !proposal || !taskEvidenceCurrent} onClick={() => void coding.approve()}>Retry checks and approval</Button></div> : null}
        {task.status === "completed" && task.sourceOutcome === "applied" && task.activation === "restart_required" ? <Notice tone={task.runtimeActivation?.status === "ready" ? "success" : task.runtimeActivation?.status === "starting" ? "neutral" : "warning"}>
          <p className="m-0">{task.runtimeActivation?.status === "failed" ? "Studio couldn’t restart. Your changes are saved." : task.runtimeActivation?.detail ?? "Restart Studio to load the changes."}</p>
          {restartError?.startsWith("Another Studio source writer") ? <p className="mb-0 mt-1 text-caption">Another Studio operation was using the project files. Retry when it finishes or complete any source recovery shown above.</p> : restartError ? <details className="mt-2 text-caption"><summary className="cursor-pointer">Restart error</summary><p className="mb-0">{restartError}</p></details> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {task.runtimeActivation?.status !== "ready" ? <Button type="button" disabled={busy || !proposal || !!activationProblem || !!error} onClick={() => void coding.activate()}>{task.runtimeActivation?.status === "starting" ? "Restarting Studio…" : "Restart Studio"}</Button> : null}
            {task.runtimeActivation?.status === "ready" || !!error ? <a className="text-caption underline underline-offset-2" href={window.location.href}>Reload Studio</a> : null}
          </div>
        </Notice> : null}
        {task.proposalDigest && coding.proposal.isPending ? <p role="status" className="m-0">Loading proposed changes…</p> : null}
        {proposal ? <TaskDisclosure key={proposal.digest + (needsReview ? ":review" : ":history")} defaultOpen={needsReview} label={proposal.changes.length ? `${proposal.changes.length} changed ${proposal.changes.length === 1 ? "file" : "files"} and checks` : "Checks and review evidence"}>
          {() => <section aria-label="Proposed changes" className="mt-3 grid min-w-0 gap-3">
            {proposal.validation.length ? <ul aria-label="Task checks" className="m-0 grid list-none gap-2 p-0 text-caption">{proposal.validation.map((check, at) => <li key={at} className="flex flex-wrap items-baseline gap-x-2 wrap-anywhere"><strong className={check.status === "passed" ? "text-accept" : "text-ink"}>{check.status === "passed" ? "Passed" : check.status === "failed" ? "Failed" : "Not verified"}</strong><code>{check.command}</code>{check.detail ? <span className="text-graphite">{check.detail}</span> : null}</li>)}</ul> : null}
            {!proposal.validation.length ? <Notice tone="warning">No validation evidence is available for this proposal.</Notice> : null}
            {task.status === "awaiting_review" && task.canResumeValidation === true && proposal.validation.some(check => check.status === "failed") ? <div>
              <Button type="button" disabled={busy || !!error} onClick={() => void coding.resume()}>{task.contract?.repairStage === "client" ? "Repair authored operations" : "Repair validation failures"}</Button>
              <p className="mb-0 mt-1 text-caption text-graphite">Resumes this agent in its retained working copy with the failed validation evidence. The repaired changes require fresh validation and a new source approval.</p>
            </div> : null}
            {proposal.activation === "restart_required" && task.sourceOutcome !== "applied" ? <Notice tone="warning">Apply these Studio changes, then use Restart Studio to activate them. Source approval and restart are separate actions.</Notice> : proposal.activation === "dependency_install_required" ? <Notice tone="warning">This proposal is retained. Applying dependency changes requires a separate installation and validation.</Notice> : null}
            {proposal.ownership?.refusal ? <Notice tone="warning">Ownership check: {proposal.ownership.refusal}</Notice> : null}
            {proposal.ownership?.transitions.length ? <Notice tone="warning">This proposal changes ownership: {proposal.ownership.transitions.map(item => `${item.entity} ${item.from} → ${item.to} (${item.file})`).join("; ")}. Studio's limits follow the new owner once it is applied.</Notice> : null}
            {proposal.limitations.length ? <details className="text-caption text-graphite"><summary className="cursor-pointer">Check limitations</summary><ul className="mb-0 grid gap-1 pl-5">{proposal.limitations.map((limit, at) => <li key={at}>{limit}</li>)}</ul></details> : null}
            {proposal.architecturePreview ? <ArchitecturePreviewPanel preview={proposal.architecturePreview} digest={proposal.digest} /> : null}
            {proposal.changes.map(change => <div key={change.path} className="grid gap-1">
              <SourceDiff file={change.path} lines={codingDiffLines(change.diff)} note={change.binary ? `${change.kind} · binary file` : change.kind} />
              {change.beforeMode !== change.afterMode ? <p className="m-0 text-caption text-graphite">File mode: {change.beforeMode?.toString(8) ?? "absent"} → {change.afterMode?.toString(8) ?? "absent"}</p> : null}
            </div>)}
            {task.status === "awaiting_review" && (!task.contract || task.contract.status === "ready") ? <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="primary" disabled={busy || !!error || !!approvalProblem} onClick={() => void coding.approve()}>Approve and apply</Button>
              <Button type="button" disabled={busy} onClick={() => void coding.reject()}>Reject proposal</Button>
              <span className="text-caption text-graphite">{approvalProblem ?? "Applies exactly this reviewed proposal to saved source."}</span>
            </div> : null}
            {task.status === "awaiting_review" && task.contract && task.contract.status !== "ready" ? <div><Button type="button" disabled={busy} onClick={() => void coding.reject()}>Reject candidate</Button></div> : null}
            {["awaiting_review", "conflicted"].includes(task.status) ? <div><Button type="button" disabled={busy || !!error} onClick={() => void coding.refresh()}>Refresh candidate from saved source</Button><p className="mb-0 mt-1 text-caption text-graphite">Merges non-overlapping saved edits into a new candidate, then validates and creates a new review. Conflicts preserve both versions.</p></div> : null}
          </section>}
        </TaskDisclosure> : null}
        <TaskDisclosure key={`details:${task.id}`} label="Task details">
          {() => <div className="mt-3 grid min-w-0 gap-3 text-caption">
            <details><summary className="cursor-pointer">Original request</summary><p className="mb-0 whitespace-pre-wrap wrap-anywhere">{task.prompt}</p></details>
            {agentSummary !== summaryExcerpt ? <details><summary className="cursor-pointer">Full agent summary</summary><p className="mb-0 whitespace-pre-wrap wrap-anywhere">{agentSummary}</p></details> : null}
            {!activityIsLive ? activity : null}
            {!needsContractAction ? contractProgress : null}
            {task.workspaceDisposition === "source_only" ? <p className="m-0 text-graphite">Temporary task files removed. Review history is still available.</p> : ["completed", "rejected"].includes(task.status) && task.contract?.approval?.status !== "checking" && task.runtimeActivation?.status !== "starting" ? <div><Button type="button" disabled={busy} onClick={() => void coding.cleanup()}>Clean up temporary task files</Button></div> : null}
          </div>}
        </TaskDisclosure>
      </article> : null}
      <CodingHostPanel repository={repository} visible={visible} active={!!activeTask} />
    </div>
  </section>;
}

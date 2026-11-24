import { cx } from "../../ui/classes";
import { Button, buttonClasses } from "../../ui/Button";

import {
  Check,
  ChevronUp,
  Circle,
  CircleDot,
  ListTodo,
  LoaderCircle,
  Minus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DockerPresence } from "../../../shared/machine";
import { changesAws, LOCAL_DATABASE_PREPARATION_STEP, LOCAL_DATABASE_VERIFICATION_STEP, type JobStep, type JobView } from "../../../shared/operations";
import { Link } from "@tanstack/react-router";
import { ActivityHistory, JobGlyph } from "./ActivityHistory";
import { Elapsed } from "./ActivityClock";
import { ActivityOutput, focusLogFilter } from "./ActivityOutput";
import { DockerStatus } from "./DockerStatus";
import { activityHistory, formatDuration, isProcess, jobDuration, jobOutcome, recoveredLocalFailure, statusTone, toneClasses } from "./activity-model";
import { finishedAnnouncement, useFinishedJob, useTabStatus } from "./useJobNotices";
import { useActivityResize } from "./useActivityResize";

const RESIZE_EDGE = "absolute -top-1 left-0 z-10 h-2 w-full hover:bg-dev/30 focus-visible:bg-dev/30 in-[[data-activity-resizing]]:bg-dev/30 transition-colors duration-100 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

/** A startup records the past; only the live status says whether Docker is running now. */
function summary(job: JobView, docker: DockerPresence): string | undefined {
  if (job.kind !== "docker-start" || job.status !== "succeeded") return job.summary;
  return docker.engine === "stopped" ? "Docker has since stopped." : undefined;
}

/** The result, plus anything the job said beyond it. */
function jobText(job: JobView, docker: DockerPresence): { readonly outcome: string; readonly detail?: string } {
  const note = summary(job, docker);
  const outcome = jobOutcome(job, job.kind === "docker-start" ? undefined : note);
  return { outcome, ...(note && note !== outcome ? { detail: note } : {}) };
}

/** The Docker status covers startups, except the latest failure explaining why Docker is still off. */
function coveredByDockerStatus(job: JobView, jobs: readonly JobView[], docker: DockerPresence): boolean {
  if (job.kind !== "docker-start") return false;
  const unresolved = (job.status === "failed" || job.status === "interrupted") && docker.engine !== "running";
  return !unresolved || job !== jobs.find((entry) => entry.kind === "docker-start");
}

/** The history row carries a running job's spinner; here the active step is a steady mark. */
function StepIcon({ step, job }: { readonly step: JobStep; readonly job: JobView }) {
  if (step.status === "done") return <Check size={13} aria-label="done" className="flex-none text-accept" />;
  if (step.status === "running") return <CircleDot size={13} aria-label="running" className={cx("flex-none", toneClasses[statusTone(job)])} />;
  if (step.status === "failed") return <X size={13} aria-label="failed" className="flex-none text-refuse" />;
  if (step.status === "skipped") return <Minus size={13} aria-label="skipped" className="flex-none" />;
  return <Circle size={13} aria-label="pending" className="flex-none" />;
}

function StepTime({ step }: { readonly step: JobStep }) {
  if (!step.startedAt) return null;
  const elapsed = step.endedAt ? jobDuration({ startedAt: step.startedAt, endedAt: step.endedAt }) : undefined;
  if (step.status !== "running" && elapsed === undefined) return null;
  return <span className="font-mono text-meta text-quiet tabular-nums">{step.status === "running" ? <Elapsed since={step.startedAt} /> : formatDuration(elapsed!)}</span>;
}

/** Duration, exit code and scope: recorded facts a developer would otherwise dig out of the log. */
function JobFacts({ job }: { readonly job: JobView }) {
  const duration = jobDuration(job);
  const facts: ReactNode[] = [
    ...(job.status === "running" ? [<Elapsed key="time" since={job.startedAt} />] : duration === undefined ? [] : [formatDuration(duration)]),
    ...(typeof job.exitCode === "number" ? [`exit ${job.exitCode}`] : []),
    ...(job.kind === "deploy-plan" && !changesAws(job) ? ["read-only"] : []),
  ];
  if (!facts.length) return null;
  return <span className="font-mono text-meta text-quiet tabular-nums">{facts.flatMap((fact, index) => index ? [" · ", fact] : [fact])}</span>;
}

function JobHeader({ job, docker, onCancel }: { readonly job: JobView; readonly docker: DockerPresence; readonly onCancel: (id: string) => void }) {
  const { outcome, detail } = jobText(job, docker);
  const activeStep = job.steps?.length === 1 && job.status === "running" ? job.steps[0]?.label : undefined;
  // A failed job's reason is the notice below, with its evidence.
  const note = job.status === "failed" ? undefined : detail ?? activeStep;
  const stoppable = job.status === "running" && job.execution !== "lost";
  const inAws = changesAws(job);
  return <header className="flex flex-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 wrap-anywhere">
    <div className="flex min-w-50 flex-1 flex-wrap items-baseline gap-x-2">
      <strong className="font-semibold">{job.title}</strong>
      <span className={cx("text-step-minus1", toneClasses[statusTone(job)])}>{outcome}</span>
      {note ? <span className="text-caption text-quiet">{note}</span> : null}
      <JobFacts job={job} />
    </div>
    <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1">
      {stoppable && inAws ? <span className="text-caption text-quiet">Stacks already started finish in AWS.</span> : null}
      {stoppable ? <Button type="button" variant="quiet" size="compact" disabled={job.cancelRequested} onClick={() => onCancel(job.id)}>
        <Square size={12} aria-hidden /> {isProcess(job) ? "Stop" : inAws ? "Stop command" : "Cancel"}
      </Button> : null}
    </div>
  </header>;
}

function JobSteps({ job }: { readonly job: JobView }) {
  if (!job.steps || job.steps.length < 2) return null;
  return <ol className="m-0 flex flex-none list-none flex-wrap gap-x-4 gap-y-1 px-4 pt-0 pb-2 text-step-minus1 text-quiet">
    {job.steps.map((step, index) => <li key={index} className={cx("inline-flex items-center gap-1", step.status === "running" ? "font-medium text-ink" : step.status === "failed" ? "text-refuse" : undefined)}>
      <StepIcon step={step} job={job} /> {step.label} <StepTime step={step} />
    </li>)}
  </ol>;
}

/**
 * What Studio is doing and has done: each operation's steps and its live log,
 * replayed from where the page last saw it. Long-running local processes (the
 * watch, the web client) are jobs too, until stopped.
 */
export function Activity(props: {
  readonly jobs: readonly JobView[];
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onCancel: (id: string) => void;
  readonly loading?: boolean;
  readonly problem?: string;
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
  readonly actionError?: string;
  readonly docker: DockerPresence;
  readonly onStartDocker: () => void;
  readonly onCheckDocker: () => Promise<unknown>;
  readonly mode?: "activity" | "agent";
  readonly onModeChange?: (mode: "activity" | "agent") => void;
  readonly agent?: ReactNode;
  /** The open Agent panel's own views, shown in the bar in place of its summary. */
  readonly agentViews?: ReactNode;
  readonly agentSummary?: string;
  readonly agentPending?: boolean;
  readonly agentUnread?: boolean;
  /** Turns paths in logs into editor links; absent until Studio's snapshot arrives. */
  readonly repositoryRoot?: string;
  /** Puts an editable message in the Agent composer. Nothing is sent without the developer. */
  readonly onAskAgent?: (prompt: string) => void;
}) {
  const mode = props.mode ?? "activity";
  const drawer = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const resize = useActivityResize({ drawer, bar, open: props.open, onExpand: props.onToggle, onCollapse: () => {
    props.onToggle();
    toggle.current?.focus();
  } });
  const motionRoot = useRef<HTMLElement | undefined>(undefined);
  const [revealed, setRevealed] = useState(props.open);
  const visible = props.open || revealed;
  // Keep contents mounted for the closing motion, but remove their focus/accessibility
  // surface immediately. Reduced motion settles both layout and visibility together.
  useLayoutEffect(() => {
    if (props.open) { setRevealed(true); return; }
    if (!window.matchMedia || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRevealed(false);
      return;
    }
    const timer = window.setTimeout(() => setRevealed(false), 320);
    return () => window.clearTimeout(timer);
  }, [props.open]);
  useLayoutEffect(() => {
    const element = drawer.current;
    if (!element) return;
    const root = element.closest<HTMLElement>('[data-ui="shell"]') ?? element;
    motionRoot.current = root;
    const previous = root.style.getPropertyValue("--activity-drawer-visible");
    return () => {
      if (previous) root.style.setProperty("--activity-drawer-visible", previous);
      else root.style.removeProperty("--activity-drawer-visible");
      motionRoot.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    const root = motionRoot.current;
    if (!root) return;
    const finish = (event: TransitionEvent) => {
      if (event.target === root && event.propertyName === "--activity-drawer-visible" && !props.open) setRevealed(false);
    };
    root.addEventListener("transitionend", finish);
    // One typed CSS length animates on the common ancestor. The drawer and map
    // inherit the same value in the same frame; no resize observer can lag behind.
    root.style.setProperty("--activity-drawer-visible", props.open ? "var(--activity-drawer)" : "0px");
    return () => root.removeEventListener("transitionend", finish);
  }, [props.open]);
  const history = useMemo(() => activityHistory(props.jobs), [props.jobs]);
  const job = props.jobs.find((entry) => entry.id === props.selected);
  const headlines = (entry: JobView) => !coveredByDockerStatus(entry, props.jobs, props.docker) && !recoveredLocalFailure(entry, props.jobs);
  // Only an explicit selection supplies detail or a closed-bar headline.
  const headline = !props.open && job && headlines(job) ? job : undefined;
  const headlineText = headline && jobText(headline, props.docker);
  const activeStep = headline?.steps?.find((step) => step.status === "running")?.label;
  const agentViews = mode === "agent" && props.open ? props.agentViews : undefined;
  const finished = useFinishedJob(props.jobs);
  useTabStatus(props.jobs, finished);

  // Ctrl+` is the terminal toggle developers already know, and browsers leave it free.
  const opened = useRef(props.open);
  opened.current = props.open;
  const returnFocus = useRef<Element | null>(null);
  const onToggle = useRef(props.onToggle);
  onToggle.current = props.onToggle;
  const focusRow = useRef(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.code !== "Backquote") return;
      event.preventDefault();
      if (opened.current) {
        const previous = returnFocus.current;
        onToggle.current();
        (previous instanceof HTMLElement && previous.isConnected ? previous : toggle.current)?.focus();
      } else {
        returnFocus.current = document.activeElement;
        focusRow.current = true;
        onToggle.current();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (!props.open || !focusRow.current) return;
    focusRow.current = false;
    const target = mode === "agent"
      ? bar.current?.querySelector<HTMLElement>('[role="tab"][aria-controls^="agent-"][aria-selected="true"]')
      : drawer.current?.querySelector<HTMLElement>('[data-history-row][tabindex="0"]');
    (target ?? bar.current?.querySelector<HTMLElement>(`[data-mode="${mode}"]`) ?? toggle.current)?.focus();
  }, [props.open, mode]);

  return (
    <div data-ui="activity-slot" className="h-[min(calc(var(--activity-drawer-visible)+var(--activity-bar-height,40px)+1px),var(--activity-slot-max,100dvh))] min-h-0 min-w-0">
    <section className="absolute inset-x-0 bottom-0 z-10 min-h-0 min-w-0 border-t border-rule-strong bg-sheet" aria-label="Activity" onKeyDown={event => {
      // Native dialogs own Escape and focus restoration before tray shortcuts apply.
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      if (event.key === "Escape" && props.open && props.agent) {
        event.preventDefault(); props.onToggle();
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)?.focus();
      }
      if (event.key === "/" && props.open && mode === "activity" && !event.metaKey && !event.ctrlKey && !(event.target as Element).closest("input, textarea, select")) {
        event.preventDefault(); focusLogFilter();
      }
    }}>
      {/* The bar and history show results; this speaks them to anyone not looking there. */}
      <span aria-live="polite" className="sr-only">{finishedAnnouncement(finished)}</span>
      {props.open ? <div data-ui="activity-resize-edge" role="separator" aria-label="Resize bottom panel" aria-orientation="horizontal"
        aria-controls="studio-activity-drawer" aria-valuemin={resize.min} aria-valuemax={resize.max} aria-valuenow={Math.round(resize.height)}
        aria-valuetext={`${Math.round(resize.height)} pixels`} tabIndex={0}
        title="Drag to resize the bottom panel, or drag below its minimum height to close. Use Up and Down arrow keys when focused."
        className={cx(RESIZE_EDGE, "cursor-row-resize touch-none select-none focus-visible:-outline-offset-2")}
        {...resize.pointer} onKeyDown={event => { if (resize.resizeByKey(event.key)) event.preventDefault(); }} /> : null}
      {/* Modes reveal their panel; the chevron toggles it. Docker remains independent. */}
      <div ref={bar} data-ui="activity-bar" {...resize.pointer} className={cx("grid min-w-0 items-center gap-x-3", !props.open && "cursor-row-resize touch-none select-none", props.agent ? "grid-cols-[auto_minmax(0,1fr)_auto_32px] pl-3 vp-480:pl-2" : "grid-cols-[minmax(0,1fr)_auto_auto] vp-480:grid-cols-[minmax(0,1fr)_auto]")}>
        {!props.open ? <span data-ui="activity-resize-edge" aria-hidden className={RESIZE_EDGE} /> : null}
        {props.agent ? <div className="col-start-1 row-start-1 flex items-center gap-1 py-1" role="tablist" aria-label="Panel mode"
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "activity" : event.key === "End" ? "agent" : mode === "activity" ? "agent" : "activity";
            props.onModeChange?.(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
          }}>
          {(["activity", "agent"] as const).map(value => <button key={value} type="button" role="tab" data-mode={value}
            id={`studio-${value}-tab`} aria-label={value === "agent" ? "Agent" : "Activity"} aria-controls={`studio-${value}-panel`} aria-selected={mode === value} tabIndex={mode === value ? 0 : -1}
            onClick={() => props.onModeChange?.(value)}
            className={cx("inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border px-3 py-1 text-label font-medium transition-colors vp-480:px-2", mode === value ? "border-selected-rule bg-selected text-selected-ink" : "border-transparent bg-transparent text-graphite hover:bg-wash hover:text-ink")}>
            {/* The agent's state takes the icon's place and corner, so the views beside it never shift. */}
            {value === "activity" ? <span className="relative flex"><ListTodo size={14} aria-hidden /></span> : props.agentPending ? <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-label="Thinking" />
              : <span className="relative flex"><Sparkles size={14} aria-hidden />{props.agentUnread ? <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accept" aria-label="New reply" /> : null}</span>}
            {value === "activity" ? "Activity" : "Agent"}
          </button>)}
        </div> : null}
        {agentViews ? <div className="relative z-1 col-start-2 row-start-1 flex items-center gap-3 justify-self-start vp-480:col-start-1 vp-480:row-start-2 vp-480:pb-1">
          <span aria-hidden className="h-4 w-px bg-rule-strong vp-480:hidden" />
          {agentViews}
        </div> : null}
        <button
          ref={toggle}
          className={cx("row-start-1 grid min-h-9 min-w-0 cursor-pointer grid-cols-subgrid items-center border-0 bg-transparent py-2 text-left text-inherit hover:bg-wash transition-[background-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", props.agent ? "col-start-2 -col-end-1 pr-3" : "col-span-full px-4")}
          onClick={props.onToggle}
          aria-expanded={props.open}
          aria-controls="studio-activity-drawer"
          aria-label={props.agent ? `${mode === "activity" ? "Activity" : "Agent"}: ${props.open ? "collapse" : "expand"} panel` : undefined}
          title={props.open ? "Ctrl+` also closes this panel." : "Click to expand or drag up to open the bottom panel. Ctrl+` also opens it."}
        >
          <span className={cx("col-start-1 flex min-w-0 items-center gap-3", !!props.agent && "pl-3 vp-480:invisible")}>
            {!props.agent ? <strong className="flex-none">Activity</strong> : null}
            {agentViews ? null : mode === "agent" ? <span className="truncate text-caption text-graphite">{props.agentSummary ?? "Ask a question"}</span> : headline && headlineText ? (
              <span className={cx("flex min-w-0 items-center gap-1.5 text-step-minus1", headline.status === "failed" && "text-refuse")}>
                {headline.status === "running" ? <JobGlyph job={headline} /> : null}
                <span className="truncate">
                  {headline.title}
                  <span className="text-quiet">
                    {" · "}
                    {headline.status === "running"
                      ? <>{activeStep ? <>{activeStep}{" · "}</> : null}<Elapsed since={headline.startedAt} /></>
                      : <span className={toneClasses[statusTone(headline)]}>{headlineText.outcome}</span>}
                    {headline.status !== "running" && headlineText.detail ? ` · ${headlineText.detail}` : null}
                  </span>
                </span>
              </span>
            ) : !props.jobs.length && props.problem ? (
              <span className="text-graphite">Activity unavailable</span>
            ) : null}
          </span>
          <ChevronUp size={15} className={cx("col-start-3 flex-none transition-transform duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", props.open && "rotate-180", !props.agent && "vp-480:col-start-2")} aria-hidden />
        </button>
        <DockerStatus
          presence={props.docker}
          onStart={props.onStartDocker}
          onCheck={props.onCheckDocker}
          className={cx("row-start-1 vp-480:row-start-2", !props.agent ? "col-start-2 vp-480:col-span-full vp-480:col-start-1 vp-480:px-2 vp-480:pb-2"
            // One row height whether or not the views share it, so changing mode moves nothing.
            : cx("col-start-3 vp-480:min-h-9 vp-480:pb-1", agentViews ? "vp-480:col-span-3 vp-480:col-start-2 vp-480:justify-end vp-480:pr-2" : "vp-480:col-span-full vp-480:col-start-1 vp-480:px-2"))}
        />
      </div>
      <div ref={drawer} id="studio-activity-drawer" data-ui={visible ? "activity-drawer" : undefined}
        aria-hidden={!props.open} inert={!props.open}
        className="h-(--activity-drawer-visible) min-h-0 overflow-hidden">
        {/* Fixed-height contents slide as a unit instead of squeezing during motion. */}
        <div hidden={!visible} className="flex h-(--activity-drawer) min-h-0 flex-col border-t border-rule">
          {props.agent ? <div id="studio-agent-panel" role="tabpanel" aria-labelledby="studio-agent-tab" hidden={mode !== "agent"} className="flex min-h-0 flex-1 flex-col">{props.agent}</div> : null}
          <div id={props.agent ? "studio-activity-panel" : undefined} role={props.agent ? "tabpanel" : undefined} aria-labelledby={props.agent ? "studio-activity-tab" : undefined} hidden={mode !== "activity"} tabIndex={0} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {props.problem ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-2" role="alert">
              <span>{props.problem}</span>
              <button className={buttonClasses({ variant: "quiet", size: "compact" })}
                disabled={props.retrying} onClick={props.onRetry}>Retry activity</button>
            </div>
          ) : null}
          {props.actionError ? (
            <p className="m-0 border-t border-rule px-4 py-2 text-refuse" role="alert">{props.actionError}</p>
          ) : null}
          {props.docker.detail ? (
            <p className="m-0 border-t border-rule px-4 py-2 text-caption text-graphite wrap-anywhere">{props.docker.detail}</p>
          ) : null}
          <div className="grid min-h-30 flex-1 grid-cols-[272px_minmax(0,1fr)] border-t border-rule vp-900:grid-cols-1 vp-900:grid-rows-[auto_auto]">
            <ActivityHistory groups={history} selected={job?.id} onSelect={props.onSelect} />
            {job ? (
              <div className="flex min-h-0 min-w-0 flex-col">
                <JobHeader job={job} docker={props.docker} onCancel={props.onCancel} />
                {job.observationProblem ? <p role="status" className="m-0 flex-none px-4 pb-2 text-caption text-caution">{job.observationProblem}</p> : null}
                <JobSteps job={job} />
                {job.status === "failed" && ["local-start", "local-restart"].includes(job.kind)
                  && job.steps?.some(step => [LOCAL_DATABASE_PREPARATION_STEP, LOCAL_DATABASE_VERIFICATION_STEP].includes(step.label) && step.status === "failed") ? (
                  <p className="m-0 px-4 pb-2 text-caption">
                    <Link to="/database/status" className={buttonClasses({ variant: "link", size: "compact" })}>Review local database</Link>
                    <span className="text-quiet"> Empty local storage is initialized during startup. Inspect this target's existing objects, signature or pending migrations before retrying.</span>
                  </p>
                ) : null}
                <ActivityOutput job={job} active={visible && mode === "activity"} repositoryRoot={props.repositoryRoot} onAskAgent={props.onAskAgent} />
              </div>
            ) : (
              <p className="text-graphite p-4" role={props.loading ? "status" : undefined}>
                {props.loading ? "Reading activity…" : props.problem ? "Restore the connection to read recorded operations." : props.jobs.length ? "Select an activity to view its steps and log." : "Operations you start in Studio appear with their steps and log."}
              </p>
            )}
          </div>
          </div>
        </div>
      </div>
    </section>
    </div>
  );
}

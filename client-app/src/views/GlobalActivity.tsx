import { lazy, memo, Suspense, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobView } from "../../shared/operations";
import { ASK_AGENT_EVENT, OPEN_ACTIVITY_EVENT } from "../activity";
import { operationsApi } from "../operations/api";
import { useOperationsLive } from "../operations/live";
import { operationsQuery, orderJobs } from "../operations/queries";
import { Activity } from "./deploy/Activity";
import { useDockerStart, useDockerStatus } from "../machine/docker";
import { dockerPresence } from "../../shared/machine";
import { useAgentChat } from "../agent-chat";
import { snapshotQueryKey } from "../snapshot";
import { readActivityPreferences, saveActivityPreferences, type ActivityMode } from "./deploy/activity-preferences";
import { AgentViewTabs, type AgentView } from "./agent/AgentViewTabs";
import { OPEN_CODING_TASK_EVENT, PREPARE_CODING_TASK_EVENT, type CodingTaskNavigation, type CodingTaskPreparation } from "../coding-task-navigation";
import type { CodingTask } from "../../shared/agent-runtime";
const AgentPanel = lazy(() => import("../sightline/AgentViews").then(module => ({ default: module.AgentViews })));

const NO_JOBS: readonly JobView[] = [];
const selectJobs = (overview: { jobs: readonly JobView[] }) => orderJobs(overview.jobs);
/** The composer's own limit: an over-long draft could not be sent. */
const DRAFT_LIMIT = 4000;

/** Route-independent state and subscriptions; navigation does not render this tray. */
export const GlobalActivity = memo(function GlobalActivity() {
  const queryClient = useQueryClient();
  const docker = useDockerStatus();
  const { start, starting } = useDockerStart();
  const overview = useQuery({
    ...operationsQuery(),
    select: selectJobs,
    staleTime: 30_000,
    refetchInterval: query => query.state.data?.jobs.some(job => job.kind === "docker-start" && job.status === "running") ? 1000 : 30_000,
    retry: false,
    notifyOnChangeProps: ["data", "error", "isPending"],
  });
  useOperationsLive();
  // A plain read: the shell owns this query, and observing it here could change how it fetches.
  const repositoryRoot = queryClient.getQueryData<{ snapshot?: { repositoryRoot?: string } }>(snapshotQueryKey)?.snapshot?.repositoryRoot;
  const [preferences] = useState(readActivityPreferences);
  const [open, setOpen] = useState(preferences.open ?? false);
  const [mode, setMode] = useState<ActivityMode>(preferences.mode ?? "activity");
  const [agentVisited, setAgentVisited] = useState(preferences.open === true && preferences.mode === "agent");
  const [agentView, setAgentView] = useState<AgentView>(preferences.agentView ?? "conversation");
  const [preparedCoding, setPreparedCoding] = useState<CodingTaskPreparation>();
  const [revealedCoding, setRevealedCoding] = useState<{ readonly repository: string; readonly id: string }>();
  const handledPreparation = useCallback((id: string) => setPreparedCoding(current => current?.request.id === id ? undefined : current), []);
  const agentVisible = open && mode === "agent";
  const chat = useAgentChat(agentVisible && agentView === "conversation");
  const [selected, setSelected] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const openMode = useCallback((value: ActivityMode) => {
    setMode(value);
    setOpen(true);
    if (value === "agent") setAgentVisited(true);
  }, []);
  const revealAgent = useCallback((view: AgentView) => {
    setAgentView(view);
    openMode("agent");
  }, [openMode]);
  useEffect(() => {
    const reveal = (event: Event) => {
      const job = (event as CustomEvent<unknown>).detail;
      if (typeof job !== "string") return;
      setSelected(job);
      setMode("activity");
      setOpen(true);
      // A durable acceptance response can arrive while the live stream is disconnected.
      void queryClient.invalidateQueries({ queryKey: operationsQuery().queryKey });
    };
    window.addEventListener(OPEN_ACTIVITY_EVENT, reveal);
    return () => window.removeEventListener(OPEN_ACTIVITY_EVENT, reveal);
  }, [queryClient]);
  useEffect(() => {
    let focusFrame: number | undefined;
    const currentRepository = () => queryClient.getQueryData<{ snapshot?: { repositoryRoot?: string } }>(snapshotQueryKey)?.snapshot?.repositoryRoot;
    const revealCoding = () => {
      revealAgent("coding");
      // The originating modal closes first so focus can move into the revealed tray.
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => document.getElementById("agent-coding-tab")?.focus());
    };
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<CodingTaskNavigation>).detail;
      if (!detail?.repository || detail.repository !== currentRepository() || !detail.task?.id) return;
      queryClient.setQueryData<{ tasks: readonly CodingTask[] }>(["coding-tasks", detail.repository], current => ({ tasks: [detail.task, ...(current?.tasks ?? []).filter(task => task.id !== detail.task.id)] }));
      setRevealedCoding({ repository: detail.repository, id: detail.task.id });
      revealCoding();
    };
    const prepare = (event: Event) => {
      const detail = (event as CustomEvent<CodingTaskPreparation>).detail;
      if (!detail?.request?.id || detail.repository !== currentRepository()) return;
      setPreparedCoding(detail);
      revealCoding();
    };
    window.addEventListener(OPEN_CODING_TASK_EVENT, reveal);
    window.addEventListener(PREPARE_CODING_TASK_EVENT, prepare);
    return () => {
      window.removeEventListener(OPEN_CODING_TASK_EVENT, reveal);
      window.removeEventListener(PREPARE_CODING_TASK_EVENT, prepare);
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    };
  }, [queryClient, revealAgent]);
  useEffect(() => { saveActivityPreferences({ open, mode, agentView }); }, [open, mode, agentView]);
  const toggle = useCallback(() => {
    if (mode === "agent") setAgentVisited(true);
    setOpen(value => !value);
  }, [mode]);
  const { setDraft } = chat;
  const askAgent = useCallback((prompt: string) => {
    setDraft(current => (current.trim() ? `${current.trim()}\n\n${prompt}` : prompt).slice(0, DRAFT_LIMIT));
    revealAgent("conversation");
  }, [setDraft, revealAgent]);
  useEffect(() => {
    let focusFrame: number | undefined;
    const prepare = (event: Event) => {
      const prompt = (event as CustomEvent<unknown>).detail;
      if (typeof prompt !== "string") return;
      askAgent(prompt);
      // Already open, the panel has no reveal to focus its composer for us.
      focusFrame = requestAnimationFrame(() => document.getElementById("studio-agent-question")?.focus({ preventScroll: true }));
    };
    window.addEventListener(ASK_AGENT_EVENT, prepare);
    return () => { window.removeEventListener(ASK_AGENT_EVENT, prepare); if (focusFrame !== undefined) cancelAnimationFrame(focusFrame); };
  }, [askAgent]);
  const startDocker = useCallback(async () => {
    setActionError(undefined);
    try {
      setSelected((await start()).id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      setMode("activity");
      setOpen(true);
    }
  }, [start]);
  const cancel = useCallback(async (id: string) => {
    setActionError(undefined);
    try {
      const job = await operationsApi.cancel(id);
      queryClient.setQueryData<{ jobs: readonly JobView[] }>(operationsQuery().queryKey, current => {
        const observed = current?.jobs.find(entry => entry.id === id);
        const latest = observed && (observed.lastSeq > job.lastSeq || observed.status !== "running" && job.status === "running")
          ? { ...observed, cancelRequested: job.cancelRequested }
          : job;
        return { jobs: orderJobs([latest, ...(current?.jobs ?? []).filter(entry => entry.id !== id)]) };
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [queryClient]);
  const agentSummary = agentView === "coding" ? "Coding tasks" : agentView === "sightline" ? "Studio context"
    : chat.pending ? `${chat.provider === "codex" ? "Codex" : "Claude"} is thinking…`
    : chat.unread ? chat.problem ? "Response needs attention" : "Reply ready" : "Conversation";

  return <Activity
    jobs={overview.data ?? NO_JOBS}
    docker={dockerPresence({ status: docker.status, problem: docker.error, starting })}
    onStartDocker={startDocker}
    // A failed read is already the status this reports.
    onCheckDocker={() => docker.refresh().catch(() => undefined)}
    selected={selected}
    onSelect={setSelected}
    open={open}
    onToggle={toggle}
    mode={mode}
    onModeChange={openMode}
    agent={agentVisited ? <Suspense fallback={<p role="status" className="m-auto text-caption text-graphite">Opening agent…</p>}><AgentPanel chat={chat} visible={agentVisible} view={agentView} preparedCoding={preparedCoding} initialCodingTaskId={revealedCoding?.repository === repositoryRoot ? revealedCoding?.id : undefined} onPreparedCodingHandled={handledPreparation} /></Suspense> : <></>}
    agentViews={<AgentViewTabs view={agentView} onChange={setAgentView} />}
    agentPending={chat.pending}
    agentUnread={chat.unread}
    agentSummary={agentSummary}
    onCancel={cancel}
    loading={overview.isPending}
    problem={overview.error?.message}
    retrying={retrying}
    onRetry={() => {
      setRetrying(true);
      void overview.refetch().finally(() => setRetrying(false));
    }}
    actionError={actionError}
    repositoryRoot={repositoryRoot}
    onAskAgent={askAgent}
  />;
});

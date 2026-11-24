import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { codingTaskActive, type CodingTask, type CodingTaskRequest } from "../shared/agent-runtime";
import { agentTasksApi, type CodingEventPage } from "./agent-tasks-api";
import { mergeCodingEvents } from "./coding-presentation";
import { codingTaskSelectionKey, OPEN_CODING_TASK_EVENT, type CodingTaskNavigation } from "./coding-task-navigation";
import type { ContractDecision } from "../shared/contract-propagation";
const eventKey = (id: string | undefined) => ["coding-task-events", id] as const;
const proposalKey = (id: string | undefined, digest: string | undefined) => ["coding-task-proposal", id, digest] as const;
const RECENT_EVENT_COUNT = 200;

function latestTask(observed?: CodingTask, listed?: CodingTask): CodingTask | undefined {
  if (!observed || !listed) return observed ?? listed;
  return observed.lastSeq > listed.lastSeq || (observed.lastSeq === listed.lastSeq && observed.updatedAt >= listed.updatedAt) ? observed : listed;
}

/**
 * A query that has never succeeded returns to pending, with its error cleared, each time it
 * refetches. Polling a failing read would otherwise flash its failure away for every attempt,
 * so the last failure for the same key holds until a read succeeds.
 */
function useHeldFailure(query: { readonly error: Error | null; readonly isPending: boolean; readonly isSuccess: boolean }, key: readonly unknown[]): Error | null {
  const scope = JSON.stringify(key);
  const [held, setHeld] = useState<{ readonly scope: string; readonly error: Error }>();
  useEffect(() => { if (query.error) setHeld({ scope, error: query.error }); else if (query.isSuccess) setHeld(undefined); }, [query.error, query.isSuccess, scope]);
  return query.error ?? (query.isPending && held?.scope === scope ? held.error : null);
}

/** Browser observation is disposable. Closing a panel never cancels durable work. */
export function useCodingTasks(visible: boolean, repository: string, options: { readonly details?: boolean; readonly initialTaskId?: string } = {}) {
  const client = useQueryClient(), storageKey = codingTaskSelectionKey(repository);
  const observeDetails = visible && options.details !== false;
  const taskListKey = ["coding-tasks", repository] as const;
  const [selected, select] = useState<string | undefined>(() => {
    if (options.initialTaskId) return options.initialTaskId;
    try { return localStorage.getItem(storageKey) ?? undefined; } catch { return undefined; }
  });
  const [problem, setProblem] = useState<string>();
  const [pending, setPending] = useState<string>();
  const action = useRef(false);
  const taskHistory = { queryKey: taskListKey, queryFn: ({ signal }: { signal: AbortSignal }) => agentTasksApi.list(signal), retry: false } as const;
  const list = useQuery({ ...taskHistory, enabled: visible,
    refetchInterval: query => visible ? query.state.data?.tasks.some(task => task.contract && (codingTaskActive(task) || task.contract.approval?.status === "checking")) ? 1000 : 5000 : false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!list.data) return;
    if (!selected || !list.data.tasks.some(task => task.id === selected)) select(list.data.tasks[0]?.id);
  }, [list.data, selected]);
  useEffect(() => { try { if (selected) localStorage.setItem(storageKey, selected); else localStorage.removeItem(storageKey); } catch { /* Selection remains session-local when storage is unavailable. */ } }, [selected, storageKey]);
  useEffect(() => {
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<CodingTaskNavigation>).detail;
      if (detail?.repository === repository && detail.task?.id) select(detail.task.id);
    };
    window.addEventListener(OPEN_CODING_TASK_EVENT, reveal);
    return () => window.removeEventListener(OPEN_CODING_TASK_EVENT, reveal);
  }, [repository]);
  const listed = list.data?.tasks.find(task => task.id === selected);
  const events = useQuery({
    queryKey: eventKey(selected), enabled: observeDetails && !!selected, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const before = client.getQueryData<CodingEventPage>(eventKey(selected));
      const lastSeen = before?.events.at(-1)?.seq;
      const lastKnown = latestTask(before?.task, listed)?.lastSeq ?? 0;
      // Reopening a busy task should show recent work without replaying its
      // oldest command output first. Once open, follow the sequence normally.
      const cursor = lastSeen ?? Math.max(0, lastKnown - RECENT_EVENT_COUNT);
      let next = await agentTasksApi.events(selected!, cursor, signal);
      if (lastSeen === undefined && next.task.lastSeq - RECENT_EVENT_COUNT > cursor) {
        next = await agentTasksApi.events(selected!, next.task.lastSeq - RECENT_EVENT_COUNT, signal);
      }
      return { task: next.task, events: mergeCodingEvents(before?.events ?? [], next.events) };
    },
    refetchInterval: query => {
      if (!observeDetails) return false;
      const page = query.state.data;
      const task = latestTask(page?.task, listed);
      if (page && task && (page.events.at(-1)?.seq ?? 0) < task.lastSeq) return query.state.error ? 1000 : 100;
      return !page || (task && (codingTaskActive(task) || task.contract?.approval?.status === "checking" || task.runtimeActivation?.status === "starting")) ? 1000 : false;
    },
  });
  const observed = events.data?.task;
  const task = latestTask(observed?.id === selected ? observed : undefined, listed);
  const proposal = useQuery({ queryKey: proposalKey(selected, task?.proposalDigest), queryFn: ({ signal }) => agentTasksApi.proposal(selected!, signal), enabled: observeDetails && !!selected && !!task?.proposalDigest, retry: false, refetchOnWindowFocus: false });
  // Read these, not each query's `error`, so a polled failure stays put while it is retried.
  const listError = useHeldFailure(list, taskListKey), eventsError = useHeldFailure(events, eventKey(selected)), proposalError = useHeldFailure(proposal, proposalKey(selected, task?.proposalDigest));
  const accept = (updated: CodingTask) => {
    client.setQueryData<{ tasks: readonly CodingTask[] }>(taskListKey, previous => ({ tasks: [updated, ...(previous?.tasks ?? []).filter(item => item.id !== updated.id)] }));
    client.setQueryData<CodingEventPage>(eventKey(updated.id), previous => ({ task: updated, events: previous?.events ?? [] }));
    select(updated.id);
    void client.invalidateQueries({ queryKey: eventKey(updated.id) });
    if (updated.contract?.status === "applied-awaiting-check") {
      void client.invalidateQueries({ queryKey: ["graphql-chain", repository] });
      void client.invalidateQueries({ queryKey: ["graphql-workspace", repository] });
    }
  };
  const run = async (name: string, execute: () => Promise<CodingTask>) => {
    if (action.current) return false;
    action.current = true; setPending(name); setProblem(undefined);
    try { accept(await execute()); return true; }
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); return false; }
    finally { action.current = false; setPending(undefined); }
  };
  return { list, listError, selected, select, task, events, eventsError, proposal, proposalError, problem, pending,
    submit: (request: CodingTaskRequest) => run("Starting task", () => agentTasksApi.submit(request)),
    cancel: () => task && run("Cancelling task", () => agentTasksApi.cancel(task.id)),
    approve: () => task && proposal.data && run(task.status === "completed" ? "Retrying saved-source approval" : "Applying approved files", () => agentTasksApi.approve(task.id, proposal.data!.digest)),
    activate: () => task && proposal.data && run("Requesting Studio restart", () => agentTasksApi.activate(task.id, proposal.data!.digest)),
    reject: () => task && run("Rejecting proposal", () => agentTasksApi.reject(task.id)),
    resume: () => task && run("Resuming task", () => agentTasksApi.resume(task.id)),
    refresh: () => task && proposal.data && run("Refreshing candidate", () => agentTasksApi.refresh(task.id, proposal.data!.digest)),
    continueContract: (decisions?: readonly ContractDecision[]) => task && proposal.data && run("Continuing contract update", () => agentTasksApi.continueContract(task.id, proposal.data!.digest, decisions)),
    cleanup: () => task && run("Cleaning temporary task files", () => agentTasksApi.cleanup(task.id)),
    permission: (requestId: string, allow: boolean) => task && run("Answering permission request", () => agentTasksApi.permission(task.id, requestId, allow)),
    retry: () => { setProblem(undefined); void list.refetch(); if (observeDetails && selected) void events.refetch(); if (observeDetails && task?.proposalDigest) void proposal.refetch(); },
  };
}

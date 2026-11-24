import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentLabApi, type AgentLabProvider } from "./agent-lab-api";
import { readAgentPreferences, saveAgentPreferences } from "./agent-preferences";
import { call } from "./http";
import type { ConversationContext } from "../shared/agent-context";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  provider: AgentLabProvider;
  modelLabel?: string;
  replyState?: "failed" | "stopped";
  context?: string;
}

/** Shell-owned conversation: survives navigation, collapsing and changing panel modes. */
export function useAgentChat(visible: boolean) {
  const [preferences, setPreferences] = useState(readAgentPreferences);
  const { provider, models } = preferences;
  const setProvider = (provider: AgentLabProvider) => setPreferences(current => ({ ...current, provider }));
  useEffect(() => { saveAgentPreferences(preferences); }, [preferences]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [stopped, setStopped] = useState(false);
  const [unread, setUnread] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [omittedMessages, setOmittedMessages] = useState(0);
  const contextReader = useRef<(() => ConversationContext) | undefined>(undefined);
  const setContextReader = useCallback((reader: (() => ConversationContext) | undefined) => { contextReader.current = reader; }, []);
  const lastRequest = useRef<{ provider: AgentLabProvider; model?: string; messages: {role: AgentMessage["role"];content:string}[]; context?: string } | undefined>(undefined);
  const retain = (turns: AgentMessage[]) => {
    let size = 0, start = turns.length;
    while (start > 0 && turns.length - start < 60) {
      const next = turns[start - 1]!; const bytes = next.content.length + (next.context?.length ?? 0);
      if (size + bytes > 192_000) break;
      size += bytes; start--;
    }
    if(start) setOmittedMessages(count => count + start);
    setMessages(turns.slice(start));
    return turns.slice(start);
  };
  const request = useRef<AbortController | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const status = useQuery({
    queryKey: ["agent-lab-status"], queryFn: agentLabApi.status,
    enabled: visible, retry: false, refetchOnWindowFocus: false, staleTime: 30_000,
    refetchInterval: query => visible && !pending && query.state.data?.busy ? 1000 : false,
  });
  useEffect(() => { if (visible) setUnread(false); }, [visible]);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const selected = status.data?.providers.find(entry => entry.id === provider);
  const forceCatalogRefresh = useRef(false);
  const catalog = useQuery({
    queryKey: ["agent-lab-models", provider],
    queryFn: ({ signal }) => {
      const refresh = forceCatalogRefresh.current;
      forceCatalogRefresh.current = false;
      return agentLabApi.models(provider, signal, refresh);
    },
    enabled: visible && selected?.available === true,
    retry: false, refetchOnWindowFocus: false, staleTime: 60_000,
  });
  const model = models[provider];
  const selectedModel = catalog.data?.models.find(entry => entry.id === model);
  const modelUnavailable = !!model && !catalog.isPending && !catalog.error && !catalog.data?.problem && !selectedModel;
  const setModel = (value: string) => setPreferences(current => ({ ...current, models: { ...current.models, [provider]: value } }));
  const refreshModels = () => { forceCatalogRefresh.current = true; void catalog.refetch(); };

  async function answer(turns: AgentMessage[], retry = false) {
    const captured = retry ? lastRequest.current : undefined;
    const attemptProvider = captured ? status.data?.providers.find(item=>item.id === captured.provider) : selected;
    if (request.current || !attemptProvider?.available || (!captured && modelUnavailable)) return;
    const controller = new AbortController();
    request.current = controller;
    turns = retain(turns);
    setPending(true);
    setProblem(undefined);
    setStopped(false);
    setUnread(false);
    // Keep recent context bounded independently of the visible transcript.
    const history: { role: AgentMessage["role"]; content: string }[] = [];
    let characters = 0;
    const completedContext = turns.filter((turn, index) => turn.role === "assistant" || turns[index + 1]?.role === "assistant" || index === turns.length - 1);
    for (const turn of [...completedContext].reverse()) {
      if (history.length === 12 || characters + turn.content.length > 30_000) break;
      history.unshift({ role: turn.role, content: turn.content });
      characters += turn.content.length;
    }
    try {
      const payload = retry && lastRequest.current ? lastRequest.current : { provider, ...(model ? { model } : {}), messages: history, ...(turns.at(-1)?.context ? {context:turns.at(-1)!.context} : {}) };
      lastRequest.current = payload;
      const result = await call<{ answer: string }>("/agent-lab/chat", payload, controller.signal);
      if (request.current !== controller) return;
      retain([...turns, { id: crypto.randomUUID(), role: "assistant", content: result.answer, provider:payload.provider, modelLabel: turns.at(-1)?.modelLabel }]);
      setUnread(!visibleRef.current);
    } catch (error) {
      if (request.current !== controller) return;
      setProblem(error instanceof Error ? error.message : String(error));
      retain(turns.map((turn, index) => index === turns.length - 1 ? { ...turn, replyState: "failed" } : turn));
      setUnread(!visibleRef.current);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
        void status.refetch();
      }
    }
  }
  const send = () => {
    if (!draft.trim() || draft.length > 4000 || request.current || !selected?.available || status.data?.busy || modelUnavailable) return;
    const context = includeContext ? contextReader.current?.() : undefined;
    const turn: AgentMessage = { id: crypto.randomUUID(), role: "user", content: draft.trim(), provider, modelLabel:selectedModel?.label, ...(context ? {context:JSON.stringify(context)} : {}) };
    setDraft("");
    void answer([...messages, turn]);
  };
  const stop = () => {
    request.current?.abort(); request.current = null;
    setPending(false); setStopped(true);
    setMessages(current => current.map((turn, index) => index === current.length - 1 ? { ...turn, replyState: "stopped" } : turn));
    void status.refetch();
  };
  const clear = () => {
    if (request.current) return;
    setMessages([]); setOmittedMessages(0); lastRequest.current = undefined; setProblem(undefined); setStopped(false); setUnread(false);
  };
  return {
    provider, setProvider, model, setModel, catalog, refreshModels, selectedModel, modelUnavailable,
    messages, draft, setDraft, pending, problem, stopped, unread, includeContext, setIncludeContext, setContextReader, omittedMessages,
    canRetry: !!lastRequest.current && status.data?.providers.some(item=>item.id === lastRequest.current?.provider && item.available) === true,
    status, selected, send, stop, clear,
    retry: () => { if (messages.at(-1)?.role === "user") void answer(messages.map((turn, index) => index === messages.length - 1 ? { ...turn, replyState: undefined } : turn), true); },
  };
}

export type AgentChat = ReturnType<typeof useAgentChat>;

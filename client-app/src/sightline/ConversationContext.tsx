import { useLayoutEffect, useMemo, useRef } from "react";
import type { AgentChat } from "../agent-chat";
import { buildSightline } from "./build";
import { buildConversationContext } from "./agent-context";
import { newestEvidenceTraceId } from "./logs";
import { useSightlineInputs } from "./useSightlineInputs";
import { useDevelopmentTrace } from "../development-logs";
import { developmentLogScope } from "../../shared/development-log-scope";
import { StudioContextControl } from "./StudioContextControl";

/** Mounted only for a visible Conversation. Evidence subscriptions never belong to the tray shell. */
export function ConversationContext({ chat }: { readonly chat: AgentChat }) {
  const inputs = useSightlineInputs(chat.includeContext);
  const evidence = inputs.developmentLogs?.evidence;
  const scope = inputs.selected
    ? developmentLogScope(inputs.snapshot.models.dev, inputs.selected)
    : undefined;
  const traceId = newestEvidenceTraceId(evidence);
  const trace = useDevelopmentTrace(
    inputs.snapshot.repositoryRoot,
    inputs.mode,
    inputs.selected,
    evidence?.run?.runtimeSessionId,
    traceId,
    chat.includeContext &&
      !!scope &&
      ["captured", "partial"].includes(scope.kind),
  );
  const context = useMemo(
    () =>
      buildConversationContext(
        buildSightline(inputs),
        trace.data,
        inputs.snapshot.models[inputs.mode],
      ),
    [inputs, trace.data],
  );
  const current = useRef(context);
  useLayoutEffect(() => {
    current.current = context;
  }, [context]);
  useLayoutEffect(() => {
    chat.setContextReader(() => ({
      ...current.current,
      capturedAt: new Date().toISOString(),
    }));
    return () => chat.setContextReader(undefined);
  }, [chat.setContextReader]);
  const { availability, observedAt } = context.observations;
  return (
    <StudioContextControl
      value={context}
      includeContext={chat.includeContext}
      onIncludeContextChange={chat.setIncludeContext}
      description="Captured with each new question. Retries use the original snapshot."
      details={`Runtime evidence · ${availability}${observedAt ? ` · observed ${new Date(observedAt).toLocaleTimeString()}` : ""}`}
      previewLabel="Conversation Studio context"
    />
  );
}

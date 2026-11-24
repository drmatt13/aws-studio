import { lazy, Suspense, useEffect, useState } from "react";
import type { AgentChat } from "../agent-chat";
import type { CodingTaskPreparation } from "../coding-task-navigation";
import { AgentPanel } from "../views/agent/AgentPanel";
import type { AgentView } from "../views/agent/AgentViewTabs";
import { ConversationContext } from "./ConversationContext";

const SightlineView = lazy(() => import("./SightlineView").then(module => ({ default: module.SightlineView })));
const CodingPanel = lazy(() => import("../views/agent/CodingPanel").then(module => ({ default: module.CodingPanel })));

/** The bar owns the view choice; each visible agent view owns its bounded evidence subscriptions. */
export function AgentViews({ chat, visible, view, preparedCoding, initialCodingTaskId, onPreparedCodingHandled }: { chat: AgentChat; visible: boolean; view: AgentView; preparedCoding?: CodingTaskPreparation; initialCodingTaskId?: string; onPreparedCodingHandled?: (id: string) => void }) {
  const codingVisible = visible && view === "coding";
  const [codingVisited, setCodingVisited] = useState(codingVisible);
  useEffect(() => { if (codingVisible) setCodingVisited(true); }, [codingVisible]);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sheet">
    <div role="tabpanel" id="agent-conversation-view" aria-labelledby="agent-conversation-tab" hidden={view !== "conversation"} inert={view !== "conversation"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <AgentPanel chat={chat} visible={visible && view === "conversation"} context={visible && view === "conversation" ? <ConversationContext chat={chat} /> : null} />
    </div>
    <div role="tabpanel" id="agent-sightline-view" aria-labelledby="agent-sightline-tab" hidden={view !== "sightline"} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {visible && view === "sightline" ? <Suspense fallback={<p role="status" className="m-4 text-caption text-graphite">Opening context preview…</p>}><SightlineView /></Suspense> : null}
    </div>
    <div role="tabpanel" id="agent-coding-view" aria-labelledby="agent-coding-tab" hidden={!codingVisible} inert={!codingVisible} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {codingVisited || codingVisible ? <Suspense fallback={<p role="status" className="m-4 text-caption text-graphite">Opening coding tasks…</p>}><CodingPanel visible={codingVisible} selection={chat} prepared={preparedCoding} initialTaskId={initialCodingTaskId} onPreparedHandled={onPreparedCodingHandled} /></Suspense> : null}
    </div>
  </div>;
}

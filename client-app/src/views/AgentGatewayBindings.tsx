import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useId, useRef } from "react";
import { gatewaysOf, type ModelGateway } from "../../shared/gateways";
import type { ModelTarget } from "../../shared/model";
import { sourceEditBlocked } from "../editing-state";
import {
  inspectorHelpClasses,
  inspectorLabelClasses,
  inspectorNoteClasses,
  inspectorRelationListClasses,
  inspectorStackedFieldClasses,
} from "../inspector-ui";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { Select } from "../ui/FormControls";
import { iconButtonClasses } from "../ui/IconButton";
import { EntityIcon } from "./EntityIcon";
import { InspectorResourceRow } from "./InspectorUI";

/** Ordered gateway bindings share the Inspector draft and reviewed source writer. */
export function AgentGatewayBindings({ target }: { readonly target: ModelTarget }) {
  const { model, snapshot, draft, draftState, live, select } = useStudio();
  const id = useId();
  const picker = useRef<HTMLSelectElement>(null);
  const selected = draft.agentGateways(target.ref);
  const gateways = [...new Map(Object.values(snapshot.models).flatMap(gatewaysOf)
    .filter(gateway => gateway.protocol === "agentcore").map(gateway => [gateway.key, gateway])).values()];
  const fact = snapshot.source.editability[target.ref]?.gateways;
  const sourceOwned = !!fact && !["literal", "absent"].includes(fact.kind);
  const disabled = sourceEditBlocked({ draftState, draft, model, live }) || !snapshot.source.entities[target.ref] || sourceOwned;
  const update = (next: readonly string[]) => draft.setAgentGateways(target.ref, next);
  const move = (index: number, direction: number) => {
    const next = [...selected];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    update(next);
  };
  const reason = (gateway: Extract<ModelGateway, { protocol: "agentcore" }>) => {
    if (!target.auth && gateway.tools.some(tool => Object.values(snapshot.models).some(graph => graph.targets.some(item => item.role === "tool" && item.id === tool && item.auth)))) return "Requires an agent with signed-in users";
    for (const graph of Object.values(snapshot.models)) {
      const agent = graph.targets.find(item => item.ref === target.ref);
      const available = gatewaysOf(graph).find(item => item.id === gateway.id);
      if (agent && (["local", "dev", "prod"] as const).some(lane => agent.lanes[lane] && !available?.lanes[lane])) return "Unavailable in an agent deployment lane";
    }
    return undefined;
  };
  return (
    <div className="grid min-w-0 gap-3" data-slot="agent-gateway-bindings">
      <p className={inspectorNoteClasses}>Each selected gateway makes all of its tools available. When gateways share a tool, the first gateway below supplies its route.</p>
      {selected.length ? (
        <ol className={inspectorRelationListClasses}>
          {selected.map((key, index) => {
            const gateway = gateways.find(item => item.key === key);
            const name = gateway?.title ?? key;
            return <InspectorResourceRow
              key={key}
              data-slot="agent-gateway-binding"
              icon={<EntityIcon size={26} icon="gateway" />}
              title={<button className={buttonClasses({ variant: "link" })} data-slot="agent-gateway-binding-name" onClick={() => select(`gateway:agentcore:${key}`)}>{name}</button>}
              trailing={<>
                <button className={iconButtonClasses()} disabled={disabled || index === 0} aria-label={`Move ${name} up`} title="Move up" onClick={() => move(index, -1)}><ArrowUp size={14} aria-hidden /></button>
                <button className={iconButtonClasses()} disabled={disabled || index === selected.length - 1} aria-label={`Move ${name} down`} title="Move down" onClick={() => move(index, 1)}><ArrowDown size={14} aria-hidden /></button>
                <button className={iconButtonClasses()} disabled={disabled} aria-label={`Remove gateway ${name}`} title="Remove" onClick={() => { update(selected.filter(item => item !== key)); picker.current?.focus(); }}><Trash2 size={14} aria-hidden /></button>
              </>}
            >
              {gateway ? <span>{gateway.tools.length} {gateway.tools.length === 1 ? "tool" : "tools"}</span> : null}
            </InspectorResourceRow>;
          })}
        </ol>
      ) : <p className={inspectorNoteClasses}>No gateways selected. This agent has no gateway tools.</p>}
      <div className={inspectorStackedFieldClasses}>
        <label htmlFor={id} className={inspectorLabelClasses}>Add gateway</label>
        <Select ref={picker} id={id} value="" disabled={disabled || !gateways.some(gateway => !selected.includes(gateway.key))} onChange={event => { if (event.target.value) update([...selected, event.target.value]); }}>
          <option value="">{gateways.length ? "Select an AgentCore gateway…" : "No AgentCore gateways available"}</option>
          {gateways.filter(gateway => !selected.includes(gateway.key)).map(gateway => {
            const unavailable = reason(gateway);
            return <option key={gateway.key} value={gateway.key} disabled={!!unavailable}>{gateway.title}{unavailable ? ` · ${unavailable}` : ""}</option>;
          })}
        </Select>
        {sourceOwned ? <span className={inspectorHelpClasses}>This gateway list is source-owned. Edit the declaration in your editor.</span> : null}
        {!gateways.length ? <span className={inspectorHelpClasses}>Create one with Add to application → API → AgentCore.</span> : null}
        <span className={inspectorHelpClasses}>Gateway invocation permission and <code>FRAMEWORK_AGENTCORE_ADAPTER</code> are supplied automatically.</span>
      </div>
    </div>
  );
}

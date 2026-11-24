import { Trash2 } from "lucide-react";
import { useId, useRef } from "react";
import type { DeployValue } from "../../shared/api";
import type { ModelGateway } from "../../shared/gateways";
import { authorizationSummary } from "../../shared/permissions";
import { accessDestination, accessOperation } from "../access";
import { deploymentSettingLabel } from "../deployment";
import { sourceEditBlocked } from "../editing-state";
import { targetIcon } from "../icons";
import {
  inspectorActionGroupClasses,
  inspectorHeaderClasses,
  inspectorHelpClasses,
  inspectorIntroClasses,
  inspectorLabelClasses,
  inspectorNoteClasses,
  inspectorRelationListClasses,
  inspectorStackedFieldClasses,
} from "../inspector-ui";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { Select, TextInput } from "../ui/FormControls";
import { iconButtonClasses } from "../ui/IconButton";
import { AuthorizationBadge } from "./Authorization";
import { Description } from "./Description";
import { useGatewayEnvironments } from "./Deployment";
import { EntityIcon } from "./EntityIcon";
import { EntityName } from "./EntityName";
import { OwnershipStatus } from "./ResourceStatus";
import { Ownership } from "./Ownership";
import { InspectorDisclosure, InspectorKind, InspectorResourceRow } from "./InspectorUI";
import { ResourceLogs } from "./ResourceLogs";
import { Tags } from "./Tags";
import { Written } from "./Written";
import { Relations } from "./inspector/InspectorRelations";

type AgentCoreGateway = Extract<ModelGateway, { protocol: "agentcore" }>;

const deployHelp = "This gateway has its own deployment setting. Its tools inherit the union of their gateways’ lanes unless overridden.";

function GatewayDeploy({ gateway, disabled }: { readonly gateway: AgentCoreGateway; readonly disabled: boolean }) {
  const { draft, snapshot, model } = useStudio();
  const id = useId();
  const value = draft.gatewayDeploy(gateway.id);
  const condition = typeof value === "string" ? undefined : value.when;
  const inputs = snapshot.models.dev.resources.filter(input => input.kind === "input" && !input.absent && (input.fromEnv || input.authoredValue !== undefined) && snapshot.models.prod.resources.some(other => other.id === input.id && !other.absent));
  const input = inputs.find(item => item.id === condition?.resource);
  const stage = (next: DeployValue) => draft.setGatewayDeploy(gateway.id, next);
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" data-slot="gateway-deploy-control">
    <div className={inspectorStackedFieldClasses}>
      <label className={inspectorLabelClasses} htmlFor={id}>Deploy</label>
      <Select id={id} value={condition ? "conditional" : String(value)} disabled={disabled} onChange={event => {
        if (event.target.value === "conditional") {
          const first = inputs[0];
          if (first) stage({ when: { resource: first.id, equals: first.values?.[0] ?? "" } });
        } else stage(event.target.value as DeployValue);
      }}>
        {["both", "local-only", "cloud-only", "none"].map(setting => <option key={setting} value={setting}>{deploymentSettingLabel(setting, model.deployChoices?.agent?.[setting])}</option>)}
        <option value="conditional" disabled={!inputs.length}>Only when an input matches…</option>
      </Select>
      {condition ? null : <span className={inspectorHelpClasses}>{deployHelp}</span>}
    </div>
    {condition ? <>
      <div className={inspectorStackedFieldClasses}>
        <label className={inspectorLabelClasses} htmlFor={`${id}-input`}>Input parameter</label>
        <Select id={`${id}-input`} disabled={disabled} value={condition.resource} onChange={event => {
          const next = inputs.find(item => item.id === event.target.value)!;
          stage({ when: { resource: next.id, equals: next.values?.[0] ?? "" } });
        }}>{inputs.map(item => <option key={item.id} value={item.id}>{item.path.join(".")}</option>)}</Select>
      </div>
      <div className={inspectorStackedFieldClasses}>
        <label className={inspectorLabelClasses} htmlFor={`${id}-equals`}>Equals</label>
        {input?.values ? <Select id={`${id}-equals`} disabled={disabled} value={condition.equals} onChange={event => stage({ when: { ...condition, equals: event.target.value } })}>{input.values.map(value => <option key={value} value={value}>{value}</option>)}</Select>
          : <TextInput id={`${id}-equals`} disabled={disabled} value={condition.equals} aria-invalid={!condition.equals.trim()} onChange={event => stage({ when: { ...condition, equals: event.target.value } })} />}
      </div>
      <p className={inspectorNoteClasses}>{deployHelp}</p>
    </> : null}
  </div>;
}

export function AgentCoreGatewayView({ gateway }: { readonly gateway: AgentCoreGateway }) {
  const { model, snapshot, draft, draftState, live, select, index } = useStudio();
  const id = useId();
  const picker = useRef<HTMLSelectElement>(null);
  const hover = useGatewayEnvironments(gateway);
  const disabled = sourceEditBlocked({ draftState, draft, model, live }) || !snapshot.source.entities[gateway.id];
  const toolsFact = snapshot.source.editability[gateway.id]?.tools;
  const toolsDisabled = disabled || !!toolsFact && !["literal", "absent"].includes(toolsFact.kind);
  const deployFact = snapshot.source.editability[gateway.id]?.deploy;
  const deployDisabled = disabled || !!deployFact && !["literal", "absent", "condition"].includes(deployFact.kind);
  const tools = draft.gatewayTools(gateway.id);
  const candidates = [...new Map(Object.values(snapshot.models).flatMap(graph => graph.targets).filter(target => target.role === "tool").map(target => [target.id, target])).values()];
  const consumers = [...new Map(Object.values(snapshot.models).flatMap(graph => graph.targets).filter(target => target.compute.kind === "agent" && target.compute.gateways.includes(gateway.key)).map(target => [target.ref, target])).values()];
  const changes = draftState.entries.filter(entry => entry.kind === "gatewayConfiguration" && "gateway" in entry.operation && entry.operation.gateway === gateway.id);
  const permissions = model.edges.filter(edge => edge.from === gateway.id || edge.to === gateway.id).filter(edge => edge.authorization);
  return <>
    <header className={inspectorHeaderClasses}>
      <InspectorKind environments={hover}>AgentCore Gateway</InspectorKind>
      <EntityName entity={gateway.id} fallback={gateway.title} icon="gateway" reference={gateway.id} />
      <OwnershipStatus entity={gateway.id} />
      <Written placement="header" location={snapshot.source.entities[gateway.id]?.key} label="Declared in" />
    </header>
    <Description entity={gateway.id} />
    <Tags entity={gateway.id} />
    <Ownership entity={gateway.id} />
    <ResourceLogs selected={gateway.id} />
    <InspectorDisclosure title="Tools" count={tools.length} status={changes.some(entry => entry.kind === "gatewayConfiguration" && entry.operation.kind === "gatewayTools") ? "modified" : undefined}>
      <p className={inspectorIntroClasses}>Every connected agent receives access to all tools on this gateway.</p>
      {tools.length ? <ul className={inspectorRelationListClasses} data-slot="gateway-tools">
        {tools.map(tool => {
          const target = candidates.find(item => item.id === tool);
          return <InspectorResourceRow
            key={tool}
            data-slot="gateway-tool"
            icon={<EntityIcon size={26} icon={target ? targetIcon(target) : "lambda"} />}
            title={<button className={buttonClasses({ variant: "link" })} onClick={() => select(`lambda:${tool}`)}>{target?.title ?? tool}</button>}
            trailing={<button className={iconButtonClasses()} disabled={toolsDisabled} aria-label={`Remove tool ${tool}`} title="Remove" onClick={() => { draft.setGatewayTools(gateway.id, tools.filter(item => item !== tool)); picker.current?.focus(); }}><Trash2 size={14} aria-hidden /></button>}
          />;
        })}
      </ul> : <p className={inspectorNoteClasses}>No tools attached. Add a tool to make it available through this gateway.</p>}
      <div className={cx(inspectorStackedFieldClasses, "mt-3")}>
        <label className={inspectorLabelClasses} htmlFor={id}>Add tool</label>
        <Select ref={picker} id={id} disabled={toolsDisabled || !candidates.some(tool => !tools.includes(tool.id))} value="" onChange={event => { if (event.target.value) draft.setGatewayTools(gateway.id, [...tools, event.target.value]); }}>
          <option value="">{candidates.length ? "Select an existing tool…" : "No agent tools available"}</option>
          {candidates.filter(tool => !tools.includes(tool.id)).map(tool => {
            const reason = tool.auth && consumers.some(agent => !agent.auth) ? "Connected agents require signed-in users" : undefined;
            return <option key={tool.id} value={tool.id} disabled={!!reason}>{tool.title}{reason ? ` · ${reason}` : ""}</option>;
          })}
        </Select>
        {toolsDisabled && !disabled ? <span className={inspectorHelpClasses}>This tool list is source-owned. Edit the declaration in your editor.</span> : null}
      </div>
    </InspectorDisclosure>
    <InspectorDisclosure title="Settings" status={changes.some(entry => entry.kind === "gatewayConfiguration" && entry.operation.kind === "gatewayDeploy") ? "modified" : undefined}>
      <GatewayDeploy gateway={gateway} disabled={deployDisabled} />
    </InspectorDisclosure>
    <InspectorDisclosure title="Incoming agents" count={consumers.length}>
      {consumers.length ? <ul className={inspectorRelationListClasses} data-slot="gateway-consumers">{consumers.map(agent => <InspectorResourceRow
        key={agent.ref}
        data-slot="gateway-consumer"
        icon={<EntityIcon size={26} icon={targetIcon(agent)} />}
        title={<button className={buttonClasses({ variant: "link" })} onClick={() => select(agent.ref)}>{agent.title}</button>}
      />)}</ul> : <p className={inspectorNoteClasses}>No agents select this gateway. Select it in an agent’s Settings.</p>}
    </InspectorDisclosure>
    <InspectorDisclosure title="Permissions" count={permissions.length}>
      <p className={inspectorIntroClasses}>IAM authorizes selected agents to invoke this gateway. The gateway’s role invokes only its attached Lambda tools.</p>
      {/* As in Triggers, each row is titled by the resource at the other end; the permitted operation opens its connection. */}
      <ul className={inspectorRelationListClasses} data-slot="gateway-permissions">{permissions.map(edge => {
        const authorization = edge.authorization!;
        const other = accessDestination(edge.from === gateway.id ? edge.to : edge.from, model, index);
        return <InspectorResourceRow
          key={edge.id}
          data-slot="gateway-permission"
          icon={<EntityIcon size={26} icon={other.icon} />}
          title={other.id ? <button className={buttonClasses({ variant: "link" })} onClick={() => select(other.id!)}>{other.title}</button> : other.title}
          trailing={authorization.kind === "iam" ? undefined : <AuthorizationBadge authorization={authorization} />}
        >
          <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={() => select(edge.id)}>{accessOperation(authorization, edge, snapshot.source)}</button>
          {authorizationSummary(authorization).map(line => <span key={line}>{line}</span>)}
        </InspectorResourceRow>;
      })}</ul>
    </InspectorDisclosure>
    <Relations id={gateway.id} />
    <InspectorDisclosure title="Remove gateway">
      <p className={inspectorIntroClasses}>{consumers.length ? "Disconnect all agents before removing this gateway." : "Review removal of this gateway declaration. Attached Lambda implementations remain available."}</p>
      <div className={inspectorActionGroupClasses}>
        <button className={buttonClasses({ variant: "quiet" })} disabled={disabled || draft.dirty || !!consumers.length} onClick={() => draft.removeGateway(gateway.id)}>Review gateway removal</button>
        <p className={inspectorNoteClasses}>Apply saves source. Deployed resources change only after a separate deployment.</p>
      </div>
    </InspectorDisclosure>
  </>;
}

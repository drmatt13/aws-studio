import { useEffect, useMemo, useRef, useState } from "react";
import type { PolicyRule, PermissionResourceInput, PermissionStatementInput } from "../../shared/permission-rules";
import { readPermissionStatement, permissionStatementKey } from "../../shared/permission-rules";
import { displayName } from "../naming";
import { useStudio } from "../studio";
import { sourceEditBlocked } from "../editing-state";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { Select, Textarea, TextInput } from "../ui/FormControls";
import { editorLink } from "../lookup";
import {
  inspectorEditorActionsClasses,
  inspectorEditorClasses,
  inspectorLabelFieldClasses,
  inspectorLabelHelpClasses,
  inspectorNoteClasses,
  inspectorRowActionsClasses,
} from "../inspector-ui";
import { PermissionFact, PermissionFacts } from "./Authorization";
import { EntityIcon } from "./EntityIcon";
import { InspectorDisclosureRow, InspectorResourceRow, InspectorSummary } from "./InspectorUI";

export const policyStatementKey = permissionStatementKey;

const problemClasses = "m-0 text-caption leading-[1.5] text-refuse wrap-anywhere";

/** Explicit IAM has its own editor; action adapters and runtime bindings keep their semantics. */
export function IamPolicyEditor({ target, rule, initial, onDone }: {
  readonly target: string;
  readonly rule?: PolicyRule;
  readonly initial?: PermissionStatementInput;
  readonly onDone: () => void;
}) {
  const { snapshot, model, live, draft, draftState } = useStudio();
  const form = useRef<HTMLDivElement>(null);
  const statement = rule?.statement ?? initial;
  const [effect, setEffect] = useState<"Allow" | "Deny">(statement?.effect ?? "Allow");
  const [actions, setActions] = useState(statement?.actions.join("\n") ?? "");
  const [resources, setResources] = useState<readonly PermissionResourceInput[]>(statement?.resources ?? [{ kind: "literal", value: "*" }]);
  const [conditions, setConditions] = useState(statement?.conditions ? JSON.stringify(statement.conditions, null, 2) : "");
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  useEffect(() => { if (!disabled) form.current?.querySelector<HTMLElement>("select:not(:disabled), textarea:not(:disabled)")?.focus(); }, [disabled]);
  const references = useMemo(() => {
    const values: { key: string; label: string; value: PermissionResourceInput }[] = [];
    for (const capability of snapshot.source.permissionCapabilities ?? []) for (const attribute of capability.attributes ?? []) {
      if (!capability.resource.startsWith("resource:") || !/arn$/i.test(attribute)) continue;
      values.push({ key: `${capability.resource}.${attribute}`, label: `${displayName(snapshot.models.dev, capability.resource, capability.resource.replace(/^resource:/, ""))} · ${attribute}`, value: { kind: "catalog", resource: capability.resource, attribute } });
    }
    for (const item of new Map(Object.values(snapshot.models).flatMap(item => item.targets).map(item => [item.ref, item])).values()) {
      if (item.kind === "service") continue;
      values.push({ key: item.ref, label: `${displayName(snapshot.models.dev, item.ref, item.title)} · ${item.kind} ARN`, value: { kind: "target", target: item.ref } });
    }
    return values.sort((a, b) => a.label.localeCompare(b.label));
  }, [snapshot]);
  const resourceKey = (value: PermissionResourceInput) => value.kind === "catalog" ? `${value.resource}.${value.attribute}` : value.kind === "target" ? value.target : "literal";
  const update = (index: number, value: PermissionResourceInput) => setResources(resources.map((item, at) => at === index ? value : item));
  let value: PermissionStatementInput | undefined, problem: string | undefined;
  try {
    const selected = [...new Set(actions.split(/[\n,]+/).map(item => item.trim()).filter(Boolean))];
    if (!selected.length || selected.some(item => !/^(?:[a-zA-Z0-9-]+:[a-zA-Z0-9*?]+|\*)$/.test(item))) throw new Error("Enter at least one AWS action, for example s3:GetObject.");
    if (!resources.length || resources.some(item => item.kind === "literal" && !item.value.trim())) throw new Error("Choose at least one resource ARN or pattern.");
    const parsed = conditions.trim() ? JSON.parse(conditions) : undefined;
    if (parsed !== undefined && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("Conditions must be a JSON object of IAM operators and keys.");
    value = readPermissionStatement({ actions: selected, resources: [...resources], effect, ...(parsed ? { conditions: parsed } : {}) });
  } catch (error) { problem = error instanceof SyntaxError ? "Enter valid JSON for conditions." : error instanceof Error ? error.message : "Review this policy."; }
  if (rule && !rule.writable) problem = rule.reason ?? "This policy is source-owned. Open its declaration to edit it.";
  const pending = rule && draftState.entries.find(entry => entry.kind === "operation" && entry.operation.kind === "iamPolicy" && entry.operation.rule === rule.id);
  return <div ref={form} className={inspectorEditorClasses} role="group" aria-label="IAM policy editor" data-slot="iam-policy-editor" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDone(); } }}>
    <p className={inspectorNoteClasses}>Attach an explicit identity policy to this workload’s execution role. Prefer references so ARNs follow your application.</p>
    {rule?.shared ? <p className="m-0 text-caption leading-[1.5] text-local">This shared declaration is used by {rule.consumers.length} workloads. Editing it changes every consumer.</p> : null}
    <label className={inspectorLabelFieldClasses}>Effect<Select value={effect} disabled={disabled} onChange={event => setEffect(event.target.value as "Allow" | "Deny")}><option>Allow</option><option>Deny</option></Select></label>
    <label className={inspectorLabelFieldClasses}>Actions<Textarea aria-label="IAM actions" value={actions} disabled={disabled} rows={4} spellCheck={false} placeholder="s3:GetObject" onChange={event => setActions(event.target.value)} /><span className={inspectorLabelHelpClasses}>One action per line, or separate actions with commas.</span></label>
    <fieldset className="m-0 grid min-w-0 grid-cols-[minmax(0,1fr)] justify-items-start gap-3 border-0 p-0" disabled={disabled}><legend className="mb-2 p-0 text-label font-medium">Resources</legend>
      {resources.map((resource, index) => <div key={index} className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)] justify-items-start gap-2 border-l-2 border-rule pl-3">
        <label className={cx(inspectorLabelFieldClasses, "w-full")}>Resource {index + 1}<Select aria-label={`Policy resource ${index + 1}`} value={resourceKey(resource)} onChange={event => update(index, event.target.value === "literal" ? { kind: "literal", value: "*" } : references.find(item => item.key === event.target.value)!.value)}>
          <option value="literal">Custom ARN or pattern</option>
          {!references.some(item => item.key === resourceKey(resource)) && resource.kind !== "literal" ? <option value={resourceKey(resource)}>{resourceKey(resource)}</option> : null}
          {references.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </Select></label>
        {resource.kind === "literal" ? <label className={cx(inspectorLabelFieldClasses, "w-full")}>ARN or pattern<TextInput aria-label={`Policy ARN ${index + 1}`} value={resource.value} spellCheck={false} onChange={event => update(index, { kind: "literal", value: event.target.value })} /><span className={inspectorLabelHelpClasses}>Deployment placeholders: <code>{"{partition}"}</code>, <code>{"{region}"}</code>, <code>{"{account}"}</code>.</span></label> : <label className={cx(inspectorLabelFieldClasses, "w-full")}>ARN suffix (optional)<TextInput aria-label={`Policy suffix ${index + 1}`} value={resource.suffix ?? ""} placeholder="/*" onChange={event => update(index, { ...resource, ...(event.target.value ? { suffix: event.target.value } : { suffix: undefined }) })} /></label>}
        <button className={cx(buttonClasses({ variant: "link" }), "text-caption")} onClick={() => setResources(resources.filter((_, at) => at !== index))}>Remove resource {index + 1}</button>
      </div>)}
      <button className={buttonClasses({ variant: "quiet" })} onClick={() => setResources([...resources, { kind: "literal", value: "*" }])}>Add resource</button>
    </fieldset>
    <details><InspectorSummary className="cursor-pointer text-label font-medium">Conditions (advanced)</InspectorSummary><label className={cx(inspectorLabelFieldClasses, "mt-2")}>IAM condition JSON<Textarea aria-label="IAM condition JSON" value={conditions} disabled={disabled} rows={5} spellCheck={false} placeholder={'{"Bool":{"aws:SecureTransport":"true"}}'} onChange={event => setConditions(event.target.value)} /></label></details>
    {problem ? <p className={problemClasses} role="status">{problem}</p> : null}
    <div className={inspectorEditorActionsClasses}><button className={buttonClasses({ variant: "neutral" })} disabled={disabled || !!problem || !value || !!pending} onClick={() => { if (value) { draft.stageOperation({ kind: "iamPolicy", target, operation: rule ? "update" : "add", ...(rule ? { rule: rule.id } : {}), statement: value }); onDone(); } }}>{rule ? "Stage policy changes" : "Stage policy"}</button><button className={buttonClasses({ variant: "quiet" })} onClick={onDone}>Cancel</button>{rule?.location ? <a className={cx(buttonClasses({ variant: "link" }), "text-caption")} href={editorLink(snapshot.repositoryRoot, rule.location)}>Open declaration</a> : null}</div>
  </div>;
}

const resourceText = (item: PermissionResourceInput) =>
  item.kind === "literal" ? item.value : item.kind === "catalog" ? `${item.resource}.${item.attribute}${item.suffix ?? ""}` : `${item.target}${item.suffix ?? ""}`;

/** A policy statement reads like the access rows beside it: icon, title, summary line, then its evidence block. */
export function IamPolicyRow({ target, rule }: { readonly target: string; readonly rule: PolicyRule }) {
  const { snapshot, model, live, draft, draftState, select } = useStudio();
  const [editing, setEditing] = useState(false), [adding, setAdding] = useState(false);
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const pending = draftState.entries.find(entry => entry.kind === "operation" && entry.operation.kind === "iamPolicy" && entry.operation.rule === rule.id);
  const pendingOperation = pending?.kind === "operation" && pending.operation.kind === "iamPolicy" ? pending.operation.operation : undefined;
  const issues = [...new Set(Object.values(snapshot.models).flatMap(item => item.edges).filter(edge => edge.from === target && edge.permissionContext?.kind === "iamPolicy" && policyStatementKey(edge.permissionContext.statement) === policyStatementKey(rule.statement)).flatMap(edge => edge.readinessIssues?.map(issue => issue.message) ?? []))];
  return <InspectorDisclosureRow
    data-slot="policy-rule"
    icon={<EntityIcon size={26} icon="iam" />}
    title="IAM policy"
    caption={<>{rule.statement.effect ?? "Allow"} · {rule.statement.actions.join(", ")}{rule.shared ? " · Shared declaration" : ""}</>}
    trailing={pending ? <span className="text-caption font-medium text-local" data-slot="section-state">{pendingOperation === "remove" ? "Removal staged" : "Changes staged"}</span> : undefined}
  >
    <div className="my-3.5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2" data-slot="policy-details">
      <PermissionFacts className="m-0">
        <PermissionFact label="Execution role">{displayName(snapshot.models.dev, target, target)}</PermissionFact>
        <PermissionFact label="Resources"><span className="grid gap-0.5">{rule.statement.resources.map((item, index) => <code key={index}>{resourceText(item)}</code>)}</span></PermissionFact>
        {rule.statement.conditions ? <PermissionFact label="Conditions"><pre className="m-0 whitespace-pre-wrap wrap-anywhere">{JSON.stringify(rule.statement.conditions, null, 2)}</pre></PermissionFact> : null}
        {rule.shared ? <PermissionFact label="Consumers"><span className="flex flex-wrap gap-x-3 gap-y-1">{rule.consumers.map(consumer => <button key={consumer} className={buttonClasses({ variant: "link" })} onClick={() => select(consumer)}>{displayName(snapshot.models.dev, consumer, consumer)}</button>)}</span></PermissionFact> : null}
      </PermissionFacts>
      {!rule.writable ? <p className={inspectorNoteClasses}>{rule.reason ?? "This declaration is source-owned."}</p> : null}
      {issues.map(message => <p key={message} className={problemClasses} role="status">{message}</p>)}
    </div>
    {editing ? <IamPolicyEditor target={target} rule={rule} onDone={() => setEditing(false)} /> : adding ? <IamPolicyEditor target={target} initial={rule.statement} onDone={() => setAdding(false)} /> : <div className={inspectorRowActionsClasses}>
      <button className={buttonClasses({ variant: "link" })} disabled={disabled || !rule.writable || !!pending} onClick={() => setEditing(true)}>Edit policy{rule.shared ? " for all consumers" : ""}</button>
      <button className={buttonClasses({ variant: "link" })} disabled={disabled || !rule.writable || !!pending} onClick={() => draft.stageOperation({ kind: "iamPolicy", target, operation: "remove", rule: rule.id })}>{rule.shared ? "Remove policy for all consumers" : "Remove policy"}</button>
      {rule.shared ? <button className={buttonClasses({ variant: "link" })} disabled={disabled} onClick={() => setAdding(true)}>Add workload-specific rule</button> : null}
      {pending ? <button className={buttonClasses({ variant: "link" })} disabled={disabled} onClick={() => draft.discardOperation(pending.key)}>{pendingOperation === "remove" ? "Undo policy removal" : "Undo policy change"}</button> : null}
      {rule.location ? <a className={buttonClasses({ variant: "link" })} href={editorLink(snapshot.repositoryRoot, rule.location)}>Open declaration</a> : null}
    </div>}
  </InspectorDisclosureRow>;
}

export function PendingIamPolicies({ target, destination }: { readonly target?: string; readonly destination?: string }) {
  const { draftState, draft, model, live, snapshot } = useStudio();
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  return <>{draftState.entries.flatMap(entry => entry.kind === "operation" && entry.operation.kind === "iamPolicy" && (!target || entry.operation.target === target) && (!destination || entry.operation.statement?.resources.some(resource => resource.kind === "target" && resource.target === destination)) && entry.operation.operation === "add" ? [<InspectorResourceRow
    key={entry.key}
    as="div"
    role="status"
    data-slot="pending-iam-policy"
    icon={<EntityIcon size={26} icon="iam" />}
    title={<strong className="font-medium">IAM policy</strong>}
    trailing={<button className={cx(buttonClasses({ variant: "link" }), "text-caption")} disabled={disabled} onClick={() => draft.discardOperation(entry.key)}>Undo policy addition</button>}
  >
    <span>{destination ? `${displayName(snapshot.models.dev, entry.operation.target, entry.operation.target)} · ` : ""}{entry.operation.statement?.actions.join(", ")}</span>
    <span className="text-accept">Addition staged</span>
  </InspectorResourceRow>] : [])}</>;
}

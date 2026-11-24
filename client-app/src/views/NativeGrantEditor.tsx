import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DraftEdit } from "../../shared/api";
import type { PermissionCapability } from "../../shared/model";
import type { JsonArgument } from "aws-studio/config/cdk-resources";
import { sourceEditBlocked } from "../editing-state";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { Select, Textarea } from "../ui/FormControls";
import { accessConnectionExists } from "../access-options";
import {
  inspectorEditorActionsClasses,
  inspectorEditorClasses,
  inspectorLabelFieldClasses,
  inspectorLabelHelpClasses,
  inspectorNoteClasses,
} from "../inspector-ui";

type Connection = Extract<DraftEdit, { kind: "connection" }>;
export function NativeGrantEditor({ target, destination, grants, initial, alternative, onDone }: {
  readonly target: string;
  readonly destination: string;
  readonly grants: NonNullable<PermissionCapability["grants"]>;
  readonly initial?: Connection;
  /** A way out of this editor, such as returning to application actions; it closes the action row. */
  readonly alternative?: ReactNode;
  readonly onDone: () => void;
}) {
  const { snapshot, model, live, draft, draftState } = useStudio();
  const form = useRef<HTMLDivElement>(null);
  const [method, setMethod] = useState(initial?.grant ?? grants.find(item => !item.reason)?.method ?? grants[0]?.method ?? "");
  const [argumentsText, setArgumentsText] = useState(JSON.stringify(initial?.grantArguments ?? (initial?.scope ? [initial.scope] : []), null, 2));
  const grant = grants.find(item => item.method === method);
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  useEffect(() => { if (!disabled) form.current?.querySelector<HTMLElement>("select:not(:disabled)")?.focus(); }, [disabled]);
  let args: JsonArgument[] | undefined, problem: string | undefined;
  try {
    const value: unknown = JSON.parse(argumentsText);
    if (!Array.isArray(value)) throw new Error("Enter a JSON array of arguments.");
    const json = (item: unknown): boolean => item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || Array.isArray(item) && item.every(json) || !!item && typeof item === "object" && Object.entries(item).every(([key, value]) => !["__proto__", "constructor", "prototype"].includes(key) && json(value));
    if (!value.every(json)) throw new Error("Arguments must contain JSON values.");
    if (grant && value.length < grant.parameters.filter(item => !item.optional && !item.rest).length) throw new Error("Provide every required argument shown in the method signature.");
    if (grant && !grant.parameters.some(item => item.rest) && value.length > grant.parameters.length) throw new Error("This method accepts fewer arguments. Follow the displayed signature.");
    args = value as JsonArgument[];
  } catch (error) { problem = error instanceof SyntaxError ? "Enter valid JSON for the argument array." : error instanceof Error ? error.message : "Review these arguments."; }
  problem = grant?.reason ?? problem ?? (!grant ? "Choose a discovered native grant." : undefined);
  const saved = initial?.grantArguments ?? (initial?.scope ? [initial.scope] : []);
  if (initial && method === initial.grant && JSON.stringify(args) === JSON.stringify(saved)) problem ??= "No grant changes.";
  if (args && accessConnectionExists({ kind: "connection", target, connection: "grant", destination, enabled: true, grant: method, grantArguments: args }, snapshot)) problem ??= "This exact native grant already exists.";
  if (args && draftState.entries.some(entry => entry.kind === "operation" && entry.operation.kind === "connection" && entry.operation.connection === "grant" && entry.operation.target === target && entry.operation.destination === destination && entry.operation.grant === method && JSON.stringify(entry.operation.grantArguments ?? (entry.operation.scope ? [entry.operation.scope] : [])) === JSON.stringify(args))) problem ??= "This grant change is already staged.";
  return <div ref={form} role="group" aria-label="Native grant editor" className={inspectorEditorClasses} data-slot="native-grant-editor" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDone(); } }}>
    <p className={inspectorNoteClasses}>Use a grant method exposed by this native CDK resource. CDK supplies its policies and supporting permissions.</p>
    <label className={inspectorLabelFieldClasses}>Native grant<Select aria-label="Native grant method" value={method} disabled={disabled} onChange={event => { setMethod(event.target.value); setArgumentsText("[]"); }}>{grants.map(item => <option key={item.method} value={item.method} disabled={!!item.reason}>{item.method}</option>)}</Select>{grant ? <code className={inspectorLabelHelpClasses}>{grant.method}({grant.parameters.map(item => `${item.name}${item.optional ? "?" : ""}: ${item.type}`).join(", ")})</code> : null}</label>
    <label className={inspectorLabelFieldClasses}>Arguments (JSON array)<Textarea aria-label="Native grant arguments" rows={4} value={argumentsText} disabled={disabled} onChange={event => setArgumentsText(event.target.value)} spellCheck={false} /><span className={inspectorLabelHelpClasses}>The workload principal is supplied automatically. For example, <code>["cognito-idp:ListUsers"]</code>. An empty array calls the helper without extra arguments.</span></label>
    {problem ? <p role="status" className="m-0 text-caption leading-[1.5] text-refuse wrap-anywhere">{problem}</p> : null}
    <div className={inspectorEditorActionsClasses}><button className={buttonClasses({ variant: "neutral" })} disabled={disabled || !!problem || !args} onClick={() => { if (args && grant) { draft.stageOperation({ kind: "connection", target, connection: "grant", destination, enabled: true, grant: grant.method, grantArguments: args, ...(initial ? { previousGrant: { method: initial.grant!, arguments: saved } } : {}) }); onDone(); } }}>{initial ? "Stage grant changes" : "Stage grant"}</button><button className={buttonClasses({ variant: "quiet" })} onClick={onDone}>Cancel</button>{alternative}</div>
  </div>;
}

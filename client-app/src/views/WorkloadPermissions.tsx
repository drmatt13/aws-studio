import { sourceEditBlocked } from "../editing-state";
import { displayName } from "../naming";
import { InspectorDisclosure, InspectorDisclosureRow, InspectorResourceRow, InspectorSwitch } from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import {
  inspectorEditorActionsClasses,
  inspectorEditorClasses,
  inspectorIntroClasses,
  inspectorLabelClasses,
  inspectorLabelFieldClasses,
  inspectorLabelHelpClasses,
  inspectorNoteClasses,
  inspectorRelationListClasses,
  inspectorRowActionsClasses,
  inspectorSwitchFieldClasses,
} from "../inspector-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DraftEdit } from "../../shared/api";
import type { ModelResource, ModelTarget, Snapshot } from "../../shared/model";
import { configuredAccessOptions, permissionAccessOptions, accessConnectionExists } from "../access-options";
import { targetAccess, nativeAccessReplacement, type AccessEntry } from "../access";
import { targetIcon, ICONS } from "../icons";
import { EntityIcon } from "./EntityIcon";
import { editorLink, ROLE_LABEL } from "../lookup";
import { useStudio } from "../studio";
import { AuthorizationBadge, AuthorizationDetails } from "./Authorization";
import { ConfiguredResourcePicker } from "./ConfiguredResourcePicker";
import { normalizeResourceAccess, resourceAccessKey, type ResourceAccessAction } from "aws-studio/config/resource-access";
import { grantOptions, permissionRuleCoveredBy } from "../../shared/grants";
import { IamPolicyEditor, IamPolicyRow, PendingIamPolicies, policyStatementKey } from "./IamPolicyEditor";
import { NativeGrantEditor } from "./NativeGrantEditor";

type ConnectionEdit = Extract<DraftEdit, { kind: "connection" }>;
type DisplayedAccess = AccessEntry & { readonly environmentLabel?: string };

/** A permissions section stacks its add actions, open editor, notes and row list 12 px apart. */
const accessSectionClasses = "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3";
/** Saved and staged rows share one list, ruled between rows only; it takes no space while empty. */
const accessListClasses = "min-w-0 empty:hidden";
const accessWarningClasses = "m-0 text-caption leading-[1.5] text-local wrap-anywhere";
const accessProblemClasses = "m-0 text-caption leading-[1.5] text-refuse wrap-anywhere";
/** Notes inside an opened row follow its evidence block in normal flow. */
const accessRowNoteClasses = "mt-0 mb-2 text-caption leading-[1.5] text-graphite wrap-anywhere";
const accessRowProblemClasses = "mt-0 mb-2 text-caption leading-[1.5] text-refuse wrap-anywhere";
const rowLinkClasses = buttonClasses({ variant: "link" });
const configurationConnection = (edit: ConnectionEdit, snapshot: Snapshot) => edit.connection === "userPool" || edit.connection === "resource" && Object.values(snapshot.models).some(model => model.resources.some(resource => resource.id === edit.destination && resource.kind === "input"));
const connectionKey = (edit: ConnectionEdit) =>
  JSON.stringify([
    edit.target,
    edit.connection,
    edit.destination,
    edit.variable,
    edit.grant,
    edit.scope ?? "",
    edit.grantArguments,
    edit.previousGrant,
    edit.previous ?? (edit.connection === "resourceAccess" ? { actions: [...(edit.actions ?? [])].sort(), limits: edit.limits } : null),
  ]);

/** The same reviewed edit is available from a consumer or from its destination. */
function AccessEditor({
  target,
  destination,
  initial,
  replaces,
  configuration = false,
  onDone,
}: {
  readonly target: ModelTarget;
  readonly destination?: string;
  readonly initial?: ConnectionEdit;
  readonly replaces?: ConnectionEdit;
  readonly configuration?: boolean;
  readonly onDone: () => void;
}) {
  const { snapshot, model, live, draft, draftState, select } = useStudio();
  const options = useMemo(
    () => configuration ? configuredAccessOptions(target, snapshot, destination).filter(option => option.configuration) : permissionAccessOptions(target, snapshot, destination),
    [target, snapshot, destination, configuration],
  );
  const scopeHelp = useId();
  const suggestedVariable = (id: string) => {
    const resource = Object.values(snapshot.models)
      .flatMap((model) => model.resources)
      .find((item) => item.id === id);
    const secret = resource?.kind === "secret" || resource?.nativeKind === "secret";
    if (!resource || !["input", "secret"].includes(resource.kind) && !secret) return "";
    const name =
      resource.fromEnv ??
      resource.path
        .at(-1)
        ?.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toUpperCase() ??
      "";
    return secret &&
      target.kind !== "service" &&
      target.kind !== "task" &&
      !name.endsWith("_ARN")
      ? `${name}${name.endsWith("_SECRET") ? "_ARN" : "_SECRET_ARN"}`
      : name;
  };
  const [selected, setSelected] = useState(destination ?? "");
  const option = options.find((item) => item.id === selected);
  const form = useRef<HTMLDivElement>(null);
  const [actionId, setActionId] = useState("");
  const action =
    option?.actions.find((item) => item.id === actionId) ??
    option?.actions.find((item) => !item.reason) ??
    option?.actions[0];
  const [scope, setScope] = useState("uploads/*");
  const [variable, setVariable] = useState(() => suggestedVariable(destination ?? ""));
  const [selectedActions, setSelectedActions] = useState<readonly ResourceAccessAction[]>(initial?.actions ?? []);
  const [prefixEnabled, setPrefixEnabled] = useState(!!initial?.limits?.objectPrefix);
  const [objectPrefix, setObjectPrefix] = useState(initial?.limits?.objectPrefix ?? "");
  const [requireHttps, setRequireHttps] = useState(!!initial?.limits?.requireHttps);
  const [native, setNative] = useState(initial?.connection === "grant");
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  useEffect(() => {
    if (option)
      form.current
        ?.querySelector<HTMLElement>(
          "select:not(:disabled), input:not(:disabled), button[data-stage]",
        )
        ?.focus();
  }, [option?.id, native]);
  const choose = (id: string) => {
    setSelected(id);
    setActionId("");
    setScope("uploads/*");
    setVariable(suggestedVariable(id));
    setSelectedActions([]);
    setPrefixEnabled(false);
    setObjectPrefix("");
    setRequireHttps(false);
    setNative(false);
  };
  if (!option)
    return (
      <ConfiguredResourcePicker
        label={configuration ? "Configuration inputs" : "Configured resources"}
        options={options}
        onChoose={choose}
        onCancel={onDone}
        disabled={disabled}
        onInspect={(id) => { onDone(); select(id); }}
      />
    );
  if (option.invokeTarget) return <IamPolicyEditor target={target.ref} initial={{ actions: ["lambda:InvokeFunction"], resources: [{ kind: "target", target: option.invokeTarget }] }} onDone={onDone} />;
  if ((native || !option.definition && action?.edit.connection === "grant") && option.grants?.length) return <div className={inspectorEditorClasses}>
    {option.warning ? <p className={accessWarningClasses} role="status">{option.warning}</p> : null}
    <NativeGrantEditor
      target={target.ref}
      destination={option.id}
      grants={option.grants}
      initial={initial?.connection === "grant" ? initial : undefined}
      alternative={option.definition ? <button className={cx(rowLinkClasses, "text-caption")} disabled={disabled} onClick={() => setNative(false)}>Use application actions</button> : undefined}
      onDone={onDone}
    />
  </div>;
  const edit = action
    ? {
        ...action.edit,
        ...(action.edit.connection === "grant" ? { scope: action.scope ? scope : "" } : {}),
        ...(action.variable ? { variable } : {}),
        ...(option.definition ? { actions: [...selectedActions].sort(), limits: prefixEnabled || requireHttps || option.requireHttps ? { ...(prefixEnabled ? { objectPrefix } : {}), ...((requireHttps || option.requireHttps) ? { requireHttps: true } : {}) } : undefined, ...(initial?.actions && !replaces ? { previous: { actions: initial.actions, ...(initial.limits ? { limits: initial.limits } : {}) } } : {}) } : {}),
      }
    : undefined;
  const duplicate = !!edit && (!initial || !!replaces) && accessConnectionExists(edit, snapshot);
  let permissionProblem: string | undefined;
  if (option.definition && edit) {
    try { normalizeResourceAccess({ actions: edit.actions!, limits: edit.limits }, option.definition); }
    catch (error) { permissionProblem = error instanceof Error ? error.message : "Choose supported permissions."; }
  }
  const unchanged = !replaces && initial?.actions && edit?.actions?.length && !permissionProblem && resourceAccessKey({ actions: initial.actions, limits: initial.limits }) === resourceAccessKey({ actions: edit.actions, limits: edit.limits });
  const pending =
    edit &&
    draftState.entries.some(
      (entry) =>
        entry.kind === "operation" &&
        entry.operation.kind === "connection" &&
        connectionKey(entry.operation) === connectionKey(edit),
    );
  const variableUsed =
    action?.variable &&
    [...target.environment, ...target.secrets].some((entry) => entry.name === variable);
  const problem =
    option.reason ?? permissionProblem ?? (unchanged ? "No permission changes." : undefined) ??
    action?.reason ??
    (duplicate
      ? "This access is already configured."
      : pending
        ? "This change is already staged."
        : variableUsed
          ? "This environment variable is already in use."
          : action?.variable && variable && !/^[A-Z][A-Z0-9_]*$/.test(variable)
            ? "Use uppercase letters, digits and underscores, starting with a letter."
            : undefined);
  const valid =
    !!edit &&
    !problem &&
    (!action?.variable || /^[A-Z][A-Z0-9_]{0,127}$/.test(variable)) &&
    (!action?.scope || (scope.length <= 256 && !/[\r\n\0]/.test(scope)));
  return (
    <div
      ref={form}
      className={inspectorEditorClasses}
      role="group"
      aria-label={`Access to ${option.title}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }
      }}
      data-slot="access-editor"
    >
      <div
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5"
        data-slot="access-destination"
      >
        <EntityIcon size={26} icon={option.icon} />
        <strong className={cx("min-w-0 font-medium wrap-anywhere", destination && "col-span-2")}>
          {option.title}
        </strong>
        {!destination ? (
          <button
            className={cx(rowLinkClasses, "text-caption")}
            disabled={disabled}
            onClick={() => choose("")}
          >
            Change
          </button>
        ) : null}
        <span className="col-span-2 col-start-2 min-w-0 text-caption text-graphite wrap-anywhere">
          {option.subtitle}
        </span>
      </div>
      {option.warning ? <p className={accessWarningClasses} role="status">{option.warning}</p> : null}
      {option.definition ? (
        <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" disabled={disabled}>
          <legend className="mb-2 p-0 text-label font-medium">Permissions</legend>
          <label className="flex items-center gap-2 text-label font-medium">
            <TextInput type="checkbox" checked={selectedActions.length === option.definition.actions.length} ref={node => { if (node) node.indeterminate = selectedActions.length > 0 && selectedActions.length < option.definition!.actions.length; }} onChange={event => setSelectedActions(event.target.checked ? option.definition!.actions.map(item => item.id) : [])} />
            Full access
          </label>
          <span className={inspectorLabelHelpClasses}>All supported application actions for this resource.</span>
          {option.definition.actions.map(item => <label key={item.id} className="flex items-center gap-2 text-label"><TextInput type="checkbox" checked={selectedActions.includes(item.id)} onChange={event => setSelectedActions(event.target.checked ? [...selectedActions, item.id] : selectedActions.filter(action => action !== item.id))} />{item.label}</label>)}
          {option.definition.id === "sqs" && selectedActions.includes("receive") && !selectedActions.includes("delete") ? <p className={inspectorNoteClasses}>Receive does not acknowledge or delete messages. Select Delete messages when your consumer needs it.</p> : null}
          {option.definition.id === "dynamodb" && (selectedActions.includes("write") || selectedActions.includes("delete")) && !(selectedActions.includes("write") && selectedActions.includes("delete")) ? <p className={inspectorNoteClasses}>Batch writes require both Write items and Delete items because the same API can perform both operations.</p> : null}
        </fieldset>
      ) : option.actions.length > 1 ? (
        <label className={inspectorLabelFieldClasses} data-slot="resource-control">
          <span>Permission</span>
          <Select
            className="w-full"
            value={action?.id ?? ""}
            disabled={disabled}
            onChange={(event) => setActionId(event.target.value)}
          >
            {option.actions.map((item) => (
              <option key={item.id} value={item.id} disabled={!!item.reason}>
                {item.label}
                {item.existing ? " · configured" : ""}
              </option>
            ))}
          </Select>
        </label>
      ) : (
        <p className="m-0 wrap-anywhere">{action?.label}</p>
      )}
      {option.definition?.id === "s3" ? <InspectorDisclosure title="Limit access" embedded className="-my-2">
        <div className="min-w-0">
          <div className={inspectorSwitchFieldClasses}>
            <span className={inspectorLabelClasses}>Object prefix</span>
            <InspectorSwitch label="Limit to object prefix" checked={prefixEnabled} onChange={setPrefixEnabled} disabled={disabled} />
            {prefixEnabled ? <label className={cx(inspectorLabelFieldClasses, "col-span-full")}>Prefix<TextInput aria-label="Prefix" value={objectPrefix} maxLength={256} disabled={disabled} placeholder="uploads/" onChange={event => setObjectPrefix(event.target.value)} /><span className={inspectorLabelHelpClasses}>Literal prefix for object access and listing. Include a trailing / to limit access to a folder.</span></label> : null}
          </div>
          <div className={inspectorSwitchFieldClasses}>
            <span className={inspectorLabelClasses}>Require HTTPS</span>
            <InspectorSwitch label="Require HTTPS" checked={requireHttps || !!option.requireHttps} onChange={setRequireHttps} disabled={disabled || option.requireHttps} />
            {option.requireHttps ? <span className={cx(inspectorLabelHelpClasses, "col-span-full")}>Required by the bucket’s configuration.</span> : null}
          </div>
        </div>
      </InspectorDisclosure> : null}
      {action?.scope ? (
        <label className={inspectorLabelFieldClasses} data-slot="resource-control">
          <span>Bucket object scope</span>
          <TextInput
            className="w-full"
            aria-label="Bucket object scope"
            aria-describedby={scopeHelp}
            value={scope}
            disabled={disabled}
            maxLength={256}
            onChange={(event) => setScope(event.target.value)}
            placeholder="* (all objects)"
            spellCheck={false}
          />
          <span id={scopeHelp} className={inspectorLabelHelpClasses}>
            Limit access to an object prefix, or use * for all objects.
          </span>
        </label>
      ) : null}
      {action?.variable ? (
        <label className={inspectorLabelFieldClasses} data-slot="resource-control">
          <span>Environment variable</span>
          <TextInput
            className="w-full"
            value={variable}
            disabled={disabled}
            maxLength={128}
            onChange={(event) => setVariable(event.target.value)}
            placeholder="MY_RESOURCE"
            spellCheck={false}
          />
        </label>
      ) : null}
      {action ? <AccessUsage edit={action.edit} className="m-0" /> : null}
      {replaces ? <p className={inspectorNoteClasses}>Replaces this native grant with the selected application actions. Review the source diff for the change in scope and supporting permissions.</p> : null}
      {problem ? (
        <p className={accessProblemClasses} role="status">
          {problem}
        </p>
      ) : null}
      <div className={inspectorEditorActionsClasses} data-slot="access-actions">
        <button
          data-stage
          className={buttonClasses({ variant: "neutral" })}
          disabled={disabled || !valid}
          onClick={() => {
            if (edit && valid) {
              if (replaces) draft.stageOperation(replaces);
              if (option.definition) {
                const { actions: _actions, limits: _limits, ...base } = edit;
                draft.stageOperation({ ...base, ...normalizeResourceAccess({ actions: edit.actions!, limits: edit.limits }, option.definition) });
              } else draft.stageOperation(edit);
              onDone();
            }
          }}
        >
          {initial ? "Stage changes" : "Stage access"}
        </button>
        <button className={buttonClasses({ variant: "quiet" })} onClick={onDone}>
          Cancel
        </button>
        {option.grants?.length && !initial && option.definition ? <button className={cx(rowLinkClasses, "text-caption")} disabled={disabled} onClick={() => setNative(true)}>Advanced native grant</button> : null}
      </div>
    </div>
  );
}

function AccessUsage({
  edit,
  className = "mt-0 mb-2",
}: {
  readonly edit: ConnectionEdit;
  readonly className?: string;
}) {
  const { snapshot } = useStudio();
  const destination = Object.values(snapshot.models)
    .flatMap((model) => model.targets)
    .find((target) => target.ref === edit.destination);
  const helper =
    edit.connection === "startsWorkflow"
      ? "startWorkflow"
      : edit.connection === "runsTask"
        ? "runTask"
        : undefined;
  if (helper && destination)
    return (
      <p className={cx("text-caption text-graphite", className)}>
        Call{" "}
        <code>
          {helper}({JSON.stringify(destination.id)}, input)
        </code>{" "}
        from your handler using <code>aws-studio/runtime/invocation</code>.
      </p>
    );
  if (edit.connection === "invokesAgent")
    return (
      <p className={cx("text-caption text-graphite", className)}>
        Call <code>invokeAgent</code> from <code>aws-studio/runtime/agentcore</code>;
        authenticated agents also require the caller’s session.
      </p>
    );
  if (edit.connection === "userPool")
    return (
      <p className={cx("text-caption text-graphite", className)}>
        Supplies the pool and client identifiers. To require a signed-in user, wrap the handler with{" "}
        <code>authenticated</code>.
      </p>
    );
  if (edit.connection === "database")
    return (
      <p className={cx("text-caption text-graphite", className)}>
        Connects to the application’s PostgreSQL database with IAM login and its private network
        placement.
      </p>
    );
  if (edit.connection === "resource") {
    const resource = Object.values(snapshot.models)
      .flatMap((model) => model.resources)
      .find((item) => item.id === edit.destination);
    const consumer = Object.values(snapshot.models)
      .flatMap((model) => model.targets)
      .find((item) => item.ref === edit.target);
    if (resource?.kind === "secret" || resource?.nativeKind === "secret")
      return (
        <p className={cx("text-caption text-graphite", className)}>
          {consumer?.kind === "service" || consumer?.kind === "task"
            ? "Loads the secret into the container’s environment at startup."
            : "Supplies the secret ARN and grants the workload permission to read it."}
        </p>
      );
  }
  if (edit.connection === "grant" && edit.grant === "grantConsumeMessages")
    return (
      <p className={cx("text-caption text-graphite", className)}>
        Allows your code to read queue messages. For automatic delivery to an event function, add
        the queue under Triggers.
      </p>
    );
  return null;
}

function AccessRow({
  entry,
  disabled,
}: {
  readonly entry: DisplayedAccess;
  readonly disabled: boolean;
}) {
  const { draft, draftState, select, snapshot } = useStudio();
  const [editing, setEditing] = useState(false);
  const [editingNative, setEditingNative] = useState(false);
  const pending =
    entry.remove &&
    draftState.entries.find(
      (item) =>
        item.kind === "operation" &&
        item.operation.kind === "connection" &&
        connectionKey(item.operation) === connectionKey(entry.remove!),
    );
  const principal = entry.authorization.grants.find(grant => grant.principalEntity)?.principalEntity;
  const source = entry.edge?.source ?? (principal ? snapshot.source.entities[principal]?.value : undefined);
  const context = entry.edge?.permissionContext;
  const consumer = Object.values(snapshot.models).flatMap(model => model.targets).find(target => target.ref === entry.remove?.target);
  const replacement = nativeAccessReplacement(entry.remove, snapshot.source);
  const editable = entry.remove?.connection === "resourceAccess" ? entry.remove : replacement;
  const nativeGrant = entry.remove?.connection === "grant" ? entry.remove : undefined;
  const nativeMethods = snapshot.source.permissionCapabilities?.find(item => item.resource === entry.edge?.to)?.grants;
  const nativeTypes = snapshot.source.permissionCapabilities?.find(item => item.resource === entry.edge?.to)?.canonicalTypes ?? snapshot.source.triggerCapabilities?.find(item => item.resource === entry.edge?.to)?.canonicalTypes ?? [];
  const includesDeletion = context?.kind === "native" && grantOptions(nativeTypes).some(item => item.method === context.method && /grant(?:Read)?Write(?:Data)?$/.test(item.method));
  const managed = !entry.remove && entry.edge ? entry.edge.relation === "routes" ? "Managed by route"
    : entry.edge.relation === "trigger" ? "Managed by trigger"
      : ["step", "integration"].includes(entry.edge.relation) ? "Managed by workflow"
        : ["authorizes", "usesGateway", "usesTool"].includes(entry.edge.relation) ? "Managed by gateway" : undefined : undefined;
  const owner = entry.edge ? entry.edge.relation === "trigger" ? entry.edge.to
    : ["authorizes", "usesGateway"].includes(entry.edge.relation) ? entry.edge.to : entry.edge.from : undefined;
  const alsoGranted = context?.kind === "resourceAccess" && entry.edge ? [...new Set(Object.values(snapshot.models).flatMap(model => model.edges).flatMap(edge => {
    if (edge.id === entry.edge!.id) return [];
    const other = edge.permissionContext;
    // Queue polling grants belong to the receiving Lambda role, opposite the event-flow arrow.
    if (edge.from === entry.edge!.to && edge.to === entry.edge!.from && other?.kind === "trigger" && other.adapter === "sqs") {
      return permissionRuleCoveredBy(context, { method: "grantConsumeMessages", arguments: [] }) ? ["managed queue trigger"] : [];
    }
    if (edge.from !== entry.edge!.from || edge.to !== entry.edge!.to) return [];
    return (other?.kind === "resourceAccess" || other?.kind === "native") && permissionRuleCoveredBy(context, other)
      ? [other.kind === "native" ? other.method : "another declared access rule"] : [];
  }))] : [];
  const scope =
    context?.kind === "native" &&
    context.arguments.length === 1 &&
    typeof context.arguments[0] === "string"
      ? context.arguments[0]
      : context?.kind === "resourceAccess" ? [context.limits?.objectPrefix ? `prefix ${context.limits.objectPrefix}` : "", context.limits?.requireHttps ? "HTTPS" : ""].filter(Boolean).join(" · ") : undefined;
  return (
    <InspectorDisclosureRow
      data-slot="access-summary"
      icon={<EntityIcon size={26} icon={entry.destination.icon} />}
      title={entry.destination.title}
      caption={
        <>
          {entry.operation}
          {scope ? ` · ${scope}` : ""}
          {entry.environmentLabel ? ` · ${entry.environmentLabel}` : ""}
          {managed ? ` · ${managed}` : ""}
        </>
      }
      trailing={
        pending ? (
          <span className="text-caption font-medium text-local" data-slot="section-state">
            {pending.kind === "operation" && pending.operation.kind === "connection" && pending.operation.enabled ? "Changes staged" : "Removal staged"}
          </span>
        ) : entry.authorization.kind !== "iam" ? (
          <AuthorizationBadge authorization={entry.authorization} />
        ) : undefined
      }
    >
      <AuthorizationDetails authorization={entry.authorization} />
      {entry.edge?.readinessIssues?.map(issue => <p key={`${issue.code}:${issue.entity}:${issue.message}`} className={accessRowProblemClasses} role="status">{issue.message}</p>)}
      {alsoGranted.length ? <p className={accessRowNoteClasses} data-slot="permission-overlap">Also granted by {alsoGranted.join(", ")}. Changing this rule leaves those grants in place.</p> : null}
      {includesDeletion ? <p className={accessRowNoteClasses}>This native write helper includes deletion. Its existing permissions are preserved.</p> : null}
      {entry.remove ? <AccessUsage edit={entry.remove} /> : null}
      {editing && consumer && editable ? <div className="mb-3"><AccessEditor target={consumer} destination={editable.destination} initial={{ ...editable, enabled: true }} replaces={replacement ? entry.remove : undefined} onDone={() => setEditing(false)} /></div> : null}
      {editingNative && consumer && nativeGrant && nativeMethods?.length ? <div className="mb-3"><NativeGrantEditor target={consumer.ref} destination={entry.edge!.to} grants={nativeMethods} initial={nativeGrant} onDone={() => setEditingNative(false)} /></div> : null}
      <div className={inspectorRowActionsClasses} data-slot="access-actions">
        {editable && !editing && !pending ? <button className={rowLinkClasses} disabled={disabled} onClick={() => setEditing(true)}>Edit access</button> : null}
        {nativeGrant && nativeMethods?.length && !editingNative && !pending ? <button className={rowLinkClasses} disabled={disabled} onClick={() => setEditingNative(true)}>Edit native grant</button> : null}
        {managed && owner ? <button className={rowLinkClasses} onClick={() => select(owner)}>Inspect {managed.replace("Managed by ", "")}</button> : null}
        {entry.destination.id ? (
          <button className={rowLinkClasses} onClick={() => select(entry.destination.id)}>
            Inspect resource
          </button>
        ) : null}
        {entry.connection ? (
          <button className={rowLinkClasses} onClick={() => select(entry.connection)}>
            Inspect connection
          </button>
        ) : null}
        {source ? <a className={rowLinkClasses} href={editorLink(snapshot.repositoryRoot, source)}>Open declaration</a> : null}
        {pending ? (
          <button
            className={rowLinkClasses}
            disabled={disabled}
            onClick={() => draft.discardOperation(pending.key)}
          >
            Undo change
          </button>
        ) : entry.remove ? (
          <button
            className={rowLinkClasses}
            disabled={disabled}
            onClick={() => draft.stageOperation(entry.remove!)}
          >
            Remove access
          </button>
        ) : null}
      </div>
    </InspectorDisclosureRow>
  );
}

/** The staged additions a list will show, so its container can know whether it has rows. */
function stagedAccess(
  entries: ReturnType<typeof useStudio>["draftState"]["entries"],
  snapshot: Snapshot,
  { target, destination, configuration = false }: { readonly target?: string; readonly destination?: string; readonly configuration?: boolean },
) {
  return entries.filter(
    (entry) =>
      entry.kind === "operation" &&
      entry.operation.kind === "connection" &&
      entry.operation.enabled &&
      configurationConnection(entry.operation, snapshot) === configuration &&
      (!target || entry.operation.target === target) &&
      (!destination || entry.operation.destination === destination),
  );
}

function PendingAccess({
  target,
  destination,
  configuration = false,
}: {
  readonly target?: string;
  readonly destination?: string;
  readonly configuration?: boolean;
}) {
  const { draft, draftState, snapshot, model, live } = useStudio();
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const entries = stagedAccess(draftState.entries, snapshot, { target, destination, configuration });
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind !== "operation" || entry.operation.kind !== "connection") return null;
        const edit = entry.operation;
        const consumer = Object.values(snapshot.models)
          .flatMap((model) => model.targets)
          .find((item) => item.ref === edit.target);
        const options = consumer ? configuredAccessOptions(consumer, snapshot) : [];
        const option = options.find((item) =>
          item.actions.some(
            (action) =>
              action.edit.connection === edit.connection &&
              action.edit.destination === edit.destination,
          ),
        );
        const action = option?.actions.find(
          (item) => item.edit.connection === edit.connection && item.edit.grant === edit.grant,
        );
        // The icon depicts whichever end the title names: the caller here, the resource on a workload.
        const icon = (destination && consumer ? targetIcon(consumer) : option?.icon) ?? "construct";
        return (
          <InspectorResourceRow
            key={entry.key}
            as="div"
            role="status"
            data-slot="pending-access"
            icon={<EntityIcon size={26} icon={icon} />}
            title={
              <strong className="font-medium">
                {destination ? consumer?.title : option?.title}
              </strong>
            }
            trailing={
              <button
                className={cx(rowLinkClasses, "text-caption")}
                disabled={disabled}
                onClick={() => draft.discardOperation(entry.key)}
              >
                Undo
              </button>
            }
          >
            <span>
              {action?.label ?? "Access"}
              {edit.connection === "resourceAccess" ? ` · ${edit.actions?.join(", ")}` : ""}
              {edit.scope ? ` · ${edit.scope}` : ""}
              {edit.variable ? ` · ${edit.variable}` : ""}
            </span>
            <span className="text-accept">Staged for review</span>
          </InspectorResourceRow>
        );
      })}
    </>
  );
}

export function WorkloadPermissions({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const [editing, setEditing] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState(false);
  const [addingCaller, setAddingCaller] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const caller = useRef<HTMLButtonElement>(null);
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const policyRules = snapshot.source.policyRules?.filter(rule => rule.consumers.includes(target.ref)) ?? [];
  const { owned, incoming } = useMemo(() => {
    const modes = [...Object.values(snapshot.models).filter((item) => item !== model), model];
    const access = modes.flatMap((item) => {
      const consumer = item.targets.find((candidate) => candidate.ref === target.ref);
      return consumer
        ? [{ mode: item.mode, ...targetAccess(consumer, item, snapshot.source) }]
        : [];
    });
    const combine = (side: "owned" | "incoming"): DisplayedAccess[] => {
      const entries = new Map<string, { entry: AccessEntry; modes: string[] }>();
      for (const item of access)
        for (const entry of item[side]) {
          // Build state can differ by mode; different permissions must remain visible.
          const key = JSON.stringify([
            entry.id,
            entry.authorization.kind,
            entry.authorization.grants,
            entry.edge?.permissionContext,
          ]);
          const previous = entries.get(key);
          const issues = entry.edge?.readinessIssues?.map(issue => ({ ...issue, message: `${item.mode === "dev" ? "Development" : "Production"}: ${issue.message}` })) ?? [];
          const combined = entry.edge ? { ...entry, edge: { ...entry.edge, readinessIssues: [...(previous?.entry.edge?.readinessIssues ?? []), ...issues] } } : entry;
          entries.set(key, { entry: combined, modes: [...(previous?.modes ?? []), item.mode] });
        }
      return [...entries].map(([key, value]) => ({
        ...value.entry,
        id: key,
        ...(value.modes.length === 1 &&
        [...entries.values()].some((other) => other !== value && other.entry.id === value.entry.id)
          ? { environmentLabel: value.modes[0] === "dev" ? "Dev" : "Prod" }
          : {}),
      }));
    };
    const indexed = snapshot.source.policyRules?.filter(rule => rule.consumers.includes(target.ref)) ?? [];
    return { owned: combine("owned").filter(entry => !entry.authorization.statement || !indexed.some(rule => policyStatementKey(rule.statement) === policyStatementKey(entry.authorization.statement!))), incoming: combine("incoming") };
  }, [target.ref, snapshot, model]);
  const done = () => {
    setEditing(false);
    requestAnimationFrame(() => add.current?.focus());
  };
  const callerDone = () => {
    setAddingCaller(false);
    requestAnimationFrame(() => caller.current?.focus());
  };
  const source = snapshot.source.entities[target.ref]?.value;
  const callable = ["lambda", "task", "workflow", "agent"].includes(target.kind);
  const policyTouches = (edit: Extract<DraftEdit, {kind:"iamPolicy"}>, side: "owned" | "incoming") => side === "owned" ? edit.target === target.ref : (edit.statement ?? snapshot.source.policyRules?.find(rule => rule.id === edit.rule)?.statement)?.resources.some(resource => resource.kind === "target" && resource.target === target.ref);
  const modified = (side: "owned" | "incoming") => draftState.entries.some(entry => entry.kind === "operation" && (entry.operation.kind === "iamPolicy" ? policyTouches(entry.operation, side) : entry.operation.kind === "connection" && !configurationConnection(entry.operation, snapshot) && (side === "owned" ? entry.operation.target : entry.operation.destination) === target.ref));
  return (
    <InspectorDisclosure
      title="Permissions"
      count={owned.length + policyRules.length + incoming.length}
      status={draftState.entries.some((entry) => entry.kind === "operation" &&
        (entry.operation.kind === "iamPolicy" ? policyTouches(entry.operation, "owned") || policyTouches(entry.operation, "incoming") : entry.operation.kind === "connection" && !configurationConnection(entry.operation, snapshot) &&
        (entry.operation.target === target.ref || entry.operation.destination === target.ref)))
        ? "modified" : undefined}
    >
      <p className={inspectorIntroClasses}>Declared application access. Deployment and effective AWS authorization are separate.</p>
      <InspectorDisclosure title="Resource permissions" count={owned.length + policyRules.length} embedded status={modified("owned") ? "modified" : undefined} contentClassName={accessSectionClasses} data-slot="resource-permissions">
        {target.kind !== "workflow" && !editing ? (
          <div className={inspectorEditorActionsClasses}>
            <button
              ref={add}
              className={buttonClasses({ variant: "quiet" })}
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              Add access
            </button>
            {!editingPolicy ? <button className={cx(rowLinkClasses, "text-caption")} disabled={disabled} onClick={() => setEditingPolicy(true)}>Manual IAM</button> : null}
          </div>
        ) : null}
        {editing ? <AccessEditor target={target} onDone={done} /> : null}
        {editingPolicy ? <IamPolicyEditor target={target.ref} onDone={() => setEditingPolicy(false)} /> : null}
        {!owned.length && !policyRules.length && !editing && !editingPolicy ? (
          <p className={inspectorNoteClasses}>No outgoing access configured.</p>
        ) : null}
        <div className={accessListClasses} data-slot="access-list">
          {policyRules.map(rule => <IamPolicyRow key={rule.id} target={target.ref} rule={rule} />)}
          <PendingIamPolicies target={target.ref} />
          {owned.map((entry) => (
            <AccessRow key={entry.id} entry={entry} disabled={disabled} />
          ))}
          <PendingAccess target={target.ref} />
        </div>
        {target.kind === "workflow" ? (
          <p className={inspectorNoteClasses} data-slot="access-note">
            Access is defined by this workflow’s steps.
            {source ? (
              <>
                {" "}
                <a href={editorLink(snapshot.repositoryRoot, source)}>Open workflow definition</a>.
              </>
            ) : null}
          </p>
        ) : null}
      </InspectorDisclosure>
      <InspectorDisclosure title="Access to this resource" count={incoming.length} embedded status={modified("incoming") ? "modified" : undefined} contentClassName={accessSectionClasses} data-slot="incoming-access">
        {callable && !addingCaller ? (
          <div className={inspectorEditorActionsClasses}>
            <button
              ref={caller}
              className={buttonClasses({ variant: "quiet" })}
              disabled={disabled}
              onClick={() => setAddingCaller(true)}
            >
              Add caller
            </button>
          </div>
        ) : null}
        {addingCaller ? (
          <ConsumerAccessEditor destination={target.ref} onDone={callerDone} />
        ) : null}
        {!incoming.length && !addingCaller ? <p className={inspectorNoteClasses}>No callers or integrations configured.</p> : null}
        <div className={accessListClasses} data-slot="access-list">
          {incoming.map((entry) => (
            <AccessRow key={entry.id} entry={entry} disabled={disabled} />
          ))}
          {callable ? <PendingAccess destination={target.ref} /> : null}
          {callable ? <PendingIamPolicies destination={target.ref} /> : null}
        </div>
      </InspectorDisclosure>
    </InspectorDisclosure>
  );
}

function ConsumerAccessEditor({
  destination,
  onDone,
}: {
  readonly destination: string;
  readonly onDone: () => void;
}) {
  const { snapshot, model, draft, draftState, live } = useStudio();
  const [consumer, setConsumer] = useState<ModelTarget>();
  const candidates = useMemo(
    () =>
      [
        ...new Map(
          Object.values(snapshot.models)
            .flatMap((item) => item.targets)
            .map((target) => [target.ref, target]),
        ).values(),
      ].flatMap((target) => {
        const option = configuredAccessOptions(target, snapshot, destination).find(
          (item) => item.id === destination,
        );
        return option && (option.actions.length || option.invokeTarget) ? [{ target, option }] : [];
      }),
    [snapshot, destination],
  );
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  return consumer ? (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <p className={inspectorNoteClasses}>
        Grant to <strong className="text-ink">{displayName(model, consumer.ref, consumer.title)}</strong>
      </p>
      <AccessEditor
        key={consumer.ref}
        target={consumer}
        destination={destination}
        onDone={onDone}
      />
    </div>
  ) : (
    <ConfiguredResourcePicker
      label="Workloads"
      options={candidates.map(({ target, option }) => ({
        id: target.ref,
        title: displayName(model, target.ref, target.title),
        subtitle: `${ICONS[targetIcon(target)][1]} · ${target.role}`,
        icon: targetIcon(target),
        reason: option.reason,
        warning: option.warning,
        searchTerms: target.ref,
      }))}
      onChoose={(id) => setConsumer(candidates.find((item) => item.target.ref === id)?.target)}
      onCancel={onDone}
      disabled={disabled}
    />
  );
}

/** Input delivery has its own home; it does not masquerade as an IAM grant. */
export function WorkloadConfigurationAccess({ target }: { readonly target: ModelTarget }) {
  const { snapshot, model, live, draft, draftState } = useStudio();
  const [editing, setEditing] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  if (target.kind === "workflow" || !configuredAccessOptions(target, snapshot).some(option => option.configuration)) return null;
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  return <div className={cx(accessSectionClasses, "mb-3")} data-slot="configuration-access">
    {editing ? <AccessEditor target={target} configuration onDone={() => { setEditing(false); requestAnimationFrame(() => add.current?.focus()); }} /> : <div className={inspectorEditorActionsClasses}><button ref={add} className={buttonClasses({ variant: "quiet" })} disabled={disabled} onClick={() => setEditing(true)}>Add input</button></div>}
    <div className={accessListClasses} data-slot="access-list">
      <PendingAccess target={target.ref} configuration />
    </div>
  </div>;
}


/** A resource can grant access without making the developer hunt for its consumer.
 * An authored input or secret has no such section: its Connections list each consumer,
 * and each workload edits how it reads, requires or deploys on it. */
export function ResourceAccess({ resource }: { readonly resource: ModelResource }) {
  const { snapshot, model, draft, draftState, live, select } = useStudio();
  const [choosing, setChoosing] = useState(false);
  const add = useRef<HTMLButtonElement>(null);
  const { supported, consumers } = useMemo(() => {
    const targets = [
      ...new Map(
        Object.values(snapshot.models)
          .flatMap((item) => item.targets)
          .map((target) => [target.ref, target]),
      ).values(),
    ];
    const supported = targets.some((target) =>
      configuredAccessOptions(target, snapshot, resource.id).some(
        (option) => option.id === resource.id && option.actions.length > 0,
      ),
    );
    const consumers = targets.filter((target) =>
      Object.values(snapshot.models).some((item) => {
        const candidate = item.targets.find((value) => value.ref === target.ref);
        return (
          candidate &&
          (targetAccess(candidate, item, snapshot.source).owned.some(
            (entry) => entry.destination.id === resource.id,
          ) ||
            candidate.environment.some(
              (entry) => entry.value.kind === "reference" && entry.value.resource === resource.id,
            ) ||
            candidate.secrets.some((entry) => entry.resource === resource.id))
        );
      }),
    );
    return { supported, consumers };
  }, [snapshot, resource.id]);
  if (resource.kind === "input" || resource.kind === "secret" || !supported && !consumers.length) return null;
  const disabled = sourceEditBlocked({ draftState, draft, model, live });
  const staged = stagedAccess(draftState.entries, snapshot, { destination: resource.id }).length > 0;
  const done = () => {
    setChoosing(false);
    requestAnimationFrame(() => add.current?.focus());
  };
  return (
    <InspectorDisclosure
      title="Access to this resource"
      count={consumers.length}
      status={draftState.entries.some((entry) => entry.kind === "operation" &&
        entry.operation.kind === "connection" && entry.operation.destination === resource.id)
        ? "modified" : undefined}
      contentClassName={accessSectionClasses}
    >
      {!choosing && supported ? (
        <div className={inspectorEditorActionsClasses}>
          <button
            ref={add}
            className={buttonClasses({ variant: "quiet" })}
            disabled={disabled}
            onClick={() => setChoosing(true)}
          >
            Grant access
          </button>
        </div>
      ) : null}
      {choosing ? <ConsumerAccessEditor destination={resource.id} onDone={done} /> : null}
      {!consumers.length && !choosing ? (
        <p className={inspectorNoteClasses}>No workloads have access yet.</p>
      ) : null}
      {/* Saved consumers and staged grants read as one list: the staged rows continue its rules. */}
      {consumers.length || staged ? (
        <div className="min-w-0" data-slot="access-list">
          {consumers.length ? (
            <ul className={inspectorRelationListClasses} data-slot="resource-consumers">
              {consumers.map((target) => (
                <InspectorResourceRow
                  key={target.ref}
                  data-slot="resource-consumer"
                  icon={<EntityIcon size={26} icon={targetIcon(target)} />}
                  title={
                    <button className={buttonClasses({ variant: "link" })} onClick={() => select(target.ref)}>
                      {displayName(model, target.ref, target.title)}
                    </button>
                  }
                >
                  <span>{ROLE_LABEL[target.role]}</span>
                </InspectorResourceRow>
              ))}
            </ul>
          ) : null}
          {staged ? (
            <div className={cx("min-w-0", consumers.length > 0 && "mt-2.5 border-t border-rule pt-2.5")}>
              <PendingAccess destination={resource.id} />
            </div>
          ) : null}
        </div>
      ) : null}
    </InspectorDisclosure>
  );
}

import { useEffect, useId, useState } from "react";
import { FRAMEWORK_INPUT_GROUPS } from "../../shared/deployment-inputs";
import type { Mode, ModelResource } from "../../shared/model";
import type { ResourceDetails } from "../../shared/resources";
import { api } from "../api";
import { sourceEditBlocked } from "../editing-state";
import {
  environmentCardClasses,
  inspectorHeaderClasses,
  inspectorNoteClasses,
  inspectorSectionClasses,
} from "../inspector-ui";
import { resourceIcon } from "../icons";
import { resourceIssues } from "../issues";
import { useStudio } from "../studio";
import { openEnvironmentVariable } from "../environment-variable-link";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { Description } from "./Description";
import { EntityName } from "./EntityName";
import { InputGroupEntries } from "./InputGroup";
import {
  EnvironmentName,
  FormGroup,
  InspectorFact,
  InspectorFacts,
  InspectorKind,
  InspectorSection,
} from "./InspectorUI";
import { IssueNotice } from "./IssueNotice";
import { LocalValue } from "./LocalValue";
import { OwnershipStatus } from "./ResourceStatus";
import { Ownership } from "./Ownership";
import { InputAllowedValues } from "./InputAllowedValues";
import { InputBehaviorFields } from "./InputBehaviorFields";

const MODES = ["dev", "prod"] as const;
const file = (mode: Mode) => `cdk-app/.env.${mode}`;
const pills = (modes: Readonly<Record<Mode, boolean>>) => ({
  availability: modes,
  descriptions: {
    dev: `read from ${file("dev")}`,
    prod: `read from ${file("prod")}`,
  },
  unavailableDescription: "not read",
});

/** Links to the inspectors that edit these values: the files themselves. */
function FileLinks({ modes, name }: { readonly modes: readonly Mode[]; readonly name?: string }) {
  const { select } = useStudio();
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-graphite">
      Edit values in
      {modes.map((mode) => (
        <button
          key={mode}
          className={cx(buttonClasses({ variant: "link" }), "text-caption")}
          aria-label={`Edit ${file(mode)} values`}
          onClick={() => openEnvironmentVariable(select, mode, name)}
        >
          {file(mode)}
        </button>
      ))}
    </p>
  );
}

/**
 * A framework-managed input group: the variables one reader takes from the CDK inputs files. It
 * holds exactly what the framework reads, so nothing is added here; each entry's value is a file line.
 */
export function FrameworkInputGroupView({
  resource,
}: {
  readonly resource: ModelResource;
}) {
  const { model } = useStudio();
  const group = FRAMEWORK_INPUT_GROUPS[resource.frameworkInput!];
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={pills({
            dev: group.modes.includes("dev"),
            prod: group.modes.includes("prod"),
          })}
        >
          Framework input group
        </InspectorKind>
        <EntityName
          entity={resource.id}
          fallback={group.title}
          icon="group"
        />
        <OwnershipStatus entity={resource.id} />
        <IssueNotice issues={resourceIssues(resource, model.resources)} />
      </header>
      <Description entity={resource.id} />
      <Ownership entity={resource.id} />
      <InspectorSection
        title="Read by"
        contentClassName="grid gap-2"
        data-slot="framework-input-reader"
      >
        <p className={inspectorNoteClasses}>
          Read by {group.reader} from {group.modes.map(file).join(" and ")}.
          Open an input to view its behavior and edit its local value.
        </p>
        {group.rule ? <p className={inspectorNoteClasses}>{group.rule}</p> : null}
        <FileLinks modes={group.modes} />
      </InspectorSection>
      <InputGroupEntries group={resource} />
    </>
  );
}

export function FrameworkInputView({
  resource,
}: {
  readonly resource: ModelResource;
}) {
  const { model, mode, snapshot, select, draft, draftState, live } = useStudio();
  const group = FRAMEWORK_INPUT_GROUPS[resource.frameworkInput!];
  const modes = {
    dev: !!resource.modes?.dev.present,
    prod: !!resource.modes?.prod.present,
  };
  const [details, setDetails] = useState<ResourceDetails>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const help = useId();
  const form = draft.resourceForm(resource);
  const owner = model.ownership?.[resource.id];
  const signIn = resource.frameworkInput === "authentication";
  const policy = signIn ? { policy: true, availability: true, fallback: resource.kind !== "secret" } : resource.inputChoices;
  const editable = policy?.policy && (!owner || owner.managedBy === "developer") ? policy : undefined;
  const entry = draftState.entries.find(item => item.kind === "resource" && item.intent.resource === resource.id);
  const environmentPending = draftState.entries.some(item => item.kind === "environment");
  const disabled = sourceEditBlocked({ draftState, draft, model, live }) || live.running !== null || environmentPending;
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setError(undefined);
    if (!resource.absent && !model.stale)
      void api
        .resourceDetails(resource.id, mode, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setDetails(value);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not load this input.",
            );
        });
    return () => controller.abort();
  }, [resource, snapshot.revision, mode, model.stale, reload]);
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind environments={pills(modes)}>
          {resource.kind === "secret" || resource.inputChoices?.sensitive ? "Framework secret" : "Framework input"}
        </InspectorKind>
        <EntityName
          entity={resource.id}
          fallback={resource.path.at(-1)!}
          icon={resourceIcon(resource)}
          reference={resource.fromEnv}
        />
        {/* Ownership sits directly below the identity, as in every resource family's inspector. */}
        <OwnershipStatus entity={resource.id} />
        <InspectorFacts>
          <InspectorFact label="Input group">
            <button
              className={buttonClasses({ variant: "link", className: "wrap-anywhere" })}
              onClick={() => select(resource.parent!)}
            >
              {group.title}
            </button>
          </InspectorFact>
        </InspectorFacts>
        <IssueNotice issues={resourceIssues(resource, model.resources)} />
      </header>
      <Description entity={resource.id} />
      <Ownership entity={resource.id} />
      <section
        className={inspectorSectionClasses}
        aria-label="Input settings"
        data-slot="framework-input-behavior"
      >
        {editable ? (
          <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
            <FormGroup title="Input behavior" appearance="plain">
              <InputBehaviorFields modes={form.modes} linked choices={form.choices ?? []}
                showDefault={!!editable.fallback} descriptionId={help}
                availability={editable.availability ? group.modes : []}
                onChange={(environment, change) => draft.setResource(resource, {
                  ...form, modes: { ...form.modes, [environment]: { ...form.modes[environment], ...change } },
                })} />
              <p id={help} className={cx(inspectorNoteClasses, "mt-2")}>
                {group.modes.length === 1 ? `Read by ${group.reader} in ${group.modes[0] === "dev" ? "development" : "production"} only. ` : ""}
                {editable.availability ? "Availability controls whether the reader uses this input. " : "The reader sets availability. "}
                {editable.fallback || resource.inputChoices?.privateFallback ? "The default applies when the file leaves the value blank." : "Set its value in the environment file."}
                {signIn ? " The provider needs all of its inputs to be available and set." : ""}
              </p>
            </FormGroup>
          </fieldset>
        ) : (
          <>
            <h3 className="mt-0 mb-3 text-label font-semibold">Input behavior</h3>
            <div
              className="grid grid-cols-2 gap-2 inspector-360:grid-cols-1"
              data-slot="input-modes"
            >
              {MODES.map((environment) => {
                const policy = resource.modes?.[environment];
                const present = !!policy?.present;
                return (
                  <div
                    key={environment}
                    className={environmentCardClasses({
                      mode: environment,
                      active: present,
                    })}
                    data-slot="input-mode"
                    data-mode={environment}
                  >
                    <EnvironmentName mode={environment} active={present} />
                    <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption text-ink">
                      <dt className="text-graphite">Available</dt>
                      <dd className="m-0">{present ? "Yes" : "No"}</dd>
                      <dt className="text-graphite">Required</dt>
                      <dd className="m-0">{policy?.required ? "Yes" : "No"}</dd>
                      <dt className="text-graphite">Default</dt>
                      <dd className="m-0">{policy?.default ?? "None"}</dd>
                    </dl>
                  </div>
                );
              })}
            </div>
            <p className={cx(inspectorNoteClasses, "mt-2")}>Behavior follows {group.reader}.</p>
            {resource.frameworkInput === "database" && snapshot.models.prod.managedDatabase ? (
              <button className={buttonClasses({ variant: "link" })}
                onClick={() => select(snapshot.models.prod.managedDatabase!.resource)}>
                Configure production database settings
              </button>
            ) : null}
          </>
        )}
        {environmentPending && editable ? (
          <p className={cx(inspectorNoteClasses, "mt-2")}>Apply or discard local value changes before editing input settings.</p>
        ) : null}
        {resource.note ? (
          <p className="mt-3 mb-0 text-caption">{resource.note}</p>
        ) : null}
        {mode === "dev" && !resource.absent && resource.inputChoices?.privateFallback ? (
          <LocalValue resource={resource} details={details} error={error} busy={!!draftState.busy}
            onRetry={() => setReload(value => value + 1)} privateDefault />
        ) : null}
        {entry?.error ? <p className="mb-0 mt-2 text-refuse wrap-anywhere" role="alert">{entry.error}</p> : null}
      </section>
      <InputAllowedValues resource={resource} />
      {resource.absent ? (
        <section className={inspectorSectionClasses} aria-label="Local value">
          <p className="m-0 text-caption text-graphite">
            Not read in {mode === "dev" ? "Development" : "Production"}.
          </p>
          {MODES.some(environment => modes[environment]) ? <FileLinks
            modes={MODES.filter((environment) => modes[environment])}
            name={resource.fromEnv}
          /> : null}
        </section>
      ) : (
        <LocalValue
          resource={resource}
          details={details}
          error={error}
          busy={!!draftState.busy}
          onRetry={() => setReload((value) => value + 1)}
        />
      )}
    </>
  );
}

import { useId } from "react";
import type { Mode, ModelTarget } from "../../shared/model";
import { requirementPolicy, type RequirementPolicy } from "../../shared/resources";
import { sourceEditBlocked } from "../editing-state";
import { environmentCardClasses } from "../inspector-ui";
import { displayName } from "../naming";
import { useStudio } from "../studio";
import { Select } from "../ui/FormControls";
import { EnvironmentPills } from "./DeploymentBadge";
import { EnvironmentName, InspectorSummary } from "./InspectorUI";

const MODES = ["dev", "prod"] as const;
const NAMES = { dev: "Development", prod: "Production" } as const;

/** The requirement belongs beside the workload's input mapping, with one policy per graph. */
export function InputRequirementControls({ target, resourceId }: { readonly target: ModelTarget; readonly resourceId: string }) {
  const { model, snapshot, draft, draftState, live } = useStudio();
  const id = useId();
  const resource = model.resources.find(resource => resource.id === resourceId)
    ?? snapshot.models.dev.resources.find(resource => resource.id === resourceId)
    ?? snapshot.models.prod.resources.find(resource => resource.id === resourceId);
  if (!resource || !["input", "secret"].includes(resource.kind) || !resource.fromEnv || resource.frameworkInput) return null;
  const form = draft.resourceForm(resource);
  const name = displayName(model, resource.id, resource.path.join("."));
  const pendingValues = draftState.entries.some(entry => entry.kind === "environment");
  const disabled = sourceEditBlocked({ model, draft, draftState, live }) || live.running !== null || pendingValues;
  const settings = (mode: Mode) => {
    const graph = snapshot.models[mode];
    const workload = graph.targets.find(item => item.ref === target.ref);
    const own = (workload?.authoredRequirementRules ?? workload?.requirementRules ?? []).filter(rule => rule.require.includes(resource.id));
    const saved = own.some(rule => !rule.when) ? "required" : own.length ? "conditional" : "optional";
    const inherited = form.modes[mode].required;
    const staged = requirementPolicy(form.requirements[target.ref], mode);
    const present = form.modes[mode].present && !!workload;
    const policy = inherited ? "required" : staged ?? saved;
    const active = !!workload && (mode === "dev" ? workload.lanes.local || workload.lanes.dev : workload.lanes.prod);
    const missing = active && graph.edges.some(edge => edge.from === target.ref && edge.to === resource.id && edge.inputRequirement?.status === "missing");
    const summary = !present ? "Input unavailable" : inherited ? "Required by the input" : policy === "conditional" ? "Conditionally required" : policy === "required" ? "Required" : "Optional";
    return { own, saved, inherited, staged, present, policy, summary, missing: missing && !staged };
  };
  const modes = { dev: settings("dev"), prod: settings("prod") };
  const change = (mode: Mode, value: string) => {
    const requirements = { ...form.requirements };
    const policies: Partial<Record<Mode, RequirementPolicy>> = {};
    for (const environment of MODES) {
      const existing = requirementPolicy(requirements[target.ref], environment);
      if (existing) policies[environment] = existing;
    }
    if (value === modes[mode].saved) delete policies[mode];
    else if (value === "required" || value === "optional") policies[mode] = value;
    if (Object.keys(policies).length) requirements[target.ref] = policies;
    else delete requirements[target.ref];
    draft.setResource(resource, { ...form, requirements });
  };
  return (
    <details className="w-full min-w-0" data-slot="input-requirement-controls" data-resource={resourceId}>
      <InspectorSummary className="flex min-w-0 cursor-pointer items-center gap-2 py-1 text-caption">
        <span className="flex-1 text-graphite">{modes.dev.summary === modes.prod.summary ? modes.dev.summary : "Requirement"}</span>
        {form.requirements[target.ref] ? <span className="text-meta text-graphite">Edited</span> : null}
        <EnvironmentPills
          label={`${name} requirements`}
          availability={{ dev: modes.dev.present && modes.dev.policy !== "optional", prod: modes.prod.present && modes.prod.policy !== "optional" }}
          attention={{ dev: modes.dev.missing, prod: modes.prod.missing }}
          descriptions={{ dev: `${modes.dev.summary}${modes.dev.missing ? ": value missing" : ""}`, prod: `${modes.prod.summary}${modes.prod.missing ? ": value missing" : ""}` }}
          unavailableDescription={{ dev: modes.dev.summary, prod: modes.prod.summary }}
        />
      </InspectorSummary>
      <fieldset disabled={disabled} className="m-0 grid min-w-0 gap-2 border-0 px-0 pt-2 pb-0" aria-label={`${name} requirements`} aria-describedby={`${id}-help`}>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          {MODES.map(mode => {
            const current = modes[mode];
            return (
              <div key={mode} className={environmentCardClasses({ mode, active: current.present })}>
                <EnvironmentName mode={mode} active={current.present} />
                <Select className="w-full" aria-label={`${name} requirement in ${NAMES[mode]}`} value={current.present ? current.policy : "unavailable"}
                  disabled={!current.present || current.inherited || snapshot.models[mode].stale} onChange={event => change(mode, event.target.value)}>
                  {!current.present ? <option value="unavailable">Unavailable</option> : null}
                  {current.saved === "conditional" && !current.inherited ? <option value="conditional">Conditionally required</option> : null}
                  <option value="required">{current.inherited ? "Required by input" : "Required"}</option>
                  {!current.inherited ? <option value="optional">Optional</option> : null}
                </Select>
                {current.policy === "conditional" ? <p className="m-0 text-caption text-graphite wrap-anywhere">{current.own.map(rule => `When ${displayName(snapshot.models[mode], rule.when!.resource, rule.when!.resource.slice("resource:".length))} equals ${JSON.stringify(rule.when!.equals)}.`).join(" ")}</p> : null}
                {current.missing ? <p className="m-0 text-caption text-refuse">Required value missing.</p> : null}
              </div>
            );
          })}
        </div>
        <p className="m-0 text-caption text-graphite" id={`${id}-help`}>{pendingValues
          ? "Apply or discard the pending environment values before changing requirements."
          : "Required inputs need a value or default when this workload runs in that environment. An input marked required applies to every consumer."}</p>
      </fieldset>
    </details>
  );
}

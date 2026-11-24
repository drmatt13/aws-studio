import { useState } from "react";
import { OWNER_LABELS, ownershipConsequence, ownershipOf, ownershipReason } from "../../shared/framework-management";
import type { OwnershipFacts } from "../../shared/model";
import { titleOf } from "../lookup";
import { useStudio } from "../studio";
import { buttonClasses } from "../ui/Button";
import { InspectorDisclosure } from "./InspectorUI";

type Value = "framework" | "developer";

/** Which transitions an entity's own declaration can record; none for inherited or undeclared ones. */
function transitions(facts: OwnershipFacts, kind: string | undefined): readonly Value[] {
  if (kind === "member" || facts.basis === "inherited" || facts.basis === "undeclared") return [];
  if (facts.basis === "entries" && kind !== "group") return [];
  if (facts.managedBy === "unresolved") return ["developer", "framework"];
  return [facts.managedBy === "framework" ? "developer" : "framework"];
}

const ACTION: Readonly<Record<Value, string>> = { developer: "Take ownership", framework: "Hand to the platform" };

/**
 * Ownership in the Inspector: who maintains the definition, how that was established, what
 * Studio may change as a result, and the framework integrations it takes part in. Changing
 * the owner is an explicit transition, reviewed on its own; the server enforces the result.
 */
export function Ownership({ entity }: { readonly entity: string }) {
  const { model, index, draft, draftState, live, select } = useStudio();
  const [confirming, setConfirming] = useState<Value>();
  const facts = ownershipOf(model, entity);
  const resource = index.resources.get(entity);
  // A transition writes beside the declaration's tags, so only declarations with a tag site can record one.
  const writable = (id: string) => !!model.tagging?.[id];
  const options = (resource?.kind === "group" ? [...index.resources.values()].filter((item) => item.parent === entity).every((item) => writable(item.id)) : writable(entity)) ? transitions(facts, resource?.kind) : [];
  const staged = draftState.entries.find((entry) => entry.kind === "ownership" && entry.entity === entity);
  const stagedValue = draft.stagedOwnership(entity);
  const others = draftState.entries.some((entry) => entry.kind !== "ownership");
  const disabled = !!draftState.busy || live.evaluating || !!model.stale || draft.conflict || others;
  const group = resource?.kind === "group";
  const entries = group ? [...index.resources.values()].filter((item) => item.parent === entity).length : 1;
  return (
    <InspectorDisclosure
      title="Ownership"
      status={staged ? (staged.error ? "invalid" : "modified") : undefined}
      data-slot="ownership"
    >
      <dl className="m-0 grid gap-2 text-caption leading-[1.5]">
        <div>
          <dt className="text-graphite">Maintained by</dt>
          <dd className="m-0 font-medium" data-slot="ownership-owner" data-owner={facts.managedBy}>{OWNER_LABELS[facts.managedBy]}</dd>
        </div>
        <div>
          <dt className="text-graphite">How Studio knows</dt>
          <dd className="m-0" data-slot="ownership-reason">
            {ownershipReason(facts, (id) => titleOf(index, id))}
            {facts.basis === "inherited" && facts.from ? (
              <>
                {" "}
                <button type="button" className={buttonClasses({ variant: "link" })} onClick={() => select(facts.from!)}>
                  Open {titleOf(index, facts.from)}
                </button>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-graphite">What Studio may change</dt>
          <dd className="m-0" data-slot="ownership-consequence">{ownershipConsequence(facts)}</dd>
        </div>
        {facts.integrations?.length ? (
          <div>
            <dt className="text-graphite">Framework integrations</dt>
            <dd className="m-0" data-slot="ownership-integrations">
              <ul className="m-0 grid gap-1 pl-4">
                {facts.integrations.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
      {stagedValue ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-rule-strong bg-sheet p-3 text-caption leading-[1.5]" data-slot="ownership-staged">
          <span className="grow">
            Staged for its own review: {OWNER_LABELS[facts.managedBy]} → {OWNER_LABELS[stagedValue]}.
          </span>
          <button type="button" className={buttonClasses({ variant: "quiet", size: "compact" })} disabled={!!draftState.busy} onClick={() => draft.stageOwnership(entity, undefined)}>
            Withdraw
          </button>
        </div>
      ) : options.length ? (
        confirming ? (
          <div className="mt-3 grid gap-2 rounded-md border border-rule-strong bg-sheet p-3 text-caption leading-[1.5]" data-slot="ownership-transition">
            <p className="m-0 font-medium">{ACTION[confirming]}: {OWNER_LABELS[facts.managedBy]} → {OWNER_LABELS[confirming]}</p>
            <p className="m-0">
              The review writes <code>managedBy: "{confirming}"</code> on {group ? `each of this group's ${entries} entries` : "its declaration"} and
              changes nothing else. Afterwards: {ownershipConsequence({ managedBy: confirming, basis: "declared" })}
            </p>
            {facts.integrations?.length ? (
              <p className="m-0">
                Framework integrations do not change with ownership. Keep their contracts when you edit it:{" "}
                {facts.integrations.join(" ")}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button type="button" className={buttonClasses({ variant: "primary", size: "compact" })} disabled={disabled} onClick={() => { draft.stageOwnership(entity, confirming); setConfirming(undefined); }}>
                Stage for review
              </button>
              <button type="button" className={buttonClasses({ variant: "quiet", size: "compact" })} onClick={() => setConfirming(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2" data-slot="ownership-actions">
            {options.map((value) => (
              <button key={value} type="button" className={buttonClasses({ size: "compact" })} disabled={disabled} onClick={() => setConfirming(value)}>
                {facts.managedBy === "unresolved" ? `Record ${OWNER_LABELS[value].toLowerCase()} as owner…` : `${ACTION[value]}…`}
              </button>
            ))}
            {others ? <span className="text-caption text-graphite">An ownership change is reviewed on its own. Apply or discard the other staged changes first.</span> : null}
          </div>
        )
      ) : null}
    </InspectorDisclosure>
  );
}

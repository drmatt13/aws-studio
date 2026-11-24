import { gatewaysOf, type ModelGateway } from "../../shared/gateways";
import {
  InspectorCount,
  InspectorSummary,
  InspectorKind,
} from "./InspectorUI";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { DeployControl } from "./DeployControl";
import { useMemo, type ComponentProps, type ReactNode } from "react";
import type { EnvironmentPills } from "./DeploymentBadge";
import type { Mode, ModelResource, ModelRoute, ModelTarget } from "../../shared/model";
import {
  catalogAvailability,
  environments,
  previewDeploymentLanes,
  type Availability,
} from "../deployment";
import { useStudio } from "../studio";
import { indexModel } from "../lookup";
import { hoverEnvironmentDescriptions, nodeHoverFacts, targetEnvironmentPlace } from "../scene/hover";
import { isFrameworkManaged } from "../../shared/framework-management";

/** Inspector summaries use the same per-environment facts as map hover cards. */
export function useHoverEnvironments(entity: Parameters<typeof nodeHoverFacts>[0]["entity"], id: string) {
  const { snapshot } = useStudio();
  const indexes = useMemo(() => ({ dev: indexModel(snapshot.models.dev), prod: indexModel(snapshot.models.prod) }), [snapshot.models]);
  const facts = nodeHoverFacts({ entity, id }, indexes);
  const descriptions = hoverEnvironmentDescriptions(facts);
  return {
    availability: { dev: facts.places.some(place => place.env === "dev"), prod: facts.places.some(place => place.env === "prod") },
    descriptions,
    unavailableDescription: descriptions,
  };
}

/** AgentCore gateways have an independent, draft-aware deployment setting. */
export function useGatewayEnvironments(gateway: Extract<ModelGateway, { protocol: "agentcore" }>) {
  const { snapshot, draft } = useStudio();
  const hover = useHoverEnvironments("gateway", gateway.id);
  const value = draft.gatewayDeploy(gateway.id);
  const places = (["dev", "prod"] as const).map(mode => {
    const graph = snapshot.models[mode];
    const saved = gatewaysOf(graph).find(item => item.id === gateway.id);
    const lanes = saved && typeof value === "string"
      ? previewDeploymentLanes({ lanes: saved.lanes, role: "agent" }, value, graph.deployChoices?.agent)
      : saved?.lanes;
    const local = mode === "dev" && lanes?.local;
    const cloud = mode === "dev" ? lanes?.dev : lanes?.prod;
    return [mode, { enabled: !!local || !!cloud, description: [local ? "Your machine" : undefined, cloud ? "AgentCore Gateway" : undefined].filter(Boolean).join(" + ") || "Not deployed" }] as const;
  });
  const result = Object.fromEntries(places) as Record<Mode, { enabled: boolean; description: string }>;
  return { ...hover, availability: { dev: result.dev.enabled, prod: result.prod.enabled }, descriptions: { dev: result.dev.description, prod: result.prod.description }, unavailableDescription: { dev: result.dev.description, prod: result.prod.description } };
}

/** The map's workload location, including staged Deploy changes. */
export function useTargetEnvironments(target: ModelTarget, route?: ModelRoute): {
  readonly availability: Availability;
  readonly locations: Readonly<Record<Mode, string>>;
} {
  const { snapshot, model, draft, draftState } = useStudio();
  const fact = model.fields[target.ref]?.find((fact) => fact.field === "deploy");
  const changed = fact && draft.field(target.ref, fact);
  const lanes = (mode: Mode) => {
    const graph = snapshot.models[mode];
    const saved = graph.targets.find((item) => item.ref === target.ref);
    if (!saved) return { ...target.lanes, local: false, dev: false, prod: false };
    const deployment = draftState.entries.find(
      (entry) =>
        entry.kind === "operation" &&
        entry.operation.kind === "deploy" &&
        entry.operation.target === target.ref,
    );
    if (
      target.role === "tool" &&
      deployment?.kind === "operation" &&
      deployment.operation.kind === "deploy" &&
      deployment.operation.value === "inherit"
    ) {
      const consumers = gatewaysOf(graph).filter(item => item.protocol === "agentcore" && item.tools.includes(target.id));
      return {
        ...saved.lanes,
        local: consumers.some((item) => item.lanes.local),
        cloud: consumers.some((item) => item.lanes.cloud),
        dev: consumers.some((item) => item.lanes.dev),
        prod: consumers.some((item) => item.lanes.prod),
      };
    }
    if (
      deployment?.kind === "operation" &&
      deployment.operation.kind === "deploy" &&
      typeof deployment.operation.value === "string"
    )
      return previewDeploymentLanes(
        saved,
        deployment.operation.value === "inherit" ? "both" : deployment.operation.value,
        graph.deployChoices?.[target.role],
      );
    return changed && !changed.error && fact
      ? previewDeploymentLanes(
          saved,
          String(draft.effective(target.ref, fact)),
          graph.deployChoices?.[target.role],
        )
      : saved.lanes;
  };
  const location = (mode: Mode) => {
    const saved = snapshot.models[mode].targets.find(item => item.ref === target.ref) ?? target;
    const place = targetEnvironmentPlace({ ...saved, lanes: lanes(mode) }, mode, route);
    return "where" in place ? place.where : place.reason;
  };
  return {
    availability: { dev: environments(lanes("dev")).dev, prod: lanes("prod").prod },
    locations: { dev: location("dev"), prod: location("prod") },
  };
}

/** A route shares its workload's draft-aware environment summary. */
export function TargetKind({
  target,
  route,
  children,
}: {
  readonly target: ModelTarget;
  readonly route?: ModelRoute;
  readonly children: ReactNode;
}) {
  const { availability, locations } = useTargetEnvironments(target, route);
  return (
    <InspectorKind
      environments={{
        availability,
        descriptions: locations,
        unavailableDescription: "not enabled",
      }}
    >
      {children}
    </InspectorKind>
  );
}

export function TargetDeploymentControls({
  target,
  route = false,
}: {
  readonly target: ModelTarget;
  readonly route?: boolean;
}) {
  const { model, select } = useStudio();
  return (
    <div className="grid min-w-0 gap-4" data-slot="deployment-controls">
      <DeployControl target={target} />
      {route ? (
        <p className="m-0 wrap-anywhere text-caption text-graphite" data-slot="deployment-note">
          Shared with{" "}
          <button className={buttonClasses({ variant: "link" })} onClick={() => select(target.ref)}>
            {target.title}
          </button>
          .
        </p>
      ) : null}
      {target.role === "event" ? (
        <p className="m-0 wrap-anywhere text-caption text-graphite" data-slot="deployment-note">
          Enabled cloud lanes include native AWS triggers. Local-only execution requires a local
          caller; AWS triggers are omitted.
        </p>
      ) : null}
      {target.role === "tool" && target.lanes.origin === "derived" ? (
        <p className="m-0 wrap-anywhere text-caption text-graphite" data-slot="deployment-note">
          {target.lanes.derivedFrom?.length ? (
            <>
              Inherits from{" "}
              {target.lanes.derivedFrom.map((ref, index) => (
                <span key={ref}>
                  {index ? ", " : ""}
                  <button
                    className={buttonClasses({ variant: "link" })}
                    onClick={() => select(ref)}
                  >
                    {model.targets.find((item) => item.ref === ref)?.title ?? gatewaysOf(model).find(item => item.id === ref)?.title ?? ref}
                  </button>
                </span>
              ))}
              . Set Deploy to override.
            </>
          ) : (
            "No gateway exposes this tool. Set Deploy to enable it independently."
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Child infrastructure follows its owner; never offers an ineffective flag. */
export function DeploymentOwnership({
  reason,
  owners = [],
}: {
  readonly reason?: string;
  readonly owners?: readonly { readonly id: string; readonly title: string }[];
}) {
  const { select } = useStudio();
  return (
    <div className="grid min-w-0 gap-3" data-slot="deployment-ownership">
      {reason ? <p className="m-0 wrap-anywhere text-caption text-graphite" data-slot="deployment-note">{reason}</p> : null}
      {owners.length > 3 ? (
        <details>
          <InspectorSummary className="text-graphite text-caption [[open]>&]:mb-2">
            Configure owners<InspectorCount className="ml-1.5">{owners.length}</InspectorCount>
          </InspectorSummary>
          <div className="flex flex-wrap gap-2" data-slot="deployment-owners">
            {owners.map((owner) => (
              <button
                key={owner.id}
                className={cx(
                  buttonClasses({ variant: "quiet" }),
                  "max-w-full whitespace-normal text-left wrap-anywhere text-caption",
                )}
                onClick={() => select(owner.id)}
              >
                Configure {owner.title}
              </button>
            ))}
          </div>
        </details>
      ) : owners.length ? (
        <div className="flex flex-wrap gap-2" data-slot="deployment-owners">
          {owners.map((owner) => (
            <button
              key={owner.id}
              className={cx(
                buttonClasses({ variant: "quiet" }),
                "max-w-full whitespace-normal text-left wrap-anywhere text-caption",
              )}
              onClick={() => select(owner.id)}
            >
              Configure {owner.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Catalog availability, except that a stack the CDK app never constructs is deployed nowhere, as its hover card says. */
export function resourceAvailability(
  resource: ModelResource,
  models: Parameters<typeof catalogAvailability>[0],
): Availability {
  if (resource.stackUsage?.status === "unreferenced") return { dev: false, prod: false };
  return catalogAvailability(models)[resource.id] ?? { dev: false, prod: false };
}

export function useResourceEnvironments(resource: ModelResource): ComponentProps<typeof EnvironmentPills> {
  const { snapshot, model } = useStudio();
  const hover = useHoverEnvironments("resource", resource.id);
  if (resource.kind === "group") {
    const entries = [...new Map(Object.values(snapshot.models).flatMap(graph => graph.resources)
      .filter(entry => entry.parent === resource.id).map(entry => [entry.id, entry])).values()];
    const availability = catalogAvailability(snapshot.models);
    const counts = { dev: entries.filter(entry => availability[entry.id]?.dev).length, prod: entries.filter(entry => availability[entry.id]?.prod).length };
    const summaries = { dev: `${counts.dev} of ${entries.length} entries declared`, prod: `${counts.prod} of ${entries.length} entries declared` };
    return { availability: { dev: counts.dev > 0, prod: counts.prod > 0 }, descriptions: summaries, unavailableDescription: summaries, note: "Configure declaration environments on the individual entries." };
  }
  const availability = resourceAvailability(resource, snapshot.models);
  const parent =
    resource.kind === "member" && resource.parent
      ? model.resources.find((item) => item.id === resource.parent)
      : undefined;
  const consumers = model.targets.filter((target) =>
    model.edges.some(
      (edge) =>
        edge.from === target.ref &&
        (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`)),
    ),
  );
  const owners = parent
    ? [{ id: parent.id, title: parent.stackClass ?? parent.path.join(".") }]
    : consumers.map((target) => ({ id: target.ref, title: target.title }));
  const declaration = resource.kind === "input" || resource.kind === "secret";
  return {
    availability,
    descriptions: hover.descriptions,
    unavailableDescription: hover.unavailableDescription,
    label: declaration ? "Declaration environments" : "Resource environments",
    note: declaration ? undefined :
          parent
            ? "This member is created with its owning stack."
            : resource.frameworkStack || isFrameworkManaged(model, resource.id)
              ? "The framework builds this infrastructure. Its consumers control their own deployment; this resource has no independent workload flag."
              : "Native CDK controls stack construction. Catalog availability does not deploy a stack; review its owning CDK declaration before changing its lifecycle.",
    details: !declaration && owners.length ? <DeploymentOwnership owners={owners} /> : undefined,
  };
}

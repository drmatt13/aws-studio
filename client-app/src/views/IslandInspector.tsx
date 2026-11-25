import { inspectorSectionClasses, inspectorHeaderClasses } from "../inspector-ui";

import { EntityIcon } from "./EntityIcon";
import { EntityName } from "./EntityName";
import { buttonClasses } from "../ui/Button";
import { NetworkControls } from "./NetworkControls";
import { VpcPrivateZones } from "./PrivateZones";
import { useMemo } from "react";
import { catalogAvailability, environments } from "../deployment";
import type { Mode } from "../../shared/model";
import { buildScene } from "../scene/build";
import { useStudio } from "../studio";
import { InspectorDisclosure, InspectorKind, InspectorResourceRow, InspectorSection } from "./InspectorUI";
import { SharedDefaults } from "./SharedDefaults";
import { IssueChips, OwnershipStatus, ResourceStatus } from "./ResourceStatus";
import { Ownership } from "./Ownership";
import { RouteStatus } from "./RouteStatus";
import { Description } from "./Description";
import {
  CLIENT_ENVIRONMENT_ISLAND,
  CDK_ENVIRONMENT_ISLAND,
} from "../../shared/client-environment";
import { Tags } from "./Tags";
import { DeploymentOwnership, resourceAvailability } from "./Deployment";

const LAMBDAS = ["lambda", "http", "webSocket", "events", "tools"];
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "island:lambda": [...LAMBDAS, "container"],
  "island:agentcore": ["tools"],
};

/** Island membership comes from the same layout as the canvas, never a second graph. */
export function IslandInspector({ id }: { readonly id: string }) {
  const { model, snapshot, select, index, mode, draft, draftState, live } = useStudio();
  const scene = useMemo(
    () =>
      buildScene(model, {
        resourceAvailability: catalogAvailability(snapshot.models),
        conditions: Object.fromEntries(
          Object.entries(snapshot.source.catalog).map(([key, value]) => [key, value.condition]),
        ),
      }),
    [model, snapshot.models, snapshot.source.catalog],
  );
  const island = scene.islands.find((island) => island.id === id);
  const members = scene.nodes.filter((node) => node.island === id);
  const groups = GROUPS[id] ?? [];
  const network = id.startsWith("island:vpc:");
  const enabledEntries = (mode: Mode) => members.filter(node => {
    const graph = snapshot.models[mode];
    const target = graph.targets.find(target => target.ref === node.id);
    const gateway = graph.gateways?.find(gateway => gateway.id === node.id);
    const lanes = target?.lanes ?? gateway?.lanes;
    const resource = graph.resources.find(resource => resource.id === node.id);
    const local = graph.localServices?.find(service => service.id === node.id);
    return lanes ? environments(lanes)[mode] : resource ? resourceAvailability(resource, snapshot.models)[mode] : mode === "dev" && local?.enabled;
  }).length;
  const counts = { dev: enabledEntries("dev"), prod: enabledEntries("prod") };
  const availability = network
    ? {
        dev: false,
        prod: !!snapshot.models.prod.networks?.find((item) => id === `island:vpc:${item.id}`)
          ?.builtInProd,
      }
    : {
        dev: counts.dev > 0,
        prod: counts.prod > 0,
      };
  const summaries = network
    ? { dev: "not built · Local Compose networking is shared", prod: availability.prod ? "Enabled · In AWS" : "not built" }
    : { dev: `${counts.dev} of ${members.length} entries enabled`, prod: `${counts.prod} of ${members.length} entries enabled` };
  if (!island)
    return (
      <p className="mt-0 mb-2 px-6 py-10 text-graphite">
        This island has no entries in this environment.
      </p>
    );
  const entries = (
    <InspectorDisclosure title="Island entries" count={members.length}>
      <ul className="p-0 list-none m-0" data-slot="island-members">
        {members.map((node) => {
          const route = index.routes.get(node.id);
          const resource = index.resources.get(node.id);
          return (
            <InspectorResourceRow
              key={node.id}
              data-slot="island-member"
              icon={<EntityIcon size={26} icon={node.icon} />}
              title={
                <button
                  className={buttonClasses({ variant: "link" })}
                  onClick={() => select(node.id)}
                >
                  {resource?.clientEnvironment ? "client-app/.env" : node.label}
                </button>
              }
            >
              <span>{node.kindLabel}</span>
              <ResourceStatus resource={resource} placement="inline" />
              {/* A resource's issues are in its status; a workload's come from the same scene node. */}
              {!resource && node.issues ? <IssueChips issues={node.issues} placement="inline" /> : null}
              {route ? <RouteStatus route={route} placement="inline" /> : null}
            </InspectorResourceRow>
          );
        })}
      </ul>
    </InspectorDisclosure>
  );
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind environments={{
          availability,
          descriptions: summaries,
          unavailableDescription: summaries,
          note: network
            ? "Production creates this VPC when its database, native resources or enabled workloads require it. Configure those owners; local Compose networking remains shared."
            : "This island groups resources. Configure its entries individually.",
          details: <DeploymentOwnership owners={members
            .filter(node => model.targets.some(target => target.ref === node.id) || model.resources.some(resource => resource.id === node.id))
            .map(node => ({ id: node.id, title: node.label }))} />,
        }}>Island settings</InspectorKind>
        <EntityName entity={id} fallback={island.title} />
        {network ? <OwnershipStatus entity={id} /> : null}
        <p className="last:mb-0 mt-0 mb-0 text-caption text-graphite">
          {members.length} {members.length === 1 ? "entry" : "entries"}
        </p>
      </header>
      <Description entity={id} />
      <Tags entity={id} />
      {network ? <Ownership entity={id} /> : null}
      <NetworkControls id={id} />
      {network ? <VpcPrivateZones networkId={id.slice("island:vpc:".length)} /> : null}
      {id === "island:inputs" ? (
        <InspectorSection
          title="Add an input"
          description="Declare an input parameter or secret, then review the source changes. Environment values are configured separately."
        >
          <button
            className={buttonClasses({ variant: "quiet" })}
            disabled={
              !!draftState.busy ||
              live.evaluating ||
              Object.values(snapshot.models).some(
                (model) => model.stale || model.status === "error",
              )
            }
            onClick={() => draft.requestNavigation(() => draft.beginCreation("input"))}
          >
            Create input parameter or secret
          </button>
        </InspectorSection>
      ) : null}
      {groups.length ? (
        <SharedDefaults
          families={groups}
          note={
            id === "island:agentcore"
              ? "These defaults configure Lambda tools used by agents. AgentCore runtimes have individual settings."
              : undefined
          }
        />
      ) : id.startsWith("island:vpc:") ||
        id === CDK_ENVIRONMENT_ISLAND ||
        id === "island:apis" ||
        id === "island:inputs" ||
        id === "island:stacks" ||
        id === CLIENT_ENVIRONMENT_ISLAND ? null : (
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Settings</h3>
          <p className="mt-0 mb-2 text-caption">
            The framework has no shared defaults for this island. Select an entry below to configure
            it.
          </p>
        </section>
      )}
      {entries}
    </>
  );
}

import {
  inspectorSectionClasses,
  inspectorFactCodeClasses,
  inspectorHeaderClasses,
  inspectorIntroClasses,
  inspectorNoteClasses,
  inspectorRelationListClasses,
} from "../../inspector-ui";

import { isFrameworkManaged } from "../../../shared/framework-management";
import type { LocalDatabase } from "../../../shared/database";
import type { ModelResource } from "../../../shared/model";
import { resourceIcon } from "../../icons";
import { inputGroupOf } from "../../input-groups";

import { catalogReference, displayName } from "../../naming";
import { buildScene } from "../../scene/build";
import { hoverEnvironmentDescriptions, propHoverFacts } from "../../scene/hover";
import { useStudio } from "../../studio";
import { buttonClasses } from "../../ui/Button";
import { ClientEnvironmentFileView } from "../ClientEnvironment";
import { Description } from "../Description";
import {
  DeploymentOwnership,
  useHoverEnvironments,
  useResourceEnvironments,
} from "../Deployment";
import { EnvironmentFileView, InputSources } from "../DeploymentInputs";
import { EntityIcon } from "../EntityIcon";
import { EntityName } from "../EntityName";
import { InputGroupEntries, InputGroupSources, InputGroupTags, InputGroupUse } from "../InputGroup";
import {
  Identifier,
  InspectorDisclosure,
  InspectorFact,
  InspectorFacts,
  InspectorKind,
  InspectorResourceRow,
  InspectorSection,
  InspectorSummary,
} from "../InspectorUI";
import { ResourceEditor } from "../ResourceEditor";
import { ResourceLogs } from "../ResourceLogs";
import { StackExports } from "../StackExports";
import { OwnershipStatus, ResourceStatus } from "../ResourceStatus";
import { Ownership } from "../Ownership";
import { IssueNotice } from "../IssueNotice";
import { FrameworkInputGroupView, FrameworkInputView } from "../FrameworkInputs";
import { resourceIssues } from "../../issues";
import { SchemaLink } from "../SchemaDetails";
import { Tags } from "../Tags";
import { Triggers } from "../Triggers";
import { ResourceAccess } from "../WorkloadPermissions";
import { SourceLines, Written } from "../Written";
import { Relations } from "./InspectorRelations";

export function ResourceView(props: { readonly resource: ModelResource }) {
  const { snapshot, model, select, index, inspectorNavigation } = useStudio();
  const { resource } = props;
  const resourceEnvironments = useResourceEnvironments(resource);
  if (resource.clientEnvironment)
    return <ClientEnvironmentFileView key={resource.id} resource={resource} />;
  if (resource.deploymentFile || resource.deploymentFiles) return <EnvironmentFileView key={`${resource.id}:${inspectorNavigation.key}`} resource={resource} />;
  // Projected framework inputs use their owning readers' views and narrowly scoped source edits.
  if (resource.frameworkInput)
    return resource.kind === "group" ? (
      <FrameworkInputGroupView key={resource.id} resource={resource} />
    ) : (
      <FrameworkInputView key={resource.id} resource={resource} />
    );
  const members = model.resources.filter((item) => item.parent === resource.id);
  const nativeMembers = members.filter(member => member.nativeKind === "resource" || member.nativeKind === "secret");
  const owningStack = resource.parent ? index.resources.get(resource.parent) : undefined;
  const facts = snapshot.source.catalog[resource.id];
  const root = resource.path[0]!;
  const links = snapshot.source.links[resource.path.join(".")] ?? snapshot.source.links[root] ?? [];
  const managed = isFrameworkManaged(index, resource.id);
  const kind = resource.frameworkStack
    ? managed ? "Framework stack" : "CDK stack"
    : resource.kind === "stack"
      ? "Stack in the catalog"
      : resource.kind === "member"
        ? "Stack member"
        : resource.kind === "secret"
          ? "Authored secret"
          : resource.kind === "input"
            ? resource.fromEnv
              ? "Environment parameter"
              : "Source parameter"
            : resource.kind === "group"
              ? "Input group"
              : "Construct";
  const group = resource.kind === "group";
  const entity = snapshot.source.entities[resource.id];
  // An entry inside a group names it, as a stack field names its stack.
  const owningGroup =
    resource.kind === "input" || resource.kind === "secret"
      ? inputGroupOf(resource, index.resources)
      : undefined;
  const database = [snapshot.models.dev, snapshot.models.prod].some((model) =>
    model.edges.some(
      (edge) =>
        edge.relation === "database" &&
        (edge.to === resource.id || edge.to.startsWith(`${resource.id}.`)),
    ),
  );
  const manual = snapshot.source.cdkLinks.manualWiring.filter(
    (item) =>
      item.resource === resource.id ||
      item.resource.startsWith(`${resource.id}.`) ||
      item.resource === resource.parent,
  );
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind environments={resourceEnvironments}>
          {kind}
        </InspectorKind>
        <EntityName
          entity={resource.id}
          fallback={
            (resource.kind === "stack"
              ? (resource.stackClass ?? resource.path.join("."))
              : resource.path.at(-1))!
          }
          icon={resourceIcon(resource)}
          // Only an application catalog entry supplies a workload reference.
          reference={
            resource.kind !== "stack" || !resource.frameworkStack
              ? catalogReference(model, resource.id)
              : undefined
          }
        />
        <ResourceStatus resource={resource} issues={resource.kind === "stack"} />
        {/* A member's type and an entry's group are facts beside its source lines, in their column. */}
        {resource.typeText || owningGroup || owningStack?.kind === "stack" ? (
          <InspectorFacts>
            {resource.typeText ? (
              <InspectorFact label="Type">
                <code className={inspectorFactCodeClasses}>
                  <Identifier>{resource.typeText}</Identifier>
                </code>
              </InspectorFact>
            ) : null}
            {owningGroup ? (
              <InspectorFact label="Input group">
                <button
                  className={buttonClasses({ variant: "link", className: "wrap-anywhere" })}
                  onClick={() => select(owningGroup.id)}
                >
                  {displayName(model, owningGroup.id, owningGroup.path.join("."))}
                </button>
              </InspectorFact>
            ) : null}
            {owningStack?.kind === "stack" ? (
              <InspectorFact label="Stack">
                <button className={buttonClasses({ variant: "link" })} onClick={() => select(owningStack.id)}>
                  {displayName(model, owningStack.id, owningStack.stackClass ?? owningStack.path.join("."))}
                </button>
              </InspectorFact>
            ) : null}
          </InspectorFacts>
        ) : null}
        {/* Descriptors and groups retain both their definition and catalog registration. */}
        {entity?.value && entity.value.file !== entity.key.file ? (
          <SourceLines
            placement="header"
            lines={[
              { location: entity.value, label: group ? "Declared in" : "Defined in" },
              { location: entity.key, label: "Cataloged in" },
            ]}
          />
        ) : (
          <Written
            placement="header"
            location={entity?.key}
            label={resource.frameworkStack ? "Class in" : "Declared in"}
          />
        )}
        {/* Ownership and source explanations follow the identity lines. */}
        {resource.frameworkStack || resource.frameworkManaged ? (
          <details
            className="group/header-details mt-2 text-caption text-graphite"
            data-slot="header-details"
          >
            <InspectorSummary className="cursor-pointer">About this resource</InspectorSummary>
            <div className="mt-1 grid gap-2">
              {resource.frameworkStack ? (
                <p className={inspectorNoteClasses}>
                  To reference this stack's fields from a workload, add a{" "}
                  <code>stack&lt;{resource.stackClass}&gt;()</code> entry to{" "}
                  <code>framework-config/stacks/</code> and link it in the CDK application.
                </p>
              ) : null}
              {resource.frameworkManaged === "database" ? (
                <p className={inspectorNoteClasses}>
                  Its database declaration owns PostgreSQL policy and placement; the framework
                  supplies IAM-only workload connections.
                </p>
              ) : resource.frameworkManaged ? (
                <p className={inspectorNoteClasses}>
                  Studio maps this stack's public outputs to environment variables.
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
        <IssueNotice issues={resourceIssues(resource, index.resources.values())} />
      </header>
      <Description entity={resource.id} />
      {group ? <InputGroupTags group={resource} /> : <Tags entity={resource.id} />}
      <Ownership entity={resource.id} />
      {resource.kind === "stack" ? (
        <InspectorDisclosure title="Resources" count={nativeMembers.length} data-slot="stack-members">
          <p className={inspectorIntroClasses}>
            {nativeMembers.length ? "Public AWS resources exposed by this stack." : "No public AWS resource properties were discovered. Expose a resource as a public instance property in the stack class."}
          </p>
          {nativeMembers.length ? (
            <ul className={inspectorRelationListClasses} data-slot="stack-resources">
              {nativeMembers.map(member => (
                <InspectorResourceRow
                  key={member.id}
                  data-slot="stack-resource"
                  icon={<EntityIcon size={26} icon={resourceIcon(member)} />}
                  title={
                    <button className={buttonClasses({ variant: "link" })} onClick={() => select(member.id)} title={member.typeText}>
                      {displayName(model, member.id, member.path.at(-1)!)}
                    </button>
                  }
                />
              ))}
            </ul>
          ) : null}
        </InspectorDisclosure>
      ) : null}
      {owningStack?.frameworkStack ? (
        <InspectorSection title="Native resource">
          <p className={inspectorNoteClasses}>Expose this stack through <code>stack&lt;{owningStack.stackClass}&gt;()</code> and <code>linkResources</code> to author additional workload permissions. Existing framework connections are shown below.</p>
        </InspectorSection>
      ) : null}
      <ResourceLogs selected={resource.id} />
      {members.some((member) => member.id === model.managedDatabase?.resource) ? (
        <InspectorSection title="Application database">
          <button
            className={buttonClasses({ variant: "neutral" })}
            onClick={() => select(model.managedDatabase!.resource)}
          >
            Configure application PostgreSQL
          </button>
          <p className="mt-0 mb-2 text-caption text-graphite">
            One database declaration coordinates production RDS and local PostgreSQL.
          </p>
        </InspectorSection>
      ) : null}
      {resource.kind === "stack" ? <StackExports stack={resource} /> : null}
      {database ? (
        <section className={inspectorSectionClasses}>
          <SchemaLink />
          <p className="mt-0 mb-2 text-caption text-graphite">
            The application contract is shared with local PostgreSQL.
          </p>
        </section>
      ) : null}
      {resource.absent ||
      (resource.kind === "member" && resource.memberSource === "class") ||
      (facts?.stackClass && !resource.frameworkStack) ||
      (facts?.stackLocation && !resource.frameworkStack) ||
      links.length ? (
        <InspectorDisclosure title="Declaration details" contentClassName="text-caption">
          {resource.absent && resource.frameworkStack ? (
            <p className="mt-0 mb-2">
              Not enabled in the {model.mode === "dev" ? "development" : "production"} environment.
            </p>
          ) : resource.absent && group ? (
            <p className="mt-0 mb-2">
              Every entry in this group is declared undefined in the{" "}
              {model.mode === "dev" ? "development" : "production"} graph, so nothing that reads
              them sees a value.
            </p>
          ) : resource.absent && resource.modes ? (
            <p className="mt-0 mb-2">
              Declared <code>.only("{model.mode === "dev" ? "prod" : "dev"}")</code>, so the{" "}
              {model.mode === "dev" ? "development" : "production"} graph does not hold it. Anything
              that reads it there never sees a value.
            </p>
          ) : resource.absent ? (
            <p className="mt-0 mb-2">
              Absent in the {model.mode === "dev" ? "development" : "production"} graph
              {facts?.condition ? (
                <>
                  , because the catalog writes it under <code>{facts.condition}</code>
                </>
              ) : (
                ""
              )}
              . Anything that reads it never sees the value.
            </p>
          ) : null}
          {resource.kind === "member" && resource.memberSource === "class" ? (
            <p className="mt-0 mb-2 text-graphite">
              Declared by its stack; no workload references it.
            </p>
          ) : null}
          {facts?.stackClass && !resource.frameworkStack ? (
            <p className="mt-0 mb-2">
              The stack class {facts.stackClass} is the declaration: each public field is an entry.
            </p>
          ) : null}
          {(facts?.stackLocation && !resource.frameworkStack) || links.length ? (
            <SourceLines
              lines={[
                ...(facts?.stackLocation && !resource.frameworkStack
                  ? [{ location: facts.stackLocation, label: "Class in" }]
                  : []),
                ...links.map((link) => ({ location: link, label: "Linked in" })),
              ]}
            />
          ) : null}
        </InspectorDisclosure>
      ) : null}
      {group ? (
        <>
          <InputGroupEntries group={resource} />
          <InputGroupUse group={resource} />
          <InputGroupSources group={resource} />
        </>
      ) : null}
      <ResourceAccess key={`access:${resource.id}`} resource={resource} />
      {resource.kind === "member" ? <Triggers key={resource.id} resource={resource} /> : null}
      {manual.length ? (
        <section className={inspectorSectionClasses}>
          {manual.map((item) => (
            <div key={`${item.source.file}:${item.source.start}`}>
              <p className="mt-0 mb-2 text-caption text-graphite">{item.reason}</p>
              <Written location={item.source} label="Wiring in" />
            </div>
          ))}
        </section>
      ) : null}
      {resource.kind === "input" || resource.kind === "secret" ? (
        <ResourceEditor key={`${resource.id}:${model.mode}`} resource={resource} />
      ) : null}
      <InputSources resource={resource} />
      <Relations id={resource.id} />
    </>
  );
}

export function LocalDatabaseView({ database }: { readonly database: LocalDatabase }) {
  const environments = useHoverEnvironments("local", database.id);
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={{
            ...environments,
            note: "Configured in Docker Compose; start and stop this service through Deploy. Container health and running state are separate from source availability.",
          }}
        >
          Local development service
        </InspectorKind>
        <EntityName
          entity={database.id}
          fallback={database.title}
          icon="postgres"
          reference={`${database.service} · ${database.image}`}
        />
        <OwnershipStatus entity={database.id} />
        <Written placement="header" location={database.source} label="Declared in" />
      </header>
      <Description entity={database.id} />
      <ResourceLogs selected={database.id} />
      <section className={inspectorSectionClasses}>
        <SchemaLink />
        <p className="mt-0 mb-2 text-caption text-graphite">
          Shares the application contract with production RDS.
        </p>
      </section>
      {database.volumes.length ? (
        <section className={inspectorSectionClasses}>
          <h3 className="mt-0 mb-3 text-label font-semibold text-balance">Persistent storage</h3>
          {database.volumes.map((volume) => (
            <p className="mt-0 mb-2" key={volume}>
              <code>{volume}</code>
            </p>
          ))}
        </section>
      ) : null}
      <Relations id={database.id} />
    </>
  );
}

export function NetworkFixtureView({ id }: { readonly id: string }) {
  const { model, snapshot } = useStudio();
  const locations = hoverEnvironmentDescriptions(propHoverFacts(snapshot.models, id));
  const fixture = buildScene(model).props.find((prop) => prop.id === id);
  if (!fixture) return null;
  const production = snapshot.models.prod;
  const inProduction =
    !!production.networks?.find((network) => id.startsWith(`prop:vpc:${network.id}:`))
      ?.builtInProd && buildScene(production).props.some((prop) => prop.id === id);
  return (
    <>
      <header className={inspectorHeaderClasses}>
        <InspectorKind
          environments={{
            availability: { dev: false, prod: inProduction },
            descriptions: locations,
            unavailableDescription: locations,
            note: "This component is created by its production VPC. Configure the owning network instead of deploying the component independently.",
            details: <DeploymentOwnership owners={(model.networks ?? [])
              .filter(network => id.startsWith(`prop:vpc:${network.id}:`))
              .map(network => ({ id: `island:vpc:${network.id}`, title: network.name ?? network.id }))} />,
          }}
        >
          Network fixture
        </InspectorKind>
        <EntityName entity={id} fallback={fixture.label} icon={fixture.icon} reference={id} />
        <OwnershipStatus entity={id} />
        <Written
          placement="header"
          location={
            snapshot.source.entities[
              `island:vpc:${model.networks?.find((network) => id.startsWith(`prop:vpc:${network.id}:`))?.id}`
            ]?.value
          }
          label="Declared in"
        />
      </header>
      <Description entity={id} />
      <section className={inspectorSectionClasses}>
        {fixture.caption.map((line) => (
          <p className="mt-0 mb-2" key={line}>
            {line}
          </p>
        ))}
      </section>
    </>
  );
}

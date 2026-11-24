import { isCdkResource, isCdkResourceGroup, isFrameworkDatabase, isResourceReference, type FrameworkConfig, type ManagedBy, type NormalizedTarget } from "aws-studio/config";
import { CLIENT_ENVIRONMENT_ID } from "../../shared/client-environment";
import { FRAMEWORK_INPUT_GROUPS } from "../../shared/deployment-inputs";
import { networkFixtureIds } from "../../shared/descriptions";
import { gatewaysOf } from "../../shared/gateways";
import { AUTHENTICATION_STACK_FILE } from "../../shared/integrations";
import type { ModeModel, ModelResource, OwnershipFacts } from "../../shared/model";

/**
 * Entity ownership: who maintains each definition, from source declarations only.
 *
 * Rules, in order:
 *  1. Declared. An entity with its own declaration (workload, workflow, AgentCore gateway,
 *     defineNetwork, defineDatabase, stack<T>(), cdk<T>(), an input or secret) takes its
 *     `managedBy`; a declaration without one is developer owned, as the DSL defines it.
 *     How it is implemented, generated or deployed never changes this.
 *  2. Inherited from one structural owner: a stack member from its stack, a route from its
 *     workload, a VPC fixture from its VPC, a database setting override from the database.
 *  3. A group with no declaration of its own reports its entries' owner when they agree.
 *  4. Conflict. Declarations that disagree (between modes, or among a group's entries) are
 *     unresolved, with the evidence listed.
 *  5. Anything else is unresolved, with a note saying what defines it.
 *
 * Nothing here decides ownership from a class name, an entity kind, a catalog key, a file
 * location or a resource flag. Flags only choose the wording of an unresolved entity's note.
 * Integrations are reported beside ownership and never change it.
 */

const recorded = (managedBy: ManagedBy | undefined): OwnershipFacts => managedBy ? { managedBy, basis: "declared" } : { managedBy: "developer", basis: "default" };
const undeclared = (note: string): OwnershipFacts => ({ managedBy: "unresolved", basis: "undeclared", note });
const inherit = (from: string, facts: OwnershipFacts): OwnershipFacts => ({ managedBy: facts.managedBy, basis: "inherited", from });

/** Every declaration's ownership in one graph, keyed by canonical entity ID; absent `managedBy` included. */
export function projectDeclaredOwnership(config: FrameworkConfig, targets: readonly NormalizedTarget[]): Record<string, OwnershipFacts> {
  const result: Record<string, OwnershipFacts> = {};
  for (const target of targets) result[target.reference] = recorded(target.managedBy);
  for (const [id, gateway] of Object.entries(config.gateways ?? {})) result[`gateway:agentcore:${id}`] = recorded(gateway.managedBy);
  for (const network of config.networks ?? []) result[`island:vpc:${network.id}`] = recorded(network.managedBy);
  if (isFrameworkDatabase(config.database)) result[`database:${config.database.id}`] = recorded(config.database.managedBy);
  const visit = (group: Record<string, unknown>, prefix: readonly string[]): void => {
    for (const [name, entry] of Object.entries(group)) {
      const path = [...prefix, name];
      if (isCdkResourceGroup(entry) || isCdkResource(entry) || isResourceReference(entry)) {
        // The placeholder a graph holds for a declaration it leaves out is not that declaration.
        // Compare exactly: a stack group answers any other property name with a member reference.
        const declaration = entry as { readonly managedBy?: ManagedBy; readonly absent?: unknown };
        if (declaration.absent !== true) result[`resource:${path.join(".")}`] = recorded(declaration.managedBy);
      }
      // A plain object is a namespace, not a declaration: its owner comes from its entries.
      else if (entry && typeof entry === "object") visit(entry as Record<string, unknown>, path);
    }
  };
  visit((config.resources ?? {}) as Record<string, unknown>, []);
  return result;
}

/**
 * One record per entity across the graphs it is declared in. A declaration absent from one
 * graph (`PROD_DEPLOYMENT ? stack(...) : undefined`) keeps the other's. Graphs that disagree
 * leave the entity unresolved, listing what each says.
 */
export function mergeDeclaredOwnership(graphs: readonly (readonly [where: string, records: Readonly<Record<string, OwnershipFacts>> | undefined])[]): Record<string, OwnershipFacts> {
  const evidence = new Map<string, { where: string; facts: OwnershipFacts }[]>();
  for (const [where, records] of graphs) for (const [id, facts] of Object.entries(records ?? {})) {
    if (facts.basis !== "declared" && facts.basis !== "default") continue;
    evidence.set(id, [...(evidence.get(id) ?? []), { where, facts }]);
  }
  const merged: Record<string, OwnershipFacts> = {};
  for (const [id, items] of evidence) {
    const owners = new Set(items.map(item => item.facts.managedBy));
    merged[id] = owners.size === 1 ? items.find(item => item.facts.basis === "declared")?.facts ?? items[0]!.facts
      : { managedBy: "unresolved", basis: "conflict", conflicts: items.map(item => ({ where: item.where, managedBy: item.facts.managedBy })) };
  }
  return merged;
}

export interface OwnershipContext {
  /** Catalog stack entity ID to its class file, for integrations keyed by a fixed source path. */
  readonly stackFiles?: Readonly<Record<string, string>>;
}

function undeclaredNote(model: ModeModel, resource: ModelResource): string {
  if (resource.frameworkStack) return "Studio finds this stack only through the outputs it exports to the root .env (scripts/root-env-outputs.ts); no stack() declaration names it. Declare it in framework-config/stacks to give it an owner.";
  if (resource.deploymentFile || resource.deploymentFiles) return "A private CDK inputs file. Its values are configuration you supply; no declaration names an owner for the file itself.";
  if (resource.id === CLIENT_ENVIRONMENT_ID) return "Defined by the mappings in framework-config/client-environment.ts, which carry no ownership declaration. The mappings stay editable as configuration.";
  if (resource.kind === "group") return "A group with no declaration of its own and no entries.";
  return `No declaration or structural owner was found in the ${model.mode === "dev" ? "Development" : "Production"} graph.`;
}

/** Complete ownership for every entity the graph holds, after the snapshot's enrichment. */
export function withOwnership(model: ModeModel, declarations: Readonly<Record<string, OwnershipFacts>> = mergeDeclaredOwnership([[model.mode, model.ownership]]), context: OwnershipContext = {}): ModeModel {
  const ownership: Record<string, OwnershipFacts> = {};
  const own = (id: string, note: string): OwnershipFacts => declarations[id] ?? undeclared(note);

  for (const target of model.targets) ownership[target.ref] = own(target.ref, "Its workload declaration was not recorded.");
  for (const route of model.routes) ownership[route.id] = inherit(route.target, ownership[route.target] ?? own(route.target, "Its workload declaration was not recorded."));
  for (const gateway of gatewaysOf(model)) ownership[gateway.id] = own(gateway.id, gateway.protocol === "agentcore" ? "Its gateway declaration was not recorded."
    : `The framework generates it from ${gateway.routes.length} route declaration${gateway.routes.length === 1 ? "" : "s"}; no declaration defines the API itself. Its routes keep their workloads' owners.`);

  const database = model.managedDatabase ? `database:${model.managedDatabase.id}` : undefined;
  if (database) ownership[database] = own(database, "Its database declaration was not recorded.");

  const resources = new Map(model.resources.map(resource => [resource.id, resource]));
  const children = new Map<string, ModelResource[]>();
  for (const resource of model.resources) if (resource.parent) children.set(resource.parent, [...(children.get(resource.parent) ?? []), resource]);
  const resolving = new Set<string>();
  const resolve = (resource: ModelResource): OwnershipFacts => {
    const known = ownership[resource.id];
    if (known) return known;
    if (resolving.has(resource.id)) return undeclared("Its parent chain loops, so no structural owner can be established.");
    resolving.add(resource.id);
    const parent = resource.parent ? resources.get(resource.parent) : undefined;
    const entries = children.get(resource.id) ?? [];
    let facts: OwnershipFacts;
    if (declarations[resource.id]) facts = declarations[resource.id]!;
    // A stack's members are fields of its class.
    else if (parent?.kind === "stack") facts = inherit(parent.id, resolve(parent));
    // A database setting override supplies one field of the database declaration.
    else if (resource.frameworkInput === "database" && resource.kind === "input" && database) facts = inherit(database, ownership[database]!);
    else if (resource.kind === "group" && entries.length) {
      const resolved = entries.map(entry => ({ where: entry.id, managedBy: resolve(entry).managedBy }));
      const owners = new Set(resolved.map(entry => entry.managedBy));
      facts = owners.size === 1 ? { managedBy: resolved[0]!.managedBy, basis: "entries" } : { managedBy: "unresolved", basis: "conflict", conflicts: resolved };
    } else facts = undeclared(undeclaredNote(model, resource));
    resolving.delete(resource.id);
    ownership[resource.id] = facts;
    return facts;
  };
  for (const resource of model.resources) resolve(resource);

  for (const network of model.networks ?? []) {
    const island = `island:vpc:${network.id}`;
    ownership[island] = own(island, "Its network declaration was not recorded.");
    for (const fixture of networkFixtureIds(network)) if (fixture !== island) ownership[fixture] = inherit(island, ownership[island]!);
  }
  for (const service of model.localServices ?? []) ownership[service.id] = undeclared(`Defined by the ${service.service} service in docker-compose.yml, which carries no ownership declaration.`);

  return { ...model, ownership: withIntegrations(model, ownership, database, context) };
}

/** Framework-maintained contracts, from the framework's own explicit references. Never ownership. */
function withIntegrations(model: ModeModel, ownership: Record<string, OwnershipFacts>, database: string | undefined, context: OwnershipContext): Record<string, OwnershipFacts> {
  const notes = new Map<string, string[]>();
  const add = (id: string, note: string) => { if (ownership[id]) notes.set(id, [...(notes.get(id) ?? []), note]); };
  for (const resource of model.resources) {
    if (!resource.frameworkInput) continue;
    const group = FRAMEWORK_INPUT_GROUPS[resource.frameworkInput];
    add(resource.id, `Read by ${group.reader}; Studio's ${group.title} view relies on ${resource.kind === "group" ? "its entries' names" : "its name"}.`);
  }
  if (database && model.managedDatabase) {
    add(database, `Built by the framework: ${model.managedDatabase.resource} in production and the local Compose PostgreSQL service in development.`);
    add(model.managedDatabase.resource, `Implements the ${database} declaration in production; its database policy and IAM login follow that declaration.`);
    for (const service of model.localServices ?? []) add(service.id, `Runs the ${database} declaration locally.`);
  }
  for (const [id, file] of Object.entries(context.stackFiles ?? {})) if (file === AUTHENTICATION_STACK_FILE) {
    add(id, `Studio's Authentication workspace reads ${AUTHENTICATION_STACK_FILE}, and its userPool is the user pool for workloads that declare userPool: true.`);
  }
  if (!notes.size) return ownership;
  return Object.fromEntries(Object.entries(ownership).map(([id, facts]) => [id, notes.has(id) ? { ...facts, integrations: notes.get(id)! } : facts]));
}

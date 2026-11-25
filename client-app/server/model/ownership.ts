import { isCdkResource, isCdkResourceGroup, isFrameworkDatabase, isResourceReference, type FrameworkConfig, type ManagedBy, type NormalizedTarget } from "aws-studio/config";
import { CLIENT_ENVIRONMENT_ID } from "../../shared/client-environment";
import { FRAMEWORK_INPUT_GROUPS } from "../../shared/deployment-inputs";
import { networkFixtureIds } from "../../shared/descriptions";
import { gatewaysOf } from "../../shared/gateways";
import { AUTHENTICATION_STACK_FILE } from "../../shared/integrations";
import type { ModeModel, ModelResource, OwnershipFacts } from "../../shared/model";

const recorded = (managedBy: ManagedBy | undefined): OwnershipFacts => managedBy ? { managedBy, basis: "declared" } : { managedBy: "developer", basis: "default" };
const undeclared = (note: string): OwnershipFacts => ({ managedBy: "unresolved", basis: "undeclared", note });
const project = (note: string): OwnershipFacts => ({ managedBy: "developer", basis: "project", note });
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
 * use the framework edit guard for their shared source and retain the evidence from both modes.
 */
export function mergeDeclaredOwnership(graphs: readonly (readonly [where: string, records: Readonly<Record<string, OwnershipFacts>> | undefined])[]): Record<string, OwnershipFacts> {
  const evidence = new Map<string, { where: string; facts: OwnershipFacts }[]>();
  for (const [where, records] of graphs) for (const [id, facts] of Object.entries(records ?? {})) {
    if (facts.basis !== "declared" && facts.basis !== "default" && facts.basis !== "catalog") continue;
    evidence.set(id, [...(evidence.get(id) ?? []), { where, facts }]);
  }
  const merged: Record<string, OwnershipFacts> = {};
  for (const [id, items] of evidence) {
    const owners = new Set(items.map(item => item.facts.managedBy));
    if (owners.size === 1) {
      // Keep a project's explicit lock when only one mode writes it.
      merged[id] = (items.find(item => item.facts.basis === "catalog" && !item.facts.projectOverride)
        ?? items.find(item => item.facts.basis === "declared")
        ?? items.find(item => item.facts.basis === "catalog") ?? items[0]!).facts;
    } else {
      merged[id] = { managedBy: "framework", basis: "conflict", conflicts: items.map(({ where, facts }) => ({ where, managedBy: facts.managedBy })),
        ...(items.some(item => item.facts.projectOverride) ? { projectOverride: true } : {}) };
    }
  }
  return merged;
}

export interface OwnershipContext {
  /** Catalog stack entity ID to its class file, for integrations keyed by a fixed source path. */
  readonly stackFiles?: Readonly<Record<string, string>>;
  /** Both mode graphs show input overrides for the production database. */
  readonly databaseOverrideOwner?: string;
}

/** Complete ownership for every entity the graph holds, after the snapshot's enrichment. */
export function withOwnership(model: ModeModel, declarations: Readonly<Record<string, OwnershipFacts>> = model.ownership ?? {}, context: OwnershipContext = {}): ModeModel {
  const ownership: Record<string, OwnershipFacts> = {};
  const own = (id: string, note: string): OwnershipFacts => declarations[id] ?? undeclared(note);

  for (const target of model.targets) ownership[target.ref] = own(target.ref, "Its workload declaration was not recorded.");
  for (const route of model.routes) ownership[route.id] = inherit(route.target, ownership[route.target] ?? own(route.target, "Its workload declaration was not recorded."));
  for (const gateway of gatewaysOf(model)) ownership[gateway.id] = own(gateway.id, "Its gateway definition was not recorded.");

  const database = model.managedDatabase ? `database:${model.managedDatabase.id}` : undefined;
  if (database) ownership[database] = own(database, "Its database declaration was not recorded.");
  const databaseOverrideOwner = context.databaseOverrideOwner ?? database;

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
    else if (resource.frameworkInput === "database" && resource.kind === "input" && databaseOverrideOwner) {
      facts = inherit(databaseOverrideOwner, own(databaseOverrideOwner, "Its production database declaration was not recorded."));
    } else if (resource.kind === "group" && entries.length) {
      const resolved = entries.map(entry => ({ where: entry.id, managedBy: resolve(entry).managedBy }));
      const owners = new Set(resolved.map(entry => entry.managedBy));
      facts = owners.size === 1 ? { managedBy: resolved[0]!.managedBy, basis: "entries" } : project("The project groups entries with independently maintained definitions.");
    } else if (resource.deploymentFile) facts = project("The project supplies this environment's CDK inputs file.");
    else if (resource.id === CLIENT_ENVIRONMENT_ID) facts = project("The project defines its client environment mappings in framework-config/client-environment.ts.");
    else if (resource.kind === "group") facts = project("The project defines this catalog namespace.");
    else if (resource.stackFile?.startsWith("cdk-app/")) facts = project(`The project defines this stack in ${resource.stackFile}.`);
    else facts = undeclared("Studio could not locate the declaration or its owning resource.");
    resolving.delete(resource.id);
    ownership[resource.id] = facts;
    return facts;
  };
  for (const resource of model.resources) resolve(resource);
  for (const defaults of model.defaults ?? []) ownership[defaults.ref] = project("The project declares its workload defaults.");

  for (const network of model.networks ?? []) {
    const island = `island:vpc:${network.id}`;
    ownership[island] = own(island, "Its network declaration was not recorded.");
    for (const fixture of networkFixtureIds(network)) if (fixture !== island) ownership[fixture] = inherit(island, ownership[island]!);
  }
  for (const service of model.localServices ?? []) ownership[service.id] = declarations[service.id] ?? project(`The project defines its ${service.service} service in Compose.`);

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

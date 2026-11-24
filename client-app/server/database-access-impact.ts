import { GRAPH_ACTIONS, type AccessGraph, type GraphModel } from "aws-studio/database/access-graph";
import { describeCondition, type readClientAccess } from "aws-studio/database/client-access";
import type { ChainDiff } from "aws-studio/contract-chain/graphql-chain";
import { fieldReaderCondition } from "../shared/database-workbench";

type CompiledAccess = ReturnType<typeof readClientAccess>;

const actions = (values: readonly string[]) => [...values].sort().join(", ") || "None";
const names = (before: object, after: object) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

function scope(graph: AccessGraph, model: GraphModel): string {
  const path = model.path.map(name => graph.models[name]?.from ? `${name}.${graph.models[name]!.from}` : name).join(" → ");
  const root = graph.models[model.path[model.path.length - 1]!];
  if (root?.roles) {
    const { relation, membership, principal, filter, field, enumeration } = root.roles;
    const qualifiers = Object.entries(filter ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name} = ${value}`).join(", ");
    return `${path} · ${relation}${qualifiers ? ` [${qualifiers}]` : ""} · ${membership}.${field} (${enumeration}) via ${membership}.${principal}`;
  }
  return `${path} · ${[...(root?.identity ?? [])].sort().map(field => `${field} = auth.id`).join(" or ")}`;
}

/** Each deny rule on the model's path: who may still read, in normal form, keyed by where it is written. */
function guards(graph: AccessGraph, model: GraphModel, self: string) {
  return Object.fromEntries(model.guards.map(({ name, model: declaredOn }) => {
    const alternatives = (graph.guards[name]?.disjuncts ?? []).map(({ row, roles }) => {
      const conditions = Object.entries(row ?? {}).sort(([a], [b]) => a.localeCompare(b))
        .map(([field, value]) => describeCondition(field, typeof value === "object" && "in" in value ? { in: [...value.in].sort() } : value));
      if (roles) conditions.push(`role in ${actions(roles)}`);
      return conditions.join(" and ") || "Any eligible reader";
    });
    return [declaredOn === self ? "deny" : `deny via ${declaredOn}`, `${declaredOn} · ${[...new Set(alternatives)].sort().join(" or ") || "No eligible reader"}`];
  }));
}

function fields(access: CompiledAccess, name: string) {
  return Object.fromEntries(Object.entries(access.policy.models[name]?.fields ?? {}).flatMap(([field, rule]) => {
    if (rule.relation) return [];
    const protection = access.settings[name]?.[field];
    const reason = access.graph.models[name]?.fields[field];
    const label = protection === "server-only" ? "Server only"
      : reason === "actor" ? "Read eligible · Actor-controlled"
      : rule.link ? "Read eligible · Scope link"
      : protection === "read-only" ? "Read eligible · Read only"
      : "Read eligible";
    return [[field, rule.readIdentity && protection !== "server-only" ? `${label} · ${fieldReaderCondition(name, rule.readIdentity)}` : label]];
  }));
}

/** Diff the compiler's effective policy, including restrictions inherited from another model. */
export function diffDatabaseAccess(before: CompiledAccess, after: CompiledAccess): ChainDiff[] {
  if (before.problems.length || after.problems.length) return [];
  const changes: ChainDiff[] = [];
  const add = (subject: string, detail: string, before?: string, after?: string) => {
    if (before === after) return;
    changes.push({ surface: "prisma", subject, path: `${subject} · ${detail}`, change: before === undefined ? "added" : after === undefined ? "removed" : "changed", before: before ?? null, after: after ?? null });
  };
  const oldGraph = before.graph;
  const newGraph = after.graph;
  for (const name of names(before.policy.enums, after.policy.enums)) {
    const declared = before.policy.enums[name], proposed = after.policy.enums[name];
    const oldGrants = declared?.grants ?? {}, newGrants = proposed?.grants ?? {};
    for (const permission of names(oldGrants, newGrants)) {
      add(name, `permission ${permission}`, oldGrants[permission] && actions(oldGrants[permission]), newGrants[permission] && actions(newGrants[permission]));
    }
    const oldProtected = declared?.values.filter(value => !declared.assignable.includes(value)) ?? [];
    const newProtected = proposed?.values.filter(value => !proposed.assignable.includes(value)) ?? [];
    if (oldProtected.length || newProtected.length) add(name, "protected values", actions(oldProtected), actions(newProtected));
  }
  for (const name of names(oldGraph.enums, newGraph.enums)) {
    const oldMasks = oldGraph.enums[name]?.masks ?? {};
    const newMasks = newGraph.enums[name]?.masks ?? {};
    for (const role of names(oldMasks, newMasks)) {
      add(name, `${role} CRUD mask`, oldMasks[role] && actions(oldMasks[role]), newMasks[role] && actions(newMasks[role]));
    }
  }
  for (const name of names({ ...oldGraph.models, ...oldGraph.rules }, { ...newGraph.models, ...newGraph.rules })) {
    const oldModel = oldGraph.models[name];
    const newModel = newGraph.models[name];
    const eligibility = (access: CompiledAccess, model: GraphModel | undefined) => !access.rows.models[name] ? "No row policy" : model ? "Eligible under a scope" : "Eligible under rules";
    add(name, "row eligibility", eligibility(before, oldModel), eligibility(after, newModel));
    add(name, "scope", oldModel && scope(oldGraph, oldModel), newModel && scope(newGraph, newModel));
    // Rules as written, normalized: reflowing a directive is no change, rewording one is.
    const oldRules = oldGraph.rules?.[name], newRules = newGraph.rules?.[name];
    add(name, "rules", oldRules?.model.join("\n") || undefined, newRules?.model.join("\n") || undefined);
    for (const field of names(oldRules?.fields ?? {}, newRules?.fields ?? {})) {
      add(name, `${field} rules`, oldRules?.fields[field]?.join("\n") || undefined, newRules?.fields[field]?.join("\n") || undefined);
    }
    if (!oldModel || !newModel) continue;
    const caps = (graph: AccessGraph, model: GraphModel) => model.path.flatMap(parent => {
      const only = graph.models[parent]?.only;
      return only ? [`${parent} [${actions(only)}]`] : [];
    }).join(" · ") || "No action cap";
    add(name, "action caps", caps(oldGraph, oldModel), caps(newGraph, newModel));
    for (const action of GRAPH_ACTIONS) add(name, `generic ${action}`, actions(oldModel.actions[action]), actions(newModel.actions[action]));
    const oldGuards = guards(oldGraph, oldModel, name), newGuards = guards(newGraph, newModel, name);
    for (const guard of names(oldGuards, newGuards)) add(name, guard, oldGuards[guard], newGuards[guard]);
  }
  // Field protections and identity reads, on every model a directive governs.
  for (const name of names({ ...oldGraph.models, ...oldGraph.fieldRules, ...oldGraph.rules }, { ...newGraph.models, ...newGraph.fieldRules, ...newGraph.rules })) {
    if (!before.policy.models[name] || !after.policy.models[name]) continue;
    const oldFields = fields(before, name), newFields = fields(after, name);
    for (const field of names(oldFields, newFields)) add(name, field, oldFields[field], newFields[field]);
  }
  return changes;
}

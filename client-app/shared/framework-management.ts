import type { ModeModel, Owner, OwnershipFacts } from "./model";

/**
 * Ownership is projected once by the server (`server/model/ownership.ts`).
 * Views only read it: they never re-derive it from resource flags, names or kinds.
 *
 * It answers three questions for every entity: who maintains its definition
 * (`managedBy`), how that was established (`basis`, with `from`, `conflicts` or
 * `note`), and what Studio may therefore change (`ownershipConsequence`).
 */
type Owned = { readonly ownership?: ModeModel["ownership"] };

const MISSING: OwnershipFacts = Object.freeze({ managedBy: "unresolved", basis: "undeclared", note: "Studio has no ownership record for this entity." });

/** An entity without a projected record is unresolved, never silently developer owned. */
export function ownershipOf(model: Owned, id: string): OwnershipFacts {
  return model.ownership?.[id] ?? MISSING;
}

export function isFrameworkManaged(model: Owned, id: string): boolean {
  return ownershipOf(model, id).managedBy === "framework";
}

export function isOwnershipUnresolved(model: Owned, id: string): boolean {
  return ownershipOf(model, id).managedBy === "unresolved";
}

/** Only a developer-owned definition is one Studio may change through its editors. */
export function isDeveloperOwned(model: Owned, id: string): boolean {
  return ownershipOf(model, id).managedBy === "developer";
}

/** Every framework-managed entity in one graph. */
export function frameworkManagedIds(model: Owned): ReadonlySet<string> {
  return idsOwnedBy(model, "framework");
}

export function idsOwnedBy(model: Owned, owner: Owner): ReadonlySet<string> {
  return new Set(Object.entries(model.ownership ?? {}).filter(([, facts]) => facts.managedBy === owner).map(([id]) => id));
}

export const OWNER_LABELS: Readonly<Record<Owner, string>> = { framework: "AWS Studio platform", developer: "Application developer", unresolved: "Unresolved" };

/** How the owner was established, for badge tooltips and the inspector. */
export function ownershipReason(facts: OwnershipFacts, title: (id: string) => string = id => id): string {
  const owner = facts.managedBy === "framework" ? "the AWS Studio platform" : facts.managedBy === "developer" ? "the application developer" : "nobody it can establish";
  switch (facts.basis) {
    case "declared": return `Its declaration says managedBy: "${facts.managedBy}", so ${owner} maintains its definition.`;
    case "default": return "Its declaration sets no managedBy, which means the application developer maintains its definition.";
    case "inherited": return `Follows ${facts.from ? title(facts.from) : "its owner"}, maintained by ${owner}.`;
    case "entries": return `Has no declaration of its own; every entry is maintained by ${owner}.`;
    case "conflict": return `Ownership is unresolved because its declarations disagree: ${(facts.conflicts ?? []).map(item => `${item.where === "dev" ? "Development" : item.where === "prod" ? "Production" : title(item.where)} says ${item.managedBy}`).join("; ")}.`;
    case "undeclared": return `Ownership is unresolved: no declaration names an owner.${facts.note ? ` ${facts.note}` : ""}`;
  }
}

/** What Studio may change as a consequence, stated the same way everywhere. */
export function ownershipConsequence(facts: OwnershipFacts): string {
  switch (facts.managedBy) {
    case "developer": return "Studio may change its definition through its editors.";
    case "framework": return "Studio does not change its definition or its stack source. Its tags, names, descriptions and supplied values stay editable, as do connections that developer-owned workloads make to it.";
    case "unresolved": return "Studio does not change any definition it can locate for it. Its tags, names, descriptions and supplied values stay editable.";
  }
}

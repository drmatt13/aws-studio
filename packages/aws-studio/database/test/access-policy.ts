/**
 * Authoring an application's access policy module (prisma/access/index.ts):
 * the commands, typed multi-row writes that no rule in contract.prisma grants.
 * Each names its audience in the row's scope, the rows it writes, the fields it
 * assigns, the state it requires and the values it may set.
 *
 * Who may read and write everything else, deny rules included, is written in
 * contract.prisma's `/// @access(…)` directives. The aws-studio db:generate command
 * validates every name here against the schema and records the result in the
 * access graph artifact.
 */
import type { AccessModules, CommandDefinition } from "../access-graph.js";
import type { RowFilterValue } from "../client-access.js";

/** A typed application command, as data. */
export function command(definition: { readonly who: string; readonly writes: CommandDefinition["writes"] }): CommandDefinition {
  for (const write of definition.writes) {
    for (const [field, values] of Object.entries(write.to ?? {})) assertValue(values, `${write.model}.${field}`);
    for (const [field, values] of Object.entries(write.when ?? {})) assertValue(values, `${write.model}.${field}`);
  }
  return definition;
}

function assertValue(value: RowFilterValue, where: string): void {
  const ok = typeof value === "string" || typeof value === "boolean"
    || (typeof value === "object" && value !== null && (("in" in value && Array.isArray(value.in)) || "not" in value));
  if (!ok) throw new Error(`${where}: write a value, { not: VALUE } or { in: [VALUES] }.`);
}

/** The module's default export. Validation happens against contract.prisma at generation. */
export function defineAccessPolicy<const Policy extends AccessModules>(policy: Policy): Policy {
  return policy;
}

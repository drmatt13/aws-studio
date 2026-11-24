import { accessDirectives, readClientAccess, type AccessModules, type SourceDirective } from "aws-studio/database/client-access";
import { ACTIONS, commentStart, parseRule } from "aws-studio/database/access-syntax";

export interface AccessProposal { readonly source: string; readonly problem?: string }
type Parsed = ReturnType<typeof readClientAccess>;

function proposal(source: string, edit: () => string, modules?: AccessModules): AccessProposal {
  try {
    const next = edit();
    const problems = readClientAccess(next, modules).problems;
    return problems.length ? { source, problem: problems[0]!.message } : { source: next };
  } catch (error) { return { source, problem: error instanceof Error ? error.message : String(error) }; }
}

const accessDirective = /^\s*\/\/\/\s*@access\s*\(/;

/** The declaration's trailing directive or the first stacked directive above it. */
export function accessDirectiveLine(lines: readonly string[], declaration: number): number | undefined {
  const declared = lines[declaration - 1] ?? "";
  const comment = commentStart(declared);
  if (comment >= 0 && accessDirective.test(declared.slice(comment))) return declaration;
  let found: number | undefined;
  for (let current = declaration - 1; current > 0 && /^\s*\/\/\//.test(lines[current - 1] ?? ""); current--) {
    if (accessDirective.test(lines[current - 1]!)) found = current;
  }
  return found;
}

type Target = SourceDirective["target"];

function targetLine(parsed: Parsed, target: Target): number | undefined {
  switch (target.kind) {
    case "enum": return parsed.index.enums[target.enumeration]?.line;
    case "value": return parsed.index.enums[target.enumeration]?.values[target.value];
    case "model": return parsed.index.models[target.model]?.line;
    case "field": return parsed.index.models[target.model]?.fields[target.field];
  }
}

/** Change only the selected directive, leaving the declaration and any sibling rules intact. */
function editRule(source: string, line: number, target: Target, existing: SourceDirective | undefined, rule: string | null): string {
  if (rule !== null) parseRule(rule, target.kind);
  const lines = source.split("\n");
  const start = line === 1 ? 0 : lines.slice(0, line - 1).join("\n").length + 1;
  const declared = lines[line - 1]!.replace(/\r$/, "");
  const indent = /^[\t ]*/.exec(declared)![0];
  const eol = lines[line - 1]!.endsWith("\r") || (line === lines.length && lines[line - 2]?.endsWith("\r")) ? "\r\n" : "\n";
  if (existing && rule === null) {
    const opening = source.lastIndexOf("\n", existing.commentFrom - 1) + 1;
    const end = source.indexOf("\n", existing.to);
    if (!existing.inline) return source.slice(0, opening) + (end < 0 ? "" : source.slice(end + 1));
    const before = source.slice(opening, existing.commentFrom).trimEnd();
    return source.slice(0, opening) + before + source.slice(existing.to);
  }
  if (rule === null) throw new Error("Select the rule to remove.");
  if (existing?.args === rule) return source;
  const body = rule.replace(/\r\n?|\n/g, eol + indent + "/// ");
  if (existing) return source.slice(0, existing.offsets[0]) + body + source.slice(existing.to - 1);
  const directive = `/// @access(${body})`;
  if ((target.kind === "field" || target.kind === "value") && commentStart(declared) < 0 && !/[\r\n]/.test(rule)) {
    const end = start + declared.trimEnd().length;
    return source.slice(0, end) + " " + directive + source.slice(end);
  }
  return source.slice(0, start) + indent + directive + eol + source.slice(start);
}

/** Validate both the requested expression and the resulting complete schema before staging it. */
export function setAccessRule(source: string, target: Target, existing: SourceDirective | undefined, rule: string | null, modules?: AccessModules): AccessProposal {
  return proposal(source, () => {
    const parsed = readClientAccess(source, modules);
    const line = targetLine(parsed, target);
    if (!line) throw new Error("This declaration no longer exists in the draft.");
    const current = existing && accessDirectives(source).find((item) => item.from === existing.from && item.to === existing.to && item.args === existing.args && targetLine(parsed, item.target) === line);
    if (existing && !current) throw new Error("This rule changed. Select it again in the draft.");
    return editRule(source, line, target, current, rule);
  }, modules);
}

/** What a role holds itself, what it gets from the roles it includes, and from which. */
export function roleHoldings(directives: readonly SourceDirective[], parsed: Parsed, enumeration: string): Record<string, { readonly own: readonly string[]; readonly includes: readonly string[]; readonly inherited: Readonly<Record<string, string>> }> {
  const values = parsed.policy.enums[enumeration]?.values ?? [];
  const own = new Map<string, { holds: string[]; includes: string[] }>();
  const rows = new Map<string, readonly string[]>();
  for (const directive of directives) {
    if (directive.target.kind === "enum" && directive.target.enumeration === enumeration && directive.rule?.kind === "permission") {
      rows.set(directive.rule.name.text, directive.rule.roles.map(({ text }) => text));
    }
    if (directive.target.kind !== "value" || directive.target.enumeration !== enumeration || directive.rule?.kind !== "role") continue;
    own.set(directive.target.value, { holds: directive.rule.holds.map((item) => item.text), includes: directive.rule.includes.map((item) => item.text.replace(/^\.\.\./, "")) });
  }
  const result: Record<string, { own: readonly string[]; includes: readonly string[]; inherited: Record<string, string> }> = {};
  for (const value of values) {
    const entry = own.get(value) ?? { holds: [], includes: [] };
    const inherited: Record<string, string> = {};
    // Breadth first through the included roles: an item comes from the nearest role that lists it itself.
    const queue = [...entry.includes];
    const seen = new Set([value]);
    while (queue.length) {
      const role = queue.shift()!;
      if (seen.has(role)) continue;
      seen.add(role);
      for (const item of own.get(role)?.holds ?? []) if (!(item in inherited) && !entry.holds.includes(item)) inherited[item] = role;
      queue.push(...(own.get(role)?.includes ?? []));
    }
    const direct = [...rows].filter(([, roles]) => roles.includes(value)).map(([name]) => name);
    result[value] = { own: [...entry.holds, ...direct], includes: entry.includes, inherited };
  }
  return result;
}

/**
 * Adds an action or ability to a role's own list, or removes it. A held item
 * that comes from an included role is that role's to change, so it refuses.
 */
export function toggleRoleHolding(source: string, parsed: Parsed, enumeration: string, role: string, item: string, modules?: AccessModules): AccessProposal {
  return proposal(source, () => {
    if (parsed.problems.length) throw new Error("Fix the current access rules before editing a role.");
    const directives = accessDirectives(source);
    const holdings = roleHoldings(directives, parsed, enumeration)[role];
    const valueLine = parsed.index.enums[enumeration]?.values[role];
    if (!holdings || !valueLine) throw new Error(`${role} is not a role of ${enumeration}.`);
    const row = directives.find(({ target, rule }) => target.kind === "enum" && target.enumeration === enumeration && rule?.kind === "permission" && rule.name.text === item);
    if (row?.rule?.kind === "permission") {
      const { roles, listSpan } = row.rule;
      const next = new Set(roles.map(({ text }) => text));
      if (next.has(role)) next.delete(role);
      else next.add(role);
      // Keep the enum's display order and preserve every character outside this list.
      const list = parsed.policy.enums[enumeration]!.values.filter(value => next.has(value));
      const start = row.offsets[listSpan.from]!, end = row.offsets[listSpan.to - 1]! + 1;
      return source.slice(0, start) + `[${list.join(", ")}]` + source.slice(end);
    }
    const from = holdings.inherited[item];
    if (from) throw new Error(`${role} gets ${item} from ${from}, which it includes. Change it on ${from}.`);
    const target = { kind: "value" as const, enumeration, value: role };
    const directive = directives.find(({ target: each }) => each.kind === "value" && each.enumeration === enumeration && each.value === role);
    const valueRule = directive?.rule;
    const flags = valueRule?.kind === "role" ? valueRule.flags.map(({ text }) => text) : [];
    const own = valueRule?.kind === "role" ? valueRule.holds.map(({ text }) => text) : [];
    const holds = own.includes(item) ? own.filter((existing) => existing !== item) : [...own, item];
    const actions = ACTIONS.filter((action) => holds.includes(action));
    const abilities = holds.filter((held) => !(ACTIONS as readonly string[]).includes(held));
    const list = [...holdings.includes.map((include) => `...${include}`), ...actions, ...abilities, ...flags];
    return editRule(source, valueLine, target, directive, list.join(", "));
  }, modules);
}

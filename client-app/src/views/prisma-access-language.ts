/**
 * Editor support for `/// @access(…)` directives: what each token means, where
 * each model's access comes from, completion and go-to-definition. Everything
 * is read through the generator's own parser and compiler, so the editor never
 * interprets policy differently from the API.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import {
  accessDirectives, readClientAccess, type ClientAccessProblem, type SourceDirective,
} from "aws-studio/database/client-access";
import { ACTIONS, categorize, commentStart, tokenize, type AccessCategory, type Expression, type Name, type Rule, type Span } from "aws-studio/database/access-syntax";

type Parsed = ReturnType<typeof readClientAccess>;
export type ScopeKind = "identity" | "role" | "path";

export interface ModelScope {
  /** Where access to the rows comes from, in a fixed order: you, your role, another row. */
  readonly kinds: readonly ScopeKind[];
  /** A short phrase for the model's header. */
  readonly label: string;
  /** In the client API at all. */
  readonly exposed: boolean;
}

const KIND_ORDER: readonly ScopeKind[] = ["identity", "role", "path"];
const ordered = (kinds: Iterable<ScopeKind>) => KIND_ORDER.filter((kind) => new Set(kinds).has(kind));

/** Model scopes to show in the editor when the schema uses Access Graph. */
export function modelScopes(parsed: Parsed): Partial<Record<string, ModelScope>> {
  const scopes: Partial<Record<string, ModelScope>> = {};
  const governed = Object.keys(parsed.rows.models).length > 0 || Object.keys(parsed.graph.enums).length > 0 || parsed.problems.length > 0;
  for (const name of Object.keys(parsed.index.models)) {
    const graph = parsed.graph.models[name];
    if (graph) {
      const root = parsed.graph.models[graph.path[graph.path.length - 1]!]!;
      const kind: ScopeKind = root.base === "roles" ? "role" : "identity";
      const label = graph.base === "roles" ? `${name} roles`
        : graph.base === "from" ? `${root.base === "roles" ? `${graph.path[graph.path.length - 1]} roles` : "owner"} · from ${graph.from}`
          : `owner · ${(graph.identity ?? []).join(" or ")}`;
      scopes[name] = { kinds: [kind], label, exposed: true };
      continue;
    }
    const row = parsed.rows.models[name];
    if (!row) {
      if (governed) scopes[name] = { kinds: [], label: "not in the API", exposed: false };
      continue;
    }
    const kinds = new Set<ScopeKind>();
    const owners: string[] = [], roles: string[] = [], paths: string[] = [];
    const once = (list: string[], item: string) => { if (!list.includes(item)) list.push(item); };
    if (row.self) { kinds.add("identity"); once(owners, "self"); }
    if (row.authenticated) { kinds.add("identity"); once(owners, "signed-in users"); }
    for (const rule of row.rules) {
      if (rule.kind === "owner") { kinds.add("identity"); once(owners, "relation" in rule ? rule.fields.join(", ") : rule.field); }
      else if (rule.kind === "members" || rule.who) { kinds.add("role"); once(roles, `${rule.model} ${rule.who?.length === 1 && rule.who[0] !== "member" ? rule.who[0] : "members"}`); }
      else { kinds.add("path"); once(paths, rule.relation); }
    }
    const parts = [
      ...(owners.length ? [owners[0] === "self" && owners.length === 1 ? "self" : `owner · ${owners.filter((owner) => owner !== "self").join(" or ")}${owners.includes("self") ? " · self" : ""}`] : []),
      ...roles,
      ...(paths.length ? [paths.length > 2 ? `via ${paths.length} relations` : `via ${paths.join(" or ")}`] : []),
    ];
    const label = parts.join(" · ");
    scopes[name] = { kinds: ordered(kinds), label, exposed: true };
  }
  return scopes;
}

/** One coloured token, in document offsets. */
export interface AccessToken extends Span { readonly category: AccessCategory | "keyword" }

/** The colour of every token of every directive, in document offsets. */
export function accessTokens(directives: readonly SourceDirective[]): AccessToken[] {
  const tokens: AccessToken[] = [];
  for (const directive of directives) {
    const start = directive.offsets[0];
    if (start === undefined) continue;
    if (!directive.rule) continue;
    for (const span of categorize(directive.rule)) {
      const from = directive.offsets[span.from], last = directive.offsets[span.to - 1];
      if (from === undefined || last === undefined) continue;
      tokens.push({ from, to: last + 1, category: span.category });
    }
  }
  return tokens.sort((a, b) => a.from - b.from);
}

/** The kind a directive is mainly about, for its line's tint. */
export function directiveKind(rule: Rule | undefined): AccessCategory | undefined {
  if (!rule) return undefined;
  switch (rule.kind) {
    case "fieldGroup": return directiveKind(rule.rule);
    case "scope": return rule.roles ? "role" : "path";
    case "deny": case "flags": return "limit";
    case "transition": return "state";
    case "role": case "permission": return "role";
    case "command": return "action";
    case "allow": {
      const kinds = new Set(categorize(rule).map(({ category }) => category).filter((category) => category === "identity" || category === "role" || category === "path"));
      return kinds.size === 1 ? [...kinds][0] : undefined;
    }
  }
}

// ─── Explanations ────────────────────────────────────────────────────────────

export interface AccessExplanation extends Span {
  readonly category: AccessCategory | "keyword";
  readonly title: string;
  readonly body: string;
}

const ACTION_WORDS: Readonly<Record<string, string>> = {
  read: "See the rows, and the columns the rule lists.",
  create: "Add rows. The new row must be one they would see.",
  update: "Change columns of rows they see.",
  delete: "Remove rows they see.",
  write: "Assign this field, at creation and on update.",
};

const within = (span: Span, offset: number) => offset >= span.from && offset <= span.to;

interface Context {
  readonly parsed: Parsed;
  readonly model?: string;
  readonly field?: string;
  readonly enumeration?: string;
}

const relationTarget = (context: Context, model: string | undefined, relation: string) => {
  const field = model ? context.parsed.policy.models[model]?.fields[relation] : undefined;
  return field?.relation ? field.type : undefined;
};

/** The role enum whose roles reach `model`'s rows: its own scope's, or the one a relation leads to. */
function scopeEnumeration(context: Context, model: string | undefined): string | undefined {
  if (!model) return undefined;
  const graph = context.parsed.graph.models[model];
  if (graph?.enumeration) return graph.enumeration;
  for (const rule of context.parsed.rows.models[model]?.rules ?? []) {
    if (rule.kind === "owner") continue;
    const found = scopeEnumeration(context, rule.model);
    if (found) return found;
  }
  return undefined;
}

function rolesHolding(context: Context, enumeration: string | undefined, term: string): readonly string[] | undefined {
  const policy = enumeration ? context.parsed.policy.enums[enumeration] : undefined;
  if (!policy) return undefined;
  if (term === "member") return policy.values;
  if (policy.values.includes(term)) return [term];
  return policy.grants[term];
}

function explainExpression(context: Context, node: Expression, offset: number): Omit<AccessExplanation, "category"> & { category: AccessCategory } | undefined {
  switch (node.kind) {
    case "isMe": return { from: node.from, to: node.to, category: "identity", title: "The signed-in user", body: `${context.model ?? "This row"}.${node.field.text} matches the signed-in user’s verified key.` };
    case "or": case "and":
      for (const part of node.of) if (within(part, offset)) return explainExpression(context, part, offset);
      return { from: node.from, to: node.to, category: "punctuation", title: node.kind === "or" ? "Either is enough" : "Both must hold", body: node.kind === "or" ? "|| joins alternatives: any one lets a person through." : "&& narrows an alternative: every part must hold." };
    case "not":
      if (offset > node.from + 1) return explainExpression(context, node.of, offset);
      return { from: node.from, to: node.from + 1, category: "limit", title: "Not", body: "Holds when what follows does not." };
    case "identity": {
      const field = node.field.map((name) => name.text).join(".");
      const owner = `${context.model ?? "This row"}.${field}`;
      return node.negated
        ? { from: node.from, to: node.to, category: "limit", title: "Never the row’s owner", body: `${owner} is not the signed-in user (auth.${node.auth.text}). Excludes them from this rule.` }
        : { from: node.from, to: node.to, category: "identity", title: "The signed-in user", body: `${owner} is the signed-in user’s ${node.auth.text}, taken from their verified session, never from the request.` };
    }
    case "state": {
      const field = node.field.map((name) => name.text).join(".");
      const values = node.values.map((value) => value.text).join(" or ");
      return { from: node.from, to: node.to, category: "state", title: "Row state", body: `${field} ${node.negated ? "is not" : "is"} ${values}${node.field.length > 1 ? ", on the related row" : ""}.` };
    }
    case "name": {
      const [head, ...rest] = node.path;
      if (!rest.length) {
        if (head!.text === "authenticated") return { ...head!, category: "identity", title: "Any signed-in user", body: "Everyone with a verified session." };
        const enumeration = scopeEnumeration(context, context.model);
        const roles = rolesHolding(context, enumeration, head!.text);
        return { ...head!, category: "role", title: head!.text === "member" ? "Any member" : head!.text, body: roles ? `Eligible roles in this row’s scope: ${roles.join(", ") || "none"}.` : `Unknown role or permission in ${enumeration ?? "this row’s scope"}.` };
      }
      const target = relationTarget(context, context.model, head!.text);
      if (within(head!, offset)) return { ...head!, category: "path", title: `${context.model}.${head!.text}`, body: target ? `Follows this relation to the ${target} row.` : "Not a relation of this model." };
      const term = rest[rest.length - 1]!;
      if (term.text === "read") return { ...term, category: "path", title: `Readers of ${target ?? head!.text}`, body: `Whoever can read the related ${target ?? "row"}, by its own rules.` };
      const roles = rolesHolding(context, scopeEnumeration(context, target), term.text);
      return { ...term, category: "role", title: term.text === "member" ? `Members of that ${target ?? "row"}` : `${term.text} in that ${target ?? "row"}`,
        body: roles ? `Eligible roles in the related ${target}’s scope: ${roles.join(", ") || "none"}.` : `Unknown role or permission in ${target ?? head!.text}’s scope.` };
    }
  }
}

function explainGrant(rule: Extract<Rule, { kind: "allow" | "deny" }>, offset: number, context: Context): AccessExplanation | undefined {
  for (const grant of rule.grants) {
    if (within(grant.action, offset)) {
      const body = grant.action.text === "read" && context.field
        ? "Check readers of the fields this rule governs on visible rows."
        : ACTION_WORDS[grant.action.text] ?? "";
      return { ...grant.action, category: "action", title: grant.action.text, body };
    }
    for (const column of grant.columns ?? []) {
      if (within(column, offset)) return { ...column, category: "column", title: `${context.model}.${column.text}`, body: grant.action.text === "read" ? "Readers through this rule see only the columns it lists." : "The columns clients may assign. Others are server-set." };
    }
  }
  return undefined;
}

/** What the token at a document offset means, or undefined outside directives. */
export function explainAccessAt(source: string, offset: number, parsed: Parsed = readClientAccess(source)): AccessExplanation | undefined {
  for (const directive of accessDirectives(source)) {
    const first = directive.offsets[0], last = directive.offsets[directive.offsets.length - 1];
    if (first === undefined || last === undefined || offset < first - "@access(".length - 1 || offset > last + 1) continue;
    const text = directive.offsets.findIndex((at) => at >= offset);
    const position = text < 0 ? directive.args.length : text;
    const absolute = (explanation: AccessExplanation): AccessExplanation => ({
      ...explanation, from: directive.offsets[explanation.from] ?? first, to: (directive.offsets[Math.max(explanation.from, explanation.to - 1)] ?? last) + 1,
    });
    const { target, rule } = directive;
    const context: Context = "enumeration" in target ? { parsed, enumeration: target.enumeration } : { parsed, model: target.model, ...(target.kind === "field" ? { field: target.field } : {}) };
    if (!rule) return directive.problem ? absolute({ from: directive.problem.from, to: Math.max(directive.problem.to, directive.problem.from + 1), category: "limit", title: directive.problem.code, body: directive.problem.message }) : undefined;
    const explain = (rule: Rule, context: Context): AccessExplanation | undefined => {
      switch (rule.kind) {
        case "fieldGroup": {
          if (within(rule.key, position)) return { ...rule.key, category: "action", title: "Shared field rule", body: `The same rule applies to the named fields on ${context.model}.` };
          const column = rule.columns.find((name) => within(name, position));
          if (column) return { ...column, category: "column", title: `${context.model}.${column.text}`, body: "This field uses the shared rule." };
          return explain(rule.rule, { ...context, field: rule.columns.map(({ text }) => text).join(", ") });
        }
        case "allow": return explainGrant(rule, position, context) ?? (within(rule.when, position) ? explainExpression(context, rule.when, position) : undefined)
          ?? rule.flags?.map((flag) => within(flag, position) ? flagExplanation(flag) : undefined).find(Boolean);
        case "deny":
          if (within(rule.keyword, position)) return { ...rule.keyword, category: "limit", title: "Deny always wins", body: `Hides ${context.model} rows when the condition holds, for everyone it names, here and in every model that follows ${context.model} with from:.` };
          return explainGrant(rule, position, context) ?? (within(rule.when, position) ? explainExpression(context, rule.when, position) : undefined);
        case "flags": return rule.flags.map((flag) => within(flag, position) ? flagExplanation(flag) : undefined).find(Boolean);
        case "transition": {
          if (within(rule.when, position)) return explainExpression(context, rule.when, position);
          const from = rule.from === "any" ? "any value" : rule.from.map((value) => value.text).join(" or ");
          return { from: rule.from === "any" ? rule.arrow.from : rule.from[0]!.from, to: rule.to[rule.to.length - 1]!.to, category: "state", title: `${context.field} transition`, body: `${context.field} may move from ${from} to ${rule.to.map((value) => value.text).join(" or ")}, for the people the condition names.` };
        }
        case "scope": {
          if (rule.roles && (within(rule.roles.key, position) || within({ from: rule.roles.relation.from, to: rule.roles.field.to }, position))) {
            const membership = relationTarget(context, context.model, rule.roles.relation.text);
            if (rule.roles.actor && within(rule.roles.actor, position)) return explainExpression({ ...context, model: membership }, rule.roles.actor, position);
            const conditions = [rule.roles.actor && `${rule.roles.actor.field.text} matches the signed-in user`, rule.roles.filter && `${rule.roles.filter.field.text} equals ${rule.roles.filter.value.text}`].filter(Boolean);
            return { from: rule.roles.key.from, to: rule.roles.field.to, category: "role", title: `${context.model} is a role scope`, body: `A person’s role here is ${membership ?? "the membership"}.${rule.roles.field.text}${conditions.length ? ` when ${conditions.join(" and ")}` : ""}.` };
          }
          if (rule.from && within({ from: rule.from.key.from, to: rule.from.relation.to }, position)) {
            const parent = relationTarget(context, context.model, rule.from.relation.text);
            return { from: rule.from.key.from, to: rule.from.relation.to, category: "path", title: `In ${parent ?? "its parent"}’s scope`, body: `${context.model} rows follow their ${parent}: the same roles, caps and deny rules.` };
          }
          if (rule.only && within({ from: rule.only.key.from, to: rule.only.actions[rule.only.actions.length - 1]?.to ?? rule.only.key.to }, position)) {
            return { from: rule.only.key.from, to: rule.only.key.to, category: "limit", title: "Action cap", body: `Role masks grant at most ${rule.only.actions.map((action) => action.text).join(", ")} here and below. Commands are separate.` };
          }
          return undefined;
        }
        case "command": {
          if (within(rule.name, position) || within(rule.keyword, position)) return { ...rule.name, category: "action", title: rule.name.text, body: `This command may ${rule.grant.action.text} ${context.model} rows for ${rule.who.text}.` };
          const column = rule.grant.columns?.find(field => within(field, position));
          if (column) return { ...column, category: "column", title: `${context.model}.${column.text}`, body: "This command may assign the field." };
          const state = rule.states.find(state => within({ from: state.field.from, to: state.value.to }, position));
          if (state) return { ...state.field, category: "state", title: "Required row state", body: `${state.field.text} must equal ${state.value.text}.` };
          if (within(rule.who, position)) return { ...rule.who, category: "role", title: rule.who.text, body: `Required to run ${rule.name.text}.` };
          return undefined;
        }
        case "permission": {
          const holder = rule.roles.find(role => within(role, position));
          const holders = rule.roles.map(({ text }) => text).join(", ") || "none";
          if (holder) return { ...holder, category: "role", title: holder.text, body: `Grants ${rule.name.text} to this role in its group.` };
          if ((ACTIONS as readonly string[]).includes(rule.name.text)) {
            return { ...rule.name, category: "action", title: rule.name.text, body: `${ACTION_WORDS[rule.name.text]} Applies to every model in each listed role’s scopes. Exactly these roles: ${holders}.` };
          }
          return { ...rule.name, category: "role", title: rule.name.text, body: `Roles with this permission in their group: ${holders}.` };
        }
        case "role": {
          const policy = parsed.graph.enums[context.enumeration!];
          for (const include of rule.includes) {
            if (!within(include, position)) continue;
            const value = include.text.replace(/^\.\.\./, "");
            return { ...include, category: "role", title: `Includes ${value}`, body: `Inherits the grants listed on ${value} and the roles it includes. Permission rows list each holder explicitly.` };
          }
          for (const item of rule.holds) {
            if (!within(item, position)) continue;
            if ((ACTIONS as readonly string[]).includes(item.text)) return { ...item, category: "action", title: item.text, body: `${ACTION_WORDS[item.text]} Applies to every model in this role’s scopes.` };
            const roles = policy?.permissions[item.text] ?? [];
            return { ...item, category: "role", title: `Ability · ${item.text}`, body: `Held by ${roles.join(", ") || "no role"}. Rules and commands that name it decide what it allows.` };
          }
          return rule.flags.map((flag) => within(flag, position) ? flagExplanation(flag) : undefined).find(Boolean);
        }
      }
    };
    const found = explain(rule, context);
    return found ? absolute(found) : undefined;
  }
  return undefined;
}

function flagExplanation(flag: Name): AccessExplanation {
  const words: Readonly<Record<string, [string, string]>> = {
    readonly: ["Read only", "Readers see it; clients never assign it. The server sets it."],
    serverOnly: ["Server only", "Never in the client API: not returned, filtered, sorted or accepted."],
    protected: ["Protected value", "Clients never assign this value, or replace it once stored."],
  };
  const [title, body] = words[flag.text] ?? [flag.text, ""];
  return { ...flag, category: "limit", title, body };
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** Access problems as editor diagnostics: at the column the compiler names, to the end of that word. */
export function accessDiagnostics(source: string, problems: readonly ClientAccessProblem[]) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") starts.push(index + 1);
  return problems.map((problem) => {
    const lineStart = starts[problem.line - 1] ?? 0;
    const lineEnd = (starts[problem.line] ?? source.length + 1) - 1;
    const from = problem.column ? Math.min(lineEnd, lineStart + problem.column - 1) : lineStart;
    const word = /^[\w.@-]+/.exec(source.slice(from, lineEnd))?.[0].length ?? 0;
    return { from, to: Math.max(from + 1, problem.column ? from + word : lineEnd), severity: "error" as const, code: problem.code ?? "FIELD_ACCESS", message: problem.message };
  });
}

// ─── Completion ──────────────────────────────────────────────────────────────

interface OpenDirective {
  /** The directive's text from after `@access(` to the cursor, continuation lines joined. */
  readonly prefix: string;
  /** The 1-based line of the declaration it governs. */
  readonly target: number;
}

/** The directive the cursor is in, when its parentheses are still open at the cursor. */
function openDirective(source: string, position: number): OpenDirective | undefined {
  const lines = source.split("\n");
  let offset = 0, cursorLine = 0;
  for (; cursorLine < lines.length; cursorLine++) {
    if (offset + lines[cursorLine]!.length >= position) break;
    offset += lines[cursorLine]!.length + 1;
  }
  const column = position - offset;
  let start = cursorLine;
  let marker = -1, open = -1;
  while (start >= 0) {
    const text = lines[start]!;
    marker = commentStart(text);
    if (marker < 0 || !text.startsWith("///", marker)) return undefined;
    const call = /^\/\/\/\s*@access\s*\(/.exec(text.slice(marker));
    if (call) {
      open = marker + call[0].length;
      break;
    }
    if (text.slice(0, marker).trim() || text.slice(marker + 3).includes("@access")) return undefined;
    start--;
  }
  if (open < 0) return undefined;
  let prefix = "";
  for (let line = start; line <= cursorLine; line++) {
    const text = lines[line]!;
    const from = line === start ? open : commentStart(text) + 3;
    const to = line === cursorLine ? column : text.length;
    if (to < from) return undefined;
    prefix += (line === start ? "" : "\n") + text.slice(from, to);
  }
  let depth = 1;
  for (const character of prefix) { if (character === "(") depth++; else if (character === ")" && --depth === 0) return undefined; }
  if (lines[start]!.slice(0, marker).trim()) return { prefix, target: start + 1 };
  let target = cursorLine + 1;
  while (target < lines.length && /^\s*\/\/\//.test(lines[target]!)) target++;
  return { prefix, target: target + 1 };
}

const keyword = (label: string, detail: string, apply?: string): Completion => ({ label, type: "keyword", detail, ...(apply ? { apply } : {}) });

/** Undefined means this is ordinary Prisma; null means a directive with nothing to offer here. */
export function prismaAccessCompletions(context: CompletionContext): CompletionResult | null | undefined {
  const source = context.state.doc.toString();
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  // `///` then `@acc…`: offer the directive itself.
  const comment = commentStart(before);
  const marker = comment >= 0 ? /^\/\/\/\s*(@[A-Za-z]*)$/.exec(before.slice(comment)) : null;
  if (marker && "@access".startsWith(marker[1]!) && marker[1] !== "@access") {
    return { from: context.pos - marker[1]!.length, options: [{ label: "@access", apply: "@access()", type: "keyword", detail: "Access directive" }] };
  }
  const open = openDirective(source, context.pos);
  if (!open) return undefined;
  const parsed = readClientAccess(source);
  const place = placementAt(parsed, open.target);
  if (!place) return null;
  const word = /[\w.]*$/.exec(open.prefix)![0];
  const from = context.pos - word.length;
  const result = (options: Completion[]): CompletionResult | null => options.length ? { from, options, validFor: /^[\w.]*$/ } : null;
  let { tokens } = tokenize(open.prefix.slice(0, open.prefix.length - word.length));

  if (place.kind === "enum") {
    const list = tokens.findIndex(({ text }) => text === "[");
    if (list === -1 || tokens.some(({ text }) => text === "]")) return null;
    const listed = new Set(tokens.slice(list + 1).map(({ text }) => text));
    return result(Object.keys(parsed.index.enums[place.enumeration]!.values).filter(name => !listed.has(name)).map(label => ({ label, type: "enum", detail: place.enumeration })));
  }
  if (place.kind === "value") {
    const enumeration = parsed.policy.enums[place.enumeration]!;
    const matrix = new Set(accessDirectives(source).flatMap(({ target, rule }) => target.kind === "enum" && target.enumeration === place.enumeration && rule?.kind === "permission" ? [rule.name.text] : []));
    const abilities = Object.keys(enumeration.grants).filter(name => !matrix.has(name));
    return result([
      ...enumeration.values.filter((value) => value !== place.value).map((value) => ({ label: `...${value}`, type: "enum", detail: `everything ${value} holds` })),
      // An action with a row above the enum is that row's to grant.
      ...ACTIONS.filter((action) => !matrix.has(action)).map((action) => keyword(action, "action on rows in scope")),
      ...abilities.map((ability) => ({ label: ability, type: "function", detail: "ability" })),
      keyword("protected", "clients never assign this value"),
    ]);
  }

  const model = place.model;
  const fields = parsed.policy.models[model]?.fields ?? {};
  const scalars = Object.entries(fields).filter(([, field]) => !field.relation);
  const relations = Object.entries(fields).filter(([, field]) => field.relation);
  const principal = parsed.graph.principal ?? parsed.rows.userModel;
  const key = principal ? parsed.rows.models[principal]?.key : undefined;
  const identityFields = (owner: string) => {
    const names = new Set<string>();
    if (key?.length === 1) {
      if (owner === principal) names.add(key[0]!);
      for (const field of Object.values(parsed.policy.models[owner]?.fields ?? {})) {
        if (field.relation && !field.list && field.type === principal && field.local?.length === 1 && field.target?.length === 1 && field.target[0] === key[0]) names.add(field.local[0]!);
      }
    }
    return [...names];
  };
  let fieldNames = place.kind === "field" ? [place.field] : undefined;
  if (place.kind === "model" && tokens[0]?.text === "fields" && tokens[1]?.text === "(") {
    const close = tokens.findIndex((token) => token.text === ")");
    const selected = tokens.slice(2, close === -1 ? undefined : close).filter(({ kind }) => kind === "name").map(({ text }) => text);
    if (close === -1) return result(scalars.filter(([name]) => !selected.includes(name)).map(([name, field]) => ({ label: name, type: "property", detail: field.type })));
    if (!selected.length || tokens[close + 1]?.text !== ",") return null;
    fieldNames = selected;
    tokens = tokens.slice(close + 2);
  }
  const texts = tokens.map((token) => token.text);
  const last = texts[texts.length - 1];
  const depth = (open: string, close: string) => texts.filter((text) => text === open).length - texts.filter((text) => text === close).length;
  const colon = texts.indexOf(":");
  const roleScope = texts[0] === "roles" || texts[0] === "role";
  const inCondition = colon >= 0 && (fieldNames !== undefined || !(roleScope || ["from", "only"].includes(texts[0] ?? "")));

  if (!inCondition) {
    if (!fieldNames) {
      if (texts[0] === "from" && last === ":") return result(relations.filter(([, field]) => !field.list && field.local?.length).map(([name, field]) => ({ label: name, type: "property", detail: `→ ${field.type}` })));
      if (roleScope && last === ":") return result(relations.filter(([, field]) => field.list).map(([name, field]) => ({ label: name, type: "property", detail: `→ ${field.type}[]`, apply: `${name}[` })));
      if (roleScope && depth("[", "]") > 0) {
        const membership = fields[texts[2] ?? ""]?.type;
        if (!membership) return null;
        if (last === "(" && texts.at(-2) === "isMe") return result(identityFields(membership).map(label => ({ label, type: "property", detail: membership })));
        if (last === "[" || last === "&&") return result([
          ...identityFields(membership).map(field => ({ label: `isMe(${field})`, type: "function", detail: "the signed-in member" })),
          ...Object.entries(parsed.policy.models[membership]?.fields ?? {}).filter(([, field]) => !field.relation && parsed.policy.enums[field.type]).map(([label]) => ({ label, type: "property", detail: membership, apply: `${label} == ` })),
        ]);
        if (last === "=" || last === "==") {
          const type = parsed.policy.models[membership]?.fields[texts.at(-2) ?? ""]?.type;
          return result((type ? parsed.policy.enums[type]?.values ?? [] : []).map(label => ({ label, type: "enum", detail: type })));
        }
        return null;
      }
      if (roleScope && last === "]" && word.startsWith(".")) {
        const membership = fields[texts[2] ?? ""]?.type;
        return result(Object.entries(parsed.policy.models[membership ?? ""]?.fields ?? {}).filter(([, field]) => !field.relation && parsed.graph.enums[field.type]).map(([label, field]) => ({ label: `.${label}`, type: "property", detail: field.type })));
      }
      if (texts.includes("only") && depth("[", "]") > 0) return result(ACTIONS.map((action) => keyword(action, "allowed here and below")));
      if (depth("(", ")") > 0) return result(scalars.filter(([name]) => parsed.settings[model]?.[name] !== "server-only").map(([name, field]) => ({ label: name, type: "property", detail: field.type })));
      if (!texts.length) return result([
        ...ACTIONS.map((action) => keyword(action, "who may", `${action}: `)),
        keyword("deny", "hide rows; deny wins", "deny read: "),
        keyword("command", "name a specific write", "command "),
        keyword("roles", "a role from a membership", "roles: "),
        keyword("from", "follow a parent's scope", "from: "),
        keyword("only", "cap role actions", "only: ["),
        keyword("fields", "apply one rule to named fields", "fields("),
      ]);
      if (last === ",") return result(ACTIONS.map((action) => keyword(action, "who may")));
      return null;
    }
    const domains = fieldNames.map((name) => {
      const type = fields[name]?.type;
      return type === "Boolean" ? ["true", "false"] : parsed.policy.enums[type ?? ""]?.values ?? [];
    });
    const values = domains[0]!.filter((value) => domains.every((domain) => domain.includes(value)));
    if (!texts.length) return result([
      keyword("readonly", "clients never assign it"),
      keyword("serverOnly", "never in the client API"),
      keyword("read", "who reads it", "read: "),
      keyword("write", "who may assign it", "write: "),
      ...values.map((value) => ({ label: value, type: "enum", detail: "transition from", apply: `${value} -> ` })),
    ]);
    if (last === "->" || last === "|") return result(values.map((value) => ({ label: value, type: "enum", detail: last === "->" ? "transition to" : "or" })));
    return null;
  }

  // In a condition.
  const principalKey = key?.length === 1 ? key[0] : undefined;
  const keys = identityFields(model);
  if (last === "(" && texts.at(-2) === "isMe") return result(keys.map(label => ({ label, type: "property", detail: "matches the signed-in user’s key" })));
  const identity = (name: string) => {
    if (keys.includes(name)) return `auth.${principalKey}`;
    if (principal && name !== principalKey && parsed.policy.models[principal]?.fields[name] && !parsed.policy.models[principal]!.fields[name]!.relation) return `auth.${name}`;
    return undefined;
  };
  const stateValues = (owner: string, name: string) => {
    const field = parsed.policy.models[owner]?.fields[name];
    return field?.type === "Boolean" ? ["true", "false"] : parsed.policy.enums[field?.type ?? ""]?.values;
  };
  if (last === "==" || last === "!=" || last === "|") {
    const operand = tokens.slice(0, last === "|" ? texts.lastIndexOf("==") >= texts.lastIndexOf("!=") ? texts.lastIndexOf("==") : texts.lastIndexOf("!=") : -1);
    const path = (last === "|" ? operand : tokens).slice(0, last === "|" ? undefined : -1);
    const names: string[] = [];
    for (let index = path.length - 1; index >= 0; index--) {
      const token = path[index]!;
      if (token.kind === "name") names.unshift(token.text);
      else if (token.text !== ".") break;
    }
    const owner = names.length === 2 ? fields[names[0]!]?.type ?? model : model;
    const name = names[names.length - 1] ?? "";
    const auth = last !== "|" && names.length === 1 ? identity(name) : undefined;
    return result([
      ...(auth ? [{ label: auth, type: "variable", detail: "the signed-in user" }] : []),
      ...(stateValues(owner, name) ?? []).map((value) => ({ label: value, type: "enum", detail: `${owner}.${name}` })),
    ]);
  }
  const dotted = /^([A-Za-z_]\w*)\.(\w*)$/.exec(word);
  if (dotted) {
    const relation = fields[dotted[1]!];
    if (!relation?.relation) return null;
    const enumeration = scopeEnumeration({ parsed }, relation.type);
    const terms = enumeration ? [...Object.keys(parsed.policy.enums[enumeration]!.grants), ...parsed.policy.enums[enumeration]!.values] : [];
    const related = Object.entries(parsed.policy.models[relation.type]?.fields ?? {}).filter(([name]) => stateValues(relation.type, name));
    return { from: from + dotted[1]!.length + 1, validFor: /^\w*$/, options: [
      { label: "read", type: "keyword", detail: `whoever can read the ${relation.type}` },
      ...(enumeration ? [{ label: "member", type: "keyword", detail: `any role in the ${relation.type}` }] : []),
      ...terms.map((term) => ({ label: term, type: /^[A-Z]/.test(term) ? "enum" : "function", detail: `in the ${relation.type}’s scope` })),
      ...related.map(([name, field]) => ({ label: name, type: "property", detail: `${relation.type}.${name}: ${field.type}` })),
    ] };
  }
  const scoped = !!parsed.graph.models[model]?.enumeration;
  const enumeration = scopeEnumeration({ parsed }, model);
  return result([
    ...scalars.flatMap(([name, field]) => {
      const auth = identity(name);
      return [
        ...(auth ? [{ label: keys.includes(name) ? `isMe(${name})` : `${name} == ${auth}`, type: "variable", detail: "the signed-in user" }] : []),
        ...(stateValues(model, name) ? [{ label: name, type: "property", detail: field.type, apply: `${name} == ` }] : []),
      ];
    }),
    ...relations.map(([name, field]) => ({ label: `${name}.`, type: "property", detail: `→ ${field.type}` })),
    keyword("authenticated", "any signed-in user"),
    ...(scoped && enumeration ? [
      keyword("member", "any role in this scope"),
      ...Object.keys(parsed.policy.enums[enumeration]!.grants).map((name) => ({ label: name, type: "function", detail: "ability in this scope" })),
      ...parsed.policy.enums[enumeration]!.values.map((name) => ({ label: name, type: "enum", detail: "role in this scope" })),
    ] : []),
  ]);
}

type Placement = SourceDirective["target"];

function placementAt(parsed: Parsed, line: number): Placement | undefined {
  for (const [model, entry] of Object.entries(parsed.index.models)) {
    if (entry.line === line) return { kind: "model", model };
    const field = Object.entries(entry.fields).find(([, at]) => at === line)?.[0];
    if (field) return { kind: "field", model, field };
  }
  for (const [enumeration, entry] of Object.entries(parsed.index.enums)) {
    if (entry.line === line) return { kind: "enum", enumeration };
    const value = Object.entries(entry.values).find(([, at]) => at === line)?.[0];
    if (value) return { kind: "value", enumeration, value };
  }
  return undefined;
}

// ─── Go to definition ────────────────────────────────────────────────────────

export interface AccessDefinition { readonly name: string; readonly from: number; readonly to: number; readonly kind: string; readonly scope: string; readonly text: string }

/** The declaration a directive's name refers to: a field, a relation, a role or the role that grants an ability. */
export function prismaAccessDefinition(source: string, offset: number): AccessDefinition | undefined {
  const parsed = readClientAccess(source);
  const lines = source.split("\n");
  const directives = accessDirectives(source);
  const at = (line: number | undefined, name: string, kind: string, scope: string): AccessDefinition | undefined => {
    if (!line) return undefined;
    const lineStart = lines.slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0);
    const column = lines[line - 1]!.search(new RegExp(`\\b${name}\\b`));
    if (column < 0) return undefined;
    return { name, from: lineStart + column, to: lineStart + column + name.length, kind, scope, text: lines[line - 1]!.trim() };
  };
  const roleDefinition = (enumeration: string, name: string) => {
    const value = parsed.index.enums[enumeration]?.values[name];
    if (value) return at(value, name, "AccessEnumValue", enumeration);
    // Exact matrix rows have one definition. A value-authored permission can have several.
    for (let i = directives.length - 1; i >= 0; i--) {
      const directive = directives[i]!;
      const { target, rule } = directive;
      if (!("enumeration" in target) || target.enumeration !== enumeration) continue;
      const token = rule?.kind === "permission" && rule.name.text === name ? rule.name
        : rule?.kind === "role" ? rule.holds.find(item => item.text === name && !(ACTIONS as readonly string[]).includes(name)) : undefined;
      if (!token) continue;
      const from = directive.offsets[token.from]!, to = directive.offsets[token.to - 1]! + 1;
      return { name, from, to, kind: "AccessPermission", scope: enumeration, text: lines[source.slice(0, from).split("\n").length - 1]!.trim() };
    }
  };
  for (const directive of directives) {
    const first = directive.offsets[0], last = directive.offsets[directive.offsets.length - 1];
    if (!directive.rule || first === undefined || last === undefined || offset < first || offset > last + 1) continue;
    const found = directive.offsets.findIndex((position) => position >= offset);
    const position = found < 0 ? directive.args.length : found;
    const tokens = tokenize(directive.args).tokens;
    const token = tokens.find((item) => position >= item.from && position <= item.to && item.kind === "name");
    if (!token) return undefined;
    const name = token.text;
    const previous = tokens[tokens.indexOf(token) - 1], before = tokens[tokens.indexOf(token) - 2];
    const { target, rule } = directive;
    if ("enumeration" in target) return roleDefinition(target.enumeration, name);
    const model = target.model;
    const fields = parsed.index.models[model]?.fields ?? {};
    if (rule.kind === "scope" && rule.roles) {
      const binding = rule.roles;
      const membership = parsed.policy.models[model]?.fields[binding.relation.text]?.type;
      if (membership && [binding.actor?.field, binding.filter?.field, binding.field].some(field => field?.from === token.from)) {
        return at(parsed.index.models[membership]?.fields[name], name, "FieldDeclaration", membership);
      }
    }
    if (rule.kind === "fieldGroup" && token.from === rule.key.from) return undefined;
    if (previous?.text === "." && before?.kind === "name") {
      const relation = parsed.policy.models[model]?.fields[before.text];
      const related = relation?.relation ? relation.type : undefined;
      if (related && parsed.index.models[related]?.fields[name]) return at(parsed.index.models[related]!.fields[name], name, "FieldDeclaration", related);
      const enumeration = related ? scopeEnumeration({ parsed }, related) : undefined;
      return enumeration ? roleDefinition(enumeration, name) : undefined;
    }
    if (fields[name]) return at(fields[name], name, "FieldDeclaration", model);
    const enumeration = scopeEnumeration({ parsed }, model);
    if (enumeration) {
      const found = roleDefinition(enumeration, name);
      if (found) return found;
    }
    const policyFields = parsed.policy.models[model]?.fields ?? {};
    const names = target.kind === "field" ? [target.field] : rule.kind === "fieldGroup" ? rule.columns.map(({ text }) => text) : [];
    const type = policyFields[names[0] ?? ""]?.type;
    const valueEnum = type && names.every((field) => policyFields[field]?.type === type) ? type : undefined;
    const values = valueEnum ? parsed.index.enums[valueEnum]?.values : undefined;
    if (valueEnum && values?.[name]) return at(values[name], name, "AccessEnumValue", valueEnum);
    return undefined;
  }
  return undefined;
}

/**
 * Prisma Access: `/// @access(…)` directives in prisma/contract.prisma, resolved.
 *
 * Directives sit directly above what they govern; several may be stacked, one
 * rule each (syntax: scripts/access-syntax.ts). Allow rules add access, and
 * `deny`, `only`, `readonly`, `serverOnly` and `protected` only take it away.
 *
 * | Above        | Directive                                      | Meaning                                                    |
 * | ------------ | ---------------------------------------------- | ---------------------------------------------------------- |
 * | model        | `read, update(name): ownerId == auth.id`       | Who may do what, optionally limited to columns             |
 * | model        | `roles: memberships[status=ACTIVE].role`       | A role scope: the actor's matching membership holds a role  |
 * | model        | `from: workspace`                              | Inherits exactly one to-one parent's scope, caps and denies |
 * | model        | `only: [read, update]`                         | Caps the role-mask actions here and below; never grants    |
 * | model        | `deny read: status == DRAFT && !createCase`    | Hides rows here and below; deny always wins                |
 * | enum         | `inviteMembers: [OWNER, ADMIN]`, `read: […]`    | Names every role that holds this ability or action         |
 * | enum value   | `...EDITOR, delete, inviteMembers, protected`  | A role: a lower role, CRUD actions, abilities; protection  |
 * | scalar field | `readonly` or `serverOnly`                     | Never client-assigned / never in the client API            |
 * | scalar field | `write: …`, `PENDING -> DONE: …`               | Who may assign it; which states it may move between        |
 *
 * Models with `roles:` or `from:` (or a single identity read) resolve here into
 * a scope path. Models with allow rules lower through scripts/access-rules.ts.
 * Both produce the policy structures scripts/client-access.ts validates and the
 * runtime enforces. Commands, the writes no rule grants, come from the access
 * policy module.
 *
 * Self-contained and dependency-free, like client-access.ts: Studio's editor
 * reads directives through the same code as the generator.
 */
import type { AccessGrant, EnumPolicy, FieldAccessMode, FieldInfo, ModelInfo, RowFilter, RowFilterValue, RowRule, Scanned, WriteVerb } from "./client-access.js";
import { ACTIONS, SyntaxProblem, normalizedRule, parseRule, readDirectives, type Expression, type Name, type Rule, type Span } from "./access-syntax.js";
import { isPrincipalLink, lowerRules, type CoreRule, type Lowered, type WrittenRule } from "./access-rules.js";

export const GRAPH_ACTIONS = ACTIONS;
export type GraphAction = (typeof GRAPH_ACTIONS)[number];
type WriteAction = Exclude<GraphAction, "read">;
const WRITE_ACTIONS: readonly WriteAction[] = ["create", "update", "delete"];

// ─── The access policy module, compiled ──────────────────────────────────────

/** A deny rule's complement, as data: conditions on this row's enum or Boolean fields and on the actor's role in its scope. */
export type GuardExpression =
  | { readonly kind: "field"; readonly field: string; readonly in: readonly (string | boolean)[]; readonly negated?: true }
  | { readonly kind: "role"; readonly in: readonly string[] }
  | { readonly kind: "permission"; readonly name: string }
  | { readonly kind: "and" | "or"; readonly of: readonly GuardExpression[] }
  | { readonly kind: "not"; readonly of: GuardExpression };

/** Who may still read `model`'s rows once its deny rules apply. It grants nothing and writes nothing. */
export interface GuardDefinition {
  readonly model: string;
  readonly where: GuardExpression;
}

/** One row a command creates, updates or deletes, and what it may assign. */
export interface CommandWrite {
  readonly model: string;
  readonly verb: WriteVerb;
  /** The client-supplied fields it may assign. */
  readonly fields?: readonly string[];
  /** The row's state it requires: stored for update and delete, proposed for create. */
  readonly when?: RowFilter;
  /** Per field, the values it may assign. */
  readonly to?: Readonly<Record<string, RowFilterValue>>;
}

/** A typed application command: who may run it in the row's scope, and exactly which rows and fields it writes. */
export interface CommandDefinition {
  /** Schema-local commands account for every ORM write in their transaction. */
  readonly closed?: true;
  /** `authenticated`, `owner`, a role or a named ability of the scope's role enum. */
  readonly who: string;
  readonly writes: readonly CommandWrite[];
}

/** What the access policy module contributes, as data. */
export interface AccessModules {
  /** The model `auth.id` identifies. Defaults to `User`. */
  readonly principal?: string;
  readonly commands?: Readonly<Record<string, CommandDefinition>>;
}

// ─── The artifact ────────────────────────────────────────────────────────────

/** A model's resolved scope. */
export interface GraphModel {
  readonly base: "read" | "roles" | "from";
  /** `read:` the fields compared with auth.id. */
  readonly identity?: readonly string[];
  /** `roles:` where the actor's role comes from. */
  readonly roles?: {
    readonly relation: string;
    readonly membership: string;
    readonly principal: string;
    readonly filter?: Readonly<Record<string, string>>;
    readonly field: string;
    readonly enumeration: string;
  };
  /** `from:` the parent relation. */
  readonly from?: string;
  /** This model, then each parent up to the scope or identity root. */
  readonly path: readonly string[];
  /** The model whose memberships decide roles; absent below an identity root. */
  readonly scope?: string;
  readonly enumeration?: string;
  readonly only?: readonly GraphAction[];
  /** Deny rules on the path: this model's own first, then its ancestors'. */
  readonly guards: readonly { readonly name: string; readonly model: string }[];
  /** Per action, the roles (enum symbols) that hold it here; `owner` for an identity-rooted read. */
  readonly actions: Readonly<Record<GraphAction, readonly string[]>>;
  /** Field protections the directives and principal links add. */
  readonly fields: Readonly<Record<string, "readonly" | "serverOnly" | "actor">>;
}

export interface GraphGuard extends GuardDefinition {
  readonly scope?: string;
  /** Who may still read, in disjunctive normal form: any one disjunct lets a reader through. */
  readonly disjuncts: readonly { readonly row?: RowFilter; readonly roles?: readonly string[] }[];
}

export interface GraphFieldRule {
  readonly mode?: "readonly" | "serverOnly";
  /** At least one validated scalar must equal the authenticated principal's key. */
  readonly readIdentity?: readonly string[];
}

export interface AccessGraph {
  readonly version: 2;
  readonly principal?: string;
  readonly enums: Readonly<Record<string, {
    readonly masks: Readonly<Record<string, readonly GraphAction[]>>;
    readonly permissions: Readonly<Record<string, readonly string[]>>;
    readonly unassignable: readonly string[];
    /** Per value, the lower roles it names (`...EDITOR`). */
    readonly includes?: Readonly<Record<string, readonly string[]>>;
  }>>;
  readonly models: Readonly<Record<string, GraphModel>>;
  readonly fieldRules?: Readonly<Record<string, Readonly<Record<string, GraphFieldRule>>>>;
  /** Models governed by allow rules: each rule as written, normalized. */
  readonly rules?: Readonly<Record<string, { readonly model: readonly string[]; readonly fields: Readonly<Record<string, readonly string[]>> }>>;
  readonly guards: Readonly<Record<string, GraphGuard>>;
  readonly commands: Readonly<Record<string, CommandDefinition>>;
  /** Where each directive is written. Navigation only: never part of the fingerprint. */
  readonly provenance: {
    readonly models: Readonly<Record<string, { readonly line: number; readonly column: number }>>;
    readonly enums: Readonly<Record<string, { readonly line: number }>>;
    readonly commands?: Readonly<Record<string, readonly CommandLocation[]>>;
  };
}

interface CommandLocation {
  readonly model: string;
  readonly verb: WriteVerb;
  readonly line: number;
  readonly column: number;
}

// ─── Reading directives ──────────────────────────────────────────────────────

export interface GraphProblem {
  readonly line: number;
  readonly column?: number;
  readonly code: string;
  readonly message: string;
}

export type Target =
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "enum"; readonly enumeration: string }
  | { readonly kind: "value"; readonly enumeration: string; readonly value: string }
  | { readonly kind: "field"; readonly model: string; readonly field: string };

export interface GraphDirective {
  /** 1-based line and column of `@access`. */
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  /** Offsets delimiting the comment marker and the @access call, exclusive at the end. */
  readonly commentFrom: number;
  readonly from: number;
  readonly to: number;
  readonly inline?: true;
  readonly target: Target;
  /** The text between the parentheses. */
  readonly args: string;
  /** Source offset of each character of `args`. */
  readonly offsets: readonly number[];
}

/** 1-based line and column of a source offset. */
export function sourcePosition(source: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === "\n") starts.push(index + 1);
  return (offset) => {
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle; else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  };
}

/** Every directive in `source`, attached to the declaration it governs. */
export function scanDirectives(source: string, scanned: Scanned, report: (problem: GraphProblem) => void): GraphDirective[] {
  const lines = source.split(/\r?\n/);
  const targets = new Map<number, Target>();
  for (const model of scanned.models.values()) {
    targets.set(model.line, { kind: "model", model: model.name });
    for (const field of model.fields.values()) targets.set(field.line, { kind: "field", model: model.name, field: field.name });
  }
  for (const enumeration of scanned.enums.values()) {
    targets.set(enumeration.line, { kind: "enum", enumeration: enumeration.name });
    for (const [value, info] of enumeration.values) targets.set(info.line, { kind: "value", enumeration: enumeration.name, value });
  }
  const directives: GraphDirective[] = [];
  for (const found of readDirectives(source)) {
    if (found.error) { report({ line: found.line, column: found.column, code: found.error.code, message: found.error.message }); continue; }
    let declaration = found.line;
    if (!found.inline) {
      declaration = found.endLine + 1;
      while (lines[declaration - 1]?.trimStart().startsWith("///")) declaration++;
    }
    const target = targets.get(declaration);
    if (found.inline && target?.kind !== "field" && target?.kind !== "value") {
      report({ line: found.line, column: found.column, code: "AG-PLACEMENT", message: "A trailing /// @access(…) belongs to the field or enum value on that line. Put model and enum rules directly above their declaration." });
      continue;
    }
    if (!target) {
      report({ line: found.line, column: found.column, code: "AG-STRAY", message: "Put /// @access(…) directly above a model, a scalar field, an enum or an enum value. Nothing it could govern follows it." });
      continue;
    }
    const { line, column, endLine, commentFrom, from, to, offsets } = found;
    directives.push({ line, column, endLine, commentFrom, from, to, offsets, ...(found.inline ? { inline: true } : {}), target, args: found.text });
  }
  return directives;
}

// ─── Deny rules in disjunctive normal form ───────────────────────────────────

interface Disjunct {
  readonly fields: Map<string, Set<string | boolean>>;
  readonly roles: Set<string> | null;
}

interface GuardScope {
  /** A field's values; null among them for an optional field. */
  readonly domain: (field: string) => readonly (string | boolean | null)[] | undefined;
  readonly roles: readonly string[];
  readonly permissions: Readonly<Record<string, readonly string[]>>;
}

const MAX_DISJUNCTS = 8;

function dnf(expression: GuardExpression, scope: GuardScope, negated = false): Disjunct[] {
  const complement = <T,>(all: readonly T[], set: Set<T>) => new Set(all.filter((item) => !set.has(item)));
  switch (expression.kind) {
    case "field": {
      const domain = (scope.domain(expression.field) ?? []) as readonly (string | boolean)[];
      let allowed = new Set<string | boolean>(expression.in);
      if (expression.negated) allowed = complement(domain, allowed);
      if (negated) allowed = complement(domain, allowed);
      return [{ fields: new Map([[expression.field, allowed]]), roles: null }];
    }
    case "role":
    case "permission": {
      let allowed = new Set(expression.kind === "role" ? expression.in : scope.permissions[expression.name] ?? []);
      if (negated) allowed = complement(scope.roles, allowed);
      return [{ fields: new Map(), roles: allowed }];
    }
    case "not":
      return dnf(expression.of, scope, !negated);
    case "and":
    case "or": {
      const conjunction = (expression.kind === "and") !== negated;
      const parts = expression.of.map((part) => dnf(part, scope, negated));
      if (!conjunction) return parts.flat();
      let product: Disjunct[] = [{ fields: new Map(), roles: null }];
      for (const part of parts) {
        const next: Disjunct[] = [];
        for (const left of product) {
          for (const right of part) {
            const fields = new Map(left.fields);
            for (const [field, values] of right.fields) {
              const current = fields.get(field);
              fields.set(field, current ? new Set([...current].filter((value) => values.has(value))) : values);
            }
            const roles = left.roles && right.roles ? new Set([...left.roles].filter((role) => right.roles!.has(role))) : left.roles ?? right.roles;
            next.push({ fields, roles });
          }
        }
        product = next;
      }
      return product;
    }
  }
}

/**
 * A disjunct's row conditions as a core filter, or undefined when it has
 * none. An optional field's domain includes null, which only `{ not }` matches:
 * a set that needs null otherwise is narrowed to its values, failing closed.
 */
function rowFilter(disjunct: Disjunct, scope: GuardScope): RowFilter | undefined {
  const filter: Record<string, RowFilterValue> = {};
  for (const [field, allowed] of disjunct.fields) {
    const domain = scope.domain(field) ?? [];
    if (domain.every((value) => allowed.has(value as string | boolean))) continue;
    const values = domain.filter((value): value is string | boolean => value !== null && allowed.has(value));
    const others = domain.filter((value) => !allowed.has(value as string | boolean));
    if (others.length === 1 && others[0] !== null) filter[field] = { not: others[0]! };
    else if (values.length === 1) filter[field] = values[0]!;
    else filter[field] = { in: values as string[] };
  }
  return Object.keys(filter).length ? filter : undefined;
}

// ─── Lowering ────────────────────────────────────────────────────────────────

export interface GraphLowering {
  /** Models whose scope resolves here (roles:, from:, a single identity read). */
  readonly models: ReadonlySet<string>;
  /** Enums whose values carry roles. */
  readonly enums: ReadonlySet<string>;
  readonly principal?: string;
  readonly rules: ReadonlyMap<string, readonly RowRule[]>;
  readonly roleFields: ReadonlyMap<string, { readonly field: string; readonly enumeration: string; readonly line: number }>;
  /** Membership models: the relation naming their user, so `members` rules can match the actor. */
  readonly principals: Readonly<Record<string, { readonly relation: string; readonly fields: readonly string[] }>>;
  readonly settings: Readonly<Record<string, Readonly<Record<string, FieldAccessMode>>>>;
  readonly grants: ReadonlyMap<string, Partial<Record<WriteAction, readonly AccessGrant[]>>>;
  /** Models whose rows are created only where the actor would see them: every `from:` model. */
  readonly strict: ReadonlySet<string>;
  readonly enumGrants: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly enumAssignable: Readonly<Record<string, readonly string[]>>;
  /** Models and enums with retired `// @access` rules. */
  readonly legacy: ReadonlySet<string>;
  /** Allow-rule models, lowered into core rules that scripts/client-access.ts reads. */
  readonly core: ReadonlyMap<string, Lowered>;
  graph: AccessGraph;
}

type Join = (model: ModelInfo, field: FieldInfo) => { readonly local: readonly string[]; readonly target: readonly string[] } | undefined;

const hasLegacy = (model: ModelInfo) => model.rules.length > 0 || [...model.fields.values()].some((field) => field.access);

interface Parsed {
  readonly directive: GraphDirective;
  readonly rule: Rule;
  /** Offset where an expanded field group's rule begins. Its AST spans still use the full directive. */
  readonly bodyFrom?: number;
}

interface ScopeModel {
  readonly read?: readonly Name[];
  readonly roles?: { readonly relation: string; readonly actor?: Name; readonly filter?: { readonly field: string; readonly value: string }; readonly field: string };
  readonly from?: string;
  readonly only?: readonly GraphAction[];
  /** Deny rules, combined: rows are hidden when any holds. */
  readonly deny?: { readonly when: readonly { readonly expression: Expression; readonly parsed: Parsed }[] };
}

const RESERVED = new Set(["owner", "anyone", "member", "authenticated", "protected", "readonly", "serverOnly", "write", "auth", "deny", "roles", "from", "only"]);

/** Directives resolved against the schema and lowered into core policy structures. */
export function lowerAccessGraph(source: string, scanned: Scanned, schemaEnums: Readonly<Record<string, EnumPolicy>>, modules: AccessModules | undefined, join: Join, report: (problem: GraphProblem) => void, legacyPrincipal?: string): GraphLowering {
  const directives = scanDirectives(source, scanned, report);
  const position = sourcePosition(source);
  const legacy = new Set<string>();
  for (const model of scanned.models.values()) if (hasLegacy(model)) legacy.add(model.name);
  for (const enumeration of scanned.enums.values()) {
    if (enumeration.rules.length || [...enumeration.values.values()].some((value) => value.access)) legacy.add(enumeration.name);
  }

  const fail = (directive: Pick<GraphDirective, "line" | "column">, code: string, message: string) => report({ line: directive.line, column: directive.column, code, message });
  /** The source position of a span of a directive's text. */
  const spanAt = (directive: GraphDirective, span: Span) => {
    const offset = directive.offsets[Math.min(Math.max(span.from, 0), directive.offsets.length - 1)];
    return offset === undefined ? { line: directive.line, column: directive.column } : position(offset);
  };
  const failAt = (directive: GraphDirective, span: Span, code: string, message: string) => report({ ...spanAt(directive, span), code, message });

  // ── Parse every directive for what it governs.
  const onModel = new Map<string, Parsed[]>();
  const commands = new Map<string, { who: string; writes: CommandWrite[]; closed: true }>();
  const commandLocations = new Map<string, CommandLocation[]>();
  const onEnum = new Map<string, { directive: GraphDirective; rule: Extract<Rule, { kind: "permission" }> }[]>();
  const onValue = new Map<string, Map<string, Parsed>>();
  const onField = new Map<string, Map<string, Parsed[]>>();
  const addFieldRule = (model: string, field: string, parsed: Parsed) => {
    const fields = onField.get(model) ?? onField.set(model, new Map()).get(model)!;
    (fields.get(field) ?? fields.set(field, []).get(field)!).push(parsed);
  };
  for (const directive of directives) {
    let rule: Rule;
    try { rule = parseRule(directive.args, directive.target.kind); }
    catch (error) {
      if (error instanceof SyntaxProblem) { failAt(directive, error.at, error.code, error.message); continue; }
      throw error;
    }
    const { target } = directive;
    if (target.kind === "model") {
      if (rule.kind === "command") {
        const name = rule.name.text;
        const who = rule.who.text;
        const verb = rule.grant.action.text as WriteVerb;
        const bad = (token: Name, message: string) => failAt(directive, token, "AG-COMMAND-DIRECTIVE", message);
        if (!/^[a-z]\w*$/.test(name)) { bad(rule.name, "A command name starts with a lowercase letter."); continue; }
        if (modules?.commands && Object.prototype.hasOwnProperty.call(modules.commands, name)) { bad(rule.name, `${name} is also declared in prisma/access. Define each command in one place.`); continue; }
        const command = commands.get(name) ?? { who, writes: [], closed: true };
        if (who !== command.who) { bad(rule.who, `Every write of ${name} must use the same audience, ${command.who}.`); continue; }
        if (command.writes.some((write) => write.model === target.model && write.verb === verb)) {
          bad(rule.grant.action, `${name} already declares ${verb} on ${target.model}. List each model and verb once.`);
          continue;
        }
        const fields = rule.grant.columns?.map((column) => column.text);
        const when = new Map<string, RowFilterValue>();
        let valid = true;
        for (const { field, value } of rule.states) {
          if (when.has(field.text)) { bad(field, `${name} compares ${field.text} more than once. Give each field one required value.`); valid = false; }
          const column = scanned.models.get(target.model)!.fields.get(field.text);
          if (column?.list) { bad(field, `${field.text} is a list. Compare one local enum or Boolean field to a value.`); valid = false; }
          const boolean = column?.type === "Boolean";
          when.set(field.text, boolean && (value.text === "true" || value.text === "false") ? value.text === "true" : value.text);
        }
        if (!valid) continue;
        command.writes.push({ model: target.model, verb, ...(fields?.length ? { fields } : {}), ...(when.size ? { when: Object.fromEntries(when) } : {}) });
        commands.set(name, command);
        const locations = commandLocations.get(name) ?? [];
        locations.push({ model: target.model, verb, line: directive.line, column: directive.column });
        commandLocations.set(name, locations);
        continue;
      }
      if (rule.kind !== "fieldGroup") {
        (onModel.get(target.model) ?? onModel.set(target.model, []).get(target.model)!).push({ directive, rule });
        continue;
      }
      const model = scanned.models.get(target.model)!;
      for (const column of rule.columns) {
        const info = model.fields.get(column.text);
        if (!info || info.relation) {
          failAt(directive, column, "AG-COLUMN", !info
            ? `${model.name} has no field named ${column.text}. List the model's Prisma field names in fields(…).`
            : `${model.name}.${column.text} is a relation. List only scalar or enum fields in fields(…).`);
          continue;
        }
        addFieldRule(target.model, column.text, { directive, rule: rule.rule, bodyFrom: rule.bodyFrom });
      }
    } else if (target.kind === "field") {
      addFieldRule(target.model, target.field, { directive, rule });
    } else if (target.kind === "enum" && rule.kind === "permission") {
      const rows = onEnum.get(target.enumeration) ?? [];
      rows.push({ directive, rule });
      onEnum.set(target.enumeration, rows);
    } else if (target.kind === "value") {
      const values = onValue.get(target.enumeration) ?? onValue.set(target.enumeration, new Map()).get(target.enumeration)!;
      if (values.has(target.value)) { fail(directive, "AG-DUPLICATE", `${target.enumeration}.${target.value} already has a directive. List everything the role holds in one: /// @access(...LOWER, read, ability).`); continue; }
      values.set(target.value, { directive, rule });
    }
  }
  const enumValues = (name: string) => [...(scanned.enums.get(name)?.values.keys() ?? [])];

  // ── Roles: value grants can include lower roles. Permission rows list exact holders.
  const masks = new Map<string, Map<string, GraphAction[]>>();
  const enumGrants: Record<string, Record<string, readonly string[]>> = {};
  const enumAssignable: Record<string, readonly string[]> = {};
  const enumIncludes: Record<string, Record<string, readonly string[]>> = {};
  for (const enumeration of new Set([...onEnum.keys(), ...onValue.keys()])) {
    const values = onValue.get(enumeration) ?? new Map<string, Parsed>();
    const rows = onEnum.get(enumeration) ?? [];
    const info = scanned.enums.get(enumeration)!;
    const all = enumValues(enumeration);
    const roles = new Map<string, Extract<Rule, { kind: "role" }>>();
    for (const [value, { rule }] of values) roles.set(value, rule as Extract<Rule, { kind: "role" }>);
    const isRoleEnum = rows.length > 0 || [...roles.values()].some((rule) => rule.includes.length || rule.holds.length);
    const protectedValues = all.filter((value) => roles.get(value)?.flags.some((flag) => flag.text === "protected"));
    if (legacy.has(enumeration)) {
      fail(rows[0]?.directive ?? [...values.values()][0]!.directive, "AG-MIXED", `${enumeration} also has retired // @access rules. Declare its roles and protected values in /// @access(…) directives only.`);
      continue;
    }
    enumAssignable[enumeration] = all.filter((value) => !protectedValues.includes(value));
    enumGrants[enumeration] = {};
    if (!isRoleEnum) continue;

    // Abilities, in the order they are first written.
    const order: string[] = [];
    let valid = true;
    const namedAbility = (name: string) => /^[a-z]\w*$/.test(name) && !RESERVED.has(name) && !all.includes(name);
    const isAction = (name: string): name is GraphAction => (ACTIONS as readonly string[]).includes(name);
    const rowGrants = new Map<string, string[]>();
    // A CRUD row above the enum (`read: [OWNER, ADMIN]`) names that action's exact holders,
    // like an ability row: role inclusion never adds a holder to it.
    const actionRows = new Map<GraphAction, { directive: GraphDirective; holders: ReadonlySet<string> }>();
    for (const { directive, rule } of rows) {
      const ability = rule.name.text;
      if (!isAction(ability) && !namedAbility(ability)) {
        failAt(directive, rule.name, "AG-ACTION", `"${ability}" is not a permission. Name an action (read, create, update, delete) or a lowerCamel ability such as inviteMembers.`);
        valid = false;
      }
      if (rowGrants.has(ability) || (isAction(ability) && actionRows.has(ability))) {
        failAt(directive, rule.name, "AG-DUPLICATE", `${enumeration} already declares ${ability}. List all of its roles in one permission row.`);
        valid = false;
      }
      const holders = new Set<string>();
      for (const role of rule.roles) {
        if (!all.includes(role.text)) {
          failAt(directive, role, "AG-ROLE", `${role.text} is not a value of ${enumeration}. Choose from ${all.join(", ")}.`);
          valid = false;
        } else if (holders.has(role.text)) {
          failAt(directive, role, "AG-DUPLICATE", `${ability} lists ${role.text} twice.`);
          valid = false;
        }
        holders.add(role.text);
      }
      if (isAction(ability)) { if (!actionRows.has(ability)) actionRows.set(ability, { directive, holders }); }
      else rowGrants.set(ability, all.filter((role) => holders.has(role)));
    }
    for (const value of all) {
      const parsed = values.get(value);
      if (!parsed) {
        if (!rows.length) {
          report({ line: info.values.get(value)!.line, code: "AG-ROLE-UNANNOTATED", message: `${enumeration}.${value} has no actions. Every value of a role declared only on its values says what it holds: /// @access(read), or /// @access() for nothing.` });
          valid = false;
        }
        continue;
      }
      const rule = roles.get(value)!;
      const seen = new Set<string>();
      for (const item of [...rule.includes, ...rule.holds]) {
        if (seen.has(item.text)) { failAt(parsed.directive, item, "AG-DUPLICATE", `${enumeration}.${value} lists ${item.text} twice.`); valid = false; }
        seen.add(item.text);
      }
      for (const include of rule.includes) {
        if (!all.includes(include.text)) { failAt(parsed.directive, include, "AG-ROLE-INCLUDE", `...${include.text}: ${include.text} is not a ${enumeration} value. Include one of ${all.filter((item) => item !== value).join(", ")}.`); valid = false; }
      }
      for (const item of rule.holds) {
        if (isAction(item.text)) {
          if (actionRows.has(item.text)) {
            failAt(parsed.directive, item, "AG-MIXED", `${enumeration} already lists the holders of ${item.text} above the enum. Remove ${item.text} from this role and edit its permission row.`);
            valid = false;
          }
          continue;
        }
        if (all.includes(item.text)) { failAt(parsed.directive, item, "AG-ROLE-INCLUDE", `${item.text} is a role. Include it with ...${item.text}.`); valid = false; continue; }
        if (!namedAbility(item.text)) { failAt(parsed.directive, item, "AG-ACTION", `"${item.text}" is not an action or an ability. Actions are read, create, update and delete; an ability is a lowerCamel name, such as inviteMembers.`); valid = false; continue; }
        if (rowGrants.has(item.text)) {
          failAt(parsed.directive, item, "AG-MIXED", `${enumeration} already lists the holders of ${item.text} above the enum. Remove the ability from this role and edit its permission row.`);
          valid = false;
          continue;
        }
        if (!order.includes(item.text)) order.push(item.text);
      }
    }
    if (!valid) continue;
    const resolved = new Map<string, Set<string>>();
    const visiting: string[] = [];
    const resolve = (value: string): Set<string> | undefined => {
      if (resolved.has(value)) return resolved.get(value);
      if (visiting.includes(value)) {
        const parsed = values.get(value)!;
        fail(parsed.directive, "AG-CYCLE", `Roles include each other in a circle: ${[...visiting.slice(visiting.indexOf(value)), value].join(" → ")}.`);
        return undefined;
      }
      visiting.push(value);
      const rule = roles.get(value);
      const held = new Set(rule?.holds.map((item) => item.text));
      for (const include of rule?.includes ?? []) {
        const lower = resolve(include.text);
        if (!lower) { visiting.pop(); return undefined; }
        for (const item of lower) held.add(item);
      }
      visiting.pop();
      resolved.set(value, held);
      return held;
    };
    const mask = new Map<string, GraphAction[]>();
    for (const value of all) {
      const held = resolve(value);
      if (!held) { valid = false; break; }
      const list = GRAPH_ACTIONS.filter((action) => held.has(action) || actionRows.get(action)?.holders.has(value));
      if (list.length && !list.includes("read")) {
        // Point at what granted the write: the role's own directive, or else the row that lists it.
        const ownWrite = WRITE_ACTIONS.some((action) => held.has(action));
        const row = [...actionRows].find(([action, { holders }]) => action !== "read" && holders.has(value))?.[1].directive;
        const at = (ownWrite ? values.get(value)?.directive : row) ?? values.get(value)?.directive ?? row!;
        fail(at, "AG-MASK-READ", `${enumeration}.${value} may ${list.join(", ")} without read. A role acts only on rows it can read: add read.`);
        valid = false;
        continue;
      }
      mask.set(value, list);
    }
    if (!valid) continue;
    masks.set(enumeration, mask);
    for (const ability of order) rowGrants.set(ability, all.filter((value) => resolved.get(value)!.has(ability)));
    enumGrants[enumeration] = Object.fromEntries(rowGrants);
    enumIncludes[enumeration] = Object.fromEntries(all.map((value) => [value, roles.get(value)?.includes.map((include) => include.text) ?? []]));
  }
  for (const enumeration of Object.keys(enumAssignable)) {
    if (!masks.has(enumeration) && Object.keys(schemaEnums[enumeration]?.grants ?? {}).length) {
      fail([...onValue.get(enumeration)!.values()][0]!.directive, "AG-MIXED", `${enumeration} also names abilities in retired // @access lines. Write them on the values: /// @access(...LOWER, ability).`);
    }
  }

  // ── Principal: the model auth.id identifies.
  const anyDirective = onModel.size > 0 || onField.size > 0;
  const principalName = anyDirective ? modules?.principal ?? (scanned.models.has("User") ? "User" : undefined) : modules?.principal;
  const principal = scanned.models.get(principalName ?? legacyPrincipal ?? "");
  const policyProblem = (message: string) => report({ line: 1, code: "AG-POLICY", message: `prisma/access: ${message}` });
  if (principalName && !principal) policyProblem(`The principal model ${principalName} is not in contract.prisma.`);
  // Without a principal, any rule that compares with auth reports AG-PRINCIPAL where it is written.

  // ── Route each model: a scope (roles:, from:, one identity read) or allow rules.
  const scopes = new Map<string, ScopeModel>();
  const ruleModels = new Map<string, Parsed[]>();
  const firstOf = (list: readonly Parsed[]) => list[0]!.directive;
  const principalKey = principal?.key.length === 1 ? principal.key[0] : undefined;
  /** `a == auth.id || b == auth.id`, and nothing else. */
  const identityOnly = (expression: Expression): Name[] | undefined => {
    if (expression.kind === "isMe") return principalKey ? [expression.field] : undefined;
    if (expression.kind === "identity") return !expression.negated && expression.field.length === 1 && expression.auth.text === principalKey ? [expression.field[0]!] : undefined;
    if (expression.kind !== "or") return undefined;
    const fields: Name[] = [];
    for (const part of expression.of) {
      const found = identityOnly(part);
      if (!found) return undefined;
      for (const field of found) if (!fields.some((item) => item.text === field.text)) fields.push(field);
    }
    return fields;
  };
  for (const [name, list] of onModel) {
    const first = firstOf(list);
    if (legacy.has(name)) { fail(first, "AG-MIXED", `${name} also has retired // @access rules. A model is governed by its directives alone: remove its // @access comments.`); continue; }
    const scopeRules = list.filter(({ rule }) => rule.kind === "scope");
    const denies = list.filter(({ rule }) => rule.kind === "deny");
    const allows = list.filter(({ rule }) => rule.kind === "allow");
    if (scopeRules.length > 1) { fail(scopeRules[1]!.directive, "AG-DUPLICATE", `${name} already declares its scope. Write roles:, from: and only: in one directive.`); continue; }
    if (scopeRules.length) {
      const scope = scopeRules[0]!.rule as Extract<Rule, { kind: "scope" }>;
      const directive = scopeRules[0]!.directive;
      if (scope.roles && scope.from) { fail(directive, "AG-BASE", `A model takes exactly one of roles and from; ${name} says both.`); continue; }
      if (!scope.roles && !scope.from) { fail(directive, "AG-BASE", "only caps a role scope: write it beside roles: or from:."); continue; }
      let usable = true;
      for (const { directive: extra } of allows) { fail(extra, "AG-SCOPE-RULE", `${name}'s actions come from its role scope: each role's actions on the enum, capped by only:. For a named write, place a command directive above the model.`); usable = false; }
      for (const { directive: denied, rule } of denies) {
        const deny = rule as Extract<Rule, { kind: "deny" }>;
        const other = deny.grants.find((grant) => grant.action.text !== "read" || grant.columns);
        if (other) { failAt(denied, other.action, "AG-DENY-ACTION", "deny hides rows: write deny read: …. To stop a write, leave it out of the role masks with only:, or narrow its command."); usable = false; }
      }
      if (!usable) continue;
      scopes.set(name, {
        ...(scope.roles ? { roles: {
          relation: scope.roles.relation.text,
          ...(scope.roles.actor ? { actor: scope.roles.actor.field } : {}),
          ...(scope.roles.filter ? { filter: { field: scope.roles.filter.field.text, value: scope.roles.filter.value.text } } : {}),
          field: scope.roles.field.text,
        } } : {}),
        ...(scope.from ? { from: scope.from.relation.text } : {}),
        ...(scope.only ? { only: GRAPH_ACTIONS.filter((action) => scope.only!.actions.some((item) => item.text === action)) } : {}),
        ...(denies.length ? { deny: { when: denies.map((parsed) => ({ expression: (parsed.rule as Extract<Rule, { kind: "deny" }>).when, parsed })) } } : {}),
      });
      continue;
    }
    if (denies.length) { for (const { directive } of denies) fail(directive, "AG-DENY-SCOPE", `deny hides rows of a role scope. ${name} has none: narrow its allow rules with && instead.`); continue; }
    const fieldRules = [...(onField.get(name)?.values() ?? [])].flat();
    const plainFields = fieldRules.every(({ rule }) => rule.kind === "flags" || (rule.kind === "allow" && rule.grants.every((grant) => grant.action.text === "read") && identityOnly(rule.when)));
    const single = allows.length === 1 ? allows[0]!.rule as Extract<Rule, { kind: "allow" }> : undefined;
    const identity = single && single.grants.length === 1 && single.grants[0]!.action.text === "read" && !single.grants[0]!.columns ? identityOnly(single.when) : undefined;
    if (identity && plainFields) scopes.set(name, { read: identity });
    else ruleModels.set(name, allows);
  }

  // ── Fields of scope models, and of models with retired rules: protections and identity reads.
  const rules = new Map<string, RowRule[]>();
  const roleFields = new Map<string, { field: string; enumeration: string; line: number }>();
  const principals: Record<string, { relation: string; fields: readonly string[] }> = {};
  const settings: Record<string, Record<string, FieldAccessMode>> = {};
  const fieldRules: Record<string, Record<string, GraphFieldRule>> = {};
  const grants = new Map<string, Partial<Record<WriteAction, readonly AccessGrant[]>>>();
  const strict = new Set<string>();
  const models: Record<string, GraphModel> = {};
  const guards: Record<string, GraphGuard> = {};
  const provenance: Record<string, { line: number; column: number }> = {};
  const add = (model: string, rule: RowRule) => (rules.get(model) ?? rules.set(model, []).get(model)!).push(rule);
  const resolving = new Set<string>();
  const failed = new Set<string>();
  /** What children inherit: a scope's whole mask, even the create its own row never offers. */
  const templates = new Map<string, Readonly<Record<GraphAction, readonly string[]>>>();

  for (const [name, list] of onModel) provenance[name] = { line: firstOf(list).line, column: firstOf(list).column };

  // Use the same principal key and checked FK identity expression for both row and field reads.
  function identityRules(model: ModelInfo, fields: readonly Name[], directive: GraphDirective): RowRule[] | undefined {
    if (!principal) { fail(directive, "AG-PRINCIPAL", "read: compares with auth.id, but no principal model is known."); return undefined; }
    const owners: RowRule[] = [];
    for (const token of fields) {
      const field = token.text;
      if (model === principal && principal.key.length === 1 && principal.key[0] === field) continue;
      const link = [...model.fields.values()].find((candidate) => candidate.fields?.length === 1 && candidate.fields[0] === field && isPrincipalLink(model, candidate, principal));
      if (!link) { failAt(directive, token, "AG-READ-FIELD", `${model.name}.${field} must be ${principal.name}'s key or a foreign key to it.`); return undefined; }
      owners.push({ kind: "owner", relation: link.name, fields: link.fields! });
    }
    return owners;
  }

  for (const [name, fields] of onField) {
    if (ruleModels.has(name)) continue; // Lowered with the model's rules below.
    const model = scanned.models.get(name)!;
    for (const [field, list] of fields) {
      const info = model.fields.get(field)!;
      for (const { directive, rule } of list) {
        if (!onModel.has(name) && !legacy.has(name)) { fail(directive, "AG-FIELD-MODEL", `${name} needs a model directive before a field can narrow it.`); continue; }
        if (info.relation) { fail(directive, "AG-FIELD-RELATION", `${name}.${field} is a relation. Put scalar restrictions on the field they govern.`); continue; }
        if (info.access) { fail(directive, "AG-MIXED", `${name}.${field} has rules in both grammars. Declare the field with directives only.`); continue; }
        const entry: { mode?: "readonly" | "serverOnly"; readIdentity?: readonly string[] } = { ...(fieldRules[name]?.[field] ?? {}) };
        const flags = rule.kind === "flags" ? rule.flags : rule.kind === "allow" ? rule.flags ?? [] : [];
        let ok = true;
        for (const flag of flags) {
          if (entry.mode && entry.mode !== flag.text) { failAt(directive, flag, "AG-FIELD-RULE", "A scalar field takes at most one of readonly and serverOnly."); ok = false; }
          entry.mode = flag.text as "readonly" | "serverOnly";
        }
        if (rule.kind === "allow") {
          const identity = rule.grants.every((grant) => grant.action.text === "read") ? identityOnly(rule.when) : undefined;
          if (!identity) {
            fail(directive, scopes.has(name) ? "AG-SCOPE-FIELD" : "AG-FIELD-RULE", scopes.has(name)
              ? `${name}.${field} is in a role scope: its writes come from the role masks and commands. A field there takes readonly, serverOnly or read: field == auth.id.`
              : `Unknown scalar field rule. Use readonly, serverOnly, or read: field == auth.id.`);
            ok = false;
          } else if (entry.readIdentity) { fail(directive, "AG-DUPLICATE", "A scalar field takes one read expression."); ok = false; }
          else if (!identityRules(model, identity, directive)) ok = false;
          else entry.readIdentity = identity.map((field) => field.text);
        } else if (rule.kind === "transition") {
          fail(directive, "AG-SCOPE-FIELD", `${name}.${field} is in a role scope; declare its named writes in a command directive above the model.`);
          ok = false;
        }
        if (entry.mode === "serverOnly" && entry.readIdentity) { fail(directive, "AG-FIELD-RULE", "A serverOnly field has no client readers. Remove the read expression."); ok = false; }
        if (!ok) continue;
        (fieldRules[name] ??= {})[field] = entry;
        if (entry.mode) (settings[name] ??= {})[field] = entry.mode === "readonly" ? "read-only" : "server-only";
      }
    }
  }

  const resolve = (name: string): GraphModel | undefined => {
    if (models[name]) return models[name];
    if (failed.has(name)) return undefined;
    const parsed = scopes.get(name)!;
    const directive = firstOf(onModel.get(name)!);
    const model = scanned.models.get(name)!;
    const stop = (code: string, message: string) => { fail(directive, code, message); failed.add(name); return undefined; };
    if (resolving.has(name)) return stop("AG-CYCLE", `from: goes round in a circle through ${[...resolving].join(" → ")} → ${name}.`);
    resolving.add(name);
    try {
      const own: Record<string, "readonly" | "serverOnly" | "actor"> = {};
      let result: GraphModel | undefined;
      const none = { read: [] as string[], create: [] as string[], update: [] as string[], delete: [] as string[] };

      if (parsed.read) {
        const owners = identityRules(model, parsed.read, directive);
        if (!owners) { failed.add(name); return undefined; }
        for (const rule of owners) add(name, rule);
        result = { base: "read", identity: parsed.read.map((field) => field.text), path: [name], guards: [], actions: { ...none, read: ["owner"] }, fields: own };
      } else if (parsed.roles) {
        const relation = model.fields.get(parsed.roles.relation);
        if (!relation?.relation || !relation.list) return stop("AG-ROLES-RELATION", `${name}.${parsed.roles.relation} is not a list relation to a membership model.`);
        const membership = scanned.models.get(relation.type)!;
        const on = join(model, relation);
        if (!on) return stop("AG-ROLES-RELATION", `Cannot tell how ${name}.${relation.name} joins ${membership.name}. Name the relation on both sides.`);
        const actor = parsed.roles.actor;
        const links = [...membership.fields.values()].filter((field) => isPrincipalLink(membership, field, principal) && (!actor || (field.fields!.length === 1 && field.fields![0] === actor.text)));
        if (links.length !== 1) {
          if (!actor) return stop("AG-ROLES-PRINCIPAL", `${membership.name} has ${links.length} relations to ${principal?.name ?? "the principal"}. Name whose membership it is with isMe(personId) in the selector.`);
          failAt(directive, actor, "AG-ROLES-PRINCIPAL", `${membership.name}.${actor.text} must be a scalar foreign key to the key of ${principal?.name ?? "the configured principal"}.`);
          failed.add(name);
          return undefined;
        }
        const user = links[0]!;
        const previous = principals[membership.name];
        if (previous && previous.relation !== user.name) return stop("AG-ROLES-PRINCIPAL", `${membership.name} already identifies its member through ${previous.relation}. Every scope using this membership must select the same person.`);
        const pair = new Set([...on.target, ...user.fields!]);
        const unique = [membership.key, ...membership.compoundUniques].some((columns) => columns.length === pair.size && columns.every((column) => pair.has(column)));
        if (!unique) return stop("AG-ROLES-UNIQUE", `${membership.name} must allow one membership per user and ${name}: add @@unique([${[...pair].join(", ")}]).`);
        const filter = parsed.roles.filter;
        if (filter) {
          const column = membership.fields.get(filter.field);
          if (!column || column.relation || !scanned.enums.has(column.type)) return stop("AG-ROLES-FILTER", `${membership.name}.${filter.field} is not an enum field to filter on.`);
          if (!enumValues(column.type).includes(filter.value)) return stop("AG-ROLES-FILTER", `${filter.value} is not a ${column.type} value. Use one of ${enumValues(column.type).join(", ")}.`);
        }
        const roleField = membership.fields.get(parsed.roles.field);
        if (!roleField || roleField.relation || !scanned.enums.has(roleField.type)) return stop("AG-ROLES-FIELD", `${membership.name}.${parsed.roles.field} is not an enum field holding a role.`);
        const enumeration = roleField.type;
        const mask = masks.get(enumeration);
        if (!mask) return stop("AG-ROLES-MASK", `${enumeration} is a role enum: mark each value with what it holds, such as /// @access(read) or /// @access(...EDITOR, delete).`);
        const existing = roleFields.get(membership.name);
        if (existing && existing.field !== roleField.name) return stop("AG-ROLES-FIELD", `${membership.name} already gives roles through ${existing.field}.`);
        roleFields.set(membership.name, { field: roleField.name, enumeration, line: roleField.line });
        principals[membership.name] = { relation: user.name, fields: user.fields! };
        if (parsed.only && !parsed.only.includes("read")) return stop("AG-MASK-READ", "only: must include read. Actions on rows no one can read never apply.");
        const values = enumValues(enumeration);
        const eligibleRoles = filter?.field === roleField.name ? [filter.value] : values;
        const holding = (action: GraphAction) => eligibleRoles.filter((value) => mask.get(value)?.includes(action) && (!parsed.only || parsed.only.includes(action)));
        const template = { read: holding("read"), create: holding("create"), update: holding("update"), delete: holding("delete") };
        templates.set(name, template);
        const actions = { ...template, create: [] as string[] };
        if (!actions.read.length) return stop("AG-ROLES-NOREAD", `No ${enumeration} value may read ${name}, so no one can see it.`);
        const where: Record<string, RowFilterValue> = filter ? { [filter.field]: filter.value } : {};
        const roleFilter = (roles: readonly string[]) => (roles.length === values.length ? {} : { [roleField.name]: { in: values.filter((value) => roles.includes(value)) } });
        const lowered = (roles: readonly string[], row?: RowFilter): RowRule => ({
          kind: "members", relation: relation.name, model: membership.name, local: on.local, target: on.target,
          ...(Object.keys({ ...where, ...roleFilter(roles) }).length ? { where: { ...where, ...roleFilter(roles) } } : {}),
          ...(row ? { own: row } : {}),
        });
        const guard = parsed.deny ? denyDisjuncts(name, model, parsed.deny, enumeration) : undefined;
        if (parsed.deny && !guard) { failed.add(name); return undefined; }
        for (const disjunct of guard ?? [{ roles: undefined, row: undefined }]) {
          const roles = actions.read.filter((role) => !disjunct.roles || disjunct.roles.includes(role));
          if (roles.length) add(name, lowered(roles, disjunct.row));
        }
        const memberFilter: Record<string, string> | undefined = filter ? { [filter.field]: filter.value } : undefined;
        result = {
          base: "roles",
          roles: { relation: relation.name, membership: membership.name, principal: user.name, ...(memberFilter ? { filter: memberFilter } : {}), field: roleField.name, enumeration },
          path: [name], scope: name, enumeration, ...(parsed.only ? { only: parsed.only } : {}),
          guards: parsed.deny ? [{ name: `${name}.deny`, model: name }] : [],
          actions, fields: own,
        };
      } else {
        const relation = model.fields.get(parsed.from!);
        if (!relation?.relation || relation.list || !relation.fields?.length) return stop("AG-FROM-RELATION", `${name}.${parsed.from} must be a to-one relation that holds the foreign key, such as workspace Workspace @relation(fields: [workspaceId], references: [id]).`);
        if (relation.optional || relation.fields.some((column) => model.fields.get(column)?.optional)) return stop("AG-FROM-OPTIONAL", `${name}.${relation.name} is optional, so some rows would have no scope. Make it required, or give the model its own rules.`);
        const parent = relation.type;
        if (!scopes.has(parent)) {
          return stop(ruleModels.has(parent) ? "AG-FROM-RULES" : legacy.has(parent) ? "AG-FROM-LEGACY" : "AG-FROM-UNEXPOSED", ruleModels.has(parent)
            ? `${parent} says who may read it with allow rules, which from: cannot inherit. Follow it in an allow rule instead: read: ${relation.name}.read.`
            : legacy.has(parent)
              ? `${parent} still uses retired // @access rules. Give ${parent} a directive first.`
              : `${parent} has no directive, so it has no scope to inherit. Give ${parent} roles:, from: or a read rule.`);
        }
        const inherited = resolve(parent);
        if (!inherited) return stop("AG-FROM-PARENT", `${parent}'s policy is invalid; fix it first.`);
        const on = join(model, relation)!;
        if (parsed.only && !parsed.only.includes("read")) return stop("AG-MASK-READ", "only: must include read. Actions on rows no one can read never apply.");
        const inheritedTemplate = templates.get(parent) ?? inherited.actions;
        const cap = (action: GraphAction) => (!parsed.only || parsed.only.includes(action) ? inheritedTemplate[action] : []);
        const actions = inherited.scope
          ? { read: cap("read"), create: cap("create"), update: cap("update"), delete: cap("delete") }
          : { ...none, read: inherited.actions.read };
        let guard: { roles?: readonly string[]; row?: RowFilter }[] | undefined;
        if (parsed.deny) {
          if (!inherited.scope) { fail(directive, "AG-DENY-SCOPE", `deny hides rows of a role scope, and ${name} inherits an identity rule from ${inherited.path[inherited.path.length - 1]}.`); failed.add(name); return undefined; }
          guard = denyDisjuncts(name, model, parsed.deny, inherited.enumeration!);
          if (!guard) { failed.add(name); return undefined; }
        }
        const values = inherited.enumeration ? enumValues(inherited.enumeration) : [];
        for (const disjunct of guard ?? [{ roles: undefined, row: undefined }]) {
          const who = disjunct.roles && disjunct.roles.length < values.length ? values.filter((role) => disjunct.roles!.includes(role)) : undefined;
          add(name, {
            kind: "via", relation: relation.name, model: parent, local: on.local, target: on.target,
            ...(disjunct.row ? { own: disjunct.row } : {}),
            ...(who ? { who } : {}),
          });
        }
        strict.add(name);
        templates.set(name, actions);
        result = {
          base: "from", from: relation.name, path: [name, ...inherited.path],
          ...(inherited.scope ? { scope: inherited.scope, enumeration: inherited.enumeration! } : {}),
          ...(parsed.only ? { only: parsed.only } : {}),
          guards: [...(parsed.deny ? [{ name: `${name}.deny`, model: name }] : []), ...inherited.guards],
          actions, fields: own,
        };
      }

      // Field protections: directives, then principal links the client never sets.
      const modes: Record<string, FieldAccessMode> = settings[name] ?? {};
      for (const [field, rule] of Object.entries(fieldRules[name] ?? {})) if (rule.mode) own[field] = rule.mode;
      const ownerRelations = new Set((rules.get(name) ?? []).flatMap((rule) => (rule.kind === "owner" && "relation" in rule ? [rule.relation] : [])));
      for (const field of model.fields.values()) {
        if (!isPrincipalLink(model, field, principal) || ownerRelations.has(field.name)) continue;
        for (const column of field.fields!) if (!modes[column]) { modes[column] = "read-only"; own[column] = "actor"; }
      }
      if (Object.keys(modes).length) settings[name] = modes;

      // Write grants: the roles that hold each action here.
      if (result.scope) {
        const written: Partial<Record<WriteAction, AccessGrant[]>> = {};
        for (const action of WRITE_ACTIONS) {
          // A scope's own row is never created through its roles: it has no memberships yet.
          if (action === "create" && result.base === "roles") continue;
          if (result.actions[action].length) written[action] = [{ who: result.actions[action] }];
        }
        if (Object.keys(written).length) grants.set(name, written);
      }
      models[name] = result;
      return result;
    } finally {
      resolving.delete(name);
    }
  };

  /** A deny condition as data: this row's enum and Boolean fields, and roles or abilities in its scope. */
  function denyExpression(name: string, expression: Expression, parsed: Parsed, enumeration: string): GuardExpression | undefined {
    const values = enumValues(enumeration);
    const convert = (node: Expression): GuardExpression | undefined => {
      switch (node.kind) {
        case "or": case "and": {
          const of = node.of.map(convert);
          return of.every(Boolean) ? { kind: node.kind, of: of as GuardExpression[] } : undefined;
        }
        case "not": { const of = convert(node.of); return of ? { kind: "not", of } : undefined; }
        case "state": {
          if (node.field.length !== 1) { failAt(parsed.directive, node, "AG-DENY", `deny tests ${name}'s own fields and roles in its scope.`); return undefined; }
          const literal = (value: Name) => (value.text === "true" ? true : value.text === "false" ? false : value.text);
          return { kind: "field", field: node.field[0]!.text, in: node.values.map(literal), ...(node.negated ? { negated: true as const } : {}) };
        }
        case "name": {
          if (node.path.length !== 1) { failAt(parsed.directive, node, "AG-DENY", `deny tests ${name}'s own fields and roles in its scope: name a role or an ability, without a relation.`); return undefined; }
          const text = node.path[0]!.text;
          if (text === "member") return { kind: "role", in: values };
          if (values.includes(text)) return { kind: "role", in: [text] };
          return { kind: "permission", name: text };
        }
        case "isMe": case "identity":
          failAt(parsed.directive, node, "AG-DENY", "deny tests the row's state and the actor's role; an identity cannot hide rows in a role scope.");
          return undefined;
      }
    };
    return convert(expression);
  }

  function denyDisjuncts(name: string, model: ModelInfo, deny: NonNullable<ScopeModel["deny"]>, enumeration: string): { roles?: readonly string[]; row?: RowFilter }[] | undefined {
    const parts: GuardExpression[] = [];
    for (const { expression, parsed } of deny.when) {
      const converted = denyExpression(name, expression, parsed, enumeration);
      if (!converted) return undefined;
      parts.push(converted);
    }
    // Readers are those no deny rule hides.
    const where: GuardExpression = { kind: "not", of: parts.length === 1 ? parts[0]! : { kind: "or", of: parts } };
    const directive = deny.when[0]!.parsed.directive;
    const values = enumValues(enumeration);
    const permissions = enumGrants[enumeration] ?? {};
    const problems: string[] = [];
    const visit = (expression: GuardExpression): void => {
      if (expression.kind === "field") {
        const field = model.fields.get(expression.field);
        const domain: readonly (string | boolean)[] | undefined = field && !field.relation ? (field.type === "Boolean" ? [true, false] : scanned.enums.has(field.type) ? enumValues(field.type) : undefined) : undefined;
        if (!domain) problems.push(`${name}.${expression.field} is not an enum or Boolean field.`);
        else if (settings[name]?.[expression.field] === "server-only") problems.push(`${name}.${expression.field} is serverOnly.`);
        else for (const value of expression.in) if (!domain.includes(value)) problems.push(`${String(value)} is not a value of ${name}.${expression.field}.`);
      } else if (expression.kind === "role") {
        for (const role of expression.in) if (!values.includes(role)) problems.push(`${role} is not a ${enumeration} value.`);
      } else if (expression.kind === "permission") {
        if (!Object.prototype.hasOwnProperty.call(permissions, expression.name)) problems.push(`${expression.name} is not a role or ability of ${enumeration}.`);
      } else if (expression.kind === "not") visit(expression.of);
      else expression.of.forEach(visit);
    };
    visit(where);
    if (problems.length) { fail(directive, "AG-DENY", problems.join(" ")); return undefined; }
    const scope: GuardScope = {
      domain: (field) => {
        const info = model.fields.get(field);
        const options = info?.type === "Boolean" ? [true, false] : info ? enumValues(info.type) : undefined;
        return options && info?.optional ? [...options, null] : options;
      },
      roles: values,
      permissions,
    };
    const disjuncts = dnf(where, scope).filter((disjunct) => [...disjunct.fields.values()].every((set) => set.size) && (!disjunct.roles || disjunct.roles.size));
    if (disjuncts.length > MAX_DISJUNCTS) { fail(directive, "AG-DENY-COMPLEX", `${name}'s deny rules leave ${disjuncts.length} kinds of reader; at most ${MAX_DISJUNCTS} are allowed. Simplify the conditions.`); return undefined; }
    if (!disjuncts.length) { fail(directive, "AG-DENY-EMPTY", `${name}'s deny rules hide every row, so no one could read ${name}.`); return undefined; }
    const lowered = disjuncts.map((disjunct) => ({
      ...(disjunct.roles && disjunct.roles.size < values.length ? { roles: values.filter((role) => disjunct.roles!.has(role)) } : {}),
      ...(rowFilter(disjunct, scope) ? { row: rowFilter(disjunct, scope)! } : {}),
    }));
    // An unconditional alternative means nothing is hidden.
    const effective = lowered.some((disjunct) => !disjunct.roles && !disjunct.row) ? [{}] : lowered;
    guards[`${name}.deny`] = { model: name, where, scope: enumeration, disjuncts: effective };
    return effective;
  }

  for (const name of scopes.keys()) resolve(name);

  // Creation must be able to fill every required field the client cannot set.
  for (const [name, graphModel] of Object.entries(models)) {
    if (!graphModel.actions.create.length) continue;
    const model = scanned.models.get(name)!;
    for (const field of model.fields.values()) {
      if (field.relation || field.list || field.optional || field.defaulted || field.clock) continue;
      const mode = settings[name]?.[field.name];
      if (mode) fail(firstOf(onModel.get(name)!), "AG-CREATE-UNFILLABLE", `${graphModel.actions.create.join(", ")} may create ${name}, but ${name}.${field.name} is required, has no default and is ${mode === "server-only" ? "serverOnly" : "protected"}, so no client create can fill it. Give it a default, or create ${name} through a command.`);
    }
  }
  // A delete may not reach rows, through ON DELETE CASCADE, that the same people may not delete.
  for (const [name, graphModel] of Object.entries(models)) {
    if (!graphModel.actions.delete.length) continue;
    for (const child of scanned.models.values()) {
      for (const field of child.fields.values()) {
        if (!field.relation || field.type !== name || field.onDelete !== "Cascade" || !field.fields?.length) continue;
        const allowed = models[child.name]?.actions.delete ?? [];
        const missing = graphModel.actions.delete.filter((role) => !allowed.includes(role));
        if (missing.length) fail(firstOf(onModel.get(name)!), "AG-CASCADE", `${missing.join(", ")} may delete ${name}, which cascades to ${child.name} rows they may not delete. Narrow ${name}'s delete with only:, or delete it through a lifecycle command.`);
      }
    }
  }

  // ── Allow-rule models, lowered into core rules.
  const core = new Map<string, Lowered>();
  const graphRules: Record<string, { model: readonly string[]; fields: Readonly<Record<string, readonly string[]>> }> = {};
  const written = ({ directive, rule, bodyFrom = 0 }: Parsed): WrittenRule => ({
    rule,
    text: directive.args.slice(bodyFrom),
    at: (span) => spanAt(directive, span.from === 0 ? { from: bodyFrom, to: bodyFrom } : span),
  });
  for (const [name, allows] of ruleModels) {
    const model = scanned.models.get(name)!;
    const fields = new Map<string, WrittenRule[]>();
    for (const [field, list] of onField.get(name) ?? []) {
      if (model.fields.get(field)!.access) { fail(list[0]!.directive, "AG-MIXED", `${name}.${field} has rules in both grammars. Declare the field with directives only.`); continue; }
      fields.set(field, list.map(written));
    }
    const lowered = lowerRules({
      model, models: scanned.models, ...(principal ? { principal } : {}),
      enumValues: (type) => (scanned.enums.has(type) ? enumValues(type) : undefined),
      fail: (at, code, message) => report({ ...at, code, message }),
    }, allows.map(written), fields);
    if (!lowered) continue;
    core.set(name, lowered);
    graphRules[name] = lowered.normalized;
  }

  const enums: Record<string, AccessGraph["enums"][string]> = {};
  const enumProvenance: Record<string, { line: number }> = {};
  for (const enumeration of Object.keys(enumAssignable)) {
    const mask = masks.get(enumeration);
    const unassignable = enumValues(enumeration).filter((value) => !enumAssignable[enumeration]!.includes(value));
    if (!mask && !unassignable.length) continue;
    enums[enumeration] = {
      masks: mask ? Object.fromEntries(mask) : {},
      permissions: enumGrants[enumeration] ?? {},
      unassignable,
      ...(enumIncludes[enumeration] && Object.values(enumIncludes[enumeration]!).some((list) => list.length) ? { includes: enumIncludes[enumeration] } : {}),
    };
    enumProvenance[enumeration] = { line: scanned.enums.get(enumeration)!.line };
  }

  return {
    models: new Set(scopes.keys()),
    enums: new Set(Object.keys(enumAssignable)),
    ...(principalName ? { principal: principalName } : {}),
    rules,
    roleFields,
    principals,
    settings,
    grants,
    strict,
    enumGrants,
    enumAssignable,
    legacy,
    core,
    graph: {
      version: 2,
      ...(principal && anyDirective ? { principal: principal.name } : {}),
      enums,
      models,
      ...(Object.keys(fieldRules).length ? { fieldRules } : {}),
      ...(Object.keys(graphRules).length ? { rules: graphRules } : {}),
      guards,
      commands: Object.fromEntries(commands),
      provenance: { models: provenance, enums: enumProvenance, ...(commandLocations.size ? { commands: Object.fromEntries(commandLocations) } : {}) },
    },
  };
}

/** The canonical text of each rule in a directive, for display. */
export { normalizedRule };
export type { CoreRule };

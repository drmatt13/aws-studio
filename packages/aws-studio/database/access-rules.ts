/**
 * Prisma Access: allow rules, lowered into the policy the runtime enforces.
 *
 * A model without `roles:` or `from:` says who may do what with rules:
 *
 *     /// @access(read: email == auth.email || workspace.inviteMembers)
 *     /// @access(create: workspace.inviteMembers && email != auth.email)
 *
 * Each rule's condition is normalized into alternatives (an OR of ANDs). Every
 * alternative names one audience (an identity, `authenticated`, or a relation
 * it follows: `rel.read`, `rel.member`, `rel.ROLE`, `rel.ability`), may exclude
 * the row's owner (`userId != auth.id`) and may test the row's state. They
 * lower into the row rules and grants of scripts/client-access.ts, which
 * validates and enforces them exactly as it always has. Anything that cannot
 * be enforced exactly fails generation instead of being approximated.
 */
import type { Expression, Name, Rule, Span } from "./access-syntax.js";
import { last, normalizedRule } from "./access-syntax.js";

/** What this module needs to know about a schema; structurally the scanned schema of client-access.ts. */
export interface SchemaField {
  readonly name: string;
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
  readonly relation: boolean;
  readonly fields?: readonly string[];
  readonly references?: readonly string[];
  readonly id: boolean;
  readonly unique: boolean;
  readonly clock: boolean;
  readonly line: number;
}
export interface SchemaModel {
  readonly name: string;
  readonly line: number;
  readonly fields: ReadonlyMap<string, SchemaField>;
  readonly key: readonly string[];
  readonly uniques: ReadonlySet<string>;
}

/** The local scalars and their types must match the configured principal's primary key in order. */
export function isPrincipalLink(model: SchemaModel, field: SchemaField, principal: SchemaModel | undefined): boolean {
  if (!principal || !field.relation || field.list || field.type !== principal.name || !principal.key.length
      || field.fields?.length !== principal.key.length || field.references?.length !== principal.key.length) return false;
  return principal.key.every((key, index) => {
    const local = model.fields.get(field.fields![index]!);
    const target = principal.fields.get(key);
    return field.references![index] === key && !!local && !!target && !local.relation && !local.list && local.type === target.type;
  });
}

/** One rule of the policy core, as client-access.ts reads it: `word` or `word(args)`. */
export interface CoreRule {
  readonly word: string;
  readonly args?: string;
  readonly columns?: readonly string[];
  /** Where the directive that produced it is written. */
  readonly line: number;
  readonly column: number;
}

export interface WrittenRule {
  readonly rule: Rule;
  /** The directive's text and its source positions, for diagnostics. */
  readonly text: string;
  readonly at: (span: Span) => { readonly line: number; readonly column: number };
}

export interface Lowered {
  /** Field (scalar or relation) → its core rules. */
  readonly fields: ReadonlyMap<string, readonly CoreRule[]>;
  /** Model-level core rules: create, update, delete, read. */
  readonly model: readonly CoreRule[];
  /** The rules as written, normalized: part of the fingerprint. */
  readonly normalized: { readonly model: readonly string[]; readonly fields: Readonly<Record<string, readonly string[]>> };
}

export interface LoweringContext {
  readonly model: SchemaModel;
  /** Every model, for conditions on a related row. */
  readonly models: ReadonlyMap<string, SchemaModel>;
  readonly principal?: SchemaModel;
  /** An enum's values, or undefined when `type` is not an enum. */
  readonly enumValues: (type: string) => readonly string[] | undefined;
  readonly fail: (at: { line: number; column: number }, code: string, message: string) => void;
}

// ─── Conditions as alternatives ──────────────────────────────────────────────

type Atom =
  | { readonly kind: "identity"; readonly field: readonly Name[]; readonly auth?: Name; readonly negated: boolean; readonly span: Span }
  | { readonly kind: "state"; readonly field: readonly Name[]; readonly values: readonly Name[]; readonly negated: boolean; readonly span: Span }
  | { readonly kind: "name"; readonly path: readonly Name[]; readonly negated: boolean; readonly span: Span };

const MAX_ALTERNATIVES = 16;

class Unsupported extends Error {
  constructor(readonly span: Span, readonly code: string, message: string) { super(message); }
}

/** Disjunctive normal form, with negation pushed to the atoms. */
function alternatives(expression: Expression, negated = false): Atom[][] {
  switch (expression.kind) {
    case "not": return alternatives(expression.of, !negated);
    case "or":
    case "and": {
      const parts = expression.of.map((part) => alternatives(part, negated));
      if ((expression.kind === "or") !== negated) return parts.flat();
      let product: Atom[][] = [[]];
      for (const part of parts) {
        product = product.flatMap((left) => part.map((right) => [...left, ...right]));
        if (product.length > MAX_ALTERNATIVES) throw new Unsupported(expression, "AG-COMPLEX", `This condition expands to more than ${MAX_ALTERNATIVES} alternatives. Split it into several rules.`);
      }
      return product;
    }
    case "isMe": return [[{ kind: "identity", field: [expression.field], negated, span: expression }]];
    case "identity": return [[{ kind: "identity", field: expression.field, auth: expression.auth, negated: expression.negated !== negated, span: expression }]];
    case "state": return [[{ kind: "state", field: expression.field, values: expression.values, negated: expression.negated !== negated, span: expression }]];
    case "name": return [[{ kind: "name", path: expression.path, negated, span: expression }]];
  }
}

// ─── Audiences ───────────────────────────────────────────────────────────────

type Audience =
  /** The principal's own row. */
  | { readonly kind: "self" }
  /** A to-one relation to the principal, or a scalar equal to the principal's field of the same name. */
  | { readonly kind: "owner"; readonly relation?: string; readonly field?: string }
  | { readonly kind: "authenticated" }
  /** `rel.read` (no term) or `rel.term`. */
  | { readonly kind: "via"; readonly relation: string; readonly term?: string };

interface Clause {
  readonly audience: Audience;
  /** `field != auth.id`: never the row's owner, through these links. */
  readonly except: ReadonlySet<string>;
  /** This row's state. */
  readonly own: ReadonlyMap<string, string>;
  /** The followed row's state (`rel.status == ACTIVE`), for `via`. */
  readonly related: ReadonlyMap<string, string>;
  readonly span: Span;
}

const audienceKey = (audience: Audience) =>
  audience.kind === "via" ? `via:${audience.relation}:${audience.term ?? ""}` : audience.kind === "owner" ? `owner:${audience.relation ?? ""}:${audience.field ?? ""}` : audience.kind;
const stateKey = (state: ReadonlyMap<string, string>) => [...state].map(([field, value]) => `${field}=${value}`).sort().join("&");
const clauseKey = (clause: Clause) => `${audienceKey(clause.audience)}|${[...clause.except].sort().join()}|${stateKey(clause.own)}|${stateKey(clause.related)}`;

export function lowerRules(context: LoweringContext, modelRules: readonly WrittenRule[], fieldRules: ReadonlyMap<string, readonly WrittenRule[]>): Lowered | undefined {
  const { model, principal } = context;
  let failed = false;
  const fail = (written: WrittenRule, span: Span, code: string, message: string) => {
    failed = true;
    context.fail(written.at(span), code, message);
  };
  const fieldsOut = new Map<string, CoreRule[]>();
  const modelOut: CoreRule[] = [];
  const addField = (field: string, rule: CoreRule) => {
    const list = fieldsOut.get(field) ?? fieldsOut.set(field, []).get(field)!;
    if (!list.some((existing) => existing.word === rule.word && existing.args === rule.args)) list.push(rule);
  };
  const at = (written: WrittenRule) => written.at({ from: 0, to: 0 });

  /** A field's possible values, for state conditions: an enum's values or the two Booleans. */
  const domain = (field: SchemaField): readonly string[] | undefined => field.type === "Boolean" ? ["true", "false"] : context.enumValues(field.type);

  /** One state condition as the core writes it: `ACTIVE`, `!DRAFT` or `PENDING | INVITED`. */
  const stateValue = (written: WrittenRule, atom: Extract<Atom, { kind: "state" }>, on: SchemaModel): [string, string] | undefined => {
    const name = last(atom.field)!;
    const field = on.fields.get(name.text);
    if (!field || field.relation) { fail(written, name, "AG-STATE-FIELD", `${on.name} has no field "${name.text}" to test.`); return undefined; }
    const values = domain(field);
    if (!values) { fail(written, name, "AG-STATE-FIELD", `${on.name}.${name.text} is ${field.type}; a condition tests an enum or Boolean field.`); return undefined; }
    for (const value of atom.values) {
      if (!values.includes(value.text)) { fail(written, value, "AG-STATE-VALUE", `${value.text} is not a value of ${on.name}.${name.text}. Use ${values.join(", ")}.`); return undefined; }
    }
    const listed = [...new Set(atom.values.map((value) => value.text))];
    if (!atom.negated) return [name.text, listed.join(" | ")];
    if (listed.length === 1) return [name.text, `!${listed[0]}`];
    const rest = values.filter((value) => !listed.includes(value));
    if (!rest.length) { fail(written, atom.span, "AG-STATE-VALUE", `${name.text} != ${listed.join(" | ")} can never hold.`); return undefined; }
    return [name.text, rest.join(" | ")];
  };

  /** Each alternative of a condition, classified; undefined after reporting a problem. */
  const clauses = (written: WrittenRule, when: Expression): Clause[] | undefined => {
    let forms: Atom[][];
    try { forms = alternatives(when); }
    catch (error) {
      if (error instanceof Unsupported) { fail(written, error.span, error.code, error.message); return undefined; }
      throw error;
    }
    const out: Clause[] = [];
    for (const atoms of forms) {
      let audience: Audience | undefined;
      let audienceSpan: Span | undefined;
      const except = new Set<string>();
      const own = new Map<string, string>();
      const related: { atom: Extract<Atom, { kind: "state" }>; relation: string }[] = [];
      const span: Span = { from: Math.min(...atoms.map((atom) => atom.span.from)), to: Math.max(...atoms.map((atom) => atom.span.to)) };
      const setAudience = (next: Audience, where: Span) => {
        if (audience && audienceKey(audience) !== audienceKey(next)) {
          throw new Unsupported(where, "AG-AUDIENCE", "Each alternative names one audience. Join audiences with ||, and narrow one with && and conditions on the row.");
        }
        audience = next;
        audienceSpan = where;
      };
      try {
        for (const atom of atoms) {
          if (atom.kind === "identity") {
            const resolved = identity(written, atom);
            if (!resolved) return undefined;
            if (atom.negated) {
              if (resolved.kind === "self") throw new Unsupported(atom.span, "AG-EXCLUDE", `${model.name} is the signed-in user's own row; excluding it leaves nothing.`);
              except.add(audienceKey(resolved));
            } else setAudience(resolved, atom.span);
          } else if (atom.kind === "name") {
            if (atom.negated) throw new Unsupported(atom.span, "AG-NOT", "An allow rule grants; it cannot grant to everyone except a role. List who may, or hide rows with deny in a roles:/from: scope.");
            const [head, ...rest] = atom.path;
            if (!rest.length) {
              if (head!.text === "authenticated") { setAudience({ kind: "authenticated" }, atom.span); continue; }
              throw new Unsupported(atom.span, "AG-SCOPE-NAME", `${model.name} has no role scope of its own, so "${head!.text}" does not say whose role. Name the relation that leads to it, such as workspace.${head!.text}, or give ${model.name} roles: or from:.`);
            }
            if (rest.length > 1) throw new Unsupported(atom.span, "AG-PATH", `Follow one relation: ${head!.text}.${last(rest)!.text}. A related model's own rules carry the rest of the way.`);
            const relation = model.fields.get(head!.text);
            if (!relation?.relation) throw new Unsupported(head!, "AG-PATH", `${model.name}.${head!.text} is not a relation.`);
            const term = rest[0]!.text;
            setAudience({ kind: "via", relation: relation.name, ...(term === "read" ? {} : { term }) }, atom.span);
          } else if (atom.field.length === 1) {
            const value = stateValue(written, atom, model);
            if (!value) return undefined;
            if (own.has(value[0]) && own.get(value[0]) !== value[1]) throw new Unsupported(atom.span, "AG-STATE-TWICE", `This alternative tests ${value[0]} twice. Write the values it may hold once: ${value[0]} == A | B.`);
            own.set(...value);
          } else if (atom.field.length === 2) {
            related.push({ atom, relation: atom.field[0]!.text });
          } else throw new Unsupported(atom.span, "AG-PATH", "Test this row's field, or a field of the row a relation in the same alternative follows.");
        }
        if (!audience) throw new Unsupported(span, "AG-AUDIENCE", "Say who in each alternative: an identity (userId == auth.id), authenticated, or a relation (workspace.member, conversation.read). Conditions on the row narrow an audience; they are not one.");
      } catch (error) {
        if (error instanceof Unsupported) { fail(written, error.span, error.code, error.message); return undefined; }
        throw error;
      }
      const relatedState = new Map<string, string>();
      for (const { atom, relation } of related) {
        const chosen = audience as Audience;
        if (chosen.kind !== "via" || chosen.relation !== relation) { fail(written, atom.span, "AG-PATH", `${relation}.${atom.field[1]!.text} tests the related row, so this alternative must follow ${relation}: ${relation}.read or ${relation}.member.`); return undefined; }
        const target = targetOf(relation);
        if (!target) { fail(written, atom.span, "AG-PATH", `${relation} leads to no model in this schema.`); return undefined; }
        const value = stateValue(written, atom, target);
        if (!value) return undefined;
        if (relatedState.has(value[0]) && relatedState.get(value[0]) !== value[1]) {
          fail(written, atom.span, "AG-STATE-TWICE", `This alternative tests ${relation}.${value[0]} twice. Combine its allowed values into one condition.`);
          return undefined;
        }
        relatedState.set(...value);
      }
      out.push({ audience: audience as Audience, except, own, related: relatedState, span: audienceSpan ?? span });
    }
    return out;
  };

  const targetOf = (relation: string) => context.models.get(model.fields.get(relation)?.type ?? "");

  const principalKey = principal?.key.length === 1 ? principal.key[0] : undefined;
  const identity = (written: WrittenRule, atom: Extract<Atom, { kind: "identity" }>): Audience | undefined => {
    if (!principal || !principalKey) { fail(written, atom.span, "AG-PRINCIPAL", "auth names the signed-in user, but no principal model with a single-field key is known."); return undefined; }
    const auth = atom.auth?.text ?? principalKey;
    if (atom.field.length !== 1) { fail(written, atom.span, "AG-IDENTITY-FIELD", `Compare a field of ${model.name} itself with auth.${auth}. To follow a relation, use ${atom.field[0]!.text}.read.`); return undefined; }
    const name = atom.field[0]!.text;
    if (auth === principalKey) {
      if (model === principal && name === principalKey) return { kind: "self" };
      const link = [...model.fields.values()].find((field) => field.fields?.[0] === name && isPrincipalLink(model, field, principal));
      if (link) return { kind: "owner", relation: link.name };
      fail(written, atom.field[0]!, "AG-READ-FIELD", `${model.name}.${name} is not ${principal.name}'s key or a foreign key to it, so it cannot equal auth.${principalKey}.`);
      return undefined;
    }
    const mine = model.fields.get(name);
    const theirs = principal.fields.get(auth);
    if (!theirs || theirs.relation || !principal.uniques.has(auth)) { fail(written, atom.auth!, "AG-IDENTITY-FIELD", `auth.${auth} is not a unique field of ${principal.name}. Use auth.${principalKey}, or a unique field such as auth.email.`); return undefined; }
    if (!mine || mine.relation || name !== auth) { fail(written, atom.field[0]!, "AG-IDENTITY-FIELD", `Compare a field with the same name as ${principal.name}'s: ${auth} == auth.${auth}.`); return undefined; }
    return { kind: "owner", field: name };
  };

  // ── Who reads rows.
  const readRules = modelRules.filter((written) => written.rule.kind === "allow" && written.rule.grants.some((grant) => grant.action.text === "read"));
  const readClauses: { clause: Clause; columns?: readonly Name[]; written: WrittenRule }[] = [];
  const parsed = new Map<WrittenRule, Clause[]>();
  for (const written of modelRules) {
    if (written.rule.kind !== "allow") continue;
    const list = clauses(written, written.rule.when);
    if (list) parsed.set(written, list);
  }
  for (const written of readRules) {
    const rule = written.rule as Extract<Rule, { kind: "allow" }>;
    const read = rule.grants.find((grant) => grant.action.text === "read")!;
    for (const clause of parsed.get(written) ?? []) readClauses.push({ clause, ...(read.columns ? { columns: read.columns } : {}), written });
  }

  const ownerLinks = new Set<string>();
  const viaRelations = new Set<string>();
  for (const { clause, written } of readClauses) {
    const { audience } = clause;
    const bad = (code: string, message: string) => fail(written, clause.span, code, message);
    if (audience.kind !== "via" && (clause.own.size || clause.related.size)) { bad("AG-READ-STATE", "Rows read by identity or by every signed-in user cannot depend on their state here. Follow a relation (rel.read) to read some rows, or let the identity read them all."); continue; }
    if (clause.except.size) { bad("AG-READ-EXCLUDE", "A read rule says who sees rows; it cannot exclude their owner."); continue; }
    if (audience.kind === "self") { ownerLinks.add("self"); continue; }
    if (audience.kind === "owner") {
      ownerLinks.add(audienceKey(audience));
      addField(audience.relation ?? audience.field!, { word: "owner", ...at(written) });
    } else if (audience.kind === "authenticated") {
      modelOut.push({ word: "read", args: "authenticated", ...at(written) });
    } else {
      viaRelations.add(audience.relation);
      const args = [
        ...(audience.term ? [audience.term] : []),
        ...[...clause.related].map(([field, value]) => `${field}: ${value}`),
        ...[...clause.own].map(([field, value]) => `this.${field}: ${value}`),
      ];
      addField(audience.relation, { word: "via", ...(args.length ? { args: args.join(", ") } : {}), ...at(written) });
    }
  }
  if (principal && model === principal && !ownerLinks.has("self")) {
    context.fail({ line: model.line, column: 1 }, "AG-SELF", `${model.name} holds the signed-in users, who always see their own row. Say so: /// @access(read: ${principalKey ?? "id"} == auth.${principalKey ?? "id"}).`);
    failed = true;
  }
  const readKeys = new Set(readClauses.map(({ clause }) => clauseKey(clause)));
  const linkName = (link: string) => (link === "self" ? principalKey ?? "id" : link.split(":")[2] || model.fields.get(link.split(":")[1]!)?.fields?.[0] || link);
  const ownerNames = (separator = " and ") => [...ownerLinks].map(linkName).join(separator);
  const roleRelations = [...viaRelations];

  /**
   * The core audience for a grant: who, whether the owner is excluded, and the
   * row's state. One entry per distinct state; undefined after a problem.
   */
  const grantsOf = (written: WrittenRule, list: readonly Clause[], purpose: string): { who: string[]; except: boolean; own: ReadonlyMap<string, string> }[] | undefined => {
    const followsRow = list.some((clause) => clause.audience.kind === "via" && !clause.audience.term);
    if (followsRow && list.every((clause) => !clause.related.size) && list.length === readKeys.size && list.every((clause) => readKeys.has(clauseKey(clause)))) {
      // Exactly the people who see the row: the only way to name readers who arrive through another row.
      return [{ who: ["anyone"], except: false, own: new Map() }];
    }
    const groups = new Map<string, { who: string[]; except: boolean; own: ReadonlyMap<string, string>; owners: Set<string> }>();
    for (const clause of list) {
      const { audience } = clause;
      const stray = [...clause.except].find((link) => !ownerLinks.has(link));
      if (stray) { fail(written, clause.span, "AG-IDENTITY-UNREAD", `${purpose} excludes an identity that no read rule of ${model.name} names.`); return undefined; }
      if (clause.related.size) { fail(written, clause.span, "AG-PATH", `${purpose} cannot test a related row's state. Test this row's fields.`); return undefined; }
      if (clause.except.size && [...ownerLinks].some((link) => !clause.except.has(link))) {
        fail(written, clause.span, "AG-OWNER-PARTIAL", `${model.name} is owned through ${ownerNames()}; the runtime excludes an owner through every one of them. Exclude each: ${ownerNames(" != auth.id && ")} != auth.id.`);
        return undefined;
      }
      const key = `${clause.except.size > 0}|${stateKey(clause.own)}`;
      const group = groups.get(key) ?? groups.set(key, { who: [], except: clause.except.size > 0, own: clause.own, owners: new Set() }).get(key)!;
      if (audience.kind === "self" || audience.kind === "owner") {
        const link = audience.kind === "self" ? "self" : audienceKey(audience);
        if (!ownerLinks.has(link)) { fail(written, clause.span, "AG-IDENTITY-UNREAD", `${purpose} names an identity that no read rule of ${model.name} names. Rows must be readable to be written: add it to a read rule.`); return undefined; }
        group.owners.add(link);
        if (!group.who.includes("owner")) group.who.push("owner");
      } else if (audience.kind === "authenticated") {
        if (!group.who.includes("authenticated")) group.who.push("authenticated");
      } else if (!audience.term) {
        fail(written, clause.span, "AG-WRITE-PATH", `${purpose} through ${audience.relation}.read must grant exactly the people who read ${model.name}: give it the same audience as the read rule, or name a role or ability (${audience.relation}.member).`);
        return undefined;
      } else {
        if (!viaRelations.has(audience.relation)) { fail(written, clause.span, "AG-SCOPE-PATH", `${audience.relation}.${audience.term}: a read rule of ${model.name} must follow ${audience.relation} for its roles to reach this row.`); return undefined; }
        if (roleRelations.length > 1) { fail(written, clause.span, "AG-SCOPE-AMBIGUOUS", `${model.name} follows ${roleRelations.join(" and ")}, and roles reach its rows through each of them, so ${audience.relation}.${audience.term} would not be checked in ${audience.relation} alone.`); return undefined; }
        if (!group.who.includes(audience.term)) group.who.push(audience.term);
      }
    }
    for (const group of groups.values()) {
      if (group.owners.size && group.owners.size !== ownerLinks.size) {
        fail(written, list[0]!.span, "AG-OWNER-PARTIAL", `${model.name} is owned through ${ownerNames()}; the runtime treats them alike, so a rule naming one must name each with the same conditions.`);
        return undefined;
      }
    }
    return [...groups.values()].map(({ who, except, own }) => ({ who, except, own }));
  };

  const grantArgs = (grant: { who: readonly string[]; except: boolean; own: ReadonlyMap<string, string> }, extra: readonly string[] = [], to?: string) => [
    ...grant.who, ...(grant.except ? ["!owner"] : []), ...extra, ...[...grant.own].map(([field, value]) => `${field}: ${value}`), ...(to ? [`to: ${to}`] : []),
  ].join(", ");

  // ── Columns: who reads each, and which the client may write.
  const protectedFlags = new Map<string, "server-only" | "read-only">();
  for (const [field, rules] of fieldRules) {
    for (const written of rules) {
      const flags = written.rule.kind === "flags" ? written.rule.flags : written.rule.kind === "allow" ? written.rule.flags ?? [] : [];
      for (const flag of flags) {
        const mode = flag.text === "serverOnly" ? "server-only" : "read-only";
        const info = model.fields.get(field)!;
        if (info.relation) { fail(written, flag, "AG-FIELD-RELATION", `${model.name}.${field} is a relation. Put ${flag.text} on its foreign key.`); continue; }
        if (protectedFlags.has(field) && protectedFlags.get(field) !== mode) { fail(written, flag, "AG-FIELD-RULE", "A scalar field takes at most one of readonly and serverOnly."); continue; }
        protectedFlags.set(field, mode);
        addField(field, { word: mode, ...at(written) });
      }
    }
  }
  const implied = (field: SchemaField) => !field.relation && (field.id || model.key.includes(field.name) || field.clock);
  const columnProblem = (written: WrittenRule, column: Name, writing: boolean): boolean => {
    const field = model.fields.get(column.text);
    if (!field || field.relation) { fail(written, column, "AG-COLUMN", `${model.name} has no scalar field "${column.text}".`); return true; }
    if (protectedFlags.get(column.text) === "server-only") { fail(written, column, "AG-COLUMN", `${model.name}.${column.text} is serverOnly: it is never in the client API.`); return true; }
    if (writing && (protectedFlags.has(column.text) || implied(field))) { fail(written, column, "AG-COLUMN", `${model.name}.${column.text} is ${protectedFlags.get(column.text) === "read-only" ? "readonly" : "set by the server"}; clients never write it.`); return true; }
    return false;
  };

  // Read columns. The core reads a column through its own read rule, else through the
  // model's default readers, which include `read(authenticated)` (the rule that shows
  // every row to every signed-in user). Each column gets exactly the readers its rules name.
  if (readClauses.some(({ columns }) => columns)) {
    const full = readClauses.filter(({ columns }) => !columns).map(({ clause }) => clause);
    const keysOf = (list: readonly Clause[]) => [...new Set(list.map(clauseKey))].sort().join("\n");
    const readersOf = (written: WrittenRule, list: readonly Clause[], what: string): string | undefined => {
      if (!list.length) return "";
      if (keysOf(list) === [...readKeys].sort().join("\n")) return "anyone";
      const grants = grantsOf(written, list, what);
      if (!grants) return undefined;
      if (grants.length !== 1) { fail(written, list[0]!.span, "AG-COLUMNS-STATE", `${what}: give every reader of these columns the same conditions on the row, or none.`); return undefined; }
      return grantArgs(grants[0]!);
    };
    const first = readClauses[0]!.written;
    const everyone = readClauses.filter(({ clause }) => clause.audience.kind === "authenticated").map(({ clause }) => clause);
    const own = full.filter((clause) => clause.audience.kind !== "authenticated");
    // With no default reader of its own and no rule for every signed-in user, an unlisted column is no one's.
    if (own.length || !everyone.length) {
      const defaults = readersOf(first, own, `Reading ${model.name}'s other columns`);
      if (defaults !== undefined) modelOut.push({ word: "read", args: defaults, ...at(first) });
    }
    const coreDefault = keysOf([...full, ...everyone]);
    const listed = new Map<string, Clause[]>();
    for (const { clause, columns, written } of readClauses) {
      for (const column of columns ?? []) {
        if (columnProblem(written, column, false)) continue;
        const list = listed.get(column.text) ?? listed.set(column.text, []).get(column.text)!;
        if (!list.includes(clause)) list.push(clause);
      }
    }
    for (const field of model.fields.values()) {
      if (field.relation || protectedFlags.get(field.name) === "server-only") continue;
      // The precomputed column grants are defaults. Adding one beside a field's
      // explicit read rule would OR away any tighter condition on that field.
      if (fieldRules.get(field.name)?.some(({ rule }) => rule.kind === "allow" && rule.grants.some((grant) => grant.action.text === "read"))) continue;
      const desired = [...full, ...(listed.get(field.name) ?? [])];
      if (keysOf(desired) === coreDefault) continue;
      const readers = readersOf(first, desired, `Reading ${model.name}.${field.name}`);
      if (readers !== undefined) addField(field.name, { word: "read", args: readers, ...at(first) });
    }
  }

  // ── create, update and delete.
  const writable = new Set<string>();
  let listing: WrittenRule | undefined;
  for (const written of modelRules) {
    if (written.rule.kind !== "allow") continue;
    for (const grant of written.rule.grants) {
      if (grant.action.text === "read") continue;
      if (grant.action.text === "delete" && grant.columns) { fail(written, grant.action, "AG-COLUMN", "delete removes the whole row: leave out the column list."); continue; }
      if (!grant.columns) continue;
      listing ??= written;
      for (const column of grant.columns) if (!columnProblem(written, column, true)) writable.add(column.text);
    }
  }
  if (listing) {
    // A field with write rules of its own is governed by them, at creation too.
    const ruled = new Set([...fieldRules].filter(([, rules]) => rules.some(({ rule }) => rule.kind === "transition" || (rule.kind === "allow" && rule.grants.some((grant) => grant.action.text === "write")))).map(([field]) => field));
    for (const field of model.fields.values()) {
      if (field.relation || implied(field) || protectedFlags.has(field.name) || writable.has(field.name) || ruled.has(field.name)) continue;
      addField(field.name, { word: "read-only", ...at(listing) });
    }
  }
  for (const written of modelRules) {
    if (written.rule.kind !== "allow") continue;
    const list = parsed.get(written);
    if (!list) continue;
    for (const grant of written.rule.grants) {
      const action = grant.action.text;
      if (action === "read") continue;
      const lowered = grantsOf(written, list, `${action} on ${model.name}`);
      // The union already defines the model's writable fields. Only a narrower
      // grant needs column metadata in the compiled policy.
      const columns = grant.columns?.map((column) => column.text);
      const limit = columns && columns.length < writable.size ? { columns } : {};
      for (const entry of lowered ?? []) modelOut.push({ word: action, args: grantArgs(entry), ...limit, ...at(written) });
    }
  }

  // ── Field rules: read, write and transitions.
  for (const [field, rules] of fieldRules) {
    const info = model.fields.get(field)!;
    for (const written of rules) {
      const { rule } = written;
      if (rule.kind === "flags") continue;
      if (info.relation) { fail(written, { from: 0, to: written.text.length }, "AG-FIELD-RELATION", `${model.name}.${field} is a relation. A relation's access is its model's: write rules on the foreign key or the model.`); continue; }
      if (rule.kind === "allow") {
        const list = clauses(written, rule.when);
        if (!list) continue;
        for (const grant of rule.grants) {
          const lowered = grantsOf(written, list, `${grant.action.text} on ${model.name}.${field}`);
          for (const entry of lowered ?? []) addField(field, { word: grant.action.text, args: grantArgs(entry), ...at(written) });
        }
      } else if (rule.kind === "transition") {
        const values = domain(info);
        if (!values) { fail(written, rule.arrow, "AG-TRANSITION", `${model.name}.${field} is not an enum or Boolean, so it has no states to move between.`); continue; }
        const unknown = [...(rule.from === "any" ? [] : rule.from), ...rule.to].find((value) => !values.includes(value.text));
        if (unknown) { fail(written, unknown, "AG-STATE-VALUE", `${unknown.text} is not a value of ${model.name}.${field}. Use ${values.join(", ")}.`); continue; }
        const list = clauses(written, rule.when);
        if (!list) continue;
        if (list.some((clause) => clause.own.has(field))) { fail(written, rule.when, "AG-TRANSITION", `The transition already says which ${field} it starts from; leave ${field} out of its condition.`); continue; }
        const from = rule.from === "any" ? [] : [`${field}: ${[...new Set(rule.from.map((value) => value.text))].join(" | ")}`];
        const to = [...new Set(rule.to.map((value) => value.text))].join(" | ");
        const lowered = grantsOf(written, list, `Changing ${model.name}.${field}`);
        for (const entry of lowered ?? []) addField(field, { word: "write", args: grantArgs(entry, from, to), ...at(written) });
      } else {
        fail(written, { from: 0, to: written.text.length }, "AG-FIELD-RULE", "A field takes readonly, serverOnly, read:, write: or a transition (FROM -> TO: who).");
      }
    }
  }

  if (failed) return undefined;
  const normalized = {
    model: modelRules.map((written) => normalizedRule(written.text)),
    fields: Object.fromEntries([...fieldRules].map(([field, rules]) => [field, rules.map((written) => normalizedRule(written.text))])),
  };
  return { fields: fieldsOut, model: modelOut, normalized };
}

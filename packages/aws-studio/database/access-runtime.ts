import {
  assignmentGrants,
  grantsFor,
  rolesOf,
  satisfies,
  writtenGrant,
  type AccessGrant,
  type AccessPolicy,
  type ClientAccessSettings,
  type CommandWrite,
  type RowFilterValue,
  type RowAccessSettings,
  type RowFilter,
  type WriteVerb,
} from "./client-access.js";

/**
 * The `// @access` rules of prisma/contract.prisma, evaluated for one person
 * and one row: may they see it, read a field, assign a field, create or delete
 * it, and which role do they hold there.
 *
 * One interpreter serves the database, test fixtures and Studio's draft
 * preview: it reads rows through a {@link AccessReader}, which is an ORM lookup
 * in the API and an array filter elsewhere. It carries no application names.
 */

export type AccessRow = Readonly<Record<string, unknown>>;
/** The signed-in user as the rules need them: the user model's key and any field an `owner` names. */
export type AccessViewer = Readonly<Record<string, string>>;

export interface AccessReader {
  /** Rows of `model` whose fields equal `where`. */
  find(model: string, where: AccessRow): Promise<readonly AccessRow[]>;
}

/**
 * Why a write is refused. `missing`: no such row for this person. `who`: they
 * are not among the people a rule names. `excluded`: a rule names them but
 * excludes the row's owner, which they are. `when`: the row is not in the state
 * the rule requires (`condition` names the field). `transition`: they may write
 * the field, but not that value. `link`: the field links the row to who may see
 * it and no rule moves it. `field`: the API never assigns that field. `value`:
 * the API never assigns that value. `protected`: the stored value is one the
 * API never replaces.
 */
export type AccessDenial = "missing" | "who" | "excluded" | "when" | "transition" | "link" | "field" | "value" | "protected";

export interface AccessDecision {
  readonly allowed: boolean;
  readonly code?: "NOT_FOUND" | "FORBIDDEN" | "BAD_USER_INPUT";
  readonly reason?: AccessDenial;
  readonly field?: string;
  /** For `when`: the field whose state the rule requires. */
  readonly condition?: string;
}

export interface RowPermissions {
  /** May assign at least one field. */
  readonly update: boolean;
  readonly delete: boolean;
  /** Per scalar field the API returns. `values` are the enum values they may assign. */
  readonly fields: Readonly<Record<string, { readonly readable: boolean; readonly writable: boolean; readonly values: readonly string[] }>>;
  /** Per list relation whose rows the API creates: may they add one to this row. */
  readonly create: Readonly<Record<string, boolean>>;
  /** On a group: each named permission, and whether their role there holds it. */
  readonly can: Readonly<Record<string, boolean>>;
  /** On a group: the roles they hold there, as stored. */
  readonly roles: readonly string[];
}

/** How one clause judged one person: the furthest it got. */
export type ClauseOutcome = "yes" | "who" | "excluded" | "when" | "transition";

/** Why an answer is what it is, clause by clause, for an editor that explains it. */
export interface AccessExplanation {
  readonly allowed: boolean;
  /** Whether they see the row at all. */
  readonly visible: boolean;
  /** Set when a fact other than a clause decides: the row is invisible, or the field is protected. */
  readonly blocked?: "invisible" | "server-only" | "identity" | "read-only" | "link" | "protected" | "no-rule";
  /** Whose clauses governed: the field's own, or the model's default. */
  readonly source?: "field" | "model";
  readonly word?: "read" | "write" | "create" | "update" | "delete";
  readonly clauses: readonly { readonly grant: AccessGrant; readonly outcome: ClauseOutcome; readonly condition?: string }[];
}

export type AccessQuestion =
  | { readonly verb: "read"; readonly field: string }
  | { readonly verb: "update"; readonly field: string }
  | { readonly verb: "create" | "delete" };

export interface AccessRuntime {
  /** The same rules over a reader that remembers what it read: one per request. */
  snapshot(): AccessRuntime;
  find(model: string, key: AccessRow): Promise<AccessRow | undefined>;
  visible(model: string, row: AccessRow, viewer: AccessViewer): Promise<boolean>;
  /** The roles `viewer` holds for this row, in its group. */
  roles(model: string, row: AccessRow, viewer: AccessViewer): Promise<ReadonlySet<string>>;
  /** Do they see this row, and does their role in its group hold this named permission. */
  can(model: string, row: AccessRow, viewer: AccessViewer, permission: string): Promise<boolean>;
  readable(model: string, field: string, row: AccessRow, viewer: AccessViewer): Promise<boolean>;
  /**
   * May `viewer` create, update or delete `row`. `assigned` holds the fields a
   * client supplies and their values. For `create`, `row` is the row as it
   * would be stored, foreign keys included. With `command`, the access policy
   * module's command decides instead of the model's grants: its audience in
   * the row's scope, the row's state and the fields and values it may assign.
   */
  authorize(model: string, verb: WriteVerb, row: AccessRow | undefined, viewer: AccessViewer, assigned?: AccessRow, command?: string): Promise<AccessDecision>;
  permissions(model: string, row: AccessRow, viewer: AccessViewer): Promise<RowPermissions>;
  /** Each clause behind one answer, with how it judged them. */
  explain(model: string, question: AccessQuestion, row: AccessRow, viewer: AccessViewer): Promise<AccessExplanation>;
}

export interface AccessRuntimeOptions {
  /**
   * Called with each rule a decision consults, as written: `rows Case`,
   * `WorkspaceInvitation.status write(owner, status: PENDING, to: ACCEPTED | DECLINED)`.
   * Tests use it to record which rules each operation depends on.
   */
  readonly observe?: (rule: string) => void;
}

interface Outcome { readonly kind: ClauseOutcome; readonly condition?: string }
const RANK: Readonly<Record<ClauseOutcome, number>> = { who: 0, excluded: 1, when: 2, transition: 3, yes: 4 };

export function createAccessRuntime(
  policy: AccessPolicy,
  rows: RowAccessSettings,
  settings: ClientAccessSettings,
  reader: AccessReader,
  options: AccessRuntimeOptions = {},
): AccessRuntime {
  const observe = options.observe;
  const modelOf = (model: string) => {
    const declared = policy.models[model];
    if (!declared) throw new Error(`Unknown access model ${model}.`);
    return declared;
  };
  const rulesOf = (model: string) => rows.models[model]?.rules ?? [];
  const userKey = rows.userModel ? rows.models[rows.userModel]?.key ?? [] : [];

  /** Values compare as the database compares them: UUIDs without regard to case. */
  const same = (model: string, field: string, left: unknown, right: unknown): boolean => {
    if (left === undefined || left === null || right === undefined || right === null) return false;
    return policy.models[model]?.fields[field]?.type === "Uuid" && typeof left === "string" && typeof right === "string"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  };
  const stored = (enumeration: string, symbol: string) => policy.enums[enumeration]?.stored?.[symbol] ?? symbol;
  const symbol = (enumeration: string, value: unknown): unknown => {
    const names = policy.enums[enumeration]?.stored;
    if (!names || typeof value !== "string") return value;
    return Object.keys(names).find((name) => names[name] === value) ?? value;
  };
  const storedOf = (model: string, field: string) => (name: string) => stored(modelOf(model).fields[field]?.type ?? "", name);

  const related = async (model: string, relation: string, row: AccessRow): Promise<readonly AccessRow[]> => {
    const field = modelOf(model).fields[relation];
    if (!field?.relation || !field.local?.length || !field.target?.length) throw new Error(`Unresolved relation ${model}.${relation}.`);
    if (field.local.some((key) => row[key] === undefined || row[key] === null)) return [];
    return reader.find(field.type, Object.fromEntries(field.target.map((key, index) => [key, row[field.local![index]!]])));
  };

  /** The first condition the row fails, if any. */
  const failing = (model: string, row: AccessRow, where: RowFilter | undefined): string | undefined =>
    Object.entries(where ?? {}).find(([field, raw]) => !satisfies(row[field], raw, storedOf(model, field)))?.[0];
  const matches = (model: string, row: AccessRow, where: RowFilter | undefined): boolean => failing(model, row, where) === undefined;

  const owns = (model: string, row: AccessRow, viewer: AccessViewer): boolean => {
    const access = rows.models[model];
    if (!access) return false;
    if (access.self && access.key.every((field) => same(model, field, row[field], viewer[field]))) return true;
    return access.rules.some((rule) => rule.kind === "owner" && ("field" in rule
      ? same(model, rule.field, row[rule.field], viewer[rule.field])
      : rule.fields.every((field, index) => same(model, field, row[field], viewer[userKey[index]!]))));
  };

  // A membership can have other readers or owners. Its role belongs to the selected person.
  const isMember = (model: string, row: AccessRow, viewer: AccessViewer): boolean => {
    const principal = rows.principals?.[model];
    return principal
      ? principal.fields.every((field, index) => same(model, field, row[field], viewer[userKey[index]!]))
      : owns(model, row, viewer);
  };

  const roleField = (model: string) => Object.entries(policy.models[model]?.fields ?? {}).find(([, field]) => field.role);

  /**
   * The roles they hold in this row's group. Roles follow the relations and
   * their filters on related rows; `who` and `this.` conditions limit who sees
   * a row, not which group it belongs to.
   */
  const scopedRoles = async (model: string, row: AccessRow, viewer: AccessViewer): Promise<Map<string, Set<string>>> => {
    const held = new Map<string, Set<string>>();
    const add = (enumeration: string, role: string) => {
      const values = held.get(enumeration) ?? new Set<string>();
      values.add(role); held.set(enumeration, values);
    };
    const asked = new Set<string>();
    for (const rule of rulesOf(model)) {
      if (rule.kind === "owner") continue;
      const path = `${rule.relation}:${JSON.stringify(rule.where ?? {})}`;
      if (asked.has(path)) continue;
      asked.add(path);
      const role = rule.kind === "members" ? roleField(rule.model) : undefined;
      if (rule.kind === "members" && !role) continue;
      for (const candidate of await related(model, rule.relation, row)) {
        if (!matches(rule.model, candidate, rule.where)) continue;
        if (role) {
          if (isMember(rule.model, candidate, viewer)) {
            const value = String(symbol(role[1].type, candidate[role[0]]));
            if (policy.enums[role[1].type]?.values.includes(value)) add(role[1].type, value);
          }
        } else for (const [enumeration, inherited] of await scopedRoles(rule.model, candidate, viewer)) {
          for (const value of inherited) add(enumeration, value);
        }
      }
    }
    return held;
  };

  /**
   * Is `viewer` one of the people a WHO term names, for this row. A row being
   * created is not stored yet, so `anyone` asks whether they would see it.
   */
  const holds = async (model: string, row: AccessRow, viewer: AccessViewer, terms: readonly string[], creating = false): Promise<boolean> => {
    if (terms.includes("authenticated")) return true;
    if (terms.includes("anyone") && (!creating || await visible(model, row, viewer))) return true;
    if (terms.includes("owner") && owns(model, row, viewer)) return true;
    const named = terms.filter((term) => term !== "owner" && term !== "anyone" && term !== "authenticated");
    if (!named.length) return false;
    const held = await scopedRoles(model, row, viewer);
    if (!held.size) return false;
    return [...held].some(([enumeration, values]) =>
      named.some((term) => rolesOf(policy, enumeration, term)?.some((role) => values.has(role))));
  };

  interface Judging {
    /** The row is not stored yet. */
    readonly creating?: boolean;
    /** Leave the row's state out: a hint for controls, before the row exists. */
    readonly anyState?: boolean;
    /** The value a write assigns, for clauses with `to:`. */
    readonly assigning?: { readonly field: string; readonly value: unknown };
  }

  const granted = async (model: string, row: AccessRow, viewer: AccessViewer, grant: AccessGrant, judging: Judging = {}): Promise<Outcome> => {
    if (!(await holds(model, row, viewer, grant.who, judging.creating))) return { kind: "who" };
    if (grant.except?.includes("owner") && owns(model, row, viewer)) return { kind: "excluded" };
    if (!judging.anyState) {
      const condition = failing(model, row, grant.where);
      if (condition) return { kind: "when", condition };
    }
    if (grant.to !== undefined && judging.assigning && !satisfies(judging.assigning.value, grant.to, storedOf(model, judging.assigning.field))) return { kind: "transition" };
    return { kind: "yes" };
  };

  const anyGranted = async (model: string, row: AccessRow, viewer: AccessViewer, grants: readonly AccessGrant[] | undefined, judging: Judging = {}): Promise<Outcome> => {
    let best: Outcome = { kind: "who" };
    for (const grant of grants ?? []) {
      const result = await granted(model, row, viewer, grant, judging);
      if (result.kind === "yes") return result;
      if (RANK[result.kind] > RANK[best.kind]) best = result;
    }
    return best;
  };

  /** A `from:` row's parent is visible: the row would hang under something its viewer sees. */
  const parentVisible = async (model: string, row: AccessRow, viewer: AccessViewer): Promise<boolean> => {
    for (const rule of rulesOf(model)) {
      if (rule.kind !== "via") continue;
      for (const candidate of await related(model, rule.relation, row)) if (await visible(rule.model, candidate, viewer)) return true;
    }
    return false;
  };

  const visible = async (model: string, row: AccessRow, viewer: AccessViewer): Promise<boolean> => {
    const access = rows.models[model];
    if (!Object.keys(viewer).length || !access) return false;
    if (access.authenticated) return true;
    if (owns(model, row, viewer)) return true;
    for (const rule of rulesOf(model)) {
      if (rule.kind === "owner") continue;
      if (!matches(model, row, rule.own)) continue;
      for (const candidate of await related(model, rule.relation, row)) {
        if (!matches(rule.model, candidate, rule.where)) continue;
        if (rule.kind === "members") {
          if (isMember(rule.model, candidate, viewer)) return true;
        } else if (await visible(rule.model, candidate, viewer) && (!rule.who || await holds(rule.model, candidate, viewer, rule.who))) return true;
      }
    }
    return false;
  };

  const identityAllowsRead = (model: string, fields: readonly string[] | undefined, row: AccessRow, viewer: AccessViewer): boolean =>
    !fields || (userKey.length === 1 && fields.some((field) => same(model, field, row[field], viewer[userKey[0]!])));

  const readable = async (model: string, field: string, row: AccessRow, viewer: AccessViewer): Promise<boolean> => {
    const column = modelOf(model).fields[field];
    if (!column || settings[model]?.[field] === "server-only") return false;
    if (!identityAllowsRead(model, column.readIdentity, row, viewer)) return false;
    if (!(await visible(model, row, viewer))) return false;
    const grants = grantsFor(policy, model, field, "read");
    return !grants || (await anyGranted(model, row, viewer, grants)).kind === "yes";
  };

  /** A stored enum value the API never assigns is one it never replaces either. */
  const isProtected = (enumeration: string, value: unknown): boolean => {
    const entry = policy.enums[enumeration];
    if (!entry || value === undefined || value === null) return false;
    const name = symbol(enumeration, value);
    return entry.values.includes(String(name)) && !entry.assignable.includes(String(name));
  };

  const deny = (reason: AccessDenial, field?: string, condition?: string): AccessDecision => ({
    allowed: false,
    code: reason === "missing" ? "NOT_FOUND" : reason === "value" ? "BAD_USER_INPUT" : "FORBIDDEN",
    reason,
    ...(field ? { field } : {}),
    ...(condition ? { condition } : {}),
  });
  const refused = (outcome: Outcome, field?: string) => deny(outcome.kind as AccessDenial, field, outcome.condition);
  const defined = (assigned: AccessRow) => Object.fromEntries(Object.entries(assigned).filter(([, value]) => value !== undefined));

  /** The writes of `command` on this model and verb; a programming error when it declares none. */
  const commandWrites = (command: string, model: string, verb: WriteVerb): readonly CommandWrite[] => {
    const definition = policy.commands?.[command];
    if (!definition) throw new Error(`No command named ${command} in Access Graph.`);
    const writes = definition.writes.filter((write) => write.model === model && write.verb === verb);
    if (!writes.length) throw new Error(`Command ${command} does not ${verb} ${model}.`);
    return writes;
  };
  const commandRule = (command: string, write: CommandWrite) =>
    `${write.model} ${command}(${[policy.commands![command]!.who, ...Object.entries(write.when ?? {}).map(([field, raw]) => `${field}: ${typeof raw !== "object" ? String(raw) : "in" in raw ? raw.in.join(" | ") : `!${raw.not}`}`)].join(", ")})`;

  /** Field protections every client assignment passes, whichever rule allows the write. */
  const assignmentProblem = (model: string, verb: WriteVerb, row: AccessRow, names: readonly string[], assigned: AccessRow, to?: Readonly<Record<string, RowFilterValue>>): AccessDecision | undefined => {
    const declared = modelOf(model);
    for (const name of names) {
      const column = declared.fields[name];
      if (!column || column.relation || settings[model]?.[name]) return deny("field", name);
      if (verb === "update" && column.link && !column.write) { observe?.(`${model}.${name} link`); return deny("link", name); }
      const enumeration = policy.enums[column.type];
      const value = assigned[name];
      if (to?.[name] !== undefined && !satisfies(value, to[name]!, storedOf(model, name))) return deny("transition", name);
      if (!enumeration) continue;
      if (verb === "update" && isProtected(column.type, row[name])) return deny("protected", name);
      if (value === null) continue;
      if (!enumeration.assignable.some((item) => stored(column.type, item) === value)) return deny("value", name);
    }
    return undefined;
  };

  const authorize: AccessRuntime["authorize"] = async (model, verb, row, viewer, assigned = {}, command) => {
    const declared = modelOf(model);
    if (!Object.keys(viewer).length) return deny("who");
    if (!row) return deny("missing");
    if (verb === "create") row = { ...row, ...defined(assigned) };
    if (verb !== "create" && !(await visible(model, row, viewer))) return deny("missing");
    // A `from:` row is created only under a parent its creator sees, guards included…
    const strict = verb === "create" && !!declared.strict;
    if (strict && !(await parentVisible(model, row, viewer))) { observe?.(`rows ${model}`); return deny("missing"); }
    // …and, once a rule allows it, only as a row they would see themselves (its own guard).
    const seen = async (decision: AccessDecision): Promise<AccessDecision> =>
      decision.allowed && strict && !(await visible(model, row!, viewer)) ? deny("who") : decision;

    const names = verb === "delete" ? [] : Object.keys(assigned).filter((name) => assigned[name] !== undefined);
    if (command) {
      // The command, not the model's grants, decides: its audience in this row's scope,
      // the state it requires, and exactly the fields and values it assigns.
      const writes = commandWrites(command, model, verb);
      const who = policy.commands![command]!.who;
      let best: Outcome = { kind: "who" };
      for (const write of writes) {
        observe?.(commandRule(command, write));
        if (names.some((name) => !(write.fields ?? []).includes(name))) continue;
        const outcome = await granted(model, row, viewer, { who: [who], ...(write.when ? { where: write.when } : {}) }, { creating: verb === "create" });
        if (outcome.kind !== "yes") { if (RANK[outcome.kind] > RANK[best.kind]) best = outcome; continue; }
        return seen(assignmentProblem(model, verb, row, names, assigned, write.to) ?? { allowed: true });
      }
      const unlisted = names.find((name) => !writes.some((write) => (write.fields ?? []).includes(name)));
      return unlisted ? deny("field", unlisted) : refused(best);
    }
    const judging = { creating: verb === "create" };
    if (verb !== "update" || !names.length) {
      for (const grant of declared[verb] ?? []) observe?.(`${model} ${writtenGrant(verb, grant)}`);
      const outcome = await anyGranted(model, row, viewer, declared[verb], judging);
      if (outcome.kind !== "yes") return refused(outcome);
    }
    for (const name of names) {
      const column = declared.fields[name];
      if (!column || column.relation || settings[model]?.[name]) return deny("field", name);
      if (verb === "update" && column.link && !column.write) { observe?.(`${model}.${name} link`); return deny("link", name); }
      const enumeration = policy.enums[column.type];
      const value = assigned[name];
      // A field's own write rule governs every assignment of it, at creation too.
      if (verb === "update" || column.write || declared.create?.some((grant) => grant.columns)) {
        const grants = column.write ?? assignmentGrants(declared[verb], name);
        for (const grant of grants ?? []) observe?.(column.write ? `${model}.${name} ${writtenGrant("write", grant)}` : `${model} ${writtenGrant(verb, grant)}`);
        const outcome = await anyGranted(model, row, viewer, grants, { ...judging, assigning: { field: name, value } });
        if (outcome.kind !== "yes") {
          // Someone a rule names may learn that the stored value is one the API never replaces.
          if (outcome.kind !== "who" && verb === "update" && enumeration && isProtected(column.type, row[name])) return deny("protected", name);
          return refused(outcome, name);
        }
      }
      if (!enumeration) continue;
      if (verb === "update" && isProtected(column.type, row[name])) return deny("protected", name);
      if (value === null) continue;
      if (!enumeration.assignable.some((item) => stored(column.type, item) === value)) return deny("value", name);
    }
    // Writing an access link moves the row: it must also be creatable where it lands.
    const moved = verb === "update" ? names.find((name) => declared.fields[name]?.link) : undefined;
    if (moved) {
      for (const grant of declared.create ?? []) observe?.(`${model} ${writtenGrant("create", grant)}`);
      const outcome = await anyGranted(model, { ...row, ...defined(assigned) }, viewer, declared.create, { creating: true });
      if (outcome.kind !== "yes") return refused(outcome, moved);
    }
    return seen({ allowed: true });
  };

  /** The clauses that let them through, ignoring which value they would write. */
  const passing = async (model: string, row: AccessRow, viewer: AccessViewer, grants: readonly AccessGrant[] | undefined): Promise<AccessGrant[]> => {
    const through: AccessGrant[] = [];
    for (const grant of grants ?? []) if ((await granted(model, row, viewer, grant)).kind === "yes") through.push(grant);
    return through;
  };

  /** Every command write on this model and verb, with its command's audience. */
  const commandsFor = (model: string, verb: WriteVerb) => Object.entries(policy.commands ?? {}).flatMap(([name, definition]) =>
    definition.writes.filter((write) => write.model === model && write.verb === verb).map((write) => ({ name, who: definition.who, write })));
  const commandAllows = async (model: string, row: AccessRow, viewer: AccessViewer, who: string, write: CommandWrite, judging: Judging = {}) =>
    (await granted(model, row, viewer, { who: [who], ...(write.when && !judging.anyState ? { where: write.when } : {}) }, judging)).kind === "yes";

  const permissions: AccessRuntime["permissions"] = async (model, row, viewer) => {
    const declared = modelOf(model);
    const fields: Record<string, { readable: boolean; writable: boolean; values: readonly string[] }> = {};
    const visibleRow = await visible(model, row, viewer);
    // Commands that may update this row now: their assignable fields count as writable, like grants.
    const updates: { write: CommandWrite }[] = [];
    if (visibleRow) for (const { who, write } of commandsFor(model, "update")) if (await commandAllows(model, row, viewer, who, write)) updates.push({ write });
    for (const [name, column] of Object.entries(declared.fields)) {
      if (column.relation || settings[model]?.[name] === "server-only") continue;
      const blocked = !visibleRow || isProtected(column.type, row[name]) || !!settings[model]?.[name] || (!!column.link && !column.write);
      const through = blocked ? [] : await passing(model, row, viewer, grantsFor(policy, model, name, "write"));
      const commanded = blocked ? [] : updates.filter(({ write }) => write.fields?.includes(name));
      const enumeration = policy.enums[column.type];
      fields[name] = {
        readable: await readable(model, name, row, viewer),
        writable: through.length > 0 || commanded.length > 0,
        values: (through.length || commanded.length) && enumeration
          ? enumeration.assignable.map((item) => stored(column.type, item)).filter((value) =>
            through.some((grant) => grant.to === undefined || satisfies(value, grant.to, storedOf(model, name)))
            || commanded.some(({ write }) => write.to?.[name] === undefined || satisfies(value, write.to[name]!, storedOf(model, name))))
          : [],
      };
    }
    // A hint for controls: the row a child would start as, checked without its state.
    const create: Record<string, boolean> = {};
    for (const [name, column] of Object.entries(declared.fields)) {
      const child = column.relation && column.list ? policy.models[column.type]?.create : undefined;
      // A command's child rows are offered through the relation that scopes them (their access link).
      const scoping = !!column.target?.length && column.target.every((key) => policy.models[column.type]?.fields[key]?.link);
      const commands = column.relation && column.list && scoping ? commandsFor(column.type, "create") : [];
      if ((!child && !commands.length) || !column.local || !column.target) continue;
      const proposed = Object.fromEntries(column.target.map((key, index) => [key, row[column.local![index]!]]));
      let allowed = visibleRow && !!child && (await anyGranted(column.type, proposed, viewer, child, { creating: true, anyState: true })).kind === "yes";
      for (const { who, write } of commands) if (!allowed && visibleRow) allowed = await commandAllows(column.type, proposed, viewer, who, write, { creating: true, anyState: true });
      create[name] = allowed;
    }
    const can: Record<string, boolean> = {};
    const held: string[] = [];
    const groups = rulesOf(model).flatMap((rule) => (rule.kind === "members" && roleField(rule.model) ? [roleField(rule.model)![1].type] : []));
    if (groups.length) {
      const mine = visibleRow ? await scopedRoles(model, row, viewer) : new Map<string, Set<string>>();
      for (const enumeration of new Set(groups)) {
        for (const [permission, allowed] of Object.entries(policy.enums[enumeration]?.grants ?? {})) {
          can[permission] = can[permission] === true || allowed.some((role) => mine.get(enumeration)?.has(role));
        }
        for (const role of policy.enums[enumeration]?.values ?? []) if (mine.get(enumeration)?.has(role) && !held.includes(stored(enumeration, role))) held.push(stored(enumeration, role));
      }
    }
    let deletable = visibleRow && (await anyGranted(model, row, viewer, declared.delete)).kind === "yes";
    if (visibleRow) for (const { who, write } of commandsFor(model, "delete")) if (!deletable) deletable = await commandAllows(model, row, viewer, who, write);
    return {
      update: Object.values(fields).some((field) => field.writable),
      delete: deletable,
      fields,
      create,
      can,
      roles: held,
    };
  };

  const explain: AccessRuntime["explain"] = async (model, question, row, viewer) => {
    const declared = modelOf(model);
    const seen = await visible(model, row, viewer);
    const result = (rest: Omit<AccessExplanation, "visible" | "clauses"> & { clauses?: AccessExplanation["clauses"] }): AccessExplanation => ({ visible: seen, clauses: [], ...rest });
    if (question.verb !== "create" && !seen) return result({ allowed: false, blocked: "invisible" });
    let grants: readonly AccessGrant[] | undefined;
    let source: "field" | "model" = "model";
    let word: NonNullable<AccessExplanation["word"]> = question.verb;
    if (question.verb === "read" || question.verb === "update") {
      const column = declared.fields[question.field];
      const mode = settings[model]?.[question.field];
      if (!column || column.relation || mode === "server-only") return result({ allowed: false, blocked: "server-only" });
      if (question.verb === "read" && !identityAllowsRead(model, column.readIdentity, row, viewer)) return result({ allowed: false, blocked: "identity" });
      if (question.verb === "update") {
        if (mode) return result({ allowed: false, blocked: "read-only" });
        if (column.link && !column.write) return result({ allowed: false, blocked: "link" });
        if (isProtected(column.type, row[question.field])) return result({ allowed: false, blocked: "protected" });
      }
      const own = question.verb === "read" ? column.read : column.write;
      grants = grantsFor(policy, model, question.field, question.verb === "read" ? "read" : "write");
      source = own ? "field" : "model";
      word = own ? (question.verb === "read" ? "read" : "write") : question.verb;
      if (!grants) return question.verb === "read" ? result({ allowed: true }) : result({ allowed: false, blocked: "no-rule" });
    } else {
      grants = declared[question.verb];
      if (!grants) return result({ allowed: false, blocked: "no-rule", word });
    }
    const clauses: { grant: AccessGrant; outcome: ClauseOutcome; condition?: string }[] = [];
    for (const grant of grants) {
      const outcome = await granted(model, row, viewer, grant, { creating: question.verb === "create" });
      clauses.push({ grant, outcome: outcome.kind, ...(outcome.condition ? { condition: outcome.condition } : {}) });
    }
    return result({ allowed: clauses.some((clause) => clause.outcome === "yes"), source, word, clauses });
  };

  return {
    snapshot: () => {
      const reads = new Map<string, Promise<readonly AccessRow[]>>();
      return createAccessRuntime(policy, rows, settings, {
        find: (model, where) => {
          const key = JSON.stringify([model, where]);
          let pending = reads.get(key);
          if (!pending) reads.set(key, pending = reader.find(model, where));
          return pending;
        },
      }, options);
    },
    find: async (model, key) => {
      if (!Object.keys(key).length || Object.values(key).some((value) => value === undefined || value === null)) return undefined;
      return (await reader.find(model, key))[0];
    },
    visible: async (model, row, viewer) => {
      observe?.(`rows ${model}`);
      return visible(model, row, viewer);
    },
    roles: async (model, row, viewer) => new Set([...(await scopedRoles(model, row, viewer)).values()].flatMap((values) => [...values])),
    can: async (model, row, viewer, permission) => {
      observe?.(`${model} can(${permission})`);
      return (await visible(model, row, viewer)) && holds(model, row, viewer, [permission]);
    },
    readable: async (model, field, row, viewer) => {
      const column = policy.models[model]?.fields[field];
      if (column?.readIdentity) observe?.(`${model}.${field} read: ${column.readIdentity.map((key) => `${key} == auth.id`).join(" || ")}`);
      for (const grant of grantsFor(policy, model, field, "read") ?? []) observe?.(column?.read ? `${model}.${field} ${writtenGrant("read", grant)}` : `${model} ${writtenGrant("read", grant)}`);
      return readable(model, field, row, viewer);
    },
    authorize,
    permissions,
    explain,
  };
}

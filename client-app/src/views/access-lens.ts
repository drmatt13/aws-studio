import {
  assignmentGrants,
  describeCondition,
  readClientAccess,
  roleSources,
  writtenGrant,
  type AccessGrant,
  type AccessPolicy,
  type RowFilter,
  type RowRule,
  type RowFilterValue,
} from "aws-studio/database/client-access";
import { createAccessRuntime, type AccessExplanation, type AccessRow, type AccessRuntime, type AccessViewer } from "aws-studio/database/access-runtime";

/**
 * What a kind of person may do with each model, answered by the same engine
 * the API enforces, run over rows synthesized from the draft's own rules. No
 * second policy interpreter: personas, fixtures and states are derived from
 * the draft, and every answer is the runtime's.
 */

type Parsed = ReturnType<typeof readClientAccess>;

export type Persona =
  | { readonly kind: "stranger" }
  | { readonly kind: "owner" }
  /** Holds `role` through an ACTIVE-as-declared row of `membership`, listed by `group.relation`. */
  | { readonly kind: "role"; readonly group: string; readonly relation: string; readonly membership: string; readonly enumeration: string; readonly role: string }
  /** Owns a row of a `members` relation that carries no role, such as a pending invitation. */
  | { readonly kind: "holder"; readonly group: string; readonly relation: string; readonly membership: string };

export interface PersonaChoice { readonly id: string; readonly label: string; readonly persona: Persona }

/** Whether something holds in every state of the row, in some, or in none. */
export interface Reach { readonly level: "yes" | "some" | "no"; readonly when?: string }

export type ScenarioState = Readonly<Record<string, string | boolean>>;
export interface ScenarioField {
  readonly field: string;
  /** Values as stored, paired with source symbols for labels. */
  readonly values: readonly (string | boolean)[];
  readonly symbols: readonly string[];
}
export interface LensCoverage { readonly evaluated: number; readonly total: number; readonly truncated: boolean }

export interface ModelLens {
  readonly model: string;
  readonly visible: Reach;
  readonly create: Reach;
  readonly delete: Reach;
  readonly fields: Readonly<Record<string, {
    readonly read: Reach;
    readonly write: Reach;
    /** Each enum/Boolean destination, judged by the engine across the evaluated states. */
    readonly values: readonly { readonly value: string | boolean; readonly write: Reach }[];
  }>>;
  readonly coverage: LensCoverage;
  /** Related rows are synthesized to satisfy these access-path conditions. */
  readonly assumptions: readonly string[];
}

const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Everyone the draft's rules distinguish: strangers, owners, each role in each group, and holders of role-less memberships. */
export function personas(parsed: Parsed): PersonaChoice[] {
  const choices: PersonaChoice[] = [
    { id: "stranger", label: "Signed-in user", persona: { kind: "stranger" } },
    { id: "owner", label: "Row owner", persona: { kind: "owner" } },
  ];
  const groups = new Map<string, { group: string; relation: string; membership: string }[]>();
  for (const [group, access] of Object.entries(parsed.rows.models)) {
    for (const rule of access.rules) if (rule.kind === "members") (groups.get(rule.model) ?? groups.set(rule.model, []).get(rule.model)!).push({ group, relation: rule.relation, membership: rule.model });
  }
  const many = new Set([...groups.values()].flat().map((entry) => entry.group)).size > 1;
  for (const [membership, entries] of groups) {
    const role = Object.values(parsed.policy.models[membership]?.fields ?? {}).find(field => field.role);
    for (const { group, relation } of entries) {
      const sharedBinding = entries.length > 1;
      const scope = sharedBinding ? `${membership}:${group}:${relation}` : membership;
      const where = sharedBinding ? ` through ${group}.${relation}` : many ? ` in ${words(group)}` : "";
      if (role) {
        for (const value of parsed.policy.enums[role.type]?.values ?? []) {
          choices.push({ id: `role:${scope}:${value}`, label: `${capitalized(words(value))}${where}`, persona: { kind: "role", group, relation, membership, enumeration: role.type, role: value } });
        }
      } else {
        choices.push({ id: `holder:${scope}`, label: `${capitalized(words(membership))} holder${where}`, persona: { kind: "holder", group, relation, membership } });
      }
    }
  }
  return choices;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const pick = (raw: RowFilterValue, values: readonly string[]): string | boolean =>
  typeof raw !== "object" ? raw : "in" in raw ? raw.in[0]! : typeof raw.not === "boolean" ? !raw.not : values.find((value) => value !== raw.not) ?? raw.not;

interface Fixture {
  readonly store: Record<string, AccessRow[]>;
  readonly viewer: AccessViewer;
  readonly row: Record<string, unknown>;
  readonly pathRows: Readonly<Record<string, Record<string, unknown>>>;
  readonly assumptions: readonly string[];
}

function fixture(parsed: Parsed, model: string, persona: Persona): Fixture {
  const { rows, policy } = parsed;
  const store: Record<string, AccessRow[]> = {};
  const assumptions = new Set<string>();
  let next = 0;
  const id = () => `row-${++next}`;
  const stored = (enumeration: string, symbol: string) => policy.enums[enumeration]?.stored?.[symbol] ?? symbol;
  const satisfy = (target: Record<string, unknown>, owner: string, where: RowFilter | undefined) => {
    for (const [field, raw] of Object.entries(where ?? {})) {
      const type = policy.models[owner]?.fields[field]?.type ?? "";
      const value = pick(raw, policy.enums[type]?.values ?? []);
      target[field] = typeof value === "string" ? stored(type, value) : value;
      assumptions.add(`${owner}.${field} = ${value}`);
    }
  };
  const userKey = rows.userModel ? rows.models[rows.userModel]?.key ?? ["id"] : ["id"];
  const viewer: Record<string, string> = {};
  for (const field of rows.viewer) viewer[field] = userKey.includes(field) ? "viewer" : `viewer-${field}`;
  const add = (owner: string, row: Record<string, unknown>) => (store[owner] ??= []).push(row);
  if (rows.userModel) add(rows.userModel, { ...viewer });

  /** Make `row` (of `owner`) belong to the viewer. */
  const own = (row: Record<string, unknown>, owner: string) => {
    // Access Graph role sources can match their principal without row access of their own.
    rows.principals?.[owner]?.fields.forEach((field, index) => { row[field] = viewer[userKey[index]!]; });
    const access = rows.models[owner];
    if (access?.self) for (const field of access.key) row[field] = viewer[field];
    for (const rule of access?.rules ?? []) {
      if (rule.kind !== "owner") continue;
      if ("field" in rule) row[rule.field] = viewer[rule.field];
      else rule.fields.forEach((field, index) => { row[field] = viewer[userKey[index]!]; });
    }
  };

  const row: Record<string, unknown> = {};
  const pathRows: Record<string, Record<string, unknown>> = { [model]: row };
  for (const field of rows.models[model]?.key ?? []) row[field] = "row";
  if (persona.kind === "owner") own(row, model);

  const membership = persona.kind === "role" || persona.kind === "holder" ? persona : undefined;
  const group = membership?.group ?? parsed.graph.models[model]?.path.at(-1);
  if (group) {
    // The shortest via path from the model to the group whose members relation the persona holds.
    const queue: { at: string; path: { from: string; rule: Extract<RowRule, { kind: "members" | "via" }> }[] }[] = [{ at: model, path: [] }];
    const seen = new Set<string>([model]);
    let found: (typeof queue)[number] | undefined;
    while (queue.length && !found) {
      const entry = queue.shift()!;
      if (entry.at === group) { found = entry; break; }
      for (const rule of rows.models[entry.at]?.rules ?? []) {
        if (rule.kind !== "via" || seen.has(rule.model)) continue;
        seen.add(rule.model);
        queue.push({ at: rule.model, path: [...entry.path, { from: entry.at, rule }] });
      }
    }
    if (found) {
      let current = row;
      found.path.forEach(({ from, rule }, index) => {
        const parent: Record<string, unknown> = {};
        for (const field of rows.models[rule.model]?.key ?? []) parent[field] = id();
        rule.local.forEach((local, at) => {
          current[local] ??= id();
          parent[rule.target[at]!] = current[local];
        });
        satisfy(parent, rule.model, rule.where);
        // A row between the model and its group takes the state its first clause needs.
        if (index > 0) satisfy(current, from, rule.own);
        add(rule.model, parent);
        pathRows[rule.model] = parent;
        current = parent;
      });
      if (persona.kind === "owner" && group !== model) own(current, group);
      const members = membership && rows.models[group]?.rules.find((rule) => rule.kind === "members" && rule.relation === membership.relation);
      if (membership && members?.kind === "members") {
        const seat: Record<string, unknown> = {};
        for (const field of rows.models[membership.membership]?.key ?? []) seat[field] = id();
        members.local.forEach((local, at) => {
          current[local] ??= id();
          seat[members.target[at]!] = current[local];
        });
        satisfy(seat, membership.membership, members.where);
        own(seat, membership.membership);
        if (persona.kind === "role") {
          const role = Object.entries(policy.models[membership.membership]?.fields ?? {}).find(([, field]) => field.role);
          if (role) seat[role[0]] = stored(persona.enumeration, persona.role);
        }
        add(membership.membership, seat);
      }
    }
  }
  return { store, viewer, row, pathRows, assumptions: [...assumptions] };
}

function runtimeOver(parsed: Parsed, store: Record<string, AccessRow[]>): AccessRuntime {
  return createAccessRuntime(parsed.policy, parsed.rows, parsed.settings, {
    find: async (model, where) => (store[model] ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
  });
}

// ─── States ──────────────────────────────────────────────────────────────────

/** The enum and Boolean fields of `model` its own rules compare, with their values as stored. */
export function scenarioFields(parsed: Parsed, model: string, selectedField?: string): ScenarioField[] {
  const { rows, policy } = parsed;
  const names = new Set<string>();
  const collect = (where: RowFilter | undefined) => { for (const field of Object.keys(where ?? {})) names.add(field); };
  for (const rule of rows.models[model]?.rules ?? []) if (rule.kind !== "owner") collect(rule.own);
  const declared = policy.models[model];
  const selected = selectedField ? declared?.fields[selectedField] : undefined;
  const grantsForModel = selected && selectedField
    ? [selected.read ?? declared?.read, selected.write ? declared?.create : assignmentGrants(declared?.create, selectedField), selected.write ?? assignmentGrants(declared?.update, selectedField)]
    : [declared?.create, declared?.update, declared?.delete, declared?.read];
  for (const grants of grantsForModel) for (const grant of grants ?? []) collect(grant.where);
  for (const command of Object.values(policy.commands ?? {})) {
    for (const write of command.writes) {
      if (write.model === model && (!selectedField || write.fields?.includes(selectedField))) collect(write.when);
    }
  }
  const columns = selected && selectedField ? [[selectedField, selected] as const] : Object.entries(declared?.fields ?? {});
  for (const [name, field] of columns) {
    for (const grant of [...(field.read ?? []), ...(field.write ?? [])]) collect(grant.where);
    const enumeration = policy.enums[field.type];
    if (!field.relation && enumeration && enumeration.assignable.length !== enumeration.values.length) names.add(name);
  }
  return [...names].flatMap((field): ScenarioField[] => {
    const type = declared?.fields[field]?.type ?? "";
    if (type === "Boolean") return [{ field, values: [true, false], symbols: ["true", "false"] }];
    const enumeration = policy.enums[type];
    return enumeration ? [{ field, values: enumeration.values.map((value) => enumeration.stored?.[value] ?? value), symbols: enumeration.values }] : [];
  });
}

/** Only the row states that participate in the selected model's read policy. */
export function sampleReadFields(parsed: Parsed, model: string): readonly (ScenarioField & { readonly model: string })[] {
  const path = parsed.graph.models[model]?.path ?? [model];
  return path.flatMap((name) => {
    const fields = new Set((parsed.rows.models[name]?.rules ?? []).flatMap((rule) => rule.kind === "owner" ? [] : Object.keys(rule.own ?? {})));
    return scenarioFields(parsed, name).filter((scenario) => fields.has(scenario.field)).map((scenario) => ({ ...scenario, model: name }));
  });
}

/** A single hypothetical read, with explicit states for related rows on the scope path. */
export async function sampleReadAccess(
  parsed: Parsed,
  model: string,
  persona: Persona,
  statesByModel: Readonly<Record<string, ScenarioState>>,
  field?: string,
): Promise<{ readonly allowed: boolean; readonly reason?: string }> {
  const { row, store, viewer, pathRows } = fixture(parsed, model, persona);
  for (const [name, state] of Object.entries(statesByModel)) {
    if (pathRows[name]) Object.assign(pathRows[name], state);
  }
  if (!parsed.rows.models[model]) return { allowed: false, reason: "This model has no row access rule." };
  const engine = runtimeOver(parsed, store).snapshot();
  if (!(await engine.visible(model, row, viewer))) {
    const path = parsed.graph.models[model]?.path ?? [];
    let parentVisible = false;
    for (const name of [...path].reverse()) {
      const candidate = pathRows[name];
      if (!candidate) break;
      const rules = parsed.graph.models[name]!;
      if (await engine.visible(name, candidate, viewer)) {
        parentVisible = true;
        continue;
      }
      // An inherited rule reaches a visible parent and its own guard is the
      // only additional read condition. For an independent scope, first check
      // that the engine found a membership with an enum mask that grants read.
      const guard = rules.guards.find((item) => item.model === name);
      const roles = rules.enumeration && parsed.graph.enums[rules.enumeration]?.masks;
      const passesScope = rules.base === "from" ? parentVisible : guard && roles
        && [...await engine.roles(name, candidate, viewer)].some((role) => roles[role]?.includes("read"));
      return { allowed: false, reason: guard && passesScope
        ? `${name}’s deny rule hides this sample.`
        : `${name}’s row access rule rejected this sample.` };
    }
    return { allowed: false, reason: "The row access rules rejected this sample." };
  }
  if (!field) return { allowed: true };
  const explanation = await engine.explain(model, { verb: "read", field }, row, viewer);
  if (explanation.allowed) return { allowed: true };
  return { allowed: false, reason: explanation.blocked === "server-only" ? "This field is server only." : "The field read rules rejected this sample." };
}

const STATE_LIMIT = 96;

function stateCount(fields: readonly ScenarioField[], fixed: ScenarioState = {}): number {
  return fields.reduce((total, { field, values }) => total * (Object.hasOwn(fixed, field) ? 1 : values.length), 1);
}

function* states(fields: readonly ScenarioField[], fixed: ScenarioState = {}, limit = STATE_LIMIT): Generator<Record<string, string | boolean>> {
  let count = 0;
  const walk = function* (index: number, state: Record<string, string | boolean>): Generator<Record<string, string | boolean>> {
    if (count >= limit) return;
    if (index === fields.length) { count++; yield { ...state }; return; }
    const { field, values } = fields[index]!;
    for (const value of Object.hasOwn(fixed, field) ? [fixed[field]!] : values) yield* walk(index + 1, { ...state, [field]: value });
  };
  yield* walk(0, { ...fixed });
}

/** Fold a yes/no answer per state into "always", "never" or "when …" in words. */
function reach(fields: readonly ScenarioField[], answers: readonly { state: Record<string, string | boolean>; yes: boolean }[]): Reach {
  const yes = answers.filter((answer) => answer.yes);
  if (!yes.length) return { level: "no" };
  if (yes.length === answers.length) return { level: "yes" };
  const symbol = (field: string, value: string | boolean) => {
    const entry = fields.find((item) => item.field === field)!;
    return String(entry.symbols[entry.values.indexOf(value)] ?? value);
  };
  // Describe it per field when the passing states are a product of per-field choices.
  const per = fields.map(({ field, values }) => ({ field, chosen: values.filter((value) => yes.some((answer) => answer.state[field] === value)), all: values.length }));
  const product = per.reduce((total, item) => total * item.chosen.length, 1);
  if (product === yes.length) {
    const parts = per.filter((item) => item.chosen.length < item.all).map(({ field, chosen }) => {
      const values = chosen.map((value) => symbol(field, value));
      const rest = fields.find((item) => item.field === field)!.values.filter((value) => !chosen.includes(value)).map((value) => symbol(field, value));
      const raw: RowFilterValue = rest.length === 1 && values.length > 1 ? { not: literal(rest[0]!) } : values.length === 1 ? literal(values[0]!) : { in: values };
      return describeCondition(field, raw);
    });
    return { level: "some", when: parts.join(" and ") };
  }
  return { level: "some", when: "in some states" };
}
const literal = (value: string): string | boolean => (value === "true" ? true : value === "false" ? false : value);

// ─── Answers ─────────────────────────────────────────────────────────────────

interface StateAnswer {
  readonly state: Record<string, string | boolean>;
  readonly visible: boolean;
  readonly create: boolean;
  readonly delete: boolean;
  readonly fields: Readonly<Record<string, { readonly read: boolean; readonly write: boolean; readonly onCreate: boolean; readonly values: readonly (string | boolean)[] }>>;
}

function destinationValues(parsed: Parsed, model: string, field: string): readonly (string | boolean)[] {
  const type = parsed.policy.models[model]?.fields[field]?.type;
  if (type === "Boolean") return [true, false];
  const enumeration = parsed.policy.enums[type ?? ""];
  return enumeration?.values.map((value) => enumeration.stored?.[value] ?? value) ?? [];
}

async function evaluate(parsed: Parsed, model: string, persona: Persona, fields: readonly ScenarioField[], fixed: ScenarioState = {}, context?: Fixture, compareCreateFields = false) {
  const { store, viewer, row, assumptions } = context ?? fixture(parsed, model, persona);
  const engine = runtimeOver(parsed, store);
  const declared = parsed.policy.models[model];
  const columns = Object.entries(declared?.fields ?? {}).filter(([name, field]) => !field.relation && parsed.settings[model]?.[name] !== "server-only").map(([name]) => name);
  const answers: StateAnswer[] = [];
  for (const state of states(fields, fixed)) {
    const candidate = { ...row, ...state };
    const visible = parsed.rows.models[model] ? await engine.visible(model, candidate, viewer) : false;
    const create = !!declared?.create && (await engine.authorize(model, "create", candidate, viewer)).allowed;
    const permissions = visible ? await engine.permissions(model, candidate, viewer) : undefined;
    const results: Record<string, StateAnswer["fields"][string]> = {};
    for (const column of columns) {
      const allowed = permissions?.fields[column];
      const values: (string | boolean)[] = [];
      const destinations = destinationValues(parsed, model, column);
      if (allowed?.writable) for (const value of destinations) {
        if ((await engine.authorize(model, "update", candidate, viewer, { [column]: value })).allowed) values.push(value);
      }
      let onCreate = false;
      if (compareCreateFields && create && !parsed.settings[model]?.[column]) {
        // Preserve the evaluated state and the fixture's access links. For a
        // column without a state, try its declared values or one scalar value.
        const choices = candidate[column] !== undefined ? [candidate[column]] : destinations.length ? destinations : ["sample"];
        for (const value of choices) {
          if ((await engine.authorize(model, "create", candidate, viewer, { [column]: value })).allowed) { onCreate = true; break; }
        }
      }
      results[column] = { read: !!allowed?.readable, write: !!allowed?.writable, onCreate, values };
    }
    answers.push({ state, visible, create, delete: !!permissions?.delete, fields: results });
  }
  const total = stateCount(fields, fixed);
  return { answers, columns, assumptions, coverage: { evaluated: answers.length, total, truncated: answers.length < total } };
}

/** The client answer for one concrete example, using the same permissions result as GraphQL. */
export async function fieldExample(parsed: Parsed, model: string, field: string, persona: Persona, state: ScenarioState) {
  const { row, store, viewer, assumptions } = fixture(parsed, model, persona);
  const candidate = { ...row, ...state };
  const engine = runtimeOver(parsed, store);
  const visible = !!parsed.rows.models[model] && await engine.visible(model, candidate, viewer);
  const permission = visible ? (await engine.permissions(model, candidate, viewer)).fields[field] : undefined;
  let choices: readonly (string | boolean)[] = permission?.values ?? [];
  // The API's values list is for enums. A Boolean assignment is judged by its write rule.
  if (permission?.writable && parsed.policy.models[model]?.fields[field]?.type === "Boolean") {
    const allowed = [];
    for (const value of [true, false]) {
      if ((await engine.authorize(model, "update", candidate, viewer, { [field]: value })).allowed) allowed.push(value);
    }
    choices = allowed;
  }
  return { visible, permission, choices, assumptions };
}

/** What `persona` may do across the states its rules compare, optionally fixing a scenario's own-row values. */
export async function modelLens(parsed: Parsed, model: string, persona: Persona, state: ScenarioState = {}): Promise<ModelLens> {
  const fields = scenarioFields(parsed, model);
  const { answers, columns, coverage, assumptions } = await evaluate(parsed, model, persona, fields, state);
  const fold = (get: (answer: StateAnswer) => boolean) => reach(fields, answers.map((answer) => ({ state: answer.state, yes: get(answer) })));
  return {
    model,
    visible: fold((answer) => answer.visible),
    create: fold((answer) => answer.create),
    delete: fold((answer) => answer.delete),
    fields: Object.fromEntries(columns.map((column) => [column, {
      read: fold((answer) => !!answer.fields[column]?.read),
      write: fold((answer) => !!answer.fields[column]?.write),
      values: destinationValues(parsed, model, column).map((value) => ({ value, write: fold((answer) => !!answer.fields[column]?.values.includes(value)) })),
    }])),
    coverage,
    assumptions,
  };
}

/** Every exposed model's lens for one persona. */
export async function schemaLens(parsed: Parsed, persona: Persona): Promise<Record<string, ModelLens>> {
  const result: Record<string, ModelLens> = {};
  for (const model of Object.keys(parsed.policy.models)) result[model] = await modelLens(parsed, model, persona);
  return result;
}

/**
 * Why one answer is what it is, at the most telling state of the row: one in
 * which it is allowed, else one in which the clauses decide (not a protected
 * value), else one the persona sees, else the first.
 */
export async function explainFor(parsed: Parsed, model: string, persona: Persona, question: { verb: "read" | "update"; field: string } | { verb: "create" | "delete" }, fixed: ScenarioState = {}): Promise<AccessExplanation & { readonly state: Readonly<Record<string, string | boolean>> }> {
  const { store, viewer, row } = fixture(parsed, model, persona);
  const engine = runtimeOver(parsed, store);
  const score = (answer: AccessExplanation) => (answer.allowed ? 3 : answer.clauses.length ? 2 : answer.visible ? 1 : 0);
  let best: (AccessExplanation & { state: Record<string, string | boolean> }) | undefined;
  for (const state of states(scenarioFields(parsed, model), fixed)) {
    const answer = { ...(await engine.explain(model, question, { ...row, ...state }, viewer)), state };
    if (!best || score(answer) > score(best)) best = answer;
    if (score(answer) === 3) break;
  }
  return best ?? { ...(await engine.explain(model, question, row, viewer)), state: {} };
}

// ─── Consequences ────────────────────────────────────────────────────────────

export interface Consequence { readonly persona: string; readonly kind: "broadens" | "narrows" | "changes"; readonly text: string }

const phrase = (value: Reach, doing: string) => (value.level === "yes" ? `can ${doing}` : value.level === "no" ? `cannot ${doing}` : `can ${doing} ${value.when === "in some states" ? value.when : `when ${value.when}`}`);

/** Compare the same concrete states, including states newly mentioned by either draft. */
function comparisonFields(before: Parsed, after: Parsed, model: string): ScenarioField[] {
  const fields = new Map<string, ScenarioField>();
  for (const item of [...scenarioFields(before, model), ...scenarioFields(after, model)]) {
    const previous = fields.get(item.field);
    if (!previous) { fields.set(item.field, item); continue; }
    const values = [...previous.values], symbols = [...previous.symbols];
    item.values.forEach((value, at) => { if (!values.includes(value)) { values.push(value); symbols.push(item.symbols[at]!); } });
    fields.set(item.field, { field: item.field, values, symbols });
  }
  return [...fields.values()];
}

/** Concrete gains/losses for each persona, broadening first. These remain draft scenario evidence. */
export async function consequences(before: Parsed, after: Parsed, model: string): Promise<Consequence[]> {
  const result: Consequence[] = [];
  const priorCommands = commandsOn(before, model), nextCommands = commandsOn(after, model);
  for (const name of new Set([...Object.keys(priorCommands), ...Object.keys(nextCommands)])) {
    if (JSON.stringify(priorCommands[name]) === JSON.stringify(nextCommands[name])) continue;
    const entry = Object.prototype.hasOwnProperty.call(nextCommands, name) ? nextCommands[name] : undefined;
    const text = entry
      ? `Command ${name} permits ${entry.who} to ${entry.writes.map((write) => {
        const when = Object.entries(write.when ?? {}).map(([field, value]) => describeCondition(field, value));
        return `${write.verb}${write.fields?.length ? `(${write.fields.join(", ")})` : ""}${when.length ? ` when ${when.join(" and ")}` : ""}`;
      }).join(" and ")} on ${model}`
      : `Command ${name} no longer writes ${model}`;
    result.push({ persona: "", kind: "changes", text });
  }
  const people = new Map([...personas(before), ...personas(after)].map((person) => [person.id, person]));
  const fields = comparisonFields(before, after, model);
  let coverage: LensCoverage | undefined;
  for (const { label, persona } of people.values()) {
    // Both engines must judge the same related rows. Satisfying each draft's
    // membership filters independently would hide a change such as active:true
    // becoming active:false. Include both concrete related-row scenarios.
    const prior = fixture(before, model, persona), proposed = fixture(after, model, persona);
    const contexts = JSON.stringify(prior) === JSON.stringify(proposed) ? [prior] : [prior, proposed];
    for (const [index, context] of contexts.entries()) {
      const [old, now] = await Promise.all([evaluate(before, model, persona, fields, {}, context, true), evaluate(after, model, persona, fields, {}, context, true)]);
      coverage = now.coverage;
      const relatedScope = contexts.length > 1 ? ` (with ${context.assumptions.length ? context.assumptions.join(" and ") : index === 0 ? "the previous access path" : "the proposed access path"})` : "";
      const compare = (get: (answer: StateAnswer | undefined) => boolean, doing: string) => {
        for (const gained of [true, false]) {
          const answers = now.answers.map((answer, index) => ({ state: answer.state, yes: gained ? get(answer) && !get(old.answers[index]) : get(old.answers[index]) && !get(answer) }));
          if (!answers.some((answer) => answer.yes)) continue;
          const change = reach(fields, answers);
          const action = phrase(change, doing);
          result.push({ persona: label, kind: gained ? "broadens" : "narrows", text: `${label} ${gained ? action : action.replace(/^can /, "can no longer ")}${relatedScope}${now.coverage.truncated ? " (in evaluated states)" : ""}` });
        }
      };
      compare((answer) => !!answer?.visible, `see ${words(model)} rows`);
      compare((answer) => !!answer?.create, `create ${words(model)} rows`);
      compare((answer) => !!answer?.delete, `delete ${words(model)} rows`);
      for (const field of new Set([...old.columns, ...now.columns])) {
        compare((answer) => !!answer?.fields[field]?.onCreate, `set ${model}.${field} on creation`);
        compare((answer) => !!answer?.fields[field]?.read, `read ${model}.${field}`);
        compare((answer) => !!answer?.fields[field]?.write, `edit ${model}.${field}`);
        for (const value of new Set([...destinationValues(before, model, field), ...destinationValues(after, model, field)])) {
          compare((answer) => !!answer?.fields[field]?.values.includes(value), `set ${model}.${field} to ${value}`);
        }
      }
    }
  }
  if (coverage?.truncated) result.push({ persona: "", kind: "changes", text: `Compared ${coverage.evaluated} of ${coverage.total} own-row states for ${words(model)}; other states have not been evaluated.` });
  const order = { broadens: 0, changes: 1, narrows: 2 } as const;
  return result.sort((left, right) => order[left.kind] - order[right.kind]);
}

/** The part of each command judged on this model. */
function commandsOn(parsed: Parsed, model: string) {
  return Object.fromEntries(Object.entries(parsed.policy.commands ?? {}).flatMap(([name, command]) => {
    const writes = command.writes.filter((write) => write.model === model);
    return writes.length ? [[name, { ...command, writes }] as const] : [];
  }));
}

/** Direct changes and models that inherit those rules through access relations. */
export function changedModels(before: Parsed, after: Parsed): string[] {
  const names = [...new Set([...Object.keys(before.policy.models), ...Object.keys(after.policy.models)])];
  const key = (parsed: Parsed, model: string) => JSON.stringify([parsed.policy.models[model], parsed.rows.models[model], parsed.settings[model], commandsOn(parsed, model)]);
  const enums = JSON.stringify(before.policy.enums) !== JSON.stringify(after.policy.enums);
  const changed = new Set(names.filter((model) => enums || key(before, model) !== key(after, model)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const model of names) {
      if (changed.has(model)) continue;
      const dependencies = [...(before.rows.models[model]?.rules ?? []), ...(after.rows.models[model]?.rules ?? [])];
      if (dependencies.some((rule) => rule.kind !== "owner" && changed.has(rule.model))) { changed.add(model); grew = true; }
    }
  }
  return names.filter((model) => changed.has(model));
}

/** A clause as written, for explanations that link back to source. */
export function clauseText(word: string, grant: AccessGrant): string { return writtenGrant(word, grant); }

/** Roles a persona would need for a clause, for "allow it here" suggestions. */
export function roleChoices(parsed: Parsed, model: string): string[] {
  return [...new Set(roleSources(parsed.rows, parsed.policy, model).flatMap(({ enumeration }) => parsed.policy.enums[enumeration]?.values ?? []))];
}

export type { Parsed as ParsedAccess };

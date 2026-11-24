/**
 * The enforcement core of Prisma Access: who sees rows, who reads and assigns
 * fields, who creates, updates and deletes, and the roles and abilities that
 * decide it. Schemas write `/// @access(…)` directives (scripts/access-syntax.ts);
 * scripts/access-graph.ts and scripts/access-rules.ts lower them into the core
 * rules read here, which this file validates and compiles into the policy the
 * runtime enforces (src/access-runtime.ts) and the generator emits.
 *
 * The core rules also have a text form, one comment per line it governs:
 *
 *     // @access rule rule …        rule = word | word(WHO…, field: VALUE…)
 *
 * | Line            | Rule                 | Meaning                                              |
 * | --------------- | -------------------- | ---------------------------------------------------- |
 * | field           | `server-only`        | The GraphQL API never returns or accepts it.         |
 * | field           | `read-only`          | Returned, never accepted. Keys and clock fields too. |
 * | field           | `read(WHO…)`         | Only these people read it.                           |
 * | field           | `write(WHO…, when)`  | These people may assign it.                          |
 * | enum field      | `role`               | The row's owner holds this role in their group.      |
 * | relation        | `owner`              | The row belongs to that user.                        |
 * | list relation   | `members(when)`      | Users who own one of these rows see this row.        |
 * | relation        | `via(WHO…, when)`    | Whoever sees the related row sees this row.          |
 * | model (comment) | `create(WHO…, when)` | These people may create a row.                       |
 * | model (comment) | `update(WHO…, when)` | They may assign any field without its own `write`.   |
 * | model (comment) | `delete(WHO…, when)` | These people may delete a row.                       |
 * | model (comment) | `read(WHO…, when)`   | Who reads a field without its own `read`.            |
 * | enum (comment)  | `name(ROLE…)`        | A named ability these roles hold.                    |
 * | enum value      | `read-only`          | The API never assigns this value, or replaces it.    |
 *
 * Schemas never use it: without `{ legacy: true }` such a comment is an
 * AG-LEGACY problem. Suites that test the core directly read it with that
 * option. WHO is `owner`, `anyone` (whoever can see the row), `member`, a role
 * or an ability; `authenticated` for `create` and a model's `read`; `!owner`
 * excludes the row's owner. `field: VALUE` names this row (the related row
 * inside `members` and `via`, where `this.field` names this row); `to:` names
 * the value a field's `write` assigns.
 *
 * The foreign keys behind `owner` and `via` are access links: set at creation,
 * moved only by a `write` rule of their own, judged again by `create` where the
 * row lands. A role belongs to the viewer's own membership in the row's group.
 * Row rules are ORed; a model with none is not in the GraphQL API. Rules are an
 * outer bound: code may narrow them, never widen them.
 *
 * Self-contained and dependency-free: Studio's editor and server, Contract
 * Chain and the database generator (aws-studio db:generate) all read
 * access through this file, so they cannot disagree about it.
 */

import { lowerAccessGraph, scanDirectives, type AccessGraph, type AccessModules, type CommandDefinition, type CoreRule, type GraphDirective } from "./access-graph.js";
import { SyntaxProblem, parseRule, type Rule } from "./access-syntax.js";

export type { AccessGraph, AccessModules, CommandDefinition, CommandWrite, GuardDefinition, GuardExpression, GraphAction, GraphModel } from "./access-graph.js";

export const FIELD_ACCESS_MODES = ["server-only", "read-only"] as const;
export type FieldAccessMode = (typeof FIELD_ACCESS_MODES)[number];
export const ROW_ACCESS_KINDS = ["owner", "members", "via"] as const;
export type RowAccessKind = (typeof ROW_ACCESS_KINDS)[number];
export const FIELD_RULES = ["role", "read", "write"] as const;
export type FieldRule = (typeof FIELD_RULES)[number];
export const MODEL_RULES = ["create", "update", "delete", "read"] as const;
export type ModelRule = (typeof MODEL_RULES)[number];
export const WRITE_VERBS = ["create", "update", "delete"] as const;
export type WriteVerb = (typeof WRITE_VERBS)[number];
export type AccessWord = FieldAccessMode | RowAccessKind | FieldRule | ModelRule;

/** WHO terms that are not roles or permissions. */
export const AUDIENCE_WORDS = ["owner", "anyone", "member", "authenticated"] as const;

export const ACCESS_LABELS: Readonly<Record<AccessWord, string>> = {
  "server-only": "Server only",
  "read-only": "Read only",
  owner: "Owner",
  members: "Members",
  via: "Via",
  role: "Role",
  read: "Read",
  write: "Write",
  create: "Create",
  update: "Update",
  delete: "Delete",
};

export const ACCESS_DESCRIPTIONS: Readonly<Record<AccessWord, string>> = {
  "server-only": "The GraphQL API never returns or accepts it.",
  "read-only": "Clients cannot assign this field. It is returned only when its read rules allow it.",
  owner: "The row belongs to this user.",
  members: "Users who own one of these rows can see this row.",
  via: "Anyone who can see the related row can see this row.",
  role: "The row's owner holds this role in their group.",
  read: "Only these people read it.",
  write: "These people may assign it.",
  create: "These people may create a row.",
  update: "These people may assign any field without its own write rule.",
  delete: "These people may delete a row.",
};

/** What a scalar field without a setting means. */
export const DEFAULT_FIELD_DESCRIPTION = "Inherits model read and write rules. Client writes require a grant.";

/** Model → field → static protection, in source order. Fields without protection inherit policy grants. */
export type ClientAccessSettings = Readonly<Record<string, Readonly<Record<string, FieldAccessMode>>>>;

/** Equality conditions on a row: field → enum member or Boolean, `{ not }` one, or `{ in }` any of several enum members. */
export type RowFilterValue = string | boolean | { readonly not: string | boolean } | { readonly in: readonly string[] };
export type RowFilter = Readonly<Record<string, RowFilterValue>>;

/** Does a value, as stored, satisfy one condition. `stored` maps an enum symbol to its stored value. */
export function satisfies(value: unknown, condition: RowFilterValue, stored: (symbol: string) => string = (symbol) => symbol): boolean {
  const as = (wanted: string | boolean) => (typeof wanted === "string" ? stored(wanted) : wanted);
  if (typeof condition !== "object") return value === as(condition);
  if ("in" in condition) return condition.in.some((wanted) => value === as(wanted));
  return value !== as(condition.not);
}

export type RowRule =
  /** A to-one relation to the user model; `fields` are this row's foreign key. */
  | { readonly kind: "owner"; readonly relation: string; readonly fields: readonly string[] }
  /** A scalar that equals the user model's unique field of the same name. */
  | { readonly kind: "owner"; readonly field: string }
  /**
   * `members` or `via` across `relation` to `model`. `on` joins this row's
   * fields (`local`) to the related row's (`target`), position by position.
   * `who` narrows `via` to people who match one of its terms on the related row.
   * `where` filters the related rows; `own` (`this.field`) is a condition on this row.
   */
  | {
      readonly kind: "members" | "via";
      readonly relation: string;
      readonly model: string;
      readonly local: readonly string[];
      readonly target: readonly string[];
      readonly where?: RowFilter;
      readonly own?: RowFilter;
      readonly who?: readonly string[];
    };

export interface ModelRowAccess {
  /** The fields that identify a row. */
  readonly key: readonly string[];
  /** The user model: a user can see their own row. */
  readonly self?: true;
  /** `read(authenticated)`: every signed-in user sees every row. */
  readonly authenticated?: true;
  readonly rules: readonly RowRule[];
}

export interface RowAccessSettings {
  /** The model every `owner` relation points at; absent when no rule names one. */
  readonly userModel?: string;
  /** User-model fields the signed-in user must carry for the rules: its key and any scalar owner field. */
  readonly viewer: readonly string[];
  /** Models in the GraphQL API, with who may see their rows. Other models are absent. */
  readonly models: Readonly<Record<string, ModelRowAccess>>;
  /**
   * Membership models of Access Graph role scopes: the relation naming whose
   * membership a row is. A `members` rule matches the actor through it, even
   * when the membership model itself is not in the API.
   */
  readonly principals?: Readonly<Record<string, { readonly relation: string; readonly fields: readonly string[] }>>;
}

/** Who a `read`, `write`, `create`, `update` or `delete` rule lets through, and when. */
export interface AccessGrant {
  /** Client columns covered by this model create/update grant, when narrowed. */
  readonly columns?: readonly string[];
  /** `owner`, `anyone`, `member`, a role or a permission. Any one is enough. */
  readonly who: readonly string[];
  /** `owner`: the rule never applies to the row's own owner. */
  readonly except?: readonly string[];
  readonly where?: RowFilter;
  /** A field `write` only: the values it may assign. */
  readonly to?: RowFilterValue;
}

export interface PolicyField {
  readonly type: string;
  readonly list: boolean;
  readonly relation: boolean;
  /** How a relation joins: this row's fields and the related row's. */
  readonly local?: readonly string[];
  readonly target?: readonly string[];
  /** The owner's role in the group that lists these rows as members. */
  readonly role?: true;
  /** A foreign key behind `owner` or `via`: set at creation, moved only by its own `write` rule. */
  readonly link?: true;
  /** Further restricts this field to a row identity matching auth.id. */
  readonly readIdentity?: readonly string[];
  readonly read?: readonly AccessGrant[];
  readonly write?: readonly AccessGrant[];
}

export interface ModelPolicy {
  readonly fields: Readonly<Record<string, PolicyField>>;
  readonly create?: readonly AccessGrant[];
  readonly update?: readonly AccessGrant[];
  readonly delete?: readonly AccessGrant[];
  /** Who reads a field without its own `read` rule. */
  readonly read?: readonly AccessGrant[];
  /** An Access Graph `from:` model: a row is created only where its creator would see it (its parent, guards included). */
  readonly strict?: true;
}

export interface EnumPolicy {
  readonly values: readonly string[];
  /** Values the API may assign: every value not marked `read-only`. */
  readonly assignable: readonly string[];
  /** Named permission → the roles that hold it. */
  readonly grants: Readonly<Record<string, readonly string[]>>;
  /** Symbol → stored value, where they differ. */
  readonly stored?: Readonly<Record<string, string>>;
}

export interface AccessPolicy {
  readonly enums: Readonly<Record<string, EnumPolicy>>;
  readonly models: Readonly<Record<string, ModelPolicy>>;
  /** Named writes from schema directives or the access policy module. */
  readonly commands?: Readonly<Record<string, CommandDefinition>>;
}

export interface ClientAccessProblem {
  /** 1-based line in contract.prisma. */
  readonly line: number;
  /** 1-based column, for Access Graph directives. */
  readonly column?: number;
  /** An Access Graph diagnostic code, such as AG-STRAY. */
  readonly code?: string;
  readonly message: string;
}

// ─── Lexing one line ─────────────────────────────────────────────────────────

const MODEL = /^\s*model\s+([A-Za-z_]\w*)\b/;
const ENUM = /^\s*enum\s+([A-Za-z_]\w*)\b/;
const FIELD = /^\s*([A-Za-z_]\w*)\s+([^\s@]+)/;
const CLOCK = /@default\(\s*now\(\)\s*\)|\bon(?:Create|Update)\s*:\s*now\b|@updatedAt\b/;
const NAME = /^[A-Za-z_][\w-]*/;
/** Words that continue a rule list without parentheses; anything else after the first rule is prose. */
const BARE = new Set<string>([...FIELD_ACCESS_MODES, ...ROW_ACCESS_KINDS, ...FIELD_RULES, ...MODEL_RULES]);

const includes = <T extends string>(list: readonly T[], value: string | undefined): value is T =>
  (list as readonly (string | undefined)[]).includes(value);
const isFieldMode = (value: string | undefined): value is FieldAccessMode => includes(FIELD_ACCESS_MODES, value);
const isRowKind = (value: string | undefined): value is RowAccessKind => includes(ROW_ACCESS_KINDS, value);
const isWord = (value: string | undefined): value is AccessWord => !!value && BARE.has(value);

/** Where a line's `//` comment starts, ignoring `//` inside string literals; -1 without one. */
function commentIndex(text: string): number {
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === "\\") index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "/" && text[index + 1] === "/") return index;
  }
  return -1;
}

function braces(code: string): number {
  const bare = code.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (bare.match(/\{/g)?.length ?? 0) - (bare.match(/\}/g)?.length ?? 0);
}

const list = (text: string | undefined) => (text ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** One rule as written: `word` or `word(arguments)`. */
export interface AccessRule {
  readonly word: string;
  readonly columns?: readonly string[];
  /** The text between the parentheses, when there are any. */
  readonly args?: string;
  readonly unclosed: boolean;
  /** Offsets of the rule in its line. */
  readonly from: number;
  readonly to: number;
}

interface ParsedAccess {
  readonly rules: readonly AccessRule[];
  /** Offsets of `@access …` in the line. */
  readonly from: number;
  readonly to: number;
  /** Where the comment starts, and whether the rules are all it says. */
  readonly comment: number;
  readonly alone: boolean;
  /** Rules lowered from a directive: the directive's line, for diagnostics. */
  readonly line?: number;
}

function parseAccess(text: string): ParsedAccess | undefined {
  const comment = commentIndex(text);
  if (comment < 0) return undefined;
  // `/// @access(…)` is an Access Graph directive (scripts/access-graph.ts), and
  // `// @access(` a mistyped one it reports; neither is a rule of this grammar.
  if (text[comment + 2] === "/") return undefined;
  const marker = /@access\b/.exec(text.slice(comment + 2));
  if (!marker) return undefined;
  if (text[comment + 2 + marker.index + marker[0].length] === "(") return undefined;
  const from = comment + 2 + marker.index;
  let position = from + marker[0].length;
  const rules: AccessRule[] = [];
  for (;;) {
    let cursor = position;
    while (cursor < text.length && /[ \t,]/.test(text[cursor]!)) cursor++;
    // A rule needs a space after `@access` or the previous rule.
    if (cursor === position && !(rules.length && text[cursor - 1] === ")")) break;
    const name = NAME.exec(text.slice(cursor))?.[0];
    if (!name) break;
    let end = cursor + name.length;
    const call = text[end] === "(";
    // After the first rule, a word that is neither a known rule nor a call is ordinary comment text.
    if (rules.length && !call && !BARE.has(name)) break;
    let args: string | undefined;
    let unclosed = false;
    if (call) {
      const close = text.indexOf(")", end);
      unclosed = close < 0;
      args = text.slice(end + 1, unclosed ? text.length : close).trim();
      end = unclosed ? text.length : close + 1;
    }
    rules.push({ word: name, ...(args !== undefined ? { args } : {}), unclosed, from: cursor, to: end });
    position = end;
    if (unclosed) break;
  }
  const to = rules.length ? rules[rules.length - 1]!.to : from + marker[0].length;
  const alone = !text.slice(comment + 2, from).trim() && !text.slice(to).trim();
  return { rules, from, to, comment, alone };
}

interface Arguments {
  readonly who: readonly string[];
  readonly except: readonly string[];
  readonly where: Record<string, RowFilterValue>;
  /** `this.field: VALUE`: conditions on this row, where plain ones name a related row. */
  readonly own: Record<string, RowFilterValue>;
  /** `to: VALUE`: the values a field's write may assign. */
  readonly to?: RowFilterValue;
  readonly error?: string;
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;
const literal = (text: string): string | boolean => (text === "true" ? true : text === "false" ? false : text);

/** `ACTIVE`, `!CLOSED` or `PENDING | INVITED`; undefined when it is none of them. */
function parseValue(raw: string): RowFilterValue | undefined {
  const text = raw.trim();
  if (text.startsWith("!")) {
    const value = text.slice(1).trim();
    return IDENTIFIER.test(value) ? { not: literal(value) } : undefined;
  }
  const options = text.split("|").map((option) => option.trim());
  if (options.some((option) => !IDENTIFIER.test(option))) return undefined;
  if (options.length === 1) return literal(options[0]!);
  // Any of several is for enum values; a Boolean is already one of two.
  return options.some((option) => typeof literal(option) === "boolean") ? undefined : { in: options };
}

function parseArguments(raw: string | undefined): Arguments {
  const who: string[] = [];
  const except: string[] = [];
  const where: Record<string, RowFilterValue> = Object.create(null);
  const own: Record<string, RowFilterValue> = Object.create(null);
  let to: RowFilterValue | undefined;
  const result = (error?: string): Arguments => ({ who, except, where, own, ...(to !== undefined ? { to } : {}), ...(error ? { error } : {}) });
  for (const part of list(raw)) {
    const named = /^((?:this\s*\.\s*)?[A-Za-z_]\w*)\s*:\s*(.+)$/.exec(part);
    const term = named ? null : /^(!?)\s*([A-Za-z_]\w*)$/.exec(part);
    if (named) {
      const value = parseValue(named[2]!);
      if (value === undefined) return result(part);
      const self = /^this\s*\./.test(named[1]!);
      const key = named[1]!.replace(/^this\s*\.\s*/, "");
      if (!self && key === "to") {
        if (to !== undefined) return result("duplicate condition to");
        to = value;
        continue;
      }
      const into = self ? own : where;
      if (Object.prototype.hasOwnProperty.call(into, key)) return result(`duplicate condition ${self ? "this." : ""}${key}`);
      into[key] = value;
    } else if (term) (term[1] ? except : who).push(term[2]!);
    else return result(part);
  }
  return result();
}

// ─── Scanning the schema ─────────────────────────────────────────────────────

export interface FieldInfo {
  readonly name: string;
  /** The type's base name, without `?`, `[]`, arguments or namespace. */
  readonly type: string;
  readonly list: boolean;
  /** Written `Type?`. */
  readonly optional: boolean;
  /** Carries `@default(…)`. */
  readonly defaulted: boolean;
  readonly relation: boolean;
  readonly relationName?: string;
  readonly fields?: readonly string[];
  readonly references?: readonly string[];
  /** A relation's `onDelete` action, such as Cascade. */
  readonly onDelete?: string;
  readonly id: boolean;
  readonly unique: boolean;
  readonly clock: boolean;
  /** 1-based. */
  readonly line: number;
  readonly access?: ParsedAccess;
}

interface BlockRules {
  readonly line: number;
  readonly access: ParsedAccess;
}

export interface ModelInfo {
  readonly name: string;
  readonly line: number;
  end: number;
  readonly fields: Map<string, FieldInfo>;
  key: readonly string[];
  readonly uniques: Set<string>;
  /** `@@unique([a, b])` and `@@index([a, b], unique: true)` over several fields. */
  readonly compoundUniques: (readonly string[])[];
  /** Comment-only `@access` lines inside the model. */
  readonly rules: BlockRules[];
}

export interface EnumInfo {
  readonly name: string;
  readonly line: number;
  end: number;
  readonly values: Map<string, { readonly line: number; readonly stored?: string; readonly access?: ParsedAccess }>;
  /** Comment-only `@access` lines inside the enum: named permissions. */
  readonly rules: BlockRules[];
}

export interface Scanned {
  readonly models: Map<string, ModelInfo>;
  readonly enums: Map<string, EnumInfo>;
  /** `@access` on a line that can carry no rule, such as a block attribute. */
  readonly stray: readonly number[];
  /** Lines carrying a retired `// @access` rule, when the core text form was not asked for. */
  readonly retired: readonly { readonly line: number; readonly column: number; readonly text: string }[];
}

/**
 * Reading options. `legacy` accepts the core rules as text (`// @access owner`):
 * the form directives lower into, kept for suites that test the enforcement
 * core directly. A schema never needs it, and without it such a comment is an
 * AG-LEGACY problem rather than policy.
 */
export interface ReadOptions { readonly legacy?: boolean }

function scan(source: string, options: ReadOptions = {}): Scanned {
  const lines = source.split(/\r?\n/);
  const modelNames = new Set(lines.flatMap((line) => {
    const at = commentIndex(line);
    const match = MODEL.exec(at < 0 ? line : line.slice(0, at));
    return match ? [match[1]!] : [];
  }));
  const models = new Map<string, ModelInfo>();
  const enums = new Map<string, EnumInfo>();
  const stray: number[] = [];
  const retired: { line: number; column: number; text: string }[] = [];
  let depth = 0;
  let current: { kind: "model" | "enum"; name: string; depth: number } | undefined;
  lines.forEach((text, index) => {
    const at = commentIndex(text);
    const code = at < 0 ? text : text.slice(0, at);
    const parsedAccess = at < 0 ? undefined : parseAccess(text);
    if (parsedAccess && !options.legacy) retired.push({ line: index + 1, column: parsedAccess.from + 1, text: text.slice(parsedAccess.from, parsedAccess.to) });
    const access = options.legacy ? parsedAccess : undefined;
    const line = index + 1;
    let placed = false;
    if (!current) {
      const model = MODEL.exec(code);
      const enumeration = model ? null : ENUM.exec(code);
      if (model) {
        current = { kind: "model", name: model[1]!, depth };
        models.set(model[1]!, { name: model[1]!, line, end: line, fields: new Map(), key: [], uniques: new Set(), compoundUniques: [], rules: [] });
      } else if (enumeration) {
        current = { kind: "enum", name: enumeration[1]!, depth };
        enums.set(enumeration[1]!, { name: enumeration[1]!, line, end: line, values: new Map(), rules: [] });
      }
      // `model User { // @access update(owner)`: rules on the opening line belong to the block.
      if (access && model) models.get(model[1]!)!.rules.push({ line, access });
      if (access && enumeration) enums.get(enumeration[1]!)!.rules.push({ line, access });
      // A comment outside every block is documentation, not a rule.
      if (model || enumeration || !code.trim()) placed = true;
    } else if (depth === current.depth + 1) {
      const trimmed = code.trim();
      const block = current.kind === "model" ? models.get(current.name)! : enums.get(current.name)!;
      if (!trimmed) {
        if (access) block.rules.push({ line, access });
        placed = true;
      } else if (current.kind === "enum") {
        const value = /^([A-Za-z_]\w*)\s*(?:=\s*("(?:[^"\\]|\\.)*"))?/.exec(trimmed);
        if (value && !trimmed.startsWith("@@")) {
          const stored = value[2] ? (JSON.parse(value[2]) as string) : undefined;
          enums.get(current.name)!.values.set(value[1]!, {
            line,
            ...(stored !== undefined && stored !== value[1] ? { stored } : {}),
            ...(access ? { access } : {}),
          });
          placed = true;
        }
      } else if (trimmed.startsWith("@@")) {
        const model = models.get(current.name)!;
        const columns = list(/\[\s*([^\]]*)\]/.exec(trimmed)?.[1]);
        const unique = trimmed.startsWith("@@unique") || /\bunique\s*:\s*true\b/.test(trimmed);
        if (trimmed.startsWith("@@id")) model.key = columns;
        else if (columns.length === 1 && unique) model.uniques.add(columns[0]!);
        else if (columns.length > 1 && unique) model.compoundUniques.push(columns);
      } else {
        const field = FIELD.exec(code);
        if (field) {
          const raw = field[2]!;
          const base = raw.replace(/\(.*$/, "").replace(/\[\]|[?!]/g, "");
          const type = base.slice(base.lastIndexOf(".") + 1);
          const attribute = /@relation\(([^)]*)\)/.exec(code)?.[1] ?? "";
          const relationName = /^\s*"([^"]+)"/.exec(attribute)?.[1] ?? /\bname\s*:\s*"([^"]+)"/.exec(attribute)?.[1];
          const info: FieldInfo = {
            name: field[1]!,
            type,
            list: raw.includes("[]"),
            optional: raw.includes("?"),
            defaulted: /@default\s*\(/.test(code),
            relation: modelNames.has(type),
            ...(relationName ? { relationName } : {}),
            ...(/\bfields\s*:/.test(attribute) ? { fields: list(/\bfields\s*:\s*\[([^\]]*)\]/.exec(attribute)?.[1]) } : {}),
            ...(/\breferences\s*:/.test(attribute) ? { references: list(/\breferences\s*:\s*\[([^\]]*)\]/.exec(attribute)?.[1]) } : {}),
            ...(/\bonDelete\s*:\s*(\w+)/.exec(attribute) ? { onDelete: /\bonDelete\s*:\s*(\w+)/.exec(attribute)![1]! } : {}),
            id: /@id\b/.test(code),
            unique: /@unique\b/.test(code),
            clock: CLOCK.test(code),
            line,
            ...(access ? { access } : {}),
          };
          const model = models.get(current.name)!;
          model.fields.set(info.name, info);
          if (info.id) model.key = [info.name];
          if (info.unique) model.uniques.add(info.name);
          placed = true;
        }
      }
    }
    if (access && !placed) stray.push(line);
    depth += braces(code);
    if (current && depth <= current.depth) {
      (current.kind === "model" ? models.get(current.name)! : enums.get(current.name)!).end = line;
      current = undefined;
    }
  });
  return { models, enums, stray, retired };
}

/** The field across a relation that holds the foreign key, and how the two sides join. */
function join(scanned: Scanned, model: ModelInfo, field: FieldInfo): { local: readonly string[]; target: readonly string[] } | undefined {
  if (field.fields?.length && field.references?.length) return { local: field.fields, target: field.references };
  const other = scanned.models.get(field.type);
  if (!other) return undefined;
  const inverse = [...other.fields.values()].filter((candidate) =>
    candidate.relation && candidate.type === model.name && candidate.fields?.length && candidate.references?.length
    && candidate.relationName === field.relationName && !(other === model && candidate.name === field.name));
  if (inverse.length !== 1) return undefined;
  return { local: inverse[0]!.references!, target: inverse[0]!.fields! };
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface AccessIndex {
  /** 1-based lines, for an editor that changes rules in place. */
  readonly models: Readonly<Record<string, {
    readonly line: number;
    readonly end: number;
    readonly fields: Readonly<Record<string, number>>;
    readonly rules: readonly number[];
  }>>;
  readonly enums: Readonly<Record<string, {
    readonly line: number;
    readonly end: number;
    readonly values: Readonly<Record<string, number>>;
    readonly rules: readonly number[];
  }>>;
}

interface Read {
  readonly settings: ClientAccessSettings;
  readonly rows: RowAccessSettings;
  readonly policy: AccessPolicy;
  readonly problems: ClientAccessProblem[];
  readonly index: AccessIndex;
  /** The resolved Access Graph directives fingerprinted by aws-studio db:generate. */
  readonly graph: AccessGraph;
}

const isImplied = (model: ModelInfo, field: FieldInfo) => !field.relation && (field.id || model.key.includes(field.name) || field.clock);

let registered: AccessModules | undefined;
/**
 * The access policy module's compiled data (generated access-graph.json `modules`),
 * for editors that read rules without passing it, such as Studio's views.
 */
export function registerAccessModules(modules: AccessModules | undefined): void {
  registered = modules;
}

function read(scanned: Scanned, source: string, modules: AccessModules | undefined = registered): Read {
  const settings: Record<string, Record<string, FieldAccessMode>> = Object.create(null);
  const problems: ClientAccessProblem[] = [];
  const problem = (line: number, message: string) => problems.push({ line, message });

  for (const line of scanned.stray) problem(line, "Put @access at the end of a field's line, or on a comment line of its own inside a model or enum.");
  for (const { line, column, text } of scanned.retired) {
    problems.push({ line, column, code: "AG-LEGACY", message: `AG-LEGACY: "${text}" is a retired rule. Write a directive on the line above instead: owner becomes /// @access(read: isMe(userId)) on the model, via becomes relation.read, and permissions are written above the enum, such as /// @access(invite: [OWNER, ADMIN]). See docs/PRISMA-ACCESS.md.` });
  }

  // ── Enums: named permissions and values the API never assigns.
  const enums: Record<string, { values: string[]; assignable: string[]; grants: Record<string, string[]>; stored?: Record<string, string> }> = Object.create(null);
  for (const enumeration of scanned.enums.values()) {
    const values = [...enumeration.values.keys()];
    const stored = Object.fromEntries([...enumeration.values].flatMap(([name, value]) => (value.stored === undefined ? [] : [[name, value.stored]])));
    const entry = { values, assignable: [...values], grants: Object.create(null) as Record<string, string[]>, ...(Object.keys(stored).length ? { stored } : {}) };
    for (const [name, value] of enumeration.values) {
      for (const rule of value.access?.rules ?? []) {
        if (rule.word === "read-only" && rule.args === undefined) entry.assignable = entry.assignable.filter((item) => item !== name);
        else problem(value.line, `An enum value takes read-only: the API then never assigns ${enumeration.name}.${name}, or replaces it. "${rule.word}" is not a setting here.`);
      }
      if (value.access && !value.access.rules.length) problem(value.line, "Write a setting after @access.");
    }
    for (const { line, access } of enumeration.rules) {
      if (!access.rules.length) problem(line, "Write a permission after @access, such as invite(OWNER, ADMIN).");
      for (const rule of access.rules) {
        const at = (message: string) => problem(line, message);
        if (rule.unclosed) { at(`Close the parentheses after "${rule.word}" in ${enumeration.name}.`); continue; }
        if (rule.args === undefined) { at(`A permission lists the roles that hold it: ${rule.word}(${values.slice(0, 2).join(", ") || "ROLE"}).`); continue; }
        if (BARE.has(rule.word) || includes(AUDIENCE_WORDS, rule.word) || values.includes(rule.word) || !/^[A-Za-z_]\w*$/.test(rule.word)) {
          at(`"${rule.word}" cannot name a permission in ${enumeration.name}: it already means something else.`);
          continue;
        }
        const parsed = parseArguments(rule.args);
        if (parsed.error || parsed.except.length || Object.keys(parsed.where).length || Object.keys(parsed.own).length || parsed.to !== undefined) { at(`${rule.word} lists roles only, such as ${rule.word}(${values.slice(0, 2).join(", ")}).`); continue; }
        const unknown = parsed.who.find((role) => !values.includes(role));
        if (unknown) { at(`${unknown} is not a ${enumeration.name} value. Use one of ${values.join(", ")}.`); continue; }
        if (rule.word in entry.grants) { at(`${enumeration.name} already declares the permission ${rule.word}.`); continue; }
        entry.grants[rule.word] = values.filter((value) => parsed.who.includes(value));
      }
    }
    enums[enumeration.name] = entry;
  }

  // ── Access Graph directives, lowered into the same rules this grammar produces.
  // ── The user model: every owner relation points at it.
  const rulesOn = (field: FieldInfo) => field.access?.rules ?? [];
  const ownerTargets = new Map<string, number>();
  for (const model of scanned.models.values()) {
    for (const field of model.fields.values()) {
      if (field.relation && rulesOn(field).some((rule) => rule.word === "owner") && !field.list && field.fields?.length && !ownerTargets.has(field.type)) {
        ownerTargets.set(field.type, field.line);
      }
    }
  }
  const graph = lowerAccessGraph(source, scanned, enums, modules, join.bind(null, scanned), ({ line, column, code, message }) =>
    problems.push({ line, ...(column ? { column } : {}), code, message: `${code}: ${message}` }), ownerTargets.keys().next().value);

  for (const name of graph.enums) {
    const entry = enums[name]!;
    entry.assignable = [...graph.enumAssignable[name]!];
    entry.grants = Object.fromEntries(Object.entries(graph.enumGrants[name] ?? {}).map(([key, roles]) => [key, [...roles]]));
  }

  // Allow-rule models: their directives, lowered into core rules, are read like any others.
  const lowered = (list: readonly CoreRule[]): ParsedAccess => ({
    rules: list.map((rule) => ({ ...rule, unclosed: false, from: rule.column - 1, to: rule.column - 1 })),
    from: 0, to: 0, comment: -1, alone: true, line: list[0]!.line,
  });
  for (const [name, core] of graph.core) {
    const model = scanned.models.get(name)!;
    for (const [field, list] of core.fields) if (list.length) model.fields.set(field, { ...model.fields.get(field)!, access: lowered(list) });
    for (const rule of core.model) model.rules.push({ line: rule.line, access: lowered([rule]) });
  }

  // Access Graph names its principal; legacy owner relations must agree with it.
  if (graph.principal && scanned.models.has(graph.principal)) {
    const elsewhere = [...ownerTargets.entries()].find(([target]) => target !== graph.principal);
    if (elsewhere) problem(elsewhere[1], `Every owner relation must point at the principal model ${graph.principal}; this one points at ${elsewhere[0]}.`);
    ownerTargets.clear();
    ownerTargets.set(graph.principal, scanned.models.get(graph.principal)!.line);
  }
  const [userModelName] = [...ownerTargets.keys()];
  const userModel = userModelName ? scanned.models.get(userModelName) : undefined;
  if (ownerTargets.size > 1) {
    const [, second] = [...ownerTargets.entries()];
    problem(second![1], `Every owner relation must point at one user model. This one points at ${second![0]}; another points at ${userModelName}.`);
  }

  // ── Pass 1: field settings, row rules and role fields.
  const rules = new Map<string, RowRule[]>();
  const add = (model: string, rule: RowRule) => (rules.get(model) ?? rules.set(model, []).get(model)!).push(rule);
  const pending: { model: string; field: FieldInfo; rule: Extract<RowRule, { kind: "members" | "via" }>; who: readonly string[] }[] = [];
  const viewer = new Set<string>();
  /** Membership model → its role field and that field's enum. */
  const roleFields = new Map<string, { field: string; enumeration: string; line: number }>();
  /** Rules that need the whole schema read before they can be checked. */
  const grants: { model: ModelInfo; field?: FieldInfo; line: number; rule: AccessRule }[] = [];

  const filterProblem = (target: ModelInfo, where: Readonly<Record<string, RowFilterValue>>): string | undefined => {
    for (const [key, raw] of Object.entries(where)) {
      const options = typeof raw !== "object" ? [raw] : "in" in raw ? raw.in : [raw.not];
      const column = target.fields.get(key);
      if (!column || column.relation) return `${target.name} has no field "${key}" to filter on.`;
      for (const value of options) {
        if (typeof value === "boolean") {
          if (column.type !== "Boolean") return `${target.name}.${key} is not a Boolean.`;
          continue;
        }
        const values = enums[column.type]?.values;
        if (!values) return `${target.name}.${key} is not an enum or Boolean, so it cannot be filtered on.`;
        if (!values.includes(value)) return `${value} is not a ${column.type} value. Use one of ${values.join(", ")}.`;
      }
    }
    return undefined;
  };

  for (const model of scanned.models.values()) {
    const fields: Record<string, FieldAccessMode> = Object.create(null);
    if (graph.models.has(model.name)) {
      // Governed by its directive: legacy rules on it were reported as AG-MIXED.
      for (const field of model.fields.values()) if (isImplied(model, field)) fields[field.name] = "read-only";
      Object.assign(fields, graph.settings[model.name] ?? {});
      if (Object.keys(fields).length) settings[model.name] = fields;
      continue;
    }
    for (const field of model.fields.values()) {
      const name = `${model.name}.${field.name}`;
      const graphMode = graph.settings[model.name]?.[field.name];
      if (graphMode) fields[field.name] = graphMode;
      else if (isImplied(model, field)) fields[field.name] = "read-only";
      if (!field.access) continue;
      const at = (message: string) => problem(field.access!.line ?? field.line, message);
      if (!field.access.rules.length) { at("Write a setting after @access."); continue; }
      let mode: string | undefined;
      let rowRule: string | undefined;
      const seen = new Set<string>();
      for (const rule of field.access.rules) {
        const { word } = rule;
        if (word === "editable") { at(`Fields inherit model rules: remove "@access editable" from ${name}. Client assignments require a write grant.`); continue; }
        if (!isWord(word) || (!isFieldMode(word) && !isRowKind(word) && !includes(FIELD_RULES, word))) {
          at(includes(MODEL_RULES, word)
            ? `${word} belongs on a comment line of its own inside ${model.name}, not on ${name}.`
            : `Unknown access setting "${word}" on ${name}. Use server-only, read-only, read or write on a field, or owner, members or via on a relation.`);
          continue;
        }
        if (rule.unclosed) { at(`Close the parentheses after "${word}" on ${name}.`); continue; }
        // Several read, write, members or via clauses are alternatives, ORed.
        if (seen.has(word) && !["read", "write", "members", "via"].includes(word)) { at(`${name} says ${word} twice.`); continue; }
        seen.add(word);
        if (rule.args !== undefined && (isFieldMode(word) || word === "owner" || word === "role")) {
          at(`${word} takes no filter; only members and via do.`);
          continue;
        }

        if (isFieldMode(word)) {
          if (field.relation) { at(`${name} is a relation. Set ${word} on its foreign-key field, or use owner, members or via here.`); continue; }
          if (mode) { at(`${name} is already ${mode}; it cannot also be ${word}.`); continue; }
          mode = word;
          fields[field.name] = word;
          continue;
        }

        if (word === "role") {
          if (field.relation || field.list || !enums[field.type]) { at(`role marks an enum field, such as role MembershipRole. ${name} is not an enum.`); continue; }
          if (roleFields.has(model.name)) { at(`${model.name} already marks ${roleFields.get(model.name)!.field} as its role.`); continue; }
          roleFields.set(model.name, { field: field.name, enumeration: field.type, line: field.line });
          continue;
        }

        if (word === "read" || word === "write") {
          if (field.relation) { at(`${word} governs a field's value. ${name} is a relation; use owner, members or via here.`); continue; }
          grants.push({ model, field, line: field.access.line ?? field.line, rule });
          continue;
        }

        if (rowRule && rowRule !== word) { at(`${name} already says ${rowRule}; it cannot also say ${word}.`); continue; }
        rowRule = word;

        if (word === "owner") {
          if (!field.relation) {
            if (!userModel) { at(`owner on ${name} names the user by a field, but no owner relation says which model holds users.`); continue; }
            const match = userModel.fields.get(field.name);
            if (!match || match.relation || !userModel.uniques.has(field.name)) {
              at(`owner on ${name} matches ${userModel.name}.${field.name}, which must be a unique field of ${userModel.name}.`);
              continue;
            }
            add(model.name, { kind: "owner", field: field.name });
            viewer.add(field.name);
            continue;
          }
          if (field.list || !field.fields?.length) { at(`owner needs a to-one relation that holds the foreign key, such as user User @relation(fields: [userId], references: [id]).`); continue; }
          if (userModel && field.type !== userModel.name) continue; // Reported once, above.
          if (userModel && field.references?.join() !== userModel.key.join()) {
            at(`owner on ${name} must reference ${userModel.name}'s key (${userModel.key.join(", ") || "none"}).`);
            continue;
          }
          add(model.name, { kind: "owner", relation: field.name, fields: field.fields });
          continue;
        }

        // members or via
        if (!field.relation) { at(`${word} needs a relation; ${name} is a field.`); continue; }
        if (word === "members" && !field.list) { at(`members needs a list relation, such as memberships Membership[]. Use via on ${name}.`); continue; }
        const on = join(scanned, model, field);
        if (!on) { at(`Cannot tell how ${name} joins ${field.type}. Name the relation on both sides with @relation("Name").`); continue; }
        const parsed = parseArguments(rule.args);
        if (parsed.error) {
          at(word === "members"
            ? `"${parsed.error}" is not a filter. Write field: VALUE, for example membershipStatus: ACTIVE.`
            : `"${parsed.error}" is not valid in via. Write who it is limited to, or a filter such as status: ACTIVE.`);
          continue;
        }
        if (word === "members" && (parsed.who.length || parsed.except.length)) {
          at(`members takes a filter only, such as members(status: ACTIVE). "${[...parsed.who, ...parsed.except][0]}" is not one.`);
          continue;
        }
        if (parsed.except.length) { at(`via cannot exclude "${parsed.except[0]}". List who it is limited to.`); continue; }
        if (parsed.to !== undefined) { at(`to: names the value a field's write assigns; ${word} on ${name} cannot take it.`); continue; }
        const bad = filterProblem(scanned.models.get(field.type)!, parsed.where) ?? filterProblem(model, parsed.own);
        if (bad) { at(bad); continue; }
        const row = {
          kind: word, relation: field.name, model: field.type, local: on.local, target: on.target,
          ...(Object.keys(parsed.where).length ? { where: { ...parsed.where } } : {}),
          ...(Object.keys(parsed.own).length ? { own: { ...parsed.own } } : {}),
          ...(parsed.who.length ? { who: parsed.who } : {}),
        } as const;
        add(model.name, row);
        pending.push({ model: model.name, field, rule: row, who: parsed.who });
      }
    }
    if (Object.keys(fields).length) settings[model.name] = fields;
    for (const { line, access } of model.rules) {
      if (!access.rules.length) problem(line, "Write a rule after @access, such as update(owner).");
      for (const rule of access.rules) {
        if (!includes(MODEL_RULES, rule.word)) {
          problem(line, isWord(rule.word)
            ? `${rule.word} belongs at the end of a field's line. A model line takes create, update, delete or read.`
            : `Unknown access rule "${rule.word}" in ${model.name}. A model line takes create, update, delete or read.`);
          continue;
        }
        if (rule.unclosed) { problem(line, `Close the parentheses after "${rule.word}" in ${model.name}.`); continue; }
        grants.push({ model, line, rule });
      }
    }
  }

  // Directive models' lowered rules and role sources join the legacy ones.
  for (const [model, lowered] of graph.rules) for (const rule of lowered) add(model, rule);
  for (const [model, role] of graph.roleFields) {
    const marked = roleFields.get(model);
    if (marked && marked.field !== role.field) problem(marked.line, `${model} gives roles through ${role.field} (a roles: directive), so ${marked.field} cannot also be marked role.`);
    else roleFields.set(model, role);
  }

  // A model line's `read(authenticated)` shows every row to every signed-in user: a row rule of its own.
  const everyone = new Set(grants.filter(({ field, rule }) => !field && rule.word === "read" && !rule.unclosed && parseArguments(rule.args).who.includes("authenticated")).map(({ model }) => model.name));
  const exposedModel = (model: string) => (rules.get(model)?.length ?? 0) > 0 || everyone.has(model) || model === userModelName;

  // A scalar directive can only narrow an exposed row policy.
  for (const [model, fields] of Object.entries(graph.graph.fieldRules ?? {})) {
    if (exposedModel(model)) continue;
    for (const field of Object.keys(fields)) {
      const line = scanned.models.get(model)!.fields.get(field)!.line;
      problems.push({ line, code: "AG-FIELD-MODEL", message: `AG-FIELD-MODEL: ${model}.${field} has no row policy to restrict.` });
    }
  }

  // The foreign keys behind owner and via decide who sees a row: access links.
  const links = new Map<string, Set<string>>();
  for (const [name, own] of rules) {
    const model = scanned.models.get(name)!;
    for (const rule of own) {
      const columns = rule.kind === "owner" ? ("relation" in rule ? rule.fields : [rule.field]) : rule.local;
      // members, and via over a list, join through this row's key, which never changes anyway.
      for (const column of columns) if (!model.key.includes(column) && model.fields.get(column) && !model.fields.get(column)!.relation) (links.get(name) ?? links.set(name, new Set()).get(name)!).add(column);
    }
  }

  // members counts the owners of the related rows, so they must have one.
  const owned = (model: string) => (rules.get(model) ?? []).some((rule) => rule.kind === "owner") || !!graph.principals[model];
  for (const { model, field, rule } of pending) {
    if (rule.kind === "members" && !owned(rule.model)) {
      problem(field.line, `members on ${model}.${field.name} counts the owners of ${rule.model} rows, but ${rule.model} has no owner. Add @access owner to the relation that names its user.`);
    }
  }
  for (const [model, role] of roleFields) {
    if (!owned(model)) problem(role.line, `role on ${model}.${role.field} is its owner's role, but ${model} has no owner. Add @access owner to the relation that names its user.`);
  }

  // via must end somewhere: no model may reach itself through via alone.
  const viaEdges = (model: string) => (rules.get(model) ?? []).filter((rule): rule is Extract<RowRule, { kind: "members" | "via" }> => rule.kind === "via");
  const done = new Set<string>();
  const visit = (model: string, path: string[]): void => {
    if (done.has(model)) return;
    for (const edge of viaEdges(model)) {
      const start = path.indexOf(edge.model);
      if (edge.model === model || start >= 0) {
        const cycle = [...path.slice(Math.max(0, start)), model, edge.model];
        const line = scanned.models.get(model)!.fields.get(edge.relation)!.line;
        problem(line, `via goes round in a circle: ${cycle.join(" → ")}. Give one of these models owner or members instead.`);
        continue;
      }
      visit(edge.model, [...path, model]);
    }
    done.add(model);
  };
  for (const model of rules.keys()) visit(model, []);

  // ── Who a rule may name: the role enums that reach a model through its group.
  const roleEnumsOf = (model: string, seen = new Set<string>()): Set<string> => {
    const found = new Set<string>();
    if (seen.has(model)) return found;
    seen.add(model);
    for (const rule of rules.get(model) ?? []) {
      if (rule.kind === "members" && roleFields.has(rule.model)) found.add(roleFields.get(rule.model)!.enumeration);
      if (rule.kind === "via") for (const name of roleEnumsOf(rule.model, seen)) found.add(name);
    }
    return found;
  };
  const whoProblem = (model: string, terms: readonly string[], word: string, onModel = false): string | undefined => {
    const roleEnums = [...roleEnumsOf(model)];
    for (const term of terms) {
      if (term === "anyone") continue;
      if (term === "authenticated") {
        if (word === "create" || (word === "read" && onModel)) continue;
        return `authenticated means any signed-in user; only create and a model's read take it. Use anyone in ${word}: whoever can see the row.`;
      }
      if (term === "owner") {
        if (owned(model) || scanned.models.get(model) === userModel) continue;
        return `owner means the row's owner, but ${model} has none. Add @access owner to the relation that names its user.`;
      }
      const known = roleEnums.some((name) => term === "member" || enums[name]!.values.includes(term) || Object.prototype.hasOwnProperty.call(enums[name]!.grants, term));
      if (known) continue;
      if (!roleEnums.length) {
        return `"${term}" is a role or permission, but no role reaches ${model}. Mark the membership's role field with @access role, and reach its group from ${model} with via.`;
      }
      const offered = roleEnums.flatMap((name) => [...enums[name]!.values, ...Object.keys(enums[name]!.grants)]);
      return `"${term}" is not a role or permission of ${roleEnums.join(" or ")}. Use owner, anyone, member, or one of ${offered.join(", ")}.`;
    }
    return undefined;
  };
  for (const { model, field, rule, who } of pending) {
    if (rule.kind === "via" && !exposedModel(rule.model)) problem(field.line, `via on ${model}.${field.name} reaches ${rule.model}, which has no row rules. Add owner, members or via to that model first.`);
    const bad = rule.kind === "via" ? whoProblem(rule.model, who, "via") : undefined;
    if (bad) problem(field.line, `${model}.${field.name}: ${bad}`);
  }

  // ── Pass 2: read, write, create, update and delete.
  const fieldGrants = new Map<string, { read?: AccessGrant[]; write?: AccessGrant[] }>();
  const modelGrants = new Map<string, Partial<Record<ModelRule, AccessGrant[]>>>();
  for (const { model, field, line, rule } of grants) {
    const where = field ? `${model.name}.${field.name}` : model.name;
    const at = (message: string) => problem(line, message);
    const word = rule.word as "read" | "write" | ModelRule;
    if (!exposedModel(model.name)) { at(`${model.name} has no row rule, so it is not in the GraphQL API and ${word} can never apply. Add owner, members or via to one of its relations.`); continue; }
    const parsed = parseArguments(rule.args);
    if (parsed.error) { at(`"${parsed.error}" is not valid in ${word}. Write who, such as owner or a role, or a condition such as status: ACTIVE.`); continue; }
    if (!parsed.who.length && rule.args !== "") { at(`${word} on ${where} must say who: ${word}(owner), ${word}(anyone) or a role.`); continue; }
    const strange = parsed.except.find((term) => term !== "owner");
    if (strange) { at(`Only !owner excludes someone. "!${strange}" is not valid in ${word}.`); continue; }
    // Here every condition names this row, so `this.status` and `status` say the same.
    const doubled = Object.keys(parsed.own).find((key) => key in parsed.where);
    if (doubled) { at(`${word} on ${where} names ${doubled} twice.`); continue; }
    const conditions = { ...parsed.where, ...parsed.own };
    if (parsed.to !== undefined && !(field && word === "write")) { at(`to: names the value a field's write assigns; ${word} on ${where} cannot take it.`); continue; }
    const bad = whoProblem(model.name, parsed.who, word, !field) ?? filterProblem(model, conditions)
      ?? (parsed.to !== undefined && field ? filterProblem(model, { [field.name]: parsed.to }) : undefined);
    if (bad) { at(bad); continue; }
    const neverAssigned = parsed.to !== undefined && field && enums[field.type]
      ? (typeof parsed.to !== "object" ? [parsed.to] : "in" in parsed.to ? parsed.to.in : []).find((value) => typeof value === "string" && !enums[field.type]!.assignable.includes(value))
      : undefined;
    if (neverAssigned) { at(`${field!.type}.${neverAssigned} is read-only: the API never assigns it, so to: cannot name it.`); continue; }
    if (field && word === "write" && (settings[model.name]?.[field.name] || isImplied(model, field))) {
      at(`${where} is ${settings[model.name]?.[field.name] ?? "read-only"}, so write can never apply. Remove one of them.`);
      continue;
    }
    if (field && word === "read" && settings[model.name]?.[field.name] === "server-only") {
      at(`${where} is server-only, so read can never apply. Remove one of them.`);
      continue;
    }
    const grant: AccessGrant = {
      who: parsed.who,
      ...(rule.columns ? { columns: rule.columns } : {}),
      ...(parsed.except.length ? { except: parsed.except } : {}),
      ...(Object.keys(conditions).length ? { where: conditions } : {}),
      ...(parsed.to !== undefined ? { to: parsed.to } : {}),
    };
    if (field) {
      const key = `${model.name}.${field.name}`;
      const entry = fieldGrants.get(key) ?? fieldGrants.set(key, {}).get(key)!;
      (entry[word as "read" | "write"] ??= []).push(grant);
    } else {
      const entry = modelGrants.get(model.name) ?? modelGrants.set(model.name, {}).get(model.name)!;
      (entry[word as ModelRule] ??= []).push(grant);
    }
  }
  // Directive models: each action granted to the roles whose masks hold it there.
  for (const [model, lowered] of graph.grants) {
    const entry = modelGrants.get(model) ?? modelGrants.set(model, {}).get(model)!;
    for (const [word, list] of Object.entries(lowered) as [ModelRule, readonly AccessGrant[]][]) (entry[word] ??= []).push(...list);
  }

  // A move is judged at both ends: the link's write rule on the stored row, create on the moved one.
  for (const [name, columns] of links) {
    const model = scanned.models.get(name)!;
    for (const column of columns) {
      if (fieldGrants.get(`${name}.${column}`)?.write && !modelGrants.get(name)?.create) {
        problem(model.fields.get(column)!.line, `${name}.${column} links each row to who may see it, so writing it moves the row. A move must also pass ${name}'s create rule at its destination: add create(…) to ${name}, or remove write.`);
      }
    }
  }

  // A user reference that is not the owner is a decision: who may set it?
  if (userModel) {
    for (const model of scanned.models.values()) {
      const declared = modelGrants.get(model.name);
      // A directive model's principal links are protected already (lowerAccessGraph).
      if (graph.models.has(model.name) || (!declared?.create && !declared?.update)) continue;
      for (const field of model.fields.values()) {
        if (!field.relation || field.list || field.type !== userModel.name || !field.fields?.length) continue;
        if ((rules.get(model.name) ?? []).some((rule) => rule.kind === "owner" && "relation" in rule && rule.relation === field.name)) continue;
        for (const column of field.fields) {
          const info = model.fields.get(column);
          if (!info || settings[model.name]?.[column] || isImplied(model, info) || links.get(model.name)?.has(column) || fieldGrants.get(`${model.name}.${column}`)?.write) continue;
          problem(info.line, `${model.name}.${column} names a ${userModel.name} that clients could choose when they ${declared.create ? "create" : "update"} a row. Mark it read-only if the server sets it, make ${field.name} the owner, or say who may assign it with write(…).`);
        }
      }
    }
  }

  // ── Both command forms use the same audience, field and state validation.
  const commands: Record<string, CommandDefinition> = Object.create(null);
  const declaredCommands = { ...modules?.commands, ...graph.graph.commands };
  for (const [name, command] of Object.entries(declaredCommands)) {
    const locations = graph.graph.provenance.commands?.[name];
    const at = (message: string, index = 0) => {
      const site = locations?.[index];
      if (site) problems.push({ line: site.line, column: site.column, code: "AG-COMMAND-DIRECTIVE", message: `AG-COMMAND-DIRECTIVE: command ${name}: ${message}` });
      else problems.push({ line: 1, code: "AG-COMMAND", message: `AG-COMMAND: prisma/access command ${name}: ${message}` });
    };
    if (!/^[a-z]\w*$/.test(name)) { at("a command name starts with a lowercase letter."); continue; }
    if (!command.writes.length) { at("it declares no writes."); continue; }
    let valid = true;
    for (const [index, write] of command.writes.entries()) {
      const model = scanned.models.get(write.model);
      const fail = (message: string) => { at(`${write.verb} ${write.model}: ${message}`, index); valid = false; };
      if (!model) { fail(`${write.model} is not a model.`); continue; }
      if (!exposedModel(write.model)) { fail(`${write.model} is not in the client API. Give it a directive or row rule first.`); continue; }
      if (!(WRITE_VERBS as readonly string[]).includes(write.verb)) { fail("the verb is create, update or delete."); continue; }
      if (command.who !== "authenticated") {
        const bad = whoProblem(write.model, [command.who], write.verb, true);
        if (bad) { fail(bad); continue; }
      }
      if (write.verb === "delete" && write.fields?.length) { fail("a delete assigns no fields."); continue; }
      for (const field of write.fields ?? []) {
        const info = model.fields.get(field);
        const mode = settings[write.model]?.[field];
        if (!info || info.relation) fail(`${field} is not a scalar field.`);
        else if (mode === "server-only" || mode === "read-only") fail(`${field} is ${mode}: clients never assign it. Set it from the server in the write's row.`);
        else if (write.verb === "update" && links.get(write.model)?.has(field)) fail(`${field} links the row to who may see it; a command never moves a row.`);
      }
      const bad = filterProblem(model, write.when ?? {});
      if (bad) fail(bad);
      for (const [field, values] of Object.entries(write.to ?? {})) {
        if (!(write.fields ?? []).includes(field)) { fail(`to: names ${field}, which the write does not assign.`); continue; }
        const problem = filterProblem(model, { [field]: values });
        if (problem) fail(problem);
      }
    }
    if (valid) commands[name] = command;
  }
  graph.graph = { ...graph.graph, commands };

  // ── Results.
  const models: Record<string, ModelRowAccess> = Object.create(null);
  for (const model of scanned.models.values()) {
    const own = rules.get(model.name) ?? [];
    const self = model === userModel;
    const all = everyone.has(model.name);
    if (!own.length && !self && !all) continue;
    if (!model.key.length) {
      problem(model.line, `${model.name} has access rules but no @id, so its rows cannot be checked.`);
      continue;
    }
    models[model.name] = { key: model.key, ...(self ? { self: true as const } : {}), ...(all ? { authenticated: true as const } : {}), rules: own };
  }
  const policyModels: Record<string, ModelPolicy> = Object.create(null);
  for (const model of scanned.models.values()) {
    const fields: Record<string, PolicyField> = Object.create(null);
    for (const field of model.fields.values()) {
      const on = field.relation ? join(scanned, model, field) : undefined;
      const own = fieldGrants.get(`${model.name}.${field.name}`);
      const readIdentity = graph.graph.fieldRules?.[model.name]?.[field.name]?.readIdentity;
      fields[field.name] = {
        ...(readIdentity ? { readIdentity } : {}),
        type: field.type, list: field.list, relation: field.relation,
        ...(on ? { local: on.local, target: on.target } : {}),
        ...(roleFields.get(model.name)?.field === field.name ? { role: true as const } : {}),
        ...(links.get(model.name)?.has(field.name) ? { link: true as const } : {}),
        ...(own?.read ? { read: own.read } : {}),
        ...(own?.write ? { write: own.write } : {}),
      };
    }
    const own = modelGrants.get(model.name) ?? {};
    policyModels[model.name] = {
      fields,
      ...(own.create ? { create: own.create } : {}),
      ...(own.update ? { update: own.update } : {}),
      ...(own.delete ? { delete: own.delete } : {}),
      ...(own.read ? { read: own.read } : {}),
      ...(graph.strict.has(model.name) ? { strict: true as const } : {}),
    };
  }
  const key = userModel?.key ?? [];
  problems.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
  return {
    settings,
    rows: {
      ...(userModel ? { userModel: userModel.name } : {}),
      viewer: [...key, ...[...viewer].filter((field) => !key.includes(field)).sort()],
      models,
      ...(Object.keys(graph.principals).length ? { principals: graph.principals } : {}),
    },
    policy: { enums, models: policyModels, ...(Object.keys(commands).length ? { commands } : {}) },
    graph: graph.graph,
    problems,
    index: {
      models: Object.fromEntries([...scanned.models].map(([name, model]) => [name, {
        line: model.line, end: model.end,
        fields: Object.fromEntries([...model.fields].map(([field, info]) => [field, info.line])),
        rules: model.rules.map((rule) => rule.line),
      }])),
      enums: Object.fromEntries([...scanned.enums].map(([name, enumeration]) => [name, {
        line: enumeration.line, end: enumeration.end,
        values: Object.fromEntries([...enumeration.values].map(([value, info]) => [value, info.line])),
        rules: enumeration.rules.map((rule) => rule.line),
      }])),
    },
  };
}

/** Every rule in a contract, plus anything that would be silently ignored or is invalid. */
export function readClientAccess(source: string, modules?: AccessModules, options?: ReadOptions): Read {
  return read(scan(source, options), source, modules);
}

/** Rule attachment can change when an ordinary comment separates a rule from its declaration. */
export function accessSourceAttachments(source: string) {
  const scanned = scan(source);
  return {
    retiredLines: scanned.retired.map(problem => problem.line),
    targets: scanDirectives(source, scanned, () => {}).map(directive => directive.target),
  };
}

/** A `/// @access(…)` directive as written: what it governs, its parsed rule or its syntax problem. */
export interface SourceDirective extends GraphDirective {
  readonly rule?: Rule;
  /** A syntax problem, with its span in the directive's text. */
  readonly problem?: { readonly code: string; readonly message: string; readonly from: number; readonly to: number };
}

/** Every directive in `source`, parsed for what it governs. For editors: colour, hover, completion. */
export function accessDirectives(source: string): SourceDirective[] {
  return scanDirectives(source, scan(source), () => {}).map((directive) => {
    try {
      return { ...directive, rule: parseRule(directive.args, directive.target.kind) };
    } catch (error) {
      if (!(error instanceof SyntaxProblem)) throw error;
      return { ...directive, problem: { code: error.code, message: error.message, from: error.at.from, to: error.at.to } };
    }
  });
}

// ─── Reasoning about a policy ────────────────────────────────────────────────

/** The membership models that give `model`'s rows their roles: each with its role field and enum. */
export function roleSources(rows: RowAccessSettings, policy: AccessPolicy, model: string, seen = new Set<string>()): { model: string; field: string; enumeration: string }[] {
  if (seen.has(model)) return [];
  seen.add(model);
  const found: { model: string; field: string; enumeration: string }[] = [];
  for (const rule of rows.models[model]?.rules ?? []) {
    if (rule.kind === "owner") continue;
    if (rule.kind === "via") { found.push(...roleSources(rows, policy, rule.model, seen)); continue; }
    const role = Object.entries(policy.models[rule.model]?.fields ?? {}).find(([, field]) => field.role);
    if (role) found.push({ model: rule.model, field: role[0], enumeration: role[1].type });
  }
  return found.filter((source, index) => found.findIndex((other) => other.model === source.model) === index);
}

/** The roles a WHO term stands for; undefined for `owner`, `anyone` and `authenticated`, every role for `member`. */
export function rolesOf(policy: AccessPolicy, enumeration: string, term: string): readonly string[] | undefined {
  const entry = policy.enums[enumeration];
  if (!entry) return undefined;
  if (term === "member") return entry.values;
  if (entry.values.includes(term)) return [term];
  return Object.prototype.hasOwnProperty.call(entry.grants, term) ? entry.grants[term] : undefined;
}

/** The grants that govern a field's reads or writes: its own, or the model's default. */
export function grantsFor(policy: AccessPolicy, model: string, field: string, kind: "read" | "write"): readonly AccessGrant[] | undefined {
  const declared = policy.models[model];
  return declared?.fields[field]?.[kind] ?? (kind === "read" ? declared?.read : assignmentGrants(declared?.update, field));
}

/** Model grants whose column list includes this particular client assignment. */
export function assignmentGrants(grants: readonly AccessGrant[] | undefined, field: string): readonly AccessGrant[] | undefined {
  return grants?.filter((grant) => !grant.columns || grant.columns.includes(field));
}

// ─── Describing ──────────────────────────────────────────────────────────────

export type ProtectionReason = "primary-key" | "clock" | "access-link";

/**
 * Why a field is protected without a comment: a primary key or database clock
 * field is never client-assigned, and an access link (a foreign key behind
 * `owner` or `via`) is set only when a row is created. An access link with any
 * `@access` of its own is described by that instead.
 */
export function fieldProtections(source: string): readonly {
  readonly line: number; readonly model: string; readonly field: string; readonly reason: ProtectionReason;
}[] {
  const scanned = scan(source);
  const { policy } = read(scanned, source);
  return [...scanned.models.values()].flatMap((model) => [...model.fields.values()].flatMap((field) => {
    const reason: ProtectionReason | undefined = isImplied(model, field)
      ? field.id || model.key.includes(field.name) ? "primary-key" : "clock"
      : policy.models[model.name]?.fields[field.name]?.link && !field.access ? "access-link" : undefined;
    return reason ? [{ line: field.line, model: model.name, field: field.name, reason }] : [];
  }));
}

/**
 * What an editor shows beside the source: fields protected without a comment
 * (1-based lines), and each model's line with who may see its rows.
 */
export function accessOutline(source: string): {
  readonly implied: readonly number[];
  readonly models: readonly { readonly line: number; readonly model: string; readonly exposed: boolean; readonly sentence: string }[];
} {
  const scanned = scan(source);
  const { rows, policy } = read(scanned, source);
  const implied: number[] = [];
  const models: { line: number; model: string; exposed: boolean; sentence: string }[] = [];
  for (const model of scanned.models.values()) {
    models.push({ line: model.line, model: model.name, exposed: !!rows.models[model.name], sentence: describeRowAccess(model.name, rows) });
    for (const field of model.fields.values()) {
      if (field.relation || field.access?.rules.some((rule) => isFieldMode(rule.word))) continue;
      if (isImplied(model, field) || (policy.models[model.name]?.fields[field.name]?.link && !field.access)) implied.push(field.line);
    }
  }
  return { implied, models };
}

const valueWords = (raw: RowFilterValue): { readonly negated: boolean; readonly words: string } => {
  if (typeof raw !== "object") return { negated: false, words: String(raw) };
  if ("in" in raw) return { negated: false, words: raw.in.length > 1 ? `${raw.in.slice(0, -1).join(", ")} or ${raw.in[raw.in.length - 1]}` : raw.in.join("") };
  return { negated: true, words: String(raw.not) };
};
const filterWords = (where: RowFilter | undefined) => Object.entries(where ?? {}).map(([key, raw]) => {
  const { negated, words } = valueWords(raw);
  if (words === "true" || words === "false") return (words === "true") !== negated ? key : `not ${key}`;
  return negated ? `not ${words}` : words;
});
/** A condition in words: "status is not DRAFT", "archived", "status is PENDING or INVITED". */
export function describeCondition(field: string, raw: RowFilterValue): string {
  const { negated, words } = valueWords(raw);
  if (words === "true" || words === "false") return (words === "true") !== negated ? field : `not ${field}`;
  return `${field} is ${negated ? "not " : ""}${words}`;
}

/** One clause as written in source: `write(owner, status: PENDING, to: ACCEPTED | DECLINED)`. */
export function writtenGrant(word: string, grant: AccessGrant): string {
  const value = (raw: RowFilterValue) => (typeof raw !== "object" ? String(raw) : "in" in raw ? raw.in.join(" | ") : `!${raw.not}`);
  const parts = [
    ...grant.who,
    ...(grant.except ?? []).map((term) => `!${term}`),
    ...Object.entries(grant.where ?? {}).map(([field, raw]) => `${field}: ${value(raw)}`),
    ...(grant.to !== undefined ? [`to: ${value(grant.to)}`] : []),
  ];
  return `${word}(${parts.join(", ")})`;
}

/** A grant's people in words: "OWNER, ADMIN or the row's owner". */
export function describeWho(who: readonly string[]): string {
  const words = who.map((term) => (term === "owner" ? "its owner" : term === "member" ? "any member" : term === "authenticated" ? "any signed-in user" : term));
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words[0] ?? "nobody";
}

/**
 * Who may see a model's rows, in a sentence: "Visible to users with ACTIVE
 * memberships or PENDING invitations". A filter reads as its values; a Boolean
 * one as its field's name.
 */
export function describeRowAccess(model: string, rows: RowAccessSettings): string {
  const access = rows.models[model];
  if (!access) return "Not in the GraphQL API";
  const qualify = (where: RowFilter | undefined, relation: string) => [...filterWords(where), relation].join(" ");
  const whilst = (own: RowFilter | undefined) => (own ? ` while ${Object.entries(own).map(([field, raw]) => describeCondition(field, raw)).join(" and ")}` : "");
  const parts: string[] = [];
  if (access.authenticated) parts.push("every signed-in user");
  if (access.self) parts.push("the user themself");
  const members: string[] = [];
  const vias: string[] = [];
  const limited: string[] = [];
  for (const rule of access.rules) {
    if (rule.kind === "owner") parts.push("relation" in rule ? `its ${rule.relation}` : `the user with this ${rule.field}`);
    else if (rule.kind === "members") (rule.own ? limited : members).push(rule.own ? `users with ${qualify(rule.where, rule.relation)}${whilst(rule.own)}` : qualify(rule.where, rule.relation));
    else if (rule.who?.length) limited.push(`${describeWho(rule.who)} in its ${qualify(rule.where, rule.relation)}${whilst(rule.own)}`);
    else if (rule.own) limited.push(`anyone who can see its ${qualify(rule.where, rule.relation)}${whilst(rule.own)}`);
    else vias.push(qualify(rule.where, rule.relation));
  }
  if (members.length) parts.push(`users with ${members.join(" or ")}`);
  if (vias.length) parts.push(`anyone who can see its ${vias.join(", ")}`);
  parts.push(...limited);
  return `Visible to ${parts.join(", or ")}`;
}

// ─── Generating ──────────────────────────────────────────────────────────────

/**
 * Scalar fields by who they reach, for projections and inputs that must be
 * literal lists: what everyone who sees a row reads, what its owner reads, and
 * what its owner may assign.
 */
export function fieldAudiences(settings: ClientAccessSettings, rows: RowAccessSettings, policy: AccessPolicy): Record<string, { read: { anyone: string[]; owner: string[] }; write: { owner: string[] } }> {
  const result: Record<string, { read: { anyone: string[]; owner: string[] }; write: { owner: string[] } }> = {};
  for (const name of Object.keys(rows.models)) {
    const columns = Object.entries(policy.models[name]?.fields ?? {}).filter(([field, column]) => !column.relation && settings[name]?.[field] !== "server-only").map(([field]) => field);
    // Literal lists hold only what a grant gives without conditions.
    const reaches = (field: string, kind: "read" | "write", term: string) => grantsFor(policy, name, field, kind)?.some((grant) =>
      !grant.where && grant.to === undefined && !grant.except?.length && (grant.who.includes(term) || grant.who.includes("anyone") || grant.who.includes("authenticated")));
    const canProject = (field: string, owner: boolean) => {
      const cap = policy.models[name]?.fields[field]?.readIdentity;
      if (!cap) return true;
      // The owner's projection can promise an identity match only for self on the principal row.
      const row = rows.models[name]!;
      return owner && row.self && row.key.length === 1 && cap.includes(row.key[0]!)
        && !rows.principals?.[name] && !row.rules.some((rule) => rule.kind === "owner");
    };
    result[name] = {
      read: {
        anyone: columns.filter((field) => canProject(field, false) && (!grantsFor(policy, name, field, "read") || reaches(field, "read", "anyone"))),
        owner: columns.filter((field) => canProject(field, true) && (!grantsFor(policy, name, field, "read") || reaches(field, "read", "owner"))),
      },
      write: { owner: columns.filter((field) => !settings[name]?.[field] && !policy.models[name]?.fields[field]?.link && reaches(field, "write", "owner")) },
    };
  }
  return result;
}

/** The generated module behind `@repo/database`'s ClientRow, ClientInput, row access and write rules. */
export function renderClientAccess(settings: ClientAccessSettings, rows: RowAccessSettings, policy?: AccessPolicy): string {
  const models = Object.entries(settings).map(([model, fields]) =>
    `  ${JSON.stringify(model)}: {\n${Object.entries(fields).map(([field, mode]) => `    ${JSON.stringify(field)}: ${JSON.stringify(mode)},`).join("\n")}\n  },\n`).join("");
  return [
    "// Generated from prisma/contract.prisma by aws-studio db:generate. Do not edit.",
    "// Change a `/// @access(…)` directive (Studio: Ctrl+. inspects the line), then run",
    "// npm --workspace @repo/database run generate.",
    "",
    "/** Fields the GraphQL API never returns (server-only) or never accepts (read-only). */",
    `export const clientAccess = {\n${models}} as const;`,
    "",
    "export type ClientAccess = typeof clientAccess;",
    "",
    "/** Whose rows the GraphQL API may return, per model. Models absent here are not in the API. */",
    `export const rowAccess = ${JSON.stringify(rows, null, 2)} as const;`,
    "",
    "export type RowAccess = typeof rowAccess;",
    ...(policy ? [
      "",
      "/** Who may read and assign fields and create, update and delete rows; roles and named permissions. */",
      `export const accessPolicy = ${JSON.stringify(policy, null, 2)} as const;`,
      "",
      "/** Scalar fields by who they reach: everyone who sees the row, its owner, and what its owner may assign. */",
      `export const fieldAudiences = ${JSON.stringify(fieldAudiences(settings, rows, policy), null, 2)} as const;`,
    ] : []),
    "",
  ].join("\n");
}

/** Roles and named permissions for workloads that must not import a database client. */
export function renderRolePolicies(policy: AccessPolicy): string {
  return `// Generated from contract.prisma by @repo/database. Do not edit.\nexport const rolePolicies = ${JSON.stringify(policy.enums, null, 2)} as const;\n`;
}

/**
 * Prisma Access: the syntax of `/// @access(…)` directives.
 *
 * Reads stacked and trailing directives, including continuations over following
 * `///` lines while parentheses are open, tokenizes them with exact source
 * offsets and parses them into a small AST. It knows nothing about the schema:
 * scripts/access-graph.ts resolves names and lowers rules into the enforced
 * policy, and Studio colours tokens by the category each one belongs to.
 *
 * Dependency-free, so the editor and the generator read directives through the
 * same code.
 *
 *     /// @access(read, update(name): ownerId == auth.id)        a rule: actions, then who may
 *     /// @access(roles: memberships[status=ACTIVE].role)          a role scope
 *     /// @access(from: workspace, only: [read])                   inherit one parent's scope
 *     /// @access(deny read: status == DRAFT && !createCase)       deny always wins
 *     /// @access(fields(a, b), serverOnly)                       one rule for several fields
 *     /// @access(PENDING -> ACCEPTED | DECLINED: email == auth.email)   a field's transition
 *     /// @access(...REVIEWER, uploadDocuments)                    a role: a lower role, plus more
 *     /// @access(uploadDocuments: [OWNER, EDITOR])                above a role enum: exact holders
 *     /// @access(read: [OWNER, EDITOR, VIEWER])                   …of an ability or a CRUD action
 *     /// @access(command rename, update(name): edit && draft == true)  a named write on this model
 */

// ─── Directives in a schema ──────────────────────────────────────────────────

export interface DirectiveText {
  /** 1-based line and column of `@access`. */
  readonly line: number;
  readonly column: number;
  /** The last line the directive spans. */
  readonly endLine: number;
  /** The declaration precedes the comment on its opening line. */
  readonly inline?: true;
  /** Offset of the first slash. */
  readonly commentFrom: number;
  /** The text between the outer parentheses; continuation lines are joined with a newline. */
  readonly text: string;
  /** For each character of `text` (and one past its end), its offset in the source. */
  readonly offsets: readonly number[];
  /** Offsets of `@access` and of the closing parenthesis (exclusive) in the source. */
  readonly from: number;
  readonly to: number;
  /** A problem reading the directive itself, before parsing its rule. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** Where a line's `//` comment starts, ignoring `//` inside string literals; -1 without one. */
export function commentStart(text: string): number {
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

/** `@access` inside backticks is prose about the syntax, not a directive. */
export const quotedAccess = (comment: string) => /`[^`]*@access[^`]*`/.test(comment) && !/(^|[^`\w])@access\(/.test(comment.replace(/`[^`]*`/g, ""));

/**
 * Every `/// @access(…)` in `source`. A directive continues onto following
 * `///` lines until its parentheses close. `//` comments naming `@access(` are
 * returned with an error: they look like policy, and policy is never ignored.
 */
export function readDirectives(source: string): DirectiveText[] {
  const lines = source.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const found: DirectiveText[] = [];
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!.replace(/\r$/, "");
    const at = commentStart(raw);
    if (at < 0) continue;
    const comment = raw.slice(at);
    const marker = comment.search(/@access\b/);
    if (marker < 0 || quotedAccess(comment)) continue;
    const line = index + 1;
    const column = at + marker + 1;
    const from = starts[index]! + at + marker;
    const location = { line, column, from, commentFrom: starts[index]! + at, ...(raw.slice(0, at).trim() ? { inline: true as const } : {}) };
    const fail = (code: string, message: string, endLine = line) => found.push({ ...location, endLine, text: "", offsets: [], to: from + "@access".length, error: { code, message } });
    if (!comment.startsWith("///")) {
      if (/@access\s*\(/.test(comment)) fail("AG-SLASHES", "Write /// @access(…) above the declaration or after a field or enum value.");
      continue;
    }
    const call = /@access\s*\(/.test(comment);
    if (comment.slice(3, marker).trim()) {
      // Prose that mentions @access is documentation; prose before a directive hides it.
      if (call) fail("AG-SYNTAX", "Start the /// line with the directive: /// @access(…). Put any description on a /// line of its own.");
      continue;
    }
    const open = raw.indexOf("(", at + marker);
    if (open < 0 || raw.slice(at + marker + "@access".length, open).trim()) { fail("AG-SYNTAX", "Write the rule inside parentheses: /// @access(read: userId == auth.id)."); continue; }
    // Collect characters up to the matching close, across `///` continuation lines.
    let text = "";
    const offsets: number[] = [];
    let depth = 1;
    let row = index;
    let position = open + 1;
    let closed = -1;
    for (;;) {
      const current = lines[row]!.replace(/\r$/, "");
      for (; position < current.length; position++) {
        const character = current[position]!;
        if (character === "(") depth++;
        else if (character === ")" && --depth === 0) { closed = position; break; }
        text += character;
        offsets.push(starts[row]! + position);
      }
      if (closed >= 0) break;
      const next = lines[row + 1]?.replace(/\r$/, "");
      const continued = next !== undefined ? /^(\s*)\/\/\/(?!\/)/.exec(next) : null;
      if (!continued || /@access\b/.test(next!)) break;
      text += "\n";
      offsets.push(starts[row]! + current.length);
      row++;
      position = continued[0].length;
    }
    const endLine = row + 1;
    if (closed < 0) { fail("AG-SYNTAX", "Close the directive's parentheses. A directive may continue on the next /// lines while they are open.", endLine); index = row; continue; }
    const after = lines[row]!.replace(/\r$/, "").slice(closed + 1);
    offsets.push(starts[row]! + closed);
    index = row;
    if (after.trim()) {
      found.push({ ...location, endLine, text, offsets, to: starts[row]! + closed + 1, error: { code: "AG-SYNTAX", message: "Nothing may follow a directive on its line. Put a description on a /// line of its own." } });
      continue;
    }
    found.push({ ...location, endLine, text, offsets, to: starts[row]! + closed + 1 });
  }
  return found;
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export type TokenKind = "name" | "symbol";
export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Offsets in the directive's text. */
  readonly from: number;
  readonly to: number;
}

const SYMBOLS = ["...", "->", "==", "!=", "&&", "||", "!", "|", "(", ")", "[", "]", ",", ":", ".", "=", "*"];

export function tokenize(text: string): { tokens: Token[]; error?: { at: number; message: string } } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (/\s/.test(character)) { index++; continue; }
    const name = /^[A-Za-z_]\w*/.exec(text.slice(index));
    if (name) { tokens.push({ kind: "name", text: name[0], from: index, to: index + name[0].length }); index += name[0].length; continue; }
    const symbol = SYMBOLS.find((item) => text.startsWith(item, index));
    if (symbol) { tokens.push({ kind: "symbol", text: symbol, from: index, to: index + symbol.length }); index += symbol.length; continue; }
    return { tokens, error: { at: index, message: `"${character}" has no meaning in a directive.` } };
  }
  return { tokens };
}

// ─── The AST ─────────────────────────────────────────────────────────────────

export interface Span { readonly from: number; readonly to: number }
export interface Name extends Span { readonly text: string }

/** Matches one local scalar against the configured principal's key. */
type IsMe = { readonly kind: "isMe"; readonly keyword: Name; readonly field: Name } & Span;

/** A condition. Every node keeps its span in the directive's text. */
export type Expression =
  | IsMe
  | ({ readonly kind: "or" | "and"; readonly of: readonly Expression[] } & Span)
  | ({ readonly kind: "not"; readonly of: Expression } & Span)
  /** `member`, `authenticated`, `ROLE`, `ability`, `rel.read`, `rel.member`, `rel.ROLE`, `rel.ability`. */
  | ({ readonly kind: "name"; readonly path: readonly Name[] } & Span)
  /** `field == auth.id`, `field != auth.email`. */
  | ({ readonly kind: "identity"; readonly field: readonly Name[]; readonly negated: boolean; readonly auth: Name; readonly operator: Span } & Span)
  /** `field == VALUE`, `rel.field != A | B`, `flag == true`. */
  | ({ readonly kind: "state"; readonly field: readonly Name[]; readonly negated: boolean; readonly values: readonly Name[]; readonly operator: Span } & Span);

export interface Grant { readonly action: Name; readonly columns?: readonly Name[] }

export type FieldRule =
  /** `read, update(a, b): condition`; on a field, `read: …` or `write: …`, optionally then `, readonly`. */
  | { readonly kind: "allow"; readonly grants: readonly Grant[]; readonly when: Expression; readonly colon: Span; readonly flags?: readonly Name[] }
  /** `PENDING | INVITED -> ACCEPTED: condition`; `*` for any stored value. */
  | { readonly kind: "transition"; readonly from: readonly Name[] | "any"; readonly to: readonly Name[]; readonly arrow: Span; readonly when: Expression; readonly colon: Span }
  /** `readonly` and `serverOnly`. */
  | { readonly kind: "flags"; readonly flags: readonly Name[] };

export type Rule =
  | FieldRule
  /** `deny read: condition`. */
  | { readonly kind: "deny"; readonly keyword: Name; readonly grants: readonly Grant[]; readonly when: Expression; readonly colon: Span }
  /** `roles: …`, `from: …`, `only: […]`, together in one directive. */
  | {
      readonly kind: "scope";
      readonly roles?: { readonly key: Name; readonly relation: Name; readonly actor?: IsMe; readonly filter?: { readonly field: Name; readonly value: Name }; readonly field: Name };
      readonly from?: { readonly key: Name; readonly relation: Name };
      readonly only?: { readonly key: Name; readonly actions: readonly Name[] };
    }
  /** Above a model, `fields(a, b), readonly` applies the same field rule to each listed field. */
  | { readonly kind: "fieldGroup"; readonly key: Name; readonly columns: readonly Name[]; readonly rule: FieldRule; readonly bodyFrom: number }
  /** Above a role enum, `inviteMembers: [OWNER, ADMIN]` or an action, `read: [OWNER, ADMIN]`. An empty list declares an ungranted permission. */
  | { readonly kind: "permission"; readonly name: Name; readonly roles: readonly Name[]; readonly listSpan: Span }
  /** On a model, a named write: one verb and audience, with optional local row conditions. */
  | { readonly kind: "command"; readonly keyword: Name; readonly name: Name; readonly grant: Grant; readonly who: Name;
      readonly states: readonly { readonly field: Name; readonly operator: Span; readonly value: Name }[] }
  /** On an enum value: `...LOWER`, actions and abilities, and `protected`. */
  | { readonly kind: "role"; readonly includes: readonly Name[]; readonly holds: readonly Name[]; readonly flags: readonly Name[] };

export type Placement = "model" | "field" | "enum" | "value";

export class SyntaxProblem extends Error {
  constructor(readonly at: Span, message: string, readonly code = "AG-SYNTAX") { super(message); }
}

export const ACTIONS = ["read", "create", "update", "delete"] as const;
export const FIELD_ACTIONS = ["read", "write"] as const;
export const FIELD_FLAGS = ["readonly", "serverOnly"] as const;
export const SCOPE_KEYS = ["role", "roles", "from", "only"] as const;

class Reader {
  private index = 0;
  constructor(private readonly tokens: readonly Token[], private readonly end: number) {}
  peek(offset = 0): Token | undefined { return this.tokens[this.index + offset]; }
  done(): boolean { return this.index >= this.tokens.length; }
  next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new SyntaxProblem({ from: this.end, to: this.end }, "The directive ends too early.");
    this.index++;
    return token;
  }
  is(text: string, offset = 0): boolean { return this.peek(offset)?.text === text; }
  eat(text: string): Token | undefined { return this.is(text) ? this.next() : undefined; }
  expect(text: string, message: string): Token {
    const token = this.peek();
    if (token?.text !== text) throw new SyntaxProblem(token ?? { from: this.end, to: this.end }, message);
    return this.next();
  }
  name(message: string): Name {
    const token = this.peek();
    if (token?.kind !== "name") throw new SyntaxProblem(token ?? { from: this.end, to: this.end }, message);
    this.next();
    return { text: token.text, from: token.from, to: token.to };
  }
  /** Is there a top-level `text` before the end, outside brackets? */
  hasTop(text: string): boolean {
    let depth = 0;
    for (let index = this.index; index < this.tokens.length; index++) {
      const token = this.tokens[index]!.text;
      if (token === "(" || token === "[") depth++;
      else if (token === ")" || token === "]") depth--;
      else if (depth === 0 && token === text) return true;
    }
    return false;
  }
}

const span = (from: Span, to: Span): Span => ({ from: from.from, to: to.to });
/** The last item of a non-empty list. */
export const last = <T,>(list: readonly T[]): T => list[list.length - 1]!;

function expression(reader: Reader): Expression {
  const parts = [conjunction(reader)];
  while (reader.eat("||")) parts.push(conjunction(reader));
  return parts.length === 1 ? parts[0]! : { kind: "or", of: parts, ...span(parts[0]!, last(parts)!) };
}

function conjunction(reader: Reader): Expression {
  const parts = [unary(reader)];
  while (reader.eat("&&")) parts.push(unary(reader));
  return parts.length === 1 ? parts[0]! : { kind: "and", of: parts, ...span(parts[0]!, last(parts)!) };
}

function unary(reader: Reader): Expression {
  const bang = reader.eat("!");
  if (bang) {
    const inner = unary(reader);
    return { kind: "not", of: inner, from: bang.from, to: inner.to };
  }
  const open = reader.eat("(");
  if (open) {
    const inner = expression(reader);
    const close = reader.expect(")", "Close the parenthesis.");
    return { ...inner, from: open.from, to: close.to };
  }
  return atom(reader);
}

function path(reader: Reader, message: string): Name[] {
  const names = [reader.name(message)];
  while (reader.is(".") && reader.peek(1)?.kind === "name") { reader.next(); names.push(reader.name(message)); }
  return names;
}

function isMe(reader: Reader): IsMe {
  const keyword = reader.name("Expected isMe.");
  reader.expect("(", "Write isMe(field).");
  const field = reader.name("Name the key that identifies the signed-in person, such as isMe(personId).");
  const close = reader.expect(")", "isMe takes one local scalar field, such as isMe(personId).");
  return { kind: "isMe", keyword, field, ...span(keyword, close) };
}

function atom(reader: Reader): Expression {
  if (reader.is("isMe") && reader.is("(", 1)) return isMe(reader);
  const names = path(reader, "Expected a condition: field == auth.id, a role, an ability, relation.read or field == VALUE.");
  const operator = reader.peek();
  if (operator?.text !== "==" && operator?.text !== "!=") {
    return { kind: "name", path: names, from: names[0]!.from, to: last(names)!.to };
  }
  reader.next();
  const negated = operator.text === "!=";
  if (reader.is("auth") && reader.is(".", 1)) {
    const auth = reader.next();
    reader.next();
    const field = reader.name("Write auth.id, or auth.FIELD for another unique field of the signed-in user.");
    return { kind: "identity", field: names, negated, auth: { text: field.text, from: auth.from, to: field.to }, operator, from: names[0]!.from, to: field.to };
  }
  const values = [reader.name("Compare with a value, such as status == ACTIVE, or with auth.id.")];
  if (reader.is(".")) throw new SyntaxProblem({ from: values[0]!.from, to: reader.peek()!.to }, `${values[0]!.text} is not auth. Compare with the signed-in user: field == auth.id, or auth.FIELD for another unique field.`, "AG-READ-EXPRESSION");
  while (reader.eat("|")) values.push(reader.name("Write another value after |."));
  return { kind: "state", field: names, negated, values, operator, from: names[0]!.from, to: last(values)!.to };
}

function grant(reader: Reader, allowed: readonly string[], code: string): Grant {
  const action = reader.name(`Expected an action: ${allowed.join(", ")}.`);
  if (!allowed.includes(action.text)) throw new SyntaxProblem(action, `"${action.text}" is not an action here. Use ${allowed.join(", ")}.`, code);
  let columns: Name[] | undefined;
  if (reader.eat("(")) {
    columns = [];
    if (!reader.is(")")) do {
      const column = reader.name("List the columns, such as update(name, description).");
      if (columns.some((entry) => entry.text === column.text)) throw new SyntaxProblem(column, `${column.text} is listed twice in ${action.text}.`, "AG-DUPLICATE");
      columns.push(column);
    } while (reader.eat(","));
    reader.expect(")", "Close the column list.");
  }
  return { action, ...(columns ? { columns } : {}) };
}

function grants(reader: Reader, allowed: readonly string[], code = "AG-ACTION"): Grant[] {
  const list = [grant(reader, allowed, code)];
  while (reader.eat(",")) {
    const next = grant(reader, allowed, code);
    if (list.some(({ action }) => action.text === next.action.text)) {
      throw new SyntaxProblem(next.action, `${next.action.text} is listed twice. Combine its columns in one action.`, "AG-DUPLICATE");
    }
    list.push(next);
  }
  return list;
}

function values(reader: Reader): Name[] {
  const list = [reader.name("Expected a value.")];
  while (reader.eat("|")) list.push(reader.name("Write another value after |."));
  return list;
}

function scope(reader: Reader): Rule {
  const result: { roles?: Extract<Rule, { kind: "scope" }>["roles"]; from?: Extract<Rule, { kind: "scope" }>["from"]; only?: Extract<Rule, { kind: "scope" }>["only"] } = {};
  do {
    const key = reader.name("Expected roles:, from: or only:.");
    if ((ACTIONS as readonly string[]).includes(key.text)) throw new SyntaxProblem(key, `A model takes its access from a scope (roles:, from:) or from rules (${key.text}: …), not both. Write rules on a model without a scope.`, "AG-BASE");
    if (!(SCOPE_KEYS as readonly string[]).includes(key.text)) throw new SyntaxProblem(key, `"${key.text}" is not a scope key. A scope takes roles:, from: and only:; a rule starts with an action.`, "AG-KEY");
    const scopeKey = key.text === "role" ? "roles" : key.text as keyof typeof result;
    if (result[scopeKey]) throw new SyntaxProblem(key, `${key.text} is written twice.`, "AG-DUPLICATE");
    reader.expect(":", `Write ${key.text}: after the key.`);
    if (scopeKey === "roles") {
      const relation = reader.name("Name the membership relation, such as seats[isMe(personId)].role.");
      let actor: IsMe | undefined;
      let filter: { field: Name; value: Name } | undefined;
      if (reader.eat("[")) {
        do {
          if (reader.is("isMe") && reader.is("(", 1)) {
            if (actor) throw new SyntaxProblem(reader.peek()!, "Name the membership's principal once.", "AG-ROLES-SYNTAX");
            actor = isMe(reader);
          } else {
            const field = reader.name("Write isMe(personId) or an enum filter such as status == ACTIVE.");
            if (filter) throw new SyntaxProblem(field, "A membership selector takes one enum filter.", "AG-ROLES-SYNTAX");
            if (!reader.eat("=") && !reader.eat("==")) throw new SyntaxProblem(field, "Write the filter as field == VALUE.", "AG-ROLES-SYNTAX");
            filter = { field, value: reader.name("Name the value the membership must hold.") };
          }
        } while (reader.eat("&&"));
        reader.expect("]", "Close the selector with ] or join isMe(personId) and an enum filter with &&.");
      }
      reader.expect(".", "Name the role field, such as seats[isMe(personId)].role.");
      result.roles = { key, relation, ...(actor ? { actor } : {}), ...(filter ? { filter } : {}), field: reader.name("Name the role field.") };
    } else if (key.text === "from") {
      result.from = { key, relation: reader.name("Name the parent relation: from: workspace.") };
    } else {
      reader.expect("[", "only takes a list of actions, such as only: [read, update].");
      const actions: Name[] = [];
      if (!reader.is("]")) do {
        const action = reader.name("List actions: read, create, update, delete.");
        if (!(ACTIONS as readonly string[]).includes(action.text)) throw new SyntaxProblem(action, `"${action.text}" is not an action. Use read, create, update and delete.`, "AG-ACTION");
        actions.push(action);
      } while (reader.eat(","));
      reader.expect("]", "Close the list with ].");
      result.only = { key, actions };
    }
  } while (reader.eat(","));
  return { kind: "scope", ...result };
}

function fieldRule(reader: Reader): FieldRule {
  if (reader.hasTop("->")) {
    let from: Name[] | "any";
    if (reader.eat("*")) from = "any";
    else from = values(reader);
    const arrow = reader.expect("->", "Write the transition as FROM -> TO: condition.");
    const to = values(reader);
    const colon = reader.expect(":", "Say who may make this change after a colon: PENDING -> REVOKED: inviteMembers.");
    return { kind: "transition", from, to, arrow, when: expression(reader), colon };
  }
  const flags: Name[] = [];
  if (!reader.hasTop(":")) {
    do {
      const flag = reader.name("Write readonly or serverOnly.");
      if (!(FIELD_FLAGS as readonly string[]).includes(flag.text)) throw new SyntaxProblem(flag, `"${flag.text}" is not a field setting. Use readonly, serverOnly, or a rule such as write: ownerId == auth.id.`, "AG-FIELD-RULE");
      flags.push(flag);
    } while (reader.eat(","));
    return { kind: "flags", flags };
  }
  const list = grants(reader, FIELD_ACTIONS, "AG-FIELD-RULE");
  const withColumns = list.find((grant) => grant.columns);
  if (withColumns) throw new SyntaxProblem(withColumns.action, "A field rule governs this field: leave out the column list.");
  const colon = reader.expect(":", "Say who after a colon: write: ownerId == auth.id.");
  const when = expression(reader);
  while (reader.eat(",")) {
    const flag = reader.name("Write readonly or serverOnly after the rule.");
    if (!(FIELD_FLAGS as readonly string[]).includes(flag.text)) throw new SyntaxProblem(flag, `"${flag.text}" is not a field setting. Write another rule on a /// @access line of its own.`, "AG-FIELD-RULE");
    flags.push(flag);
  }
  return { kind: "allow", grants: list, when, colon, ...(flags.length ? { flags } : {}) };
}

/** Parse one directive's text for what it is written above. */
export function parseRule(text: string, placement: Placement): Rule {
  const { tokens, error } = tokenize(text);
  if (error) throw new SyntaxProblem({ from: error.at, to: error.at + 1 }, error.message);
  const reader = new Reader(tokens, text.length);
  const finish = (rule: Rule): Rule => {
    const extra = reader.peek();
    if (extra) throw new SyntaxProblem(extra, `Unexpected "${extra.text}". ${extra.text === "," ? "Write another rule on a /// @access line of its own." : "The rule already ended."}`);
    return rule;
  };

  if (reader.is("fields") && reader.is("(", 1)) {
    const key = reader.name("Expected fields.");
    if (placement !== "model") throw new SyntaxProblem(key, "Put a fields(…) directive above the model whose fields it governs.", "AG-FIELD-GROUP");
    reader.expect("(", "Write the field list inside parentheses.");
    const columns: Name[] = [];
    const seen = new Set<string>();
    do {
      const name = reader.name("List at least one scalar field in fields(…).");
      if (seen.has(name.text)) throw new SyntaxProblem(name, `${name.text} is listed twice in fields(…).`, "AG-DUPLICATE");
      seen.add(name.text);
      columns.push(name);
    } while (reader.eat(",") && !reader.is(")"));
    reader.expect(")", "Close the field list with ).");
    const comma = reader.expect(",", "Follow the field list with a comma and a field rule, such as fields(a, b), serverOnly.");
    const bodyFrom = reader.peek()?.from ?? comma.to;
    return finish({ kind: "fieldGroup", key, columns, rule: fieldRule(reader), bodyFrom });
  }

  if (placement === "enum") {
    const name = reader.name("Name a permission and list its roles, such as inviteMembers: [OWNER, ADMIN].");
    reader.expect(":", "Follow the permission name with a colon and a list of roles.");
    const open = reader.expect("[", "Put the roles inside brackets. Use [] to grant this permission to nobody.");
    const roles: Name[] = [];
    if (!reader.is("]")) do {
      roles.push(reader.name("List a value of this role enum."));
    } while (reader.eat(",") && !reader.is("]"));
    const close = reader.expect("]", "Close the role list with ].");
    return finish({ kind: "permission", name, roles, listSpan: span(open, close) });
  }

  if (placement === "value") {
    const includes: Name[] = [];
    const holds: Name[] = [];
    const flags: Name[] = [];
    if (reader.done()) return { kind: "role", includes, holds, flags };
    do {
      const spread = reader.eat("...");
      const name = reader.name(spread ? "Name the role this one includes: ...EDITOR." : "List actions, abilities, ...ROLE or protected.");
      if (spread) includes.push({ ...name, from: spread.from });
      else if (name.text === "protected") flags.push(name);
      else holds.push(name);
    } while (reader.eat(","));
    return finish({ kind: "role", includes, holds, flags });
  }

  const first = reader.peek();
  if (!first) throw new SyntaxProblem({ from: 0, to: 0 }, placement === "model" ? "Write a rule, such as /// @access(read: userId == auth.id)." : "Write readonly, serverOnly, or a rule such as write: ownerId == auth.id.");

  if (placement === "field") return finish(fieldRule(reader));

  // A model: scope keys, deny, or a rule.
  if (first.text === "command") {
    const keyword = reader.name("Expected command.");
    const name = reader.name("Name the command, such as command archiveNote, update(status): editNotes.");
    reader.expect(",", "Write a comma between the command name and its write.");
    const write = grant(reader, ["create", "update", "delete"], "AG-COMMAND-DIRECTIVE");
    reader.expect(":", "Name the audience after a colon, such as update(title): editNotes.");
    const who = reader.name("Name the permission, role or audience that may run this command.");
    const states: { field: Name; operator: Span; value: Name }[] = [];
    while (reader.eat("&&")) {
      const field = reader.name("Name a local enum or Boolean field for this write's condition.");
      const operator = reader.expect("==", "Compare a local enum or Boolean field to one value, such as status == DRAFT.");
      const value = reader.name("Name the allowed enum or Boolean value.");
      states.push({ field, operator, value });
    }
    return finish({ kind: "command", keyword, name, grant: write, who, states });
  }
  if (first.kind === "name" && (SCOPE_KEYS as readonly string[]).includes(first.text) && reader.is(":", 1)) return finish(scope(reader));
  if (first.text === "deny" && reader.peek(1)?.kind === "name") {
    const keyword = reader.name("deny");
    const list = grants(reader, ACTIONS);
    const colon = reader.expect(":", "Say when the rows are denied after a colon: deny read: status == DRAFT.");
    return finish({ kind: "deny", keyword, grants: list, when: expression(reader), colon });
  }
  if (first.kind === "name" && !(ACTIONS as readonly string[]).includes(first.text) && reader.is(":", 1)) {
    throw new SyntaxProblem(first, `"${first.text}" is not a rule. Start with an action (read, create, update, delete), deny, or a scope key (roles, from, only).`, "AG-KEY");
  }
  const list = grants(reader, ACTIONS);
  const colon = reader.expect(":", "Say who after a colon: read: userId == auth.id.");
  return finish({ kind: "allow", grants: list, when: expression(reader), colon });
}

// ─── Categories, for colour and explanation ──────────────────────────────────

/**
 * What a token is about. Studio colours each category its own way:
 * identity (who you are), role (your role in a scope), path (follows another
 * row), state (the row's values), limit (takes access away), action, column.
 */
export type AccessCategory = "identity" | "role" | "path" | "state" | "limit" | "action" | "column" | "punctuation";

export interface CategorizedSpan extends Span { readonly category: AccessCategory }

const IDENTITY_WORDS = new Set(["authenticated"]);

/** The categories of a parsed rule's tokens, in directive-text offsets, in order. */
export function categorize(rule: Rule): CategorizedSpan[] {
  const out: CategorizedSpan[] = [];
  const push = (at: Span, category: AccessCategory) => out.push({ from: at.from, to: at.to, category });
  const grant = (list: readonly Grant[]) => {
    for (const item of list) {
      push(item.action, "action");
      for (const column of item.columns ?? []) push(column, "column");
    }
  };
  const walk = (node: Expression): void => {
    switch (node.kind) {
      case "or": case "and": node.of.forEach(walk); return;
      case "not": push({ from: node.from, to: node.from + 1 }, "limit"); walk(node.of); return;
      case "isMe": push(node.keyword, "identity"); push(node.field, "identity"); return;
      case "identity":
        for (const name of node.field.slice(0, -1)) push(name, "path");
        push(last(node.field), "identity");
        push(node.operator, node.negated ? "limit" : "identity");
        push(node.auth, "identity");
        return;
      case "state":
        for (const name of node.field.slice(0, -1)) push(name, "path");
        push(last(node.field), "state");
        push(node.operator, "state");
        for (const value of node.values) push(value, "state");
        return;
      case "name": {
        const [head, ...rest] = node.path;
        if (!rest.length) { push(head!, IDENTITY_WORDS.has(head!.text) ? "identity" : "role"); return; }
        for (const name of node.path.slice(0, -1)) push(name, "path");
        const final = last(node.path);
        push(final, final.text === "read" ? "path" : "role");
        return;
      }
    }
  };
  switch (rule.kind) {
    case "fieldGroup":
      push(rule.key, "action");
      for (const column of rule.columns) push(column, "column");
      out.push(...categorize(rule.rule));
      break;
    case "allow": grant(rule.grants); walk(rule.when); for (const flag of rule.flags ?? []) push(flag, "limit"); break;
    case "deny": push(rule.keyword, "limit"); grant(rule.grants); walk(rule.when); break;
    case "transition":
      if (rule.from !== "any") for (const value of rule.from) push(value, "state");
      push(rule.arrow, "state");
      for (const value of rule.to) push(value, "state");
      walk(rule.when);
      break;
    case "flags": for (const flag of rule.flags) push(flag, "limit"); break;
    case "permission":
      push(rule.name, (ACTIONS as readonly string[]).includes(rule.name.text) ? "action" : "role");
      for (const role of rule.roles) push(role, "role");
      break;
    case "command":
      push(rule.keyword, "action");
      push(rule.name, "action");
      grant([rule.grant]);
      push(rule.who, rule.who.text === "authenticated" || rule.who.text === "owner" ? "identity" : "role");
      for (const state of rule.states) {
        push(state.field, "state");
        push(state.operator, "state");
        push(state.value, "state");
      }
      break;
    case "role":
      for (const role of rule.includes) push(role, "role");
      for (const item of rule.holds) push(item, (ACTIONS as readonly string[]).includes(item.text) ? "action" : "role");
      for (const flag of rule.flags) push(flag, "limit");
      break;
    case "scope":
      if (rule.roles) {
        push(rule.roles.key, "role");
        push(rule.roles.relation, "role");
        if (rule.roles.actor) walk(rule.roles.actor);
        if (rule.roles.filter) { push(rule.roles.filter.field, "state"); push(rule.roles.filter.value, "state"); }
        push(rule.roles.field, "role");
      }
      if (rule.from) { push(rule.from.key, "path"); push(rule.from.relation, "path"); }
      if (rule.only) { push(rule.only.key, "limit"); for (const action of rule.only.actions) push(action, "action"); }
      break;
  }
  return out.sort((a, b) => a.from - b.from);
}

const TIGHT_BEFORE = new Set([",", ")", "]", ".", ":"]);
const TIGHT_AFTER = new Set(["(", "[", ".", "...", "!"]);

/** A rule's canonical text: whitespace normalized, so reflowing a directive never changes it. */
export function normalizedRule(text: string): string {
  let out = "";
  let previous: Token | undefined;
  for (const token of tokenize(text).tokens) {
    const tight = !previous || TIGHT_BEFORE.has(token.text) || TIGHT_AFTER.has(previous.text)
      || (token.text === "(" && previous.kind === "name") || (token.text === "[" && previous.kind === "name") || (token.text === "=" || previous.text === "=");
    out += (tight ? "" : " ") + token.text;
    previous = token;
  }
  return out;
}

/**
 * How `/// @access(…)` directives look in the schema editor. Every token takes
 * the colour of what it is about, and models in policy-bearing schemas show
 * where access to their rows comes from:
 *
 * - amber, identity: the signed-in user (`ownerId == auth.id`, `authenticated`);
 * - violet, role: a role in a scope (`roles:`, `workspace.member`, abilities);
 * - teal, path: another row's access (`from:`, `conversation.read`);
 * - blue, state: the row's values and transitions (`status == DRAFT`);
 * - red, limit: what takes access away (`deny`, `only`, `readonly`, `serverOnly`, `protected`).
 *
 * Valid declarations render as source-linked buttons. The generator's parse
 * supplies their targets, validation, colours and the rail beside each model.
 */
import { EditorSelection, StateEffect, StateField, type EditorState, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { categorize, commentStart } from "aws-studio/database/access-syntax";
import { accessDirectives, readClientAccess, type AccessModules, type SourceDirective } from "aws-studio/database/client-access";
import { InlineRoleMatrix } from "./inline-role-matrix";
import { accessTokens, directiveKind, explainAccessAt, modelScopes, type ModelScope, type ScopeKind } from "./prisma-access-language";

export const ACCESS_CATEGORY_LABELS = {
  identity: "Identity", role: "Role", path: "Path", state: "State", limit: "Limit", action: "Action", column: "Column", punctuation: "Rule", keyword: "Directive",
} as const;

const SCOPE_WORDS: Readonly<Record<ScopeKind, string>> = {
  identity: "the signed-in user",
  role: "a role in a scope",
  path: "another row’s readers",
};

/**
 * A pill stands for a rule; an annotation is a role value's own settings
 * (`protected`, `...LOWER`), written quietly after the value like an inlay.
 */
type ButtonKind = "pill" | "annotation" | "hint" | "matrix-open";

/** A run of an annotation's text, coloured by what it is about. */
interface AnnotationPart { readonly text: string; readonly category?: string }

/** The line number always identifies the authored rule, even for a pill drawn beside its field. */
class AccessButton extends WidgetType {
  constructor(readonly kind: ButtonKind, readonly line: number, readonly target: string,
    readonly label: string, readonly tone = "mixed",
    /** Annotation only: its coloured runs, and the columns that align it with its siblings. */
    readonly parts: readonly AnnotationPart[] = [], readonly indent = 0) { super(); }
  override eq(other: AccessButton) {
    return this.kind === other.kind && this.line === other.line && this.target === other.target &&
      this.label === other.label && this.tone === other.tone && this.indent === other.indent &&
      this.parts.length === other.parts.length && this.parts.every((part, index) => part.text === other.parts[index]!.text && part.category === other.parts[index]!.category);
  }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = this.kind === "matrix-open" ? 0 : -1;
    button.className = `cm-access-${this.kind}`;
    button.dataset.accessLine = String(this.line);
    button.dataset.accessTarget = this.target;
    button.dataset.accessKind = this.tone;
    button.setAttribute("aria-haspopup", "dialog");
    const name = this.kind === "matrix-open" ? `Role permissions for ${this.target}`
      : this.kind === "hint" ? `Configure access for ${this.target}` : `Access for ${this.target}: ${this.label}`;
    button.setAttribute("aria-label", name);
    button.title = name;
    const text = document.createElement("span");
    if (this.kind === "annotation") {
      // The editor's own ch, so annotations in one enum start in one column.
      // Less the hover padding, so the text itself starts on the column.
      if (this.indent) button.style.marginInlineStart = `calc(${this.indent}ch - 4px)`;
      for (const part of this.parts) {
        // Not .cm-access-<category>: those classes mark the document's own tokens.
        const run = document.createElement("span");
        if (part.category) run.dataset.category = part.category;
        run.textContent = part.text;
        text.append(run);
      }
    } else text.textContent = this.label;
    button.append(text);
    return button;
  }
  override ignoreEvent(event: Event) { return event.type.startsWith("key"); }
}

/** A directive's text in coloured runs, whitespace collapsed as in its pill label. */
function annotationParts(directive: SourceDirective): AnnotationPart[] {
  const text = directive.args;
  const parts: AnnotationPart[] = [];
  const plain = (slice: string) => { const collapsed = slice.replace(/\s+/g, " "); if (collapsed) parts.push({ text: collapsed }); };
  let at = 0;
  for (const span of directive.rule ? [...categorize(directive.rule)].sort((a, b) => a.from - b.from) : []) {
    if (span.from < at) continue;
    plain(text.slice(at, span.from));
    parts.push({ text: text.slice(span.from, span.to), category: span.category });
    at = span.to;
  }
  plain(text.slice(at));
  if (parts[0] && !parts[0].category) parts[0] = { text: parts[0].text.trimStart() };
  const last = parts.at(-1);
  if (last && !last.category) parts[parts.length - 1] = { text: last.text.trimEnd() };
  return parts.filter(({ text }) => text);
}

/** How wide a line's declaration is, without its trailing comment. */
const codeWidth = (text: string) => {
  const comment = commentStart(text);
  return (comment >= 0 ? text.slice(0, comment) : text).trimEnd().length;
};

/** The model's scope at the end of its declaration line. Opens the access inspector. */
class ScopeChip extends WidgetType {
  constructor(readonly model: string, readonly line: number, readonly scope: ModelScope) { super(); }
  override eq(other: ScopeChip) { return other.model === this.model && other.line === this.line && other.scope.label === this.scope.label && other.scope.kinds.join() === this.scope.kinds.join(); }
  toDOM() {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.tabIndex = -1; // Ctrl/Cmd+. opens the same inspector from the keyboard.
    chip.className = "cm-access-scope-chip";
    chip.dataset.accessLine = String(this.line);
    chip.dataset.accessModel = this.model;
    chip.dataset.exposed = String(this.scope.exposed);
    chip.setAttribute("aria-haspopup", "dialog");
    const from = this.scope.kinds.map((kind) => SCOPE_WORDS[kind]).join(", ");
    chip.title = this.scope.exposed ? `${this.model}: access comes from ${from}.\n${this.scope.label}\nClick to inspect.`
      : `${this.model} has no access directive, so the client API never returns it.`;
    chip.setAttribute("aria-label", this.scope.exposed ? `Access for ${this.model}: ${this.scope.label}` : `${this.model} is not in the client API`);
    for (const kind of this.scope.kinds) {
      const dot = document.createElement("span");
      dot.className = "cm-access-scope-dot";
      dot.dataset.kind = kind;
      dot.setAttribute("aria-hidden", "true");
      chip.append(dot);
    }
    const label = document.createElement("span");
    label.textContent = this.scope.label;
    chip.append(label);
    chip.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); event.stopPropagation(); chip.click();
    });
    return chip;
  }
  override ignoreEvent(event: Event) { return event.type === "keydown" || event.type === "keyup" || event.type === "keypress"; }
}

const VARIABLES: Readonly<Record<ScopeKind, string>> = { identity: "var(--access-identity)", role: "var(--access-role)", path: "var(--access-path)" };

/** The rail's colours: one stripe per kind of access, so a mixed model reads as mixed. */
const railStyle = (kinds: readonly ScopeKind[]) => [0, 1, 2].map((index) => `--access-rail-${index + 1}: ${VARIABLES[kinds[index % kinds.length]!]}`).join("; ");

export interface AccessDecorationOptions {
  readonly interactive: boolean;
  /** Exact draft that passed Studio's Prisma validation. */
  readonly validatedSource?: string;
  readonly modules?: AccessModules;
  readonly onApplySource: (source: string) => void;
}
export const setAccessDecorationOptions = StateEffect.define<AccessDecorationOptions>();
const optionsField = StateField.define<AccessDecorationOptions>({
  create: () => ({ interactive: true, onApplySource: () => {} }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setAccessDecorationOptions)) return effect.value;
    return value;
  },
});

const toggleInlineMatrix = StateEffect.define<string>();
const inlineMatrices = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update(value, transaction) {
    const toggle = transaction.effects.find(effect => effect.is(toggleInlineMatrix));
    if (!toggle) return value;
    const next = new Set(value);
    if (next.has(toggle.value)) next.delete(toggle.value);
    else next.add(toggle.value);
    return next;
  },
});

interface SourceSpan {
  readonly from: number;
  readonly to: number;
  /**
   * Where a caret sits directly after the drawn form: the end of the source it
   * replaces, or the declaration line where a stacked rule is drawn beside it.
   */
  readonly edge?: number;
}

interface MatrixSource {
  readonly line: number;
  readonly blocks: readonly SourceSpan[];
}

class InlineMatrixSwitch extends WidgetType {
  constructor(readonly enumeration: string, readonly checked: boolean) { super(); }
  override eq(other: InlineMatrixSwitch) { return this.enumeration === other.enumeration && this.checked === other.checked; }
  toDOM(view: EditorView) {
    const button = view.dom.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "cm-inline-role-switch";
    button.dataset.enumeration = this.enumeration;
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", `Show role permissions inline for ${this.enumeration}`);
    const track = view.dom.ownerDocument.createElement("span");
    track.setAttribute("aria-hidden", "true");
    button.append(track, "Inline matrix");
    this.updateDOM(button);
    button.addEventListener("click", () => {
      const { state } = view;
      const matrix = state.field(sourceField).matrices.get(this.enumeration);
      if (!matrix) return;
      const open = state.field(inlineMatrices).has(this.enumeration);
      const header = state.doc.line(matrix.line).from;
      const target = open ? header : matrix.blocks[0]?.from ?? header;
      view.dispatch({
        selection: !open && selectsSource(state, matrix.blocks) ? EditorSelection.cursor(header) : undefined,
        effects: [toggleInlineMatrix.of(this.enumeration), EditorView.scrollIntoView(target, { y: open ? "nearest" : "start", yMargin: 12 })],
      });
    });
    return button;
  }
  override updateDOM(button: HTMLElement) {
    if (button.dataset.enumeration !== this.enumeration) return false;
    button.setAttribute("aria-checked", String(this.checked));
    return true;
  }
}

interface RulePill extends SourceSpan {
  readonly enumeration?: string;
  readonly decorations: readonly Range<Decoration>[];
}

function targetName({ target }: SourceDirective) {
  switch (target.kind) {
    case "model": return target.model;
    case "field": return `${target.model}.${target.field}`;
    case "enum": return target.enumeration;
    case "value": return `${target.enumeration}.${target.value}`;
  }
}

/** Leave ordinary prose between permission directives in the document. */
function permissionBlocks(doc: Text, directives: readonly SourceDirective[]): SourceSpan[] {
  const blocks: SourceSpan[] = [];
  for (const directive of directives) {
    const { from } = doc.line(directive.line);
    const { to } = doc.line(directive.endLine);
    const last = blocks.at(-1);
    if (last && last.to + 1 === from) blocks[blocks.length - 1] = { from: last.from, to };
    else blocks.push({ from, to });
  }
  return blocks;
}

function sourceDecorations(state: EditorState) {
  const { doc } = state;
  const source = doc.toString();
  const directives = accessDirectives(source);
  const parsed = readClientAccess(source, state.field(optionsField).modules);
  const invalid = new Set(parsed.problems.map(problem => problem.line));
  const trailing = new Map(directives.filter(rule => rule.inline).map(rule => [rule.line, rule.commentFrom]));
  const highlights: Range<Decoration>[] = [];
  const structure: Range<Decoration>[] = [];
  const pills: RulePill[] = [];
  const governed = new Set<string>();
  const permissionRules = new Map<string, SourceDirective[]>();
  const columns = new Map<string, number>();
  /** Two columns past the enum's widest value declaration. */
  const annotationColumn = (enumeration: string) => {
    let column = columns.get(enumeration);
    if (column === undefined) {
      const lines = Object.values(parsed.index.enums[enumeration]?.values ?? {}).filter((line) => line <= doc.lines);
      column = Math.max(0, ...lines.map((line) => codeWidth(doc.line(line).text))) + 2;
      columns.set(enumeration, column);
    }
    return column;
  };
  /** Value lines that already have an aligned annotation; the next one follows it. */
  const annotated = new Set<number>();
  for (const token of accessTokens(directives)) {
    if (token.to > token.from && token.to <= doc.length) highlights.push(Decoration.mark({ class: `cm-access-token cm-access-${token.category}` }).range(token.from, token.to));
  }
  for (const directive of directives) {
    const kind = directiveKind(directive.rule);
    const keyword = directive.from;
    highlights.push(Decoration.mark({ class: "cm-access-token cm-access-keyword" }).range(keyword, keyword + "@access".length));
    const name = targetName(directive);
    governed.add(name);
    let valid = !!directive.rule;
    for (let line = directive.line; line <= directive.endLine; line++) {
      if (invalid.has(line)) valid = false;
      if (!directive.inline) highlights.push(Decoration.line({ class: "cm-access-line", attributes: { "data-access-kind": kind ?? "mixed" } }).range(doc.line(line).from));
    }
    if (!valid) continue;
    const target = directive.target;
    const enumeration = target.kind === "enum" && directive.rule?.kind === "permission" ? target.enumeration : undefined;
    if (enumeration) {
      const rows = permissionRules.get(enumeration) ?? [];
      rows.push(directive);
      permissionRules.set(enumeration, rows);
    }
    const memberLine = target.kind === "field" ? parsed.index.models[target.model]?.fields[target.field] :
      target.kind === "value" ? parsed.index.enums[target.enumeration]?.values[target.value] : undefined;
    const label = directive.args.trim().replace(/\s+/g, " ") || "No actions";
    const from = directive.commentFrom, to = directive.to;
    // Older schemas put field and value directives above their declaration.
    // Draw these beside it too; raw editing and saving retain the original text.
    const beside = memberLine && !directive.inline ? trailing.get(memberLine) ?? doc.line(memberLine).to : undefined;
    let widget: AccessButton;
    if (target.kind === "value") {
      // A role value's settings align in one column after the enum's longest value.
      const valueLine = doc.lineAt(beside ?? from);
      const column = annotationColumn(target.enumeration);
      const indent = annotated.has(valueLine.number) ? 0 : Math.max(0, column - (beside ?? from) + valueLine.from);
      annotated.add(valueLine.number);
      widget = new AccessButton("annotation", directive.line, name, label, kind, annotationParts(directive), indent);
    } else widget = new AccessButton("pill", directive.line, name, label, kind);
    const decorations = beside !== undefined
      ? [Decoration.replace({}).range(doc.line(directive.line - 1).to, doc.line(directive.endLine).to),
        Decoration.widget({ widget, side: -1 }).range(beside)]
      : [Decoration.replace({ widget }).range(from, to)];
    pills.push({ from, to, edge: beside ?? to, decorations, enumeration });
  }
  const scopes = modelScopes(parsed);
  const hintTargets = new Map<number, string>();
  const recordHint = (line: number, name: string) => {
    if (!governed.has(name)) hintTargets.set(line, name);
  };
  for (const [model, entry] of Object.entries(parsed.index.models)) {
    if (entry.line > doc.lines) continue;
    for (const [field, line] of Object.entries(entry.fields)) {
      if (!parsed.policy.models[model]?.fields[field]?.relation) recordHint(line, `${model}.${field}`);
    }
    const scope = scopes[model];
    if (!scope) continue;
    structure.push(Decoration.widget({ widget: new ScopeChip(model, entry.line, scope), side: 1 }).range(doc.line(entry.line).to));
    if (!scope.exposed) continue;
    for (let line = entry.line; line <= Math.min(entry.end, doc.lines); line++) {
      structure.push(Decoration.line({ class: "cm-access-rail", attributes: { "data-access-rail": scope.kinds.join(" "), style: railStyle(scope.kinds) } }).range(doc.line(line).from));
    }
  }
  const matrices = new Map<string, MatrixSource>();
  for (const [name, entry] of Object.entries(parsed.index.enums)) {
    const roles = parsed.graph.enums[name];
    if (roles && (Object.keys(roles.permissions).length || Object.keys(roles.masks).length)) {
      structure.push(Decoration.widget({ widget: new AccessButton("matrix-open", entry.line, name, "Role permissions"), side: 1 }).range(doc.line(entry.line).to));
      if (!invalid.size) matrices.set(name, { line: entry.line, blocks: permissionBlocks(doc, permissionRules.get(name) ?? []) });
    } else recordHint(entry.line, name);
    for (const [value, line] of Object.entries(entry.values)) recordHint(line, `${name}.${value}`);
  }
  return { source, parsed, directives, highlights: Decoration.set(highlights, true), structure, pills, hintTargets, matrices };
}

const sourceField = StateField.define<ReturnType<typeof sourceDecorations>>({
  create: sourceDecorations,
  update(value, transaction) {
    const before = transaction.startState.field(optionsField);
    const after = transaction.state.field(optionsField);
    return transaction.docChanged || before.modules !== after.modules ? sourceDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.highlights),
});

/**
 * A selection inside a rule's source, or a caret directly after its drawn form,
 * shows the authored text. A caret before a pill leaves it folded, so moving
 * through a declaration's leading whitespace does not unfold its rules.
 */
function selectsSource(state: EditorState, spans: readonly SourceSpan[]) {
  return state.selection.ranges.some(selection => spans.some(({ from, to, edge = to }) =>
    (selection.from < to && selection.to > from) || (selection.empty && selection.head === edge)));
}

/** A text cursor or a search match exposes the authored rule for editing. */
function visualDecorations(state: EditorState): DecorationSet {
  const options = state.field(optionsField);
  if (!options.interactive) return Decoration.none;
  const { doc } = state;
  const inline = state.field(inlineMatrices);
  const { source, parsed, directives, structure, pills, matrices } = state.field(sourceField);
  const ranges = [...structure];
  const shown = new Set<string>();
  for (const [enumeration, { line, blocks }] of matrices) {
    const checked = inline.has(enumeration);
    ranges.push(Decoration.widget({ widget: new InlineMatrixSwitch(enumeration, checked), side: 2 }).range(doc.line(line).to));
    if (!checked || selectsSource(state, blocks)) continue;
    shown.add(enumeration);
    const widget = new InlineRoleMatrix({ source, parsed, directives, enumeration, modules: options.modules,
      onApplySource: state.readOnly ? undefined : options.onApplySource });
    if (blocks.length === 0) ranges.push(Decoration.widget({ block: true, side: -1, widget }).range(doc.line(line).from));
    blocks.forEach(({ from, to }, index) => {
      ranges.push(Decoration.replace({ block: true, widget: index === 0 ? widget : undefined }).range(from, to));
    });
  }
  for (const pill of pills) {
    if (pill.enumeration && shown.has(pill.enumeration)) continue;
    if (!selectsSource(state, [pill])) ranges.push(...pill.decorations);
  }
  return Decoration.set(ranges, true);
}
const visualField = StateField.define<DecorationSet>({
  create: visualDecorations,
  update(value, transaction) {
    const { state, startState } = transaction;
    return transaction.selection || state.field(sourceField) !== startState.field(sourceField)
      || state.field(inlineMatrices) !== startState.field(inlineMatrices)
      || state.field(optionsField).interactive !== startState.field(optionsField).interactive
      || state.readOnly !== startState.readOnly
      ? visualDecorations(state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function accessHint(view: EditorView): DecorationSet {
  const { state } = view;
  const { interactive, validatedSource } = state.field(optionsField);
  const { source, hintTargets } = state.field(sourceField);
  if (!interactive || !view.hasFocus || state.readOnly || validatedSource !== source) return Decoration.none;
  const { main, ranges } = state.selection;
  if (!main.empty || ranges.length !== 1) return Decoration.none;
  const line = state.doc.lineAt(main.head);
  const target = hintTargets.get(line.number);
  if (!target || main.head !== line.to || commentStart(line.text) >= 0) return Decoration.none;
  return Decoration.set(Decoration.widget({ widget: new AccessButton("hint", line.number, target, "+ Access"), side: 2 }).range(line.to));
}

const caretHint = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = accessHint(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.focusChanged || update.state.readOnly !== update.startState.readOnly
      || update.state.field(optionsField) !== update.startState.field(optionsField)) this.decorations = accessHint(update.view);
  }
}, { decorations: plugin => plugin.decorations });

/** What a token means, from the same compile the API uses. */
const accessHover = hoverTooltip((view, position) => {
  if (!view.state.field(optionsField).interactive) return null;
  const line = view.state.doc.lineAt(position);
  if (!line.text.includes("///")) return null;
  const explanation = explainAccessAt(view.state.doc.toString(), position);
  if (!explanation) return null;
  return {
    pos: explanation.from, end: explanation.to, above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-access-hover";
      dom.dataset.category = explanation.category;
      const heading = document.createElement("p");
      heading.className = "cm-access-hover-heading";
      const tag = document.createElement("span");
      tag.className = "cm-access-hover-tag";
      tag.textContent = ACCESS_CATEGORY_LABELS[explanation.category];
      const title = document.createElement("strong");
      title.textContent = explanation.title;
      heading.append(tag, title);
      const body = document.createElement("p");
      body.className = "cm-access-hover-body";
      body.textContent = explanation.body;
      dom.append(heading, body);
      return { dom };
    },
  };
}, { hoverTime: 250 });

/** Colours, rails, scope chips and hover explanations for access directives. */
export function accessDecorations(options: AccessDecorationOptions) {
  return [optionsField.init(() => options), inlineMatrices, sourceField, visualField, caretHint, accessHover];
}

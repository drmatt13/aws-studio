import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Range } from "@codemirror/state";
import {
  Decoration, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  hoverTooltip, keymap, lineNumbers, rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { readClientAccess, type AccessModules } from "aws-studio/database/client-access";
import type { ModelLens, Reach } from "./access-lens";
import { accessDecorations, setAccessDecorationOptions } from "./access-decorations";
import type { FieldAccessAnchor } from "./access-presentation";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, undo } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, foldService, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { prismaAttributes, prismaCompletions, prismaDefinition, prismaFold, prismaLanguage, prismaScalars } from "./prisma-language";

export interface PrismaEditorDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly code?: string;
}
export interface PrismaEditorCursor { readonly from: number; readonly to: number; readonly line: number; readonly column: number }
export interface PrismaEditorHandle {
  /** Selects from–to and scrolls it into view, or scrolls `scrollFrom` into view when the context above matters. */
  reveal(from: number, to?: number, focus?: boolean, align?: "center" | "start", scrollFrom?: number): void;
  replace(from: number, to: number, text: string): void;
  replaceDocument(text: string): void;
  undo(): void;
  redo(): void;
  focus(): void;
  getSelection(): { from: number; to: number };
  /** A 1-based line of the editor's document, in its own offsets. */
  line(number: number): { from: number; to: number; text: string } | undefined;
  /** The 1-based line holding a document offset. */
  lineNumberAt(position: number): number;
}
/** One persona's answers for every model, for the source lens. */
export interface EditorAccessLens { readonly label: string; readonly models: Readonly<Record<string, ModelLens>> }

export interface PrismaEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCursor?: (cursor: PrismaEditorCursor) => void;
  readonly diagnostics?: readonly PrismaEditorDiagnostic[];
  readonly readOnly?: boolean;
  /** A mounted editor can be hidden by the workspace's tab or layout. */
  readonly visible?: boolean;
  readonly onFormat?: () => void;
  /** Opens source review. This callback must never save without review. */
  readonly onSave?: () => void;
  /** Opens the access popup from a rule, declaration or the cursor's Ctrl/Cmd+. shortcut. */
  readonly onFieldAccess?: (position: number, anchor: FieldAccessAnchor) => void;
  readonly interactiveAccess?: boolean;
  readonly accessModules?: AccessModules;
  /** Source bytes accepted by the workbench's latest Prisma validation. */
  readonly validatedSource?: string;
  /** "View as": what one persona may do, from the engine, drawn over the source. */
  readonly lens?: EditorAccessLens;
  readonly className?: string;
  readonly label?: string;
}

const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: "prisma-token-keyword" },
  { tag: [tags.typeName, tags.className], class: "prisma-token-type" },
  { tag: tags.definition(tags.variableName), class: "prisma-token-definition" },
  { tag: tags.meta, class: "prisma-token-attribute" },
  { tag: tags.string, class: "prisma-token-string" },
  { tag: [tags.number, tags.atom], class: "prisma-token-number" },
  { tag: tags.comment, class: "prisma-token-comment" },
  { tag: tags.function(tags.variableName), class: "prisma-token-function" },
  { tag: tags.invalid, class: "prisma-token-invalid" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "var(--sheet)", fontSize: "12px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.8", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 18px 0 8px" },
  ".cm-gutters": { border: "none", borderRight: "1px solid var(--rule)", color: "var(--faint)", backgroundColor: "light-dark(var(--wash), var(--sheet))", paddingRight: "4px" },
  ".cm-activeLineGutter, .cm-activeLine": { backgroundColor: "color-mix(in srgb, light-dark(var(--prod), var(--dev)) 5%, transparent)" },
  ".cm-activeLineGutter": { color: "light-dark(var(--quiet), var(--faint))" },
  ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "10px", minWidth: "32px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--dev) 14%, transparent)", outline: "1px solid color-mix(in srgb, var(--dev) 30%, transparent)" },
  ".cm-panels": { color: "var(--ink)", backgroundColor: "var(--wash)", fontFamily: "var(--sans)" },
  ".cm-panels-top": { borderBottom: "1px solid var(--rule)" },
  ".cm-tooltip": { border: "1px solid var(--rule-strong)", borderRadius: "6px", backgroundColor: "var(--sheet)", color: "var(--ink)", fontFamily: "var(--sans)", boxShadow: "var(--elevation-popover)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { color: "var(--selected-ink)", backgroundColor: "var(--selected)" },
  ".cm-completionDetail": { color: "var(--graphite)", fontSize: "11px", marginLeft: "12px" },
  ".cm-tooltip.cm-tooltip-hover": { maxWidth: "360px", padding: "10px 12px", fontSize: "12px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--wash)", color: "var(--graphite)", border: "1px solid var(--rule)" },
});

const externalChange = Transaction.userEvent.of("input.external");
/** Minimal splice lets CodeMirror map the cursor through formatting and external document changes. */
export function editorChange(previous: string, next: string): { from: number; to: number; insert: string } | null {
  if (previous === next) return null;
  let from = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from++;
  let to = previous.length, end = next.length;
  while (to > from && end > from && previous[to - 1] === next[end - 1]) { to--; end--; }
  return { from, to, insert: next.slice(from, end) };
}
const APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The field access shortcut as this platform writes it. Ctrl+. also works on macOS. */
export const FIELD_ACCESS_KEY = APPLE ? "⌘." : "Ctrl+.";

const setAccessLens = StateEffect.define<EditorAccessLens | undefined>();
const accessLensField = StateField.define<EditorAccessLens | undefined>({
  create: () => undefined,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setAccessLens)) return effect.value;
    return value;
  },
});

const when = (reach: Reach) => (reach.when === "in some states" ? " in some states" : ` when ${reach.when}`);
/** What the persona may do with a model's rows, as one line for its header. */
export function lensSummary(label: string, lens: ModelLens): string {
  const scope = lens.coverage.truncated ? "evaluated rows" : "rows in this access path";
  const parts = [lens.visible.level === "yes" ? `sees ${scope}` : lens.visible.level === "no" ? `sees no ${scope}` : `sees rows${when(lens.visible)}`];
  if (lens.create.level !== "no") parts.push(`creates${lens.create.level === "some" ? when(lens.create) : ""}`);
  if (lens.delete.level !== "no") parts.push(`deletes${lens.delete.level === "some" ? when(lens.delete) : ""}`);
  return `As ${label}: ${parts.join(" · ")}`;
}

/** "View as": fields the persona cannot read are dimmed in place. */
function lensDecorations(state: EditorState): DecorationSet {
  const lens = state.field(accessLensField, false);
  if (!lens) return Decoration.none;
  const { doc } = state;
  const { index } = readClientAccess(doc.toString());
  const ranges: Range<Decoration>[] = [];
  for (const [model, answers] of Object.entries(lens.models)) {
    const lines = index.models[model]?.fields ?? {};
    for (const [field, { read }] of Object.entries(answers.fields)) {
      const line = lines[field];
      if (!line || line > doc.lines) continue;
      if (read.level === "no") ranges.push(Decoration.line({ class: "cm-lens-dim" }).range(doc.line(line).from));
    }
  }
  return Decoration.set(ranges, true);
}
const lensField = StateField.define<DecorationSet>({
  create: lensDecorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.effects.some((effect) => effect.is(setAccessLens)) ? lensDecorations(transaction.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Where the inspector anchors for the cursor's line: after its text. */
function lineAnchor(view: EditorView, position: number): FieldAccessAnchor {
  const coords = view.coordsAtPos(view.state.doc.lineAt(position).to) ?? view.contentDOM.getBoundingClientRect();
  return { left: coords.left, top: coords.top, bottom: coords.bottom };
}

function diagnosticRanges(diagnostics: readonly PrismaEditorDiagnostic[], length: number): Diagnostic[] {
  return diagnostics.map(item => ({ ...item, from: Math.max(0, Math.min(length, item.from)), to: Math.max(0, Math.min(length, Math.max(item.from, item.to))), source: item.code ? `Prisma · ${item.code}` : "Prisma" }));
}

export const PrismaEditor = forwardRef<PrismaEditorHandle, PrismaEditorProps>(function PrismaEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Callbacks are current without reconstructing the editor and destroying undo/selection.
  const latest = useRef(props);
  latest.current = props;
  const readOnly = useRef(new Compartment());
  const reveal = (from: number, to = from, focus = true, align: "center" | "start" = "center", scrollFrom = from) => {
    const editor = view.current;
    if (!editor) return;
    const clamp = (offset: number) => Math.max(0, Math.min(editor.state.doc.length, offset));
    editor.dispatch({ selection: EditorSelection.single(clamp(from), clamp(to)), effects: EditorView.scrollIntoView(clamp(scrollFrom), { y: align, yMargin: align === "start" ? 12 : 0 }) });
    if (focus) editor.focus();
  };
  const replace = (from: number, to: number, text: string) => {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    editor.dispatch({ changes: { from, to, insert: text }, annotations: [Transaction.userEvent.of("input.visual"), isolateHistory.of("full")] });
  };
  const replaceDocument = useCallback((text: string) => {
    const editor = view.current;
    if (!editor || editor.state.readOnly) return;
    const changes = editorChange(editor.state.doc.toString(), text);
    if (changes) editor.dispatch({ changes, annotations: [Transaction.userEvent.of("input.format"), isolateHistory.of("full")] });
  }, []);
  useImperativeHandle(ref, () => ({
    reveal, replace, replaceDocument,
    undo() { if (view.current) undo(view.current); },
    redo() { if (view.current) redo(view.current); },
    focus() { view.current?.focus(); },
    getSelection() { const selection = view.current?.state.selection.main; return { from: selection?.from ?? 0, to: selection?.to ?? 0 }; },
    line(number) {
      const doc = view.current?.state.doc;
      if (!doc || number < 1 || number > doc.lines) return undefined;
      const line = doc.line(number);
      return { from: line.from, to: line.to, text: line.text };
    },
    lineNumberAt(position) {
      const doc = view.current?.state.doc;
      return doc ? doc.lineAt(Math.max(0, Math.min(doc.length, position))).number : 1;
    },
  }), [replaceDocument]);

  const { interactiveAccess, accessModules, validatedSource } = props;
  const accessOptions = useMemo(() => ({
    interactive: interactiveAccess !== false, modules: accessModules,
    validatedSource: validatedSource?.replace(/\r\n?/g, "\n"), onApplySource: replaceDocument,
  }), [interactiveAccess, accessModules, validatedSource, replaceDocument]);

  useLayoutEffect(() => {
    if (!host.current) return;
    const openAccess = (mark: Element, editor: EditorView) => {
      if (!latest.current.onFieldAccess) return false;
      const line = Number(mark.getAttribute("data-access-line"));
      if (!line || line > editor.state.doc.lines) return false;
      const target = editor.state.doc.line(line);
      const position = mark.classList.contains("cm-access-hint") ? target.to : target.from;
      const { left, top, bottom } = mark.getBoundingClientRect();
      editor.dispatch({ selection: EditorSelection.cursor(position) });
      latest.current.onFieldAccess(position, { left, top, bottom, element: mark });
      return true;
    };
    const accessTargets = ".cm-access-pill, .cm-access-annotation, .cm-access-hint, .cm-access-matrix-open, .cm-access-scope-chip";
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: latest.current.value, extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
      rectangularSelection(), highlightActiveLine(), highlightSelectionMatches(), indentUnit.of("  "),
      prismaLanguage, syntaxHighlighting(highlight), theme,
      search({ top: true }), autocompletion({ override: [prismaCompletions] }), lintGutter(),
      foldService.of((state, from, to) => prismaFold(state.doc.toString(), from, to)), foldGutter(),
      readOnly.current.of(EditorState.readOnly.of(!!latest.current.readOnly)),
      EditorView.contentAttributes.of({ "aria-label": latest.current.label ?? "Prisma schema source", "aria-describedby": "prisma-editor-keyboard-help", spellcheck: "false", autocapitalize: "off", autocomplete: "off", "data-gramm": "false" }),
      EditorView.lineWrapping,
      accessDecorations(accessOptions),
      accessLensField.init(() => latest.current.lens),
      lensField,
      EditorView.domEventHandlers({
        mousedown(event, editor) {
          const mark = event.button === 0 && event.target instanceof Element ? event.target.closest(accessTargets) : null;
          if (!mark || !latest.current.onFieldAccess) return false;
          event.preventDefault();
          return openAccess(mark, editor);
        },
        click(event, editor) {
          const mark = event.detail === 0 && event.target instanceof Element ? event.target.closest(accessTargets) : null;
          if (!mark) return false;
          return openAccess(mark, editor);
        },
      }),
      keymap.of([
        // Mod-. is Cmd+. on macOS; Ctrl-. is bound too so the same keys work everywhere.
        ...["Mod-.", "Ctrl-."].map(key => ({ key, run: (editor: EditorView) => {
          if (latest.current.interactiveAccess === false || !latest.current.onFieldAccess) return false;
          const head = editor.state.selection.main.head;
          latest.current.onFieldAccess(head, lineAnchor(editor, head));
          return true;
        } })),
        { key: "Mod-s", run: () => { latest.current.onSave?.(); return true; } },
        { key: "Mod-Shift-f", run: () => { latest.current.onFormat?.(); return true; } },
        { key: "Alt-Shift-f", run: () => { latest.current.onFormat?.(); return true; } },
        { key: "Mod-h", run: openSearchPanel },
        { key: "Mod-Alt-f", run: openSearchPanel },
        { key: "F12", run: editor => {
          const definition = prismaDefinition(editor.state.doc.toString(), editor.state.selection.main.head);
          if (definition) reveal(definition.from, definition.to);
          else editor.dispatch({ effects: EditorView.announce.of("No unambiguous definition in this draft.") });
          return true;
        } },
        { key: "Escape", run: editor => { editor.setTabFocusMode(3000); return false; } },
        ...completionKeymap, ...closeBracketsKeymap, ...defaultKeymap,
        // Leave the browser's Find shortcut available while the editor is focused.
        ...searchKeymap.filter(binding => binding.key !== "Mod-f"),
        ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab,
      ]),
      hoverTooltip((editor, offset) => {
        const line = editor.state.doc.lineAt(offset);
        const within = offset - line.from;
        const expression = /@@?[\w.]+|[A-Za-z_][\w.]*/g;
        for (const match of line.text.matchAll(expression)) {
          if (match.index > within || match.index + match[0].length < within) continue;
          const information = prismaAttributes[match[0]] ?? prismaScalars[match[0]];
          if (!information) return null;
          return { pos: line.from + match.index, end: line.from + match.index + match[0].length, above: true,
            create() { const dom = document.createElement("div"); dom.textContent = information; return { dom }; } };
        }
        return null;
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !update.transactions.some(transaction => transaction.isUserEvent("input.external"))) latest.current.onChange(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main;
          const line = update.state.doc.lineAt(selection.head);
          latest.current.onCursor?.({ from: selection.from, to: selection.to, line: line.number, column: selection.head - line.from + 1 });
        }
      }),
    ] }) });
    view.current = editor;
    if (latest.current.diagnostics?.length) editor.dispatch(setDiagnostics(editor.state, diagnosticRanges(latest.current.diagnostics, editor.state.doc.length)));
    return () => { view.current = null; editor.destroy(); };
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const changes = editorChange(editor.state.doc.toString(), props.value);
    if (changes) editor.dispatch({ changes, annotations: [externalChange, isolateHistory.of("full")] });
  }, [props.value]);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: setAccessDecorationOptions.of(accessOptions) });
  }, [accessOptions]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || props.visible === false) return;
    // CodeMirror starts with estimated line heights and normally measures next
    // frame. Flush that measurement through its public geometry API before paint
    // so the gutters never appear at the estimate, including after a hidden tab.
    editor.requestMeasure();
    editor.coordsAtPos(editor.state.selection.main.head);
  }, [props.visible]);
  useEffect(() => {
    const editor = view.current;
    if (editor) editor.dispatch(setDiagnostics(editor.state, diagnosticRanges(props.diagnostics ?? [], editor.state.doc.length)));
  }, [props.diagnostics]);
  useEffect(() => { view.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(!!props.readOnly)) }); }, [props.readOnly]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.field(accessLensField, false) !== props.lens) editor.dispatch({ effects: setAccessLens.of(props.lens) });
  }, [props.lens]);
  return <div data-prisma-editor data-ui="prisma-editor" className={`flex h-full min-h-0 min-w-0 flex-1 flex-col ${props.className ?? ""}`}>
    <div data-ui="prisma-editor-host" className="min-h-0 min-w-0 flex-1 overflow-hidden" ref={host} />
    <span id="prisma-editor-keyboard-help" className="sr-only">
      Prisma 8 source editor. Tab indents. Press Escape then Tab to leave. Control or Command Alt F opens editor find and replace. Control or Command S reviews source changes. {interactiveAccess !== false && "Control or Command period inspects access at the cursor."} F12 goes to a definition, including names in access directives.
    </span>
  </div>;
});
import "../styles/codemirror.css";

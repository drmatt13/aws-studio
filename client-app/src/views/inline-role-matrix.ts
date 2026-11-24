import { redo, undo } from "@codemirror/commands";
import { EditorView, WidgetType } from "@codemirror/view";
import { createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RolePermissionMatrix, rolePermissionItems } from "./RolePermissionMatrix";

type MatrixProps = Omit<ComponentProps<typeof RolePermissionMatrix>, "onNavigate" | "inline">;

const roots = new WeakMap<HTMLElement, Root>();

/** A CodeMirror block widget backed by the same table as the role popup. */
export class InlineRoleMatrix extends WidgetType {
  constructor(private readonly props: MatrixProps) { super(); }

  override get estimatedHeight() {
    // Give CodeMirror the table's approximate height before the block has been measured:
    // a header and one code line per permission, plus the block's padding.
    return 8 + 22 * (1 + rolePermissionItems(this.props.parsed.graph.enums[this.props.enumeration]!).length);
  }

  override eq(other: InlineRoleMatrix) {
    return this.props.enumeration === other.props.enumeration && this.props.source === other.props.source
      && this.props.modules === other.props.modules && this.props.onApplySource === other.props.onApplySource;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement("section");
    element.className = "cm-inline-role-matrix";
    element.setAttribute("aria-label", `${this.props.enumeration} inline role permissions`);
    element.addEventListener("keydown", event => {
      const key = event.key.toLowerCase();
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || (key !== "z" && key !== "y")) return;
      event.preventDefault();
      const history = key === "y" || event.shiftKey ? redo : undo;
      const scroll = view.scrollSnapshot();
      history({
        state: view.state,
        // History usually scrolls to the text selection. Keep the focused table cell in view here.
        dispatch: change => view.dispatch([change, change.state.update({ effects: scroll.map(change.changes) })]),
      });
    });
    roots.set(element, createRoot(element));
    this.updateDOM(element, view);
    return element;
  }

  override updateDOM(element: HTMLElement, view: EditorView): boolean {
    if (element.getAttribute("aria-label") !== `${this.props.enumeration} inline role permissions`) return false;
    const root = roots.get(element);
    if (!root) return false;
    const { source, onApplySource } = this.props;
    root.render(createElement("div", { className: "cm-inline-role-matrix-panel" },
      createElement(RolePermissionMatrix, {
        ...this.props, inline: true,
        onApplySource: onApplySource && ((next) => {
          if (view.state.doc.toString() === source) onApplySource(next);
        }),
        onNavigate(lineNumber) {
          const { doc } = view.state;
          if (lineNumber > doc.lines) return;
          const line = doc.line(lineNumber);
          const marker = line.text.indexOf("@access");
          const head = marker < 0 ? line.from : line.from + marker + 1;
          view.dispatch({ selection: { anchor: head }, effects: EditorView.scrollIntoView(head, { y: "nearest" }) });
          view.focus();
        },
      })));
    return true;
  }

  override destroy(element: HTMLElement) {
    const root = roots.get(element);
    roots.delete(element);
    // An editor can be destroyed during its parent React tree's commit.
    if (root) queueMicrotask(() => root.unmount());
  }
}

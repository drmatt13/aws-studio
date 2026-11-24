import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { FieldAccessAnchor } from "./access-presentation";

/** Keep the source layout intact when opening policy controls from a pill, a line or the diagram. */
export function PrismaAccessPopup({ anchor, matrix, label, children, onClose }: {
  anchor: FieldAccessAnchor;
  matrix: boolean;
  label: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const popup = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = popup.current!;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => dialog.close();
  }, []);

  useLayoutEffect(() => {
    const dialog = popup.current!;
    const viewport = window.visualViewport;
    const place = () => {
      const origin = anchor.element?.isConnected ? anchor.element.getBoundingClientRect() : anchor;
      const { width, height } = dialog.getBoundingClientRect();
      const viewWidth = viewport?.width ?? window.innerWidth;
      const viewHeight = viewport?.height ?? window.innerHeight;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const margin = 12;
      const centered = viewWidth <= 600;
      const left = centered ? x + (viewWidth - width) / 2 : origin.left;
      const below = origin.bottom + 8;
      const top = centered ? y + (viewHeight - height) / 2
        : below + height + margin <= y + viewHeight ? below : origin.top - height - 8;
      dialog.style.left = `${Math.max(x + margin, Math.min(left, x + viewWidth - width - margin))}px`;
      dialog.style.top = `${Math.max(y + margin, Math.min(top, y + viewHeight - height - margin))}px`;
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(dialog);
    const scroll = (event: Event) => { if (event.target instanceof Node && !dialog.contains(event.target)) place(); };
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      observer?.disconnect();
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [anchor]);

  return <dialog ref={popup} id="prisma-access-popup" aria-label={label} tabIndex={-1} data-ui="access-rule-popup"
    className={`fixed inset-auto m-0 max-h-[min(84dvh,calc(100dvh-24px))] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-rule-strong bg-sheet p-0 text-ink shadow-popover outline-none backdrop:bg-transparent open:flex ${matrix ? "w-[min(52rem,calc(100vw-24px))]" : "w-[min(28rem,calc(100vw-24px))]"}`}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >{children}</dialog>;
}

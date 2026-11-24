import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../ui/IconButton";

/** Header pills explain on hover/focus; activation pins their details for touch and owner navigation. */
export function EnvironmentDetails({ description, heading, summary, note, details, children, ...props }: ComponentProps<"button"> & {
  readonly description: string;
  readonly heading: string;
  readonly summary: string;
  readonly note?: string;
  readonly details?: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismissed = useRef(false);
  const pointerFocus = useRef(false);
  const [open, setOpen] = useState<"preview" | "pinned" | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const cancelClose = () => clearTimeout(timer.current);
  const close = (restoreFocus = false) => {
    cancelClose();
    dismissed.current = true;
    setOpen(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const preview = () => {
    cancelClose();
    if (!dismissed.current) setOpen(current => current ?? "preview");
  };
  const leave = () => {
    dismissed.current = false;
    cancelClose();
    timer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current) setOpen(current => current === "preview" ? null : current);
    }, 150);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const { width, height } = popup.getBoundingClientRect();
      const below = window.innerHeight - anchor.bottom - 20;
      const above = anchor.top - 20;
      const placeAbove = height > below && above > below;
      const available = Math.max(44, Math.min(window.innerHeight - 24, placeAbove ? above : below));
      popup.style.maxHeight = `${available}px`;
      const top = placeAbove ? anchor.top - Math.min(height, available) - 8 : anchor.bottom + 8;
      setPosition({
        left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(top, window.innerHeight - Math.min(height, available) - 12)),
      });
    };
    panel.current?.showPopover?.();
    positionPanel();
    if (open === "pinned") closeButton.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(open === "pinned");
    };
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(positionPanel);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
      observer?.disconnect();
    };
  }, [open]);
  return <>
    <button {...props} ref={trigger} type="button"
      aria-label={description}
      aria-haspopup="dialog"
      aria-expanded={open === "pinned"}
      aria-controls={open === "pinned" ? id : undefined}
      aria-describedby={open === "preview" ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== "touch") preview(); }}
      onPointerLeave={leave}
      onPointerDown={() => { pointerFocus.current = true; }}
      onPointerUp={() => { pointerFocus.current = false; }}
      onPointerCancel={() => { pointerFocus.current = false; }}
      onFocus={() => { if (!pointerFocus.current) preview(); }}
      onBlur={() => { pointerFocus.current = false; dismissed.current = false; setOpen(current => current === "preview" ? null : current); }}
      onClick={() => { cancelClose(); dismissed.current = false; setOpen(current => current === "pinned" ? null : "pinned"); }}
    >{children}</button>
    {open ? createPortal(<div ref={panel} id={id} popover="auto"
      role={open === "pinned" ? "dialog" : "tooltip"}
      aria-label={open === "pinned" ? description : undefined}
      data-ui="environment-details"
      onToggle={event => {
        if (event.target !== event.currentTarget || event.newState !== "closed") return;
        // Another pill replaces this auto popover. Only an explicit dismissal
        // suppresses previews; returning to this pill must open it immediately.
        cancelClose();
        setOpen(null);
      }}
      onPointerEnter={cancelClose} onPointerLeave={leave}
      style={{ ...props.style, ...position }}
      className="fixed right-auto bottom-auto z-40 m-0 box-border grid w-max max-w-[min(320px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] gap-3 overflow-y-auto overscroll-contain rounded-xl border border-[color-mix(in_srgb,var(--badge-fg)_24%,var(--rule))] bg-sheet bg-[radial-gradient(ellipse_at_top_right,color-mix(in_srgb,var(--badge-fg)_10%,transparent),transparent_75%)] p-3 text-left font-sans text-caption font-normal leading-relaxed whitespace-normal text-ink shadow-popover wrap-anywhere before:pointer-events-none before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,var(--badge-fg),transparent)] before:opacity-70 before:content-[''] forced-colors:border-[CanvasText]"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <strong className="min-w-0 font-semibold leading-5 text-(--badge-fg)">{heading}</strong>
        {open === "pinned" ? <IconButton ref={closeButton} variant="quiet" size="compact" aria-label="Close environment details" onClick={() => close(true)}><X size={14} aria-hidden /></IconButton> : null}
      </div>
      <p className="m-0 text-graphite">{summary}</p>
      {open === "pinned" && note ? <p className="m-0 border-t border-rule/70 pt-2.5 text-graphite">{note}</p> : null}
      {open === "pinned" ? details : null}
    </div>, trigger.current?.closest("dialog") ?? document.body) : null}
  </>;
}

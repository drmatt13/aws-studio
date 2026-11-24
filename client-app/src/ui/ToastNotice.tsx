import { X } from "lucide-react";
import { cx } from "./classes";
import type { ToastAction } from "./useToasts";

export function ToastNotice({ text, tone, action, onDismiss }: {
  readonly text: string;
  readonly tone: "plain" | "info" | "accept" | "refuse";
  readonly action?: ToastAction;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      data-ui="toast"
      className={cx(
        "pointer-events-auto flex max-w-full items-start rounded-md border border-graphite text-step-minus1 leading-5 text-sheet shadow-popover",
        tone === "refuse" ? "bg-refuse" : tone === "accept" ? "bg-accept" : "bg-ink",
      )}
    >
      <span className="min-w-0 flex-1 py-3 pl-4 wrap-anywhere">{text}</span>
      {action ? (
        // Acting on a notification answers it, so it leaves with the click.
        <button
          type="button"
          onClick={() => { action.run(); onDismiss(); }}
          className="mt-2 ml-2 inline-flex min-h-7 flex-none cursor-pointer items-center rounded-md border-0 bg-transparent px-2 font-sans text-inherit font-medium underline underline-offset-[3px] hover:bg-sheet/15 focus-visible:outline-current focus-visible:-outline-offset-2 coarse:mt-0 coarse:min-h-11"
        >
          {action.label}
        </button>
      ) : null}
      {/* Quiet like IconButton, whose wash and ink hover would invert harshly on this surface. */}
      <button
        type="button"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        onClick={onDismiss}
        className={cx(action ? "my-2 mr-2 ml-0.5" : "m-2", "inline-flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-inherit cursor-pointer hover:bg-sheet/15 focus-visible:outline-current focus-visible:-outline-offset-2 coarse:m-0 coarse:size-11")}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

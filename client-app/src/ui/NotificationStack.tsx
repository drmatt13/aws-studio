import { ToastNotice } from "./ToastNotice";
import { cx } from "./classes";
import type { Toast } from "./useToasts";

/**
 * Pure lengths, so placement tracks the tray's animated height frame by frame.
 * `--tray` is what the Activity tray occupies, `--rest` is where the stack rests
 * above it and any dock a workspace reserves, and `--room` is the height left
 * between there and the navigation. The `* 1000` terms make a step: with space for
 * a notification it rests above the tray, and without it drops into the tray's
 * foot, under the Activity and Agent tabs rather than over them.
 */
const ABOVE_THE_TRAY = [
  "[--tray:calc(var(--activity-drawer-visible,0px)_+_var(--activity-bar-height,40px)_+_1px)]",
  "[--rest:calc(var(--tray)_+_var(--notification-clearance,0px)_+_12px)]",
  "[--room:calc(100dvh_-_var(--bar)_-_8px_-_var(--rest))]",
  "activity-expanded:[--notification-clearance:0px]",
  "bottom-[max(12px,min(var(--rest),calc(var(--rest)_+_(var(--room)_-_96px)_*_1000)))]",
  "top-[max(calc(var(--bar)_+_8px),min(calc(100dvh_-_var(--tray)_+_var(--activity-bar-height,40px)_+_8px),calc(var(--bar)_+_8px_+_(96px_-_var(--room))_*_1000)))]",
].join(" ");

/**
 * The single stack, so notifications have one predictable home. Short windows show
 * the newest two whole, and the clip is a last guard that spares the other three
 * sides, which carry the toasts' shadow.
 */
export function NotificationStack({ toasts, onDismiss, fullscreen = false }: {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: number) => void;
  /** Native fullscreen has no Activity bar or navigation to clear. */
  readonly fullscreen?: boolean;
}) {
  return (
    <div
      data-ui="toasts"
      role="status"
      aria-live="polite"
      className={cx(
        "pointer-events-none fixed left-4 z-30 flex w-[min(460px,calc(100vw-32px))] flex-col items-start justify-end gap-2 [clip-path:inset(0_-32px_-32px_-32px)] [@media(max-height:640px)]:[&>:nth-last-child(n+3)]:hidden",
        fullscreen ? "bottom-4" : ABOVE_THE_TRAY,
      )}
    >
      {toasts.map((item) => (
        <ToastNotice key={item.id} text={item.text} tone={item.tone} {...(item.action ? { action: item.action } : {})} onDismiss={() => onDismiss(item.id)} />
      ))}
    </div>
  );
}

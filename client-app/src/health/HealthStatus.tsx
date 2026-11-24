import { forwardRef, type KeyboardEvent } from "react";
import { cx } from "../ui/classes";
import type { HealthIndicator } from "./conditions";
import { SEVERITY_ICON } from "./severity";

const TONE: Readonly<Record<HealthIndicator["severity"], string>> = {
  healthy: "border-transparent text-graphite hover:bg-wash hover:text-ink",
  notice: "border-transparent text-graphite hover:bg-wash hover:text-ink",
  warning: "border-transparent text-caution hover:bg-wash",
  error: "border-refuse/40 bg-refuse-wash text-refuse hover:border-refuse",
};

/**
 * Source status, in the navbar's free space. A healthy navbar shows nothing, but
 * the slot stays reserved so an indicator arriving moves nothing. Its text grows
 * leftward into space nothing else uses, and container queries hide that text
 * before it could press on navigation. While the panel is open the control stays,
 * even once healthy, so the panel keeps its toggle as recovery happens inside it.
 */
export const HealthStatus = forwardRef<HTMLButtonElement, {
  readonly indicator: HealthIndicator;
  readonly hold: string | null;
  readonly expanded: boolean;
  readonly panelId: string;
  readonly onToggle: () => void;
  readonly onClose: () => void;
  readonly className?: string;
}>(function HealthStatus({ indicator, hold, expanded, panelId, onToggle, onClose, className }, ref) {
  const Mark = SEVERITY_ICON[indicator.severity];
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && expanded) { event.preventDefault(); onClose(); }
  };
  return (
    <div data-ui="health-status" className={cx("@container flex min-h-7 min-w-0 items-center justify-end gap-3 coarse:min-h-11", className)}>
      <span role="status" className={cx("text-caption whitespace-nowrap text-graphite", indicator.label ? "sr-only" : "sr-only @min-[224px]:not-sr-only")}>{hold}</span>
      {indicator.severity === "healthy" && !expanded ? null : (
        <button
          ref={ref}
          type="button"
          data-severity={indicator.severity}
          aria-label={indicator.description}
          title={indicator.description}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          onKeyDown={closeOnEscape}
          className={cx(
            "inline-flex h-7 max-w-full min-w-7 cursor-pointer items-center justify-end gap-1.5 rounded-md border px-1.5 font-sans text-label font-medium coarse:h-11 coarse:min-w-11 coarse:justify-center",
            TONE[indicator.severity],
          )}
        >
          {indicator.label ? (
            <span className="hidden min-w-0 items-baseline gap-1.5 @min-[132px]:flex">
              {indicator.showsLastLoaded ? <span className="hidden flex-none font-normal text-graphite @min-[248px]:inline">Last loaded</span> : null}
              <span className={cx("min-w-0 truncate", indicator.labelIsPlace && "font-mono text-meta")}>{indicator.label}</span>
              {indicator.additional ? <span className="flex-none font-normal">+{indicator.additional}</span> : null}
            </span>
          ) : null}
          <Mark data-severity-mark={indicator.severity} size={14} className="flex-none" aria-hidden />
        </button>
      )}
    </div>
  );
});

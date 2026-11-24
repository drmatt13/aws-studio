import type { Mode } from "../../shared/model";
import { deploymentBadgeCss } from "../deployment";
import { cx } from "../ui/classes";
import type { CSSProperties } from "react";

/** Matching circular actions in the map's bottom-right dock. */
export const mapFloatingButtonClasses =
  "flex size-10 cursor-pointer items-center justify-center rounded-full border border-map-edge bg-transparent bg-[linear-gradient(145deg,var(--map-float-from),var(--map-float-to))] p-0 text-map-text shadow-map-float backdrop-blur-[12px] transition-[border-color,color] duration-150 hover:border-map-edge-strong hover:bg-[linear-gradient(145deg,var(--map-float-hover-from),var(--map-float-hover-to))] hover:text-map-title aria-expanded:border-map-edge-strong aria-expanded:bg-[linear-gradient(145deg,var(--map-float-hover-from),var(--map-float-hover-to))] aria-expanded:text-map-title focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-map-focus";

/** DOM chrome over the canvas, in the map's theme. Geometry is supplied by the caller. */
export function mapTooltipClasses(portal = false) {
  return cx(
    "w-[400px] max-w-[calc(100vw-16px)] overflow-auto overscroll-contain rounded-lg border border-map-edge bg-map-surface p-4 text-label leading-[1.5] text-map-text shadow-popover wrap-anywhere scrollbar-thin [scrollbar-color:light-dark(var(--map-edge-strong),#556174)_transparent] forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText] forced-colors:[&_strong]:text-[CanvasText] forced-colors:[&_dt]:text-[CanvasText] forced-colors:[&_dd]:text-[CanvasText] forced-colors:[&_p]:text-[CanvasText] forced-colors:[&_span]:text-[CanvasText] forced-colors:[&_[data-environment]]:border-[CanvasText] forced-colors:[&_[data-enabled=false]]:border-dashed",
    portal ? "pointer-events-auto fixed z-40" : "pointer-events-auto absolute z-4",
  );
}

/** A background-connection filter pill on the canvas; pressed means shown. */
export const mapFilterChipClasses =
  "group pointer-events-auto inline-flex min-h-(--control-height-sm) cursor-pointer items-center gap-[7px] rounded-full border border-dashed border-map-edge bg-map-surface/90 px-[10px] py-[3px] font-sans text-caption leading-[1.3] font-medium whitespace-nowrap text-map-muted aria-pressed:border-solid aria-pressed:border-map-edge-strong aria-pressed:text-map-ink aria-pressed:not-hover:bg-[light-dark(var(--map-row),color-mix(in_oklab,var(--map-surface)_90%,transparent))] hover:border-map-muted hover:bg-map-row hover:text-map-title focus-visible:outline-2 focus-visible:outline-map-focus focus-visible:outline-offset-2";
/** A category pill's line swatch, in its `--swatch` colour; faint until pressed. */
export const mapFilterSwatchClasses =
  "before:h-0.5 before:w-3.5 before:flex-none before:rounded-[1px] before:bg-(--swatch) before:opacity-30 before:content-[''] aria-pressed:before:opacity-100";

export const mapCameraButtonClasses =
  "inline-flex h-[calc(var(--control-height)-2px)] w-(--control-height) cursor-pointer items-center justify-center border-0 border-l border-rule bg-transparent text-graphite first:rounded-l-md first:border-l-0 last:rounded-r-md hover:not-disabled:bg-wash hover:not-disabled:text-ink aria-pressed:bg-wash aria-pressed:text-ink disabled:cursor-default disabled:opacity-35";

/** Use the same semantic palette in canvas badges and DOM environment facts, in Studio's theme. */
export const environmentStyle = (mode: Mode): CSSProperties => {
  const badge = deploymentBadgeCss(mode);
  return { "--badge-fg": badge.color, "--badge-bg": badge.background } as CSSProperties;
};
export const environmentTextClasses = "text-(--badge-fg)";

/** Shared resource/connection tooltip typography and two-column fact rows. */
export const hoverTitleClasses =
  "font-sans text-step0 leading-[1.35] font-semibold text-map-title wrap-anywhere";
export const hoverFactRowClasses = "grid grid-cols-[34px_minmax(0,1fr)] items-baseline gap-2";
/**
 * A fact's emphasis on every map card: an error or warning (`src/issues.ts`) in the canvas's issue
 * colours, an expected reason with a neutral rule. Colour is never the only cue; each keeps its words.
 */
export const hoverToneClasses = {
  error: "border-l-2 border-map-error pl-2 text-map-error-text",
  warning: "border-l-2 border-map-warning pl-2 text-map-warning-text",
  info: "border-l-2 border-map-rule pl-2 text-map-muted",
} as const;
export const hoverFactValueClasses = "m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5";

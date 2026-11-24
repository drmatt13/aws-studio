import { DEPLOYMENT_BADGES, deploymentBadgeCss, type Availability, type DeploymentBadgeKind } from "../deployment";
import type { Mode } from "../../shared/model";
import { cx } from "../ui/classes";
import { environmentStyle } from "./map-styles";
import type { ReactNode } from "react";
import { EnvironmentDetails } from "./EnvironmentDetails";

const environmentPillClasses =
  "inline-flex items-center gap-[5px] rounded-full border px-[9px] py-px font-semibold leading-[1.5] whitespace-nowrap before:box-border before:size-1.5 before:flex-none before:rounded-full before:content-[''] group-data-[map-tooltip]:min-h-5.5 group-data-[map-tooltip]:py-0.5";
function pillClasses(enabled: boolean) {
  // An unlit pill keeps a visible outline on the light sheet; the dark sheet and map cards keep their own.
  return cx(
    environmentPillClasses,
    enabled
      ? "border-transparent bg-(--badge-bg) text-(--badge-fg) before:bg-current"
      : "border-[light-dark(var(--rule-strong),rgb(255_255_255/.08))] bg-[light-dark(transparent,rgb(255_255_255/.03))] text-graphite before:border before:border-current group-data-[map-tooltip]:border-map-edge group-data-[map-tooltip]:bg-map-hover group-data-[map-tooltip]:text-map-muted",
  );
}

/** A required value missing in that environment: unlit, in the refusal color. */
const attentionPillClasses = cx(
  environmentPillClasses,
  "border-refuse bg-refuse-wash text-refuse before:border before:border-current",
);

/** Show both environments by default so availability stays explicit. */
export function EnvironmentPills({
  availability,
  attention,
  descriptions,
  interactive = false,
  note,
  details,
  enabledOnly = false,
  unavailableDescription = "not enabled",
  onToggle,
  disabled,
  className,
  label = "Deployment environments",
}: {
  readonly availability: Availability;
  /** Environments that need a value; takes precedence over availability. */
  readonly attention?: Readonly<Partial<Record<Mode, boolean>>>;
  readonly descriptions?: Readonly<Partial<Record<Mode, string>>>;
  readonly interactive?: boolean;
  readonly note?: string;
  readonly details?: ReactNode;
  /** Show only assigned environments in additive summaries such as profile rows. */
  readonly enabledOnly?: boolean;
  readonly unavailableDescription?: string | Readonly<Partial<Record<Mode, string>>>;
  readonly onToggle?: (mode: Mode) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly label?: string;
}) {
  const unavailable = (mode: Mode) =>
    typeof unavailableDescription === "string" ? unavailableDescription : (unavailableDescription[mode] ?? "not enabled");
  const summary = (mode: Mode) => attention?.[mode] ? (descriptions?.[mode] ?? "Needs attention") : availability[mode] ? (descriptions?.[mode] ?? "Enabled") : unavailable(mode);
  const description = (mode: Mode) => `${mode === "dev" ? "Development" : "Production"} · ${summary(mode)}`;
  return (
    <span
      data-ui="environment-pills"
      data-slot="environment-pills"
      className={cx("inline-flex flex-nowrap items-center gap-1 text-meta font-normal", className)}
      role={onToggle ? "group" : undefined}
      aria-label={label}
    >
      {(["dev", "prod"] as const).filter((mode) => !enabledOnly || availability[mode]).map((mode) =>
        onToggle ? (
          <button
            key={mode}
            type="button"
            className={pillClasses(availability[mode])}
            style={environmentStyle(mode)}
            data-environment={mode}
            data-enabled={availability[mode]}
            disabled={disabled}
            aria-pressed={availability[mode]}
            aria-label={`${label} in ${mode === "dev" ? "Development" : "Production"}`}
            title={`${availability[mode] ? "Included" : "Omitted"} in ${mode === "dev" ? "Development" : "Production"} · click to toggle`}
            onClick={() => onToggle(mode)}
          >
            {mode === "dev" ? "Dev" : "Prod"}
          </button>
        ) : interactive ? (
          <EnvironmentDetails
            key={mode}
            className="inline-flex cursor-pointer items-center rounded-full border-0 bg-transparent p-0 [@media(pointer:coarse)]:min-h-11"
            style={environmentStyle(mode)}
            data-environment={mode}
            data-enabled={availability[mode]}
            data-attention={attention?.[mode] || undefined}
            description={description(mode)}
            heading={mode === "dev" ? "Dev" : "Prod"}
            summary={summary(mode)}
            note={note}
            details={details}
          >
            <span aria-hidden className={attention?.[mode] ? attentionPillClasses : pillClasses(availability[mode])}>
              {mode === "dev" ? "Dev" : "Prod"}
            </span>
          </EnvironmentDetails>
        ) : (
          <span
            key={mode}
            className={attention?.[mode] ? attentionPillClasses : pillClasses(availability[mode])}
            style={environmentStyle(mode)}
            title={description(mode)}
            data-environment={mode}
            data-enabled={availability[mode]}
            data-attention={attention?.[mode] || undefined}
          >
            {mode === "dev" ? "Dev" : "Prod"}
            <span className="sr-only">
              :{" "}
              {availability[mode]
                ? (descriptions?.[mode] ?? "Enabled")
                : unavailable(mode)}
            </span>
          </span>
        ),
      )}
    </span>
  );
}

export function DeploymentBadge({ kind }: { readonly kind: DeploymentBadgeKind | undefined }) {
  if (!kind) return null;
  const badge = DEPLOYMENT_BADGES[kind];
  const colors = deploymentBadgeCss(kind);
  return (
    <span
      data-ui="deployment-badge"
      data-environment={kind}
      title={badge.description}
      aria-label={badge.description}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-[color-mix(in_srgb,currentColor_28%,transparent)] px-[5px] py-[2px] text-micro leading-none font-semibold tracking-[0.04em] whitespace-nowrap uppercase"
      style={{ color: colors.color, backgroundColor: colors.background }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {badge.paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      <span>{badge.label}</span>
    </span>
  );
}

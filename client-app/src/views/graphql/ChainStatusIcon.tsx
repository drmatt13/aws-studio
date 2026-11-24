import { Check, CircleDashed, CircleHelp, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { ChainStatus, ChainStatusShape, ChainStatusTone } from "../../graphql-chain";
import { cx } from "../../ui/classes";
import { toneClasses } from "../deploy/activity-model";

const icons = {
  passed: Check,
  failed: X,
  attention: TriangleAlert,
  pending: CircleDashed,
  unknown: CircleHelp,
  checking: LoaderCircle,
} as const;

/**
 * GraphQL status shapes, drawn like Activity's JobGlyph: success is a check, failure a cross,
 * anything to look at a warning triangle. The words beside it carry the meaning too.
 */
export function ChainStatusIcon({ shape, tone, size = 14, className }: {
  readonly shape: ChainStatusShape;
  readonly tone: ChainStatusTone;
  readonly size?: number;
  readonly className?: string;
}) {
  const Icon = icons[shape];
  return <Icon size={size} aria-hidden data-status-shape={shape} className={cx("flex-none", toneClasses[tone], shape === "checking" && "animate-spin motion-reduce:animate-none", className)} />;
}

/** A status's icon and words in its tone. */
export function ChainStatusLabel({ status, className }: { readonly status: ChainStatus; readonly className?: string }) {
  return <span className={cx("inline-flex min-w-0 items-center gap-1.5", toneClasses[status.tone], className)}>
    <ChainStatusIcon shape={status.shape} tone={status.tone} />
    <span className="min-w-0">{status.label}</span>
  </span>;
}

import { LockKeyhole, TriangleAlert } from "lucide-react";
import type { ModelResource } from "../../shared/model";
import { cx } from "../ui/classes";
import { ownershipOf, ownershipReason } from "../../shared/framework-management";
import { titleOf } from "../lookup";
import { resourceIssues, type EntityIssue } from "../issues";
import { useStudio } from "../studio";
import { IssueGlyph } from "./IssueNotice";

type StatusPlacement = "header" | "inline";

/** Badge spacing belongs here, including consecutive header badges. Data attributes identify states
 * for browser tests; no parent selector controls this component's appearance. */
function resourceStatusClasses(placement: StatusPlacement | "map" | "adjacent", stacked = false, compact = false) {
  return cx(
    "flex w-fit items-center rounded-[5px] border border-current leading-[1.4]",
    compact ? "gap-1 px-1.5 py-0.5 text-micro" : "gap-1.5 px-[7px] py-1 text-meta",
    placement === "header"
      ? cx(stacked ? "-mt-1" : "mt-2.5", "mb-2.5 last:mb-0")
      : placement === "map" || placement === "adjacent"
        ? "m-0"
        : "mt-0 mb-2",
  );
}
/** Error and warning chip colours; issue chips and input-group entry rows share them. */
export const issueChipClasses = {
  error: "bg-[light-dark(var(--refuse-wash),#ef444410)] text-[light-dark(var(--refuse),#f87171)]",
  warning: "bg-[light-dark(var(--caution-wash),#e7ac4410)] text-[light-dark(var(--caution),#f0b96b)]",
} as const;

/** Compact issue chips for lists such as island entries; an inspector header shows `IssueNotice` instead. */
export function IssueChips({
  issues,
  placement = "header",
  stacked = false,
}: {
  readonly issues: readonly EntityIssue[];
  readonly placement?: StatusPlacement;
  /** A status chip precedes the first one. */
  readonly stacked?: boolean;
}) {
  return (
    <>
      {issues.map((issue, at) => (
        <p
          key={issue.title}
          data-resource-status={issue.severity}
          className={cx(resourceStatusClasses(placement, stacked || at > 0), issueChipClasses[issue.severity])}
        >
          <IssueGlyph issue={issue} />
          {issue.title}
        </p>
      ))}
    </>
  );
}

export function FrameworkManagedStatus({
  as: Tag = "p",
  title,
  placement = "header",
  appearance = "default",
  density = "regular",
  className,
}: {
  readonly as?: "p" | "span";
  readonly title?: string;
  readonly placement?: StatusPlacement | "adjacent";
  readonly appearance?: "default" | "map";
  readonly density?: "regular" | "compact";
  readonly className?: string;
} = {}) {
  return (
    <Tag
      data-resource-status="managed"
      title={title}
      className={cx(
        resourceStatusClasses(appearance === "map" ? "map" : placement, false, density === "compact"),
        "bg-info-wash text-dev",
        className,
      )}
    >
      <LockKeyhole size={density === "compact" ? 12 : 14} aria-hidden />
      Framework managed
    </Tag>
  );
}

/** Shown only when the ownership declarations disagree. */
export function OwnershipConflictStatus({
  as: Tag = "p",
  title,
  placement = "header",
  appearance = "default",
  density = "regular",
  stacked = false,
}: {
  readonly as?: "p" | "span";
  readonly title?: string;
  readonly placement?: StatusPlacement | "adjacent";
  readonly appearance?: "default" | "map";
  readonly density?: "regular" | "compact";
  readonly stacked?: boolean;
} = {}) {
  return (
    <Tag
      data-resource-status="ownership-conflict"
      title={title}
      className={cx(resourceStatusClasses(appearance === "map" ? "map" : placement, stacked, density === "compact"), issueChipClasses.warning)}
    >
      <TriangleAlert size={density === "compact" ? 12 : 14} aria-hidden />
      Conflicting ownership declarations
    </Tag>
  );
}

/** The server projection supplies the ownership badge and its explanation. */
export function OwnershipStatus({
  entity,
  placement = "header",
  ...props
}: {
  readonly entity: string;
  readonly placement?: StatusPlacement | "adjacent";
  readonly as?: "p" | "span";
  readonly density?: "regular" | "compact";
  readonly appearance?: "default" | "map";
}) {
  const { index } = useStudio();
  const facts = ownershipOf(index, entity);
  const title = ownershipReason(facts, (id) => titleOf(index, id));
  return (
    <>
      {facts.managedBy === "framework" ? <FrameworkManagedStatus {...props} placement={placement} title={title} /> : null}
      {facts.basis === "conflict" ? <OwnershipConflictStatus {...props} placement={placement} title={title} stacked /> : null}
    </>
  );
}

/** Ownership and issue status chips. `issues={false}` leaves issues to the header's `IssueNotice`. */
export function ResourceStatus({
  resource,
  placement = "header",
  issues: showIssues = true,
}: {
  resource?: ModelResource;
  placement?: StatusPlacement;
  issues?: boolean;
}) {
  const { index } = useStudio();
  if (!resource) return null;
  const facts = ownershipOf(index, resource.id);
  const hasOwnershipBadge = facts.managedBy === "framework" || facts.basis === "conflict";
  const issues = showIssues ? resourceIssues(resource, index.resources.values()) : [];
  return (
    <>
      <OwnershipStatus entity={resource.id} placement={placement} />
      <IssueChips issues={issues} placement={placement} stacked={hasOwnershipBadge} />
    </>
  );
}

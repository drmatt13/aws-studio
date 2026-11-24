import type { ComponentPropsWithRef } from "react";
import type { LucideIcon } from "lucide-react";
import { cardClasses, pageToolbarClasses } from "../ui/Surface";
import { cx } from "../ui/classes";

/** Reading cards shared by document pages. Native dialogs keep their own margins. */
export function documentCardClasses(className?: string) {
  return cardClasses({
    variant: "document",
    className: cx("[&>:not(dialog)]:my-0 [&>:not(dialog):not(:first-child)]:mt-3", className),
  });
}
export function DocumentCard({ className, ...props }: ComponentPropsWithRef<"section">) {
  return <section {...props} data-ui="document-card" className={documentCardClasses(className)} />;
}
export const documentLabelClasses =
  "mb-3 flex min-w-0 flex-col gap-1 text-label has-[>input[type=checkbox]]:flex-row has-[>input[type=checkbox]]:items-start has-[>input[type=checkbox]]:gap-2";
export const documentSwitchLabelClasses =
  "mt-0 mb-3 flex min-w-0 items-center gap-2 text-label";
export const documentTitleClasses = "m-0 font-sans text-step0 font-semibold leading-[1.4]";
/**
 * A card's own title: the 15px role on a 32px row, the geometry WorkbenchPageHeader and
 * whole-card disclosures use, so titles in a stack sit level whether or not a card has an action.
 * Block-level `align-content` centres it without turning inline code or links into flex items.
 */
export const documentCardTitleClasses = cx(documentTitleClasses, "min-h-8 content-center");
export const documentSubheadingClasses = "m-0 font-sans text-label font-semibold leading-[1.5]";
export const documentProseClasses = "m-0 text-body leading-[1.5]";
export const documentSupportClasses = "m-0 text-caption leading-[1.5] text-graphite";
/** Native markers and keyboard activation stay with summary; its target is at least 32px. */
export const documentSummaryClasses =
  "min-h-8 cursor-pointer py-1 font-sans text-label font-semibold leading-6";
export const documentDisclosureClasses = "mt-3 min-w-0 [&[open]>:not(summary)]:mt-3";
export const documentFieldsetClasses =
  "mx-0 my-3 min-w-0 rounded-md border border-rule p-3 [&>:last-child]:mb-0";
export const documentTableRegionClasses = "my-2 max-w-full overflow-x-auto";
/** Preserve readable columns on phones; the named, focusable region owns scrolling. */
export const documentDataTableClasses =
  "table w-full min-w-[720px] table-fixed border-collapse [&_thead_th]:whitespace-nowrap";
/** Column and row headers take the 600 heading weight; a bare `th` would fall back to bold. */
export const documentTableHeadClasses =
  "border-b border-rule bg-[light-dark(var(--field),transparent)] p-2 text-left align-top text-caption font-semibold";
export const documentTableCellClasses = "border-b border-rule p-2 text-left align-top text-caption";
export const documentToolbarClasses = "flex flex-wrap items-end gap-2";
export const documentToolbarFieldClasses =
  "m-0 flex min-w-0 flex-[1_1_180px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_100%]";
export const documentSearchFieldClasses =
  "m-0 flex min-w-0 flex-[0_1_480px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_100%]";
export const documentToolbarActionClasses = "max-w-full flex-none vp-720:w-full";
export const inspectionControlClasses = "flex flex-wrap items-end gap-2";
export const inspectionFieldClasses =
  "m-0 flex min-w-0 max-w-80 flex-[1_1_160px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_140px]";
export const inspectionRegionFieldClasses =
  "m-0 flex min-w-0 max-w-45 flex-[1_1_160px] flex-col gap-1 text-label vp-720:max-w-none vp-720:flex-[1_1_140px]";
export const inspectionActionClasses = "flex-none vp-720:flex-[1_1_100%]";
/** Shared document column, including Database's pages other than Schema. */
export const pageWidthClasses = "mx-auto w-full min-w-0 max-w-(--workspace-page-max) px-(--workspace-gutter)";
/** A document page's content: the column plus the rhythm below its toolbar. */
export const pageBodyClasses = cx(pageWidthClasses, "pt-4 pb-6");
export const pageTitleClasses = "m-0 font-sans text-step1 font-semibold leading-[1.3]";
/**
 * A page title's leading glyph: the same icon as the tab or link that opened the page,
 * at the title's 18px size and quieter than its words. The title names the page alone.
 */
export function PageTitleIcon({ icon: Icon }: { readonly icon: LucideIcon }) {
  return <Icon size={18} aria-hidden className="shrink-0 text-graphite" />;
}
/**
 * A plain header sits where a section strip's content would start: 16px below the navbar,
 * and the page body's own top padding puts its first block 16px below, at every width.
 */
const plainPageHeaderClasses = "pt-4 text-label text-ink";
export function PageToolbar({ appearance = "toolbar", className, ...props }: ComponentPropsWithRef<"div"> & { readonly appearance?: "toolbar" | "plain" }) {
  return (
    <header className={cx(appearance === "plain" ? plainPageHeaderClasses : pageToolbarClasses, "flex items-center")}>
      <div {...props} className={cx(pageWidthClasses, className)} />
    </header>
  );
}

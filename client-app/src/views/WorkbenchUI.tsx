import { cardClasses, noticeClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import {
  dialogClasses,
  dialogHeaderClasses,
  dialogTitleClasses,
  dialogBodyClasses,
  dialogFooterClasses,
} from "../inspector-ui";
import { iconButtonClasses } from "../ui/IconButton";
import { sourceDiff } from "../../shared/source-diff";
import { X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode, type Ref } from "react";
import {
  documentCardClasses,
  documentSupportClasses,
  documentTitleClasses,
  PageTitleIcon,
  pageTitleClasses,
} from "./DocumentUI";

/*
 * Database pages share the document column, type roles (DocumentUI) and card geometry.
 * Schema keeps its full-width editor. These recipes cover only what
 * documents lack: the page rhythm, evidence blocks, empty states and list choices.
 */
/** The column below the Database tabs: header, notices, cards and sections 16px apart. */
export const workbenchPageClasses = "grid min-w-0 content-start gap-4";
/** A reading card: 6px corners, 16px padding (12px at 720px) and 12px between groups. */
export const workbenchCardClasses = documentCardClasses();
/** A card laid out by its caller (rows, splits); it does not apply flow spacing. */
export function workbenchPanelClasses(className: string): string {
  return cardClasses({ variant: "document", className });
}
export const workbenchCodeClasses = "text-meta wrap-anywhere";
export const workbenchPreClasses =
  "m-0 max-h-110 overflow-auto rounded-md border border-rule bg-paper p-3 text-meta";
/** Evidence, limits and metadata disclosed inside a card: quieter than a section summary. */
export const workbenchDetailSummaryClasses =
  "min-h-8 cursor-pointer py-1 text-caption leading-6 text-graphite hover:text-ink";
/** A disclosure nested in a card; its revealed children sit 8px apart. */
export const workbenchDetailClasses = "min-w-0 [&>:not(summary)]:mt-2";
/** Nothing loaded, selected or created yet. Title (optional) and support text sit 4px apart. */
export const workbenchEmptyClasses =
  "m-0 grid min-w-0 content-start gap-1 rounded-md border border-dashed border-rule-strong p-6 text-label text-graphite vp-720:p-4";
/** A catalog beside its selection: migrations, saved commands. */
export const workbenchMasterDetailClasses =
  "grid min-w-0 grid-cols-[288px_minmax(0,1fr)] items-start gap-4 vp-850:grid-cols-1";
const choiceTreatment =
  "min-w-0 cursor-pointer rounded-md border border-transparent bg-transparent text-left font-sans text-ink hover:bg-wash aria-pressed:border-[light-dark(var(--selected-rule),var(--rule))] aria-pressed:bg-selected aria-pressed:text-selected-ink disabled:cursor-not-allowed disabled:opacity-45";
/** One choice in a catalog card; the restrained selected treatment Database navigation uses. */
export const workbenchChoiceClasses = cx("grid gap-1 p-3", choiceTreatment);
/** A one-line choice in a long catalog (GraphQL types and documents): same treatment, 32px rows. */
export const workbenchCompactChoiceClasses = cx("flex min-h-8 items-center px-3 py-1", choiceTreatment);
/** Key/value evidence rows: label column, then value, collapsing at 700px. */
export const workbenchFactRowClasses =
  "grid grid-cols-[220px_minmax(0,1fr)] gap-4 border-t border-rule py-2 text-caption vp-700:grid-cols-1 vp-700:gap-1";

/** A few mutually exclusive views of one subject: Database's editing layout, GraphQL's Fields/SDL. */
export const workbenchSegmentGroupClasses =
  "flex shrink-0 items-center gap-[2px] rounded-md border border-rule bg-paper p-[2px]";
/** One segment; `aria-pressed` marks the current view. Icon segments are square, text ones pad. */
export function workbenchSegmentClasses(content: "icon" | "text"): string {
  return cx(
    "inline-flex h-[26px] min-h-[26px] cursor-pointer items-center justify-center rounded-md border border-transparent bg-transparent text-graphite hover:bg-wash hover:text-ink aria-pressed:border-selected-rule aria-pressed:bg-selected aria-pressed:text-selected-ink",
    content === "icon" ? "w-7 p-0" : "px-2.5 py-0 font-sans text-caption leading-[1.5] font-medium",
  );
}

export function workbenchNoticeClasses(tone: "neutral" | "warning" = "neutral"): string {
  return noticeClasses({ tone, className: "group-[:fullscreen]/workbench:shrink-0" });
}

/**
 * Every Database page except Schema, each GraphQL section and its chain, and each Cognito
 * section opens with this.
 */
export function WorkbenchPageHeader({
  icon,
  title,
  titleId,
  titleRef,
  description,
  actions,
}: {
  /** The icon of the tab that opened this section; decorative, 8px before the title. */
  readonly icon?: LucideIcon;
  readonly title: ReactNode;
  /** For a region labelled by this header. */
  readonly titleId?: string;
  /** Lets a section move focus to its title after navigation; the title is then programmatically focusable. */
  readonly titleRef?: Ref<HTMLHeadingElement>;
  readonly description: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <header
      data-ui="workbench-content-heading"
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3"
    >
      <div className="grid min-w-0 max-w-3xl gap-1">
        <h2
          id={titleId}
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className={cx(pageTitleClasses, "flex min-h-8 items-center gap-2", titleRef && "focus:outline-none")}
        >
          {icon ? <PageTitleIcon icon={icon} /> : null}
          <span className="min-w-0">{title}</span>
        </h2>
        <p className={documentSupportClasses}>{description}</p>
      </div>
      {actions ? (
        <div data-ui="workbench-actions" className="flex min-w-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/**
 * A status card's lead: what was checked, then its state in the card-title role. A
 * readiness card's state is its heading and its one live region; evidence cards pass
 * `live={false}`, keeping the subject as their heading and the state as text.
 */
export function WorkbenchStatusHeading({
  subject,
  status,
  tone = "neutral",
  live = true,
}: {
  readonly subject: ReactNode;
  readonly status: ReactNode;
  readonly tone?: "neutral" | "accept" | "caution";
  readonly live?: boolean;
}) {
  const Subject = live ? "p" : "h3";
  const State = live ? "h3" : "p";
  return (
    <div className="grid min-w-0 gap-1">
      <Subject className={cx(documentSupportClasses, "font-medium")}>{subject}</Subject>
      <State
        role={live ? "status" : undefined}
        className={cx(
          documentTitleClasses,
          "flex items-center gap-2",
          tone === "accept" && "text-accept",
          tone === "caution" && "text-caution",
        )}
      >
        {status}
      </State>
    </div>
  );
}

/** A whole-card disclosure's summary: the 15px card-title role on a 32px target. */
export const workbenchCardSummaryClasses =
  "min-h-8 cursor-pointer py-1 font-sans text-step0 font-semibold leading-6";

/** A heading above a card's list, aligned with the text of the choices below it. */
export function WorkbenchListHeading({
  children,
  count,
}: {
  readonly children: ReactNode;
  readonly count: number;
}) {
  return (
    <h3 className="m-0 flex items-baseline gap-2 px-3 font-sans text-label font-semibold leading-[1.5]">
      {children}
      <span className="font-normal text-graphite">{count}</span>
    </h3>
  );
}

export function WorkbenchDialog({
  title,
  children,
  footer,
  onClose,
  busy = false,
  className = "",
  id,
  size = "wide",
  titleClassName = dialogTitleClasses,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  readonly busy?: boolean;
  readonly className?: string;
  readonly id?: string;
  readonly size?: "wide" | "help";
  readonly titleClassName?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) {
      body.current.scrollTop = 0;
      body.current.scrollLeft = 0;
    }
  }, [title]);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      data-inspector-context
      ref={dialog}
      id={id}
      data-ui="preview workbench-dialog"
      className={dialogClasses({ size, className })}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className={cx(dialogHeaderClasses, "flex items-center justify-between")}>
        <h2 className={titleClassName}>{title}</h2>
        <button
          type="button"
          className={iconButtonClasses()}
          aria-label={`Close ${title}`}
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div
        ref={body}
        data-ui="body"
        className={cx(dialogBodyClasses, "min-w-0 grid-cols-[minmax(0,1fr)] wrap-anywhere")}
      >
        {children}
      </div>
      <footer className={dialogFooterClasses}>{footer}</footer>
    </dialog>
  );
}

export function SourceComparison({
  before,
  after,
  beforeLabel = "Saved source",
  afterLabel = "Proposed source",
}: {
  readonly before: string;
  readonly after: string;
  readonly beforeLabel?: string;
  readonly afterLabel?: string;
}) {
  const oldLines = before.split("\n"),
    newLines = after.split("\n");
  const changes = sourceDiff("source", before, after, 0).lines;
  const removed = new Set(
    changes.filter((line) => line.kind === "remove").map((line) => line.oldLine),
  );
  const added = new Set(changes.filter((line) => line.kind === "add").map((line) => line.newLine));
  return (
    <div
      data-ui="workbench-source-comparison"
      className="grid grid-cols-2 gap-3 vp-850:grid-cols-1"
    >
      {[
        { lines: oldLines, label: beforeLabel, kind: "remove" },
        { lines: newLines, label: afterLabel, kind: "add" },
      ].map(({ lines, label, kind }) => (
        <section key={label} className="min-w-0">
          <h3 className="mt-0 mb-2 text-caption font-semibold">{label}</h3>
          <pre
            aria-label={label}
            className="m-0 min-w-0 max-h-[52vh] max-w-full overflow-auto border border-rule px-0 py-2.5 text-meta"
          >
            {lines.map((line, index) => (
              <span
                key={index}
                className={cx(
                  "block h-[1.7em] w-max min-w-full leading-[1.7] whitespace-pre",
                  (kind === "remove" ? removed : added).has(index + 1) &&
                    (kind === "remove" ? "bg-removed" : "bg-added"),
                )}
              >
                <span
                  data-ui="line-number"
                  className="mr-3 inline-block w-[4ch] text-right text-graphite select-none"
                  aria-hidden
                >
                  {index + 1}
                </span>
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

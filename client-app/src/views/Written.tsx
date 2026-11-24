import { cx } from "../ui/classes";
import { ExternalLink } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { SourceLocation } from "../../shared/model";
import { inspectorFactCodeClasses } from "../inspector-ui";
import { editorLink } from "../lookup";
import { useStudio } from "../studio";
import { Identifier, InspectorFact, InspectorFacts } from "./InspectorUI";

type Placement = "body" | "header" | "evidence" | "row";

export interface SourceLine {
  readonly location: SourceLocation | undefined;
  readonly label?: string;
}

/**
 * A header fact that opens a file in the editor. The file leads in the ink colour; its external
 * mark recedes until the link is hovered. It keeps the panel's caption target.
 */
export function EditorFactLink({
  href,
  title,
  "aria-label": label,
  children,
}: {
  readonly href: string;
  readonly title: string;
  readonly "aria-label"?: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={href}
      className="group/source inline-flex min-h-[var(--panel-caption-target,24px)] min-w-0 max-w-full items-center gap-1.5 text-ink no-underline hover:underline coarse:min-h-11"
      aria-label={label}
      title={title}
    >
      <code className={inspectorFactCodeClasses}>{children}</code>
      <ExternalLink
        size={12}
        className="shrink-0 text-graphite group-hover/source:text-ink"
        aria-hidden
      />
    </a>
  );
}

/**
 * Where something is written. Lines share one label column, so their files align and read as one list.
 * Each line keeps the 24 px caption target, so lines sit on a 24 px pitch with no extra gap. In a
 * header the lines are facts (`InspectorFacts`): they take the header's fixed label column, the file
 * leads in the ink colour and its line number recedes. `row` places the lines inside a list row's
 * metadata, which supplies its own rhythm.
 */
export function SourceLines({
  lines,
  placement = "body",
  className,
}: {
  readonly lines: readonly SourceLine[];
  readonly placement?: Placement;
  readonly className?: string;
}) {
  const { snapshot } = useStudio();
  const located = lines.filter(
    (line): line is SourceLine & { readonly location: SourceLocation } =>
      !!line.location,
  );
  if (!located.length)
    return (
      <p
        className={cx(
          "text-caption text-graphite",
          // A header keeps the row a located source line would have taken.
          placement === "header"
            ? "m-0 flex min-h-6 items-center"
            : placement === "row"
              ? "m-0"
              : "mt-0 mb-2",
          className,
        )}
      >
        Its declaration could not be located in source.
      </p>
    );
  if (placement === "header")
    return (
      <InspectorFacts data-ui="written" className={className}>
        {located.map(({ location, label }) => {
          const name = location.file.split("/").at(-1)!;
          // A long file name wraps between its words; its extension and line number stay with the last one.
          const extension = name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")) : "";
          return (
            <InspectorFact key={`${label}:${location.file}:${location.line}`} label={label ?? "Source"}>
              <EditorFactLink
                href={editorLink(snapshot.repositoryRoot, location)}
                aria-label={`Open ${location.file}:${location.line} in VS Code`}
                title={`${location.file}:${location.line}`}
              >
                <Identifier>{name.slice(0, name.length - extension.length)}</Identifier>
                {extension}
                <span className="text-graphite">:{location.line}</span>
              </EditorFactLink>
            </InspectorFact>
          );
        })}
      </InspectorFacts>
    );
  return (
    <dl
      data-ui="written"
      className={cx(
        "grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-2 gap-y-0 text-meta text-graphite",
        placement === "row"
          ? "m-0"
          : placement === "evidence"
            ? "mt-0 mb-0.75"
            : "mt-2 mb-3",
        className,
      )}
    >
      {located.map(({ location, label }) => (
        <Fragment key={`${label}:${location.file}:${location.line}`}>
          <dt>{label ?? "Source"}</dt>
          <dd className="m-0 min-w-0">
            <a
              href={editorLink(snapshot.repositoryRoot, location)}
              className="inline-flex min-h-[var(--panel-caption-target,24px)] min-w-0 max-w-full items-center gap-1 text-caption text-graphite no-underline hover:text-ink hover:underline coarse:min-h-11"
              aria-label={`Open ${location.file}:${location.line} in VS Code`}
              title={`${location.file}:${location.line}`}
            >
              <code className="min-w-0 text-meta wrap-anywhere">
                {location.file.split("/").at(-1)}:{location.line}
              </code>{" "}
              <ExternalLink size={12} className="shrink-0" aria-hidden />
            </a>
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Written(props: {
  readonly location: SourceLocation | undefined;
  readonly label?: string;
  readonly placement?: Placement;
  readonly className?: string;
}) {
  return (
    <SourceLines
      lines={[props]}
      placement={props.placement}
      className={props.className}
    />
  );
}

import { TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cx } from "../ui/classes";
import { pickerOptionClasses } from "../inspector-ui";
import { ArrowRight, ChevronRight, Search } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { iconUrl, type IconKey } from "../icons";

export interface ConfiguredResourceOption {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: IconKey;
  readonly reason?: string;
  readonly searchTerms?: string;
  readonly group?: string;
  /** A compatible destination may still have a deployment problem. */
  readonly warning?: string;
  readonly parent?: string;
  readonly browseOnly?: boolean;
}

/** Search the application's configured resources without leaving the owning editor. */
export function ConfiguredResourcePicker({
  label,
  options,
  onChoose,
  onCancel,
  disabled,
  onInspect,
}: {
  readonly label: string;
  readonly options: readonly ConfiguredResourceOption[];
  readonly onChoose: (id: string) => void;
  readonly onCancel: () => void;
  readonly disabled?: boolean;
  readonly onInspect?: (id: string) => void;
}) {
  const prefix = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collapsedSearch, setCollapsedSearch] = useState<ReadonlySet<string>>(new Set());
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const byId = new Map(options.map(option => [option.id, option]));
  const parentOf = (option: ConfiguredResourceOption) => option.parent && option.parent !== option.id && byId.get(option.parent)?.browseOnly ? option.parent : undefined;
  const children = (id?: string) => options.filter(option => parentOf(option) === id);
  const included = new Set<string>();
  for (const option of options) {
    const ancestry: ConfiguredResourceOption[] = [], seen = new Set<string>();
    let current: ConfiguredResourceOption | undefined = option;
    while (current && !seen.has(current.id)) {
      ancestry.push(current); seen.add(current.id);
      const parent = parentOf(current);
      current = parent ? byId.get(parent) : undefined;
    }
    const text = ancestry.map(item => `${item.id} ${item.title} ${item.subtitle} ${item.group ?? ""} ${item.searchTerms ?? ""}`).join(" ").toLowerCase();
    if (words.every(word => text.includes(word))) for (const item of ancestry) included.add(item.id);
  }
  const isExpanded = (id: string) => words.length ? !collapsedSearch.has(id) : expanded.has(id);
  const setOpen = (id: string, open: boolean) => {
    if (words.length) setCollapsedSearch(previous => { const next = new Set(previous); if (open) next.delete(id); else next.add(id); return next; });
    else setExpanded(previous => { const next = new Set(previous); if (open) next.add(id); else next.delete(id); return next; });
  };
  const matches: ConfiguredResourceOption[] = [];
  const collect = (parent?: string) => {
    for (const option of children(parent)) if (included.has(option.id)) {
      matches.push(option);
      if (option.browseOnly && isExpanded(option.id)) collect(option.id);
    }
  };
  collect();
  const resourceCount = options.filter(option => included.has(option.id) && !option.browseOnly).length;
  const focused = matches.some((option) => option.id === active) ? active : matches[0]?.id;

  useEffect(() => {
    if (!disabled) search.current?.focus();
  }, [disabled]);

  const focusResult = (index: number) => {
    const option = matches[index];
    const button = root.current?.querySelectorAll<HTMLButtonElement>("[data-slot=endpoint-option]")[
      index
    ];
    if (option && button) {
      setActive(option.id);
      button.focus();
    }
  };

  return (
    <div
      ref={root}
      className="min-w-0"
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      data-slot="endpoint-picker"
    >
      <div
        className="mt-2 border border-rule-strong rounded-md p-2 bg-paper"
        data-slot="endpoint-dropdown"
      >
        <div className="relative flex items-center gap-2" data-slot="endpoint-search">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute left-2.5 text-graphite"
          />
          <TextInput
            className="w-full pl-8"
            ref={search}
            type="search"
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder="Find a resource or service…"
            value={query}
            disabled={disabled}
            aria-controls={`${prefix}-results`}
            onChange={(event) => {
              setQuery(event.target.value);
              setCollapsedSearch(new Set());
              setActive("");
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                event.stopPropagation();
                focusResult(event.key === "ArrowDown" ? 0 : matches.length - 1);
              }
            }}
          />
        </div>
        <div
          className="flex items-center justify-between gap-2 p-2"
          data-slot="endpoint-picker-status"
        >
          <span className="text-caption text-graphite" role="status">
            {resourceCount} {resourceCount === 1 ? "resource" : "resources"}
          </span>
          <button
            type="button"
            className={cx(
              buttonClasses({ variant: "link" }),
              "min-h-(--panel-caption-target) text-caption",
            )}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
        <ul
          id={`${prefix}-results`}
          className="m-0 max-h-[300px] list-none overflow-auto overscroll-contain p-[2px] scrollbar-thin scroll-p-1"
          aria-label={label}
          data-slot="endpoint-options"
        >
          {renderOptions()}
        </ul>
        {!matches.length ? (
          <p className="text-caption text-graphite my-3 mx-[2px]" data-slot="endpoint-no-results">
            {query.trim() ? `No resources match “${query.trim()}”.` : "No resources available."}
          </p>
        ) : null}
      </div>
    </div>
  );

  function renderOptions(parent?: string): ReactNode {
    return children(parent).filter(option => included.has(option.id)).map(option => {
      const index = matches.findIndex(item => item.id === option.id);
      const open = option.browseOnly && isExpanded(option.id);
      return <li key={option.id} className={cx("relative mt-0.5 first:mt-0", parent && "before:pointer-events-none before:absolute before:-left-4 before:top-[29px] before:w-4 before:border-t before:border-rule-strong after:pointer-events-none after:absolute after:-left-4 after:top-0 after:bottom-0 after:border-l after:border-rule-strong last:after:bottom-[calc(100%-29px)]")} data-slot={parent ? "endpoint-child" : undefined}>
              <button
                type="button"
                className={cx(pickerOptionClasses, "group")}
                tabIndex={focused === option.id ? 0 : -1}
                aria-label={`${option.title} · ${option.subtitle}`}
                id={`${prefix}-option-${index}`}
                aria-describedby={option.reason ? `${prefix}-reason-${index}` : undefined}
                aria-disabled={disabled || !!option.reason || undefined}
                aria-expanded={option.browseOnly ? !!open : undefined}
                aria-controls={option.browseOnly ? `${prefix}-children-${index}` : undefined}
                onFocus={() => setActive(option.id)}
                onClick={() => {
                  if (!disabled && !option.reason) {
                    if (option.browseOnly) setOpen(option.id, !open);
                    else onChoose(option.id);
                  }
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowDown"
                      ? Math.min(index + 1, matches.length - 1)
                      : event.key === "ArrowUp"
                        ? index - 1
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? matches.length - 1
                            : undefined;
                  if (next !== undefined) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (next < 0) search.current?.focus();
                    else focusResult(next);
                  } else if (event.key === "ArrowRight" && option.browseOnly) {
                    event.preventDefault(); event.stopPropagation();
                    if (open) focusResult(index + 1);
                    else setOpen(option.id, true);
                  } else if (event.key === "ArrowLeft" && (open || parent)) {
                    event.preventDefault(); event.stopPropagation();
                    if (open) setOpen(option.id, false);
                    else if (parent) focusResult(matches.findIndex(item => item.id === parent));
                  } else if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                }}
                data-slot="endpoint-option"
              >
                <img className="size-8 flex-none" src={iconUrl(option.icon)} alt="" aria-hidden />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="text-caption leading-[1.35] font-medium wrap-anywhere">
                    {option.title}
                  </strong>
                  <span className="text-caption text-graphite group-hover:text-ink">{option.subtitle}</span>
                  {option.warning ? <span className="text-caption text-local">{option.warning}</span> : null}
                  {option.reason ? (
                    <span id={`${prefix}-reason-${index}`} className="text-caption text-graphite">
                      {option.reason}
                    </span>
                  ) : null}
                </span>
                {!option.reason ? (
                  <span
                    className="grid size-[22px] flex-none place-items-center rounded-full text-graphite"
                    aria-hidden
                    data-slot="endpoint-option-mark"
                  >
                    {option.browseOnly ? <ChevronRight size={15} className={open ? "rotate-90" : undefined} /> : <ArrowRight size={15} />}
                  </span>
                ) : null}
              </button>
              {option.reason && onInspect ? <button type="button" className={cx(buttonClasses({ variant: "link" }), "ml-12 text-caption")} disabled={disabled} onClick={() => onInspect(option.id)}>Inspect resource</button> : null}
              {open ? <ul id={`${prefix}-children-${index}`} aria-labelledby={`${prefix}-option-${index}`} className="m-0 ml-6 list-none pl-4" data-slot="endpoint-children">{renderOptions(option.id)}</ul> : null}
            </li>;
    });
  }
}

import { workbenchNoticeClasses } from "./WorkbenchUI";
import { cx } from "../ui/classes";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { Info, Lock, Minus, Plus, Scan, Search, Table2, UsersRound, X } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DeclaredSchema, SchemaRelation, SchemaRelationAccess, SchemaTable } from "../../shared/database";
import type { SourceLocation } from "../../shared/model";
import { schemaLayout, TABLE_WIDTH } from "../schema-layout";
import { useSchemaViewport } from "../use-schema-viewport";
import { ACCESS_DESCRIPTIONS, ACCESS_LABELS, fieldProtections } from "aws-studio/database/client-access";
import { ACCESS_ICONS, ACCESS_TONES, FIELD_ACCESS_SHORTCUT } from "./access-presentation";


export interface SchemaSelection {
  readonly table: string;
  readonly field?: string;
  readonly relation?: string;
}

/** A projection of the current valid draft; this component never authors source. */
export function DatabaseDiagram({
  schema,
  source,
  selection,
  onSelect,
  onLocate,
  retained = false,
  onFieldAccess,
}: {
  readonly schema: DeclaredSchema;
  readonly source?: string;
  readonly selection?: SchemaSelection;
  readonly onSelect: (selection: SchemaSelection) => void;
  readonly onLocate: (source: SourceLocation) => void;
  readonly retained?: boolean;
  /** Ctrl/Cmd+. or right-click on a column: open field access for its source line. */
  readonly onFieldAccess?: (line: number, anchor: HTMLElement) => void;
}) {
  const fieldLabels = useMemo(() => {
    const labels = new Map<number, string>();
    if (!source) return labels;
    for (const item of fieldProtections(source)) {
      labels.set(item.line, item.reason === "access-link" ? "Access link" : "Server-set");
    }
    return labels;
  }, [schema, source]);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const [aspectRatio, setAspectRatio] = useState(1.5);
  const searching = Boolean(query.trim());
  const resizeLayout = useCallback((ratio: number) => {
    if (!searching) setAspectRatio(ratio);
  }, [searching]);
  const layout = useMemo(() => schemaLayout(schema, aspectRatio), [schema, aspectRatio]);
  const { viewport, camera, panning, handlers, zoomBy, frame, fit, zoomPercent, canZoomIn, canZoomOut } = useSchemaViewport({ x: 0, y: 0, width: layout.width, height: layout.height }, resizeLayout);
  const { zoom } = camera;
  const navigationId = useId();
  const detailsId = useId();
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const detailsPanel = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState({ left: 12, bottom: 12 });
  const positionDetails = () => {
    const rect = detailsTrigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(420, window.innerWidth - 24);
    setDetailsPosition({
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
      bottom: Math.max(12, Math.min(window.innerHeight - rect.top + 8, window.innerHeight - 192)),
    });
  };
  useLayoutEffect(() => {
    if (!detailsOpen) return;
    window.addEventListener("resize", positionDetails);
    window.addEventListener("scroll", positionDetails, true);
    return () => {
      window.removeEventListener("resize", positionDetails);
      window.removeEventListener("scroll", positionDetails, true);
    };
  }, [detailsOpen]);
  const selected = schema.tables.find((table) => table.id === selection?.table);
  const relation = schema.relations.find((item) => item.id === selection?.relation);
  const accessWord = (rule: SchemaRelationAccess) => `${rule.kind}${rule.filter ? `(${rule.filter})` : ""}`;
  const accessLabel = (edge: SchemaRelation, rule: SchemaRelationAccess) => {
    const table = schema.tables.find((table) => table.id === (rule.side === "from" ? edge.from : edge.to));
    return `${table?.model ?? (rule.side === "from" ? edge.from : edge.to)}.${rule.field} · ${accessWord(rule)}`;
  };
  const accessColor = (edge: SchemaRelation) => `var(--access-${edge.access?.some((rule) => rule.kind === "via") ? "via" : edge.access?.some((rule) => rule.kind === "members") ? "members" : "owner"})`;
  const accessKinds = (edge: SchemaRelation) => [...new Set(edge.access?.map((rule) => rule.kind))].join(" · ");
  /**
   * How people reach the selected table's rows: each access rule on a reached
   * table leads to the table its visibility comes from, until none is new.
   * Only those edges are drawn in their access colors; with nothing selected,
   * access edges stay neutral and the diagram reads as structure.
   */
  const accessPath = useMemo(() => {
    if (!selected) return undefined;
    const reached = new Set([selected.id]);
    const edges = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const edge of schema.relations) for (const rule of edge.access ?? []) {
        const near = rule.side === "from" ? edge.from : edge.to, far = rule.side === "from" ? edge.to : edge.from;
        if (!reached.has(near)) continue;
        if (!edges.has(edge.id)) { edges.add(edge.id); grew = true; }
        if (!reached.has(far)) { reached.add(far); grew = true; }
      }
    }
    return { reached, edges };
  }, [schema.relations, selected?.id]);
  const related = useMemo(() => new Set(
    schema.relations
      .filter((item) => item.from === selected?.id || item.to === selected?.id)
      .flatMap((item) => [item.from, item.to]),
  ), [schema.relations, selected?.id]);
  const searched = query.trim().toLowerCase();
  const matches = new Set(
    schema.tables
      .filter((table) =>
        `${table.model} ${table.table} ${table.columns.map((column) => `${column.name} ${column.column}`).join(" ")}`
          .toLowerCase()
          .includes(searched),
      )
      .map((table) => table.id),
  );
  useLayoutEffect(() => {
    if (!focus || !selected) return;
    const entry = layout.tables.find(({ table }) => table.id === selected.id);
    if (!entry) return;
    const horizontalPadding = TABLE_WIDTH * 0.45;
    const verticalPadding = entry.height * 0.45;
    frame({ x: entry.x - horizontalPadding, y: entry.y - verticalPadding,
      width: TABLE_WIDTH + horizontalPadding * 2, height: entry.height + verticalPadding * 2 }, 0.9);
    // Retain manual pan/zoom when selecting another field in the same table.
  }, [focus, selected, layout, frame]);
  const choose = (
    table: SchemaTable,
    field?: string,
    source = field ? table.columns.find((column) => column.name === field)?.source : table.source,
  ) => {
    onSelect({ table: table.id, field });
    if (source && !retained) onLocate(source);
  };
  return (
    <div data-ui="workbench-diagram" className="flex min-h-0 flex-1 flex-col">
      <div
        data-ui="workbench-pane-toolbar"
        className="flex flex-wrap items-center justify-between gap-[5px] border-b border-rule p-2"
      >
        <div
          data-ui="schema-search"
          className="flex min-w-0 max-w-full flex-[1_1_120px] items-center gap-2 rounded-md border border-[light-dark(var(--field-rule),var(--rule-strong))] bg-[light-dark(var(--field),var(--sheet))] px-2 focus-within:outline-2 focus-within:outline-prod focus-within:outline-offset-2"
        >
          <Search size={14} className="flex-none" aria-hidden />
          <input
            className="min-h-8 min-w-[40px] w-full border-0 bg-transparent px-0 py-1 text-caption text-ink outline-none placeholder:text-faint placeholder:opacity-100 [&::-webkit-search-cancel-button]:hidden"
            ref={search}
            type="search"
            aria-label="Find a table or column"
            placeholder="Find table or field…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
          {query ? (
            <button
              data-ui="icon-button"
              className={iconButtonClasses({
                variant: "quiet",
                size: "compact",
                className: "-mr-2",
              })}
              aria-label="Clear schema search"
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div
          data-ui="schema-zoom"
          className="flex shrink-0 items-center gap-[2px] text-caption"
          role="group"
          aria-label="Schema view controls"
        >
          <button
            data-ui="icon-button"
            className={iconButtonClasses({ size: "compact" })}
            aria-label="Zoom out"
            disabled={!canZoomOut}
            onClick={() => zoomBy(1 / 1.2)}
          >
            <Minus size={14} />
          </button>
          <button
            className={buttonClasses({ variant: "quiet", size: "custom", className: "min-h-7 min-w-[5ch] px-1 py-0.5 tabular-nums" })}
            aria-label="Reset schema view to 100%"
            title="100% shows the complete schema"
            onClick={fit}
          >{zoomPercent}%</button>
          <button
            data-ui="icon-button"
            className={iconButtonClasses({ size: "compact" })}
            aria-label="Zoom in"
            disabled={!canZoomIn}
            onClick={() => zoomBy(1.2)}
          >
            <Plus size={14} />
          </button>
          <button
            data-ui="icon-button"
            className={iconButtonClasses({ size: "compact" })}
            aria-label="Fit schema"
            title="Fit schema to view"
            onClick={fit}
          >
            <Scan size={14} />
          </button>
        </div>
      </div>
      {retained ? (
        <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="status">
          Last valid diagram · current draft has not passed validation. Source navigation is paused.
        </div>
      ) : null}
      {searched ? (
        <p
          data-ui="workbench-search-status"
          className="m-0 px-[10px] py-1 text-caption text-graphite"
          role="status"
        >
          {matches.size} matching tables · other tables remain in place
        </p>
      ) : null}
      <div
        data-ui="schema-viewport"
        className={cx("relative min-h-[160px] flex-1 touch-none overflow-clip overscroll-contain border-0 bg-[radial-gradient(circle,var(--rule)_1px,transparent_1px)] bg-paper bg-size-[20px_20px] select-none focus-visible:-outline-offset-[3px] [--schema-edge:light-dark(#78879b,color-mix(in_oklab,var(--graphite)_45%,transparent))]", panning ? "cursor-grabbing" : "cursor-grab")}
        style={{ backgroundPosition: `${camera.x}px ${camera.y}px` }}
        ref={viewport}
        tabIndex={0}
        aria-label="Database relationship diagram"
        aria-describedby={navigationId}
        {...handlers}
        onKeyDown={(event) => {
          handlers.onKeyDown?.(event);
          if (event.target !== event.currentTarget) return;
          if (event.key === "0") {
            event.preventDefault();
            fit();
          }
        }}
      >
        {schema.tables.length ? (
            <div
              data-ui="schema-stage"
              className="absolute top-0 left-0 origin-top-left"
              style={{ width: layout.width, height: layout.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})` }}
            >
              {layout.groups.map(group => (
                <div
                  key={group.id}
                  data-ui="schema-group"
                  className="pointer-events-none absolute rounded-xl border border-rule bg-[light-dark(var(--wash),color-mix(in_oklab,var(--sheet)_25%,transparent))]"
                  style={{ left: group.x, top: group.y, width: group.width, height: group.height }}
                >
                  <p className="m-0 flex h-[48px] items-center gap-3 px-[48px] text-[18px] text-graphite">
                    <strong className="min-w-0 truncate font-semibold" title={group.title}>{group.title}</strong>
                    <span className="shrink-0 text-[14px]">{group.tables.length} {group.tables.length === 1 ? "table" : "related tables"}</span>
                  </p>
                </div>
              ))}
              <svg
                data-ui="schema-connectors"
                className="absolute inset-0 overflow-visible"
                width={layout.width}
                height={layout.height}
                aria-hidden
              >
                <defs>
                  {layout.edges.map(({ relation: edge }, index) => {
                    const kinds = [...new Set(edge.access?.map((rule) => rule.kind))];
                    return kinds.length > 1 ? <linearGradient key={edge.id} id={`access-edge-${index}`} x1="0%" y1="0%" x2="100%" y2="100%">
                      {kinds.map((kind, at) => <stop key={kind} offset={`${at / (kinds.length - 1) * 100}%`} stopColor={`var(--access-${kind})`} />)}
                    </linearGradient> : null;
                  })}
                  <marker
                    id="workbench-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerUnits="userSpaceOnUse"
                    markerWidth={7 / zoom}
                    markerHeight={7 / zoom}
                    orient="auto"
                  >
                    <path d="M0 0 8 4 0 8" fill="context-stroke" />
                  </marker>
                  <marker id="workbench-plain-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth={5 / zoom} markerHeight={5 / zoom} orient="auto"><path d="M0 0 8 4 0 8" fill="var(--schema-edge)" /></marker>
                </defs>
                {layout.edges.map(({ relation: edge, path, label }, edgeIndex) => {
                  const traced = !!edge.access?.length && !!accessPath?.edges.has(edge.id);
                  return <g
                    key={edge.id}
                    data-ui="schema-connector"
                    data-access-path={traced || undefined}
                    className={`${(!matches.has(edge.from) && !matches.has(edge.to)) || (focus && selected && edge.from !== selected.id && edge.to !== selected.id && !traced) ? "opacity-25" : ""}`}
                  >
                    <title>{[`${edge.name} · ${edge.cardinality}`, ...(edge.access ?? []).map((rule) => `${accessLabel(edge, rule)}: ${ACCESS_DESCRIPTIONS[rule.kind]}`)].join("\n")}</title>
                    <path
                      data-ui="schema-edge-line"
                      data-access-kinds={accessKinds(edge) || undefined}
                      style={{ strokeWidth: (edge.id === relation?.id || edge.from === selected?.id || edge.to === selected?.id || traced ? 3.5 : 1) / zoom, ...(traced ? { stroke: new Set(edge.access!.map((rule) => rule.kind)).size > 1 ? `url(#access-edge-${edgeIndex})` : accessColor(edge) } : {}) }}
                      d={path}
                      markerEnd={traced ? "url(#workbench-arrow)" : "url(#workbench-plain-arrow)"}
                      className={cx(
                        "fill-none",
                        traced ? "" : "[stroke:var(--schema-edge)]",
                        edge.id === relation?.id ||
                          edge.from === selected?.id ||
                          edge.to === selected?.id ||
                          traced
                          ? "stroke-[4px]"
                          : "stroke-[1.2px]",
                      )}
                    />
                    <path
                      d={path}
                      data-ui="schema-edge-hit"
                      className="cursor-pointer fill-none stroke-transparent stroke-[18px] [pointer-events:stroke]"
                      onClick={() => {
                        onSelect({ table: edge.from, relation: edge.id });
                        if (!retained) onLocate(edge.source);
                      }}
                    />
                    <text
                      style={traced ? { fill: accessColor(edge) } : undefined}
                      className="pointer-events-none fill-dev stroke-paper stroke-[6px] font-mono text-caption font-semibold [paint-order:stroke]"
                      x={label.x}
                      y={label.y}
                      textAnchor="middle"
                    >
                      <tspan x={label.x}>{edge.cardinality}{edge.nullable ? " · optional" : ""}</tspan>
                      {edge.access?.length ? <tspan x={label.x} dy="15">{accessKinds(edge)}</tspan> : null}
                    </text>
                  </g>;
                })}
              </svg>
              {layout.tables.map(({ table, x, y }) => (
                <article
                  key={table.id}
                  data-ui="schema-table"
                  className={`absolute overflow-hidden rounded-lg border bg-sheet ${table.id === selected?.id || (relation && [relation.from, relation.to].includes(table.id)) ? "border-dev shadow-[0_0_0_2px_color-mix(in_srgb,var(--dev)_22%,transparent)]" : "border-rule-strong shadow-[0_4px_14px_light-dark(#17233212,#0000000a)]"} ${!matches.has(table.id) || (focus && selected && selected.id !== table.id && !related.has(table.id)) ? "opacity-25" : focus && selected && selected.id !== table.id ? "opacity-60" : ""}`}
                  style={{ left: x, top: y, width: TABLE_WIDTH }}
                >
                  <button
                    data-ui="schema-table-heading"
                    className="flex h-[69px] w-full items-center justify-between rounded-none border-0 bg-wash px-4 py-3 text-left hover:bg-[light-dark(color-mix(in_srgb,var(--prod)_6%,var(--wash)),var(--wash))] focus-visible:shadow-[inset_0_0_0_2px_light-dark(var(--prod),transparent)] aria-pressed:bg-selected [&>svg]:flex-none"
                    aria-label={`Select table ${table.table}`}
                    aria-description={table.rows?.sentence}
                    aria-pressed={selected?.id === table.id}
                    onClick={() => choose(table)}
                    title={`${table.namespace}.${table.table}${table.rows ? `\n${table.rows.sentence}` : ""}`}
                  >
                    <span className="min-w-0">
                      <strong className="mb-0.75 block truncate font-condensed text-[20px] font-semibold [line-height:normal]">
                        {table.model}
                      </strong>
                      <span data-ui="small" className="block truncate text-meta text-graphite">
                        {table.namespace}.{table.table}
                      </span>
                    </span>
                    {table.rows ? (
                      table.rows.exposed
                        ? <UsersRound data-ui="schema-table-rows" size={17} className="flex-none text-dev" aria-hidden />
                        : <Lock data-ui="schema-table-rows" size={17} className="flex-none text-faint" aria-hidden />
                    ) : <Table2 size={18} className="flex-none" aria-hidden />}
                  </button>
                  {table.columns.map((column) => {
                    const foreign = schema.relations.some(
                      (item) => item.from === table.id && item.fields.includes(column.name),
                    );
                    const highlighted =
                      (selected?.id === table.id && selection?.field === column.name) ||
                      (relation &&
                        ((relation.from === table.id && relation.fields.includes(column.name)) ||
                          (relation.to === table.id && relation.references.includes(column.name))));
                    const AccessIcon = column.access ? ACCESS_ICONS[column.access] : undefined;
                    const summary = fieldLabels.get(column.source.line) ?? (column.access ? ACCESS_LABELS[column.access] : undefined);
                    const access = summary ?? "Inherits model rules";
                    // A retained diagram belongs to an older draft, so its source lines may be wrong.
                    const openAccess = onFieldAccess && !retained ? (anchor: HTMLElement) => onFieldAccess(column.source.line, anchor) : undefined;
                    return (
                      <button
                        data-ui="schema-column"
                        className={`flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-none border-0 border-t border-rule px-3 py-0 text-left hover:bg-wash focus-visible:shadow-[inset_0_0_0_2px_light-dark(var(--prod),transparent)] ${highlighted ? "bg-[light-dark(var(--selected),color-mix(in_srgb,var(--dev)_15%,var(--sheet)))]" : "bg-transparent"}`}
                        key={column.name}
                        aria-label={`Locate ${table.model}.${column.name}${summary ? ` · ${summary}` : ""}`}
                        aria-keyshortcuts={openAccess ? "Control+. Meta+." : undefined}
                        onClick={() => choose(table, column.name)}
                        onKeyDown={(event) => {
                          if (!openAccess || !(event.ctrlKey || event.metaKey) || event.key !== ".") return;
                          event.preventDefault();
                          openAccess(event.currentTarget);
                        }}
                        onContextMenu={(event) => {
                          if (!openAccess) return;
                          event.preventDefault();
                          openAccess(event.currentTarget);
                        }}
                        title={`${column.name} → ${column.column} · ${column.type} · ${column.nullable ? "nullable" : "required"}${column.default ? ` · default ${column.default}` : ""} · Access: ${access}${openAccess ? ` (${FIELD_ACCESS_SHORTCUT} or right-click to change)` : ""}`}
                      >
                        <span
                          data-ui="schema-key"
                          className="w-[31px] shrink-0 font-mono text-[9px] font-semibold text-dev [line-height:normal]"
                        >
                          {[
                            column.primaryKey ? "PK" : "",
                            foreign ? "FK" : "",
                            column.unique && !column.primaryKey ? "UQ" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        </span>
                        <code className="truncate text-meta">
                          {column.name}
                          {column.nullable ? "?" : ""}
                        </code>
                        {AccessIcon ? (
                          <AccessIcon data-ui="schema-access" size={11} className={cx("shrink-0", ACCESS_TONES[column.access!])} aria-hidden />
                        ) : null}
                        <span
                          data-ui="schema-type"
                          className="ml-auto max-w-[155px] truncate font-mono text-micro text-graphite [line-height:normal]"
                        >
                          {column.type}
                        </span>
                      </button>
                    );
                  })}
                  <footer className="h-[34px] border-t border-rule px-[14px] py-[9px] text-micro text-graphite">
                    {table.indexes.length} keys / indexes
                  </footer>
                </article>
              ))}
            </div>
        ) : (
          <p data-ui="empty">No tables to display. Write a model in the source editor.</p>
        )}
      </div>
      <div aria-label="Access relationship colors" className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule px-3 py-1 text-micro">
        {(["owner", "members", "via"] as const).map((kind) => <span key={kind} className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-[3px] w-5 rounded" style={{ background: `var(--access-${kind})` }} />{ACCESS_LABELS[kind]}</span>)}
        <span className="text-graphite" data-ui="access-path-caption">{selected ? `Colored: how people reach ${selected.model} rows` : "Select a table to trace how people reach its rows"}</span>
      </div>
      <footer
        data-ui="workbench-diagram-caption"
        className="flex h-8 shrink-0 items-center gap-2 border-t border-rule px-[10px] text-micro text-graphite"
      >
        <span className="min-w-0 flex-1 truncate">
          {schema.tables.length} tables · {schema.relations.length} {schema.relations.length === 1 ? "relationship" : "relationships"}
        </span>
        <label className="flex shrink-0 items-center gap-1.5" title={schema.tables.length ? "Center the selected table and dim other tables; select a table to begin" : "No tables to focus"}>
          <input
            className="m-0 size-[13px] shrink-0 accent-dev disabled:cursor-not-allowed disabled:opacity-55"
            type="checkbox"
            checked={focus}
            disabled={!schema.tables.length}
            onChange={(event) => setFocus(event.target.checked)}
          />{" "}
          Focus selection
        </label>
        <button
          ref={detailsTrigger}
          className={cx(iconButtonClasses({ variant: "quiet", size: "compact" }), "size-6 min-h-6 shrink-0")}
          aria-label="Schema details"
          title="Schema details and key legend"
          popoverTarget={detailsId}
          aria-haspopup="dialog"
          aria-expanded={detailsOpen}
          onClick={positionDetails}
        >
          <Info size={14} aria-hidden />
        </button>
      </footer>
      <div
        ref={detailsPanel}
        id={detailsId}
        popover="auto"
        role="dialog"
        aria-label="Schema details"
        onToggle={(event) => {
          const open = event.newState === "open";
          setDetailsOpen(open);
          if (open) detailsPanel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
        }}
        style={{ ...detailsPosition, maxHeight: `calc(100dvh - ${detailsPosition.bottom + 12}px)` }}
        data-ui="workbench-entity-details"
        className="fixed top-auto right-auto z-30 m-0 box-border w-[420px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-lg border border-rule-strong bg-sheet p-3 text-meta text-ink shadow-popover"
      >
        <header className="mb-2 flex items-center justify-between gap-2">
          <strong>Schema details</strong>
          <button
            className={iconButtonClasses({ variant: "quiet", size: "compact" })}
            aria-label="Close schema details"
            onClick={() => { detailsPanel.current?.hidePopover(); detailsTrigger.current?.focus(); }}
          >
            <X size={14} aria-hidden />
          </button>
        </header>
        <p id={navigationId} className="my-1.5 text-caption text-graphite">
          Drag or scroll to pan. Use arrow keys to pan, +/− to zoom and 0 to fit.
          100% shows the complete schema. Tables are grouped by their foreign-key relationships.
          Trackpad pinch or Ctrl/Cmd+scroll to zoom. Focus selection centers the selected table and
          dims other tables, keeping direct relationships more prominent. If nothing is selected,
          it waits for you to select a table, field or relationship.
        </p>
        <p className="my-1.5 text-caption text-graphite">
          Amber lines carry Owner, purple lines Members, and teal lines Via row access
          rules. A connection with different rules at its ends blends both colors. Arrowheads point to the referenced table. Each rule names the model whose rows it makes visible.
        </p>
        {selected ? (
          <>
            <div
              data-ui="workbench-detail-heading"
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <strong>
                {selected.model}
                {selection?.field ? `.${selection.field}` : ""}
              </strong>
              <span data-ui="small" className="text-caption text-graphite">
                {selected.namespace}.{selected.table}
              </span>
            </div>
            {selection?.field
              ? selected.columns
                  .filter((column) => column.name === selection.field)
                  .map((column) => (
                    <p key={column.name} className="my-1.5 only:m-0">
                      <code>{column.type}</code> · {column.nullable ? "Nullable" : "Required"} ·
                      column <code>{column.column}</code>
                      {column.default ? (
                        <>
                          {" "}
                          · default <code>{column.default}</code>
                        </>
                      ) : null}
                    </p>
                  ))
              : null}
            {relation ? (
              <p className="my-1.5 only:m-0">
                <strong>{relation.name}</strong> · ({relation.fields.join(", ")}) →{" "}
                {schema.tables.find((table) => table.id === relation.to)?.model} (
                {relation.references.join(", ")}) · {relation.cardinality} · on delete{" "}
                {relation.onDelete} · on update {relation.onUpdate}
              </p>
            ) : null}
            <div
              data-ui="workbench-inline-list"
              className="mt-[7px] flex flex-wrap gap-x-[14px] gap-y-[5px]"
            >
              {selected.indexes.map((index, position) => (
                <button
                  key={position}
                  data-ui="linkish"
                  className={cx(buttonClasses({ variant: "link" }), "text-meta")}
                  disabled={retained}
                  title={index.declaration}
                  onClick={() => onLocate(index.source)}
                >
                  {index.name ?? `${index.kind} (${index.fields.join(", ")})`}
                </button>
              ))}
              {schema.relations
                .filter((item) => item.from === selected.id || item.to === selected.id)
                .map((item) => (
                  <div key={item.id} className="min-w-0 w-full">
                    <button
                      data-ui="linkish"
                      className={cx(buttonClasses({ variant: "link" }), "text-meta")}
                      onClick={() => {
                        onSelect({ table: item.from, relation: item.id });
                        if (!retained) onLocate(item.source);
                      }}
                    >
                      {item.name} · {item.cardinality}
                    </button>
                    {item.access?.map((rule) => {
                      const AccessIcon = ACCESS_ICONS[rule.kind];
                      return (
                        <div key={`${rule.side}.${rule.field}`} className="mt-1 flex items-start gap-1.5">
                          <AccessIcon size={13} className="mt-0.5 shrink-0 text-dev" aria-hidden />
                          <div className="min-w-0">
                            <button
                              data-ui="schema-relation-access"
                              className={cx(buttonClasses({ variant: "link" }), "text-left text-meta [overflow-wrap:anywhere]")}
                              aria-label={`Locate ${accessLabel(item, rule)}`}
                              disabled={retained}
                              onClick={() => {
                                onSelect({ table: rule.side === "from" ? item.from : item.to, relation: item.id });
                                detailsPanel.current?.hidePopover();
                                // The popover returns focus to its opener as it closes.
                                // Move focus to the revealed source after that handoff.
                                requestAnimationFrame(() => onLocate(rule.source));
                              }}
                            >
                              {accessLabel(item, rule)}
                            </button>
                            <p className="m-0 text-caption text-graphite">{ACCESS_DESCRIPTIONS[rule.kind]}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </div>
          </>
        ) : (
          <p data-ui="small" className="my-1.5 only:m-0 text-caption text-graphite">
            Select a table, field or relationship to locate its source. PK primary key · FK foreign
            key · UQ unique.
          </p>
        )}
        {schema.enums.length ? (
          <details>
            <summary>{schema.enums.length} enums</summary>
            {schema.enums.map((item) => (
              <p key={item.name} className="my-1.5">
                <strong>{item.name}</strong> <code>{item.values.join(" · ")}</code>
              </p>
            ))}
          </details>
        ) : null}
        {schema.problems.length ? (
          <details>
            <summary>Diagram capability notes ({schema.problems.length})</summary>
            {schema.problems.map((problem, index) => (
              <p key={index} data-ui="small" className="my-1.5 text-caption">
                {problem}
              </p>
            ))}
          </details>
        ) : null}
      </div>
    </div>
  );
}

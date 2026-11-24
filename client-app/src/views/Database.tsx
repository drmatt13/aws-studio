import { usePublishSightline } from "../sightline/bridge";
import { dialogPrimaryActionClasses } from "../inspector-ui";
import {
  workbenchEmptyClasses,
  workbenchNoticeClasses,
  workbenchSegmentClasses,
  workbenchSegmentGroupClasses,
  WorkbenchDialog,
  SourceComparison,
} from "./WorkbenchUI";
import { documentTitleClasses, pageWidthClasses } from "./DocumentUI";
import { cx } from "../ui/classes";
import { NotificationStack } from "../ui/NotificationStack";
import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { workspaceToolbarClasses } from "../ui/Surface";
import {
  AlertTriangle,
  Check,
  CircleHelp,
  Code2,
  Columns2,
  Database as DatabaseIcon,
  ExternalLink,
  FileCode2,
  History,
  Maximize2,
  Minimize2,
  Shield,
  Table2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useLocation, useNavigate } from "@tanstack/react-router";
import type { SourceLocation } from "../../shared/model";
import { editorLink } from "../lookup";
import { graphqlWorkspaceApi } from "../graphql-workspace-api";
import { ApiError, call } from "../http";
import type {
  DatabaseContractImpact,
  DatabaseObservation,
  DatabaseSourceReview,
  DatabaseValidation,
  DatabaseWorkbench,
  DatabaseSaveResult,
} from "../../shared/database-workbench";
import { DatabaseSession } from "../database-session";
import { DatabaseDiagram, type SchemaSelection } from "./DatabaseDiagram";
import { PrismaEditor, type PrismaEditorHandle } from "./PrismaEditor";
import { PrismaAccessInspector, accessSelectionAt, type AccessSelection } from "./PrismaAccessInspector";
import { PrismaAccessPopup } from "./PrismaAccessPopup";

/** Where the framework's GraphQL API lives: the one workload that enforces contract.prisma's rules. */
import { Select } from "../ui/FormControls";
import { FIELD_ACCESS_SHORTCUT, type FieldAccessAnchor } from "./access-presentation";
import { readClientAccess, registerAccessModules } from "aws-studio/database/client-access";
import { accessDiagnostics } from "./prisma-access-language";
import { DatabaseHistory } from "./DatabaseHistory";
import { DatabaseEvidence } from "./DatabaseEvidence";

import { useStudio } from "../studio";
import { DatabaseSql } from "./DatabaseSql";
import { DataRetention } from "./DataRetention";
import { NavigationStrip, navigationItemClasses } from "./NavigationStrip";
import { contractPrimaryClasses, contractStageNames } from "./graphql/GraphQLContractWorkflow";

const basePath = "/database/workbench";
export const databaseApi = {
  load: async (signal?: AbortSignal) => {
    const result = await call<DatabaseWorkbench>(basePath, undefined, signal);
    if (
      typeof result.source !== "string" ||
      typeof result.revision !== "string" ||
      !result.validation ||
      !result.capabilities ||
      !Array.isArray(result.targets)
    )
      throw new ApiError(
        409,
        "The running server does not support this database workbench. Restart npm run studio in this checkout, then retry. Your draft is preserved.",
      );
    return result;
  },
  validate: (source: string, signal?: AbortSignal) =>
    call<DatabaseValidation>(`${basePath}/validate`, { source }, signal),
  review: (source: string, expectedRevision: string) =>
    call<DatabaseSourceReview>(`${basePath}/review`, { source, expectedRevision }),
  save: (reviewId: string) => call<DatabaseSaveResult>(`${basePath}/save`, { reviewId }),
  format: (source: string) => call<{ source: string }>(`${basePath}/format`, { source }),
  inspect: (targetId: string, expectedRevision: string, historyRevision: string) =>
    call<DatabaseObservation>(`${basePath}/inspect`, {
      targetId,
      expectedRevision,
      historyRevision,
    }),
};

function AccessPolicyChanges({ changes }: { readonly changes: DatabaseContractImpact["accessChanges"] }) {
  if (!changes?.length) return null;
  return (
    <section aria-label="Access policy changes" className="grid gap-2 rounded-md border border-rule bg-paper p-3">
      <h3 className="m-0 text-label font-semibold">Access policy changes</h3>
      <ul className="m-0 grid list-none gap-2 p-0 text-caption">
        {changes.map((change) => (
          <li key={change.path} className="grid gap-0.5 wrap-anywhere">
            <strong className="font-medium">{change.path}</strong>
            <span><span className="text-graphite">Before</span> · {change.before ?? "None"}</span>
            <span><span className="text-graphite">After</span> · {change.after ?? "None"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Database() {
  const { snapshot, selected, toast, toasts, dismissToast, mode: sourceMode } = useStudio();
  const queryClient = useQueryClient();
  const impactKey = ["database-contract-impact", snapshot.repositoryRoot] as const;
  const impact = useQuery<NonNullable<DatabaseSaveResult["contractImpact"]>>({ queryKey: impactKey, queryFn: skipToken });
  // Cache saved source above the route; drafts and editor history stay in their
  // guarded session. Returning renders cached source while checking for changes.
  const saved = useQuery({
    queryKey: ["database-workbench", snapshot.repositoryRoot],
    queryFn: ({ signal }) => databaseApi.load(signal),
    retry: false,
    staleTime: 0,
    // Every accepted read also rechecks history/targets, even with identical text.
    structuralSharing: false,
    refetchOnWindowFocus: "always",
  });
  // Drafts read contract.prisma with the repository's access policy module (Access Graph guards and permissions).
  const accessModules = saved.data?.accessModules;
  registerAccessModules(accessModules);
  const [session] = useState(() => {
    const session = new DatabaseSession(databaseApi);
    if (saved.data) session.sync(saved.data);
    return session;
  });
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const loadingError = saved.error?.message;
  const load = saved.refetch;
  useLayoutEffect(() => {
    if (saved.data) session.sync(saved.data);
  }, [saved.data, session]);
  const pathname = useLocation({ select: location => location.pathname });
  const hash = useLocation({ select: location => location.hash });
  const tab = pathname === "/database/history" ? "history"
    : pathname === "/database/status" || hash === "status" ? "database"
    : pathname === "/database/sql" ? "sql"
    : pathname === "/database/retention" ? "retention" : "schema";
  const navigate = useNavigate();
  useEffect(() => { if (hash === "status") void navigate({ to: "/database/status", search: true, hash: "", replace: true }); }, [hash, navigate]);
  const [mode, setMode] = useState<"split" | "source" | "diagram">("source");
  const [interactiveAccess, setInteractiveAccess] = useState(() => {
    try { return localStorage.getItem("studio.prisma.access-display") !== "comments"; }
    catch { return true; }
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [selection, setSelection] = useState<SchemaSelection | undefined>(() =>
    selected?.startsWith("schema:") ? { table: selected } : undefined,
  );
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [ratio, setRatio] = useState(62);
  const [access, setAccess] = useState<{ anchor: FieldAccessAnchor; selection?: AccessSelection; line: number; restore: () => void }>();
  const [formatting, setFormatting] = useState(false);
  const [help, setHelp] = useState(false);
  const [guard, setGuard] = useState<"discard" | "navigation">();
  const pendingNavigation = useRef<((block: boolean) => void) | undefined>(undefined);
  const editor = useRef<PrismaEditorHandle>(null);
  const workbench = useRef<HTMLDivElement>(null);
  const fullscreenReturn = useRef<{ mode: typeof mode } | undefined>(undefined);
  const fullscreenTrigger = useRef<HTMLButtonElement>(null);
  const layoutControls = useRef<HTMLDivElement>(null);
  const validationTrigger = useRef<HTMLButtonElement>(null);
  const accessTrigger = useRef<HTMLButtonElement>(null);
  const fullscreenPending = useRef(false);
  const split = useRef<HTMLDivElement>(null);
  const sourceNow = useRef(state.source);
  sourceNow.current = state.source;
  const loadedRevision = useRef(snapshot.revision);
  useEffect(() => {
    if (loadedRevision.current === snapshot.revision) return;
    loadedRevision.current = snapshot.revision;
    void load();
  }, [snapshot.revision, load]);
  useEffect(() => {
    // Private connections and migration files can change without changing the graph.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);
  useEffect(() => {
    if (!state.baseline || state.validationVersion === state.version || state.busy) return;
    const timer = window.setTimeout(() => void session.validate(), 650);
    return () => window.clearTimeout(timer);
  }, [state.version, state.baseline, state.busy]);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    if (tab !== "schema") setAccess(undefined);
  }, [tab]);
  useEffect(() => {
    const element = workbench.current;
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === element;
      setFullscreen(active);
      if (!active && fullscreenReturn.current) {
        const previous = fullscreenReturn.current;
        fullscreenReturn.current = undefined;
        setMode(previous.mode);
        window.requestAnimationFrame(() => fullscreenTrigger.current?.focus());
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  const toggleFullscreen = async () => {
    const element = workbench.current;
    if (!element || fullscreenPending.current) return;
    fullscreenPending.current = true;
    setFullscreenError(false);
    try {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      else {
        fullscreenReturn.current = { mode };
        await element.requestFullscreen();
      }
    } catch {
      if (fullscreenReturn.current && document.fullscreenElement !== element) {
        setMode(fullscreenReturn.current.mode);
        fullscreenReturn.current = undefined;
      }
      setFullscreenError(true);
    } finally {
      fullscreenPending.current = false;
    }
  };
  useEffect(() => {
    const onExit = (event: BeforeUnloadEvent) => {
      if (session.dirty || session.getSnapshot().busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onExit);
    return () => window.removeEventListener("beforeunload", onExit);
  }, [session]);
  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: ({ current, next }) => {
      const staysInDatabase = next.pathname === "/database" || next.pathname.startsWith("/database/");
      if (current.pathname === next.pathname || staysInDatabase || (!session.dirty && !state.busy)) return false;
      return new Promise<boolean>((resolve) => {
        pendingNavigation.current = resolve;
        setGuard("navigation");
      });
    },
  });
  const closeGuard = () => {
    pendingNavigation.current?.(true);
    pendingNavigation.current = undefined;
    setGuard(undefined);
  };
  const discard = () => {
    session.discard();
    pendingNavigation.current?.(false);
    pendingNavigation.current = undefined;
    setGuard(undefined);
    if (guard === "discard") window.requestAnimationFrame(() => validationTrigger.current?.focus());
  };
  const format = async () => {
    const source = state.source;
    setFormatting(true);
    try {
      const result = await databaseApi.format(source);
      if (sourceNow.current === source) editor.current?.replaceDocument(result.source);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "refuse");
    } finally {
      setFormatting(false);
    }
  };
  const revealSource = (from: number, to: number) => {
    if (mode === "diagram") {
      setMode("split");
      window.requestAnimationFrame(() => editor.current?.reveal(from, to));
    } else editor.current?.reveal(from, to);
  };
  const locate = (source: SourceLocation) => {
    if (session.currentValid) revealSource(source.start, source.end);
  };
  const cursorChanged = (position: { from: number; to: number; line: number; column: number }) => {
    setCursor({ line: position.line, column: position.column });
    if (!session.currentValid) return;
    const schema = session.getSnapshot().diagram;
    const table = schema?.tables.find(
      (item) => position.from >= item.source.start && position.from <= item.source.end,
    );
    if (!table) return;
    const field = table.columns.find(
      (item) => position.from >= item.source.start && position.from <= item.source.end,
    );
    const relation = schema?.relations.find(
      (item) => position.from >= item.source.start && position.from <= item.source.end,
    );
    setSelection({ table: table.id, field: field?.name, relation: relation?.id });
  };
  const parsedAccess = useMemo(() => readClientAccess(state.source, accessModules), [state.source, accessModules]);
  // Access problems underline their exact column as you type; a validation reports them too.
  const liveAccessDiagnostics = useMemo(() => accessDiagnostics(state.source, parsedAccess.problems), [state.source, parsedAccess]);
  const symbols = useMemo(() => [
    ...Object.entries(parsedAccess.index.models),
    ...Object.entries(parsedAccess.index.enums),
  ].sort(([a], [b]) => a.localeCompare(b)), [parsedAccess]);
  const activeSymbol = symbols.find(([name, entry]) => cursor.line === parsedAccess.graph.provenance.models[name]?.line || cursor.line >= entry.line && cursor.line <= entry.end)?.[0] ?? "";
  // What the rules govern, and what they do not: operations whose executed
  // authorization consulted a model, and workloads that reach the database
  // directly (only the GraphQL API enforces contract.prisma's rules).
  // Permission names are API surface: client operations read them as _access.can.<name>.
  // Same key as the GraphQL view, so both share one inventory and its invalidation.
  const graphqlWorkspace = useQuery({ queryKey: ["graphql-workspace", snapshot.repositoryRoot], queryFn: ({ signal }) => graphqlWorkspaceApi.load(signal), retry: false });
  const clientQueries = useMemo(() => ({
    status: graphqlWorkspace.isPending ? "loading" as const : graphqlWorkspace.isError || !graphqlWorkspace.data || graphqlWorkspace.data.client.status === "invalid" ? "unavailable" as const : graphqlWorkspace.data.client.status === "missing" ? "missing" as const : "available" as const,
    documents: (graphqlWorkspace.data?.client.documents ?? []).map(({ name, kind, file, line, selections }) => ({ name, kind, file, line, selections })),
    link: (file: string, line: number) => editorLink(snapshot.repositoryRoot, { file, line, column: 1, start: 0, end: 0 }),
  }), [snapshot.repositoryRoot, graphqlWorkspace.isPending, graphqlWorkspace.isError, graphqlWorkspace.data]);
  const closeAccess = () => {
    setAccess(undefined);
    window.requestAnimationFrame(() => access?.restore());
  };
  const showInteractiveAccess = (interactive: boolean) => {
    setInteractiveAccess(interactive);
    setAccess(undefined);
    try { localStorage.setItem("studio.prisma.access-display", interactive ? "interactive" : "comments"); }
    catch { /* The mounted editor still retains the preference. */ }
  };
  const revealLine = (line: number, focus = true, top = line) => {
    const target = editor.current?.line(line);
    if (!target) return;
    setCursor({ line, column: 1 });
    editor.current?.reveal(target.from, target.from, focus, "start", editor.current.line(top)?.from ?? target.from);
  };
  /** A declaration's leading comments and rules belong with it: a jump shows them above it. */
  const declarationTop = (line: number) => {
    let top = line;
    while (top > 1 && /^\s*\/\//.test(editor.current?.line(top - 1)?.text ?? "")) top--;
    return top;
  };
  const elementAnchor = (element: Element): FieldAccessAnchor => {
    const { left, top, bottom } = element.getBoundingClientRect();
    return { left, top, bottom, element };
  };
  const inspectAt = (line: number, anchor: FieldAccessAnchor, restore: () => void) => {
    setAccess({ anchor, selection: accessSelectionAt(state.source.split("\n"), parsedAccess, line), line, restore });
    return true;
  };
  const editAccessSource = (line: number, offset?: number) => {
    setAccess(undefined);
    if (mode === "diagram") setMode("split");
    window.requestAnimationFrame(() => {
      const target = editor.current?.line(line);
      if (!target) return;
      const marker = target.text.indexOf("@access");
      const position = Math.min(target.to, target.from + (offset ?? (marker < 0 ? 0 : marker + 1)));
      editor.current?.reveal(position, position, true, "start");
    });
  };
  const save = async () => {
    const result = await session.save();
    if (result) {
      if (result.contractImpact) queryClient.setQueryData(impactKey, result.contractImpact);
      else queryClient.removeQueries({ queryKey: impactKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: ["graphql-chain", snapshot.repositoryRoot] });
      void queryClient.invalidateQueries({ queryKey: ["graphql-workspace", snapshot.repositoryRoot] });
      toast(result.message, result.refresh === "complete" ? "plain" : "refuse");
      void load();
    }
  };
  const validationCurrent = state.validationVersion === state.version;
  const valid = validationCurrent && state.validation?.valid;
  usePublishSightline("database", () => ({
    availability: loadingError ? "error" : state.baseline ? "available" : "loading",
    tab, editorMode: mode, selection, dirty: session.dirty, conflicted: session.conflict,
    validation: { availability: state.validating ? "loading" : state.validation ? "available" : "not-loaded",
      current: validationCurrent, valid: state.validation?.valid,
      diagnostics: (state.validation?.diagnostics ?? []).map(d => ({ code: d.code, severity: d.severity, from: d.from, to: d.to })) },
    diagramRetained: !!state.diagram && !valid, revision: state.baseline?.revision, file: state.baseline?.file,
  }));
  const status = state.validating
    ? "Validating…"
    : !validationCurrent
      ? "Validation pending"
      : valid
        ? "Valid Prisma 8"
        : "Invalid draft";
  const workspaceControls = (
    <div
      data-ui="workbench-workspace-controls"
      className="ml-auto flex shrink-0 items-center gap-2"
    >
      <div
        ref={layoutControls}
        data-ui="workbench-view-modes"
        className={workbenchSegmentGroupClasses}
        role="group"
        aria-label="Editing layout"
      >
        {[
          { id: "source" as const, label: "Focus source", icon: Code2 },
          { id: "split" as const, label: "Split source and diagram", icon: Columns2 },
          { id: "diagram" as const, label: "Focus diagram", icon: Table2 },
        ].map((item) => (
          <button
            className={workbenchSegmentClasses("icon")}
            key={item.id}
            title={item.label}
            aria-label={item.label}
            aria-pressed={mode === item.id}
            onClick={() => {
              setAccess(undefined);
              setMode(item.id);
              window.requestAnimationFrame(() =>
                layoutControls.current
                  ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
                  ?.focus(),
              );
            }}
          >
            <item.icon size={15} aria-hidden />
          </button>
        ))}
      </div>
      <button
        ref={fullscreenTrigger}
        className={iconButtonClasses({ variant: "quiet", size: "compact" })}
        aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen schema workspace"}
        title={
          !document.fullscreenEnabled
            ? "Fullscreen is unavailable in this browser"
            : fullscreen
              ? "Exit fullscreen · Esc"
              : "Fullscreen schema workspace"
        }
        disabled={!document.fullscreenEnabled}
        onClick={() => void toggleFullscreen()}
      >
        {fullscreen ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
      </button>
    </div>
  );
  const sourceStatus = (
    <div data-ui="workbench-source-meta" className="flex flex-1 flex-wrap items-center gap-x-3">
      <span
        data-ui="workbench-badge"
        className={`inline-flex items-center gap-1 rounded-sm bg-transparent p-0 text-meta leading-[22px] font-normal whitespace-nowrap text-graphite ${session.dirty ? "border-[color-mix(in_srgb,var(--local)_45%,var(--rule))] text-local" : ""}`}
      >
        {session.dirty ? "Modified draft" : "Saved source"}
      </span>
      <span
        data-ui="workbench-badge"
        className={`inline-flex items-center gap-1 rounded-sm bg-transparent p-0 text-meta leading-[22px] font-normal whitespace-nowrap text-graphite ${validationCurrent && !valid ? "text-refuse" : ""}`}
        role="status"
      >
        {valid ? (
          <Check size={12} aria-hidden />
        ) : validationCurrent ? (
          <AlertTriangle size={12} aria-hidden />
        ) : null}
        {status}
      </span>
    </div>
  );
  const sourceActions = (
    <div
      data-ui="workbench-source-tools"
      className="flex min-h-[50px] flex-wrap items-center justify-between gap-2 border-b border-rule px-[10px] py-2 [&_button]:text-caption"
    >
      <div className="flex flex-wrap items-center gap-2">
        {mode !== "diagram" && symbols.length ? (
          <Select appearance="quiet" controlSize="compact" aria-label="Jump to model or enum" value={activeSymbol} className="max-w-[190px]" onChange={(event) => {
            const symbol = event.target.value;
            const entry = symbols.find(([name]) => name === symbol)?.[1];
            if (entry) revealLine(entry.line, true, declarationTop(entry.line));
          }}>
            <option value="" disabled>Jump to…</option>
            {symbols.map(([name]) => <option key={name} value={name}>{name}</option>)}
          </Select>
        ) : null}
        {mode !== "diagram" && (
          <div className={workbenchSegmentGroupClasses} role="group" aria-label="Access display">
            <button type="button" className={workbenchSegmentClasses("text")} aria-pressed={interactiveAccess}
              title="Show access pills and interactive controls" onClick={() => showInteractiveAccess(true)}>Interactive</button>
            <button type="button" className={workbenchSegmentClasses("text")} aria-pressed={!interactiveAccess}
              title="Show highlighted access comments" onClick={() => showInteractiveAccess(false)}>Comments</button>
          </div>
        )}
        <button
          className="inline-flex h-7 min-h-7 cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent bg-transparent px-2 py-0 font-sans text-caption leading-[1.5] font-medium text-graphite hover:border-rule hover:bg-wash hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
          disabled={formatting || !!state.busy}
          title="Format draft · Shift+Alt+F"
          onClick={() => void format()}
        >
          {formatting ? "Formatting…" : "Format"}
        </button>
      </div>
      <div data-ui="workbench-actions" className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          ref={validationTrigger}
          className={buttonClasses({
            variant: "quiet",
            size: "custom",
            className: "h-7 min-h-7 px-2 py-0",
          })}
          aria-label="Validate draft"
          disabled={!!state.busy || formatting}
          onClick={() => void session.validate()}
        >
          Validate
        </button>
        {session.dirty ? (
          <button
            className={buttonClasses({
              variant: "quiet",
              size: "custom",
              className: "h-7 min-h-7 px-2 py-0",
            })}
            disabled={!!state.busy}
            onClick={() => setGuard("discard")}
          >
            Discard
          </button>
        ) : null}
        <button
          className={buttonClasses({
            variant: "primary",
            size: "custom",
            className: "h-7 min-h-7 px-2 py-0",
          })}
          aria-label="Review source changes"
          disabled={
            !session.dirty || !!state.busy || session.conflict || (validationCurrent && !valid)
          }
          onClick={() => void session.review()}
        >
          {state.busy === "review" ? "Preparing review…" : "Review changes"}
        </button>
      </div>
    </div>
  );
  const selectedAccess = access?.selection;
  const declaration = selectedAccess?.kind === "enum" ? parsedAccess.index.enums[selectedAccess.name] : selectedAccess && parsedAccess.index.models[selectedAccess.name];
  const currentLine = declaration && selectedAccess?.member
    ? ("values" in declaration ? declaration.values : declaration.fields)[selectedAccess.member]
    : declaration?.line;
  const popup = access && tab === "schema" ? (
    <PrismaAccessPopup anchor={access.anchor} matrix={selectedAccess?.kind === "enum"} onClose={closeAccess}
      label={selectedAccess ? `Access for ${[selectedAccess.name, selectedAccess.member].filter(Boolean).join(".")}` : "Prisma access"}>
      <PrismaAccessInspector
        source={state.source}
        parsed={parsedAccess}
        line={currentLine ?? access.line}
        activeLine={currentLine && selectedAccess ? currentLine + access.line - selectedAccess.line : undefined}
        modules={accessModules}
        onApplySource={state.busy ? undefined : (next) => {
          if (sourceNow.current === state.source) editor.current?.replaceDocument(next);
        }}
        exposure={graphqlWorkspace.isPending
          ? { status: "loading" }
          : graphqlWorkspace.data?.schema.tableTypes
            ? { status: "available", typesByModel: graphqlWorkspace.data.schema.tableTypes }
            : { status: "unavailable" }}
        policyModuleHref={accessModules ? editorLink(snapshot.repositoryRoot, {
          file: "packages/database/prisma/access/index.ts", line: 1, column: 1, start: 0, end: 0,
        }) : undefined}
        onNavigate={editAccessSource}
        onEditSource={editAccessSource}
        onClose={closeAccess}
      />
    </PrismaAccessPopup>
  ) : null;
  return (
    <div
      data-ui="database-view database-workbench"
      className="group/workbench flex min-h-full min-w-0 flex-col gap-4 pb-(--workspace-gutter) [&:fullscreen]:h-full [&:fullscreen]:min-h-0 [&:fullscreen]:overflow-auto [&:fullscreen]:bg-paper [&:fullscreen]:p-(--workspace-gutter)"
      ref={workbench}
    >
      <h1 className="sr-only">Database</h1>
      <div
        data-ui="workspace-toolbar workbench-navigation"
        className={cx(
          workspaceToolbarClasses,
          "flex items-center justify-between gap-2 group-[:fullscreen]/workbench:hidden",
        )}
      >
        <NavigationStrip className="min-w-0 flex-1" label="Database workspace" activeKey={tab}>
          {[
            { id: "schema" as const, to: "/database/schema" as const, label: "Schema", icon: FileCode2 },
            { id: "history" as const, to: "/database/history" as const, label: "History & migrations", icon: History },
            { id: "database" as const, to: "/database/status" as const, label: "Database status", icon: DatabaseIcon },
            { id: "sql" as const, to: "/database/sql" as const, label: "Saved SQL", icon: Code2 },
            { id: "retention" as const, to: "/database/retention" as const, label: "Data retention", icon: DatabaseIcon },
          ].map((item) => (
            <Link
              className={navigationItemClasses}
              key={item.id}
              to={item.to}
              search={true}
              activeOptions={{ exact: true, includeSearch: false }}
              aria-current={tab === item.id ? "page" : undefined}
            >
              <item.icon size={15} aria-hidden />
              {item.label}
            </Link>
          ))}
        </NavigationStrip>
        <button
          data-ui="workbench-help-toggle"
          className={cx(
            iconButtonClasses(),
            "shrink-0 border-transparent bg-transparent text-graphite",
          )}
          title="How this works"
          aria-label="How this works"
          aria-haspopup="dialog"
          aria-expanded={help}
          aria-controls={help ? "database-workbench-help" : undefined}
          onClick={() => setHelp(true)}
        >
          <CircleHelp size={16} aria-hidden />
        </button>
      </div>
      {help ? (
        <WorkbenchDialog
          id="database-workbench-help"
          size="help"
          title="How this works"
          onClose={() => setHelp(false)}
          footer={
            <button
              data-variant="primary"
              className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
              onClick={() => setHelp(false)}
            >
              Got it
            </button>
          }
        >
          <p
            data-ui="workbench-help-flow"
            className="m-0 text-label leading-[1.65] font-medium text-graphite"
          >
            Source → review → migration → database
          </p>
          <ol className="m-0 grid gap-3 pl-5 text-body leading-[1.65]">
            <li className="pl-1">
              <strong>Edit and review.</strong> Edit the Prisma draft, validate it, then review the
              exact source change before saving.
            </li>
            <li className="pl-1">
              <strong>Plan a migration.</strong> Use History & migrations to plan offline from an
              explicit historical baseline.
            </li>
            <li className="pl-1">
              <strong>Inspect a database.</strong> Choose a target in Database status to compare
              migration markers with its physical schema.
            </li>
          </ol>
          <section data-ui="workbench-help-access" className="grid gap-2 border-t border-rule pt-3">
            <h3 className="m-0 text-label font-semibold">Access</h3>
            <p className="m-0 text-label leading-[1.65]">
              Select a model, enum, or field, then open <strong>Access</strong> or press <kbd>{FIELD_ACCESS_SHORTCUT}</kbd>.
              Follow an inherited scope to its source or preview the policy with sample data.
            </p>
            <p className="m-0 text-label leading-[1.65]">
              A valid directive appears as a pill. Select a pill or hover a declaration and open its access button
              to configure a rule. Select the matrix button on a role enum to edit its permissions.
            </p>
            <p className="m-0 text-label leading-[1.65] text-graphite">
              A change is a contract change: GraphQL types built with <code>tableObject</code> or{" "}
              <code>tableInput</code> must comply, and every row they return is checked, before Contract
              Chain passes. Other workloads are not limited.
            </p>
          </section>
          <p className="m-0 text-label leading-[1.65]">
            Saving only writes <code>contract.prisma</code>. Generation, migration packages,
            database application and deployment are separate actions.
          </p>
          <p className="m-0 text-label leading-[1.65] text-graphite">
            New fields may also need repository, GraphQL, authorization and frontend changes; Studio
            does not expose them automatically.
          </p>
          {state.baseline?.capabilities.notes.length ? (
            <details
              data-ui="workbench-help-capabilities"
              className="border-t border-rule pt-3 text-caption"
            >
              <summary className="cursor-pointer text-graphite [[open]>&]:mb-3">
                Editor capabilities
              </summary>
              {state.baseline.capabilities.notes.map((note) => (
                <p
                  className={"[&+p]:pt-2 m-0 leading-[1.65] text-caption text-graphite"}
                  key={note}
                >
                  {note}
                </p>
              ))}
            </details>
          ) : null}
        </WorkbenchDialog>
      ) : null}
      <div
        data-ui="database-content"
        className={cx(
          "flex min-w-0 flex-1 flex-col gap-4 group-[:fullscreen]/workbench:min-h-0 group-[:fullscreen]/workbench:px-0",
          tab === "schema" ? "px-(--workspace-gutter)" : pageWidthClasses,
        )}
      >
        {tab === "schema" && impact.data && impact.data.revision === state.baseline?.revision && impact.data.earliestStage ? <section aria-label="Saved contract impact" className={cx(workbenchNoticeClasses("neutral"), "grid gap-2")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid min-w-0 gap-1"><strong className="text-label font-semibold">Saved schema · contract update needed</strong><span className="text-caption text-graphite">Next: {contractStageNames[impact.data.earliestStage]}</span></div>
            <Link to="/graphql/schema" search={previous => ({ ...previous, document: undefined })} className={buttonClasses({ variant: "primary", className: contractPrimaryClasses })}>Continue contract update</Link>
          </div>
          <p className="m-0 text-caption text-graphite">{impact.data.models.length ? `${impact.data.models.join(", ")} changed. ` : "Database semantics changed. "}Repository/API, generated documents and client confidence need reconciliation. Public exposure remains an explicit decision.</p>
          {impact.data.diffs.length ? <details className="text-caption"><summary className="cursor-pointer font-medium">Inspect affected fields · {impact.data.diffs.length}</summary><ul className="mb-0 grid gap-1 pl-5">{impact.data.diffs.map((diff, index) => <li key={`${diff.path}-${index}`}><code className="wrap-anywhere">{diff.path}</code> · {diff.change}</li>)}</ul></details> : null}
          {impact.data.accessChanges?.length ? <details className="text-caption"><summary className="cursor-pointer font-medium">Inspect access policy changes · {impact.data.accessChanges.length}</summary><AccessPolicyChanges changes={impact.data.accessChanges} /></details> : null}
          {session.dirty ? <p className="m-0 text-caption text-graphite">This impact is from saved source. Your current editor draft is excluded.</p> : null}
        </section> : null}
        {loadingError && tab !== "sql" && tab !== "retention" ? (
          <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
            {loadingError} Your draft is preserved.{" "}
            <button
              data-ui="linkish"
              className={cx("ml-2", buttonClasses({ variant: "link" }))}
              onClick={() => void load()}
            >
              Retry loading source
            </button>
          </div>
        ) : null}
        {fullscreenError ? (
          <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
            The browser could not change fullscreen mode. Use the source, split or diagram layout
            controls to adjust your workspace.{" "}
            <button
              data-ui="linkish"
              className={cx("ml-2", buttonClasses({ variant: "link" }))}
              onClick={() => setFullscreenError(false)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {state.error ? (
          <div data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
            {state.error}{" "}
            <button
              data-ui="linkish"
              className={cx("ml-2", buttonClasses({ variant: "link" }))}
              onClick={() => void load()}
            >
              Check latest saved source
            </button>
          </div>
        ) : null}
        {session.conflict ? (
          <section
            data-ui="workbench-notice"
            className={workbenchNoticeClasses("warning")}
            role="alert"
          >
            <strong>Saved source changed outside this session.</strong> Your draft and undo history
            are preserved.{" "}
            <button
              className={cx("ml-2", buttonClasses({ variant: "quiet", size: "compact" }))}
              disabled={!!state.busy}
              onClick={() => setGuard("discard")}
            >
              Load saved source
            </button>
            <button
              className={cx("ml-2", buttonClasses({ variant: "quiet" }))}
              disabled={!!state.busy}
              onClick={() => {
                session.useLatestBaseline();
                void session.review();
              }}
            >
              Review draft against latest source
            </button>
          </section>
        ) : null}
        {!state.baseline ? (
          tab !== "sql" && tab !== "retention" ? (
            <div data-ui="workbench-loading" className={workbenchEmptyClasses} role="status">
              {loadingError
                ? "Source is unavailable. Resolve the error and retry."
                : "Loading the authored Prisma contract…"}
            </div>
          ) : null
        ) : (
          <>
            <section
              hidden={tab !== "schema"}
              data-ui="workbench-schema"
              className="min-w-0 [&:not([hidden])]:flex [&:not([hidden])]:flex-[1_0_auto] [&:not([hidden])]:flex-col group-[:fullscreen]/workbench:min-h-0 group-[:fullscreen]/workbench:[&:not([hidden])]:flex-1"
            >
              <div
                data-ui="workbench-split"
                className="group/split grid min-w-0 flex-[1_0_420px] grid-cols-[minmax(280px,min(var(--source-width),calc(100%-289px)))_9px_minmax(280px,1fr)] overflow-hidden rounded-[7px] border border-rule-strong bg-sheet data-[mode=source]:grid-cols-1 data-[mode=diagram]:grid-cols-1 vp-850:flex vp-850:h-auto vp-850:min-h-0 vp-850:flex-none vp-850:flex-col group-[:fullscreen]/workbench:h-auto group-[:fullscreen]/workbench:min-h-60 group-[:fullscreen]/workbench:flex-1"
                data-mode={mode}
                ref={split}
                style={{ "--source-width": `${ratio}%` } as CSSProperties}
              >
                <section
                  data-ui="workbench-source-pane"
                  className="flex min-h-0 min-w-0 flex-col overflow-hidden group-data-[mode=diagram]/split:hidden vp-850:h-120 vp-850:border-b vp-850:border-rule-strong group-[:fullscreen]/workbench:h-auto group-[:fullscreen]/workbench:flex-1"
                  aria-label="Prisma source pane"
                >
                  <header data-ui="workbench-panel-header" className="shrink-0">
                    <div
                      data-ui="workbench-pane-heading"
                      className="flex min-h-[43px] flex-none flex-wrap items-center gap-2 border-b border-rule bg-sheet px-[10px] py-[5px] text-caption font-semibold vp-1100:px-1.75"
                    >
                      <span
                        title={snapshot.schema.file}
                        className="flex items-center gap-2 whitespace-nowrap"
                      >
                        <Code2 size={15} aria-hidden />
                        <span className="font-mono">contract.prisma</span>
                      </span>
                      {mode !== "diagram" ? sourceStatus : null}
                      {interactiveAccess && <button
                        ref={accessTrigger}
                        className={cx(workbenchSegmentClasses("text"), "aria-expanded:border-selected-rule aria-expanded:bg-selected aria-expanded:text-selected-ink")}
                        aria-expanded={!!access}
                        aria-haspopup="dialog"
                        aria-controls={access ? "prisma-access-popup" : undefined}
                        onClick={({ currentTarget }) => inspectAt(cursor.line, elementAnchor(currentTarget), () => accessTrigger.current?.focus())}
                      >
                        <Shield size={14} className="mr-1.5" aria-hidden /> Access
                      </button>}
                      <a
                        className={iconButtonClasses({ variant: "quiet", size: "compact" })}
                        aria-label="Open in editor"
                        title="Open contract.prisma in editor"
                        href={editorLink(snapshot.repositoryRoot, {
                          file: snapshot.schema.file,
                          line: 1,
                          column: 1,
                          start: 0,
                          end: 0,
                        })}
                      >
                        <ExternalLink size={15} aria-hidden />
                      </a>
                      {mode === "source" ? workspaceControls : null}
                    </div>
                    {mode !== "diagram" ? sourceActions : null}
                  </header>
                  <PrismaEditor
                    ref={editor}
                    value={state.source}
                    visible={tab === "schema" && mode !== "diagram"}
                    onChange={(source) => session.setSource(source)}
                    onCursor={cursorChanged}
                    diagnostics={validationCurrent ? state.validation?.diagnostics : liveAccessDiagnostics}
                    readOnly={!!state.busy}
                    interactiveAccess={interactiveAccess}
                    accessModules={accessModules}
                    validatedSource={validationCurrent && valid ? state.source : undefined}
                    onSave={() => void session.review()}
                    onFormat={() => void format()}
                    onFieldAccess={(position, anchor) =>
                      inspectAt(editor.current?.lineNumberAt(position) ?? 1, anchor, () => {
                        const trigger = anchor.element;
                        if (trigger instanceof HTMLElement && trigger.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
                        else editor.current?.focus();
                      })
                    }
                  />
                  <footer
                    data-ui="workbench-editor-status"
                    className="flex h-8 shrink-0 items-center justify-between gap-[6px] border-t border-rule px-[10px] font-mono text-micro text-graphite [line-height:normal]"
                  >
                    <span>
                      Ln {cursor.line}, Col {cursor.column}
                    </span>

                    <span className="vp-1100:hidden">⌘/Ctrl Alt F find{interactiveAccess && ` · ${FIELD_ACCESS_SHORTCUT} access`}</span>
                  </footer>
                </section>
                <div
                  data-ui="workbench-resizer"
                  className="cursor-col-resize touch-none border-x border-rule bg-paper hover:bg-dev focus-visible:bg-dev focus-visible:-outline-offset-2 group-data-[mode=source]/split:hidden group-data-[mode=diagram]/split:hidden vp-850:hidden"
                  role="separator"
                  tabIndex={0}
                  aria-label="Resize source and diagram"
                  aria-orientation="vertical"
                  aria-valuemin={25}
                  aria-valuemax={75}
                  aria-valuenow={ratio}
                  onKeyDown={(event) => {
                    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      setRatio((value) =>
                        event.key === "Home"
                          ? 25
                          : event.key === "End"
                            ? 75
                            : Math.max(
                                25,
                                Math.min(75, value + (event.key === "ArrowLeft" ? -2 : 2)),
                              ),
                      );
                    }
                  }}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !split.current)
                      return;
                    const bounds = split.current.getBoundingClientRect();
                    setRatio(
                      Math.max(
                        25,
                        Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100),
                      ),
                    );
                  }}
                  onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
                />
                <section
                  data-ui="workbench-diagram-pane"
                  className="flex min-h-0 min-w-0 flex-col overflow-hidden group-data-[mode=source]/split:hidden vp-850:h-130 group-[:fullscreen]/workbench:h-auto group-[:fullscreen]/workbench:flex-1"
                  aria-label="Schema diagram pane"
                >
                  <header data-ui="workbench-panel-header" className="shrink-0">
                    <div
                      data-ui="workbench-pane-heading"
                      className="flex min-h-[43px] flex-none flex-wrap items-center gap-2 border-b border-rule bg-sheet px-[10px] py-[5px] text-caption font-semibold vp-1100:px-1.75 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:whitespace-nowrap"
                    >
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <Table2 size={15} aria-hidden />
                        Schema diagram
                      </span>
                      {mode === "diagram" ? sourceStatus : null}
                      {mode !== "source" ? workspaceControls : null}
                    </div>
                    {mode === "diagram" ? sourceActions : null}
                  </header>
                  {state.diagram ? (
                    <DatabaseDiagram
                      schema={state.diagram}
                      source={state.diagramSource}
                      selection={selection}
                      onSelect={setSelection}
                      onLocate={locate}
                      retained={!valid}
                      onFieldAccess={(line, element) =>
                        inspectAt(line, elementAnchor(element), () => {
                          if (element.isConnected && element.getClientRects().length) element.focus();
                          else editor.current?.focus();
                        })
                      }
                    />
                  ) : (
                    <p data-ui="empty">Validate a model to see its diagram.</p>
                  )}
                </section>
              </div>
              {popup}
              {validationCurrent && state.validation?.diagnostics.length ? (
                <section
                  data-ui="workbench-diagnostics"
                  className="mt-4 grid min-w-0 gap-2 group-[:fullscreen]/workbench:max-h-[25vh] group-[:fullscreen]/workbench:shrink-0 group-[:fullscreen]/workbench:overflow-auto"
                  aria-label="Prisma diagnostics"
                >
                  <h2 className={documentTitleClasses}>Diagnostics</h2>
                  {state.validation.diagnostics.map((diagnostic, index) => (
                    <button
                      key={index}
                      data-ui="workbench-diagnostic"
                      className="flex w-full cursor-pointer items-start gap-3 rounded-md border border-rule bg-sheet px-3 py-2 text-left font-sans text-caption text-ink hover:bg-wash vp-480:flex-wrap"
                      data-severity={diagnostic.severity}
                      onClick={() => {
                        revealSource(diagnostic.from, diagnostic.to);
                      }}
                    >
                      <strong className="max-w-50 text-micro text-refuse wrap-anywhere">
                        {diagnostic.code}
                      </strong>
                      <span className="flex-1 vp-480:basis-full">{diagnostic.message}</span>
                      <code className="text-micro whitespace-nowrap">
                        line {state.source.slice(0, diagnostic.from).split("\n").length}
                      </code>
                    </button>
                  ))}
                </section>
              ) : null}

            </section>
            <section hidden={tab !== "history"}>
              <DatabaseHistory
                mode={sourceMode}
                observation={state.observation}
                snapshotRevision={snapshot.revision}
                active={tab === "history"}
                saved={state.baseline}
                draft={state.source}
                draftValidation={valid ? state.validation : undefined}
                dirty={session.dirty}
                onInstalled={() => {
                  session.invalidateObservation();
                  void load();
                }}
              />
            </section>
            <section hidden={tab !== "database"}>
              <DatabaseEvidence
                active={tab === "database"}
                workbench={state.latest ?? state.baseline}
                session={session}
                observation={state.observation}
                dirty={session.dirty}
                onRefresh={() => void load()}
              />
            </section>
          </>
        )}
        <section hidden={tab !== "sql"}>
          <DatabaseSql active={tab === "sql"} mode={sourceMode} />
        </section>
        {tab === "retention" ? <DataRetention kind="database" /> : null}
      </div>
      {state.review ? (
        <WorkbenchDialog
          title="Review source changes"
          busy={state.busy === "save"}
          onClose={() => session.closeReview()}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                autoFocus
                disabled={!!state.busy}
                onClick={() => session.closeReview()}
              >
                Back to editing
              </button>
              <button
                data-variant="primary"
                className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                disabled={!!state.busy || session.conflict}
                onClick={() => void save()}
              >
                {state.busy === "save" ? "Saving…" : "Save schema"}
              </button>
            </>
          }
        >
          <p className="text-label">
            Review the complete source before saving. The file revision and Prisma validation are
            checked again before writing.
          </p>
          <ul className="text-caption leading-[1.8]">
            {state.review.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          <AccessPolicyChanges changes={state.review.contractImpact?.accessChanges} />
          <SourceComparison before={state.review.before} after={state.review.after} />
          <p className="m-0 text-caption text-graphite">
            After saving, generate application artifacts and review downstream types, repositories,
            GraphQL exposure and writable-field policies. Plan a migration separately when storage
            changes.
          </p>
        </WorkbenchDialog>
      ) : null}
      {guard ? (
        <WorkbenchDialog
          title={guard === "navigation" ? "Leave your schema draft?" : "Discard schema draft?"}
          onClose={closeGuard}
          busy={!!state.busy}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                autoFocus
                disabled={!!state.busy}
                onClick={closeGuard}
              >
                Keep editing
              </button>
              <button
                className={buttonClasses({ variant: "quiet" })}
                disabled={!!state.busy}
                onClick={discard}
              >
                {guard === "navigation" ? "Discard and continue" : "Discard draft"}
              </button>
              <button
                data-variant="primary"
                className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                disabled={!!state.busy || session.conflict}
                onClick={() => {
                  closeGuard();
                  void session.review();
                }}
              >
                Review source changes
              </button>
            </>
          }
        >
          <p className="text-label">
            Your unsaved Prisma text will be replaced with the latest saved source. No database or
            migration is changed. Editor undo can recover discarded text during this session.
          </p>
        </WorkbenchDialog>
      ) : null}
      {/* Native fullscreen hides Shell's notifications outside this element. */}
      {fullscreen ? (
        <NotificationStack fullscreen toasts={toasts} onDismiss={dismissToast} />
      ) : null}
    </div>
  );
}

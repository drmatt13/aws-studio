import { buttonClasses } from "../ui/Button";
import { iconButtonClasses } from "../ui/IconButton";
import { cx } from "../ui/classes";
import { NotificationStack } from "../ui/NotificationStack";
import { Link, useLocation } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { SOURCE_HOLD_NOTE, type CommandResult } from "../../shared/api";
import { api } from "../api";
import { prepareAgentPrompt } from "../activity";
import { useHealthAnnouncements, type HealthAnnouncement } from "../health/announcements";
import { healthAgentPrompt, type HealthCondition } from "../health/conditions";
import { HealthPanel, type HealthRecovery } from "../health/HealthPanel";
import { HealthStatus } from "../health/HealthStatus";
import { useHealth } from "../health/useHealth";
import { ApiError } from "../http";
import { useStudio } from "../studio";
import { EditDialog } from "./EditDialog";
import { Inspector } from "./Inspector";
import { UnsavedChangesDialog } from "./DraftControls";
import { SourceRecoveryPanel } from "./SourceRecovery";
import { navigationItemClasses, NavigationStrip } from "./NavigationStrip";
import { AppNameMenu } from "./AppName";
import { SourceEnvironment } from "./SourceContext";
import { GlobalActivity } from "./GlobalActivity";
import { GlobalDockerStatus } from "../machine/docker";

const HEALTH_PANEL_ID = "configuration-health";

/**
 * Stays mounted so closing can fade: `hidden` ends the transition with display:none,
 * which also takes it out of the tab order and the accessibility tree.
 */
function Drawer(props: {
  readonly open: boolean;
  readonly view: string;
  readonly title: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { open, view, returnFocus } = props;
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      if (!wasOpen.current) opener.current = document.activeElement;
      close.current?.focus();
    } else if (wasOpen.current) {
      const origin = opener.current;
      const restorable = origin instanceof HTMLElement && origin !== document.body && origin.isConnected;
      // After recovery the indicator has gone, so focus lands on the workspace rather than the body.
      (restorable ? origin : returnFocus.current ?? document.querySelector<HTMLElement>('[data-ui="canvas"]'))?.focus();
    }
    wasOpen.current = open;
  }, [open, view, returnFocus]);
  return (
    <aside
      id={HEALTH_PANEL_ID}
      hidden={!open}
      data-ui="drawer"
      className="fixed top-[calc(var(--bar)+12px)] right-4 z-20 flex max-h-[max(240px,calc(100dvh-var(--bar)-var(--activity-bar-height,40px)-var(--activity-drawer-visible,0px)-25px))] w-[min(620px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-rule-strong bg-sheet text-body leading-[1.5] shadow-[0_18px_50px_-24px_light-dark(#233c604f,color-mix(in_srgb,var(--ink)_60%,transparent))] transition-[opacity,translate,display] transition-discrete duration-160 ease-[cubic-bezier(0.22,1,0.36,1)] starting:-translate-y-1 starting:opacity-0 motion-reduce:transition-none [&[hidden]]:-translate-y-1 [&[hidden]]:opacity-0 vp-700:top-3 vp-700:max-h-[calc(100dvh-24px)]"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header className="flex flex-none items-center justify-between border-b border-rule px-5 py-3">
        <h2 id={id} className="m-0 font-sans text-[16px] text-balance">
          {props.title}
        </h2>
        <button
          ref={close}
          className={iconButtonClasses({ className: "coarse:min-h-11" })}
          onClick={props.onClose}
          aria-label={`Close ${props.title}`}
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 gap-4 overflow-auto overscroll-contain p-5">
        {props.children}
      </div>
    </aside>
  );
}

function CommandOutput(props: {
  readonly result: CommandResult | undefined;
  readonly onBack: () => void;
  readonly onRun: (name: string, confirmed: boolean) => void;
}) {
  const studio = useStudio();
  const { live } = studio;
  const result = props.result;
  const stale =
    result && result.exitCode !== 0 && /generat|stale|out of date|differs/i.test(result.output);
  return (
    <>
      <button
        className={buttonClasses({ variant: "link", className: "text-caption coarse:min-h-11" })}
        onClick={props.onBack}
      >
        Back to configuration health
      </button>
      {result ? (
        <>
          <p className="text-caption text-graphite">
            Finished in {(result.durationMs / 1000).toFixed(1)}s with exit code{" "}
            {String(result.exitCode)}.
          </p>
          {stale ? (
            <p>
              Generated files no longer match the config.{" "}
              <button
                className={buttonClasses({ variant: "quiet", className: "coarse:min-h-11" })}
                onClick={() => props.onRun("framework:generate", true)}
                disabled={live.running !== null || studio.draft.dirty || !!studio.draftState.busy}
              >
                Run framework:generate
              </button>{" "}
              <span className="text-caption text-graphite">
                It rewrites the generated files only.
              </span>
            </p>
          ) : null}
          <pre className="m-0 font-mono text-[0.78rem] whitespace-pre-wrap wrap-anywhere">
            {result.output}
          </pre>
        </>
      ) : (
        <p className="text-graphite">The output appears here when it finishes.</p>
      )}
    </>
  );
}

export function Shell(props: {
  readonly children: ReactNode;
  /** The latest snapshot request: its failure is a health condition, not a banner. */
  readonly refresh?: { readonly failure: string | undefined; readonly retrying: boolean; readonly retry: () => void };
}) {
  const studio = useStudio();
  const { snapshot, response, live, toast, toasts, dismissToast, selected } = studio;
  const pathname = useLocation({ select: (location) => location.pathname });
  const databasePage = pathname === "/database" || pathname.startsWith("/database/");
  // Isometric hosts the inspector in its own side panel, below the map toolbar.
  const isometricPage = useLocation({ select: (location) => location.pathname === "/" });
  const { conditions, indicator } = useHealth(props.refresh?.failure);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSource = async () => {
    setRefreshing(true);
    try {
      await api.refreshSource();
      toast("Source reloaded. Any draft is preserved for review.");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "refuse");
    } finally {
      setRefreshing(false);
    }
  };
  const showInspector =
    !!selected && !isometricPage && !(databasePage && selected.startsWith("schema:"));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<"health" | "command">("health");
  const [result, setResult] = useState<CommandResult | undefined>();
  const healthStatus = useRef<HTMLButtonElement>(null);
  const openHealth = useCallback(() => {
    setDrawerView("health");
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const announce = useCallback((item: HealthAnnouncement) => {
    toast(item.text, item.tone, {
      key: `health:${item.condition}`,
      ...(item.opensHealth ? { action: { label: "Show details", run: openHealth } } : {}),
    });
  }, [openHealth, toast]);
  useHealthAnnouncements(conditions, announce, drawerOpen && drawerView === "health");

  const run = async (name: string, confirmed: boolean) => {
    setResult(undefined);
    setDrawerView("command");
    setDrawerOpen(true);
    try {
      setResult(await api.command(name, confirmed));
    } catch (error) {
      setDrawerOpen(false);
      toast(error instanceof ApiError ? error.message : String(error), "refuse");
    }
  };
  const askAgent = (condition: HealthCondition) => {
    setDrawerOpen(false);
    prepareAgentPrompt(healthAgentPrompt(condition));
  };
  const recovery: HealthRecovery = {
    reloading: refreshing,
    reloadDisabled: refreshing || live.evaluating,
    onReload: () => void refreshSource(),
    retrying: props.refresh?.retrying ?? false,
    onRetry: () => props.refresh?.retry(),
    onAskAgent: askAgent,
    onShowEntity: studio.select,
  };
  const drawerTitle = drawerView === "health"
    ? "Configuration health"
    : result
      ? `${result.command} ${result.exitCode === 0 ? "passed" : "failed"}`
      : `Running ${live.running ?? "a command"}…`;

  return (
    <div
      data-ui="shell"
      className={cx(
        "relative grid h-full grid-rows-[var(--bar)_minmax(0,1fr)_auto] [--health-slot:28px] coarse:[--health-slot:44px] vp-760:[--bar:89px] vp-560:[--bar:129px] transition-[--activity-drawer-visible] duration-280 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none [&[data-activity-resizing]]:transition-none",
      )}
    >
      <GlobalDockerStatus />
      <header
        data-ui="bar"
        className="grid min-h-(--bar) min-w-0 grid-cols-[auto_minmax(0,auto)_minmax(var(--health-slot),1fr)_auto] items-center gap-4 border-b border-rule bg-sheet px-4 vp-1200:gap-3 vp-760:grid-cols-[minmax(0,1fr)_auto_auto] vp-760:gap-2 vp-760:py-2"
      >
        <span className="inline-flex min-w-0 items-center font-condensed text-step1 font-semibold tracking-[0.01em] whitespace-nowrap vp-760:col-start-1 vp-760:row-start-1">
          AWS Studio
          <AppNameMenu />
        </span>
        <NavigationStrip
          className="vp-760:col-span-full vp-760:row-start-2 vp-560:row-start-3"
          label="Views"
          activeKey={pathname}
        >
          <Link
            to="/"
            search={(previous: { select?: string }) => previous}
            className={navigationItemClasses}
            activeOptions={{ exact: true, includeSearch: false }}
          >
            Map
          </Link>
          <Link
            to="/database/schema"
            search={{}}
            className={navigationItemClasses}
            activeOptions={{ includeSearch: false }}
            aria-current={databasePage ? "page" : undefined}
          >
            Database
          </Link>
          <Link
            to="/deploy"
            search={{}}
            className={navigationItemClasses}
            activeOptions={{ includeSearch: false }}
          >
            Deploy
          </Link>
          <Link
            to="/graphql/schema"
            search={{}}
            className={navigationItemClasses}
            activeOptions={{ includeSearch: false }}
            aria-current={pathname.startsWith("/graphql/") ? "page" : undefined}
          >
            GraphQL
          </Link>
          <Link
            to="/cognito/user-pools"
            search={{}}
            className={navigationItemClasses}
            activeOptions={{ includeSearch: false }}
            aria-current={pathname.startsWith("/cognito/") ? "page" : undefined}
          >
            Cognito
          </Link>
          <Link
            to="/domains"
            search={{}}
            className={navigationItemClasses}
            activeOptions={{ includeSearch: false }}
          >
            Domains
          </Link>
          <Link
            to="/websockets"
            search={{}}
            className={navigationItemClasses}
            activeOptions={{ includeSearch: false }}
          >
            WebSockets
          </Link>
        </NavigationStrip>
        <HealthStatus
          ref={healthStatus}
          className="vp-760:col-start-2 vp-760:row-start-1 vp-760:min-w-(--health-slot) vp-760:[container-type:normal] vp-560:col-start-3"
          indicator={indicator}
          hold={response.sourcePublication?.status === "busy" ? SOURCE_HOLD_NOTE : null}
          expanded={drawerOpen && drawerView === "health"}
          panelId={HEALTH_PANEL_ID}
          onToggle={() => { if (drawerOpen && drawerView === "health") closeDrawer(); else openHealth(); }}
          onClose={closeDrawer}
        />
        <div className="flex items-center gap-3 vp-760:col-start-3 vp-760:row-start-1 vp-560:contents">
          <SourceEnvironment />
        </div>
      </header>
      <div
        data-studio-workspace
        data-ui="workspace"
        className={cx(
          "grid min-h-0 vp-900:grid-cols-1",
          showInspector
            ? "grid-cols-[minmax(0,1fr)_var(--inspector)] vp-900:grid-rows-[minmax(120px,1fr)_minmax(0,2fr)] has-[>[data-ui=source-watch-warning]]:grid-rows-[auto_minmax(0,1fr)] vp-900:has-[>[data-ui=source-watch-warning]]:grid-rows-[auto_minmax(180px,1fr)_auto]"
            : "grid-cols-1 vp-900:grid-rows-[minmax(0,1fr)] has-[>[data-ui=source-watch-warning]]:grid-rows-[auto_minmax(0,1fr)]",
        )}
      >
        <SourceRecoveryPanel
          initial={response.sourceRecovery}
          problem={response.sourceRecoveryProblem}
        />
        <main
          data-ui="canvas"
          data-stale={studio.model.stale || undefined}
          tabIndex={0}
          className="relative min-h-0 overflow-auto"
        >
          {props.children}
        </main>
        {showInspector ? <Inspector /> : null}
      </div>
      <GlobalActivity />
      {studio.draftState.reviewOpen ? <EditDialog review={studio.draftState.review} /> : null}
      <UnsavedChangesDialog />
      <Drawer open={drawerOpen} view={drawerView} title={drawerTitle} returnFocus={healthStatus} onClose={closeDrawer}>
        {drawerView === "health" ? (
          <HealthPanel
            conditions={conditions}
            repositoryRoot={snapshot.repositoryRoot}
            recovery={recovery}
            checkDisabled={live.running !== null || live.evaluating}
            onCheck={() => void run("framework:check", false)}
          />
        ) : (
          <CommandOutput result={result} onBack={openHealth} onRun={(name, confirmed) => void run(name, confirmed)} />
        )}
      </Drawer>
      <NotificationStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

import { usePublishSightline } from "../sightline/bridge";
import { dialogPrimaryActionClasses, dialogBodyHeadingClasses } from "../inspector-ui";
import { cx } from "../ui/classes";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { Check, History, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import type {
  DatabaseHistory as HistoryData,
  DatabaseMigration,
  DatabaseMigrationInstallResult,
  DatabaseMigrationReview,
  DatabaseSchemaComparison,
} from "../../shared/database-history";
import type { DatabaseObservation, DatabaseValidation, DatabaseWorkbench } from "../../shared/database-workbench";
import { call } from "../http";
import {
  WorkbenchDialog,
  WorkbenchListHeading,
  WorkbenchPageHeader,
  WorkbenchStatusHeading,
  workbenchCardClasses,
  workbenchCardSummaryClasses,
  workbenchChoiceClasses,
  workbenchCodeClasses,
  workbenchDetailClasses,
  workbenchDetailSummaryClasses,
  workbenchEmptyClasses,
  workbenchMasterDetailClasses,
  workbenchNoticeClasses,
  workbenchPageClasses,
  workbenchPanelClasses,
  workbenchPreClasses,
} from "./WorkbenchUI";
import {
  documentProseClasses,
  documentSubheadingClasses,
  documentSummaryClasses,
  documentSupportClasses,
  documentTitleClasses, documentCardTitleClasses,
  documentToolbarClasses,
  documentToolbarFieldClasses,
} from "./DocumentUI";

export const historyApi = {
  load: (signal?: AbortSignal) => call<HistoryData>("/database/history", undefined, signal),
  compare: (from: string, to: string, source?: string, signal?: AbortSignal) =>
    call<DatabaseSchemaComparison>("/database/history/compare", { from, to, source }, signal),
  plan: (
    body: {
      name: string;
      from: string;
      expectedSourceHash: string;
      expectedHistoryRevision: string;
    },
    signal?: AbortSignal,
  ) => call<DatabaseMigrationReview>("/database/history/plan", body, signal),
  install: (reviewId: string) =>
    call<DatabaseMigrationInstallResult>("/database/history/install", { reviewId }),
  discard: (reviewId: string) => call("/database/history/discard", { reviewId }),
};
export const shortHash = (value: string | null | undefined) =>
  value ? value.slice(0, 12) : "empty storage";

function migrationName(name: string): string {
  const words = name.replace(/^\d{8}T\d+(?:Z)?[_-]?/, "").replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}

function migrationSummary(migration: DatabaseMigration): string {
  const labels = migration.operations.map(operation => operation.label);
  return labels.length
    ? labels.slice(0, 2).join(" · ") + (labels.length > 2 ? ` · ${labels.length - 2} more` : "")
    : "No emitted storage operations";
}

function snapshotLabel(history: HistoryData, hash: string): string {
  const previous = history.migrations.find(migration => migration.to === hash);
  const next = history.migrations.find(migration => migration.from === hash);
  return previous ? `After ${migrationName(previous.name)}` : next ? `Before ${migrationName(next.name)}` : "Unlinked snapshot";
}

function MigrationOperations({
  operations,
  expanded = false,
}: {
  readonly operations: DatabaseMigration["operations"];
  readonly expanded?: boolean;
}) {
  return (
    <>
      {operations.length ? (
        operations.map((operation, index) => (
          <details
            key={`${operation.id}-${index}`}
            data-ui="workbench-card"
            className={workbenchCardClasses}
            open={expanded && index === 0}
          >
            <summary className={documentSummaryClasses}>
              <strong className="font-semibold">{operation.label}</strong>{" "}
              <span className="font-normal text-graphite">{operation.operationClass}</span>
            </summary>
            {operation.summary ? <p className={documentProseClasses}>{operation.summary}</p> : null}
            {operation.statements.map((statement, at) => (
              <div key={at} className="grid min-w-0 gap-2">
                <p className={documentSupportClasses}>
                  {statement.phase}
                  {statement.description ? ` · ${statement.description}` : ""}
                </p>
                <pre className={workbenchPreClasses}>
                  {statement.sql}
                  {statement.params?.length
                    ? `\nParameters: ${JSON.stringify(statement.params)}`
                    : ""}
                </pre>
              </div>
            ))}
          </details>
        ))
      ) : (
        <p className={workbenchEmptyClasses}>No emitted storage operations.</p>
      )}
    </>
  );
}
function Changes({ comparison }: { readonly comparison: DatabaseSchemaComparison }) {
  const visible = comparison.changes.filter(
    (change) =>
      !comparison.changes.some(
        (parent) =>
          parent !== change &&
          parent.plane === change.plane &&
          parent.kind === change.kind &&
          parent.kind !== "changed" &&
          parent.path.length < change.path.length &&
          parent.path.every((part, index) => change.path[index] === part),
      ),
  );
  return (
    <div className="grid min-w-0 gap-3">
      <div
        data-ui="workbench-provenance"
        className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-graphite"
      >
        <span>Storage: {comparison.storageChanged ? "changed" : "unchanged"}</span>
        <span>Execution: {comparison.executionChanged ? "changed" : "unchanged"}</span>
        <span>Domain: {comparison.domainChanged ? "changed" : "unchanged"}</span>
      </div>
      {!comparison.changes.length ? (
        <p className={documentProseClasses}>
          These semantic contracts are equal. Authored comments and formatting are outside this
          comparison.
        </p>
      ) : (
        <div data-ui="workbench-comparison-changes" className="grid min-w-0 gap-3">
          {(["storage", "domain", "execution"] as const).map((plane) => {
            const changes = visible.filter((change) => change.plane === plane);
            return changes.length ? (
              <section key={plane} className="grid min-w-0 gap-2">
                <h5 className="m-0 font-sans text-caption font-semibold text-graphite">
                  {plane === "storage"
                    ? "Physical storage"
                    : plane === "domain"
                      ? "Prisma models & fields"
                      : "Execution behavior"}
                </h5>
                {changes.map((change, index) => {
                  const children = comparison.changes.filter(
                    (child) =>
                      child !== change &&
                      child.plane === change.plane &&
                      child.path.length > change.path.length &&
                      change.path.every((part, at) => child.path[at] === part),
                  );
                  const path = change.path
                    .filter((part) => !["database", "namespaces", "models"].includes(part))
                    .join(" → ");
                  return (
                    <details
                      data-ui="workbench-change"
                      className={cx(
                        "min-w-0 rounded-sm border-l-2 bg-paper px-3 py-2 text-caption wrap-anywhere [&>:not(summary)]:mt-2",
                        change.kind === "added"
                          ? "border-accept"
                          : change.kind === "removed"
                            ? "border-refuse"
                            : "border-rule-strong",
                      )}
                      key={index}
                    >
                      <summary className="cursor-pointer">
                        <strong>{change.kind}</strong> · {path || change.entity}
                        {children.length ? (
                          <span className="text-caption text-graphite">
                            {" "}
                            · {children.length} nested changes
                          </span>
                        ) : null}
                      </summary>
                      {change.explanation ? (
                        <p className={documentProseClasses}>{change.explanation}</p>
                      ) : null}
                      {children.length ? (
                        <ul className="m-0 pl-5">
                          {children.map((child, at) => (
                            <li key={at}>
                              {child.kind} · {child.path.slice(change.path.length).join(" → ")}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <pre className={workbenchPreClasses}>
                        {JSON.stringify({ before: change.before, after: change.after }, null, 2)}
                      </pre>
                    </details>
                  );
                })}
              </section>
            ) : null;
          })}
        </div>
      )}
      <details className={workbenchDetailClasses}>
        <summary className={workbenchDetailSummaryClasses}>Comparison evidence and limits</summary>
        <p className={documentSupportClasses}>
          {shortHash(comparison.fromStorageHash)} → {shortHash(comparison.toStorageHash)} ·{" "}
          {new Date(comparison.observedAt).toLocaleString()}
        </p>
        {comparison.limitations.map((item) => (
          <p key={item} className={documentSupportClasses}>
            {item}
          </p>
        ))}
      </details>
    </div>
  );
}


const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Display emitted snapshot data as such; no historical PSL or source ranges are fabricated. */
function HistoricalSchema({
  contract,
  empty,
}: {
  readonly contract: unknown;
  readonly empty?: boolean;
}) {
  const namespaces = record(record(record(contract).storage).namespaces);
  return (
    <div data-ui="workbench-historical-schema" className="grid min-w-0 gap-3">
      {empty ? (
        <p className={documentSupportClasses}>Empty storage</p>
      ) : !Object.keys(namespaces).length ? (
        <p className={documentSupportClasses}>
          Semantic snapshot unavailable
        </p>
      ) : (
        Object.entries(namespaces).flatMap(([namespace, space]) =>
          Object.entries(record(record(record(space).entries).table)).map(([name, value]) => {
            const table = record(value);
            const primary = record(table.primaryKey).columns as string[] | undefined;
            return (
              <article
                key={`${namespace}.${name}`}
                className="overflow-hidden rounded-md border border-rule-strong text-meta"
              >
                <header className="bg-wash px-3 py-2">
                  <strong>
                    {namespace}.{name}
                  </strong>
                </header>
                {Object.entries(record(table.columns)).map(([column, value]) => {
                  const field = record(value);
                  return (
                    <div
                      key={column}
                      className="flex flex-wrap justify-between gap-2 border-t border-rule px-3 py-1.5"
                    >
                      <code className={workbenchCodeClasses}>{column}</code>
                      <span className="font-mono text-micro text-graphite">
                        {String(field.nativeType ?? field.codecId)}
                        {Object.keys(record(field.typeParams)).length
                          ? `(${Object.values(record(field.typeParams)).join(", ")})`
                          : ""}
                        {field.nullable ? " · nullable" : ""}
                        {primary?.includes(column) ? " · PK" : ""}
                      </span>
                    </div>
                  );
                })}
                <footer className="border-t border-rule px-3 py-2 text-micro text-graphite">
                  {Array.isArray(table.indexes) ? table.indexes.length : 0} indexes ·{" "}
                  {Array.isArray(table.foreignKeys) ? table.foreignKeys.length : 0} foreign keys
                </footer>
              </article>
            );
          }),
        )
      )}
    </div>
  );
}

export function DatabaseHistory({
  active,
  saved,
  draft,
  draftValidation,
  dirty,
  onInstalled,
  snapshotRevision,
  mode,
  observation,
}: {
  readonly mode: "dev" | "prod";
  readonly observation?: DatabaseObservation;
  readonly snapshotRevision: string;
  readonly active: boolean;
  readonly saved: DatabaseWorkbench;
  readonly draft: string;
  readonly draftValidation?: DatabaseValidation;
  readonly dirty: boolean;
  readonly onInstalled: () => void;
}) {
  const [history, setHistory] = useState<HistoryData>();
  const [selectedId, setSelectedId] = useState<string>();
  const [from, setFrom] = useState("saved");
  const [to, setTo] = useState("saved");
  const [comparison, setComparison] = useState<DatabaseSchemaComparison>();
  const [busy, setBusy] = useState<"load" | "compare" | "plan" | "install">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [planning, setPlanning] = useState(false);
  const [baseline, setBaseline] = useState("");
  const [name, setName] = useState("");
  const [review, setReview] = useState<DatabaseMigrationReview>();
  useBlocker({ shouldBlockFn: () => busy === "install", enableBeforeUnload: busy === "install" });
  const generation = useRef(0);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (review) backButton.current?.focus();
  }, [review]);
  const controller = useRef<AbortController | undefined>(undefined);
  const load = async () => {
    const id = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy("load");
    setError(undefined);
    try {
      const next = await historyApi.load(controller.current.signal);
      if (id === generation.current) {
        setHistory(next);
        setComparison(undefined);
      }
    } catch (error) {
      if (id === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === generation.current) setBusy(undefined);
    }
  };
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setBusy(undefined);
    setComparison(undefined);
    setReview(undefined);
  }, [saved.revision, saved.configRevision, draft, snapshotRevision]);
  useEffect(() => {
    if (active) void load();
    else if (busy !== "install") {
      generation.current++;
      controller.current?.abort();
      setPlanning(false);
      setReview(undefined);
    }
  }, [active, saved.revision, saved.configRevision, snapshotRevision]);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  const selected = history?.migrations.find((item) => item.id === selectedId);
  const observed = observation?.status === "observed"
    && observation.savedRevision === saved.revision
    && observation.historyRevision === history?.revision
    && observation.targetId === (mode === "dev" ? "local:postgres" : "production")
    ? observation : undefined;
  const targetLabel = mode === "dev" ? "Local PostgreSQL" : "Production database";
  const selectedComparison = selected && comparison
    && comparison.from === (selected.from ?? "empty") && comparison.to === selected.to
    ? comparison : undefined;
  usePublishSightline("databaseHistory", () => ({
    availability: busy === "load" ? "loading" : error ? "error" : history ? "available" : "not-loaded",
    selectedId, selected: selected ? { id: selected.id, name: selected.name, from: selected.from, to: selected.to, integrity: selected.integrity } : undefined, busy,
  }));
  const options = [
    { value: "saved", label: "Current saved source" },
    ...(draftValidation
      ? [{ value: "draft", label: dirty ? "Unsaved editor draft" : "Current draft (= saved)" }]
      : []),
    { value: "empty", label: "Empty storage" },
    ...(history?.snapshots.map((item) => ({
      value: item.hash,
      label: `${snapshotLabel(history, item.hash)} · ${shortHash(item.hash)}${item.available ? "" : " · unavailable"}`,
    })) ?? []),
  ];
  const compare = async (origin = from, target = to) => {
    const id = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setFrom(origin);
    setTo(target);
    setBusy("compare");
    setError(undefined);
    setComparison(undefined);
    try {
      const result = await historyApi.compare(origin, target, draft, controller.current.signal);
      if (id === generation.current) setComparison(result);
    } catch (error) {
      if (id === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === generation.current) setBusy(undefined);
    }
  };
  const choose = (migration: DatabaseMigration) => {
    setSelectedId(migration.id);
    void compare(migration.from ?? "empty", migration.to);
  };
  const plan = async () => {
    if (!history) return;
    const id = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy("plan");
    setError(undefined);
    try {
      const result = await historyApi.plan(
        {
          name,
          from: baseline,
          expectedSourceHash: saved.revision,
          expectedHistoryRevision: history.revision,
        },
        controller.current.signal,
      );
      if (id === generation.current) setReview(result);
    } catch (error) {
      if (id === generation.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === generation.current) setBusy(undefined);
    }
  };
  const discardReview = () => {
    if (busy === "install") return;
    if (review) void historyApi.discard(review.id);
    setReview(undefined);
    setPlanning(false);
  };
  const cancelPlan = () => {
    generation.current++;
    controller.current?.abort();
    setBusy(undefined);
    setNotice("Planning cancelled. The checkout and database were not changed.");
  };
  const install = async () => {
    if (!review) return;
    setBusy("install");
    setError(undefined);
    try {
      const result = await historyApi.install(review.id);
      setNotice(result.message);
      setReview(undefined);
      setPlanning(false);
      onInstalled();
      void load();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };
  const statusLabel = observed
    ? observed.migrationState.status === "current" ? "Migration history current"
      : observed.migrationState.status === "pending" ? "Migrations pending"
      : observed.migrationState.status === "divergent" ? "History needs review" : "Needs inspection"
    : "Not checked";
  const statusTone = !observed ? "neutral"
    : observed.migrationState.status === "current" ? "accept"
    : observed.migrationState.status === "pending" || observed.migrationState.status === "divergent" ? "caution" : "neutral";
  return (
    <div data-ui="workbench-history" className={workbenchPageClasses}>
      <WorkbenchPageHeader
        icon={History}
        title="Migrations"
        description="Review schema changes and prepare the next migration. Migration files are shared by Development and Production; each database applies them separately."
        actions={
          <>
            <button
              className={buttonClasses({ variant: "quiet" })}
              disabled={!!busy}
              onClick={() => void load()}
            >
              <RefreshCw size={14} aria-hidden /> Refresh history
            </button>
            <button
              data-variant="primary"
              className={buttonClasses({ variant: "primary" })}
              disabled={!!busy || !history || dirty || !saved.validation.valid}
              title={
                dirty
                  ? "Save or discard the draft before planning from saved source"
                  : "Creates a review in a disposable source copy; no checkout or database writes"
              }
              onClick={() => {
                setPlanning(true);
                setError(undefined);
              }}
            >
              Plan migration
            </button>
          </>
        }
      />
      {dirty ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses()}>
          Save your schema draft before planning a migration. You can compare it in Advanced history details.
        </p>
      ) : null}
      {notice ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses()} role="status">
          {notice}
        </p>
      ) : null}
      {error && !planning ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")} role="alert">
          {error}
        </p>
      ) : null}
      {!history ? (
        <p data-ui="workbench-empty" className={workbenchEmptyClasses}>
          {busy === "load"
            ? "Loading migrations…"
            : "History is unavailable. Refresh to retry."}
        </p>
      ) : (
        <>
          {/* The same status card as Database status: what was checked, then its state. */}
          <section aria-label="Migration application status" className={workbenchCardClasses}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <WorkbenchStatusHeading
                live={false}
                subject={targetLabel}
                tone={statusTone}
                status={<>{statusTone === "accept" ? <Check size={16} aria-hidden /> : null}{statusLabel}</>}
              />
              <Link to="/database/status" className={buttonClasses({ variant: "link" })}>Check database status</Link>
            </div>
            <p className={documentSupportClasses}>
              {observed
                ? `${observed.migrationState.message} Observed ${new Date(observed.observedAt).toLocaleString()}.`
                : mode === "dev"
                  ? "Inspect local PostgreSQL to see which migrations it has applied."
                  : "Inspect the named production deployment to check its migration state."}
            </p>
          </section>
          {history.issues.length ? (
            <details data-ui="workbench-notice" className={workbenchNoticeClasses("warning")}>
              <summary className="cursor-pointer font-semibold">{history.issues.length} history findings · review before planning</summary>
              {history.issues.map((issue, index) => (
                <p key={index} className="mt-2 mb-0 text-caption">
                  <strong>{issue.code}</strong> {issue.message}{" "}
                  {issue.path ? <code>{issue.path}</code> : null}
                </p>
              ))}
            </details>
          ) : null}
          <div data-ui="workbench-history-grid" className={workbenchMasterDetailClasses}>
            <nav
              data-ui="workbench-history-list"
              className={workbenchPanelClasses("grid content-start gap-2")}
              aria-label="Migration graph"
            >
              <WorkbenchListHeading count={history.migrations.length}>In this checkout</WorkbenchListHeading>
              {history.migrations.length ? (
                <div className="grid gap-1">
                  {history.migrations.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((migration) => {
                    const applied = observed?.ledger.find(item => item.migrationHash === migration.migrationHash);
                    return <button
                      data-ui="workbench-history-edge"
                      className={workbenchChoiceClasses}
                      key={migration.id}
                      aria-pressed={selectedId === migration.id}
                      onClick={() => choose(migration)}
                    >
                      <strong className="text-label wrap-anywhere">{migrationName(migration.name)}</strong>
                      <span className="text-caption text-graphite wrap-anywhere">{migrationSummary(migration)}</span>
                      <span className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-graphite">
                        <span>Created {new Date(migration.createdAt).toLocaleDateString()}</span>
                        {migration.integrity !== "verified" || migration.pendingPlaceholders || migration.issues.length
                          ? <span className="text-refuse">Needs review</span> : null}
                        {observed ? <span title={applied ? `Applied ${new Date(applied.appliedAt).toLocaleString()}` : "This migration is absent from the inspected database ledger."}>
                          {applied ? "Applied" : "Not recorded"}
                        </span> : null}
                      </span>
                    </button>;
                  })}
                </div>
              ) : (
                <p className="m-0 px-3 text-caption text-graphite">No migrations yet.</p>
              )}
              <p className="m-0 px-3 text-meta text-graphite">Read {new Date(history.observedAt).toLocaleTimeString()}</p>
            </nav>
            <div data-ui="workbench-history-detail" className="grid min-w-0 gap-4">
              {selected ? (
                <>
                  <section data-ui="workbench-card" className={workbenchCardClasses}>
                    <div className="grid min-w-0 gap-1">
                      <h3 className={documentCardTitleClasses}>{migrationName(selected.name)}</h3>
                      <p className={documentSupportClasses}>
                        Created {new Date(selected.createdAt).toLocaleString()} · {selected.operations.length} {selected.operations.length === 1 ? "operation" : "operations"}
                      </p>
                    </div>
                    {selected.pendingPlaceholders ? (
                      <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")}>
                        Data transformation placeholders remain. Implement them before applying this migration.
                      </p>
                    ) : null}
                    {selected.integrity === "modified" ? (
                      <p data-ui="workbench-notice" className={workbenchNoticeClasses("warning")}>
                        This package was modified. Review its integrity findings before application.
                      </p>
                    ) : null}
                    {selected.issues.map((issue, index) => <p key={index} className={documentProseClasses}>{issue.message}</p>)}
                    <h4 className={documentSubheadingClasses}>Schema changes</h4>
                    {selectedComparison ? <Changes comparison={selectedComparison} /> : (
                      <p className={documentSupportClasses} role={busy === "compare" ? "status" : undefined}>
                        {busy === "compare" ? "Comparing the schema before and after this migration…" : "Select this migration to compare its before and after schema."}
                      </p>
                    )}
                  </section>
                  <section aria-label="Migration changes and SQL" className="grid min-w-0 gap-3">
                    <h3 className={documentTitleClasses}>Changes & SQL</h3>
                    <MigrationOperations operations={selected.operations} expanded />
                    <details data-ui="workbench-card" className={workbenchCardClasses}>
                      <summary className={documentSummaryClasses}>Migration source</summary>
                      <p className={documentSupportClasses}>{selected.sourcePath}</p>
                      <pre className={workbenchPreClasses}>{selected.source ?? "Source unavailable"}</pre>
                    </details>
                  </section>
                </>
              ) : (
                <section data-ui="workbench-empty" className={workbenchEmptyClasses}>
                  <h3 className={cx(documentTitleClasses, "text-ink")}>{history.migrations.length ? "Review a migration" : "Prepare your first migration"}</h3>
                  <p className="m-0">
                    {history.migrations.length
                      ? "Select a named change to see the affected schema, operations and SQL."
                      : "Save your schema, then choose Plan migration. Planning prepares files for review using your saved schema and an explicit empty baseline."}
                  </p>
                  <p className="m-0 text-caption">
                    Planning saves no source or database changes. Review the package, save its files, then apply it separately in Database status.
                  </p>
                </section>
              )}
            </div>
          </div>
          <details data-ui="workbench-history-advanced" className={workbenchCardClasses}>
            <summary className={workbenchCardSummaryClasses}>Advanced history details</summary>
            <section className="grid min-w-0 gap-3">
              <h3 className={documentSubheadingClasses}>Compare any two schemas</h3>
              <div data-ui="workbench-comparison-controls" className={documentToolbarClasses}>
                <label className={documentToolbarFieldClasses}>
                  From
                  <Select value={from} disabled={!!busy} onChange={(event) => { setFrom(event.target.value); setComparison(undefined); }} className="w-full min-w-0">
                    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <label className={documentToolbarFieldClasses}>
                  To
                  <Select value={to} disabled={!!busy} onChange={(event) => { setTo(event.target.value); setComparison(undefined); }} className="w-full min-w-0">
                    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <button className={buttonClasses({ variant: "quiet" })} disabled={!!busy} onClick={() => { setSelectedId(undefined); void compare(); }}>
                  {busy === "compare" ? "Comparing…" : "Compare schemas"}
                </button>
              </div>
              {comparison && !selected ? <Changes comparison={comparison} /> : null}
            </section>
            <section className="grid min-w-0 gap-2 border-t border-rule pt-3">
              <h3 className={documentSubheadingClasses}>History metadata</h3>
              <p className={documentSupportClasses}>
                {history.heads.length} graph {history.heads.length === 1 ? "head" : "heads"}. Migration creation time and database application time are separate.
              </p>
              <p className={documentSupportClasses}>
                To restore an older design, create a new source change and forward migration. Existing packages stay immutable.
              </p>
              {history.refs.map(ref => <p key={`${ref.space}:${ref.name}`} className={documentSupportClasses}><strong>{ref.space}/{ref.name}</strong> · <code>{ref.hash}</code></p>)}
              {selected ? <>
                <p className={documentSupportClasses}><code>{selected.name}</code></p>
                <p className={documentSupportClasses}>
                  {selected.integrity === "verified" ? <Check size={12} aria-hidden /> : null} Metadata and emitted operation integrity: <strong>{selected.integrity}</strong>. Historical TypeScript is read as text.
                </p>
                <p className={documentSupportClasses}><code>{shortHash(selected.from)} → {shortHash(selected.to)}</code></p>
                <div data-ui="workbench-historical-pair" className="mt-2 grid grid-cols-2 gap-4 vp-700:grid-cols-1">
                  {[{ hash: selected.from, label: "Before" }, { hash: selected.to, label: "After" }].map(item => (
                    <details key={item.label} className={workbenchDetailClasses}>
                      <summary className={documentSummaryClasses}>{item.label} semantic snapshot</summary>
                      <p className={documentSupportClasses}>Emitted contract JSON; original Prisma text and comments are not preserved.</p>
                      <HistoricalSchema empty={!item.hash} contract={history.snapshots.find(snapshot => snapshot.hash === item.hash)?.contract} />
                      <details className={workbenchDetailClasses}>
                        <summary className={workbenchDetailSummaryClasses}>Full emitted contract JSON</summary>
                        <pre className={workbenchPreClasses}>{item.hash ? JSON.stringify(history.snapshots.find(snapshot => snapshot.hash === item.hash)?.contract ?? "Snapshot unavailable", null, 2) : "Empty storage"}</pre>
                      </details>
                    </details>
                  ))}
                </div>
              </> : null}
            </section>
          </details>
        </>
      )}
      {active && planning ? (
        <WorkbenchDialog
          title={review ? "Review migration artifacts" : "Plan a forward migration"}
          onClose={discardReview}
          busy={busy === "install" || busy === "plan"}
          footer={
            <>
              {busy === "plan" ? (
                <button className={buttonClasses({ variant: "quiet" })} onClick={cancelPlan}>
                  Cancel planning
                </button>
              ) : (
                <button
                  ref={backButton}
                  className={buttonClasses({ variant: "quiet" })}
                  autoFocus
                  disabled={busy === "install"}
                  onClick={discardReview}
                >
                  Back to history
                </button>
              )}
              {review ? (
                <button
                  data-variant="primary"
                  className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                  disabled={!!busy || review.noOp}
                  onClick={() => void install()}
                >
                  {busy === "install" ? "Installing artifacts…" : "Save migration package"}
                </button>
              ) : (
                <button
                  data-variant="primary"
                  className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                  disabled={!!busy || !baseline || !name || dirty}
                  onClick={() => void plan()}
                >
                  {busy === "plan"
                    ? "Planning in disposable workspace…"
                    : "Create migration review"}
                </button>
              )}
            </>
          }
        >
          {error ? (
            <p
              data-ui="workbench-notice"
              className={workbenchNoticeClasses("warning")}
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {review ? (
            <>
              <p className="text-label">
                <strong>{review.summary}</strong>
              </p>
              <p className="text-label">
                Source: unchanged · database: not contacted · migration artifacts:{" "}
                {review.noOp ? "none needed" : "review only"}.
              </p>
              {review.warnings.map((warning, index) => (
                <p
                  key={index}
                  data-ui="workbench-notice"
                  className={workbenchNoticeClasses("warning")}
                >
                  {warning}
                </p>
              ))}
              <MigrationOperations operations={review.operations} />
              <h3 className={dialogBodyHeadingClasses}>
                Actual proposed artifacts ({review.artifacts.length})
              </h3>
              <div data-ui="workbench-plan-artifacts" className="grid gap-3">
                {review.artifacts.map((artifact) => (
                  <details
                    key={artifact.path}
                    data-ui="workbench-card"
                    className={workbenchCardClasses}
                  >
                    <summary>
                      <code className={workbenchCodeClasses}>{artifact.path}</code>
                    </summary>
                    <pre className={workbenchPreClasses}>
                      {artifact.contents}
                    </pre>
                  </details>
                ))}
              </div>
              <p className="m-0 text-caption text-graphite">
                Saving installs only the reviewed new files after rechecking source, configuration
                and migration history. Existing migration packages stay immutable. Generate
                application artifacts separately. Database application requires a separately
                reviewed target.
              </p>
            </>
          ) : (
            <>
              <p className="text-label">
                Name the change and choose the schema it starts from. Planning runs offline in a
                disposable workspace; you review the proposed files before saving them.
              </p>
              <div
                data-ui="workbench-comparison-controls"
                className="flex flex-wrap items-end gap-3"
              >
                <label className={documentToolbarFieldClasses}>
                  Migration name
                  <TextInput
                    aria-label="Migration name"
                    placeholder="add_project_summary"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={!!busy}
                  />
                </label>
                <label className={documentToolbarFieldClasses}>
                  Starting schema
                  <Select
                    aria-label="Migration baseline"
                    value={baseline}
                    onChange={(event) => setBaseline(event.target.value)}
                    disabled={!!busy}
                    className="w-full min-w-0"
                  >
                    <option value="">Choose the intended baseline…</option>
                    {history?.snapshots
                      .filter(
                        (snapshot) =>
                          snapshot.available &&
                          history.migrations.some(
                            (migration) =>
                              migration.space === "app" &&
                              (migration.from === snapshot.hash || migration.to === snapshot.hash),
                          ),
                      )
                      .map((snapshot) => (
                        <option key={snapshot.hash} value={snapshot.hash}>
                          {snapshotLabel(history, snapshot.hash)} · {shortHash(snapshot.hash)}
                          {history.heads.includes(snapshot.hash) ? " · end of branch" : ""}
                          {saved.validation.storageHash === snapshot.hash
                            ? " · matches saved schema"
                            : ""}
                        </option>
                      ))}
                    {!history?.migrations.length ? (
                      <option value="empty">Empty storage · new migration graph</option>
                    ) : null}
                  </Select>
                </label>
              </div>
              <p className="m-0 text-caption text-graphite">
                Choose the migration your change builds on. The starting schema stays an explicit
                choice, including when this checkout contains multiple branches.
              </p>
              <p
                data-ui="workbench-notice"
                className={workbenchNoticeClasses("warning")}
              >
                Required fields, drops, constraints and data transformations need human review. A
                schema plan cannot prove that existing rows satisfy a new requirement or that a
                backfill is complete.
              </p>
            </>
          )}
        </WorkbenchDialog>
      ) : null}
    </div>
  );
}

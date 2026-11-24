/** Shows target-scoped database readiness, inspection evidence, and reviewed application. */
import { usePublishSightline } from "../sightline/bridge";
import { dialogPrimaryActionClasses } from "../inspector-ui";
import { cx } from "../ui/classes";
import { TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { Check, Database as DatabaseIcon, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { localRuntimeQuery } from "../deploy/local-runtime";
import { useStudio } from "../studio";
import type { DatabaseHistory } from "../../shared/database-history";
import type {
  DatabaseObservation,
  DatabaseWorkbench,
} from "../../shared/database-workbench";
import type {
  DatabaseApplicationResult,
  DatabaseApplicationReview,
  DatabaseOperationRecord,
} from "../../shared/database-application";
import type { DatabaseSession } from "../database-session";
import { call } from "../http";
import { historyApi, shortHash } from "./DatabaseHistory";
import {
  WorkbenchDialog,
  WorkbenchPageHeader,
  WorkbenchStatusHeading,
  workbenchNoticeClasses,
  workbenchCardClasses,
  workbenchCodeClasses,
  workbenchCardSummaryClasses,
  workbenchDetailClasses,
  workbenchDetailSummaryClasses,
  workbenchEmptyClasses,
  workbenchFactRowClasses,
  workbenchPageClasses,
  workbenchPreClasses,
} from "./WorkbenchUI";
import {
  documentProseClasses,
  documentSubheadingClasses,
  documentSupportClasses,
  documentCardTitleClasses,
} from "./DocumentUI";
import { noticeClasses } from "../ui/Surface";
import { DatabaseCloud } from "./DatabaseCloud";

function readinessLabel({
  inspecting,
  engine,
  current,
  drift,
  migrationState,
  ready,
}: {
  readonly inspecting: boolean;
  readonly engine?: string;
  readonly current?: DatabaseObservation;
  readonly drift: boolean;
  readonly migrationState: DatabaseObservation["migrationState"]["status"];
  readonly ready: boolean;
}): string {
  if (inspecting) return "Checking database…";
  if (engine === "missing") return "Docker is not installed";
  if (engine === "stopped") return "Docker is stopped";
  if (!current) return "Not checked";
  if (current.status === "unreachable") return "Database is unreachable";
  if (current.status !== "observed") return "Inspection needs attention";
  if (drift) return "Schema needs review";
  if (migrationState === "pending") return "Migrations pending";
  if (ready) return "Ready";
  if (current.marker.status === "missing") return "Database needs setup";
  return "Database needs review";
}

export function DatabaseEvidence({
  active,
  workbench,
  session,
  observation,
  dirty,
  onRefresh,
}: {
  readonly active: boolean;
  readonly workbench: DatabaseWorkbench;
  readonly session: DatabaseSession;
  readonly observation?: DatabaseObservation;
  readonly dirty: boolean;
  readonly onRefresh: () => void;
}) {
  const { mode, snapshot } = useStudio();
  const targetId = mode === "prod" ? "production" : "local:postgres";
  const runtime = useQuery({
    ...localRuntimeQuery(snapshot.repositoryRoot),
    enabled: active && mode === "dev",
    refetchInterval: active && mode === "dev" ? 5000 : false,
  });
  const [history, setHistory] = useState<DatabaseHistory>();
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState<string>();
  const [application, setApplication] = useState<DatabaseApplicationReview>();
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [applicationResult, setApplicationResult] =
    useState<DatabaseApplicationResult>();
  const [operations, setOperations] = useState<DatabaseOperationRecord[]>([]);
  const [operationError, setOperationError] = useState<string>();
  const [cloudBusy, setCloudBusy] = useState(false);
  useBlocker({
    shouldBlockFn: () => applying || cloudBusy,
    enableBeforeUnload: applying || cloudBusy,
  });
  const request = useRef(0);
  const target = workbench.targets.find((item) => item.id === targetId);
  usePublishSightline("databaseTarget", () => ({
    availability: targetId ? "available" : "not-applicable",
    targetId: targetId || undefined,
    target: target
      ? { id: target.id, label: target.label, available: target.available }
      : undefined,
    inspecting,
    reviewing,
    applying,
    observation: observation
      ? {
          status: observation.status,
          observedAt: observation.observedAt,
          marker: observation.marker.status,
          physical: observation.physical.status,
          migrationState: observation.migrationState.status,
        }
      : undefined,
  }));
  useEffect(() => {
    request.current++;
    session.invalidateObservation();
    setInspecting(false);
    setReviewing(false);
    setError(undefined);
    setApplication(undefined);
    setApplicationResult(undefined);
  }, [
    targetId,
    workbench.revision,
    workbench.configRevision,
    workbench.targets.map((item) => item.identity).join(":"),
    session,
  ]);
  useEffect(() => {
    request.current++;
    setApplication(undefined);
    setConfirmation("");
    setReviewing(false);
    if (!active) setInspecting(false);
  }, [active, history?.revision]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void historyApi
      .load()
      .then((next) => {
        if (current) {
          setHistory((previous) => {
            if (previous && previous.revision !== next.revision)
              session.invalidateObservation();
            return next;
          });
        }
      })
      .catch((error) => {
        if (current)
          setError(error instanceof Error ? error.message : String(error));
      });
    void call<DatabaseOperationRecord[]>("/database/application/operations")
      .then((next) => {
        if (current) {
          setOperations(next);
          setOperationError(undefined);
        }
      })
      .catch(() => {
        if (current)
          setOperationError(
            "Database operation history could not be read. Refresh before retrying a previous unconfirmed write.",
          );
      });
    return () => {
      current = false;
    };
  }, [active, workbench, session]);
  const inspect = async () => {
    if (!target || !history) return;
    const id = ++request.current;
    const sessionRequest = session.beginObservation(target.id);
    setInspecting(true);
    setError(undefined);
    try {
      const result = await call<DatabaseObservation>(
        "/database/workbench/inspect",
        {
          targetId: target.id,
          expectedRevision: workbench.revision,
        },
      );
      if (
        id === request.current &&
        result.targetId === target.id &&
        result.targetIdentity === target.identity
      ) {
        session.acceptObservation(sessionRequest, result);
        if (result.historyRevision !== history.revision)
          void historyApi.load().then(setHistory);
      }
    } catch (error) {
      if (id === request.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === request.current) setInspecting(false);
    }
  };
  const reviewApplication = async (initialize = false) => {
    if (!target || dirty) return;
    const id = ++request.current;
    setReviewing(true);
    setError(undefined);
    setConfirmation("");
    try {
      const result = await call<DatabaseApplicationReview>(
        "/database/application/review",
        {
          targetId: target.id,
          sourceHash: workbench.revision,
          ...(initialize ? { initialize: true } : {}),
        },
      );
      if (id === request.current && result.targetIdentity === target.identity)
        setApplication(result);
    } catch (error) {
      if (id === request.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === request.current) setReviewing(false);
    }
  };
  const apply = async () => {
    if (!application) return;
    const generation = request.current;
    setApplying(true);
    setError(undefined);
    const sessionRequest = session.beginObservation(application.targetId);
    try {
      const result = await call<DatabaseApplicationResult>(
        "/database/application/apply",
        {
          reviewId: application.id,
          confirmation,
        },
      );
      if (generation === request.current) setApplicationResult(result);
      setApplication(undefined);
      void call<DatabaseOperationRecord[]>("/database/application/operations")
        .then(setOperations)
        .catch(() =>
          setOperationError(
            "Operation history could not refresh. The application result above remains authoritative.",
          ),
        );
      if (result.observation)
        session.acceptObservation(sessionRequest, result.observation);
    } catch (error) {
      if (generation === request.current)
        setError(
          `Application could not be confirmed: ${error instanceof Error ? error.message : String(error)} Inspect this target before retrying; database effects may be unconfirmed.`,
        );
      setApplication(undefined);
    } finally {
      setApplying(false);
    }
  };
  const current =
    observation &&
    observation.targetId === target?.id &&
    observation.targetIdentity === target.identity &&
    observation.savedRevision === workbench.revision &&
    (!history || observation.historyRevision === history.revision) &&
    observation.status !== "stale"
      ? observation
      : undefined;
  const migrationState = current?.migrationState.status ?? "unknown";
  const migrationLabel =
    migrationState === "current"
      ? "At saved storage contract"
      : migrationState === "pending"
        ? "Pending migration path"
        : migrationState === "divergent"
          ? "History diverges"
          : "Unknown";
  const physicalLabel =
    current?.physical.status === "matches"
      ? "Matches saved storage"
      : current?.historicalPhysical?.status === "matches"
        ? "Matches historical storage"
        : current?.physical.status === "differs"
          ? "Differs from saved storage"
          : "Unknown";
  const engine =
    mode === "dev" && !runtime.error && !runtime.data?.observationProblem
      ? runtime.data?.docker.engine
      : undefined;
  const dockerStopped = engine === "stopped" || engine === "missing";
  const drift =
    current?.historicalPhysical?.status === "differs" ||
    migrationState === "divergent" ||
    (current?.physical.status === "differs" &&
      current.historicalPhysical?.status !== "matches");
  const ready =
    current?.status === "observed" &&
    migrationState === "current" &&
    current.physical.status === "matches";
  const readiness = readinessLabel({ inspecting, engine, current, drift, migrationState, ready });
  return (
    <div data-ui="workbench-evidence" className={workbenchPageClasses}>
      <WorkbenchPageHeader
        icon={DatabaseIcon}
        title={mode === "prod" ? "Production database" : "Local database"}
        description={
          mode === "prod"
            ? "Inspect the named production deployment before reviewing database changes."
            : "Check PostgreSQL, review pending migrations, and get ready to develop."
        }
        actions={
          <button
            className={buttonClasses({ variant: "quiet" })}
            onClick={() => {
              onRefresh();
              if (mode === "dev") void runtime.refetch();
            }}
          >
            <RefreshCw size={14} aria-hidden /> Refresh source
          </button>
        }
      />
      {mode === "dev" ? (
        <section aria-label="Database readiness" className={workbenchCardClasses}>
          <WorkbenchStatusHeading
            subject={target?.label ?? "Local PostgreSQL"}
            status={readiness}
            tone={ready && !dockerStopped ? "accept" : "neutral"}
          />
          <div className="grid gap-1">
            <p className={documentProseClasses}>
              {dockerStopped
                ? "Open development setup to start Docker and prepare the local runtime."
                : current
                  ? current.message
                  : runtime.data?.readiness?.state === "ready"
                    ? "Local services are running. Inspect to verify the database against the saved schema."
                    : "Inspect to check this database against the saved schema. Starting development prepares proven empty storage automatically."}
            </p>
            {current ? (
              <p className={documentSupportClasses}>
                Last checked {new Date(current.observedAt).toLocaleString()}
              </p>
            ) : null}
          </div>
          <div
            data-ui="workbench-observation-heading"
            className="flex flex-wrap items-center gap-x-4 gap-y-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                data-variant="primary"
                className={buttonClasses({ variant: "primary" })}
                disabled={
                  !target?.available ||
                  !history ||
                  inspecting ||
                  applying ||
                  reviewing ||
                  cloudBusy ||
                  dockerStopped
                }
                onClick={() => void inspect()}
              >
                {inspecting ? "Inspecting selected database…" : "Inspect database"}
              </button>
              {current?.migrationState.status === "pending" &&
              target?.id === "local:postgres" ? (
                <button
                  className={buttonClasses({ variant: "quiet" })}
                  disabled={dirty || reviewing || applying}
                  onClick={() => void reviewApplication()}
                >
                  {reviewing ? "Reviewing pending migrations…" : "Review pending migrations"}
                </button>
              ) : null}
              {current?.status === "observed" &&
              current.marker.status === "missing" &&
              target?.id === "local:postgres" ? (
                <button
                  className={buttonClasses({ variant: "quiet" })}
                  disabled={dirty || reviewing || applying}
                  onClick={() => void reviewApplication(true)}
                >
                  {reviewing
                    ? "Checking empty database and planning…"
                    : "Review empty database initialization"}
                </button>
              ) : null}
            </div>
            {dockerStopped || (!current && runtime.data?.readiness?.state !== "ready") ? (
              <Link to="/deploy" className={buttonClasses({ variant: "link" })}>
                Open development setup
              </Link>
            ) : null}
            {current && (drift || migrationState === "pending") ? (
              <Link to="/database/history" className={buttonClasses({ variant: "link" })}>
                Review migration history
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}
      {!target ? (
        <p role="alert" className={noticeClasses()}>
          No database target is configured for this declaration mode. Check its
          declaration, then refresh.
        </p>
      ) : null}
      {target?.handoffs?.length ? (
        <DatabaseCloud
          target={target}
          active={active}
          sourceContext={JSON.stringify([
            workbench.revision,
            workbench.configRevision,
            history?.revision,
            snapshot.revision,
          ])}
          dirty={dirty}
          onBusyChange={setCloudBusy}
          onOutcome={() => {
            void call<DatabaseOperationRecord[]>(
              "/database/application/operations",
            )
              .then(setOperations)
              .catch(() =>
                setOperationError(
                  "Operation history could not refresh. Inspect the recorded task before retrying.",
                ),
              );
          }}
        />
      ) : target?.id === "production" ? (
        <section aria-label="Database readiness" className={workbenchCardClasses}>
          <WorkbenchStatusHeading subject={target.label} status="Not checked" />
          <p className={documentProseClasses}>
            No valid production targets were found. Configure the named
            production deployment in cdk-app/cdk.json, then refresh. No database
            command has run.
          </p>
        </section>
      ) : null}
      {dirty ? (
        <p data-ui="workbench-notice" className={workbenchNoticeClasses()}>
          Your unsaved draft differs from saved source. This inspection compares
          the database with the <strong>saved authored contract</strong>; the
          editor draft is a separate proposal.
        </p>
      ) : null}
      {error ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses("warning")}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {applicationResult ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses(
            ["applied", "unchanged"].includes(applicationResult.status)
              ? "neutral"
              : "warning",
          )}
          role="status"
        >
          {applicationResult.message}
        </p>
      ) : null}
      {applicationResult?.diagnostic ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses("warning")}
          role="alert"
        >
          <code>{applicationResult.diagnostic.code}</code>
          {applicationResult.diagnostic.sqlState
            ? ` · SQLSTATE ${applicationResult.diagnostic.sqlState}`
            : ""}{" "}
          · {applicationResult.diagnostic.action}{" "}
          <button
            className={cx("ml-2", buttonClasses({ variant: "quiet" }))}
            disabled={inspecting || applying}
            onClick={() => void inspect()}
          >
            Inspect again
          </button>
        </p>
      ) : null}
      {operationError ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses("warning")}
          role="alert"
        >
          {operationError}
        </p>
      ) : null}
      {operations.length ? (
        <details data-ui="workbench-card" className={workbenchCardClasses}>
          <summary className={workbenchCardSummaryClasses}>
            Database operation history ({operations.length})
          </summary>
          <p className={documentSupportClasses}>
            Records survive Studio restarts. Interrupted operations are never
            resumed automatically; inspect the selected target and ledger before
            requesting another review.
          </p>
          {operations.map((operation) => (
            <div key={operation.id} className="grid min-w-0 gap-1 border-t border-rule pt-3">
              <h3 className={documentSubheadingClasses}>
                {operation.targetLabel} · {operation.kind} · {operation.status}
              </h3>
              <p className={documentSupportClasses}>
                {new Date(operation.startedAt).toLocaleString()} · last observed{" "}
                {new Date(operation.updatedAt).toLocaleString()} · last stage:{" "}
                {operation.stage} · source {shortHash(operation.sourceHash)}
              </p>
              <p className={documentProseClasses}>
                {operation.result?.message ??
                  operation.message ??
                  "Execution was interrupted or is still running. Database effects are unconfirmed; inspect before retrying."}
              </p>
              {operation.result?.diagnostic ? (
                <code className={workbenchCodeClasses}>
                  {operation.result.diagnostic.code}
                </code>
              ) : null}
              {operation.reviewDigest ? (
                <p className={documentSupportClasses}>
                  Reviewed operation digest{" "}
                  <code className={workbenchCodeClasses}>
                    {operation.reviewDigest}
                  </code>
                </p>
              ) : null}
              {operation.taskArn ? (
                <p className={documentSupportClasses}>
                  Task{" "}
                  <code className={workbenchCodeClasses}>
                    {operation.taskArn}
                  </code>{" "}
                  · client token{" "}
                  <code className={workbenchCodeClasses}>
                    {operation.requestId}
                  </code>
                  . Inspect this exact task and its CloudWatch stream before
                  retrying.
                </p>
              ) : null}
              {operation.cloudRecovery ? (
                <details className="min-w-0 [&[open]>:not(summary)]:mt-1">
                  <summary className={workbenchDetailSummaryClasses}>
                    Recorded AWS recovery destination
                  </summary>
                  <p className={documentSupportClasses}>
                    Profile{" "}
                    <code className={workbenchCodeClasses}>
                      {operation.cloudRecovery.profile}
                    </code>{" "}
                    · region{" "}
                    <code className={workbenchCodeClasses}>
                      {operation.cloudRecovery.region}
                    </code>{" "}
                    · cluster{" "}
                    <code className={workbenchCodeClasses}>
                      {operation.cloudRecovery.cluster}
                    </code>
                  </p>
                  <p className={documentSupportClasses}>
                    CloudWatch group{" "}
                    <code className={workbenchCodeClasses}>
                      {operation.cloudRecovery.logGroup}
                    </code>{" "}
                    · stream{" "}
                    <code className={workbenchCodeClasses}>
                      {operation.cloudRecovery.logStream}
                    </code>
                  </p>
                  {!operation.taskArn ? (
                    <p className={documentSupportClasses}>
                      If submission returned no ARN, locate the task with ECS
                      list-tasks using started-by{" "}
                      <code className={workbenchCodeClasses}>
                        {operation.requestId}
                      </code>{" "}
                      in this recorded cluster. Do not submit another write to
                      discover its status.
                    </p>
                  ) : null}
                </details>
              ) : null}
              {operation.migrations.length ? (
                <p className={documentSupportClasses}>
                  Reviewed packages: {operation.migrations.join(", ")}
                </p>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
      <details className={workbenchCardClasses} data-ui="workbench-inspection-details">
        <summary className={workbenchCardSummaryClasses}>Inspection details</summary>
        {target ? (
          <p data-ui="workbench-target-note" className={documentSupportClasses}>
            {target.detail}
          </p>
        ) : null}
        <section
          data-ui="workbench-card workbench-representations"
          className={workbenchCardClasses}
          aria-label="Schema representations"
        >
          <h3 className={documentSubheadingClasses}>
            Five distinct sources of evidence
          </h3>
          <dl className="m-0">
            <div className={workbenchFactRowClasses}>
              <dt className="font-semibold">Editor draft</dt>
              <dd className="m-0 wrap-anywhere">
                {dirty
                  ? "Unsaved proposal · separate from this database comparison"
                  : "Same text as saved source"}
              </dd>
            </div>
            <div className={workbenchFactRowClasses}>
              <dt className="font-semibold">Saved Prisma source</dt>
              <dd className="m-0 wrap-anywhere">
                {workbench.validation.valid
                  ? "Valid contract"
                  : "Invalid contract"}{" "}
                ·{" "}
                <code className={workbenchCodeClasses}>
                  {shortHash(workbench.revision)}
                </code>
              </dd>
            </div>
            <div className={workbenchFactRowClasses}>
              <dt className="font-semibold">
                Emitted contract & migration graph
              </dt>
              <dd className="m-0 wrap-anywhere">
                {workbench.emitted?.message ??
                  "Emitted artifacts have not been observed."}
                <br />
                <span className="text-graphite">
                  {workbench.emitted?.file} ·{" "}
                  {workbench.emitted?.observedAt
                    ? `read ${new Date(workbench.emitted.observedAt).toLocaleTimeString()}`
                    : ""}{" "}
                  · {history?.heads.length ?? "?"} migration graph heads
                </span>
              </dd>
            </div>
            <div className={workbenchFactRowClasses}>
              <dt className="font-semibold">Database marker & ledger</dt>
              <dd className="m-0 wrap-anywhere">
                {current?.status === "observed"
                  ? `${current.marker.status} · ${current.ledger.length} recorded applications`
                  : "Unknown · no successful target observation"}
              </dd>
            </div>
            <div className={workbenchFactRowClasses}>
              <dt className="font-semibold">Physical PostgreSQL schema</dt>
              <dd className="m-0 wrap-anywhere">
                {current
                  ? physicalLabel
                  : "Unknown · marker equality alone is insufficient"}
              </dd>
            </div>
          </dl>
        </section>
        <div
          data-ui="workbench-evidence-grid"
          className="grid grid-cols-3 gap-3 vp-1100:grid-cols-1"
        >
          <section data-ui="workbench-card" className={workbenchCardClasses}>
            <WorkbenchStatusHeading
              live={false}
              subject="Saved source → migration history"
              status={
                history
                  ? history.heads.includes(workbench.validation.storageHash ?? "")
                    ? "Storage has a graph head"
                    : "Needs investigation"
                  : "Unknown"
              }
            />
            <p className={documentProseClasses}>
              {history?.heads.includes(workbench.validation.storageHash ?? "")
                ? "Saved storage matches a terminal contract in the on-disk migration graph. This does not establish whether any database has applied it."
                : "Compare saved source with migration history. A missing plan, branch or incomplete snapshot can prevent a known path."}
            </p>
            <p className={documentSupportClasses}>
              <code className={workbenchCodeClasses}>
                {shortHash(workbench.validation.storageHash)}
              </code>{" "}
              · {history?.migrations.length ?? "?"} migration packages
            </p>
          </section>
          <section data-ui="workbench-card" className={workbenchCardClasses}>
            <WorkbenchStatusHeading
              live={false}
              subject="Database migration evidence"
              tone={migrationState === "current" ? "accept" : migrationState === "unknown" ? "neutral" : "caution"}
              status={
                <>
                  {migrationState === "current" ? <Check size={16} aria-hidden /> : null}
                  {migrationLabel}
                </>
              }
            />
            <p className={documentProseClasses}>
              {!current
                ? "No current observation for this target. A schema file and migration folders alone cannot establish database state."
                : current.marker.status === "missing"
                  ? "No Prisma migration marker was found. The physical schema may still exist; do not infer an origin or sign it automatically."
                  : `Marker: ${current.marker.status}. ${current.marker.storageHash ? `Storage contract ${shortHash(current.marker.storageHash)}.` : ""}`}
            </p>
            {current?.ledger.length ? (
              <p className={documentSupportClasses}>
                {current.ledger.length} recorded migration applications
              </p>
            ) : null}
          </section>
          <section data-ui="workbench-card" className={workbenchCardClasses}>
            <WorkbenchStatusHeading
              live={false}
              subject="Observed physical schema"
              tone={current?.physical.status === "matches" ? "accept" : current?.physical.status === "differs" ? "caution" : "neutral"}
              status={physicalLabel}
            />
            <p className={documentProseClasses}>
              {!current
                ? "Inspect to compare PostgreSQL’s modeled schema with saved source. Matching a migration marker alone never proves a physical match."
                : current.status !== "observed"
                  ? "No physical observation was obtained for this target. Review the inspection result below."
                  : current.historicalPhysical?.status === "matches" &&
                      current.physical.status === "differs"
                    ? "The database matches the verified historical contract at its marker. A known forward path can explain the difference from saved source."
                    : current.historicalPhysical?.status === "differs"
                      ? "Physical storage differs from the known marker contract. Investigate drift before applying a migration."
                      : current.physical.status === "matches"
                        ? "Prisma strict verification accepts modeled physical storage. Data transformations, backfill completion and application correctness remain separate."
                        : "Physical evidence is incomplete or differs. Review detailed issues before deciding what changes are needed."}
            </p>
          </section>
        </div>
        {current ? (
          <section data-ui="workbench-card" className={workbenchCardClasses}>
            <h3 className={documentSubheadingClasses}>
              {target?.label} · observation
            </h3>
            <p className={documentProseClasses}>{current.message}</p>
            <div
              data-ui="workbench-provenance"
              className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-graphite"
            >
              <span>
                {current.status === "observed" ? "Observed" : "Attempted"}{" "}
                {new Date(current.observedAt).toLocaleString()}
              </span>
              <span>Baseline: {current.baseline.label}</span>
              <span>
                Source revision:{" "}
                <code className={workbenchCodeClasses}>
                  {shortHash(current.savedRevision)}
                </code>
              </span>
              <span>
                Target identity:{" "}
                <code className={workbenchCodeClasses}>
                  {shortHash(current.targetIdentity)}
                </code>
              </span>
            </div>
            {current.physical.issues.length ||
            current.physical.warnings.length ? (
              <details open className={workbenchDetailClasses}>
                <summary className={workbenchDetailSummaryClasses}>
                  Physical comparison findings
                </summary>
                {[...current.physical.issues, ...current.physical.warnings].map(
                  (issue, index) => (
                    <pre key={index} className={workbenchPreClasses}>
                      {issue}
                    </pre>
                  ),
                )}
              </details>
            ) : null}
            {current.historicalPhysical ? (
              <details
                open={current.historicalPhysical.status === "differs"}
                className={workbenchDetailClasses}
              >
                <summary className={workbenchDetailSummaryClasses}>
                  Historical physical baseline ·{" "}
                  {shortHash(current.historicalPhysical.storageHash)} ·{" "}
                  {current.historicalPhysical.status}
                </summary>
                <p className={documentSupportClasses}>
                  This separately verifies physical storage against the known
                  contract named by the database marker.
                </p>
                {[
                  ...current.historicalPhysical.issues,
                  ...current.historicalPhysical.warnings,
                ].map((issue, index) => (
                  <pre key={index} className={workbenchPreClasses}>
                    {issue}
                  </pre>
                ))}
              </details>
            ) : null}
            {current.ledger.length ? (
              <details className={workbenchDetailClasses}>
                <summary className={workbenchDetailSummaryClasses}>
                  Database application history
                </summary>
                <p className={documentSupportClasses}>
                  These are observed application times, separate from migration
                  creation.
                </p>
                {current.ledger.map((entry, index) => (
                  <p key={index} className="m-0 text-caption">
                    <strong>{entry.name}</strong> · applied{" "}
                    {new Date(entry.appliedAt).toLocaleString()}
                    <br />
                    <code className={workbenchCodeClasses}>
                      {shortHash(entry.from)} → {shortHash(entry.to)}
                    </code>
                  </p>
                ))}
              </details>
            ) : null}
            <details className={workbenchDetailClasses}>
              <summary className={workbenchDetailSummaryClasses}>Evidence limits</summary>
              {current.limits.map((limit) => (
                <p key={limit} className={documentSupportClasses}>
                  {limit}
                </p>
              ))}
            </details>
          </section>
        ) : (
          <div data-ui="workbench-empty" className={workbenchEmptyClasses}>
            {inspecting
              ? "Reading Prisma marker, application ledger and physical schema. No database writes…"
              : "Database state is unknown until an explicit inspection succeeds."}
          </div>
        )}
      </details>
      {active && application ? (
        <WorkbenchDialog
          title="Authorize reviewed database application"
          busy={applying}
          onClose={() => setApplication(undefined)}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                autoFocus
                disabled={applying}
                onClick={() => setApplication(undefined)}
              >
                Back to database status
              </button>
              <button
                data-variant="primary"
                className={cx(
                  dialogPrimaryActionClasses,
                  buttonClasses({ variant: "primary" }),
                )}
                disabled={
                  applying || confirmation !== application.confirmation || dirty
                }
                onClick={() => void apply()}
              >
                {applying
                  ? "Applying reviewed database change…"
                  : application.kind === "initialize"
                    ? "Initialize reviewed empty database"
                    : "Apply reviewed migration"}
              </button>
            </>
          }
        >
          <p className="text-label">
            <strong>{application.targetLabel}</strong> ·{" "}
            {application.kind === "initialize"
              ? "Initialize verified empty storage"
              : "Apply reviewed migration path"}{" "}
            · target identity{" "}
            <code>{shortHash(application.targetIdentity)}</code> ·{" "}
            {shortHash(application.from)} → {shortHash(application.to)}
          </p>
          <ul className="text-caption leading-[1.8]">
            {application.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          {application.initialization ? (
            <section data-ui="workbench-card" className={workbenchCardClasses}>
              <h3 className={documentCardTitleClasses}>
                Reviewed initialization SQL
              </h3>
              {application.initialization.operations.map((operation) => (
                <p key={operation.id} className={documentProseClasses}>
                  {operation.label} · {operation.operationClass}
                </p>
              ))}
              {application.initialization.statements
                ? application.initialization.statements.map(
                    (statement, index) => (
                      <pre
                        key={index}
                        className={workbenchPreClasses}
                      >
                        {statement.operationId} · {statement.phase}
                        {"\n"}
                        {statement.sql}
                        {statement.params?.length
                          ? `\nParameters: ${JSON.stringify(statement.params)}`
                          : ""}
                      </pre>
                    ),
                  )
                : application.initialization.sql.map((sql, index) => (
                    <pre
                      key={index}
                      className={workbenchPreClasses}
                    >
                      {sql}
                    </pre>
                  ))}
              <details className={workbenchDetailClasses}>
                <summary className={workbenchDetailSummaryClasses}>Prisma control schema and table DDL</summary>
                {application.initialization.controlSql?.map(
                  (statement, index) => (
                    <pre
                      key={index}
                      className={workbenchPreClasses}
                    >
                      {statement.sql}
                    </pre>
                  ),
                )}
              </details>
            </section>
          ) : null}
          {application.migrations.map((migration) => (
            <section
              data-ui="workbench-card"
              className={workbenchCardClasses}
              key={migration.id}
            >
              <h3 className={documentCardTitleClasses}>{migration.name}</h3>
              {migration.operations.map((operation, index) => (
                <div key={index}>
                  <p className={documentProseClasses}>
                    <strong>{operation.label}</strong> ·{" "}
                    {operation.operationClass}
                  </p>
                  {operation.statements.map((statement, at) => (
                    <pre
                      key={at}
                      className={workbenchPreClasses}
                    >
                      {statement.phase}
                      {"\n"}
                      {statement.sql}
                      {statement.params?.length
                        ? `\nParameters: ${JSON.stringify(statement.params)}`
                        : ""}
                    </pre>
                  ))}
                </div>
              ))}
              <details className={workbenchDetailClasses}>
                <summary className={workbenchDetailSummaryClasses}>Executable migration source</summary>
                <pre
                  className={workbenchPreClasses}
                >
                  {migration.source}
                </pre>
              </details>
            </section>
          ))}
          <p
            data-ui="workbench-notice"
            className={workbenchNoticeClasses("warning")}
          >
            This changes the selected database and may transform or delete data.
            Source undo does not roll back a database. The reviewed target and
            historical schema are checked again before execution.
          </p>
          <label
            data-ui="workbench-confirmation"
            className="mt-4 grid gap-2 text-label"
          >
            Type <strong>{application.confirmation}</strong> to authorize this
            application
            <TextInput
              aria-label="Confirm database target"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              disabled={applying}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </WorkbenchDialog>
      ) : null}
    </div>
  );
}

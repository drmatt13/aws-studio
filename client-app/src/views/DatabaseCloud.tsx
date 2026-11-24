import { usePublishSightline } from "../sightline/bridge";
import { dialogPrimaryActionClasses } from "../inspector-ui";
import { cx } from "../ui/classes";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { useEffect, useRef, useState } from "react";
import { useStudio } from "../studio";
import { AwsConnectionSummary } from "./AwsConnectionSummary";
import { useBlocker } from "@tanstack/react-router";
import type { DatabaseTarget } from "../../shared/database-workbench";
import type { DatabaseApplicationResult } from "../../shared/database-application";
import type {
  DatabaseCloudApproval,
  DatabaseCloudDestination,
} from "../../shared/database-cloud";
import { call } from "../http";
import {
  WorkbenchDialog,
  WorkbenchStatusHeading,
  workbenchCardClasses,
  workbenchDetailClasses,
  workbenchDetailSummaryClasses,
  workbenchNoticeClasses,
  workbenchCodeClasses,
  workbenchPreClasses,
} from "./WorkbenchUI";
import {
  documentProseClasses,
  documentSupportClasses,
  documentCardTitleClasses,
  inspectionActionClasses,
  inspectionControlClasses,
  inspectionFieldClasses,
} from "./DocumentUI";

/** Dialog copy follows the dialog's 13px label role. */
const dialogTextClasses = "m-0 text-label";

export const databaseCloudApi = {
  prepare: (deployment: string, profile: string) =>
    call<DatabaseCloudDestination>("/database/cloud/prepare", {
      deployment,
      profile,
    }),
  review: (destination: DatabaseCloudDestination, confirmation: string) =>
    call<DatabaseCloudApproval>("/database/cloud/review", {
      deployment: destination.identity.deployment,
      profile: destination.profile,
      preparationId: destination.id,
      confirmation,
    }),
  apply: (reviewId: string, confirmation: string) =>
    call<DatabaseApplicationResult>("/database/cloud/apply", {
      reviewId,
      confirmation,
    }),
};

export function DatabaseCloud({
  target,
  active,
  sourceContext,
  dirty,
  onOutcome,
  onBusyChange,
}: {
  readonly target: DatabaseTarget;
  readonly active: boolean;
  readonly sourceContext: string;
  readonly dirty: boolean;
  readonly onOutcome: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [deployment, setDeployment] = useState(() =>
    target.handoffs?.length === 1 ? target.handoffs[0]!.deployment : "",
  );
  const { awsProfile, mode, live } = useStudio();
  const profile = awsProfile ?? "";
  const visibility = useRef({ active, generation: 0 });
  if (visibility.current.active !== active)
    visibility.current = {
      active,
      generation: visibility.current.generation + 1,
    };
  const sourceScope = JSON.stringify([
    mode,
    profile,
    live.awsConnectionRevision,
    deployment,
    target.identity,
    sourceContext,
  ]);
  const context = JSON.stringify([sourceScope, visibility.current.generation]);
  const latest = useRef(context);
  latest.current = context;
  const [destination, setDestination] = useState<DatabaseCloudDestination>();
  const [approval, setApproval] = useState<DatabaseCloudApproval>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"preparing" | "inspecting" | "applying">();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<DatabaseApplicationResult>();
  const [inspected, setInspected] = useState<{
    at: string;
    migrations: number;
    initialize: boolean;
  }>();
  usePublishSightline("databaseCloud", () => ({
    deployment,
    targetId: target.id,
    busy,
    reviewOpen: !!approval,
  }));
  useBlocker({
    shouldBlockFn: () => busy === "inspecting" || busy === "applying",
    enableBeforeUnload: !!busy,
  });
  useEffect(() => {
    onBusyChange?.(!!busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!target.handoffs?.some((item) => item.deployment === deployment))
      setDeployment(
        target.handoffs?.length === 1 ? target.handoffs[0]!.deployment : "",
      );
  }, [target.handoffs, deployment]);
  useEffect(() => {
    setDestination(undefined);
    setApproval(undefined);
    setConfirmation("");
  }, [context]);
  useEffect(() => {
    setInspected(undefined);
    setResult(undefined);
    setError(undefined);
  }, [sourceScope]);
  const prepare = async () => {
    setBusy("preparing");
    setError(undefined);
    setResult(undefined);
    const captured = context;
    try {
      const next = await databaseCloudApi.prepare(deployment, profile);
      if (latest.current !== captured) return;
      setDestination(next);
      setConfirmation("");
    } catch (error) {
      if (latest.current === captured)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };
  const inspect = async () => {
    if (!destination) return;
    setBusy("inspecting");
    setError(undefined);
    const captured = context;
    try {
      const next = await databaseCloudApi.review(destination, confirmation);
      if (latest.current !== captured) return;
      setApproval(next);
      setInspected({
        at: new Date().toISOString(),
        migrations: next.review.migrations.length,
        initialize: next.review.kind === "initialize",
      });
      setDestination(undefined);
      setConfirmation("");
    } catch (error) {
      if (latest.current === captured) {
        setError(error instanceof Error ? error.message : String(error));
        setDestination(undefined);
      }
    } finally {
      setBusy(undefined);
      onOutcome();
    }
  };
  const apply = async () => {
    if (!approval) return;
    const captured = context;
    setBusy("applying");
    setError(undefined);
    try {
      const applied = await databaseCloudApi.apply(approval.id, confirmation);
      if (latest.current === captured) {
        setResult(applied);
        setInspected(undefined);
      }
    } catch (error) {
      if (latest.current === captured)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
      setApproval(undefined);
      onOutcome();
    }
  };
  const identity = destination?.identity ?? approval?.review.identity;
  const placement = destination ?? approval?.destination;
  return (
    <section
      data-ui="workbench-card"
      className={workbenchCardClasses}
      aria-label="Database readiness"
    >
      <WorkbenchStatusHeading
        subject={target.label}
        status={
          busy === "inspecting"
            ? "Inspecting production database…"
            : inspected
              ? inspected.initialize
                ? "Empty database reviewed"
                : inspected.migrations
                  ? `${inspected.migrations} migration${inspected.migrations === 1 ? "" : "s"} to review`
                  : "No pending migrations in the reviewed task"
              : result
                ? result.database === "applied"
                  ? "Changes applied · inspect again to verify"
                  : result.message
                : "Not checked"
        }
      />
      <div className="grid gap-1">
        <p className={documentProseClasses}>
          Check the destination, review its SQL, then authorize the database
          change separately. Read-only inspection and application each start a
          billed Fargate task. The database uses private IAM/TLS access.
        </p>
        {inspected ? (
          <p className={documentSupportClasses}>
            Last inspected {new Date(inspected.at).toLocaleString()} ·{" "}
            {deployment}
          </p>
        ) : null}
      </div>
      <div data-ui="workbench-observation-heading" className={inspectionControlClasses}>
        <AwsConnectionSummary layout="field" />
        <label className={inspectionFieldClasses}>
          Production deployment
          <Select
            aria-label="Production database deployment"
            value={deployment}
            disabled={!!busy}
            onChange={(event) => setDeployment(event.target.value)}
            className="w-full min-w-0"
          >
            <option value="">Choose a production deployment…</option>
            {target.handoffs?.map((item) => (
              <option key={item.deployment} value={item.deployment}>
                {item.deployment} · {item.account ?? "unpinned account"} ·{" "}
                {item.region ?? "unpinned region"}
              </option>
            ))}
          </Select>
        </label>
        <button
          className={buttonClasses({ variant: "quiet", className: inspectionActionClasses })}
          disabled={!deployment || !profile.trim() || !!busy || dirty}
          onClick={() => void prepare()}
        >
          {busy === "preparing"
            ? "Checking destination…"
            : "Check database task destination"}
        </button>
      </div>
      {error ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses("warning")}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {result ? (
        <p
          data-ui="workbench-notice"
          className={workbenchNoticeClasses(
            ["applied", "unchanged"].includes(result.status)
              ? "neutral"
              : "warning",
          )}
          role="status"
        >
          {result.message}
          {result.diagnostic
            ? ` ${result.diagnostic.code}: ${result.diagnostic.action}`
            : ""}
        </p>
      ) : null}
      {active && identity ? (
        <WorkbenchDialog
          title={
            destination
              ? "Authorize billed read-only database inspection"
              : approval?.review.kind === "initialize"
                ? "Review empty production database initialization"
                : "Review production SQL and authorize application"
          }
          busy={!!busy}
          onClose={() => {
            setDestination(undefined);
            setApproval(undefined);
          }}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                autoFocus
                disabled={!!busy}
                onClick={() => {
                  setDestination(undefined);
                  setApproval(undefined);
                }}
              >
                Back to database status
              </button>
              {destination ? (
                <button
                  data-variant="primary"
                  className={cx(
                    dialogPrimaryActionClasses,
                    buttonClasses({ variant: "primary" }),
                  )}
                  disabled={
                    !!busy ||
                    dirty ||
                    confirmation !== `Inspect ${identity.deployment}`
                  }
                  onClick={() => void inspect()}
                >
                  {busy === "inspecting"
                    ? "Waiting for read-only task…"
                    : "Start billed read-only task"}
                </button>
              ) : (
                <button
                  data-variant="primary"
                  className={cx(
                    dialogPrimaryActionClasses,
                    buttonClasses({ variant: "primary" }),
                  )}
                  disabled={
                    !!busy ||
                    dirty ||
                    confirmation !== approval?.confirmation ||
                    (!approval?.review.initialization &&
                      !approval?.review.migrations.length)
                  }
                  onClick={() => void apply()}
                >
                  {busy === "applying"
                    ? "Waiting for reviewed database task…"
                    : approval?.review.kind === "initialize"
                      ? "Initialize reviewed production database"
                      : "Apply reviewed production SQL"}
                </button>
              )}
            </>
          }
        >
          <p className={dialogTextClasses}>
            <strong>{identity.deployment}</strong> · account {identity.account}{" "}
            · {identity.region} · profile{" "}
            {destination?.profile ?? approval?.profile}
          </p>
          <p className={dialogTextClasses}>
            Task definition{" "}
            <code className={workbenchCodeClasses}>
              {identity.taskDefinitionArn}
            </code>{" "}
            · reviewed database protocol v1
          </p>
          {placement ? (
            <section
              data-ui="workbench-card"
              className={workbenchCardClasses}
              aria-label="Database task networking"
            >
              <h3 className={documentCardTitleClasses}>
                Declared task networking
              </h3>
              <p className={documentProseClasses}>
                Cluster{" "}
                <code className={workbenchCodeClasses}>
                  {placement.launch.cluster}
                </code>{" "}
                · {placement.launch.launchType} · platform{" "}
                {placement.launch.platformVersion} · container{" "}
                {placement.launch.containerName}
              </p>
              <p className={documentProseClasses}>
                Public IP assignment:{" "}
                <strong>
                  {placement.launch.assignPublicIp ? "Enabled" : "Disabled"}
                </strong>
                . Database access remains private with IAM/TLS.
              </p>
              <p className={documentProseClasses}>
                Subnets:{" "}
                {placement.launch.subnets.map((subnet) => (
                  <code key={subnet} className={workbenchCodeClasses}>
                    {subnet}{" "}
                  </code>
                ))}
              </p>
              <p className={documentProseClasses}>
                Security groups:{" "}
                {placement.launch.securityGroups.map((group) => (
                  <code key={group} className={workbenchCodeClasses}>
                    {group}{" "}
                  </code>
                ))}
              </p>
              <p className={documentProseClasses}>
                CloudWatch group{" "}
                <code className={workbenchCodeClasses}>
                  {placement.logs.group}
                </code>{" "}
                · stream prefix{" "}
                <code className={workbenchCodeClasses}>
                  {placement.logs.streamPrefix}
                </code>
              </p>
            </section>
          ) : null}
          {destination ? (
            <ul className="text-caption leading-[1.8]">
              {destination.effects.map((effect) => (
                <li key={effect}>{effect}</li>
              ))}
            </ul>
          ) : null}
          {approval?.review.initialization ? (
            <section data-ui="workbench-card" className={workbenchCardClasses}>
              <h3 className={documentCardTitleClasses}>
                Initialize verified empty production storage
              </h3>
              <p className={documentProseClasses}>
                No application objects, extra user schemas, large objects,
                marker or ledger may exist. The same emptiness proof and exact
                additive plan are checked again inside the writer transaction.
                Existing populated storage is never adopted or reset. This
                creates modeled storage and Prisma control metadata; IAM roles
                remain infrastructure-owned.
              </p>
              {approval.review.initialization.operations.map((operation) => (
                <p key={operation.id} className={documentProseClasses}>
                  {operation.label} · {operation.operationClass}
                </p>
              ))}
              {approval.review.initialization.statements
                ? approval.review.initialization.statements.map(
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
                : approval.review.initialization.sql.map((sql, index) => (
                    <pre
                      key={index}
                      className={workbenchPreClasses}
                    >
                      {sql}
                    </pre>
                  ))}
              <details open className={workbenchDetailClasses}>
                <summary className={workbenchDetailSummaryClasses}>Prisma control schema and table DDL</summary>
                {approval.review.initialization.controlSql?.map(
                  (statement, index) => (
                    <pre
                      key={index}
                      className={workbenchPreClasses}
                    >
                      {statement.sql}
                      {statement.params?.length
                        ? `\nParameters: ${JSON.stringify(statement.params)}`
                        : ""}
                    </pre>
                  ),
                )}
              </details>
            </section>
          ) : null}
          {approval?.review.helpers?.map((helper) => (
            <details key={helper.file} className={workbenchDetailClasses}>
              <summary className={workbenchDetailSummaryClasses}>Imported migration helper · {helper.file}</summary>
              <pre
                className={workbenchPreClasses}
              >
                {helper.source}
              </pre>
            </details>
          ))}
          {approval ? (
            <>
              <p className={dialogTextClasses}>
                Storage {approval.review.markerHash} →{" "}
                {approval.review.storageHash}
              </p>
              <p
                className={documentSupportClasses}
              >
                Exact source/image inputs, marker identities, migration ledger
                and SQL are bound to review {approval.review.digest}. Approval
                expires {new Date(approval.expiresAt).toLocaleTimeString()}.
              </p>
              {approval.review.migrations.length ? (
                approval.review.migrations.map((migration) => (
                  <section
                    data-ui="workbench-card"
                    className={workbenchCardClasses}
                    key={`${migration.spaceId}/${migration.dirName}`}
                  >
                    <h3 className={documentCardTitleClasses}>
                      {migration.spaceId}/{migration.dirName}
                    </h3>
                    {migration.sql.map((statement, index) => (
                      <pre
                        key={index}
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
                    <details className={workbenchDetailClasses}>
                      <summary className={workbenchDetailSummaryClasses}>Executable migration source</summary>
                      <pre
                        className={workbenchPreClasses}
                      >
                        {migration.source}
                      </pre>
                    </details>
                  </section>
                ))
              ) : approval.review.kind === "initialize" ? null : (
                <p className={dialogTextClasses}>
                  No pending migrations were found. The database was unchanged.
                </p>
              )}
              <p
                data-ui="workbench-notice"
                className={workbenchNoticeClasses("warning")}
              >
                {approval.review.kind === "initialize"
                  ? "Initialize starts another billed task and applies the reviewed additive SQL for modeled storage and Prisma control metadata. It repeats the empty-database check inside the writer transaction and refuses populated storage."
                  : "Apply starts another billed task and can transform or delete data. It rechecks the exact path, marker, ledger and historical physical schema inside its database transaction before SQL executes."}{" "}
                Editing source cannot roll back a database. Closing Studio does
                not cancel a submitted task; inspect its recorded ARN before
                retrying an uncertain outcome.
              </p>
            </>
          ) : null}
          <label
            data-ui="workbench-confirmation"
            className="mt-4 grid gap-2 text-label"
          >
            Type{" "}
            <strong>
              {destination
                ? `Inspect ${identity.deployment}`
                : approval?.confirmation}
            </strong>
            <TextInput
              aria-label="Confirm production database action"
              autoComplete="off"
              spellCheck={false}
              disabled={!!busy}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </WorkbenchDialog>
      ) : null}
    </section>
  );
}

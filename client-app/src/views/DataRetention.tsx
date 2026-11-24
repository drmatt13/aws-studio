import { dialogPrimaryActionClasses } from "../inspector-ui";
import { useDeploymentOverview } from "../deploy/observations";
import { InspectorSummary } from "./InspectorUI";
import { Select, TextInput } from "../ui/FormControls";
import { buttonClasses } from "../ui/Button";
import { cardClasses, noticeClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import {
  documentTitleClasses,
  documentSubheadingClasses,
  documentProseClasses,
  documentSupportClasses,
  documentSummaryClasses,
  documentCardClasses,
  pageTitleClasses,
} from "./DocumentUI";

import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Database as DatabaseIcon } from "lucide-react";
import type { Mode } from "../../shared/model";
import type {
  StatefulInventory,
  StatefulKind,
  StatefulPlan,
  StatefulSelection,
  StatefulSource,
} from "../../shared/stateful-resources";
import type { TeardownPlanView } from "../../shared/deploy";
import { call } from "../http";
import { deployApi } from "../deploy/api";
import { useStudio } from "../studio";
import { AwsConnectionSummary } from "./AwsConnectionSummary";
import {
  WorkbenchDialog,
  WorkbenchPageHeader,
  workbenchCardClasses,
  workbenchCardSummaryClasses,
  workbenchDetailSummaryClasses,
  workbenchPageClasses,
} from "./WorkbenchUI";

type RetentionAppearance = "workbench" | "document";

/**
 * Both hosts share the document type roles and card. The workbench (Database) is one level
 * shallower: its page title is the page's, its cards take the card-title role, sections sit
 * 16px apart and its page-level disclosures are cards. A document host nests all of it in a card.
 */
function retentionStyles(appearance: RetentionAppearance) {
  const document = appearance === "document";
  return {
    heading: document ? documentTitleClasses : pageTitleClasses,
    subheading: document ? documentSubheadingClasses : documentTitleClasses,
    paragraph: documentProseClasses,
    support: documentSupportClasses,
    caption: documentSupportClasses,
    label: "grid min-w-0 max-w-full gap-1 text-label",
    card: cardClasses({ variant: "document", className: "grid gap-3" }),
    content: document ? "grid min-w-0 gap-3" : workbenchPageClasses,
    // Every parent is a gap container, which owns the space above a disclosure.
    details: "min-w-0 [&[open]>:not(summary)]:mt-3",
    summary: documentSummaryClasses,
    section: document ? "min-w-0 [&[open]>:not(summary)]:mt-3" : workbenchCardClasses,
    sectionSummary: document ? documentSummaryClasses : workbenchCardSummaryClasses,
  };
}
const retentionCodeClasses = "max-w-full overflow-auto whitespace-pre-wrap wrap-anywhere";
const localOutcomeClasses =
  "flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-rule py-2 first:border-t-0 first:pt-0 last:pb-0";

const title = (kind: StatefulKind) => (kind === "database" ? "Database" : "Cognito User Pool");
const resourceType = (kind: StatefulKind) =>
  kind === "database" ? "AWS::RDS::DBInstance" : "AWS::Cognito::UserPool";

export function LifecycleDisclosure({ selection }: { readonly selection: StatefulSelection }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={documentCardClasses()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-slot="state-panel"
    >
      <summary className={documentSummaryClasses}>
        <h2 className={cx(documentTitleClasses, "inline")}>Stateful retention and retained-resource references</h2>
      </summary>
      {open ? <DataRetention appearance="document" headingLevel={3} selection={selection} /> : null}
    </details>
  );
}

export function DataRetention({
  kind,
  selection: suppliedSelection,
  appearance = "workbench",
  headingLevel = 2,
}: {
  readonly kind?: StatefulKind;
  readonly selection?: StatefulSelection;
  readonly appearance?: RetentionAppearance;
  readonly headingLevel?: 2 | 3;
}) {
  const styles = retentionStyles(appearance);
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const Subheading = headingLevel === 3 ? "h4" : "h3";
  const { snapshot, mode: selectedMode, draft, draftState, live, awsProfile } = useStudio();
  const [mode, setMode] = useState<Mode>(suppliedSelection?.mode ?? selectedMode);
  const [source, setSource] = useState<StatefulSource>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [message, setMessage] = useState<string>();
  const [plan, setPlan] = useState<StatefulPlan>();
  const connectionKey = JSON.stringify([selectedMode, awsProfile, live.awsConnectionRevision]);
  const currentConnection = useRef(connectionKey);
  currentConnection.current = connectionKey;
  const generation = useRef(0);
  const sourceBusy = draft.dirty || !!draftState.busy || live.evaluating || draft.conflict;
  const databasePage = kind === "database" && !suppliedSelection && appearance === "workbench";
  const localDatabase = databasePage && mode === "dev";
  const AwsContent = localDatabase ? "details" : "div";
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const load = async (selected: Mode, request: number) => {
    const next = await call<StatefulSource>(`/stateful-resources/source?mode=${selected}`);
    if (generation.current === request) setSource(next);
  };
  useEffect(() => {
    setMode(suppliedSelection?.mode ?? selectedMode);
  }, [suppliedSelection?.mode, selectedMode]);
  useEffect(() => {
    const request = ++generation.current;
    setSource(undefined);
    setPlan(undefined);
    setError(undefined);
    setMessage(undefined);
    void load(mode, request).catch((error) => {
      if (generation.current === request)
        setError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      generation.current++;
    };
  }, [mode, snapshot.revision]);
  useEffect(() => { setPlan(undefined); }, [selectedMode, awsProfile, live.awsConnectionRevision]);
  const kinds: readonly StatefulKind[] = kind ? [kind] : ["database", "cognito"];
  return (
    <section
      className={styles.content}
      aria-label="Stateful retention and reuse"
      data-slot="data-retention"
    >
      {databasePage ? (
        <WorkbenchPageHeader
          icon={DatabaseIcon}
          title="Data retention"
          description={
            localDatabase
              ? "Your development database keeps its data when local services stop or rebuild."
              : "Choose what happens to your production RDS database when its deployment is deleted."
          }
        />
      ) : (
        <>
          <Heading className={styles.heading}>Retention and reuse</Heading>
          <p className={styles.paragraph}>
            Configure each resource in TypeScript, review the change, then deploy separately. Existing
            policies inherit <code className={retentionCodeClasses}>RETAIN_STATEFUL_RESOURCES</code>{" "}
            until explicitly changed.
          </p>
        </>
      )}
      {error ? (
        <p className={noticeClasses()} role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className={styles.paragraph}>
          {message}
        </p>
      ) : null}
      {sourceBusy ? (
        <p className={styles.support}>
          Finish or discard the current source draft before changing lifecycle configuration.
        </p>
      ) : null}
      {databasePage ? null : <label className={styles.label}>
        Environment{" "}
        <Select
          aria-label="Retention environment"
          value={mode}
          disabled={busy || sourceBusy || !!suppliedSelection}
          onChange={(event) => setMode(event.target.value as Mode)}
          className="w-full min-w-0"
        >
          <option value="dev">Development</option>
          <option value="prod">Production</option>
        </Select>
      </label>}
      {source?.problems.map((problem) => (
        <p key={problem} className={noticeClasses()} role="alert">
          {problem}
        </p>
      ))}
      {localDatabase ? (
        <section className={styles.card} aria-label="Local PostgreSQL persistence">
          <Subheading className={styles.subheading}>Local data survives restarts</Subheading>
          <p className={styles.paragraph}>
            PostgreSQL stores your rows in the <code className={retentionCodeClasses}>postgres_data</code> Docker volume.
            Keep using the same Compose project and volume to keep your database.
          </p>
          <dl className="m-0 text-label">
            <div className={localOutcomeClasses}><dt>Stop or restart local services</dt><dd className="m-0 font-medium">Data kept</dd></div>
            <div className={localOutcomeClasses}><dt>Rebuild images or recreate containers</dt><dd className="m-0 font-medium">Data kept</dd></div>
            <div className={localOutcomeClasses}><dt>Remove the database volume</dt><dd className="m-0 font-medium text-refuse">Data permanently deleted</dd></div>
          </dl>
          <Link to="/database/status" className={cx("justify-self-start", buttonClasses({ variant: "quiet" }))}>Check local database</Link>
          <p className={styles.support}>This page leaves the volume and its data unchanged. Database migrations are reviewed in History & migrations.</p>
        </section>
      ) : null}
      <AwsContent className={localDatabase ? styles.section : styles.content}>
      {localDatabase ? <InspectorSummary className={styles.sectionSummary}>Advanced AWS retention and recovery</InspectorSummary> : null}
      {localDatabase ? <p className={styles.support}>These policies apply to AWS resources. Local PostgreSQL uses the Docker volume described above.</p> : null}
      <div
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] gap-4"
        data-slot="stateful-policies"
      >
        {kinds.map((resource) => {
          const value = source?.resources[resource];
          const effective = value?.retention ?? (source?.legacy.retain ? "retain" : "remove");
          return (
            <section
              key={resource}
              className={styles.card}
              data-slot="stateful-policy"
            >
              <Subheading className={styles.subheading}>{databasePage && mode === "prod" ? "When the deployment is deleted" : title(resource)}</Subheading>
              <p className={styles.paragraph}>
                <strong>Configured intent:</strong>{" "}
                {source
                  ? databasePage
                    ? source.problems.length ? "Source needs attention"
                      : value?.reference ? "Existing database · externally managed"
                      : `${effective === "retain" ? "Keep the database" : "Remove the database"}${value?.retention ? " · configured policy" : " · inherited default"}`
                    : `${effective === "retain" ? "Retain" : "Remove"}${value?.retention ? " · explicit TypeScript policy" : " · inherited legacy policy"}`
                  : "Loading source…"}
              </p>
              {databasePage && mode === "prod" ? <p className={styles.paragraph}>
                {source?.problems.length
                  ? "Resolve the policy source errors before reviewing production protection."
                  : value?.reference
                  ? "Deleting this deployment leaves the existing database under its original management. Check that resource’s own protection separately."
                  : effective === "retain"
                  ? "The database and required supporting resources remain after deletion and continue to incur AWS charges."
                  : "Deleting the deployment can delete its managed database. Review the exact deployed consequences before deleting anything."}
              </p> : null}
              <p className={databasePage ? styles.support : styles.paragraph}>
                <strong>Management:</strong>{" "}
                {value?.reference
                  ? "Externally referenced; the original resource stays outside this stack’s management."
                  : "Framework-managed when deployed."}
              </p>
              {value?.reference ? (
                <p className={styles.paragraph}>
                  <code className={retentionCodeClasses}>
                    {"userPoolId" in value.reference
                      ? value.reference.userPoolId
                      : value.reference.instanceIdentifier}
                  </code>
                </p>
              ) : null}
              <label className={styles.label}>
                {title(resource)} policy{" "}
                <Select
                  aria-label={`${title(resource)} retention policy`}
                  value={value?.retention ?? "inherit"}
                  disabled={
                    busy || sourceBusy || !source || !!source.problems.length || !!value?.reference
                  }
                  onChange={(event) => {
                    const retention = event.target.value;
                    const request = generation.current;
                    const connection = currentConnection.current;
                    void run(async () => {
                      const reviewed = await call<StatefulPlan>("/stateful-resources/retention/plan", {
                        mode,
                        kind: resource,
                        retention,
                        hash: source!.hash,
                        revision: snapshot.revision,
                      });
                      if (generation.current === request && currentConnection.current === connection) setPlan(reviewed);
                    });
                  }}
                  className="w-full min-w-0"
                >
                  <option value="inherit">{databasePage ? "Use inherited default" : "Inherit legacy input"}</option>
                  <option value="retain">{databasePage ? "Keep database after deletion" : "Retain"}</option>
                  <option value="remove">{databasePage ? "Remove database with deployment" : "Remove"}</option>
                </Select>
              </label>
              {value?.reference ? (
                <p className={styles.caption}>
                  This policy applies to managed creation only. Deleting this deployment does not
                  delete the externally referenced resource or change its protection.
                </p>
              ) : null}
              {resource === "database" && mode === "dev" ? (
                <p className={styles.caption}>
                  Development uses local PostgreSQL. This AWS policy does not control Docker
                  volumes.
                </p>
              ) : null}
              {databasePage && mode === "prod" ? <p className={styles.support}>Review and save the source change, then deploy it from Deploy. Saving here does not update AWS protection.</p> : null}
              {databasePage && source ? (
                <details className={styles.details}>
                  <InspectorSummary className={workbenchDetailSummaryClasses}>Policy source and inherited default</InspectorSummary>
                  <p className={styles.support}>
                    <code className={retentionCodeClasses}>{source.file}</code>{" · legacy fallback from "}
                    <code className={retentionCodeClasses}>{source.legacy.file}</code>{": "}
                    {source.legacy.configured ? String(source.legacy.retain) : "absent; existing default false"}.
                    Deployment context overrides and custom input files require review in Deploy.
                  </p>
                </details>
              ) : null}
            </section>
          );
        })}
      </div>
      {source && !databasePage ? (
        <p className={styles.support}>
          <code className={retentionCodeClasses}>{source.file}</code>{" · legacy fallback from "}
          <code className={retentionCodeClasses}>{source.legacy.file}</code>{": "}
          {source.legacy.configured
            ? String(source.legacy.retain)
            : "absent; existing default false"}
          . Deployment context overrides and custom input files require review in Deploy.
        </p>
      ) : null}
      <StatefulRecovery
        appearance={appearance}
        headingLevel={headingLevel}
        compact={databasePage}
        key={`${kind ?? "all"}:${mode}:${suppliedSelection?.deployment ?? ""}:${suppliedSelection?.profile ?? ""}:${suppliedSelection?.region ?? ""}`}
        mode={mode}
        kinds={kinds}
        selection={suppliedSelection}
        disabled={busy || sourceBusy || !source}
        onReview={async (payload) => {
          const request = generation.current;
          const connection = currentConnection.current;
          await run(async () => {
            const reviewed = await call<StatefulPlan>("/stateful-resources/reference/plan", {
              ...payload,
              hash: source!.hash,
              revision: snapshot.revision,
            });
            if (generation.current === request && currentConnection.current === connection) setPlan(reviewed);
          });
        }}
      />
      </AwsContent>
      {!databasePage ? <details className={styles.details}>
        <InspectorSummary className={styles.summary}>Local PostgreSQL persistence</InspectorSummary>
        <p className={styles.paragraph}>
          The <code className={retentionCodeClasses}>postgres_data</code> volume survives ordinary
          Compose stop/restart and container recreation. Reconnect with the same Compose project and
          volume. Removing that volume permanently deletes its data. No volume or schema is changed
          here.
        </p>
      </details> : null}
      <details className={styles.section}>
        <InspectorSummary className={styles.sectionSummary}>
          Retain, reference, import and restore
        </InspectorSummary>
        <p className={styles.paragraph}>
          Retain leaves a physical resource and its ongoing costs after stack deletion. Reference
          connects a new deployment to that same externally managed resource. It does not give
          CloudFormation management authority. Import into CloudFormation and restore from snapshot
          require separate procedures; this workspace does not execute them.
        </p>
        <p className={styles.paragraph}>
          RDS requires its original compatible network, encryption key, secret and IAM database
          login. Cognito requires the original pool and a usable existing app client; providers,
          domains, groups and triggers remain separate dependencies. Deleted pools, users and
          passwords cannot be recreated by referencing a new empty pool.
        </p>
      </details>
      {plan ? (
        <WorkbenchDialog
          titleClassName={styles.heading}
          title="Review lifecycle source"
          busy={busy}
          onClose={() => setPlan(undefined)}
          footer={
            <>
              <button
                className={buttonClasses({ variant: "quiet" })}
                disabled={busy}
                onClick={() => setPlan(undefined)}
              >
                Cancel
              </button>
              <button
                className={cx(dialogPrimaryActionClasses, buttonClasses({ variant: "primary" }))}
                disabled={busy || sourceBusy}
                onClick={() =>
                  void run(async () => {
                    const request = generation.current;
                    const connection = currentConnection.current;
                    const result = await call<{ message: string }>("/stateful-resources/apply", {
                      planId: plan.planId,
                    });
                    if (generation.current !== request || currentConnection.current !== connection) return;
                    setPlan(undefined);
                    setMessage(result.message);
                    await load(mode, request);
                  })
                }
                data-variant="primary"
              >
                Save lifecycle source
              </button>
            </>
          }
        >
          {error ? (
            <p
              role="alert"
              className={noticeClasses()}
            >
              {error}
            </p>
          ) : null}
          <ul className="text-caption leading-[1.8]">
            {plan.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
          {(plan.inspection?.evidence?.checks ?? plan.inspection?.checks)?.length ? (
            <details className={styles.details}>
              <InspectorSummary className={styles.summary}>
                Read-only compatibility evidence
              </InspectorSummary>
              <ul>
                {(plan.inspection?.evidence?.checks ?? plan.inspection?.checks)?.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {plan.inspection?.warnings?.map((warning) => (
            <p
              key={warning}
              className={noticeClasses()}
            >
              {warning}
            </p>
          ))}
          {plan.changes.map((change) => (
            <pre
              key={change.file}
              className={cx("min-w-0 max-w-full overflow-auto", retentionCodeClasses)}
            >
              {change.diff.unified}
            </pre>
          ))}
        </WorkbenchDialog>
      ) : null}
    </section>
  );
}

function StatefulRecovery({
  mode,
  kinds,
  selection: supplied,
  disabled,
  onReview,
  appearance,
  headingLevel,
  compact = false,
}: {
  mode: Mode;
  kinds: readonly StatefulKind[];
  selection?: StatefulSelection;
  disabled: boolean;
  onReview(payload: Record<string, unknown>): Promise<void>;
  appearance: RetentionAppearance;
  headingLevel: 2 | 3;
  compact?: boolean;
}) {
  const styles = retentionStyles(appearance);
  const Heading = headingLevel === 3 ? "h4" : "h3";
  const overview = useDeploymentOverview();
  const { awsProfile, mode: declarationMode, live } = useStudio();
  const profile = awsProfile ?? "";
  const [deployment, setDeployment] = useState(supplied?.deployment ?? ""),
    [region, setRegion] = useState(supplied?.region ?? "");
  const [kind, setKind] = useState<StatefulKind>(kinds[0]!);
  const [id, setId] = useState(""),
    [originalDeployment, setOriginalDeployment] = useState(""),
    [clientId, setClientId] = useState("");
  const [inventory, setInventory] = useState<StatefulInventory>(),
    [deployed, setDeployed] = useState<TeardownPlanView>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [policyError, setPolicyError] = useState<string>();
  const context = JSON.stringify([declarationMode, mode, profile, deployment, region, live.awsConnectionRevision]);
  const latest = useRef(context);
  latest.current = context;
  useEffect(() => {
    setInventory(undefined);
    setDeployed(undefined);
    setError(undefined);
    setPolicyError(undefined);
    setId("");
    setOriginalDeployment("");
    setClientId("");
  }, [context]);
  const selection = { mode, profile, deployment, region };
  const target = overview.data?.targets.find(
    (target) => target.name === deployment && target.mode === mode,
  );
  const InspectionControls = compact ? "details" : "div";
  const RecoveryControls = compact ? "details" : "div";
  const protectionSummary = !deployed
    ? "Unverified for this destination."
    : `${deployed.remains.filter((resource) => kinds.some((kind) => resource.type === resourceType(kind))).length} stateful resource policies leave a resource or snapshot; inspect the exact consequences below.`;
  const candidates =
    inventory?.ledgers.flatMap((ledger) =>
      [...ledger.observations]
        .reverse()
        .flatMap((observation) =>
          observation.resources
            .filter((resource) => resource.type === resourceType(kind) && resource.physicalId)
            .map((resource) => ({
              ...resource,
              originalDeployment: ledger.deployment,
              phase: observation.phase,
              observedAt: observation.createdAt,
            })),
        ),
    ) ?? [];
  const unique = candidates.filter(
    (candidate, at) =>
      candidates.findIndex(
        (other) =>
          other.physicalId === candidate.physicalId &&
          other.originalDeployment === candidate.originalDeployment,
      ) === at,
  );
  const inspect = async () => {
    const captured = context;
    setBusy(true);
    setError(undefined);
    setPolicyError(undefined);
    setInventory(undefined);
    setDeployed(undefined);
    const results = await Promise.allSettled([
      call<StatefulInventory>("/stateful-resources/inventory", { selection }),
      deployApi.teardown(profile, deployment, mode, region),
    ]);
    if (latest.current === captured) {
      const [records, policies] = results;
      if (records.status === "fulfilled") setInventory(records.value);
      else
        setError(records.reason instanceof Error ? records.reason.message : String(records.reason));
      if (policies.status === "fulfilled" && policies.value.ok) setDeployed(policies.value.value);
      else
        setPolicyError(
          policies.status === "rejected"
            ? String(policies.reason)
            : policies.value.ok
              ? ""
              : policies.value.problem.message,
        );
    }
    setBusy(false);
  };
  return (
    <section
      className={styles.card}
      aria-label="Retained resource references"
      data-slot="stateful-recovery"
    >
      <Heading className={styles.subheading}>{compact ? "Deployed protection" : "Inspect protection and retained resources"}</Heading>
      <p className={styles.paragraph}>
        {compact
          ? "Check the deployed policies before relying on deletion protection. Configured source takes effect after deployment."
          : "Read deployed templates and saved teardown evidence, then review an explicit reference. A saved observation alone does not prove that a resource is still available."}
      </p>
      {compact ? <p className={styles.paragraph} role="status"><strong>{deployed ? "Last observed:" : "Not checked:"}</strong>{" "}{protectionSummary}</p> : null}
      {compact && target ? <p className={styles.support}>{deployment} · {region || "Region required"} · AWS profile {profile || "not selected"}</p> : null}
      <InspectionControls className={compact ? styles.details : "grid min-w-0 gap-3"}>
      {compact ? <InspectorSummary className={styles.summary}>Inspect deployed protection</InspectorSummary> : null}
      <div
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] gap-4"
        data-slot="stateful-context"
      >
        <AwsConnectionSummary layout="field" />
        <label className={styles.label}>
          Destination deployment
          <Select
            aria-label="Lifecycle destination"
            value={deployment}
            disabled={busy || !!supplied}
            onChange={(event) => {
              const target = overview.data?.targets.find(
                (target) => target.name === event.target.value,
              );
              setDeployment(event.target.value);
              setRegion(
                target?.region ??
                  overview.data?.profiles.find((entry) => entry.name === profile)?.region ??
                  region,
              );
            }}
            className="w-full min-w-0"
          >
            <option value="">Select destination</option>
            {overview.data?.targets
              .filter((target) => target.mode === mode)
              .map((target) => (
                <option key={target.name} value={target.name}>
                  {target.name}
                </option>
              ))}
          </Select>
        </label>
        <label className={styles.label}>
          Region
          <TextInput
            aria-label="Lifecycle region"
            value={region}
            disabled={busy || !!supplied || !!target?.region}
            onChange={(event) => setRegion(event.target.value)}
            className="w-full min-w-0"
          />
        </label>
      </div>
      <button
        className={cx("justify-self-start whitespace-normal", buttonClasses({ variant: "quiet" }))}
        disabled={busy || disabled || !profile || !target || !region}
        onClick={() => void inspect()}
      >
        {busy ? "Inspecting…" : "Inspect deployed protection and inventory"}
      </button>
      </InspectionControls>
      {overview.error ? (
        <p role="alert" className={styles.paragraph}>
          Deployment destinations unavailable: {overview.error.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={cx(styles.paragraph, "text-refuse wrap-anywhere")}>
          {error}
        </p>
      ) : null}
      {!compact ? <p className={styles.paragraph}>
        <strong>Deployed retention:</strong>{" "}
        {protectionSummary}
      </p> : null}
      {policyError ? (
        <p role="alert" className={styles.paragraph}>
          Deployed template inspection unavailable: {policyError}
        </p>
      ) : null}
      {deployed ? (
        <details open className={styles.details}>
          <InspectorSummary className={styles.summary}>
            Observed teardown consequences
          </InspectorSummary>
          <ul>
            {deployed.remains
              .filter((resource) => kinds.some((kind) => resource.type === resourceType(kind)))
              .map((resource) => (
                <li key={`${resource.stack}/${resource.logicalId}`}>
                  <code className={retentionCodeClasses}>
                    {resource.stack}/{resource.logicalId}
                  </code>{" "}
                  · {resource.policy}
                </li>
              ))}
          </ul>
          {!deployed.remains.some((resource) =>
            kinds.some((kind) => resource.type === resourceType(kind)),
          ) ? (
            <p className={styles.paragraph}>
              No retained primary resource was reported. Review the full teardown plan in Deploy
              before relying on protection.
            </p>
          ) : null}
          {deployed.blockers?.map((problem) => (
            <p key={problem} className={cx(styles.paragraph, "text-refuse wrap-anywhere")}>
              {problem}
            </p>
          ))}
          {deployed.warnings?.map((warning) => (
            <p key={warning} className={cx(styles.paragraph, "text-caption")}>
              {warning}
            </p>
          ))}
          <p className={cx(styles.paragraph, "text-caption")}>
            This is a read-only preview. No teardown was authorized or started.
          </p>
        </details>
      ) : null}
      <RecoveryControls className={compact ? styles.details : "grid min-w-0 gap-3"}>
      {compact ? <InspectorSummary className={styles.summary}>Advanced retained-resource recovery</InspectorSummary> : null}
      {inventory ? (
        <>
          <p className={styles.paragraph}>
            Inventory scope: account{" "}
            <code className={retentionCodeClasses}>{inventory.account}</code> · {inventory.region}.
            RDS instances/storage, snapshots, KMS and Secrets Manager can continue incurring
            charges. Exact costs are unverified.
          </p>
          {!unique.length ? (
            <p className={styles.paragraph}>
              No saved {title(kind).toLowerCase()} identity was found. Older teardown evidence may
              be unavailable in this checkout; an exact resource with verified ownership tags can
              still be inspected below.
            </p>
          ) : (
            <ul className="pl-4.5" data-slot="stateful-candidates">
              {unique.map((candidate) => (
                <li
                  key={`${candidate.originalDeployment}/${candidate.physicalId}`}
                  className="my-2"
                >
                  <button
                    className={cx(
                      "justify-self-start whitespace-normal",
                      buttonClasses({ variant: "link" }),
                    )}
                    onClick={() => {
                      setId(candidate.physicalId!);
                      setOriginalDeployment(candidate.originalDeployment);
                    }}
                  >
                    <code className={retentionCodeClasses}>{candidate.physicalId}</code>
                  </button>
                  <span className="block text-caption">
                    {candidate.originalDeployment} · state uncertain until live reference validation
                    · {candidate.phase} · {candidate.observedAt}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <details className={styles.details}>
        <InspectorSummary className={styles.summary}>
          Reference a retained resource
        </InspectorSummary>
        <p className={styles.paragraph}>
          Only an available resource with proven original ownership and compatible dependencies can
          pass review. Managed resources, conflicting claims and unsafe in-place transitions are
          refused.
        </p>
        {kinds.length > 1 ? (
          <label className={styles.label}>
            Resource
            <Select
              aria-label="Reference resource kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as StatefulKind);
                setId("");
                setOriginalDeployment("");
                setClientId("");
              }}
              className="w-full min-w-0"
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {title(kind)}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className={styles.label}>
          Original deployment
          <TextInput
            aria-label="Original resource deployment"
            value={originalDeployment}
            disabled={busy || disabled}
            onChange={(event) => setOriginalDeployment(event.target.value)}
            className="w-full min-w-0"
          />
        </label>
        <label className={styles.label}>
          Physical resource ID
          <TextInput
            aria-label="Retained resource ID"
            value={id}
            disabled={busy || disabled}
            onChange={(event) => setId(event.target.value)}
            className="w-full min-w-0"
          />
        </label>
        {kind === "cognito" ? (
          <label className={styles.label}>
            Existing app client ID
            <TextInput
              aria-label="Retained Cognito app client ID"
              value={clientId}
              disabled={busy || disabled}
              onChange={(event) => setClientId(event.target.value)}
              className="w-full min-w-0"
            />
          </label>
        ) : null}
        <button
          className={cx(
            "justify-self-start whitespace-normal",
            buttonClasses({ variant: "primary" }),
          )}
          disabled={
            busy ||
            disabled ||
            !profile ||
            !target ||
            !region ||
            !id ||
            !originalDeployment ||
            (kind === "cognito" && !clientId)
          }
          onClick={() =>
            void onReview({
              selection,
              kind,
              id,
              originalDeployment,
              ...(kind === "cognito" ? { clientId } : {}),
            })
          }
          data-variant="primary"
        >
          Inspect and review reference source
        </button>
        <p className={cx(styles.paragraph, "text-caption")}>
          After saving, review and deploy supporting infrastructure in Deploy. Verify actual
          database records or Cognito sign-in separately. CloudFormation import, snapshot
          restoration and permanent resource deletion are separate operations.
        </p>
      </details>
      </RecoveryControls>
    </section>
  );
}

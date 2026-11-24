/** Owns Cognito subsection navigation and the source and AWS observations shared by its mounted panels. */
import { usePublishSightline } from "../sightline/bridge";
import { RetryNotice } from "./RetryNotice";
import {
  evidenceFactsClasses,
  evidenceLabelClasses,
  evidenceValueClasses,
  Groups,
  PoolRelationships,
  ProviderEvidence,
} from "./AuthenticationEvidence";
import { sourceEditBlocked } from "../editing-state";
import { identitySourceQuery } from "../identity-queries";
import { useDeploymentOverview } from "../deploy/observations";
import { resolveDeploymentTarget } from "../deploy/context";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Fingerprint, KeyRound, ShieldCheck, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeployOverview } from "../../shared/deploy";
import type {
  CognitoObservation,
  IdentityPoolsObservation,
  IdentitySelection,
} from "../../shared/identity";
import type { Mode } from "../../shared/model";
import { deployApi } from "../deploy/api";
import { identityApi, inspectionErrorMessage } from "../identity-api";
import { useStudio } from "../studio";
import { AwsConnectionSummary } from "./AwsConnectionSummary";
import { buttonClasses } from "../ui/Button";
import { Select, TextInput } from "../ui/FormControls";
import { noticeClasses, workspaceToolbarClasses } from "../ui/Surface";
import { cx } from "../ui/classes";
import { CognitoManagement } from "./CognitoManagement";
import { CreationWizard } from "./CreationWizard";
import { DataRetention } from "./DataRetention";
import {
  DocumentCard,
  documentTitleClasses,
  documentCardTitleClasses,
  documentProseClasses,
  documentSupportClasses,
  documentSummaryClasses,
  documentDisclosureClasses,
  documentCardClasses,
  documentDataTableClasses,
  documentTableHeadClasses,
  documentTableCellClasses,
  documentTableRegionClasses,
  documentToolbarClasses,
  inspectionControlClasses,
  pageBodyClasses,
  inspectionFieldClasses,
  inspectionRegionFieldClasses,
  inspectionActionClasses,
  documentSearchFieldClasses,
  documentToolbarActionClasses,
} from "./DocumentUI";
import { DraftFooter } from "./DraftControls";
import { WorkbenchPageHeader } from "./WorkbenchUI";
import { IdentityPolicyEditor } from "./IdentityPolicyEditor";
import { navigationItemClasses, NavigationStrip } from "./NavigationStrip";

const sections = [
  { id: "user-pools", label: "User Pools", to: "/cognito/user-pools", icon: Users,
    description: "The application user pool, its app clients, users and groups." },
  { id: "identity-pools", label: "Identity Pools", to: "/cognito/identity-pools", icon: Fingerprint,
    description: "Exchange trusted sign-in tokens for scoped AWS credentials." },
  { id: "providers", label: "Providers", to: "/cognito/providers", icon: KeyRound,
    description: "Federated sign-in through Google, Microsoft, Meta, OIDC and SAML providers." },
  { id: "permissions", label: "Permissions & RBAC", to: "/cognito/permissions", icon: ShieldCheck,
    description: "How application RBAC, Cognito groups, identity-pool mapping and IAM authorize access." },
] as const;
type Section = (typeof sections)[number]["id"];
/** A section's cards, 16px apart like every other page-level stack. */
const sectionClasses = "grid min-w-0 gap-4";
/**
 * A card that opens with an action follows WorkbenchPageHeader: the action is level with a
 * 32px title row; on narrow screens it follows the copy at full width.
 */
const cardHeaderClasses =
  "flex flex-wrap items-start justify-between gap-x-4 gap-y-3 vp-720:flex-col vp-720:items-stretch";
const cardHeaderTextClasses = "grid min-w-0 flex-[1_1_360px] gap-3 vp-720:basis-auto";
interface Evidence<T> {
  readonly data: T;
  readonly revision: string;
  readonly hash: string;
}
interface Inspection {
  readonly cognito?: Evidence<CognitoObservation>;
  readonly pools?: Evidence<IdentityPoolsObservation>;
  readonly errors?: Partial<Record<"cognito" | "pools", string>>;
}

export function authenticationSelection(mode: Mode, overview?: DeployOverview, profile = ""): IdentitySelection {
  const target = resolveDeploymentTarget(mode, overview);
  return {
    profile,
    deployment: target?.name ?? "",
    region:
      target?.region ??
      overview?.profiles.find((entry) => entry.name === profile)?.region ??
      "us-east-1",
  };
}

/** One route owner keeps all four panels and their drafts mounted. AWS reads are
 * bound to the exact environment/profile/target/region and source revision. */
export function AuthenticationWorkspace() {
  const { mode, snapshot, model, draft, draftState, select, live, awsProfile } = useStudio();
  const pathname = useLocation({ select: (location) => location.pathname });
  const section: Section =
    sections.find((entry) => pathname.endsWith(`/${entry.id}`))?.id ?? "user-pools";
  const source = useQuery(identitySourceQuery(mode, snapshot.revision));
  const overview = useDeploymentOverview();
  const [selections, setSelections] = useState<Partial<Record<Mode, IdentitySelection>>>({});
  const candidate = selections[mode];
  const destination =
    candidate &&
    (!candidate.deployment ||
      overview.data?.targets.some(
        (target) => target.name === candidate.deployment && target.mode === mode,
      ))
      ? candidate
      : authenticationSelection(mode, overview.data, awsProfile);
  const selection = { ...destination, profile: awsProfile ?? "" };
  const selectedTarget = overview.data?.targets.find(
    (target) => target.name === selection.deployment && target.mode === mode,
  );
  const sourceInputsFile = source.data?.file ?? `cdk-app/.env.${mode}`;
  const normalizeInputPath = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");
  const targetInputsMismatch =
    !!selectedTarget?.inputs &&
    normalizeInputPath(selectedTarget.inputs) !== normalizeInputPath(sourceInputsFile);
  const contextKey = JSON.stringify([
    mode,
    live.awsConnectionRevision,
    selection.profile,
    selection.deployment,
    selection.region,
    selectedTarget?.account ?? "",
  ]);
  const [observations, setObservations] = useState<Record<string, Inspection>>({});
  const observation = observations[contextKey];
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const currentKey = useRef(contextKey);
  currentKey.current = contextKey;
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const activeSection = sections.find((entry) => entry.id === section) ?? sections[0];
  const creation = draft.creation();
  const cog = observation?.cognito?.data;
  const pools = observation?.pools?.data;
  const evidence =
    section === "identity-pools" || section === "permissions"
      ? observation?.pools
      : observation?.cognito;
  const sourceStale =
    !!evidence && (evidence.revision !== snapshot.revision || evidence.hash !== source.data?.hash);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const timeStale = !!evidence && clock - Date.parse(evidence.data.context.observedAt) > 5 * 60_000;
  useEffect(() => {
    request.current?.abort();
    setBusy(false);
    return () => request.current?.abort();
  }, [contextKey]);
  useEffect(() => {
    panelHeading.current?.focus({ preventScroll: true });
  }, [section]);
  const updateSelection = (patch: Partial<IdentitySelection>) => {
    const next = { ...selection, ...patch };
    setSelections((current) => ({ ...current, [mode]: next }));
    // Reuse Deploy's remembered destination authority, without running discovery.
    void deployApi
      .preferences({ deployment: next.deployment })
      .catch(() => {});
  };
  const inspect = async (onlyCognito = false, nextToken?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestContextKey = contextKey;
    const sourceRevision = snapshot.revision;
    const sourceHash = source.data?.hash ?? "";
    setBusy(true);
    const kinds = onlyCognito ? (["cognito"] as const) : (["cognito", "pools"] as const);
    await Promise.all(
      kinds.map(async (kind) => {
        try {
          const data = await identityApi.inspect<CognitoObservation | IdentityPoolsObservation>(
            kind,
            selection,
            kind === "cognito" ? nextToken : undefined,
            kind === "cognito" ? (nextToken ? appliedSearch : search) : undefined,
            controller.signal,
          );
          if (controller.signal.aborted || currentKey.current !== requestContextKey) return;
          if (
            !data?.context ||
            data.context.profile !== selection.profile ||
            data.context.deployment !== selection.deployment ||
            data.context.region !== selection.region
          )
            throw new Error(
              "Inspection returned a different destination. Select the intended context and inspect again.",
            );
          setObservations((current) => ({
            ...current,
            [requestContextKey]: {
              ...current[requestContextKey],
              [kind]: { data, revision: sourceRevision, hash: sourceHash },
              errors: { ...current[requestContextKey]?.errors, [kind]: undefined },
            },
          }));
          if (kind === "cognito" && !nextToken) setAppliedSearch(search);
        } catch (reason) {
          if (!controller.signal.aborted && currentKey.current === requestContextKey)
            setObservations((current) => ({
              ...current,
              [requestContextKey]: {
                ...current[requestContextKey],
                errors: { ...current[requestContextKey]?.errors, [kind]: inspectionErrorMessage(reason) },
              },
            }));
        }
      }),
    );
    if (!controller.signal.aborted && currentKey.current === requestContextKey) {
      setBusy(false);
      setClock(Date.now());
    }
  };
  const canAuthor = !sourceEditBlocked({ draftState, draft, model, live });
  const createPool = () =>
    draft.requestNavigation(() => {
      draft.beginCreation("stack");
      const entry = draft.creation()!;
      draft.setCreation("stack", { ...entry.form, template: "identity-pool", scope: mode });
    });
  const declaredPools = model.resources.filter(
    (resource) =>
      resource.kind === "member" && /(?:Cfn)?IdentityPool$/.test(resource.typeText ?? ""),
  );
  const declaredUserPool = model.resources.find(
    (resource) => resource.kind === "member" && /(?:I)?UserPool$/.test(resource.typeText ?? ""),
  );
  usePublishSightline("cognito", () => ({
    subsection: section, destination: { deployment: selection.deployment, region: selection.region },
    source: { availability: source.isPending ? "loading" : source.error ? "error" : source.data ? "available" : "not-loaded",
      declaredPoolIds: [...declaredPools.map(pool => pool.id), ...(declaredUserPool ? [declaredUserPool.id] : [])],
      providers: source.data ? (source.data.declaredProviders ?? []).map(provider => ({ id: provider.id, name: provider.name, type: provider.type, scope: provider.scope })) : undefined,
      problemCount: source.data?.problems.length },
    observed: { availability: busy ? "loading" : observation?.errors?.cognito || observation?.errors?.pools ? "error" : evidence ? "available" : "not-loaded",
      poolId: cog?.poolId, observedAt: evidence?.data.context.observedAt, stale: sourceStale || timeStale,
      providerNames: cog?.providers.map(provider => provider.name), identityPoolIds: pools?.pools.map(pool => pool.id) },
  }));
  return (
    <div className="h-full w-full min-w-0 overflow-auto text-ink">
      {/* The navbar already names the page; the section strip is GraphQL's flush-left workspace toolbar. */}
      <h1 className="sr-only">Cognito</h1>
      <div data-ui="workspace-toolbar cognito-navigation" className={cx(workspaceToolbarClasses, "flex items-center")}>
        <NavigationStrip className="min-w-0 flex-1" label="Cognito sections" activeKey={section}>
          {sections.map((entry) => (
            <Link
              key={entry.id}
              className={navigationItemClasses}
              to={entry.to}
              search={(previous: { select?: string }) => previous}
              aria-current={section === entry.id ? "page" : undefined}
            >
              <entry.icon size={15} aria-hidden />
              {entry.label}
            </Link>
          ))}
        </NavigationStrip>
      </div>
      <div className={cx(pageBodyClasses, "grid content-start gap-4")}>
        <WorkbenchPageHeader
          icon={activeSection.icon}
          titleRef={panelHeading}
          title={activeSection.label}
          description={activeSection.description}
        />
        {/* Shared by every section, so it stays mounted outside their hidden wrappers. */}
        <DocumentCard aria-labelledby="cognito-inspection-title">
          <h3 id="cognito-inspection-title" className={documentCardTitleClasses}>
            Read-only deployment inspection
          </h3>
          <div className={inspectionControlClasses}>
            <AwsConnectionSummary layout="field" />
            <label className={inspectionFieldClasses}>
              Deployment
              <Select
                className="h-8 w-full"
                aria-label="Identity deployment"
                disabled={overview.isPending || !!overview.error}
                value={selection.deployment}
                onChange={(event) => {
                  const target = overview.data?.targets.find(
                    (target) => target.name === event.target.value,
                  );
                  updateSelection({
                    deployment: event.target.value,
                    region: target?.region ?? selection.region,
                  });
                }}
              >
                <option value="">Select a deployment</option>
                {overview.data?.targets
                  .filter((target) => target.mode === mode)
                  .map((target) => (
                    <option key={target.name} value={target.name}>
                      {target.name}
                    </option>
                  ))}
              </Select>
            </label>
            <label className={inspectionRegionFieldClasses}>
              Region
              <TextInput
                className="h-8 w-full"
                aria-label="Identity AWS region"
                disabled={overview.isPending || !!overview.error}
                value={selection.region}
                readOnly={!!selectedTarget?.region}
                title={selectedTarget?.region ? "Pinned by the deployment target" : undefined}
                onChange={(event) => updateSelection({ region: event.target.value })}
              />
            </label>
            <button
              className={cx(inspectionActionClasses, buttonClasses({ variant: "primary" }))}
              disabled={
                busy ||
                overview.isPending ||
                !!overview.error ||
                !selectedTarget ||
                !selection.profile ||
                !selection.deployment ||
                !selection.region ||
                source.isPending
              }
              onClick={() => void inspect()}
            >
              {busy ? "Inspecting…" : "Inspect authentication"}
            </button>
          </div>
          <div
            className={cx(documentSupportClasses, "flex flex-wrap gap-x-4 gap-y-2 wrap-anywhere")}
            role="status"
          >
            <span>
              <strong className="mr-1 font-semibold">Source</strong>{" "}
              {source.isPending
                ? "Loading…"
                : source.error
                  ? "Unavailable"
                  : `${mode === "dev" ? "Development" : "Production"} declarations`}
            </span>
            <span>
              <strong className="mr-1 font-semibold">AWS metadata</strong>{" "}
              {evidence
                ? `${sourceStale || timeStale ? "Stale · " : "Observed · "}${new Date(evidence.data.context.observedAt).toLocaleString()} · account ${evidence.data.context.account}`
                : "Unverified for this context"}
            </span>
            <span>
              <strong className="mr-1 font-semibold">Sign-in / effective access</strong> Unverified
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 [&>details[open]]:basis-full">
            <p className={documentSupportClasses}>
              <strong>Source inputs</strong> <code>{sourceInputsFile}</code>
              {targetInputsMismatch ? (
                <>
                  {" "}
                  · Deployment inputs <code>{selectedTarget?.inputs}</code>
                </>
              ) : null}
            </p>
            <details className="min-w-0 [&_p]:max-w-250 [&[open]>:not(summary)]:mt-3">
              <summary className={documentSummaryClasses}>Evidence and action boundaries</summary>
              <p className={documentSupportClasses}>
                Inspect reads verified deployment-owned AWS resources. Source actions propose
                TypeScript for review; Apply source never deploys infrastructure. User/group
                operations require their own exact live-operation review. IAM simulation evaluates
                saved source policy and does not establish issued credentials, deployed IAM or
                application RBAC.
              </p>
              <p className={documentSupportClasses}>
                Profile/deployment defaults reuse Deploy preferences. Evidence is isolated by
                environment, profile, deployment and region. Changing context never transfers an AWS
                observation or an operation approval.
              </p>
            </details>
          </div>
          {targetInputsMismatch ? (
            <p className={noticeClasses({ tone: "warning" })} role="status">
              This deployment uses different inputs. Sign-in provider input-presence evidence and retention
              settings here refer to <code>{sourceInputsFile}</code>; the deployment’s input
              presence and freshness are unverified. Review <code>{selectedTarget?.inputs}</code> in
              Deploy. Provider declarations still follow the selected environment.
            </p>
          ) : null}
          {sourceStale || timeStale ? (
            <p className={noticeClasses({ tone: "warning" })} role="status">
              {sourceStale
                ? "Source changed since inspection."
                : "Inspection is more than five minutes old."}{" "}
              Previous metadata is retained; inspect again before relying on it.
            </p>
          ) : null}
          {overview.error ? (
            <RetryNotice
              message={<>Deployment context could not load: {overview.error.message}</>}
              retryLabel="Retry context"
              retrying={overview.isFetching}
              onRetry={() => void overview.refetch()}
            />
          ) : null}
          {!overview.isPending && !selectedTarget ? (
            <p className={noticeClasses({ tone: "warning" })}>
              No {mode === "dev" ? "development" : "production"} deployment is declared. Source
              proposals are still available; configure a target in Deploy before AWS inspection.
            </p>
          ) : null}
          {source.error ? (
            <RetryNotice
              message={source.error.message}
              retryLabel="Retry source"
              retrying={source.isFetching}
              onRetry={() => void source.refetch()}
            />
          ) : null}
          {source.data?.problems.map((problem) => (
            <p
              className={cx(noticeClasses(), "flex flex-wrap items-center gap-x-3 gap-y-2")}
              role="alert"
              key={problem}
            >
              {problem}
            </p>
          ))}
          {Object.entries(observation?.errors ?? {}).map(([kind, error]) =>
            error ? (
              <p
                className={cx(noticeClasses(), "flex flex-wrap items-center gap-x-3 gap-y-2")}
                role="alert"
                key={kind}
              >
                {kind === "cognito" ? "User-pool" : "Identity-pool"} inspection failed: {error}{" "}
                {observation?.[kind as "cognito" | "pools"]
                  ? "Previous metadata remains visible."
                  : "No metadata verified."}
              </p>
            ) : null,
          )}
          {cog?.warnings.length ? (
            <details className="min-w-0 [&_p]:max-w-250 [&[open]>:not(summary)]:mt-3">
              <summary className={documentSummaryClasses}>User-pool inspection notes ({cog.warnings.length})</summary>
              {cog.warnings.map((warning) => (
                <p className={documentSupportClasses} key={warning}>{warning}</p>
              ))}
            </details>
          ) : null}
          {pools?.warnings.length ? (
            <details className="min-w-0 [&_p]:max-w-250 [&[open]>:not(summary)]:mt-3">
              <summary className={documentSummaryClasses}>Identity-pool inspection notes ({pools.warnings.length})</summary>
              {pools.warnings.map((warning) => (
                <p className={documentSupportClasses} key={warning}>{warning}</p>
              ))}
            </details>
          ) : null}
        </DocumentCard>
        <div className={sectionClasses} hidden={section !== "user-pools"}>
          <DocumentCard>
            <div className={cardHeaderClasses}>
              <div className={cardHeaderTextClasses}>
                <h3 className={documentCardTitleClasses}>
                  {cog?.pool.name ?? "Application user pool"}
                </h3>
                <p className={cx(documentProseClasses, "flex flex-wrap items-baseline gap-2")}>
                  <span className="inline-block rounded-sm border border-rule bg-wash px-[6px] py-0.5 text-meta leading-[1.5]">
                    {cog ? "AWS metadata observed" : "Deployment unverified"}
                  </span>
                  <span>
                    {cog ? (
                      <code>{cog.poolId}</code>
                    ) : (
                      "A source declaration alone does not prove a deployed pool."
                    )}
                  </span>
                </p>
              </div>
              {declaredUserPool ? (
                <button
                  className={cx("flex-[0_1_auto]", buttonClasses({ variant: "quiet" }))}
                  onClick={() => select(declaredUserPool.id)}
                >
                  Inspect source declaration
                </button>
              ) : null}
            </div>
            {cog ? (
              <dl className={evidenceFactsClasses}>
                <div className="min-w-0">
                  <dt className={evidenceLabelClasses}>Estimated users</dt>
                  <dd className={evidenceValueClasses}>{cog.pool.estimatedUsers ?? "Unknown"}</dd>
                </div>
                <div className="min-w-0">
                  <dt className={evidenceLabelClasses}>Deletion protection</dt>
                  <dd className={evidenceValueClasses}>
                    {cog.pool.deletionProtection ?? "Unknown"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className={evidenceLabelClasses}>Hosted domain</dt>
                  <dd className={evidenceValueClasses}>
                    {cog.pool.customDomain ?? cog.pool.domain ?? "Not returned"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className={documentSupportClasses}>
                Select a deployment and inspect authentication to load its pool, app clients, users
                and groups.
              </p>
            )}
            {cog?.management ? (
              <p className={documentProseClasses}>
                <strong>Management:</strong>{" "}
                {cog.management === "external-reference"
                  ? `Externally referenced from ${cog.originalDeployment}; pool and client configuration remain externally managed.`
                  : "Framework-managed User Pool."}
                {cog.selectedClientId ? (
                  <>
                    {" "}
                    Selected existing app client: <code>{cog.selectedClientId}</code>.
                  </>
                ) : null}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-label">
              <Link to="/cognito/providers" search={(previous: { select?: string }) => previous}>
                Set up federation
              </Link>
              <Link
                to="/cognito/identity-pools"
                search={(previous: { select?: string }) => previous}
              >
                Connect AWS access
              </Link>
              <Link to="/cognito/permissions" search={(previous: { select?: string }) => previous}>
                Inspect permissions
              </Link>
            </div>
          </DocumentCard>
          <DocumentCard>
            <h3 className={documentCardTitleClasses}>
              App clients{" "}
              <span className="text-graphite">{cog ? `(${cog.clients.length})` : ""}</span>
            </h3>
            {cog?.clients.map((client) => (
              <details className={documentDisclosureClasses} key={client.id} open>
                <summary className={documentSummaryClasses}>
                  {client.name ?? client.id}
                </summary>
                <dl className={evidenceFactsClasses}>
                  <div className="min-w-0">
                    <dt className={evidenceLabelClasses}>Client ID</dt>
                    <dd className={evidenceValueClasses}>
                      <code>{client.id}</code>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={evidenceLabelClasses}>Providers</dt>
                    <dd className={evidenceValueClasses}>
                      {client.providers.join(", ") || "None returned"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={evidenceLabelClasses}>Callbacks</dt>
                    <dd className={evidenceValueClasses}>
                      {client.callbacks.join(", ") || "None"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className={evidenceLabelClasses}>Logout URLs</dt>
                    <dd className={evidenceValueClasses}>{client.logout.join(", ") || "None"}</dd>
                  </div>
                </dl>
              </details>
            ))}
            {!cog?.clients.length ? (
              <p className={documentProseClasses}>
                {cog
                  ? "No app clients returned."
                  : "Inspect authentication to observe app-client configuration."}
              </p>
            ) : null}
          </DocumentCard>
          <DocumentCard>
            <h3 className={documentCardTitleClasses}>Users</h3>
            <form
              className={documentToolbarClasses}
              onSubmit={(event) => {
                event.preventDefault();
                void inspect(true);
              }}
            >
              <label className={documentSearchFieldClasses}>
                Username starts with
                <TextInput
                  className="w-full"
                  aria-label="Search Cognito users"
                  value={search}
                  maxLength={128}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <button
                className={cx(documentToolbarActionClasses, buttonClasses({ variant: "quiet" }))}
                disabled={busy || !selection.deployment || !selection.profile}
              >
                Search users
              </button>
            </form>
            {cog ? (
              <>
                <div
                  className={documentTableRegionClasses}
                  role="region"
                  aria-label="Cognito users"
                  tabIndex={0}
                >
                  <table className={documentDataTableClasses}>
                    <colgroup>
                      <col />
                      <col className="w-[180px]" />
                      <col className="w-20" />
                      <col className="w-[180px]" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className={documentTableHeadClasses}>
                          Username
                        </th>
                        <th className={documentTableHeadClasses}>
                          Status
                        </th>
                        <th className={documentTableHeadClasses}>
                          Enabled
                        </th>
                        <th className={documentTableHeadClasses}>
                          Created
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {cog.users.map((user) => (
                        <tr key={user.username}>
                          <th
                            className={documentTableHeadClasses}
                            scope="row"
                          >
                            {user.username}
                          </th>
                          <td className={documentTableCellClasses}>
                            {user.status ?? "Unknown"}
                          </td>
                          <td className={documentTableCellClasses}>
                            {user.enabled ? "Yes" : "No"}
                          </td>
                          <td className={documentTableCellClasses}>
                            {user.createdAt ?? "Unknown"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!cog.users.length ? (
                  <p className={documentProseClasses}>
                    No users returned for this page and search.
                  </p>
                ) : null}
                <button
                  className={buttonClasses({ variant: "quiet" })}
                  disabled={busy || !cog.nextToken}
                  onClick={() => void inspect(true, cog.nextToken)}
                >
                  Next page
                </button>
              </>
            ) : (
              <p className={documentProseClasses}>
                Users are unverified until an explicit AWS inspection.
              </p>
            )}
          </DocumentCard>
          <Groups result={cog} />
          <CognitoManagement
            selection={selection}
            connectionRevision={live.awsConnectionRevision}
            active={section === "user-pools"}
            onChanged={() =>
              setObservations((current) => ({
                ...current,
                [contextKey]: { ...current[contextKey], cognito: undefined },
              }))
            }
          />
          <details className={documentCardClasses()}>
            <summary className={documentSummaryClasses}>
              <span className={documentTitleClasses}>Retention and retained pool reuse</span>
            </summary>
            {targetInputsMismatch ? (
              <p className={documentProseClasses}>
                Retention editing is unavailable for this deployment’s custom inputs. Review{" "}
                <code>{selectedTarget?.inputs}</code> in Deploy; the retention editor supports the
                standard <code>{sourceInputsFile}</code> inputs only.
              </p>
            ) : (
              <DataRetention
                appearance="document"
                headingLevel={3}
                kind="cognito"
                selection={{ ...selection, mode }}
              />
            )}
          </details>
        </div>
        <div className={sectionClasses} hidden={section !== "identity-pools"}>
          <DocumentCard>
            <h3 className={documentCardTitleClasses}>Scoped AWS access</h3>
            {/* The same label-over-value columns as Permission layers; order carries the sequence. */}
            <ol className={cx(evidenceFactsClasses, "list-none p-0")} aria-label="AWS access relationship">
              {[
                ["User Pool", "Identity and authentication claims"],
                ["Identity Pool", "Claims select a role"],
                ["IAM role", "Policies authorize AWS calls"],
              ].map(([name, role]) => (
                <li key={name} className="min-w-0">
                  <p className={cx(evidenceLabelClasses, "mt-0")}>{name}</p>
                  <p className={evidenceValueClasses}>{role}</p>
                </li>
              ))}
            </ol>
            <p className={documentProseClasses}>
              Keep application RBAC in your application. An identity pool exchanges trusted tokens
              for scoped AWS credentials.
            </p>
            <div className="flex flex-col items-start gap-2 [&>p]:m-0 vp-720:items-stretch">
              <button
                className={buttonClasses({ variant: "primary" })}
                disabled={!canAuthor}
                aria-describedby="identity-pool-source-help"
                onClick={createPool}
              >
                Create identity pool source
              </button>
              <p
                id="identity-pool-source-help"
                className={documentSupportClasses}
              >
                Reviewed native source connects the application pool/client. Default roles have no
                AWS API grants; guest access and classic flows start disabled.
              </p>
            </div>
          </DocumentCard>
          <DocumentCard>
            <h3 className={documentCardTitleClasses}>Declared identity pools</h3>
            {declaredPools.map((resource) => (
              <p className={documentProseClasses} key={resource.id}>
                <button
                  className={buttonClasses({ variant: "link" })}
                  onClick={() => select(resource.id)}
                >
                  {resource.path.join(".")}
                </button>{" "}
                <span className="inline-block rounded-sm border border-rule bg-wash px-[6px] py-0.5 text-meta leading-[1.5]">
                  {resource.absent ? "Excluded from this environment" : "Source declaration"}
                </span>{" "}
                · deployment unverified by source
              </p>
            ))}
            {!declaredPools.length ? (
              <p className={documentProseClasses}>
                No typed identity-pool declarations recognized. Create reviewed source above, or
                inspect custom native resources in your editor.
              </p>
            ) : null}
            <Link className="block w-fit" to="/cognito/permissions" search={(previous: { select?: string }) => previous}>
              Review reader policies and simulate permissions
            </Link>
          </DocumentCard>
          <PoolRelationships result={pools} />
        </div>
        <div className={sectionClasses} hidden={section !== "providers"}>
          <DocumentCard>
            <div className={cardHeaderClasses}>
              <div className={cardHeaderTextClasses}>
                <h3 className={documentCardTitleClasses}>Add federation</h3>
                <p className={documentProseClasses}>
                  Propose an OIDC or SAML provider on the existing user pool and app client. Secret
                  references are declared in source; their values stay out of Studio.
                </p>
              </div>
              <button
                className={cx("flex-[0_1_auto]", buttonClasses({ variant: "primary" }))}
                disabled={!canAuthor}
                onClick={() => draft.requestNavigation(() => draft.beginCreation("auth-provider"))}
              >
                Add federation provider
              </button>
            </div>
          </DocumentCard>
          <ProviderEvidence source={source.data} result={cog} />
        </div>
        <div className={sectionClasses} hidden={section !== "permissions"}>
          <DocumentCard>
            <h3 className={documentCardTitleClasses}>Permission layers</h3>
            <dl className={evidenceFactsClasses}>
              <div className="min-w-0">
                <dt className={evidenceLabelClasses}>Application RBAC</dt>
                <dd className={evidenceValueClasses}>
                  Application code decides record and feature access.
                </dd>
              </div>
              <div className="min-w-0">
                <dt className={evidenceLabelClasses}>Cognito groups</dt>
                <dd className={evidenceValueClasses}>
                  Group membership and precedence influence token role claims.
                </dd>
              </div>
              <div className="min-w-0">
                <dt className={evidenceLabelClasses}>Identity-pool mapping</dt>
                <dd className={evidenceValueClasses}>
                  Trusted claims select an IAM role; ambiguous mappings can deny credentials.
                </dd>
              </div>
              <div className="min-w-0">
                <dt className={evidenceLabelClasses}>IAM authorization</dt>
                <dd className={evidenceValueClasses}>
                  Role policies, explicit Deny, boundaries and SCPs govern AWS calls.
                </dd>
              </div>
            </dl>
          </DocumentCard>
          <Groups result={cog} />
          <PoolRelationships result={pools} />
          <IdentityPolicyEditor
            profile={selection.profile}
            region={selection.region}
            account={selectedTarget?.account ?? pools?.context.account ?? cog?.context.account}
            contextKey={contextKey}
            contextLabel={`${mode} · ${selection.deployment} · ${selection.profile} · ${selection.region}${selectedTarget?.account ? ` · account ${selectedTarget.account}` : ""}`}
            active={section === "permissions"}
          />
        </div>
        {draftState.error ? (
          <p
            className={cx(noticeClasses(), "flex flex-wrap items-center gap-x-3 gap-y-2")}
            role="alert"
          >
            {draftState.error}
          </p>
        ) : null}
        {draft.dirty ? (
          <DraftFooter className="sticky bottom-0 rounded-md border border-rule bg-sheet" />
        ) : null}
      </div>
      {creation ? <CreationWizard entry={creation} back={() => draft.discard()} /> : null}
    </div>
  );
}

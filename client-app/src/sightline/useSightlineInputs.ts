import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useLocation } from "@tanstack/react-router";
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useStudio } from "../studio";
import { useDeploymentObservation } from "../deploy/observations";
import { operationsQuery } from "../operations/queries";
import { deploymentDiscoveryQuery, deploymentStatusQuery, deploymentReadPolicy } from "../deploy/queries";
import { deploymentFreshness } from "./freshness";
import { deploymentInvalidations, subscribeDeploymentInvalidations } from "./cache";
import { useSightlineWorkspaceInputs } from "./bridge";
import type { SightlineDeploymentInput, SightlineInputs } from "./types";
import { developmentLogScope } from "../../shared/development-log-scope";
import { useDevelopmentLogEvidence } from "../development-logs";

function deploymentInput(observation: ReturnType<typeof useDeploymentObservation>, client: QueryClient, capturedAt: number): SightlineDeploymentInput {
  const query = observation.target ? observation.statusQuery : observation.discoveryQuery;
  const fetching = query.isFetching;
  const data = observation.status ?? observation.discovery;
  const detail = observation.status?.detail;
  const key = observation.target ? deploymentStatusQuery(observation.scope).queryKey : deploymentDiscoveryQuery(observation.scope).queryKey;
  const freshness = data ? deploymentFreshness({ capturedAt, updatedAt: query.dataUpdatedAt,
    staleTime: deploymentReadPolicy.staleTime,
    invalidated: client.getQueryState(key)?.isInvalidated ?? false, failed: query.isError, available: observation.availability === "available" }) : undefined;
  return {
    availability: observation.availability as SightlineDeploymentInput["availability"],
    target: observation.target ? { name: observation.target.name, mode: observation.target.mode, region: observation.target.region } : undefined,
    observed: {
      availability: data ? "available" : fetching ? "loading" : query.isError ? "error" : "not-loaded",
      observedAt: data?.observedAt,
      updatedAt: query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : undefined,
      stale: freshness?.stale,
      freshUntil: freshness?.freshUntil,
      state: detail?.state.kind ?? observation.status?.targets.find(target => target.name === observation.status?.deployment)?.status,
      stackCount: detail?.stacks.length,
      problemKind: observation.problem?.kind,
    },
  };
}

/** Visible consumers may read the bounded local log cache; other operational evidence stays cache-only. */
export function useSightlineInputs(includeLogEvidence = true): SightlineInputs {
  const client = useQueryClient();
  const pathname = useLocation({ select: location => location.pathname });
  const studio = useStudio();
  const dev = useDeploymentObservation("dev");
  const prod = useDeploymentObservation("prod");
  const queryHash = (observation: typeof dev) => hashKey(observation.target ? deploymentStatusQuery(observation.scope).queryKey : deploymentDiscoveryQuery(observation.scope).queryKey);
  const devHash = queryHash(dev), prodHash = queryHash(prod);
  const subscribe = useCallback((notify: () => void) => subscribeDeploymentInvalidations(client, [devHash, prodHash], notify), [client, devHash, prodHash]);
  const getInvalidations = useCallback(() => deploymentInvalidations(client, [devHash, prodHash]), [client, devHash, prodHash]);
  const invalidations = useSyncExternalStore(subscribe, getInvalidations, getInvalidations);
  const operations = useQuery({ ...operationsQuery(), enabled: false });
  const logScope = studio.selected ? developmentLogScope(studio.snapshot.models.dev, studio.selected) : undefined;
  const logs = useDevelopmentLogEvidence(studio.snapshot.repositoryRoot, studio.mode, studio.selected,
    includeLogEvidence && (!studio.selected || !!logScope && !["not-applicable", "unsupported"].includes(logScope.kind)));
  const workspace = useSightlineWorkspaceInputs();
  const capturedAt = Date.now();
  const deployments = { dev: deploymentInput(dev, client, capturedAt), prod: deploymentInput(prod, client, capturedAt) };
  // Query result wrappers change identity on render; only their allow-listed evidence
  // participates. No observation time is invented when the cache has no successful read.
  const deploymentKey = JSON.stringify(deployments);
  const availability = operations.isError ? "error" : operations.data ? "available" : operations.isFetching ? "loading" : "not-loaded";
  return useMemo(() => ({
    capturedAt: new Date(capturedAt).toISOString(), pathname, snapshot: studio.snapshot, mode: studio.mode, selected: studio.selected,
    source: { latestRevision: studio.response.snapshot.revision, evaluating: studio.live.evaluating || studio.response.evaluating,
      dirty: studio.draft.dirty, conflicted: studio.draft.conflict, connected: studio.live.connected },
    aliases: studio.entityAliases, workspace, deployments,
    activity: { jobs: operations.data?.jobs, availability,
      updatedAt: operations.dataUpdatedAt ? new Date(operations.dataUpdatedAt).toISOString() : undefined },
    developmentLogs: { availability: logs.isError ? "error" : logs.data ? "available" : logs.isFetching ? "loading" : "not-loaded", evidence: logs.data,
      updatedAt: logs.dataUpdatedAt ? new Date(logs.dataUpdatedAt).toISOString() : undefined },
  }), [pathname, studio.snapshot, studio.mode, studio.selected, studio.response.snapshot.revision, studio.live.evaluating,
    studio.response.evaluating, studio.draft.dirty, studio.draft.conflict, studio.live.connected, studio.entityAliases,
    workspace, deploymentKey, invalidations, operations.data, operations.dataUpdatedAt, availability, logs.data, logs.isError, logs.isFetching, logs.dataUpdatedAt]);
}

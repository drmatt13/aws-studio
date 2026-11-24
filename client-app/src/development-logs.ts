import { useQuery } from "@tanstack/react-query";
import type {
  DevelopmentLogEvidence,
  DevelopmentLogPage,
  DevelopmentLogRun,
} from "../shared/development-logs";
import type { Mode } from "../shared/model";
import { call } from "./http";
import type { DevelopmentTrace } from "../shared/development-traces";

export interface DevelopmentTraceOptions {
  readonly resource: string;
  readonly runId: string;
  readonly traceId: string;
}

export interface LogPageOptions {
  readonly resource?: string;
  readonly runId?: string;
  readonly search?: string;
  readonly level?: string;
  readonly kind?: string;
  readonly cursor?: string;
  readonly direction?: "older" | "newer";
  readonly limit?: number;
}
const search = (options: LogPageOptions) => {
  const params = new URLSearchParams({ mode: "dev" });
  for (const [key, value] of Object.entries(options))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};
export const developmentLogsApi = {
  trace: (options: DevelopmentTraceOptions, signal?: AbortSignal) =>
    call<DevelopmentTrace>(
      `/development-logs/trace?${new URLSearchParams({ mode: "dev", ...options })}`,
      undefined,
      signal,
    ),
  runs: (signal?: AbortSignal) =>
    call<{ schemaVersion: 1; runs: readonly DevelopmentLogRun[] }>(
      "/development-logs/runs?mode=dev",
      undefined,
      signal,
    ),
  entries: (options: LogPageOptions, signal?: AbortSignal) =>
    call<DevelopmentLogPage>(
      `/development-logs/entries?${search(options)}`,
      undefined,
      signal,
    ),
  evidence: (resource?: string, signal?: AbortSignal) =>
    call<DevelopmentLogEvidence>(
      `/development-logs/evidence?${search({ resource, limit: 24 })}`,
      undefined,
      signal,
    ),
};

/** Shared visible-consumer owner: Conversation and an expanded inspector join the same cache read. */
export function useDevelopmentTrace(
  repository: string,
  mode: Mode,
  resource?: string,
  runId?: string,
  traceId?: string,
  active = true,
) {
  const enabled =
    active && mode === "dev" && !!resource && !!runId && !!traceId;
  return useQuery({
    queryKey: ["development-trace", repository, resource, runId, traceId],
    queryFn: ({ signal }) => {
      if (!enabled)
        throw new Error(
          "Development trace reads require a visible Development consumer and a selected trace.",
        );
      return developmentLogsApi.trace(
        { resource: resource!, runId: runId!, traceId: traceId! },
        signal,
      );
    },
    enabled,
    staleTime: 2_000,
    refetchInterval: (query) =>
      enabled && query.state.data?.collection === "collecting" ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 30_000,
  });
}

/** The visible Sightline/Coding consumer may read only this bounded, sanitized local cache. */
export function useDevelopmentLogEvidence(
  repository: string,
  mode: Mode,
  resource?: string,
  applicable = true,
) {
  return useQuery({
    queryKey: ["development-log-evidence", repository, resource ?? null],
    queryFn: ({ signal }) => developmentLogsApi.evidence(resource, signal),
    enabled: mode === "dev" && applicable,
    staleTime: 2_000,
    refetchInterval: mode === "dev" && applicable ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 30_000,
  });
}

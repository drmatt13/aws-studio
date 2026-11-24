import type { DevelopmentLogControl } from "aws-studio/development-logs";

export const DEVELOPMENT_FOLLOWER_CHECKPOINT_BYTES = 256 * 1024;
export interface DevelopmentFollowerCheckpoint {
  readonly version: 1;
  readonly repositoryKey: string;
  readonly composeProject: string;
  readonly runtimeSessionId: string;
  readonly bindingId: string;
  readonly containers: Record<
    string,
    {
      startedAt: string;
      completed?: boolean;
      lifecycleHash?: string;
      stdout?: { at: string; counts: Record<string, number> };
      stderr?: { at: string; counts: Record<string, number> };
    }
  >;
}
/** Fixed metadata only: callers cannot choose a cache path or persist raw output. */
export function validateDevelopmentFollowerCheckpoint(
  value: unknown,
  control: DevelopmentLogControl,
): DevelopmentFollowerCheckpoint | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Buffer.byteLength(JSON.stringify(value)) >
      DEVELOPMENT_FOLLOWER_CHECKPOINT_BYTES
  )
    return undefined;
  const data = value as DevelopmentFollowerCheckpoint;
  if (
    data.version !== 1 ||
    data.repositoryKey !== control.repositoryKey ||
    data.composeProject !== control.composeProject ||
    data.runtimeSessionId !== control.runtimeSessionId ||
    data.bindingId !== control.bindingId ||
    !data.containers ||
    typeof data.containers !== "object" ||
    Array.isArray(data.containers) ||
    Object.keys(data.containers).length > 128
  )
    return undefined;
  const result: DevelopmentFollowerCheckpoint = {
    version: 1,
    repositoryKey: control.repositoryKey,
    composeProject: control.composeProject,
    runtimeSessionId: control.runtimeSessionId,
    bindingId: control.bindingId,
    containers: Object.create(null),
  };
  for (const [id, entry] of Object.entries(data.containers)) {
    if (
      !/^[a-f0-9]{12,64}$/.test(id) ||
      !entry ||
      typeof entry.startedAt !== "string" ||
      entry.startedAt.length > 64 ||
      (entry.startedAt !== "unknown" &&
        !Number.isFinite(Date.parse(entry.startedAt)))
    )
      return undefined;
    const safe: DevelopmentFollowerCheckpoint["containers"][string] = {
      startedAt: entry.startedAt,
      completed: entry.completed === true,
    };
    if (entry.lifecycleHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(entry.lifecycleHash)) return undefined;
      safe.lifecycleHash = entry.lifecycleHash;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const cursor = entry[stream];
      if (!cursor) continue;
      if (
        typeof cursor.at !== "string" ||
        cursor.at.length > 40 ||
        !Number.isFinite(Date.parse(cursor.at)) ||
        !cursor.counts ||
        Object.keys(cursor.counts).length > 8
      )
        return undefined;
      const counts: Record<string, number> = Object.create(null);
      for (const [hash, count] of Object.entries(cursor.counts)) {
        if (
          !/^[a-f0-9]{64}$/.test(hash) ||
          !Number.isSafeInteger(count) ||
          count < 1 ||
          count >= 1_000_000
        )
          return undefined;
        counts[hash] = count;
      }
      safe[stream] = { at: cursor.at, counts };
    }
    result.containers[id] = safe;
  }
  return result;
}

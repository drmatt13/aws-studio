import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  normalizeFrameworkConfig,
  type FrameworkConfig,
} from "aws-studio/config";
import {
  DevelopmentTextFramer,
  developmentSecrets,
  sanitizeDevelopmentText,
  observeDevelopment,
  withDevelopmentObservation,
  type DevelopmentLogControl,
  type DevelopmentObservationInput,
} from "aws-studio/development-logs";

const execute = promisify(execFile);
const CAPACITY = 128;
const CHECKPOINT_BYTES = 256 * 1024;
interface StreamCursor {
  at: string;
  counts: Record<string, number>;
}
interface Checkpoint {
  startedAt: string;
  completed?: boolean;
  lifecycleHash?: string;
  stdout?: StreamCursor;
  stderr?: StreamCursor;
}
interface Checkpoints {
  version: 1;
  repositoryKey: string;
  composeProject: string;
  runtimeSessionId: string;
  bindingId: string;
  containers: Record<string, Checkpoint>;
}
interface FollowOptions {
  repositoryRoot: string;
  projectName: string;
  config: FrameworkConfig;
}
export interface ComposeOutputDependencies {
  readonly command?: (args: readonly string[]) => Promise<string>;
  readonly follow?: (args: readonly string[]) => ChildProcess;
  readonly emit?: (event: DevelopmentObservationInput) => void;
  readonly checkpoint?: {
    load(): Promise<unknown>;
    save(value: unknown): Promise<void>;
  };
  readonly now?: () => number;
  readonly autoPoll?: boolean;
}

function normalizedHostPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}
export function ownsDevelopmentComposeContainer(
  labels: Record<string, unknown>,
  control: DevelopmentLogControl,
): boolean {
  if (
    !control.hostRepositoryRoot ||
    labels["com.docker.compose.project"] !== control.composeProject
  )
    return false;
  const expected = normalizedHostPath(control.hostRepositoryRoot);
  const working = labels["com.docker.compose.project.working_dir"],
    configs = labels["com.docker.compose.project.config_files"];
  return (
    typeof working === "string" &&
    normalizedHostPath(working) === expected &&
    typeof configs === "string" &&
    (`,` + normalizedHostPath(configs) + `,`).includes(
      `,${expected}/docker-compose.yml,`,
    )
  );
}
/** Only fixed server lifecycle summaries survive; statements/detail/context never do. */
export function postgresDevelopmentLifecycle(text: string): string | undefined {
  const message =
    /^\s*(?:\d{4}-\d\d-\d\d\s+\S+\s+\S+\s+)?\[\d+\]\s+LOG:\s+(.*?)(?:\r?\n)?$/.exec(
      text,
    )?.[1];
  if (!message) return undefined;
  const fixed = [
    "database system is ready to accept connections",
    "database system is shut down",
    "received fast shutdown request",
    "received smart shutdown request",
    "database system was interrupted",
  ];
  return (
    fixed.find(
      (value) =>
        message === value ||
        (value === "database system was interrupted" &&
          message.startsWith(value + ";")),
    ) ??
    (/^starting PostgreSQL \d+(?:\.\d+)*(?:\s|$)/.test(message)
      ? "starting PostgreSQL"
      : undefined)
  );
}
function timestamp(value: unknown, now: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(
    value,
  );
  return match &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= now + 30_000
    ? `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`
    : undefined;
}

/** Project-scoped Docker readers. They never run commands supplied by browser requests. */
export function followDevelopmentComposeOutput(
  options: FollowOptions,
  control: DevelopmentLogControl,
  dependencies: ComposeOutputDependencies = {},
): { inspect(): Promise<void>; close(): Promise<void> } {
  const now = dependencies.now ?? Date.now;
  const command =
    dependencies.command ??
    (async (args) =>
      (
        await execute("docker", [...args], {
          timeout: 3000,
          maxBuffer: 256 * 1024,
        })
      ).stdout);
  const follow =
    dependencies.follow ??
    ((args) =>
      spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] }));
  const emit = (event: DevelopmentObservationInput): void =>
    withDevelopmentObservation(
      { isolated: true, resourceId: event.resourceId, correlation: {} },
      () => (dependencies.emit ?? observeDevelopment)(event),
    );
  const services = new Map(
    [...normalizeFrameworkConfig(options.config).targets.values()]
      .filter((target) => target.kind === "service")
      .map((target) => [target.id, target.reference as string]),
  );
  services.set("postgres", "local:postgres");
  const checkpoints: Checkpoints = {
    version: 1,
    repositoryKey: control.repositoryKey,
    composeProject: control.composeProject,
    runtimeSessionId: control.runtimeSessionId,
    bindingId: control.bindingId,
    containers: {},
  };
  let closed = false,
    polling = false,
    dirty = false,
    checkpointFailed = false;
  let writes = Promise.resolve();
  const active = new Map<
    string,
    { child: ChildProcess; finish(): void; completed: Promise<void> }
  >();
  const staleSessions = new Set<string>();
  const gap = (resourceId: string, message: string): void =>
    emit({ resourceId, kind: "collector.source_gap", level: "warn", message });
  const initialized = (async () => {
    if (!dependencies.checkpoint) return;
    try {
      const data = (await dependencies.checkpoint.load()) as
        Checkpoints | undefined;
      if (!data) return;
      if (
        data.version !== 1 ||
        data.repositoryKey !== control.repositoryKey ||
        data.composeProject !== control.composeProject ||
        data.runtimeSessionId !== control.runtimeSessionId ||
        data.bindingId !== control.bindingId ||
        !data.containers ||
        Object.keys(data.containers).length > CAPACITY
      )
        return;
      for (const [id, entry] of Object.entries(data.containers)) {
        if (
          !/^[a-f0-9]{12,64}$/.test(id) ||
          typeof entry.startedAt !== "string"
        )
          continue;
        const safe: Checkpoint = {
          startedAt: entry.startedAt,
          completed: entry.completed === true,
          ...(typeof entry.lifecycleHash === "string" &&
          /^[a-f0-9]{64}$/.test(entry.lifecycleHash)
            ? { lifecycleHash: entry.lifecycleHash }
            : {}),
        };
        for (const stream of ["stdout", "stderr"] as const) {
          const cursor = entry[stream],
            at = timestamp(cursor?.at, now());
          if (
            at &&
            cursor &&
            cursor.counts &&
            Object.keys(cursor.counts).length <= 8 &&
            Object.entries(cursor.counts).every(
              ([key, count]) =>
                /^[a-f0-9]{64}$/.test(key) &&
                Number.isSafeInteger(count) &&
                count > 0 &&
                count < 1_000_000,
            )
          )
            safe[stream] = { at, counts: cursor.counts };
        }
        checkpoints.containers[id] = safe;
      }
      gap(
        "runtime:development",
        "Container collection restarted. Recent queued output may not have reached storage; bounded Docker backfill will be attempted.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        checkpointFailed = true;
        gap(
          "runtime:development",
          "Container output checkpoints are unavailable; backfill may repeat recent entries.",
        );
      }
    }
  })();
  const save = (): Promise<void> => {
    if (!dependencies.checkpoint || !dirty) return writes;
    dirty = false;
    const text = JSON.stringify(checkpoints);
    if (Buffer.byteLength(text) > CHECKPOINT_BYTES) {
      gap(
        "runtime:development",
        "Container checkpoint capacity was reached; reconnect evidence may repeat.",
      );
      return writes;
    }
    writes = writes.then(async () => {
      try {
        await dependencies.checkpoint!.save(JSON.parse(text));
      } catch {
        if (!checkpointFailed)
          gap(
            "runtime:development",
            "Container output checkpoints could not be saved; reconnect evidence may repeat.",
          );
        checkpointFailed = true;
      }
    });
    return writes;
  };
  const inspect = async (): Promise<void> => {
    await initialized;
    if (closed || polling) return;
    polling = true;
    try {
      const inventory = await command([
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${control.composeProject}`,
        "--format",
        "{{json .}}",
      ]);
      for (const line of inventory
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 1024)) {
        if (closed) break;
        const { ID: id } = JSON.parse(line) as { ID: string };
        if (!/^[a-f0-9]{12,64}$/.test(id) || active.has(id)) continue;
        const value = JSON.parse(
          await command(["inspect", "--format", "{{json .}}", id]),
        );
        const labels = value.Config?.Labels ?? {},
          service = labels["com.docker.compose.service"];
        const resourceId = services.get(service);
        if (!resourceId || !ownsDevelopmentComposeContainer(labels, control))
          continue;
        const session = Array.isArray(value.Config?.Env)
          ? value.Config.Env.find(
              (entry: unknown) =>
                typeof entry === "string" &&
                entry.startsWith("FRAMEWORK_DEVELOPMENT_LOG_SESSION="),
            )?.slice("FRAMEWORK_DEVELOPMENT_LOG_SESSION=".length)
          : undefined;
        if (session && session !== control.runtimeSessionId) {
          if (!staleSessions.has(id) && staleSessions.size < CAPACITY) {
            staleSessions.add(id);
            emit({
              resourceId,
              kind: "collector.source_session_unavailable",
              level: "warn",
              details: {
                originalRuntimeSessionId: /^[a-f0-9-]{36}$/i.test(session)
                  ? session
                  : "unknown",
                reason:
                  "This container belongs to a different development runtime session. Its output is not recaptured into this run.",
              },
            });
          }
          continue;
        }
        const argv: unknown[] = value.Config?.Cmd ?? [];
        const wrapper = argv.findIndex(
          (arg) =>
            typeof arg === "string" && /(?:^|\/)run-service\.ts$/.test(arg),
        );
        if (
          service !== "postgres" &&
          (wrapper < 0 || argv[wrapper + 1] !== service)
        )
          continue;
        if (
          !checkpoints.containers[id] &&
          Object.keys(checkpoints.containers).length >= CAPACITY
        ) {
          const retired = Object.keys(checkpoints.containers).find(
            (key) => checkpoints.containers[key]?.completed && !active.has(key),
          );
          if (retired) delete checkpoints.containers[retired];
        }
        if (
          active.size >= CAPACITY ||
          (!checkpoints.containers[id] &&
            Object.keys(checkpoints.containers).length >= CAPACITY)
        ) {
          gap(
            resourceId,
            "Container follower capacity was reached; this stream is unavailable.",
          );
          continue;
        }
        const startedAt = String(value.State?.StartedAt ?? "unknown");
        const previous = checkpoints.containers[id];
        const entry = previous ?? { startedAt };
        const state = value.State ?? {};
        const lifecycle = {
          status:
            typeof state.Status === "string"
              ? state.Status
              : state.Running
                ? "running"
                : "stopped",
          startedAt,
          finishedAt:
            typeof state.FinishedAt === "string" ? state.FinishedAt : undefined,
          exitCode: Number.isInteger(state.ExitCode)
            ? state.ExitCode
            : undefined,
          oomKilled: state.OOMKilled === true,
          error:
            typeof state.Error === "string"
              ? sanitizeDevelopmentText(
                  state.Error,
                  developmentSecrets(resourceId),
                ).slice(0, 2000)
              : undefined,
        };
        const lifecycleHash = createHash("sha256")
          .update(JSON.stringify(lifecycle))
          .digest("hex");
        if (entry.lifecycleHash !== lifecycleHash) {
          emit({
            resourceId,
            kind: "container.lifecycle",
            level:
              lifecycle.oomKilled ||
              lifecycle.error ||
              (!state.Running && lifecycle.exitCode)
                ? "error"
                : "info",
            attribution: "resource",
            details: {
              ...lifecycle,
              containerId: id,
              evidence:
                "Docker process observation; application readiness is separate",
            },
          });
          entry.lifecycleHash = lifecycleHash;
          checkpoints.containers[id] = entry;
          dirty = true;
        }
        if (
          previous?.completed &&
          previous.startedAt === startedAt &&
          !state.Running
        )
          continue;
        entry.startedAt = startedAt;
        entry.completed = false;
        checkpoints.containers[id] = entry;
        dirty = true;
        const positions = [entry.stdout?.at, entry.stderr?.at];
        const since = positions.every(Boolean)
          ? positions.sort()[0]!
          : control.startedAt;
        gap(
          resourceId,
          "Container output reattached with a 2000-line backfill limit. Earlier or uncommitted output may be unavailable.",
        );
        const child = follow([
          "logs",
          "--follow",
          "--timestamps",
          "--since",
          since,
          "--tail",
          "2000",
          id,
        ]);
        let done = false;
        let resolveCompleted!: () => void;
        const completed = new Promise<void>((resolve) => {
          resolveCompleted = resolve;
        });
        const frame = (stream: "stdout" | "stderr") => {
          const replayCounts = new Map<string, number>();
          return new DevelopmentTextFramer((text) => {
            const match = /^(\S+)\s(.*)$/s.exec(text),
              at = timestamp(match?.[1], now()),
              content = match?.[2];
            if (!at || content === undefined) {
              gap(
                resourceId,
                "A Docker output record had no usable timestamp and was omitted.",
              );
              return;
            }
            const lifecycle =
              service === "postgres"
                ? postgresDevelopmentLifecycle(content)
                : undefined;
            if (service === "postgres" && !lifecycle) return;
            const hash = createHash("sha256")
              .update(lifecycle ?? content.replace(/\r?\n$/, ""))
              .digest("hex");
            const cursor = entry[stream];
            if (cursor && at < cursor.at) return;
            const key = `${at}:${hash}`,
              count = (replayCounts.get(key) ?? 0) + 1;
            if (replayCounts.size >= 128 && !replayCounts.has(key))
              replayCounts.clear();
            replayCounts.set(key, count);
            if (
              cursor &&
              at === cursor.at &&
              count <= (cursor.counts[hash] ?? 0)
            )
              return;
            if (!cursor || at > cursor.at)
              entry[stream] = { at, counts: { [hash]: count } };
            else if (
              Object.keys(cursor.counts).length < 8 ||
              hash in cursor.counts
            )
              cursor.counts[hash] = count;
            else {
              gap(
                resourceId,
                "Too many Docker records shared a timestamp; duplicate detection is limited.",
              );
              return;
            }
            dirty = true;
            if (service === "postgres") {
              if (lifecycle)
                emit({
                  resourceId,
                  kind: "database.lifecycle",
                  message: lifecycle,
                  occurredAt: at,
                  attribution: "resource",
                });
            } else
              emit({
                resourceId,
                kind: "process.output",
                stream,
                message: content,
                occurredAt: at,
                attribution: "resource",
                details: { containerId: id },
              });
          }, developmentSecrets(resourceId));
        };
        const out = frame("stdout"),
          err = frame("stderr");
        const finish = (): void => {
          if (done) return;
          done = true;
          out.flush();
          err.flush();
          entry.completed = !Boolean(value.State?.Running);
          dirty = true;
          active.delete(id);
          resolveCompleted();
        };
        active.set(id, { child, finish, completed });
        child.stdout?.on("data", (chunk) => out.push(chunk));
        child.stderr?.on("data", (chunk) => err.push(chunk));
        child.once("error", () => {
          gap(
            resourceId,
            "Docker output could not be followed; a bounded reconnect will be attempted.",
          );
          finish();
        });
        child.once("close", finish);
      }
      await save();
    } catch {
      gap(
        "runtime:development",
        "Docker output inventory is unavailable; collection will retry without changing application execution.",
      );
    } finally {
      polling = false;
    }
  };
  const poll =
    dependencies.autoPoll === false
      ? undefined
      : setInterval(() => {
          void inspect();
        }, 5000);
  poll?.unref();
  const checkpointTimer =
    dependencies.autoPoll === false
      ? undefined
      : setInterval(() => {
          void save();
        }, 1000);
  checkpointTimer?.unref();
  if (dependencies.autoPoll !== false) void inspect();
  return {
    inspect,
    async close() {
      closed = true;
      if (poll) clearInterval(poll);
      if (checkpointTimer) clearInterval(checkpointTimer);
      await initialized;
      const followers = [...active.values()];
      for (const follower of followers) follower.child.kill();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(followers.map((follower) => follower.completed)),
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 1000);
        }),
      ]);
      if (deadline) clearTimeout(deadline);
      for (const follower of followers) follower.finish();
      await save();
      await writes;
    },
  };
}

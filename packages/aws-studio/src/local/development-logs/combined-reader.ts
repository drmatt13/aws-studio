import path from "node:path";
import type {
  DevelopmentLogPage,
  DevelopmentLogQuery,
  DevelopmentLogRun,
  DevelopmentLogTraceQuery,
  DevelopmentLogTracePage,
} from "../../development-logs/contract";
import { DevelopmentLogReader } from "./store";

/** The host startup spool remains readable even if preparation prevented the runner from starting. */
export class CombinedDevelopmentLogReader {
  private readonly main: DevelopmentLogReader;
  private readonly bootstrap: DevelopmentLogReader;
  constructor(directory: string) {
    this.main = new DevelopmentLogReader(directory);
    this.bootstrap = new DevelopmentLogReader(
      path.join(directory, "bootstrap"),
    );
  }
  async runs(): Promise<DevelopmentLogRun[]> {
    const [main, bootstrap] = await Promise.all([
      this.main.runs(),
      this.bootstrap.runs(),
    ]);
    return [
      ...new Map(
        [...bootstrap, ...main].map((run) => [run.runtimeSessionId, run]),
      ).values(),
    ]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 20);
  }
  async trace(
    query: DevelopmentLogTraceQuery,
  ): Promise<DevelopmentLogTracePage> {
    // A trace is pinned to one known run: do not enumerate every retained manifest.
    const main = await this.main.trace(query);
    if (main.run) return main;
    const startup = await this.bootstrap.trace(query);
    return startup.run ? startup : main;
  }
  async entries(query: DevelopmentLogQuery = {}): Promise<DevelopmentLogPage> {
    const [main, bootstrap] = await Promise.all([
      this.main.runs(),
      this.bootstrap.runs(),
    ]);
    const origin = query.cursor?.startsWith("startup:")
      ? "startup"
      : query.cursor?.startsWith("runtime:")
        ? "runtime"
        : undefined;
    if (query.cursor && !origin)
      throw Object.assign(new Error("Invalid development log cursor."), {
        status: 400,
      });
    const innerCursor = query.cursor?.slice(query.cursor.indexOf(":") + 1);
    const wrap = (
      page: DevelopmentLogPage,
      source: "startup" | "runtime",
      transitioned = false,
    ): DevelopmentLogPage => ({
      ...page,
      olderCursor: page.olderCursor
        ? `${source}:${page.olderCursor}`
        : undefined,
      nextCursor: page.nextCursor ? `${source}:${page.nextCursor}` : undefined,
      gaps: transitioned
        ? [
            ...page.gaps,
            {
              reason: "restart" as const,
              at: page.observedAt,
              message:
                "Startup evidence moved into the runtime cache; the page was refreshed.",
            },
          ].slice(-64)
        : page.gaps,
    });
    // Let the signed cursor's own cache bind its run. Choosing the latest run here
    // silently reassigns old history or rejects valid pagination after a restart.
    if (origin === "runtime")
      return wrap(
        await this.main.entries({ ...query, cursor: innerCursor }),
        "runtime",
      );
    if (origin === "startup") {
      const prior = await this.bootstrap.entries({
        ...query,
        cursor: innerCursor,
      });
      const boundRun = prior.run?.runtimeSessionId;
      // Validate the original signature/scope before any cache transition resets it.
      if (boundRun && main.some((run) => run.runtimeSessionId === boundRun))
        return wrap(
          await this.main.entries({
            ...query,
            runId: boundRun,
            cursor: undefined,
            direction: "older",
          }),
          "runtime",
          true,
        );
      return wrap(prior, "startup");
    }
    const all = [
      ...new Map(
        [...bootstrap, ...main].map((run) => [run.runtimeSessionId, run]),
      ).values(),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const runId = query.runId ?? all[0]?.runtimeSessionId,
      runtimeAvailable = main.some((run) => run.runtimeSessionId === runId);
    const source = runtimeAvailable ? "runtime" : "startup";
    const page = await (runtimeAvailable ? this.main : this.bootstrap).entries({
      ...query,
      runId,
    });
    if (
      runtimeAvailable &&
      !page.entries.length &&
      bootstrap.some((run) => run.runtimeSessionId === runId)
    ) {
      const pending = await this.bootstrap.entries({ ...query, runId });
      if (pending.entries.length)
        return wrap(
          {
            ...pending,
            run: page.run,
            collection: page.collection,
            gaps: [
              ...pending.gaps,
              {
                reason: "restart" as const,
                at: page.observedAt,
                message:
                  "Showing cached startup evidence while it is imported into the runtime cache.",
              },
            ].slice(-64),
          },
          "startup",
        );
    }
    return wrap(page, source);
  }
}

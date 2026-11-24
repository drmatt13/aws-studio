import path from "node:path";
import { run } from "node:test";
import { pipeline } from "node:stream/promises";

/** Pinned by the inspection host. Authored stdout is never interpreted as proof. */
export default async function* report(events: AsyncIterable<{ type: string; data: unknown }>) {
  let summary: unknown;
  let executedTests = 0;
  for await (const event of events) {
    if (event.type === "test:summary") summary = event.data;
    if (event.type === "test:pass" || event.type === "test:fail") {
      const value = event.data as { name?: string; file?: string; skip?: unknown; todo?: unknown; details?: { type?: string } };
      // Node treats an empty file as a passing synthetic test named after the
      // file. That wrapper is process evidence, not an executed behavioral test.
      const fileWrapper = value.name && value.file && path.resolve(value.name) === path.resolve(value.file);
      if (value.details?.type === "test" && !fileWrapper && !value.skip && !value.todo) executedTests++;
    }
  }
  yield JSON.stringify(summary && typeof summary === "object" ? { ...summary, executedTests } : null);
}

/** Run after native startup preloads; CLI reporters load before those preloads. */
export async function runReporter(files: string[]): Promise<void> {
  try {
    if (files.length !== 1) throw new Error("Exactly one required behavioral suite must be selected.");
    const events = run({ files, isolation: "process", concurrency: 1 });
    events.on("test:summary", summary => { if (!summary.success) process.exitCode = 1; });
    await pipeline(events, report, process.stdout);
  } catch (error) { console.error(error); process.exitCode = 1; }
}

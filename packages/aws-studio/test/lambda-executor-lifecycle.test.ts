import { testProjectScratch } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { defineFrameworkConfig } from "../src/config";
import { LocalLambdaExecutor } from "../src/local";
import { defaults } from "../../../scripts/test-project-declarations";

test("closing a cold-only executor cancels an active handler and prevents further execution", async () => {
  const fixture = testProjectScratch("executor-close-");
  const handler = path.join(fixture, "compute/events/probe");
  mkdirSync(handler, { recursive: true });
  writeFileSync(path.join(handler, "index.ts"), `import { renameSync, writeFileSync } from "node:fs";
export async function lambdaHandler(event: { started: string }) {
  writeFileSync(event.started + ".pending", String(process.pid));
  renameSync(event.started + ".pending", event.started);
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}`);
  const config = defineFrameworkConfig({ defaults, http: [], webSocket: [], services: [], events: [{ probe: { directory: "compute/events/probe", subnet: "none", timeoutSeconds: 60 } }] });
  const executor = new LocalLambdaExecutor({ config, repositoryRoot: fixture, pool: null });
  let pending: Promise<unknown> | undefined;
  try {
    const marker = path.join(fixture, "started");
    pending = executor.invoke("lambda:probe", { started: marker });
    const stopped = assert.rejects(pending, /closed|shutting down/);
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker)) {
      assert.ok(Date.now() < deadline, "cold handler started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = Number(readFileSync(marker, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "the handler atomically published its positive process ID");
    executor.close();
    executor.close();
    await stopped;
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the cold child has exited before cancellation settles");
    await assert.rejects(executor.invoke("lambda:probe", { started: marker }), /closed|shutting down/);
  } finally {
    executor.close();
    await pending?.catch(() => undefined);
    rmSync(fixture, { recursive: true, force: true });
  }
});

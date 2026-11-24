import assert from "./support/assert";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskClient } from "../server/agent-runtime/client";
import { startAgentHost } from "../server/agent-runtime/host";
import { agentEndpoint, callAgentHost, type AgentHostInfo } from "../server/agent-runtime/ipc";
import { readAgentRuntimeUpgrade } from "../server/agent-runtime/runtime-upgrade";
import { identityAlive } from "aws-studio/source/identity";

test("client starts an owned host and recovers a stopped ready host from its retained release", async t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-client-startup-")));
  const root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root); writeFileSync(path.join(root, "package.json"), '{"name":"disposable-client-startup"}');
  writeFileSync(path.join(root, "saved.ts"), "export const saved = true;\n");
  const client = new AgentTaskClient(root, state), endpoint = agentEndpoint(root, state);
  async function stop(info: AgentHostInfo): Promise<void> {
    assert.ok(info.identity); assert.ok(info.releaseDigest);
    await callAgentHost(endpoint, "/runtime/drain", { requestId: randomUUID(), targetDigest: info.releaseDigest, expectedToken: info.identity.token });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (identityAlive(info.identity) === false) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail("The exact owned fixture host did not finish its drain.");
  }
  t.after(async () => {
    client.close();
    try { await stop(await callAgentHost<AgentHostInfo>(endpoint, "/ping", undefined, process.platform === "win32" ? 5000 : 500)); }
    catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await client.ping();
  assert.ok(first.identity); assert.ok(first.releaseDigest); assert.equal(first.root, root);
  const requestId = randomUUID();
  assert.equal((await client.restartHost(requestId)).phase, "ready");
  const activated = await client.ping();
  await stop(activated);
  // A changed checkout must not select a new runtime during ordinary reconnect.
  mkdirSync(path.join(root, "client-app/server/agent-runtime"), { recursive: true });
  writeFileSync(path.join(root, "client-app/server/agent-runtime/host.ts"), 'throw new Error("not explicitly activated");\n');
  const recovered = await client.ping();
  assert.notEqual(recovered.pid, activated.pid); assert.equal(recovered.releaseDigest, activated.releaseDigest);
  const retained = readAgentRuntimeUpgrade(root, state);
  assert.equal(retained?.requestId, requestId); assert.equal(retained?.phase, "ready");
  assert.equal(retained?.launchedIdentity?.pid, recovered.pid); assert.equal(retained?.launchPending, undefined);
  assert.equal(readFileSync(path.join(root, "saved.ts"), "utf8"), "export const saved = true;\n");
  assert.deepEqual(await client.list(), { tasks: [] });
});

test("a closed task observer cannot acquire new runtime state", t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-client-closed-")));
  const root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = new AgentTaskClient(root, state);
  client.close(); client.close();
  assert.throws(() => client.runtimeUpgrade(), /observer is closed/);
  assert.equal(existsSync(state), false);
});

test("a retained host without a pinned restart target still serves ordinary agent requests", async t => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-client-pre-activation-")));
  const root = path.join(directory, "project"), state = path.join(directory, "state");
  mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), '{"name":"disposable-legacy-observer"}');
  const client = new AgentTaskClient(root, state, () => { assert.fail("The retained host cannot accept restart registration."); });
  let host: Awaited<ReturnType<typeof startAgentHost>> | undefined;
  t.after(async () => {
    client.close();
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  host = await startAgentHost(root, state, {
    runProvider: async () => { assert.fail("The legacy observer must not start a provider."); },
    integrate: async () => { assert.fail("The legacy observer must not integrate a proposal."); },
  });
  assert.deepEqual(await client.list(), { tasks: [] });
  await assert.rejects(client.activate(randomUUID(), "0".repeat(64)), /Restart agent host/);
});

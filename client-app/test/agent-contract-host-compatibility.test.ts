import { platformSourceRoot, testProjectRoot, testProjectScratch } from "../../scripts/test-project";
import assert from "./support/assert";
import { studioContractControl } from "../server/agent-runtime/contract-control";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentTaskClient } from "../server/agent-runtime/client";
import { nativeAgentOptions } from "../server/agent-runtime/host";
import type { AgentRuntimeRelease } from "../server/agent-runtime/runtime-release-manifest";
import type { AgentWorkspace } from "aws-studio/source/workspace";
import { contractTaskFixture } from "./support/contract-propagation";
import { portableProofPolicy, projectVerifierRoot } from "aws-studio/contract-chain/portable-identity";

test("an obsolete host cannot receive bypassed advancing or Apply requests for retained contracts", async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-old-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = new AgentTaskClient(root, path.join(root, "state")), task = contractTaskFixture("client"), forwarded: string[] = [];
  Object.assign(client, { ping: async () => ({ capabilities: ["contract-propagation-v1"] }), get: async () => task, call: async (route: string) => { forwarded.push(route); return task; } });
  for (const action of ["resume", "continue", "approve", "refresh"] as const) await assert.rejects(client.action(task.id, action, { digest: task.proposalDigest }), /older agent host|Restart agent host/);
  assert.deepEqual(forwarded, [], "rejected actions perform no host mutation");
  for (const action of ["cancel", "reject", "cleanup"] as const) await client.action(task.id, action);
  assert.equal(forwarded.length, 3, "retention, rejection and cancellation remain compatible");
  client.close();
});

test("native contract callbacks reject legacy releases even when authenticated IPC bypasses the client", () => {
  const options = nativeAgentOptions({ version: 1 } as AgentRuntimeRelease), task = contractTaskFixture(), workspace = {} as AgentWorkspace;
  assert.throws(() => options.contractOrigin!("/unused", task.contract!.context), /legacy agent host|restart the agent host/);
  assert.throws(() => options.contractIdentity!(workspace, "client"), /legacy agent host|restart the agent host/);
  assert.throws(() => options.contractRefreshContext!("/unused", "client", [], task.contract!.context), /legacy agent host|restart the agent host/);
  assert.throws(() => options.validateContract!({ workspace, stage: "client", signal: new AbortController().signal, onOutput: () => {} }), /legacy agent host|restart the agent host/);
  assert.equal(typeof options.runProvider, "function", "generic native Coding remains configured");
});

test("generic tasks and compatible contract hosts retain their existing actions", async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-host-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = new AgentTaskClient(root, path.join(root, "state")), task = contractTaskFixture(), forwarded: string[] = [];
  Object.assign(client, { ping: async () => ({ capabilities: ["contract-proof-v1"] }), call: async (route: string) => { forwarded.push(route); return task; } });
  await client.action(task.id, "approve");
  Object.assign(client, { ping: async () => ({}), get: async () => ({ ...task, contract: undefined }) });
  await client.action(task.id, "resume");
  assert.deepEqual(forwarded, [`/tasks/${task.id}/approve`, `/tasks/${task.id}/resume`]);
  client.close();
});

test("one-click execution modes require a capable host before submitting or promoting a contract", async t => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-contract-run-host-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = new AgentTaskClient(root, path.join(root, "state")), task = contractTaskFixture(), forwarded: string[] = [];
  const request = { requestKey: "one-click-contract-run", provider: "codex" as const, prompt: "Preserve current source behavior.", contract: task.contract!.context, contractRun: "sequential" as const };
  Object.assign(client, { ping: async () => ({ capabilities: ["contract-proof-v1"] }), call: async (route: string) => { forwarded.push(route); return task; } });
  await assert.rejects(client.submit(request), /one-click contract runs|Restart agent host/);
  await assert.rejects(client.action(task.id, "continue", { digest: task.proposalDigest, contractRun: "sequential" }), /one-click contract runs|Restart agent host/);
  assert.deepEqual(forwarded, []);
  Object.assign(client, { ping: async () => ({ capabilities: ["contract-proof-v1", "contract-runs-v1"] }) });
  await client.submit(request);
  await client.action(task.id, "continue", { digest: task.proposalDigest, contractRun: "stage" });
  assert.deepEqual(forwarded, ["/tasks", `/tasks/${task.id}/continue`]);
  client.close();
});

test("guided submissions and continuation reject an older pinned checker before mutating the host", async t => {
  const state = testProjectScratch("contract-host-compatibility-");
  const client = new AgentTaskClient(testProjectRoot, state), task = contractTaskFixture(), forwarded: string[] = [];
  t.after(() => { client.close(); rmSync(state, { recursive: true, force: true }); });
  const request = { requestKey: "stale-checker-contract-run", provider: "codex" as const, prompt: "Preserve current source behavior.", contract: task.contract!.context, contractRun: "sequential" as const };
  const capabilities = ["contract-proof-v1", "contract-runs-v1"], current = portableProofPolicy(projectVerifierRoot(testProjectRoot)).digest;
  Object.assign(client, { ping: async () => ({ capabilities, contractPolicyDigest: "0".repeat(64) }), call: async (route: string) => { forwarded.push(route); return task; } });
  await assert.rejects(client.submit(request), /pinned contract checker.*Restart agent host/);
  await assert.rejects(client.action(task.id, "continue", { digest: task.proposalDigest, contractRun: "sequential" }), /pinned contract checker.*Restart agent host/);
  assert.deepEqual(forwarded, []);
  // The receipts' policy alone is not enough: the pinned host's Studio contract code must be current too.
  Object.assign(client, { ping: async () => ({ capabilities, contractPolicyDigest: current, contractControlDigest: "0".repeat(64) }) });
  await assert.rejects(client.submit(request), /pinned contract checker.*Restart agent host/);
  Object.assign(client, { ping: async () => ({ capabilities, contractPolicyDigest: current }) });
  await assert.rejects(client.submit(request), /pinned contract checker.*Restart agent host/, "a host that predates Studio contract control is refused");
  assert.deepEqual(forwarded, []);
  Object.assign(client, { ping: async () => ({ capabilities, contractPolicyDigest: current, contractControlDigest: studioContractControl(platformSourceRoot) }) });
  await client.submit(request);
  await client.action(task.id, "continue", { digest: task.proposalDigest, contractRun: "stage" });
  assert.deepEqual(forwarded, ["/tasks", `/tasks/${task.id}/continue`]);
  client.close();
});

import { copyLocalTestProject } from "../../../test/cdk/support/isolated-project";
import { applicationVpc as fixtureVpc } from "../../../../../scripts/test-project-declarations";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { defineFrameworkConfig } from "aws-studio/config";
import { frameworkRepositoryRoot } from "aws-studio/config/source";
import { agentSessionId } from "aws-studio/runtime/agentcore";
import { defaults } from "../../../../../scripts/test-project-declarations";
import { LocalAgentSupervisor } from "../src/agents";

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

function probe(idleSeconds = 60) {
  const root = copyLocalTestProject();
  const name = `session-probe-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, "compute", "agents", name);
  mkdirSync(directory, { recursive: true });
  const write = (start: number) =>
    writeFileSync(
      path.join(directory, "index.ts"),
      [
        'import { z } from "zod";',
        'import { agent } from "aws-studio/runtime/agentcore";',
        `let count = ${start};`,
        'export const handler = agent("session-probe", { request: z.object({}), response: z.object({ pid: z.number(), count: z.number() }) })',
        "  .respond(async () => ({ pid: process.pid, count: ++count }));",
      ].join("\n"),
    );
  write(0);
  const selectedGateways: string[] = [];
  let description = "Echo.";
  const config = defineFrameworkConfig({ networks: [fixtureVpc],
    defaults,
    http: [],
    webSocket: [],
    events: [],
    services: [],
    tools: [{ echo: {} }],
    gateways: [{ first: { tools: ["echo"], deploy: "local-only" }, empty: { deploy: "local-only" } }],
    agents: [{ "session-probe": { directory: `compute/agents/${name}`, gateways: selectedGateways, deploy: "local-only", cloud: { idleSeconds } } }],
  });
  let now = Date.now();
  const supervisor = new LocalAgentSupervisor(config, root, "http://127.0.0.1:1", {
    loadTools: async () => ({ echo: { description, auth: false, inputSchema: { type: "object" }, outputSchema: { type: "object" } } }),
    now: () => now,
  });
  const invoke = async (conversationId: string) => {
    let body: { result: { pid: number; count: number } } | undefined;
    await supervisor.invoke(
      "session-probe",
      {
        headers: { "content-type": "application/json", [SESSION_HEADER]: agentSessionId("service", conversationId) },
        body: JSON.stringify({ conversationId, input: {} }),
      },
      async (response) => {
        assert.equal(response.status, 200);
        body = (await response.json()) as typeof body;
      },
    );
    return body!.result;
  };
  return {
    invoke,
    write,
    supervisor,
    selectGateways: (...ids: string[]) => selectedGateways.splice(0, selectedGateways.length, ...ids),
    describeTool: (value: string) => { description = value; },
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    dispose: async () => {
      await supervisor.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a conversation keeps its session process, another gets its own, and an edit restarts an idle one", async () => {
  const { invoke, write, dispose } = probe();
  try {
    const first = await invoke("a");
    const again = await invoke("a");
    assert.equal(again.pid, first.pid);
    assert.equal(again.count, 2);

    const other = await invoke("b");
    assert.notEqual(other.pid, first.pid);
    assert.equal(other.count, 1);

    write(100);
    const edited = await invoke("a");
    assert.notEqual(edited.pid, first.pid);
    assert.equal(edited.count, 101);
  } finally {
    await dispose();
  }
});

test("an idle session is released after the agent's declared idleSeconds, as AgentCore releases its microVM", async () => {
  const { invoke, advance, supervisor, dispose } = probe(120);
  try {
    const first = await invoke("a");
    advance(119);
    supervisor.sweep();
    assert.equal((await invoke("a")).pid, first.pid);
    advance(121);
    supervisor.sweep();
    assert.notEqual((await invoke("a")).pid, first.pid);
  } finally {
    await dispose();
  }
});

test("Gateway selections, empty Gateway bindings and live tool contracts restart idle sessions", async () => {
  const { invoke, selectGateways, describeTool, dispose } = probe();
  try {
    const unbound = await invoke("a");
    selectGateways("first");
    const bound = await invoke("a");
    assert.notEqual(bound.pid, unbound.pid);
    describeTool("Updated tool description.");
    const edited = await invoke("a");
    assert.notEqual(edited.pid, bound.pid);
    selectGateways("first", "empty");
    const withEmpty = await invoke("a");
    assert.notEqual(withEmpty.pid, edited.pid);
    assert.equal((await invoke("a")).pid, withEmpty.pid);
  } finally { await dispose(); }
});

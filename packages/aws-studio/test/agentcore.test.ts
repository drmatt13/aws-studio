import { applicationVpc as fixtureVpc } from "../../../scripts/test-project-declarations";
import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig,
  defineInputs, defineStacks,
  input, stack, cdk,
  getAgentTools,
  getGateways,
  getCloudGateways,
  getAgentBrowserRoutes,
  getFrameworkTargets,
  getCloudTargets,
  getLocalTargets,
  isTargetEnabled,
  invokesAgent,
  startsWorkflow,
  withDeferredInvocationAvailability,
  succeed,
  workflow,
  resolveLambdaTarget,
  type DeploySetting,
  type FrameworkConfig,
  type FrameworkConfigInput,
  type FrameworkHttp,
} from "../src/config/index";
import { defaults } from "../../../scripts/test-project-declarations";

/** The Cognito inputs a token verifier reads, which `auth: true` requires. */
const cognito = { USER_POOL_ID: "us-east-1_pool", USER_POOL_CLIENT_ID: "client" };

const base = { networks: [fixtureVpc],
  defaults: { ...defaults, tools: { timeoutSeconds: 20 } },
  http: [],
  webSocket: [],
  events: [],
  services: [],
} satisfies FrameworkConfigInput;

const tools = {
  "lookup-case": { auth: true, environment: cognito },
  echo: {},
} as const;

const agents = {
  "support-agent": { auth: true, gateways: ["support"], environment: cognito },
  "summarizer": { gateways: ["summary"] },
} as const;
const gateways = { support: { tools: ["lookup-case", "echo"] }, summary: { tools: ["echo"] } } as const;

const config = (overrides: Partial<FrameworkConfigInput> = {}): FrameworkConfig =>
  defineFrameworkConfig({ ...base, tools: [tools], agents: [agents], gateways: [gateways], ...overrides });

test("tools and agents take their directories from their ids", () => {
  const targets = new Map(getFrameworkTargets(config()).map((target) => [target.reference, target]));
  assert.equal(targets.get("lambda:lookup-case")?.role, "tool");
  assert.equal(targets.get("lambda:lookup-case")?.directory, "compute/tools/lookup-case");
  assert.equal(targets.get("agent:support-agent")?.directory, "compute/agents/support-agent");
});

test("an agent never uses the database; a tool can", () => {
  const catalog = defineStacks({ rds: stack<{ readonly database: { readonly connections: object; readonly node: { readonly id: string; readonly path: string } } }>() });
  assert.throws(
    () => config({
      stacks: catalog, database: { resource: catalog.rds.database, vpc: fixtureVpc },
      agents: [{ "support-agent": { vpc: fixtureVpc, ...agents["support-agent"], database: true } }],
    } as never),
    /declares database: true, but an AgentCore agent runs outside the VPC\. Give the work that needs the database to a tool/,
  );
  assert.doesNotThrow(() => config({
    stacks: catalog, database: { resource: catalog.rds.database, vpc: fixtureVpc },
    tools: [{ ...tools, "lookup-case": { vpc: fixtureVpc, ...tools["lookup-case"], database: true } }],
  } as never));
});

test("a tool inherits defaults.tools like any other section", () => {
  assert.equal(resolveLambdaTarget(config(), "echo").timeoutSeconds, 20);
});

test("an agent's selected Gateways resolve tools, named by tool id alone", () => {
  assert.deepEqual(getAgentTools(config(), "support-agent"), [
    { id: "lookup-case", gatewayId: "support", auth: true, wireName: "lookup-case___lookup-case" },
    { id: "echo", gatewayId: "support", auth: false, wireName: "echo___echo" },
  ]);
  assert.deepEqual(getAgentTools(config(), "summarizer").map((tool) => tool.id), ["echo"]);
});

test("an agent's tool list is checked like any other invocation edge", () => {
  assert.throws(
    () => config({ gateways: [{ missing: { tools: ["missing"] } }], agents: [] }),
    /gateways\["missing"\] tools\("missing"\) is not declared under tools/,
  );
  assert.throws(
    () =>
      config({
        http: [{ "/ping": { directory: "compute/http/ping", methods: ["GET"] } }],
        gateways: [{ ping: { tools: ["ping"] } }], agents: [],
      }),
    /tools\("ping"\) is not declared under tools/,
  );
});

test("tools follow the union of their Gateways' deployment lanes", () => {
  const cases: readonly [readonly (DeploySetting | undefined)[], DeploySetting][] = [
    [[], "none"],
    [["none"], "none"],
    [["local-only"], "local-only"],
    [["cloud-only"], "cloud-only"],
    [["both"], "both"],
    [[undefined], "both"],
    [["local-only", "cloud-only"], "both"],
    [["local-only", "none"], "local-only"],
    [["cloud-only", "none"], "cloud-only"],
  ];
  for (const [deploys, expected] of cases) {
    const framework = config({
      tools: [{ echo: {}, unused: {} }],
      gateways: deploys.map((deploy, index) => ({ [`consumer-${index}`]: { tools: ["echo"], deploy } })), agents: [],
    });
    const target = getFrameworkTargets(framework).find((item) => item.reference === "lambda:echo")!;
    assert.equal(target.deploy, expected, JSON.stringify(deploys));
    assert.equal(getLocalTargets(framework, ["tool"]).some((item) => item.id === "echo"), expected === "both" || expected === "local-only");
    assert.equal(getCloudTargets(framework, ["tool"], "prod").some((item) => item.id === "echo"), expected === "both" || expected === "cloud-only");
    assert.deepEqual(getCloudTargets(framework, ["tool"], "dev"), []);
    assert.equal(getFrameworkTargets(framework).find((item) => item.id === "unused")!.deploy, "none");
  }
});

test("tools accept explicit deployment without a consuming agent", () => {
  const built = config({ tools: [{ echo: { deploy: "local-only" } }], agents: [], gateways: [] });
  assert.equal(isTargetEnabled(built, "lambda", "echo", "local"), true);
  assert.equal(isTargetEnabled(built, "lambda", "echo", "cloud"), false);
});

test("inferred tool lanes still validate outgoing invocation destinations", () => {
  const tool = { echo: { cloud: { bindings: [startsWorkflow("review")] } } };
  const workflows = [{ review: workflow(() => succeed(), { deploy: "local-only", timeoutSeconds: 60 }) }];
  assert.doesNotThrow(() => config({ tools: [tool], gateways: [{ summary: { tools: ["echo"], deploy: "local-only" } }], agents: [{ summarizer: { gateways: ["summary"], deploy: "local-only" } }], workflows }));
  assert.throws(
    () => config({ tools: [tool], gateways: [{ summary: { tools: ["echo"] } }], agents: [{ summarizer: { gateways: ["summary"], deploy: "both" } }], workflows }),
    /tools\["echo"\].*startsWorkflow\("review"\).*removes from the cloud lane/,
  );
});

test("a tool that acts as the signed-in user is reachable only from an agent that has one", () => {
  assert.throws(
    () => config({ agents: [{ summarizer: { gateways: ["support"] } }] }),
    /agents\["summarizer"\] lists tools\("lookup-case"\), which declares auth: true\. Only an agent with auth: true has a signed-in user to act as/,
  );
});

test("auth: true needs the Cognito inputs its verifier reads", () => {
  assert.throws(
    () => config({ tools: [{ ...tools, "lookup-case": { auth: true } }] }),
    /tools\["lookup-case"\] declares auth: true without environment USER_POOL_ID, USER_POOL_CLIENT_ID/,
  );
  assert.throws(
    () => config({ agents: [{ ...agents, "support-agent": { auth: true, gateways: ["summary"] } }] }),
    /agents\["support-agent"\] declares auth: true without environment USER_POOL_ID, USER_POOL_CLIENT_ID/,
  );
});

test("invokesAgent derives a descriptor, and an agent with users is invoked only on a user's behalf", () => {
  const caller = (auth: boolean): FrameworkHttp => ({
    "/ask": {
      directory: "compute/http/ask",
      methods: ["POST" as const],
      ...(auth ? { auth: true as const } : {}),
      cloud: { bindings: [invokesAgent("support-agent")] },
    },
  });
  const ask = getFrameworkTargets(config({ http: [caller(true)] })).find((target) => target.id === "ask");
  assert.deepEqual(ask?.cloud.bindings, [
    { capability: "invokesAgent", agent: "support-agent", environment: "FRAMEWORK_AGENT_SUPPORT_AGENT" },
  ]);
  assert.throws(
    () => config({ http: [caller(false)] }),
    /http\["\/ask"\] cloud\.bindings invokesAgent\("support-agent"\) calls an agent with auth: true from a caller with no signed-in user/,
  );
});

test("agent and tool edges join the cycle check", () => {
  assert.throws(
    () => config({ tools: [{ ...tools, echo: { cloud: { bindings: [invokesAgent("summarizer")] } } }] }),
    /Invocation edges form a cycle: (lambda:echo -> agent:summarizer -> lambda:echo|agent:summarizer -> lambda:echo -> agent:summarizer)/,
  );
});

test("Studio availability inspection still refuses auth, stack-order and invocation-cycle violations", () => {
  withDeferredInvocationAvailability(() => {
    assert.throws(() => config({ http: [{ "/ask": { directory: "compute/http/ask", methods: ["POST"], cloud: { bindings: [invokesAgent("support-agent")] } } }] }), /no signed-in user/);
    assert.throws(() => config({ events: [{ caller: { directory: "compute/events/caller", cloud: { bindings: [invokesAgent("summarizer")] } } }] }), /invokes an agent from a event target/);
    assert.throws(() => config({ tools: [{ ...tools, echo: { cloud: { bindings: [invokesAgent("summarizer")] } } }] }), /Invocation edges form a cycle/);
    assert.throws(() => config({ tools: [{ ...tools, echo: { deploy: "local-only" } }] }), /same deployment lanes/, "gateway/tool availability is not an editable runtime binding");
  });
});

test("Runtime limits and ownership are refused where they are written", () => {
  assert.throws(
    () => config({ agents: [{ ...agents, summarizer: { gateways: ["summary"], cloud: { idleSeconds: 30 } } }] }),
    /agents\["summarizer"\] cloud\.idleSeconds must be a whole number from 60 to 28800/,
  );
  assert.throws(
    () =>
      config({
        agents: [{ ...agents, summarizer: { gateways: ["summary"], cloud: { idleSeconds: 900, maxLifetimeSeconds: 600 } } }],
      }),
    /agents\["summarizer"\] cloud\.maxLifetimeSeconds is shorter than cloud\.idleSeconds/,
  );
  assert.throws(
    () => config({ agents: [{ ...agents, summarizer: { gateways: ["summary"], secrets: {} } } as never] }),
    /agents\["summarizer"\] declares secrets\. AgentCore Runtime has no startup secret injection/,
  );
});

test("agent browser routes are explicit, keep their full path, and do not change target identity", () => {
  assert.deepEqual(getAgentBrowserRoutes(config()), [], "auth alone does not expose a route");
  const routed = config({ agents: [{ ...agents, "support-agent": { ...agents["support-agent"], route: "/chat/support" } }] });
  assert.deepEqual(getAgentBrowserRoutes(routed), [{ id: "support-agent", path: "/chat/support" }]);
  const target = getFrameworkTargets(routed).find((item) => item.reference === "agent:support-agent")!;
  const original = getFrameworkTargets(config()).find((item) => item.reference === "agent:support-agent")!;
  assert.equal(target.directory, original.directory);
  assert.equal(target.cloud.constructId, original.cloud.constructId);
  // /agents is no longer a globally reserved namespace.
  config({ http: [{ "/agents/report": { directory: "compute/http/report", methods: ["GET"] } }] });
});

test("agent browser routes require user auth and an exact literal path", () => {
  assert.throws(() => config({ agents: [{ summarizer: { route: "/chat/summary" } }] }), /agents\["summarizer"\]\.route requires auth: true/);
  for (const route of ["relative", "//chat", "/chat/", "/chat/*", "/chat/:id", "/chat?x=1", "/chat#x", "/chat/../other", "/chat%2fother"]) {
    assert.throws(() => config({ agents: [{ "support-agent": { ...agents["support-agent"], route } } as never] }), /agents\["support-agent"\]\.route/);
  }
});

test("duplicate agent routes name both owners even when one is disabled", () => {
  assert.throws(() => config({ agents: [{
    "support-agent": { ...agents["support-agent"], route: "/chat/support" },
    another: { auth: true, environment: cognito, route: "/chat/support", deploy: "none" },
  }] }), /Browser route collision: agents\["support-agent"\]\.route.*agents\["another"\]\.route.*\/chat\/support/);
});

test("agent routes cannot shadow HTTP paths, even on a different method or deployment lane", () => {
  assert.throws(() => config({
    agents: [{ ...agents, "support-agent": { ...agents["support-agent"], route: "/api/report", deploy: "local-only" } }],
    http: [{ "/report": { directory: "compute/http/report", methods: ["GET"], deploy: "cloud-only" } }],
  }), /Browser route collision: agents\["support-agent"\]\.route.*http\["\/report"\].*\/api\/report/);
});

test("service mounts conflict at their root and descendants, but not sibling prefixes", () => {
  const withRoute = (route: `/${string}`) => config({
    agents: [{ ...agents, "support-agent": { ...agents["support-agent"], route } }],
    services: [{ "/chat/*": { cloud: { vpc: fixtureVpc }, directory: "compute/services/chat", methods: ["GET"] } }],
  });
  for (const route of ["/api/chat", "/api/chat/support"] as const) {
    assert.throws(() => withRoute(route), /Browser route collision: agents\["support-agent"\]\.route.*services\["\/chat\/\*"\]/);
  }
  withRoute("/api/chatbot");
  // This is a distinct browser path from the HTTP/service path /api/chat/support.
  withRoute("/chat/support");
  assert.throws(() => config({
    agents: [{ "support-agent": { ...agents["support-agent"], route: "/api/anywhere" } }],
    services: [{ "/*": { cloud: { vpc: fixtureVpc }, directory: "compute/services/chat", methods: "*" } }],
  }), /Browser route collision/);
});

test("legacy agent tools are rejected with migration guidance", () => {
  assert.throws(
    () => defineFrameworkConfig({ ...base, agents: [{ example: { tools: [] } }] } as never),
    /tools has been replaced by gateways/,
  );
});

test("selected Gateways deduplicate shared tools and route through the first selection", () => {
  const framework = config({
    gateways: [{ first: { tools: ["echo"] }, second: { tools: ["echo", "lookup-case"] } }],
    agents: [{ caller: { auth: true, environment: cognito, gateways: ["first", "second"] } }],
  });
  assert.deepEqual(getAgentTools(framework, "caller").map(tool => [tool.id, tool.gatewayId]), [["echo", "first"], ["lookup-case", "second"]]);
  const { resources: _derivedResources, ...authored } = framework;
  const reversed = config({ ...authored, agents: [{ caller: { ...framework.agents!.caller, gateways: ["second", "first"] } }] });
  assert.deepEqual(getAgentTools(reversed, "caller").map(tool => [tool.id, tool.gatewayId]), [["echo", "second"], ["lookup-case", "second"]]);
});

test("empty Gateways exist independently and validate their identity and consumers", () => {
  const framework = config({ tools: [], agents: [], gateways: [{ empty: {} }] });
  assert.equal(getGateways(framework)[0].deploy, "both");
  assert.equal(getCloudGateways(framework, "prod").length, 1);
  assert.equal(getCloudGateways(framework, "dev").length, 0);
  assert.throws(() => config({ agents: [{ caller: { gateways: ["missing"] } }] }), /not declared under gateways/);
  assert.throws(() => config({ agents: [{ caller: { gateways: ["summary", "summary"] } }] }), /lists a Gateway twice/);
  assert.throws(() => config({ gateways: [{ first: { cloud: { constructId: "Same" } }, second: { cloud: { constructId: "Same" } } }], agents: [] }), /both resolve to construct id/);
  assert.throws(() => config({ gateways: [{ summary: { deploy: "local-only" } }], agents: [{ caller: { gateways: ["summary"] } }] }), /same deployment lanes/);
});

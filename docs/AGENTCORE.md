# AgentCore agents and tools

An agent is an application AgentCore Runtime hosts. A tool is a Lambda the agent calls through
an AgentCore Gateway. Declare agents, gateways and tools in composable sections. A gateway
owns its tool list, and each agent selects one or more gateways. The framework derives IAM,
packaging, browser routes, local execution and generated types from those declarations.

Read [Framework](FRAMEWORK.md) first; this guide assumes its declarations, resources and
deploy settings.

Studio's **Add to application → Agent** creates a deterministic echo responder by
default, so its first request does not require a model provider or paid model call.
Choose the model/tool-loop starter explicitly when that behavior is needed. **Agent
tool** creates an adjacent Zod contract and an authenticated tool wrapper by default.
Both creators review declarations, starter files and generated artifacts together.
The configured directory can use existing code; missing-file repair never overwrites
it. Incompatible partial contracts need a source edit. See the
[Studio creation guide](../client-app/README.md#add-to-application) for supported
templates and review boundaries. Saving source does not start or deploy an agent.

## Declaring them

```ts
// framework-config/workloads/tools.ts
import { startsWorkflow } from "aws-studio/config";
import type { ToolsSection } from "../workload-types";
import { applicationVpc } from "../networks/application";

export const tools = {
  "lookup-case": { directory: "compute/tools/lookup-case", auth: true, database: true, vpc: applicationVpc },
  "start-review": { directory: "compute/tools/start-review", auth: true, cloud: { bindings: [startsWorkflow("case-review")] } },
} satisfies ToolsSection;
```

```ts
// framework-config/workloads/agents.ts
import type { AgentsSection } from "../workload-types";
import { modelProviders } from "../model-providers";

export const agents = {
  "support-agent": {
    directory: "compute/agents/support-agent",
    auth: true,
    route: "/chat/support",
    gateways: ["support-tools"],
    deploy: "both",
    environment: { ...modelProviders.environment },
    cloud: { access: modelProviders.access, requirements: modelProviders.requirements, idleSeconds: 900 },
  },
} satisfies AgentsSection;
```

```ts
// framework-config/workloads/gateways.ts
import type { GatewaysSection } from "../workload-types";

export const gateways = {
  "support-tools": { tools: ["lookup-case", "start-review"], deploy: "both" },
} satisfies GatewaysSection;
```

Compose them in `framework.config.ts` as `tools: [tools]`, `gateways: [gateways]` and
`agents: [agents]`. Gateways have their own Deploy setting, defaulting to `both`,
and may be empty or shared by several agents. Studio lists them in **APIs** with an
AgentCore badge. **Add to application → API → AgentCore** creates a gateway without
scaffolding a handler. Agent configuration selects gateways through the existing
reviewed source workflow.

Tools inherit the union of their gateways' lanes by default. An explicit
`deploy` overrides that default, using the same tokens and input conditions as other
workloads. Studio's Inherit restores consumer-based deployment; unused tools inherit
no lanes. An active agent requires every selected gateway in its lanes, and each active gateway
requires its tools in those lanes. Disable or disconnect consumers before disabling
a required gateway or tool. Outgoing tool bindings keep
the same destination checks.

| Declaration | What it says |
| --- | --- |
| `tools.<id>` | A Lambda an agent may call. Lives in `compute/tools/<id>` unless it declares `directory`. Takes Node ZIP Lambda settings, `defaults.tools`, environment and bindings. Deployment follows its gateways unless `deploy` overrides it. |
| `tools.<id>.auth: true` | The tool acts as the signed-in user, and its handler is written with `authenticatedTool`. |
| `agents.<id>` | An agent. Lives in `compute/agents/<id>` at the repository root unless it declares `directory`. |
| `gateways.<id>` | A reusable IAM-authorized MCP gateway with its own tools, deployment setting, tags and stable optional `cloud.constructId`. |
| `gateways.<id>.tools` | The declared tool Lambda IDs exposed by this gateway. |
| `agents.<id>.gateways` | An ordered list of gateway IDs the agent may invoke. |
| `agents.<id>.auth: true` | Calls carry the user's session, and its tools may act as that user. Authentication alone does not expose a browser route. |
| `agents.<id>.route` | The exact same-origin browser path, e.g. `/chat/support`. No `/api` or `/agents` prefix is added. Requires `auth: true`; omit it for workload-only invocation. |
| `agents.<id>.cloud.idleSeconds`, `maxLifetimeSeconds` | Session lifetime, 60 to 28800 seconds. Both lanes apply it. |
| `invokesAgent("<id>")` | A workload's binding to call an agent, as `runsTask` is to run a task. |

An agent's Runtime role may invoke only its selected gateways. Each gateway's role may
invoke only its listed Lambda tools. Selecting a gateway grants access to its entire tool
list. Multiple agents can share one gateway; a tool can appear in several gateways.
`tools.specs` and `tools.call(id, input)` use the union of selected tools. A repeated global
tool ID appears once and routes through the first selected gateway that exposes it, so
Studio provides Move up/down controls alongside gateway selections.

`agents.<id>.tools` is no longer accepted. Move that list into a gateway declaration and
replace it with `gateways: ["<gateway-id>"]`. To preserve a previously deployed gateway,
set the new gateway's `cloud.constructId` to the old agent's construct ID and compare
CloudFormation logical IDs before deployment. The example does this explicitly.

The framework automatically supplies `FRAMEWORK_AGENTCORE_ADAPTER` with a descriptor map
for all selected gateways and their resolved endpoints. Studio shows this generated
environment entry. Do not author endpoint URLs or this reserved variable in `.env` files.

`auth: true` hands a tool or an agent the user pool framework.config.ts names as `userPool`
(`USER_POOL_ID` and `USER_POOL_CLIENT_ID`), because its handler is the verifier that reads it;
see [The user pool](FRAMEWORK.md#the-user-pool). One that names both variables itself keeps
its own, and without a `userPool` in the config it must. A tool with `auth: true` may be
exposed only to agents with `auth: true` through their selected gateways; those agents
have a user to act as. An agent with
`auth: true` may be invoked only by a caller that has a user to pass on: an `auth: true` route,
service, tool or agent.

Agent browser routes are exact literal paths and accept POST. Keep the agent id separate
from its route: changing `/chat/support` does not change the implementation directory,
invocation binding, Runtime or Gateway identity. Routes are compared across all declarations,
including disabled deployment lanes. Duplicate agent routes and overlap with HTTP routes or
service mounts are rejected with both owners named. HTTP/service keys still resolve under
`/api`: an agent at `/api/chat/support` conflicts with a service at `/chat/*`; an agent at
`/chat/support` does not. An agent cannot share an HTTP browser path on another method,
because CloudFront selects its origin by path. Existing HTTP-versus-service checks remain
method-aware. Generation, local startup, CDK synth and deployment share this validation;
deployment synthesizes before secret uploads or infrastructure changes.

## Writing a tool

A tool's contract sits beside its handler, as an HTTP payload contract does:

```ts
// compute/tools/lookup-case/contract.ts — Zod only
import { z } from "zod";

export const contract = {
  description: "Find one of the signed-in user's cases by its number.",
  request: z.object({ caseNumber: z.string().describe("For example 2024-CV-0012") }),
  response: z.object({ title: z.string(), status: z.enum(["open", "closed"]) }),
} as const;

// index.ts
import { authenticatedTool } from "aws-studio/runtime/tools";
import { contract } from "./contract";

export const lambdaHandler = authenticatedTool(contract, async (input, session) => {
  return casesRepository.findOwned(session.payload.sub, input.caseNumber);
});
```

`tool(contract, async (input, context) => ...)` is the form for a tool with service authority.
`framework:check` refuses `auth: true` without `authenticatedTool`, `authenticatedTool` without
`auth: true`, and a tool handler with no wrapper.

The `description` and the schemas are what the model reads. `framework:generate` projects
them into `packages/framework-generated/src/agentcore.ts`, which is committed, so a change to a
tool's prompt is a reviewable diff. Gateway's schema has five keywords — type, description,
properties, required, items — so the projection writes everything else into the description:
an enum becomes "One of: …", a bound becomes "At most 2000 characters.", a default becomes
"Defaults to …". The wrapper still enforces every constraint with the real Zod schema, in both
lanes. A union, a nullable field or a record cannot be described at all and is refused at the
field that wrote it: make the field optional, or split the tool.

A wrapper validates the arguments and refuses bad ones with a message naming each field, which
reaches the model so it can correct the call. Anything the handler throws is logged with its
stack and reaches the model as "Tool execution failed." — a thrown error can carry a query, a
credential or a row.

**How a user tool knows the user.** The agent's adapter adds the verified ID token to every
call to an `auth: true` tool, in a reserved argument (`__framework_identity`) the model never
sees and cannot set: anything the model writes there is replaced. `authenticatedTool` verifies
the token against Cognito — the tool trusts neither the agent nor the Gateway for who the user
is — and removes it before the handler runs. Ownership checks stay in the handler, as they do in
a GraphQL resolver. Exposure is the HTTP API's: a Lambda's event already carries the bearer
token there. A turn that outlives the ID token's validity fails its user tools; give background work
a service tool.

Keep database and secret access in tools. An agent then needs no VPC and no database
access — it thinks, and its tools touch data. A tool that needs the database declares
`database: true` and explicitly imports the database's VPC as `vpc`; the framework does
not inherit it from defaults. An agent cannot declare database access, because its
current Runtime integration runs outside the VPC.

## The model

An agent builds its model with `getModel()` from `@repo/models` (`packages/models/`):
Bedrock, Bedrock Mantle or OpenAI as a LangChain chat model, chosen by
`LANGGRAPH_MODEL_PROVIDER` in `cdk-app/.env.<mode>`. Depend on it in the agent's package.json
(`"@repo/models": "*"`) rather than copying the providers into the agent.

What the providers need is declared once, in `framework-config/model-providers.ts`, and each agent
spreads it — `...modelProviders.environment` in `environment`, `access: modelProviders.access` and
`requirements: modelProviders.requirements` in `cloud` — as the declaration above does. A model is
not something an application builds, so there is no construct to grant from; the access is
plain IAM. The default `bedrock-mantle` provider needs `bedrock-mantle:CreateInference` on
the deployment account's regional `project/default`, plus `bedrock-mantle:CallWithBearerToken`
on `*` for its short-lived token authentication. The `bedrock` provider uses
`bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on model and
inference-profile ARNs. OpenAI needs only its key's secret, which the ARN in the
environment grants. See [AWS's Mantle inference policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonBedrockMantleInferenceAccess.html).

Locally the model is called with your AWS profile, which proves nothing about the deployed
Runtime's role. So `npm run verify` fails for an agent that depends on `@repo/models`
without the shared declaration, rather than its first deployed turn.

To give one agent another model, override the variable after the spread, for example
`BEDROCK_MODEL_ID: inputs.models.supportModelId`; the access already covers every model.
Append the agent's own permissions with `access: [...modelProviders.access, { ... }]`. A new provider
in `packages/models/` that calls AWS adds its permissions to `modelProviders.access`, which reaches
every agent at once. An agent on a different model library does not depend on the package
and writes its own `cloud.access`.

## Writing an agent

```ts
// compute/agents/support-agent/contract.ts
export const contract = {
  request: z.object({ message: z.string() }),
  event: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("done") }),
  ]),
} as const;

// compute/agents/support-agent/index.ts
import { agent } from "aws-studio/runtime/agentcore";
import { contract } from "./contract";

export const handler = agent("support-agent", contract).stream(async function* (input, { tools, user, conversationId, signal }) {
  // Hand tools.specs to any model SDK; dispatch what it chooses with tools.call(name, args).
  const found = await tools.call("lookup-case", { caseNumber: input.message });
  yield { type: "text", text: `Case ${found.title} is ${found.status}.` };
  yield { type: "done" };
});
```

A contract has `request` and either `event` (the agent streams; write `.stream(async function* …)`)
or `response` (it answers once with JSON; write `.respond(async …)`). Only the matching method
exists, and each yield or return is typed by the contract. The adapter validates both directions. The id is the declaration's key; `framework:check`
refuses a mismatch, and `tools.call` with a literal id is typed by that tool's contract — calling
a tool outside the selected gateways fails to compile.

The framework owns the boundary and nothing inside it. Use any agent library: give its model
`tools.specs` (name, description and JSON-schema input, the shape every model SDK takes) and
route the model's chosen calls through `tools.call`. The tool names are the tool ids; Gateway's
wire names are mapped for you.

`context.user` is the verified session of an `auth: true` agent. `conversationId` is the
caller's. `signal` aborts when the caller goes away; it does not undo a committed write.

AgentCore Memory, Browser and Code Interpreter are extension candidates through the
native-resource path: an application stack can expose supported construct attributes and
grants through `stack<T>()` and `linkResources`, then pass identifiers and access
to its agent. This repository does not provide dedicated framework adapters, local
emulators or validated end-to-end workflows for those services. Their SDK/session behavior,
required IAM, network access and deployment lifecycle must be implemented and verified
for the application; the generic catalog alone does not establish that integration.

## Calling an agent

From the browser, for an agent with `auth: true` and an explicit `route`:

```ts
import { streamAgent } from "#/lib/agents";

for await (const event of streamAgent("support-agent", { message }, { conversationId })) render(event);
```

The request and events are typed by the agent's contract, projected into `@repo/api-contract`.
The call goes to the exact declared path through the same authenticated fetch, refresh included.
It passes a same-origin URL so the HTTP helper does not add `/api`. Use a new
`crypto.randomUUID()` per conversation. The Runtime session it lands in is derived from the
conversation and the user, and the adapter recomputes it from the verified token, so a user can
never land in another user's session.

From a workload, declare `cloud: { bindings: [invokesAgent("support-agent")] }` and:

```ts
import { invokeAgent } from "aws-studio/runtime/agentcore";

export const lambdaHandler = authenticated(async (event, session) => {
  const result = await invokeAgent("support-agent", { message: "…" }, { conversationId, session });
  return jsonResponse(200, result);
});
```

`invokeAgent` returns an agent's JSON `response`; a streaming agent is called from the browser,
and generation refuses an `invokesAgent` binding to one, as it does a workflow step.
An agent with users is called with the caller's `session` — its Runtime accepts only a user's
token, so no IAM grant is written. A service agent is called with the caller's role, which the
binding grants. The default timeout is 25 seconds, under the HTTP API's 30.

From a workflow, `invokeAgent` is a step like `runTask`, with no binding — the graph is the
declaration:

```ts
import { invokeAgent, invokeLambda, sequence, workflow } from "aws-studio/config";

workflow<{ caseId: string }>(({ input }) => {
  const analysis = invokeAgent("case-analysis", { caseId: input.caseId }, { timeoutSeconds: 600 });
  return sequence(analysis, invokeLambda("store-analysis", { payload: analysis.output }));
}, { timeoutSeconds: 900 });
```

`.output` is the agent's `response`, typed by its contract. Only an agent without `auth` and with
a `response` contract can be a step: a workflow has no user's token to forward, and a step's
result is one document. Naming any other agent does not compile, and `framework:check` refuses it
too.

**Sessions belong to the execution.** Calls in one execution share its default Runtime session,
so a later step or a retry lands in the warm microVM the first call started; no two executions
ever share one. `session` names another session within the execution:

```ts
map(input.caseIds, ({ item }) => invokeAgent("case-analysis", { caseId: item }, { session: item }))
```

A call inside `map` (unless `maxConcurrency: 1`), or the same agent in two branches of one
`parallel`, must name its session: concurrent calls into one session race its provisioning —
Runtime answers `RetryableConflictException` while a session is being created — and share one
microVM's memory. Validation refuses the unnamed form. A Runtime session is compute affinity,
not memory: it ends after the agent's `idleSeconds` or `maxLifetimeSeconds`, so keep durable
state in AgentCore Memory or your database, keyed by your own ids.

**Limits.** The step waits at most 900 seconds, Runtime's fixed synchronous limit, which is also
its default; a longer `timeoutSeconds` is refused. A timed-out or stopped step does not stop the
agent in AWS. Input and result share Step Functions' 256 KiB state limit, measured on the raw
answer, in which the result is an escaped string. Each new session counts against Runtime's
25-per-second creation rate and 5,000 active sessions, and lives until the agent's
`idleSeconds` after its last call: a high-volume workflow wants a short `idleSeconds` on its
agent.

**Failures.** An agent that answers an error status fails the step with
`BedrockAgentCore.RuntimeClientErrorException`, and the cause carries only the status
("Received error (500) from runtime"); the body is in the agent's log. An answer that is not the
adapter's `{ result }` fails with `States.QueryEvaluationError`. Throttling and provisioning
races arrive as `BedrockAgentCore.ThrottlingException` and
`BedrockAgentCore.RetryableConflictException`; nothing is retried unless you say so, as with
every other step:

```ts
retry(invokeAgent("case-analysis", input), {
  retries: 3,
  on: ["BedrockAgentCore.ThrottlingException", "BedrockAgentCore.RetryableConflictException"],
});
```

A retried call sends the same input to the same session, and an express workflow started
asynchronously may run twice, so tools with side effects should be idempotent on your ids.

**In AWS** the step is Step Functions' SDK integration with AgentCore Runtime
(`aws-sdk:bedrockagentcore:invokeAgentRuntime`) under the workflow's role, granted
`InvokeAgentRuntime` on that Runtime only. (Step Functions' optimized AgentCore integration,
`invokeHarness`, is for managed harnesses, not code Runtimes.) Locally the runner calls the same
session process the browser reaches. Express workflows can use it.

Workflows may invoke agents while tools and agents start workflows, in one application, as long
as the calls never lead back to where they started: `review` → `case-analysis` →
`open-review` → `intake` deploys, while a tool that starts `review` itself is refused, naming the
edges of the cycle.

## Development

`npm run dev:containers`. Nothing AgentCore-specific deploys in development:

- Each conversation runs in its own agent process in the invocation runner, as each Runtime
  session runs in its own microVM, and is released after the agent's idle time or lifetime.
  Editing the agent restarts an idle session on its next turn.
- Each declared gateway is emulated by the runner at `/gateways/<id>/mcp`: the same tool names and schemas, and tools
  invoked as a Gateway Lambda target is — the argument map as the event, Gateway's metadata as
  `context.clientContext.custom`. Tools run through the local Lambda executor, cold, against
  local Postgres and your AWS profile.
- Tool contracts are read live. Edit a description or a field and the next call lists it —
  no generate step. `framework:check` keeps the committed projection equal to the source before
  you deploy.
- The browser reaches the declared agent path through an exact-match Vite proxy; the local API dev server
  verifies the user, as AgentCore's authorizer does in AWS, and streams the agent through the
  runner.

The local API server preserves browser paths: regular HTTP/service routes are mounted at
`/api`, while agent routes are mounted at their declared paths before that mount. Direct
requests to the API server therefore include `/api` for HTTP/services. `dev:request` adds it
for you; continue passing the declaration key, e.g. `/graphql`, to that command.

`npm run agents:inspect` prints each agent: where it runs, who may call it, its session
lifetime, selected gateways and their tools.

## Deployment

`npm run deploy:resources -- --all -c prodDeployment=true --profile <PROFILE>`
builds the following beside workflows after the intended production target is authorized.
Use the [production review procedure](PROD-DEPLOYMENT.md#deploy) for a saved plan and
apply; deploying infrastructure does not publish the frontend assets.

| Resource | From |
| --- | --- |
| A Lambda per tool | `tools`, built like any framework Lambda |
| A Gateway per enabled declaration, IAM inbound | `gateways`, including empty gateways, and the committed tool contract projection |
| A Runtime per agent, Node code from S3 | the agent's directory, bundled with esbuild with the framework's adapter |
| A Cognito JWT authorizer, `Authorization` allowlisted | an agent's `auth: true`, from the app's user pool |
| An exact CloudFront behavior per declared agent route, ahead of `/api/*` | Agents with `auth: true` and `route`, on either the generated or configured frontend hostname |

Agent route behaviors forward only `Authorization`, `Content-Type`, `Accept`, the session header and
`?qualifier`. It never forwards cookies, so the refresh cookie scoped to `/api` stays between the
browser and the HTTP API. Replies are never cached or compressed.

Agent browser routing and `/api/*` work on both configured frontend domains and the
generated CloudFront hostname. For the generated hostname, the website is constructed
first so Cognito can use its callback origin. CloudFront Functions read API/agent routing
from a KeyValueStore populated by the later `FrontendRouting` custom resource, avoiding a
website → Cognito → Runtime → website dependency cycle. Custom-domain routing can bind
origins directly. This is implemented in
`frontend-website-s3-stack.ts`,
`frontend-routing.ts` and the
composition root (`cdk-app/lib/application.ts` in the app); live streaming/sign-in verification remains
separate from synthesis.

Agents deploy as code, not images: no Docker, no registry, no ARM64 cross-build. They run on
AgentCore's Node 22 runtime and are bundled for it; Lambdas run Node 24. Agents are TypeScript
modules today — a Python agent would need its own adapter and local lane.

Every name AgentCore requires is derived from the stack and construct path, so two
deployments in one account do not collide.

The current implementation enables MMDSv2 through a custom resource after each Runtime
update, using one provider shared by the agents and scoped to their Runtime/execution-role
ARNs ([agentcore-metadata.ts](../packages/aws-studio/cdk/agentcore-metadata.ts)). This is the
repository's compatibility shim for the pinned CDK/CloudFormation integration. Before
removing it, verify that the replacement native metadata property is supported by the
installed provider model and exercise creation/update behavior against AWS; a newer SDK
alone does not replace the deployed custom-resource dependency.

### Where it deploys

Agents, gateways and tools share one CloudFormation stack with the workflows — the
orchestration stack, whose deployed name stays `WorkflowsStack` (`packages/aws-studio/cdk/orchestration-stack.ts`).
They share it because they call each other: a state machine references a Runtime, and a tool or
Runtime references a state machine. In two stacks those are opposite dependencies CloudFormation
cannot order; in one, only resources are ordered, and their graph is the invocation graph that
validation proves acyclic. The two are still built apart — `framework-workflows.ts` builds state
machines at the stack's top level, where their logical ids have always been, and
`framework-agentcore.ts` builds everything AgentCore under one `AgentCore` construct — so a
workflow may not be named `agent-core`, and an agent and a tool may not share an output id.

CloudFormation allows 500 resources per stack. Gateways and tools can be shared, so
resource use depends on their declarations and bindings rather than agent count alone.
Runtimes share one MMDSv2 provider; empty gateways need no Runtime or placeholder tool.
Synthesis refuses a stack over 500 rather than letting the deploy fail. Beyond that an
application splits into deployments; the framework does not shard the stack.

## Smoke test in AWS

`npm run agents:smoke` checks the example agent in a disposable deployment, and only one whose
name contains `smoke`:

```sh
# a separate checkout or worktree, so the main cdk-app/.env.<mode> is untouched
# cdk-app/cdk.json framework:targets: a stage smoke-<you> ("mode": "prod", pinned to your account),
#   which deploys as <app>-smoke-<you>,
#   with an inputs file holding DATABASE_BACKUP_RETENTION_DAYS=0, optionally FRONTEND_URL + certificate
# framework-config/workloads/agents.ts: the agent deploys "both"
# framework-config/workloads/gateways.ts: the selected gateway deploys "both"
# tools inherit the gateway's deployment automatically
npm run deploy:resources -- --all -c prodDeployment=true -c deployment=<app>-smoke-<you> --profile <PROFILE>
npm run agents:smoke -- --deployment <app>-smoke-<you> --profile <PROFILE> [--frontend <FRONTEND_URL>] [--include-expiry]
```

It creates two users in that deployment's pool and deletes them on exit. It checks:

- the Runtime is ready with MMDSv2 required;
- Gateway lists each tool's committed schema, answers through each tool, and refuses contract-violating input;
- one model turn streams to user A and calls the tools from Runtime through its selected Gateway;
- user B, with the same conversation id, lands in B's own empty session, and cannot enter A's;
- the Runtime rejects every bad credential and malformed request;
- with `--frontend`, the same path through CloudFront;
- no token it minted appears in the Runtime's or the tools' logs.

The model turn needs access to the model `LANGGRAPH_MODEL_PROVIDER` selects in the smoke
deployment's account; every other check reads the conversation's history and calls no model.
The tools are service tools, so a user's identity reaching a tool through Gateway
(`authenticatedTool`) is covered only by the local tests, not by this run.

It prints statuses only, with JWT-shaped text redacted. `--include-expiry` waits out the ID token's hour
to check expiry. After editing a tool description or the agent, redeploy and rerun it: the schema
check compares Gateway with the committed projection, and the MMDSv2 check proves the shim ran after
the update.

## What local proves, and what it does not

| Property | Proven locally | Proven only in AWS |
| --- | --- | --- |
| The whole call path | A workload's `invokeAgent` → runner → session process → emulated Gateway → the tool's Lambda, with its contract enforced (`packages/aws-studio/local/invocation/test/agent-e2e.test.ts`) | The same path through Runtime and Gateway |
| Tool contracts, validation, naming, identity handling | Same wrappers, same projection, same adapter | Gateway's own schema enforcement and error text |
| Session ownership | The adapter's check, in both lanes | Runtime microVM isolation |
| Who may call what | Edges and the runner's caller check | IAM: Gateway and Runtime grants |
| Packaging | The adapter and handler code | The Node 22 code artifact starting in Runtime |
| Streaming | Server-sent events end to end | CloudFront → AgentCore streaming |

A local process is not a microVM: the host's filesystem, profile and network are shared, and
your profile can exceed the deployed roles. These AWS behaviours have not yet been exercised
against a live account and need a dev-account spike before production use: a Node code
Runtime starting with entry point `index.js` and the MMDSv2 update completing; the Runtime
accepting Cognito ID tokens by audience and passing `Authorization` to the adapter (whose
verifier takes the pool's region from its id when the Runtime sets no `AWS_REGION`); CloudFront forwarding to the AgentCore data
plane and streaming past 60 seconds with keepalives; Gateway passing the identity argument to
the Lambda, mapping a Lambda error to a tool error, and what it logs of arguments; and, for a
workflow's `invokeAgent` step, a real invocation: the error Step Functions raises when the agent
answers an error status, and how Runtime treats concurrent calls into one established session.
The step's definition itself is checked against AWS without deploying: Step Functions'
ValidateStateMachineDefinition accepts it, and TestState with a mocked result evaluates its
JSONata as AWS does — `$hash` answers lowercase hex, the session id is the one the adapter
derives, `Response` is a string, and a malformed answer fails with `States.QueryEvaluationError`.

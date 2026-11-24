---
id: framework.agents-tools
summary: Agent/tool contracts, explicit reusable Gateways, cloud provisioning, and local sessions.
read_when:
  - Implementing agents or tool integrations
  - Changing session, auth, Gateway, or agent workflow behavior
source:
  - packages/aws-studio/src/config/agentcore.ts
  - packages/aws-studio/cdk/framework-agentcore.ts
  - packages/aws-studio/src/runtime/agentcore.ts
  - packages/aws-studio/src/runtime/tools.ts
  - packages/aws-studio/local/invocation/src/agents.ts
related:
  - framework.workflows
  - runtime.local-execution
  - deployment.secrets
---
# Agents and tools

The complete authoring/API guide is [AgentCore](../../AGENTCORE.md). Agent declarations name an implementation directory, ordered gateway IDs, lanes, auth, optional exact browser route, environment and permissions. Gateways own their tool IDs and deployment policy. Tools are Lambda targets with neighboring contracts; their lanes derive from all exposing gateways. An unused tool has neither lane. An agent's browser path is separate from `/api` HTTP/service paths.

`agent(...).respond(...)` / invocation helpers in [runtime/agentcore.ts](../../../packages/aws-studio/src/runtime/agentcore.ts) and `tool` / `authenticatedTool` in [runtime/tools.ts](../../../packages/aws-studio/src/runtime/tools.ts) validate payloads and propagate supported identity. Contract modules use Zod and feed generated Gateway schema projections. Keep them self-contained. `auth: true` tools/agents get pool bindings without an extra `userPool: true`; session ownership is verified by the shared adapter.

| Lane | Implementation |
| --- | --- |
| Prod CDK | `FrameworkAgentCore` in [framework-agentcore.ts](../../../packages/aws-studio/cdk/framework-agentcore.ts) builds Node code Runtimes, each declared IAM-inbound Gateway independently of agents, Lambda targets, narrow invoke grants and Cognito authorizers/routes |
| Orchestration | [orchestration-stack.ts](../../../packages/aws-studio/cdk/orchestration-stack.ts) keeps workflows/agents/tools in deployed `WorkflowsStack`; validated acyclic invocation edges let one stack order mutually referencing resource kinds |
| Runtime metadata | [agentcore-metadata.ts](../../../packages/aws-studio/cdk/agentcore-metadata.ts) provisions the implementation's MMDSv2 custom-resource shim; revisit when changing the pinned CDK/CloudFormation model |
| Local agent | `LocalAgentSupervisor` in [agents.ts](../../../packages/aws-studio/local/invocation/src/agents.ts): one fork per session, bounded capacity, idle/lifetime eviction, source/environment fingerprints and restart of idle edited sessions |
| Local Gateway | [agent-routes.ts](../../../packages/aws-studio/local/invocation/src/agent-routes.ts): serves gateway-owned `/gateways/:id/mcp` endpoints, checks declared agent bindings, lists live contracts and invokes tools through `LocalLambdaExecutor` cold, with Gateway-shaped metadata |
| Caller | Declared workload `invokeAgent` binding, browser route through authenticated local proxy, or [workflow agent step](workflows.md) |

Local model calls use the configured provider and can incur real external requests. Node processes share host trust; they do not reproduce Runtime microVM isolation or IAM. Tool wrappers and contracts are shared, but Gateway's deployed schema/error behavior, streaming, MMDSv2 and actual Step Functions/AgentCore integration require live evidence. The existing AgentCore guide explicitly records those unverified surfaces; do not infer production readiness from local tests.

[Development logs](../../framework-studio/development-logs.md) capture application
session/turn and tool outcomes with bounded sanitized excerpts. Observation does not
change streaming, session ownership or tool contracts, and does not include Studio's
own Conversation/Coding processes. Transport acceptance is distinct from stream success.

Add a tool by implementing its contract/handler, declaring it under `tools`, referencing its ID from a gateway selected by an agent, regenerating and checking projections. Add only the necessary native grants/secret references. [Local E2E](../../../packages/aws-studio/local/invocation/test/agent-e2e.test.ts) exercises workload → session → emulated Gateway → tool without a live model; [agentcore tests](../../../packages/aws-studio/test/cdk/agentcore.test.ts) cover provisioning, and [tool runtime tests](../../../packages/aws-studio/test/agentcore-tools.test.ts) cover wrappers. See [walkthroughs](../guides/workflows.md) and [extensions](../guides/extensions.md).

## Gateway selection and generated environment

Agents select zero or more reusable gateways through `agents.<id>.gateways`. Each gateway
is an IAM boundary: selecting it exposes its complete tool list. Tool IDs remain global;
a shared tool is listed once and routes through the first selected gateway exposing it.
The same resolver drives generation, runtime routing, local sessions and Studio.
`FRAMEWORK_AGENTCORE_ADAPTER` supplies selected gateway descriptors automatically; it is
not an authored `.env` input. Gateway selection, routing and live contract changes take
part in the local session environment fingerprint.

The example gateway preserves its old `ExampleAgent` construct identity explicitly.
Keep gateway identity distinct from agent IDs and browser paths. The legacy agent `tools`
property is rejected with migration guidance.

## Model providers are declared dependencies

The example agent uses @repo/models (`packages/models/src/index.ts` in the app), which
selects `bedrock`, `bedrock-mantle` or `openai` and returns the provider's LangChain model.
Its environment, IAM statements and conditional secret requirement are centralized in
`model-providers.ts`, then composed into the
agent declaration. Provider selection is application configuration; AgentCore itself is
the execution/tool/session platform, not the model provider.

The secret reference supplies an ARN and read grant; provider code resolves contents at
runtime. The OpenAI provider requirement applies when that provider is selected. Bedrock
Runtime and Mantle use different permission sets in the shared declaration. The declared
resource patterns are the current application policy, not a claim that the framework can
infer an arbitrary model provider's permissions. Extending the model catalog requires
matching environment/IAM/requirement changes and provider integration evidence.

Local tests using fake models establish session and tool behavior without demonstrating
model availability, billing, region support or deployed provider access. Changing a model
identifier in source does not validate it against a remote provider.

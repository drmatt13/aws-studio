---
id: framework.configuration
summary: Literal section composition, normalized targets, stable identities, and execution lanes.
read_when:
  - Adding a workload or changing the framework DSL
  - Debugging identity or local/cloud selection
source:
  - packages/aws-studio/src/config/source.ts
  - packages/aws-studio/src/config/index.ts
  - packages/aws-studio/src/config/private-dns.ts
related:
  - framework.resources-cdk
  - deployment.environments
  - reference.change-impact
---
# Configuration and normalized identities

The canonical layout groups one workload module per kind under `framework-config/workloads/<kind>.ts`,
input declarations under `inputs/`, native references under `stacks/`, authentication under `auth/`, and deployment policy
under `deployment/`. `model-providers.ts` supplies one cohesive environment/IAM/requirements
fragment; `studio/descriptions.ts` is optional documentation. `inputs/index.ts` and
`stacks/index.ts` explicitly compose `defineInputs` and `defineStacks`. Each root array normally names its kind module (`http: [http]`). Grouped and
smaller literal modules remain supported through direct imports when deliberately splitting a large section;
directory depth does not define identity or registration. See the
[authoring guide](../../framework-studio/declarations-and-tags.md).

`DeclarationTags` uses ordinary string key/value metadata on each declaration; resource
factory options use `{ tags, members }`. There are no global defaults. Stack members
inherit owner tags and override keys explicitly; removing an override restores inheritance.
Routes sharing compute must agree on tags. Reserved AWS/framework namespaces and portable
AWS limits are validated before synthesis. Tags never rename targets or resolve secrets.

`framework.config.ts` composes `defaults`, `networks`, `inputs`, `stacks`, application database/user-pool references, and arrays of `http`, `webSocket`, `events`, `services`, `tasks`, `workflows`, `tools`, and `agents` modules. `workload-types.ts` specializes section types from both catalogs and exports only types. `framework.resources` is derived internally; authored mixed catalogs are rejected. Catalog paths retain their existing keys without category prefixes; collisions across inputs/stacks fail. Framework-owned stack tag overrides use `stackTags`.

The root composes the workload/resource model. Additional federation and stateful policy
are consumed by application CDK; deployment inputs, public client recipes, frontend release
policy and Studio descriptions have their own explicit consumers. The
declaration directory guide (`framework-config/README.md` in the app) maps all entry points.
Types reject unsupported agent database access, non-Node/non-ZIP tool settings and authored
derived database bindings. Invocation/workflow helpers suggest known target IDs while accepting
new IDs before regeneration; runtime normalization remains authoritative for references and
cross-target rules.

In [config/index.ts](../../../packages/aws-studio/src/config/index.ts), `defineFrameworkConfig` merges sections and validates normalization eagerly. `mergeSection` detects duplicate keys before information is lost; an object spread could erase that evidence. `normalizeFrameworkConfig` / `getFrameworkTargets` give CDK, generation, runtime and Studio one target vocabulary.

| Identity | Meaning / preservation rule |
| --- | --- |
| Public path / WebSocket key | How traffic enters; may change without renaming compute |
| Target `id` / canonical `kind:id` | Shared workload identity; routed IDs derive from directory unless explicit |
| `directory` | Repository-relative `compute/...` path with no leading slash; one real-path containment rule applies to every kind |
| `cloud.constructId` | Stable deployed construct identity; moving source must preserve it where appropriate |
| Stack scope + output prefix | CloudFormation logical identity and export compatibility, independent of route names |

`NormalizedTarget` records kind, role, resolved compute/settings, source origin, references and bindings. Several routes may share one compatible target; target-level settings must agree. Lambda inheritance resolves framework defaults → section defaults → workload override. Container architecture has its own defaults chain.

Lambda `reservedConcurrentExecutions` and `provisionedConcurrentExecutions` are
optional per-function counts, excluded from shared defaults. Absence disables
each setting; reserved permits 0 (pausing invocations), provisioned requires at
least 1, and provisioned cannot exceed a configured reservation. Normalization
validates safe integers and shared-route agreement. CDK preserves the function's
construct identity and adds a published version and `provisioned` invocation
alias only when provisioned capacity is configured. Framework integrations and
native `eventFunction` consumers use that alias; local execution does not emulate
these AWS capacity settings.

Every workload role accepts `deploy`, including events and tools. Events default to
both and include enabled cloud functions in both AWS modes. Tools default to consuming
agents' union, with explicit policies overriding it. Disabled events omit optional
native hooks and framework trigger descriptors; required native lookups still fail.

`isTargetEnabled` applies deploy tokens or `{ when: { resource, equals } }` to execution lanes. Conditions select declared non-secret strings from `input.value` or `input.fromEnv`; standalone values resolve from source, while environment-linked inputs resolve context, file and default. Optional unset inputs disable the workload. Conditional queries require explicit `DeployInputs`; generators request `"unconditioned"` supersets. `isTargetDeployed` separately applies the deployment mode: dev builds AWS-invoked event infrastructure, not the normal locally executed HTTP/task/workflow/agent fleet; prod builds cloud-enabled workloads. Event deploy policies apply in both graphs. Gateways have their own deployment policy; tools derive their default lanes from exposing gateways, with explicit policies supported. WebSocket handlers deploy only in the prod AWS graph when enabled, and the framework builds their API there when a route exists; dev runs them under local-ws-dev-server. Guard validation requires every route to fit inside `$connect` and its authorizer. These predicates are not synonyms. [Environment modes](../deployment/environments.md) owns named-target behavior.

`assertCloudEdgesResolvable` rejects cloud consumers whose required declared targets/resources cannot resolve. Source validation also checks literal routes, overlap, handler wrappers, invocation cycles, workflow semantics and runtime packaging. `npm run framework:generate` emits projections; `framework:check` detects drift and authoring violations. Neither is a live deployment check.

The application uses one shared conditional Deploy input for its WebSocket routes
and authorizer: `inputs.enableWebSocketApi` is
`input.fromEnv("ENABLE_WEB_SOCKET_API").required().enum("true", "false").default("true")` in
inputs/index.ts (`framework-config/inputs/index.ts` in the app). Every handler
requires `equals: "true"`. Each environment's input file can override it independently;
blank or unset uses `true`, and `false` disables those handlers.
It does not add another global API Gateway flag to CDK.

Batch tooling uses `getLambdaTargets` and `createTargetArtifactValidator` from the
configuration/source entry points to resolve Lambda build settings once per
operation. Studio implementation health uses the canonical per-target tool/agent
and Cognito checks, avoiding a whole-application scan for each handler. These are
invocation-local snapshots, never a persistent cache of a mutable config. Recreate
them after edits; standalone resolution remains fresh. Local target selection and
route validation likewise use one fresh normalization. The
[artifact benchmark](../../../packages/aws-studio/scripts/benchmark-artifacts.ts)
provides timing, CPU and RSS samples without relying on unit-test timing limits.

`createTargetAvailability` shares the exact canonical enabled/deployed predicates
within an operation. Standalone predicates remain fresh, including their existing
unknown-target behavior. Cloud selection and edge validation use one fresh target
map; no cache crosses those calls. Studio model projection uses operation-local
availability and a temporary batch of Lambda settings, restored in `finally`.
Repository input-template checks, CDK registration checks and development resource
output finalization also create fresh availability per invocation. Registration
retains kind and declaration order; finalization retains target and output order.

Extend a DSL field through its type, normalization/defaults, validation, CDK/local consumers, generated projections and Studio projection/editability as applicable; use [extension recipes](../guides/extensions.md). Start from existing [Framework guidance](../../FRAMEWORK.md), then use [change impact](../reference/change-impact.md). Resource references belong to [resources/CDK](resources-and-cdk.md), not new environment-specific import tables.

VPC declarations are exported `defineNetwork({ id, ... })` values, one module under
`framework-config/networks/<id>.ts`, registered in a literal `networks` array.
Networked Lambdas declare `vpc`; services/tasks declare `cloud.vpc`. References are
explicit, never inherited. Registration and placement import the same declaration value;
another `defineNetwork` call with matching IDs is rejected rather than silently replacing
its policy with the registry's CIDR, egress, endpoints and tags. The imported `defineDatabase` value owns its resource and VPC, allowing cross-VPC
rejection even when native RDS is absent in development.

Private hosted zones are exported `definePrivateHostedZone` values registered in
the literal root `privateHostedZones` array. They reference the same imported VPC
values, support multiple associations, and select resource endpoint capabilities
instead of authored IPs/URLs. The initial capability is an internal ECS ALB A
alias; connectivity grants separately name same-VPC workloads. Normalization checks
namespace conflicts, targets and gateway-auth bypass; production CDK additionally
checks deployment eligibility. See [private DNS](../../framework-studio/private-dns-parity.md)
for ownership and the explicit unsupported local runtime boundary.

The primary managed PostgreSQL declaration is `defineDatabase` in
databases/application.ts (`framework-config/databases/application.ts` in the app).
The root selects `database: applicationDatabase`; network, subnet and PostgreSQL policy
belong to that value. Stable declaration IDs do not determine deployed RDS identities.
Explicit CDK context wins over selected-file `DATABASE_*` values, then declaration settings,
then framework defaults. A nonblank input-file override can therefore mask a TypeScript
setting change; remove it to let the declaration own that setting. See the
[design and migration contract](../../framework-studio/network-database-declarations.md).

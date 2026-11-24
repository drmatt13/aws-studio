---
id: studio.creation-connections
summary: Implemented creation wizards, bounded scaffolding, trigger adapters and native connection removal.
read_when:
  - Extending Add to Application
  - Creating or modifying Lambda triggers and failure destinations
source:
  - client-app/shared/creation.ts
  - client-app/src/views/AddMenu.tsx
  - client-app/src/views/CreationWizard.tsx
  - client-app/server/edits/creation.ts
  - client-app/server/edits/creation-generation.ts
  - client-app/server/edits/implementation-scaffold.ts
  - packages/aws-studio/src/scaffolding/index.ts
  - client-app/server/edits/connections.ts
  - client-app/server/edits/iam-policy.ts
  - client-app/server/edits/resource-access.ts
  - client-app/server/edits/removal.ts
  - client-app/server/edits/triggers.ts
  - client-app/server/edits/native-triggers.ts
  - client-app/server/identity-policy-source.ts
  - client-app/server/source/catalog.ts
  - packages/aws-studio/src/config/identity-policy.ts
related:
  - studio.editing
  - studio.source-indexing
  - framework.resources-cdk
---
# Creation and resource connections

Implementation starters are application-owned files under
`framework-config/templates/` (`framework-config/templates/README.md` in the app).
The Node-only `aws-studio/scaffolding` factory renders them for both creation and
missing-file repair. Templates use a validated manifest and a `files/` tree with
`.template` suffixes; they are excluded from the configuration writer's declaration
inventory and from generator preview copies. They never author registration or generated
contracts. Unknown tokens, incompatible manifests and symlinked inputs are refused.
Review fingerprints the selected template's file inventory, bytes and consumed dependency
manifests; changes expire Apply, including file additions/removals. Source journals retain
template ID/fingerprint. Use-existing reads no starter. Container starters now use
TypeScript workspaces with `src/index.ts`, build scripts and nonroot runtime Dockerfiles;
legacy `index.mjs` repair remains available. New events default to paired local replay;
the creation switch selects a separate synchronous-result starter when off. Trigger
replay restrictions are unchanged, and disabled events are checked against their authored
flag rather than membership in the active replay projection.

Workload/catalog creators accept optional string key/value tags. Workloads append a literal
entry to the canonical `framework-config/workloads/<section>.ts` export (`http`, `events`,
`tasks`, etc.). Existing imports, comments and fragments are preserved; the existing root
array registration remains in place. A missing kind module is created and explicitly
registered. Computed/ambiguous canonical maps receive a corrective source-owned refusal.
Developers can still deliberately compose smaller maps through root arrays. Catalog
creation writes named descriptors and explicitly composes them in `inputs/index.ts` or `stacks/index.ts`.
Creation tags travel through generated-source review and history.

New input/secret descriptors use `framework-config/inputs/<kebab-name>.ts`; native stack
descriptors use `framework-config/stacks/<kebab-name>.ts`. The corresponding `index.ts`
facade explicitly imports and composes each public name. Existing catalog groups retain
their declaring module; descriptor filenames are never public catalog identity. Native
classes remain under `cdk-app/lib/app/`, with assembly wiring in
`cdk-app/lib/application.ts` inside `configureApplication`.

When the authorized WebSocket `$connect` handler has the same input condition in both
graphs, a new WebSocket handler's default Deploy choice is **Use $connect condition**.
Creation copies that selector and comparison into the new declaration, using its actual
catalog path and existing imports. Off remains available; incompatible local/cloud-only
choices are refused. Existing-target route aliases retain their target's settings.

Current source implements **Add to Application**, not a disabled menu. [AddMenu](../../../client-app/src/views/AddMenu.tsx) opens [CreationWizard](../../../client-app/src/views/CreationWizard.tsx); `CREATORS`, `CreationRequest` and `readCreationRequest` in [shared/creation.ts](../../../client-app/shared/creation.ts) define forms and server-revalidated inputs. `InspectorDraft.beginCreation` stages one complete creation; it cannot be mixed with unrelated edits in a batch.

The Cognito view's federation creator reuses this transaction for literal
`framework-config/auth/additional-providers.ts` entries. OIDC declares/reuses a catalog secret
reference; SAML authors metadata URL and explicit claim mappings. The native existing
Cognito stack/client consumes environment-scoped entries, preserving Google/pool/client
identities. External provider configuration, secret access and actual sign-in remain
unverified until separately observed. Provider metadata reads are allowlisted and never
request secret values. See the [identity guide](../../framework-studio/identity-and-domains.md).

The Stack creator also supplies an authenticated-only identity-pool template through
native `identityPoolAccess`. Guest/classic flows are disabled, web-identity trust is
constrained by pool audience and authenticated amr, and ambiguous token role mapping
denies credentials. The default authenticated role is always permissionless. A distinct
reader role supplies the reader-group claim (precedence10) and alone receives optional
`s3:GetObject` for an explicit bucket/prefix; no listing/write/admin grants are added.
This separation preserves the missing-group boundary if Cognito falls back to its
default role. Group assignment, effective IAM and retained-resource reattachment are
separate operations; source/synth success is not runtime authorization proof.

**API** creation starts with a Type selector for HTTP, WebSocket or AgentCore. HTTP and
WebSocket reuse the existing route creator. AgentCore creates a gateway declaration;
agents choose ordered gateways instead of direct tools. Gateway removal checks agent
consumers, and tool removal checks gateway consumers.

The chooser supports arrow keys, Home/End and Escape with focus returned to its trigger.
Unavailable choices explain their configuration/validation blocker in the menu.
The Input parameters and secrets island opens the same creator as Add to application.
One form uses a Secret switch to choose an input parameter or a secret, preserving shared
settings while retaining their distinct validated source declarations. Input defaults and
allowed values apply only to parameters; no secret value is entered or written by creation.
For parameters, **Link to .env file** selects an environment-linked `input.fromEnv`
declaration with an optional default, or a public `input.value` declaration. Source
parameters have no environment-file fallback, supply edge or generated template row.
The switch carries form text through the reviewed source change; it never reads or moves
an existing environment-file value. Secrets keep the protected environment source.
Wizard fields keep labels, controls, helper text and validation together; tags and
list editors span the form width. Helpers remain associated when errors appear,
and all configuration controls freeze during validation, stale-source evaluation
or a source conflict. Cancel remains available for resolving a conflict. These UI
states do not change the reviewed-source transaction or deploy authorization.

`planCreation` in [edits/creation.ts](../../../client-app/server/edits/creation.ts) returns source overrides, expected entities/selection and impact. It does not write authored files. `assertCreationFile` allows fixed creator-owned destinations and refuses traversal/symlink components. Disposable evaluators load new proposed modules; the [transaction](editing.md) reviews, validates both modes/typechecks, applies and verifies creation.

`generateCreationArtifacts` in [creation-generation.ts](../../../client-app/server/edits/creation-generation.ts) copies selected source/manifests into a private preview directory, excludes authored environment values/dependencies/deployment outputs, overlays the proposal and runs the real framework generator with `--repository-root`. Its allowlisted generated outputs join the same diff/journal. New service and agent manifests also trigger an offline npm 11 lockfile-only update in the copy. Input hashes protect the review from generator-input changes. Generated files are never authored by scaffold templates or accepted as arbitrary HTTP write destinations.

| Creator | Current source behavior / boundary |
| --- | --- |
| Function / API route | Node TypeScript zip handler plus literal section and root array registration; HTTP/WebSocket/event categories. Compatible existing routed Lambda aliases are appended to the original literal section, preserving local references, imports, settings and construct identity. New WebSocket modules use `Partial<WebSocketSection>`; existing modules retain their authored type. Other runtimes/images remain manually authored |
| Stack | Application stack exposing an SQS queue or private, encrypted, retained S3 bucket, catalog type import/declaration and actual CDK entrypoint instantiation; custom members remain source-owned |
| VPC | Create an independent VPC module and registry entry. Each has its own map island and settings; prod builds it when used. Placement edits generate imported references and subnet settings together |
| Workflow | Identity workflow or initial sequence of existing event Lambdas/tasks through the existing DSL |
| Service / task | Node source, Dockerfile, declaration; service manifest and generated Compose/lock changes join the review where needed. No new arbitrary Docker execution path |
| Agent | Contract, deterministic echo starter by default or explicit model/tool loop using shared model configuration and selected existing gateways, workspace manifest and TypeScript configuration; echo requires no provider/model setup |
| AgentCore API | Explicit composable gateway declaration with optional tool IDs and independent Deploy; no handler scaffold, empty gateways allowed |
| Agent tool | Adjacent Zod request/response/description contract and `tool` or default `authenticatedTool` wrapper, configured Lambda directory, literal tools section registration; no separate user-pool declaration |
| Input / secret | Catalog declaration and commented template keys; no authored environment values or secret provisioning |

Workload creation accepts an explicit implementation directory and create/existing-code
choice. `defaultImplementationDirectory` is shared by forms and backend. Existing code
is never overwritten; use-existing adds declarations only, then canonical artifact and
TypeScript validation checks the actual code. New agent/service manifests must match root
workspace patterns. Path authority rejects traversal and symlink components.

For a creator requiring a framework feature, declare its stable identifier in
`studioCompatibility.capabilities` in the first framework release that
implements it. Return that identifier from [creationCapability](../../../client-app/server/edits/creation.ts)
for the specific request settings that need it. Studio checks the app's installed
manifest before planning. If the bundled release supplies the missing capability
it installs that release in the same private candidate used for generation and
both-mode preflight. The resulting review includes the source diff, artifact and
dependency activation. Existing app pins stay in place for supported requests.

Preserve canonical owners and report a file or route when a prerequisite is
ambiguous. An HTTP GET creator can register HEAD with the same Lambda and
authorization, including a developer-owned handler without a route registration.
The reviewed model must contain both methods, and registration rejects a
duplicate path or overlapping method ownership. The creator exercises the
capability workflow with the immutable starter and a separate control app.
[Release qualification](../guides/verification-and-maintenance.md#qualify-studio-and-framework-releases)

The target's Implementation section reports artifact diagnostics and stages the typed
`implementation` operation through the exact HTTP draft parser. Repair writes only absent
files at the configured path, previews each new file, typechecks partial scaffolds and
hash-guards existing artifact bytes. Node ZIP: `index.ts` with configured export, HTTP
JSON response/authenticated wrapper where declared, and replay wrapper where required.
Tool: `contract.ts` plus validated wrapper. Agent: echo `index.ts`, `contract.ts`, manifest
and tsconfig. ECS service/task: TypeScript workspace, build script and nonroot Dockerfile;
existing `index.mjs` implementations use the compatibility template. Unauthenticated conventional Python ZIP
repair creates `lambda_function.py`; authenticated Python/custom entry points/image
Lambda repair deliberately requires source review. Incompatible existing contract exports
produce a no-write compiler conflict, never a template overwrite.

`connections.ts` supports database IAM/VPC placement, pool identifiers,
declared task/workflow/agent invocation, agent gateway selections, gateway tool lists,
catalog inputs/secrets, native managed policies and source-discovered CDK grants.
`resource-access.ts` adds exact reviewed guided application-access rules, including public
native Lambda invocation. The HTTP parser, destination picker and writer share capability
facts; guided actions use the framework registry and native methods use discovered typed
signatures. A picker action must be accepted by the parser and checked against the target's
discovered type. `iam-policy.ts` writes explicit actions, literal or referenced scopes,
Allow/Deny and scalar conditions through bounded `iamPolicy` operations.
Imports reuse existing catalog aliases. Secret delivery follows
ARN/read for Lambda/agent and startup-value delivery for containers. Literal grants have
optional bucket key scope; disconnect matches the exact resource/method/scope and
preserves other bindings. A new variable may follow a spread in the workload's own
`environment`/`secrets` map (`{ ...shared, NAME: … }`), since the literal key wins; it is
refused when the evaluated workload already has that name. Computed owners, commented
arrays and ambiguous shared native bindings stay source-owned. Shared literal IAM statements
retain their owning declaration and consumer list: editing changes that shared rule, while
adding a workload-specific rule preserves the imported source. Handler authentication is
separate from providing pool identifiers.

Workload **Permissions → Resource permissions → Add access** and resource **Access to this resource → Grant access**
share the destination-first editor in `WorkloadPermissions.tsx`. An authored input or
secret has no consumer section: its **Connections** list each consumer, and each workload
edits its own use in its inspector: **Add access** for secret reading, **Configuration and inputs → Add input** for ordinary inputs/pool identifiers, **Deploy** to deploy only
when it matches, and **Required inputs** (`RequiredInputs.tsx`, the workload's
`cloud.requirements`) to need a value before deploying. Tasks, workflows and
agents also offer **Access to this resource → Add caller**. `access-options.ts` builds options
from both source modes, discovers public native attributes/grants independently of triggers,
and supplies service names/icons without inventing new writer authority. Ordinary inputs
are filtered out of permission pickers and remain in Configuration and inputs. Public stack
members stay selectable when their native stack is unconstructed; saved connections retain
construction/availability errors on the map and Inspector until deployment is ready.
Permission authoring never constructs a disconnected stack. `access.ts` assigns
grants by their receiving principal, not by graph direction; callback edges can give
different grants to each endpoint. Only supported, unambiguous source bindings offer
removal, with exact native method/arguments or IAM owner matching. Additions and removals
enter the existing source review and can be undone before apply. The picker shows actual
permission destinations, including unfinished connections and concrete structural blockers;
there is no Show all resources mode. Map-only items, ordinary inputs, service HTTP interfaces,
unsupported native members without a grant action, and stacks with no permission choices
are omitted. Native members expand immediately below their public owning stack, with
CloudFormation artwork and indented line connectors. Search retains and expands matching
ancestors; clearing it restores manual expansion. Counts include matching leaf resources,
including disabled choices, independently of stack expansion. Private/internal constructs stay
source-owned. **Manual IAM** selects public ARN attributes, registered workload ARNs or
explicit literal scopes. **Advanced native grant** uses discovered serializable methods.
Managed-policy entries attach their public native policy without copying its document.
Derived route, trigger, workflow and gateway permissions navigate to their owning feature.
Runtime handler code and custom workflow steps remain source-owned; authoring access does
not implement application behavior or deploy infrastructure.

Invocation authoring retains local/cloud lane and deployment-condition mismatches as
editable connections with readiness errors on their lines and endpoints. The evaluator,
preflight and disposable generated-artifact preview use the synchronous framework
`withDeferredInvocationAvailability` scope only for runtime invocation bindings. Missing
destinations, authentication requirements, unsupported caller roles, dependency cycles,
workflow steps and gateway/tool availability remain strict. Ordinary CLI generation,
runtime startup and CDK synthesis retain strict validation; the generator's internal
`--studio-source-preview` mode requires an explicit preview root and refuses `--check`.
An event Lambda can also save a task binding and retain a visible
development readiness error because development AWS does not build the task. Test it
through a local caller, such as an HTTP handler under Compose, or deploy the connection
in production. Source review/apply preserves that declaration; strict CDK synthesis
still refuses the missing AWS destination. No authoring action promotes development
infrastructure.

Event functions and container tasks cannot author workflow/agent runtime bindings under
the current stack construction order. The picker names that framework restriction and
suggests a routed handler, service or tool; it does not imply AWS IAM forbids the action.
Authenticated agents require a caller that can propagate a signed-in user. Arbitrary
Lambda invocation stays an explicit IAM rule, distinct from typed runtime bindings.
Container services have HTTP interfaces and authentication rather than one permission ARN.
Secrets retain ARN/startup delivery and remain permission choices; public configuration
values stay in Configuration and inputs. Unconstructed/unlinked stacks remain authorable
with readiness errors and are never constructed automatically by permission editing.

`removal.ts` checks consumers across both modes and refuses shared implementation roots.
It reviews literal declaration removal, generated reference changes and an exact text
archive in `archived-workloads/<kind>/<id>/`; exclusive original source files are removed
only on Apply. Symlinks, env values, binary/large sets, dependencies and conflicting
archives are refused before writes. Archive source is excluded from active TypeScript
roots. Use Git to restore saved source. This never deletes already deployed infrastructure or data.

The VPC creator separates immutable `id` / `cloud.constructId` from its optional
display `name`. Changing a display name preserves deployed construct identity.
The form and server reject duplicate IDs, duplicate deployed identities, invalid
private `/16` ranges and overlapping ranges before source writes. The DSL still
permits intentionally overlapping independent VPCs; Studio refuses to introduce
one accidentally. An existing intentional overlap can keep its CIDR while other
settings change. A VPC can be removed only after workloads, the database and all
other source imports/re-exports have stopped using it. Removal reviews the registry,
import, exclusive declaration module and map descriptions together, and uses the
same conflict checks, guarded rollback as creation. Custom modules or computed
references stay source-owned and produce an actionable refusal.

Descriptions for every family use `framework-config/studio/descriptions.ts`, which the existing Inspector reads and edits. Optional input/secret consumer bindings reuse compatible catalog imports and the framework's ARN or startup-value delivery. Inputs/secrets share declarations across graphs. Environment-linked values remain independent in each mode's protected input file; source parameters store public values in their declaration. Creation refuses collisions, incompatible route reuse, nonliteral compositions and unknown references. Apply selects the created entity and saves the reviewed authored/generated artifacts; it does not deploy or start containers. Preview generation can fail when offline npm cache/workspace inputs are insufficient. Browser usability and live provisioned behavior require separate checks. The [capability matrix](../reference/capabilities.md) distinguishes implemented source paths from external validation.

Triggers are a separate change surface. [config/triggers.ts](../../../packages/aws-studio/src/config/triggers.ts) defines `TriggerAdapterMetadata`, `defineTriggerAdapter`, `triggerAdapters`, trigger/failure-destination validation and normalization. [framework-triggers.ts](../../../packages/aws-studio/cdk/framework-triggers.ts) and [framework-trigger-services.ts](../../../packages/aws-studio/cdk/framework-trigger-services.ts) attach supported native integrations. Resource capabilities come from [type-aware discovery](source-indexing.md).

`validateTriggerBindings` / `planTriggers` in [edits/triggers.ts](../../../client-app/server/edits/triggers.ts) write declared event triggers. Failure destination and local replay changes share batch preflight; enabling replay also updates a supported handler wrapper through [local-replay.ts](../../../client-app/server/edits/local-replay.ts). Source-inferred native edges use `planNativeRemovals` in [native-triggers.ts](../../../client-app/server/edits/native-triggers.ts) only when a safe removal site is recognized. Unsupported native code is not a general CDK editor.

Validate using [creation](../../../client-app/test/creation.test.ts), [triggers](../../../client-app/test/triggers.test.ts), [removal](../../../client-app/test/trigger-removal.test.ts), [trigger services](../../../client-app/test/trigger-services.test.ts), [CDK triggers](../../../packages/aws-studio/test/cdk/triggers.test.ts), and draft/recovery tests. Adding a resource family requires the [extension recipe](../guides/extensions.md) across framework, CDK, discovery and transformations.

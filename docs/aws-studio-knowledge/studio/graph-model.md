---
id: studio.graph-model
summary: Serialized graph entities, lanes, provenance, edge aggregation, and database source projections.
read_when:
  - Adding graph nodes, relations, evidence, or Inspector facts
source:
  - client-app/shared/model.ts
  - client-app/shared/permissions.ts
  - client-app/shared/framework-management.ts
  - client-app/server/model/ownership.ts
  - client-app/server/model/framework-resource-catalog.ts
  - client-app/shared/grants.ts
  - client-app/server/model/project.ts
  - client-app/server/model/catalog-context.ts
  - client-app/src/connections.ts
  - client-app/src/connection-presentation.ts
  - client-app/server/database.ts
  - client-app/shared/database-workbench.ts
  - client-app/shared/database-history.ts
related:
  - studio.snapshots
  - studio.source-indexing
  - studio.rendering
---
# Graph entities and edge semantics

`ModeModel.tagging` maps canonical entity IDs to authored/effective tags, per-key provenance
and explicit AWS ownership/capability explanations. Targets, routes, networks, database,
catalog entries and source-discovered public members share this metadata. It never contains
secret values. Isometric retains canonical selection and source identities;
tag filtering is a rendering projection rather than a new infrastructure resource.
Public members of framework-built export stacks inherit their `stackTags` metadata
through `server/source/export-stacks.ts`, including members already discovered elsewhere.
Public strings remain logical metadata; constructs keep linked ownership semantics.

`ModeModel.ownership` maps each graph entity to the maintainer of its definition.
Studio applies its [framework resource catalog](../../../client-app/server/model/framework-resource-catalog.ts)
to each evaluated mode, reconciles project overrides across modes, then propagates ownership
to routes, members and groups. Map badges, inspectors and source writers read those facts.
[Editing](editing.md#ownership) documents catalog entries, project overrides and write behavior.

[shared/model.ts](../../../client-app/shared/model.ts) is the serialized server/browser contract; avoid creating parallel graph types in a view. `projectModel`, `targetLanes` and `targetPlacement` in [model/project.ts](../../../client-app/server/model/project.ts) derive the graph from normalized declarations and mode predicates.

Each synchronous `projectModel` call creates fresh operation-local availability
from the canonical framework enabled/deployed predicates. Cloud selection and
cloud-edge validation likewise share one normalized target map per call. Lambda
settings for fields, compute and placement are batch-resolved into a temporary
projection scope in [lambda-spec.ts](../../../client-app/server/model/lambda-spec.ts)
and restored/released in `finally`. The next projection refreshes this scope even
if its config object was changed in place. No persistent graph or availability
cache crosses operations. Standalone predicate calls keep their current-config
semantics. [Projection regression tests](../../../client-app/test/projection-performance.test.ts)
check bounded declaration enumeration, fresh subsequent projections and complete
lane-byte equivalence with the standalone predicate path.

| Model | Carries |
| --- | --- |
| `Snapshot` | Revision, dev/prod `ModeModel`s, source index, file hashes, schema and descriptions |
| `ModelTarget` | Canonical ref/kind/role, directory/origin, construct ID, compute, placement, lanes, environment and permission facts; optional implementation artifact readiness/problems |
| `ModelGateway` | HTTP/WebSocket route gateways or explicit AgentCore gateway identity, tools, consumer agents, lanes and source ownership |
| `ModelRoute` | Public route/method semantics and target; route and target identities are distinct |
| `ModelResource` | Catalog path/kind, member/input/secret metadata, capabilities and stack usage; not resolved secret contents |
| `OwnershipFacts` | Definition owner, catalog or project evidence, structural inheritance, conflicts, supported project overrides and framework integrations |
| `ModelEdge` | Directed `from`/`to`, relation, provenance, source evidence and supported removal information |
| `FieldFact` | Authored/effective setting, inheritance, domain and editability reason |
| `SourceIndex`, `CdkLinkIndex` | Source entities/files, capabilities, inferred connections and diagnostics |

AgentCore connections have two explicit hops: agent → gateway invocation and gateway → tool Lambda invocation. Their IAM principals and scopes are distinct. Gateway selection supplies generated adapter environment metadata; it is not an authored environment input.

Relations cover routing, authorization, environment/secret reads, native grants, database access, invocation bindings, workflow steps/integrations, event triggers, callbacks and failure destinations. Their meanings differ: a grant is permission; an invocation binding is capability; neither proves an actual runtime call. Schedule triggers may have no catalog resource endpoint.

The [permissions investigation](../../framework-studio/permissions-analysis.md)
maps the grant-generation paths and source-evidence limits. `ModelEdge.permissionContext`
records typed normalization/adapter facts; `withConnectionAuthorizations` derives
principal, actions when known, symbolic scope, conditions and policy kind. It runs in
projection and again after source/local enrichment. `authorization` is derived presentation
and excluded from binding review signatures; typed context remains part of the source semantics.
Original relation IDs, labels and description keys stay stable.
The replay relationship retains its original ID but targets the public replay
bucket member, so its permission scope and resource inspector identify the bucket
instead of its owning stack. Stack inspectors show native members as visible
Resources rows with service icon badges; public string values remain in a separate disclosure.
Database IAM is `rds-db:connect` for `app_user`; its local PostgreSQL derivative carries no AWS grant. Reader access retains
writer access. A development replay Lambda only captures events: its handler's database edge
targets local PostgreSQL, while its native RDS edge and IAM grant belong to production.
Readiness checks do not treat that development capture function as an RDS caller.
Typed secret ARN delivery grants the workload role; container startup injection
uses the ECS execution role. Pull event arrows and IAM principal direction are independent.
Target permission lists group enriched edges once per projection, in source edge order.
Repeated endpoints or principals attach an edge once to each target; distinct edges with
the same ID remain distinct. Implicit permission sources and explicit policies follow.

`connection-presentation.ts` names every connection as **action: relevant value** while
retaining authored labels in the model. Routes keep `Routes to: /api/path`; database bindings
say `Connects to: rds.database` or `Connects to: Local PostgreSQL`; the database's stack says
`Provides database: rds.database`; replay names its handler as `Local replay: handler-id`.
Tools and workload calls name their destination instead of an internal helper or a generic
capability. Workflow steps derive their action from typed invocation metadata; service calls
use typed integration operations. Database details distinguish local settings from cloud
settings, private networking and IAM login. Reader bindings say `Includes writer and reader
connections`; they do not imply that replicas exist. Single-connection hovers append a compact IAM
action/helper summary without a mode suffix. Environment pills show availability; the
collapsed Permissions disclosure retains mode-specific principal, scope, conditions and
evidence. Raw binding details, source links and inference caveats remain under Configuration.
Resource previews omit IAM counts. Workload Permissions retains the full capability list.

Three background filters cover Routes and events, Environment and secrets, and Resource interactions;
an Errors pill, present only when the map has errors, pins error wires and names (see [Rendering](rendering.md)).
Structural links retain their internal category for layout and inspection; they appear when a
resource is selected or previewed, or the connection is inspected, without a background filter.
`edgeCategory` puts native triggers, subscriptions and event
failure destinations under Routes and events even when their underlying relation is `cdk`
or `grant`. Empty categories are hidden. Groups retain every member's category across both
modes; matching any category keeps the wire visible. IAM metadata neither chooses the
category nor overrides the styling representative. Selected/previewed resources reveal
all context.
Schedules, unlinked callbacks, custom integrations and explicit `cloud.access` also appear in
workload permissions without inventing graph endpoints. Supported grant creation is a bounded
type-discovered allowlist shared by UI and server (S3, SQS, DynamoDB, SNS, EventBridge).
Source-derived facts do not establish synthesized, deployed or effective IAM access; arbitrary
native statements, trust/key policies and policy evaluation require their own evidence.
Manual IAM connection excerpts reuse the indexed policy owner's location only when
the consumer and canonical statement both match. Shared statements retain their owning
file; ordinary source-excerpt redaction still removes literals and comments.

The `runsTask` binding appears under Resource interactions as `Runs task: task-id`.
Its solid connection matches the source resource's icon colour and retains the derived ECS launch and role-passing grants plus
launch configuration in the inspector; it does not establish an observed execution. Conditional `deployWhen`
connections use the same dashed style as Supplies input, with the title
`Conditional deployment: $inputPath`. The arrow and animated packets run from the
selecting input to the controlled workload. Their historical relationship IDs and
description keys remain stable.

Client environment `maps` edges point from public catalog input parameters and native
stack outputs into `client-envfile` (the **Client environment**, exported to
`client-app/.env.development.local` and `.env.production.local`), never directly from CDK input
files. CDK files supply parameters; each parameter carries both graphs' presence, requirement and
default (`modes`, filled by `withDeploymentInputs` from the declaration or, for a legacy ternary,
from each graph's own answer) and sanitized outcomes for declared client comparisons. A field's
preview infers whether it is generated from those facts and the file's line presence. Hover and connection
details say `Maps into`; the client's incoming connection list says `Mapped from`.
Layout uses this source-to-client direction without reversing these edges.
Local URL inputs are declared under `inputs.client` with `.only("dev")`, so Production holds
them as absent inputs that keep their kind and name.
`VITE_LOCAL_WS_URL` also consumes `inputs.enableWebSocketApi`; its condition writes
an empty URL when the selected input does not match `"true"`. Raw input values stay private.
The evaluator pair retains an absent input's type from the other mode while preserving
its absence, so snapshot display, creation review and apply checks share the same metadata.
A catalog `group` owns no resource: `catalogModel` marks it absent only when every entry
it holds is absent in that graph, so `inputs.client` is development-only while each
entry keeps its own absence.

Declared/derived/source-inferred edges retain their evidence classification. [source-indexing](source-indexing.md) defines inference limits. Studio is a declaration/source graph, not an authoritative live AWS topology or full IAM analysis.

Implementation health is separate from declaration validity: a missing handler can leave
the declaration graph readable so its node offers repair. Isometric and Inspector
show this warning without inventing a replacement target, changing topology or asserting
runtime health. Reviewed source application checks canonical artifacts against the proposed
file overlay; current files are never silently scaffolded during evaluation.

`aggregateConnections` in [connections.ts](../../../client-app/src/connections.ts)
groups by directed visible endpoint pair **and relationship type**, retaining original
members, categories and mode availability. Three environment reads form `Reads: 3 environment
values`; an IAM grant between the same resources has its own arc. Typed subscriptions and
failure delivery stay distinct from native grants even when their underlying relation is
`cdk` or `grant`. Bundle IDs include the type; original relationship IDs, evidence and
description keys remain intact. Hover previews are bounded to four members without
concealing missing required inputs. The Inspector preserves every member and its evidence.
The logical `envfile:cdk` resource references the physical `envfile:dev` and `envfile:prod`
records. Both draw as **CDK environment**. Supply members join matching original input
IDs and variable names across their own file modes, so two files supplying one parameter
count as one relationship with Dev/Prod evidence. Original edge IDs and description keys
remain available; a one-member supply bundle also has a stable aggregate identity.
Missing-value wire styling follows the selected Source mode, while hover and expanded
details retain both modes' statuses and source links.
Dev/prod union topology stabilizes layout while the active mode controls availability and
styling. `lookup.ts` in [src/lookup.ts](../../../client-app/src/lookup.ts) centralizes
entity/relationship lookup labels and categories.

The Database workbench uses `parseDeclaredSchema` in
[server/database.ts](../../../client-app/server/database.ts) for source-linked diagram
projection. Semantic validity comes from the configured, installed Prisma interpreter in
[server/database-workbench.ts](../../../client-app/server/database-workbench.ts),
independently from the framework snapshot. The editor draft remains authoritative for its
diagram; temporarily invalid drafts retain an explicitly marked last-valid diagram.
Logical Prisma names and mapped storage names remain distinct. Unsupported valid source
stays accessible instead of being regenerated from the projection.

Prisma access relationships use solid amber (owner), purple (members) and teal (via)
with a heavier stroke that stays visible at fit zoom; mixed rules blend their colors. Ordinary relations
stay thin and neutral. Rule labels retain their declaring endpoint and source location,
including inverse `via` rules. Model/enum policy comments participate in Contract Chain's
semantic review independently of physical storage changes. The source-pane Permissions
inspector edits those comments in the same undoable draft. See
[Prisma access](../../PRISMA-ACCESS.md) for the shared parser and runtime contract.

`DatabaseHistory` in [shared/database-history.ts](../../../client-app/shared/database-history.ts)
describes migration graph edges and verified semantic snapshots; terminal nodes are hints,
never implicit migration origins. `DatabaseObservation` in
[shared/database-workbench.ts](../../../client-app/shared/database-workbench.ts)
separates selected-target marker/ledger evidence from strict physical verification against
saved and historical storage. A declaration graph, matching marker or valid source alone
cannot establish database synchronization. Local observation never starts Compose. Local
database application needs a target-bound review. Production uses an explicitly approved
private IAM task: metadata preparation, billed read-only inspection and reviewed application
are distinct actions. No database action follows the graph-mode switch. See the
[workbench guide](../../framework-studio/database-workbench.md).

`DatabaseWorkbench.emitted` separately observes the configured generated JSON's content
revision and canonical storage/execution hashes against saved source. It carries safe
metadata/status only, never the raw artifact. This evidence neither generates files nor
proves generated TypeScript, downstream consumers, migration application or live storage.

When adding a relation, update projection, shared types, lookup/category labels, aggregation, Inspector, layout direction/weight, focus/picking, and tests as applicable; use [change impact](../reference/change-impact.md). Start with [model tests](../../../client-app/test/model.test.ts), [database tests](../../../client-app/test/database.test.ts), and [rendering tests](rendering.md). Snapshot revisions and edit conflicts belong to [snapshots](snapshots.md) / [editing](editing.md).

`ModeModel.networks` contains stable VPC identities and per-network settings.
VPC workload placement includes `networkId`; recognized native member placement does too.
Network production applicability derives from the projected targets' placement and
production lanes, including resolved workload deployment conditions, then adds database and
source-discovered native-stack consumers. Do not recalculate workload availability in
the network projection with different deployment options.
Network islands, subnet bands and fixtures use VPC-qualified IDs. The database's local
counterpart is drawn only in its declared VPC. Native helper calls and simple aliases are
source evidence; synthesis inventory remains the authority for built infrastructure.

`ModeModel.gateways` describes actual HTTP/WebSocket gateways and their route IDs,
authorizer and export-stack resource. `deployChoices` comes from the framework's
pure lane preview. Conditional `Lanes.when` contains references, comparison literals
from source and per-environment outcomes; it never contains resolved input values.
The `deployWhen` relation points from the selecting input to its controlled workload.
`Lanes.when` remains the authority for the comparison and per-mode outcome. Existing
connection IDs and description keys retain their historical workload/input ordering.

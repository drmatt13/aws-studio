---
id: studio.editing
summary: Canonical draft, review, AST transformation, guarded apply, rollback contract.
read_when:
  - Changing Inspector fields or source-writing behavior
  - Debugging stale review, conflict, apply, or rollback
source:
  - client-app/src/draft.ts
  - client-app/src/draft-entries.ts
  - client-app/src/editing-state.ts
  - client-app/src/views/Inspector.tsx
  - client-app/src/views/inspector/
  - client-app/src/views/Triggers.tsx
  - client-app/src/views/ResourceEditor.tsx
  - client-app/shared/creation.ts
  - client-app/shared/resources.ts
  - client-app/shared/naming.ts
  - client-app/server/naming-source.ts
  - client-app/server/naming-program.ts
  - client-app/server/naming-metadata.ts
  - client-app/server/naming-service.ts
  - client-app/server/naming-worker.ts
  - client-app/server/naming-equivalence.ts
  - client-app/server/naming-continuity.ts
  - client-app/server/resource-config-comments.ts
  - client-app/server/resources.ts
  - client-app/server/resources-source.ts
  - client-app/src/views/Deployment.tsx
  - client-app/src/views/DeploymentBadge.tsx
  - client-app/src/views/EnvironmentDetails.tsx
  - client-app/src/views/ManagedDatabaseInspector.tsx
  - client-app/src/views/DatabasePlacement.tsx
  - client-app/server/edits/transaction.ts
  - client-app/server/edits/batch.ts
  - client-app/server/edits/iam-policy.ts
  - client-app/server/source/permission-rules.ts
  - client-app/server/edits/database.ts
  - client-app/server/edits/plan.ts
  - client-app/server/edits/splice.ts
  - client-app/server/edits/comments.ts
  - packages/aws-studio/scripts/source/io.ts
  - client-app/server/edits/journal.ts
  - client-app/server/edits/installation-journal.ts
  - client-app/server/project-upgrade.ts
  - client-app/src/database-session.ts
  - client-app/server/database-workbench.ts
  - client-app/server/database-history.ts
  - client-app/server/database-application.ts
  - client-app/server/agent-runtime/integration.ts
  - client-app/server/agent-runtime/structured-proposal.ts
  - packages/aws-studio/scripts/source/source-gate.ts
  - client-app/server/edits/ownership-guard.ts
  - client-app/server/edits/ownership.ts
  - client-app/server/edits/proposal-ownership.ts
  - client-app/server/model/ownership.ts
related:
  - studio.source-indexing
  - studio.snapshots
  - studio.creation-connections
---
# Inspector drafts and source transactions

**Validate reviewed changes** in Inspector batch review runs independent checks on the
exact reviewed edits. `BatchEditor.exportReviewedSource` rechecks the accepted plan and
source inputs. The host stages those changes in a private workspace, runs deterministic
validation and creates the same immutable proposal used by general Coding tasks.
The browser preserves its draft and opens that durable task. Handoff writes no live source;
Coding approval remains separate. A later source import can make the retained inspector
draft stale, using its existing conflict/refresh handling.

Coding imports and existing source writers share the durable source gate and publication
epoch. Imports use complete baseline checks, exact proposal digests and a write-ahead
journal; an interrupted multi-file import is recoverable, not crash-atomic. Explicit
restore/keep recovery checks the inspected current-source fingerprint and preserves
intervening edits. See [Coding tasks](../../framework-studio/local-agent-lab.md#coding-tasks)
for validation, candidate refresh, runtime restart and operational boundaries.

The shared Rename action stages code and display names in this same draft. Authored
inputs, secrets and input groups support source refactoring; other resource families
expose display-name editing and explain their code identity's owner. VPC labels edit
the existing network name. Optional `framework-config/display-names.ts` exports a literal
`displayNames` map keyed by canonical entity ID. It is parsed without execution; labels
are shared between environments, trimmed, single-line and at most 120 characters.
Clearing a label restores automatic naming; duplicate labels do not change identity.

`naming-source.ts` uses the installed TypeScript language service and workspace compiler
options to rename an owning exported declaration, refresh the overlay, then rename the
catalog property. Explicit aliases, source comments and unrelated prose remain intact.
Client recipes and node/connection/display-name associations have explicit identity
adapters. Group descendants move together. One code rename or group move is reviewed at
a time; creation/removal and simultaneous reparenting are separate operations. Dynamic
or unowned consumers produce located review blockers alongside the available diff.
The proposed name remains staged for a retry after the developer makes the **old**
reference explicit in valid saved source. Apply remains disabled while blockers exist.

Rename review fingerprints source membership, indexed bytes, project configuration and
generator inputs. Apply repeats those checks and both-mode validation, then confirms
the written relationships before returning `entityRemap`. Source mismatches use the
existing guarded restoration. Only confirmed application remaps selection, navigation
memory and layout identities; reviewing a proposal leaves the map on its baseline.
`naming-continuity.ts` matches actual relationship identities, including source-offset
IDs and encoded connection bundles, so historical connection selections follow the
same resource rename. Distinct grant scopes and ambiguous relationships remain distinct.
External consumers and bookmarks outside the mounted session cannot be rewritten.
Reference analysis runs in a bounded child process so the HTTP server remains responsive.
Workers carry only public snapshot metadata and candidate source; they return comment
choices to the owning batch and terminate on timeout, cancellation or owner shutdown.
Both-mode semantic comparison uses the overlay immediately before refactoring, allowing
approved configuration edits while rejecting unrelated behavioral changes. Surgical
builder edits preserve comments in retained calls; commented removals require deliberate
source resolution when their attachment cannot be retained safely.

Every workload role exposes Deploy, including event Lambdas and agent tools. The same
bounded token/condition source writer validates both graphs, applies and restores exact
bytes. Tool Inherit follows exposing gateways; explicit overrides still satisfy invocation
edges. Event changes also control native AWS trigger attachment on the next deployment.
Catalog entries, stack members, HTTP/WebSocket gateway infrastructure, databases, network fixtures and
islands show their deployment owner and navigation to owner controls instead of a second
independent flag. Environment mappings explain that files supply inputs rather than deploy.

Inputs distinguish a public **Source parameter** from an **Environment parameter** through
**Link to .env file** in creation and the Inspector. `input.value(...)` stores a non-secret
value directly in source, with per-mode values supported; it has no `fromEnv`, fallback,
local-value read or catalog-derived environment-file row. A linked input reads its variable and may declare
an optional `.default(...)`. Switching sources carries the Value/Default form text through
the normal reviewed source writer, without reading, moving or rewriting `.env` values.
Secret inputs always remain environment-linked and never accept a source value or default.
The `enableWebSocketApi` example reads `ENABLE_WEB_SOCKET_API`, with a default of `true`.

**Allowed values** edits an input's `.enum(...)` in the same source draft as its other settings.
The restriction switch selects unrestricted text or an explicit list; add/remove controls retain
keyboard focus. Choices are non-blank and unique ignoring case, with at most 100 single-line
values of 500 characters each. Declared defaults and source values must fit the proposed list.
Secrets never acquire enum metadata. Explicit developer-owned deployment and local builders
expose the same editor and editable requirements. Deployment declarations also expose availability
and public defaults. A local test-account reader that exports `localTestAccountInputs` supports
development availability for both credentials and a public email default. Its password default
is independently editable in the private development input file. Studio can generate it when a
starter opts in through its development template. Raw Compose readers keep their own availability
and defaults.
The source writer preserves the reader, variable name, group and retained comments. It updates
the legacy requirements list when an edited input becomes optional, and verifies the refreshed
policy before confirming success. Sign-in provider inputs expose their declaration policy while
the provider still evaluates its credentials together. Inferred database overrides link to the
database's typed settings. Private environment edits use their own review.

Source projection includes public `authoredValue` and mode `value` metadata, while resolved
environment-file values stay out of snapshots and symbolic client previews. New client
input recipes use canonical catalog IDs; legacy variable-name aliases remain readable.
Changing a link or group reviews affected recipe references with the declaration.

Tags use a typed `tags` draft operation for the owning declaration, including all aliases
of shared compute. `server/edits/tags.ts` plans narrow literal changes and
`server/source/tags.ts` supplies conservative editability. Tag changes participate in
normal both-mode review, per-file diffs, stale hashes, refreshed-model validation, guarded
guarded rollback. Stack member overrides are distinct from effective inherited tags;
removal restores inheritance. See [tag authoring](../../framework-studio/declarations-and-tags.md).
The tag Inspector uses labeled key/value inputs, an Add tag action that focuses the new
key, and visible Delete buttons. Validation is associated with its fields; deleting a
row returns keyboard focus to a remaining key or Add tag. Route ownership help stays
inside the Tags disclosure. Its compact heading retains the effective count and any
Modified/Needs attention draft state while collapsed. Registry-backed boolean fields
dispatch through `FieldRow` to the shared switch, including build options and defaults.
An open page with missing tag editability offers
Refresh editor, which reloads its snapshot without writing source; an expired server
session reconnects through a page reload. Refresh is disabled while a draft is dirty.

This is the canonical graph-to-source contract. Creators, trigger editors and resource tools reuse it; they do not gain arbitrary file-writing authority.

Prisma has a separate fixed authority rather than extending the TypeScript configuration
writer. `DatabaseSession` in [database-session.ts](../../../client-app/src/database-session.ts)
owns draft text, exact request generations, external-source conflicts and last-valid diagram
identity. CodeMirror retains selection/undo through validation, formatting and explicit
discard; source review remains required before saving. The actual configured Prisma 8
interpreter owns semantic diagnostics. Syntax/local-name suggestions do not promise a
compatible language server or safe rename.

`DatabaseWorkbenchService` in
[database-workbench.ts](../../../client-app/server/database-workbench.ts) reviews,
revalidates and hash-guards writes only to `packages/database/prisma/contract.prisma`.
Source success is reported separately from snapshot-refresh failure. It neither generates
artifacts nor applies storage. `DatabaseHistoryService` in
[database-history.ts](../../../client-app/server/database-history.ts) runs pinned
Prisma emission/planning in a disposable copy, exposes actual artifact bytes, then installs
only reviewed new files after source/config/history checks, including the bounded imported
configuration helpers used by source validation and copied into offline planning. Existing migration packages
remain immutable; history browsing never executes them. `DatabaseApplicationService` in
[database-application.ts](../../../client-app/server/database-application.ts) owns
the separate local target review, typed approval, input/path revalidation and canonical
runner. Empty local initialization has its own metadata-only emptiness check, SQL review and
typed authorization; populated unknown storage remains blocked. Redacted database operation
records survive restart and never replay writes. Database effects and follow-up inspection
failures remain separate. `DatabaseCloudService` and the versioned VPC task add production
inspection/application: read-only metadata preparation pins a named destination and stack-owned
task revision and full launch/log descriptor, showing actual public-IP/subnet/security-group placement (database stays private/IAM), then typed billed inspection returns SQL/source for a separately typed write
approval. Old write-only tasks fail before launch. Full marker/ledger and strict historical
storage checks run under the canonical runner's transaction lock before DDL. Durable task ARN,
request token and CloudWatch evidence survive restart without automatic write retries. Local and production empty initialization share a full-native-operation/SQL-parameter review and under-transaction empty metadata proof; production requires its distinct typed Initialize approval. Populated/partial unknown storage is never adopted or reset. See the
[Database workbench guide](../../framework-studio/database-workbench.md) for precise actions,
evidence and capability limits.

`InspectorDraft` in [draft.ts](../../../client-app/src/draft.ts) owns baseline/latest snapshots, staged entries, validation, review and navigation protection. While dirty, the visible graph stays on the baseline. A different snapshot revision marks conflict; it does not auto-merge. Invalid/conflicting drafts cannot apply. An explicit Review against latest source preserves ordinary typed entries and requests a fresh proposal; protected resource/input forms require their own reload. `StudioProvider` in [studio.tsx](../../../client-app/src/studio.tsx) connects this lifecycle across routes and browser exit. Drafts remain in memory; interrupted source writes have a separate durable journal.

[draft-entries.ts](../../../client-app/src/draft-entries.ts) owns staged entry/form
types and pure resource normalization/request conversion. It does not own session state
or make requests. Ordinary edits, including resource configuration, use batch review;
private environment edits use their isolated input review. The frontend review union
contains those two actual paths. Existing server resource APIs retain their separate
compatibility contracts.

## Inspector module ownership

[Inspector.tsx](../../../client-app/src/views/Inspector.tsx) owns entity dispatch,
presentation capture/restoration and the draft footer. `views/inspector/WorkloadInspector`
renders targets/routes, workflow steps and workload environment mappings;
`ResourceInspectors` renders catalog resources and local/network fixtures;
`InspectorRelations` renders their shared relationship list. Specialized editors remain
the owners of their own forms. Dispatch permits supplementary sections, so adding a
resource must not replace it with an exclusive renderer registry.

[Triggers.tsx](../../../client-app/src/views/Triggers.tsx) retains form/disclosure
state, availability/validation, step-focus effects and draft staging/removal. Its
`inspector/triggers` modules share the form contract and render setup steps and typed
fields without another form store. Guided and raw input representations remain part
of the same form. Source changes, Confirm/Back and invalid intermediate text retain
their existing transition semantics.

The [navigation presentation contract](rendering.md) depends on the actual element
hierarchy, not merely its appearance. Extract existing components without adding
wrappers or changing conditional order/keys; verify focus, disclosure and scroll
restoration in real browser Back/Forward cases.

## Ownership

The Studio host assigns **framework** or **developer** ownership to each resource when it
opens or refreshes a project. Add shared resource definitions to the
[Studio framework resource catalog](../../../client-app/server/model/framework-resource-catalog.ts).
The host applies it to the selected project's evaluated resources and installed sources.
A catalog update takes effect across compatible projects on their next open with that Studio
version. New CDK or runtime functionality still follows the project's reviewed release upgrade.

| Resource | Ownership rule |
| --- | --- |
| Generated HTTP and WebSocket APIs | Framework. Routes and handlers keep their own owners. |
| Primary PostgreSQL database | Framework by default. The project supplies database settings and placement. |
| CDK stacks and their public members | Stacks defined by the installed framework package belong to the framework. Studio also registers the starter's website and RDS stack classes at their canonical source paths. Members inherit their stack's owner. |
| Framework inputs and services | Studio registers known deployment, local and sign-in settings, the logical CDK environment editor, and services defined by the packaged Compose file. Each project's own files and client environment mappings belong to the project. Database overrides follow the database. |
| Application declarations | An explicit `managedBy` records the owner's decision on a configurable declaration. Other application workloads, AgentCore gateways, VPCs, native stacks and custom inputs default to developer. Routes and network components inherit their structural owner's classification. |
| Application namespaces | A group with uniformly owned entries inherits their classification. A mixed namespace belongs to the project and each entry retains its owner. |

The [ownership projection](../../../client-app/server/model/ownership.ts) records the
basis and source of each decision in `ModeModel.ownership`. If dev and prod assign different
owners to one definition, Studio shows both declarations and protects the shared source until
they agree. Missing graph evidence also prevents writes. An integration such as Cognito's
workload user-pool binding has its own evidence and can use a developer-owned stack.

The [write guard](../../../client-app/server/edits/ownership-guard.ts) checks framework-owned
stack source and declaration tokens. The project can edit tags, display names, descriptions,
supplied values, and the configuration exposed by the resource. A reviewed change of owner
stands alone. Removing a project override restores the catalog default.

Enforcement covers every writer:

- `BatchEditor` assesses the proposed change set before generation, on the final set and before
  writing. An `ownership` edit must be the only kind of edit in its batch, and every transition in
  a change set must come from one.
- `writeSourceChange` and `writeAtomically` in [io.ts](../../../packages/aws-studio/scripts/source/io.ts) call the
  guard the server installs, so other Studio writers are checked too. Recovery rollbacks pass
  `restoring: true`, because they restore recorded bytes.
- Coding-task proposals: the agent host does not evaluate configuration, so the Studio server checks
  them in [proposal-ownership.ts](../../../client-app/server/edits/proposal-ownership.ts). It rebuilds each
  proposed file from its complete diff, accepts it only at the proposal's SHA-256, attaches the
  result to the proposal view and refuses approval in `agentTaskRouter` before the host is asked.
  The host applies an approved proposal only to its exact baseline. Proposals that are already
  approved (integrating, completed, recovery) keep their retry path unchecked.

The Inspector's **Ownership** disclosure shows the owner, the basis, what Studio may change and any
integrations. **Take ownership** / **Hand to the platform** (or recording an owner for a conflict)
opens a confirmation, then stages `{ kind: "ownership", entity, managedBy }`;
[edits/ownership.ts](../../../client-app/server/edits/ownership.ts) writes the explicit value at the
declaration's tag site (each entry for a group). Intrinsic framework resources have a fixed catalog owner. Inherited entities link to the owner’s declaration. Ownership of files (platform versus application source)
is not modelled; edits made outside Studio are not checked.

## Reviewed source application

Routine Inspector changes retain the exact framework pin. A change that updates the
lockfile, such as creating a service workspace, includes its dependency installation in
the same review. Open the app-name menu and
choose **Review framework upgrade** to advance a vendored project to Studio's bundled
framework. A creator that needs a newer framework capability can include the same
upgrade in its own review. Studio installs the target in a private candidate before
running the creator and expects the app's pinned Node and npm to remain suitable.

The review identifies the archive and its integrity and shows the manifest, lockfile and
any source or generated changes. Studio runs the app's offline install lifecycle and
Contract Chain checks in the private checkout. Missing or stale receipt approvals can
leave a passing candidate pending. Review and Apply leave receipt approval unchanged.

Apply reproduces the reviewed installation privately with the app's toolchain, then uses
the existing project write lease and journal to activate the vendored tarball, source and
installed dependency trees together. It resolves moved workspace links at their final paths,
checks the approved digests and loads a fresh Development and Production snapshot. Apply
preserves the prior dependency trees until verification succeeds.

If Apply is interrupted, run `--recover-upgrade --project <directory>` through the
Studio launcher before opening the project again. Recovery restores the files and
dependencies still owned by the interrupted operation. A conflicting external edit or
install is preserved and reported for inspection. After reconciling a conflict, use
`--recover-upgrade --status` to review its current state and fingerprint. Pass those
values to `--recover-upgrade --keep-current <id> <fingerprint>` to retain a coherent
installation and complete recovery. The release upgrade path expects a project-local
vendored framework, a reproducible offline npm cache and dependency roots on the
project's filesystem. A project with durable restricted execution needs a qualified
restricted npm installer to use dependency activation.

During apply, draft setters and discard are inert until the server responds, preserving
the accepted review payload. Network creation/settings and workload placement controls
use the same busy, evaluating, stale and conflict gates as the other Inspectors.
The pure `sourceEditBlocked` predicate in [editing-state.ts](../../../client-app/src/editing-state.ts)
expresses that common gate. Additional restrictions such as running operations, private
sessions, missing files or unavailable consumers stay with the owning control; similar
forms need not have identical permissions.

Inspector settings consume `FieldFact` inheritance and source editability. `FIELDS`, `DEFAULT_FIELDS`, `fieldFacts` and `fieldById` in [edits/fields.ts](../../../client-app/server/edits/fields.ts) define recognized fields, domains, parsers, source paths and defaults. Add a field through this shared contract rather than a UI-only input. Effective inherited values and authored overrides must remain distinct; removal restores inheritance. Some boolean fields support true/absence rather than explicit false.

Lambda Resources settings expose **Reserved Concurrency** and **Provisioned
Concurrency** as off-by-default switches with numeric execution counts when on.
Their canonical source is the optional `reservedConcurrentExecutions` or
`provisionedConcurrentExecutions` count, so off removes the property instead of
persisting a redundant boolean. They are excluded from shared defaults. Reserved
allows 0 and provisioned starts at 1; the draft and both-mode source validation
reject provisioned counts above a configured reservation. Source review explains
reserved zero and provisioned capacity billing. Applying saves source; deployment
remains separate.

Boolean settings reuse `InspectorSwitch` in `InspectorUI.tsx`, including VPC/database
policies and creation forms; toggling stages the owning draft and never applies source.
VPC inspectors contain only network settings and membership, not global workload defaults.
`SharedDefaults.tsx` presents Lambda and container family defaults in Serverless compute's
Service type selector, with tool defaults also in Agents. APIs lists gateways without
workload defaults. Database caller
pool defaults live in Application PostgreSQL's Connection pool defaults and still edit `defaults.database`,
independently of the server policy declaration. See the
[inspector conventions](../../framework-studio/inspector-design.md).

Resource-inspector disclosures start closed on a fresh visit. Workload Permissions
and Settings and catalog Access to this resource use the same `InspectorDisclosure` as stack
fields/outputs and gateway sections. Settings groups HTTP routes/access, runtime capacity
and local replay directly, with embedded advanced build and production-placement
disclosures. Counts and draft status remain on the collapsed heading; Settings includes
route, auth, replay, build and placement changes and marks invalid drafts. Route
inspectors expose their owning target's authorizer in Settings and derive access text
from the draft. Shared-compute edit locks remain authoritative; path editing stays in
the Lambda inspector. Permissions contains matching Resource permissions and Access to this
resource disclosures, each retaining counts and draft status. Ordinary inputs and user-pool
identifier delivery live in Configuration and inputs. Access actions appear after expansion.
New native rules use service-specific action checkboxes and explicit select-all actions;
advanced native grants use source-discovered methods and serializable arguments. Manual IAM
edits explicit Allow/Deny statements, reference-based or literal scopes and conditions.
Source-bound IAM rule identities retain shared ownership and list every consumer; updating
or removing a shared rule changes its owner once, while Add workload-specific rule preserves
that shared declaration. Literal IAM edits preserve comments through comment review;
computed owners and protected directives remain linked and explained.
Managed-policy connections edit attachments; policy documents stay with their native stacks.
Derived permissions navigate to their route, trigger, workflow or gateway owner.
Construction readiness is separate from source validity: disconnected public stack resources
can be selected and saved with persistent connection/caller/resource diagnostics. This never
constructs the stack or deploys it. Ordinary inputs are excluded from permission targets.
S3 limits expose literal prefixes and HTTPS. Editing a recognized legacy native grant stages
its exact removal and an explicitly reviewed replacement, preserving all other rules.
Computed/commented or ambiguous binding lists remain source-owned. Restriction summaries
describe one rule; overlapping native or declared access remains visible as additional grants.
The navigation presentation contract still restores open states on Back/Forward;
action-driven focus, guided setup and validation may reveal the relevant controls.

`InterfaceEndpointPicker.tsx` replaces comma entry in VPC editing and creation with
searchable service icons and removable selections. It stages exact endpoint IDs through
the existing network/create drafts. `ModeModel.interfaceEndpointServices` is projected
directly from `INTERFACE_ENDPOINT_SERVICES`, the framework's generated CDK catalog;
`src/endpoint-services.ts` supplies only labels and local artwork. Gateway endpoints keep
their separate controls. An unavailable catalog offers a server restart instruction and
preserves authored selections. The catalog does not verify regional service availability.

The shared [deployment controls](../../../client-app/src/views/Deployment.tsx)
live inside Settings on workloads and routes. Header Dev/Prod pills replace the standalone
Deployment section: hover/focus explains availability and execution; click/tap pins ownership
details and owner navigation. The pill interaction lives in `EnvironmentDetails.tsx`, shared
by `InspectorKind`. Grouping islands and input groups summarize entry counts. Collapsed
Settings retains modified/error status for deployment and required-input edits.

Route edits target the owning workload. Token previews use framework-projected `deployChoices`;
conditional Deploy uses a typed batch operation and the existing resource import alias.
The evaluator sends condition metadata to the parent; only holds/fails/unset outcomes return
over IPC. Each environment resolves privately against its own inputs. Saved conditions show
both outcomes; review resolves drafts, and selectors count as consumers for catalog rename/delete
safety. Catalog/local-service inspectors reuse the pills, with managed ownership explained
instead of inventing a deploy field. Catalog availability is not evidence of deployed
infrastructure. See the [inspector conventions](../../framework-studio/inspector-design.md).

```mermaid
flowchart LR
  A[Stage draft] --> B[Plan source overlays]
  B --> C[Validate both modes + relevant TS checks]
  C --> D[Review per-file diffs / impact]
  D --> E[Recheck revision / hashes / authority]
  E --> F[Write files / rebuild snapshot / compare]
  F --> G[Confirm source or guarded restoration]
```

`EditService` in [transaction.ts](../../../client-app/server/edits/transaction.ts) serializes its operations and keeps expiring plans. `BatchEditor` in [batch.ts](../../../client-app/server/edits/batch.ts) composes field, route, trigger, failure destination, replay wrapper, naming, public input configuration, tags, description, mapping and creation changes into source overrides. The legacy resource source API delegates to that planner and journal. Private environment values retain a separate service and never enter source diffs; see [secrets](../deployment/secrets.md).

Local replay's paired handler write uses the shared repository-relative `compute/...`
source resolver. Only the declared event's direct TypeScript entry point is eligible;
escaping directory links and linked entry files are refused. This separate authority
does not expand the generic configuration writer's allowed paths.

Batch review rejects unchanged source before expensive work. Applicable framework
artifacts are generated in the existing disposable copy, then the complete candidate
is evaluated in fresh dev/prod processes once, with the relevant TypeScript checks.
Generator errors still block otherwise valid intent; rejected intent retains normal
both-mode diagnostics. Binding comparisons exclude only snapshot display evidence,
so source excerpts/locations do not cause unrelated candidate type-checks. Grant
scope, permission, destination and invocation changes remain validation dependencies.
The final review rechecks all captured generator-input hashes after validation.
Apply repeats validation and confirms actual written models; no review result is
reused across source changes. See the [source and projection benchmarks](../../framework-studio/performance.md#source-and-projection-benchmarks).

`planEdit` in [plan.ts](../../../client-app/server/edits/plan.ts) uses [source locations](source-indexing.md), narrow parsing and semantic patches; the shared diff engine preserves interior unchanged runs and emits contextual hunks. [splice.ts](../../../client-app/server/edits/splice.ts) replaces/inserts/removes supported literal ranges while preserving surrounding source/quotes. It refuses unsafe computed shapes instead of reprinting entire files.

Comment protection belongs in the shared source operations: inserting the first property
into a commented empty object is refused, and `setProperty` refuses replacing a literal
whose range contains comments. Editors may change a neighboring literal while preserving
comments outside that range. Do not add editor-specific fallbacks that discard this prose.
Batch removals use [comments.ts](../../../client-app/server/edits/comments.ts) to
keep attached and embedded comments in the initial diff. Review offers a separate
**Remove this comment** choice for each affected comment and revalidates the complete
candidate after a choice. Choices bind to saved file bytes and original comment locations;
the accepted plan stores the exact resulting source under the existing hash guards.
Tooling directives require manual resolution and block Apply while leaving the preview
available. Every comment has an exact **Open in VS Code** link and instructions.
**Refresh source and retry** reloads saved source and reviews the preserved ordinary draft
in the same dialog, clearing prior comment deletion choices. Protected input/catalog
forms retain their separate reload requirement. Pending or failed replans cannot apply
an older preview. Writers outside the batch context keep conservative refusal behavior.
VPC settings use the registered declaration's source span, including official import
aliases and modules containing multiple declarations; a helper's spelling or file layout
does not identify the declaration to edit.

Plans capture revision and file hashes; both fresh mode evaluations must pass. Canonical source resolution and artifact validation check configured directories, handlers and Dockerfiles against proposed files. Missing implementation is projected independently from declaration validity so repair remains available. Type-aware connection/creation/repair changes use TypeScript checks. Normal Inspector edits preserve target/construct identity. Creation permits expected additions and explicit removal permits only the selected removed identity. Projection-affecting edits, including the legacy route/deployment APIs, run real generation in a private copy and include changed/generated/deleted outputs in review. Generator input hashes include existing implementations, contracts and Dockerfiles even when no output changes. Review approval saves authored/generated source; it does not synthesize or deploy infrastructure.

Apply checks source before and after preflight, then checks each write's expected contents. `writeSourceChange` in [io.ts](../../../packages/aws-studio/scripts/source/io.ts) distinguishes absent files (`null`) from empty files, creates through an exclusive link, and replaces existing files by temporary-file rename. After refresh, the batch compares relevant actual identities/settings/routes/triggers/creation relationships with the reviewed model.

Atomic source replacement preserves Unix ownership/modes and Windows owner/group/DACL,
rejects linked files, and rechecks bytes and file identity immediately before rename.
Temporary source bytes are private until the original permissions are restored.

**Multi-file apply is not a crash-atomic filesystem transaction.** On caught failure it restores written files in reverse only while they still equal its own written contents. Concurrent edits are preserved and can produce `unconfirmed`; inspect those files. Saved-source history belongs to Git. Source-edit undo/redo APIs and in-memory history are removed. Server restart loses in-memory reviews. [journal.ts](../../../client-app/server/edits/journal.ts) writes a private fsynced write-ahead source record before batch/resource multi-file writes. An exclusive checkout lock spans writes and post-write verification; competing Studio processes cannot begin another journaled transaction. Begin never reclaims a stale lock. Restart exposes dead-owner records (including a lock acquired before journaling) through Source recovery. Typed Restore source restores matching bytes and preserves later edits; typed Keep current source completes recovery only after current-source revalidation and a fingerprint check. A separate exclusive recovery lock serializes explicit recovery. A shared active registry excludes in-flight transactions across service instances and rejects recovery against them. Record/root/path/symlink validation applies on reads as well as writes. Corrupt metadata or an interrupted recovery lock requires explicit inspection while snapshots remain inspectable and source writes remain blocked. Environment values and database operations have separate service boundaries. Revision/hash checks do not eliminate every external-editor race between a check and rename; editors outside Studio do not honor its lock.

The single-edit API and resource editor follow the same expected-contents write guard during recovery.

`DatabaseSqlService` in
[database-sql.ts](../../../client-app/server/database-sql.ts) owns a separate
fixed source authority under `packages/database/sql/`. A `.sql` file contains versioned
metadata and one parameterized statement. Hash-guarded review/save does not contact
storage. A separate expiring, single-use execution review binds saved bytes, positional
values and private loopback target identity; production is refused rather than bypassing
its IAM/TLS task. Inspection is a PostgreSQL read-only transaction; writes require
acknowledged COMMIT and once-only intent uses a database-side ledger in that transaction.
Redacted fsynced history records uncertain outcomes without replay. The service reuses
private target resolution, the database operation lock and the installed PostgreSQL
driver, never a second connection configuration or startup runner. `DataRetention.tsx`
reuses the protected environment-input service for mode-specific
`RETAIN_STATEFUL_RESOURCES`; saving it is distinct from deploying protection, teardown
and actual recovery.
Journal records retain per-file authority: recognized native CDK edits first pass the
linked-stack ownership check and record a bounded native source entry; generated/new
files retain creator authority. A mixed native/source/generated transaction can recover
without broadening the normal configuration writer or accepting HTTP-selected paths.
`identityPolicy` batches edit only the recognized linked native stack's literal
`identityPoolAccess` options. ReaderRole Allow/Deny statements replace convenience
bucket settings; default/guest roles stay permissionless and guest issuance is an
explicit opt-in. Stack/helper/validator hashes expire reviews. Custom shapes and
authored comments refuse replacement. The separate read-only IAM simulator uses
saved statements and an STS-pinned account; it rechecks all three source authorities
after the asynchronous request and does not prove credential claims, boundaries,
SCPs, resource policies or runtime access. See the
[identity guide](../../framework-studio/identity-and-domains.md#identity-pools).
Post-write snapshot exceptions and stale/error models trigger restoration, never a
successful edit response. An external edit or deletion remains untouched and yields
`unconfirmed`. If refresh still fails after recovery, the response distinguishes restored
source from an unavailable snapshot and asks the user to refresh after resolving it.
`SourceJournal.begin` acquires its exclusive checkout lock before inspecting pending
records. A competing writer is refused even while the owner is initializing lock
metadata; it cannot misread that live lock as a corrupt record. Pending records
still block new writes, and a refused attempt releases only its own token. Incomplete
or abandoned locks remain explicit inspection/recovery work. See the deterministic
[lock race tests](../../../client-app/test/source-lock-race.test.ts).
Resource rollback attempts every written file even when one was externally deleted or
cannot be restored, reports `unconfirmed` and preserves later edits.

Use [extensions](../guides/extensions.md) for new fields. Tests: [plan](../../../client-app/test/plan.test.ts), [splice](../../../client-app/test/splice.test.ts), [transaction](../../../client-app/test/transaction.test.ts), [draft](../../../client-app/test/draft.test.ts), [draft UI](../../../client-app/test/draft-ui.test.ts), and feature-specific creation/trigger/resource suites. Assert refusal causes zero writes and rollback preserves unrelated changes.

Typed VPC removal and managed database settings reuse this batch journal, including
post-apply semantic checks, guarded guarded rollback. VPC removal rescans source
consumers immediately before writing. `ManagedDatabaseInspector.tsx` joins local PostgreSQL
and production RDS, showing independent data, connection paths, the VPC home and consumers.
Policy edits target literal settings. A separate typed `databasePlacement` operation
coordinates the database declaration and the union of normalized database consumers in
both modes, preserving each workload's subnet tier and bindings. `DatabasePlacement.tsx`
offers only registered VPCs and private/isolated subnets; the owning VPC is required.
Computed declarations and competing consumer placement edits are refused. Actual placement
is checked after apply; mismatch uses guarded rollback.
This edits source only: deployed RDS moves need migration/cutover planning and separately
authorized deployment. Identity and native CDK source remain source-owned. See
[placement and parity](../../framework-studio/network-database-declarations.md).
The [database placement suite](../../../client-app/test/database-placement.test.ts)
covers coordinated consumers, policy composition, unsafe-source refusal, post-write rollback
and guarded rollback without touching a live database.
The
[HTTP response helper](../../../client-app/server/http.ts) catches synchronous
validation as well as rejected planning promises. A shared browser/server protocol blocks
incompatible edits with an explicit restart instruction; a Vite refresh does not reload
the running server API.

Local readiness uses the valid development snapshot to recognize service launchers
that exit zero because Deploy is disabled. Their container row says Disabled by Deploy;
nonzero exits and unhealthy active services still block startup.

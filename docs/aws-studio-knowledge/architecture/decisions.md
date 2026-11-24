---
id: architecture.decisions
summary: Reconstructed architectural decision records with rationale, consequences and source evidence.
read_when:
  - Changing a boundary or proposing a new representation of the application
source:
  - packages/aws-studio/src/config/source.ts
  - packages/aws-studio/src/config/index.ts
  - packages/aws-studio/src/config/resources.ts
  - client-app/server/snapshot.ts
  - client-app/server/edits/batch.ts
  - client-app/server/edits/journal.ts
  - client-app/src/scene/build.ts
  - packages/aws-studio/cli/deploy.ts
related:
  - architecture.contracts
  - reference.invariants
  - reference.status
---
# Architectural decision records

These records describe established decisions and proposed changes. **Established**
means the current implementation and working rules enforce or depend on the choice.
Proposed decisions specify behavior to qualify. See [status and direction](../reference/status.md).

## ADR-001 — Keep TypeScript declarations authoritative

**Status: established.** The composition root imports literal workload sections,
resources, networks and the database declaration. Framework normalization is consumed
by CDK, local execution, generators and Studio. Arrays retain duplicate-key evidence;
object spreads can erase that evidence before validation.

This makes source review and normal developer tooling available while sharing one
application contract. Studio must represent unsupported expressions honestly and refuse
edits it cannot preserve. It must not serialize the graph into a second authoritative
configuration. Generated projections are regenerated from their producers.

Evidence: [configuration](../framework/configuration.md),
[source authority](contracts.md), `defineFrameworkConfig` and
`normalizeFrameworkConfig` in [config/index.ts](../../../packages/aws-studio/src/config/index.ts).

## ADR-002 — Model native capabilities instead of cloning the AWS catalog

**Status: established.** Symbolic catalog references expose native CDK attributes and
grant methods. Application code constructs and links resources beside their native
constructs; framework finalization resolves deferred bindings and checks dependencies.

The catalog describes what consumers can receive or do. Native construction remains
extensible and preserves stack ownership/construct identity. A reference to a value is
not automatically a permission; grants, secret delivery and database capability each
have explicit behavior. Studio discovery of a type does not imply generic CRUD support.

Evidence: [resources/CDK](../framework/resources-and-cdk.md),
[framework-resources.ts](../../../packages/aws-studio/cdk/framework-resources.ts),
[resources.ts](../../../packages/aws-studio/src/config/resources.ts).

## ADR-003 — Derive the graph and layout from semantic evidence

**Status: established.** The snapshot combines normalized dev/prod models with source
locations and bounded CDK inference. Edges retain purpose and provenance; the scene
projects islands, network placement and grouped connections. Layout identity is not
infrastructure identity. Source-mode changes reuse a shared layout basis.

The consequence is a useful architecture view without a manually maintained diagram.
Inference must remain distinguishable from declarations and observed AWS state.
Searching, filtering, panning and selecting never rewrite placement. A future manual
layout would be a view preference, not a deployment input.

Evidence: [graph model](../studio/graph-model.md),
[rendering](../studio/rendering.md),
[snapshot.ts](../../../client-app/server/snapshot.ts),
[scene/build.ts](../../../client-app/src/scene/build.ts).

## ADR-004 — Review exact source changes through bounded writers

**Status: established.** Typed drafts are planned against recognized source shapes,
validated in overlays/disposable workspaces where applicable, and reviewed before
application. Hashes and expected effects reject stale writes. The source journal
records recoverable interrupted transactions; subsequent unrelated edits must survive.

This trades arbitrary visual editing for reviewable, constrained changes. Each writer
must state its allowlist, generation needs and recovery semantics. Prisma, environment
values and operations have specialized authorities rather than a generic write-any-file
endpoint. Saved-source history belongs to Git; historical global Undo/Redo guidance is
superseded. Recovery is not a crash-proof transaction spanning AWS and local files.

Evidence: [editing](../studio/editing.md),
[batch.ts](../../../client-app/server/edits/batch.ts),
[transaction.ts](../../../client-app/server/edits/transaction.ts),
[journal.ts](../../../client-app/server/edits/journal.ts).

## ADR-005 — Separate mode, execution location, deployment identity and values

**Status: established.** Development and Production are binary framework modes.
Development may use local compute and AWS-managed dependencies. Named deployment
targets add explicit identity/account/region context without adding a third mode.
Inputs, public source values, secrets, runtime exports and client mappings have distinct
sources and delivery rules.

This prevents a graph switch from silently selecting a cloud target, or a generated
client file from becoming an input authority. Adding an independent mode would affect
normalization, evaluators, file selection, deployment guards and exports together.
Source values remain public; secrets cannot be smuggled through public stack strings.

Evidence: [environments](../deployment/environments.md),
[environment delivery](../runtime/environment.md), [secrets](../deployment/secrets.md).

## ADR-006 — Share execution contracts while preserving runtime differences

**Status: established.** Declared invocation bindings drive injected runtime descriptors
and cloud IAM. Workflows compile and interpret one symbolic IR; agents/tools share
contracts and local/cloud adapters. Application handlers do not choose transport by
checking the environment.

This reduces divergent application code. It does not make local Docker, child processes
or in-memory workflow histories equivalent to IAM isolation, Step Functions durability
or AgentCore runtime behavior. Explicit live evidence is still required.

Evidence: [local execution](../runtime/local-execution.md),
[workflows](../framework/workflows.md), [agents/tools](../framework/agents-and-tools.md).

## ADR-007 — Bind operational authority to reviewed effects and explicit targets

**Status: established.** Deployment uses saved assemblies, target/account/ownership
checks and reviewed fingerprints. Secret changes, database execution, identity writes,
DNS operations and frontend releases have their own review/outcome contracts. Studio
uses typed operational adapters; there is no generic shell endpoint.

A source review cannot authorize an AWS mutation. Unknown or partial outcomes must
remain visible rather than being reported as success or blindly retried. Local guards
are not distributed locks and repository wrappers cannot prevent out-of-band AWS
changes. Planning can itself have documented AWS effects, such as preparing change sets;
“plan” should not be used as a synonym for “offline.”

Evidence: [planning/safety](../deployment/planning-and-safety.md),
[operations](../deployment/operations.md),
[operational lifecycle](../deployment/lifecycle.md),
[deploy.ts](../../../packages/aws-studio/cli/deploy.ts).

## ADR-008 — Treat data and infrastructure identity as durable

**Status: established.** Target IDs, public routes, stack scopes, construct IDs and
output names are separate contracts. Stateful lifecycle uses explicit retention,
deployment evidence and resource-specific reuse. Teardown follows deployed identities
and dependencies rather than assuming current source enumerates everything deployed.

This protects upgrades and recovery when code evolves. Removing source does not
automatically remove cloud resources. Retaining infrastructure does not automatically
make it safe to reuse or restore. Preserve `postgres_data`, compare logical IDs for
infrastructure moves and inspect every resource-specific recovery precondition.

Evidence: [invariants](../reference/invariants.md),
[stateful lifecycle](../../framework-studio/stateful-resources.md),
[stateful database](../framework/stateful-database.md).

## ADR-009 — Keep Studio a local host tool and preserve extension boundaries

**Status: established.** Studio runs as a host process with React/TypeScript rendering,
Express, middleware Vite and isolated evaluator module state. Its HTTP surface uses
loopback/Host/token/origin guards. It remains optional for the framework.

The process needs local source/tool access; it is not a remote collaborative service
or a hostile-code sandbox. New resource families and UI workflows should extend existing
normalization, capability discovery, typed intents and review adapters. Remote operation
would need an explicit authentication, authorization, credential and collaboration design.

Evidence: [backend](../studio/backend.md),
[server.ts](../../../client-app/server/server.ts),
[moving forward](../../framework-studio/moving-forward.md),
[extension recipes](../guides/extensions.md).

## ADR-010 — Evolve Studio and projects independently

**Status** Established for the implemented compatibility boundary, November 24, 2026.

The Studio installation owns its host runtime. Each project owns its Node and npm
pins, dependency tree, lockfile, framework release and authored source. Studio
can bundle and recommend a framework release. Projects continue to build,
verify and run through their own installed framework without the Studio source
tree. Use a project process with an explicit executable for app-owned evaluation
and commands. Studio owns UI, orchestration and review. Exchange data and
diagnostics across the existing evaluator boundary, extended as needed. Preserve
the platform's restricted execution and process ownership on supported hosts.

### Version identities

| Identity | Decision |
| --- | --- |
| Studio distribution | Independently identify the installer for updates and recovery. Its release metadata names the exact bundled framework artifact and digest. A Studio-only release can keep that artifact. |
| Published framework | Use the existing package version and its own runtime ranges. Apps pin an exact artifact and retain its lock integrity. Studio and framework may continue to ship together from one repository while their version identities serve different purposes. |
| Project protocol | Start with one version for messages crossing the process boundary. Negotiate capabilities separately so an additive operation can share the existing protocol. |
| Project layout | Detect supported source shapes and prerequisites. Add a durable, scoped layout revision when a persisted breaking change needs an unambiguous migration start point. Database schemas, review receipts and npm lock formats keep their existing owners. |

Before executing app code, read the app pin and static compatibility metadata.
Obtain the minimum supported Studio release from a qualified framework artifact
or an explicit mapping for legacy artifacts. Report the actual minimum when the
installed Studio is too old. An unknown combination gets its own diagnostic.
After admission, check the selected app runtime and negotiate the capabilities
required for the requested action. During transition, retain the current release
guard for legacy artifacts. Use verified compatibility to expand support.

### Invariants for contributors

1. **Opening is inspection.** Preserve installed dependencies, manifests,
   lockfiles, vendored artifacts, private inputs and receipts. Keep necessary
   Studio coordination in its documented paths. Put setup actions that create app
   files behind an explicit decision. Updating Studio follows the same app
   preservation rule.
2. **Upgrade through a reviewed change.** Prefer the existing exact app pin for
   a change it already supports. When a feature requires a newer framework, or
   the developer asks to upgrade, show the eligible target and apply it with the
   approved edit. An app runtime change needs explicit approval. A supported
   app-facing framework can keep its older Node range while Studio advances.
3. **Create owned prerequisites.** Inspect the selected app's actual structure.
   Reuse compatible wiring, add missing pieces in recognized and owned locations,
   and report conflicts with paths. Preserve existing implementations, identities
   and unrelated files. Repeated planning and retry preserve a single binding.
4. **Migrate a tracked contract deliberately.** Prefer additive capabilities.
   When an incompatible persisted change is necessary, ship a deterministic
   transition in the platform with explicit input conditions, output revision
   and validation. Apply only transitions relevant to the app. Treat ambiguous
   custom code as a developer decision. Keep infrastructure and data actions
   separately authorized.
5. **Verify and recover as one operation.** Install and verify the exact candidate
   under app Node/npm before applying. Check the source, runtime and dependency
   identity again before accepting the review. Use the source lease and journal
   for the approved source changes, archive and dependency activation. Restore
   operation-owned changes and the prior installation on failure. Block further
   writes while interrupted recovery is unresolved, and preserve competing edits.
6. **Publish tested support.** Require reusable features to use public fixtures
   covering the oldest advertised baseline and relevant layout variations.
   Qualify released artifacts by project framework, runtime, native host and
   capability. Retain a compatible Studio release and artifacts for the published
   support and recovery window.

Keep the existing app framework for a routine edit. Combine a required pin
advance and its feature change in one reviewed approval.

The distribution records its own version, runtime and the bundled framework's
version and integrity. The project's installed manifest supplies the minimum
Studio release, protocol and capabilities. The public Framework 1.0.0 requires
Studio 1.0.0. Evaluation starts a worker under the selected project Node and
verifies the worker handshake.
Missing deployment inputs have an explicit setup action. [Packer](../../../scripts/pack-studio.ts) · [Admission](../../../client-app/server/project-release.ts) · [Startup](../../../client-app/server/server.ts) · [Evaluator](../../../client-app/server/evaluator/pool.ts)

Reviewed feature adoption stages the installed target framework before source
planning. Apply activates the verified dependency tree with the source, lock and
archive under the source lease. The journal keeps the previous dependency tree
until verification completes and exposes interrupted installations through
`--recover-upgrade`. [Reviewed save](../studio/editing.md#reviewed-source-application) · [Upgrade](../../../client-app/server/project-upgrade.ts) · [Installation journal](../../../client-app/server/edits/installation-journal.ts)

Qualify the packaged release with an independent application on each advertised
native host and runtime pair. Retain the two-release fixture proof for compatibility
changes. [Release qualification](../guides/verification-and-maintenance.md#qualify-studio-and-framework-releases)

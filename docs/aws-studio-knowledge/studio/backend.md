---
id: studio.backend
summary: Studio backend service boundaries, source authorities, state ownership and API navigation.
read_when:
  - Tracing a Studio interaction into the backend
  - Extending a source writer or operational endpoint
source:
  - client-app/server/server.ts
  - client-app/server/machine/docker.ts
  - client-app/shared/machine.ts
  - client-app/server/guards.ts
  - client-app/server/deploy/observe.ts
  - client-app/server/deploy/service.ts
  - client-app/server/deploy/routes.ts
  - client-app/server/deploy/stack-inspection.ts
  - client-app/shared/stack-inspection.ts
  - client-app/src/deploy/observations.tsx
  - client-app/src/deploy/live.ts
  - client-app/server/edits/batch.ts
  - client-app/server/edits/journal.ts
  - client-app/server/database-workbench.ts
  - client-app/server/project-modules.ts
  - packages/aws-studio/src/deploy/stateful-resources.ts
  - client-app/server/operations/client.ts
  - client-app/server/operations/coordinator.ts
  - client-app/server/operations/worker.ts
  - client-app/server/operations/ipc.ts
  - client-app/shared/operations.ts
  - client-app/src/operations/live.ts
  - client-app/src/operations/queries.ts
  - client-app/server/agent-runtime/
  - packages/aws-studio/scripts/source/source-gate.ts
  - client-app/server/evaluator/restricted.ts
  - client-app/server/graphql-chain/service.ts
  - packages/aws-studio/scripts/contract-chain/evaluation.ts
  - packages/aws-studio/scripts/contract-chain/dependencies.ts
  - packages/aws-studio/scripts/contract-chain/core.ts
  - packages/aws-studio/scripts/contract-chain/worker.ts
  - client-app/server/graphql-chain/review.ts
  - client-app/server/graphql-chain/cli.ts
  - client-app/server/graphql-workspace/inventory.ts
  - client-app/server/graphql-workspace/runtime.ts
  - client-app/server/graphql-workspace/routes.ts
  - client-app/shared/graphql-workspace.ts
  - packages/aws-studio/scripts/contract-chain/inspector.ts
  - client-app/server/graphql-chain/inspection-host.ts
  - client-app/server/graphql-chain/watch-inputs.ts
  - client-app/server/graphql-chain/evidence-cache.ts
  - packages/aws-studio/scripts/contract-chain/proof-core.ts
  - packages/aws-studio/scripts/contract-chain/proof.ts
  - packages/aws-studio/scripts/contract-chain/portable-identity.ts
  - packages/aws-studio/scripts/contract-chain/portable-dependencies.ts
  - packages/aws-studio/scripts/contract-chain/ci.ts
  - packages/aws-studio/cli/aws-studio.cjs
  - scripts/pack.ts
  - packages/aws-studio/scripts/contract-chain/ci-observation.ts
  - packages/aws-studio/scripts/contract-chain/contract-proof.ts
  - packages/aws-studio/cli/windows-security.ts
  - packages/aws-studio/cli/private-files.ts
  - packages/aws-studio/cli/windows-job.ps1
related:
  - studio.interface
  - studio.snapshots
  - studio.editing
  - deployment.planning-safety
---
# Backend services and authority boundaries

Studio is a local Node host serving React through Vite middleware. It executes trusted
repository configuration and may run explicitly requested local or AWS operations. Its
browser protections do not make arbitrary checked-out code safe to run, and it is not a
hosted multi-user administration service.

[server.ts](../../../client-app/server/server.ts) assembles services, guarded API
routes, server-sent events, Vite and the watcher. [index.ts](../../../client-app/server/index.ts)
selects the project through [project.ts](../../../client-app/server/project.ts) and chooses
server mode or one-shot `--print`. `--project <dir>` (or `STUDIO_PROJECT`) opens that directory;
otherwise the project is the one containing the working directory. A project holds
`framework.config.ts` and `package.json` and installs `aws-studio`; anything else is refused
with what is missing. One Studio process serves one project, so opening another is a restart.

Studio evaluates a project with the framework that project installs. The evaluator's first import,
[use-project-framework.ts](../../../client-app/server/evaluator/use-project-framework.ts),
loads every module that resolves inside Studio's `aws-studio` from the same path in the
project's, so a configuration is built and projected by one framework instance, and a module this
Studio needs that the project's version lacks is refused by name. The sandboxed evaluator bundle
keeps its own single-instance plugin instead. Application modules Studio executes in its own
process load from the opened project through
[project-modules.ts](../../../client-app/server/project-modules.ts), never from Studio's
checkout. The project's declarations (deployment inputs, sign-in catalog and inputs, framework
settings) load at the paths and with the contract types of the framework's
[project-declarations.ts](../../../packages/aws-studio/src/config/project-declarations.ts), which
`packages/aws-studio/cdk/deployment.ts` uses too. An absent declaration module supplies empty settings.
Stateful policy resolution and reference validation use the opened project's installed `aws-studio/deploy/stateful-resources`
and `aws-studio/deploy/stateful-references` exports from the project's root
installation. A missing installation or export identifies the required subpath.
[project-boundary.test.ts](../../../client-app/test/project-boundary.test.ts) keeps
executable application imports and relative framework imports out of Studio, and
Studio resolves its own framework from the host installation before redirecting evaluation to
the opened project's installed package. The platform tests prepare a physical install of the
development release from the starter commit recorded in `scripts/starters.json`.
`npm --workspace framework-studio run test:external-project` opens a writable copy of that
starter. [Evaluator host resolution](../../../client-app/server/evaluator/project-framework.ts)

The listener claims
loopback before expensive initialization; shutdown owns evaluators, watcher, Vite and
legacy fixed command children. The checkout operations host, its local runtime support
processes and independent operation workers outlive this shutdown;
Studio closes only its runner client. See [snapshots](snapshots.md) for startup, reload
and disposal, and [operations](../deployment/operations.md) for runner lifecycle.

## Separate authorities

| Service / entry point | Owns | Does not establish |
| --- | --- | --- |
| `SnapshotBuilder`, `EvaluatorPool`, `projectModel` | Both normalized mode graphs, source revision, source evidence and metadata projections | Deployed resources, live health or secrecy against hostile authored code |
| `EditService`, `BatchEditor`, `ResourceService` | Typed source proposals, complete overlay validation and guarded writes | Arbitrary code editing or deployment approval |
| `DeploymentInputService` | Private values and reviewed edits to the two fixed CDK environment files | Secret upload, client export or complete infrastructure validation |
| `DatabaseWorkbenchService`, `DatabaseHistoryService` | Prisma source, semantic validation, history comparison and reviewed offline artifact installation | Application of migrations to a database |
| `DatabaseApplicationService`, `DatabaseCloudService`, SQL router | Separately targeted, reviewed database operations | Authority derived merely from editing Prisma or choosing a source mode |

The SQL router uses Studio's own PostgreSQL driver. Its reviewed SQL, connection
selection and history belong to the opened project, while the driver follows
the Studio distribution's lock.
| `InfrastructureService` | Explicit CDK synthesis and sanitized assembly inventory, with per-mode freshness | Deployment, live drift or AWS runtime health |
| `DeployService`, frontend-release and stateful-resource services | Named targets, plans, operation approvals, evidence and recovery/lifecycle workflows | Implicit authority from source Apply or a canvas selection |
| Stack inspection under `DeployService` | On-demand CloudFormation information for a verified deployment member and immutable stack ARN | Account-wide stack browsing, deployment approval, secret resolution or implicit drift detection |
| Operations coordinator and workers | Durable accepted intents, duplicate prevention, resource claims, independent execution/log capture and shared projection for supported adapters | New deployment authority, replay of uncertain mutations or approval for database/publication/identity actions |
| Identity and identity-policy services | Source-owned identity configuration, selected AWS observations and typed operation boundaries | A generic IAM policy simulator or proof that provider-side sign-in works |
| `AwsConnectionsService` | Machine-local profile catalog, identity observations, native authentication coordination, reviewed non-secret AWS configuration and profile deletion | Deployment approval, complete IAM authorization or browser access to credentials |
| `CommandRunner` | Fixed `framework:check` and confirmed `framework:generate` scripts | A request-controlled shell or the complete operations surface |
| `GraphQLChainService` | Stage-scoped source hashes, predecessor-bound proof receipts, reviewed decisions, restricted behavioral/type checks, SDL/document validation and non-writing Codegen evidence | Running API/database state, generated-output writes or automatic propagation |
| GraphQL workspace inventory | Bounded saved generated SDL, authored documents, resolved fragments and recognized TanStack exports | Live schema freshness, executing application source or inferred Prisma mappings/cache keys |
| GraphQL Explorer runtime | Observed local-runtime readiness and an explicit bounded request to the fixed configured loopback GraphQL endpoint | Starting local compute, choosing an arbitrary endpoint, storing tokens or decoding authorization claims |
| `GraphQLChainReviews` and the chain CLI | Deterministic review evidence in the single fixed root `graphql-chain.review.json`, with explicit scoped acknowledgement | Exposure decisions, application source changes, generation, migrations or deployment |
| `AgentLabService` | Bounded question answering and model discovery through local CLIs | Live source/graph/log inspection, arbitrary agent-authored code execution or general framework editing |
| `AgentTaskService`, native provider adapters and pinned agent host | Durable Coding tasks, restricted native editing in private saved-source copies, validation, immutable proposals, explicit approval for editable Coding and guarded integration for guided contract actions | AWS/database/deployment authority, arbitrary permission expansion or automatic replay of uncertain commands |
| Agent integration and shared source gate | Baseline/digest checks, serialized imports, durable recovery, publication coordination and explicit kept/restored outcomes | Atomic multi-file filesystem writes or undo of external command side effects |
| Managed Studio runtime activation | Explicit restart of a registered observer after its reviewed source is applied | Source approval itself, dependency installation or arbitrary process control |
| Agent-host runtime upgrade | Explicit request-identified transition to a newly pinned host implementation with retained task state | Source import, Studio observer restart or permission to terminate unrelated processes |

Activity and Deploy reject a job event whose log sequence is older than the held
job, or whose running status would replace a terminal result. A completion can
have the same sequence as its last progress event. The operations list also preserves
newer cache entries received while its GET was pending. A later uncontended GET can
remove server-pruned jobs; no additional retained job cache is introduced. The log
sequence is not a revision for arbitrary same-sequence metadata changes.

Each authority has its own typed request and checks. The generic configuration writer
allows existing `framework.config.ts` and `framework-config/**/*.ts` by real path,
without symlinks. Creation, generated projections, starter implementations, selected native
trigger removal, identity policy, Prisma and private input edits have narrower dedicated
validators. Do not broaden the generic allowlist to accommodate a new workflow.

## Request and state flow

The browser fetches `/api/snapshot` and subscribes to `/api/events`. A snapshot contains
both mode models and source locations, not live AWS state. One reference-counted
EventSource per tab serves snapshot, operation and deployment observers. Reconnect invalidates
queries; source changes expire reviews. Dirty drafts keep their own snapshot baseline.

One persistent browser deployment observer reads overview/profile metadata and one
mode-correct deployment target per configured association on every route. Shared Query
entries own its responses/errors; pages subscribe without adding requests or polling.
The existing status batch contains discovery, recent events/change-set summaries and
Development compatibility; it avoids a separate equivalent discovery request. This is
read-only evidence, separate from specialized inspection and mutation approval.

The on-demand `/deploy/stack` reader is separate from that background status batch.
It validates the declared target, selected actor and framework ownership, pins the stack ARN and reads
one requested CloudFormation section. Section pagination is bound to the verified
destination; outputs, template, parameter and change-set data do not enter operation
logs. NoEcho parameters and template defaults stay masked. See
[deployment operations](../deployment/operations.md) for the inspector sections.

`AwsObserver` shares pending command reads independently of their completed-cache TTL.
Freshness starts at completion. A forced read bypasses a completed entry but joins a
pending request in the same profile/configuration generation. Profile/all invalidation
removes old entries so new reads cannot join an earlier generation; late completion can
only finish the original request. Failed observations are not cached. Source publication
invalidates source-dependent observations, and terminal operations invalidate the host
cache before broadcasting completion. Browser query identities and scoped invalidation
preserve the same destination/credential boundaries. See
[AWS connections](../../framework-studio/aws-connections.md#shared-deployment-observations)
for scheduling, failure and reconnect policy.

Shared operation requests pass from guarded Studio HTTP routes through
[`OperationsClient`](../../../client-app/server/operations/client.ts) and
[private local IPC](../../../client-app/server/operations/ipc.ts) to a
separate host coordinator. The coordinator commits acceptance before acknowledgement;
workers reconstruct allowlisted adapters rather than executing request-supplied commands.
Worker-owned SQLite log writes continue without Studio. The API combines these records
with the host's local jobs for Activity; execution and domain outcome are separate fields.
The same host owns the local runtime's existing JobManager and native child-process
supervision. Studio proxies local status and lifecycle intent over the existing private
IPC; its own observer never restores or cancels the host's active job records.

An Inspector review sends typed intent and its source revision. The server locates
the authored syntax, composes candidate text in memory, validates the complete overlay
in fresh mode evaluators and performs operation-specific type/graph checks. Apply accepts
the server-owned plan ID, rechecks files and revision, writes, reloads and verifies the
predicted result. The browser does not supply arbitrary configuration text to the generic
writer. The Prisma editor is a distinct fixed-file text authority.

Batch/resource multi-file writes use `SourceJournal` and the durable SQLite source gate
shared with coding imports and source publication.
The private write-ahead record supports explicit interrupted-write recovery. A multi-file
apply is not a crash-atomic filesystem transaction; rollback restores only bytes still
matching the transaction's writes and preserves intervening edits. In-memory reviews are
lost on restart. Coding tasks, immutable proposals and their approval records are durable
in the independent host. Git remains an optional developer history mechanism; Coding does
not create branches or commits to capture the saved working tree.

Source-gate storage rejects linked paths, non-regular database files and hard links on
every platform. POSIX hosts also enforce private file permissions and current-user
ownership; Windows verifies the real owner and installs a private DACL on its app-owned
coordination directory and database, preserving existing leases and recovery bytes.
Node's synthetic Windows mode bits do not represent those permissions.
The coordination database also retains a native checkout directory identity and prior
locations, so reopening an idle renamed folder preserves its publication epoch and
completed journal history. An active lease or pending recovery prevents adoption; a
copied database cannot claim the original directory's identity. Legacy records without
that identity require an absent former location and idle source before adoption.
Operations storage can follow those verified prior locations only after its executions
are finished and resolved and all operation locks and recovery holds are released. It
retains original intent identities and consumed reviews without replaying operations.
[Windows permission primitives](../../../packages/aws-studio/cli/windows-security.ts) verify the real
owner and DACL; [private-file creation](../../../packages/aws-studio/cli/private-files.ts) protects a
new inode before publishing its pathname or writing private contents.
Windows creation verifies the actual empty staging file before publication; it does
not repair a shared file after opening it. Private groups grant cleanup authority
only after verifying an unchanged, empty directory, and recheck its identity after
each file opens and before any bytes are written.

`SnapshotBuilder` owns a lazy source-gate observer connection until disposal. Its
native permission check grants access to that retained SQLite resource; it grants
no cached pathname authority to writers. Each observation checks the directory and
file identities/types/links (and Unix owner/mode), reads committed state, and freshly
checks any lease's process identity. Replacement closes the observer and requires
inspection/restart. New writer/recovery acquisitions still verify native permissions.

Coding HTTP routes proxy to a private per-checkout local host. Its pinned code and
task state live outside editable source. Native CLIs own coding/tool execution inside the
named execution policy; the host owns final validation, frozen blobs and digest-bound
approval. Browser replay is observational and disconnection is not cancellation. Source
review and runtime activation are separate durable outcomes. See
[Coding tasks](../../framework-studio/local-agent-lab.md#coding-tasks) for the current
workflow, limitations and source owners.

An inspector `/edits/batch/coding-review` handoff exports an unchanged, accepted typed
review to that same private proposal pipeline. No model call or live source write occurs
at handoff. The original direct batch apply remains supported. Architecture previews are
separate restricted evaluations of frozen baseline and candidate source; they never
publish a live Studio snapshot or assert observed AWS state.

## API navigation

These are service families, not a frozen exhaustive endpoint specification. Consult the
mounted router and `src/*-api.ts` transport before extending a request.
All prefixes in this table are relative to `/api`.

| Prefix | Main actions / source owner |
| --- | --- |
| `/snapshot`, `/events` | Source read/refresh and live notifications in `server/server.ts` |
| `/edits`, `/routes`, `/resources` | Review/apply typed fields, batches, routes and catalog resources |
| `/deployment-inputs` | Fixed-file metadata/value reads, creation from template, private review/apply |
| `/source-recovery` | Read recovery records; typed restore or keep-current after validation |
| `/infrastructure` | Read inventory; explicit `/synthesize` |
| `/database/workbench`, `/database/history` | Source validation/format/review/save; history compare/plan/install/discard |
| `/graphql/chain` | `server/graphql-chain/routes.ts`: GET the source hash and check status from memory. `?check=fresh` starts a background check. `?check=refresh` can reuse independent checks if their inputs still match. POST `/review` prepares a scoped record diff. POST `/accept` applies its server-owned plan. |
| `/graphql/workspace`, `/graphql/runtime`, `/graphql/execute` | Fast cached source inventory; local-runtime readiness; separately guarded transient GraphQL relay. The execution request never controls its destination |
| `/database/application`, `/database/cloud`, `/database/sql` | Separate target review/application and SQL operations |
| `/machine/docker` | Shared host Docker/Compose observation and timestamp, without AWS discovery; one in-flight probe/cache feeds readiness and Docker-dependent operations |
| `/deploy` | `server/deploy/routes.ts`: target discovery, plans, approvals, operations and local runtime |
| `/operations` | `server/server.ts`: shared operation list/submission, `/:id/log?after=<seq>` replay and `/:id/cancel`; adapter-specific approval stays with its owning workspace |
| `/aws-connections` | `server/aws-connections`: catalog, protected connection checks, ephemeral authentication, configuration, deletion and logout reviews |
| `/frontend-release` | `server/frontend-release-routes.ts`: frontend release and add-a-deployment-stage workflows |
| `/app-name` | `server/app-name-routes.ts`: the app's name and id (`framework:app`, `framework:appId`): read, review (read-only AWS discovery by app id and stage decides which production stages keep their deployed name), `/deploy-as/review` (keep one stage's deployed name, from Deploy) and hash-guarded apply to `cdk-app/cdk.json`; source edits, not AWS operations |
| `/identity`, `/identity-policy` | `server/identity/routes.ts`, `server/identity-policy.ts`: identity/domain evidence and source/operation workflows |
| `/stateful-resources` | `server/stateful-resources.ts`: lifecycle inventory, reviews and operations |
| `/websockets/defaults` | Starting endpoint URLs; not a proxy for WebSocket traffic |
| `/commands/:name` | Fixed allowlisted commands with bounded output and runtime |
| `/agent-lab` | `/status` checks native CLI login; `/models?provider=codex\|claude` discovers the CLI's model choices without inference; `/chat` answers a bounded conversation with optional validated model selection, fixed product context and cancellation on disconnect. See [local coding agents](../../framework-studio/local-agent-lab.md) |
| `/agent-tasks` | Durable Coding list/submission; `/:id/events?after=<seq>` replay; proposal, cancel/resume, permission, reject, digest-bound contract continue/approve/refresh/activate and terminal cleanup; `/recovery` inspection and explicit typed restore/keep; `/runtime-upgrade` inspected host status and explicit UUID-bound host restart |

Unknown API routes return JSON 404. There are no `/edits/undo` or `/edits/redo` routes.
The generic mutation protocol version is checked separately from authentication; a stale
frontend receives a restart/reload error instead of issuing incompatible mutations.

## Trust and failure behavior

The server binds `127.0.0.1`, accepts only exact loopback Host/port values, and requires a
per-process token on every API request. SSE uses the token in its query; other calls use
`x-studio-token`. Non-GET requests also require the exact origin and current
`x-studio-protocol`. Responses are no-store; Vite filesystem serving is restricted.

Runner IPC uses private Unix sockets on macOS/Linux and authenticated encrypted named
pipes on Windows. Windows keys and replay records live under a current-user-only DACL;
request replay protection survives runner restarts. Protocol checks and the same
checkout/state binding apply to both transports, with no TCP listener. Its allowlisted
deployment adapter retains CLI review checks and private credential handling. Child npm
commands select their target through explicit arguments and working directory; inherited
workspace batch and optional-script flags cannot widen or silently skip their execution. Process
identity includes user and start-time evidence; an uncertain or unreadable execution
record is preserved rather than automatically reclaimed. Windows identity binds a process
to its owner SID and creation time; POSIX identity retains its UID and start time. The
runner is separate from application Compose and its stop/cleanup lifecycle.
Owned Windows command trees use the shared [native Job Object supervisor](../../../packages/aws-studio/cli/windows-job.ps1);
assignment happens before the command resumes, and closing the job kills its descendants.

Evaluator children receive synthetic mode inputs and condition outcomes rather than
authored environment-file values. The original trusted-source evaluator retains host
filesystem/environment access. Before an agent import, the source gate durably requires
the restricted evaluator for subsequent publication, including after restart. That
evaluator reads source under the native policy with a restricted environment, writable
scratch and bounded verified output artifacts. It does not use the private-condition
broker; unresolved condition lanes remain unknown, and dependent inspector preflight
fails closed. Missing native capability does not fall back to trusted evaluation.
Public `input.value` values and
declared defaults are ordinary source metadata and may appear in snapshots. Private
environment values are handled by the dedicated service, not the graph or source journal.

GraphQL's ordinary workspace read parses only the fixed generated SDL and a bounded
`client-app/src/api/**/*.ts` inventory, plus generated document-map/typed-string evidence.
It never imports application code or scans installed dependencies/the whole checkout.
Relevant path/inode/size/change metadata keys its cache; bounded regular-file reads reject
links and changed bytes. SDL types, fields, arguments, defaults and descriptions come from
GraphQL's parser; authored helper literals and actual exported TanStack options come from
TypeScript's AST. Known fragments resolve transitively. Dynamic or ambiguous forms carry
diagnostics instead of invented lineage. Field locations identify generated SDL, not
Prisma or Pothos origin. Key-factory expressions are authored source, not computed keys.

The fixed inspection child reports allowlisted phases on its private IPC: startup,
source/dependency identity, independent checks, portable proof hashing, final identity
checks and publication. The service accepts a phase only for its active request and
uses its own timestamps for elapsed/phase time. These messages establish no proof and
clear at terminal results, owner cancellation and child replacement. The GraphQL detail
status and Coding preparation show the same server message without guessed percentages.
The [Studio launcher](../../../client-app/launch.mjs) selects the host Node/npm pair.
Project admission selects the app's pair independently. The inspection child uses the
project Node executable and checks the runtime before walking dependencies. Source and
dependency capture failures carry separate bounded diagnostics.

Normal chain reads use memory and bounded durable evidence only, including cold startup,
focus and stale evidence. They never start deep work. Only explicit **Check again** or
`?check=fresh` starts work in the fixed persistent inspection child at normal priority. GET polling
observes it while checking. Captured source, hashing, source watching and native preparation
stay outside the HTTP event loop. Restored evidence is historical and cannot be
acknowledged until an explicit check succeeds. The source read lease covers only the short
public-source copy, rather than hashing or native execution; input identities are rechecked
afterward. Apply waits for fresh inspection before taking write ownership, then performs
cache-only identity revalidation under the write lease.

Dependency identity ignores only the conventional `node_modules/.cache`, `.vite` and
`.vite-temp` tool outputs. Cache creation and removal do not force a byte rehash; real
package file changes, additions, removals and replacements still invalidate evidence.

Restricted GraphQL schema evaluation uses the same verified native execution policy through
the model-free validation runner, including after restricted source evaluation becomes
durable. A fresh private copy contains public saved source and the explicitly captured
emitted database contract and declaration types required by schema imports. Workspace dependency links resolve
into that copy; other installed dependencies have narrow, canonical `node_modules`
read grants, using the same linker as declaration evaluation. Source and dependencies are
read-only and only scratch is writable. Dependency content hashes are reused only while
installed file/link inode and nanosecond metadata, directory identity/permissions and
meaningful entries still match. Exact `node_modules/.cache`, `.vite` and `.vite-temp`
tool outputs are omitted consistently; their parent-directory timestamps do not force
package bytes to be read again.
Metadata and full hashing share the same installed-root inventory, including dependency-only
directories. Changes during capture refuse evidence; changed metadata hashes the bytes
again. The fixed pinned worker
imports application schema/configuration inside that sandbox, validates documents and
runs Codegen in check mode. It also compares compiled Prisma semantics with emitted output,
executes registered backend and client behavior tests, checks API/consumer types without
emitting, and validates the generated persisted manifest after Codegen. Required suites
must exist and execute every selected case; missing, skipped, todo, cancelled or partial
required-suite evidence never establishes proof. The required backend suites are each
feature schema's neighboring test, the schema-wide `schema-files.test.ts`, and the offline
`packages/database/test/*.test.ts` suites. The database package's opt-in `*-live.test.ts`
suites run separately against their required runtime. Applications with Access Graph directives, an access
policy module, or a table-access API integration also require `authorization.test.ts`,
`client-access.test.ts`, and the `client-database.ts` / `table-access.ts` type fixtures.
Removing those suites from an opted-in application fails verification. The boilerplate's
existing API checks remain valid without adopting an access integration
([verification.ts](../../../packages/aws-studio/scripts/contract-chain/verification.ts)).
The fixed worker overlaps database and schema inspection, then runs backend and client
verification in two bounded lanes. A sequential run retains its intermediate checkpoints
and builds an architecture preview when a candidate pauses for review or reaches Apply.
Tests use pinned scratch runners/configuration, read-only captured source and installed
dependencies, and scratch-only writes; application Vite plugins and generators do not run.
On Windows, the pinned Node reporter runs as an ordinary startup entry so the native
filesystem preload executes before reporter resolution. Client Vitest keeps isolated
forks; its fixed adapter moves only the installed warning-suppression preload from
`--require` to `--import`, after the native preload. Neither runner expands filesystem
permissions or treats authored stdout as test evidence.
The host accepts a bounded,
hash-checked regular result artifact. Missing capability, missing generated dependencies,
timeouts and malformed output become Unknown; there is no privileged fallback. Reads are
deduplicated and cached by captured source, dependency, runtime-contract, worker and Node
identity, then checked again before returning. The review record contributes separately to
the response revision, so changing only review evidence does not reevaluate application code.
Check again reruns the worker while retaining a dependency content digest only when its
complete inode metadata still matches. Review and apply recheck those same input identities.
Evaluation also compares physical metadata before and after execution for saved/private
source, emitted artifacts, pinned worker assets and installed dependencies. Changing and
restoring bytes or their visible modification times cannot renew evidence. These
machine-specific execution guards never enter portable receipt identities. Common installed
dependency source, including transitive code, is additionally content-bound in the portable
toolchain identity; same-version implementation edits require review renewal. Lock-declared
platform packages and native artifacts remain lock/version-bound with local byte/metadata
guards rather than cross-machine byte equality. Receipts do not authenticate installations.
Portable dependency results may be reused across private copies only through a bounded
in-memory mapping from a currently metadata-guarded raw content digest, the captured lock
object and the fixed normalization profile. Required-package preflight and a closing
metadata check still run. The metadata inventory counts empty directories to preserve the
portable entry limit; a larger conservative count falls back to the exact portable walk.
A missing raw cache never triggers extra raw hashing just to enable this reuse. Initial
portable capture still hashes common package bytes. Cancellation drains opened descriptor
batches and cannot publish a portable cache result; no cache record is task input or
durable proof. This optimization preserves the portable digest format and review rules.
Active metadata scans yield to the host event loop every 32 entries, including cache
hits and closing observations. The owning cancellation signal covers origin checks,
candidate validation and inspector baseline capture; disposal cancels and drains that
capture. Startup control snapshots retain their original loaded-module identity.
Candidate-stage validation, origin admission and context refresh share one immutable
dependency observation among their nested checks. Origin, refresh and saved-source
finalization always read installed bytes afresh once, including on a warm root. Portable
reuse must also match that raw commitment. Finalization compares it with the candidate's
verified installation before reconciling artifacts or preparing a review. Fresh physical
inventories bracket each operation; cold raw content is checked before it can be borrowed.
Origin admission compares the captured source and review revision before launching any
executable check. A matching revision still requires independent context and predecessor
validation and the closing source and dependency guards.
Results and new raw/portable cache facts remain
provisional until the closing inventory succeeds. Mutation, cancellation or a failed
operation discards them, including API receipts carried by document-repair errors.
Concurrent callers and other roots retain independent boundaries; late asynchronous work
cannot borrow a closed observation. This scope never spans a model turn. The saved-source
review writer runs only after the observation closes and retains its revision/source gate;
service admission and continuation keep their independent guards.
The contract watcher observes authored inputs and installed dependency metadata. Windows
uses a bounded native file notification bridge; overflow, watcher loss or unknown changes
fail closed. The bridge excludes access-only events; a genuine write notification still
invalidates when inode, size and nanosecond timestamps collide. Dependency notifications
advance a local observation generation and evict installed byte reuse without hashing
packages in the callback; they also reject in-flight scoped evidence and retained leases.
Source-only notifications preserve dependency reuse. A source-only observation may retain already verified upstream stages when
their exact inputs, outputs, policy, review record and dependency identity remain unchanged.
The shared non-executing document plucker distinguishes document changes from cache-only
client edits. This in-memory reuse never creates receipts or enables review actions;
changed stages require the full independent check and explicit approval flow.

The standalone `contract:check` command is the framework's verifier
([cli.ts](../../../packages/aws-studio/scripts/contract-chain/cli.ts)); Studio's chain CLI delegates
`verify`, `record` and `init` to it and keeps `status`, `--check` and `accept`. It executes the
same fixed worker through an explicit trusted-checkout runner in a clean checkout, without Studio, Coding or a Codex installation.
It uses a private source capture, credential-free environment, bounded owned processes and
scratch writes. This is repository test execution, not an OS isolation claim; Studio and
Coding retain the native restricted runner and never fall back to it. The normal root
`npm run verify` ends with this mandatory gate and the supported-platform CI matrix runs it.
The framework has no default runner: Studio injects its sandbox
([sandbox.ts](../../../client-app/server/graphql-chain/sandbox.ts)) and the gate its owned
worker. Receipts bind the proof policy, which is the verifier's runtime closure
(`CONTRACT_PROOF_POLICY_FILES`, enforced by `packages/aws-studio/test/contract-verification-boundary.test.ts`).
`npm run pack` includes the verifier's policy files in the full release, including the
POSIX tether and Windows job supervisor. The installed `aws-studio verify` command
hashes the same package-relative policy files as the workspace command. It captures
inputs, dependencies and saved receipts from the selected application.
Studio's own contract code (Coding stages, agent host and release, sandbox, review) is not in
that policy; its integrity is Studio's contract-control identity
([contract-control.ts](../../../client-app/server/agent-runtime/contract-control.ts)): the
source host refuses contract work after it changes, each pinned host release records it, and
the client admits a pinned host for contract runs only when policy and control both match.
The host release records separate digests for Studio's installed control dependencies and
the selected application's installed dependencies.
The gate recomputes identities, executes independent checks, checks accepted predecessor
lineage and refuses missing, stale or insufficient review evidence. It never approves
application decisions or writes the review record. Status JSON remains informational;
`--check` and `verify` return 0 only for complete current accepted proof, 1 for pending or
known failed evidence and 2 for unavailable evidence, including hidden unavailable
prerequisites. Node 24.22.2 and npm 11 are the repository pin; the exact supported Node
patch and package/lockfile versions are bound into evidence.

Receipt policy includes the fixed checker, source-capture, restricted execution, reuse and
acceptance guards. The inspector seals this policy at construction and rejects edited
policy sources with `CHECKER_POLICY_RESTART_REQUIRED`; old loaded code cannot claim a newly
edited policy. It also seals installed dependency metadata; a changed loaded dependency
requires a fresh checker rather than relabelling Node's cached modules. Native releases
pin the portable control dependency digest beside policy and reject mismatched candidates.
An explicit host restart/reload activates changed code. Normal checks never
restart the developer's running Studio session. Adding a required suite or typecheck root
edits `verification.ts`, a policy source, so restart an already running Studio host before
renewing proof.

Explorer runtime reads observe the checkout's local-runtime verdict and fixed configured
root `.env` API port without starting anything. Execution accepts document text, variables,
an optional operation name and a transient Cognito ID token. Only the fixed loopback
GraphQL path receives that token; the request cannot supply a host, port or URL. The relay
does not decode claims or persist/forward credentials to Sightline. A selected mutation
requires explicit confirmation. Requests have a 35-second deadline and a 2 MiB response
bound. Readiness failures, validation/refusal and endpoint responses remain distinct.

The inspector's temporary source capture withholds only `graphql-chain.review.json`, so
review-record changes cannot influence cached application-schema evaluation. The live file
and captured baseline identity are preserved; source importing that record is unsupported.
Coding task workspaces retain the record as source context. Guided contract tasks reject
changes to it: candidate validation and source application cannot accept saved-source
reviews. A guided stage or sequential action authorizes guarded integration of its exact
passing proposal within the requested scope and established decisions. Editable Coding
requests retain explicit proposal approval. `agent-runtime/contract-finalization.ts` follows
a guided run with fresh saved-source checks and `GraphQLChainReviews.reviewStages`. This writer
approves only completed stages in dependency order, binds established decisions, and records
the hash ledger and review receipts together under the same exact-revision write gate as
manual review. No-change runs also finalize. Sequential checkpoints can reuse passing native
checks within the same private candidate after rechecking its source, artifacts and dependency
identity. Saved-source finalization independently checks the checkout.
When the selected stage's recorded hashes still match, guided actions can first check and
renew saved source directly using prior recorded behavior decisions. This path needs no
private Coding task or provider session. Changed contract behavior goes through remediation
and the normal decision checks.
The fixed ignored database outputs are copied from the independently checked candidate;
database regeneration includes Access Graph and client access outputs. Failed finalization
is retained in `contract.approval` and cannot report approval.

The GraphQL review writer is separate from generic configuration editing. Its only target
is the repository root's `graphql-chain.review.json`; request-supplied paths and contents
are refused. A review selects the initial baseline, one current/removed Prisma model,
repository/API implementation, or the whole client surface and returns the exact
before/after record. The in-memory plan
expires after 15 minutes. Apply checks the revision, current evidence, exact before bytes
and fixed real path again under the shared source write gate, then uses `writeSourceChange`
and records `ownWrites`. Linked, hard-linked, malformed or stale records are refused.
Model acceptance requires current emitted database artifacts and backend checks. API
acceptance additionally requires all model reviews current; client acceptance requires
verified API/Codegen confidence and passing client/consumer/integration checks. Version 2
bindings remain readable, while version 3 adds content-addressed, predecessor-bound receipts
for database, API, Codegen and client stages. A receipt contains normalized stage inputs,
implementation/output identities, predecessor IDs, policy and exact toolchain versions,
required check outcomes, explicit API/client decisions and scope/limitations. Canonical
content excludes timestamps, machine paths and filesystem metadata. Its hash is integrity,
not cryptographic authenticity, a signature or authenticated reviewer identity. Current
trust is freshly derived from independent checks and matching source/decisions; persisted
passing outcomes never substitute for those checks. Candidate receipts retain candidate
scope and cannot become saved-source receipts after Apply; the host recomputes saved receipts
from independent saved-source inspection and established run intent. Codegen also requires
its recorded receipt to match, so unchanged output cannot bypass an invalidated predecessor.
The API binding includes compiled Prisma storage/execution semantics, so private-field,
mapping and index changes invalidate downstream confidence even with identical public SDL.
Valid version 1/2 records remain readable and upgrade only on explicit acceptance; absent
bindings or receipts cannot establish complete verification. Failed or unavailable validation cannot be
acknowledged away. Historical observations are labeled and cannot authorize writes.
Invalid client documents cannot be acknowledged. The CLI uses the same record update and
write authority; its explicit `init` creates only an unreviewed version 3 record. API/client
review requires a `--decision`/`--evidence` declaration or a bounded `--decisions-file` JSON
input. Baseline review requires separate API/client declarations in that file and is only
available for a truly unreviewed record. Reads never create
or stamp one. The chain response/cache and browser compatibility guard prevent older
independent-green payloads from establishing confidence. Restart Studio and reload the
browser to activate a changed server; inspection does not restart a running instance.

The optional bounded `.cache/framework-studio/graphql-chain/ci-report.json` records only a
historical checkout/CI claim, outcome and inspectable receipt/check IDs. Its execution
platform is observational metadata outside canonical receipt identity. Imported authority
labels are unsigned and unauthenticated; comparison can report agreement only with already
independently verified current local receipts. Missing, malformed, altered or passing report
bytes never enable primary confidence or acceptance. Declared offline validation does not
establish live database behavior, deployed compatibility or rendered application UX.

Failure classes remain distinct: stale source refuses review/apply; invalid declaration
syntax keeps a labeled previous graph; synthesis failure retains labeled last-good
inventory; interrupted writes expose recovery; failed or unknown operations require
their service's reconciliation. Never convert any of these states into a green runtime
health assertion. See [deployment safety](../deployment/planning-and-safety.md) for
target verification, approvals and cloud operation recovery.

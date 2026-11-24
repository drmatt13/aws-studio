---
id: studio.snapshots
summary: Loopback server, mode-isolated evaluation, revisioned snapshots, watching, and browser synchronization.
read_when:
  - Debugging server startup, stale models, or snapshot refresh
source:
  - client-app/server/index.ts
  - client-app/server/server.ts
  - client-app/server/commands.ts
  - client-app/server/snapshot.ts
  - packages/aws-studio/cli/atomic-replace.cjs
  - client-app/server/evaluator/pool.ts
  - client-app/server/evaluator/evaluate.ts
  - client-app/server/evaluator/inspection-process.ts
  - client-app/server/evaluator/protocol.ts
  - client-app/server/project-runtime.ts
  - client-app/server/watch.ts
  - client-app/src/http.ts
  - client-app/src/snapshot.ts
  - client-app/src/events.ts
  - client-app/src/deploy/live.ts
  - client-app/src/deploy/observations.tsx
  - client-app/src/deploy/queries.ts
  - client-app/src/connection-generations.ts
  - client-app/server/deploy/observe.ts
  - client-app/src/database-session.ts
  - client-app/server/database-history.ts
related:
  - studio.source-indexing
  - studio.graph-model
  - studio.editing
---
# Source to snapshot to browser

`main` in [server/index.ts](../../../client-app/server/index.ts) discovers the checkout, admits its framework release and resolves its Node/npm before it prints a snapshot (`--print`) or calls `startServer`. [server.ts](../../../client-app/server/server.ts) binds loopback (default port 4590), builds services and watches source. Installed Studio serves its compiled frontend. The source checkout uses Vite.

Open and Refresh observe existing CDK inputs. To initialize a missing file, choose
**Create** for its mode in the CDK Environment inspector. Studio records an explicit
setup failure for that mode and presents a retry. Open preserves app source, private
inputs, receipts, the framework pin and dependencies. It can create or update
`.cache/framework-studio/source-gate/coordination.sqlite` and its SQLite sidecars
for coordination, and `.cache/framework-studio/cdk-links.json` for the published
graph. Development Studio can also create Vite data in
`.cache/framework-studio/vite/<port>`. Operation status readers continue to use
their existing state directories. The synthetic evaluator inputs live in a
disposable host temp directory.

The listener claims its port before acquiring Vite, source watchers or evaluator
processes. It returns 503 while initialization is pending. Port conflicts therefore
exit before creating those resources. Signal supervision is installed before
startup and remains registered while asynchronous cleanup runs. Partial startup
failures release every registered resource and the listener. Shutdown closes
incoming connections, stops watching and closes the builder's explicit
`EvaluatorLifetime`: snapshot, batch-review, route-review and resource-review
pools all belong to that owner, and live evaluators are released from its registry
on exit. Terminal builder disposal refuses new or already queued refreshes. Cleanup
joins startup and tracked refreshes, then drains any late acquisition; interrupted
startup never reports readiness. Local compute/storage started separately through Deploy & Run keeps
its existing ownership rules; closing Studio does not delete persistent volumes.
Evaluator disposal first disconnects IPC and sends SIGTERM, then escalates after
one second to SIGKILL against only that owned child if it has not exited. This also
bounds cleanup when authored code installs a signal handler and blocks its event
loop. The escalation timer is cleared on exit, and repeated disposal shares the
same completion.
The fixed generator/check commands in [commands.ts](../../../client-app/server/commands.ts)
also belong to this lifetime. Shutdown stops their supervised process tree and
waits for the active command to settle before exiting; a closed runner refuses
new commands and never advances to a later step. The existing tether also stops
those children if Studio is killed outright. Commands still use fixed argv without
a shell, and generation still requires explicit confirmation.

[guards.ts](../../../client-app/server/guards.ts) checks exact local Host/port, a random session token, same-origin POSTs and no-store caching; SSE carries the token in its query. Vite filesystem access is restricted. This is a trusted local tool executing repository code, not a remotely hosted multi-user service or hostile-code sandbox.

`SnapshotBuilder.refresh` in [snapshot.ts](../../../client-app/server/snapshot.ts) serializes/coalesces refreshes.

Before evaluation, it releases an abandoned read reservation only when the recorded
owner is confirmed stopped and no import marker, transaction or integration recovery
record remains pending. The SQLite record and publication epoch are preserved. Live
or unverifiable readers, abandoned writers/recovery owners and pending recovery records
retain their existing coordination requirements; no command is replayed.

An idle checkout can be renamed without resetting its source coordination database.
The gate records the checkout directory's native filesystem identity and, on reopening
at a different path, adopts that path only for the same directory with no lease or
pending transaction/import recovery. Older records without a directory identity can
be upgraded when their former location no longer exists and source is idle. Copied
modern coordination databases and existing different checkouts are rejected. The
publication epoch, restricted-evaluation policy and recovery bytes remain intact;
completed source and integration journals retain their original paths and are readable
through the gate's recorded prior locations. Restart Studio after renaming its folder.

The refresh then:

1. Hash editable files.
2. `EvaluatorPool` starts separate Dev and Prod workers using the app's selected Node. Before request handling they report the executable, version, protocol and capabilities. Synthetic inputs select mode. Ordinary inspection denies filesystem writes, subprocesses, native addons and worker threads through Node permissions. It assumes trusted project sources and the developer's local read access. Native restricted evaluation uses the selected project Node with a read-only public capture, excludes private inputs and keeps its network restrictions. An unavailable native sandbox fails closed.
3. `projectModel` normalizes/validates declarations into each `ModeModel`. A fresh availability resolver supplies canonical lane predicates for that projection. `withLambdaSpecs` in [lambda-spec.ts](../../../client-app/server/model/lambda-spec.ts) temporarily seeds build settings from one fresh batch; `finally` restores or removes that scope. Later projections re-read mutated settings. The ordinary evaluator treats loaded configuration as immutable (`applyPatch` copies).
4. [Source indexing](source-indexing.md) supplies locations, capabilities and CDK evidence. Workers return deployment and sign-in declarations as metadata. For ordinary evaluation, Studio resolves deployment condition outcomes against the private mode files and returns holds, fails or unset to the worker. Restricted evaluation carries an explicit warning when it lacks private outcomes. Prisma contract parsing, Compose metadata, client mappings and descriptions augment the snapshot in Studio.
5. Increment generation and combine it with a content hash for `revision`; atomically cache disposable CDK-link evidence under `.cache/framework-studio`. A refresh whose snapshot matches the published one in everything but its timing keeps that snapshot and revision.

Each mode also carries `interfaceEndpointServices`, copied from the framework's generated
CDK endpoint catalog by `projectModel`. The browser uses this list for the VPC service
picker without importing CDK or maintaining its own supported-service list. It describes
framework support, not live regional availability.

`lastGood` retains a previous nonempty graph after a new load failure, marks it stale/error and carries new diagnostics. It is display continuity, not permission to edit old source. Models are rebuilt, not incrementally patched node by node.

A load failure records where it was written when the error reveals it: `failureLocation` reads the transformer's position, the first application file in a missing module's require stack, or the first application frame of a throw, skipping `node_modules` and framework or Studio code. `Diagnostic.location` is absent rather than guessed otherwise.

A Deploy & Run operation reserves the source whether or not it changes it, and a write
reservation rolls the publication epoch, so every operation ends with a refresh. Two
readings of that state exist. `SnapshotBuilder.current` is the edit authority: while an
operation holds the source or a refresh is due, it marks both models stale, and every edit
path refuses them. `SnapshotBuilder.presented` is what `GET /snapshot` and value reads
serve: in those same two states it is the last published snapshot, unchanged. Only
`recovery_required` and `unavailable` present as failures. The browser reads
`sourcePublication`, and `StudioProvider` folds a hold into `live.evaluating`, so controls
pause through the same quiet path a refresh uses. Keeping the revision on an unchanged
republish is what stops an operation reading as a source change: a dirty draft stays out of
conflict, and an open review stays open because the deployment scope does not change.

If indexing or writing the disposable CDK-link projection fails after a successful
snapshot, `SnapshotBuilder` publishes a new revision retaining the previous source
and graphs as stale/error. It disposes the failed generation's evaluators and
provides a failed preflight with a safe error code and contained file path. Old
graphs cannot authorize edits after their evaluator processes have been replaced.
Resolve the filesystem/index failure and refresh to recover. An initial failure
without a previous snapshot rejects. The HTTP endpoint then returns a terminal 500
with a terminal/repair/restart remedy rather than the pending-evaluation 503; the
browser leaves its loading state. Arbitrary exception values remain in server output,
not this infrastructure error response. Atomic projection replacement retries
only transient Windows sharing errors; a permanent failure remains visible.

An unexpected rejected refresh also expires source reviews and broadcasts a snapshot
invalidation. `GET /snapshot` returns a sanitized 500 with a terminal/repair/restart
remedy even after an earlier successful graph; an old snapshot cannot hide the failure.
The browser retains its mounted editor and drafts while showing the failure and retry.
A later successful refresh clears the HTTP failure state. Recovery records remain intact.

[watchRepository](../../../client-app/server/watch.ts) watches configuration, framework config implementation, CDK sources, Prisma contract, Compose and mode input/template files using directory watches and a debounce. Workload implementation roots (Lambda handlers, container contexts and agents) are also watched, excluding dependencies/build output. Source changes expire reviews and publish revision/status events. Native watch errors expose a persistent source-health notice and activate the same five-second content comparison used to detect missed events and newly created directories. Failed watches retry; recovery clears the notice. The notice includes paths/error codes and a read-only **Reload source** action. Environment contents never enter health events. A reconnect re-fetches the snapshot while preserving dirty drafts.

[main.tsx](../../../client-app/src/main.tsx) declares seven core workspaces and the
compatible redirects listed in the
[interface guide](interface.md). [StudioProvider](../../../client-app/src/studio.tsx) owns shared
selection/mode/draft context; [snapshot.ts](../../../client-app/src/snapshot.ts)
owns the snapshot query and server-event invalidation. The typed endpoint catalog is
separate in `api.ts`; [http.ts](../../../client-app/src/http.ts) owns protocol,
token, no-store, cancellation and response-error mechanics.

Snapshot, operation and deployment observers share one reference-counted EventSource
per tab through `src/events.ts`. `GlobalDeploymentObservations` mounts once and owns
deployment cache subscriptions through `deploy/live.ts`; Deploy's separate page hook
handles only page callbacks. Route changes do not add deployment pollers or duplicate
cache listeners. Each subscriber cleans up only its own listeners, leaving HTTP/1 connections
available for reads and approvals with several tabs open. Six or more simultaneous
tab streams can still reach the browser's per-origin connection limit. Unknown API
routes return JSON 404; an older server's HTML fallback is rejected as an invalid API
response instead of appearing as empty successful data. Dirty drafts keep their
baseline visible and record a newer snapshot as a conflict rather than silently
rebasing; see [editing](editing.md).

The global deployment observer loads repository overview/profile metadata independently
of the current route. It uses the latest published source identity, then resolves one
matching named target for each configured declaration mode. Overview is fresh for 60
seconds and has no polling interval. Status/discovery is fresh for 20 seconds, polls
every 120 seconds for the active mode and 300 seconds for the other, and accelerates to
four seconds for matching running jobs/in-progress stacks. Failures cool down for 300
seconds. The inactive mode warms after the active read settles or five seconds, with two
concurrent deployment reads at most. Hidden tabs pause polling/warming and reconcile on
return. The existing status result supplies discovery without an extra equivalent read.
See [AWS connections](../../framework-studio/aws-connections.md#shared-deployment-observations)
for the full cache and scheduling contract.

`snapshot.ts` advances profile-scoped connection generations on `aws-connections`; a
global scope advances every profile. Existing broad connection revisions still expire
workspace-specific reviews. Identity checks and deployment reads include their captured
generation in their cache keys, so late responses cannot become current evidence for a
new actor/configuration. The first `hello` retains startup reads; subsequent `hello`
events advance all connection generations and reconcile metadata to recover missed
changes. Source publication refreshes target metadata and source-dependent observations.
Destination-matched deployment invalidation during an in-flight read schedules one
trailing refresh. Typed observation errors preserve labeled same-context stale evidence
without turning an unavailable AWS read into an absent deployment or blocking the map.

An initial snapshot failure offers a connection retry. A failed background fetch with a
cached snapshot keeps `StudioProvider` mounted, preserving selection and unsaved drafts;
a persistent Shell notice offers retry. Successful retry removes the notice without
recreating the editor. This is separate from server-side stale-model diagnostics, which
continue to govern source editability.

During frontend hot replacement, the entry retains its React root, query cache and router
through Vite's per-module HMR data. Its exported root component remains a React Refresh
boundary, and replacement updates the retained router's route tree without remounting
the application or discarding its inspector draft. Removing the entry releases the root,
cache and browser history; ordinary replacement does not unmount them.

Disposable source previews travel through evaluator IPC. [evaluate.ts](../../../client-app/server/evaluator/evaluate.ts) resolves proposed new TypeScript modules and replaces compilation from an override map without writing preview files. Evaluation still runs authored config; it does not synthesize CDK or run handlers.

Database editing is an independent exact-text session in
[database-session.ts](../../../client-app/src/database-session.ts). A framework
generation does not replace dirty Prisma text. The baseline uses the authored file's hash;
validation responses also carry that draft's source hash and request generation. Invalid
drafts retain a labeled last-valid diagram, while semantic errors stay distinct from
unsupported diagram projections. Compilation caches source plus an opaque per-server
config identity that covers imported local modules, relevant manifests and private inputs,
and validates through installed Prisma without publishing generated files. Config changes
invalidate same-text validation and diagrams; framework generations also expire/reload
history comparisons, preserving dirty source.

`DatabaseWorkbench.emitted` is a separate metadata-only observation of the generated JSON
named by the actual Prisma config. The configured serializer and canonical storage/execution
hashes verify its integrity on loading before saved-source comparison. Only status, safe
file label, content revision, semantic hashes and time reach the browser; raw generated
contracts and private config inputs do not. Missing/invalid/outside-checkout output stays
explicitly unknown or unavailable. No file is emitted, and matching JSON does not prove
generated TypeScript or downstream application consumers are current.

Migration/config changes are watched independently and notify database views. History in
[database-history.ts](../../../client-app/server/database-history.ts) hashes all
migration/snapshot/ref bytes, Prisma config and relevant manifests/lockfile, and refuses a
graph that changes during discovery. Comparisons and offline planning recheck source and
history before returning. Artifact reviews are in memory and expire; generated artifacts
from a disposable plan are installed only after explicit review and unchanged-input checks.
Observations include target connection-identity hashes, saved-source/history revisions,
baseline and freshness. Changing any relevant identity expires old evidence; a marker
match never substitutes for physical-schema verification. See the
[Database workbench guide](../../framework-studio/database-workbench.md).

Validate with [model](../../../client-app/test/model.test.ts), [guards](../../../client-app/test/guards.test.ts), [draft](../../../client-app/test/draft.test.ts), [startup/recovery UI](../../../client-app/test/startup-ui.test.ts), [snapshot I/O recovery](../../../client-app/test/snapshot-recovery.test.ts), [creation](../../../client-app/test/creation.test.ts) and [watch failure/recovery](../../../client-app/test/watch.test.ts) tests. Browser reconnect/render behavior needs browser verification beyond snapshot tests.

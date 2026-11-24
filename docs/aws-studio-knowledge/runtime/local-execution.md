---
id: runtime.local-execution
summary: HTTP/WebSocket ingress, Node workers, containers, tasks, workflows, and agent processes.
read_when:
  - Running or debugging workloads locally
  - Changing runner transports, process lifecycle, or Docker paths
source:
  - packages/aws-studio/local/api/src/index.ts
  - packages/aws-studio/local/websocket/src/index.ts
  - packages/aws-studio/src/local/index.ts
  - packages/aws-studio/src/local/lambda-process.ts
  - packages/aws-studio/local/invocation/src/index.ts
  - packages/aws-studio/local/invocation/src/tasks.ts
  - client-app/server/deploy/local.ts
  - client-app/server/deploy/database-readiness.ts
  - client-app/server/deploy/registry.ts
  - packages/aws-studio/cli/dev.mjs
  - packages/aws-studio/cli/local-startup-diagnostics.mjs
  - packages/aws-studio/cli/compose-project-ownership.mjs
  - packages/aws-studio/cli/database/prepare-local-database.ts
  - packages/aws-studio/database/studio-migrations.ts
  - packages/aws-studio/database/empty-database.ts
  - packages/aws-studio/dev/Dockerfile
  - packages/aws-studio/cli/run-cloud-task.ts
  - packages/aws-studio/dev/compose.yml
  - packages/aws-studio/cli/docker-desktop-start.mjs
  - client-app/src/deploy/local-runtime.ts
  - client-app/server/deploy/service.ts
  - client-app/shared/local-lifecycle.ts
  - client-app/src/deploy/local-runtime-state.ts
  - client-app/src/views/map/ComposePreview.tsx
related:
  - runtime.environment
  - framework.workflows
  - framework.agents-tools
---
# Local execution paths

[Development](../../DEV-DEPLOYMENT.md) owns setup/reload commands. Local execution consumes normalized declarations; do not add application route/import tables to generic servers.

All implementations resolve from repository-relative `compute/...` declarations through
the shared Node source resolver, including agents. Compose Watch, package workspaces,
image build contexts and Node child processes use those same paths. Root discovery uses
`framework.config.ts` and root `package.json`; it does not require a handler tree.

[Private DNS qualification](../../framework-studio/private-dns-parity.md) separates
the authoring/CDK feature from its isolated Docker experiment. Local private DNS
execution remains unsupported: framework-mediated Lambda invocation, task submission
and service endpoint resolution refuse workloads whose VPC has an enabled private
zone. Independently running Compose services are not stopped or network-isolated.
With no enabled zone, the existing paths below retain their current networking.
Actual AWS and platform qualification remain gates for a scoped DNS runtime.

[Development resource logs](../../framework-studio/development-logs.md) owns the
versioned observation contract, runner collector, dedicated private cache mount,
bootstrap spool, retention and privacy. Capture follows runtime ownership, not Studio's
Source selector. Cached evidence survives restarts without recovering executions.

| Workload | Call path / lifecycle |
| --- | --- |
| HTTP Lambda | [API server](../../../packages/aws-studio/local/api/src/index.ts) maps literal route/method and verifies declared Cognito auth → `LocalLambdaExecutor` in [local/index.ts](../../../packages/aws-studio/src/local/index.ts) → Node child or container runner |
| Service | Same API server → Compose DNS service URL, with mount prefix removed; generated Compose owns declared local service registration |
| WebSocket | [WS server](../../../packages/aws-studio/local/websocket/src/index.ts) runs declared connect/message/disconnect handlers, retains authorizer context, and supplies connection push transport |
| Node zip Lambda | `invokeLocalNodeLambda` in [lambda-process.ts](../../../packages/aws-studio/src/local/lambda-process.ts) resolves environment before loading handler, creates Lambda context, enforces timeout, returns result/error over IPC |
| Warm Node worker | `LambdaWorkerPool` caches processes by handler/source/environment fingerprint, serializes reuse and evicts idle workers; configured limits differ from cloud concurrency. Tools opt for cold execution |
| Container Lambda | [runner/index.ts](../../../packages/aws-studio/local/invocation/src/index.ts) builds architecture-pinned image, launches Runtime Interface Emulator container and invokes it |
| Container task | `LocalTaskSupervisor` in [tasks.ts](../../../packages/aws-studio/local/invocation/src/tasks.ts) builds/starts container, records running/terminal state, logs and stop requests; zero/nonzero exit determines outcome |
| Workflow | `LocalWorkflowEngine` delegates the [shared IR interpreter](../framework/workflows.md) to Lambda/task/integration/agent executors and callback broker |
| Agent | [LocalAgentSupervisor and Gateway emulation](../framework/agents-and-tools.md) provide session processes and contract-enforced tools |

Node zip execution supports the configured Node handler path; a Python zip declaration does not imply local Python support. Environment fingerprints prevent reuse after environment changes; source changes restart the owner through Watch. These processes are not a security sandbox. Closing an executor cancels active cold-only calls as well as warm workers; closing a pool also cancels cold overflow calls. Both become terminal and refuse new invocations. An already cancelled invocation never launches a handler. Local workloads use ordinary host and Docker networking without VPC egress guards or forced dual-stack SDK endpoints. Local success does not verify deployed VPC reachability.

Runtime `runTask` / `startWorkflow` in [invocation.ts](../../../packages/aws-studio/src/runtime/invocation.ts) consume declared descriptors and select local runner or AWS transport. Never branch in application code to choose transport. Local caller/binding checks are not cryptographic IAM. Poll terminal outcomes when testing; an accepted start is not a completed task/workflow.

`LambdaWorkerPool.close()` is awaitable: it cancels owned invocations and waits for
warm workers, retired workers and cold overflow to release their processes and output
handles. Await it before removing or replacing a worker's source directory, especially
on Windows where an exiting process can still hold that directory open.
`LocalWorkflowEngine.shutdown()` likewise awaits owned Lambda child closure after
cancelling workflows; a terminal timeout or cancellation alone does not release process
output handles or working directories.

Docker images own dependencies and generated database artifacts. The development and
database migration images copy `packages/aws-studio/database/` before they run app
database tooling. `docker-compose.yml` plus generated service projection and override conventions define Watch delivery; never mount the whole checkout over image dependencies. Preserve `postgres_data`. `LocalImageJanitor` in [images.ts](../../../packages/aws-studio/local/invocation/src/images.ts) keeps current/in-use images and removes only superseded labeled project images, unforced. Legacy images without a project label are preserved because ownership cannot be established. New runner build paths must preserve names/labels.

Studio can start Docker Desktop when its `docker desktop` plugin is available.
That launcher starts an independent application, uses the CLI's 120-second timeout,
and may finish startup after cancellation; check status before retrying. A nonzero
Desktop launcher exit does not end the operation prematurely: the following engine
probe decides whether startup succeeded, and still fails if the engine stays stopped.
Failure to launch the CLI itself remains a failure. This accommodates a Desktop/WSL
startup race without silently retrying a launch or treating a CLI exit as readiness.
Native Linux Docker Engine startup stays with the developer's service manager and
required privileges; Studio never elevates. Denied socket access is an unknown
observation with a permissions remedy, rather than evidence that Docker stopped.

Events marked `localReplay: true` still originate in AWS: `withLocalReplay` in [event-replay.ts](../../../packages/aws-studio/src/runtime/event-replay.ts) captures payloads through dev S3/SQS infrastructure; the local dispatcher polls and invokes the declared handler. Queue acknowledgments/retries and handler completion are distinct. This is not local emulation of every event source.

Local does **not** mean offline: Cognito, stack-created secret reads, workflow service SDK calls/bridges, event replay and models can reach AWS/providers. AWS profile permissions may exceed deployed roles. Default Compose startup runs `db:prepare-local` in the compatibility-named `prisma-verify` service: initialize proven empty local storage, then verify the contract. Existing signed storage is only verified; unknown populated storage, drift and pending migrations block application consumers. Migration packages, orphan cleanup and test identity setup have separate authorizations/profiles and are never compute-start dependencies. A preparation failure leaves PostgreSQL available for the Database workbench. Its result records per-file input identities (`localDatabaseInputs`, which ignores root npm `scripts`; cloud review still binds the exact `databaseInputsDigest`). [database-readiness.ts](../../../client-app/server/deploy/database-readiness.ts) compares them with the checkout on every status read and names changed files; such readiness carries `remedy: "restart"`, which Details offers as one `local-restart`. Studio reports readiness only after container health and client HTTP checks; that does not prove authenticated application correctness. Runner restart loses in-memory workflows/callbacks. [Environment delivery](environment.md) defines supplied values; [maintenance](../guides/verification-and-maintenance.md) separates offline tests from Docker/live checks.

The development map's **Local runtime** switch uses the existing guarded startup/stop
operations. A fresh AWS observation must confirm the selected development target,
account, region, profile and source compatibility before exporting or starting a new
container runtime. Explicit start and restart regenerate development exports after that preflight:
root `.env`, `.framework/local/resources.json`, and `client-app/.env.development.local`.
Export generation preserves authored values and validates the exported destination
before compute starts. Existing files cannot replace a fresh AWS completion check.
Successful export immediately refreshes deployment observations, before database and
container startup finish. Deploy presents missing or outdated exports on a stopped
checkout as normal startup preparation: **Start development** regenerates them. During
a local operation, one progress finding replaces the stopped/readiness cards; active
runtime destination conflicts and incompatible deployments remain visible.
Startup never deploys resources, applies migrations or seeds identities.
Startup clears inherited `COMPOSE_PROFILES` so maintenance profiles cannot be enabled
implicitly. A separate **Generate source projections** step completes before
**Prepare local database** uses `dev.mjs --prepare-database --skip-generation`
(`--verify-database` remains a CLI alias) to start only PostgreSQL and its storage prerequisite, then
waits for that one-shot container before building the remaining services. The shared
`LOCAL_DATABASE_PREPARATION_STEP` label binds Activity's **Review local database**
recovery action to that failed prerequisite; it opens `/database#status` without an
inspection or write. The prior `LOCAL_DATABASE_VERIFICATION_STEP` label remains recognized
in saved Activity journals. Preparation proves complete metadata emptiness and absent
marker/ledger state, captures the additive native plan, then rechecks inside Prisma's
locked writer transaction before initializing. Unknown populated databases are never
adopted, reset or signed. Bounded prerequisite logs supply fixed, sanitized remedies
for missing signatures and contract/schema mismatches. PostgreSQL and its volume stay
available for inspection and separately reviewed migration application. Readiness inventories the native resolved Compose configuration (including
generated includes and overrides), requires every default enabled service and successful
one-shot prerequisite completion, then checks watch, client and client HTTP readiness.
Missing services cannot be hidden by a healthy remaining container. Profiled maintenance
services remain outside compute readiness; native configuration values stay server-side.

Database readiness also binds the successful preparation result to its source/migration/
dependency digest and the verified PostgreSQL container start. A pull, branch switch or
database restart/recreation invalidates that proof until local runtime rebuilds/rechecks;
healthy application containers alone cannot retain **Running**. This is bounded startup
evidence, not continuous live-schema polling. Existing signed physical drift still blocks
the next preparation. Lost volumes initialize an empty current schema and cannot recover
old rows. A behind database requires a separately reviewed forward migration; an ahead or
different-branch database is never automatically downgraded or reset. Legal side branches
and cycles permit a unique destination path; competing simple paths, incomplete history
and physical drift remain local application refusals.

On a shared Docker host, each parallel checkout uses a stable, unique
app name and host ports. Studio and CLI startup resolve the Compose project directly
from `framework:app`; export generates `COMPOSE_PROJECT_NAME` from it for native
Compose commands. Shell and authored env names cannot override a named app. Container working-directory
and config-file labels must match this checkout; volume project/logical-name labels must
match the selected project. Another checkout's project is refused without cleanup or
volume removal. Stop before changing the project name; selecting a different name selects
a different local volume. Retained-cluster login and missing-database failures have fixed
diagnostics; startup never repairs roles or recreates a database inside an existing cluster.
Export freshness compares application-compute start times. Retained PostgreSQL and pgAdmin
containers may predate a new export without blocking fresh compute or reconnection;
native Compose reconciliation and database readiness still check their configuration and health.

The existing per-checkout operations host owns the local runtime's managed watcher,
web client and container logs independently of individual Studio servers or browser tabs.
Its local-runtime capability is versioned separately from operation journals. Studio
refreshes an older idle host before reading runtime state or admitting a runtime action,
so newly loaded UI cannot consume stale lifecycle or start/reconnect semantics. The
handoff verifies the host's process identity and refuses active or uncertain operations;
support processes close gracefully and reconnect under the replacement host. Containers,
database volumes and journals are preserved. A missing lifecycle verdict keeps startup
disabled and displays **Checking…**, never **Stopped**.
`GET /api/deploy/local` observes this checkout's Compose project, managed watch/client,
exported destination and captured run binding; it performs no AWS reads. Existing containers
are verified through project, canonical working-directory and Compose config-file labels.

**One verdict.** The host derives `lifecycle` once (`deriveRuntimeLifecycle` in
[local-lifecycle.ts](../../../client-app/shared/local-lifecycle.ts)) and reports the
operation it is performing as `operation`, so every tab, window and page load reads the same
answer. A browser remembers nothing authoritative; it adds only its own just-submitted request
and a finished operation no observation has confirmed yet, so the switch never flickers
backwards. The vocabulary is **Stopped**, **Starting…**, **Running** and **Stopping…**.
Reconnecting existing compute is Starting. One deliberate exception: live compute that is not
ready and that nothing is converging (a crashed or unhealthy service, a reconnect that failed,
exports lost under running compute) is **Needs attention**; the switch stays on so it can be
turned off, which always ends in a clean Stopped. Unknown observations (`lifecycle` absent) are
never rendered as Stopped.

**A session is application compute.** `activeContainerCount` counts only compute: the API and
WebSocket servers, the invocation runner, framework services and runner work. `postgres`,
`pgadmin` and `prisma-verify` (`isInfrastructureService` in [local.ts](../../../client-app/server/deploy/local.ts))
are database infrastructure: their `restart: unless-stopped` policies make Docker revive them
after an engine restart, so their being up says nothing about a session. After a Docker restart
the runtime is therefore Stopped, not "partially running", and the development-resource guard
(`assertStopped`) and Start admission share that definition, so Stopped never coexists with a
"stop local runtime first" refusal. Stopping an engaged runtime still stops every container,
infrastructure included. An idle checkout reads no Compose configuration.

When compute is positively gone (Docker restarted or quit, every container stopped) and no
operation is in flight, the host retires the watcher, web client and log follower that belonged
to that session after a short grace (it spans a `docker compose up` recreating containers outside
Studio); an explicit Start or a development-resource change retires them immediately. A stranded
client would otherwise hold the client port and a stale environment. This never happens on an
unknown observation. Retiring cancels only the host's own supervised jobs and issues no Docker
command.

Recovery attaches only when compute is ready and just the watcher/client are missing
(`readiness.waiting === "support"`), then reattaches logs and starts only the missing processes.
Compute that is warming or blocked is observed, not "recovered": a reconnect cannot succeed
there, so none is attempted and Activity gains no failed entry; its output is still followed
read-only, once per Docker container identity even when Compose reuses its display name.
Recovery failures belong to that session and cannot mark a later explicit start as
unhealthy. Warming observed without an operation to bound it (a host that restarted mid-start, a
client that never answers) is Starting for at most two minutes, then Needs attention
(`FRAMEWORK_LOCAL_WARMUP_LIMIT_MS` overrides it in tests). Recovery never exports settings, runs
Compose up/build, recreates containers, or prepares/applies database changes. When a Start is
requested and only infrastructure is running, admission is a real start (export, build, up), never
a reconnect, and it does not refuse for an unverified destination.

Missing ignored development exports under *live compute* (a reclone that kept running
containers) are Needs attention with a fixed message: observation checks the root settings,
resource manifest and client export before invoking Compose configuration or scheduling
recovery, so polling and **Check again** create no failed recovery jobs. Stop the retained
runtime, then start it explicitly to regenerate settings through the normal verified startup.
Container ownership checks and the ability to stop remain available without exports; the
existing database volume is preserved. A stopped checkout needs no exports.
Missing, expired or differently selected AWS profiles do not prevent local reconnection.
A persisted stop intent in the existing run record prevents automatic recovery from
undoing intentional shutdown; startup explicitly replaces that intent. Failed recovery is
bounded to the observed runtime generation; **Check again** explicitly retries it. The map shares
that repository-scoped query across navigation and refreshes it every five seconds
(two during a runtime operation), alongside existing operation events. Read errors stay
unknown rather than becoming stopped; last-known active evidence remains explicitly
unavailable until a successful observation confirms shutdown. A failed observation retains
engagement, but never retains a finished operation as an ongoing start or stop. Active compute containers,
including paused and one-shot processes, keep the switch engaged. **Running**
requires local readiness and consistent captured/exported settings, independently of AWS
selection. A confirmed **Ownership conflict** is a refusal rather than a state: it never permits
adopting or stopping foreign containers. A partial startup stays engaged and can be stopped.
Start is disabled until AWS, host and operation evidence confirm eligibility; the switch
still reads Stopped while **Details**
explains the next step, including why the last start failed when the runtime is Stopped.
Changing Source profile never exports over a running binding automatically.

Standalone CLI watcher/client processes do not carry the host's verified job ownership.
Studio does not adopt or terminate an arbitrary listener or PID; Vite's strict configured
port prevents a second client from silently moving to another port. A prior intentional
Studio stop remains authoritative until an explicit Studio start, even if containers are
later started manually. When captured project metadata is stale and has no active compute,
Studio can discover an active configured project only after verifying its checkout labels.
It repairs the existing run record once with that project identity and unknown AWS binding,
so log readers and independent operation guards share the same checkout identity. Discovery
never reuses the stale project's AWS binding or creates a second ownership record.

Development trace identity follows framework-controlled local boundaries. `runTask`,
`startWorkflow`, agent/tool adapters and workflow child steps propagate the trace while
creating their own spans. Private container-Lambda HTTP transport retains the already
allocated logical invocation and span; it is not a second application invocation.
Native/raw worker output remains resource/worker evidence when no invocation is known.
See [development logs](../../framework-studio/development-logs.md) for cache/privacy limits.
Application-runtime Lambda-to-Lambda calls are not a current framework API; workflow
`invokeLambda` steps are separate. Arbitrary SDK calls, imports and deployed AWS execution
do not automatically acquire local spans.
Task output privacy is owned by its existing run record and a boolean scoped-container
label. A runner restart can preserve that policy without storing payloads in metadata.
An adopted legacy container with unknown privacy policy omits cached output and reports
the gap; operational task adoption and completion remain independent of log capture.

The checkout operations host supervises **Container logs** independently of source Watch
and the web client. This read-only, explicit-project Compose follower supplies the combined
local output in Activity and survives a Studio restart. Host recovery reattaches it when
owned containers remain active. It does not
count as active application compute or as readiness evidence. Its stop action stops only
the subscription; stopping development also stops that subscription.

Development apply, destruction, manual export/repoint and cloud-writing plan preparation
require local runtime fully off. Studio repeats this guard at acceptance and immediately
before the command, including detached workers, with shared local/export locks. Source
editing and ordinary template synthesis/review stay available. Production infrastructure
keeps its separate scope. Stop resumes paused containers only to stop them gracefully,
and preserves containers and volumes. Activity owns operation progress and logs.

# Development resource logs

Studio's resource inspector includes a collapsed **Logs** disclosure for executable
resources and observable integrations. Map selection and **Resources** use the same
inspector. Development shows sanitized cached evidence; Production shows an explicit
unimplemented placeholder and performs no log read. The Source selector does not own
or stop the development collector. Activity's combined **Container logs** is unchanged.

## Ownership and storage

`packages/aws-studio/cli/dev-observation.ts`, called by `packages/aws-studio/cli/dev.mjs`, creates a private runtime
descriptor and an optional Compose overlay under `.framework/local/`. The overlay
enables `FRAMEWORK_DEVELOPMENT_LOGS=1` on local producers and gives only the invocation
runner a dedicated writable cache mount. The existing `.framework/local/` mount stays
read-only; Watch does not synchronize the cache. `USE_LOCAL_DEV_STACK` retains its
event-replay meaning and is not a diagnostics switch. Custom `COMPOSE_FILE` launches
and simulated engines do not implicitly acquire diagnostics ownership.
Overlay selection follows the Compose command's working directory, so another checkout
cannot supply its runtime descriptor. Host version/help probes bypass project overlays.

The runner's `src/development-logs/collector.ts` accepts bounded, capability-authenticated
local batches. Its writer subprocess owns filesystem work, so application handlers
never wait for disk writes. Host startup output uses a separate bounded bootstrap spool;
the runner imports it with stable event IDs. A failed startup remains readable even if
the runner never started. Studio only reads caches and can be closed throughout capture.
The spool retains sanitized generator diagnostics. Compose output is handled conservatively:
only fixed allowlisted engine/build lifecycle and failure summaries are retained; application
container lines and all unclassified text, including detailed build diagnostics, are omitted
with an explicit marker. The original combined Activity stream remains available. Actual
target build/process output belongs to the runner's resource-attributed producers.

Cache ownership is keyed by the canonical checkout path and Compose project:
`.cache/framework-development-logs/<repository-hash>/<compose-project>/`. Each run
retains its original declaration digest, development deployment/account/region binding,
runtime session and timestamps. A new start gets a new run; database preparation and
the following compute start share one run. A still-active collector retains its run.
If declaration or binding preparation changes the session during startup, the old spool
receives a source-change marker and closes before a new capture pipe owns subsequent output.
Capture readiness is bounded; failure disables startup capture while application startup
continues. The overlay is published before the capability, and mismatched overlay/control
sessions are rejected instead of being applied after an interrupted publication.
Runner restart can resume appending evidence, but cannot recover workflow executions,
callbacks, tasks or agent sessions from that evidence.

The declaration digest identifies the declarations at runtime preparation. It is not
an attestation of every source edit made later through Watch. Worker/process identities
and restart events qualify later evidence; a new runtime start creates a new binding.

The cache stores sanitized NDJSON segments and atomic manifests with committed byte
offsets. A separate small native SQLite lock provides exclusive writer ownership and
is released by process death; SQLite is not the log database. The supported Node 24
runtime supplies it without an npm native extension. A crash discards uncommitted tails,
retains committed evidence and adds a restart gap. Parent queues are bounded and retry
after writer failure. Producer IDs and sequence checkpoints deduplicate transport retries.
Private-file helpers enforce POSIX ownership/modes and Windows ACL protections.
Native Linux uses the host user's numeric UID for the writer. Docker Desktop maps host
ownership into its VM; a verified Desktop daemon and private root-owned mount use the
VM's root UID instead. Host acceptance checks verify that files remain owned by the
host user. An unknown ownership mapping disables capture rather than relaxing checks.
Container followers send checkpoint requests through the writer; the root runner does
not independently open cache files.

Native Windows collector fixtures verify the cache's actual current-user owner and
private DACL before starting a writer with the inherited token; POSIX mode/UID fields
do not establish Windows ownership. Shared or linked caches are refused without repair.
Normal application capture still runs in the Linux container. Offline native collector
tests do not establish Docker Desktop's host-to-container ownership mapping.

| Bound                                        | Default                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Main runtime evidence                        | 7 days, 20 runs, 128 MiB, 100,000 stored copies                   |
| Resource evidence                            | 8 MiB / 10,000 copies, within project limits                      |
| Overview projection                          | 2 MiB / 2,000 lifecycle, warning and error records                |
| Metadata / startup spool / directory ceiling | 16 MiB / 8 MiB / 192 MiB                                          |
| Segment / record / payload preview / string  | 256 KiB / 16 KiB / 4 KiB / 1 KiB                                  |
| Unfinished text frame                        | 64 KiB, then an omission marker                                   |
| Producer queue                               | 256 KiB / 512 records                                             |
| Collector queue                              | 4 MiB / 4,096 records, plus one bounded in-flight batch           |
| Batch                                        | 32 records / 256 KiB                                              |
| API page / scan                              | 200 records / 256 KiB; scan at most 2 MiB / 2,000 records         |
| Ingest rate                                  | 1,000 records/sec with a 2,000-record burst; 200/sec per producer |

Retention removes oldest owned segments/runs, independently of deployment approval,
recovery journals and database state. Do not blanket-delete `.cache` or `.framework`.
The startup spool independently retains up to 20 runs / 5,000 copies for seven days,
including attempts whose runner never started. Its 8 MiB data and 2 MiB metadata limits
fit within the overall directory ceiling. The combined reader lists the latest 20
distinct sessions; main and startup caches can physically retain up to 40 distinct
sessions / 105,000 copies in total.
Loss, truncation, restart and retention gaps are explicit. Shutdown flushes within a
bounded deadline; unavailable storage or abrupt termination can lose queued evidence.
The application still succeeds or fails according to its own execution, never according
to whether diagnostics could be saved. A stale collector heartbeat is disconnected,
not evidence that a workload succeeded. Ordinary shutdown preserves stopped history.
The collector's internal handle can explicitly await real writer readiness and committed
batches with `flush(signal)`, and request acknowledged closure with `close({ signal })`.
Both observations require the caller's bounded abort signal and reject unavailable or
interrupted persistence. HTTP acceptance remains asynchronous. Ordinary runner shutdown
keeps its existing best-effort drain deadlines; either shutdown path waits for its owned
child to release process/output handles before returning. Tests use acknowledged
persistence before reading evidence or restarting a writer, and private fixture parents
before creating child files. They do not infer durability from elapsed time or acceptance.

## Coverage and limits

Identities come from normalized declarations and Studio's model. Target references,
public route IDs and gateway IDs remain distinct. No application routing registry is
introduced. Schema version 1 records source, resource, producer, event/stream/level,
occurred/observed timestamps, monotonic ingest sequence, omissions and appropriate
request/invocation/execution/task/connection/session/turn/tool correlation. Framework
boundaries propagate parent/span relationships independently of application payloads.

| Family                                                                                             | Evidence and attribution                                                                                                                                   | Limit                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP gateway                                                                                       | Arrival, method/route match, auth outcome, bounded body preview, chosen target, mount stripping, dispatch, response status/duration, rejection/abort/error | Dispatch is intent; response finish is the observed HTTP outcome. Streaming content is sampled without buffering the response.                                                  |
| Node Lambda: HTTP, WS, authorizer, replay, tools                                                   | Input/result, cold/warm lifecycle, invocation output, exceptions, timeout/cancellation                                                                     | Async-context IPC distinguishes concurrent and late output. Native/raw worker output is resource/worker evidence when invocation attribution is unavailable.                    |
| Container Lambda                                                                                   | Target build, per-invocation container output, invoke/result/failure, removal                                                                              | Runtime output cannot manufacture finer application spans.                                                                                                                      |
| WebSocket gateway                                                                                  | Connect/auth, route selection, inbound messages, disconnect, management pushes                                                                             | Connection/message IDs correlate observed activity. A successful local push does not prove client processing.                                                                   |
| Event replay                                                                                       | Receipt, resolved target, delivery attempt, handler execution and acknowledgment/failure                                                                   | Receipt or queue deletion is not handler success. AWS-only event executions without local replay remain unavailable.                                                            |
| Workflows                                                                                          | Lifecycle, state input/output, branch/map identities, retry/catch attempts and Lambda/task/workflow/agent children                                         | Uses interpreter observation hooks independently of bounded in-memory history. Evidence is not durable execution recovery.                                                      |
| Application agents/tools                                                                           | Session/turn/invoke/stream outcome, child process output, tool dispatch/results/contracts                                                                  | Fake-model tests do not prove provider availability. Session ownership, streams and tool contracts remain authoritative. Studio Conversation/Coding infrastructure is excluded. |
| Services                                                                                           | Verified Compose-container stdout/stderr, lifecycle and gateway proxy evidence                                                                             | Only declaration-derived service/container ownership is accepted. Shared API/runner output is not relabeled as a service's invocation.                                          |
| Tasks                                                                                              | Submission, build/start, concurrent run IDs, exit/failure/cancellation, final output before removal                                                        | An accepted task is not a completed task.                                                                                                                                       |
| Local PostgreSQL                                                                                   | A small allowlist of server lifecycle/status messages                                                                                                      | SQL, statements, parameters and row capture are not enabled.                                                                                                                    |
| Queues/topics/tables/buckets and native resource members                                           | Calls observed by framework integration adapters, when an existing reference identifies the resource                                                       | No service-internal AWS logs or arbitrary application SDK interception. Explicit partial/unavailable status.                                                                    |
| Secrets, input/groups, environment files, stack/configuration entities, networks and relationships | Not applicable                                                                                                                                             | No independent local execution stream.                                                                                                                                          |

Compose build failure before a resource container exists may have only startup/runtime
attribution. It remains startup evidence instead of being assigned to a guessed resource.
Proxy requests carry correlation to a service, but arbitrary service frameworks must
consume that context to continue it through their own request handlers. Service process
output remains resource-level when the framework cannot attribute it to a request;
framework calls made without an inherited context begin a new trace.
Route inspectors show declaration-selected gateway events carrying that route's canonical
identity. Target output without an explicit route relationship remains resource-focused;
the cache does not guess a route from a target, public URL or the most recent request.

CloudWatch ingestion, new cloud infrastructure and production instrumentation are outside
this feature.

## Privacy and consumers

`packages/aws-studio/src/development-logs/` owns bounded serialization and redaction.
Sanitization precedes producer transport and persistence and is repeated at ingress and
cache reads. Credential-bearing JSON bodies are omitted; nested JSON/forms, header/cookie
fields, signed URLs, callback tokens, known resolved secret values, text and stack paths
are bounded/redacted. Binary and unknown bodies, accessors, circular or oversized values
have explicit omission markers. Text framing handles UTF-8/chunk boundaries; unfinished
sensitive output cannot expose a credential prefix. Resolved environments are never logged.
Only a workload's own secret matchers cross into its child process. Unknown application
secrets without recognizable structure still need careful application logging practices.
Recognized sensitive HTTP invocations omit input, result, error and scoped output previews.
Late JavaScript output keeps its invocation's privacy policy. Raw/native worker output has
no reliable invocation identity, so after a sensitive invocation it is conservatively omitted
until that worker restarts; ordinary attributed JavaScript output remains available.
Workflow payload privacy follows recognized sensitive HTTP envelopes through the existing
bounded execution lifetime. This is not general information-flow tracking for application
code that transforms secrets into opaque values. Application responses and the existing
combined Activity streams keep their established behavior.

Guarded `/api/development-logs/{runs,entries,evidence}` routes accept only Development,
validated model identities, bounded filters and scope-bound signed cursors. They cannot
read arbitrary files, execute commands, inspect arbitrary containers or query AWS. Records
are ordered by ingest sequence within a run, with source timestamps retained for skew/late
output. Cache readers reconstruct allowlisted data rather than trusting arbitrary disk JSON.

The inspector provides run selection, Follow/Pause, search, level filtering, bounded
history and expandable details. Reading older entries pauses follow and preserves scroll.
The displayed history is a moving window of at most 1,000 entries. Loading an older page
keeps that page and evicts the newest rows from the window when necessary; a notice reports
the newer rows outside the window. Loading can continue past 1,000 total fetched records.
A retained reading row stays anchored; **Follow logs** returns to the latest tail and resumes
polling, while **Refresh logs** returns to a paused latest snapshot. Full occurred/observed
timestamps remain available in event details, with the full source timestamp on hover.
Closed disclosures do not poll. Repeated cache-gap messages are summarized, with the
bounded marker history available in an expandable disclosure. Production never mounts
the development reader.

Native resources receive partial log availability only when an enabled local workflow's
existing integration references identify them. Other native resources explicitly report no
local capture point. An event Lambda invoked by an enabled local workflow has partial local
coverage even without replay; AWS event-triggered execution is still unobserved.

[Sightline](sightline.md) has a narrow explicit exception to its former cache-only input
contract: a visible Sightline, Conversation or Coding consumer may read this bounded local evidence cache
without opening Logs. Its pure builder receives a projection, not query-cache internals
or DOM content. Focused evidence groups the bounded reads by explicit invocation or
request identity before selecting anything, and supplies up to three execution digests:
the latest terminal execution, the latest failed one and one still running. Each digest
keeps its own identity, outcome, status provenance, duration, age and recorded failure
excerpt. Retrieval reads at most 24 recent records and eight same-run error-level records.
The supplemental read reserves one of its eight slots for the latest recorded terminal
error, continuing the same scan past stderr noise only within the existing 2 MiB / 2,000
record limits. If none is found, it keeps the eight newest errors. Skipped records remain
unread, and supplemental scan gaps reach the captured context. This reservation does not
search normally returned HTTP error statuses outside the recent window unless they were
also recorded at error level. Error-level output such as stderr is severity, not a failed outcome, and cannot
displace a failed execution. Records outside those executions remain sanitized excerpts
with correlation. The read window, unread older history and excluded counts are stated,
so missing evidence is never presented as a healthy execution. The no-selection overview
prioritizes errors and lifecycle events. The overall 12,000
character budget remains, with deterministic omissions. Coding attaches the optional,
inspectable submission-time snapshot and preserves it exactly on retry. Conversation
includes a compact inspectable capture by default, with safe outcomes, relationships
and a same-run trace synopsis. New questions follow current selection; retries preserve
their original snapshot. Its 6,000-character ceiling is separate from Sightline/Coding's
unchanged 12,000-character envelope. Log text remains untrusted evidence, never instructions
or authority. See [Conversation context](local-agent-lab.md#conversation-context).

## Trace inspection

An expanded invocation/request can open **Execution trace**. Its cache-only
`GET /api/development-logs/trace` read requires Development, the selected canonical
resource, the original runtime run and a trace ID. The API proves a same-run,
resource-scoped observation before reading other resources in that trace. It cannot
choose a filesystem path, container, command or AWS destination.

Primary-resource segment metadata indexes at most 128 distinct trace IDs; a full
index rotates the segment. This adds no duplicate event stream and shares existing
metadata, byte/count/age and run retention. A lookup reads only matching indexed
segments. Older segments without the index permit a bounded scan and explicitly
report partial evidence. Each of the scope and trace reads scans at most 2 MiB /
2,000 records. A response contains at most 200 events, 80 spans and 256 KiB, with
visible omission/retention markers when limits prevent a complete cache observation.

The pure reconstruction groups observed resource/span identities and follows explicit
`parentSpanId` links. It never infers a parent from timestamps, nearby output or the
most recent invocation. Missing/ambiguous parents and cyclic links stay explicit;
retry attempts, map/branch identity and asynchronous children keep their recorded
correlation. Failure spans and their available ancestors take priority at the span
limit. Handler return, HTTP status, service acceptance and observed execution failure
retain their distinct meanings. Parallel/asynchronous durations overlap and cannot be
added to estimate request latency.

`complete` describes this bounded read of retained cached evidence. It does not assert
that every application/AWS boundary was instrumented, that running work completed or
that durable execution recovery is possible. The view retains original run/source
identity. Production shows its placeholder and initiates no development trace read.

Only a visible expanded trace or relevant agent-context consumer reads this projection.
They share a repository/resource/run/trace query identity, so overlapping consumers join
the same request. While the cache reports collecting, the visible read can refresh every
two seconds; hidden/background consumers do not subscribe. Payloads remain sanitized
untrusted evidence, and identifiers/details are disclosed only as needed in the compact
execution list.

## Validation

Run from the repository root with the supported Node 24 distribution. Focused source/cache
and browser checks precede the required full offline gate:

```sh
node --import tsx --test packages/aws-studio/local/invocation/test/development-log-collector.test.ts packages/aws-studio/local/invocation/test/compose-development-logs.test.ts
node --import tsx --test packages/aws-studio/test/development-log-privacy.test.ts packages/aws-studio/test/development-log-producer.test.ts packages/aws-studio/test/development-logs-writer.test.ts packages/aws-studio/test/development-logs-review.test.ts
node --import tsx --test packages/aws-studio/test/lambda-auth-preview.test.ts packages/aws-studio/test/lambda-observation.test.ts packages/aws-studio/local/api/test/observation-chain.test.ts
node --import tsx --test packages/aws-studio/test/development-log-traces.test.ts
node --conditions=development --import ./client-app/test/support/register-css.mjs --import tsx --test client-app/test/development-traces.test.ts
node --import tsx --test packages/aws-studio/test/cdk/development-observation-startup.test.ts packages/aws-studio/test/cdk/dev-containers.test.ts
node --conditions=development --import ./client-app/test/support/register-css.mjs --import tsx --test client-app/test/development-log-scope.test.ts client-app/test/development-logs.test.ts client-app/test/sightline-logs.test.ts client-app/test/execution-evidence.test.ts
npm --workspace framework-studio run test:browser -- test/browser/resource-logs.spec.ts test/browser/development-traces.spec.ts test/browser/agent-awareness.spec.ts test/browser/agent-panel.spec.ts test/browser/sightline.spec.ts test/browser/agent-coding.spec.ts --project=chromium-light --project=chromium-dark
npm run verify
```

Docker fixture checks are separate opt-in evidence; they use temporary fixture resources:

```sh
FRAMEWORK_DEVELOPMENT_LOG_COMPOSE_TEST=1 node --import tsx --test packages/aws-studio/local/invocation/test/development-logs-compose.test.ts
FRAMEWORK_DEVELOPMENT_LOG_DOCKER_TEST=1 node --import tsx --test packages/aws-studio/local/invocation/test/development-logs-docker.test.ts
```

In PowerShell, set the corresponding `$env:FRAMEWORK_DEVELOPMENT_LOG_COMPOSE_TEST` or
`$env:FRAMEWORK_DEVELOPMENT_LOG_DOCKER_TEST` to `"1"` before running the same Node command,
then clear it. Fixture results do not establish native Windows, paid-provider, live database
or deployed behavior. Infrastructure/projection changes still require separate local/prod synth.

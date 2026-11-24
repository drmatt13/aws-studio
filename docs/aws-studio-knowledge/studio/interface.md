---
id: studio.interface
summary: Current Studio workspaces, their state ownership, user journeys and action boundaries.
read_when:
  - Learning the Studio interface or tracing a visible action into source
  - Adding a workspace without duplicating configuration or approval state
source:
  - client-app/src/main.tsx
  - client-app/src/studio.tsx
  - client-app/src/aws-profile-selection.ts
  - client-app/src/views/AwsProfileMenu.tsx
  - client-app/src/views/AwsProfileConfiguration.tsx
  - client-app/src/snapshot.ts
  - client-app/src/health/conditions.ts
  - client-app/src/connection-generations.ts
  - client-app/src/deploy/observations.tsx
  - client-app/src/deploy/use-deployment-progress.ts
  - client-app/src/deploy/context.ts
  - client-app/src/deploy/presence.ts
  - client-app/src/deploy/queries.ts
  - client-app/src/deploy/stack-inspection.ts
  - client-app/src/views/deploy/Detail.tsx
  - client-app/src/views/deploy/StackInspector.tsx
  - client-app/src/deploy/local-runtime.ts
  - client-app/src/deploy/local-runtime-state.ts
  - client-app/src/views/map/ComposePreview.tsx
  - client-app/src/views/map/LocalRuntimePopover.tsx
  - client-app/src/deploy/dev-lifecycle.ts
  - client-app/src/views/deploy/RuntimeMutationNotice.tsx
  - client-app/src/views/DomainsWorkspace.tsx
  - client-app/src/views/websockets/WebSocketTester.tsx
  - client-app/src/views/Shell.tsx
  - client-app/src/views/GraphQL.tsx
  - packages/aws-studio/scripts/contract-chain/graphql-chain.ts
  - packages/aws-studio/scripts/contract-chain/contract-proof.ts
  - packages/aws-studio/scripts/contract-chain/graphql-chain-response.ts
  - client-app/src/views/graphql/GraphQLProofLineage.tsx
  - client-app/src/views/graphql/GraphQLChainReview.tsx
  - client-app/src/views/graphql/GraphQLContractWorkflow.tsx
  - client-app/src/views/SourceContext.tsx
  - client-app/src/views/Database.tsx
  - client-app/src/views/PrismaEditor.tsx
  - client-app/src/views/access-decorations.ts
  - client-app/src/views/access-authoring.ts
  - client-app/src/views/inline-role-matrix.ts
  - client-app/src/views/RolePermissionMatrix.tsx
  - client-app/src/views/access-lens.ts
  - client-app/src/views/GlobalActivity.tsx
  - client-app/src/agent-chat.ts
  - client-app/src/agent-preferences.ts
  - client-app/src/views/agent/AgentPanel.tsx
  - client-app/src/sightline/AgentViews.tsx
  - client-app/src/views/agent/AgentViewTabs.tsx
  - client-app/src/sightline/useSightlineInputs.ts
  - client-app/src/sightline/bridge.ts
  - client-app/src/views/deploy/DockerStatus.tsx
  - client-app/src/machine/docker.ts
  - client-app/shared/machine.ts
  - client-app/src/activity.ts
  - client-app/src/operations/live.ts
  - client-app/src/operations/api.ts
  - client-app/shared/operations.ts
  - client-app/server/agent-lab.ts
  - client-app/src/views/agent/CodingPanel.tsx
  - client-app/src/agent-tasks.ts
  - client-app/src/coding-task-navigation.ts
  - client-app/src/views/CreationWizard.tsx
  - client-app/shared/creation.ts
related:
  - studio.backend
  - studio.editing
  - studio.rendering
  - studio.authentication
---
# Studio interface and action model

This is a source-verified map of the current application. Runtime verification is separate:
being able to render a control does not establish that its AWS or database operation has
completed. Start Studio with `npm run studio`, then open `http://127.0.0.1:4590/`.
`--port <number>` or `STUDIO_PORT` selects another local port.

## Navigation and state

[main.tsx](../../../client-app/src/main.tsx) owns the routes. The navbar has the app's
name, seven navigation destinations and a shared **Source** Development/Production selector. The name is
`framework:app` from `cdk-app/cdk.json`; its pencil opens a popover that previews each stage's
`<app>-<stage>` deployment and reviews a rename (AppName.tsx), looking in AWS read-only with
each mode's profile, by app id and stage. The same name controls local Compose; renaming
removes old stage-name overrides while existing AWS resources stay deployed under their
original identities. An app without `framework:appId` shows the name in the refuse color, and its
unchanged name can be reviewed to add one. Between 761 and 1200px only the pencil shows. Source mode selects a
declaration graph. Its trailing chevron opens an AWS profile popover for the accepted mode.
Opening it leaves focus on the chevron; Tab moves through its controls without automatically
highlighting the profile selector, including when discovery finishes.
`StudioProvider` exposes `awsProfile`, `awsProfiles` and `setAwsProfile(mode, name)` globally.
Only profile names are cached in browser local storage, keyed by repository root and mode;
both modes may use the same profile. Missing profiles remain visible as unavailable until
reselected or cleared. Storage failures retain session choices, and storage events synchronize
tabs. The popover lists local profile metadata through `/api/aws-connections` and checks
STS caller identity through its protected POST `/check`. These endpoints do not themselves
perform deployment discovery; associating a profile separately activates the persistent
deployment observer, including when the menu is opened outside Deploy.
Account/caller observations are query-cached, never persisted in local storage. Escape and
outside click dismiss the popover; keyboard focus returns to its trigger. While open,
the Development/Production buttons keep the popover open and update its mode/profile.
Switching modes while it is closed does not open it.
Profile selection automatically refreshes account details. The cog beside **AWS profile**
opens a foreground **AWS profile configuration** modal with profile discovery, cached
health, explicit connection tests, native sign-in, reviewed non-secret edits, and guided
Console/Identity Center/role creation. Its fixed viewport-bounded height, scrolling panes,
icon-only refresh and reserved feedback space keep profile/association changes stable.
The modal is a profile list beside an inspector panel that follows the inspector grammar: an
eyebrow whose Dev | Prod pills report which declaration modes use the profile, the config
section as the ref line, credential-source lines, then Declaration modes, Identity and
Configuration sections. Declaration modes shows a Development and a
Production card, then a **Use for** select (Dev + Prod, Dev only, Prod only, Not used). A review, deletion, sign-out or sign-in replaces that panel until it finishes or is
canceled; the panel stays mounted so Back restores edited fields.
Each configured profile row offers confirmed deletion with dependency/file checks; successful deletion
clears matching mode associations without selecting a replacement. Cancel/Escape restores
focus to that row's delete button. An absent or deleted `default` remains visible as an
unconfigured setup action; it becomes selectable for operations only after configuration.
Closing the modal returns focus to the navbar chevron.

Operational workspaces consume the active declaration mode's profile association and retain
explicit deployment/region controls and approvals. In Deploy, the global Source selector
chooses a matching Development/Production target through the unsaved-source guard. Entry honors the current mode and only reuses a saved
target from that mode; the page has no deployment rail. Profile names and legacy per-target
profile preferences never choose a mode or override its association. Deploy shows machine
checks and their remedies on the right of the deployment heading, with issues and remedies
before passed checks. The heading uses a plain document header and 18px sans title;
its findings and operational evidence share the document column, type roles and spacing. Narrow layouts wrap the group below the name and keep it aligned right;
there is no separate subnav bar. **Synthesize** prepares and saves the selected mode's
complete deployment assembly and template review without applying it. The newest completed
generation for the exact deployment, mode, profile, account and region decides the current plan;
once that generation is applied, an older pending plan does not become current again.
Older artifacts remain available under **Earlier plans** for explicit review and recovery.
Each plan card owns **Review plan** and **Discard**. Deployment is confirmed inside its
review; the header has only **Synthesize**, with no promoted review or deployment action.
Detailed progress belongs to Activity. **Synthesize** reads **Synthesizing…** at the same
width, with a legible busy label. An accepted deployment owns one green-accented
**Deploying <name>** panel, scoped to its selected destination. Intermediate stack,
compatibility, consumed-plan and read findings remain in the evidence model without
replacing this panel or shifting the metadata above it. The same panel waits for the
terminal operation's final AWS/plan refresh before handing back to settled findings;
a failed read then exposes its real retry state. Failed deployments still show their
result and recovery. This presentation changes no source, review, identity or apply
guard. A plan being discarded keeps its card, retitled with actions disabled.
`OPERATION_RUNNING` stays a finding for other readers. Plan cards follow the state
cards outside deployment. While an operation holds the source, the header says when editing resumes.
Source, input, target and AWS
connection changes make a saved synthesis unavailable for ordinary deployment. The Repository/AWS cards, stage-origin labels,
separate comparison/change-set controls and stage-creation form remain absent.
The full-width This machine, Client environment & frontend release, and Stateful retention
and retained-resource references editors are absent from Deploy. Their components and backend
services remain available; saved-plan reviews, local operation findings and Activity remain.
For a compatible development deployment, missing or outdated local exports on a stopped
checkout are preparation performed by **Start development**, rather than a warning.
A separate **Client environment** card explains that mappings in
`framework-config/client-environment.ts` combine selected `cdk-app/.env.dev` inputs
and verified deployment outputs to generate `client-app/.env.development.local`.
Its **Generate .env file** action uses the existing development export, which also writes
root Compose settings and the local resource manifest. **Ready to run locally** owns
**Start development**: starting automatically regenerates those files before Docker
Compose starts, so manual generation is optional.
Local startup, shutdown and export show one informational progress card instead of
simultaneous settings and readiness prompts. Active runtime settings conflicts remain
actionable; export freshness compares content and presence, not file dates.
CloudFormation events are shown through Activity rather than repeated on the page.
**Deployed · N stacks** is a keyboard-accessible disclosure with the observed destination
and stack statuses. Its **Destroy…** action opens the existing teardown review; deletion
still requires the typed deployment name and the backend's identity and retention checks.
The card remains visible during synthesis and source-only observation refreshes.
Each stack row opens a read-only **Stack details** inspector with its CloudFormation
overview, resources, events, outputs, parameters, template, tags, change sets and
cross-stack dependencies. Sections load only when selected, with pagination and
explicit loading, empty and error states. The inspector pins the immutable stack ARN
and clears when the deployment destination or credential generation changes. Deployment
destruction stays in the parent card's separately confirmed teardown flow.
Each Source mode's dot subscribes to the same destination-scoped observations: ready
owned stacks are green, AWS changes in progress are yellow, and failed/unreadable
evidence or a missing/unavailable AWS profile is red. Confirmed absence, loading
evidence or an undeclared destination is gray.
A source-only refresh retains the
last observation; changing the destination or credential generation clears it. Retained
evidence is labeled as last observed and does not establish current application health.
The Development map's **Local runtime** switch starts/stops the checkout's actual local
compute through the existing operations pipeline. An idle card appears only after the selected
development deployment is verified complete in the selected account and region. An ownership
conflict or stale recovery record alone never shows it. Confirmed deployment absence hides
the card; actual active checkout work stays reachable if AWS evidence becomes unavailable.
The card fades in as it appears and fades out before it is removed, including when the map
leaves Development.
It is disabled until the selected
AWS development deployment is fully completed and compatible, with a visible reason
and keyboard-accessible **Details** action. Only the switch toggles; the rest of the card
is not a control. The switch reports intent at once (on when starting, off when
stopping) and keeps focus while busy, while the status line narrates the running job
step ("Preparing database…", "Starting containers…") and observed readiness. Startup
initializes proven empty local PostgreSQL storage and verifies existing storage; pending
migrations and unknown populated databases require inspection in Database. It shows
checking, starting, running, stopping and attention states from local observations;
Docker availability alone never enables startup, and a finished command remains
starting or stopping until a newer local observation arrives, so the switch never
flickers back through the old state. One press carries the whole start: a running
Docker observation older than 15 seconds is checked again, a stopped Docker Desktop
is started with the existing `docker-start` operation, and the runtime starts once the
engine answers. Pressing again while Docker is still starting cancels the runtime start;
pressing during a running startup submits one stop intent. The checkout host records
that intent before cancelling the startup and stopping any services it already started.
Docker help appears only when that cannot finish alone (Docker missing, unreadable or
failed to start); it keeps the start pending and continues by itself once Docker answers.
The runtime popover explains blockers or links to Deploy, shows separate container,
source-watcher and web-client status, and provides an explicit stop for this checkout's
active runtime. A confirmed foreign-checkout ownership conflict disables lifecycle actions.
Startup validates the dev destination and compatibility and exports current outputs;
Activity records its steps and logs. Starting or stopping preserves the tray's current
mode and open state; **View activity** in runtime details explicitly reveals the job.
Running follows this checkout's observed container, database, watcher and client readiness,
independently of the browser's AWS profile selection or credential availability. Captured
runtime settings remain checked against the exported destination; missing or loading AWS
observations do not imply an ownership conflict. The switch reads the checkout host's single
verdict, so every tab and a freshly loaded page agree: **Stopped**, **Starting…** (including
reconnecting existing compute), **Running** and **Stopping…**. Live compute that is unhealthy
or cannot be reconnected reads **Needs attention** and stays on so it can be turned off; a
confirmed **Ownership conflict** is a refusal rather than a state. After a Docker restart only
the database containers Docker revives remain, which is not a session: the switch reads Stopped.
The existing checkout operations host owns watcher, client and log processes across Studio
restarts. Reconnection resumes only missing components after local ownership/readiness
checks, without exports, rebuilds or database writes; compute that is merely warming is
observed rather than reconnected. **Check again** retries failed recovery
without AWS reads. Failed local reads clear the healthy indication. The switch remains on for active or starting/stopping
work, including partial failures, until shutdown is confirmed. Source changes do not erase
the checkout's actual runtime evidence. Stopping preserves local containers and data.
Development deploy/destroy/export and cloud-writing preparation actions require shutdown;
their compact inline notice offers **Stop local runtime** without dismissing an open review.
Source edits, normal template synthesis and read-only reviews remain available. Every
runtime start regenerates settings from the verified deployment, so the ordinary flow
has no manual export step.
Saved local settings for an absent deployment do not imply that local runtime is active.
Deploy shows the absent-deployment state without an orphaned-settings warning when
runtime is stopped. An active runtime with settings for that absent deployment still
shows a warning and offers stopping; starting remains gated on completed AWS resources.
The account/region line shows a caption-sized loading skeleton while the selected profile
is first read, preserving the same line height. Expired or missing
credentials replace that line with a red **AWS sign-in required** text action in the same
type size. Hover/focus reveals its link styling; activation opens the active profile's
configuration modal. These login failures do not add a Sign in button or a findings banner.
**This machine · N checks passed** opens a compact, viewport-bounded popover without
expanding the readiness strip; it follows the profile menu's native Escape, outside-click dismissal
and focus-return behavior. AWS connection details live in the global chevron. Domains still edits Production intent while the global source selector
may display Development: its operational connection is explicitly the active association.
Changing that association or its authentication/configuration invalidates evidence and
pending reviews; it never retargets running jobs. One persistent observer refreshes
read-only deployment evidence for each configured mode on every route; Deploy consumes
the same cached and in-flight queries. Other operational workspaces retain their explicit
inspection actions. See [AWS connections](../../framework-studio/aws-connections.md#shared-deployment-observations)
for target resolution, background scheduling and refresh policy.

| Workspace | Route | What the interface controls |
| --- | --- | --- |
| Map | `/` | Isometric declaration graph, search, tag emphasis, connection visibility, camera, resource navigation, creation and Inspector |
| Database | `/database`, `/database/schema`, `/database/history`, `/database/status`, `/database/sql`, `/database/retention` | Prisma editor with inline access badges, role matrices and access popups, runtime-backed persona/scenario previews, diagram access paths, shared migration/SQL source, mode-scoped database context, separately reviewed execution, and persistence/deletion policy |
| Deploy | `/deploy` | Active source-mode deployment, header machine checks, synthesis, reviewed deployment, findings and Activity |
| GraphQL | `/graphql`, `/graphql/schema`, `/graphql/explorer`, `/graphql/client` | Persistent contract chain above Schema, Explorer and Client, each chain link opening its section; saved source browsing and explicit local GraphQL execution |
| Authentication | `/cognito`, `/cognito/user-pools`, `/cognito/identity-pools`, `/cognito/providers`, `/cognito/permissions` | User pools, identity pools, providers and permissions, each with separate source and deployed evidence |
| DNS / Domains | `/domains` | Production domain input settings, selected-deployment observations and separately approved domain operations |
| WebSockets | `/websockets` | One connection panel for the Source mode: local-ws-dev-server in Development, the API Gateway stage in Production; connecting or sending is an explicit runtime action |

Database opens with the Prisma source at full width. **Interactive** renders valid directives
as badges above models and enums and beside fields; a role value's settings (`protected`,
`...LOWER`) render as quiet annotations aligned in one column after the enum's values.
A caret inside a rule's source, or directly after its badge, shows the authored text.
**Comments** shows the highlighted source. **Jump to** selects a declaration and scrolls
its leading comments and rules into view. Click a badge or press Ctrl/Cmd+.
to open its access popup. Placing the caret at the end of an uncommented, validated
declaration eligible for a rule shows **+ Access**. The popup reads the compiled draft graph for scope paths, field protections,
commands and permissions. **Configure access** writes validated rules to the draft.
**Preview with sample data** evaluates the policy over synthesized related rows.

**Role permissions** beside a role enum opens its matrix in a popup. **Inline matrix**
replaces the stacked permission badges for that enum with the same table, drawn as those
rows' rendered form: one code line per permission, in their role tint. Each enum-level
row, ability or CRUD action, links to its holder list. Toggling a cell stages that single grant
in the Prisma draft, including when the last holder is removed. Selecting a field shows its read and assignment
rules, including a link to a model-level `fields(…)` directive when one governs it.
The editor provides syntax colours, scope rails, hover explanations, completion and
F12 navigation. Use Ctrl/Cmd+Alt+F for editor Find. See the
[database workbench](../../framework-studio/database-workbench.md#access) and
[Prisma access guide](../../PRISMA-ACCESS.md).

The WebSocket panel owns its socket from construction through cleanup, including a
pending handshake. Leaving or switching Source closes it; callbacks from an older
attempt cannot update the replacement panel. Construction failures allow another
attempt. Received text is parsed as JSON when possible and otherwise kept as text.
Message rows keep their expanded state during payload edits; history is append-only
and currently uncapped, so this is a debugging view rather than a retained log store.

The Database, GraphQL and Cognito navbar links open `/database/schema`, `/graphql/schema`
and `/cognito/user-pools`. Their base routes redirect to these sections with history
replacement, preserving validated search parameters. Each stays active in the navbar
across its subsections. Legacy `/database#status` still opens `/database/status`.

GraphQL keeps its four-node contract chain above a selected link's details in the same
scrolling page; the chain scrolls away while the section strip stays visible. Each link opens
its section: Pothos review → Schema, Codegen → Explorer, Client review → Client; on the active
section it shows or hides the detail. **Check again** sits in the chain's header, and **How
this works** at the right of the section strip explains the review and codegen flow. Prisma →
Pothos requires model and repository/API implementation review; the client review binds its
SDL, implementation and API predecessor. Generated GraphQL retains schema, authored-document
and complete Codegen check evidence. The rail displays recorded source and output hashes.
Loading stays visible until those hashes arrive. An upstream output that matches the recorded
input is **In sync**, and a matching saved approval can display **Approved**. A mismatch applies
at its handoff and later stages wait for upstream. **Check again** runs independent checks.
The stage's draft or generation button is disabled when it is **In sync** or **Approved**.
**Draft full contract task** is disabled when all three stages are in sync or approved.
Approval evidence and renewal are available in the stage details.
The stage details report end-to-end confidence and any blocked predecessors. Independent backend,
client, consumer and integration checks are required; hashes alone cannot establish correctness.
Unknown inputs never become verified. Lightweight reads and source invalidation keep previous
observations explicitly historical; **Check again** starts independent saved-source validation
without reading a running API, AWS or a database. **Regenerate GraphQL** in the Codegen
detail runs the fixed generator and records the Codegen handoff on success. The action uses
saved schema and authored operations and can run without a Coding task.
The chain has the same source-only meaning in both Source modes. Sightline identifies
all GraphQL routes but captures no chain contents, tokens, variables or execution results.

**Draft Pothos task**, **Draft client task**, and **Draft full
contract task** open **Agent → Coding** with an editable suggested prompt. The developer
starts the task from the shared composer and reviews any proposed files before applying
them. An existing unsent Coding draft is retained until the developer chooses which
prompt to use. For an existing contract run, **Open in Coding** on the **Contract update**
card selects the saved task, which retains its checkpoint evidence and continuation
controls. Saved-source checks and approval stay in GraphQL. The rail shows
**Source SHA-256** on the left and **Generated SHA-256** on the right of each
downstream block. Database has only the output hash. Source shows the upstream content
bound by the recorded approval, or **Not recorded**; it never copies the live predecessor
hash. Adjacent values match after recording and diverge when upstream content changes.
The Prisma hash excludes ordinary comments and includes Access Graph directives and other
semantic declarations. The separate proof
lineage shows accepted/current predecessor receipts. Activity reports pending or failed
saved-source approval separately from source application. GraphQL shows task progress and
the approval result during saved-source checks. Completed approval refreshes the rail.

**Schema** browses the saved generated schema's types, fields, arguments, input defaults,
descriptions, enum values and SDL. **Client** lists authored operations/fragments and
statically recognized query/mutation options and key factories, with exact source and
generated-document evidence. Field paths resolve known fragment spreads without inferring
Prisma mappings. Dynamic keys are shown as source expressions, never invented values.
These source tabs load independently of the optional deep contract check. Navigation,
focus and stale evidence never start that check: **Check again** explicitly starts the
background inspection while the rest of Studio remains available.

**Run in Explorer** loads an operation with its transitive fragments for editing.
**Explorer** runs only an explicit request against the checkout's ready local API; it
never starts the runtime. The Cognito ID token stays in the transient composer and is sent
only with execution. Selected mutations require confirmation. The page reports stopped,
starting, unavailable, validation, loading, error and response states separately.

With no recorded review, **Record reviewed baseline** first asks for explicit API and client
behavior decisions and their source or user evidence, then opens the exact record diff before
**Record review** saves it. All independent checks must pass. API and client reviews use the
same decision form; it starts empty and never silently adopts Coding decisions. Preparation
errors preserve the typed decisions and focus their explanation. Later Prisma changes
are acknowledged per model, followed by a repository/API review against the current compiled
contract. Client review requires verified API/Codegen confidence and passing client/consumer/
integration checks. Identical downstream outputs permit explicit no-op reconciliation; they
do not bypass upstream review. These actions update only `graphql-chain.review.json`.
The details distinguish local checks from effective confidence and explain changed inputs,
blocking predecessors and the next required check/review. Previous fingerprints and results
remain labeled historical information when their inputs are stale or unavailable; they
never grant current status or review authority. During a source check, a healthy watcher
can preserve Approved for unaffected upstream stages whose verified inputs and dependencies
still match. Changed stages lose approval immediately; a watcher failure cannot preserve
it. Ordinary polling does not erase current approvals. Incompatible browser/server chain versions
request a Studio restart instead of interpreting old green statuses as current proof.
Source changes invalidate an open review. An initial unreviewed file is ordinary committed
review evidence, so cloning it still shows **No review recorded** until someone explicitly
reviews the source. The terminal status/check/accept workflow is documented in
[Data features](../../DATA-FEATURES.md).

The selected stage's **Proof lineage** disclosure loads advanced details only when opened.
It separates current independent evaluation from the recorded receipt, shows specific
predecessor receipt bindings, and retains differing receipts as historical evidence. Nested
receipt details expose normalized input/output identities, policy and tool versions,
validation outcomes, accepted decision text and offline limitations. A matching identity
establishes content equality; it does not establish behavioral correctness or authenticate
the reviewer. Version 3 review records retain versioned receipts; existing v1/v2 model
acknowledgements survive, but their missing proof requires explicit review renewal. Older
server responses cannot provide current verification to this browser.

Local and CI evidence comparison stays inside the same disclosure. With no available CI
observation it says **No CI observation loaded**; an observed match never substitutes for
CI independently executing its verification policy. CI origin labels and content hashes
are not signatures. Current trust remains bound to saved source, accepted decisions,
required predecessor proofs and independently passing checks.

Authentication deep links are `/cognito/user-pools`, `/cognito/identity-pools`,
`/cognito/providers` and `/cognito/permissions`. `/identity` and `/identity-pools` redirect
to the identity-pool workspace; `/isometric` redirects to `/`.

`?select=<canonical-id>` identifies the shared Inspector selection. `StudioProvider`
owns source mode, selection/navigation, the snapshot-derived lookup and one Inspector
draft. The draft retains its baseline if newer source arrives; it becomes conflicted
instead of silently accepting a new baseline. Source-mode changes, selecting another
resource and route navigation use the unsaved-change guard. Database text editing has its
own exact-text session and navigation protection.

| State | Owner and lifetime |
| --- | --- |
| Requested entity | Router `?select`; the draft/navigation guard controls acceptance |
| Accepted source mode, graph and pending edits | One mounted `StudioProvider`/`InspectorDraft`; dirty sessions retain their baseline |
| AWS profile associated with each source mode | `StudioProvider` via `aws-profile-selection.ts`; browser cache scoped to repository root, containing profile names only |
| Latest snapshot and source-read evidence | TanStack Query; [snapshot.ts](../../../client-app/src/snapshot.ts) and feature query definitions retain existing keys and refresh policies |
| Inspector return trail | In-memory accepted visits, with presentation retained separately per source mode; see [rendering](rendering.md) |
| Saved Prisma workbench source | Repository-scoped TanStack Query cache; immediate return rendering with background rereads on mount, focus and snapshot revision changes; each accepted read also refreshes history |
| Prisma draft, validation and diagram | Independent route-owned `DatabaseSession`, preserving editor identity/undo across Database tabs; line geometry is measured before the editor becomes visible |
| Docker availability | One Shell-mounted observer and shared query cache; Deploy, Map and Activity consume the same current host observation |
| Global Activity | `GlobalActivity` in the persistent shell owns open/selected state and operation reads; shared log storage and one global operation-event observer continue on every route. Execution belongs to the runner or the operation's legacy service |
| Agent preferences | `useAgentChat` owns the shared Conversation/Coding provider and each provider's model choice. `agent-preferences.ts` caches only these choices in browser local storage across reloads; unavailable storage keeps session choices usable |
| Agent conversation | `useAgentChat` in the persistent shell owns transcript, draft, pending request and unread state. These survive mode switches, collapse and navigation, and reset on page reload |
| Sightline display and projection | `GlobalActivity` owns Conversation/Sightline/Coding view selection; only the visible Sightline or Coding consumer subscribes to route, Studio and cached evidence. Workspace owners register lazy typed readers in `sightline/bridge.ts`, removed on unmount; they never read the projection back. Coding can explicitly capture bounded context; Conversation does not receive it |
| Coding task observation and review | `useCodingTasks` owns browser queries/replay and repository-scoped task selection; durable task/proposal/approval state belongs to the independent host. Browser unmount does not cancel execution. `CodingPanel` owns the disposable composer and explicit task actions |
| Shared deployment target resolution and observations | Pure mode-aware resolver and one persistent observer; TanStack Query owns data/errors/freshness. Consumer hooks subscribe without polling or issuing reads |
| Specialized operational destination, inspection and approval | Owning workspace; shared deployment defaults never replace its explicit target, inspection action or review |
| Camera, hover, filters and disclosures | Local view state; never persisted as framework configuration |

`http.ts` owns token/protocol HTTP mechanics; endpoint adapters own typed calls.
Shared deployment queries include repository/source revision, mode, profile, credential
generation and destination. `GlobalDeploymentObservations` activates one target per
configured mode and owns deployment polling/cache events. Pages subscribe through shared
hooks; specialized inspection state and all action approvals remain with their workspaces.
No AWS failure blocks source navigation or graph rendering. Use the
[source ownership map](../REPOSITORY-MAP.md#where-to-change-studio) to locate rendering,
state, transport and tests for a change.

Docker availability is observed through `/api/machine/docker`, reusing Deploy's host
probe and derived Docker/Compose readiness checks. One Shell observer refreshes every
five seconds while visible, on focus/reconnect and after Docker startup settles. Changed
observations share the existing event stream; older HTTP observations cannot replace newer
ones. Missing, stopped and unavailable/unknown remain distinct. This lightweight read does
not inspect AWS or deployment state.

## Shared Activity

The bottom **Activity** tray belongs to `Shell` and is mounted once for every route.
Its **Activity** and **Agent** tabs choose operation history or a question-and-answer
conversation. Clicking either tab selects its mode and opens the panel, including an
already-selected tab. The summary/chevron control opens and closes it. Arrow keys and Home/End select tabs;
Escape collapses the panel. While open, drag the tray's thin highlighted top edge to
resize it. Dragging below its 100px minimum height closes the panel and restores the responsive
default height when reopened. Other resizing retains its height across ordinary collapse,
mode changes and navigation. The top-edge separator also supports Up/Down arrows
and Home/End for resizing. The collapsed tray has no separate resize handle; drag its
summary bar upward to pull it open, or click to expand. A manual opening follows the
pointer and closes again if released below 100px. Mode tabs and Docker controls remain
independent. The open summary bar remains a click control. The tray can reach the top
of the window, covering the navigation, and adapts to window size. Dragging follows
the pointer immediately. The drawer slides with an interruptible 280ms
`cubic-bezier(.22,1,.36,1)` transition, disabled under reduced motion. A registered CSS
length on the shell drives both drawer height and map compensation in the same frame.
The occlusion marker remains until
closing finishes; collapsed contents are inert and hidden from accessibility navigation.
Agent offers editable suggestions, a pinned multiline composer, Codex/Claude and model selection,
Markdown answers, copy, stop, retry and confirmed New chat. Replies can finish while
Activity is selected without changing modes; a new-reply dot marks the Agent tab.
Explicit `openActivity(job.id)` switches back to Activity. Conversation provides
general Q&A with a fixed Studio overview, without reading live source/graph/log context;
see [local coding agents](../../framework-studio/local-agent-lab.md).
`GlobalActivity` is memoized and consumes no route or Studio context, so navigation does
not render it again. Open state, selected job, log DOM, and the reader's scroll position
survive navigation. Job/log changes and tray interactions still update it normally.
Selection starts empty on each reload. Opening the tray does not select a job; clicking the
selected history row again clears its detail and closed-bar headline. Only an explicit
selection supplies that headline. The Activity tab carries no badge, dot or count, so it never
changes width. Durations, live or finished, count whole minutes ("<1m", "4m", "2h 14m").
The collapsed bar stays blank while history loads; the open panel shows its loading state.
Open state, height, and log Wrap and Time survive a reload, per browser, through `views/deploy/activity-preferences.ts`. **Ctrl+`** opens
the tray at the selected job and closes it, returning focus.

History (`ActivityHistory`) is one line per job: running work first and never capped, then Today
and Earlier, 20 rows at a time. Identical neighbours and each development session fold into one
row that opens to its jobs; a failed job leads its session and never folds into a success.
History is one Tab stop, with arrow keys, Home and End between rows. A running job has one
spinner: its history row while the tray is open, the bar while closed. The active step is a
steady mark with a ticking time, and the open bar stays empty. An idle bar with no operations
also stays blank; loading and failed history reads remain visible. Clocks rewrite their own text, so
time passing renders nothing.

The detail header leads with the result, then duration, exit code and scope, with a stepper for
multi-step jobs. Stopping says only what is true: **Cancel** for read-only work, **Stop** for a
local process, and **Stop command** beside "Stacks already started finish in AWS." only when
`changesAws` holds. A job that needs attention shows its first error, or recovery note, with a
link to that line and **Ask in Conversation**. It puts a bounded excerpt of the stored, sanitized
log in the Conversation composer, after any draft; only the developer can send it.
Confirmed deletion shows **Deleted** in history and reports how many reviewed stacks
were deleted. Retained resources and managed secrets appear in quiet completion
context, without a warning or recovery action. This requires a complete teardown
receipt matching the accepted review; missing proof still requires attention (see
[operation evidence](../deployment/operations.md)).

`ActivityOutput` owns the log subscription, so output renders only there, and lines render in
chunks of 200 so a long log costs only the chunk that changed.
Colour comes from what a line says (`operations/log-lines.ts`), because tools write ordinary
progress to stderr. Tools are Filter (`/`), Problems, Time, Wrap and Copy, which copies the lines
showing. Bundling output folds without hiding a problem. URLs, CloudFormation stack ARNs and
source locations inside the checkout are links, outside the tab order; other ARNs stay plain text
because no console address is guessed. In a background tab the title reports running work and
what finished, and a live region announces finished jobs.
**Agent** opens the same tray on every workspace. Studio remembers the selected tab
and whether the tray is open across page reloads. Contextual actions go directly to
their destination in **Conversation** or **Coding**. The **Context** tab opens the
Sightline JSON preview with **Copy JSON** and a character count. Conversation DOM,
draft and scroll remain mounted while it is selected.
Only the visible Sightline or Coding view mounts context subscriptions; context capture initiates no data
reads. The existing JSON viewer loads lazily, with keyboard expansion controls and Studio
theme tokens. [Sightline](../../framework-studio/sightline.md) defines the read-only
contract, privacy allow-list, workspace state seams and current gaps. The conversation
still receives only its existing bounded messages and fixed server overview.
**Coding** opens either the request composer or the selected task. Conversation and
Coding share the provider and model controls inside the composer. The context chip in
either view opens **Studio context**, previews what that composer will send, and shares
the include setting. Studio chooses checks from the actual changes by default. **Task
settings** contains the optional check scope. On submission, the view shows startup immediately and then
follows the selected task's live activity. Review shows the files and checks. Approved
source changes still use digest-bound application. Completed tasks lead with the result
and any action still needed. **Task details** contains the original request, activity,
contract evidence and cleanup. **Restart Studio** appears when applied changes need it.
Inspector **Validate reviewed changes** selects the validation task while preserving the
inspector draft. **Coding runner maintenance** is below the task area and reads runner
status when opened. Restart requests retain their identity across retries and reloads. See
[Coding tasks](../../framework-studio/local-agent-lab.md#coding-tasks).
Database source saves show a lightweight contract-impact notice and a contextual
**Continue contract update** link. GraphQL retains its saved-source confidence rail and
shows private Coding checkpoints for existing runs. **Draft next task** preloads a
request for the next stage that needs attention. Existing task metadata restores progress
after navigation or reload. Developer choices,
candidate continuation, final source application and saved-source review renewal remain
separate actions. Checkpoint details reference versioned candidate receipts and their
candidate predecessors. Missing, stale or incompatible proof makes retained passing flags
historical and disables approval until the host independently revalidates the candidate.
Candidate receipts never become saved-source receipts through Apply; integrated source
requires its own inspection and explicit review renewal.
Opening the bottom panel shrinks the workspace, except the map's canvas, which [runs beneath it](rendering.md).
The tray observes `/api/operations` through the shared operation transport and owns the
global operation-event subscription. Deploy's event observer handles its plan-review/CloudFormation
callbacks. Operations started from Deploy call `openActivity(job.id)` to reveal their job
in the same tray. Cancellation retains the existing command semantics; failed reads and
cancellation errors stay in the tray, with read retry available there. Cursor-based replay
recovers historical log pages and missed tails without adding duplicate lines. Replay
failures remain explicit and retryable. Workspace navigation stays in the navbar;
uncertainty, unverified outcomes and recovery instructions remain visible
separately from command completion.

During local development, **Container logs** leads the steady processes in Activity,
beside **Web client** and **Source watch**. It streams service-prefixed container output;
the log filter can narrow it to a service or invocation. Successful local retries retire
the matching earlier failure's closed-bar alert and unread marker without changing its
history entry. Selecting an old failure still opens its original evidence.

The tray bar always shows Docker's current state beside the headline, on every route and
whichever job is selected. `dockerPresence` in `shared/machine.ts` derives it from the shared
machine observation and the running startup, never from a past job, and gives each state one
remedy: **Start** (the shared startup operation, in place), **Check again**, an install link,
or the restart/reload instruction when the running server or page is out of date. Startups
leave the headline because the status reports them; only the latest failed or interrupted
startup stays, while Docker is still not running, to explain why. A finished startup's detail
says only how it relates to the present ("Docker has since stopped."), so a past success never
reads as the current state. Stored job results and logs remain unchanged.

Deployment plan/apply/discard, deletion, drift, export and the fixed framework-check
operation use independent host workers. Their logs continue through Studio shutdown and
can be read after restart. Local development and host-remedy jobs run in that same
checkout host; closing Studio leaves its watcher, client and logs running. Activity itself owns presentation and observation, never approval
or execution. See [operation lifecycle](../deployment/operations.md) for exact recovery
guarantees and the current macOS/Linux boundary.

## Reading the map

Resource and connection counts sit at the map's top right. In Development, the
lower-left **Local runtime** switch controls actual checkout compute and shares its
observations across navigation. The switch remains engaged for partial startup while
**Running** and whale animation require confirmed readiness. Its prerequisite state and
**Details** action explain unavailable startup. Turning the switch on starts a stopped
Docker Desktop and then the runtime; Docker help appears only when Docker cannot be
started automatically. While starting, containers stack onto the whale and rest as a
full stack for about ten seconds before restacking; on readiness it spouts and light runs
once around the card; while stopping, the containers come off and the whale slowly ebbs
until shutdown is confirmed. Whale motion follows the map's
motion control and reduced-motion preference. Production does not show the switch.

The scene combines both modes to stabilize placement while showing the selected mode's
availability. Islands group entry points, compute, networks, orchestration, resources,
inputs and environment projections. Real VPC declarations own their subnet placement;
moving the camera never moves resources between networks. Production terrain can depict
an unused declared VPC without asserting that it has been provisioned.

Use **Resources** for a keyboard-accessible list of canonical entities and connections.
Selection opens the same Inspector used by canvas hits. Contextual Back retraces accepted
Inspector visits; Resources restores the list context. Search and tags change emphasis,
not source, graph identity or deployment intent. In the focused entity navigator, arrows
and Home/End browse, Enter inspects and Escape returns to the canvas. See
[rendering](rendering.md) for picking, narrow-screen placement and focus restoration.

Connections retain individual members even when visually bundled. Declared references,
derived framework relationships and inferred native CDK wiring have distinct provenance.
A native wire is source evidence; synthesized inventory and observed deployment state are
different evidence. An omitted inferred wire is not proof that no connection exists.

## Changing the application

1. Select an entity and inspect its source location, availability, settings and connections.
   Read-only computed settings link to their source; Studio does not rewrite arbitrary code.
2. Stage supported settings in the shared Inspector draft. **Add to Application** opens
   a typed creation form. The current creation registry supports functions, API routes,
   stack starters, VPCs, workflows, services, tasks, agents, tools, inputs, secrets and
   OIDC/SAML authentication providers. A stack starter offers queue, bucket and identity-pool
   templates; this is not an unrestricted visual editor for every CDK construct.
3. Review the combined source diff and Development/Production validation. Some operations
   include generated contracts, starter implementations or narrowly authorized native CDK
   changes. Creation reviews one complete operation at a time.
4. Apply the reviewed source. File hashes, source revision and capability evidence must
   still match. The server reevaluates from disk and verifies expected semantics.
5. Run the relevant local/build checks and use Deploy separately if infrastructure must
   change. Saving source never authorizes a cloud mutation.

Saved source history belongs to Git. There is no global source Undo/Redo API. An interrupted
multi-file write can expose **Source recovery**, which offers guarded restoration or
keeping validated current source. Editor-local text undo and reverting an unsaved field
are separate behaviors. See [editing](editing.md) for transaction guarantees and limits.

## Inputs and configuration

VPC inspectors expose **Private hosted zones** with create, associate-existing and
configuration links. **Domains** starts with a private-zone editor, separate from
production public-domain inputs. [PrivateZones.tsx](../../../client-app/src/views/PrivateZones.tsx)
uses the shared source draft for imported zone modules, VPC associations, internal
ECS ALB A aliases and explicit caller grants. No DNS model is stored in Studio.
The editor labels local execution unsupported and AWS behavior unverified;
[private DNS qualification](../../framework-studio/private-dns-parity.md) owns those boundaries.

The Inspector distinguishes a public **Source parameter** (`input.value`) from an
**Environment parameter** (`input.fromEnv`). **Link to .env file** switches the source
through ordinary reviewed source editing. Public source values/defaults may be displayed
in the graph. Environment-file contents are loaded through a separate guarded, no-store
service and excluded from snapshots and source diffs. Authored `input.secret("NAME")`
inputs remain linked to their selected CDK input file and start masked. Native stack-owned
`ISecret` fields are separate catalog references; this editor does not turn them into
authored dotenv values or reveal their AWS contents.

The CDK-file editor writes only `cdk-app/.env.dev` and `.env.prod`, preserving untouched
assignments and comments. Client environment mapping edits symbolic recipes in
`framework-config/client-environment.ts`; export later resolves these into ignored Vite
environment files. The **CDK environment files** island holds **CDK environment**, labeled
**Framework managed**. The separate **Client environment files** island holds the application's
client mappings, which carry no ownership label. The label describes ownership; framework input values remain editable. Every island ends with one
**Island entries** disclosure; there is no separate Files list. Select
`client-app/.env` from its island entries for both export destinations and
the file's mappings; file details remain collapsed. These are symbolic sources, not the
contents of the base `.env` file. Editing a recipe does not export values or deploy resources.
The islands use `island:environment` and `island:client-environment`, respectively.
**CDK environment** represents both physical files as one
variable list: per-environment readiness first, then one row per name with a Dev | Prod pair
(lit with a value, red when a required value is missing) that opens to both values side by
side. Editing is independent of the map's Source; one private review saves whichever files
changed, and refuses both if either file changed. Links to a variable open its row with that
environment's field focused. Revealed values clear when newer source arrives. Individual
file IDs and original connection evidence remain available behind the combined node and its
Dev/Prod supply rows.

Opening a project preserves existing files and reports missing conventional CDK
inputs. **Create .env.<mode> from template** creates the selected missing file
from its own template. Snapshot reads, refreshes and `--print` preserve the files.

## Health and verification boundaries

**Configuration health** reports source loading, framework validation and source-index
problems. Its Additional checks action runs the fixed `framework:check` command. This is
distinct from a synthesized resource inventory, AWS credentials, deployed infrastructure,
Docker health and application health. **Deploy** (`/deploy`) owns explicit synthesis
and infrastructure review. The Stacks island inspector lists its source-linked entries;
changing the view or source mode does not synthesize.

A navbar indicator opens that panel while a condition is unresolved; a healthy navbar
shows nothing, in a slot that stays reserved. `healthConditions` in `client-app/src/health/conditions.ts` is the single derivation for the indicator,
the panel and health toasts, covering a model that is stale or errored in either mode, a
failed snapshot request, an interrupted source watcher and non-blocking notes. Each
condition keeps its own severity, evidence, recovery and capability list. No health state
inserts anything into the page, so the workspace never moves.

Initial loading, failed initial connection, cached-snapshot refresh errors and stale
source models have separate UI states. A background fetch failure preserves the mounted
editor and its draft. Synthesis errors preserve labeled last-good inventory. Operational
pages report unverified/stale evidence until the relevant explicit inspection succeeds.

For extension work, start with the matching shared contract and server authority in
[backend boundaries](backend.md), then the existing view and design system. Adding a
button alone cannot extend the source write allowlist or authorize a deployment.

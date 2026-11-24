# Database workbench

Open **Database** at `/database/schema` after `npm run studio`; `/database` redirects
there with history replacement. **Schema** combines authored
Prisma source and a navigable diagram. The other workspace routes are
`/database/history`, `/database/status`, `/database/sql` and `/database/retention`.
The parent stays mounted across these routes, preserving the Prisma editor, undo history
and draft. Back, Forward, reload and direct links select the same workspace.
Saved workbench source uses the repository-scoped TanStack Query cache (the default
five-minute inactive lifetime). Returning from another workspace renders it immediately
while rereading source, configuration and targets in the background. Focus and source
revision changes also refresh it; every accepted read rechecks migration history even
when the source text is unchanged. Refresh failures keep the editor and offer Retry.
Drafts and approvals remain owned by the guarded Database session. CodeMirror measures
its actual line geometry before its first visible paint and when revealed from a hidden
tab or layout, keeping line numbers aligned without retaining a hidden global editor.
**History & migrations** explains evolution and prepares migration artifacts.
**Database status** leads with readiness and the relevant next action, with technical
evidence under **Inspection details**. Development selects local PostgreSQL context;
Production selects RDS context using the production AWS connection. Selecting a mode or
route starts no database inspection or write. These workspaces share a source proposal without treating a diagram,
folder name or migration marker as another schema authority.

Legacy `/database#status` redirects to `/database/status`. Activity offers **Review local database**
when the local runtime's **Prepare local database** preflight fails (including older
**Verify local database** Activity records). Startup initializes proven empty local storage;
existing storage issues and pending migrations lead here. Inspecting and reviewing
remain separate from applying initialization or migrations; following this link performs no writes.

**Saved SQL** starts with a command list and **Create query** / **Create seed** actions.
A query starts with a read-only database metadata statement; a seed starts blank.
Command settings are disclosed on demand, parameters have named typed fields, and
returned rows use a bounded table. Drafts remain mounted across database routes.
Command switching and leaving the database workspace or browser protect edited SQL
drafts, including when the editor is hidden on another database route.
It reviews and saves reusable seed, backfill, operational and read-only
commands under `packages/database/sql/`, then separately reviews execution against
the resolved local PostgreSQL target. Parameters are bound values, file/target changes
invalidate approval, and durable redacted history distinguishes confirmed COMMIT,
acknowledged rollback, skipped once-only runs and uncertain outcomes. Source saving
never executes SQL. Production permits shared catalog/source editing; saved SQL execution
is local-only. Production retains the
existing versioned IAM/TLS migration-task boundary. See the
saved-command contract (`packages/database/sql/README.md` in the app).

**Data retention** follows the global declaration mode for the database. Development
leads with local volume persistence through stops, restarts and container rebuilds,
with AWS retention/recovery in an advanced disclosure. Production leads with deletion
policy and separately observed deployed protection. Destination inspection and
retained-resource recovery forms are disclosed when needed.
It reviews independent Database/Cognito policies in
`framework-config/deployment/stateful-resources.ts`, with separate development/production
choices and the existing `RETAIN_STATEFUL_RESOURCES` fallback for omitted settings.
Source saving never deploys protection. Deployed-template inspection and durable
teardown evidence are separate from configured intent. Compatible retained RDS
writers and Cognito pools have an explicit inspected reference workflow; import
and snapshot restore remain separate procedures. Development PostgreSQL uses its
independent `postgres_data` volume. See the [stateful lifecycle guide](stateful-resources.md)
for dependency protection, code-only commands, continuing costs and post-deployment
verification requirements.

The authored contract is `packages/database/prisma/contract.prisma`.
`packages/database/prisma.config.ts` owns the configured target, source, generated output,
migration directory and terminal connection input. Studio uses the installed Prisma 8
interpreter, serializer, schema differ, planner and migration runner; the application
continues to work through normal Prisma commands without Studio. Package versions remain
pinned and the runtime remains Rust-free.

## Authoring and navigation

The page starts with shared workspace route links; the help icon opens a centered modal with
a blurred backdrop. Escape or the close controls dismiss it and restore keyboard focus.
Links scroll horizontally in narrow windows and retain their normal control size,
keeping every workspace reachable without expanding the toolbar into several rows.
**Open in editor** sits in the Prisma source pane header. Source gets the full workspace
on first open. Choose a model or enum with **Jump to**, or open the diagram layout.
The tab bar and Schema editor keep the full-width workbench frame with 16px gutters.
History, Status, Saved SQL and Retention center their content in Studio's shared 1280px
document column, including its 16px side gutters. Saved SQL and retention forms use
Studio's standard control height, label spacing and surface colors; field actions
align with their controls and wrap at narrow widths. SQL source and execution remain
separate bordered groups, with review actions kept beside their relevant guidance.
The Prisma header owns saved/draft and validation status, with formatting, validation
and source review in its action row. Discard appears when the draft has changes. Editing
a rule in a popup or in the source uses the same draft and undo history.
Source, split and diagram controls share one fullscreen button in the diagram header;
they move to the source header in source-only mode. Fullscreen expands the current layout;
Escape or **Exit fullscreen** restores the previous layout and keyboard focus.
The workbench keeps the 16px workspace gutter on every side, in fullscreen too, where it
paints the paper background so the browser's black fullscreen backdrop never shows.
Tailwind 4 has no `fullscreen:` variant, so
style the fullscreen element with `[&:fullscreen]:` and its descendants with
`group-[:fullscreen]/workbench:`.
Diagram-only mode keeps source status, validation and review in the diagram panel.
Fullscreen keeps source review, validation and layout controls available
without resetting text, undo, diagram zoom or selection. It requires browser fullscreen
support. **Modified draft** in the pane header identifies unsaved changes without adding
content below the editor. Source review retains the saving and migration guidance;
history and database inspection live in their own tabs.
Source and diagram use matching, fixed-height status bars. The diagram footer keeps
counts and **Focus selection** beside **Schema details**, which opens selection metadata,
keys, relationships, enums and capability notes without resizing either pane. Escape or
the close control dismisses those details and returns focus to the trigger.

Drag the separator, or focus it and use
Left/Right; Home/End select the supported width limits. Diagram search, focus, zoom and
fit remain independent from the source proposal. Tables form foreign-key relationship
neighborhoods, labeled by their central model, with variable-height cards packed to the
available canvas shape. These groups are computed navigation aids, not authored domains.
The diagram opens fitted at **100%**, meaning the complete schema rather than native
CSS scale. The percentage button, **Fit schema** and **0** restore that overview, including
schemas too large for the former minimum scale. A fitted overview follows pane/window
resizing; manual pan and zoom remain under the reader's control.
Selecting a field or relationship locates
its Prisma range; moving the editor cursor identifies its model, column or relation.
Drag or scroll anywhere in the diagram to pan, including when all tables already fit.
Arrow keys pan the focused canvas; +/− zoom and 0 fits the whole schema. Trackpad pinch or
Ctrl/Cmd+scroll zooms around the pointer. **Focus selection** centers the selected table,
dims other tables and keeps direct relationships more prominent; selecting another table
follows it. If nothing is selected, focus waits for a selection. Framing leaves
space around the table for the available viewport. Pan and zoom remain available while focus is enabled. **Schema details**
includes these navigation instructions.
The diagram distinguishes logical model/field names from mapped PostgreSQL tables/columns
and displays keys, indexes, nullability, defaults and referential actions.

CodeMirror provides text selection, indentation, undo/redo, search/replace, multiple
selections, bracket matching, folding and a theme using Studio's light/dark colors.
Selection backgrounds belong to the scoped CSS adapter, so a mounted draft receives
contrast fixes without replacing the editor extension or losing undo history.
Ctrl/Cmd+F uses the browser’s Find command. Ctrl/Cmd+H opens editor find and replace,
Ctrl/Cmd+S opens source review,
Shift+Alt+F formats, and F12 navigates a local definition. Tab indents; Escape then Tab
leaves the editor. Completion and contextual help provide syntax and local-name
suggestions. They are not a semantic language server: cross-project references, semantic
completion and safe rename are unavailable. Use **Open in editor** for those workflows.

Validation is debounced and cancellable, and uses Prisma's configured interpreter on the
exact draft. Diagnostics carry codes and UTF-16 source ranges; selecting a diagnostic
locates it. Formatting uses the installed Prisma formatter and is one editor undo action.
Validation and formatting neither write source nor emit artifacts nor query a database.

Temporarily invalid source remains editable with its selection and undo history intact.
The last valid diagram stays visible with an explicit retained-schema notice; it cannot
be mistaken for the current draft or used for current-source navigation. Valid constructs
outside the diagram's projection remain in source with capability explanations. Source is
never regenerated from a lossy diagram representation.

The GraphQL workspace reuses this same PSL parser pass for a separate logical review
projection. It includes relation back-references and referenced enums while excluding
indexes and physical mappings; this does not change diagram projection or database
validation. Unsupported review syntax remains Unknown on the contract chain. Emitted
artifact freshness remains the independent Database evidence described below.

**Review source changes** validates and presents the complete before/after source.
**Save schema** writes only that reviewed Prisma file after rechecking source and config
revisions and validation. Comments, mappings and unsupported constructs are ordinary
editor text. An external edit preserves the draft and offers loading saved source or
reviewing the draft against the latest baseline. Navigation and browser exit protect
unsaved text. Discard, source undo and database rollback have different effects: editor
undo can recover text during the session; no database rollback is implied.

## Access

Access Graph authoring is optional. For schemas without Access Graph policy, model
headers stay plain. Open the Access inspector to see **No Access Graph policy declared**.
Application resolvers and repositories own API exposure and authorization for those schemas.

**Interactive** shows valid access directives as badges. Model and enum rules stack
above the declaration, and field badges appear inline. A role value's own settings
(`protected`, `...LOWER`) appear as quiet annotations, aligned in one column after the
enum's widest value. Put the caret inside a rule's source, or directly after its badge
(End on its line), to show and edit the authored text; moving away folds it again. Switch to
**Comments** to edit the highlighted authorization syntax directly. Click a badge or
press Ctrl/Cmd+. in **Interactive** to open an access popup. Put the caret at the end
of an eligible declaration without a trailing comment. **+ Access** appears once the
draft passes validation. **Configure access** applies a validated edit to the draft.
Source links open the underlying rule for editing.

Click **Role permissions** beside a role enum to open its popup, or enable **Inline matrix**
on its declaration to replace the stacked permission badges with the table. Inline, the
table is those rows' rendered form: one code line per permission, in the rows' role tint,
with the source's exact role names; it scrolls inside its block on narrow panes. Each
enum-level row, ability or CRUD action, links to its holder list. Toggling a cell stages an undoable edit to one role.
Clearing its last holder leaves the permission in the draft as `[]`. Faint checks show
grants inherited through role inclusions. **Jump to** keeps the caret on the declaration
and scrolls its leading comments and rules into view. A field's read and write details link to its individual directive
or the shared model-level `fields(…)` rule. GraphQL table registrations appear at the model
level when the saved inventory and generated schema agree.

**Preview with sample data** uses the authorization engine and synthesized rows to explain
policy decisions. The diagram shows relationships and access edges from the compiled policy.
Syntax colours, scope rails, hover, completion and F12 help navigate the source. Use
Ctrl/Cmd+Alt+F for editor Find. Ctrl/Cmd+F remains available to the browser.
**Review source changes** reports the policy impact before **Save schema** applies the draft.

See [Prisma access](../PRISMA-ACCESS.md) for the directive grammar, generated policy, and
runtime boundaries.

## What the evidence proves

| Representation | Identity and evidence |
| --- | --- |
| Unsaved draft | Exact editor text, local version and validation source hash |
| Saved authored contract | File-content revision and installed Prisma semantic interpretation |
| Emitted contract and migration graph | Configured generated JSON's observed content revision and verified storage/execution identities, plus independent package hashes, graph edges, refs and semantic snapshots |
| Database migration state | Selected target's observed marker and application ledger, with application timestamps |
| Physical database schema | Prisma strict schema verification against saved storage and, when available, the marker's historical contract |

Draft differences do not imply that saved source changed. Execution defaults can change
with no storage SQL. A saved contract at a graph tip does not establish a database's state.
A matching marker alone does not prove physical compatibility. An observed database may
match a known historical contract and have a pending forward path; a difference from saved
source then has a migration explanation. A mismatch with its verified marker contract is
physical drift within Prisma's modeled surface. Missing/inconsistent markers, incomplete
history, connectivity failures and unsupported inspection remain explicit uncertainty.

Workbench loading separately reads the generated JSON output named by Prisma's actual
configuration. The configured target serializer and canonical storage/execution hashing
check its integrity before comparing it with saved source. The browser receives only
status, safe file label, content revision, observation time and semantic hashes, never
the raw generated contract. Missing, invalid, inaccessible and outside-checkout output
remain distinct from a match. This check neither regenerates files nor proves generated
TypeScript, repositories, GraphQL or frontend consumers are current; their normal
generation/typecheck/test workflow remains necessary.

Every observation records target identity, source/history revisions, baseline and time.
Source, target or history changes invalidate evidence. Superseded asynchronous results
cannot replace a newer draft or another target's observation. Physical-schema compatibility
does not prove data correctness, backfill completion or downstream application compatibility.
Views, triggers, functions and other objects outside Prisma's supported comparison surface
need separate review.

The local target resolves the existing literal Compose PostgreSQL binding and configured
loopback port. Operational-only overrides preserve it; connection-changing overrides use
read-only `docker compose config` resolution and require a unique loopback-only binding.
Missing or ambiguous effective configuration remains unavailable. Connection values stay
server-side. Inspection enforces a read-only session and never starts Compose. Local startup
initializes proven empty storage and verifies existing storage; migrations, orphan cleanup
and test identity setup are separate actions.
Production RDS uses the existing VPC `db-migrate` task with private-database IAM/TLS access. Select the named production
deployment and AWS profile, then **Check database task destination** to read AWS metadata.
Studio verifies the pinned account/region, stable tasks stack and stack-owned task definition.
An old task lacking reviewed protocol v1 is a deployment prerequisite, never launched for
inspection. The destination dialog displays the exact task ARN/revision, cluster, subnets,
security groups, public-IP assignment, CloudWatch destination and billing effects. The task
uses its declared VPC networking and may receive a public IP; the database remains private
and IAM/TLS authenticated. Preparation and application bind the full resolved launch/log
descriptor; changed placement, cluster or log routing requires a new review.
Type **Inspect &lt;deployment&gt;** to authorize one billed Fargate read-only inspection task.
No task starts merely from selecting a target, refreshing or preparing its destination.
The declaration mode selects the visible local or production context. Every execution
review still names its exact destination; switching modes invalidates pending reviews
and never starts or retargets a task.

## History and migration planning

History starts with named migrations and operation summaries. Selecting one reveals
schema changes and SQL. Application status requires a current matching database
observation; files alone never establish application. Hashes, graph references,
snapshots and arbitrary contract comparisons live under **Advanced history details**.
History reads metadata, `ops.json`, `migration.ts` as text and content-addressed snapshots
under `packages/database/prisma/migrations/`. Each migration is a graph edge from one
storage hash to another; a null origin means empty storage. Creation time is displayed
separately from database application time. Branches, incomplete packages, invalid metadata,
missing or modified snapshots, modified emitted operations and refs outside known history
stay visible. Browsing never executes migration code or changes refs.

Legal side branches and cycles do not block an otherwise unique path from the local
database marker to this checkout's saved contract. Competing simple paths to that exact
destination remain a local application refusal until their routes are reviewed and
resolved. Missing snapshots and package integrity problems still block application;
switching branches never automatically rewinds a database or chooses a route by date.

Select an edge to compare its before/after contracts, or compare historical, saved and
valid draft contracts. Prisma's serializer hydrates snapshots before the official schema
tree differ compares physical entities. Domain and execution changes use canonical emitted
contracts, preserving the difference between logical mappings and physical storage.
Snapshots preserve semantic contracts; they do not preserve historical authored Prisma text
or comments. Metadata/operation hash verification also does not prove that edited
`migration.ts` still matches its last self-emitted operations.

To create a migration, save the intended source, choose **Plan migration**, name the
change and explicitly select its intended historical baseline. A graph tip is a navigation
hint. Studio never guesses the newest folder, an abandoned snapshot or an unknown database
origin. An empty baseline is offered for a new migration graph.

Pinned Prisma runs `contract emit` and `migration plan` in a disposable source copy with
the same bounded authored configuration dependency closure used by validation. Imported
local helpers participate in review identity; changing one expires artifact installation.
Private environment inputs and dotenv files remain excluded. The review contains the actual proposed TypeScript,
metadata, operations and snapshot bytes. A no-op storage plan is a valid result. Required
fields, narrowing changes or data transformations may produce placeholders and incomplete
emitted operations; fill `migration.ts` and self-emit through the supported terminal workflow
before applying. Review drops, constraints and backfills deliberately.

**Save migration package** installs only reviewed new artifacts, with source/config/history
revision checks and exclusive creation. Existing packages are never rewritten. Caught
installation failures remove only unchanged files created by that attempt; concurrent edits
are preserved and reported as unconfirmed. This is compensating restoration, not a durable
multi-file crash transaction. Planning/review is ephemeral and expires after 30 minutes.

Restoring an old design means authoring a new source proposal and an appropriate forward
migration. Previously applied packages remain immutable. Git source history, if consulted
separately, is not Prisma migration or database-application history.

## Deliberate effects and progression

| Action | Reads | Writes |
| --- | --- | --- |
| Validate / format / compare | Draft, saved config and selected semantic baselines | In-memory draft only for formatting; no checkout or database writes |
| Review / save schema | Exact source proposal and file/config revisions | Saving writes only `contract.prisma` |
| Plan migration | Saved source and explicitly selected migration origin | Disposable workspace only |
| Save migration package | Reviewed actual artifact bytes and current source/history identities | New migration/snapshot files only |
| Inspect database | Selected private target, saved contract, marker, ledger and modeled schema | No database or source writes |
| Review database application | Current target evidence and Prisma's canonical pending path | In-memory approval only |
| Apply reviewed migration | Target-bound approved path, source and all package byte checks | Selected local database storage, data transforms, marker and ledger |

The normal progression is edit → validate → review/save source → generate and assess
application artifacts → plan offline → review SQL/data impact → save migration package →
inspect/review the target → explicitly authorize application → inspect the result.
`npm --workspace @repo/database run generate` emits application artifacts separately.
Repository, GraphQL, authorization, writable-field and frontend changes follow the
[data-feature automation contract](../playbooks/typed-contract-propagation.md); Studio
never invents CRUD behavior or automatically exposes a new field.

**Review changes** compares the draft and saved Access Graph policies before saving.
It shows changed scope paths, role masks, named grants, protected enum values, action
caps, guards, field identity conditions, field protections, and
which descendants inherit a changed rule. Policy changes appear even when the Prisma
storage and execution hashes stay the same. Read eligibility describes the compiled
policy. Published fields and operations can be checked in the GraphQL workspace.

Local database application requires an intact history, a known marker, a physical schema
matching that marker's historical snapshot and a canonical pending path to saved source.
Review shows the selected packages, SQL and migration source. The approval is single-use,
expires in five minutes, and requires typing **Local PostgreSQL**. Immediately before
execution, Studio rechecks connection identity, source/config/history and migration bytes,
marker, baseline and path. The complete reviewed marker and ledger identities and strict
historical physical schema are checked again inside the writer transaction under Prisma's
migration locks, before any migration DDL. Observed marker, ledger or schema changes
invalidate the review even when its storage hash stayed the same. These advisory locks
coordinate Prisma migration callers; manual SQL must not run alongside a reviewed
migration. Prisma's runner executes the selected migrations and records
their application; migration code can transform or delete data. No reset, direct schema
synchronization, signing, repair or ref advancement is offered as an automatic recovery.

For a marker-less target, **Review empty database initialization** separately verifies the
absence of application objects (including views, functions, enums, sequences, extra user
schemas and large objects), previews every native initialization statement/parameter plus
Prisma control-table DDL and requires typing **Initialize Local PostgreSQL**.
Emptiness, source, target identity and exact native plan are checked again inside the writer
transaction under canonical migration/initialization locks before any DDL.
Unknown populated databases are never adopted, reset or automatically signed.

Ordinary local startup also uses this guarded native initialization for a proven empty
Compose database, then verifies the saved contract. It does not execute migration packages
against an existing database. The separate workbench review remains useful for explicitly
inspecting and initializing empty storage before starting application compute. Production
initialization always retains its own destination-bound review and approval.

Source/artifact effects, database execution and refresh are reported separately. An
inspection failure after successful application does not undo it or justify repeating it.
An interrupted/failed execution can leave unconfirmed database effects; inspect and review
the target before retrying. Redacted operation records survive restart and show execution
stage, reviewed package names, stable error codes, SQLSTATE when available and confirmed
results. A dead process's running record becomes interrupted and never resumes a write.
An exclusive local operation lock prevents concurrent Studio processes from applying in
the same checkout. This release's offline suites exercise pinned parsing, diffs
and planning; local live runner behavior requires a deliberately disposable PostgreSQL
integration test and explicit authorization before use against application data.

The opt-in Compose lifecycle regression creates a random labeled PostgreSQL project,
executes Studio's actual reviewed initialization, saved SQL and forward migration,
then replaces compute while retaining its volume and checks original rows, marker,
physical schema and once-only ledger. It also verifies stale reviews, drift refusal,
constraint rollback, read-only denial, rejected retained credentials and unavailable
storage. It removes only that invocation's independently labeled containers/volume;
it never uses the ordinary `postgres_data` volume. With Docker running, explicitly
authorize the disposable run using:

```sh
STUDIO_DATABASE_LIVE=job3-disposable node --conditions=development --import tsx --test client-app/test/database-lifecycle-live.test.ts
```

Unset inherited `POSTGRES_HOST_PORT`, `FRAMEWORK_STUDIO_STATE_DIRECTORY` and
`COMPOSE_FILE` before running it. The test refuses these overrides before setup
so target resolution, operation history and Compose cannot escape its own fixture.

This is real local service/driver evidence. Browser acceptance, application recovery,
RDS IAM/networking, CloudFormation import and snapshot restoration remain separate.

Production inspection reads metadata, marker and ledger through a session forced read-only;
it returns canonical pending packages, SQL and executable source in bounded, correlated
CloudWatch envelope chunks. Review binds the image's authored config/migration inputs,
full marker-map and ledger identities, SQL, account, region and exact task definition.
Literal relative migration helper imports are included in source currency, image copying
and preview; computed imports and workspace aliases are refused until made explicit.
Type **Apply &lt;deployment&gt;** separately to launch the reviewed write task. The task rechecks
source, exact pending edges and review digest, then acquires the pinned canonical runner's
PostgreSQL advisory transaction locks and rechecks marker/ledger and strict historical
physical schema on that same connection before any DDL. These locks coordinate Prisma
migrations, not arbitrary external SQL clients. Schema verification has the same modeled
storage limits as local inspection. A marker-less production target has a distinct reviewed
initialization path only when the metadata-complete empty proof and absent marker/ledger
succeed. It previews all native precheck/execute/postcheck SQL and parameters, plus canonical
control-table DDL, and requires typing **Initialize &lt;deployment&gt;** before a second task.
The initializer captures complete canonical runner inputs using a replacement runner on
the forced-read-only connection; no real writer runner is constructed during inspection.
Presentation-only DDL previews never authorize execution. The writer binds the full native
operations digest, rechecks exact additive SQL and emptiness under its transaction locks,
and refuses changed parameters, checks, non-DDL operations or occupied storage. No migration
graph is needed for a genuinely empty app schema. Populated or partially initialized unknown
storage is never adopted/reset. Source undo never rolls back database data.

Cloud tasks persist a redacted pre-submission record before launch, then task ARN, client
token/started-by ID, destination, CloudWatch group/stream and terminal result. Missing chunks,
unexpected task versions, timeouts and transport loss cannot establish write success; a
submitted task can continue after Studio closes. Inspect the exact recorded task and database
before requesting another write. If no ARN returned, locate it with ECS `list-tasks
--started-by <requestId>` in the recorded cluster/profile/region. No task is automatically
retried or cancelled. Confirmed application remains applied even if local journal refresh fails.

Operation journals live in `.cache/framework-studio/database-operations/` (or the configured
Studio state directory), with fsynced atomic records. Unreadable records are explicit unknown
outcomes, and unresolved records remain visible beyond newer inspections. An existing
`active.lock` is never removed automatically. After inspecting the database/ledger or cloud
task, proving its owner stopped and deciding an appropriate recovery, an operator can preserve
the journal and remove only that stale lock. Never use lock removal to run concurrent writes.
The checkout lock does not coordinate other checkouts; the database-side Prisma/advisory
initialization locks provide the cooperating-database boundary.

## Implementation ownership

- `src/database-session.ts` owns draft text/revisions, request generations, conflicts,
  last-valid diagrams and observation acceptance; `PrismaEditor.tsx` owns editor state.
- `packages/aws-studio/scripts/contract-chain/database-contract-source.ts` owns configured, output-free Prisma compilation
  and emitted storage/execution integrity comparison, shared by Database and restricted
  contract-chain verification. `server/database-workbench.ts` retains formatting, fixed
  source review/save and private target resolution/read-only database observations.
- `server/database.ts` projects syntax into diagram entities with source ranges, including
  each column's `@access` setting and each table's row access sentence.
- `packages/aws-studio/database/access-syntax.ts` provides the shared directive parser and source
  spans. `access-graph.ts`, `access-rules.ts` and `client-access.ts` validate and compile the
  policy used by the editor, diagram, Contract Chain and generated runtime artifacts.
- `server/database-history.ts` owns tolerant graph/snapshot discovery, canonical semantic
  comparison and disposable, reviewed migration-artifact planning/installation.
- `server/database-application.ts` owns separately reviewed local execution through the
  canonical Prisma path and runner.
- `packages/aws-studio/database/empty-database.ts` shares metadata-only emptiness checks with the VPC task; `server/database-operations.ts`
  persists redacted effects and the cross-process application lock without replaying writes.
- `server/database-sql.ts`, `shared/database-sql.ts` and `src/views/DatabaseSql.tsx`
  own reviewed repository commands, local transactional execution and redacted SQL history.
- `src/views/DataRetention.tsx` presents the existing deployment input policy with
  explicit environment, source review and recovery limitations.
- `server/database-cloud.ts` and `src/views/DatabaseCloud.tsx` own explicit cloud preparation,
  task inspection/application, typed approvals, outcomes and recovery evidence. The task's
  `review-task.ts` and `packages/aws-studio/database/studio-migrations.ts` own the versioned
  read-only/reviewed-write protocol and pinned runner guard.
- `server/server.ts` exposes the existing loopback/session/same-origin guarded APIs.

Generated application artifacts, Prisma configuration and framework declarations keep their
existing owners. Source-review and application approvals live in memory; restarting Studio
expires them. There is no durable browser-draft recovery. Saved SQL commands are
bounded and local-only; there is no arbitrary-connection or production SQL console.

## Prisma access controls

**Access** opens the compiled policy for the current Prisma declaration. The inspector
links scopes, grouped or individual field rules, and named permissions to authored source.
Role edits stage validated changes in the same draft. Policy review reports effective
changes even when storage is identical. See [Access](#access) for the controls and
[Prisma access](../PRISMA-ACCESS.md) for the policy grammar and enforcement.

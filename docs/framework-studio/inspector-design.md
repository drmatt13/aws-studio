# Inspector interaction system

Studio is a visual control room. Inspectors should answer what an item is, where it
runs, and what can be changed before asking the developer to read implementation detail.
The shared tokens live in `client-app/src/styles/theme.css`; native controls
live in `src/ui/`. Tailwind panel/dialog recipes live in `src/inspector-ui.ts` and
section/disclosure/switch implementations in `src/views/InspectorUI.tsx`. Isometric and Database use the same inspector.
The [editing architecture](../aws-studio-knowledge/studio/editing.md#inspector-module-ownership)
locates entity/trigger rendering and session ownership; the [source map](../aws-studio-knowledge/REPOSITORY-MAP.md#where-to-change-studio)
locates implementation and tests for common changes.

## Conventions

The title's compact Rename action opens an inline header editor without adding a new
Inspector section. Supported inputs and groups show Code name first, followed by an
optional Display name disclosure; other resources edit their display label and explain
where code identity is owned. Keep the identity → Description → Tags order. Enter
finishes editing, while Escape restores the naming state captured on opening and
preserves other pending settings. Both actions leave source application to Review
Changes → Apply All. Show the resulting caption separately from its actual code
reference. A custom display name survives code renaming; clearing it restores automatic
naming. Search matches both, including duplicate display labels. VPCs reuse their
existing authored network name rather than gaining another label authority.

Deployment information follows the resource's actual configuration authority:

| Family | Deployment control |
| --- | --- |
| HTTP, WebSocket, authorizer, event and tool Lambdas; services, tasks, workflows, agents | Deploy lives in Settings; each input's requirements live in Configuration and inputs; review validates both environments |
| Tool with no authored override | Inherit follows consuming agents; explicit Deploy overrides it |
| API gateway, stack member, network component | Header pills explain availability; activating a pill exposes ownership and navigation to handlers, stack or VPC |
| Catalog input, secret or group | Header pills show declaration availability; groups summarize how many entries are declared. Entries retain their own pills. Sources, requirements and consumers explain delivery |
| Native/framework stack, managed database, VPC island | Header pill details explain ownership and offer navigation; no ineffective independent workload flag |
| CDK/client environment file and input/environment islands | No Deployment section; CDK environment files holds one Framework managed CDK environment; Client environment files holds client mappings without an ownership badge. Each CDK variable row edits both files' values side by side |
| Other grouping islands | Header pills count enabled entries per environment; entries remain individually configurable |

Every resource inspector uses the compact Dev/Prod pair in its top-right type row instead
of a separate Deployment section. Hover or keyboard focus shows execution/declaration
information and ownership notes. Moving between Dev and Prod replaces the tooltip immediately
and supports repeated return hovers without dismissal or clicks. Click, Enter, Space or tap pins the details in a small
popover with owner navigation. Escape closes details without closing the inspector; closing
pinned details restores the invoking pill's focus. Popovers stay within the viewport,
use 44 px pill targets on touch screens, and open without reading environment values.
Details use a compact floating card with the pill's environment tint and a fine illuminated
top edge. A Dev or Prod heading precedes the same runtime and placement summary as the map
hover card. Supporting ownership notes and navigation appear only in pinned details.
Pills describe configured availability, never observed deployment or runtime health.
Inferred ownership is text with owner links, never a disabled Deploy selector.

In **Configuration and inputs**, each environment-linked input or secret has a
**Requirement** disclosure with Dev/Prod pills. Expanding it edits Required or Optional
independently for Development and Production, and shows existing conditional requirements.
An input declaration's Required setting is inherited and cannot be weakened by a workload.
Changes stage in the shared source review; changing one environment preserves the other.
Workload-only missing values mark the workload and its input connection. The environment-file
supply connection and input resource use only the input declaration's own requirement.

Framework ownership uses the same framed lock and **Framework managed** label directly
after the inspector's identity block (its name and identifier). Keep type labels factual, such as PostgreSQL database;
ownership is a separate badge, not a replacement type label. Every badge renders through
`OwnershipStatus`, which reads the server's `ModeModel.ownership` projection; no view derives
ownership from resource flags, names or kinds. A platform-maintained resource shows **Framework
managed**. Developer-owned resources use the usual header. The badge tooltip, map lock and hover
card use the same ownership fact. A framework export stack can appear without an application
`stack()` declaration. Its inspector explains what an application reference enables.

The **Ownership** disclosure identifies the maintainer, explains how Studio recognized the
resource, and lists any integration. Project-backed declarations support reviewed changes of
ownership. A mode conflict shows the competing declarations and keeps the shared definition
protected. [Ownership rules and enforcement](../aws-studio-knowledge/studio/editing.md#ownership)

Grouping islands carry no owner record; a grouping does not own its entries' infrastructure.

`shared/framework-management.ts` owns classification. Map icons, inherited resource
status and hover cards use the same rule. Managed map resources carry the mini lock, and
endpoint service artwork keeps its own badge with the lock in the other lower corner. An
issue (`src/issues.ts`) replaces the map lock: the problem's badge takes the right corner
alone, while hover cards and inspector headers still state ownership. Picking and layout
geometry include exactly the painted badges. Absence from the selected mode
dims the whole icon, including its ownership context, without changing ownership.

Every island inspector ends with one **Island entries** disclosure, after its controls
and supporting sections. Environment-file islands use the same entry navigation;
do not add a separate Files list.

Workload headers list **Declared in** and **Implementation** as facts in the header's shared
label column, with compact editor links. Healthy implementations add no separate section or
status copy; missing-source warnings and starter-file repair stay together in the header.

Resource **Logs** follows the immediate identity and deployment context,
before Permissions, Settings and other supporting disclosures. Keep it collapsed until
opened and use the same placement for every resource with a log view.

Choosing **Only when an input matches…** shows a collapsed **Condition** disclosure
directly beneath Deploy. Its input, equality value and environment results stay inside
that disclosure; validation errors remain visible when it is closed.

CDK environment variables use compact, bordered input-group disclosures that start collapsed.
Headers share a 44px minimum target, show variable counts, and retain compact framework
ownership badges and missing-required-variable counts while closed. Descriptions and editable
variable rows live inside the expanded group; standalone variables remain ungrouped. Search
and missing-value filters open matching groups temporarily and restore manual expansion when
cleared. Variable links open both their group and value row before focusing the target field.
Native CDK construction remains source-owned. A catalog presence change must never be
presented as an AWS deployment switch. Event deployment changes omit optional native
hooks on the next deployment, and the source review calls out that effect.

| Element | Convention |
| --- | --- |
| Panel | 380–480 px on desktop; bounded split view on narrow screens |
| Scrolling | One content region, with close and draft actions outside it; a fresh destination starts at the top, while returning restores its position |
| Type | 20 px item titles, 14 px body, 13 px labels, 12 px captions; monospace for identifiers and source |
| Spacing | Shared 4, 8, 12, 16 and 20 px tokens; 20 px panel gutters |
| Controls | 32 px inputs/selects, actions and icon actions, 24 px supporting disclosures; shared On/Off switches for boolean settings, checkboxes for acknowledgements and multi-selection; 44 px control targets for touch |
| Sections | `InspectorSection` for immediate context; `InspectorDisclosure` for grouped controls and supporting information |
| Forms | Stacked label → control → support on one left edge; units inside their input; visible error messages; semantic `FormGroup` boundaries |
| Color | Existing theme surfaces; teal/violet for environments, accept/refuse colors for validation |

Links inside an inspector extend a contextual return path. **Back to langgraph**, for
example, returns from an input to the group that opened it. The same control serves
routes, handlers, stack fields, connection endpoints and island entries, including the
standalone inspector outside the map. The map panel also offers **Resources**, which
returns to the original list row with its search, type and scroll retained. A new map or
list selection starts a new path; direct links without a predecessor fall back to Resources.

Contextual Back retraces browser history. Back and browser Back/Forward restore each
visit's scroll, disclosure states and triggering control focus. A fresh destination opened
inside the panel focuses its Back control; direct map selections keep map focus. If the
original focus target is unavailable, use the Back control. Navigation only becomes part
of the trail after the existing unsaved-edit guard accepts it; **Keep Editing** preserves
the current visit and draft.

`src/inspector-navigation.ts` owns this presentation memory, shared through `StudioProvider`.
It is limited to 200 accepted visits, with separate presentation state per source mode,
and expires with the mounted session. Store structural focus locations, open states and
scroll only; never retain form values, drafts, secrets or detached DOM nodes in the trail,
URL or browser history state.

Controls share horizontal padding and a single select-arrow treatment: a 14 px chevron
inset 12 px from the edge, with 10 px between text and icon. Native selects retain keyboard
behavior and return to the platform arrow in forced-colors mode. Focus uses an outline
without changing control geometry. Component styles should not reset shared control
padding, backgrounds or arrow placement.

Field dividers keep 12 px of vertical padding; deployment controls use an unruled 16 px
gap inside Settings. Value fields stack label, control and support at every
width, 4 px apart on one left edge, so a field never switches grammar between a wide and a
narrow panel; a boolean keeps its label and On/Off switch centered on one line. Numeric units
(`UnitInput`) sit inside the input's trailing edge, where a select draws its chevron, and the
accessible label names the unit. Defaults, reset actions and provenance share the support row
beneath the control. At panel widths up to 420 px, mapping actions wrap and primary dialog
actions use the full row. Long labels and source references wrap;
selected options reserve their arrow space and truncate within the control.
Container queries apply the same behavior to a narrow inspector beside a wide map.
Local values use `InspectorSection`, including its 20 px gutters and separator in
loading, missing-file, error and editable states. Keep the environment caption in the
heading, then group the variable name and destination above the status and value control.
Input behavior gives each environment one card, using its environment tint,
icon and dotted absent edge (`environmentCardClasses`, `EnvironmentName`): Present, Required
and the default or value sit together under Development or Production, and checkboxes take
their environment's color. Cards sit side by side and stack below 360 px. Secret and Group
each have their own ruled settings group with nearby help.

Vertical rhythm follows the relationship, not a single gap:

| Relationship | Gap |
| --- | --- |
| Name → its identifier in a header | 2 px, in the name's text column |
| Identity block → ownership badges → header facts | 10 px each; badges 6 px apart when stacked |
| Header facts (type, group, source lines, generated files) | 24 px pitch, one 88 px label column |
| Label → control → support | 4 px |
| Section or group heading → its description | 4 px, in the title's column beside any heading action |
| Heading or introductory copy → controls, lists or an action group | 12 px |
| Action → the note that qualifies it (`inspectorActionGroupClasses`) | 8 px |
| Fields and list rows | ruled, 12 px (fields) or 10 px (rows) each side |
| Sections | rule and 16 px padding |

Lists of resources lead each row with the 26 px `EntityIcon` tile: group and island entries,
triggers, failure destinations, permissions and workload access, gateway tools, agents and
routes, an agent's gateways, a WebSocket authorizer, stack public fields, and input-group
readers and environment file sources. Connections keep their text rows. `InspectorResourceRow`
centers the icon, title and trailing badges or icon actions on one line and aligns metadata
beneath the title. The title names, and links to, the resource the icon depicts; a trigger's
event, a route's path, a permission's operation or a destination's retry policy is metadata
(the event, path and operation still open their connection or route). Dotted identifiers
(`DottedName`) wrap after a dot before breaking inside a name. Change and remove are icon
actions at the row's trailing edge, as is reordering an agent's gateways; a staged removal strikes
the title through and offers Restore.
A permission row opens, so it is an `InspectorDisclosureRow`: the same icon, title and metadata
geometry as its summary, with a hover wash and no marker. An explicit IAM policy is one of these
rows with the IAM tile, never a bare disclosure. Opened evidence uses the shared `PermissionFacts`
block (`Authorization.tsx`) for both grants and policy statements, and the row closes with
caption-size links (`inspectorRowActionsClasses`). A staged addition is an `InspectorResourceRow`
with its status beneath the title and **Undo** at the trailing edge. Saved and staged rows share
one list, so rules fall only between rows.
Add access, Add caller, Grant access and Add input lead their expanded section from its left
edge (`inspectorEditorActionsClasses`); an alternative path such as **Manual IAM** is a caption
link beside the action. Staged-edit forms (`inspectorEditorClasses`) space their groups 12 px
apart, use `inspectorLabelFieldClasses` for a label that wraps its control, and end with commit,
Cancel and any alternative link on one wrapping line.
Production placement stacks VPC and Subnet with the placement's explanation beneath the last
select; the selects already state the VPC and subnet, so the note restates them only for a
read-only placement or, as the saved placement, while a different one is staged.

Client mapping rows put the identifier and rename/remove actions on one grid row,
with Dev/Prod badges below the identifier. Split-source previews use a small environment
column beside wrapping expressions. Expanded editors separate Development and Production
with a rule. Inactive environment labels remain readable; use the neutral supporting-text
color rather than treating declaration absence as a disabled control.

Field rows own their first/last padding through `inspectorFieldRowClasses`; section
containers do not style fields by `data-slot`. Header source lines and generated-file
metadata are header facts (`InspectorFacts`): a fixed label column, a 12 px column gap and the
24 px caption pitch, without negative trailing margins.
Public-field types are row metadata beneath the field name and wrap there. Route tag ownership help belongs inside the Tags section;
explanatory copy never sits outside a section's gutters. Tag controls share the normal
field height, identify invalid keys/values, connect validation messages to their inputs,
and return focus to a remaining row or Add tag after deletion.
Boolean setting rows keep their label and right-aligned switch on the same line at all
widths, with room for long labels to wrap. `InspectorSwitch` in `InspectorUI.tsx` owns
the existing On/Off appearance, accessible name, checked state and native button keyboard
behavior. Workload/default, VPC, database, input, client mapping and creation controls
reuse it while retaining their existing draft, validation and disabled behavior.

VPC interface endpoints use `InterfaceEndpointPicker` in both the network inspector and
creation form. Selected endpoints remain visible as removable service chips. **Add services**
opens a searchable dropdown with AWS service/family artwork, friendly names, exact endpoint
IDs and a visible selection mark. Search and selection stay in place for choosing related
variants such as `ecr.api` and `ecr.dkr`; Escape closes only the picker and restores its
toggle's focus. Arrow keys move through results. The catalog comes from the framework's
CDK-derived list in each mode's snapshot; artwork is presentation metadata and never a
second service allowlist. S3 and DynamoDB gateway switches remain separate. Keep billing
help visible; the catalog does not verify regional service availability.

## Information order

Workload **Implementation** shows the configured directory, artifact readiness and an
editor link. **Create missing starter files** stages a review; it does not immediately
write, start or deploy anything. Existing code stays intact. **Permissions** is always
available as a collapsed section, including on new workloads. Expanding it reveals
**Add access**, which opens a searchable configured-resource
picker with existing service artwork; selecting a destination reveals only its supported
actions. Services and calls precede configuration inputs. Queue permissions omit bucket
scopes; bucket permissions start with a bounded object-key scope. Saved entries name the
destination and operation; exact supported removals and staged additions have Undo.
Permissions are IAM grants unless labelled otherwise, so neither rows nor the **Authorization**
heading carry an "IAM grant" badge; only the exceptions (**Local connection**, **User token**,
**Source evidence**) are labelled, by `AuthorizationBadge`.
**Incoming access** separates other principals from the workload's own grants, including
callbacks and pull triggers whose IAM ownership differs from the graph arrow. Tasks,
workflows and agents offer **Add caller**; resource inspectors offer **Grant access**.
These entry points share the same source draft and reviewed writer. Workflow-owned
access remains defined by its steps. Call bindings show the runtime helper to use in
the handler; generated descriptor keys are not configuration instructions.

The picker supports search, arrow keys, Home/End and Escape. Escape returns focus to
the opening control. Unavailable resources retain their reason; duplicate grants compare
the exact method and object scope. Internal AWS graph state does not rename an IAM grant.
Native method expressions belong under Configuration, while connection titles name the
operation and resource. **Remove workload** is a separate supporting disclosure. Source removal
reviews dependencies and an implementation archive, with an explicit explanation that
deployed resources and their costs require a separate operation.

Every inspector opens the same way: the identity header, then its **Description**, then a
compact **Tags** disclosure wherever the selection has tags. This holds for workloads, routes,
catalog resources, gateways, databases, islands, fixtures, environment files and single
connections, so Description sits in the same place whatever is selected. A bundled connection
has no description of its own; each row leads with its relationship's description instead.
Framework-built stacks and the API gateways they hold edit Tags like any stack; the editor
writes `stacks` in `framework.config.ts`.
Workloads and routes place the shared deployment controls (`src/views/Deployment.tsx`)
inside **Settings**; infrastructure keeps its availability and ownership in header pill details.
Catalog inputs, secrets and groups proceed directly to their input settings.
Tags show their effective count without opening the editor, and retain **Modified** or
**Needs attention** on the collapsed heading while a draft exists. Supporting disclosure
headings use a 32px target with 8px vertical padding on each side and the shared panel gutter;
expanded forms keep their normal spacing.
Generated fixtures and local services use the same header pill details.
Development always precedes Production; both pills remain visible when unavailable.
Configurable workloads and their routes expose the same **Deploy** selector in Settings.
A route edits its target's declaration. The pills immediately preview a staged scope, and restoring
inheritance restores the default preview. Role-specific choices come from the framework's lane previews, including AWS execution
for event Lambdas during development. Conditional Deploy selects a non-secret input
and compares one literal value in a grouped, full-width form. The input's catalog name
and environment variable appear separately so neither crowds the selector; helpers and
validation remain associated with their controls. Saved settings and review show each
environment's outcome. API gateway headers reuse the catalog's framed Framework managed badge.
Workload and route pills reuse the map's per-environment runtime and placement formatter,
including staged Deploy choices. Replay help remains with the Local replay setting.
Infrastructure catalog pills reuse map locations such as CloudFormation stack, stack membership,
and Secrets Manager; these describe configuration rather than deployed health.
Stack members link to their parent; tools link to their consuming
agents and retain an editable override; framework-managed resources explain their inferred availability.
Infrastructure does not get unsupported deployment overrides. Local services and network fixtures
use the same pill details and identify Compose or the production VPC as their configuration source.
VPC island inspectors configure only the selected network and list its entries. Their
deployment summary uses whether production builds the VPC; local workloads never enable
a development VPC. Global Lambda and container defaults belong to Serverless compute's
Service type selector; agent tool defaults also appear in the Agents inspector. The APIs
inspector lists gateways without workload defaults. Connection pool defaults appear in
Application PostgreSQL's Connection pool defaults. These defaults apply across VPCs; they are
never scoped by which network is selected. Select an individual entry to change its
deployment scope. Client mapping Dev/Prod pills
continue to control file generation rather than workload deployment.

The managed application database has a dedicated inspector shared by the RDS resource and
local Postgres node. Identity and description lead into Development/Production implementations, the required
VPC home and connection paths. Group production capacity, availability, connections and
maintenance into disclosures, followed by caller pool defaults, deployment overrides and
supporting ownership details. Explain independent data and shared schema without implying
local replication or live health. Placement uses a separate coordinated source review for
the database and its consumers, with no public or unplaced option. Existing RDS moves need
migration/cutover planning and separate deployment; routine policy toggles never perform it.

For workloads, Implementation stays in the header. One **Settings** disclosure begins
with Deploy, its condition and required-input controls, followed by **HTTP routing and access**,
**Runtime and capacity**, and development
replay when applicable. Routine route paths, authorizer switches and runtime fields
appear directly under their group heading. **Build and runtime** and **Production
placement** are embedded advanced disclosures within Settings, with no second outer
gutter. Build details omit the source directory already shown under Implementation.
Empty groups are omitted; placement-only workloads still have Settings.
Numeric fields keep their
inherited default visible after an override and offer a direct way to restore it.
Default, reset and collapsed provenance share one wrapping support row; expanding
provenance uses the full width below it.
Triggers, connections, environment bindings and permissions keep their own sections.
Route inspectors group their owner's API authorizer under Settings and preview its
draft access state. Path editing remains with the owning Lambda's Settings.

Fresh resource inspectors start with disclosures closed, including **Permissions**,
**Settings**, **Workload access**, stack **Resources** and **Exports**,
and gateway **Routes** and **Connection authorizer**. Their full heading is the native
keyboard-operable toggle. Counts stay visible when collapsed; Permissions and Settings
also retain their pending-change status, and Settings exposes invalid drafts as
**Needs attention**. This includes deployment, required-input, route, authorizer, replay, build and placement edits,
so closing the parent never hides the existence of a pending change. Add/grant actions
live inside the expanded access section.
Returning through inspector or browser Back restores the user's open sections, scroll
and focus. Explicit links, guided setup and validation may still open their relevant
controls after an action.

Stack and Stacks island inspectors show source-linked declarations and entries.
CDK synthesis and infrastructure review live in **Deploy** (`/deploy`).

Stack and gateway inspectors share one **Exports** section for public string fields and
CDK outputs. A field used by an output appears once, with the output name and environment
mapping beneath it. Cataloged fields and recognized resource attributes show their
`stacks.…` reference for workload configuration alongside inputs and secrets; uncataloged
stacks retain their CDK expression without inventing a reference. Values remain source
metadata; inspecting exports never resolves deployment values.

Resource titles use the useful short name, with the full catalog identity on a secondary
line. Operational flags remain visible; longer ownership and source explanations expand
on demand. Empty sections are omitted. Local values edit inline with a clear environment,
file destination and saved/default/empty state. Allowed values use a select; freeform values
use the shared environment value control. Secrets start masked. Revert and default actions
stage through the existing private environment-file review rather than navigating away.

Input identity distinguishes **Source parameter** from **Environment parameter**. The same
**Link to .env file** switch appears during creation and editing. Off shows a non-secret
**Value** saved in the declaration, including separate Dev/Prod values when needed. On shows
the variable name and an optional **Default value**, plus the environment-specific local
value editor after the link is saved. Switching sources carries the entered Value/Default
text across and stages source review; it never transfers or rewrites existing environment
file values. Source parameters have no local-file destination, file-source rows or missing
environment-file requirement. `enableWebSocketApi` is an environment parameter reading
`ENABLE_WEB_SOCKET_API`, with a default of `true`.
Secrets always stay environment-linked, masked and without a source value or default.

Boolean setting help describes what the option does and stays the same when toggled. Keep related
controls in place and disable them when inapplicable (including input defaults and client
mapping options). Draft restrictions belong in existing status space; reserve that space
for both messages so wrapping on narrow panels cannot move the controls below it.

Descriptions show a two-line preview and open their editor deliberately. Source links
show a filename and line, retain the full path in their title and open the original
declaration. Field provenance expands beside its control rather than repeating long
inheritance expressions in every select option. Connection evidence and user-authored
descriptions remain separate. Connection endpoints include their type (for example,
API versus WebSocket) so identically named routes and handlers remain distinguishable.

## Presentation details

Every inspector follows these rules, so that generated content never repeats or crowds itself
(audited across all 135 map inspectors in both modes on 2026-10-28):

- Identity headers read in three steps: the type label, the identity block, then facts.
  - **Type label.** Every eyebrow is `InspectorKind`, islands and schema entities included. The
    subject's Dev | Prod pair sits at the right end of the eyebrow row, where the hover card puts
    it, so names keep the panel's full width. Every inspector with an environment answer has one:
    workloads and routes (draft-aware, from the framework lanes), gateways,
    catalog resources, the managed and local databases, network fixtures, connections and both
    kinds of environment file. A stack the CDK app never constructs is off in both, as its hover
    card says. Islands and input groups show per-environment entry counts.
  - **Identity block** (`EntityName`). The 32 px service artwork sits beside the name, and the
    technical identifier sits directly beneath the name in the same text column: a target ref,
    `resources.<path>`, a route's config key, a framework input's variable, a database's name and
    declaration. Catalog stacks show `resources.<key>` beneath their class name, as inputs and
    secrets do. The artwork spans the pair, from the name's cap height to the identifier's
    baseline; beside a name alone (gateways, framework stacks, framework input groups,
    environment files) it centres on the name; an island has no artwork and starts at the gutter.
    A wrapped name stays in its text column, never beneath the artwork. Names and identifiers
    break after a separator or at a camel-case hump (`Identifier`) before they break inside a
    word. The Rename action overhangs the name's line rather than heightening it, at either
    pointer size, so the block keeps 4 px above and 10 px below with or without one.
  - **Ownership and status badges** follow the identity block, 10 px clear of it and of the facts,
    6 px apart when stacked.
  - **Facts** (`InspectorFacts`, `InspectorFact`) are definition lists sharing one 88 px label
    column, so values start at the same x in every inspector and consecutive lists read as one: a
    stack member's **Type**, an entry's **Input group**, source lines (`SourceLines` in
    `Written.tsx`) and the environment files' Dev and Prod rows. Labels are 12 px supporting text;
    values lead in the ink colour, monospace for identifiers and paths. A source line's line
    number recedes and its external mark brightens on hover (`EditorFactLink`). Rows sit on the
    24 px caption pitch and links keep the caption target (44 px on coarse pointers); a long value
    wraps inside its column with its label on the first line. An unlocated declaration says so in
    the row its source line would have taken. Header labels use one vocabulary: **Declared in**
    for config declarations, **Cataloged in** for a group's `resources.ts` entry, **Class in**
    for a stack class and **Defined in** for framework-owned CDK code.
  - **About this resource** and issue notices follow the facts. A header closes with the space
    it opens with, whatever its last line is.
- Every section title sits the same distance below its rule. A 32 px heading action (the
  Description row, a leading switch or boolean field) keeps its target but overhangs the title
  line; a described section with an action moves its description clear of the overhang.
- Counts use the shared `InspectorCount` chip beside a heading or supporting summary (right-aligned in
  `InspectorDisclosure`), never parentheses or bare numbers.
- One disclosure marker: section disclosures draw the lucide chevron; every other summary
  uses the same chevron at its own text size (a mask utility owned by `InspectorUI`), never the
  browser triangle or a +/− sign. A permission row is its own toggle and washes on hover; the
  description's **Edit** summary carries its own affordance.
- Lists inside ruled sections draw rules only between rows, never at the list's ends, so a
  section never shows two lines together. This covers relation, permission, environment and
  bundle-member lists.
- **Connections** rows lead with the connection title and its pills; the other endpoint and
  its provenance form the supporting line, so long identifiers never break inside a narrow
  column. Workload access rows name the consumer's kind beside it.
- A connection heading follows the hover rule against repeating its From/To. Bundle rows
  omit a shared action, and an expanded member lists only the endpoint that differs.
- Environment-linked local values state each fact once: the status line covers Empty and Not set, and an empty
  value select already reads **Use default · value**, so no help line repeats either.
- Input settings begin with their **Input behavior** group rather than a generic heading.
  Form-group legends sit inside their group, below its rule.
- Suggestion fields (`input[list]`) show the shared select chevron in its usual place.

## Workflows

Environment search and add actions share one toolbar. Mapping rows use the same control
sizes and action alignment as other forms. Client mappings begin with a searchable source
overview; expand a row to select a source type and its inputs. Keep symbolic previews and
availability in sync with the draft, and distinguish omitted fields from empty values.
Use the shared Dev/Prod pills on each row to toggle inclusion independently, and keep
renaming inline with duplicate-name validation and preservation of both source recipes.
The CDK environment inspector follows the same grammar for both input files. Its header
names the Dev and Prod files; Variables opens with one readiness line per environment
(**Show** filters to the missing values and keeps those rows in place while they are filled),
then search and **Add variable**, then rows grouped by reader. A row's Dev | Prod pair is lit
where the environment has a value, red where a required one is missing, and unlit where it is
blank or never read; the row opens to a labeled field per environment, or a "Not read in …"
line instead of a field. One review saves whichever files changed. Per-file notes read as text
under **Files**, with editing behind **Edit description**. Transient notices share one
container so open rows restore by position on Back. The header offers
**Create .env.<mode> from template** for each missing file.
The local environment switch follows the graph's navigation guard. Native selects retain
keyboard support with an inset arrow and reserved text space. Shared defaults reuse the ordinary field rows;
membership lists can expand separately from settings. Trigger setup retains its three
steps, brings each step into view and focuses the next relevant field. Back/cancel remain
secondary actions; the next/commit action sits at the end of the action row.

Review dialogs share panel typography and controls. Validation, pending changes and file
diffs have separate visual groups, with actions outside the scrolling body. Staging,
navigation guards, source conflicts, review/apply, undo/redo, masking and deployment
authorization continue through the existing services. UI refinement never writes a value
merely because a control or inspector was opened.

## Extending the system

Applicable resources share a collapsed **Logs** disclosure at the end of their inspector,
owned by `ResourceLogs` in the shared `InspectorContent`. Map selection and the Resources
list therefore show the same section. It uses `InspectorDisclosure`'s native summary,
Enter/Space behavior and existing per-mode disclosure/scroll/focus navigation memory.
Opening or restoring the section starts a bounded cache read; collapsing it removes the
reader. It never starts the collector or application work.

Development shows timestamps, level/event kind, resource attribution, original runtime
run/binding, readable text and expandable structured event details. Search and level filters,
the run selector, bounded older-history loading, **Pause follow**, **Follow logs** and
**Refresh logs** operate only on the sanitized local cache. The timeline displays at most
1,000 records in a moving window. Loading an older page keeps its rows and evicts newer
rows when full, with an explicit notice; loading may continue into earlier cache history. Loading,
available-empty, stopped with history, disconnected, collection failure and retention gaps
have separate copy. Scrolling away from the tail pauses following; loading older entries
preserves the reading position. Long payloads wrap and their detail region remains bounded.
Follow returns to the latest tail; Refresh returns to a paused latest snapshot. Timestamps
show full source time on hover and occurred/observed ISO values in expanded event details.

Lambda lifecycle and attributed output events form one invocation entry using the exact
runtime, resource and invocation identities. HTTP gateway events use the corresponding
request identity. Resource-level output stays independent; an inherited caller identity
does not turn an agent's session output into a Lambda invocation. The primary entry shows
the observed outcome, duration and cold/warm state when available. Errors remain visible
while collapsed; native Enter/Space expansion reveals the original lifecycle events and
their structured details. Filtering or bounded history can leave a partial entry, which
must never imply that execution is still running or completed successfully.

A Lambda's **Returned status 401** means its handler returned a response-shaped value.
It is distinct from the gateway's observed **HTTP 401** response and from an exception,
timeout or cancellation. Safe status/duration metadata survives authentication-body
omission. **Run details** retains full runtime/binding/declaration identities behind a
native disclosure instead of filling the default view with identifiers. An invocation's
optional **Execution trace** reads bounded cached evidence only when explicitly opened.

Production shows only the explicit collection-not-implemented placeholder. It neither reads
production logs nor reuses Development cache entries. AWS-only handlers say why no local
execution can be observed; native AWS resource evidence is labeled as locally observed
integration calls. Local PostgreSQL shows lifecycle evidence only, with SQL/row capture
omitted. Inputs, secrets, environment files, stack/configuration groupings, network fixtures
and schema/relationship selections have no independent execution stream and omit Logs.
An event Lambda used by an enabled local workflow exposes partial logs for its synchronous
local invocations even when `localReplay` is absent. Its AWS-triggered executions remain
unobserved. This scope comes from the existing workflow target references/step relationships.

Use the section primitives and shared tokens before adding a new panel-specific rule.
Surfaces outside the map follow the same grammar where they inspect one subject: the AWS
profile configuration modal's detail panel uses `InspectorKind` and its read-only pills, the
header ref line, source-line lists, environment cards with a select for profile assignment,
`InspectorSection`, field rows and `InspectorDisclosure`.
Scope form styling to the interaction surfaces; map graphics have their own visual model.
Keep primary controls visible and explanations discoverable. Do not add empty metadata
sections, nested scrolling regions, repeated source excerpts or long provenance strings
to routine control labels. Preserve meaningful notices and validation messages.

Check representative compute, stack/member, input/secret, environment-file, client mapping,
island, connection and trigger flows in the browser. Include staged edits, review, cancel,
selection changes and a narrow viewport. Browser checks complement the interaction suites
and `npm run verify`; they do not authorize or prove deployment behavior.

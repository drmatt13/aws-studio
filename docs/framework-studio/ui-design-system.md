# Studio UI design system

Studio keeps its graphite surfaces, environment colors, AWS artwork and isometric map.
React presentation uses Tailwind CSS 4 through the native Vite plugin. Keep layout
next to JSX and repeated appearance in `src/ui/` primitives or existing component
implementations. [Inspector conventions](inspector-design.md) describe the information
order and source-review workflow. The migration changes presentation ownership, not the
visual system or source-editing contracts.

## Styling ownership

There are exactly four production stylesheets:

| File | Owner and allowed contents |
| --- | --- |
| `src/styles.css` | Application entry, layer order, explicit `src/` and `index.html` sources, inclusive media/container variants |
| `src/styles/theme.css` | Runtime tokens, saved/OS light/dark values, `@theme inline` aliases, shared keyframes |
| `src/styles/base.css` | Document sizing, native font inheritance, focus/hidden/reduced-motion safeguards and browser-owned pseudo-elements |
| `src/styles/codemirror.css` | CodeMirror-owned DOM and Prisma syntax integration, loaded by `PrismaEditor` |

Preflight is intentionally omitted. Import theme and utilities separately; do not add
PostCSS, Autoprefixer, forms plugins, JavaScript Tailwind configuration or a second
runtime theme. Ordinary feature stylesheets and `@apply` facades are not supported.
CodeMirror's narrowly scoped adapter remains unlayered to cooperate with injected
editor styles. Its controls explicitly own appearance that React primitives cannot reach.

In light mode, `paper` is the cool workspace canvas and `sheet` carries documents,
toolbars and panels. `wash` groups related content and supplies hover feedback.
`field` and `field-rule` make editable controls recognizable in both canvas and
sheet contexts. Use `selected`, `selected-ink` and `selected-rule` for a persistent
selection. Structural rules stay quieter than field boundaries, and elevated surfaces
use the corresponding card, popover or dialog shadow. Use theme-resolved colors
for hand-authored artwork and third-party styles so a saved preference takes effect
independently of the operating system setting.

`Button`/`buttonClasses` share primary, neutral, quiet and link variants; compact,
regular and prominent sizes; default and danger tones. Repeated compact trigger rows use
`size="dense"`; `size="custom"` leaves padding and minimum height to explicit caller
utilities for uncommon geometry. `IconButton` requires an
accessible label. Quiet danger icon buttons use graphite at rest, the shared rounded wash
on hover, and the refuse color on hover or visible keyboard focus. Destructive confirmation
buttons retain their explicit danger treatment.
Buttons marked `aria-busy` keep their label at full opacity while disabled, so
progress text stays legible. Unavailable actions retain the normal disabled fade.
`TextInput`, `Select` and `Textarea` retain native props/events/refs;
`controlSize` is separate from the native `size`; `controlSize="panel"` follows the
inspector or dialog control-height token. `UnitInput` draws a numeric unit inside the
input's trailing edge; callers keep the unit in the accessible label. `Select`'s
`appearance="quiet"` is for a setting inside another control's frame, such as the model
beside the Agent composer: no box until pointed at, as wide as its value, and the caller
bounds its width. `Card` and `Notice` cover shared surfaces. `Notice` does not invent an
ARIA role.
`InspectorUI`, `FieldRow`, `NavigationStrip`, `WorkspacePanel`, `WorkbenchUI` and
`DocumentCard` remain the higher-level owners. `cx` joins complete static class strings;
it does not resolve conflicting utilities, and JSX class order is not CSS precedence.
Use appearance props/recipes instead of conflicting caller overrides.

| Reuse tier | Owners | Use and limits |
| --- | --- | --- |
| Native UI primitives | [src/ui/](../../client-app/src/ui/): buttons, form controls, cards, notices and toolbar | Preserve native props, refs, events and submission behavior; appearance variants do not own application state |
| Shared application composition | `InspectorUI`, `FieldRow`, `NavigationStrip`, `WorkspacePanel`, `DocumentUI`, `WorkbenchUI` | Reuse the existing information/layout contract; each workflow retains its draft, approval and modal policy |
| Source/context retry feedback | [RetryNotice.tsx](../../client-app/src/views/RetryNotice.tsx) | Stateless alert with a retry action for document-workspace read failures; caller owns the query, message, retry label and pending state |
| Feature rendering | [views/inspector/](../../client-app/src/views/inspector/), [views/map/](../../client-app/src/views/map/), existing deployment/WebSocket modules | Keep feature-specific props and semantics; extract cohesive rendering without inventing universal configurable components |
| Domain and integration behavior | `draft-entries`, `editing-state`, typed endpoint/query adapters | Keep validation, edit gating and side effects outside presentation primitives; see [editing](../aws-studio-knowledge/studio/editing.md) and the [source map](../aws-studio-knowledge/REPOSITORY-MAP.md#where-to-change-studio) |

`RetryNotice` intentionally covers only the equivalent source/context retry rows.
Stale observations, ordinary status messages, operation outcomes and modal errors keep
their existing components and ARIA behavior. Similar markup alone does not establish
a shared lifecycle or approval contract.

`ToastNotice` owns transient notification appearance: a graphite border, wrapping
message, an optional action and a quiet dismiss button on the message's first line.
`useToasts` is the one list, in `StudioProvider`: a repeat of a visible message restarts
it instead of stacking, at most four show, and `useStudio().toast` is the only way to add
one. Give related notifications one `key` so a newer one replaces its predecessor where it
stands: a failure and its recovery must never be on screen together. The dismiss button matches quiet `IconButton` close controls but keeps its own hover,
because the wash and ink recipe inverts harshly on the toast's `ink`, `accept` or `refuse`
surface. It has an accessible name, visible keyboard focus and a 44px coarse-pointer
target that replaces its margin, so touch input changes neither height nor alignment.
An action dismisses its toast, since acting on a notification answers it.

`NotificationStack` is the single home for toasts. It rests 12px above the Activity bar,
rises with the tray, and sits above any dock a workspace reserves through
`reserveNotificationClearance`: the map does this for the Local runtime switch and Add to
application. When no room is left above the tray it drops into the tray's foot, under the Activity and
Agent tabs rather than over them. Short windows show the newest two whole, and a clip
keeps anything else from reaching the navigation. Do not add a second stack; native fullscreen, which hides Shell, uses the same component with
`fullscreen`.

### Health

Nothing inserts itself above the workspace. Shell's grid has no conditional row, and a
condition never changes the height or width of anything else on the page. Every health
surface reads one list, `healthConditions` in `src/health/conditions.ts`, so they cannot
disagree. A condition has a severity, a recovery action and a capability list stating
what is paused, what shows the last loaded version, what is limited and what still works.
Those entries must match what the code enforces: the server refuses source edits when
either mode is stale or errored, so a failure in the mode not being viewed still counts.
Never claim the view is current without evidence. The outside-save notification waits for
the refetch and stays silent unless the view was current before and after, so a save that
breaks or fixes the configuration is reported once, by health.

| Surface | Job |
| --- | --- |
| `HealthStatus` | The persistent state, shown only while a condition is unresolved. A healthy navbar has no validation control: a permanent badge was removed on purpose. Its slot stays reserved and empty, so an arriving indicator moves nothing. Its text sits in a `1fr` track that only takes leftover space, and container queries hide the text before it could press on navigation. Severity changes shape as well as colour, and only an error gets a filled surface. |
| `HealthPanel` | The diagnosis: the error without transformer wrapping, its file and line, **Open in VS Code**, the condition's recovery, **Ask in Conversation** and the capability list. If a condition clears while it is open, it shows that in place and keeps its toggle until closed. |
| Toasts | Transitions only, from `useHealthAnnouncements`. A state must hold for 1.2s to count, so a half-typed save fixed moments later interrupts nobody. Changed evidence for a continuing condition updates the indicator silently. Opening Studio on a known problem is not a transition, and nothing toasts while the panel is open, because the panel is already the feedback. A recovery replaces the failure notice in place. |

Dialog primary actions compose `dialogPrimaryActionClasses` directly with
`buttonClasses`. This preserves their 110px minimum and full row at 420px and below;
the footer no longer finds them through `data-variant`. `Button` still emits that
attribute for inspection and integrations. Attributes identify UI, state, focus targets
and test fixtures; ordinary layout must not depend on a distant selector finding them.
Native dialogs explicitly restore pointer events when rendered inside map overlays.
Boolean field help and inheritance details span both grid columns, leaving the
switch column sized by the switch itself; never place long support copy in that
auto-sized column.
On short windows, the stacked map panel retains a 260px minimum and uses workspace
scrolling so its resource rows remain reachable. Dense operational tables retain
readable column widths inside named, keyboard-focusable horizontal scroll regions.
Database review transitions reset the modal body scroll when the review title changes.

`src/inspector-ui.ts` contains explicit recipes for inspector headers, section gutters,
field rows, labels, relationship rows and native dialogs. Import the recipe at the element
it styles: `inspectorHeaderClasses` belongs on a header, `inspectorRelationRowClasses`
on each list item, and `inspectorFieldLabelClasses` on the label. Choose switch/stacked
field geometry and modified-label treatment from component state instead of inferring
them through descendant roles or `data-slot`. `InspectorSection` and
`InspectorDisclosure` accept `contentClassName` for their content layout, so callers can
set a shared grid or gap without reaching through the component's DOM.

Problems on map entities have one producer, `src/issues.ts`, and one treatment per surface.
Errors use `refuse` (inspector) or `map-error` (map cards and canvas); warnings use `local`
or `map-warning`. Inspector headers end with `IssueNotice` (a `Notice` per issue: glyph and
title, then the same sentences the hover card shows; errors are alerts, warnings notes) and
pass `issues={false}` to `ResourceStatus`, so a header never states a problem twice. Lists
too narrow for a notice, such as island entries, use `IssueChips`. Map cards use
`HoverIssues` and `hoverToneClasses` from `views/map-styles.ts`; a neutral `info` tone
marks expected, non-problem reasons. Colour is never the only cue: every issue keeps its
glyph and words.

Operation status has one owner as well: `statusTone` in `views/deploy/activity-model.ts`, used by
the Activity bar, history and detail through `toneClasses`. Success is `accept`, failure `refuse`,
anything a developer must check `caution`, and stopped or busy work `quiet`. `caution` and `quiet`
are theme tokens that keep 4.5:1 at 11px on `wash`. Use `quiet` for secondary
status text on grouped and selected surfaces. Each status also has a shape in
`JobGlyph`, and a running job shows exactly one spinner.
GraphQL's `ChainStatusIcon` draws the same shapes for contract-chain, review and local-API
status, so no status depends on a font's text glyphs.

Resource ownership badges own their spacing and appearance in `ResourceStatus.tsx`.
Their explicit `placement` and `appearance` props cover inspector headers and map
previews. Changing the managed badge's margin starts in that component; neither
`data-resource-status` nor the inspector scroll area supplies it. `Written` owns its
source-line layout and header placement. `EntityIcon` accepts a literal pixel `size`
(20, 22, 24, 26 or 32) and optional badge size; consumers no longer resize its private
image through an attribute selector.

`DocumentUI` and `WorkbenchUI` keep shared document recipes near their composition
components. Feature forms own their labels, control widths, supporting copy, table cells
and disclosure contents. Repeated tooltip typography and fact rows live beside their
surface recipe in `views/map-styles.ts`; resource and connection tooltip JSX references
them directly. Use `FormGroup appearance="plain"` when a fieldset needs a plain frame
instead of overriding nested fieldsets from an ancestor.

The theme supplies 32px control/icon and 24px disclosure-target defaults. Inspector and
dialog contexts retain their scoped 44px coarse-pointer minimums. Browser-owned
pseudo-elements, ARIA/native disclosure state, focus-within behavior, forced-color
adaptation and third-party CodeMirror DOM remain appropriate selector uses. The Shell's
recovery row uses `:has` because its asynchronous child owns whether it is present.
These boundaries are distinct from ordinary component spacing and typography. Preserve
DOM behavior and compare computed geometry when removing a selector; class string order
alone never establishes which conflicting utility wins.

Put one-off placement in JSX. Extract repeated appearance into its actual component or
small typed variant recipe, never a runtime mapping from old presentation class names.
Do not interpolate utility fragments. Use semantic colors, preserve the 4px spacing
base and the existing rem type roles, and reserve arbitrary values for actual geometry
or documented parity exceptions. Do not replace exact pixel/container boundaries with
Tailwind defaults: `vp-*`, `map-band`, `inspector-*`, `detail-640`, `coarse` and
`forced-colors` variants encode the original inclusive queries.

Tailwind side-border utilities already set that side's style. Without Preflight, adding
an all-sides `border-solid` to `border-b` can activate unwanted native medium widths on
other sides. Native dialogs must only acquire flex/grid while open; `[hidden]` remains
a document safeguard. Preserve explicit submit buttons, cancellation/busy guards,
autofocus and focus return. Behavior and measurements use refs, roles and stable data
attributes, never presentation classes or assertions about utility strings.

| Concern | Shared convention |
| --- | --- |
| Spacing | `--space-1` through `--space-8`: 4–32px in 4px steps; workspace gutters: 16px; document page column: `pageWidthClasses`; inspector gutters: 20px |
| Type | Barlow for UI text, Barlow Semi Condensed for display, JetBrains Mono for code. Barlow is self-hosted from `public/fonts/` as Google's unhinted build: the hinted build Google sends Windows merges the i/j dot into the stem at 12–13px. Document pages: 18px page titles, 15px card/subsection titles, 13px nested titles and labels, 14px body, 12px supporting text; sans headings at 600 weight. The faces stop at 600, so `base.css` maps native bold (`strong`, `b`, `th`, headings) to 600 instead of letting the browser synthesize 700; native controls inherit their context |
| Controls | 32px regular, 28px compact, 36px prominent; icon actions are square |
| Surfaces | Studio theme colors; `rounded-sm` is 4px, `rounded-md` is the regular 6px, `rounded-lg` is 8px |
| Selects | Native keyboard interaction; 14px chevron inset 12px with a 10px text gap |
| Actions | `Button`, `IconButton` and their recipes; destructive actions use `tone="danger"` |
| Feedback | Stable outline focus, shared disabled and invalid states, reduced-motion support, native select arrows in forced colors; entity problems through `IssueNotice`, `IssueChips` and `HoverIssues` |
| Motion | State changes are instant except explicit spatial transitions. The bottom Activity/Agent drawer uses an interruptible 280ms `cubic-bezier(.22,1,.36,1)` slide, disabled under reduced motion. The Configuration health panel opens and closes through a 160ms fade with a 4px lift, because it stands in for what was an in-page banner and needs to read as arriving from its indicator; it is off under reduced motion. Loading and busy indicators may pulse with `animate-deploy-pulse`, off under reduced motion. While a contract-chain check runs, one highlight crosses the chain's rail (`animate-chain-scan`), off under reduced motion; nothing else on the chain moves. The map's Local runtime switch (`views/map/ComposePreview.tsx`) uses interruptible transitions on the `--spring` and `--spring-bounce` curves plus its `compose-*` keyframes in `styles/theme.css`; its starting loop re-targets those transitions on a timer, so readiness settles the cargo from wherever it is. All of it is off under reduced motion and the map's Motion toggle |
| Density | 4px within a group (label, control, support; identifier and source), 8px action-to-note, 12px heading-to-content, 16px sections; use container gaps rather than stacked paragraph margins |

## Navigation and workspace rhythm

The application bar owns the app's name (renamed in place from its pencil), seven
workspace navigation links and the **Source** Development/Production selector, which
sits at the right on every route. The navbar
uses a 52px row on desktop, 89px with two rows at 760px and below, and 129px with
three rows at 560px and below. Route changes never add or remove source controls.
While a condition is unresolved, a health indicator sits between navigation and Source
and opens Configuration health. Its slot is reserved in every state. Status text,
including the hold note, only uses the space navigation leaves free.

`SourceEnvironment` mounts once in `Shell`. It reflects the framework's two declaration
projections and retains the unsaved-draft guard. Deploy, Database and inspection forms
keep their own named-target and region controls, and display the active Source profile
through `AwsConnectionSummary`; profile selection lives in the navbar. Domains edits Production
domain settings; Database edits one shared contract and keeps its editor's draft undo.
Source-edit undo/redo controls and APIs are removed; use Git for saved source history.
Failed-write rollback and interrupted-write recovery retain their existing guards.

`NavigationStrip` provides the shared link/button geometry for primary navigation,
Cognito sections and Database workspaces. Native links and buttons retain their keyboard
behavior. Overflow scrolls within the strip; active items and keyboard focus are revealed
without moving the surrounding page. Keep each name on one line.

Studio has exactly two page layouts. **Workbenches** (Map and Database Schema) are tools
that need the whole window: their toolbars and content run edge to edge within 16px gutters.
Database's tabs keep that frame so its navigation stays still when moving to and from the
Schema editor. **Document pages** (Database History, Status, Saved SQL and Retention,
Deploy, GraphQL, Cognito, Domains, WebSockets and Agent test) share one column; a new page
is a document page unless it needs the whole window.

GraphQL is a document page whose section strip is Database's toolbar: `workspaceToolbarClasses`
with `NavigationStrip` flush left at the 16px gutter, an icon on each section (Schema shares
Database's `FileCode2`), **How this works** at the right and no visible title, because the
navbar already names the page (its `h1` is `sr-only`). Everything below the strip sits in the
document column. The contract chain is page content rather than chrome: no band surface or
rule, a `WorkbenchPageHeader` with **Check again** as its action, pinned above the detail
region that scrolls beneath it. A column-width rule marks that edge only while the region is
scrolled. Each link between layers opens its section (Pothos review → Schema, Codegen →
Explorer, Client review → Client); on the active section the same control shows or hides the
link's detail. Its status is one line: `ChainStatusIcon`, words and a chevron that turns
with `aria-expanded`. Sections open with `WorkbenchPageHeader` and use the workbench recipes.
The open link's review is the first card beneath the chain, where its stem lands. The
saved-source **Contract update** card follows it and is absent while saved-source evidence is
historical, or while a source change or **Check again** is being read; an ordinary background
read only pauses its actions, so it never blinks out. Nothing is inserted between the chain's
header and plate: unavailable task history offers **Retry task history** among the header's
actions, and a background inspection is announced to assistive technology while the rail and
gates show it.

The chain's layers are one faceplate (`GraphQLChainBand`), built from the page's own surfaces
and never from the map's scene palette. Do not turn it back into four cards joined by arrows.

| Part | Convention |
| --- | --- |
| Stages | Four channels on one `sheet` plate, divided by rules: the stage in the 15px title role, its index, its name in the code face. A stage's fingerprints sit where they are compared: what it was built or reviewed against at its leading edge, what it offers at its trailing edge, so the two readings face each other across each divider. A message such as **Fingerprint unavailable** stands in for its reading and keeps that reading's edge: trailing on the Database contract and Pothos schema, leading on Generated GraphQL and Client operations |
| Track | A `paper` band along the plate's foot carries the lineage rail from an origin mark to an arrowhead. A link is the interface between two stages, so its gate sits on their divider: a grid item spanning both columns, centred on the boundary, with the rail through its centre |
| Colour | Status only. Stage identity is typographic. The rail beneath a stage shows its standing against the stage before it: solid and neutral once verified (as is the origin), dashed in `caution` or `refuse`, dotted and `faint` while unknown, so an unknown stage never looks verified or failed. Words and `ChainStatusIcon` shapes stay on every gate |
| Selection | The two stages beside the open section's gate take the `wash` of the active section tab, and only they do: pointing at or focusing another gate changes that gate alone, never its stages, so at most two stages are ever washed. An open gate drops a 1px stem through the plate's edge and the section's 16px foot to the top of its detail card, which stays an ordinary `DocumentCard` |
| Width | From 738px of column width the plate reflows: names wrap at slashes and readings wrap within their stage. Below that it is a horizontally scrolling region that centres the open section's gate, because stacking four stages would roughly double the height of a pinned header |

Document pages share header geometry and one vertical rhythm at every width: the page's
first heading starts 16px below the chrome above it (the navbar, or the section strip),
its header is the 18px title on a 32px row with one 12px support line 4px below, and the
first block starts 16px below that header. Blocks (cards, notices and section headers)
then follow 16px apart. A full-bleed sheet band under the navbar always holds section
navigation (Database, GraphQL, Cognito); a page without sections opens with a plain header
instead. Deploy and Domains use that plain page header (`PageToolbar appearance="plain"`),
which blends into the page: no surface, rule, minimum height or bottom padding, just 16px
above it, so both pages place their title and first card identically. Deploy keeps
machine readiness beside its deployment heading in the same column. Deploy omits the
full-width This machine, frontend-release and stateful-retention cards; header readiness,
findings and operational evidence retain their existing controls. Each Cognito section
opens with `WorkbenchPageHeader`, as GraphQL's sections do, followed by its **Read-only
deployment inspection** card (below). WebSockets has no title bar: its panel opens with a
`WorkbenchPageHeader` (Local or AWS, with the panel's description), then field groups 16px
apart, each label 4px above its control and flush with its edge.
Deploy reserves the account/region caption line even during reads; when no AWS profile is
chosen it says so instead of leaving the reserved line blank. Login errors use that
same caption line as a red text action with an underline on hover/focus, opening AWS profile
configuration instead of adding a button or error card. On narrow screens, machine readiness
always occupies its own row so switching declaration modes does not reflow the header.

Routine operations hold the page still. Synthesizing, deploying and discarding are what
Studio is for, so a running operation is never an alert: nothing is inserted above existing
content, nothing changes width, and no warning colour appears until something needs a
decision. Show progress on the control that started it, and in Activity. A paused edit
control stays the same control, disabled; its read-only replacement and "Editing is paused"
line are for a configuration that truly failed to load. An explanation that must appear goes
in free space, like the header's hold note left of Source. `operation-stability.spec.ts` keeps
this honest with the browser's own `layout-shift` entries, not only element positions.
Reserve warning colour for a plan that still wants something; a ready plan is a result.

`pageToolbarClasses` owns `--toolbar-padding` (12px vertically), `--toolbar-height` (57px
minimum including the rule), the `--sheet` surface and the `--rule` bottom border.
`workspaceToolbarClasses` adds `--workspace-gutter` (16px) for workbenches. Controls are 32px tall.
Additional rows accommodate genuine controls, warnings or narrow widths; do not add a
route-specific heading spacer or an inset rule above the first toolbar. Keep responsive
utilities with their owning component; register shared query variants in the application entry.

Composition preserves each workspace's purpose. Isometric devotes its area
to the map, without a redundant page heading. Database leads with its workspace tabs
and editor controls. Deploy follows the global Source mode, with machine readiness at the
right of its deployment heading. Cognito's section navigation and section title precede
the variable inspection evidence, so a growing card never moves either of them.

Document pages compose three recipes from `DocumentUI`. `PageToolbar` draws the full-bleed
toolbar surface and puts its contents in the column. `pageWidthClasses` is that column:
centered, `--workspace-page-max` (1280px) wide including the 16px gutters; use it for
subsection navigation or a full-bleed strip's contents. `pageBodyClasses` is the column plus
the rhythm below a toolbar: 16px above at every width, matching Database's and GraphQL's
16px below their tabs, and 24px below. Titles in a
toolbar use the 18px `pageTitleClasses`; Deploy's deployment name is its page title.
Every page title except Deploy's leads with `PageTitleIcon`: an 18px graphite glyph 8px before
the words, `aria-hidden`, so the heading's accessible name is the title alone.
Page chrome stays outside the column: the navbar and global Activity tray span the window.
Activity occupies the final shell row on every route; its memoized owner stays mounted
through navigation. Opening the bounded tray reduces workspace height instead of covering
content, including on narrow screens. The map canvas is the one exception: it keeps its height
and runs beneath the tray, so opening it moves nothing on the map. `--activity-drawer` is the
drawer's one height, notices included, and the `activity-open` variant styles anything that
depends on the tray.
Activity history rows provide the positioning context for their screen-reader status text,
keeping it inside the list's scroll boundary. Opening or resizing the tray must not add
document scrolling; history, logs and workspace content retain their own scroll areas.
Running source-watch and web-client processes use steady green indicators in the summary,
history and steps. Temporary work, startup and stopping use neutral spinners. Yellow is
reserved for warning or uncertain observations; process-running status does not establish
the readiness of the whole local application.
The map's bottom dock fades out over 140ms when the tray opens and returns over
220ms after an 80ms lead-in as it closes. Opacity reverses from its current value
on rapid toggles; visibility follows the exit fade and pointer input stops immediately.
The `activity-expanded` variant follows toggle intent, while `activity-open` retains
the map's layout through the closing slide. The map's Motion toggle and OS reduced
motion disable the dock fade. A dock above a stacked phone panel remains available.
While open, only the thin top-edge separator resizes that shared height, preserving
it for the mounted shell. Dragging below the 100px minimum closes the panel, returns focus
to its toggle and resets to the responsive default height on reopening. The separator
supports Up/Down and Home/End; window
resizing bounds the drawer to the window; it can cover the navigation at full height.
The collapsed summary bar also opens by dragging upward, following the pointer from
zero height and closing again if released below 100px. Hovering only the collapsed bar's
thin top edge shows the same blue highlight as the open panel's resize handle. The highlight
fades over 100ms on `cubic-bezier(.22,1,.36,1)` and stays blue throughout a drag,
including while the collapsed bar becomes the open separator. The clickable summary
area has its own 200ms background fade on the same curve. Reduced motion disables
both fades. A drag does not trigger the bar's
click action; mode tabs and Docker controls keep their independent behavior.
The shell keeps a small workspace reservation for hidden toolbar layout and caps the map compensation
at that reservation, preserving its camera even when the tray covers the whole screen.
Pointer resizing disables
the shell's height transition until release; opening and closing retain their slide.
The Agent panel spends the drawer on its transcript. Its Conversation and Sightline views
are a second tier in the bar, unbordered beside the bordered Activity/Agent modes, and they
replace the panel's summary while it is open. Heading, suggestions and composer
share one left edge in a 752px column, using the document title and support roles. The empty
state sits at the bottom of the transcript, 8px above the composer, and in a short drawer the
heading scrolls away before the suggestions; a conversation starts at its top and takes a rule
above the composer. The quiet context chip sits outside the composer over its top-right corner,
its label on the composer's right edge: on the suggestions' last line while empty, and opposite
New chat on one row during a conversation. The composer is one 46px row that wraps at 650px, its
focus border is `--faint` rather than the near-white `--graphite`, and nothing visible follows it
except whatever stops a question from being sent, in the warning or error colour; its usage hint
remains the field's accessible description.
Shared `DocumentCard` and its native child controls
own 6px corners, 16px padding (12px at 720px and below) and 12px spacing between content
groups. Page-level cards, notices and sections are 16px apart on Database, Deploy, GraphQL,
Cognito and Domains, the same step as `workbenchPageClasses` and the space below the
toolbar; set it on the
container (a grid gap or a dialog-excluding flow selector), never as per-card margins.
Every card title takes `documentCardTitleClasses`: the 15px role on a 32px row
(`WorkbenchPageHeader`'s geometry, and the height whole-card disclosure summaries already
have), centred with block-level `align-content` so inline code and links stay inline. Titles
in a stack therefore sit level whether or not a card has an action. A card that opens with
an action keeps it level with that row, and on narrow screens the action follows the copy.
Status cards whose subject precedes the title keep `WorkbenchStatusHeading`.
A status card's action is centred on its two-line `WorkbenchStatusHeading`. Deploy's
findings follow the same rule: the 15px card-title role on a 32px row, regular 32px actions.
A heading inside a card is one step below the card's title: `documentSubheadingClasses`
(13px), as for Deploy's **Stacks** and GraphQL's **Local evidence**, never a second 15px title.
A card footer that pairs an explanation with its action has a rule above it, the
explanation on the left and the action last at the trailing edge, including when it wraps;
disclosures belong above the footer. Saved SQL's source and run cards share this footer.
Data tables use `documentTableHeadClasses` and `documentTableCellClasses`. Identifiers such as
environment input names render as `code`, including when they are a field's label; a list of
named inputs is a fact grid (name over value), not a run-on sentence. Layers or relationships
explained side by side (Cognito's Scoped AWS access and Permission layers) use the same
label-over-value columns.
`documentTitleClasses`, `documentSubheadingClasses`, `documentProseClasses` and
`documentSupportClasses` name the document type roles. Heading level follows the content
hierarchy independently of visual size: cards below a subsection heading use `h3`.
`documentSummaryClasses` gives native disclosures a 32px minimum target, 13px semibold
sans text and immediate state changes; whole-card disclosure titles use the 15px title role.
Deploy and Cognito select the document appearance of retention controls; Database selects
the workbench appearance, which uses the same roles one heading level shallower. Inspection/search rows align control bottoms, with no bottom margin
on toolbar labels. Source actions group their button and supporting explanation;
on narrow screens the actions wrap within the card. Flow-spacing selectors exclude
native dialogs so browser modal centering remains intact.

Cognito and Domains share `inspectionControlClasses` for connection summaries, deployment and region
fields, including label spacing, 32px inputs and responsive wrapping. In a row of labelled
fields `AwsConnectionSummary` takes `layout="field"`: an **AWS connection** label beside
**Deployment** and **Region**, and its value centred on their 32px control row (Cognito,
Domains, Database production observation and retention inspection). The inline layout
remains for rows without field labels, such as the Infrastructure inspector. Cognito groups
source provenance and its evidence disclosure on one wrapping support row. Inspection
transport failures explain how to restore the Studio connection and retry; server
diagnostics and earlier observations remain available.

Load failures use a contained `Notice` in the same content column, with
wrapping details and a nearby retry action. Keep independent source and deployment
context failures independently recoverable, and show progress during retry. Alerts
must remain visible without widening the document or separating them from their controls.
Deploy keeps its plain title header and column through loading, missing profiles, missing targets
and read failures; background read failures retain the deployment and contextual retry.

Database workspace choices use a restrained selected treatment: wash surface, rule
border, regular radius and readable foreground. The map retains its compact floating
creation action.

The Database routes other than Schema use `pageWidthClasses` below their full-width tabs,
including loading and error feedback. They share document roles and geometry. `WorkbenchUI` owns only
what documents lack:

| Element | Convention |
| --- | --- |
| Page | `workbenchPageClasses`: 16px below the tabs and between header, notices, cards and sections |
| Header | `WorkbenchPageHeader`: the 18px page title on a 32px row (level with its actions), one 12px support line 4px below, actions at the right (refresh first, the primary action last). `titleId` names a region it labels; GraphQL's chain and sections and Cognito's sections use it too, and `titleRef` makes the title the focus target after section navigation. `icon` repeats the icon of the tab that opened the section (Database, GraphQL and Cognito tabs); the contract chain uses a chain link, and WebSockets uses a laptop for Local and a cloud for AWS |
| Cards | `workbenchCardClasses` (= `documentCardClasses`) with 15px titles and 13px nested headings; `workbenchPanelClasses` when the caller lays out rows or columns |
| Status cards | `WorkbenchStatusHeading`: the subject in support text, then the state in the card-title role. Readiness cards keep the state as their heading and their single `status` region, and their actions sit inside the card. History's migration status uses the same heading (not live; Database status owns the live region), with its link centred beside it; GraphQL's saved-source and candidate cards draw the same subject role |
| Disclosures | Whole-card: `workbenchCardSummaryClasses` (15px). A section within a card: `documentSummaryClasses` (13px). Evidence and metadata: `workbenchDetailSummaryClasses` (12px graphite). All have a 32px target |
| Catalogs | `workbenchMasterDetailClasses` (a 288px list beside the selection, stacked at 850px), `WorkbenchListHeading` and `workbenchChoiceClasses` for migrations and saved commands; `workbenchCompactChoiceClasses` gives long one-line catalogs (GraphQL types and documents) the same treatment in 32px rows |
| Views | `workbenchSegmentGroupClasses` and `workbenchSegmentClasses("icon" \| "text")`: a few mutually exclusive views of one subject, such as Database's editing layout or GraphQL's Fields/SDL |
| Empty and loading | `workbenchEmptyClasses`: a dashed 24px frame, with an optional title |
| Notices and code | `workbenchNoticeClasses` delegates to the shared `Notice` tones; `workbenchPreClasses` frames SQL and JSON |

Schema keeps its editor chrome: pane headers, the 32px footers and the split frame are
fixed geometry that its reference screenshots cover.

Isometric search, tag filters and camera controls occupy a normal-flow toolbar outside
the measured canvas. Wrapping controls must reduce the canvas viewport rather than cover
resources. The scene remains dark in both themes; its toolbar follows the application
theme. Use the existing scene container for pointer coordinates, resize and camera fit.
The circular sun/moon toggle immediately left of Add to application selects the
application theme. `src/theme.ts` saves the preference under `aws-studio-theme`,
restores it before React mounts and shares it with the WebSocket JSON viewer.
Without a saved preference, Studio follows the OS. CSS `light-dark()` tokens and
CodeMirror syntax colors follow the root `color-scheme`. The toggle's interruptible
sun/moon transitions respect reduced motion and the map's Motion control.
At 701–1100px, search and tag filters share a full-width row above camera
actions. Search counts and reset actions must leave the input editable at every width.
The map footer gives resource/connection counts; tile counts and frame timing belong
to the existing diagnostics API, not normal application chrome.

Deploy keeps its name on the left and machine readiness on the right of the same heading
row. Issues and remedies precede passed checks in both visual and keyboard order. Narrow
layouts wrap the group below the name, retaining right alignment within the page column. AWS connection details
remain in the global Source menu; the deployment heading retains account and effective
region. A profile's
default region never overrides a selected target's pinned region. Uninspected deployment
status says **Unverified**. Related deployment disclosures share one summary target.
Healthy machine checks collapse into
one named disclosure with versions/details on demand. Warnings, failures and remedies
remain visible. Refresh reports pending state and partial failures, keeps prior results
available and works when no profile is configured. Never communicate refresh failure
only through a disappearing notification.

Cognito uses one persistent workspace below the application bar. Its internal route
navigation has the same restrained selected treatment. Below the section title, one
**Read-only deployment inspection** card (Domains' title for the same controls) holds the
wrapping connection/deployment/region row, compact evidence status and the context's
notices. It sits outside the hidden section wrappers, so it stays mounted. User Pools starts
with pool identity and app clients; provider setup and policy tools have their own
routes. Use bounded, horizontally scrollable tables for long provider/role metadata,
wrapping identifiers and associated form labels. Keep source declarations, AWS
observations and simulation evidence individually labeled. Technical limitations
belong in contextual disclosures; failed reads, missing prerequisites and stale
evidence remain visible and actionable. Subsection navigation preserves mounted
forms and must not invoke the leave-workspace discard flow.

## Inspector density and disclosure

Keep identity and source first, then a compact **Tags** disclosure with its effective
count, followed by deployment and operational controls. Tags retain a visible **Modified**
or **Needs attention** state when collapsed. Supporting disclosure headings use a 32px
target with 8px vertical padding on each side, shared gutters and a hover cue. Do not add empty sections or repeat generic
descriptions above self-explanatory controls.

Use `FieldRow` for registry-backed fields; it dispatches boolean domains to the shared
On/Off switch, including build options and inherited defaults. Keep inheritance/reset
information, native keyboard behavior and complete draft gating when changing a
control's presentation. Route paths, helper text and validation share an associated
label and description. Dialogs and expanded disclosures follow the same form geometry.

Numeric defaults, reset actions and collapsed provenance share a wrapping support row;
expanded provenance occupies its full width. Creation fields begin with their naming
help, then show field errors after interaction or blur. Canonical validation still
disables review from the start, and server errors remain immediate.

Set select surface colors with `background-color`: the `background` shorthand removes
the shared chevron. Do not reset select padding in component styles. Search fields use a
single enclosing focus outline and explicit labeled reset actions where provided.
Helpers and validation belong with their control and are connected through
`aria-describedby`; labels remain associated when errors appear.

Inspector forms respond to their container width, including when a desktop map leaves a
narrow panel. Long identifiers wrap in metadata, while constrained map cards and selects
truncate with their full identifier available. Related key/value fields align; section
gutters and rules belong to shared sections rather than individual paragraphs. Creation
forms keep their descriptions, tag editors and list controls across the full form width.

Keyboard users can operate map and deployment menus with arrow keys and Escape. Search
reset, tag deletion, and drawer dismissal retain a useful focus destination. The map's
accessible resource list becomes a bounded visible navigator while it contains focus;
Escape returns to the canvas. Native dialogs keep their browser focus containment.
Deployment cards adapt to available width; review tables scroll within their own region
and confirmation actions wrap without leaving the dialog. Log updates follow the bottom
only while the reader remains there.

Gate a form's related controls together. VPC and workload placement editors pause native
inputs, switches, placement selects, endpoint pickers and removal actions during pending
review/apply, configuration evaluation, stale configuration, and source conflicts.
A partially disabled form invites edits that cannot participate in the displayed review.
The shared draft enforces its accepted-write boundary independently of control state;
see [editing transactions](../aws-studio-knowledge/studio/editing.md).

## Audit and regression coverage

The consistency audit covered shell navigation and health, Board, Isometric controls,
creation, configuration inspectors, tags, public fields, database schema, and deployment
overview/review/deletion/activity surfaces. In addition to spacing and chevron defects it
found empty Settings sections, missing secret-only Environment disclosures, resource-only
Boards mistaken for load failures, empty map mount/recovery crashes, invisible keyboard
focus, incomplete creation conflict gating, background refresh errors discarding drafts,
and log refreshes losing the reader's place. Initial connection failures offer retry;
background failures preserve the current map and draft with a persistent retry notice.

`inspector-styling.spec.ts` exercises ownership badges, missing-source headers, grouped
inputs and environment-file inspectors at desktop and phone widths. It records measured
geometry and screenshots while checking keyboard disclosure and overflow behavior.
It also checks local-value gutters, loading/read-error/missing-file states, synthetic
secret masking and reversion, and long client mappings at 1440, 1100, 390 and 320 px.
Those fixtures never read real input values or apply source changes; both themes receive
keyboard, geometry and accessibility checks.

Interaction regressions live in `navigation-polish.test.ts`, `isometric-ui.test.ts`,
`draft-ui.test.ts`, `startup-ui.test.ts`, `cognito-workspace-ui.test.ts`,
`domains-workspace-ui.test.ts`, and `deploy-ui.test.ts`. Browser checks should include desktop,
380px inspector panels and 320–420px windows, expanded disclosures, long identifiers,
creation and unsaved-change dialogs, forced colors, and both themes. Deployment review
and deletion can be exercised with mocked API responses while refusing all operation
requests. These checks establish UI behavior; applying source, deployment, live database
operations and infrastructure replacement retain their separate authorization boundaries.

`document-style.spec.ts` checks the shared Deploy, GraphQL, Cognito and Domains type
roles, card geometry, heading hierarchy and disclosure keyboard behavior at desktop and
phone widths in both themes. It also measures the vertical rhythm on Deploy, Domains,
GraphQL, Cognito, Database History and WebSockets: the first heading 16px below the chrome,
blocks 16px apart, no margin added to a gap, and card titles on one 32px row. It also covers Deploy loading, failed reads, missing profiles,
missing targets and keyboard retry. `responsive.spec.ts` checks the shared document column
at 1512px, 1100px and 390px, and GraphQL's flush-left section strip above that column. These are presentation fixtures, not live AWS observations.

For control changes, exercise the complete stage → review → back/discard lifecycle,
including a delayed review and stale source. Check the rendered disabled state and
keyboard focus as well as the draft transitions. Browser checks should report the
actual viewports and workflows exercised; unit fixtures alone establish neither layout
quality nor live AWS behavior. Build output and current checks belong in the engineering
handoff rather than permanent historical test counts here.

## Browser regression workflow

Run `npm --workspace framework-studio run test:browser` after the production build and
focused Node suites. Playwright owns strict preview ports 4592 (production entry) and
4593 (test-only gallery); it never reuses an unknown development server. The gallery
has a separate HTML entry/output and explicit test sources, and never enters the app's
routes or production scan. Install the pinned browser binaries with
`npm exec --workspace framework-studio -- playwright install chromium firefox webkit`.

Fixtures intercept APIs and designated WebSocket URLs and simulate EventSource events;
unexpected network requests fail. They inject the protocol/token before modules execute,
fix time/locale, and fulfill the four Google-hosted production font faces from licensed
local test copies; the application serves its own Barlow faces. Source writes and
cloud/database operations are represented only by explicit fixture responses. This suite verifies UI response to events; the real middleware and
transport need their own smoke checks.

Reference PNGs are tied to their named browser project and OS. Compare on the same
platform, inspect every diff, and only update baselines as an explicit reviewed action:
`npm --workspace framework-studio run test:browser -- --update-snapshots`.
Do not update references to silence a regression. Keyboard, settled-route/dialog axe,
responsive geometry, editor identity, route revisits and visual checks supplement one
another. The [browser regression guide](../../client-app/test/browser/README.md)
documents the executable acceptance matrix and its limits; report remaining unverified
states separately. The styling contract Node test rejects new production CSS owners
and retired feature stylesheet imports.

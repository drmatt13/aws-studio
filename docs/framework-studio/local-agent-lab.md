# Local coding agents

## Conversation context

**Agent → Conversation** answers questions using recent chat and an inspectable compact
[Sightline](sightline.md) capture. The context chip above the composer's top-right corner opens its preview
and the inclusion setting. New questions include current Studio context by default.
Resource identity, declared dependencies and timestamped sanitized runtime evidence are
separate facts; the prompt must acknowledge unavailable or partial observations.
Safe status metadata distinguishes a returned handler result from an observed HTTP
response, including error statuses from normally completed handlers. Runtime evidence
arrives as one digest per invocation or request, so a failed execution and a later
successful one keep separate outcomes and identities. An execution with no terminal
record is reported as unobserved, and unread or excluded records are counted; neither is
evidence that anything succeeded.

A question keeps its captured context/provider/model when retried, even if selection or
cache evidence changes. New questions use the latest committed selection. Each user
message can disclose its original source-labeled capture. Conversation receives at most
6,000 context characters once per prompt, with bounded relationships, observations and
trace summaries; the transcript and provider history have independent limits documented
in Sightline. Excluding context stops that consumer's log and trace polling. Conversation
cannot run tools or operate the project. Coding retains its separate private-workspace,
tool and source-review capabilities.

Server API changes require restarting `npm run studio` and reloading the browser to
activate them. Studio restart leaves the independently owned development collector running.

## Coding tasks

Choose **Agent → Coding** in the bottom tray for source development. This is separate
from **Conversation**. A task starts
from the project's actual saved files, including uncommitted and untracked source;
unsaved inspector/editor drafts are not included. Studio creates a private copy
outside the checkout, runs the selected native coding CLI there, captures its progress,
checks the changed files, and retains an immutable file proposal.
**Approve and apply** is a separate action bound to that proposal's digest.

GraphQL offers **Draft Pothos task**, **Draft Codegen task**, **Draft client task**,
and **Draft full contract task**. Each opens the same Coding composer with a suggested
prompt. Edit the prompt, then choose **Start coding task**. If a draft is already open,
**Use suggested prompt** replaces its text and **Keep current draft** preserves it.
An unsuccessful submission retains its request identity for retry. Local runtime can
stay off. Existing contract runs are accessible via **Open in Coding** on the
**Contract update** card.

### Existing contract runs

Structured contract runs retain one private candidate through API, Codegen and client checkpoints.
The host runs independent contract checks; Codegen is a bounded deterministic command,
and changed client documents receive another generation before final checks. Continuing
an existing run retains established developer decisions and uses the current proposal digest.
If an API change invalidates authored operations or fragments, sequential execution permits
one bounded client repair in the same workspace, followed by fresh generation and independent
checks. A stage-only task offers an explicit client repair at the failed Codegen checkpoint.
Other failed or unavailable checks pause the task. Repair does not
advance that proof: the host must validate the repaired documents, regenerate when
needed and pass the client checks before renewing the checkpoint. Unsupported configuration
and unavailable execution are distinct blockers, never automatic repair loops.
Choices can be supplied before starting. Changing a choice at a checkpoint explicitly
reruns its owning stage with those instructions and independent validation; it cannot
advance using checks performed before that choice. Confirming unchanged, validated
choices continues without another model turn.
Checkpoint evidence belongs to that private candidate. It cannot make the saved-source
Contract Chain green or acknowledge an application review. Agents cannot change
`graphql-chain.review.json` in these tasks. Structured runs with existing approval
authority check saved source independently after integration or after a successful
no-change run, then record approvals in dependency order. Draft shortcuts use the
ordinary Coding review and **Approve and apply**. Use GraphQL's saved-source checks
and explicit review to update the Contract Chain afterward.
Failed approval remains visible with **Retry checks and approval**, which repeats the
saved-source checks without another agent turn or applying the proposal again.
Intentional private-field/no-op changes use these same independent checks without
manufacturing application changes. Matching fingerprints alone never record an approval.
Returning to an already approved task also refreshes stale chain evidence once, including
after a page reload. Current healthy evidence avoids another check; a failed refresh stays
visible and is not retried by each task-list poll.
Each validated checkpoint references a versioned, content-addressed candidate receipt.
Its source, tools/policy, typed decision digest and exact upstream receipts must still
match before continuation or Apply. Changing an earlier decision rewinds its owning
stage; a resumed host treats persisted results as historical until refreshed and
independently validated. Candidate receipts never become saved-source receipts by copying.
Saved-source review records retain concise explicit decision/evidence notes; current
checks recompute trust even when a recorded receipt says it passed. The mandatory
`npm run contract:check` gate repeats those checks without a Coding agent or Studio.
Receipt integrity and a matching optional CI observation do not authenticate a reviewer
or CI provider; repository review/access controls remain the decision authority.
Generated database artifacts stay private to validation and outside source integration.
If the checkout's emitted database contract is stale after application, generate that
related contract separately before checking saved-source proof; inspection never emits it.

The provider/model selectors reuse native CLI discovery and login. Coding execution
requires the installed CLI's restricted execution capabilities and boundary checks;
an available conversational CLI does not guarantee an available coding runtime.
Read-only toolchain grants reject filesystem roots, host home directories and
directories containing the host working directory. Narrow versioned installations
and inspected package aliases remain available; cached discovery never caches permission approval.
The agent supplies its own investigation, edits and development commands. Studio owns
workspace preparation, permission boundaries, supervision, validation evidence and
source integration rather than implementing another model/tool loop.

Codex coding uses its native app-server protocol for the model loop, edits, commands,
streaming, saved sessions and interruption. Studio explicitly disables inherited MCP
entries and verifies the effective configuration before starting a model thread;
an empty MCP configuration table alone does not remove inherited entries.
Only completion for the exact thread and turn acknowledged by `turn/start` ends
the Coding task. Delegated threads, older turns and notifications missing either
identity cannot finish it. A completion arriving before the start response stays
bounded and provisional until that response establishes the matching turn ID.

Provider JSONL events persist in order, with an I/O yield every 32 consumed frames.
Large output bursts therefore leave task polling and cancellation responsive even
when the durable event consumer completes synchronously. Failed consumers still
stop execution and drain the owned process before reporting closure.

Claude coding requires **both the Claude and Codex CLIs**. Claude retains its native
model loop, saved login and sessions, but all native tools, including Bash and file tools,
are disabled. Its only tool is the host's fixed `studio_shell` SDK MCP bridge, which runs
commands through Codex's verified, model-free `command/exec` sandbox. This avoids
Claude's native macOS shell sandbox's credential-service permissions. The bridge accepts
only a command string; the host fixes its directory, environment, permissions, timeout
and output limits. Codex needs no model authentication for this executor. Final validation
for either provider uses the same model-free boundary. Studio never copies CLI credentials
or provisions API keys; the authenticated native controller remains trusted.
The submitted task authorizes commands inside that verified offline boundary, so routine
commands proceed automatically. Unsupported capabilities remain denied. Approving source
integration is a separate user action and never authorizes deployment or database changes.

Both paths must pass actual disposable filesystem, symlink, process-signal, environment,
loopback, external-network and local-socket boundary checks before receiving the source
task. macOS native coding and test/repair have been exercised with Codex 0.166.0 and
Claude 2.1.318; both providers' saved-session resume and cancellation passed native probes.
Linux uses the same per-run fail-closed checks. Native Windows uses an explicit
Codex MXC sandbox, Windows process identities and owner-only state ACLs; no legacy
Windows token sandbox or unrestricted execution fallback is allowed. The model-free
Windows boundary probe and Node/npm validation passed with Codex 0.164.0. It checks
a named pipe and junction instead of a Unix socket and file symlink. Native Windows
Codex Coding, source patching and independent final validation passed with Codex 0.167.0;
Windows Claude model sessions have not been exercised. These checks do not claim that every possible OS credential channel or
daemon-detachment technique has been exhaustively tested.

Windows Coding requires Codex CLI **0.167.0 or newer** and an MXC-capable Windows device.
Studio rejects older or unidentifiable Coding runtimes before starting a model thread:
0.164.0's native instruction reader could not launch with its required Windows environment.
Model-free validation remains separately capability-checked.
Studio selects `windows.sandbox = "mxc"` only for its own child process and leaves saved
CLI settings unchanged. Unsupported devices fail closed. See the
[official Windows sandbox requirements](https://learn.chatgpt.com/docs/windows/windows-sandbox).
When Linux tooling is needed, run the entire Studio checkout, Node/npm, installed CLIs
and task host inside WSL2, using a checkout in the Linux filesystem and a separate Linux
dependency installation. A Windows host does not silently send source or credentials to WSL.

Studio selects independent checks after it sees the changes. An unchanged task skips
source checks. Markdown-only documentation changes receive a text check for UTF-8 and
merge conflicts. Declaration-only changes use `framework:check` when available. Other
source changes run the project's `verify` script or its `test` script. Open **Task
settings** to select a check scope explicitly, including up to twenty repository-relative
source test files. GraphQL contract tasks run their required stage checks automatically.
Review shows the checks that actually ran. Commands run in the task's offline sandbox,
where any test depending on local servers, Docker, AWS or a database may fail.
For this repository's exact standard `framework:check` script, Studio invokes its two
authored check entries through `node --import tsx`, preserving the arguments while
avoiding the `tsx` launcher’s local IPC socket. Both checks passed in the native sandbox
against a private full-project copy. A custom script or npm pre/post hook keeps the npm
execution path; no check or lifecycle hook is silently discarded.
If final validation fails on a native coding task, **Repair validation failures** resumes
the same task and retained working copy with the failure evidence. It produces a new
validated proposal requiring new approval. Missing validation capability does not enable
this action, and structured Inspector handoffs do not invoke an LLM repair.
Buffered command output is capped at 32 KiB per stream and reports truncation;
larger native captures stalled in the installed CLI. Architecture results use bounded
scratch artifacts and small receipts instead of large protocol responses.

The **Studio context** control previews bounded [Sightline](sightline.md) JSON captured at
submission. A retry keeps the same request key, context and
check settings. Context distinguishes declared source, cached observations and their
freshness; it grants no AWS, database, deployment or source-write authority. It does not
silently include private environment values, database rows or unsaved draft text. The
dedicated log projection includes only sanitized bounded development evidence. Context
opt-out stops its log read and avoids serializing the projection.

Tasks and sequence-numbered events live in a separate pinned host with SQLite state.
Closing the browser, changing views or restarting the Studio observer does not cancel
the task. Coding shows startup feedback while the submission is connecting. The selected
task then shows what the runner is doing, from checking storage for the private copy
through agent setup, source changes and independent checks. The most recent agent updates,
commands and changed files are visible while work is active. Open **Activity log** for
output and earlier entries. Reopening Coding restores the selected task and loads its
recent events before following new activity. A short agent summary appears on the result
when the native provider returns an identifiable final answer. Native process
identity and interruption records support recovery; an uncertain side effect is not
automatically replayed. Cancellation, permission answers, rejection, refresh and approval
are explicit actions. Default execution concurrency is one; the host accepts a bounded
queue and supports up to four configured execution slots, with source imports serialized.

Review covers added, modified and removed files, content and mode changes, validation,
and available architecture previews. Once a task finishes, open its files and checks
to revisit the diff. **Task details** holds the original request, activity history,
contract checkpoints and temporary file cleanup. A single contract stage shows its
own checks and any relevant predecessors. Saved-source changes refuse stale approval.
**Refresh candidate from saved source** attempts a clean three-way merge, validates
the result and produces a new proposal requiring new approval. Overlapping edits remain
conflicted. Integration uses the shared source gate, exact baseline checks and a durable
journal; normal filesystems do not provide an atomic multi-file transaction. Interrupted
writes require explicit, fingerprint-bound **RESTORE SOURCE** or **KEEP CURRENT SOURCE**
decisions. User edits are not silently overwritten during recovery.

After approved application changes, Studio refreshes its source graph. For approved
Studio implementation changes, **Restart Studio** is a separate action available only
after source integration; it restarts the registered managed observer, then **Reload
Studio** reconnects the browser. The pinned agent host remains independent. Dependency
manifest changes remain blocked from integration until a separate private installation
and validation workflow is available; a runtime restart is not a dependency installation.

**Coding runner maintenance** at the bottom of Coding manages the local process that
runs tasks and stores their history. Opening it reads restart status. Use **Restart
coding runner** after active tasks finish or are cancelled to load an updated runner
implementation and keep existing tasks and proposals. A transport retry reuses the
same retained request UUID, including after a
browser reload; reading status never automatically resubmits a restart.
After a failed upgrade, **Restart coding runner** retries the same pinned version.
After saving a correction, **Restart from corrected source** explicitly creates a new
version and retains the previous failure record. Its new request identity and the
failed request it replaces remain paired across transport retries and browser reloads.
Superseded requests remain in the task database's upgrade history; replaying an old
request cannot select newer source. A late-starting failed target is reconciled before
replacement. Once a managed upgrade is recorded, an ordinary host crash restarts
that retained pinned version. Before the first managed upgrade, a fresh host startup
pins the current Studio implementation.
The controller records its launch intent before spawning and retains the verified child
identity afterward. An unknown launch outcome or a live, unresponsive child blocks a
duplicate launch; it requires inspection rather than a forced process kill. A matching
live endpoint can reconcile an interrupted observer. These restart actions do not replay
coding tasks or their development commands.

Inspector batch review also offers **Validate reviewed changes**. It transfers the trusted
reviewed source changes into deterministic validation in a private workspace. The original
inspector draft remains available, and Coding requires
explicit source approval. The existing **Apply All** flow remains supported.
If a structured task is interrupted after staging, explicit resume captures a fresh
private directory, rechecks the trusted before-bytes against current saved source and
reruns validation. The previous partial directory remains retained for inspection.

Completed contract workspace capture is retained before initial origin inspection. If
that inspection fails or the host stops, explicit Resume reuses the exact copy and
repeats origin admission before any agent or generation runs. Current saved source
must still match the captured baseline; changed source retains a conflict for Refresh.
A completed initial capture interrupted before task persistence is recovered only
when its task/root identity and untouched candidate bytes match its baseline.
Contract prompts give the agent an exact private scratch directory for reports, logs
and tool caches outside candidate source. Resume carries the last host failure with the
task so the agent can repair the actual blocker. An accidental out-of-scope change can
only be restored to its exact captured baseline; retries cannot alter other unowned
source or undo a passed upstream stage.
Preparation reports source copying, dependency copying, dependency integrity and origin
inspection separately. Cancellation stops new copy work, drains already started writes
and retains partial directories for inspection. An incomplete copy never becomes a usable
workspace. A completed copy still requires origin admission after recovery or Refresh;
cancelling that admission cannot clear its pending marker.

Workspace copies exclude private inputs, Git metadata, runtime output and tool hooks.
Dependencies are private copies with internal workspace links rebased; escaping links
and source symlinks/hardlinks are refused. Copies are filesystem staging, not the security
boundary: native process restrictions separately constrain writes, credentials and
network access. Copy admission uses a disk estimate and minimum free space; it is not an
OS quota. **Clean up temporary task files** releases terminal working/runtime copies while
retaining review and recovery evidence. Rejection cannot undo an external side effect;
operational capabilities must remain outside the coding policy.

Architecture previews compare frozen baseline/candidate declarations in both modes
through the pinned projector and each revision's own framework instance. Read-only source,
scratch-only writes, synthetic mode inputs and bounded verified result artifacts isolate
evaluation. Unknown private-input conditions remain labeled unknown. The result is an
advisory declaration diff, not CloudFormation synthesis, effective IAM analysis, observed
AWS state or deployment approval. Incompatible framework/dependency changes can make it
unavailable without manufacturing an empty graph.
Unchanged proposals skip architecture materialization because their source is identical.
Automatic sequential checkpoints verify their frozen candidate before advancing. A
nonempty proposal receives an architecture preview when it pauses for review or repair,
or completes the selected stages. Contract validation and saved-source approval still
run for every requested stage.

Implementation owners: [task service](../../client-app/server/agent-runtime/service.ts),
[workspace](../../packages/aws-studio/scripts/source/workspace.ts),
[provider adapters](../../client-app/server/agent-runtime/providers/),
[integration](../../client-app/server/agent-runtime/integration.ts),
[runtime activation](../../client-app/server/agent-runtime/activation.ts),
[preview runner](../../client-app/server/agent-runtime/architecture-preview-runner.ts)
and [Coding panel](../../client-app/src/views/agent/CodingPanel.tsx).

The [managed restart probe](../../client-app/test/support/agent-studio-restart-probe.ts)
exercises the relocated Studio server with trusted source helpers, a minimal page and
deterministic provider and validation fixtures. It checks separate source and restart
approvals, a new process and activation nonce, and retained source and task history
after a simulated startup failure.

## Conversation

Choose **Agent** beside **Activity** in the bottom bar on any Studio page, then use
the summary or chevron to open the panel. Mode buttons preserve its open or closed
state. The panel slides open and closed, with instant changes under reduced motion.
The question-and-answer conversation uses the selected standalone Codex or Claude CLI
and its saved login. Starter questions fill the composer so they can be edited before
sending. Enter sends; Shift+Enter adds a line. Answers support Markdown, code examples
and copying. **Stop** cancels the active request; failed or stopped replies can be retried.

The model selector lists the choices reported by the selected CLI using its saved
login. **CLI default** leaves the choice to that CLI. Conversation and Coding share
the selected provider and remember a separate model choice for Codex and Claude in
browser local storage across reloads. If storage is unavailable, choices still work
for the current page session. A model removed from the CLI catalog remains visible
as unavailable until another model or CLI default is selected. Catalog discovery
initializes a session without asking a model to generate a reply. If discovery fails, the default remains
usable and **Refresh models** retries. The server validates explicit choices against
the CLI catalog and passes them through its `--model` option.

Activity and Agent keep their state when switching modes, collapsing the panel or
navigating. A background answer marks the Agent tab without switching modes. Explicit
operation launches still reveal Activity. Escape collapses the panel and returns focus
to its mode tab. **New chat** asks before clearing the conversation and preserves a
draft. Conversation state lasts until the page reloads; it is not stored on disk.

Conversation receives a short built-in Studio overview, bounded recent conversation and,
by default, the compact [Conversation context](#conversation-context) captured for that
question. It can explain the supplied declarations and cached development evidence;
it cannot inspect source files, retrieve more logs or operate Studio. The agent has no
tools or source-write access.
`src/agent-chat.ts` owns session state, `views/agent/AgentPanel.tsx` owns chat presentation,
and `POST /api/agent-lab/chat` uses the existing bounded CLI runner. The request is
aborted when the browser stops it or disconnects. No API-key setup is required.

Choose **Context** beside **Conversation** in the bar of the open Agent panel to inspect
what Studio can see from the current location and selection. This is a read-only JSON debug view.
Conversation receives its smaller question-time projection; Coding can include the explicit
captured projection described above.
Conversation, draft and scroll survive switching back. Expand/collapse and
Copy JSON affect only its display/export. The JSON updates while visible from existing
source, workspace and cached deployment/operation evidence. Visible consumers can also
read the bounded local development-log cache without opening the inspector's Logs disclosure.
`GlobalActivity` owns the display choice, `views/agent/AgentViewTabs.tsx` presents it in the
bar, `src/sightline/AgentViews.tsx` shows the chosen view, `useSightlineInputs()` gathers
existing inputs only while visible, and pure `buildSightline(inputs)` builds the bounded
allow-listed object. Workspaces publish small fragments one way and remove them on
unmount; they retain ownership of every selection and draft. See the canonical
[Sightline design](sightline.md) for the contract, privacy policy and future pull-model
analysis. The chat request's optional context field is validated and sanitized by the server.

## Conversation execution boundary

Studio discovers standalone CLIs through absolute PATH entries and `~/.local/bin`.
Editor extension bundles and symlinks to them are excluded. Login storage stays with
its native CLI; Studio passes a curated environment without application, AWS or API
credentials. `HOME`, `USER`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` preserve saved login
lookup, including Claude's macOS Keychain account.

Conversation runs outside the repository in a disposable directory. Codex uses
read-only mode with user config, shell, hooks, apps, plugins, subagents and web search
disabled. Claude uses safe/plan mode with no tools or MCP servers. Requests are limited
to 45 seconds plus shutdown and 128 KiB of CLI output. CLI diagnostics are not returned
to the browser, and Studio stops owned child processes when closing. Claude also has
a $0.10 budget setting and a one-turn limit. These CLI restrictions do not establish
a hostile-code sandbox.

## Extension boundaries

For controlled domains, add explicit operations with schemas and deterministic
writers, or translate agent proposals into Studio's existing typed review/apply
services. Domain ownership, source hashes, affected invariants and required checks
belong to each operation. A prose plan is a proposal, not an execution boundary.

General source editing now uses the Coding runtime described above. Keep model execution
delegated to the native CLI and retain the common immutable proposal/integration boundary
when adding providers or structured operations. A Git worktree or private directory alone
does not isolate credentials, network access or processes. Deployment and migration
application retain their separate authorization.

Conversation and model discovery live in `client-app/server/agent-lab.ts`.
`client-app/src/agent-chat.ts` owns conversation requests;
`client-app/src/agent-lab-api.ts` provides CLI availability and model discovery.

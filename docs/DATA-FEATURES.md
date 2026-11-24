# Data features

Edit storage in `packages/database/prisma/contract.prisma`, describe the intended
application behavior, and let the agent carry the change through to exported
TanStack Query options. You do not need to author GraphQL or custom hooks yourself.

## Asking for a change

An example request:

> Propagate Project.description. Owners can read and edit it, limit it to 500
> characters, and include it in ProjectSummary. Keep the existing ownership rule.

For a new feature, supply the model, public and writable fields, ownership rule,
operations, and fields the screen needs. For an existing feature, the agent preserves
its established policy and asks only for decisions the request and existing code do
not resolve. A new database column alone does not grant permission to expose it.

Studio's schema editor also supports [Access Graph declarations](PRISMA-ACCESS.md).
Open **Database → Schema → Access**, or press Ctrl/Cmd+., to inspect a declaration;
sample-data previews evaluate the compiled policy and source review shows its impact.
The boilerplate keeps Project's existing owner-scoped repositories and resolvers.
Access Graph declarations and previews do not automatically replace those checks or
add fields to the public API. Application enforcement requires an explicit integration.

Agents must follow the [automation contract](playbooks/typed-contract-propagation.md).
That is the single home for required filenames, naming, operation shapes, error
semantics, tests, and completion criteria. The repository's Claude entry point is
`/propagate-contract <ModelName>`; other agents can follow that same procedure directly.
This is a source-editing workflow, not a runtime API endpoint.

## The chain

```text
contract.prisma -> repository -> Pothos schema -> GraphQL documents -> query/mutation options -> React
```

Storage, public API, and screen selection express separate decisions. Record types
are derived with `ContractRow<"Model">`; Codegen derives operation results and variables.
Typechecking verifies compatibility along declared paths. It cannot decide exposure,
notice a requested field omitted everywhere, or prove an ownership rule is correct.
The agent must verify the requested behavior using executable-schema and API tests.

### Reviewing the source contract chain

Studio's `/graphql` page separates local freshness from end-to-end confidence. Its four
visible stages project a dependency graph: Prisma and emitted database artifacts feed
repositories/Pothos and the executable schema; that schema and authored documents feed
Codegen; generated documents, React Query operations and consumers complete the chain.
An upstream change blocks downstream confidence even when generated files still match.
Only current independent checks and current predecessor reviews establish verified confidence.
The rail displays **Approved** when a tracked approval receipt matches saved source, including
after restart or clone. **Check again** validates the current installation. Each node
displays its output as **Generated SHA-256**
on the right; downstream nodes show the upstream hash consumed by the recorded stage as
**Source SHA-256** on the left. A stage without that record shows **Not recorded**. Changing
upstream content leaves the accepted input visible, so a broken connection can be compared
directly. The rail follows these comparisons from left to right. **In sync** means the
upstream output matches the recorded input. A mismatch puts later handoffs in **Waiting
for upstream**. At Codegen it reads **Regeneration needed**. Use **Regenerate GraphQL**
to run the generator against saved schema and operations. On success Studio records
the Codegen input and output hashes. Saved review approvals are separate. The Prisma hash uses
`packages/database/prisma/contract.prisma` with ordinary comments excluded. Access Graph
directives and other declarations that affect the database contract are included. The Pothos hash uses
`compute/http/graphql-api/`. The generated and client hashes use
`client-app/src/api/generated/` and the rest of `client-app/src/api/`, respectively.
Codegen also binds its configuration, loaded operations and executable schema. Adding
another Lambda or editing a framework parameter leaves the four hashes and matching
saved approvals intact. Independent checks still cover repository behavior, emitted database
artifacts, client consumers and the installed toolchain. **Proof lineage**
shows accepted and current receipt and parent identities. A change to the Prisma contract invalidates API, Codegen and client approvals
even when output bytes remain identical; a cache-only client change preserves API and
Codegen receipts. A healthy source watcher retains unaffected verified evidence while
checking changed stages; it cannot approve new bytes.
Acknowledgement does not expose a column or change a selection. Inspection never generates
files, applies migrations, contacts a database or invokes a model.

`graphql-chain.review.json` is committed review evidence. Version 3 retains reviewed model
shapes, the client SDL surface and API/client bindings, and adds versioned receipts for
database, API, Codegen and client evidence. Each receipt identifies its normalized source
and outputs, exact predecessor receipts, validator policy, Node and package toolchain
(including normalized common installed dependency source),
required check outcomes and verification limits. API/client receipts also contain explicit
developer decisions and the source evidence used to review them. A receipt's canonical hash
establishes content integrity; it is not a signature or authenticated reviewer identity.
Current confidence always requires independent validation against current inputs. Valid
version 1 and 2 records remain readable, with model acknowledgements preserved, but require
explicit proof renewal before the complete chain can pass. Receipts from the earlier,
broader source scope also require one renewal. Reads never rewrite the record.
It is not a feature manifest: application source and task inputs still own public fields,
permissions and consumer choices. Never edit this record by hand or record a baseline to
conceal pending changes.

Deep inspection uses an immutable private capture and the existing verified native command
sandbox. It compares emitted database storage/execution semantics with compiled Prisma,
runs backend behavior/type checks, checks full Codegen output, runs client operation/cache
and transport tests, checks consumer types, and validates the persisted manifest against
production limits. Missing, skipped-only, failed or unavailable checks cannot establish
proof. Executable-schema tests use repository fakes; they do not establish live database
or deployed behavior. Previous checks remain historical evidence after invalidation.
The fixed Node runner loads its trusted reporter through a file URL. Client discovery
uses workspace-relative glob paths and requires the returned file identities to equal
the required operation/transport inventory, in addition to complete passing test counts.
This keeps Windows path handling from turning present tests into unavailable evidence.

Use the deterministic CLI from the repository root:

```sh
node --import tsx client-app/server/graphql-chain/cli.ts status --json
node --import tsx client-app/server/graphql-chain/cli.ts --check
npm run contract:check
```

Use the repository-pinned Node **24.22.2** and npm 11. Supported execution requires at least
24.22.2 within Node 24; a different supported patch changes the receipt's toolchain identity
and requires proof renewal. `status --json` is informational. `--check` and `contract:check`
exit 0 only for a complete current accepted receipt lineage, 1 for known drift, failed checks
or pending reviews, and 2 for unavailable evidence or command failure, including unavailable
prerequisites beneath blocked stages. Missing receipts cannot pass.

`contract:check` is the standalone `verify` CLI verb of the framework's verifier
(`packages/aws-studio/scripts/contract-chain/cli.ts`, with `record` and `init`; `npm run contract:record`
runs `record`). It independently executes the fixed
checks in a private source capture as a trusted-checkout process, like repository tests;
it requires neither Studio nor a Coding agent/Codex installation. This is a separate explicit
execution authority, not an OS sandbox or a fallback for Studio's native restricted runner.
Studio, CLI status and review continue to use the verified model-free Codex command sandbox;
model authentication is not required. Both paths use the same checks and acceptance rules.
The receipts' policy is the framework verifier's own source, so the application verifies
independently of the Studio installation. `status`, `--check` and `accept` remain Studio's
CLI verbs because they inspect through Studio's sandbox.
Inspection/check commands neither generate source nor acknowledge reviews and require
installed generated database artifacts.

From the Studio source checkout, run `npm run pack -- <directory>` to build the release locally.
Without a directory it writes `release/aws-studio-<version>.tgz`, where Studio looks for its bundled
release. A standalone application pins that archive in its dependencies and runs
`aws-studio verify --json` through the installed npm bin. The release supplies the checker source,
worker, reporter and native process launchers. The application supplies the declarations, generated
artifacts, tests, lockfile and review record. The CLI discovers the application from its working
directory or `FRAMEWORK_REPOSITORY_ROOT`.

For existing structured runs, the trusted host independently checks saved source and
records completed stages through the revision-guarded review writer after the authorized
source application. A no-change run performs this finalization without an empty Apply
step. Missing decisions or failed checks stop approval. A failed finalization preserves
source for repair. **Retry checks and approval** rechecks the accepted saved source
without another agent turn or source application. It tolerates an already published
review receipt after interruption, but refuses changed authored files. Repeated
concurrent retries share one operation.

`npm run verify` includes `contract:check` as a mandatory final gate, and the supported-platform
CI matrix runs that same command. CI freshly executes the checks and validates committed
decisions and predecessor bindings; it never creates approvals. An unreviewed checkout fails
until the developer completes explicit review. The bounded local/CI observation under
`.cache/framework-studio/graphql-chain/ci-report.json` is optional historical information.
Importing or editing its unsigned authority label or passing flag cannot establish confidence.

After inspecting status and resolving the selected work, use its `revision` as `REVISION`
with exactly one acceptance scope:

```sh
node --import tsx client-app/server/graphql-chain/cli.ts accept --model Project --expected REVISION
node --import tsx client-app/server/graphql-chain/cli.ts accept --api --expected REVISION --decision "Preserve the reviewed exposure and ownership rules." --evidence "Reviewed repository filters, schema behavior and current backend checks."
node --import tsx client-app/server/graphql-chain/cli.ts accept --client --expected REVISION --decision "Preserve the reviewed selections and cache behavior." --evidence "Reviewed operations, consumers and current client/integration checks."
```

Replace the example decisions with the actual reviewed intent and evidence. Passing tests
or an agent's completion message cannot supply those decisions. Keep notes concise and free
of credentials, tokens, environment values and sensitive request payloads.

Re-read status between accept commands because each changes the revision. Model acceptance
updates only that model after backend validation. API acceptance requires all model reviews
current and independently validates the repository/Pothos implementation against the current
database contract. Client acceptance additionally requires verified API/Codegen confidence
and passing client, consumer and integration checks. A private field can leave public SDL and
generated GraphQL unchanged, but still requires model, API and client proof renewal.

The GraphQL page has stage-specific draft shortcuts and **Draft full contract task**.
They open **Agent → Coding** with a suggested prompt. Edit it and choose **Start coding
task**, then review and apply proposed source changes. Return to GraphQL to check saved
source and review the affected stages. Existing structured contract runs remain available
under **Contract update** with their checkpoints and continuation controls.

For a wholly unreviewed checkout, `accept --baseline --expected REVISION --decisions-file FILE`
records all surfaces, bindings and receipts atomically only after every required check passes.
`FILE` must be a bounded regular JSON file with separate `api` and `client` declarations:

```json
{
  "api": { "statement": "The actual reviewed API decision.", "evidence": "The source and validation evidence reviewed." },
  "client": { "statement": "The actual reviewed selection and cache decision.", "evidence": "The source and validation evidence reviewed." }
}
```

Prefer a temporary file outside public source; adding the file to source after inspection
changes the expected revision. API/client acceptance can also use `--decisions-file` for its
selected declaration. `init` creates an unreviewed version 3 record and refuses to overwrite
an existing file. Every accept uses
the same scoped writer as Studio, rechecks current source/evidence and refuses stale
revisions or linked targets. Neither acceptance nor generation authorizes database or cloud changes.

The inspector seals its checker policy at construction. Editing checker or trust-guard
sources requires restarting the affected Studio/Coding host before renewed verification;
`CHECKER_POLICY_RESTART_REQUIRED` prevents old loaded code from claiming a new policy.
Inspection never restarts the running development session. Receipt verification establishes
the declared offline checks and explicit decisions, not live database behavior, deployed
compatibility or rendered application UX.

The **Schema** and **Client** tabs use a separate lightweight saved-source inventory;
opening them does not start a deep check or import application modules. Schema reflects
`client-app/src/api/generated/schema.graphql`. Client shows authored documents, resolved
fragment selections, generated typed strings and actual recognized TanStack exports.
It shows key-factory source expressions rather than evaluating cache keys. Missing,
dynamic, ambiguous and malformed evidence stays explicit. **Open in Explorer** copies an
operation plus its transitive fragments. Explorer execution is a separate user action,
gated on the ready local runtime and a transient Cognito ID token; mutations require
confirmation. Neither runtime execution nor source inventory changes review records.

## Project is the reference

| Layer | Source |
| --- | --- |
| Storage | `contract.prisma` |
| Record, write inputs, repository interface | `contracts.ts` |
| Persistence operations | `projects.ts` |
| Static repository registration | database index (`packages/database/src/index.ts` in the app) |
| Public types, validation, authorization, resolvers | `project.ts` |
| Static schema registration | schema index (`compute/http/graphql-api/schema/index.ts` in the app) |
| Executable behavior tests | `project.test.ts` |
| Documents, fragment, query/mutation options | `operations.ts` |
| Cache and operation tests | `operations.test.ts` |
| Ordinary React consumers | `ProjectsPanel.tsx` |

The Project implementation exposes id, name, archived, createdAt, and updatedAt;
ownerId stays private. Every resolver resolves the session's application user once per
request (`requireCurrentUserId`). Lists filter by that id. Creates trim and validate names and
assign ownership on the server. Archive and delete write in one owner-scoped statement:
another user's project is NOT_FOUND, exactly like a missing one, so the API never reveals
that it exists. Deletes return `{ deletedId }`; create/archive return `{ project }` in named
mutation payloads. Queries live under one key factory (`projectKeys`); mutation options
invalidate `projectKeys.all` after success and preserve errors.

The screen's ProjectSummary selects id, name, archived, and updatedAt. Components use
`useQuery(projectsQuery)` and `useMutation(deleteProjectMutation)`, then
`deleteProject.mutate({ id })`. No feature hook wrapper is required.

currentUser uses the same frontend pattern: its
`operations.ts` exports
`currentUserKeys`, `currentUserQuery`, and `updateCurrentUserMutation`. Components use
`useQuery(currentUserQuery)` and `useMutation(updateCurrentUserMutation)`; updates pass
`{ data: { firstName, lastName } }`. Its singleton cache key remains `["currentUser"]`.
Session-expired errors are not retried; other failures receive at most two retries.
Override per-consumer options with `useQuery({ ...currentUserQuery, enabled })`.
Its API tests (`client-app/src/api/currentUser/operations.test.ts` in the app) cover selections,
retries, and invalidation. All features keep documents, options, and cache behavior in
operations.ts rather than adding a feature hook wrapper solely for these concerns.

User's backend still handles a single profile with verified-identity provisioning,
instead of generic owner CRUD. Its
schema tests (`compute/http/graphql-api/schema/user.test.ts` in the app)
cover that behavior.

## New-feature scaffolding

After emitting the Prisma contract, preview the owned-list/create recipe:

```powershell
npm --workspace @repo/database run scaffold -- Note --dry-run
```

The interactive command asks for public fields, create fields, the owner foreign key,
operation names, and selected screen fields. Explicit flags make it usable by an agent:

```powershell
npm --workspace @repo/database run scaffold -- Note --dry-run --public id,name,archived --create name --owner ownerId --query notes --mutation createNote --select id,name
```

Use `--write` instead of `--dry-run` once the choices are authorized. The command emits
ordinary application source, static registrations, and a neighboring schema test.
It refuses collisions and existing feature files. Customize the source directly;
there is no retained feature configuration and no regeneration over customized code.

The recipe supports a single UUID id, exactly one UUID owner relation to User.id,
and non-null text, UUID, Boolean, Int32, Float64, and string-timestamp fields. Omitted
required create fields need defaults. Nullable fields, enums, additional relations,
updates, deletes, and domain validation require the agent to edit ordinary source
using the automation contract. Scaffold output is a starting point; the agent must
also supply frontend API tests and all validation required by the request.

## Completing a change

The agent returns the implemented options, the exposed/withheld field decisions,
the tests and checks run, and any migration still awaiting application. Every feature
schema requires a neighboring `<feature>.test.ts` and an explicit import in schema/index.ts.
`verify` checks those files exist and runs them; test quality remains part of review.

Use [Database](DATABASE.md#changing-storage) for migration planning and application.
An agent can plan and show a migration while continuing source work. Applying it to
a database is a separate, explicitly authorized action. A GraphQL-only operation,
such as deleting Project, needs no storage migration.

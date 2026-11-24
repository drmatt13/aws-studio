# Data-feature automation contract

This is the normative output contract for agents propagating data changes. Read
[Data features](../DATA-FEATURES.md) for orientation and
[Database](../DATABASE.md) when storage changes. Project is the implementation
reference; inspect its repository, schema, schema tests, documents/options, and API
tests before editing. Preserve existing application-specific behavior.

Studio supports optional [Access Graph declarations](../PRISMA-ACCESS.md). Preserve
existing directives and accepted policy decisions while propagating a data change.
Generation and sample-data previews validate those declarations; application code must
explicitly bind them to reads and writes for enforcement. The boilerplate Project
reference continues to use its owner-scoped repository and resolver checks below.
Do not replace that boundary or invent policy directives merely to satisfy a check.

## 1. Resolve the requested behavior

Identify the model and change from the request and working-tree diff. The storage
source is `packages/database/prisma/contract.prisma`. Do not treat unrelated existing
edits as part of the request or diff only against HEAD when that obscures the user's change.

Before implementing, resolve this small behavior specification from the request,
existing feature, and established project decisions:

| Decision | Required answer |
| --- | --- |
| Public fields | Which changed fields are exposed or withheld, and GraphQL scalar/nullability |
| Write permissions | Which fields each create/update accepts; defaults, omitted values, explicit null |
| Ownership | Session identity, application owner relation, and who may read/write |
| Operations | Exact requested query/mutation names and behavior, including hard delete versus archive |
| Validation | Domain constraints and normalization; preserve existing rules |
| Screen selection | Which documents/fragments gain or lose fields |
| Cache | Queries affected by each successful mutation |

State the resolved choices briefly. Existing authorization and prior user decisions
count; do not ask again for routine implementation choices. Ask a focused question
only when a meaningful application decision remains unresolved, and continue work
that does not depend on it. Do not invent a CRUD surface, expose all columns, or infer
business validation solely from a storage type. Never expose identity keys, ownership
foreign keys, credentials, or sensitive fields without explicit authorization.

These choices are task inputs, not a new persistent feature manifest. The resulting
application code remains the source of truth. The committed `graphql-chain.review.json`
records reviewed source surfaces, implementation/predecessor bindings and versioned
content-addressed receipts. Version 3 receipts retain an explicit API behavior decision
and client selection/cache decision, each with concise inspectable source/test evidence.
They summarize accepted intent; application code remains authoritative. Private Coding
records retain the detailed typed propagation choices. Matching bindings or recorded
passing outcomes never replace current independent backend/client checks.

Studio contract tasks preserve these inputs and explicit developer decisions in the
existing private Coding task record. API, deterministic Codegen, and client checkpoints
share one candidate; later stages retain established choices. An unresolved meaningful
choice blocks continuation rather than granting an agent permission to invent behavior.
The host independently checks the exact candidate. Candidate checkpoints never acknowledge
saved-source reviews, and contract tasks must not modify `graphql-chain.review.json`.
Apply the reviewed source proposal, recheck saved source, then renew explicit reviews.

## 2. Required source layout

Use the model's emitted repository root for `<plural>`, lowerCamelCase model name
for `<singular>`, and GraphQL list root for `<rootField>`. Preserve established names
on existing features. Use these exact locations for new features:

| Artifact | Required location and shape |
| --- | --- |
| Record | `packages/database/src/contracts.ts`: `type <Model>Record = ContractRow<"<Model>">` |
| Write inputs | Same file: explicit `Pick` / `Partial<Pick>` permissions, named `Create<Model>Input` / `Update<Model>Input` as needed |
| Repository boundary | Same file: `<Model>Repository` interface; only requested methods |
| Repository | `packages/database/src/<plural>.ts`: `create<Model>Repository(client: DatabaseClient)` |
| Repository registration | Import factory and add one entry to `repositories` in `packages/database/src/index.ts` |
| Feature schema | `compute/http/graphql-api/schema/<singular>.ts` |
| Schema registration | `import "./<singular>";` in that directory's `index.ts` |
| Schema tests | Neighboring `<singular>.test.ts`, executing the assembled schema |
| Frontend documents and options | `client-app/src/api/<rootField>/operations.ts` |
| Frontend API tests | Neighboring `operations.test.ts`, using Vitest |

Infrastructure schema files are `index.ts`, `builder.ts`, and `errors.ts`. All other
non-test `.ts` files directly under schema/ are feature modules and require matching
tests and registration. The schema-files test enforces this inventory. Feature tests
are discovered by the root verify command; no per-feature test-script edit is needed.

Do not add a mandatory hooks.ts, a result/variable type mirror, a generic CRUD base,
a feature runtime registry, or a per-table mapper/timestamp helper. Use ordinary
Pothos, Zod, GraphQL Codegen, and TanStack APIs. A custom hook or view model is justified
only by requested behavior beyond the exported options.

## 3. Repository rules

- The generated contract stays inside `@repo/database`. Return derived records as-is.
- A repository that writes a timestamp column passes the ISO string through
  `toTimestamptz` (packages/database/src/timestamps.ts).
- Keep writable field sets explicit. Do not use all record fields as mutation inputs.
- For the owner recipe: `listByOwner(ownerId)`, `findOwnedById(id, ownerId)`, `create(input)`,
  `updateOwnedById(id, ownerId, input)`, and `deleteOwnedById(id, ownerId)` are the standard
  method names. Every read and write matches on id *and* owner in one statement
  (`where({ id, ownerId })`), so another user's row and a missing row are the same `null`
  and nothing happens between checking ownership and writing. Implement only operations
  the feature needs.
- Owner is assigned by the resolver, never copied from public input. Standard updates
  do not permit owner reassignment. Features that transfer ownership need an explicit
  concurrency and authorization design, including protection at the write boundary.
- Declare automatic updatedAt behavior in PSL as documented in Database. No repository
  stamps, branded scalar casts, or broad widening of literal/enum types.

## 4. GraphQL rules

Use the shared builder and errors helpers. Define the feature's public object, named
input/payload types, Zod schemas, and resolvers in its feature file. Use the shared
GraphQLContext; do not initialize a database or verify tokens inside feature resolvers.

| Operation | Standard shape |
| --- | --- |
| List | `Query.<plural>: [<Model>!]!`, direct object list |
| Create | `create<Model>(data: Create<Model>Input!): Create<Model>Payload!`, payload `{ <singular> }` |
| General update, when requested | `update<Model>(id: ID!, data: Update<Model>Input!): Update<Model>Payload!`, payload `{ <singular> }` |
| Specific action | Verb-based field such as `setProjectArchived(id: ID!, archived: Boolean!)`, named action payload |
| Hard delete | `delete<Model>(id: ID!): Delete<Model>Payload!`, payload `{ deletedId: ID! }` |

Preserve an existing operation's public name and signature unless the user requested
an API change. The table defines new operations; it does not require generating all of them.

Expose IDs with ID, booleans with Boolean, text/string timestamps with String.
Choose numeric and enum representations deliberately; never widen an enum into an
unrestricted String just to make codegen pass. The builder defaults outputs to non-null;
set `nullable: true` when approved. For partial updates, omission means unchanged;
explicit null is accepted only where the API permits clearing the field. Reject empty
updates and protected/unknown input fields. Zod object schemas are strict; validate
before writing. Apply only the requested/established trimming and business bounds.

For Project-style ownership:

1. Resolve the application user id with `await requireCurrentUserId(context)` from
   `../graphql-context`. It looks the user up once per request, however many resolvers
   ask, and answers NOT_FOUND ("User not found") when there is no application user.
2. Lists call `listByOwner(ownerId)`. Creates inject the owner id on the server.
3. Reads, updates and deletes call the owner-scoped repository method. A `null` result —
   the row is missing *or* belongs to someone else — is `notFound("<Model> not found")`.
   The API never distinguishes the two, so it never reveals another user's row exists.
4. Hard delete returns the actual deleted row's id.

Use `invalidPayload` / `badUserInput` for validation errors (BAD_USER_INPUT) and
`notFound` for rows the caller cannot see. Preserve repository failures; do not turn
outages into NOT_FOUND or unauthorized responses.

User is the existing exception: `currentUser` may provision from a verified Cognito
identity, and `updateCurrentUser` writes by session sub. It exposes a CurrentUser view,
not a generic owner CRUD model. Do not copy its provisioning into new model resolvers.

## 5. Frontend rules

- Put every GraphQL operation in operations.ts under src/api. Codegen scans `.ts`, not
  component `.tsx` files. Reuse `<Model>Summary` for repeated selections of the same view.
- Name documents from their operations: `ProjectsDocument`, `CreateProjectDocument`,
  `DeleteProjectDocument`. Keep the selected fields limited to the consumer's needs.
- Export one key factory per feature, `<singular>Keys`, with every cached query under one
  prefix: `all: ["<rootField>"] as const`, `list: () => [...<singular>Keys.all, "list"] as const`,
  and `detail: (id) => [...<singular>Keys.all, "detail", id] as const` when a detail query exists.
  Parameterized keys include every result-affecting input.
- Export `<rootField>Query = queryOptions({ queryKey: <singular>Keys.list(), ... })` and
  `<mutationField>Mutation = mutationOptions(...)`.
- Call executeGraphQL with the generated document. Documents are typed strings
  (codegen's `documentMode: "string"`); the transport sends the text and its persisted-document
  hash. Type mutation variables with `VariablesOf<typeof Document>` and pass the same
  variables object to the transport. Infer results; unwrap the list, payload record, or
  deletedId inside the operation.
- Return `client.invalidateQueries({ queryKey: <singular>Keys.all })` from the mutation's
  onSuccess callback, using its fourth argument `{ client }`: the prefix covers the list and
  any detail query. Extend it only for related features' queries. Do not invalidate all queries.
- Preserve transport error codes and rejected promises. Never return a success-shaped
  fallback after failure or make components responsible for required invalidation.
- Components consume `useQuery(options)` / `useMutation(options)`. When UI is requested,
  connect pending/error states and prevent conflicting duplicate submissions.
- currentUser follows the same operations/options pattern: export `currentUserKeys`,
  `currentUserQuery`, and `updateCurrentUserMutation` from operations.ts. Preserve its
  singleton `["currentUser"]` cache key and auth retry behavior: session-expired errors
  are not retried; other failures receive at most two retries. Components may override
  `enabled` with `useQuery({ ...currentUserQuery, enabled })`.

## 6. Required behavioral tests

Every feature schema needs its own `<singular>.test.ts`, including User. Import `schema`
from `./index` and call GraphQL's `graphql` function with a fake GraphQLContext and typed
repository fakes. Exercise the public operation, not an extracted resolver. Assert the
response/error and repository calls so an omitted authorization check fails the test.
No credentials, live database, or HTTP server are needed for these tests.

Cover each operation the feature actually has:

| Behavior | Required assertions |
| --- | --- |
| Public contract | Requested fields appear with intended values/nullability; withheld fields cannot be queried |
| List/read | Correct session owner/filter; empty list or missing-row behavior as applicable |
| Create | Valid data/normalization, server-assigned ownership, invalid input rejected without writes |
| Update | Intended fields changed, omitted fields preserved, empty/invalid/null input policy, protected fields rejected |
| Update/delete authorization | The write is scoped to the session owner's id; a foreign owner's row answers NOT_FOUND, exactly as a missing row does |
| Missing | Missing application user produces NOT_FOUND with zero writes; a null owner-scoped result produces NOT_FOUND |
| Delete | Exactly the requested owned id is removed; returned deletedId matches |
| Feature exception | Provisioning, computed fields, enum/nullability semantics, or other requested domain behavior |

In operations.test.ts, execute the TanStack options with QueryClient and mock only the
transport. Assert variables/result selection, successful invalidation of affected keys,
unrelated keys remaining fresh, and failed mutations preserving cached data and errors.
Existing transport tests own HTTP/error-code behavior; don't duplicate that suite per feature.

For a newly exposed/changed field, add an assertion that would fail if the agent omitted
that field from the schema or selected frontend document. Inspect/execute the actual
document (parse the typed string with graphql's `parse`, or assert its selection), not only
a mocked response containing the field.
Use type fixtures for compile-time guarantees where needed. Passing tsc is not evidence
that the requested field was exposed or that every mutation enforces ownership.

## 7. Execution and completion

1. Read the current feature and resolve the behavior specification above.
2. For storage changes, emit artifacts, plan the migration using Database's procedure,
   inspect/show the SQL, and continue source implementation. Do not apply migrations,
   start a migration container, or deploy as part of propagation. Application requires
   a separate explicit request targeting the intended database/environment.
3. For a supported new list/create feature, preview the scaffold with explicit choices,
   then write it. Add business validation and API tests. For existing or unsupported
   features, edit their ordinary source; never rerun a scaffold over customized files.
4. Make the repository, static registrations, schema, documents/options, and tests agree.
   Add a model/field -> output mapping to the handoff; explicitly account for omissions.
5. Generate GraphQL before building new frontend selections (`npm run codegen`). Build
   the client if changed, then run `npm run contract` and the relevant behavioral tests. Fix failures
   at their sources; never hand-edit generated directories or weaken a test to hide drift.
6. Review the diff for unrequested public fields, write permissions, destructive SQL,
   handwritten generated types, and unrelated edits. Compare the behavior specification
   to the completed source and tests; the compiler cannot perform that review.
7. After the checks pass, explicitly review only fully reconciled saved-source evidence.
   Inside a Studio contract task, leave the review record unchanged and report the
   required scopes; the developer applies the candidate before renewing source proof.
   Outside that candidate workflow, read
   `node --import tsx client-app/server/graphql-chain/cli.ts status --json`, then
   use `node --import tsx client-app/server/graphql-chain/cli.ts accept --model <Model> --expected <revision>`
   for each reconciled model. Read status again between updates because each stamp changes
   the revision. Next use `accept --api --expected <revision>` with fresh status to review
   repository/Pothos implementation against the current compiled database contract. This
   requires all model reviews current and passing independent backend checks. API and
   client acceptance also require `--decision "<deliberate choice>" --evidence "<source/test references and rationale>"`;
   supply real reviewed intent, never generic completion claims or sensitive payloads. Then use
   `accept --client --expected <revision>` with those explicit notes and fresh status only after API and Codegen
   confidence are verified and the entire SDL/implementation delta has been reconciled with
   client documents, options, cache behavior and consumers, including deliberate omissions.
   A private database field may produce identical SDL/generated files; it still invalidates
   downstream proof and requires successful validation and explicit no-op review renewal.
   Reads never generate artifacts or upgrade version 1/2 records; acceptance upgrades them
   while preserving unrelated model reviews. A failed/unavailable independent check cannot
   be acknowledged away, and an agent's completion message is not verification.
   Never hand-edit the record, acknowledge unrelated pending work, or create a baseline to
   hide drift. If validation or application intent remains blocked, do not stamp that work;
   report it in the handoff. Run `npm run verify` after explicit review renewal. Its final
   mandatory `npm run contract:check` independently validates the saved checkout and rejects
   missing, stale, incompatible or incomplete proof. It never creates review acknowledgements.
   A genuinely unreviewed checkout may use `accept --baseline --expected <revision> --decisions-file <file>`
   with explicit `{ "api": { "statement": "...", "evidence": "..." }, "client": { "statement": "...", "evidence": "..." } }`.
   Baseline acceptance requires every declared independent check and writes all four receipts atomically.

Coding resolves Node and npm from the private project's pins. Contract generators
and executable checks use that pair inside the native validation boundary. A pinned
metadata worker reads project bytes with filesystem writes and subprocesses disabled.
Studio checks the installed verifier policy before reading proof identity and records
the project Node version in the source revision used for review.
Architecture previews apply the same runtime selection to each frozen revision.

The gate runs without Studio or a Coding agent. It executes the fixed validator against
a private checkout capture with a minimal environment; this is trusted repository test
execution, not an OS sandbox. Studio/Coding retain their existing restricted executor.
`status --json` remains informational; `status --check` and `verify` return 0 only for a
complete currently verified lineage, 1 for known pending/drift/failure and 2 for unavailable
evidence, including missing evidence beneath a blocked successor. Verification never emits
database or GraphQL artifacts; generation remains an explicit separate command.

Receipts bind normalized source and output identities, lockfile/tool versions, checker
policy, independent outcomes, accepted decisions and exact predecessor receipt IDs.
Use the CI-pinned Node 24.22.2 for reproducible receipt identity; supported later Node 24
patches require fresh review because tool versions are part of the proof. Source restoration,
identical generated outputs or a previous passing flag cannot renew stale proof. A changed
checker or its installed control dependencies requires restarting the checker host before
it can attribute checks to the new implementation. Native releases seal both identities;
cached or bundled validator code cannot receive a newer dependency label.
Candidate receipts stay candidate-scoped; Apply requires saved-source reinspection and
explicit reviews. Restored caches and interrupted candidate checks remain historical.

Content addressing detects inconsistent evidence; it is not signing or authenticated
reviewer identity. Repository review/access controls remain the authority for who may
accept decisions. The optional local checkout/CI report is a comparison of receipt IDs,
not authenticated CI provenance and never an input granting trust. Offline proof does not
establish live database behavior, deployed compatibility or rendered application UX.
Portable identity binds the committed lockfile, observed tool versions and the normalized
common installed-source inventory, including transitive implementations. Native/platform
artifacts use lockfile resolution plus local byte/metadata execution guards rather than
cross-machine byte equality. Receipts do not authenticate package installations.

For renames/removals, search callers and fragments, remove obsolete references, and
review whether the API change is breaking. Do not reinterpret a rename as a safe
add/drop migration without inspecting SQL and data preservation. For nullable/enum
changes, cover both accepted and rejected values and explicit-null versus omission.
For relationship changes, resolve authorization and deletion effects before writing.

A completed handoff names the exported options, public/withheld fields and rationale,
ownership/validation changes, checks actually run, and migration status. Report blocked
checks precisely. Never claim live database, AWS, or browser validation from offline tests.

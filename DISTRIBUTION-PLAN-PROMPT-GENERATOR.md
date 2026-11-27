# Prompt generator: the final AWS Studio 1.0 distribution plan

## How to use this file

- **When.** Run this after [the readiness checklist](REFACTOR-READINESS-CHECKLIST.html) has been worked through. Its data, including your results, is in `REFACTOR-READINESS-CHECKLIST.json`.
- **How.** Give the full contents of this file to an agent as its entire prompt. Start the agent at the workspace root `/Users/matt/Desktop/code/aws-studio-workspace/`. It needs no other context.
- **Output.** It writes one file: `aws-studio/DISTRIBUTION-PLAN-PROMPT.md`.
- **Next.** You then run that output file, alone, in **Plan Mode**. That run researches and produces the implementation-ready plan that takes AWS Studio to its first public distribution with an upgrade lifecycle you can rely on.

Everything below this line is the prompt.

---

## A. Your job

You are writing a **prompt**, not a plan. The prompt you write will be run, with no other context,
by a planning agent in Plan Mode. That agent must then produce a single, implementation-ready
architectural plan that:

1. brings AWS Studio to its final initial distributed form (public 1.0)
2. leaves the owner confident they can keep developing the platform centrally while thousands of developers maintain independent applications on it

After 1.0, every framework change, security patch and unfinished feature must reach existing
projects through a predictable, safe, reviewed upgrade.

Your prompt has to give that agent everything it needs:

- the owner's goals and requirements
- the decisions already made, and their reasons
- the decisions still open
- the evidence, with file paths
- the results of the readiness work the owner did over the past weeks
- the exact output the plan must contain

Use independent judgment while reconciling. If a readiness result contradicts the reference
material, or the current code contradicts both, say so plainly in the prompt. Don't paper over it.

## B. Rules for this run

1. Write exactly one file, `aws-studio/DISTRIBUTION-PLAN-PROMPT.md`. Don't modify, create, delete or commit anything else.
2. Run only read-only commands, such as reading files, `git log`, `git show`, `git status`, `grep` and `node -e` that only reads. Don't run AWS commands, deployments, installs, migrations or anything billed or destructive.
3. Never copy private data into the output: credentials, secret values, `.env` contents, AWS account IDs, profile names, emails, user data. Where a readiness result says "see private note", write "recorded privately by the owner".
4. If a file this prompt mentions is missing, say so in the output and fall back on section F.

## C. Read these inputs, in this order

1. `aws-studio/REFACTOR-READINESS-CHECKLIST.json`. This is the primary input. The HTML file beside it is only an editor; ignore it. The JSON has:
   - `grounding[]` (`title`, `body`): the plain-language "Start here" background, in the owner's terms. Use it to keep the generated prompt's framing and vocabulary consistent with how the owner understands the work.
   - `intro`, `scope` and `rules`: Markdown text the owner may have edited
   - `updatedAt`: when the editor last saved
   - `steps[]`, each with:
     - `number`, `title` and `gate` (true for gate steps)
     - `done`, and `status` (one of `not started`, `done`, `changed`, `blocked`, `skipped`)
     - `objective`, `why`, `references`, `do` and `doneWhen` (Markdown, possibly edited by the owner)
     - `technical`: Markdown background with files, symbols and decision IDs, written on 2026-11-25. Re-verify it against current code before carrying it into the prompt.
     - `results.fields[]` (`label`, `value`)
     - `results.table` (`columns`, `rows`), or null

   Extract every step's status, field values (including "Decisions or deviations" and "Follow-ups") and table rows. If the owner edited a step's text, treat the edited text as the step's current intent.
2. `aws-studio/REFACTOR-READINESS-REFERENCE.md`. The full background, proposals and decision register (R0 to R25).
3. `aws-studio/REFACTOR-FREEZE-LIST.md` and `aws-studio/REFACTOR-COUPLING-MAP.md`, produced by checklist Steps 22 and 21.
4. `aws-studio/AGENTS.md`, `aws-studio/docs/aws-studio-knowledge/README.md`, and from `aws-studio/docs/aws-studio-knowledge/architecture/decisions.md`: ADR-008, ADR-010 and any ADR newer than ADR-010.
5. `aws-studio/docs/aws-studio-knowledge/research/*.md`.
6. Git state for `aws-studio` and `aws-studio-starter-projects`. Apta has been deleted from the workspace.
   - current HEAD
   - tags, especially `pre-refactor-baseline`
   - `git log --oneline <tag>..HEAD`
   - `git status --short`
   - also `aws-studio/scripts/starters.json`
7. The evidence directories named in checklist results, usually under `aws-studio/output/refactor-baseline/`. Summarize them; don't paste raw logs.

## D. Gate check, before writing the prompt

The gate steps are:

| Step | Covers |
| --- | --- |
| 3 | Names |
| 8 | Production golden path |
| 15 | Stability tiers |
| 16 | Change-delivery rules |
| 18 | Persisted owner value and names |
| 22 | Freeze list |

**If any gate step is not `done` or `changed`:**

1. Don't write the planning prompt.
2. Write `aws-studio/DISTRIBUTION-PLAN-PROMPT.md` as a short report headed `NOT READY`. List each unresolved gate step, what is missing, and what would resolve it.
3. Stop.

**If the gate steps are resolved but other steps aren't,** continue. List each unresolved step in
the prompt's "Known gaps" section, stating the assumption the planner should use and how to
verify it.

## E. Reconciliation, before writing

**1. Decision status.**

For each decision D01 to D49 and each correction C1 to C5 in section F, set its status:

- confirmed
- changed (state the new form)
- rejected (state the replacement)
- unresolved

Use the checklist results. This table shows which steps decide which items:

| Step | Decides |
| --- | --- |
| 3 | D10 |
| 6 | Baseline for D04 |
| 8 | Production validity of D04, D21, D22, D23, D43 |
| 9 | Tier of the high-availability settings |
| 11 | D38 |
| 12 | D24 |
| 13 | D26 |
| 14 | D16, D17, D18 |
| 15 | D39, D47 |
| 16 | D01, D02, D05, D13, D30, D39, D40, D41 |
| 17 | D28 |
| 18 | D08, D09, D11, D46 |
| 19 | D31 and the starter contents |
| 20 | D49 |
| 21 | D44 |
| 22 | D41, D42, D43, D45, D46 |

A decision not covered by any step stays "proposed". The planner must confirm or replace it.

**2. Fact drift.**

Re-check the key facts below against the current source, because the code may have changed
during the readiness weeks. For each, record "still true", "changed (how)" or "gone".
`<starter>` means `aws-studio-starter-projects/reference-app`.

- Persisted owner value: `grep -n "FRAMEWORK_OWNER" aws-studio/packages/aws-studio/src/deploy/identity.ts`
- Upgrade internals: `grep -n "export function projectUpgradeFile\|export async function prepareProjectUpgrade\|function applyCandidateEdits\|databaseArtifactsDigest" aws-studio/client-app/server/project-upgrade.ts`
- Upgrade planning: `grep -n "planFrameworkUpgrade\|planCreationUpgrade\|stableIdentity" aws-studio/client-app/server/edits/batch.ts`
- Ownership catalog: `grep -n "STARTER_STACKS\|LOCAL_SETTINGS\|projectOverride" aws-studio/client-app/server/model/framework-resource-catalog.ts`
- Declaration loading: `grep -rn "requireDeploymentSettings\|PROJECT_DECLARATIONS" aws-studio/packages/aws-studio/src aws-studio/packages/aws-studio/cdk aws-studio/client-app/server`
- Migration spaces: `grep -n 'space === "app"\|readMarker\|snapshots' aws-studio/packages/aws-studio/database/studio-migrations.ts`
- Local PostgreSQL image: `grep -n "image: postgres\|postgres_data" aws-studio/packages/aws-studio/dev/compose.yml`
- Compose project name: `grep -n "export function resolveProjectName" -A3 aws-studio/packages/aws-studio/src/local/project-name.mjs`
- GraphQL builder: `grep -n "new SchemaBuilder" <starter>/compute/http/graphql-api/schema/builder.ts`
- Account linking: `grep -n "AdminLinkProviderForUser\|autoVerifyEmail\|NEVER_LINKED_PROVIDERS" <starter>/compute/events/cognito-pre-signup-trigger/index.ts`
- Pool attributes: `grep -n "required: true\|signInAliases" <starter>/cdk-app/lib/app/cognito-stack.ts`
- Identity service coupling: `grep -rn "AUTHENTICATION_STACK_FILE\|UserPoolIdentityProvider" aws-studio/client-app/server aws-studio/client-app/shared`
- Studio state store: `grep -n "CREATE TABLE IF NOT EXISTS\|user_version" aws-studio/client-app/server/operations/store.ts`
- Frontend release outputs: `grep -n "FrontendWebsiteBucketName\|CloudFrontId\|FrontendDistributionId" aws-studio/client-app/server/frontend-release.ts`
- Package exports: `node -e "console.log(Object.keys(require('./aws-studio/packages/aws-studio/package.json').exports).length)"`
- Prisma version: `node -e "const l=require('./aws-studio/package-lock.json');console.log(l.packages['node_modules/@prisma/orm-toolchain']?.version)"`
- Cross-space PSL support: `grep -rln "PSL_UNSUPPORTED_CROSS_SPACE_LIST" aws-studio/node_modules/@prisma/orm-family-sql/dist`
- Identity harness: `grep -n "Usage: infrastructure-identity" aws-studio/packages/aws-studio/cli/infrastructure-identity.ts`

If the readiness weeks included refactor work, also list the commits since the baseline tags and
what each changed.

**3. Feature inventory.**

Build it from checklist Steps 10 and 15. For each feature, give:

- its tier
- its evidence
- the gaps to close before 1.0
- its delivery channel (Studio release, package upgrade, database review, or behavior revision)
- its bin: Freeze, Slot or Build

**4. Problems found.**

From checklist Steps 7 to 9, collect every problem. Mark each as structural (fixed, or open) or
functional.

**5. Contradictions.**

List every place where readiness results, the reference file and the current code disagree.

## F. Context capsule

Use this if the reference file is missing. Otherwise it's a cross-check. It reflects the
research of 2026-11-25. Readiness results and current code override it.

### F1. The owner's goals and requirements

**The situation.** AWS Studio is about to be released publicly. It is a local, source-linked
editor and architecture viewer for an AWS application framework: TypeScript declarations drive
CDK, local execution, generated contracts and Studio's graph.

After release, the owner must be able to make these changes and deliver them through a reviewed
project upgrade:

- add framework capabilities
- change existing framework-managed infrastructure
- patch security vulnerabilities
- evolve integrated services

**Stated requirements:**

1. Change the managed logic of the RDS stack.
2. Add a new framework-managed native CDK stack that existing projects receive.
3. Add a new framework-managed Lambda, ECS task or other workload.
4. Be protected even though few additions are expected.
5. Keep an immutable reference app per release, plus CI testing upgrades from historical versions. The full pipeline can grow after release.
6. Deliver features that are unfinished at 1.0 through later releases.

**Unfinished at 1.0, per the owner:**

1. Prisma AG (Prisma Access) enforcement in the Lambda GraphQL Pothos API. It has no plugins yet.
2. The database pages History & migrations, Database status, Saved SQL and Data retention. They are untested, and their functionality may change.
3. Production deployment, and automated client-app build and CloudFront release. Neither is finalized or tested.
4. The `/cognito` routes and the `/domains` pages. They are not fully built or tested.
5. RDS Multi-AZ, read replicas and disaster recovery. These are planned for later. The settings already exist in code but are untested.
6. Teardown with retained backups, and redeploying from those backups, for RDS and Cognito. Also an idea for a framework-managed development S3 bucket so developers on different machines can share local Postgres and Cognito data through preset baselines and rollbacks.

**The managed database is central.** Preserve and strengthen how it ties these together:

- the database schema workspace (`/database/schema`)
- automated Prisma migrations
- the GraphQL schema workspace and Contract Chain propagation (`/graphql/schema`)
- the Prisma Access Graph and generated authorization contracts
- the preconfigured Prisma repositories used by auth
- Cognito users meshed with database users

**Priorities, in order:** longevity, maintainability, backward compatibility, security
patchability, developer autonomy, operational safety, least complexity.

### F2. Workspace

- Root: `/Users/matt/Desktop/code/aws-studio-workspace/` (not a git repository).
- `aws-studio/`: the platform. Studio is in `client-app/`. The framework package is `packages/aws-studio` (name `aws-studio`, 1.0.0, private). Research HEAD was `8b0a51f`.
- `aws-studio-starter-projects/reference-app`: the starter. HEAD `61d8847`; `aws-studio/scripts/starters.json` pins `47d90d7`.
- **Scope.** No one uses AWS Studio yet: no production app, and no one else's project or deployment, depends on it. The reference app is a throwaway working app. Apta has been deleted from the workspace. Nothing existing is migrated or kept compatible. Compatibility starts at public 1.0.
- `old/aws-studio/`: a snapshot from before the split, for regression diffs only.
- Studio runs on `127.0.0.1:4590` via `npm run studio -- --project <dir>`. Its `/api` needs a session credential.
- Docs checks: `node docs/aws-studio-knowledge/check.mjs` and `python3 docs/check-links.py`. The link checker scans every `.md` in `aws-studio` and fails on links that leave the repository.
- Test harness: `scripts/with-test-project.mjs`. Leave `TMPDIR` at its default.
- Toolchains: Studio on Node 26.13.0 and npm 11.20.0; apps on Node 24.22.2 and npm 11.19.1.

### F3. How framework code reaches projects today

1. **Studio host catalog.** `client-app/server/model/framework-resource-catalog.ts`:
   - It has hard-coded `STARTER_STACKS` and `LOCAL_SETTINGS`.
   - It imports `DEPLOYMENT_SETTING_KEYS` from Studio's own package copy, so the version can skew from the project's.
   - An explicit `managedBy` becomes a locked project override.
2. **Vendored package.** `file:vendor/aws-studio-1.0.0.tgz`, with sha512 integrity in the lock:
   - CDK factories `createFrameworkFoundation`, `createFrameworkTasks`, `createFrameworkOrchestration`, `createFrameworkWorkloads`
   - config, runtime, CLI, local runtime, Compose base
   - 105 export subpaths, including `./cdk/*`
   - `studioCompatibility { minimumStudio, protocol: 1, capabilities }`
   - peer dependencies `aws-cdk-lib ^2.274.0` and `constructs ^10.6.0`
3. **Starter copy.** `client-app/server/project-create.ts` `createStudioProject`:
   - It records no provenance.
   - It copies a personal `author` field.
   - Framework-intended code living in project copies:
     - `cdk-app/lib/app/{rds-stack,frontend-website-s3-stack,frontend-routing,frontend-routing-handler,cognito-stack,auth-providers,identity-pool-access,identity-policy}.ts`
     - `cdk-app/lib/application.ts`, which owns stack order and deployed names
     - `cdk-app/bin/app.ts`
     - `framework-config/inputs/deployment.ts` and `cdk-app/framework-inputs.ts`
     - the sign-in provider catalog and inputs
     - `framework-config/stacks/{rds,cognito}.ts`
     - `framework-config/templates/**`
     - `compute/tasks/db-migrate/{migrate.ts,review-task.ts,Dockerfile}`
     - the auth Lambdas `compute/events/cognito-*` and `compute/http/{oauth-callback,sign-in,refresh,sign-out,verify-session,mfa}`, about 800 lines
     - the GraphQL framework parts `compute/http/graphql-api/{index,graphql-context}.ts` and `lib/*`, about 365 lines
     - the user repositories and seed/prune scripts in `packages/database`
     - 15 framework CDK tests
     - skills and `AGENTS.md`
   - Compose is already package-owned: the root `docker-compose.yml` is a 5-line include, and the services file is generated.

### F4. Upgrade machinery that already exists

Extend it; don't replace it.

- **`prepareProjectUpgrade(root, prepare)`** in `client-app/server/project-upgrade.ts`:
  - It installs Studio's bundled archive in a private candidate (offline lock, offline `npm ci`).
  - It refuses lifecycle changes to source or to generated database artifacts.
  - **It runs a `prepare` callback whose source changes are applied in the candidate (`applyCandidateEdits`). Creation upgrades already use this.**
  - It runs `aws-studio verify --json` and binds the source, dependency, inputs and runtime digests.
  - `projectUpgradeFile` limits only the upgrade's own computed changes.
- **`planFrameworkUpgrade`** in `client-app/server/edits/batch.ts` checks model identity (`stableIdentity`) but no CloudFormation templates.
- **Apply and recovery:** journals and `--recover-upgrade [--status | --keep-current]`.
- **Upgrade offer:** shown only for `file:` pins older than Studio's bundled framework. Same version with different bytes is never offered. The starter vendors a pre-release `1.0.0` that no one depends on, so it simply vendors the freshly built release archive. The pre-1.0 rehearsal uses versions that sort correctly (`1.0.0-rc.N` → `1.0.0`).
- **Deploy plan:** `packages/aws-studio/cli/deployment-plan.ts` (`STATEFUL_TYPES`, `templateChanges`, `changedExports`).
- **Refactor identity proof:** `npm run infrastructure:identity -- capture --mode dev|prod --out <file> [--bundling]` and `compare <a> <b> [--strict]`.
- **Stateful lifecycle:** retention, teardown and reference reattachment for RDS and Cognito.
- **Qualifiers:** `scripts/verify-studio-distribution.mjs`, `scripts/qualify-retained-cohorts.mjs` and `scripts/qualify-project-compatibility.mjs`. They are not in CI.

### F5. Deficiencies

1. No update path for starter-copied framework code.
2. RdsStack imports project files.
3. The package depends on internals of copied stacks: `RdsStack.RdsDatabaseEndpoint`, `framework:task-launch:v1:db-migrate`, and about 36 files of hard-coded database and GraphQL paths.
4. `requireDeploymentSettings` throws when a setting is missing, so adding a setting breaks older projects.
5. Template IDs live in the package while template files live in the project.
6. Unreserved namespaces: a shared `stackId`, and closed reserved lists.
7. 105 exports with no API gate.
8. No provenance, layout revision or behavior revision.
9. Split ownership truth.
10. Unpatchable security code.
11. The `users` table, keyed by `cognito_sub` with a unique `email`, sits in the developer's contract and `app` space.
12. Cognito settings fixed at creation: required `email`, `givenName` and `familyName`.
13. Local `postgres:16` with a persistent volume.
14. The routing Lambda bundles at the project's synth, and `pgadmin4` is unpinned.
15. Qualification is not in CI.
16. Pre-release compatibility code that nothing depends on. Candidates: the deprecated settings `prodUrl` and `prodCloudFrontCertificateArn`, `REQUIRED_FRAMEWORK_INPUTS` (a "legacy requirement list"), the `PROD_DEPLOYMENT` and `CDK_APP_NAME` inputs-file checks, identity contract 1 readers, ADR-010's legacy-artifact release guard, the `legacy-javascript` templates and the `managedBy` lines. Deleting them is free before 1.0.
17. 80 CDK feature flags and the locked `aws-cdk-lib` shape framework output.
18. Studio loads project declarations with its own loader.

### F6. Persisted identifiers

- **Owner value.** `FRAMEWORK_OWNER = "matts-aws-framework"` is on every stack and resource tag and on the SSM record.
- **Key family.** Tags and metadata use `framework:*` (contract 2). Context uses `framework:app`, `framework:appId` and `framework:targets`. SSM uses `/framework/deployments/<deployment>`.
- **Compose project.** It equals `framework:app`, and volume ownership checks only the project label, so two checkouts with the same app name share one `postgres_data` volume. This is a small future-user safety item (D25), not a migration.
- **Database.** `app_user`, the marker keys `prisma_8.contract.marker:<ns>:<space>`, and `DATABASE_REVIEW_PROTOCOL = 1`.
- **Product-named.** The package and CLI `aws-studio`, the `package.json` key `awsStudio`, the env prefix `AWS_STUDIO_*`, and `.cache/framework-studio/`.
- **Setting env names** read by pages: `FRONTEND_URL`, `COGNITO_*`, `DATABASE_*`, `LOCAL_*`.
- **Trademark.** "AWS" in a third-party product name needs trademark clearance, and AWS App Studio already exists.

### F7. Target architecture (proposed in research)

**Principles:**

- Ownership follows where a definition lives.
- Framework code lives in the package. Projects hold declarations, seed files and their own code.
- The gates are separate:
  - source goes through the reviewed upgrade or edits
  - infrastructure goes through the deploy plan
  - data goes through the two-approval database review
  - an upgrade never deploys or migrates
- Projects adopt explicitly: the pin, then the layout revision, then the behavior revision.
- Persisted identifiers are brand-neutral, reserved, and defined in one module.
- Remove synchronization surfaces rather than synchronizing them.

**Tiers:**

| Tier | Contents |
| --- | --- |
| T0 | Studio host |
| T1 | Package |
| T2 | Generated, read-only (Compose services, generated peers, framework migrations, framework skills, env templates) |
| T3 | Developer seeds and code |
| T4 | Private state |

**Four tests for "updatable":** Deliver, Apply safely, Patch fast, Observe.

**Composition.**

- Seeds: `runApplication` in `bin/app.ts`, and `defineApplication({ config, statefulResources, identity: { additionalProviders, extend }, stacks(ctx), afterWorkloads(ctx) })` in `application.ts`.
- `compose()` reproduces today's stack order exactly.
- RdsStack, FrontendWebsiteS3Stack, FrontendRouting (with a prebuilt handler) and CognitoStack move into the package with identical stack and construct IDs, proven by `infrastructure:identity compare`.

**Framework contributions.**

- `defineFrameworkConfig` merges platform sections with `origin` metadata.
- A typed `platform` options object holds the tunables.
- Settings are package-declared and tolerant. The project declaration files are deleted from the starter, and no legacy merge is needed. Missing settings fall back to defaults. The pre-release deprecated keys are deleted before 1.0. Post-1.0 deprecations are aliased until the next major.
- Templates come from the package, with a project override.
- Studio loads declarations through the project's package.
- The local runtime accepts package workload directories.
- Stack references keep the keys `rds` and `cognito`.

**Project record.** In `package.json` `awsStudio`:

```json
{ "record": 1, "layout": 1, "behavior": 1, "origin": { "framework": "…", "integrity": "…", "starter": "…", "studio": "…" } }
```

Plus `.aws-studio/origin.json`, holding a hash for each seed file.

**Revisions.**

- Layout transitions ship in the target package and run in the candidate.
- Behavior revisions are opt-in bundles, adopted by a source-only review with a synth diff, followed by a deploy.

**Upgrade extension.** Transitions, then T2 regeneration (shown in the review), then verify, then
an offline dev and prod synth diff of baseline against candidate. Stateful replacement or
removal, export removal and stack renames are refused unless they come from an adopted behavior
revision.

**Release evidence.** The SSM record gains `framework { version, integrity, layout, behavior }`,
and each framework stack gets a `FrameworkRelease` output.

**API tiers.**

- App-facing semver entry points, with an API Extractor gate: `config`, `app`, `cdk`, `runtime/*`, `graphql`, `auth/triggers`, `identity`, `database`, and the CLI.
- Studio-facing `studio/*`, governed by the protocol and capabilities.
- Everything else internal.

**Reserved names:**

- existing framework stack roles, plus the prefix `Framework`
- target IDs `framework-*`
- env prefixes `FRAMEWORK_` and `AWS_STUDIO_`
- Compose services `framework-*`
- SSM `/framework/**`
- tags `framework:*`
- migration space and PostgreSQL schema `framework`
- stack reference keys `rds`, `cognito` and `framework*`

### F8. Change-delivery rules (proposed after the second pass)

**Four channels:**

| Channel | Arrives by |
| --- | --- |
| Studio UI and orchestration | A Studio release |
| Package | A reviewed pin upgrade |
| Data | The database review |
| Infrastructure behavior | Revision adoption, then a deploy |

**Capability versus revision.** A new capability is an opt-in declaration and needs no revision.
A revision only changes defaults for existing deployments.

**Stability tiers:**

- **Stable:** tests, plus a manual pass, plus a real-account pass for anything AWS-backed.
- **Preview:** may change, but what it persists is versioned with a migration.
- **Hidden:** not shown.

Studio gates every page and operation on the project's framework capabilities.

**Freeze, Slot, Build.**

- Freeze: final at 1.0.
- Slot: only the extension point exists at 1.0.
- Build: finished and tested at 1.0.

**Fallback scope.**

- Can wait for a post-1.0 transition, thanks to provenance: the RdsStack, website and routing move, the migrator, the auth endpoints.
- Can never wait: names and namespace, framework schema and identity, Cognito creation settings and linking, the record, the API surface, the Pothos builder slot, composition, reserved names, Studio state versioning.

### F9. Database platform

**Cloud migration review already exists.** In `packages/aws-studio/database/studio-migrations.ts`,
the starter's `review-task.ts` and `client-app/server/database-cloud.ts`:

- an inputs digest bound to the task image
- verification of the ECS task's identity
- a strict drift check against the historical snapshot
- per-space advisory locks
- marker and ledger identity checks
- an additive-only initialization
- two approvals, each launching a billed Fargate task

**Gaps:**

- Initialization uses only `space === "app"`.
- The drift check uses a single marker and a single snapshot store.
- Nothing orders migrations against deploys.
- `migrate.ts` has an unreviewed no-input apply branch.
- Paths are hard-coded.

**Proposed production sequence:**

1. Deploy the tasks stack.
2. Reviewed expand migration, framework space first.
3. Deploy the remaining stacks.
4. A later contract migration.

No migration runs on deploy.

**Prisma 8.0.0-rc.14 contract spaces:**

- `ControlExtensionDescriptor.contractSpace { contractJson, migrations, headRef }`.
- The PSL parser accepts `space:ns.Name`.
- The interpreter emits app→extension foreign keys with `references.spaceId` for singular N:1 relations, and refuses list cross-space relations.
- Unproven: client composition, Access Graph, Contract Chain, GraphQL chain, Studio, two-space cloud review.

**Proposed framework space** (gated by spike S1):

- namespace `framework`
- `User`: uuid id, non-unique `email`, `emailVerified`, optional names
- `Identity`: `userId`, `issuer`, `subject`, `provider`, `providerSubject`; unique on `(issuer, subject)`
- no `cognito_sub`
- app relations as `framework:<ns>.User`
- fallbacks F1 (package SQL migrations plus a generated read-only mirror model) and F2 (reserved directories in the app space)

**Local PostgreSQL.** The major comes from the declared `engineVersion`, with a `PG_VERSION`
volume pre-check.

**Prisma risk.** The RC's formats are persisted contracts. Decide between moving to GA before
1.0 or planning an RC→GA migration.

### F10. Identity

**Current state:**

- **Auto-linking.** Pre-signup auto-links a Google sign-in to a native account with the same verified email, which violates the owner's rule that matching email is never proof of identity. It also sets `autoVerifyEmail` for every external provider.
- **Meta.** A pre-token trigger trusts Meta emails.
- **Entra.** `xms_edov` is mapped as verified.
- **Callback.** The OAuth callback requires `email_verified`.
- **Squatting.** `ensureCognitoUser` and the unique email let any identity squat an address.
- **GraphQL.** Resolves the current user by `findByCognitoSub`.

**Proposed:**

- Pool requires `email` only.
- A package identity stack that keeps the ID `CognitoStack`, configured through `defineIdentity`.
- Framework pre-signup (policy only, no linking) and post-confirmation triggers. A developer can override a trigger type with their own target that calls the package's steps.
- Lazy user creation only in the auth endpoints and the GraphQL runtime (C1).
- Framework auth endpoints at their existing paths.
- Identity key `(issuer, subject)`.
- Explicit linking after 1.0.

**AWS limits:**

- Required attributes and aliases are fixed at creation.
- A new pool issues new subs.
- There is no pool backup or restore, and passwords can't be exported.
- The model is retain and reattach.

### F11. GraphQL and Prisma AG

**Current state:**

- The enforcement core is in the package (`database/client-access.ts`, `access-runtime`), and `clientAccess` is generated into the project.
- The starter's `schema/builder.ts` is a plain `new SchemaBuilder(...)` with no plugins.
- Enforcement happens through scoped repositories, plus a test-time check of the GraphQL types against `clientAccess`.

**One-way doors:** the builder, the context data handle and the `@access` syntax.

**Proposed:**

- `createSchemaBuilder()` and `createGraphQLHandler()` in the package.
- `@access` frozen as version 1.
- The plugin ships later in report mode.
- Turning enforcement on by default is a behavior revision.

### F12. Production and frontend release

- **The release service already exists, Studio-only:** `client-app/server/frontend-release.ts`.
  - It builds locally.
  - An artifact-bound approval uploads to S3 and invalidates CloudFront.
  - Settings live in `framework-config/deployment/frontend-release.json`.
  - It finds the bucket and distribution by output name.
- **Proposed:**
  - a versioned `framework:frontend-release:v1` descriptor and a versioned settings file
  - Studio-hosted operations stay in Studio for 1.0, bound to versioned descriptors (C4)
  - production must work once before its stacks are frozen (C3)

### F13. Studio pages and state

**What the pages touch:**

- **Saved SQL** writes `packages/database/sql/<kind>/`, plus unversioned records in `.cache/framework-studio/sql-operations/`.
- **Data retention** writes `framework-config/deployment/stateful-resources.ts`, and its evidence hashes files the plan removes.
- **The identity service** regex-parses `cognito-stack.ts`.
- **The operations store** `operations.sqlite` has no schema version.

**Proposed:**

- Studio state versioning.
- Studio readers re-pointed at the evaluated model.
- Setting env names frozen.
- Capability gating.

### F14. RDS availability, recovery and teardown

**Existing but untested:**

- Multi-AZ, replicas and Proxy.
- Retain policies plus final snapshots.
- Reference reattachment, which refuses Proxy and replicas.

**Missing:** no restore.

**CloudFormation restore hazard.** `DBSnapshotIdentifier` must be kept after a restore; removing
it creates an empty instance. A restore therefore needs a permanent `restoredFrom` declaration,
and the deploy plan must refuse to remove it.

**Encryption key.** The AWS-managed key blocks cross-account snapshot sharing. Proposal: a
customer-managed key option at creation in 1.0 (C2).

**Slots at 1.0:** `database.recovery`, `restoredFrom`, reserved names.

### F15. Development data

**Two-way sync is rejected:** it causes conflicts, mixes migration heads, puts personal data in
a shared bucket, and Cognito can't export passwords anyway.

**Proposed for later:** immutable `pg_dump` baselines.

- each bound to a migration storage hash
- stored in a dev-only `FrameworkDevDataStack` bucket
- restored by an explicit operation, refused on a head mismatch
- seeds remain the primary way to share data
- dev pools are retained across teardown, not exported

**Slots at 1.0:** reserved names, plus the identity model.

### F16. Scope and the starter

**Scope:**

- No one uses AWS Studio yet. No migration paths, backups, legacy readers or compatibility shims for anything that existed before 1.0.
- Apta has been deleted from the workspace.
- The plan must not spend effort on existing projects or deployments.

**Starter (the reference app, throwaway until 1.0):**

- choose the public demo set
- remove `author`
- regenerate the migration history and contents freely around the framework space
- delete pre-release compatibility code (D49)
- vendor the release-built archive
- re-pin `starters.json`

### F17. Qualification (proposed minimum)

- golden templates per release
- three fixtures: pristine, customized and minimal
- an rc→1.0 cohort upgrade with a synthetic transition, interrupted-apply recovery, minimum-Studio refusal and mixed Node runtimes
- the qualifiers run in CI
- a feature test matrix
- one manual canary in a real account
- retained artifacts: the distribution and its sha256, the tgz and its sha512, the starter tag, the golden templates, `evidence.jsonl`

### F18. Decisions and corrections

**Boundary and composition**

- D01 Ownership follows origin; remove the catalog lists, `managedBy`, overrides and ownership edits.
- D02 No framework-patchable code in project source; seeds only.
- D03 Package composition `runApplication` and `defineApplication`.
- D04 Move the stacks with identical IDs.
- D05 Framework sections merged with origin metadata.
- D06 Tolerant package settings.
- D07 Package templates with an override.

**Names, records and revisions**

- D08 Keep the `framework:` keys; replace the owner value outright, with no legacy reader.
- D09 Reserved names.
- D10 Name decided before work starts.
- D11 Project record and origin file.
- D12 Two revisions, layout and behavior.

**Upgrade and API**

- D13 Transitions plus synth impact inside the upgrade.
- D14 API tiers with a gate.

**Database and identity**

- D15 Framework Prisma space.
- D16 `(issuer, subject)` identities with non-unique email.
- D17 No email linking.
- D18 Required attribute `email` only; identity stack in the package.
- D19 Framework triggers and endpoints, overridable by target.
- D20 GraphQL runtime in the package.
- D21 Framework migrator; unreviewed cloud apply removed.
- D22 Multi-space review.
- D23 Production sequence.
- D24 Local PostgreSQL major from the declaration.
- D25 Volume appId label.
- D26 AWS-managed key default plus a customer-managed option at 1.0.
- D38 Prisma version policy.

**Distribution, tooling and visibility**

- D27 `file:` tgz remains the installation form.
- D32 Release evidence.
- D33 Prebuilt framework Lambdas.
- D34 Platform workloads visible but not editable.
- D35 No eject.
- D36 CDK flag handling.
- D37 Security badge.

**Policy and transition**

- D28 Support window is the whole major.
- D29 Qualification minimum.
- D30 No existing project or deployment is migrated or kept compatible; compatibility starts at 1.0.
- D31 Regenerate the starter freely, then re-pin.

**Added after the second pass**

- D39 Stability tiers and capability gating.
- D40 Capability versus revision rule.
- D41 Freeze, Slot and Build bins.
- D42 Pothos builder and data handle in the package; `@access` v1; enforcement default via revision.
- D43 Frontend release descriptor.
- D44 Studio readers re-pointed.
- D45 Studio state versioning.
- D46 Env names frozen.
- D47 Feature test matrix.
- D48 Recovery and dev-data slots.
- D49 Delete pre-release compatibility code before 1.0.

**Corrections**

- C1 Lazy user creation only where the workload has database access.
- C2 Customer-managed key option at 1.0.
- C3 Freeze at the 1.0 golden templates; production tested first.
- C4 Studio-hosted operations bound to descriptors.
- C5 Freeze, Slot and Build instead of "release-blocking".

**Spikes**

- S1 Prisma framework space end to end. Runs first. Fallbacks F1 and F2.
- S2 Identity-preserving move using `infrastructure:identity`.
- S3 Offline candidate synth, and whether an output-only change updates a stack.
- S4 Scoping CDK feature flags per stack.
- S5 PostgreSQL 17 or 18, local and RDS.
- S6 Cognito flows with `email`-only pools and no linking.

**Deferred (each needs only its slot at 1.0)**

- a codemod engine beyond the minimal runner
- chained installs
- broad T2 regeneration
- `cdk refactor`
- registry distribution
- Blue/Green
- the engine-upgrade operation and local dump-and-restore
- explicit linking and pool replacement
- an advisory feed
- Aurora
- the full historical cohort pipeline and CI canary
- editing-authority flags
- automated deploy/migrate sequencing
- snapshot and point-in-time restore
- dev baselines
- package CLI versions of the Studio-hosted operations

**External facts to re-verify**

- CDK feature flag behavior
- `cdk refactor` preview limits
- the Amplify Gen 2 package-plus-declarations pattern
- jsii-diff
- RDS Blue/Green limits on CloudFormation and Proxy
- RDS Extended Support
- the `DBSnapshotIdentifier` update rule
- Cognito's settings fixed at creation and its one-Lambda-per-trigger rule
- the Django `contrib.auth` precedent

## G. The prompt you must write

Write `aws-studio/DISTRIBUTION-PLAN-PROMPT.md` with these sections, in this order. Every section
is required. Fill each from sections C to E, falling back on F.

1. **Title and purpose.** One paragraph: what the planning run must produce, and why.
2. **Role and stance.**
   - The planner is a principal AWS platform architect, framework designer and distributed-systems engineer who owns AWS Studio's long-term architecture.
   - Independent judgment is required. Don't agree by default.
   - Fixed decisions are fixed unless the code proves one impossible or unsafe. If so, the planner stops and explains, with evidence, and proposes a replacement.
   - Proposed decisions are hypotheses to test.
3. **Plan Mode rules.**
   - Don't modify, create, delete or commit any file.
   - Read-only investigation only.
   - No AWS, billed or destructive commands.
   - Feasibility that needs execution becomes a gated spike in the plan: exact steps, pass and fail criteria, and a fallback architecture.
   - The deliverable is one plan.
4. **Objective and definition of success.** Getting to 1.0 is successful when all of these hold:
   - every change type in section 16 below has a tested playbook
   - the qualification suite runs in CI against retained release artifacts
   - the Stable features pass their test matrix
   - every Freeze item is final
   - every Slot exists
   - the starter is regenerated from the reference app and re-pinned
   - the readiness checklist for release is complete
5. **The owner's requirements and scope.** Section F1 in full, including the six unfinished areas, in the owner's terms. Also state the scope from F16 plainly:
   - No one uses AWS Studio yet.
   - The reference app is throwaway.
   - Apta has been deleted from the workspace.
   - Compatibility starts at public 1.0.
   - The plan must not add migration paths, legacy readers or compatibility shims for anything that existed before 1.0.
6. **Workspace and current state.**
   - repositories, paths, HEADs and tags
   - the starter pin
   - commits since the baseline tags and what changed
   - toolchains and the hosts to advertise
   - no private data
7. **What the readiness work established.** For each of the 23 checklist steps, two to six lines: the outcome, the evidence path, and any deviation. Restate the content of each step; never refer to a step by number alone.
8. **Fixed decisions.** Every confirmed or changed decision, grouped by area. For each: the full statement, the rationale, the alternatives rejected, reversibility, its bin (Freeze, Slot or Build), and the evidence or readiness result it rests on. Never write a bare ID.
9. **Open decisions.** Every unresolved or proposed decision. For each: the options, a recommended default, and the evidence the planner must gather to close it.
10. **Feature inventory.** The reconciled table from E.3, plus each unfinished area's specific Slot requirements (F10 to F15, updated).
11. **Freeze list.** Every entry from `REFACTOR-FREEZE-LIST.md`, or the section F categories if the file is missing, with the owner's keep-or-change verdict.
12. **Studio–project coupling map.** Every row from `REFACTOR-COUPLING-MAP.md`, grouped by action.
13. **Evidence base.** Verified facts with file paths and symbols, from F3 to F6 and F9 to F14 plus the E.2 drift results. Mark each one "verified <date>" or "re-verify". Include the corrections to earlier claims.
14. **Target architecture as decided.** F7 and F8 updated by the decisions, including:
    - the tiers
    - ownership by origin and the authority axes
    - the composition API
    - framework contributions
    - the project record
    - revisions and transitions
    - the upgrade extension
    - release evidence
    - API tiers
    - reserved names
    - the database platform's seven layers
    - identity
    - GraphQL and AG
    - production and release
    - Studio state
    - recovery and dev-data slots
15. **Known problems.** Structural and functional problems from the golden paths, with status.
16. **Required coverage.** The plan must address all of these, each with current state, decision, alternatives rejected, reversibility and bin:
    1. Ownership and authority across the Studio host, package, generated files, starter and developer source, including the fate of the catalog, `managedBy` and the ownership edits.
    2. Composition and framework contributions.
    3. Settings, templates, reserved names and the persisted namespace.
    4. The project record, provenance, layout and behavior revisions, and transitions.
    5. The upgrade extension: transitions, T2 regeneration, the generated-artifact rule, synth impact and the refusal rule, recovery, concurrent edits, and same-version collisions.
    6. The public API surface and its gate.
    7. The managed database's seven layers, each with a path to "updatable" under the four tests: infrastructure and local Compose, connection runtime, migration engine and review with its persisted Prisma formats, migrator, identity mesh, data contract and propagation, Studio surfaces.
    8. Identity, Cognito, account linking and triggers.
    9. GraphQL runtime, the Pothos builder and the AG enforcement slot.
    10. Production deploy, the migration sequence, frontend release and release evidence.
    11. Studio pages, Studio state versioning and capability gating.
    12. RDS high availability, recovery and teardown slots.
    13. Development data slots.
    14. Rationalizing the version identities: framework, Studio distribution, protocol and capabilities, layout, behavior, database contracts, review protocols, provenance, deployed evidence, API stability.
    15. Upgrade safety: stack and logical IDs, exports, stateful retention, mixed-version runtimes, engine upgrades and drift, local volume compatibility, security patch delivery. A framework upgrade must never deploy or run a destructive database operation.
    16. **Post-release playbooks**, one per change type, each a step-by-step runbook from code change to project adoption. Each says what the framework release contains, what Studio shows, what the developer approves, what the deploy and database gates show, and how qualification proves it. The change types:
        1. modify an existing framework stack
        2. add a framework stack, and where it sits in dependency order
        3. add a framework Lambda or ECS task
        4. add, modify or deprecate a framework setting
        5. add a template or capability
        6. change the framework schema
        7. a security patch
        8. adopt a behavior revision
        9. change the layout with a transition
        10. change a Studio-only page
        11. promote a Preview feature to Stable
        12. a Prisma upgrade
        13. a PostgreSQL major upgrade
        14. a Studio state format change
        15. change composition or stack ordering
    17. **Release rehearsal before 1.0 GA.** Simulate as qualification fixtures: a 1.0.1 security patch, a 1.1.0 additive capability (for example AG report mode or recovery declarations), and a 1.2.0 layout change with a transition.
    18. Qualification, CI and retained artifacts: golden templates, fixtures, cohort runs, the feature matrix, the canary.
    19. Regenerating the starter from the reference app, and deleting pre-release compatibility code: what changes in `aws-studio`, and what changes in the starter repository.
    20. The support window and deprecation policy.
17. **Spikes.** S1 to S6 in full, each with its status from the readiness work (run, partially run or not run). S1 runs first. Give steps, pass and fail criteria, and fallbacks.
18. **How to work.**
    - Read `aws-studio/AGENTS.md` and the knowledge router first.
    - Verify every critical claim in current source.
    - Trace each contract through config loading, CDK synthesis, CLI commands, Studio snapshot and ownership, edits and write guards, the upgrade journal, database tooling, the Contract Chain and GraphQL chain, the local runtime and Compose, deploy planning, qualification scripts and docs.
    - Reuse existing mechanisms.
    - Decide; don't leave options open.
    - Name every one-way door.
    - Avoid unrelated refactoring.
19. **Expected output.** One cohesive plan containing:
    1. An assessment, including drift and contradictions.
    2. The definitive target architecture.
    3. An ownership and authority table covering every starter file class.
    4. The repository and package structure.
    5. Interfaces, contracts and data flows, with TypeScript signatures.
    6. The end-to-end lifecycle, including security patches.
    7. Dependency-ordered phases. Each phase lists its files and symbols, its tests, and measurable acceptance criteria.
    8. Spikes.
    9. The starter regeneration and the deletion of pre-release compatibility code.
    10. Testing, recovery and qualification.
    11. The post-release playbooks.
    12. The release rehearsal.
    13. A public release readiness checklist.
    14. Deferred work, with reasons.
    15. A risk register.
    16. A decision register. Each entry gives ID, decision, rationale, alternatives rejected, reversibility, bin and evidence.

    The plan must be concrete enough for an autonomous coding agent to implement without another broad research session.
20. **Done criteria for the plan.**
    - Every required-coverage item is addressed.
    - Every Freeze item is final.
    - Every unfinished area has its Slot.
    - Every playbook is complete.
    - Every phase has acceptance criteria.
    - The decision register covers every decision in this prompt.
21. **Known gaps.** The readiness steps that are unresolved but not gating, with assumptions and how to verify each.

## H. Writing rules for the prompt you write

- **Self-contained.** The planning agent sees only your prompt and the repositories. Never refer to "the conversation", "the earlier session" or "the checklist" without restating the content. You may name repository files for deeper reading, but every fact the plan depends on must be in the prompt itself.
- **Spell out every identifier.** Never write "confirm D20" or "per Step 19". Always state the full decision or result.
- **Be concrete.** Use concrete paths, symbols and commands. Mark line numbers as approximate.
- **Tag facts.** Tag each fact "verified <date>" or "re-verify".
- **Format.** Prefer numbered lists and tables. Avoid filler. Length is not a problem; missing context is.
- **Keep the owner's voice.** State the owner's requirements and constraints in their own terms, including: never treat matching email as proof of identity; opening a project is inspection only; a framework upgrade never authorizes a deployment or a destructive database operation.
- **No private data.**

## I. Self-check before you write

Confirm each of these before writing the file:

1. All 21 sections from G are present and filled.
2. Every decision from F18 appears once, either in Fixed or in Open.
3. All six of the owner's unfinished areas appear in the feature inventory and the required coverage, with Slot requirements.
4. Every readiness step's outcome is summarized.
5. Every drift result from E.2 is included.
6. There are no bare IDs and no private data.
7. The Plan Mode rules are explicit.
8. The output format of the final plan is fully specified, including the playbooks, the rehearsal and the decision register.

## J. Your reply after writing

Reply with:

- the gate status
- how many decisions are confirmed, changed or open
- the most important drift or contradictions
- the known gaps
- the full path of the file you wrote

Keep the reply short. The file holds the detail.

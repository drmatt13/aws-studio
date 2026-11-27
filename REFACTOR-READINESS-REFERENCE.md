# Refactor readiness reference

This file holds the full context behind [the readiness checklist](REFACTOR-READINESS-CHECKLIST.html).
The checklist's data, including your results, lives in `REFACTOR-READINESS-CHECKLIST.json`. Open the
HTML file in Chrome or Edge to edit it. Its **Start here** section is the plain-language version of this
file, and each step's **Technical background** points back to sections here.
[The step map](REFACTOR-READINESS-MAP.svg) shows all 23 steps on one page.
The checklist says what to do, in order. This file says why, what the code shows, and what has
been proposed. Read the section a checklist step links to before you start that step.

Research date: 2026-11-25. Observed commits: `aws-studio` `8b0a51f`, starter `61d8847`
(pinned in `scripts/starters.json` as `47d90d7`). Line numbers drift. Re-check critical symbols in
current source before relying on them.

**Scope.** Nobody uses AWS Studio yet. No production app, and no one else's project or deployment,
depends on it. The reference app is a throwaway. The readiness work touches only `aws-studio` and
the reference app. Nothing existing needs a migration path, a backup or backward compatibility.
Every compatibility promise starts at public 1.0. See R17.

Everything in "Target architecture" and "Decision register" is a **proposal** until a checklist
step or the final plan confirms it. Treat these as hypotheses to test, not decisions.

## R0 How to use this file

- Each checklist step names one or more sections here, such as R11.
- Sections R3 to R7 describe the **current** code. Sections R8 onward describe the **proposed**
  target and the reasoning for it.
- When a checklist result contradicts something here, the checklist result wins. Note the
  contradiction in the step's results so the prompt generator carries it forward.
- Paths outside this repository (the starter) are written as code, not links, because
  `python3 docs/check-links.py` fails on links that leave the repository.

## R1 Workspace and repositories

| Item | Value |
| --- | --- |
| Workspace root | `/Users/matt/Desktop/code/aws-studio-workspace/` (not a git repository) |
| Platform | `aws-studio/`. Studio host is `client-app/`. Framework package is `packages/aws-studio` (name `aws-studio`, version `1.0.0`, `"private": true`). |
| Starter | `aws-studio-starter-projects/reference-app`. New projects are created from the commit pinned in `scripts/starters.json` (`47d90d7`), not from HEAD (`61d8847`). The starter repository is `github.com/drmatt13/aws-studio-starter-projects`. |
| Reference app | The starter's `reference-app` is a **throwaway** working app. It is changed freely, its database can be reset, and its migration history can be regenerated. |
| Apta | **Deleted** from the workspace on 2026-11-26. It played no part in this work. |
| Old snapshot | `old/aws-studio/`, from before the Studio/framework split (about Nov 15). Studio UI was `framework-studio/` there. Useful only for regression diffs. |
| Studio | Runs on `127.0.0.1:4590`. Open a project with `npm run studio -- --project <dir>`. Its `/api` needs a session credential, so plain `curl` gets 401. |
| Docs checks | `node docs/aws-studio-knowledge/check.mjs` (wiki) and `python3 docs/check-links.py` (every `.md` in this repository, including the root; links leaving the repository fail). |
| Test harness | `scripts/with-test-project.mjs`, `scripts/prepare-test-project.mjs`, `scripts/test-project-source.mjs`. Setting `TMPDIR` to a session scratchpad has failed before because npm masks part of the path. |
| Toolchains | Studio 1.0.0: Node 26.13.0 and npm 11.20.0. Reference app: Node 24.22.2 and npm 11.19.1. Framework 1.0.0 requires Studio 1.0.0 and declares the capability `http-get-with-head`. |
| Uncommitted at research time | `docs/aws-studio-knowledge/research/` and a change to `docs/aws-studio-knowledge/README.md` |

## R2 The problem being solved

AWS Studio is about to be released publicly, and potentially thousands of developers will build
independent applications on it. After release, the owner must keep developing the platform
centrally and deliver these changes through a predictable, safe, reviewed project upgrade:

- new framework capabilities
- changes to existing framework-managed infrastructure
- security patches
- changes to integrated services

The owner's concrete requirements:

1. Change the managed logic of the RDS stack after release.
2. Add an entirely new framework-managed native CDK stack that existing projects receive through an upgrade.
3. Add a new framework-managed Lambda, ECS task or other workload.
4. Be protected for these cases even though few are expected.
5. Keep an immutable, versioned reference application per release, with CI that tests upgrades from historical versions. The full historical pipeline can grow after release.
6. Deliver features that are **not finished at 1.0** through later Studio releases and project upgrades (see R9 and R12 to R16).

The managed database is central and was designed as a framework product. It ties together:

- Studio's database schema workspace (`/database/schema`)
- automated Prisma migrations
- the GraphQL schema workspace and the Contract Chain propagation engine (`/graphql/schema`)
- the Prisma Access Graph ("Prisma AG") and generated authorization contracts
- preconfigured Prisma repositories used by the auth integration
- Cognito users meshed with database users

Priorities, in order: architectural longevity, maintainability, backward compatibility, security
patchability, developer autonomy, operational safety, and the least complexity that achieves them.

## R3 How framework code reaches projects today

There are three delivery channels.

**1. Studio host ownership catalog.**

- `client-app/server/model/framework-resource-catalog.ts`, added in `8b0a51f`.
- `STARTER_STACKS` maps `FrontendWebsiteS3Stack` and `RdsStack` to their starter paths.
- `LOCAL_SETTINGS` is a hard-coded list of 10 local tooling keys.
- `DEPLOYMENT_SETTING_KEYS` is imported from **Studio's own copy** of the package, not the project's.
- An explicit authored `managedBy` becomes `basis: "declared", projectOverride: true`.
- A catalog change applies to every compatible project on its next open with that Studio version.
- Edits made outside Studio are not checked.

**2. The versioned framework package, vendored in each project.**

- The starter depends on `"aws-studio": "file:vendor/aws-studio-1.0.0.tgz"`. The tgz is committed, and the lockfile holds its sha512 integrity.
- The package contains:
  - the framework CDK factories in `cdk/`: `createFrameworkFoundation`, `createFrameworkTasks`, `createFrameworkOrchestration`, `createFrameworkWorkloads`, plus the replay, HTTP, WebSocket, ECS, orchestration and event Lambda stacks
  - `framework-database.ts`
  - config, runtime, CLI, the local runtime and the Compose base `dev/compose.yml`
- `package.json` declares `studioCompatibility { minimumStudio: "1.0.0", protocol: 1, capabilities: ["http-get-with-head"] }`.
- Peer dependencies: `aws-cdk-lib ^2.274.0`, `constructs ^10.6.0`, `@repo/framework-generated: "*"`.
- 105 `exports` subpaths, including a `./cdk/*` wildcard.

**3. The starter copy.**

- `client-app/server/project-create.ts` `createStudioProject` copies the bundled `release/starter`, or the pinned git tree.
- It sets the package name, a new `framework:appId` and the Compose project name (derived from `framework:app`), and deletes `framework:targets`.
- It then runs `npm ci` and `git init`.
- **It records no starter commit, framework version, layout revision or file hashes.**
- It copies the personal `author` field in `package.json` and `cdk-app/package.json` into every new project.

Framework-intended code that lives in starter copies, with no update path:

- `cdk-app/lib/app/rds-stack.ts`, `frontend-website-s3-stack.ts`, `frontend-routing.ts` (bundled with `NodejsFunction` at the project's synth), `frontend-routing-handler.ts`
- `cdk-app/lib/app/cognito-stack.ts` (482 lines), `auth-providers.ts`, `identity-pool-access.ts`, `identity-policy.ts`
- `cdk-app/lib/application.ts` (314 lines). It imports about 17 framework symbols, orders every stack and holds deployed stack names such as `stackId("AsynchronousLambdaFunctionsStack")`.
- `cdk-app/bin/app.ts`
- `framework-config/inputs/deployment.ts` (14 settings) and `cdk-app/framework-inputs.ts` (10 local settings plus `REQUIRED_FRAMEWORK_INPUTS`)
- `framework-config/auth/sign-in-providers.ts`, `framework-config/inputs/sign-in-providers.ts`, `framework-config/stacks/rds.ts`, `framework-config/stacks/cognito.ts`
- `framework-config/templates/**`
- `compute/tasks/db-migrate/` (`migrate.ts`, `review-task.ts`, `Dockerfile`)
- the auth Lambdas: `compute/events/cognito-{pre-signup-trigger,post-confirmation-trigger,pre-token-generation,custom-message}` and `compute/http/{oauth-callback,sign-in,refresh,sign-out,verify-session,mfa}`, about 800 lines of security-sensitive code
- `compute/http/graphql-api/{index.ts,graphql-context.ts,lib/*}`, about 365 lines of framework parts: the Yoga server, hardening, persisted documents and the API Gateway adapter
- `packages/database/src/{users,cognito-users}.ts`, the user parts of `contracts.ts`, and `packages/database/scripts/*` (seed and prune adapters named in `package.json` under `awsStudio.database`)
- 15 CDK tests in `cdk-app/test/` that test framework stacks
- `.agents/skills/*`, `.claude/skills/*`, `AGENTS.md`

Already package-owned or generated, contrary to earlier claims:

- Root `docker-compose.yml` is a 5-line `include` of `node_modules/aws-studio/dev/compose.yml`.
- `docker-compose.services.yml` is generated.
- Overrides go in `docker-compose.override.yml`.

## R4 The upgrade machinery that already exists

These are strong mechanisms. Extend them; don't replace them.

- `client-app/server/project-upgrade.ts`:
  - `projectUpgradeFile` limits the upgrade's **own computed** changes to `package.json`, `package-lock.json` and `.gitignore`.
  - `upgradeArchivePath` accepts only `aws-studio-<ver>.tgz`.
  - `prepareProjectUpgrade(root, prepare)` works in a private candidate copy:
    1. requires a `file:` pin
    2. copies Studio's bundled archive
    3. runs an offline `npm install --package-lock-only`, then an offline `npm ci`
    4. refuses if install lifecycles changed authored source **or generated database artifacts** (`databaseArtifactsDigest`)
    5. runs the `prepare` callback, whose changes are applied in the candidate by `applyCandidateEdits`, path-guarded by `assertAgentSourcePath`
    6. runs `aws-studio verify --json`
    7. binds the source manifest, dependency identity, private input digests and the runtime
- **The `prepare` callback can already carry source changes.** `planCreationUpgrade` (`client-app/server/edits/batch.ts`) already ships a source change together with a pin advance. `planFrameworkUpgrade` passes `changes: []` and runs `validate`, which checks `stableIdentity` (targets and construct IDs). **No CloudFormation template comparison runs during upgrade.**
- Apply and recovery:
  - `client-app/server/edits/journal.ts` (`recoverInterruptedProjectUpgrades`) and `installation-journal.ts`
  - the launcher's `--recover-upgrade [--status | --keep-current <id> <fingerprint>]`
- Studio offers **Review framework upgrade** only for `file:` pins older than its bundled framework (`availableFrameworkUpgrade` in `client-app/server/server.ts`).
- **Same version, different bytes.** The starter vendors a pre-release `aws-studio-1.0.0.tgz`. Studio never offers an upgrade between two archives with the same version (`releaseIsOlder("1.0.0","1.0.0")` is false) and refuses an archive collision. No one depends on the pre-release bytes. Before 1.0, the starter simply vendors the freshly built release archive. The pre-1.0 upgrade rehearsal uses versions that sort correctly, such as `1.0.0-rc.1` → `1.0.0`.
- Admission and compatibility live in `client-app/server/project-release.ts`, `scripts/release-compatibility.ts`, `scripts/studio-release.json` and `client-app/server/project-runtime.ts`.
- The deploy plan is in `packages/aws-studio/cli/deployment-plan.ts`:
  - `STATEFUL_TYPES` covers RDS, Cognito, S3, DynamoDB, Secrets Manager, KMS, EFS and log groups.
  - `templateChanges(deployed, synthesized)` and `changedExports` exist and are reusable for an upgrade synth diff.
  - Change-set review lives in `deployment-review.ts`.
- **Refactor identity proof already exists.** `npm run infrastructure:identity -- capture --mode dev|prod --out <file> [--bundling]` and `compare <before> <after> [--strict]` (`packages/aws-studio/cli/infrastructure-identity.ts`) synthesize offline and report three things separately: identity (stacks, logical IDs, exports), properties (normalized) and assets.
- Stateful lifecycle:
  - `cli/stateful-references.ts`, `cli/retained-resources.ts`, `cli/stateful-teardown.ts`
  - `framework-config/deployment/stateful-resources.ts` in the starter
- The two-approval database review (R10).

## R5 Verified deficiencies

1. **Framework code in starter copies has no update path** (R3).
2. **RdsStack is coupled to project files.** It imports `framework-config/databases/application` and `framework-config/stacks` (`linkResources(this, stacks.rds)`).
3. **The package depends on internals of project-copied stacks:**
   - `cli/root-env-outputs.ts` reads `RdsStack.RdsDatabaseEndpoint`.
   - `cli/export-cdk-outputs.mjs` uses stack names.
   - Studio's cloud migration needs the `framework:task-launch:v1:db-migrate` output from `${deployment}-EcsTasksStack`.
   - About 36 package and Studio files hard-code `packages/database/prisma/...`, `packages/database/src/generated/*`, `compute/http/graphql-api` or `graphql-chain.review.json`.
4. **Required declarations throw when absent.** `requireDeploymentSettings` (`packages/aws-studio/src/config/project-declarations.ts`) throws if a `DEPLOYMENT_SETTING_KEYS` entry is missing. That includes the case where the file is omitted, because `{}` is substituted. `cdk/deployment.ts` calls it at synth. Adding a setting breaks every older project, and deprecated keys (`prodUrl`, `prodCloudFrontCertificateArn`) can never be removed.
5. **Template IDs live in the package while template files live in the project.** `SCAFFOLD_TEMPLATES` is in `src/scaffolding/index.ts`, but files load only from `framework-config/templates`.
6. **Unreserved namespaces.** `stackId(name) = ${deployment}-${name}` is shared between framework and user stacks. The reserved lists are closed (`RESERVED_LOCAL_ENVIRONMENT_KEYS`, `RESERVED_LOCAL_SERVICE_NAMES`, `RESERVED_LAMBDA_ENVIRONMENT_KEYS`, `RESERVED_SERVICE_CLOUD_ENVIRONMENT_KEYS`, `RESERVED_TASK_CLOUD_ENVIRONMENT_KEYS` in `src/config/index.ts`). Target IDs, input keys, export names and SSM paths have no reserved prefix.
7. **Oversized public surface** (105 subpaths) and no API stability gate.
8. **No provenance, layout revision or behavior revision.** ADR-010 names a layout revision, but it is not built.
9. **Ownership truth is split.** The catalog is Studio-versioned, `managedBy` is project-authored, and the defaults are computed. The 24 `managedBy: "framework"` lines added on 2026-11-24 **freeze** those keys as project overrides.
10. **Security-sensitive code can't be patched across projects:** the OAuth PKCE exchange, cookies, GraphQL hardening, persisted documents, identity creation and the migrator review logic.
11. **The identity mesh lives in application data.** `User` is in the developer's `contract.prisma` and `app` migration space, `cognito_sub` is the identity key, and `email` is unique (R11).
12. **Cognito settings fixed at creation are committed in the starter:** required `email`, `givenName` and `familyName`, and the `email` sign-in alias.
13. **Local PostgreSQL is `postgres:16`** with a persistent `postgres_data` volume, and CI pulls `postgres:16`. A major bump makes existing volumes unreadable. `DATABASE_ENGINE_VERSION` defaults to `"16"`.
14. **Non-reproducible framework bundling.** The routing Lambda uses `NodejsFunction` at the project's synth, and `pgadmin4` is unpinned.
15. **Qualification is not in CI.** `qualify-retained-cohorts.mjs` and `qualify-project-compatibility.mjs` exist but `.github/workflows/verify.yml` does not run them, and they prove only dependency activation.
16. **Pre-release compatibility code that nothing depends on.** These candidates exist only to support states from before 1.0. Verify each one before deleting it:
    - the deprecated settings `prodUrl` and `prodCloudFrontCertificateArn` ("Deprecated spelling of …")
    - `REQUIRED_FRAMEWORK_INPUTS`, described in source as a "legacy requirement list"
    - the `PROD_DEPLOYMENT` and `CDK_APP_NAME` inputs-file checks in `packages/aws-studio/cdk/deployment.ts`
    - readers for identity contract 1 ("the identity output only")
    - ADR-010's "release guard for legacy artifacts" kept during transition
    - the `legacy-javascript` template variants
    - the 24 `managedBy` lines

    Deleting them before 1.0 costs nothing. After 1.0, each would need a deprecation cycle (D49).
17. **Framework synth output depends on project settings.** Each project's `cdk.json` carries 80 CDK feature flags, and the project locks `aws-cdk-lib` (`2.274.0` in the starter). Both shape the templates of framework-owned stacks.
18. **Studio reads framework facts from its own copy.** `client-app/server/project-modules.ts` imports the `projectDeclarations` loader from Studio's workspace, and the catalog imports `DEPLOYMENT_SETTING_KEYS` the same way. A project on framework 1.0 opened in Studio 1.1 gets 1.1's loader and labels.

## R6 Corrections to earlier claims

| Earlier claim | What the code shows |
| --- | --- |
| No upgrade can reach project source | False. `prepareProjectUpgrade`'s `prepare` callback applies source changes in the candidate, and creation upgrades already use it. |
| The production migration path is not implemented | Mostly false. Reviewed cloud **initialize, review and apply** exist end to end (R10). Missing: deploy ordering, multi-space correctness, and closing an unreviewed apply branch. |
| `db-migrate` is a thin 110 lines | Outdated. `review-task.ts` holds security-sensitive task identity and review logic. |
| Compose is a starter copy | False. Only a 5-line include seed is in the project (R3). |
| The 24 `managedBy` lines are redundant | They are not inert. They convert those keys to declared project overrides, which locks them against future catalog changes. |
| App PSL relations to extension-space models are unproven | Statically supported (R10). End-to-end behavior is still unproven. |
| No deployed-version evidence | Partly outdated. `writeDeploymentRecord` writes `/framework/deployments/<deployment>` to SSM with the git commit, assembly digest, actor and stacks, but **no framework version**. |
| Existing projects (Apta, earlier copies) need migration paths and backward compatibility | Not needed. No one uses AWS Studio yet. The reference app is throwaway, and Apta has been deleted (R17). |
| Stack moves must keep identical IDs for deployed continuity | Before 1.0 nothing is deployed, so identical IDs are a **regression check** that the refactor changed nothing by accident, not a continuity requirement. A deliberate identity change before 1.0 is allowed if it is recorded. |
| A template-metadata release stamp is enough | Probably not. I believe CloudFormation does not treat a template-metadata-only change as an update, so the stamp would go stale. Use a stack output plus the SSM record (spike S3). |
| A new S2 harness is needed for the stack move | False. `infrastructure:identity capture|compare` already exists (R4). |

## R7 Persisted identifiers and names

These end up in deployed infrastructure, databases, pools and every project. They are
expensive to change after release.

| Identifier | Current value | Where it persists |
| --- | --- | --- |
| Owner value | `FRAMEWORK_OWNER = "matts-aws-framework"` (`packages/aws-studio/src/deploy/identity.ts`, about 30 files) | Every stack's template metadata and tags, every resource's tags through propagation, the SSM record tags |
| Tag and metadata keys | `framework:owner`, `framework:deployment`, `framework:mode`, `framework:contract` (`"2"`), `framework:app-id`, `framework:stage`. Metadata key `framework:deployment` (`contract: 2`). | Every deployed stack and resource |
| CDK context keys | `framework:app`, `framework:appId`, `framework:targets` | Every project's `cdk-app/cdk.json` |
| Descriptors | `framework:task-launch:v1:<target>`, `framework:stateful-reference`, `framework:database-reference:v1` | Stack outputs and metadata |
| SSM | `/framework/deployments/<deployment>` | Each account |
| Compose project | Equal to `framework:app` (`src/local/project-name.mjs` `resolveProjectName`) | Local volume names such as `<app>_postgres_data` |
| Volume ownership | Only `com.docker.compose.project` and `com.docker.compose.volume` are checked (`cli/compose-project-ownership.mjs` `assertComposeVolumeOwnership`) | Local volumes |
| Database | IAM login `DATABASE_LOGIN = "app_user"`. Marker keys `prisma_8.contract.marker:<namespace>:<space>`. `DATABASE_REVIEW_PROTOCOL = 1`, prefix `AWS_STUDIO_DATABASE_V1:`. | Every database |
| Product-named | Package `aws-studio` (every import, `aws-studio/config`), CLI `aws-studio`, `package.json` key `awsStudio`, env `AWS_STUDIO_*`, Studio state `.cache/framework-studio/` | Every project |
| Setting env names | `FRONTEND_URL`, `FRONTEND_CLOUDFRONT_CERTIFICATE_ARN`, `COGNITO_DOMAIN_NAME`, `COGNITO_DOMAIN_CERTIFICATE_ARN`, `COGNITO_SES_*`, `LOCAL_DEV_URL`, `SKIP_EMAIL_VERIFICATION`, `RETAIN_STATEFUL_RESOURCES`, `USE_*_CUSTOM_DOMAIN`, `DATABASE_*`, local `*_HOST_PORT` and `LOCAL_*` | Every project's `.env.*` files; read by the Domains and Cognito pages |

**On the product name.** "AWS Studio" contains the AWS trademark, and AWS already sells a
product named AWS App Studio. Using "AWS" in a third-party product name is generally restricted
by AWS's trademark guidelines. This is not legal advice; get it cleared. The architecture keeps
the brand out of infrastructure identifiers (the `framework:` family is already brand-neutral).
The **package name** still ends up in every project's imports, so it must be final before 1.0.
Note that tag keys starting with `aws:` are reserved by AWS.

## R8 Target architecture

### Principles

1. **Origin is ownership.** A definition in the installed package is framework-owned. A definition in project source is developer-owned.
2. **Framework code lives in the package.** Projects hold declarations, small seed files that call public APIs, and their own code.
3. **Every state change has its own gate.**
   - Source changes go through the reviewed upgrade or reviewed edits.
   - Infrastructure changes go through the deploy plan.
   - Data changes go through the two-approval database review.
   - A framework upgrade never implicitly authorizes a deploy or a destructive database operation.
4. **Each project adopts changes explicitly:** the framework pin, the layout revision (applied with the upgrade) and the behavior revision (opt-in, needs a deploy).
5. **Persisted identifiers are brand-neutral, reserved and defined in one module** (`src/identity/namespace.ts`).
6. **Remove synchronization surfaces rather than build a synchronizer.**

### Tiers

| Tier | Contents | Changes by |
| --- | --- | --- |
| T0 Studio host | UI, orchestration, review, journal, admission | A new Studio distribution. Never writes project content on open. |
| T1 Package | Stacks, composition, framework declarations and workloads (handlers prebuilt), runtime libraries, the Prisma framework space, templates, Compose base, agent guidance, transitions, revision tables | A reviewed pin upgrade |
| T2 Generated, read-only | `docker-compose.services.yml`, `packages/framework-generated/src/*`, `packages/api-contract/src/generated/*`, `prisma/migrations/framework/**`, framework skills, `.env.*.template` | Regenerated by `framework:generate` and by the upgrade. Hand edits are detected and refused. |
| T3 Developer seeds and code | Declarations, `framework.config.ts`, small `bin/app.ts` and `application.ts`, developer stacks, workloads, the app contract and migrations, the client | The developer. Changed only by a reviewed, versioned transition. |
| T4 Private state | `.env.*`, `.cache/framework-studio`, `cdk.out` | Never in git or archives |

### What "updatable" means

A layer passes when it meets all four tests:

1. **Deliver:** ships in a release with no hand edits.
2. **Apply safely:** a source gate, plus a cloud or data gate; verified before activation; recoverable or fixed forward.
3. **Patch fast:** one patch release, one reviewed upgrade, one deploy.
4. **Observe:** Studio can show which framework release each deployment is running.

### Authority axes

`managedBy` is removed. Each axis is computed.

| Axis | Framework-origin definition | Project-origin definition |
| --- | --- | --- |
| Resource and implementation ownership | Framework | Developer |
| Source ownership | Package bytes, never in project source | Project |
| Studio editing authority | None. Studio shows "Provided by `<pkg>@x.y.z`" and where to configure it. | Studio writers and guards |
| Configuration authority | Project, through typed `platform` options, `defineIdentity`, `defineDatabase` and inputs | Project |
| Deployment authority | The deploy gate | The deploy gate |
| Upgrade responsibility | A framework release plus a reviewed pin upgrade | The developer, or a reviewed transition |

What happens to the existing ownership surfaces:

- `STARTER_STACKS`, `LOCAL_SETTINGS`, `projectOverride`, "Take ownership", "Hand to the platform" and the 24 `managedBy` lines are deleted.
- No eject at 1.0.
- The Inspector's Ownership disclosure stays, re-sourced from origin.

### Composition

```ts
// cdk-app/bin/app.ts (seed)
import * as path from "node:path";
import { runApplication } from "<pkg>/app";
runApplication({ root: path.join(__dirname, "..", ".."), load: () => require("../lib/application").default });

// cdk-app/lib/application.ts (seed, developer-owned)
import { defineApplication } from "<pkg>/app";
import framework from "../../framework.config";
import { additionalAuthProviders } from "../../framework-config/auth/additional-providers";
import { statefulResources } from "../../framework-config/deployment/stateful-resources";
export default defineApplication({
  config: framework, statefulResources,
  identity: { additionalProviders: additionalAuthProviders, extend?(ctx, pool) {} },
  stacks(ctx) { /* new OrdersStack(ctx.app, ctx.stackId("OrdersStack"), { env: ctx.env }) */ },
  afterWorkloads?(ctx) {},
});
```

`ApplicationContext` is `{ app, mode, env, stackId(name), framework: { identity, database?, website?, events, tasks?, orchestration?, httpApi? } }`.

`compose()` reproduces today's order exactly:

1. website (prod)
2. `resolveFrontendSettings`
3. foundation
4. RdsStack (prod)
5. tasks, which depend on RDS
6. `AsynchronousLambdaFunctionsStack`
7. identity stack `CognitoStack`
8. stateful-reference metadata
9. `stacks(ctx)`
10. orchestration
11. workloads
12. same-origin origins
13. `FrontendRouting` in the HTTP API stack's scope
14. `finalizeFrameworkResources`
15. describe

**Stack moves.** RdsStack, FrontendWebsiteS3Stack, FrontendRouting (with a prebuilt handler) and
CognitoStack move into the package with identical stack IDs and construct paths. Prove it with
`infrastructure:identity compare`. Only the routing asset may differ, and it must be explained.
Nothing is deployed, so this is a regression check, not a continuity requirement. If the
production test (checklist Step 8) shows a stack should be restructured, restructure it before 1.0
and record the change. The 1.0 golden templates are the real freeze point.

### Framework-contributed declarations

- `defineFrameworkConfig` merges the package's platform sections into the project's sections as one more module.
- Every contributed target, input, stack reference and service carries `origin: { kind: "framework", release }`.
- Studio reads ownership from the project's own evaluation, so no separate manifest is needed.
- `platform` is a typed options object for tuning knobs, such as `{ migrator: { cpu, memory }, auth: { endpoints: { mfa: false } } }`. Required parts can't be disabled.
- Framework settings and local settings are declared by the package:
  - The project declaration files (`framework-config/inputs/deployment.ts`, `cdk-app/framework-inputs.ts`) are deleted from the starter. No legacy merge is needed, because no other projects exist.
  - `requireDeploymentSettings` is deleted.
  - The pre-release deprecated keys (`prodUrl`, `prodCloudFrontCertificateArn`) are deleted outright before 1.0.
  - After 1.0, a deprecated key is aliased in the package and removed only in a major.
- `client-app/server/project-modules.ts` loads `projectDeclarations` from the project's installed package.
- Templates come from the package by default. A project override directory `framework-config/templates/<id>` is optional.
- The local runtime accepts framework-origin implementation directories inside the package. Today the resolver only allows `compute/`.
- Package-contributed stack references keep the keys `rds` and `cognito`, so Studio entity IDs stay stable.

### Project record

The record extends the existing `package.json` `awsStudio` key, which the upgrade already writes:

```json
"awsStudio": {
  "record": 1,
  "layout": 1,
  "behavior": 1,
  "origin": { "framework": "1.0.0", "integrity": "sha512-…", "starter": "<commit>", "studio": "1.0.0" }
}
```

- `.aws-studio/origin.json` is committed and written once at creation. It holds `{ path: sha256 }` for every T3 seed, so a later transition can tell pristine seeds from edited ones.
- The `awsStudio.database` adapters are removed.
- Every supported project is created at 1.0 or later, so every supported project has a record. Upgrade review refuses a project without one and names the missing record. There is no pre-release "layout 0" migration.

### Revisions and transitions

- **Layout revision** describes the shape of project source.
  - A transition is `{ from, to, appliesTo(project), plan(candidateRoot) → UpgradeChange[] | DeveloperDecision[] }`.
  - Transitions ship in the **target** package and run in the candidate under the project's Node: `node node_modules/<pkg>/transitions/run.mjs --from L --to M --json`.
  - They are mandatory within an upgrade. An edited seed is refused with its path.
- **Behavior revision** describes synthesized and runtime output.
  - `BEHAVIOR_REVISIONS = [{ revision: 1, release: "1.0.0", changes: [] }]`.
  - New projects start at the latest revision.
  - Existing projects adopt N+1 through a reviewed source-only change that shows a synth diff, followed by a separate deploy.
  - Revisions are bundles, not per-feature flags.

### Upgrade extension

The upgrade review gains these steps, in the candidate:

1. Run transitions.
2. Regenerate T2 files. Generated database artifacts may change only by regeneration, and the change is shown.
3. Verify.
4. Synth dev and prod offline on both the baseline and the candidate, then compare with `templateChanges` and `changedExports`.
5. **Refuse** stateful replacement or removal, a removed export or a renamed stack unless it comes from an adopted behavior revision.

### Deployed-release evidence

- The SSM record gains `framework: { version, integrity, layout, behavior }`.
- Each framework stack gains an output `FrameworkRelease` (spike S3 confirms that an output-only change updates a stack).
- The identity contract (`framework:deployment`, contract 2) is not touched.

### Public API tiers

| Tier | Entry points | Rule |
| --- | --- | --- |
| App-facing | `config`, `app`, `cdk` (handles, `linkResources`, `eventFunction`, network helpers), `runtime/*`, `graphql`, `auth/triggers`, `identity`, `database`, CLI | semver, API Extractor gate in CI |
| Studio-facing | `studio/*`: contract-chain, source, checks, database internals, project-declarations, compose-services | Governed by `studioCompatibility.protocol`, capabilities and window qualification |
| Internal | everything else | Not exported. The `./cdk/*` wildcard is removed. |

### Reserved names

| Namespace | Reserved |
| --- | --- |
| Stack roles | Existing framework names (`RdsStack`, `CognitoStack`, `FrontendWebsiteS3Stack`, `AsynchronousLambdaFunctionsStack`, `EcsTasksStack`, `DevLambdaReplayStack`, the HTTP, WebSocket and orchestration stacks) plus the prefix `Framework` |
| Target IDs | `framework-*`. Existing framework targets are renamed into it before 1.0. |
| Env names | Existing closed lists, plus `FRAMEWORK_` and `AWS_STUDIO_` for future additions |
| Compose services | Packaged names plus `framework-*` |
| SSM | `/framework/**` |
| Tag keys | `framework:*` |
| Migration space and PostgreSQL schema | `framework` and `framework_*` |
| Stack references | `rds`, `cognito`, `framework*` |

### Lifecycle

1. **Framework release.** Prebuild handlers and the Prisma space. Run the API gate and qualification. Retain golden templates.
2. **Studio distribution.** Names the archive and its digest. A security release carries `security: true`.
3. **Open.** Admission, and ownership from origin. Opening writes nothing.
4. **Review framework upgrade.** Candidate install, transitions, regeneration, verify, synth impact.
5. **Apply.** Journal and recovery. Source and dependencies only.
6. **Deploy.** Deploy plan and change sets, then release evidence.
7. **Migrate.** Migrator deploy, then reviewed expand migration, then the remaining deploy, then a later contract migration.
8. **Security patch.** Patch release, Studio distribution with a security badge, reviewed upgrade (usually Lambda asset changes only), deploy, evidence shows the patched version. A fix that needs stateful infrastructure changes ships as a behavior revision, never silently.

### Starter files after 1.0

| Path or class | Tier and owner |
| --- | --- |
| `cdk-app/lib/app/{rds-stack,frontend-website-s3-stack,frontend-routing,frontend-routing-handler,cognito-stack,auth-providers,identity-pool-access,identity-policy}.ts` | T1, in the package |
| `cdk-app/lib/app/reference-example-stack.ts` | T3 example |
| `cdk-app/lib/application.ts`, `cdk-app/bin/app.ts` | T3 seeds |
| `cdk-app/framework-inputs.ts`, `framework-config/inputs/deployment.ts`, `framework-config/stacks/{rds,cognito}.ts` | Removed (T1) |
| `cdk-app/test/*` framework tests | Moved to the package |
| `cdk-app/cdk.json` | T3 |
| `cdk-app/.env.*.template` | T2 |
| `framework-config/auth/sign-in-providers.ts`, `inputs/sign-in-providers.ts` | T1 |
| `framework-config/auth/additional-providers.ts` | T3 |
| Other `framework-config/**` | T3. Framework entries are removed from `workloads/{events,tasks,http}.ts`. |
| `framework-config/templates/**` | T1 defaults. The override directory is T3. |
| `compute/tasks/db-migrate/**` | T1 task `framework-db-migrate` |
| `compute/events/cognito-pre-signup-trigger`, `cognito-post-confirmation-trigger` | T1 |
| `compute/events/cognito-pre-token-generation` | Removed |
| `compute/events/cognito-custom-message` | T3 optional |
| `compute/http/{oauth-callback,sign-in,refresh,sign-out,verify-session,mfa}` | T1, public paths kept |
| `compute/http/graphql-api/{index,graphql-context}.ts`, `lib/*` | T1. `index.ts` becomes a seed. |
| `compute/http/graphql-api/schema/**` | T3. `schema/builder.ts` uses the package builder (R12). |
| `compute/websocket/ws-authorizer` | T3 seed if it only calls `<pkg>/runtime/auth`; otherwise move its verification into the package |
| Other `compute/**` | T3 examples, set chosen for the public starter |
| `packages/database/prisma/contract.prisma` | T3, app models only |
| `packages/database/prisma/migrations/app/**`, `snapshots/**` | T3 history |
| `packages/database/prisma/migrations/framework/**` | T2 |
| `packages/database/prisma.config.ts` | T3 seed, includes the framework extension |
| `packages/database/src/{users,cognito-users}.ts`, user contracts, `scripts/*` | T1 |
| `packages/database/src/{client,index,projects,demo-board,timestamps,contract-types}.ts` | T3 |
| `packages/{api-contract,framework-generated}/src/generated/**` | T2 |
| `packages/models/**`, `client-app/**`, `codegen.ts`, `graphql.config.ts`, `graphql-chain.review.json` | T3 |
| `docker-compose.yml` | T3 seed |
| `docker-compose.services.yml` | T2 |
| `.claude/skills/*`, `.agents/skills/*` | T2 |
| `AGENTS.md` | T3 seed pointing at package guidance |
| `.github/scripts/*` | Removed from the starter |
| `.github/workflows/verify.yml` | T3 seed |
| `package.json` | T3; the pin and record are written only by the upgrade |
| `vendor/*.tgz` | T1 artifact |

## R9 Change-delivery rules

These rules govern how anything, including unfinished features, reaches projects after 1.0.

**Four channels.**

| Channel | Ships | Reaches users by | Must exist at 1.0 |
| --- | --- | --- | --- |
| Studio UI and orchestration | Pages and Studio-hosted operations | A new Studio distribution | Pages read versioned project contracts, not file shapes. Gated by capabilities. Studio state formats versioned. |
| Framework package | Runtime, CDK, Lambdas, plugins, recovery constructs, dev-data stack | Reviewed pin upgrade | The extension point, reserved names, opt-in declarations |
| Data | Framework-schema changes | Two-approval database review | The framework Prisma space |
| Infrastructure behavior | Changed defaults on already-deployed resources | Adopting a behavior revision, then a deploy | The behavior revision in the project record |

**Capability versus revision.**

- A new capability is an opt-in declaration (additive, no revision). Examples: recovery settings, a dev-data bucket, an access-enforcement plugin in report mode.
- A behavior revision is only for changing what an existing deployment synthesizes or does by default. Examples: turning on enforcement by default, changing proxy defaults.

**Stability tiers.**

| Tier | Promise | Rule |
| --- | --- | --- |
| Stable | Covered by the support window and semver | Has automated tests plus a recorded manual pass; a real-account pass for anything AWS-backed |
| Preview | Behavior and UI may change between minors. Shown with a badge. | Anything it **persists** (project files, Studio state, AWS resources) must carry a version and a migration. Otherwise it persists nothing durable. |
| Hidden | Not shown | Nothing persisted |

Studio checks the project's framework capabilities for every page and operation. The mechanism
exists (`studioCompatibility.capabilities`, `planCreationUpgrade`) and is generalized.

**Freeze, Slot, Build.** Every item is classified as one of:

- **Freeze:** must be final at 1.0. Names, persisted identifiers, data shapes, settings fixed at creation, file paths tools read, persisted formats.
- **Slot:** at 1.0 only the extension point exists: a declaration namespace, reserved name, versioned format or capability flag. The feature lands later.
- **Build:** finished and tested at 1.0.

**Fallback scope if time is short.** With provenance hashes in place, these can wait for a
post-1.0 transition:

- moving RdsStack, the website stack and routing into the package
- the migrator
- the auth endpoints

These cannot wait:

- names and the persisted namespace
- the framework schema and identity model
- the Cognito settings fixed at creation, and the linking default
- the project record and provenance
- the public API surface
- the Pothos builder slot
- package-owned composition (`application.ts`, which most developers edit)
- reserved names
- Studio state versioning

## R10 Managed database platform

### Layers

| Layer | Target mechanism | Stays separately governed |
| --- | --- | --- |
| Infrastructure | RdsStack in the package; behavior revisions; deploy plan; engine drift guard. Local Compose image derived from the declared `engineVersion` major, with a volume `PG_VERSION` pre-check. | Settings fixed at creation; major upgrades; replacement |
| Connection runtime | Already in the package (`app_user`, IAM tokens, TLS, Proxy, pools). Release N stays wire-compatible with N−1. | Old Lambdas run until redeployed |
| Migration engine and review | Package and Studio; multi-space review; exact Prisma pins; persisted formats treated as contracts | Every application goes through review |
| Migrator | Framework task `framework-db-migrate` with a package-owned entry and Dockerfile; unreviewed cloud branch removed | Task launches are billed, approved operations |
| Identity mesh | Framework space, identities, package triggers and endpoints | Pool replacement; framework migrations go through review |
| Data contract and propagation | `createGraphQLHandler`; layout contract; chains treat framework models as read-only | Resolvers and receipts are developer-owned |
| Studio surfaces | Ownership from origin; window = the whole major | — |

### What exists for production migrations

`packages/aws-studio/database/studio-migrations.ts`, the starter's
`compute/tasks/db-migrate/review-task.ts` and `client-app/server/database-cloud.ts` together implement:

- Inputs digest binding to the immutable task image (`databaseInputsDigest`).
- ECS metadata identity verification of the running task.
- A strict `schemaVerify` against the historical snapshot (`DATABASE_PHYSICAL_DRIFT`).
- Per-space `pg_advisory_xact_lock` keys `prisma_8.contract.marker:<ns>:<space>`.
- Marker and ledger identity checks.
- An additive-only initialization plan for an empty database.
- Chunked, digest-checked log envelopes.
- Two approvals: inspect and apply. Each runs a billed Fargate task found through the `framework:task-launch:v1:db-migrate` output of `${deployment}-EcsTasksStack`. The task definition must carry `DATABASE_REVIEW_PROTOCOL=1`.

**Gaps:**

1. **Multi-space.**
   - Initialization lowers using only `space === "app"`.
   - Drift checks use `readMarker()` and a single snapshot store `prisma/migrations/snapshots/<hash>`.
2. **Ordering with deploys.** Nothing sequences migrator deploy, migration and code deploy.
3. **Unreviewed branch.** `migrate.ts` without `FRAMEWORK_TASK_INPUT` runs `db:migrate --no-interactive`. Check how the `db:migrate:cloud` CLI reaches it.
4. **Hard-coded paths** `packages/database/...`.

### Production sequence (proposed)

1. Deploy the tasks stack (the new migrator image) alone.
2. Run a reviewed migration (review, then apply), framework space before app space, expand-only steps before code.
3. Deploy the remaining stacks.
4. Run a later, separately reviewed contract migration.

Framework migrations in a minor are additive. Destructive framework changes happen only across a
major: expand in N, contract in N+1. Nothing migrates automatically on deploy.

### Prisma contract spaces

Installed version: `8.0.0-rc.14` (`@prisma/orm-toolchain`, `orm-framework`, `orm-family-sql`, `orm-postgres`, `orm-target-postgres`, `cli-engine 0.6.2`).

What the installed code shows:

- **Exports.** `@prisma/orm-toolchain` exports `./migration-tools/spaces`, with `APP_SPACE_ID`, `computeExtensionSpaceApplyPath`, `planAllSpaces`, `contractSpaceFromJson`, `gatherDiskContractSpaceState`, `verifyContractSpaces` and `assertDescriptorSelfConsistency`.
- **Descriptor.** `ControlExtensionDescriptor` has `contractSpace?: { contractJson, migrations, headRef }`.
- **Cross-extension FK direction.** `assertNoCrossSpaceFkReverseReferences` in `orm-family-sql` allows FKs between extension spaces only in the dependency direction.
- **App PSL syntax.** The parser accepts `space:ns.Name`, `space:Name`, `ns.Name` and `Name` (`orm-framework/dist/psl-parser.mjs`), and the printer round-trips them.
- **App to extension relations.** The interpreter (`orm-family-sql/dist/interpreter-IKKTyZNv-D12J5Dcx.mjs`, around line 2347):
  - emits an FK with `references.spaceId` for **singular N:1** relations from app models to extension models
  - refuses list cross-space relations (`PSL_UNSUPPORTED_CROSS_SPACE_LIST`)
  - refuses undeclared spaces (`PSL_UNKNOWN_CONTRACT_SPACE`)
  - refuses unknown targets (`PSL_UNKNOWN_CROSS_SPACE_TARGET`)
- **Still unproven:** client composition, the Access Graph, client access, the Contract Chain, the GraphQL chain, Studio surfaces and the cloud review with two spaces. Spike S1 covers these.

### Framework space (proposed, gated by S1)

```prisma
// package-internal framework.prisma, namespace "framework"
model User     { id String @id @default(uuid()) @db.Uuid  email String?  emailVerified Boolean @default(false)
                 givenName String?  familyName String?  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt }
model Identity { id String @id @default(uuid()) @db.Uuid  userId String @db.Uuid  user User @relation(fields:[userId], references:[id])
                 issuer String  subject String  provider String  providerSubject String?
                 createdAt DateTime @default(now())  lastSeenAt DateTime?
                 @@unique([issuer, subject])  @@index([provider, providerSubject]) }
```

- `email` is not unique, and there is no `cognito_sub`.
- App relations look like `owner framework:framework.User @relation(fields:[ownerId], references:[id])`. The exact spelling comes from S1.
- App-specific user data goes in app tables keyed by `userId`.
- The space is applied before the app space, each against its own marker.
- All toolchain calls go through `database/platform/prisma-adapter.ts` so RC churn stays in one module.
- Two fallbacks are in R22 (S1).

### Local PostgreSQL

- Derive the Compose image major from the declared `engineVersion`.
- Before start, read `PG_VERSION` from the volume and refuse a mismatch with guidance.
- Never change the local major implicitly.
- The postgres 18 image changed its data-directory layout; check S5 before choosing 18.

### Risk: Prisma RC

On-disk migration packages, snapshots and marker keys persist in every repository and database.
Either move to Prisma 8 GA before 1.0, or ship on the exact RC and plan an RC→GA framework
release with fixtures that hold real migration histories.

## R11 Identity, Cognito and account linking

### Current state

- **`cognito-stack.ts`** (starter):
  - `signInAliases: { email: true }`
  - required `email`, `givenName` and `familyName` (fixed at pool creation)
  - `keepOriginal: { email: true }`
  - a 12-character minimum password
  - triggers wired by target ID through `eventFunction(this, "<id>", { optional: true })`
- **Pre-signup trigger** (`compute/events/cognito-pre-signup-trigger/index.ts`):
  - For `PreSignUp_ExternalProvider`, it calls `AdminLinkProviderForUser` when the provider asserts `email_verified === "true"` and a CONFIRMED native user with the same verified email exists.
  - `NEVER_LINKED_PROVIDERS = {facebook, microsoftentraid}`. Google links.
  - It also sets `autoConfirmUser` and `autoVerifyEmail = true` for **every** external provider.
- **Pre-token trigger** marks Facebook emails verified in the ID token.
- **Entra** maps the tenant-controlled `xms_edov` claim as `emailVerified`.
- **OAuth callback** (`compute/http/oauth-callback/index.ts`) does the PKCE code exchange and `verifyCognitoIdToken`, requires `email_verified`, calls `ensureCognitoUser`, and sets refresh cookies.
- **`ensureCognitoUser`** (`packages/database/src/cognito-users.ts`):
  - finds the user by `cognitoSub`
  - otherwise throws `CognitoIdentityConflictError` if the email belongs to another user
  - otherwise creates the user
  - `users_email_key` is unique
- **GraphQL** resolves the current user with `findByCognitoSub` (`graphql-context.ts` `requireCurrentUserId`).
- **Compose comment:** "postgres_data outlives the dev Cognito pool: a redeployed stack has new subs, and a row still holding an old sub blocks sign-up with its email."

### Audit against the owner's constraint

The constraint is that linking must never create account-takeover risk or treat matching email
as proof of identity. Five findings:

1. **Auto-linking violates it.** Google auto-linking treats a Google-verified email that matches a verified native account as proof that the two are the same person. Google's `email_verified` is checked once, when the Google account is created. An address that was reassigned or lost (a former employee, an expired domain) can still be "verified" on an old Google account.
2. **The unique email lets anyone squat an address.** The first identity to claim an email in `users` blocks the real owner. That includes identities whose verification is only a trust decision (Meta, Entra).
3. **The trust decisions are scattered** across pre-signup, pre-token, the stack mappings and the callback.
4. **`AdminLinkProviderForUser` needs trusted attributes.** AWS warns to use it only with external providers and attributes the app owner trusts.
5. **Cognito accepts one Lambda per trigger type.** A framework-owned trigger must let developers extend it, not compete with it.

### Target (proposed)

- **Pool settings fixed at creation.** Required attributes are `email` only. `givenName` and `familyName` become optional and mutable. The sign-in alias stays `email`.
- **Framework-managed identity stack** (ID `CognitoStack` kept), configured through `defineIdentity({ triggers?, selfSignUp? })` in `framework.config.ts`. CDK customization goes through `defineApplication({ identity: { additionalProviders, extend } })`.
- **Triggers.** Prebuilt `framework-auth-pre-signup` (policy only, **no linking**) and `framework-auth-post-confirmation` (`ensureUserForIdentity`). A developer can replace one trigger type with their own target that calls the `<pkg>/auth/triggers` steps.
- **Lazy user creation.** Only in the framework auth endpoints and the GraphQL runtime, which have `database: true`. Not every authenticated workload has database access.
- **Endpoints.** `framework-auth-{oauth-callback,sign-in,refresh,sign-out,verify-session,mfa}` keep their public paths. The callback records `email_verified` as profile data rather than requiring it. The Meta workaround is removed.
- **Identity key.** `(issuer, subject)`, where the issuer is the pool's issuer URL. `providerSubject` keeps the IdP's stable ID.
- **Linking.** None at 1.0. Explicit, user-initiated linking comes later: an authenticated session, plus a single-use, short-lived, cookie-bound link intent; PreSignUp links only when an intent matches; the callback verifies the result.

### AWS limits

- Required standard attributes and sign-in aliases can't change after pool creation.
- A new pool issues new `sub`s.
- **There is no pool backup or restore.** A deleted pool is gone, password hashes can't be exported, CSV import forces password resets, and the user-migration trigger needs the old pool to still exist.
- For Cognito, the model is **retain and reattach** (reference mode exists: `UserPoolManagement: external-reference`), not backup and restore.
- Later pool replacement:
  - Federated users map by `(provider, providerSubject)`.
  - Native users migrate through the user-migration trigger against the old pool, keyed by the old `(issuer, subject)` identity, never by email.

## R12 GraphQL and Prisma Access (AG)

### Current state

- Prisma Access (AG) is the enforcement core in the package (`packages/aws-studio/database/client-access.ts` and `access-runtime`). `/// @access(...)` directives in `contract.prisma` are lowered into rules: `server-only`, `read-only`, `read(WHO)`, `write(WHO, when)`, `role`, `owner`, `members`, `via`, and model-level `create`, `update` and `delete`.
- Generated `clientAccess` lives in the project at `packages/database/src/generated/client-access`.
- The starter's GraphQL API does **not** enforce AG at runtime:
  - `schema/builder.ts` is `new SchemaBuilder<{ Context; DefaultFieldNullability: false }>({ defaultFieldNullability: false })` with no plugins.
  - Resolvers use scoped repositories through `context.database`, a `ClientDatabase = Omit<Database, "projectMembers" | "tasks" | "access">`.
  - `schema/client-access.test.ts` checks the GraphQL types against `clientAccess` at test time.
  - The demo board Lambdas use the Access Graph evaluator directly.

### One-way doors

1. **The builder.** Once thousands of projects own `new SchemaBuilder(...)`, a package release can't add an enforcement plugin to it.
2. **The context's data handle.** If resolvers reach data only through a developer-built handle, row-level enforcement can't be inserted later without rewriting resolvers.
3. **The `@access` directive language.** It lives in every project's contract, so changing its meaning silently changes authorization.

### Target (proposed)

- `<pkg>/graphql` provides `createSchemaBuilder<Context>()`, with an AG plugin slot that may do nothing at 1.0.
- `createGraphQLHandler({ schema, context?, limits?, persistedDocuments? })` owns Yoga, `authenticated`, hardening with secure defaults, introspection blocking, persisted documents, the API Gateway adapter and error masking. Its base context is `{ user, identity, db }`.
- `requireCurrentUserId` moves into the package with the identity model.
- `@access` is frozen as syntax version 1.
- **After 1.0:**
  - The plugin first ships in report mode, an additive change.
  - Turning enforcement on by default is a behavior revision each project adopts, because it can start denying requests that work today.

## R13 Production deploy and frontend release

- **Status.** The owner has not finalized or tested production deployments, nor automated client build and CloudFront release.
- **What exists:**
  - The deploy plan and review (R4).
  - The reviewed database operations (R10).
  - **A Studio-only frontend release service**, `client-app/server/frontend-release.ts` with `frontend-release-routes.ts`:
    - It runs the configured `npm run <buildScript>` locally.
    - A second, artifact-bound approval uploads to S3 and invalidates CloudFront.
    - Settings come from `framework-config/deployment/frontend-release.json`: `projectDirectory`, `outputDirectory`, `buildScript`, `buildArgs`, `include`, `exclude`, `deleteRemote`, `prefix`, `invalidationPaths`.
    - It finds the destination by output **names**: `FrontendWebsiteBucketName`, `CloudFrontId` or `FrontendDistributionId`, and `CloudFrontUrl` or `FrontendWebsiteUrl`.
    - It checks that the bucket and distribution belong to the website stack.
- **Website export names in the starter:** 5 in `frontend-website-s3-stack.ts`, 3 in `cognito-stack.ts`, 1 in `rds-stack.ts` (`${stackName}:RdsDatabaseEndpoint`), 5 in `reference-example-stack.ts`.
- **What 1.0 needs (proposed):**
  - The production golden path must work in a real account before the website, RDS and Cognito stacks are frozen into the package.
  - A versioned release descriptor output on the website stack, `framework:frontend-release:v1` (bucket, distribution, prefix, region), following the `framework:task-launch:v1` pattern.
  - A `version` field in `frontend-release.json`.
  - Studio-hosted AWS operations (frontend release, database review, Cognito operations, domains) stay in Studio for 1.0, bound to versioned descriptors. Moving them into the package CLI comes later.
- **After 1.0.** An "automatic release after deploy" flow is a new opt-in over the same reviewed operation. Deploy and publish stay separate approvals.

## R14 Studio pages and Studio state

**Pages under development.** These are subject to change:

- History & migrations, Database status, Saved SQL and Data retention
- `/cognito` routes
- `/domains` pages

Studio-only pages can change in any Studio release. What they **persist** and what they **read
from projects** cannot change freely:

| Page or service | Reads and writes | 1.0 need |
| --- | --- | --- |
| Saved SQL (`client-app/server/database-sql.ts`, `src/views/DatabaseSql.tsx`) | Writes SQL source under `packages/database/sql/<kind>/` (`SQL_DIRECTORY`) and execution records in `.cache/framework-studio/sql-operations/*.json`. The records carry no version field I could find. | Record the `sql/` path in the layout contract. Version the records. |
| Data retention (`client-app/server/stateful-resources.ts`, `src/views/DataRetention.tsx`) | Writes `framework-config/deployment/stateful-resources.ts`. Its evidence fingerprint hashes `cdk-app/cdk.json`, `framework-config/inputs/deployment.ts`, `cdk-app/lib/application.ts` and internal package paths. | Point the evidence at files that still exist after the refactor. |
| History & migrations (`client-app/server/database-history.ts`) | Reads every migration space under `prisma/migrations/` except `snapshots` | Two-space display after S1 |
| Identity service (`client-app/server/identity/service.ts`) | **Regex-parses** `cdk-app/lib/app/cognito-stack.ts` for `new …UserPoolIdentityProvider(Google|Facebook|Amazon|Apple|Oidc|Saml)` and identity pools, and parses `additional-providers.ts` with the TypeScript AST. `AUTHENTICATION_STACK_FILE` (`client-app/shared/integrations.ts`) is also used by ownership and `server/source/capabilities.ts`. | Read the evaluated declarations instead. **Don't finish these pages against `cognito-stack.ts`.** |
| Domains (`client-app/server/identity/domain-*.ts`, `src/views/DomainsWorkspace.tsx`) | Reads setting env names from the inputs files | Freeze the setting env names (R7) |
| Operations store (`client-app/server/operations/store.ts`) | `operations.sqlite`, created with `CREATE TABLE IF NOT EXISTS` and no schema version. `OPERATIONS_VERSION` is a host-protocol check, not a migration. | `PRAGMA user_version` migrations; refuse when an older Studio opens newer state |

**Rule.** Every Studio page and operation that needs framework support declares a capability.
Studio hides it, or offers an upgrade, when the project's framework doesn't declare that
capability.

## R15 RDS availability, recovery and teardown

**Already in `rds-stack.ts` and `defineDatabase` settings, but untested:**

- `multiAz`, `readReplicaCount`, `readReplicaInstanceClass`, `readReplicaMultiAz`
- `proxyEnabled`, `proxyMaxConnectionsPercent`, `proxyBorrowTimeoutSeconds`, `proxyIdleClientTimeoutSeconds`
- storage type, IOPS and throughput, backup windows, log exports, `allowMajorVersionUpgrade`, `autoMinorVersionUpgrade`

**Retention and teardown:**

- Not retained: `RemovalPolicy.SNAPSHOT`, so destroying leaves a final snapshot, and `deleteAutomatedBackups: false`.
- Retained: `RETAIN` and deletion protection. Related security groups, subnet groups, parameter groups, secrets and KMS keys are retained by an aspect.
- **Reference mode** (`props.reference`) reattaches a retained instance as an imported, externally managed database. It refuses Proxy and read replicas and checks the engine major.

**Restore from snapshot exists nowhere** (no `snapshotIdentifier`, no restore call).

AWS documents a hazard with in-place restore through CloudFormation:

- Setting `DBSnapshotIdentifier` on an `AWS::RDS::DBInstance` replaces the instance with one created from the snapshot.
- Every later update must keep specifying the same identifier.
- Dropping it replaces the instance with an **empty** one.

So a restore must write a permanent `restoredFrom` field into the developer's database
declaration, and the deploy plan must refuse to remove it.

**Encryption key.**

- `storageEncrypted: true` uses the AWS-managed key. Snapshots encrypted with it can't be shared with other accounts.
- Switching keys means a snapshot copy and restore, which is a replacement.
- Because DR is planned, offer a customer-managed key option at 1.0, chosen at creation. The default can stay AWS-managed.

**Engine.** Major upgrades are a guaranteed future event:

- RDS enrolls instances in paid Extended Support after standard support ends.
- RDS attempts the upgrade itself after Extended Support ends.
- Blue/Green deployments don't support CloudFormation or RDS Proxy.
- Planned: an engine drift guard in the deploy plan (deployed major versus declared) and an explicit `engineLifecycleSupport` setting.
- The reviewed engine-upgrade operation comes later.

**Slots needed at 1.0 for later recovery work:**

- a `database.recovery` declaration namespace
- the `restoredFrom` design
- the customer-managed key option
- reserved stack names

## R16 Development data and the S3 baseline idea

**The owner's idea.** When local runtime stops or a dev stack is destroyed, export Cognito users
and the Docker Postgres data to a framework-managed S3 bucket, so developers on different
machines can sync, with preset baselines and rollbacks.

**Problems with two-way sync:**

- last-writer-wins conflicts
- dumps taken at different migration heads on different branches
- personal data in a shared bucket
- Cognito can't export passwords (R11)
- dev mode builds no RDS, so each developer has local Postgres while the dev AWS pool is shared

**Proposed design (later, opt-in, package-delivered):**

- **Baselines, not sync.** A baseline is a named, immutable `pg_dump`, published explicitly (`db:baseline publish <name>`). It is bound to the migration storage hash that the markers already record.
- **Storage.** An encrypted, framework-managed bucket in a dev-only stack `FrameworkDevDataStack`, with lifecycle rules.
- **Restore.** An explicit, reviewed local operation, refused unless the baseline's head is the local head or an ancestor of it (if an ancestor, restore and then migrate forward).
- **Rollback** is restoring an earlier baseline.
- **Seed operations** stay the main way to share dev data.
- **Dev pools** are retained across teardown, not exported.
- The identity model (several identities per user) keeps a baseline valid after a dev pool is redeployed.

**Slots needed at 1.0:** reserved stack and bucket names and SSM prefixes, plus the identity model.

## R17 Scope and existing state

**No one depends on AWS Studio yet.** There is no production app, and no other person's
project or deployment.

That removes whole categories of work from the plan:

- No migration path for existing projects. No "layout 0" handling, hand migrations or adoption migrations for existing databases.
- No backward-compatible readers for pre-release values. The owner value `matts-aws-framework`, identity contract 1 and the deprecated settings can simply be replaced or deleted.
- No data preservation. The reference app's local database can be reset, and its migration history regenerated.
- No compatibility with the pre-release `aws-studio-1.0.0.tgz` bytes.

**What remains in scope:**

- `aws-studio`.
- The starter's `reference-app`, a throwaway working app. Use it directly for the golden paths and evidence captures.
- Any AWS resources left over from your own experiments. Destroy them in a sandbox before the production test. Nothing needs keeping.

**Apta has been deleted** from the workspace (2026-11-26). It was an unrelated copy of the starter
and plays no part in this work.

**Compatibility starts at public 1.0.** Everything in R9 (support window, deprecation, upgrade
qualification) applies from the 1.0 release onward.

**One nuance.** The Compose project name comes from `framework:app`, and volume ownership checks
only that label. Two checkouts with the same app name share one `postgres_data` volume. This
doesn't matter now. D25 (an appId label on volumes) is a small safety improvement for future
users, not a migration.

## R18 Starter

- Starter HEAD `61d8847`, pinned `47d90d7`.
- It ships demo and test workloads:
  - `compute/http/demo-board`, `demo-broken`, `demo-tasks`, `python-example`, `test-run-task`, `test-start-workflow`
  - `compute/tasks/invocation-test-task`, `compute/events/invocation-test-step`
  - `compute/agents/example-agent`, `compute/tools/*`, `compute/services/example-service`, `compute/websocket/*`
- Pick a public set.
- The personal `author` fields must go.
- `.github/scripts/*` are platform smoke tests that don't belong in a public starter.
- **Before 1.0:**
  - Regenerate the migration history freely, so the framework space owns users and identities and the app `init` migration creates the app tables referencing them. No one depends on the existing history.
  - Vendor the release-built framework archive.
  - Re-pin `scripts/starters.json`.
- **During readiness work** the reference app is a throwaway working app: change it, reset its database and redeploy it as needed.

## R19 Qualification and release evidence

**What exists:**

- `scripts/verify-studio-distribution.mjs` (single-release packaged smoke)
- `scripts/qualify-retained-cohorts.mjs` and `scripts/qualify-project-compatibility.mjs` (two releases; protected-file digests; mixed Node 24 and 26; dependency activation; minimum-Studio refusal; rollback)
- `.github/workflows/verify.yml` (lockfile and docs; fresh-clone PostgreSQL startup and retained data; native Node 24 hosts)

**Proposed minimum for 1.0:**

- **Golden templates** at `release/qualification/<version>/templates/{dev,prod}/*.json`, compared at the next release with the same refusal rule the upgrade uses.
- **Fixtures**, each created from the release starter:
  - pristine
  - customized: a developer stack, a template override, an extra workload, a trigger override, a `platform` tuning, three extra app models with migrations
  - minimal: no database, no WebSocket

  Each must pass create, verify, dev and prod synth, Contract Chain, and opening without changes.
- **Cohort run.** Cut `1.0.0-rc.1`, create fixtures from it, and upgrade them to `1.0.0` through the reviewed upgrade with one synthetic transition. Exercise synth impact, interrupted apply with `--recover-upgrade`, minimum-Studio refusal and mixed Node runtimes. Run `qualify-retained-cohorts.mjs` on that pair in CI.
- **Feature test matrix.** Stable features need automated tests plus a recorded manual pass, and a real-account pass if AWS-backed.
- **One manual canary in a sandbox account:**
  1. deploy rc prod
  2. initialize the database
  3. write a row
  4. upgrade
  5. deploy
  6. confirm the row and the instance identity survived, and that Studio shows 1.0
- **Retain per release:**
  - the Studio distribution and its sha256
  - the framework tgz and its sha512
  - the tagged starter commit
  - the golden templates
  - `evidence.jsonl`

## R20 Decision register

**Status key:** P = proposed; C = confirmed by a checklist step (record the step number).
**Bins:** F = Freeze, S = Slot, B = Build.

Each entry gives the decision, why, what was rejected, then (reversibility, bin, status).

**Boundary**

- **D01** Ownership follows definition origin. Remove the catalog lists, `projectOverride`, the ownership edits and `managedBy`. *Why:* one truth that matches the pinned release. *Rejected:* the Studio catalog (skews by version), a package ownership manifest (redundant), keeping `managedBy` (contradictory for project files). (Medium, F, P)
- **D02** No framework-patchable code in project source; seeds only. *Why:* patch fast; removes sync surfaces. *Rejected:* a 3-way managed-file sync, a folder injected on open (breaks "opening is inspection" and skews against the pin), per-stack hashes (the lock integrity already covers package code). (Low after release, F, P)
- **D03** Package composition `runApplication` and `defineApplication`, with `stacks(ctx)` and `afterWorkloads` hooks. *Why:* `application.ts` is edited in most projects, so a later migration is ambiguous. *Rejected:* keeping ordering in projects; many phase hooks. (Low after release, F, P)
- **D04** Move the Rds, website, routing and Cognito stacks into the package. Identical IDs are the default, checked by `infrastructure:identity compare` as a regression check. Nothing is deployed, so a deliberate, recorded identity change before 1.0 is allowed. *Why:* the framework can deliver changes to these stacks. *Rejected:* leaving Cognito developer-owned (unpatchable security config). (Medium, B, P)
- **D05** Framework sections merged by `defineFrameworkConfig`, with origin and reserved IDs. *Why:* a release can add workloads Studio shows. *Rejected:* directory scanning; developer-declared framework workloads. (Medium, S/B, P)
- **D06** Framework settings declared by the package; missing settings use defaults instead of throwing. *Why:* a new setting no longer breaks old projects. (High, B, P)
- **D07** Package templates with a project override directory. (High, B, P)
- **D27** The vendored `file:` tgz stays the only upgrade source; a registry can later be an acquisition channel feeding the same review. (High, F, P)
- **D33** Framework Lambdas are prebuilt in the package. (High, B, P)
- **D34** Framework workloads show in Studio under "Platform", not editable; `platform` options are editable. (High, B, P)
- **D35** No eject at 1.0. (High, —, P)

**Identity, names and records**

- **D08** Keep the `framework:` key family. Replace the owner value `matts-aws-framework` outright. No legacy reader, because nothing deployed needs to be read. (Medium, F, P)
- **D09** Reserved names as listed in R8. (Low after release, F, P)
- **D10** Product, package and CLI name decided before P1; the brand stays out of infrastructure identifiers. (Low, F, P)
- **D11** Project record in `package.json` `awsStudio`, plus `.aws-studio/origin.json`. (Medium, F, P)
- **D12** Two revision integers: layout (mandatory transitions) and behavior (opt-in bundles). No per-feature flags. (Medium, F for the record, P)
- **D32** Release evidence in the SSM record plus a stack output. The identity contract is untouched. (High, B, P)

**Upgrade and API**

- **D13** The upgrade gains transitions through the existing `prepare` hook, plus synth impact that refuses unrevised stateful changes. *Rejected:* a new engine. (High, B, P)
- **D14** Three-tier exports with an API Extractor gate. (Low after release, F, P)
- **D36** CDK feature flags handled per spike S4; synth impact covers `aws-cdk-lib` drift. (High, S, P)
- **D37** A security badge on bundled releases instead of an advisory feed. (High, S, P)

**Database and identity**

- **D15** Framework Prisma space `framework` and PostgreSQL schema `framework`, gated by S1, with fallbacks F1 and F2. (Very low after data exists, F, P)
- **D16** Identities keyed by `(issuer, subject)`, with `providerSubject`; email not unique; lazy creation in the auth endpoints and GraphQL runtime only (correction C1). (Very low after data, F, P)
- **D17** No email-based linking at 1.0; explicit linking later. (Linked identities persist, F, P)
- **D18** Required attribute `email` only; identity stack in the package; `defineIdentity`. (None per pool, F, P)
- **D19** Framework triggers and endpoints as framework workloads; a developer overrides a trigger type with their own target plus composable steps. (Medium, B, P)
- **D20** `createGraphQLHandler` in the package. (Medium, B, P)
- **D21** Migrator becomes a framework task; the unreviewed cloud apply is removed. (High, B, P)
- **D22** Multi-space cloud review. (High, B, P)
- **D23** Production sequence: migrator deploy, reviewed expand, remaining deploy, later contract. No migration on deploy. (High, docs B, P)
- **D24** Local PostgreSQL major derived from `engineVersion`, with a volume pre-check; new-project default per S5. (High, B, P)
- **D25** An appId label on Compose volumes, so two checkouts with the same app name can't share a database. A small safety improvement for future users, not a migration. (High, B, P)
- **D26 (amended)** Keep `DatabaseInstance` and the master user `postgres`. Default to the AWS-managed key, but offer a **customer-managed key at creation in 1.0**, because of the DR roadmap (correction C2). (None per instance, F/B, P)
- **D38** Pin the exact Prisma RC and treat its formats as contracts; move to GA before 1.0 if available. (Low, F, P)

**Policy and transition**

- **D28** Support window is the whole major. Fixes land on the latest 1.x. Deprecations are removed only in a major. (High, F, P)
- **D29** Minimum qualification per R19. (High, B, P)
- **D30** No existing project or deployment is migrated or kept compatible. Apta has been deleted, and the reference app is throwaway. Compatibility starts at public 1.0. (—, policy, P)
- **D31** Regenerate the starter's migration history and contents freely before release, vendor the release archive, then re-pin. (None after release, F, P)

**Added after the second pass**

- **D39** Stability tiers Stable, Preview and Hidden, with capability gating per page and operation. (High, S, P)
- **D40** A new capability is an opt-in declaration; only changed defaults need a behavior revision. (Policy, F, P)
- **D41** Every item classified Freeze, Slot or Build. (Policy, —, P)
- **D42** Package-provided Pothos builder and context data handle; `@access` syntax v1 frozen; switching enforcement on by default is a behavior revision. (Low after release, F+S, P)
- **D43** Versioned `framework:frontend-release:v1` descriptor and a versioned `frontend-release.json`. (Medium, F, P)
- **D44** Studio readers and writers bound to moved files are pointed at the evaluated model (identity service, `AUTHENTICATION_STACK_FILE`, retention evidence, path literals). (High, B, P)
- **D45** Studio state versioning: SQLite `user_version`, versioned JSON records, forward migration, refuse downgrade. (Medium, F, P)
- **D46** Setting env names frozen. (Low after release, F, P)
- **D47** Feature test matrix gate for Stable. (High, B, P)
- **D48** Slots for recovery and dev data: `restoredFrom`, `database.recovery`, `FrameworkDevDataStack`, baselines rather than sync. (High, S, P)
- **D49** Delete pre-release compatibility code before 1.0: deprecated settings, legacy requirement lists, legacy inputs-file checks, identity contract 1 readers, the legacy-artifact release guard, `legacy-javascript` templates, `managedBy` lines. Verify each candidate first (R5 item 16). *Why:* free now; a deprecation cycle after 1.0. (High before 1.0, B, P)

**Corrections from the second pass**

- **C1** Lazy user creation only in workloads with database access.
- **C2** Customer-managed key option at 1.0 (D26).
- **C3** The true freeze point is the 1.0 golden templates. Before 1.0, stacks may still be restructured if a production test shows it's needed.
- **C4** Studio-hosted AWS operations stay in Studio for 1.0, bound to versioned descriptors.
- **C5** Release-blocking replaced by Freeze, Slot and Build.

## R21 Planned phases (pending the final plan)

| Phase | Size | Content |
| --- | --- | --- |
| P0 | M | Decisions D10, D38 and D24; spikes S1 to S6 |
| P1 | M | Namespace module and owner value (no legacy reader), reserved names, project record and provenance, deletion of pre-release compatibility code (D49), Compose volume labels, deploy appId refusal, Studio state versioning (D45), capability gating (D39), Cognito and linking quick wins in the starter |
| P2 | L | Stack moves (D04), composition (D03), tolerant settings (D06), templates (D07), layout contract, ownership from origin (D01), project-loaded declarations, CLI decoupling, API tiers (D14), frontend release descriptor (D43), env name freeze (D46), Studio retargeting (D44), behavior plumbing at revision 1 |
| P3 | XL | Framework Prisma space, identity model and repositories, triggers and endpoints, GraphQL runtime and builder (D20, D42), migrator (D21), multi-space review (D22), Studio database surfaces, seed and prune operations, local PostgreSQL major (D24), customer-managed key (D26), drift guard, guided sequence |
| — | — | Finish the Stable features on the new boundary |
| P4 | M | Upgrade synth impact, generated-artifact rule, transition runner, behavior adoption, security badge |
| P5 | M | Golden templates, fixtures, CI, rc→1.0 cohort, feature matrix, starter regeneration and re-pin, docs and ADRs, artifacts, canary |

## R22 Feasibility spikes

Run spikes on disposable copies with `scripts/with-test-project.mjs`, and leave `TMPDIR` at its
default.

**S1 Prisma framework space (first).**

Steps:

1. Build the framework `contractSpace` and pass `assertDescriptorSelfConsistency` and `verifyContractSpaces`.
2. Register it in the starter's `prisma.config.ts`. Remove `User` from the app contract and point the relations at `framework:<ns>.User`.
3. Emit and plan.
4. Apply to empty PostgreSQL 16 and 17. Check the order, two markers and a real FK.
5. Exercise the runtime client: query across spaces and write through the framework space.
6. Run Contract Chain `verify --json`, the Access Graph with `@access` over a cross-space relation, client access and the GraphQL chain.
7. Check Studio's database workspace, history and local database preparation.
8. Simulate the two-space cloud review.
9. Evolution: add a column in a new framework migration.

Pass and fail:

- **Pass:** steps 1–6 and 9 pass without patching Prisma, and failures in 7–8 are confined to AWS Studio code.
- **Fail:** steps 3–5 need a Prisma patch, or the Access Graph can't represent the relation.

Fallbacks:

- **F1:** framework schema applied by package-shipped SQL migrations with their own ledger. The app contract carries a generated read-only `User` model in namespace `framework`, and a guard refuses app-space operations on that namespace.
- **F2:** framework migration packages generated into the app space under a reserved `framework_` prefix.

**S2 Identity-preserving move.**

- Steps: run `infrastructure:identity capture` before and after the move (dev and prod, bundled and unbundled), then `compare`.
- Pass: no identity or property changes; only the routing asset differs.

**S3 Offline candidate synth and output-only updates.**

- Steps: synth deterministically in the candidate, with no network and Docker stopped, in under 3 minutes in total. In a sandbox, confirm that an output-only change updates a stack.
- Fallback: show synth impact after apply, and write release evidence to SSM only.

**S4 CDK flag scoping.**

- Steps: test `node.setContext(flag, value)` on a framework stack scope before it has children.
- Fallback: `REQUIRED_CDK_FLAGS`, enforced by `framework:check`.

**S5 PostgreSQL major.**

- Steps: test `postgres:17` with the existing volume mount; check Prisma compatibility; check the newest RDS-supported major; check the postgres 18 data-directory layout.

**S6 Cognito 1.0 flows.**

- Steps: pool requiring only `email` with Google, Microsoft, Meta and a name-less OIDC provider; no linking; federated and native sign-ups with the same email coexist; the callback works without `email_verified`.

## R23 Deferred work

| Deferred | Reason |
| --- | --- |
| Codemod engine beyond the minimal transition runner | Built with the first layout change |
| Chained installs across intermediate releases | One candidate applies transitions in sequence |
| Broad T2 regeneration | The 1.0 set covers the known consumers |
| `cdk refactor` | Preview only, and needs newer bootstrap permissions |
| Registry distribution | `file:` stays the installation form |
| RDS Blue/Green | Doesn't support CloudFormation or Proxy |
| Engine-upgrade operation; local dump-and-restore | The drift guard and volume pre-check block unsafe paths |
| Explicit linking; pool replacement | Additive; the identity model enables them |
| Advisory feed | The security badge covers 1.0 |
| Aurora | A new database kind later |
| Full historical cohort pipeline, mixed-version tests, CI canary | Grow from the 1.0 artifacts |
| Editing-authority flags | No demand yet |
| Automated deploy/migrate sequencing | Each step stays separately authorized |
| Snapshot or point-in-time restore; cross-region and cross-account copies | Slots at 1.0 (D48) |
| Dev baselines | Slots at 1.0 (D48) |
| Package CLI versions of Studio-hosted operations | C4 |

## R24 External facts

Re-verify any of these the plan depends on.

- **CDK feature flags.** New `cdk init` projects enable all current flags; existing apps that don't set a flag keep the old behavior. https://docs.aws.amazon.com/cdk/latest/guide/featureflags.html
- **`cdk refactor`** is a preview (September 2025), needs `--unstable=refactor` and newer bootstrap permissions, and rejects add, delete and modify changes in the same operation. https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-refactor.html
- **Amplify Gen 2** keeps construct logic in packages and declarations in the project, with custom CDK through `backend.createStack()`. https://docs.amplify.aws/gen2/build-a-backend/add-aws-services/custom-resources/
- **jsii-diff** fails on breaking changes to stable APIs. https://unpkg.com/jsii-diff@1.142.0/README.md
- **RDS Blue/Green** doesn't support CloudFormation or RDS Proxy. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/blue-green-deployments-considerations.html
- **RDS Extended Support** auto-enrolls instances with charges after standard support ends. https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support-overview.html
- **`AWS::RDS::DBInstance` `DBSnapshotIdentifier`** must keep being specified after a restore; removing it creates an empty instance. https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbinstance.html
- **Cognito.** Required standard attributes and sign-in aliases can't change after pool creation. A pool accepts one Lambda per trigger type. A new pool issues new `sub`s. `AdminLinkProviderForUser` should be used only with trusted providers and attributes.
- **Django's `contrib.auth`** ships its own migrations inside the framework, and swapping the user model after the first migration is a known hard case.

## R25 Glossary

| Term | Meaning |
| --- | --- |
| Pin | The project's `file:vendor/<pkg>-x.y.z.tgz` dependency and its lock integrity |
| Candidate | A private copy where an upgrade is installed and verified before apply |
| Seed file | A small developer-owned file created at project creation that calls public APIs |
| Origin | Whether a definition comes from the installed package or from project source |
| Layout revision | The project's source shape; moved forward by transitions during an upgrade |
| Behavior revision | The adopted bundle of synthesized and runtime defaults; changed by explicit adoption |
| Transition | A deterministic source change shipped by a framework release, run in the candidate |
| Golden templates | Normalized dev and prod templates retained per release, used as the next release's comparison baseline |
| Prisma AG | Prisma Access (Access Graph): `/// @access` directives compiled into enforced rules |
| Freeze, Slot, Build | Final at 1.0; extension point at 1.0; finished and tested at 1.0 |

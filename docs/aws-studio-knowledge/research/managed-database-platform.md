---
id: research.managed-database
summary: Which layers of the managed PostgreSQL platform the framework owns, where each lives today, and how to keep the platform, including its schema in application data, upgradable.
read_when:
  - Changing RdsStack, the users table, Cognito triggers, migrations or GraphQL propagation
  - Designing automated production database migrations
source:
  - packages/aws-studio/cdk/framework-database.ts
  - packages/aws-studio/database/studio-migrations.ts
  - packages/aws-studio/cli/root-env-outputs.ts
  - packages/aws-studio/cli/database/project-adapter.ts
  - client-app/server/database-cloud.ts
  - client-app/server/database-history.ts
related:
  - research.index
  - research.upgrade-boundary
  - framework.stateful-database
  - studio.editing
---
# Managed database platform

**Status:** research, 2026-11-25. These are proposals, not decisions.

## Why the database is framework managed

The primary PostgreSQL database was designed as a framework product from the
start. It serves:

- Studio's database schema workspace and its automated Prisma migrations, locally and, once implemented, in production
- the GraphQL schema propagation chain
- preconfigured Prisma repositories for the framework's auth integration
- Cognito users meshed with database users out of the box

This research agrees the database must be framework managed. The question is
where each part of that product lives, and whether the framework can still
change it after release.

## The platform's layers

| Layer | What it is | Where it lives today | Updatable after release? |
| --- | --- | --- | --- |
| Infrastructure | RdsStack: instance, proxy, replicas, secrets, IAM login | Starter copy at `cdk-app/lib/app/rds-stack.ts` | No |
| Connection runtime | IAM token login as `app_user`, pools, proxy selection | Package: [framework-database.ts](../../../packages/aws-studio/cdk/framework-database.ts), `aws-studio/runtime/database` | Yes, with the pin |
| Migration engine and review | Prisma 8 toolchain, migration history, two-approval cloud review | Package and Studio: [studio-migrations.ts](../../../packages/aws-studio/database/studio-migrations.ts), [database-cloud.ts](../../../client-app/server/database-cloud.ts) | Yes |
| Migrator workload | The `db-migrate` task. Studio requires its `framework:task-launch:v1:db-migrate` output in `EcsTasksStack` | Starter copy: `framework-config/workloads/tasks.ts` (developer-owned by default) and `compute/tasks/db-migrate` | No |
| Identity mesh | The `User` model (`cognito_sub`, unique email) in `packages/database/prisma/contract.prisma`, `ensureCognitoUser`, the post-confirmation trigger, the OAuth callback, the seed and prune adapters | Starter copies under `packages/database/`, `compute/events/cognito-*` and `compute/http/oauth-callback`. The adapters are named in `package.json` under `awsStudio.database` and run by [project-adapter.ts](../../../packages/aws-studio/cli/database/project-adapter.ts) | No |
| Data contract and propagation | `contract.prisma` with `@access` annotations, the access graph, generated client access, the GraphQL chain | Engines are in the package and Studio. The chain reads fixed project paths: `packages/database/prisma/contract.prisma`, `packages/database/src/generated/*`, `compute/http/graphql-api`, `graphql-chain.review.json` | Engines yes. The endpoint and review record no |
| Studio surfaces | Database schema workspace, GraphQL schema workspace, workbench | Studio | Yes |

The engines update. Most of what the engines depend on are copies. Framework code
depends on copies of framework code that it can no longer change. Evidence:

- The CLI reads the `RdsDatabaseEndpoint` output of the stack named `RdsStack` ([root-env-outputs.ts](../../../packages/aws-studio/cli/root-env-outputs.ts)).
- Cloud migration requires the `db-migrate` launch descriptor ([database-cloud.ts](../../../client-app/server/database-cloud.ts)).
- The Contract Chain and GraphQL chain hard-code the database package and GraphQL handler paths.

## Highest risk: framework schema inside application data

**The problem.** The users table is framework-owned in intent. But it is declared
in the developer's contract and migrated in the developer's `app` migration space,
and application tables reference it (`projects.owner_id → users.id`). Any
framework change to it therefore needs:

- a migration in every project,
- ordered among that project's own migrations,
- applied to production data.

The framework cannot ship that today. Data migrations are the least reversible
change a framework makes.

**A plausible change.** Change how identities map to rows, for example with an
identity-links table that lets one row carry more than one Cognito `sub`.

- Replacing a user pool needs this. Some pool settings, such as sign-in aliases and required attributes, are fixed at creation, and a new pool issues new `sub`s.
- Today `users_cognito_sub_key` makes `sub` the identity key.
- Federated sign-in is already linked inside Cognito: the pre-signup trigger calls `AdminLinkProviderForUser`.
- `ensureCognitoUser` throws `CognitoIdentityConflictError` when an email arrives with a different `sub`.

**Precedent.** Django's `contrib.auth` ships its own migrations inside the
framework package. Every project receives them, and application models reference
its tables. Changing the user model after a project's first migration is a known
hard case, so that choice is made at project start. AWS Studio should make the
equivalent choice before release.

## Recommendations

1. **A framework platform schema with its own migration chain, shipped in the package.**
   - Framework tables live in a framework-owned migration space, optionally in their own PostgreSQL namespace. That covers users, identity links and any future framework tables.
   - That space is applied before the application space and recorded in its own ledger.
   - Application tables reference framework tables.
   - Application-specific user data goes in an application-owned table keyed by the user ID, rather than in columns added to the framework table.
   - The engine already reads every space under `prisma/migrations/` ([database-history.ts](../../../client-app/server/database-history.ts)), and its plans carry space IDs and storage namespaces ([studio-migrations.ts](../../../packages/aws-studio/database/studio-migrations.ts)).
   - The toolchain already supports this shape: a `ControlExtensionDescriptor` can carry a `contractSpace`, and cross-space foreign keys follow the dependency direction. See [making every layer updatable](updatable-layers.md#identity-mesh) for the findings and the remaining spike.
2. **RdsStack in the package.**
   - Preserve its construct IDs.
   - Treat its output names, the `app_user` IAM login, and its proxy and secret identities as versioned framework contracts.
3. **Framework-contributed workloads for the mesh and the migrator.**
   - Candidates: the post-confirmation and pre-signup triggers, the OAuth callback and `db-migrate`.
   - Handler code lives in the package, under reserved target IDs.
   - A user pool accepts one Lambda per trigger type. A framework-owned trigger must therefore call developer hooks, such as an after-user-created hook, rather than compete with developer triggers.
   - Custom message and pre-token generation do not touch the database and can stay developer-owned.
4. **Split the repositories.**
   - Framework repositories (users, identity) ship in the package.
   - Application repositories stay in `@repo/database`.
   - The generated client composes both.
5. **Declare the fixed paths as a layout contract** with a revision, so a later release can move them through a deterministic migration.
6. **Define production automation before building it.** Production is not implemented yet. Define:
   - **Order.** Run the framework space, then the application space.
   - **Expand before deploy.** Expand migrations run before code deploys. Contract steps wait until no deployed code reads the old shape, because old Lambdas keep running during a deploy.
   - **What is automated.** Additive steps can be automated. Destructive steps keep the two-approval review that `database-cloud.ts` already implements.
   - **Version tracking.** Record the platform-schema revision in the ledger, so Studio can compare source with what is deployed.
7. **Treat the engine choice as a one-way door.**
   - RdsStack builds `rds.DatabaseInstance` with construct ID `PostgresDatabase`.
   - Moving to Aurora would be a data migration, not a template change.
   - Keep `defineDatabase` engine-neutral, so a future engine becomes a new kind rather than a change to the existing one.

## Open questions

- Partly answered: Prisma 8 supports contract-space extensions shipped in packages, and cross-space foreign keys in the dependency direction. Still open: can a relation in the application's PSL name a model in an extension space?
- Should the Contract Chain and GraphQL chain treat framework models as read-only inputs, for example exposing `User` without letting application edits change its storage?
- Which mesh behaviors should be hooks, and which fixed framework behavior?

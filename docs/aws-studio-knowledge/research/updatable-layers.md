---
id: research.updatable-layers
summary: Path to making each managed-database layer updatable after release. Covers what "updatable" must mean, the mechanism and gate per layer, the AWS properties fixed at creation, and future events the platform cannot avoid.
read_when:
  - Planning how a managed-database layer receives fixes after release
  - Choosing Cognito or RDS settings that AWS fixes at creation
  - Planning engine upgrades, security patches or Prisma toolchain upgrades
source:
  - packages/aws-studio/dev/compose.yml
  - packages/aws-studio/src/config/database.ts
  - packages/aws-studio/database/studio-migrations.ts
  - client-app/server/database-history.ts
  - client-app/server/database-cloud.ts
  - packages/aws-studio/cli/deployment-plan.ts
related:
  - research.index
  - research.managed-database
  - research.upgrade-boundary
  - framework.stateful-database
---
# Making every layer updatable

**Status:** research, 2026-11-25. These are proposals, not decisions. This page
continues the layer table in [managed database platform](managed-database-platform.md#the-platforms-layers).

## What "updatable" has to mean

A layer counts as updatable only if it passes three tests:

| Test | Meaning |
| --- | --- |
| Deliver | The framework can ship the change in a release, with no hand edits in projects. |
| Apply safely | Two gates check it: the reviewed pin upgrade for source, and the deploy plan or database review for state. The change is verified before activation, and a failure leaves the project recoverable. A data change that cannot be undone must be fixed forward. |
| Patch fast | A security fix reaches every project through one patch release and a reviewed upgrade. |

Two limits remain whatever the design:

- AWS fixes some resource properties at creation. Changing one means replacing the resource.
- Destructive data changes cannot be reversed. They can only be fixed forward.

The framework's job is to keep both sets small and to ship governed replacement
operations for them.

## Summary

| Layer | Today | Achievable | Mechanism | Stays bounded |
| --- | --- | --- | --- | --- |
| Infrastructure (RdsStack) | No | Yes | Package-owned stack, behavior revisions, deploy plan, an engine-upgrade operation | Properties fixed at creation. Engine upgrades are a forced event. |
| Connection runtime | Yes | Yes | Package, delivered on redeploy | Old Lambdas run until redeployed. The wire contract must stay compatible with the previous release. |
| Migration engine and review | Yes | Yes | Package and Studio | Toolchain on-disk and marker formats persist in every project and database |
| Migrator workload | No | Yes | Framework-contributed task in the package | None of note: the task is stateless |
| Identity mesh | No | Yes | Prisma contract-space extension shipped in the package, framework workloads with hooks, framework-managed user pool | Pool settings fixed at creation. A pool replacement issues new `sub`s. |
| Data contract and propagation | Partly | Yes | Package-owned GraphQL runtime, generated artifacts, a layout contract | Developer resolvers change only through approved codemods |
| Studio surfaces | Yes | Yes, within the compatibility window | Studio, capability negotiation, an ownership manifest shipped in the package | Studio must keep supporting every framework release in the window |

## Path per layer

### Infrastructure

- Move RdsStack into the package with identical stack and construct IDs.
- Gate changes to synthesized output behind behavior revisions.
- The deploy plan already flags stateful types and replacement ([deployment-plan.ts](../../../packages/aws-studio/cli/deployment-plan.ts)).
- **Engine major upgrades are guaranteed for every deployed database.**
  - After a version's end of standard support, RDS enrolls instances in paid Extended Support.
  - After Extended Support ends, RDS attempts the upgrade itself.
  - The framework needs a reviewed engine-upgrade operation: compatibility checks, snapshot, then an in-place `EngineVersion` change with major upgrades allowed.
  - RDS Blue/Green Deployments don't support CloudFormation or RDS Proxy, so they can't be the default path.
  - An upgrade done outside the stack leaves its `EngineVersion` stale. The operation must reconcile from the deployed state.
- **The local counterpart is also stateful.**
  - Compose runs `postgres:16` with a `postgres_data` volume ([compose.yml](../../../packages/aws-studio/dev/compose.yml)).
  - Changing the major version makes existing volumes unreadable.
  - Pin the local major per project behind a behavior revision, and ship a local dump-and-restore operation.

### Connection runtime

- Already in the package.
- Runtime code reaches AWS only when a project redeploys.
- A deployment runs old and new handlers side by side, so each release must stay compatible with the previous one on:
  - the IAM login `app_user`
  - the connection settings
  - the database contract

### Migration engine and review

- Already updatable. The risk is the formats it persists.
- The project is on Prisma `8.0.0-rc.14`. Its migration packages, contract snapshots and database markers persist in every project repository and every database. Studio builds marker keys from them ([studio-migrations.ts](../../../packages/aws-studio/database/studio-migrations.ts)).
- Treat those formats as persisted contracts. Moving from RC to GA is a migration of the migration system, and needs cohort fixtures with real migration histories.

### Migrator workload

- `db-migrate` is thin: about 110 lines of TypeScript that delegate to `aws-studio/runtime/database` and `aws-studio/database/studio-migrations`, plus a Dockerfile.
- Its launch descriptor, `framework:task-launch:v1:db-migrate`, is already versioned ([database-cloud.ts](../../../client-app/server/database-cloud.ts)).
- Make it a framework-contributed task under a reserved ID. This needs `defineFrameworkConfig` to merge package contributions.

### Identity mesh

**Data.** Prisma 8 supports contract-space extensions.

- A `ControlExtensionDescriptor` can carry a `contractSpace`: its contract JSON, migration packages and head ref.
- The toolchain writes the space to `prisma/migrations/<spaceId>/` and applies it against its own marker.
- Cross-space foreign keys are allowed in the direction of the dependency. A space may reference only spaces it depends on.
- Studio already reads every space ([database-history.ts](../../../client-app/server/database-history.ts)) and keys markers per space.

So an `aws-studio` extension space shipped in the package can own users and identity links, and application tables can reference it. One thing is still unproven: whether a relation in the application's PSL can name a model in an extension space. A spike should settle that before this design is committed.

**Do it before 1.0.** After release, every production database already holds a `users` table created by the `app` space. The framework space would then need an adoption migration that takes ownership of an existing table without moving data, run on every database. Before release, the table simply starts life in the framework space.

**Identity key.**

- Today `cognito_sub` is the unique key.
- The Compose file already documents the cost: a redeployed development pool issues new subs, and old rows block sign-up until the prune script removes them.
- A framework identity-links table, keyed by pool and subject, solves this for development pool redeploys and for production pool replacement.

**Code.**

- `ensureCognitoUser` and the user repository move into the package.
- The post-confirmation trigger, the pre-signup linking trigger and the OAuth callback become framework workloads that call developer hooks. A user pool accepts one Lambda per trigger type, so the framework trigger has to invoke the developer's logic.
- The OAuth callback performs the PKCE token exchange and session cookies. That is security code that must be patchable.

**User pool.**

- `CognitoStack` is developer-owned. It also holds the pool settings that AWS fixes at creation, and it wires the mesh triggers by target ID.
- Make the stack framework-managed and keep the developer's configuration in declarations. This is the same split as `defineDatabase` and RdsStack. Sign-in provider declarations stay developer-owned.

### Data contract and propagation

- Move the framework parts of `compute/http/graphql-api` into a package runtime such as `createGraphQLHandler({ schema })`:
  - the server bootstrap
  - the auth context
  - depth and alias limits
  - introspection blocking
  - persisted documents
  - the API Gateway adapter
- Resolvers and schema modules stay with the developer.
- Generated client artifacts are already ignored, generated outputs.
- Declare the fixed paths the chains read as a layout contract with a revision.
- `graphql-chain.review.json` remains developer-approved evidence, with a versioned format.

### Studio surfaces

- Studio must open every framework release inside the published support window.
- The package already declares a minimum Studio release, a protocol and capabilities.
- The ownership catalog lives in Studio today, so it describes Studio's framework rather than the project's. Ship the ownership facts as a manifest in the package, so labels match the project's pinned release.

## Settings fixed at creation to decide before 1.0

| Property | Starter value | Why it matters | Recommendation |
| --- | --- | --- | --- |
| Cognito required attributes | `email`, `givenName` and `familyName` all required | Required attributes can't change after the pool is created. Identity providers that omit names cannot satisfy them. | Require only `email`. Keep names as profile data in the users table, which `ensureCognitoUser` already writes. |
| Cognito sign-in aliases | `email` | Fixed after creation | Keep, and document it as fixed |
| User pool identity | One pool per deployment | A new pool issues new `sub`s | Identity-links table in the framework space |
| RDS storage encryption key | Encrypted with the AWS-managed key | Snapshots encrypted with the default AWS-managed key cannot be shared with other accounts. Changing the key means a snapshot copy and restore. | Decide whether a customer-managed key is offered as a creation-time setting for cross-account backup. Document the default as fixed. |
| RDS engine family | `rds.DatabaseInstance`, construct ID `PostgresDatabase` | Moving to Aurora is a data migration | Keep `defineDatabase` engine-neutral, so Aurora would arrive as a new kind |
| Master username and database name | `postgres` and the declared name | Fixed at creation | Keep |
| Local PostgreSQL major | `postgres:16` | A major bump breaks existing volumes | Pin per project behind a behavior revision |

## Delivery prerequisites

1. Package-owned composition and reserved namespaces ([upgrade boundary](framework-upgrade-boundary.md#one-way-doors-before-release)).
2. Framework-contributed sections in `defineFrameworkConfig`.
3. The `aws-studio` Prisma extension space, shipped in the package.
4. A behavior revision recorded at creation, and the deployed release stamped in template metadata.
5. **Advisory channel.** Studio shows security advisories that affect the project's pinned release, with the fixed release.
6. **Distribution.** A vendored tarball referenced as `file:` prevents automated dependency update PRs. Consider publishing to a registry with provenance attestations, and keep vendoring available for offline installs.

## Qualification additions

- **Mixed versions:** old handlers against a new schema, and new handlers against an old schema, for each expand step.
- **Migration history:** fixtures with real application histories, plus the framework space.
- **Engine upgrade:** a rehearsal in the canary account.
- **Local volumes:** a local volume upgrade for any change to the local PostgreSQL major.

## Sources

- [RDS Blue/Green limitations](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/blue-green-deployments-considerations.html) and [replication methods](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/blue-green-deployments-replication-type.html)
- [RDS Extended Support overview](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support-overview.html) and [charges](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support-charges.html)
- [RDS for PostgreSQL engine upgrades](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.html)

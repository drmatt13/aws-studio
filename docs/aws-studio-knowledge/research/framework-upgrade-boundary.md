---
id: research.upgrade-boundary
summary: How framework-owned code reaches projects today, what blocks iteration after release, and the recommended framework and project boundary.
read_when:
  - Deciding where framework-owned code, stacks or Lambdas live
  - Adding a framework-managed stack, Lambda, setting or template
  - Planning a framework release, upgrade path or cohort qualification
source:
  - client-app/server/project-upgrade.ts
  - client-app/server/project-create.ts
  - client-app/server/model/framework-resource-catalog.ts
  - packages/aws-studio/src/config/project-declarations.ts
  - packages/aws-studio/cdk/framework-composition.ts
  - packages/aws-studio/cdk/framework-resources.ts
  - packages/aws-studio/package.json
  - scripts/qualify-retained-cohorts.mjs
related:
  - research.index
  - research.managed-database
  - architecture.decisions
  - studio.editing
  - guides.maintenance
---
# Framework upgrade boundary

**Status:** research, 2026-11-25. These are proposals, not decisions.

## Question

After release, can the platform:

- change a framework-owned stack such as RdsStack,
- add a new framework-managed stack,
- add a framework-managed Lambda,

and have every project receive the change safely through an upgrade? The platform
expects few such additions. The requirement is that one stays possible.

## How framework code reaches a project today

| Channel | Location | Contents | Update path |
| --- | --- | --- | --- |
| Ownership catalog | [framework-resource-catalog.ts](../../../client-app/server/model/framework-resource-catalog.ts) in the Studio host | Which stacks, settings, gateways and services count as framework | Updating Studio. Takes effect when a project is next opened |
| Framework package | `packages/aws-studio`, vendored in each project as `vendor/aws-studio-<version>.tgz` with its sha512 in the lockfile | DevLambdaReplayStack, the HTTP, WebSocket, ECS and orchestration stacks, config, runtime, CLI, Compose | Per project, through **Review framework upgrade**: install and verify a private candidate, journal, `--recover-upgrade` |
| Starter copy | Copied once by [createStudioProject](../../../client-app/server/project-create.ts) | RdsStack, FrontendWebsiteS3Stack, frontend routing, `cdk-app/lib/application.ts`, `cdk-app/bin/app.ts`, `framework-config/inputs/deployment.ts`, `cdk-app/framework-inputs.ts`, `framework-config/templates/`, Compose, skills, the database package and the auth workloads | **None.** [projectUpgradeFile](../../../client-app/server/project-upgrade.ts) refuses every file except `package.json`, `package-lock.json` and `.gitignore` |

`managedBy: "framework"` is a label and Studio write guard, not a delivery
mechanism. The catalog marks the deployment settings, local settings and the two
starter stacks as framework by itself. An explicit `managedBy` on those
declarations is therefore only a project override.

## What blocks iteration after release

1. **New deployment setting.**
   - [requireDeploymentSettings](../../../packages/aws-studio/src/config/project-declarations.ts) throws for any `DEPLOYMENT_SETTING_KEYS` entry the project file lacks. `cdk/deployment.ts` calls it at synth.
   - An upgrade cannot add the declaration.
   - Omitting the file entirely also throws, despite the "declares nothing" comment.
2. **RdsStack and website stack fixes.** There is no delivery path. RdsStack also imports the project's own `framework-config/databases/application` and `framework-config/stacks`.
3. **New template IDs.** `SCAFFOLD_TEMPLATES` lives in the package, but templates load only from the project's `framework-config/templates`.
4. **Factory signature changes.** These break every project's `application.ts`, which Studio cannot write.
5. **No provenance.** Creation records no starter commit, framework version or file hashes. Later there is no way to tell an edited copy from an untouched one.
6. **Package depends on project-copied stacks.** The CLI reads the `RdsStack` stack name and its `RdsDatabaseEndpoint` output ([root-env-outputs.ts](../../../packages/aws-studio/cli/root-env-outputs.ts), [export-cdk-outputs.mjs](../../../packages/aws-studio/cli/export-cdk-outputs.mjs)).
7. **Shared stack namespace.** Framework and user stacks share `stackId(name)` = `${deployment}-${name}` with no reserved prefix. Reserved Lambda environment keys and local service names are closed lists in [config/index.ts](../../../packages/aws-studio/src/config/index.ts). Any name added later may already be in use by a project.
8. **Large public surface.** The package exports 105 subpaths, including a `./cdk/*` wildcard, and about half look internal.
9. **No deployed version.** Deployed identity metadata deliberately records no revision ([framework-resources.ts](../../../packages/aws-studio/cdk/framework-resources.ts)), so Studio cannot tell which framework release built a deployment.

## Proposals evaluated

| Proposal | Verdict | Reason |
| --- | --- | --- |
| Rely on `managedBy: "framework"` | Insufficient | It decides labels and write protection, not content. |
| A `framework-config` folder in the Studio repository, injected into projects when Studio opens | Reject | Studio advances independently of each project's pin (ADR-010). A newer Studio would inject files that call APIs the project's pinned framework lacks. It also breaks the rule that opening a project only inspects it. A copied file has no effect until the developer-owned `framework.config.ts` imports it. |
| Hash each framework CDK stack and force a diff when it changes | Not needed for package code | The lockfile's sha512 of the vendored tgz already identifies all package code, and the upgrade verifies it. Hashes remain useful for generated files (tier 2 below). |
| 3-way sync of managed files copied into projects | Withdrawn | Every managed file becomes a merge surface across many edited copies. Amplify Gen 1 kept CLI-managed resource folders in the project. Gen 2 moved construct logic into packages and kept declarations in the project. |
| A pinned reference app per release, with CI upgrade tests | Adopt and extend | See [cohort qualification](#cohort-qualification). |

## Recommended boundary

| Tier | What | How it updates |
| --- | --- | --- |
| 1. Package-owned code (the default) | Framework stacks including RdsStack and the website, framework Lambdas, framework setting declarations, default templates, stack ordering | Pin upgrade. The lockfile integrity is the hash. |
| 2. Generated, read-only files | Files that tools must find at fixed paths | Fully regenerated by the upgrade. A recorded hash detects hand edits and refuses to overwrite them. Customization goes in override files, as Compose's multi-file merge allows. |
| 3. Developer-owned seed files | Workloads, application stacks, inputs catalog, client app | Never rewritten, except by a versioned codemod shown in the reviewed upgrade for a breaking change |

**Composition.** Replace most of `application.ts` with one package-owned call,
such as `createFrameworkApplication(app, { config, extend })`. The package then
owns stack order and deployed names. Developers add stacks through named phase
hooks, such as after events or before orchestration. Amplify Gen 2's
`backend.createStack()` is the precedent.

**Changes to synthesized output.** Use the CDK feature-flag pattern:

- New projects record the current behavior revision.
- Existing projects keep the old synthesized output until they adopt the new revision through a reviewed migration.
- Tolerant defaults cover additive changes. Missing framework declarations fall back to the package rather than throwing.

**Two gates.** Pulling a new Studio never changes a project.

- **Source gate:** the reviewed pin upgrade.
- **Cloud gate:** the deploy plan, which already flags stateful types and replacements ([deployment-plan.ts](../../../packages/aws-studio/cli/deployment-plan.ts)).

New infrastructure is opt-in for existing projects through a behavior revision.
The exception is a security fix.

## Requirements walkthrough

### Change RdsStack's managed logic

- **Delivery.** Move the class into `aws-studio/cdk/`. Pass the database definition in, as it already is through `definition`. Have the package contribute the `stacks.rds` reference. Keep the stack ID and construct IDs identical, and prove it with an empty template diff.
- **Safety.** Gate any change to an existing database's synthesized template behind a behavior revision. Moving resources between stacks or renaming logical IDs can use `cdk refactor` later. It is a preview that needs `--unstable=refactor` and a current bootstrap stack, so 1.0 should not depend on it.
- **Database-specific risks.** See [managed database platform](managed-database-platform.md).

### Add a framework-managed native CDK stack

- **What works today.** The package can add a stack only inside a factory the project already calls. The catalog already labels anything under `node_modules/aws-studio/cdk/` as framework.
- **Blockers.**
  - The shared stack namespace.
  - Stack order lives in `application.ts`.
- **Fixes.**
  - A reserved prefix for framework stacks.
  - The single package-owned composition.
  - A behavior revision, so existing projects opt in.

### Add a framework-managed Lambda

- **Internal to a framework construct** (routing handler, custom resource, replay):
  - Ship the handler pre-bundled in the package, as `aws-cdk-lib` ships its custom-resource handlers.
  - Today `frontend-routing.ts` bundles with esbuild in the project at synth.
- **A framework workload shown in Studio's graph:**
  - `defineFrameworkConfig` must merge sections contributed by the package, under a reserved target-ID namespace. That is not built yet.
  - The auth and migration workloads in the [managed database platform](managed-database-platform.md#recommendations) are the first candidates.

## One-way doors before release

1. **No framework code in project source.** Move the framework stacks, routing, framework setting declarations, `bin/app.ts` and most of `application.ts` into the package. Once these stacks move, the catalog's `STARTER_STACKS` list becomes unnecessary. Deprecated settings such as `prodUrl` also become removable.
2. **Reserve namespaces by prefix.** Cover stack names, target IDs, input and environment keys, Compose services, output export names and SSM paths.
3. **Narrow the public API.** Define a documented public surface and gate releases with an API diff. That means API Extractor for TypeScript; `jsii-diff` fails CDK builds on breaking changes to stable APIs.
4. **Record provenance and the behavior revision at creation.** Record the starter commit, framework version and layout revision. ADR-010 names a layout revision, but it is not built yet.
5. **Stamp the deployed framework release.** Add it to template metadata, under a separate key from the identity contract.
6. **Decide the framework-owned database schema boundary.** See [managed database platform](managed-database-platform.md).

**Deferred two-way doors:**

- the codemod engine
- chained multi-version upgrades
- tier 2 regeneration
- `cdk refactor` adoption

## Cohort qualification

[qualify-retained-cohorts.mjs](../../../scripts/qualify-retained-cohorts.mjs)
already proves a two-release dependency upgrade. It does not prove source
migrations, and [verify.yml](../../../.github/workflows/verify.yml) does not run
it.

**Retain per release:**

- the Studio distribution
- the framework tgz
- the starter commit
- customized variants of the reference app: an added application stack, ownership taken, edited templates, extra workloads

Untouched reference apps miss the hard cases.

**For each old-to-new pair, assert:**

1. The upgrade applies offline.
2. Typecheck and verify pass.
3. Synth passes in dev and prod.
4. Opening the project leaves its protected files unchanged.
5. The old-versus-new template diff shows no stateful replacement or removal, no removed export and no renamed stack, unless the release declares a behavior revision.
6. Database migrations apply in order, both framework and application ([managed database platform](managed-database-platform.md)).

**Add one canary in a real account:** deploy the old version, write a row, upgrade,
deploy, and confirm the row survives.

**Support window:** publish one before 1.0, for example every release in the
current major version.

## Precedents

- [AWS CDK feature flags](https://docs.aws.amazon.com/cdk/latest/guide/featureflags.html): new projects enable current flags, and existing apps keep prior behavior.
- [cdk refactor](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-refactor.html), announced as a [preview in 2025](https://aws.amazon.com/about-aws/whats-new/2025/09/aws-cdk-refactor-preview).
- [Amplify Gen 2 custom resources](https://docs.amplify.aws/gen2/build-a-backend/add-aws-services/custom-resources/) and [Gen 1 custom CDK](https://docs.amplify.aws/cli/custom/cdk/).
- [jsii-diff](https://unpkg.com/jsii-diff@1.142.0/README.md).

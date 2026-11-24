# Working on AWS Studio

This repository holds Studio, the framework, CDK factories, runtime servers and the
release CLI. Read the [README](README.md) for local commands and the
[knowledge router](docs/aws-studio-knowledge/README.md) for the ownership map.
Trace each architecture-sensitive change through its smallest relevant source-linked
guide. Update the affected guide when an implementation contract changes.

| Area | Required guide |
| --- | --- |
| Studio UI, graph, source review or operations | [Knowledge router](docs/aws-studio-knowledge/README.md) and the relevant subsystem page |
| Studio and app runtimes, release admission, app upgrades or creation compatibility | [Independent evolution decision](docs/aws-studio-knowledge/architecture/decisions.md#adr-010--evolve-studio-and-projects-independently) and [release qualification](docs/aws-studio-knowledge/guides/verification-and-maintenance.md#qualify-studio-and-framework-releases) |
| Workload declarations, resources, CDK or local execution | [Framework](docs/FRAMEWORK.md) |
| Database, GraphQL or React Query | [Data features](docs/DATA-FEATURES.md) and the [automation contract](docs/playbooks/typed-contract-propagation.md) |
| Features that span workloads | [Feature build procedure](docs/playbooks/feature-build.md) |
| Authentication and authorization | [Auth checklist](docs/playbooks/auth.md) |
| AgentCore agents and tools | [AgentCore](docs/AGENTCORE.md) and [Framework](docs/FRAMEWORK.md) |
| Development or production operations | [Development](docs/DEV-DEPLOYMENT.md) and [Production](docs/PROD-DEPLOYMENT.md) |
| Repository cleanup and artifact retention | [Repository hygiene](docs/REPOSITORY-HYGIENE.md) |

## Ownership and implementation

- Preserve unrelated work and keep the npm 11 lockfile in sync. Preserve native
  bindings and `libc` records for supported macOS, Linux and Windows hosts. Keep
  the esbuild pin and the Rust-free Prisma runtime.
- Load project configuration with `loadFrameworkConfig()` and locate it with
  `frameworkRepositoryRoot()`. Studio opens a canonical external project before
  it evaluates source. It resolves that project's release exports through
  `projectModules(root)`. Studio's own host tooling resolves from the platform
  installation. Keep these issuers separate.
- For new compatibility work, keep Studio and project runtime selection separate.
  Check release compatibility before executing project code. Treat opening as
  inspection. Make framework advances, layout migrations and missing resource
  prerequisites visible in reviewed changes. Reuse verified app wiring and
  preserve developer-owned implementations when a creator encounters a conflict.
- Treat the application as the author of declarations, native stacks, handlers,
  Prisma models, API schemas, generated peers, client code and reviewed receipts.
  Keep application routing and import tables out of the framework. A project
  owns its generated output and its declared `@repo/framework-generated` peer.
  Change authored source and run its generator to update a projection.
- Keep `aws-cdk-lib` and `constructs` as release peers. Each app uses one physical
  copy of each. Evaluate the installed release in tests that exercise an
  independent app. Preserve the public entry points and the standalone CLI.
- Preserve the distinction between public paths, target IDs and deployed
  construct identities. Keep historical stack scopes, `cloud.constructId` and
  stack-prefixed output names stable. Compare normalized properties and asset
  changes as well as logical IDs when moving infrastructure.
- Preserve generic resource contracts. Workload environments use declared
  inputs and native references, database access uses explicit `database: true`
  with IAM, network placement uses declared VPCs and subnets, and invocation
  uses declared task, workflow and WebSocket bindings. An authored secret value
  stays in its app's private input file. The framework passes secret references
  and grants through the declared delivery model.
- Contract Chain verification runs from the framework's
  `packages/aws-studio/scripts/contract-chain/` closure with the selected
  application's inputs. Read the application's receipts under its authority.
  Preserve pending proof and all receipts unless separate renewal is authorized.
- Keep same-origin `/api` and Vite `base=/`. Local Docker images own dependencies
  and generated database artifacts. Preserve `postgres_data` and label-scoped
  image/container reconciliation. Each cleanup matches its project's resource
  ownership and preserves resources still in use.
- Keep credentials, env values, private lookup cache, state and CDK output out
  of Git, release archives, starter trees and logs. Treat each app's
  `.cache/framework-studio/` as durable operational state. Use
  `output/playwright/<task>/` for disposable browser evidence.
- Database application, AWS deploy or destruction, publication and receipt
  renewal each require authorization for the target. Offline code, plan and test
  work can proceed independently.

## Verification

Use the local starter commit recorded by `scripts/starters.json` and the
`AWS_STUDIO_STARTERS` override. Run `node scripts/bootstrap-test-peer.mjs`
before a clean `npm ci --offline`. Platform integration tests share the
prepared public starter. Use a disposable isolated copy for tests that write app
source, private state, dependency trees or generated files. Use the platform
root for framework and Studio source paths. Build Studio, then run
`npm run verify` and the applicable focused suites.

Use the opened app for offline dev/prod synthesis, application-specific code
generation and Contract Chain checks. Verify both bundled and unbundled identity
captures for infrastructure changes and explain each asset delta. Use the
appropriate browser, Docker and live checks where their behavior is affected.
Record exactly which commands ran and preserve evidence for any pending gate.

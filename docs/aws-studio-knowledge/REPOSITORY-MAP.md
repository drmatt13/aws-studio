---
id: knowledge.repository-map
summary: Source ownership and exact entry points without a full repository tree.
read_when:
  - Locating implementation and test owners
source:
  - package.json
  - AGENTS.md
related:
  - knowledge.architecture-map
  - guides.maintenance
---
# Source ownership map

For the product map start with [AWS Studio](../AWS-STUDIO.md); for all documentation
areas use the [documentation index](../README.md).

Source links and metadata are relative to the platform checkout. Application paths are relative to the selected app.

| Source owner | Entry points / responsibility | Architecture |
| --- | --- | --- |
| Application `framework.config.ts`, `framework-config/` | Composition root, literal sections, defaults, network, catalog, type-only contracts | [Configuration](framework/configuration.md) |
| [packages/aws-studio/src/config/](../../packages/aws-studio/src/config/) | `defineFrameworkConfig`, `normalizeFrameworkConfig`, resource types, workflow builder/IR/ASL | [DSL](framework/configuration.md), [workflows](framework/workflows.md) |
| [packages/aws-studio/cdk/](../../packages/aws-studio/cdk/) | Generic Lambda/ECS/network/orchestration, ordered composition and resource finalization. An app supplies its own `cdk-app/bin/app.ts` and `cdk-app/lib/application.ts`. | [Resources/CDK](framework/resources-and-cdk.md) |
| Application `cdk-app/lib/app/` | App-owned Cognito, database, frontend and custom resource constructs | [Resources/CDK](framework/resources-and-cdk.md) |
| [client-app/server/](../../client-app/server/) | `main`, `startServer`, `SnapshotBuilder`; model, source evidence, editing, deploy adapters | [Snapshots](studio/snapshots.md), [editing](studio/editing.md) |
| [client-app/shared/](../../client-app/shared/) | `Snapshot`, `ModeModel`, `ModelEdge`, API intents, creation forms | [Graph](studio/graph-model.md) |
| [client-app/src/](../../client-app/src/) | Router, `StudioProvider`, `InspectorDraft`, views, Canvas scene | [Rendering](studio/rendering.md), [editing](studio/editing.md) |
| [packages/aws-studio/src/local/](../../packages/aws-studio/src/local/), [src/runtime/](../../packages/aws-studio/src/runtime/) | Local executor/environment/interpreter vs deployed helpers/auth/invocation | [Local](runtime/local-execution.md) |
| [packages/aws-studio/local/api/](../../packages/aws-studio/local/api/), [packages/aws-studio/local/websocket/](../../packages/aws-studio/local/websocket/) | HTTP/service proxy, Cognito auth, WebSocket connection transport, replay | [Local](runtime/local-execution.md) |
| [packages/aws-studio/local/invocation/src/](../../packages/aws-studio/local/invocation/src/) | Container Lambdas/tasks, workflow runs/callbacks, agent processes, image reconciliation | [Local](runtime/local-execution.md), [agents](framework/agents-and-tools.md) |
| Application `compute/`, `packages/models/` | Workload implementation roots: http, websocket, events, tools, services, tasks and agents. The app owns shared model providers. | [Agents/tools](framework/agents-and-tools.md) |
| [packages/aws-studio/cli/deploy.ts](../../packages/aws-studio/cli/deploy.ts), [packages/aws-studio/src/deploy/](../../packages/aws-studio/src/deploy/) | Plan/apply, identity, target selection, ownership/discovery/classification | [Planning](deployment/planning-and-safety.md) |
| [packages/aws-studio/cli/deployment-status.ts](../../packages/aws-studio/cli/deployment-status.ts), [destroy.ts](../../packages/aws-studio/cli/destroy.ts) | AWS observation/drift and identity-scoped teardown | [Operations](deployment/operations.md) |
| [packages/aws-studio/database/](../../packages/aws-studio/database/) | Access Graph compiler/runtime, migration planning contracts and database input discovery | [Access Graph](../PRISMA-ACCESS.md), [Database workbench](../framework-studio/database-workbench.md) |
| Application `packages/database/`, `packages/api-contract/`, `client-app/` | Prisma storage/repositories, browser-safe routes/payloads and app UI | [Data features](../DATA-FEATURES.md) |
| [Studio WebSocket panels](../../client-app/src/views/websockets/) | One connection panel per Source mode (local or API Gateway), message log and client launch-link token handoff | [Interface](studio/interface.md) |
| [packages/aws-studio/dev/compose.yml](../../packages/aws-studio/dev/compose.yml), [packages/aws-studio/cli/dev.mjs](../../packages/aws-studio/cli/dev.mjs) | Image-owned dependencies, Compose Watch and local bootstrap. An app includes the release Compose base from its own `docker-compose.yml`. | [Development](../DEV-DEPLOYMENT.md) |

Platform suites cover [Studio](../../client-app/test/), [framework](../../packages/aws-studio/test/), [CDK/deployment](../../packages/aws-studio/test/cdk/) and the [runner](../../packages/aws-studio/local/invocation/test/). The selected starter supplies app source, app CDK cases and schema fixtures. [Maintenance](guides/verification-and-maintenance.md)

## Where to change Studio

Keep route entries and session owners easy to find; group extracted feature rendering
beside its owner. The [interface guide](studio/interface.md) owns the route/state model,
and the [UI design system](../framework-studio/ui-design-system.md) owns shared controls.

| Change | Start here | Relevant regression surface |
| --- | --- | --- |
| Page route, deep link or selection URL | [main.tsx](../../client-app/src/main.tsx); page entry in `src/views/` | `startup-ui`, `hmr-ui`, browser `shell` |
| Shared navigation, source selector or health drawer | [Shell.tsx](../../client-app/src/views/Shell.tsx), `NavigationStrip`, `SourceContext` | `navigation-polish`, browser `shell`/`responsive` |
| Inspector section or entity-specific content | [Inspector.tsx](../../client-app/src/views/Inspector.tsx) dispatches to [views/inspector/](../../client-app/src/views/inspector/) and existing specialized editors | `draft-ui`, browser `inspector-navigation`/`map-editing` |
| Trigger form steps or field editors | [Triggers.tsx](../../client-app/src/views/Triggers.tsx) owns state; [inspector/triggers/](../../client-app/src/views/inspector/triggers/) owns rendering | `trigger-ui`, `draft-ui`, creation/trigger server fixtures |
| Draft lifecycle or source request conversion | [draft.ts](../../client-app/src/draft.ts), [draft-entries.ts](../../client-app/src/draft-entries.ts) | `draft`, `draft-ui`, source transaction fixtures |
| Map toolbar or keyboard entity list | [views/map/](../../client-app/src/views/map/); [Isometric.tsx](../../client-app/src/views/Isometric.tsx) owns state/callbacks | `isometric-ui`, browser `map-editing`/`responsive` |
| Scene geometry, layout, drawing or picking | [scene/](../../client-app/src/scene/); [types.ts](../../client-app/src/scene/types.ts) defines scene contracts | geometry/layout/landscape/hover suites; browser map cases |
| HTTP behavior, snapshot refresh or server events | [http.ts](../../client-app/src/http.ts), [api.ts](../../client-app/src/api.ts), [snapshot.ts](../../client-app/src/snapshot.ts), [events.ts](../../client-app/src/events.ts) | `api-response`, `events`, `startup-ui`, `browser-boundaries` |
| Deployment evidence, refresh or live logs | [deploy/](../../client-app/src/deploy/) separates API, query definitions, event hooks and log store; [Deploy.tsx](../../client-app/src/views/Deploy.tsx) composes the page | `deploy-ui`, deploy-service fixtures, browser `operations` |
| Authentication or production domains | [AuthenticationWorkspace.tsx](../../client-app/src/views/AuthenticationWorkspace.tsx) owns state/operations; [AuthenticationEvidence.tsx](../../client-app/src/views/AuthenticationEvidence.tsx) owns read-only evidence; [DomainsWorkspace.tsx](../../client-app/src/views/DomainsWorkspace.tsx), `identity-api`, `identity-queries` | `cognito-workspace-ui`, `domains-workspace-ui`, browser operations |

## Shared code and local conventions

Studio's router is explicit in its `src/main.tsx`. The selected application's
React client uses its own file routes under `client-app/src/routes/` and owns its
generated route tree, TypeScript config and path aliases. The framework's
[package manifest](../../packages/aws-studio/package.json) defines the shared
`config`, `runtime/*`, `local`, `deploy`, `source-index` and `checks/*`
entry points. The app provides its generated `@repo/framework-generated`
peer. Platform tests use the source from the recorded starter commit.

| Concern | Existing owner / convention |
| --- | --- |
| Shared browser/server shapes | [Studio shared contracts](../../client-app/shared/); runtime imports stay browser-safe, as enforced by `browser-boundaries.test.ts`; type-only contracts can cross the boundary |
| Component and feature ownership | Named React components in `src/views/`; feature subdirectories hold cohesive rendering, while session/draft owners retain state and effects |
| Shared controls and class recipes | [src/ui/](../../client-app/src/ui/), [inspector-ui.ts](../../client-app/src/inspector-ui.ts), `DocumentUI`, `WorkbenchUI` and `views/map-styles.ts`; use the [UI design system](../framework-studio/ui-design-system.md) before changing presentation |
| Studio styles | [styles.css](../../client-app/src/styles.css) registers sources and responsive variants; [styles/](../../client-app/src/styles/) owns theme, base/native behavior and CodeMirror integration |
| Declaration discovery and source links | [config-source.ts](../../packages/aws-studio/scripts/config-source.ts), [server/source/](../../client-app/server/source/); follow [source indexing](studio/source-indexing.md) before moving declarations or rewriting recognized syntax |
| Generated projections | [AGENTS.md](../../AGENTS.md) lists protected outputs; use root `framework:generate`, database `generate`, root `codegen` or the client route build through the [required contract sequence](../playbooks/typed-contract-propagation.md) |

These are current ownership boundaries, not a reason to rename every existing file or
introduce a common abstraction across applications. Native CDK, declaration modules and
Studio source writers have different contracts even where their TypeScript looks similar.

## Commands and test discovery

The platform [package.json](../../package.json) owns Studio and release
commands. The selected app owns its aliases for generation, deployment, exports
and identity checks. Those aliases invoke the [release CLI](../../packages/aws-studio/cli/)
through the pinned installed package. The app's `packages/database/` owns the
schema and repositories. It uses the reusable [database tooling](../../packages/aws-studio/database/).
[Development](../DEV-DEPLOYMENT.md) · [Production](../PROD-DEPLOYMENT.md)

| Test surface | Discovery / runner |
| --- | --- |
| Studio unit, DOM and service fixtures | `client-app/test/*.test.ts`, Node test runner with development conditions, CSS registration and `tsx`; use its workspace `test` script to preserve those options |
| Framework, CDK, database, API server and invocation runner | Each workspace's `test/*.test.ts` through its manifest; Node test runner and `tsx`, with workspace-specific concurrency |
| Application and standalone WebSocket client | Colocated `*.test.ts` / `*.test.tsx`, through the workspace's Vitest configuration |
| GraphQL executable schema | `compute/http/graphql-api/schema/*.test.ts`, explicitly included by root `verify`; schema modules also require explicit registration |
| Studio browser fixtures and visuals | `client-app/test/browser/*.spec.ts`, a separate Playwright command; [browser guide](../../client-app/test/browser/README.md) owns sanitized API fixtures, pinned fonts, screenshot review and output retention |

From the platform root, `npm run verify` runs typechecks and workspace suites with the prepared starter. In the app, the verification command covers its generated artifacts, schema and Contract Chain. Browser checks, full application synthesis, Docker
execution and live database/AWS evidence are separate. Test globs and explicit schema
imports make file placement significant; an apparently unimported test or fixture is
not evidence that it is unused. [Maintenance](guides/verification-and-maintenance.md)
maps checks to change surfaces; [repository hygiene](../REPOSITORY-HYGIENE.md) distinguishes
maintained fixtures and reviewed visual references from disposable output.

Respect [AGENTS.md](../../AGENTS.md) and its generated-file exclusions. Application GraphQL/data feature procedures remain in their existing guides; this wiki maps their boundary rather than duplicating them.

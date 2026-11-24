---
id: architecture.contracts
summary: Authority, derived representations, execution boundaries, and authentication boundaries.
read_when:
  - Deciding which representation to change or trust
source:
  - packages/aws-studio/src/config/source.ts
  - packages/aws-studio/src/config/index.ts
  - client-app/shared/model.ts
  - packages/aws-studio/package.json
  - packages/aws-studio/database/client-access.ts
  - packages/aws-studio/database/access-graph-artifact.ts
  - packages/aws-studio/database/access-runtime.ts
  - packages/aws-studio/src/config/project-declarations.ts
  - packages/aws-studio/src/deploy/stateful-resources.ts
  - scripts/studio-release.json
  - client-app/server/project-release.ts
related:
  - framework.configuration
  - studio.graph-model
  - reference.invariants
---
# Sources of truth and boundaries

| Representation | Owns | Does not establish |
| --- | --- | --- |
| `framework-config/` + root composition | Workload declarations, bindings, shared defaults and resource references | Whether a referenced application stack was instantiated |
| Application CDK + framework factories | Native constructs, linked catalog members, generated CloudFormation | Actual deployed state or external service success |
| `contract.prisma`, handlers, tool/agent contracts | Storage and executable application behavior/payloads | Automatic GraphQL exposure or record authorization |
| Access Graph directives and compiler | Optional row/field rules, scoped roles, named permissions and commands; generated policy and Studio previews | Enforcement in application code that has not bound the policy, SQL privileges, or automatic GraphQL exposure |
| Generated contracts/Compose projections | Consumer-specific views of authored declarations | Independent editable configuration |
| Studio `Snapshot` / source index | Evaluated dev/prod graphs, source locations, evidence and diagnostics | Complete IAM policy, arbitrary CDK execution, live AWS topology |
| Saved deployment assembly/plan | The exact synthesized templates reviewed for an apply | Drift-free infrastructure or predictable custom-resource side effects |
| CloudFormation observation/export | Observed stack identity/status and published runtime values | A replacement for authored source |

The central path is **declaration → normalize/validate → consumer projection**. [Configuration](../framework/configuration.md) owns normalization; [graph model](../studio/graph-model.md) owns Studio's serialized view. Update the producer and run its generator instead of patching a generated consumer.

`aws-studio` has explicit config, runtime, local and source-discovery entry points with no package-root barrel. Config remains browser-safe; CDK types enter catalog/contracts through `import type`. Backend runtime helpers must not import the entire configuration machinery. Browser application code consumes `@repo/api-contract`, not local/runtime modules. See [package exports](../../../packages/aws-studio/package.json) and [entry-point tests](../../../packages/aws-studio/test/entry-points.test.ts).

The framework package holds nothing derived from one application: `framework:generate` writes target
ids, agent contracts, the replay manifest and endpoint names into `packages/framework-generated`,
a peer the application provides ([app-agnostic test](../../../packages/aws-studio/test/app-agnostic.test.ts)).
Platform code serves the project it runs for: it loads `<root>/framework.config.ts` through
`loadFrameworkConfig` and finds the root with `frameworkRepositoryRoot`, which honours
`FRAMEWORK_REPOSITORY_ROOT` (set by `cdk-app/bin/app.ts`), never a path relative to its own files
([platform boundary test](../../../packages/aws-studio/test/platform-app-boundary.test.ts)).
Studio and CDK load deployment and sign-in declarations from the project root. Studio
also reads local-tooling declarations there and resolves stateful policy and reference
validation through the framework installed at the opened project's root.

Studio validates the app's exact framework pin and npm lockfile before executing
project code. Its installed framework declares the minimum Studio release.
Compatible projects use the physical `node_modules/aws-studio` in the selected
app under its own Node runtime. The Studio installation supplies its own Node
runtime, release metadata and bundled archive for reviewed upgrades.

Opening a project preserves its files and dependencies. Create missing deployment
inputs through the explicit setup action. Studio applies a required framework
change with the approved project edit and its dependency installation.
[Independent evolution decision](decisions.md#adr-010--evolve-studio-and-projects-independently)

Studio's loopback/token guard protects a trusted local editing tool. Application authentication is a different boundary: shared Cognito ID-token verification, route/agent authorizers, and explicit per-record authorization in GraphQL. An HTTP handler requiring a session uses `authenticated(...)` and declares `userPool: true`; route `auth` and record access still need their own checks. Consult the [auth checklist](../../playbooks/auth.md) before changing any coupled surface.

The [Access Graph compiler and interpreter](../../PRISMA-ACCESS.md) are generic platform
tools exposed through `aws-studio/database/*`. Application database generation
emits policy artifacts from the app's schema. Studio edits and previews their
declarations. The boilerplate User/Project contract has no access directives and uses
its existing resolver/repository authorization. Compiling a rule does not install a
GraphQL enforcement hook, a database privilege, or an application transaction boundary.

Local child processes/evaluators share host trust and credentials; they isolate module state/lifecycle, not hostile code. Local managed-service integrations can call AWS. [Local execution](../runtime/local-execution.md) and [environment delivery](../runtime/environment.md) define those limits.

For changes crossing representations, follow [change impact](../reference/change-impact.md) and preserve the [invariants](../reference/invariants.md). Source inspection proves an implementation path; focused tests prove selected behavior; live integrations require separate evidence.

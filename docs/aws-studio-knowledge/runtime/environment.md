---
id: runtime.environment
summary: Declared resource references become scoped workload environment values and invocation descriptors.
read_when:
  - Changing workload environment injection or local/cloud parity
source:
  - packages/aws-studio/cli/local-client.mjs
  - packages/aws-studio/cli/local-export.ts
  - packages/aws-studio/src/local/origins.ts
  - client-app/server/client-environment-source.ts
  - client-app/server/deploy/local.ts
  - packages/aws-studio/src/local/environment.ts
  - packages/aws-studio/src/runtime/database.ts
  - packages/aws-studio/src/runtime/invocation.ts
  - packages/aws-studio/cdk/framework-cloud.ts
  - packages/aws-studio/local/invocation/src/tasks.ts
related:
  - deployment.secrets
  - deployment.environments
  - framework.resources-cdk
---
# Workload environment resolution

The catalog defines references; an execution lane supplies their values. [Secrets/input storage](../deployment/secrets.md) owns authored files and deployment synchronization; this page owns delivery to a workload.

## Configuration ownership

Treat these as distinct layers, even when Studio presents them in neighboring inspectors:

| Layer | Authoritative source | Consumers and generated outputs |
| --- | --- | --- |
| Workload intent and source-owned values | `framework-config/workloads/`, `inputs/`, `stacks/`, `defaults.ts`; standalone `input.value` | Normalized settings, Studio graph, local runtime and CDK |
| Environment-linked values and secret contents | Selected target's authored `cdk-app/.env.dev` or `.env.prod` (or its explicitly configured input file) | Input resolution and separately authorized secret synchronization |
| Deployment-wide settings | `framework-config/inputs/deployment.ts`, resolved by `deployment.ts`; targets in `cdk.json` | Account/mode/region, domains, lifecycle and deployment assembly |
| App and local project name | `framework:app` in `cdk-app/cdk.json`, edited by the Studio navbar | Compose uses the app name; stages use `<app>-<stage>`. Export generates `COMPOSE_PROJECT_NAME`; it is not an authored env input |
| Deployed resource identities | Identity-checked CloudFormation outputs | `.framework/local/resources.json`, generated root Compose controls and production output records |
| Public browser recipes | `framework-config/client-environment.ts` | Generated `client-app/.env.development.local` or `.env.production.local` |
| Per-process runtime environment | The target's declared environment/secrets/bindings plus allowed platform settings | Worker/container environment, generated invocation descriptors and database connection settings |

An environment variable exported in the invoking shell does not override an authored
resource input. [readAuthoredInputs](../../../packages/aws-studio/src/config/source.ts)
parses the selected input file itself; `FRAMEWORK_INPUTS_FILE` selects an explicit
alternate file. CDK context overrides apply when the caller supplies the context reader.
Local workload resolution reads authored inputs without a CDK context reader. Root `.env`
is generated Compose output, not a fallback input store for declarations.

`resolveInput` in [config/resources.ts](../../../packages/aws-studio/src/config/resources.ts)
returns `supplied`, `fallback`, `missing`, `unresolved`, `invalid` or `not-applicable`.
Blank environment lines are unset; enum comparisons accept case-insensitive spelling
and return the declared choice. A required input with no supplied value or default is
missing; an optional one is unresolved. Inputs absent from the selected graph are
not applicable. Standalone values are supplied from source before external reads.
Secrets resolve through secret handles rather than this public-string path.

The development client API and WebSocket port inputs declare defaults of 8080 and 8081
in `framework-config/inputs/index.ts`. Both client URL generation and
`packages/aws-studio/cli/local-export.ts` use these declarations through `resolveInput`, so blank/missing
overrides agree. Local export still validates port ranges and collisions; framework-only host
ports without an input default must be supplied explicitly.

`LOCAL_DEV_URL` also sets the Vite development server's port, shared by Studio's
managed client and `npm run dev:client`. The client reads the authored development
inputs file (or `FRAMEWORK_INPUTS_FILE`), ignoring shell/root-output overrides for
this setting. Blank or missing values use `http://localhost:3000`. The shared parser
in `packages/aws-studio/cli/local-client.mjs` keeps Vite, Studio's launch/readiness URL and the local
browser allowlist aligned; Vite refuses an occupied port. Edit it in CDK environment's
Deployment settings, then restart local runtime to refresh local settings. Cognito
callback changes require a separately authorized development deployment.

The development-only `STUDIO_URL` input defaults to `http://127.0.0.1:4590`.
It supplies `VITE_STUDIO_URL` for the application's `/websockets` launch link and
the local browser-origin allowlist alongside `LOCAL_DEV_URL`. Local export accepts
an HTTP origin on `127.0.0.1` or `localhost`, trusting both names at that port.
Match this input to Studio's `--port` when customized; Studio runs on the host,
independently of Compose. Production leaves `VITE_STUDIO_URL` blank.

`VITE_API_GATEWAY_URL` is generated output, never a catalog input or an authored CDK
environment variable. Development derives the Vite proxy target from the local HTTP API
port; production maps the frontend stack's `CloudFrontUrl` (legacy `FrontendWebsiteUrl`
fallback), which owns the browser's same-origin `/api` entry point. The HTTP API stack
exports `HttpApiUrl` separately; the production browser continues using same-origin paths.

## Delivery and process scope

```mermaid
flowchart TD
  catalog["Catalog references and workload declarations"] --> resolver["Selected-mode resolution"]
  values["Public source values"] --> resolver
  inputs["Selected authored input file"] --> resolver
  resolver --> synth["CDK environment and capability wiring"]
  resolver --> local["Scoped local workload environment"]
  outputs["Identity-checked deployed outputs"] --> manifest["Generated development resource manifest"]
  manifest --> local
  inputs --> secretReview["Separate secret review and authorized delivery"]
  secretReview --> secrets["Secrets Manager handles"]
  native["Native generated or imported secrets"] --> secrets
  secrets --> runtime["Lambda secret reads or ECS secret injection"]
  recipes["Public client mapping recipes"] --> exporter["Client environment exporter"]
  outputs --> exporter
  resolver --> exporter
  exporter --> vite["Generated public Vite environment"]
```

The client exporter uses only supported public recipes and input references; secret
handles/contents are excluded from that path. Local authored container secrets can be
injected directly from the private input file, while native stack secrets require an
AWS read. The diagram shows dependencies, not an automatic deploy or export on save.

`resolveLocalWorkloadEnvironment` in [local/environment.ts](../../../packages/aws-studio/src/local/environment.ts) finds the normalized target, starts from an allowlisted platform environment, loads selected authored local inputs and a development resource manifest, then resolves the target's declared environment/secrets/requirements. It runs before application modules read `process.env`.

| Declaration | Local delivery | Cloud delivery |
| --- | --- | --- |
| Literal or `input.value` | Literal / standalone declared non-secret value | Declared value, without a resource output or link |
| `input.fromEnv` | Selected authored input with enum/default/required rules | Deployment readers resolve selected target inputs |
| Native string attribute | Manifest keyed by canonical resource attribute; missing nonoptional reference fails | Linked native construct attribute/token |
| Secret `.arn` in Lambda environment | Manifest ARN; runtime secret reader may call AWS | Secrets Manager ARN plus read grant; contents are not embedded in the template |
| Secret `.value` / `.field` in container secrets | Raw authored secret for fromEnv; stack secret fetched once per resolution, optionally JSON field extracted | ECS secret injection from declared native/imported secret |
| `database: true` | Compose database URL and pool settings only for declared consumers | IAM database token/permissions and framework-owned VPC placement |
| Task/workflow/agent binding | Local runner descriptors with declared caller/target | AWS descriptors and narrowly derived invoke permissions |
| Agent gateway selection | Generated `FRAMEWORK_AGENTCORE_ADAPTER` with local gateway descriptors and tool routing | Same managed variable with selected IAM-authorized gateway endpoints |
| User-pool binding | Declared application pool references | Same application pool supplied by CDK; never paste pool IDs |

`readLocalResourceManifest` checks the exported resource document; absent/optional resources are handled deliberately. Conditional `cloud.requirements` are evaluated using the same declared references. `TRUSTED_FRONTEND_ORIGINS` has a deliberate local-browser-origin override. Deployed Lambda dual-stack endpoint behavior derives from framework network/placement. Local workloads use ordinary host and Docker networking; the local runtime does not inject `AWS_USE_DUALSTACK_ENDPOINT` based on cloud placement.

Standalone `input.value(...)` inputs are resolved from `authoredValue` (and `modes.value`
when graphs differ). `resolveInput` reports them as supplied without consulting environment
or CDK context. Local/cloud delivery, requirements and deploy conditions use that same
answer; development manifests and CloudFormation resource exports omit standalone inputs.
Public client recipes address them by `resource:<catalog.path>`; canonical identities also
work for environment-linked inputs, whose legacy variable-name aliases remain compatible.

Prisma configuration reads dotenv files into its own environment copy, so loading the
Database workbench cannot cache deployment outputs in Studio's process environment.
Studio also removes inherited overrides for fields in the generated development client
file before starting Vite. Vite then reads the current file, including blank values,
instead of preferring outputs inherited from an earlier deployment. Unmapped shell
settings remain available to the client process.

A task calling AWS locally declares `local: { resources: ["awsCredentials"] }`; [tasks.ts](../../../packages/aws-studio/local/invocation/src/tasks.ts) mounts the discovered profile directory read-only only for that local resource. [docker.ts](../../../packages/aws-studio/local/invocation/src/docker.ts) passes resolved environment values through the Docker CLI environment rather than value-bearing argv. The runner's Docker socket/profile mounts in Compose (`docker-compose.yml` in the app) make it a trusted developer process, not a hostile-workload isolation boundary.

[runtime/database.ts](../../../packages/aws-studio/src/runtime/database.ts) resolves IAM credentials in deployed workloads. Never deliver the database master password to a framework workload. Cloud networking remains [framework-owned](../framework/resources-and-cdk.md); an SDK custom endpoint inside a deployed VPC Lambda needs `useDualstackEndpoint: false` as required by the framework guide.

Common failures: stale/wrong-identity manifest, absent required catalog field, invalid enum/default, missing local secret field, unauthorized stack-secret read, undeclared invocation capability, or missing dev AWS bridge. Debug names, presence and identity first; do not print resolved environment objects or credential values.

## Public client configuration

Browser environment recipes remain public references in
`framework-config/client-environment.ts`. The existing output exporter resolves them
against completed deployed identity and the named target's own input file. Its
`--client-only` mode writes the selected public client env without Docker, root
Compose settings or the local manifest. Studio's static frontend release invokes that
same exporter before its configured package script, binds mapping/input/package hashes
and exact artifact bytes, then separately reviews S3 publication and CloudFront
invalidation. Build settings live in `framework-config/deployment/frontend-release.json`;
[frontend release](../../framework-studio/frontend-release.md) owns that workflow and
the distinction between upload, invalidation submission and observed application health.

Client recipes support public `input`, allowlisted stack `output`, deployment `region`,
`endpoint` and `empty` sources, with an optional input equality condition. A shared
recipe serves both modes; `{ dev, prod }` is used only when the recipes differ. There is
no independent `enabled` flag: source availability determines whether the generated
field is blank. Missing required inputs fail export. An unset comparison input also
fails rather than silently selecting false; a comparison outside its graph is blank.
An optional output tolerates an absent stack, not a present stack lacking its requested
output. These distinctions are implemented by
[client-environment-export.ts](../../../packages/aws-studio/cli/client-environment-export.ts).

The export resolves every mapping before writing, validates deployment identity, refuses
secret references and rejects URL credentials. A public catalog path is
`resource:<catalog.path>`; an environment-linked input also retains its variable-name
alias. `VITE_` values are browser-visible; renaming a secret to evade name checks does
not make it safe. Only public string declarations belong in this recipe system.

## Verification

Validate changes through framework environment/resource/runtime tests, [database runtime tests](../../../packages/aws-studio/test/database-runtime.test.ts), [export tests](../../../packages/aws-studio/test/cdk/environment-export.test.ts), [resource deployment tests](../../../packages/aws-studio/test/cdk/resource-deployment.test.ts), and local worker/runner tests. Cloud grants, SDK endpoint behavior and real IAM remain separate synth/live checks.

# Development

This guide gets a checkout running and explains the everyday edit/reload loop.
Commands run from the repository root. Replace placeholders before running commands.
For a shorter first pass, use [Quick Start](../QUICKSTART.md). The
[operational lifecycle](aws-studio-knowledge/deployment/lifecycle.md) explains which
steps save files, inspect state or need separate deployment/database approval.

The local API server uses browser paths: `/api/<http-or-service-path>` for HTTP/service
declarations and the exact `route` for agents. The Vite proxy preserves those paths.
`npm run dev:request` still takes an HTTP declaration key (e.g. `/graphql`) and adds `/api`.

## First setup

For the source workspace, install the official Node 24.22.2+ distribution (24.x)
with its bundled npm 11.19.1+ (11.x), then follow the
[source bootstrap](../README.md#run-studio-from-source). The standalone Studio
1.0.0 distribution uses Node 26.13.0 with npm 11.20.0. Maps, inspection and
ordinary source review and apply work without AWS credentials, Docker or a
coding agent. [Standalone installation](../README.md#install-and-open-studio)
AWS CLI v2 credentials are needed for AWS operations. Local application compute needs
Docker Desktop on Windows/macOS, or Docker Engine/Desktop on Linux, using Linux
containers and Compose Watch (`watch --no-up`, Compose 2.32+). The workspace
provides the CDK CLI; use `npm --workspace cdk-app exec -- cdk ...`.

### Supported development hosts

The source workspace and operations runner target native Windows, macOS and
Linux. See the [distribution qualification matrix](aws-studio-knowledge/guides/verification-and-maintenance.md#qualify-studio-and-framework-releases)
for its host and project runtime pairings.
On Windows, use a local NTFS checkout owned by your Windows account, the installed
Windows PowerShell/.NET components and CIM process inspection. Run Studio from an
unelevated terminal: startup checks the token before initializing any state or input
files. An elevated Administrator token or a default owner different from the current
user is rejected. Close the Administrator terminal, open PowerShell/Windows Terminal
normally (without **Run as administrator**), and run `npm run studio` again.
Windows Docker Desktop requires the WSL 2 backend and Linux containers. Studio uses named pipes,
Windows ACLs and Job Objects for the local equivalents of Unix sockets, file modes and
process groups. It does not require a Unix shell for normal Studio operations. Docker
Desktop still runs the application's Linux containers; Linux hosts can use Docker Engine.
Cancellation during the Windows supervisor's compilation can leave private compiler
source/assembly files; an already-started compiler may finish independently. The
application command starts only after compilation and live-parent checks. Normal
completion removes that command's compiler directory; no automatic sweep runs.

On macOS/Linux, protected edits and independent operations need `ps` to verify
process ownership and start times. macOS supplies it; minimal Linux images may
need `procps` (`procps-ng` on some distributions). If Studio reports **Host process
inspection is required**, install that package using the host's package manager
and retry. Preserve existing private and recovery state.

A local Windows fixture reproduced a native `fs.rmSync` process abort on a Unicode
directory when deletion was denied with Node 24.16.0. The same eight probes completed
with Node 24.22.2; Node's [upstream non-ASCII error-path fix](https://github.com/nodejs/node/pull/61233)
is the relevant change. This establishes the local reproduction and patched-runtime
result; it does not identify every earlier interrupted run's cause. Install/select
the official Node 24.22.2 distribution, reopen a normal terminal, verify `node --version`
and `npm --version`, then retry. Preserve private and recovery state; do not bypass
permission checks or delete `.cache/` or `.framework/` to work around the abort.

Native Windows Coding additionally requires a Codex CLI with its MXC sandbox available
and a passing Studio boundary probe; conversational CLI availability alone is insufficient.
See [Coding execution](framework-studio/local-agent-lab.md). Missing isolation keeps coding
disabled while ordinary map, editing and operational work remains available.

The [verification workflow](../.github/workflows/verify.yml) builds client routes and runs
`npm run verify` on Windows x64, Linux x64, macOS Intel and Apple Silicon using the
official Node 24.22.2 distribution and bundled npm 11.19.1, with no global npm upgrade.
CI checks both installs for tracked changes in a checkout containing spaces/Unicode.
Each platform is an independent result; configured jobs are not observed passes.

Windows CI tests its unmodified token and rejects unsupported startup before its unit
suite. The CI-only token helper then changes only that short-lived verification
shell’s default owner so private-file fixtures reproduce current-user ownership.
It does not remove elevation or make an elevated shell a supported development host;
those unit results do not establish native unelevated Studio startup. Developer and
fresh-install acceptance never use the helper. Native coding, desktop/Docker and live
AWS checks remain separate from the offline suite.

Run focused Studio tests from `client-app` with its package-script loader flags
so TSX uses the workspace's JSX configuration. Lifecycle fixtures report module loading
over child IPC before starting their server startup/shutdown deadlines. Source-mode
Contract Chain imports capture installed dependency identities; that loading work must
finish before a lifecycle test can establish which phase failed. A missing readiness
message is a failure, never evidence that the server started or stopped correctly.

Deployment integration tests copy current public source and rebase workspace dependency
links into disposable projects. Their locks, input bindings and recovery journals belong
to those projects. A retained checkout production lock must not be removed to run tests.
Windows log fixtures create actual private ACLs before writing records; POSIX mode bits
alone do not establish Windows privacy. Offline verification still includes these native
process/filesystem checks; it does not establish browser, Docker or live AWS behavior.

### Node and npm selection

The supported application baseline is Node 24.22.2 and its bundled npm 11.19.1.
Each project's `.nvmrc` and `packageManager` identify its preferred pair. Runtime
selection prefers the exact pair and accepts a compatible newer patch or minor
within the pinned majors and declared engine ranges.
It checks the running installation, nvm's installed pin, Homebrew's `node@24`, and
absolute directories on `PATH`. It also recognizes an official distribution extracted
to `~/.local/share/aws-studio/node/24.22.2` (`$XDG_DATA_HOME` can replace `~/.local/share`)
or `%LOCALAPPDATA%\aws-studio\node\24.22.2` on Windows. Keep that installation outside
the checkout so Studio can use it in restricted contract checks. For other locations,
set `AWS_STUDIO_PROJECT_NODE` to the absolute app Node or `node.exe` when
opening Studio. The Studio bootstrap and direct project CLI use `AWS_STUDIO_NODE`
when run from a terminal.

Installed Studio has its own runtime choice. Project evaluation, inspection,
deployment commands and local client processes start under the selected app runtime.
Restart Studio after replacing the host or project Node. A durable Coding host can
outlive that restart. When Studio reports an older host, use **Restart agent host**
after its work finishes to adopt the current runtime and checker.

Run `npm ci` and `npm install` with the supported Node 24 and npm 11 already active.
`devEngines` may warn about the shell's bootstrap runtime before a launcher command
selects the project runtime. `npm run verify` checks native lockfile bindings, and Studio
requires npm 11.19.1+ within npm 11 before generating a workspace lockfile.

```powershell
npm ci
npm run studio
```

Check AWS identity separately when preparing an authorized operation:

```powershell
aws sts get-caller-identity --profile <PROFILE>
```

In Studio, open the **CDK environment** inspector and choose **Create** for each
missing mode file you need. For CLI-only setup, copy
`cdk-app/.env.dev.template` to `cdk-app/.env.dev` if the file is missing.
The inspector edits both modes side by side and flags each mode's missing required values.
Template creation supplies framework defaults; configure your own deployment values before deploying. Set:

- The app's name, `framework:app` in `cdk-app/cdk.json` (Studio's navbar edits it, and adds
  the app's permanent `framework:appId` if it is missing). Your development deployment is
  `<app>-dev`; one AWS account per developer keeps teammates' dev deployments apart. After a
  rename, the next development deploy starts `<new-name>-dev` fresh and notes the earlier one
  still running; Studio's Deploy page deletes it, or keeps deploying to it.
- LOCAL_DEV_URL, LOCAL_AWS_REGION, and the framework tooling's host ports in the example.
  The client API and WebSocket ports may stay blank: their input defaults are
  8080 and 8081, shared by client URL generation and the local Compose export. Leave
  LOCAL_AWS_PROFILE blank to use your AWS default profile.
- Studio hosts the WebSocket tester at `http://127.0.0.1:4590/websockets`; start it
  with `npm run studio`. `STUDIO_URL` may stay blank for this default origin. If
  using Studio's `--port`, set `STUDIO_URL` to match before exporting. Export trusts
  Studio's `127.0.0.1` and `localhost` origins at that port for local connections.
- Any workload settings, such as the example agent's LangGraph model provider. With
  LANGGRAPH_MODEL_PROVIDER=openai, also set OPENAI_API_KEY and deploy: the agent reads the
  key from Secrets Manager by ARN, locally as in AWS.
- Optional sign-in provider credentials (Google, Microsoft, Meta). Leave custom domains off for
  routine development.
- SKIP_EMAIL_VERIFICATION=true if new users should skip the emailed code. Without it, sign-up
  sends Cognito's own verification code, which the Verify page accepts. It is refused in
  production, and federated sign-in never links to an account confirmed this way.

The [framework guide](FRAMEWORK.md#configuration-and-environment) owns configuration
precedence and environment-file responsibilities. Do not author LOCAL_BROWSER_ORIGINS;
it is derived during export. Never put backend secrets in a VITE_ variable.

Deploy the AWS portion of development. The deploy command synthesizes the dev
graph and exports the root `.env` and local resource manifest after deployment.
Commands build your development deployment unless they say `-c prodDeployment=true`,
so no mode flag is needed:

```powershell
npm run deploy:resources -- --all
```

For a named AWS profile, use `aws sts get-caller-identity --profile <PROFILE>`
to check the account, then deploy with `npm run deploy:resources -- --all --profile=<PROFILE>`.
Without a profile flag or an authored `AWS_PROFILE`, deployment uses the AWS
default credential chain.

Stateful intent lives in `framework-config/deployment/stateful-resources.ts`: development
Cognito retention is independent of production and of the database policy. Omitted
fields preserve the existing `RETAIN_STATEFUL_RESOURCES` fallback. Review source,
then deploy protection separately. A released compatible User Pool and existing
client can be selected through the explicit inspected reference workflow; this
does not import or reconfigure them. Development PostgreSQL still uses its local
volume, never an AWS database reference. See [stateful lifecycle](framework-studio/stateful-resources.md).

The deploy command synchronizes only the selected graph's configured/required secrets,
supplies ARN parameters, deploys, then exports development files. Existing managed secrets
are reused when no local value is supplied; unchanged values create no version. Synth and
diff perform no secret uploads and do not require a secret-binding file. For a standalone
refresh, run `npm run export:cdk-outputs -- --profile <PROFILE> --region <REGION>`.

Before any secret is uploaded, deploy reads what CloudFormation already holds under the
deployment's name and refuses to change stacks it does not own:

- **The other mode.** It refuses a deployment that is currently the other mode, such as a
  dev deploy over a prod deployment of the same name.
- **Unidentified stacks.** It refuses stacks that follow the deployment's names but carry
  no framework identity; they are never adopted on their name alone.
- **Stacks that disagree.** It refuses stacks whose identities disagree with each other or
  with their own account and region.
- **Busy or stuck deployments.** It refuses a deployment that CloudFormation is still
  changing, or that needs recovery.

To see what an account holds, read-only:

```powershell
npm run deploy:status -- discover --profile <PROFILE>
npm run deploy:status -- status --profile <PROFILE>
```

`discover` lists every framework deployment in the profile's account and region, with its mode as
its own stacks record it, and matches this repository's targets against them. `status` adds recent
events, pending change sets, and whether local development can run against the deployment and its
exported files are current. `--plan <dir>` / `--apply <dir>` review a deployment before it changes
anything; see [Production](PROD-DEPLOYMENT.md#deploy).

Each refusal names the stacks and a remedy, and nothing is changed. Two deploys of the same
name on one machine cannot run at once (`.cache/deploy/<name>.lock`). A reviewed plan's secret
writes are bound to the review in `.cache/deploy/secret-bindings/` (keyed digests and AWS version
ids, never values): applying refuses if a secret's authored value or its value in Secrets Manager
changed since the plan was made. Assemblies that an
interrupted run left in `.cache/deploy` are removed after a day. Deploy and export read
authored inputs from `FRAMEWORK_INPUTS_FILE` when it is set, otherwise from the target's
inputs file: `cdk-app/.env.dev` for development, `cdk-app/.env.prod` with `-c prodDeployment=true`.
There is no mode-less `cdk-app/.env`.

The dev graph holds Cognito, AWS-invoked event handlers, and replay resources. Routed
HTTP handlers, services, tasks, and workflows run locally; no ECS image is published by a
dev deployment. A dev deployment builds no WebSocket API Gateway or WebSocket handlers:
local-ws-dev-server serves locally enabled routes under Compose, so a handler may declare
`database: true`, a subnet, or bindings to tasks and workflows exactly as an HTTP handler
does. Only a production deployment builds WebSocketApiStack and
WebSocketLambdaFunctionsStack. An input condition on `deploy` controls both local and AWS
execution, resolved separately for each environment from the selector's declared
source: standalone value or environment-linked input/default.
The application's `inputs.enableWebSocketApi` reads `ENABLE_WEB_SOCKET_API` in
`framework-config/inputs/index.ts`, with a declared default of `"true"`. All WebSocket
routes and their authorizer require it to equal `"true"`. Set `ENABLE_WEB_SOCKET_API=false`
in the selected CDK environment file to disable them; blank or unset uses the default.
Restart local containers after changing a deployment selector.
The retired `DEPLOY_PROD_WEBSOCKET_API` setting must be removed (`true` warns; `false`
is refused). Use a separate full cloud deployment when testing HTTP routing.

Export writes root `.env` with fixed Compose controls and `.framework/local/resources.json`
with discovered development resource identifiers. It does not rewrite authored
`cdk-app/.env.dev`. If export reports conflicting old assignments, move authored local
settings to cdk-app/.env.dev and rerun it. The generated manifest directory and authored input
file are mounted read-only; neither is copied into images.

Export also writes `client-app/.env.development.local`, which `vite dev` reads over
`client-app/.env`: the Cognito settings, the Vite proxy target derived from the local API
host port, and the WebSocket tester URL. Nothing is copied by hand; keep your own client
settings in `client-app/.env` (from its example (`client-app/.env.example` in the app)). Two WebSocket names are
written independently: VITE_LOCAL_WS_URL is always local-ws-dev-server on its host port,
with routes filtered by their local Deploy setting; VITE_API_GATEWAY_WS_URL is
the deployment's WebSocketApiStack endpoint, which only a production deployment builds,
so a development export leaves it empty. The home page's tester link passes both in its
query; Studio's WebSockets page shows one panel for its Source mode, connecting to the
local server in Development and to the API Gateway stage in Production.
Application requests continue to use the same-origin `/api` prefix.

Studio starts Vite without inherited overrides for the generated client fields, so
redeploying a development stack uses the newly exported Cognito and endpoint settings.
The Database workbench loads its dotenv settings privately and does not add them to
Studio's process environment. If an older Studio session still serves a deleted Cognito
client ID, restart Studio and start local runtime again to load the current exports.

Those are the initial mappings in `framework-config/client-environment.ts`. Edit them in
Studio's **Client environment** inspector, then review and apply. Each field uses one
recipe for both modes, or explicit `dev` and `prod` recipes where sources differ.
There is no independent `enabled` flag: source availability determines its value.
A standalone catalog value needs no dotenv line; environment-linked inputs resolve
through the selected inputs file, context and declaration defaults. An input outside
the mode or an optional unsupplied input leaves the generated field blank. Required
missing inputs or invalid choices stop export before file writes. Public stack outputs
come from the selected deployment. Studio edits do not run export or deployment.

### macOS (Apple silicon)

- Docker Desktop must expose the default socket, `/var/run/docker.sock`: the invocation
  runner builds and runs task images through it. `ls -l /var/run/docker.sock` should
  resolve.
- Compose images run as linux/arm64 while `npm run dev:client` runs on macOS, so the
  lockfile needs both platforms' native bindings. `npm run verify` checks them.
- Change package-lock.json only with the supported bundled npm 11. npm 10
  removes the lockfile's `libc` fields.
- Node 24 matches the containers. Other Node major versions are outside the
  supported toolchain and are rejected by the root manifest.
- Container targets follow `defaults.container.architecture`. With `arm64`, task and
  service images build natively. With `x86_64` they build under emulation, which
  Docker Desktop's Rosetta option speeds up.
- Commands in these guides are PowerShell unless an `sh` variant is shown. Plain `npm`
  lines work in any shell.

### Dependency installation and security

Use the root's `npm@11.19.1` package-manager version for lockfile changes and run
`npm ci` from the root. Keep registry URLs, integrity hashes, and all supported
platform bindings in the lockfile. Funding notices need no action.

The root `package.json` owns npm's `allowScripts` policy for every workspace.
Review an updated package's scripts before renewing its version-specific approval
with `npm install-scripts approve <package>`; `npm install-scripts ls` lists pending
reviews. Workspace pnpm policies do not apply to npm. See
[npm's install-script policy](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/).

The reviewed decisions are:

- `esbuild@0.28.2`: allow its postinstall. CDK bundling, tsx, and service builds
  need its platform binary. The script selects the optional binary package,
  validates its version, and can retrieve a missing binary from npm with a hash check.
  Preserve the root esbuild pin.
- `workerd@1.20260901.1`: allow its postinstall. Prisma CLI's Composer dependencies
  bring `alchemy` and `@alchemy.run/cloudflare-runtime`, which require this binary.
  The script selects the platform package, prepares the executable, and checks its
  version, with an npm download fallback. This is development tooling, outside the
  application's deployed runtime; removing it requires changing Prisma's CLI family.
- `fsevents`: deny install scripts. Vite and tsx optionally use this macOS watcher.
  Version 2.3.3's registry metadata advertises `node-gyp rebuild`, but its published
  tarball ships `fsevents.node`, no install script, and no `binding.gyp`. No rebuild
  is needed. Keep the optional dependency for macOS; npm skips it on Linux/Windows.
  Revisit this decision if its packaging changes.

#### Historical dependency review: October 20, 2026

The findings, versions, advisory counts and test totals below record that review;
they are not a fresh security audit or current release verification. The root manifests
and lockfile own installed versions. Preserve the compatibility rationale when changing
them and rerun the relevant checks for the new dependency set.

The October 20, 2026 dependency review upgraded GraphQL Codegen CLI to 7.4.6,
schema-ast to 6.1.1, GraphQL Yoga to 5.24.6, Vite to 8.2.4, CDK library to 2.274.0,
CDK CLI to 2.1146.0 (required for assembly schema 55), and transitive launch-editor
to 2.14.2. Sign-in and MFA now declare Zod 4.4.3, the version their schemas were
already resolving from the root; this corrects their invalid Zod 3 declarations.
Patched GraphQL Tools utilities resolve
through their parents' supported ranges. CDK bundles its glob dependencies, so
upgrading CDK replaces its vulnerable bundled brace-expansion. Vite's existing
override now pins the patched 8.2.4 backport across application and Prisma tooling.

The new override is deliberately scoped to `@tailwindcss/typography`:
`postcss-selector-parser: 7.1.6`. Typography 0.5.19 (and the reviewed latest 0.5.20)
pins vulnerable 6.0.10. Version 7 retains the parser/AST APIs typography uses;
its major change makes insertion during iteration safe. Remove this override when
typography supports a patched parser itself. The security fix is described in
[GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).

The temporary Zod 4.4.3 compatibility pin from that review is superseded by the
November update below. The Gateway projection now recognizes the newer union
encoding and preserves its existing rejection diagnostic.

One advisory still has no published patch:
[braces stack exhaustion, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
All published braces versions through 3.0.3 are affected. Its development-only paths are:

```text
@graphql-codegen/cli@7.4.6
  -> micromatch@4.0.8 -> braces@3.0.3
  -> @graphql-tools/git-loader@8.0.46 -> micromatch@4.0.8 -> braces@3.0.3
  -> @graphql-tools/{code-file-loader@8.1.43,graphql-file-loader@8.1.24,json-file-loader@8.0.38}
     -> globby@11.1.0 -> fast-glob@3.3.3 -> micromatch@4.0.8 -> braces@3.0.3
  -> graphql-config@5.1.8 -> the same file loaders -> the same globby/braces chain
```

Code generation uses repository-authored file patterns in `codegen.ts`; these paths
do not handle application HTTP requests or ship in the browser/Lambda runtime.
Do not feed untrusted patterns into this tooling. Upgrade braces/micromatch and its
parents when a fix is published. Replacing Codegen or substituting a different
glob implementation would require a separate compatibility migration. The full
audit retains ten high findings propagated from this one advisory; none are ignored.

Two informational upstream notices can still appear during installation:
Codegen's `@graphql-tools/apollo-engine-loader -> sync-fetch -> node-fetch ->
fetch-blob -> node-domexception@1.0.0` chain uses a deprecated DOMException shim,
and Prisma may suggest `prisma skills sync` for optional coding-agent instructions.
The reviewed loader still requires that shim through its current dependency ranges.
Neither notice is an unapproved install script; changing agent instructions is
separate from installing application dependencies.

#### Foundation dependency review: November 7, 2026

Zod 4 consumers resolve to 4.6.7, including auth validation and AgentCore schema
generation. The existing Gateway projection tests pass with the newer union
encoding; a constrained-array regression also checks early rejection. This patches
[Zod collection memory exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
for those consumers. The browser contract workspace still uses Zod 3.25.76 and is
reported **high** by npm audit. It parses sign-in responses and includes generated
agent collection schemas. A Zod 4 contract/generator migration and consumer tests
remain required before declaring that advisory remediated; passing builds do not
clear it.

The refreshed audit reports **1 high and 12 moderate package records**, spanning
four advisory families. The other families are
[Hono static middleware bypass](https://github.com/advisories/GHSA-rmxm-3fg6-px4f),
[minimatch pattern amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249),
and [glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
The installed Hono adapter is used by Prisma development tooling; repository code
does not import its `serveStatic`. Minimatch/glob reach CDK, Codegen and Prisma
tooling, with repository-authored patterns. These are still dependency findings:
do not expose the tooling to untrusted patterns or treat cancellation as an I/O
budget. Published fixes cross major dependency boundaries, including CDK's bundled
copy, so they need targeted compatibility work rather than `audit fix --force`.

The browser-contract package declares ESM and retains TypeScript's NodeNext resolution.
Its source and generated contract imports include explicit extensions, and Vite's authored
config imports do too. The default and native configuration-loader builds now run
without the earlier CommonJS/ESM or ambiguous-import warnings. This changes module
metadata, not the generated route values or payload schemas.

Validation of the October 20 dependency update:

| Audit | Before | After |
| --- | --- | --- |
| All workspaces | 35 high, 2 moderate | 10 high, 0 moderate (the unpatched braces chain above) |
| `npm audit --omit=dev` | 4 high, 4 moderate | 0 |

The clean `npm ci --strict-allow-scripts` preserves the lockfile byte for byte;
`npm ls --all` succeeds and `npm install-scripts ls` has no pending reviews.
Registry metadata was restored for 478 existing entries with npm 11's registry
client and lockfile writer, without changing those entries' versions. The lockfile
check now also rejects missing registry URLs/integrity hashes. All supported native
platform entries remain present. The macOS fsevents watcher was exercised without
a rebuild, and esbuild/workerd binaries run successfully.

All workspace builds, 453 framework tests, 22 executable GraphQL schema tests, and
65 client tests pass. Typography's 33 variants and 29 component groups, plus client
and WebSocket tester CSS output, match their pre-update output. Offline dev/prod
synthesis preserves resource logical IDs/types and output names across the CDK
upgrade; the updated CLI reads both assemblies. Asset bundling was skipped in
these synthesis comparisons. Live AWS, database, Docker-image and browser checks
are separate and were not performed.

At the time, `npm run verify` stopped at `framework-studio/test/landscape.test.ts:420`
(a fixture omitting `Lanes.deploy`, `origin` and `cloud`), and the full workspace run
had seven Studio failures. None was a dependency regression; each depended on the
machine running it, and each is now fixed so the result is the same on any machine:

- `deploy-orphans`: Compose plugin discovery also found this machine's Docker
  Desktop install. The system plugin directories are now a parameter the test sets.
- `deploy-prereqs`: npm discovery missed Homebrew's layout, where `bin/npm` beside
  Node links to npm installed elsewhere. This also affected Studio launched without
  `npm run`; `npmCli` now follows that link.
- `deploy-service`: the simulated Docker named its Compose project after one
  checkout's directory. It now uses the project Studio derives for the checkout.
- `deployment-inputs`: `util.parseEnv` returns a null-prototype object on Node 26.
  The test compares contents.
- `hover` (two tests): the labels encoded one machine's `DEPLOY_PROD_WEBSOCKET_API`
  values in its ignored `cdk-app/.env.dev` and `.env.prod`. The tests now pin those
  lanes, and a separate test checks each environment follows its own file.
- `landscape`: the WebSocket role badge gained the managed border on purpose; the
  assertion still expected no WebSocket entry. It now checks the documented badge.

The two AgentCore test failures introduced by resolving a newer Zod minor are fixed by
the compatibility override above.

### Line endings (Windows and macOS)

`.gitattributes` checks every text file out with LF on every platform. Git for Windows
otherwise writes CRLF, and a bundled Lambda's source map embeds its source, so the same
commit built on Windows and on macOS gets different asset hashes and each deploy from the
other machine updates those Lambdas for nothing. A Windows checkout made before the file
existed keeps its CRLF files until they are rewritten. With a clean working tree, run once:

```powershell
git rm -rq --cached .
git reset --hard HEAD
git ls-files --eol   # every text file should show w/lf
```

## Start development

The shortest path is Framework Studio (`npm run studio`). Choose a Development AWS
profile in the Source selector and deploy its resources from **Deploy**. On the map,
**Local runtime** becomes available after AWS confirms a fully completed, compatible
development deployment. It is hidden before development stacks exist; an incomplete
observed deployment keeps it disabled with a prerequisite explained through **Details**.
Turn it on: Studio verifies the exact development destination and its
compatibility and exports its current outputs. **Generate source projections** runs
before **Prepare local database**, which builds the database image and starts only PostgreSQL and its
`prisma-verify` prerequisite. That service runs `db:prepare-local`: a proven empty local
database is initialized from the saved contract, then storage is verified. Existing storage
is only verified. Studio waits for preparation to finish before
building and starting the other containers (`npm run dev:containers -- --detach`), then runs the source watch
(`docker compose watch --no-up`) and web client for you. If Docker is stopped, the
toggle offers a separate **Start Docker Desktop** action; starting Docker leaves
application startup for your next toggle activation.

Activity shows startup steps and logs. The switch reports **Running** only after
container and client readiness checks pass. Every start regenerates root `.env`, the
local resource manifest and the development client environment from that verified
deployment; authored inputs stay in `cdk-app/.env.dev`. A failed startup can leave
containers running; the switch stays on with **Needs attention** until you turn it off,
preserving containers and data. A running runtime also needs attention when a database
input — `package.json` (scripts excepted), `package-lock.json`, `packages/database/package.json`,
the Prisma config and its imports, the contract or migration history — changed after
`prisma-verify` checked storage. Details names the changed files and offers **Restart runtime**,
which rebuilds images and reverifies storage in one step. Containers built before files
were recorded individually show a generic message and also count root script edits. The
runtime belongs to this checkout, so changing AWS profiles never silently retargets
running services or changes their local readiness. The existing checkout operations host
keeps containers, source watcher, web client and log capture attached when Studio closes
or restarts. Reopening Studio discovers that same environment; if support processes are
missing, it reconnects only those components after local ownership/readiness checks.
Recovery needs no selected AWS profile or valid AWS credentials and performs no exports,
container rebuilds/recreation or database changes. Details shows container, watcher and
client status; failed recovery offers **Retry recovery**. An intentional stop is persisted
and remains stopped across reloads and restarts. Deploy's existing local actions remain available. See
[Deploy & Run](framework-studio/deploy-and-run.md).

A fresh clone can use an existing compatible development deployment: choose its AWS
profile for Development and start local runtime. Missing generated settings are normal;
startup exports them automatically, without a separate export or redeployment. Studio
creates missing CDK input files from templates, so custom private inputs from another
machine still need their own secure transfer or configuration.

Deploy's **Client environment** panel describes how
`framework-config/client-environment.ts` maps public deployment outputs and selected
`cdk-app/.env.dev` inputs into `client-app/.env.development.local`.
**Generate .env file** runs that export separately, including root Compose settings and the
local resource manifest. **Start development** automatically regenerates all three
before any Compose startup, so you can start directly from **Ready to run locally**.

Keep editing local code while the runtime runs. You can also synthesize and review
infrastructure changes then. Before deploying a new dev stack, applying a dev plan,
refreshing exported settings or destroying development resources, stop local runtime.
Deploy shows **Stop local runtime** beside blocked actions and reenables them after
shutdown is confirmed. It never stops services or deploys as a side effect of editing
or reviewing. After deployment, turn local runtime on to regenerate settings and run
against the new outputs. Destroy uses its separate typed confirmation after shutdown;
generated files alone cannot enable runtime after AWS resources are gone.

From the command line, in one root terminal:

```powershell
npm run dev:containers
```

In another:

```powershell
npm run dev:client
```

`npm run dev:containers` runs `docker compose up --build --watch`; `npm run dev:client` is the Vite dev server.
Set `LOCAL_DEV_URL` in **CDK environment → Deployment settings → Development** to
choose the frontend URL and port, for example `http://localhost:3100`. Both Studio's
web client and `npm run dev:client` use that port; blank or missing values default to
`http://localhost:3000`. Vite fails if the port is occupied. Restart local runtime after
changing it to refresh the local browser allowlist. Updating Cognito's sign-in callback
URLs requires a separate development deployment.

`npm run dev:containers -- --detach` starts the same stack in the background and returns
(watch it with `docker compose watch --no-up`; stop it with `docker compose stop`).
It uses the AWS `default` profile unless you pass a profile for this run or set
`AWS_PROFILE` in the shell:

```powershell
npm run dev:containers -- --profile=<PROFILE>
```

With npm 11, `npm run dev:containers --profile=<PROFILE>` also works, but npm warns about
the unknown npm config option. The `--` form passes the flag directly to the
dev script. Use the same profile for deployment and local execution when they
must access the same AWS account.

Compose runs postgres, local database preparation, the local API/WebSocket servers, invocation runner,
the declared services (generated into docker-compose.services.yml; see
[Framework](FRAMEWORK.md#local-service-containers)), WebSocket tester, and pgAdmin. Postgres and pgAdmin listen on 127.0.0.1 only.
Each Node Lambda you call keeps a warm process for its next call, as a warm Lambda does, up
to LOCAL_LAMBDA_WARM_MAX processes, each stopped after LOCAL_LAMBDA_WARM_IDLE_SECONDS idle;
set LOCAL_LAMBDA_WARM=false in cdk-app/.env.dev to start every call cold. See
[Framework](FRAMEWORK.md#local-resource-delivery). Services use the framework launcher, so adding
a resource environment reference or secret requires no Compose interpolation change. The
`prisma-verify` prerequisite retains its service name but now runs `db:prepare-local`.
On a fresh volume it checks complete metadata emptiness, absent markers and an empty
migration ledger, then creates the saved schema with Prisma's additive initialization.
Those checks repeat inside the locked writer transaction before DDL. An existing signed
database is verified without writes. Repeated starts preserve existing records and never
apply migration packages, delete users or change Cognito.

Unknown populated databases, pending migrations and schema drift block consumers while
PostgreSQL stays available: open Studio **Database > Database status**, inspect Local
PostgreSQL, and separately review the reported issue or authorize its pending migration.
Activity's failed **Prepare local database** step offers **Review local database**, which
opens Database status without inspecting or changing storage automatically; older
**Verify local database** records retain the same recovery link. Startup reports the
database cause instead of only Compose's prerequisite wrapper. It never adopts, resets
or signs an unknown populated database. Restart local compute after a reviewed database
action. See [Database](DATABASE.md#local-database).
The React client runs separately. Studio checks container health and the client's HTTP
response before reporting readiness; a process launch alone is not application success.
Use the configured LOCAL_DEV_URL and host ports rather than assuming defaults.

The image owns Linux dependencies and generated database artifacts. Only postgres_data
is a persistent data volume. Do not mount host node_modules or the whole checkout over
image-owned dependencies. Only the invocation runner gets the Docker socket.

### Parallel checkouts

Developers on different machines have independent Docker volumes. Multiple clones or
Git worktrees on the same Docker host also need distinct Compose project names and
published host ports. A matching checkout directory name is not ownership evidence:
Studio and development startup refuse containers owned by another checkout instead of stopping
or adopting them.

The app name at the top of Studio (`framework:app` in `cdk-app/cdk.json`) controls
Compose directly. `COMPOSE_PROJECT_NAME` is generated during export, not an authored
input; stale shell or env-file assignments do not override a named app. Stop the
current local runtime before renaming the app. Choose a stable, unique app name such
as `aws-studio-alex-feature`, then export/start development. Keep that name when returning to the same local database.
Changing the project name selects another namespaced `postgres_data` volume and leaves
the old volume intact. It does not transfer its records.

For a second checkout, choose its unique app name in Studio or `cdk-app/cdk.json`.
Studio reads that name even before the first export. Use a separate Studio port:

```powershell
npm run studio -- --port 4591
```

Foreign container provenance remains blocked; an explicit project name does not move or
stop the other checkout. Legacy volumes do not record a checkout path, so use unique
project names from the first start, including concurrent first starts. Runner-only orphan
containers without Compose provenance require inspection and stopping their exact IDs in
Docker before Studio can confirm shutdown.

Choose distinct `POSTGRES_HOST_PORT`, `LOCAL_API_DEV_SERVER_HOST_PORT`,
`LOCAL_WS_DEV_SERVER_HOST_PORT`, `LOCAL_INVOCATION_RUNNER_HOST_PORT` and
`PGADMIN_HOST_PORT` values for simultaneous runtimes. Host web clients and Studio servers
also need distinct ports; use `LOCAL_DEV_URL` and Studio's `--port`/`STUDIO_URL` settings
described above. Keep the existing sign-in callback configuration compatible with the
frontend URL. Exported settings, Studio observations, stop operations and runner networking
must use the same project name as Docker Compose.

After pulling changed workspace manifests or a lockfile, run `npm ci` and restart Studio
to refresh its host tooling. After a teammate's database change, restart local runtime to
rebuild its images and rerun storage preparation. A valid older database needs a reviewed forward migration;
an older source checkout must use compatible storage or its own project/volume. Legal
side branches do not block a unique route, while competing routes and physical drift
require investigation. If PostgreSQL was restarted/recreated or database source/history
changed after its last check, Studio shows **Needs attention** with a restart remedy even
when the application containers still answer health checks. See the
[development database cases](DATABASE.md#development-with-teammates-and-branches).

## What to do after an edit

| Change | Action |
| --- | --- |
| Ordinary handler/service/client source | Keep Watch and the client dev server running; the owning process reloads |
| Task/container Lambda source or Dockerfile | Watch delivers it to the runner; the next invocation builds it |
| Framework config or runner/framework source | Watch restarts affected processes; in-flight local work may stop |
| A service added, removed, or given another port or healthCheckPath; `x-framework-service` | Restart `npm run dev:containers`: it regenerates docker-compose.services.yml first |
| Manifests, lockfile, node_modules/aws-studio/dev/Dockerfile, ignore rules, deleted files while Watch was off | Rebuild and restart with `npm run dev:containers` |
| A captured event whose handler failed every replay | Fix the handler, then `npm run replay:redrive` (`npm run replay:list` shows what is waiting) |
| A Deploy condition selector in `.env.dev` | Restart `npm run dev:containers`; Compose Watch excludes input files |
| Ports, outputs, local secrets | Edit cdk-app/.env.dev, then stop/start Local runtime in Studio to regenerate settings and recreate containers; the CLI equivalent is export followed by container recreation |
| Local AWS profile | Restart with `npm run dev:containers -- --profile=<PROFILE>`; deploy that account's dev graph first if needed |
| Database contract | Follow Database planning/application steps and rebuild; Watch does not regenerate it |
| AWS event handler, Cognito, or infrastructure | Redeploy the dev graph, then re-export changed outputs |

A service's production Dockerfile is separate from node_modules/aws-studio/dev/Dockerfile. Compose uses the
shared development image; the invocation runner uses a task's own Dockerfile when it runs.
Concurrent submissions may share a build, but each run gets its own container/input.

## Verification and troubleshooting

If Studio reports an initial evaluation failure, inspect the terminal and repair the
reported source or filesystem problem before restarting `npm run studio`. The original
Windows failure was coordination SQLite creation with synthetic POSIX modes and a
foreign/Administrators owner: Windows requires a real current-user owner and native
private DACL. Never fix loading by deleting `.cache/` or `.framework/`; they contain
source journals, approvals and deployment recovery evidence. Unsupported elevated startup
now fails before initialization. Linked/junction state paths, foreign-owned files and
replaced coordination databases fail closed; inspect and repair the exact path/ownership
from a normal terminal, preserving its contents. Source syntax errors retain a labeled
last-good graph and disable edits until corrected. A first snapshot infrastructure failure
returns an explicit error instead of continuing to claim evaluation is running.
Unexpected later refresh failures also notify the browser and show an error while
retaining its mounted editor and pending draft.


Set `LOCAL_TEST_USER_EMAIL` and `LOCAL_TEST_USER_PASSWORD` in ignored `cdk-app/.env.dev`.
Setting these inputs and starting compute do not create or modify any account. After
verifying the intended development pool/profile and authorizing its AWS/local database
writes, run `docker compose --profile identity-setup run --rm seed-test-user`.
This explicit action creates the user in the dev pool if it is missing, with the email marked verified
and no invitation sent, sets its password to `LOCAL_TEST_USER_PASSWORD`, and writes
its local users row. An existing row is kept, with any name edited in the app. The
password must meet the pool's policy (12 characters). It runs only for the pool a
development export wrote to root `.env` (`LOCAL_FRAMEWORK_DEPLOYMENT`, which a production
export never writes); without both settings, or if Cognito rejects a call,
the command reports the problem and changes nothing. Sign in as
this user in the browser or headlessly. Use an address you control: the account is
marked verified, so a password reset mails a code there.
These are local CLI credentials, not workload environment variables or deployment
secrets. Never set them for a production deployment or commit their values.

```sh
npm run dev:request -- POST /graphql '{"query":"{ currentUser { id email } }"}'
```

The helper refuses production mode, signs in through the existing `/sign-in`
route with the configured frontend origin, and uses the returned ID token for
one request to the local API. It prints the status and route response, without
printing the sign-in token or password. Expect HTTP 200 with the current user
from GraphQL. For an application task starter, check the task's terminal exit
code separately from submission acceptance. Use the helper to verify authenticated routes and GraphQL headlessly.
The same dedicated user can sign in through browser automation to check the UI;
headless requests do not replace browser verification.

```powershell
npm --workspace client-app run build
npm run verify
docker compose ps
docker compose logs -f local-api-dev-server local-invocation-runner
```

Verification has four lanes:

| Lane | Command | Needs |
| --- | --- | --- |
| Offline | `npm run verify`: lockfile, generated artifacts, every workspace typecheck (including the root `scripts/`), all test suites, independent Contract Chain proof gate | Supported Node 24/npm 11, installed dependencies and explicit current contract reviews. No AWS, Docker, database, browser or ignored inputs file: AWS, the CDK CLI and Docker are simulated (`FRAMEWORK_AWS_CLI`, `FRAMEWORK_CDK_CLI`, `FRAMEWORK_DOCKER_CLI`) |
| Integration (part of Offline) | The same run: `deploy:resources` plan/apply/discard as real processes against the simulated account, Studio's deploy service driving them, evaluator processes, invocation-runner child processes | As above |
| Disposable PostgreSQL | Set `FRAMEWORK_LOCAL_DATABASE_TEST=1`, then run `node --import tsx --test packages/aws-studio/database/test/local-startup-live.test.ts`; also runs in the dedicated CI database job | Docker and `postgres:16`; creates its own labeled container and checks empty startup, repeated startup, retained rows and unsafe-state refusals without opening the ordinary project database |
| Acceptance | Synthesis in both modes, `npm run dev:containers` with the browser checks below, a reviewed plan and apply against a development account, migrations | Docker, AWS credentials, a database; run by hand for the change being made |

A test in the offline lanes must not read this machine's state: ignored inputs files,
an installed Docker, the checkout's directory name, or where Node keeps npm.

The offline gate does not verify credentials, container startup, or live migrations.
Its final `contract:check` independently reruns declared contract checks and refuses stale
or missing accepted proof; it cannot approve application decisions. Use the CI-pinned
Node 24.22.2 for reproducible receipt identities and follow
[explicit review renewal](DATA-FEATURES.md) for a legacy or changed contract.
After startup, sign in, list/create/archive/delete a Project, reload the page, and check
that the expected changes persist. Use the framework's [invocation verification](FRAMEWORK.md#verifying-task-and-workflow-invocation)
when changing tasks or workflows.

| Symptom | Check |
| --- | --- |
| Source appears unchanged | Watch must remain attached. Inspect the file with `docker compose exec <service> cat <path>`; rebuild if stale |
| Port conflict | Change the host port in cdk-app/.env.dev, export, and recreate; container ports are fixed |
| Auth endpoints return Forbidden origin | Re-export LOCAL_BROWSER_ORIGINS and recreate containers; use the frontend's /api proxy |
| Service returns 502 | The route exists but its upstream is unavailable; inspect that service's startup logs |
| Missing table/column | Check the selected database and reviewed migrations; generation alone changes no tables |
| "A user already exists ... with a different Cognito identity" | The local row may predate the dev pool. Inspect users and their owned data before separately authorizing orphan cleanup; restarting compute never deletes them. See Database's cleanup consequences |
| Google redirect fails on a LAN HTTP origin | Hosted UI needs HTTPS except loopback; use localhost or configured HTTPS |
| Prisma config missing during image installation | Use the current node_modules/aws-studio/dev/Dockerfile, which defers root generation until its inputs exist |

`docker compose watch --no-up` attaches Watch to an already current stack. A running
container cannot reload a file that was never synchronized. Rebuild after edits/deletions
made while Watch was stopped when the image and checkout may disagree.

In Studio, open Activity → **Container logs** for the combined live container output
that an attached `docker compose up --build --watch` shows in a terminal. **Source watch**
shows synchronization/rebuild activity, and **Web client** shows Vite output. Container
logs retains service prefixes; use **Filter log** to find a service or invocation. A
successful local retry clears its earlier startup alert from the closed Activity bar,
while retaining that attempt and its log in history.

For resource-specific evidence, select a resource on the map or in **Resources** and
expand **Logs**. Development capture belongs to the local runtime and continues while
Studio is closed. Private bounded history survives Studio and runtime restarts; run and
deployment bindings remain attached to historical entries. Production shows a placeholder
only. [Development resource logs](framework-studio/development-logs.md) describes capture
coverage, startup diagnostics, retention, privacy and Sightline's bounded excerpts.

## Stop and reset

Use `docker compose stop` to stop or `docker compose down` to remove containers/networks.
The runner removes the task/container-Lambda containers it owns. Local run history is
in memory and is lost on runner restart; cached diagnostic evidence survives but does not
recover execution. Keep the same Compose project name to reuse
postgres_data. Do not use `down --volumes` during routine updates.

Local persistence and AWS retention are independent. Recreating application
containers with that same volume preserves rows; changed project/volume identity,
missing schema and connection failures require explicit diagnosis. AWS teardown
records exact retained identities under `.framework/retained-resources` and refuses
unsafe retained dependency deletion. Preserve that evidence with the checkout;
retention alone does not establish a working recovered application.

A deliberate database reset requires stopping the project, identifying its exact
postgres_data volume, and removing that volume. This deletes local application data;
it is separate from rebuilding dependencies. AWS teardown is documented in
[Production](PROD-DEPLOYMENT.md#teardown), using the dev mode and account instead.

### Local images

Images are cleaned up automatically. Nothing is removed with force, so an image any
container uses, running or stopped, is kept until a later pass:

| Images | Named | Removed |
| --- | --- | --- |
| Compose development images | `<project>-<service>:latest`, labelled `com.docker.compose.project`/`service` | By `npm run dev:containers` before it starts Compose: untagged images an earlier `--build` replaced, and images of services docker-compose.yml no longer declares. The previous start's images remain until the next start |
| Task images | `matts-framework-task-<id>:<arch>` | By the runner after each build and at startup: the image a build replaced, an architecture no longer declared, a task no longer declared |
| Container-Lambda images | `matts-framework-<id>:<source hash>-<arch>` | By the runner after each build and at startup: every source hash but the current one, and Lambdas no longer declared or no longer container-packaged |

Runner images carry `com.matts-aws-framework.kind` (`task` or `lambda`), `.project` and
`.target`, so `docker image ls --filter label=com.matts-aws-framework.target=<id>` finds a
workload's image. The runner touches only images labelled with its own Compose project.
Older container-Lambda images without project labels are preserved because their
ownership cannot be proved. Inspect their labels and container references before any
manual removal. `--remove-orphans` removes containers of services removed from the file.
Build cache is left to Docker's builder garbage collection (`docker builder prune` reclaims
it by hand). Checkouts with the same directory name share one Compose project, and with it
these images, container names and postgres_data.

`LocalLambdaExecutor.close()` cancels its active calls, including cold-only Node
handlers. `LambdaWorkerPool.close()` cancels warm and concurrent overflow handlers;
both reject new invocations after closing. Handler processes also exit when the
parent IPC channel disconnects. Closing compute does not remove images or storage.

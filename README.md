# AWS Studio

AWS Studio is a source-linked editor and operations interface for TypeScript applications
on AWS. The `aws-studio` release contains the framework, CDK constructs, local runtime
servers and command-line tools. Applications declare the resources and workloads that
Studio shows and that the framework runs.

The starter repository includes a reference app with its own source and lockfile. An app installs its declared `aws-studio` release from the vendored archive.
Studio opens a single selected app and uses its physical release to evaluate declarations.
The platform checkout contains Studio and the release source.

![Studio, framework, starter repository, and independent app with separate Node runtimes](framework-overview.svg)

[Product and architecture overview](docs/AWS-STUDIO.md) · [Documentation](docs/README.md) · [Knowledge router](docs/aws-studio-knowledge/README.md)

## Install and open Studio

Install Node.js with npm and extract the Studio distribution anywhere you like.
From the extracted `aws-studio` directory, open a project with its dependencies
already installed:

```sh
npm run studio "../projects/my-app"
```

The path can be absolute or relative to where you ran the command. Quote paths
with spaces. On npm 11, `npm run studio --project "../projects/my-app"` also works
and may print npm’s unknown-option warning. To pass additional Studio options,
use the npm separator, for example `npm run studio -- --project "../projects/my-app" --print`.

Studio installs its locked dependencies on the first launch. It locates the
Studio and project toolchains independently and downloads a missing supported
Node/npm pair into a user cache. The first launch may need internet access.
Use the loopback URL printed by Studio. To update, extract the next distribution
in its own directory and launch it against the same project. Keep the previous
installation for reopening projects in its compatibility window.

### Create an independent project

From the installed Studio directory, supply a new project directory whose
parent already exists. Studio copies the bundled starter, installs its locked
dependencies and initializes its Git repository.

```sh
npm run studio -- --create-project "../projects/my-app"
```

Create private deployment inputs from **CDK environment files** when a target
needs them. Review dependency and source changes together when adopting a feature
that requires a framework upgrade.

## Run Studio from source

From the source checkout, run the same command against an existing project:

```sh
npm run studio "../projects/my-app"
```

Studio prepares the checkout’s locked host dependencies on first launch.
On Windows, use an unelevated terminal and local NTFS checkouts. Source review
and architecture inspection work without AWS credentials or Docker.

[Quick Start](QUICKSTART.md) · [Supported development hosts](docs/DEV-DEPLOYMENT.md#supported-development-hosts)

## Work on an application

Run application commands from the opened application's root. The app owns
`framework.config.ts`, its CDK entry point, workloads, database schema and client.
Read its `AGENTS.md` and the guides under `node_modules/aws-studio/docs/`. The latest
source copies of those guides cover framework declarations, development,
production deployment and typed data features. [Documentation index](docs/README.md)

Studio saves reviewed changes in the selected app. The app's private inputs and
operational state stay with it, including the `.cache/framework-studio/` state
directory. AWS operations require authorization and an AWS profile for the target.
Local application compute uses Docker with Linux containers.

## Work on Studio and the release

| Location | Responsibility |
| --- | --- |
| `client-app/` | Studio UI, local host, source inspection and operational controls |
| `packages/aws-studio/` | Release source, public exports, generic CDK, runtime servers and CLI |
| `scripts/` | Release packaging, test starter selection, dependency bootstrap and lockfile checks |
| `docs/` | Product documentation, package guides and linked source evidence |

```sh
npm run build
npm run verify
npm run pack
```

To build both distributables for Studio 1.0.0, use the source Node/npm pair to
pack the framework and the Studio host pair to pack the installation. Use a new
output directory for each build.

```sh
SOURCE_NODE_BIN=/path/to/node-v24.22.2/bin
STUDIO_NODE_BIN=/path/to/node-v26.13.0/bin
RELEASE_OUT="$(mktemp -d)"
PATH="$SOURCE_NODE_BIN:$PATH" "$SOURCE_NODE_BIN/npm" run pack -- "$RELEASE_OUT"
PATH="$STUDIO_NODE_BIN:$PATH" "$STUDIO_NODE_BIN/npm" run pack:studio -- \
  "$RELEASE_OUT" "$RELEASE_OUT/aws-studio-1.0.0.tgz"
```

The Studio distribution records the version and digest of its bundled framework
and CLI. [Release qualification](docs/aws-studio-knowledge/guides/verification-and-maintenance.md#qualify-studio-and-framework-releases)

Platform integration tests prepare the recorded starter with a physical development
release and use an isolated copy when a test changes app source or state. Run app
generation, deployment and Contract Chain commands inside an independently installed
app. A pending Contract Chain result requires explicit review, and verification
preserves all receipts. Release and fixture checks work offline.

For development verification and release packaging, use a local
[starter catalog](https://github.com/drmatt13/aws-studio-starter-projects) with the
commit in `scripts/starters.json`. Follow the verification guide to prepare the
recorded fixture and install the platform dependencies with the workspace pins.

[Repository map](docs/aws-studio-knowledge/REPOSITORY-MAP.md) · [Verification and maintenance](docs/aws-studio-knowledge/guides/verification-and-maintenance.md)

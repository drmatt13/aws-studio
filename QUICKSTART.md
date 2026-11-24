# Quick Start

The AWS Studio 1.0.0 distribution runs on Node 26.13.0 with npm 11.20.0. The
reference starter uses Framework 1.0.0 on Node 24.22.2 with npm 11.19.1.
Framework 1.0.0 requires Studio 1.0.0 or newer.
[Install and update Studio](README.md#install-and-open-studio)

## Create a project

From an installed distribution, choose a new or empty directory outside Studio.
Use a lowercase name with letters, digits, and internal hyphens. Studio copies
its pinned starter, assigns a new deployment identity, installs the project's
locked dependencies, initializes a Git repository, and opens the project.
Configure the production destination separately for that app.

```sh
mkdir -p /path/to/projects
AWS_STUDIO_PROJECT_NODE=/path/to/node-v24.22.2/bin/node \
  /path/to/node-v26.13.0/bin/node /path/to/studio/aws-studio/scripts/studio.mjs \
  --create-project /path/to/projects/my-app
```

Add `--name my-app` when choosing a different app and package name. First-time
offline installation requires the starter's locked packages in the npm cache.

## Open a local project

Install the selected application's pinned dependencies from its own directory:

```sh
PROJECT_NODE_BIN=/path/to/node-v24.22.2/bin
PATH="$PROJECT_NODE_BIN:$PATH" "$PROJECT_NODE_BIN/npm" ci --offline --no-audit --no-fund
```

From the Studio installation, open the independently installed app:

```sh
AWS_STUDIO_PROJECT_NODE=/path/to/node-v24.22.2/bin/node \
  /path/to/node-v26.13.0/bin/node scripts/studio.mjs --project /path/to/projects/my-app
```

Open the printed loopback URL. Select **Development** or **Production** and inspect
workloads, resources and their source. Reviewed changes save to the selected
project. Concurrent source changes expire reviews. Preserve the project's
`.cache/framework-studio/` directory when inspecting interrupted work.

## Adopt a framework capability

Use the creator and review its source diff. For an HTTP Lambda, choose **GET**
and **Also register HEAD** to route both methods to one handler. **Use existing
code** can register a developer-owned handler. Studio includes the framework
archive, pin and lockfile in the same review when the project needs the upgrade.
Use **Review framework upgrade** from the app name to review the bundled release
explicitly. Ordinary compatible edits keep the current pin. Commit the reviewed
files with the new vendored archive so another clone can install the same release.
Studio extends the starter's exact Git ignore exception for a new framework.

If an installation is interrupted, run the Studio launcher with
`--project /path/to/projects/my-app --recover-upgrade` and follow its recovery
result before reopening. Add `--status` to inspect the journal without attempting
recovery. If recovery reports conflicting external changes and you decide to
retain the current files, use `--keep-current <id> <fingerprint>` with the values
from `--status`. Verify the retained installation and source before resuming work.
Keep the previous Studio distribution available for the saved project revision.

## Select a profile and review operations

Use **AWS profiles** to select the intended account and region, then use **CDK
environment files** to prepare the selected project's private inputs. Studio keeps
credentials in their native stores. AWS CLI v2 and account access are required for
AWS operations. [AWS connections](docs/framework-studio/aws-connections.md)

In **Deploy**, choose the intended target and profile. Review the plan and provide
the required authorization before applying. Cloud planning can read AWS and may
create review artifacts. Inspect any interrupted or uncertain operation before a
retry. [Planning and safety](docs/aws-studio-knowledge/deployment/planning-and-safety.md)

## Run the local app

Use **Start development** after completing the project's development prerequisites.
Local compute requires Docker with Linux containers and Compose Watch. Studio
coordinates the supported application services, and the database preflight
initializes proven empty local PostgreSQL storage. Review pending migrations in
**Database** and use **Activity** to inspect operations.
[Development](docs/DEV-DEPLOYMENT.md#start-development)

Run build, code generation and application verification from the app root. For
platform changes, use `npm run build` and `npm run verify` from the platform root.
[Platform verification](docs/aws-studio-knowledge/guides/verification-and-maintenance.md)

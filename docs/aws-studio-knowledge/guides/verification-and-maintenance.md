---
id: guides.maintenance
summary: Targeted verification, documentation schema/checks, and contract-driven maintenance.
read_when:
  - Choosing checks or updating architectural knowledge after implementation changes
source:
  - AGENTS.md
  - package.json
  - client-app/package.json
  - scripts/pack-studio.ts
  - scripts/verify-studio-distribution.mjs
  - docs/aws-studio-knowledge/check.mjs
related:
  - reference.invariants
  - reference.capabilities
  - guides.retrieval
---
# Verification and knowledge maintenance

Build Studio and run `npm run verify` from the platform checkout. The platform
uses the starter commit in `scripts/starters.json`. Before a clean install,
set `AWS_STUDIO_STARTERS` to the local starter Git repository and run
`node scripts/bootstrap-test-peer.mjs` with the pinned Node and npm 11
toolchain. Tests that edit app source, state or dependencies use an isolated
copy of the prepared starter. [Working rules](../../../AGENTS.md)

In an installed app, run its application verification for generated contracts,
database output, schema and pending review state. Synthesis, browser checks,
Docker and live AWS/database integration have their own verification commands.


| Change | Focused checks / additional evidence |
| --- | --- |
| Studio fields/transactions/creation | `node --conditions=development --import tsx --test client-app/test/plan.test.ts client-app/test/transaction.test.ts client-app/test/draft.test.ts client-app/test/creation.test.ts`; add relevant refusal/rollback fixtures |
| Graph/rendering | Studio model/layout/landscape/labels/hover tests; actual browser resize/zoom/picking and representative timing measurements |
| Workflow/agent | Framework workflow/agent contract, compiler/interpreter tests; runner engine/agent E2E; live service behavior requires separate authorized evidence |
| Infrastructure/resource/identity | Relevant platform `packages/aws-studio/test/cdk/` and app-owned CDK tests. From the selected app, synth **both explicit dev/prod modes** using [Framework's procedure](../../FRAMEWORK.md#generated-contracts-and-verification), compare logical IDs for identity-sensitive moves. `npm run infrastructure:identity -- capture --mode dev\|prod [--bundling] --out <file>` synthesizes offline from cached context without credentials and `compare` reports identity (stacks, logical IDs, types, exports, dependencies, tags), property and asset changes separately; captures always write to `.cache/infrastructure-assembly-<mode>` because bundle sourcemaps make asset hashes depend on the output location |
| Deployment/secret review | Fake AWS/CDK plan/apply/guard/secret-review suites; reject stale/mismatched input before writes. No real deployment just to test a source edit |
| Application data/auth | Follow [data automation](../../playbooks/typed-contract-propagation.md) / [auth checklist](../../playbooks/auth.md). Build client before typecheck for changed routes. Migration planning is offline; application requires separate authorization |
| This wiki | `node docs/aws-studio-knowledge/check.mjs`; checker regression fixtures: `node docs/aws-studio-knowledge/check.mjs --self-test` |

For a documentation-only discovery pass, explicit task instructions may call for targeted
link/source/diagram checks and browser inspection instead of expensive application suites.
Record that scope rather than claiming `verify` passed. Code changes still follow the
repository gates above.

For a single test command run from the repository root, preserve workspace conditions (`--conditions=development --import tsx`). When failures appear in a changing checkout, report the actual failure and working-tree context; don't restore unrelated source to make verification pass.

## Qualify Studio and framework releases

Set Studio's version in the root `package.json`. From the Studio checkout,
`npm version patch --no-git-tag-version` updates the version and lockfile together.
The packer reads that version and records it in the installed package. Set the
bundled framework version and host runtime in `scripts/studio-release.json`.
When changing a managed Node pin, update `scripts/studio-node-archives.json` using
the digests published with that Node.js release. First-launch provisioning checks
the pinned archive digest before extracting and activating the runtime.
The framework package declares its own version,
runtime ranges, minimum Studio release, evaluator protocol and creator capabilities.
Retain the exact framework archive when releasing a Studio-only change.
`npm run pack:studio -- <destination> <retained-framework-archive>` packages that
artifact in the new Studio distribution. [Independent release decision](../architecture/decisions.md#adr-010--evolve-studio-and-projects-independently)

| Release | Studio toolchain | Reference application toolchain |
| --- | --- | --- |
| Studio 1.0.0 with Framework 1.0.0 | Node 26.13.0 and npm 11.20.0 | Node 24.22.2 and npm 11.19.1 |

Framework 1.0.0 requires Studio 1.0.0 or newer and supports the
`http-get-with-head` capability. Qualify an actual artifact on each intended
native host and runtime pair before advertising support. A source workspace
verification and a packaged native-host smoke establish different results.

Use a populated, writable npm cache for the intended host and two independent
Node installations with npm beside each executable. Pass a new evidence
directory whose parent exists.

```sh
npm_config_cache=/path/to/npm-cache /path/to/node26/bin/node scripts/verify-studio-distribution.mjs \
  /path/to/aws-studio-1.0.0-distribution.tar.gz /path/to/node26/bin/node \
  /path/to/node24/bin/node /path/to/new-smoke-directory
```

On Windows set `$env:npm_config_cache`, use the corresponding `node.exe` paths
and run in an unelevated terminal with a user-owned NTFS directory. The smoke
installs Studio and a new app offline, records toolchain paths and versions,
verifies the embedded framework pin, and compares protected file digests before
and after reopening Development and Production. Keep its `evidence.jsonl`
with the archive SHA-256 digests and the exact starter commit. Record native or
emulated execution explicitly.

The [platform verification workflow](../../../.github/workflows/verify.yml)
checks lockfile metadata and documentation. The native and PostgreSQL jobs
read the starter repository and exact commit in `scripts/starters.json` before
preparing the app fixture and warming its npm cache. Keep the oldest eligible
Studio distribution, framework archive and starter commit when adding a
cohort. Use small fixtures for missing, partial, complete and ambiguous
prerequisites. Retire a cohort after documenting the last compatible
installation and a verified upgrade path.

### Two-release development qualification

The two-release qualifier exercises a specific mixed-runtime feature-adoption
fixture. It expects a historical Studio installation on Node 24, a candidate
Studio installation on Node 26 with a separate Studio and framework version,
and an embedded starter pinned to the historical framework. Use this fixture
for testing an eligible lockfile change, reviewed dependency activation,
compatible reopen, minimum Studio refusal and rollback to the saved version.
Use the single-release smoke above for the public 1.0.0 baseline.

When the two fixture distributions and recorded digests are available, run:

```sh
npm_config_cache=/path/to/npm-cache /path/to/node26/bin/node scripts/qualify-retained-cohorts.mjs \
  /path/to/older-fixture-distribution.tar.gz "$OLD_STUDIO_SHA256" \
  /path/to/newer-fixture-distribution.tar.gz "$CURRENT_STUDIO_SHA256" \
  /path/to/node24/bin/node /path/to/node26/bin/node /path/to/new-evidence-directory
```

The driver checks both digests before creating the evidence directory, installs
the retained fixtures offline, and runs the project compatibility proof. It
stores the two install receipts in `old/` and `current/` and the project proof
in `qualification/`. The underlying
[project qualifier](../../../scripts/qualify-project-compatibility.mjs) accepts
existing installations followed by the Node 24 executable, Node 26 executable
and a new evidence directory.

## Contract-driven updates

1. Decide whether behavior, authority, identity, data flow, capability, enforcement or a public type changed. A private implementation cleanup often needs no wiki edit.
2. Find that contract's canonical page through the [router](../README.md) / [change-impact graph](../reference/change-impact.md).
3. Verify current source/symbols and update only affected facts, dependency links and workflow/extension steps.
4. If support changed, update [capabilities](../reference/capabilities.md); if a guarantee changed, update [invariants](../reference/invariants.md). Keep enforcement and limitations distinct.
5. Run the checker and applicable code checks; rerun the relevant [retrieval route](retrieval-checks.md). Record unverified external behavior without converting it into a guarantee.

Every Markdown page uses restricted YAML-style frontmatter: unique `id`, one-line `summary`, and nonempty `read_when`, `source`, `related` lists. IDs are stable graph identifiers. `source` paths are repository-relative and may name directories. `related` contains IDs; meaningful body links provide navigation. One concept has one canonical home; other pages summarize only enough to link there.

[check.mjs](../check.mjs) uses Node built-ins. It checks the schema, duplicate IDs, related-ID existence, source-path existence/containment, relative inline/reference Markdown links and Markdown heading anchors, and Markdown-page reachability from the router. It ignores fenced examples/external URLs and does not crawl all repository docs. It does **not** prove symbol semantics, evidence accuracy, diagrams, external links, or live integration behavior; source/symbol review remains human/agent work. Prefer simple relative links/ATX headings supported by the checker.

Existing [Studio design documents](../../framework-studio/README.md) retain detailed UI conventions and history; consult [Inspector interaction guidance](../../framework-studio/inspector-design.md) for visual controls. Use the source-linked capability matrix and current implementation to resolve conflicts with historical descriptions; don't propagate old roadmap statements as current behavior.


## Repository Markdown link validation

Run `python3 docs/check-links.py` from the repository root, or add `--json` for
machine-readable counts. [check-links.py](../../check-links.py) uses only Python 3.9+
standard-library modules, discovers its checkout from its own location and makes no
network calls. It checks authored Markdown across the repository, including hidden
agent/skill guidance. Dependencies, generated directories, caches, builds and the root
browser-output directory are excluded.

The checker validates local inline and reference links, file/directory existence and
Markdown heading or explicit HTML heading anchors. It ignores fenced examples,
frontmatter and inline code. It reports documents unreachable from the root README
or AGENTS as navigation observations; broken paths/anchors fail the command. External
links are counted but never fetched. Supported Markdown is intentionally bounded:
prefer ordinary relative destinations or angle-bracket destinations for paths with
spaces, rather than complex nested-link syntax or generated renderer-specific anchors.

This complements `node docs/aws-studio-knowledge/check.mjs`, which additionally
validates wiki metadata, related IDs, declared source paths and router reachability.
Neither checker proves command correctness, symbol semantics, external-service
behavior or historical claims; those require independent source review.

## Mermaid syntax validation

[check-mermaid.mjs](../../check-mermaid.mjs) validates repository Markdown diagrams
with the real Mermaid parser in an isolated Node/jsdom process. It leaves repository
dependencies and the lockfile unchanged and does not open a browser or send diagram
content to an external service. Install tooling once into a temporary directory
(network required), then run the check from the repository root:

```sh
mermaid_tools=$(mktemp -d "${TMPDIR:-/tmp}/aws-studio-mermaid.XXXXXX")
npm install --prefix "$mermaid_tools" --cache "$mermaid_tools/cache" --ignore-scripts --no-audit --no-fund mermaid@11.17.2 jsdom@26.1.0
node docs/check-mermaid.mjs "$mermaid_tools"
```

The check itself is offline. It scans the Markdown files returned by `rg --files`
(excluding ignored files and dependencies), checks standard triple-backtick `mermaid`
fences, reports file/line/type and rejects an intentionally malformed control first.
It exits unsuccessfully if a diagram fails or none are found.

Parsing establishes syntax for the installed version, not readable layout, renderer
compatibility in every Markdown host, or architectural truth. Review edges against
source separately. Historical/proposed diagrams retain their explicit status and
must not be treated as the current implementation. Rendering in an isolated browser
is an additional check when visual layout or export quality matters.

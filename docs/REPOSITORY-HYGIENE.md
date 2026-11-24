# Repository hygiene and artifact retention

Keep source, reusable tests and useful architectural evidence easy to find. Disposable
output should have a clear owner and destination; directory names alone do not prove
that something is safe to delete.

## Locations and retention

| Material | Location / retention |
| --- | --- |
| Application/framework source, manifests and lockfile | Retain; ordinary feature work owns changes |
| Tests and support fixtures | Existing workspace test directories; retain glob-discovered entrypoints, fixtures and benchmarks |
| Reviewed visual references | `client-app/test/browser/*.spec.ts-snapshots/`; tracked inputs, never disposable screenshots |
| Browser fixture fonts and licenses | `client-app/test/browser/assets/fonts/`; retain binaries, provenance and licenses |
| Browser results, reports, traces, videos and ad hoc screenshots | Ignored `output/playwright/<task>/`; normal suite owns `output/playwright/studio/` |
| Tool-default browser snapshots | Ignored `.playwright-mcp/` and `.playwright-cli/`; close owned sessions and review contents before removal |
| Other one-off experiment output | Ignored `.framework/artifacts/<task>/` or a task directory outside the checkout; keep it separate from runtime state |
| Durable findings and historical decisions | Canonical guides or concise public verification notes |
| Build outputs and transform caches | Regenerate through the owning workspace command; retain caches used by an active process |
| `.cache/` and `.framework/` | Mixed-use directories: inspect ownership and contents; never blanket-purge |
| `.cache/framework-development-logs/` | Private, disposable development evidence with its own byte/count/age retention; preserve active writer ownership and distinguish it from deployment/recovery journals |

Private environment files, source recovery journals, saved approvals/plans, deployment
identities, retained-resource evidence, SQL, database files and volumes remain protected.
In particular, retain `.framework/local/`, `.framework/retained-resources/`,
`.cache/deploy/` and Studio's journals/jobs/preferences/private-input stores. A copied
test workspace can contain real or private inputs even when its name starts with
`fixture-` or `creation-`.

Generated files are not interchangeable with build output. The committed framework,
GraphQL and route projections named in [AGENTS.md](../AGENTS.md) are part of the source
contract. Use their generators. The optional frozen Tailwind assets used by
`STUDIO_BROWSER_BASELINE=1` are historical inputs, not a cache of the current app.

## Simple cleanup workflow

1. Record `git status --short`, the revision and `du -sk` measurements. Inventory hidden,
   tracked, untracked and ignored files; do not follow symlinks outside the checkout.
2. Identify each candidate's producer and consumers, including scripts, package globs,
   runtime discovery, Docker contexts, docs and external tool conventions. Classify it
   as disposable, regenerable, archive candidate, manual review or retain.
3. Check the exact target list for environment/data/state files and active writers.
   Close only your own previews/tests; preserve the developer's running services.
   Recheck membership/size/mtime immediately before deletion and stop if it changed.
4. Record useful findings before discarding raw captures. Preserve unique receipts and
   the source/hash provenance needed to interpret them. Remove exact reviewed targets
   with native tools, rather than running a repository-wide clean or cache purge.
5. Check the diff and protected-file fingerprints, regenerate/check with existing tools,
   and run the required [verification gates](aws-studio-knowledge/guides/verification-and-maintenance.md).
   Run cleanup, browser cleanup and the full offline gate sequentially: CDK tests may
   be walking the same filesystem.
6. Record after measurements and remaining review candidates. Leave no cleanup daemon,
   retention scheduler or dependency installation behind.

Ignore rules prevent future additions; they do not remove files already tracked by Git.
Keep permanent fixtures out of output folders. Do not use blanket PNG/JSON/ZIP/test
ignore rules. Raw browser traces and local reports may contain private material, so
review their filenames/metadata without dumping values into audit output. Git history
is retained; removing a tracked artifact from the working tree does not erase old commits.

The [browser guide](../client-app/test/browser/README.md) owns screenshot approval
and test behavior. Existing [development guidance](DEV-DEPLOYMENT.md) owns local state
and Docker/image lifecycle; filesystem hygiene does not authorize infrastructure actions.

---
id: research.index
summary: Index of pre-release architecture research. These pages hold findings and proposals, not established decisions.
read_when:
  - Deciding the framework and project boundary before a release
  - Changing how framework-owned code, stacks, Lambdas or database schema reach projects
source:
  - docs/aws-studio-knowledge/architecture/decisions.md
  - client-app/server/project-upgrade.ts
related:
  - knowledge.router
  - architecture.decisions
---
# Architecture research

These pages record research done before the public release. Each one states its
question, what the current source shows, the options considered and a
recommendation. A recommendation is not a decision. To adopt one, record it in
the [decision records](../architecture/decisions.md) and update the canonical
pages it affects.

| Page | Question |
| --- | --- |
| [Framework upgrade boundary](framework-upgrade-boundary.md) | After release, how can framework-owned code (stacks, Lambdas, settings, templates) keep changing across many independent projects? Which choices must be made before 1.0? |
| [Managed database platform](managed-database-platform.md) | Which parts of the managed PostgreSQL platform does the framework own? Where does each live today? How does it stay upgradable, including framework-owned schema in application data? |
| [Making every layer updatable](updatable-layers.md) | Can every managed-database layer be updated after release? What does that require per layer? Which AWS settings fixed at creation, and which unavoidable events, set its limits? |

Research date: 2026-11-25, against aws-studio `8b0a51f` and starter `61d8847`.
The starter pin in `scripts/starters.json` was `47d90d7`. Source line references
can drift, so check critical symbols against current source.

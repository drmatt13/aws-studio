---
id: reference.status
summary: Product maturity, evidence boundaries and grounded future direction.
read_when:
  - Separating current support from proposals and historical validation
source:
  - client-app/src/main.tsx
  - client-app/server/server.ts
  - client-app/server/deploy/registry.ts
  - client-app/shared/creation.ts
  - docs/framework-studio/moving-forward.md
related:
  - reference.capabilities
  - architecture.decisions
  - guides.maintenance
---
# Implementation status and direction

This page explains implementation maturity. The
[capability matrix](capabilities.md) lists the supported surfaces in detail.
The [product overview](../../AWS-STUDIO.md) explains how the parts fit together.

## Interpreting evidence

“Implemented” means there is an executable source path. It is not a release stability
guarantee. “Bounded” means the operation recognizes specific declarations, resource
types or targets and refuses unsupported cases. “Runtime verified” must name the action,
environment and date. Browser navigation proves a visible interface; source inspection,
isolated tests, local execution and live AWS outcomes are different evidence levels.

| Category | Current examples | Practical consequence |
| --- | --- | --- |
| Implemented core | Literal TypeScript model, normalization, native resource references/grants, local/cloud projections, generated contracts; revisioned Studio snapshots, map, inspectors and source review | Extend the existing producer/consumer contracts and preserve identities |
| Implemented with explicit limits | Supported creators, workload bindings/removal, source recovery, input/client recipes, Prisma workbench, GraphQL source contract-chain evidence and scoped review records, deployment planning, stateful reuse, Cognito/identity/DNS operations, frontend release | Consult each subsystem's supported shapes, authorization and outcome model; UI availability is not universal coverage |
| Implemented source-input support | Standalone `input.value` inputs, source-versus-env input conversion and client mapping availability propagation | Follow the [environment contract](../runtime/environment.md); source values, private inputs and browser mappings have distinct delivery rules |
| Incomplete Studio journeys | General native-resource authoring, advanced graphical workflow authoring, complete Studio-driven data propagation, production saved-SQL execution, comprehensive application observability | GraphQL source-chain evidence does not establish propagation or application behavior; continue through the documented data-feature agent procedure |
| Proposed direction | Workflow execution overlays, structured workflow views, broader typed templates, optional manual layout and touch/performance refinements | Proposals from existing design guidance; no schedule or commitment |
| Outside current contract | Third independent environment mode, full offline AWS emulation, universal IAM proof, remote multi-user Studio, automatic deployment promotion or universal retained-resource import/restore | Requires a new design decision and explicit implementation, not a documentation claim |

## Current limitations worth finding early

- Map is `/`; `/isometric` redirects. The retired Board implementation has been removed.
- Saved-source history is Git. Current source operations expose guarded plan/apply and
  interrupted-write recovery, not the old global Undo/Redo endpoints.
- The Source Development/Production switch selects graph context, not a cloud account
  or database. Named targets reuse the two modes; staging is not a third graph.
- Source-inferred connections and permission evidence are bounded analysis. A visible
  line is not proof of effective IAM, network reachability or business authorization.
- Local workflow/agent/task histories and runtime behavior do not equal managed AWS
  durability. Some local integrations call real AWS or model providers.
- Database planning is offline. Production inspection/application uses a deployed
  protocol-capable VPC task and separate approval. The database remains private and uses
  IAM/TLS; the task follows its declared networking and may have a public IP. Production
  saved SQL remains unavailable in the SQL workspace.
- CloudFormation events, deployment job output and local container logs exist;
  a general CloudWatch application logs/metrics/traces explorer does not.
- Protected selected-input APIs may return authored values for editing. Public model
  redaction is not a claim that the trusted host cannot read secrets.

## Evidence-based future direction

[Moving forward](../../framework-studio/moving-forward.md) proposes execution overlays,
structured workflow inspection and measured interaction improvements.
New work should preserve the [decisions](../architecture/decisions.md), extend
the [capability matrix](capabilities.md), and record validation separately from intent.

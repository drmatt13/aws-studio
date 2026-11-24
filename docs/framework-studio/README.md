# AWS Studio documentation

Start with the [interface and action model](../aws-studio-knowledge/studio/interface.md)
for the current product surface, [backend boundaries](../aws-studio-knowledge/studio/backend.md)
for implementation ownership, and the [knowledge router](../aws-studio-knowledge/README.md)
for a focused subsystem reference. The documents below explain Studio design and operations.

Framework Studio is a local, source-linked visual environment for applications built
with this framework. It reads `framework.config.ts` the way the framework does, shows what
the configuration declares, where each piece runs and how the pieces relate. It creates
declarations and edits supported settings and connections in TypeScript source, after a
validated review.

The framework never depends on it: declaration views use framework normalization,
and reviewed writes remain ordinary source and migration files consumed by the existing
framework and Prisma workflows. The Database workbench edits its fixed authored Prisma
contract through a separate source authority; it does not expand the configuration writer.

```powershell
npm run studio            # http://127.0.0.1:4590/   (--port <n>, or STUDIO_PORT)
npm run studio -- --print # the whole model as JSON, then exit
```

## Views

| View | Path | What it is for |
| --- | --- | --- |
| Map | `/` | The isometric view: the application as a lit, navigable landscape: gateways, compute, the VPC's subnet terraces, catalog stacks. `/isometric` redirects here |
| Database | `/database` | Prisma source and diagram editing, semantic migration history, offline artifact review and selected-target database evidence |
| Deploy | `/deploy` | Deployment discovery, reviewed plans, authorized operations and local development controls |
| GraphQL | `/graphql` | Saved schema, generated documents, client query options, local Explorer and reviewed Contract Chain evidence |
| Authentication | `/cognito` | User pools, identity pools, providers and permissions; source and deployed evidence remain distinct |
| DNS / Domains | `/domains` | Private DNS source declarations, production public-domain intent, explicit deployment inspection and separately approved operations |
| WebSockets | `/websockets` | One connection panel for the Source mode: local-ws-dev-server in Development or API Gateway in Production, with client launch-link token handoff |
| Inspector | beside any view | One entity: source location, resolved settings and where they come from, relationships, and the editable fields |

A Development/Production switch picks which deployment graph Isometric describes.
Deploy owns its named deployment/profile/account/region selection; Database requires an
explicit database target and separate approval for database changes. While something is
unresolved, a navbar indicator opens Configuration health, which reports what is wrong,
where, what is paused and what still works.
Configuration health contains an optional saved-source audit for generated files and local
wiring under **Additional checks**. This runs `framework:check`; it is separate from the
automatic configuration validation and inspector preflight. The **Stacks** island inspector
owns CDK synthesis and its resource inventory; catalog stack inspectors offer a scoped
inline disclosure. These actions build local templates and never deploy or rewrite stacks.

The isometric view uses a thin world-anchored grid and local official AWS SVGs, with
Lucide outlines for generic concepts. Startup and watched CDK edits automatically rebuild
an ignored JSON index from linked stack source. Source-inferred edges
have a separate filter and source links, including the resource flow in `referenceExamples`.

Declaration placement uses two framework modes. Isometric omits
badges for entities available in both; Dev (flask), Prod (diamond) and Off
badges identify exceptions. The Inspector shows two environment cards. Development
combines local execution and its AWS-managed workloads; it does not treat these as
separate deployment states.

## Documents

| Document | Read it when |
| --- | --- |
| [EC2 instance implementation report](ec2-implementation-report.md) | You are planning first-class EC2 declarations, account-scoped AMI selection, production instances and local development containers; proposed, not implemented |
| [Product and architecture overview](../AWS-STUDIO.md) | You need the system's identity, lifecycle and grounded long-term direction |
| [Knowledge router](../aws-studio-knowledge/README.md) | You need current source-linked ownership, contracts, verification and selective architecture context |
| [Declarations and tags](declarations-and-tags.md) | You are authoring declaration modules or changing metadata ownership and tag filtering |
| [Network and database declarations](network-database-declarations.md) | You are changing explicit VPC/database ownership, placement or identity-sensitive infrastructure |
| [Database workbench](database-workbench.md) | You are authoring Prisma, comparing migration contracts, planning artifacts or reviewing explicit local/private-task database operations |
| [Local coding agents](local-agent-lab.md) | You are using or extending the Agent panel's Conversation, Coding tasks, CLI discovery or source review |
| [Architecture](architecture.md) | You need detailed implementation context; confirm current contracts through the knowledge router |
| [Isometric view](isometric-view.md) | You are changing the landscape: layout, terrain, buildings, camera, picking or rendering |
| [Inspector interaction system](inspector-design.md) | You are adding or refining inspector sections, forms, disclosures, menus or edit workflows |
| [UI design system](ui-design-system.md) | You are styling a Studio surface or checking shared control, spacing, responsive and keyboard conventions |
| [Lambda invocation design](lambda-invocations-design.md) | You are adding Lambda type conversion, resource-specific event triggers or function creation |
| [Moving forward](moving-forward.md) | You are about to extend the studio: invariants, recipes, gotchas, known limits, the roadmap |
| [Deploy & Run](deploy-and-run.md) | You are working on deployment discovery, planning, deploys, teardown or the local development lifecycle |

The [Studio workspace README](../../client-app/README.md) describes the implementation.

## Framework semantics

The framework defines the lanes, placement, resources and workflows shown in
Studio. See [Framework](../FRAMEWORK.md) for their source contracts.

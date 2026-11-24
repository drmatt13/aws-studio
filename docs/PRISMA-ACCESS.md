# Access Graph declarations and previews

AWS Studio includes the Access Graph compiler, policy interpreter and schema editing
tools. They describe row visibility, scoped roles, field readers and writers, named
permissions and commands in Prisma doc comments.

The GraphQL API keeps Project's owner-scoped authorization and does not consult Access
Graph directives. The demo board is the one enforced example: `ProjectRole`,
`ProjectMember` and `Task` in `contract.prisma` declare role grants, a
`seeConfidential` permission, a deny rule and readonly/serverOnly fields, and the
`/demo/board` and `/demo/tasks` Lambdas evaluate them through
`database.access.forRequest()` (`packages/database/src/demo-board.ts`) before every
read and write. `packages/database/test/demo-board-access.test.ts` checks each role.
Adding a declaration alone does not bind the policy to a GraphQL resolver, database
query or write transaction. An application that adopts policy enforcement must wire
those boundaries and test them explicitly.

## Authoring

Use `/// @access(…)` above a model, scalar field or enum. A scalar field or enum value
can carry a trailing directive on its own declaration line. Long directives can
continue across consecutive `///` lines. Keep explanatory prose separate.

```prisma
/// @access(read, create: isMe(ownerId))
model Note {
  id      Uuid   @id @default(uuid())
  ownerId Uuid
  owner   User   @relation(fields: [ownerId], references: [id])
  title   String
}
```

This example declares intended access; it does not add a public API or install an
enforcement hook. The compiler checks relation, identity and field references against
the authored schema.

| Declaration | Example | Meaning |
| --- | --- | --- |
| Model | `read, update(title): isMe(ownerId)` | The selected actions and columns for that identity. |
| Model | `roles: members[isMe(userId) && status == ACTIVE].role` | Resolve the actor's role through the selected membership. |
| Model | `from: parent` | Inherit a required parent's scope, actions, caps and denies. |
| Model | `only: [read]` | Cap inherited actions; never grant access. |
| Model | `deny read: status == DRAFT && !publish` | Remove rows from the readable set, including inheriting descendants. |
| Model | `fields(a, b), readonly` | Apply one field rule independently to each named scalar. |
| Field | `readonly` / `serverOnly` | Describe a field that cannot be client assigned / cannot enter a bound client API. |
| Field | `write: isMe(ownerId)` | Describe who may assign the field. |
| Field | `PENDING -> ACCEPTED: email == auth.email` | Check both stored and proposed state. |
| Enum | `publish: [EDITOR]` | The exact roles holding a named permission; `[]` preserves a permission held by nobody. |
| Enum value | `...READER, update, protected` | Inherit another role, add actions and protect the stored value from client replacement. |
| Model | `command publishNote, update(title): publish && status == DRAFT` | Name a command's audience, state and affected columns. |

Conditions combine with `&&`, `||`, `!` and parentheses. Each allow alternative names
one audience and may narrow it by row state or exclude an identity. `isMe(field)`
compares a principal key or principal foreign key with verified identity. Explicit
comparisons such as `email == auth.email` use the principal's corresponding unique
field. Relation rules such as `parent.read` follow that relation's own readers.
Unsupported or ambiguous expressions produce a diagnostic at their source span.

A permission matrix can list action and permission holders above an enum, or place
grants on enum values. Do not declare the same action in both forms. Role spreads
inherit the lower role's grants. Scope limits and deny rules restrict grants;
field restrictions and protected values apply after a grant qualifies.

## Studio

Open **Database → Schema → Access**, or press Ctrl/Cmd+., to inspect a declaration.
The inspector links effective rules to their source and edits role/permission cells.
**Preview with sample data** evaluates rules over test rows using the shared interpreter.
**Review source changes** shows policy changes before saving. These previews establish
the result for the supplied rows; they do not query production or prove application
enforcement. Existing application authentication and domain validation remain separate.

## Generation and source owners

Run from the repository root:

```sh
npm --workspace @repo/database run generate
```

This emits the ordinary Prisma contract, then validates access declarations and emits:

| Artifact | Contents |
| --- | --- |
| `packages/database/src/generated/client-access.ts` | Field settings, row rules, access policy and field audiences. |
| `packages/database/src/generated/access-graph.json` | Compiled graph, semantic fingerprint and policy-module source digest. |
| `packages/api-contract/src/generated/access-policy.ts` | Browser-safe role/permission declarations. |

No directives is a valid input. Keys and database clock fields still receive derived
read-only metadata, while row rules and role exports remain empty. Generation does
not change the public GraphQL schema or client operations. Never edit these generated
artifacts by hand.

Optional `packages/database/prisma/access/index.ts` can default-export a policy object
with a differently named principal or compatibility command declarations.
Schema-local commands are declared beside the models they affect. Policy-module
files and their normalized source digest are included in the graph artifact; Contract
Chain checks generated policy against current source. The boilerplate needs no module.

The implementation owners are:

| Source | Responsibility |
| --- | --- |
| `packages/aws-studio/database/access-syntax.ts` | Token spans, parsing and syntax diagnostics. |
| `packages/aws-studio/database/access-rules.ts`, `access-graph.ts` | Validate and lower declarations into a policy graph. |
| `packages/aws-studio/database/client-access.ts` | Compile row/field settings, policies and generated exports. |
| `packages/aws-studio/database/access-graph-artifact.ts` | Semantic fingerprint and policy-module identity. |
| `packages/aws-studio/cli/database/emit-client-access.ts` | Generate artifacts. |
| `packages/aws-studio/database/access-runtime.ts` | Shared policy interpreter for application adapters and Studio previews. |

## Runtime integration boundary

`createAccessRuntime(policy, rows, settings, reader)` accepts a reader implementing
`find(model, where)`. It provides visibility, field read/write checks, role/permission
answers, write authorization, explanations and request-scoped snapshots. The reader
must supply authoritative rows and the caller must supply verified viewer identity.

An adopting application must bind policy decisions to its actual read and write
paths, preserve pagination/count semantics, authorize stored and proposed values in
the appropriate transaction, and account for every affected row and client assignment.
Authentication, domain validation, transaction execution and service effects stay in
application code. A preview or a client permission hint cannot authorize a write.

The generic compiler/interpreter regression suites use independent schemas and
in-memory rows. Run them from the repository root with
`node --import tsx --test packages/aws-studio/database/test/*.test.ts`. The app's database and
API tests cover the concrete repository behavior, including Project's owner-scoped access.

---
id: studio.source-indexing
summary: Connect evaluated entities to editable TypeScript and conservatively inferred CDK evidence.
read_when:
  - Adding source transformations, source evidence, or resource discovery
  - Explaining a read-only field or missing inferred edge
source:
  - client-app/server/source/index.ts
  - client-app/server/source/capabilities.ts
  - client-app/server/source/permission-rules.ts
  - client-app/shared/permission-readiness.ts
  - client-app/server/source/cdk-links.ts
  - packages/aws-studio/scripts/config-source.ts
related:
  - studio.editing
  - studio.graph-model
  - framework.resources-cdk
---
# Source locations, capability discovery and evidence

Catalog shorthand and named relative descriptor imports resolve to their owning const,
including cohesive one-level catalog namespaces. The default `workloads/<kind>.ts` layout is an
authoring convention, not a section-discovery or module-depth restriction. Independently
imported network/database literals remain source-located without using directory depth as
write authority. Tag writes remain restricted to the root and `framework-config` TypeScript.
Tag editability requires literal string maps and unambiguous ownership; computed values,
spreads and comment-sensitive replacements provide source links and corrective refusals.
Catalog members' source files identify where their descriptors were authored, not where
the composed derived resource catalog is exported. Trigger, failure-destination and requirement
edits derive catalog imports from the located root `inputs` or `stacks` property for the selected category; never infer that
module from the first member or its ordering.

Evaluation answers what a declaration means; the source index answers where it was authored and whether a narrow transformation is safe. `buildSourceIndex` / `SourceFiles` in [source/index.ts](../../../client-app/server/source/index.ts) combine normalized origins with parsed TypeScript and overlay contents. `locateConfigSource` in [config-source.ts](../../../packages/aws-studio/scripts/config-source.ts) follows supported imports/aliases and literal section composition.

Per-entity tag editability reuses the current index's located configuration and catalog;
it must not rewalk and reparse the entire catalog for every member. These discovery
results live only for that index. Source planning resolves each changed overlay afresh,
so offsets and ownership never come from an earlier draft.

Native VPC evidence and VPC removal share relative-module matching in
[networks.ts](../../../client-app/server/source/networks.ts). It recognizes emitted
`.js` import paths that refer to TypeScript declarations, as well as extensionless imports.
The removal scan treats imports, re-exports and literal dynamic references as consumers;
disabled or source-only consumers still block deletion.
The framework's locator indexes only exported `const` VPC declarations calling the real
`defineNetwork` helper, including official import aliases and namespace imports. Custom
wrappers and unrelated same-named functions stay source-owned.

Permission discovery shares the TypeScript program and is independent of trigger adapters.
`SourceIndex.permissionCapabilities` covers public native members, secrets and managed
policies from `stack<T>()`, plus standalone `cdk<T>()` entries in the configured `stacks`
catalog, including official factory aliases and namespace imports. It retains canonical
CDK type identities, public string attributes and compatible `grant*` signatures with
serializable trailing arguments. Common guided actions still use their bounded service
registry; other grants use discovered methods instead of a second method allowlist.
`IManagedPolicy` is recognized independently of `IConstruct`. Definite literal S3 HTTPS
enforcement is source evidence only. Optional fields carry an availability explanation;
private fields, unresolved types and arbitrary structural lookalikes do not prove a
supported capability.

The same discovery pass reads public resources on the displayed framework export
stacks, even without a catalog entry. Inherited fields, getters and constructor
parameter properties use resolved types; private, protected, static, `any` and
`unknown` members do not establish resources. Framework members retain
`framework-stack:<Class>.<field>` identities and source locations. They can be
inspected and used as endpoints for existing derived connections; additional
authored permissions require a declared and linked `stack<T>()` reference.

`discoverPolicyRules` follows literal IAM arrays through relative const imports, object
properties and supported spreads, retaining each statement's exact owner, source-bound
identity and complete consumer list. Shared statements remain one rule, not copied
workload-specific policies. Literal IAM edits preserve comments through the existing
comment-review path; computed rules and protected directives retain inspectable source
and a refusal reason. Evaluated action/resource lists never authorize a guessed rewrite.

Construction evidence is separate from editability. Unconstructed public native targets
remain selectable; `withPermissionReadiness` adds located errors to saved relationships,
their callers and resources. Unknown construction remains a warning. Caller-lane absence
can block deployment readiness without turning valid declarations into snapshot-load errors.
`readResourceLinks` retains direct `linkResources` group and `linkResource` member evidence,
following named/namespace imports, const aliases and re-exports against the configured
catalog. Constructed public members and standalone native declarations with no source
link carry saved-connection errors. Computed references, custom helpers and incomplete
analysis produce explicit warnings instead of claiming that a link is absent; uncertainty
inside a known stack constructor is scoped to that stack. A link written in an
unconstructed class does not establish construction or deployment.
`validateForMode` checks the framework's declared lane, role, authentication and cycle
contracts; reduced development AWS availability belongs to readiness. For an event-to-task
binding, both modes can remain source-valid while development has a blocking readiness
error. The application retains its strict CDK cloud-edge check before stack composition.

`fieldEditability` compares actual authored expressions against the evaluated setting. Computed expressions, ambiguous spreads, unsupported wrappers and comment-sensitive edits can be read-only even when their values normalize successfully. Do not replace a computed declaration merely because the Inspector can display its effective value.

| Source analysis | Owner / evidence strength |
| --- | --- |
| Catalog and public members | [catalog.ts](../../../client-app/server/source/catalog.ts): type-only stack imports, catalog paths, field declarations and native link sites |
| Trigger/resource capability | `discoverCapabilities` in [capabilities.ts](../../../client-app/server/source/capabilities.ts): TypeScript program resolves official CDK type symbols, inheritance and adapter metadata; not class-name string guessing |
| Stack instantiation | [stack-usage.ts](../../../client-app/server/source/stack-usage.ts): source evidence of application constructor usage; not CloudFormation observation |
| Explicit IAM ownership | [permission-rules.ts](../../../client-app/server/source/permission-rules.ts): literal owner, shared consumers, source-bound statement identity and safe editability |
| Permission readiness | [permission-readiness.ts](../../../client-app/shared/permission-readiness.ts): saved-source construction/availability diagnostics; not permission authoring eligibility |
| Native relationship inference | `scanCdkLinks` in [cdk-links.ts](../../../client-app/server/source/cdk-links.ts): supported direct constructors/aliases and native S3/SQS/SNS/DynamoDB/Cognito/EventBridge patterns |
| Safe evidence snippets | `sourceEvidence` in [evidence.ts](../../../client-app/server/source/evidence.ts): strips comments/redacts literal/template/regex contents while retaining structural names |
| Description and display-name metadata | [string-map.ts](../../../client-app/server/source/string-map.ts) shares literal-map reading for `descriptions.ts` and `naming-metadata.ts`; those writers retain their own validation and exact original AST spans |

CDK inference deliberately skips unsupported loops, conditions, helper indirection and dynamic expressions. A missing edge is not proof of absence. A source-supported edge is not proof that its stack is constructed or deployed. Edges retain provenance and supported-removal metadata; arbitrary native statements must remain source-owned. [Graph model](graph-model.md) owns how those distinctions reach the UI.

Recognized native triggers retain `ModelEdge.sourceConstruct`, the canonical imported CDK
constructor at the wiring site (for example `cdk.aws_cognito.UserPool`). Import aliases
resolve to that name; custom or unresolved constructors leave it absent. Hover shows this
short origin, while Configuration retains the file location and inference evidence. This
metadata describes source wiring and does not change relationship identity or editability.

Extend discovery when a real source shape/resource family is needed; add positive and refusal fixtures together. Do not broaden the writable-file allowlist to compensate for an unresolved source location. New native trigger semantics also need framework adapter/CDK support, not just an inferred visual wire; see [creation/connections](creation-and-connections.md).

Tests: [CDK links](../../../client-app/test/cdk-links.test.ts), [stack usage](../../../client-app/test/stack-usage.test.ts), [evidence](../../../client-app/test/evidence.test.ts), framework [config source](../../../packages/aws-studio/test/config-source.test.ts). [Editing](editing.md) consumes locations; [snapshots](snapshots.md) consumes the index and exposes diagnostics.

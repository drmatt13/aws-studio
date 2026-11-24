---
id: studio.authentication
summary: Cognito workspace routing, shared target context, retained drafts and separate authentication evidence.
read_when:
  - Changing Cognito navigation, federation, identity pools or permissions diagnostics
source:
  - client-app/src/views/AuthenticationWorkspace.tsx
  - client-app/src/views/AuthenticationEvidence.tsx
  - client-app/src/views/SourceContext.tsx
  - client-app/src/identity-api.ts
  - client-app/src/identity-queries.ts
  - client-app/src/deploy/observations.tsx
  - client-app/src/deploy/context.ts
  - client-app/src/views/DomainsWorkspace.tsx
  - client-app/src/views/RetryNotice.tsx
  - client-app/src/views/IdentityPolicyEditor.tsx
  - client-app/src/views/CognitoManagement.tsx
  - client-app/server/identity/service.ts
  - packages/aws-studio/src/runtime/auth.ts
  - packages/aws-studio/src/runtime/cognito.ts
related:
  - studio.editing
  - deployment.planning-safety
  - deployment.environments
---
# Authentication workspace

**Cognito** is the single authentication destination. User pools, identity pools,
providers and permissions have distinct nested routes under `/cognito`. The parent
owns context and preserves its panels while moving between subsections. These
routes organize the UI; Cognito User Pools and Identity Pools retain separate AWS
resources, APIs and authorization boundaries. `/identity-pools` remains a compatible
entry point. Domains remain a separate production workspace.

Subsection navigation sits immediately below the application bar, ahead of inspection
controls and errors. It is GraphQL's section strip: `workspaceToolbarClasses` with
`NavigationStrip` flush left at the 16px gutter and an icon on each section. The page has
no visible title, because the navbar already names it (its `h1` is `sr-only`). It remains
a stable destination while context loads or fails. Everything below it shares the bounded
document column used by Domains, starting 16px below the strip. Each section opens with
`WorkbenchPageHeader` (its 18px title and one support line, like GraphQL's sections); that
title receives focus after section navigation. The inspection context follows as one
**Read-only deployment inspection** `DocumentCard`, the title Domains gives the same
controls, holding the connection/deployment/region row, evidence status and context
notices. It sits outside the hidden section wrappers, so it stays mounted across
sections. The header, the inspection card and section cards are 16px apart. The shared source-environment selector lives in `Shell`'s
application bar. Selecting a source mode promotes its shared read-only deployment
observation; it does not run this workspace's specialized inspection or deploy AWS.
Saved source history belongs to Git.
Card typography, form spacing and action alignment come from the shared identity
workspace styles. Source actions stay grouped with their explanation, and failed
context/source reads use an inline alert with a visible retry action. Keep long messages
and identifiers wrapping inside the workspace; subsection navigation scrolls
independently on narrow screens.

`identity-api.ts` owns the shared read-only HTTP adapter. `identity-queries.ts` shares
the source query's mode/revision identity between this page and `DomainsWorkspace`;
AWS inspection remains an explicit action with its existing context/cancellation
checks. `RetryNotice` renders equivalent source/context failures without owning
either query or observation state. Production Domains keep their own selection,
input-edit gate and operation approvals.

[AuthenticationEvidence.tsx](../../../client-app/src/views/AuthenticationEvidence.tsx)
contains provider evidence, groups and pool relationships. `AuthenticationWorkspace`
owns requests, context, cancellation, approvals and panel lifetime.

The workspace inherits Studio's selected development/production mode. Inspection
uses one profile, declared deployment and region across the subsections. Shared repository
metadata and the pure mode-aware target resolver seed defaults from a matching remembered
target; they do not prove the account or make the graph deployed. Explicit selections
remain local to this workspace and per mode. Global deployment observations can load
while this route is open, but Cognito/identity-pool inspection still requires its explicit
action and retains its own cancellation and approval boundary. Changing the destination invalidates incompatible observations
and live-operation reviews. Observations are also isolated by the declared account.
Source revision, input changes and an observation age above five minutes make old
inspection evidence stale. Refresh is an explicit read against verified owned stacks.
The source toolbar names the fixed mode input file. A named target with a custom
input path needs an explicit mismatch notice: presence in `.env.dev`/`.env.prod`
does not prove that named target supplies the same input. Do not silently retarget
fixed-path source controls.

Subsection navigation keeps source proposals, policy form state, user search and
inspection results. The global source draft continues to guard leaving the
workspace and changing environment. Source review/apply uses the existing batch,
preflight and journal; it never starts deployment. User/group operations keep
their separate exact destination/action approvals. IAM simulation uses saved
source statements and explicitly verified expected account; it neither deploys
policies nor issues credentials.

Keep these evidence classes separate in every status and empty state:

| Evidence | What it establishes |
| --- | --- |
| Supported provider type | An authoring/constructor capability exists |
| Source declaration | TypeScript intent for the selected mode |
| Deployed metadata | A timestamped read from verified owned AWS resources |
| Secret presence/access | Authentication diagnostics return presence flags only; presence does not prove deployed secret access |
| External provider configuration | Requires provider-side verification independent of AWS metadata |
| Sign-in and effective access | Require actual authentication/authorization observations; IAM simulation is a separate bounded diagnostic |

Handler-side `authenticated` verifies ID tokens with the configured pool/client and
fetches remote Cognito signing keys over HTTPS. `userPool: true` delivers the
identifiers; it does not create a network path to that JWKS endpoint. API Gateway
JWT admission is a separate layer. An isolated handler can therefore receive a
valid admitted token but return 503 when signing keys cannot be read; an invalid
token returns 401. Keep the authentication entry point where that fetch is reachable
and delegate private work through declared bindings, or explicitly provide the
required network reachability. An S3 gateway endpoint alone does not provide it.

`IdentityService` resolves owned physical IDs rather than accepting arbitrary pool
IDs. It allowlists public provider metadata and never requests secret values.
Google setup links to the exact mode input file in the editor; it never requests
`/deployment-inputs/details`. Successful provider creation clears automatic
resource selection, so adding an OIDC secret does not open its value inspector.
Failure preserves the draft and context. Saved-source history belongs to Git.
The existing generic environment and resource value editors are separate
boundaries that can load stored values into component state for masked display.
`identityPoolAccess` keeps default authenticated and optional guest roles
permissionless; reader-group grants and explicit Deny statements remain distinct
from application RBAC. Native code may pass a newly created bucket's unresolved
CDK `bucket.bucketArn` to `readBucketArn`; synthesis preserves that CloudFormation
reference and the selected object prefix. Studio's literal ARN editor still
requires a concrete scoped string and never evaluates arbitrary expressions.
See the [identity/domain guide](../../framework-studio/identity-and-domains.md)
for supported source shapes, operation approvals and limitations.

New custom-domain settings are production-only. An existing development custom
domain needs a separately reviewed transition before deployment can remove or
replace it. Source application, offline synthesis and live deployment remain
separate actions; use [deployment safety](../deployment/planning-and-safety.md).

Stateful policy source is `framework-config/deployment/stateful-resources.ts`: Database and
Cognito each have independent dev/prod retention, with omission inheriting legacy
inputs. Managed pool retention preserves native client/domain/providers/invoke
grants, but not independently owned trigger functions, groups or Identity Pool
roles. Dependency-aware teardown must preserve supporting infrastructure or refuse.

An explicit external Cognito reference uses the original pool/client/domain and
publishes existing outputs plus `UserPoolManagement` and
`UserPoolOriginalDeployment`. Read-only `IdentityService` resolves these only from
verified destination stacks and verifies original live framework tags, account,
region and selected client. User/group operation review refuses this external
ownership scope. `identityPoolAccess` and native framework trigger adapters refuse
unreviewed imported-pool mutation. Referencing is not CloudFormation import,
configuration management, password recovery or proof of sign-in. The
[Cognito lifecycle guide](../../framework-studio/cognito-lifecycle.md) owns source
examples, CLI inspection, preserved identities and remaining prerequisites.

Trigger capability discovery can prove managed ownership from a canonical native
constructor when the public field is typed `IUserPool`. `trigger.cognito` accepts
that interface, while CDK still requires the concrete owned `UserPool` before any
attachment. Studio reads the literal lifecycle policy and refuses trigger edits
if either graph references the external pool or ownership cannot be resolved.
Policy-file changes invalidate cached capability evidence; no source values enter
capability metadata.

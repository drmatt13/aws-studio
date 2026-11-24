# Private DNS authoring and runtime qualification

Studio supports source-authoritative private hosted zone authoring from a VPC's
**Private hosted zones** section and from **Domains**. Create a zone, select one or
more declared VPCs, configure A aliases to declared ECS internal ALBs, and review
the TypeScript diff before applying it. Source approval does not deploy anything.
An ASCII DNS name such as `internal.example.test` needs no public registration.
An enabled zone can be empty; after deployment its namespace is still authoritative.

`definePrivateHostedZone` modules live under `framework-config/private-dns/` and
are imported into the root's literal `privateHostedZones` array. Source remains
the only configuration authority. Zone/record IDs and `cloud.constructId` are
stable infrastructure identities. A zone owns its records; removal and name
replacement delete its owned DNS through a separate AWS deployment. External or
retained zones, cross-account associations and arbitrary DNS record types are
not supported by this authoring slice.

Only production builds the zone and its associated VPCs. Enabled records require
production-enabled internal ECS services with desired tasks; enabled grants also
require production-enabled callers. Disabled records can document a planned
endpoint. HTTP/80 grants are explicit, same-VPC and separate from DNS visibility.
They admit direct requests to the ALB, regardless of hostname. Studio rejects
grants that would bypass an ECS service's API Gateway `auth: true` authorizer;
service-owned authentication must be implemented before removing that declaration.
API Gateway retains its separate ingress identity. Existing VPC endpoint settings
and existing workload/ALB construct identities are preserved.

**Local private DNS execution is unavailable; production parity is unverified.**
Framework-mediated Lambda execution, task submission and service endpoint/proxy
resolution refuse workloads in a VPC associated with an enabled zone. These guards
do not stop independently running Compose services or constrain arbitrary traffic
inside those containers. Disable a zone explicitly to use the existing unqualified
local runtime. No host mappings, API monkey-patches or fake resolver are installed.

The experiment below remains a separate qualification harness, not an application
runtime or proof of AWS equivalence. Offline declaration, source-transaction,
browser and CDK tests establish authoring and synthesis behavior only.

## Isolated local experiment

Use the supported Node 24/npm 11 toolchain and a running Linux Docker Engine or
Docker Desktop. From the repository root:

```sh
npm run private-dns:spike -- local --build
```

`--build` explicitly builds the fixture helper and pulls digest-pinned CoreDNS.
Later runs can omit it while the exact helper inputs remain cached. The build
context contains only fixture assets, not developer inputs. It never mounts the
complete checkout over image dependencies. The script does not invoke Compose
or modify application containers, declarations, credentials or volumes. Its source
lives outside Compose's restart-watched framework scripts.

Each run creates uniquely named, labeled networks, a management volume, namespace
anchors, trusted initializers and unprivileged application containers. Cleanup
rechecks ownership and uses graceful stop and unforced removal. The current helper
image and anything in use are kept; only provably owned superseded helper images
are reclaimed. Shared upstream images and Docker build cache remain untouched.

Private evidence lives under `.framework/artifacts/private-dns-parity/<run-id>/`:
`report.json`, `local-evidence.json` and `contract.json`. A failed check or incomplete
cleanup exits nonzero. An uncertain cleanup names its exact resources; inspect
their labels instead of using a broad prune.

`--output <directory>` must name a new directory. Existing evidence and recovery
journals are never overwritten. Preflight refuses remote Docker endpoints,
inventories native host routes before subnet selection, and pins every operation
and recovery journal to the validated local Docker endpoint.

Resource intent is journaled to `resources.json` before each creation. SIGINT and
SIGTERM stop new admission and enter scoped cleanup. After an interrupted process
or Docker failure, retry only that manifest:

```sh
npm run private-dns:spike -- cleanup --manifest <run-directory>/resources.json
```

The live test is separately opt-in:

```sh
FRAMEWORK_PRIVATE_DNS_SPIKE_TEST=1 npm --workspace aws-studio test
```

In PowerShell set `$env:FRAMEWORK_PRIVATE_DNS_SPIKE_TEST = '1'` first. Set
`FRAMEWORK_PRIVATE_DNS_SPIKE_BUILD=1` only when image preparation is also intended.
Ordinary `npm run verify` does not create Docker or AWS resources.

## Boundaries under test

One immutable test topology drives local projections and the standalone CDK
specimen: two private views of one namespace, a zone shared by both VPCs, nested
zones, parent shadowing, an outside view, UDP/TCP DNS, distinct HTTP endpoints and
granted/denied callers. The shared zone resolves to VPC A's endpoint in VPC B while
the connection remains denied: association supplies no route or ingress grant.

Each worker shares only its selected anchor's Linux network namespace. A trusted
initializer installs and verifies default-deny nftables rules before a supervisor
loads a handler. Applications run as UID 1000 with capabilities dropped and
`no-new-privileges`, without the management volume or registration nonce.
The broker uses a caller-bound Unix socket inside a Docker named volume. Node IPC
remains between each supervisor and its actual child.

The experiment asserts raw DNS negatives and alias identity, independent VPC
answers, unmodified `fetch()` and `curl`, warm reuse, backend/wrong-port denial,
missing grants, cross-VPC denial, host-gateway denial and backend failure without
deleting DNS. Actual privileges and registration inventory are checked rather
than inferred solely from launch arguments.

Select an optional controlled public IPv4 TCP endpoint explicitly:

```sh
npm run private-dns:spike -- local --external-ipv4 <public-test-address> --external-port <port>
```

Without it, controlled external IPv4 reachability remains unverified. This option
does not certify NAT source identity, every UDP behavior or arbitrary internet
services. The identity-only broker does not claim task/workflow/database adapters.
Cache aging, live policy reconciliation, ALB distributed behavior, authentication,
IPv6, VPC endpoints and real public/private overlap remain separate gates. SOA
defaults and DNS flags await AWS calibration.

## Offline AWS specimen and comparison

The [CDK tests](../../packages/aws-studio/test/cdk/private-dns-parity.test.ts) synthesize the
standalone specimen (`cdk-app/test/support/private-dns-parity-fixture.ts` in the app) in
two explicit fixture modes. It stages identical probe bytes and template VPCs,
internal ALBs/ECS services, private zones and granted/denied Lambda callers. It
does not import or change the application's CDK entrypoint.

The test specimen defaults to a fake account and `deploymentReady: false`.
Fixture modes do not establish application dev/prod graph behavior. A real run
still requires an explicitly authorized test account/region, bounded
provisioning/cleanup and independently captured AWS receipts. Private-only zones
can use a valid unregistered suffix such as `internal.parity.test`; public domain
ownership is not a private-zone requirement. Creating controlled public DNS
records for overlap/fallback tests requires ownership or delegated write
authority; read-only public DNS probes do not.
No automatic AWS deployment command is supplied by this experiment.

Prepare an account-bound offline artifact using an explicit profile:

```sh
npm run private-dns:aws-plan -- --profile dev
```

This command reads the profile's region, verifies identity through its explicit
regional STS endpoint, then synthesizes a uniquely named disposable stack. It
creates a new private artifact directory containing `plan.json`, source and
artifact hashes, the assembly, probe bytes and a resource inventory. It does not
publish assets, deploy, invoke application functions or modify AWS resources.
`deploymentReady` and `releaseAuthorized` remain false. The plan lists missing
cost, permission, deployment, observation and teardown gates. A future cloud test
authorization can cover the complete deploy/test/cleanup lifecycle.

The AWS specimen includes an outside-VPC caller but covers a subset of the local
scenarios. It still needs controlled backend failure and a NAT-enabled caller for
the optional positive internet test; its current VPCs have no NAT. The future runner
must complete those projections and collect real observations before comparing
the complete cross-environment contract.

```sh
npm run private-dns:spike -- compare --contract contract.json --local local-evidence.json --aws aws-evidence.json --endpoint-maps endpoint-maps.json
```

Endpoint maps use `{ "local": { "<address>": "alb-a" }, "aws": { "<address>": "alb-a" } }`.
The comparator rejects missing AWS data, stale hashes, wrong runtimes, incomplete
scenarios and semantic differences. Addresses map to logical endpoints; RCODEs,
answer types, flags, TTLs and connection outcomes are not normalized away. SOA
comparison covers owner, class, serial, refresh, retry, expire, MINIMUM and observed
negative TTL; provider-specific MNAME/RNAME identities are excluded. Fresh positive
and negative TTL comparisons allow two seconds of measurement skew, without
certifying cache aging. Matching files report only `evidence-matches`, always with
`releaseAuthorized: false`. Self-reported metadata is not cryptographic attestation
and cannot replace the future trusted AWS runner's receipts.

`comparison-contract.json` and `comparison-local-evidence.json` omit local-only
host-gateway safety checks from the cross-environment set. Direct-IP probes use
explicit request endpoint identities, so different addresses are acceptable only
when they map to the intended resource; a different known target still fails.

## Remaining release gates

Do not enable or claim production-equivalent local execution until the spike
passes on supported macOS/Windows Docker setups and actual AWS. Authoring and CDK
ownership/grants are implemented separately; scoped execution across every lane,
binding adapters, reconciliation and the full differential matrix remain gates.

The selected first release is owned A aliases to internal ECS ALBs, HTTP, explicit
caller grants, supported IPv4 egress and existing bindings. Unsupported paths fail
explicitly. Participating VPCs with **any enabled gateway or interface endpoint
are ineligible**. The current application VPC enables S3/DynamoDB endpoints and
remains unchanged and ineligible for the future strict profile.

No local-only result, synthesized template, mocked test, matching evidence file
or installation check is sufficient to claim production parity.

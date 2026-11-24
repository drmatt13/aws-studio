# EC2 instance implementation report

Date: November 13, 2026. Status: proposed implementation; EC2 support is not implemented.

Add **EC2 instance** to **Add to application** as a new framework workload kind. A literal
`framework-config/workloads/ec2.ts` section should drive Studio, production CDK and the
selected local runtime through the existing framework pipeline. This preserves
`framework.config.ts` as the composition root and keeps Studio optional.

Production runs one standalone EC2 instance and owns its EC2 instance type. Development
should offer two explicit local runtimes: a generic Linux **container**, or an **AMI-backed
virtual machine** managed through QEMU. The VM option downloads the selected development
image's readable disk contents into `.cache/ec2/` and boots a local guest OS. This makes
the dev AMI an executable input without deploying a dev-account EC2 instance. QEMU can
run inside a container, although a native host process is preferable for acceleration
on macOS. No new CPU emulator is needed.

Development and Production retain separate account/region-scoped AMI selections and
bootstrap scripts. In container mode, the dev AMI remains optional reference metadata.
In VM mode, it is required and must pass acquisition and boot compatibility checks.
Deliver the generic container first if needed, but qualify the VM path with a focused
spike before promising that arbitrary account AMIs will boot locally.

## Requested behavior and initial scope

| Request | Proposed behavior |
| --- | --- |
| EC2 in the add menu | A first-class EC2 instance creator, map target and Inspector |
| AMI dropdowns for the respective accounts | Independent Development and Production lookups through their saved AWS connections and selected deployment targets |
| Different settings by declaration mode | Literal mode-specific AMI bindings and bootstrap file references, evaluated without live AWS calls |
| Instance size only in Production | `cloud.instanceType`, required for cloud-enabled production deployment; absent from local sizing |
| Different user data | Development shell script executed inside the local container; Production shell script delivered as EC2 user data |
| Generic development container | A pinned Linux image and foreground command, managed by the existing Compose lifecycle |
| Boot the development AMI locally | Optional QEMU runtime with a downloaded disk cache, fresh writable overlay and development user data; image and host compatibility must be demonstrated |
| No autoscaling or custom permissions yet | One On-Demand instance per declaration; no ASG or application IAM/grant editor |

Start with Linux, EBS-backed, HVM images on `x86_64` or `arm64`. User data initially accepts
shell scripts. Windows, arbitrary cloud-init documents, image baking/copying, SSH setup,
SSM access, public HTTP routing, load balancers, extra data disks, database capabilities
and workflow invocation are later features. The AMI download/VM qualification below is
a separate local-runtime increment within the same workload design.

“Generate different AMIs” should mean **generate different configured AMI references**.
Selecting an existing image does not build, copy or promote an AMI. AMIs identify boot
software and are specific to a region and architecture; they must match the instance
type. See [AWS AMI concepts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AMIs.html).

## How the repository wires workloads today

The current path is:

```text
framework-config/workloads/<kind>.ts + imported resource/network declarations
    -> framework.config.ts literal section arrays
    -> framework configuration validation and normalization
         -> CDK target selection, construction and completeness checks
         -> local selection, generated Compose and runtime launchers
         -> generated target/route contracts
         -> Studio dev/prod projection, map, Inspector and source review
```

The relevant source owners are:

| Responsibility | Existing source and implications for EC2 |
| --- | --- |
| Composition and application types | `framework.config.ts`, declaration layout (`framework-config/README.md` in the app), `workload-types.ts`: add an imported `ec2` module, `ec2: [ec2]`, and a type-only `Ec2Section` |
| Canonical framework model | [config/index.ts](../../packages/aws-studio/src/config/index.ts): target kinds currently cover Lambda, service, task, workflow and agent; extend types, section flattening/merging, normalization, reference parsing and target selection |
| Mode and lane semantics | [config/deploy.ts](../../packages/aws-studio/src/config/deploy.ts): `local`/`cloud` are lanes; `dev`/`prod` are graph modes; `DEV_GRAPH_ROLES` currently includes only events |
| Source and artifact inventory | [config-source.ts](../../packages/aws-studio/scripts/config-source.ts), [config/source.ts](../../packages/aws-studio/src/config/source.ts), [generate-contracts.ts](../../packages/aws-studio/scripts/generate-contracts.ts): explicit section ownership, source containment, artifacts and generated projections |
| CDK construction | [framework-composition.ts](../../packages/aws-studio/cdk/framework-composition.ts), [framework-target-registry.ts](../../packages/aws-studio/cdk/framework-target-registry.ts), `app.ts`: factories construct declared targets and check registry completeness |
| VPC placement | [framework-network.ts](../../packages/aws-studio/cdk/framework-network.ts): imported network identity, deployment-wide account/region, lazy production VPC construction; dev VPC access explicitly throws |
| Local services | [compose-services.ts](../../packages/aws-studio/scripts/compose-services.ts), `docker-compose.yml`, [dev.mjs](../../packages/aws-studio/cli/dev.mjs): declarations generate Compose services, with project ownership, startup and cleanup managed centrally |
| Studio read model | [model/project.ts](../../client-app/server/model/project.ts), [shared/model.ts](../../client-app/shared/model.ts): source-derived compute, placement and availability facts for each mode |
| Studio creation | [shared/creation.ts](../../client-app/shared/creation.ts), [AddMenu.tsx](../../client-app/src/views/AddMenu.tsx), [CreationWizard.tsx](../../client-app/src/views/CreationWizard.tsx), [edits/creation.ts](../../client-app/server/edits/creation.ts): typed forms, server validation and proposed source changes |
| Reviewed generation | [creation-generation.ts](../../client-app/server/edits/creation-generation.ts), [batch.ts](../../client-app/server/edits/batch.ts): disposable preview, real generators, input hashes, review/apply and guarded recovery |
| AWS destination | [deploy/context.ts](../../client-app/src/deploy/context.ts), [connection-generations.ts](../../client-app/src/connection-generations.ts), [aws-connections/service.ts](../../client-app/server/aws-connections/service.ts): mode connection, named target, destination pins and credential-generation invalidation |

The current services API couples services to public route mounts, ports and npm `dev`
scripts. Tasks run to completion through invocation bindings. EC2 is a persistent host
with a local substitute, so neither declaration is a good fit. A native stack could
construct EC2 today, but that alone would omit the first-class local runtime, creator,
placement and Inspector contracts requested here.

## Development and Production semantics

Preserve the existing deployment tokens and answer availability in the framework, then
project those answers into Studio. For EC2, the proposed matrix is:

| Declaration policy | Local Development | Dev AWS deployment | Prod AWS deployment |
| --- | --- | --- | --- |
| `both` | Selected container/VM runtime with dev bootstrap | No EC2 instance | EC2 with prod AMI, size and bootstrap |
| `local-only` | Selected container/VM runtime with dev bootstrap | No EC2 instance | No EC2 instance |
| `cloud-only` | Disabled | No EC2 instance | EC2 with prod AMI, size and bootstrap |
| `none` | Disabled | No EC2 instance | No EC2 instance |

Conditional deployment should reuse `deploy.when` and its current input resolution. A
local-only declaration needs no production AMI, VPC or instance type. A cloud-enabled
declaration requires complete production settings. Selecting Production in Studio changes
the source projection; it must not launch production bootstrap locally.

Keep the Development AMI selector in the Development configuration card. In container
mode, label it **Development AMI reference — not used by the local container** and allow
it to remain unset. In VM mode, label it **Development boot image**, show download/boot
compatibility separately from EC2 launchability, and use it to prepare the local disk.
Never silently replace a failed VM boot with the generic container. Production always
consumes its own binding; there is no fallback from an unset prod image to the dev image.

If actual dev-account EC2 is required, make that an explicit additional feature. It needs
dev VPC construction, a dev instance type, cloud/local selection rules and updates to
availability, ownership, planning, status, teardown and development exports. Simply adding
`ec2` to `DEV_GRAPH_ROLES` would still fail at `frameworkVpc`. Instance sizing is a
**cloud-only** concern in that design, with separate dev/prod values, rather than a
production-only concern. An independent named target using prod semantics is already an
option for a cloud test environment; it uses prod declaration settings and does not turn
the local Development mode into a second cloud model. See [environment semantics](../aws-studio-knowledge/deployment/environments.md).

## Proposed declaration shape

The following is a proposed API, not currently valid configuration. `imageId`, image
metadata, account IDs and the container digest below are illustrative placeholders.

```ts
// framework-config/workloads/ec2.ts
import { applicationVpc } from "../networks/application";
import type { Ec2Section } from "../workload-types";

export const ec2 = {
  "worker-host": {
    directory: "/ec2_instances/worker-host",
    deploy: "both",
    tags: { area: "workers" },
    userData: {
      dev: { file: "bootstrap.dev.sh" },
      prod: { file: "bootstrap.prod.sh" },
    },
    local: {
      runtime: "container",
      image: "debian:bookworm-slim@sha256:<reviewed-digest>",
      architecture: "x86_64",
      command: ["sleep", "infinity"],
    },
    cloud: {
      constructId: "WorkerHost",
      vpc: applicationVpc,
      subnet: "private",
      instanceType: "t3.small",
      images: {
        dev: [{
          account: "111122223333", // account that will consume the image
          region: "us-east-1",
          imageId: "ami-<dev-image>",
          ownerAccount: "111122223333",
          architecture: "x86_64",
          rootDeviceName: "/dev/xvda",
          minimumRootVolumeGiB: 8,
        }],
        prod: [{
          account: "444455556666",
          region: "us-east-1",
          imageId: "ami-<prod-image>",
          ownerAccount: "444455556666",
          architecture: "x86_64",
          rootDeviceName: "/dev/xvda",
          minimumRootVolumeGiB: 8,
        }],
      },
    },
  },
} satisfies Ec2Section;
```

The root imports the module and composes `ec2: [ec2]`. Add `FrameworkEc2` to the framework
types and derive `Ec2Section` from the application's catalog if references are supported.
Use target kind/role `ec2` and stable reference `ec2:worker-host` throughout the system.

Image arrays allow multiple named targets of the same mode to use different accounts or
regions without introducing another deployment mode. Resolve exactly one binding for
`(mode, deployment account, deployment region)`. Reject duplicate bindings and missing
matches; never silently select the first image. Keep consuming account separate from
owner account so shared images work. Do not persist AWS profile names in application
declarations; they remain machine-local connection settings.

Store script paths relative to the workload directory. Node-side artifact readers resolve
them and enforce containment, regular files and symlink refusal. Keep filesystem reads
out of browser-safe declaration modules. Model EC2's artifact requirements explicitly;
the current sourced-target sweeps must not mistake it for a Lambda handler, npm service,
task Dockerfile or agent contract. Container architecture is independent of an unused
dev AMI and is pinned for reproducible Docker execution. VM architecture comes from the
selected development AMI; the local host's acceleration support is checked separately.

## AMI discovery and instance size

Add a read-only host service, for example `server/ec2/catalog.ts`, and a typed browser
adapter. Reuse the existing AWS CLI process, profile environment and error handling
patterns rather than adding a browser AWS SDK or another credential store. Existing
[aws-cli.ts](../../packages/aws-studio/cli/aws-cli.ts) supplies JSON calls and pagination support;
Studio's [identity service](../../client-app/server/identity/service.ts) demonstrates
bounded CLI execution. The new reader needs cancellation, timeouts, bounded pages and
sanitized diagnostics.

Resolve the requested mode's saved connection and selected named target, observe the
actual STS account, apply the target's region pin, and reject account mismatches. Image
discovery must work before any application stack is deployed. Key cached results by
mode, target, profile generation, actual account, region, filters, search and page. Discard
late responses after any destination change. Development and Production may share a
profile without sharing the wrong target's results.

Use a searchable dropdown with explicit scopes:

- **Owned by this account**, the default, uses `DescribeImages` with `Owners=self`.
- **Shared with this account** uses the API's executable-user scope; combine/deduplicate
  results with owned images where necessary.
- **Amazon images**, an optional separate scope, uses `Owners=amazon` rather than querying
  the entire public catalog.

Filter to supported images and `state=available`; inspect deprecation/disabled/Allowed
AMIs evidence. Owned deprecated images can appear even when deprecated inclusion is off,
so inspect returned metadata too. Paginate and sort deterministically. Show image name,
ID, owner, architecture and creation date. AWS documents visibility and pagination in
[DescribeImages](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeImages.html).

Persist the selected image's immutable ID and required public metadata in reviewed
source. Do not resolve “latest” during normal generation or synth. Selection is a read;
changing the configured image is a source edit. Catalog outages must leave existing
declarations inspectable and offline checks usable. Manual image IDs can be authored in
source, but require the same selected-target validation before deployment.

For Production size, show instance types with vCPU, memory and architecture from
[DescribeInstanceTypes](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypes.html).
Validate architecture, boot mode, virtualization and root-volume compatibility, plus
image-specific instance restrictions where provided. Check regional/AZ offerings when
placement is resolved using [DescribeInstanceTypeOfferings](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceTypeOfferings.html).
An offering is not a capacity reservation or proof that launch will succeed. Avoid a
hard-coded list or a universal cheapest/default size. Local configuration has no EC2
size field and does not pretend to simulate its CPU or memory.

During deployment planning, re-describe the exact image and type in the verified
destination. Bind that evidence to the saved plan, recheck accessibility before execution,
and invalidate approval if relevant metadata changes. Listing an encrypted shared AMI
does not prove its backing snapshots/KMS keys are usable. Report such launch prerequisites
without adding application permission configuration to this feature.

## User data and the local container

Use separate tracked `bootstrap.dev.sh` and `bootstrap.prod.sh` files. The creator writes
small starters; the Inspector links to source and offers a bounded multiline editor
through the existing reviewed transaction. Current creation text fields reject newlines
and normally cap strings at 500 characters, so user data needs a dedicated field/parser
and fixed script destinations. Do not relax every string field's validation.

Production loads the script bytes as EC2 user data. Enforce the 16 KiB unencoded limit
against the complete rendered payload, including any framework additions. Keep secret
values out of user data, source diffs and logs. AWS treats user data as opaque content;
the image needs a working launch agent/cloud-init setup to execute it. A Linux label
alone does not prove that prerequisite. See [EC2 user data](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html).

Choose deterministic replacement when Production user data changes, using CDK's
`userDataCausesReplacement: true`, and show that replacement in the deployment review.
Otherwise an EBS-backed instance can restart with updated user data without executing
the new script. This flag deliberately changes the logical ID based on user data;
preserve the stable declaration/construct identity while testing that this specific
replacement is expected. A single instance provides no rolling availability guarantee.
See [CDK InstanceProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.InstanceProps.html).

Locally, execute the development script inside the declared container, then `exec` its
foreground command. Initial starters can use a generic keep-alive command; an actual
workload supplies its foreground process. A failed bootstrap must produce a failed
container/startup observation, not a healthy idle shell. The local script must be
idempotent: run it once per container start, including restart, and explain that this
differs from EC2's usual first-launch behavior. Require shell-compatible development
scripts rather than claiming to run arbitrary cloud-init YAML in Docker.

Extend generated Compose with a dedicated `x-framework-ec2` template and a cohesive EC2
derivation/launcher helper. It can share the existing `docker-compose.services.yml`
output and generator ownership. The current `x-framework-service` path requires npm
workspace/dev-script/HTTP-port facts and cannot accept an arbitrary Linux image as-is.
An EC2 substitute should need no `package.json`, service route or listening port.

Bootstrap runs inside the container; review/generation never executes it on the host.
Use read-only bootstrap mounts, ordinary Docker networking, no privileged container or
Docker-socket mount, and no default AWS credential mount. Recreate/restart the local
container when its dev script/image/command changes; a production-only script or AMI
change must not restart it. Integrate existing Compose ownership, status and logs. New
image-build paths must carry framework ownership labels and join scoped, unforced
cleanup. Never mount the checkout over image-owned dependencies.

The container substitute supplies application development behavior, not the AMI's kernel, systemd, cloud-init,
instance metadata, IAM enforcement, EBS or VPC routing. Show local process status
separately from cloud EC2 status. Neither “container running” nor “EC2 running” proves
the production bootstrap or application completed successfully.

## Booting an AMI locally with QEMU

The achievable architecture is a local virtual machine built from an AMI's disk contents.
An AMI is a descriptor plus backing storage, rather than a Docker image or a single
universally downloadable file. QEMU supplies CPU/device emulation and virtualization;
the framework supplies image acquisition, lifecycle, user-data delivery and observations.
Its [system emulator](https://www.qemu.org/docs/master/system/introduction.html) already
supports Linux KVM, macOS HVF, Windows WHPX and software emulation through TCG.

```text
Development profile + selected account/region + AMI
    -> image metadata + root EBS snapshot
    -> authorized disk acquisition
    -> .cache/ec2/<account>/<region>/<ami>/<snapshot>/base.raw
    -> immutable verified base + writable qcow2 overlay + boot seed
    -> QEMU guest OS + development user data + serial/health observations
```

### Acquiring the disk

There are two distinct implementation routes:

| Route | Implementation and boundaries |
| --- | --- |
| EBS direct snapshot reads | Resolve the AMI's root snapshot, paginate `ListSnapshotBlocks`, fetch `GetSnapshotBlock` data and reconstruct a sparse raw disk at the reported offsets/size. Verify block checksums, handle token expiry/retries and retain resumable progress. These read APIs avoid creating an EC2 instance or export bucket, but need snapshot permissions; AMI launch permission alone is insufficient |
| VM Import/Export | Start `ExportImage`, wait for completion, download the resulting RAW/VMDK/VHD file from a same-account S3 bucket and convert if needed. This creates an AWS export task and S3 objects and requires its service-role/bucket prerequisites. It is a separate authorized operation rather than a background effect of opening the AMI dropdown |

AWS documents the direct read sequence in [Read snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/readsnapshots.html).
`GetSnapshotBlock` also supports encrypted snapshots when the caller can use their KMS
key; plaintext disk contents then become private local data. See [GetSnapshotBlock](https://docs.aws.amazon.com/ebs/latest/APIReference/API_GetSnapshotBlock.html).
Scope the local downloader's permissions to the intended snapshots; these are developer
profile capabilities, separate from custom IAM permissions granted to the EC2 workload.

The export service has different restrictions: encrypted snapshots, images shared from
another account and Marketplace-derived images are among its excluded cases. A dropdown
entry therefore cannot imply exportability. These restrictions apply to VM Import/Export;
they do not establish the behavior of every direct-snapshot-read case. See [image export
limitations](https://docs.aws.amazon.com/vm-import/latest/userguide/limits-image-export.html).

Start qualification with an owned, single-root-disk Linux AMI whose snapshot the dev
profile can read. Probe exact permissions and image eligibility; do not promise arbitrary
public/shared/Marketplace images. Downloading reconstructs disk contents and does not by
itself prove the image can boot on QEMU hardware.

### Boot compatibility and user data

Match guest architecture, BIOS/UEFI firmware, bootloader, kernel and disk/network drivers.
An EC2 image may depend on Nitro/Xen devices, AWS-specific networking or an EC2-only
cloud-init datasource. Validate each supported image family; do not treat an AMI's Linux
or HVM flag as a local-boot guarantee.

For compatible images, attach a cloud-init NoCloud seed disk containing the development
user data and a local instance ID. NoCloud can supply metadata and user data locally;
see [NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html).
If the guest's datasource configuration or first-boot state needs preparation, make a
versioned transformation in a derived overlay and identify the result as a local
derivative of the AMI. Preserve the downloaded base. Begin with images already prepared
for NoCloud rather than inventing a complete EC2 metadata server.

A thin metadata adapter may be needed later for specific software. It must not invent
production IAM credentials or claim to emulate IAM, VPCs, EC2 APIs or Nitro. Guest network
access to Compose dependencies and incoming local application ports also needs explicit
forwarding; Docker service DNS names do not automatically resolve inside a separate VM.

### Host runtime and local sizing

| Host | Proposed QEMU execution |
| --- | --- |
| Native Linux | Native QEMU/KVM; a containerized QEMU runner can use an explicitly provided `/dev/kvm` when available |
| macOS | Native QEMU/HVF for a compatible guest architecture. A Linux Docker container runs inside Docker Desktop's Linux VM and cannot directly use the macOS HVF accelerator; probe nested KVM availability rather than assuming it |
| Windows | Qualify native QEMU/WHPX or a supported WSL/KVM environment. Select from observed capability; retain explicit software emulation as an option |
| Different host/guest CPU architectures | QEMU TCG software emulation; measure boot and workload latency before treating it as an acceptable default |

The native-versus-container recommendation follows QEMU's accelerator support and
[Docker Desktop's VM architecture](https://docs.docker.com/desktop/features/vmm/); it is an
engineering design choice requiring platform tests. Prefer a managed native child process
on macOS. A container wrapper remains feasible with software emulation, but adds another
VM boundary and does not guarantee hardware acceleration.

Keep the EC2 instance type Production-only. A local VM nevertheless needs a RAM/vCPU
budget; these are local machine settings rather than an emulated `t3.small` SKU. A
proposed alternative to the earlier container block is:

```ts
local: {
  runtime: "ami-vm", // consumes the dev image binding and dev user data
  cpus: 2,
  memoryMiB: 2048,
}
```

These values are illustrative defaults for qualification, not a performance promise.
Own the VM through the existing local lifecycle coordinator with process-tree cleanup,
QMP control, boot timeout, serial logs and explicit readiness. Stopping/restarting a guest
preserves its overlay; **Reset local instance** creates a fresh overlay and instance ID
so first-boot user data runs again. A bootstrap edit should offer/reset that local
instance rather than pretending an ordinary VM restart reruns cloud-init.

### Cache ownership and qualification

Use `.cache/ec2/` exactly as a scoped, ignored private artifact directory. Cache keys
include consuming account, region, AMI ID, snapshot IDs, disk hashes and transformation
version. Download to partial files, atomically publish verified bases, lock in-use images
and create per-instance writable overlays. Restrict file access and never copy disk
contents into source reviews, generated contracts or browser responses. Guest disks may
contain private application data; cache status should report metadata and byte usage.
Warm starts should reuse a verified cached base without downloading it again; a missing
or corrupt base requires explicit acquisition before boot.
Preserve active overlays and unrelated `.cache` journals; cleanup is specific to this
owner. See [repository hygiene](../REPOSITORY-HYGIENE.md).

Before committing to the AMI runtime, demonstrate one dev-account image from acquisition
through local boot on the primary development host, with a development user-data marker,
restart/reset behavior, serial logs and clean stop. Then qualify supported host/guest
architectures, denied snapshot/KMS reads, interrupted downloads, corrupt blocks,
unsupported firmware/drivers/datasources and bounded disk growth. Report measured cold
download/boot time and warm boot time. Keep the generic container available as an
explicitly selected runtime while this compatibility matrix is built.

## CDK construction and lifecycle

Add an `Ec2InstancesStack` and composition factory using the normalized cloud-enabled
EC2 targets selected for Production. Construct one `ec2.Instance` per target with:

- The explicitly imported network through `frameworkVpc`, declared subnet tier and a
  deterministic single-subnet selection.
- A pinned image, for example through `MachineImage.genericLinux` with the selected
  region's ID, and the configured instance type.
- Framework-owned security group with no inbound rules, required IMDSv2, and no
  application IAM policies. If CDK creates an instance role/profile, leave it without
  application grants. Account permissions used for discovery/deployment are separate.
- An encrypted, delete-on-termination EBS root volume, at least the selected image's
  snapshot size, using its root-device name. Preserve valid AMI mappings; refuse extra
  disks in the initial scope instead of silently destroying or promising to retain data.
- Stable `cloud.constructId`, deployment-prefixed stack/output identities, declaration
  tags and primary/supporting ownership through `markInfrastructure`.

Offer explicit public/private/isolated placement using the existing network tiers. Keep
public IPv4 assignment an explicit cloud setting, initially off. A public subnet alone
must not imply inbound access. Private bootstrap package downloads need the declared
network's compatible egress; AWS-service endpoints do not supply general internet access.
Do not automatically enable NAT, allocate an address or change a network declaration.

Extend the CDK target registry and completeness checks so a selected `ec2:<id>` is built
exactly once and omitted targets are explained. Add the factory before completeness
validation. Extend inventory ownership and verify generic deployment/status/drift/teardown
handling for EC2, its volumes and supporting constructs. No `runTask` or workflow
descriptor is needed for a persistent host.

Treat the first version as disposable compute: image/bootstrap changes can replace the
instance and delete its root disk. Display this consequence in review and removal plans.
Retaining durable volumes or restoring a machine is a separate feature. Existing source
removal archives source; cloud deletion still occurs only through an authorized deployment
or teardown. Do not add direct start/stop/terminate buttons in this scope.

## Studio creation and editing

Place **EC2 instance** alongside the container entries in the existing menu. Reuse its
keyboard navigation, focus restoration and source-health blocking. The wizard should
collect identity/tags, local runtime and its image/command or VM budget, Development
bootstrap/AMI, then Production destination/AMI/type, imported VPC/subnet and bootstrap.
Reuse the existing form controls and Inspector environment cards. Show the effective
account/region beside each AMI picker and the Development reference-only explanation.

Extend `CreationRequest`, `CREATORS` and server parsing, plus `planCreation` with fixed
destinations for the declaration and starter files. Add an application-owned EC2 starter
under `framework-config/templates` through the existing scaffolding factory. Include
`cdk-app/ec2_instances` in preview copies, source watches and artifact inventory. Bootstrap
file bytes and chosen template inputs must participate in review hashes, stale-source
checks, apply verification and guarded rollback. A file edit alone must invalidate a
review even if `framework.config.ts` is unchanged.

Add EC2 compute/placement facts to the shared model, source provenance/editability,
Inspector dispatch, map icon/layout/picking, tagging, search, removal and Compose preview.
Keep its local container visible as a Development substitute and its production target
on the selected VPC tier. Existing source always remains authoritative.

AMI controls need loading, empty, denied, expired-session, unavailable-image and success
states. Preserve the saved ID when live lookup fails; display its validation status
without silently clearing it. Offer retry and connection navigation. Switching modes,
targets, profiles or regions must never commit a late result to the other configuration.
Review/Apply saves source only; it neither starts Docker nor deploys EC2.
Preparing a VM adds explicit downloading, verification, booting, ready and failed states;
readable disk access, export eligibility and VM boot compatibility are separate facts.

## Implementation sequence and acceptance

1. **Framework contract:** implement the literal section, per-mode image bindings,
   normalization, target identity/availability and contained bootstrap artifacts. Add
   generator/source inventory support. Keep HTTP route contracts unchanged.
2. **Production CDK:** add the stack/factory, image/type destination guards, network
   placement, ownership, registry completeness and replacement/storage consequences.
3. **Local execution:** generate the generic container and qualify the QEMU image path
   above before exposing it as supported. Add snapshot acquisition/cache, overlays,
   first-boot seed, host capability probing and VM lifecycle ownership. Integrate each
   runtime's distinct restart/failure/log/status behavior.
4. **Studio projection and editing:** expose EC2 facts, placement and reviewed field/script
   edits before adding the creator. Add read-only AMI/type discovery through mode-specific
   connections, with destination-bound caching and stale-response protection.
5. **Creator:** wire menu, form, template, preview generation, source registration,
   removal/archive, recovery and complete diff review.
6. **Documentation and release checks:** update Framework, declaration layout and the
   affected creation/configuration/local-execution/capability knowledge pages when the
   feature actually ships. Keep this report labeled as a proposal.

Required verification for implementation:

| Layer | Acceptance evidence |
| --- | --- |
| Framework unit tests | Composition/duplicate IDs; EC2 reference parsing; optional local-only cloud settings; mode/account/region resolution; no cross-mode fallback; all deploy policies/conditions; script path/size/symlink failures; unaffected existing target behavior |
| Source/generator integration | EC2 source discovery; bootstrap-only changes invalidate review; generated Compose is deterministic; no invented HTTP routes or Lambda/task payloads; preview contains all EC2 inputs and no private environment values |
| CDK unit/synth | Prod has exactly one declared instance and correct image/type/subnet/root disk/metadata; dev has no EC2 or VPC; disabled declarations are absent; registry completeness; stable identities on unrelated edits; intentional replacement on bootstrap/image changes |
| Studio integration | Parser rejects unsupported fields; exact reviewed diff; stale catalog/destination/source handling; cancellation; no writes before Apply; consumed-plan refusal; rollback/recovery; removal preserves unrelated declarations |
| Browser | Playwright MCP: menu and picker keyboard behavior, focus, desktop/mobile layout, both-mode edits, all lookup states, review/apply and selected EC2 Inspector. Chrome DevTools MCP: reproduce and diagnose console/request/DOM problems in its separate session; close sessions afterward |
| Docker | Real generic container starts, boot marker proves dev script ran, prod script never runs, bootstrap failure is visible, restart/recreate semantics work, shutdown cleans processes, ownership/reconciliation stay scoped |
| Local VM | Real dev-image disk acquisition and checksum verification; compatible QEMU boot; dev cloud-init marker; host acceleration detection; no silent runtime fallback; guest restart versus reset; denied/cancelled/corrupt download paths; clean stop and scoped cache retention |
| Repository gates | `npm run framework:generate`, `npm run verify`, Studio build, documentation link checks, and both explicit dev/prod synth commands from [Framework verification](../FRAMEWORK.md#generated-contracts-and-verification) |
| Deployed checks | With separately authorized targets: real catalog isolation, image accessibility, launch/bootstrap and intended replacement behavior. Record EC2 status separately from application/bootstrap evidence |

This investigation examines source and primary documentation. It does not enumerate
private account AMIs, download disks, boot VMs, execute user data, start containers,
synthesize EC2 infrastructure or deploy anything. Those checks become meaningful after
implementation and, for live changes, authorization for the intended environment.

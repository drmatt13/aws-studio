import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createPrivateDnsParityAwsFixture, PARITY_FIXTURE_OWNER, type AwsParityFixtureOptions } from "./private-dns-parity-fixture";

const execute = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(__dirname, "../../../../..");
const OWNER_FILE = "private-dns-parity-owner.json";
const INTEGRITY_FILE = "integrity.json";

export interface ParityPlanOptions {
  readonly profile: string;
  readonly region?: string;
  readonly mode?: "dev" | "prod";
  readonly stackName?: string;
  readonly zoneName?: string;
  readonly probeArchitecture?: AwsParityFixtureOptions["probeArchitecture"];
}

export interface SourceSnapshot {
  readonly sha256: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export interface PlanPreparationDependencies {
  /** Offline tests inject these dependencies; the CLI supplies none. */
  readonly repositoryRoot?: string;
  readonly runAws?: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<string>;
  readonly captureSources?: () => SourceSnapshot;
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function captureSources(): SourceSnapshot {
  const files = [
    "packages/aws-studio/test/cdk/support/private-dns-parity-fixture.ts",
    "packages/aws-studio/test/cdk/support/private-dns-parity-plan.ts",
    "packages/aws-studio/test/support/private-dns-parity/model.ts",
    "packages/aws-studio/test/support/private-dns-parity/evidence.ts",
    "packages/aws-studio/test/support/private-dns-parity/probe.mjs",
    "package-lock.json",
  ].sort().map(file => ({ path: file, sha256: sha256(readFileSync(path.join(REPOSITORY_ROOT, file))) }));
  return { sha256: sha256(JSON.stringify(files)), files };
}

function officialStsEndpoint(region: string): string {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region) || /^(?:cn-|us-gov-|us-iso)/.test(region)) throw new Error("The Phase 0 preparation path supports an explicit commercial AWS region.");
  return `https://sts.${region}.amazonaws.com`;
}

function readOnlyAwsEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true" };
  for (const name of Object.keys(environment)) if (/^AWS_ENDPOINT_URL(?:_|$)/.test(name)) delete environment[name];
  return environment;
}

async function nativeReadOnlyAws(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<string> {
  const result = await execute("aws", [...args], { env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1_048_576 });
  return result.stdout;
}

function mkdirWithoutLinks(directory: string): void {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Artifact directory components must be ordinary directories, never symlinks.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(directory, { mode: 0o700 });
  }
}

function newArtifactDirectory(repositoryRoot: string, id: string): string {
  let directory = realpathSync(repositoryRoot);
  for (const component of [".framework", "artifacts", "private-dns-parity"]) {
    directory = path.join(directory, component);
    mkdirWithoutLinks(directory);
  }
  const destination = path.join(directory, id);
  mkdirSync(destination, { mode: 0o700 }); // Exclusive creation: never reuse/rewrite a previous artifact.
  return destination;
}

function artifactFiles(directory: string): { readonly path: string; readonly sha256: string }[] {
  const files: { path: string; sha256: string }[] = [];
  function visit(folder: string): void {
    for (const name of readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const relative = path.relative(directory, file).split(path.sep).join("/");
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Prepared artifacts cannot contain symlinks.");
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) { if (relative !== INTEGRITY_FILE) files.push({ path: relative, sha256: sha256(readFileSync(file)) }); }
      else throw new Error("Prepared artifacts cannot contain special files.");
    }
  }
  visit(directory);
  return files;
}

function writeJsonExclusive(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export function verifyPrivateDnsParityPlan(directory: string): { readonly valid: boolean; readonly sha256?: string; readonly reason?: string } {
  try {
    if (lstatSync(directory).isSymbolicLink() || lstatSync(path.join(directory, INTEGRITY_FILE)).isSymbolicLink()) throw new Error("Artifact paths must not be symlinks.");
    const ownerStat = lstatSync(path.join(directory, OWNER_FILE));
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) throw new Error("Artifact ownership marker must be a regular file.");
    const owner = JSON.parse(readFileSync(path.join(directory, OWNER_FILE), "utf8"));
    const integrity = JSON.parse(readFileSync(path.join(directory, INTEGRITY_FILE), "utf8"));
    if (owner.owner !== PARITY_FIXTURE_OWNER || owner.id !== path.basename(directory) || integrity.schemaVersion !== 1) throw new Error("Artifact ownership or integrity schema differs.");
    const actual = artifactFiles(directory);
    const digest = sha256(JSON.stringify(actual));
    if (JSON.stringify(integrity.files) !== JSON.stringify(actual) || integrity.sha256 !== digest) throw new Error("Artifact file set or bytes changed; prepare a new artifact.");
    return { valid: true, sha256: digest };
  } catch (error) { return { valid: false, reason: error instanceof Error ? error.message : "Invalid prepared artifact." }; }
}

/** Only configure/STS reads are executed. Synthesis is isolated from the app. */
export async function preparePrivateDnsParityPlan(options: ParityPlanOptions, dependencies: PlanPreparationDependencies = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@+=,-]{0,127}$/.test(options.profile)) throw new Error("A literal AWS profile name is required.");
  const mode = options.mode ?? "dev";
  if (!["dev", "prod"].includes(mode)) throw new Error("Mode must be dev or prod.");
  const snapshot = dependencies.captureSources ?? captureSources;
  const sources = snapshot();
  const runAws = dependencies.runAws ?? nativeReadOnlyAws;
  const environment = readOnlyAwsEnvironment();
  const region = options.region ?? (await runAws(["configure", "get", "region", "--profile", options.profile], environment)).trim();
  const endpoint = officialStsEndpoint(region);
  let identity: { Account?: string; Arn?: string };
  try {
    identity = JSON.parse(await runAws(["sts", "get-caller-identity", "--profile", options.profile, "--region", region, "--endpoint-url", endpoint, "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt"], environment));
  } catch { throw new Error("Read-only AWS identity verification failed; no cloud resources were changed."); }
  if (!identity || typeof identity !== "object" || !/^\d{12}$/.test(identity.Account ?? "") || !/^arn:aws:(?:iam|sts)::\d{12}:.+/.test(identity.Arn ?? "") || identity.Arn!.split(":")[4] !== identity.Account) throw new Error("STS returned an invalid or inconsistent commercial-account identity.");
  if (snapshot().sha256 !== sources.sha256) throw new Error("Fixture inputs changed during identity verification; prepare again. No artifact was created.");

  const nonce = randomUUID().replace(/-/g, "").slice(0, 12);
  const id = `aws-plan-${new Date().toISOString().replace(/[-:.]/g, "")}-${nonce}`;
  const stackName = options.stackName ?? `phz-parity-${mode}-${nonce}`;
  if (!/^phz-parity-[A-Za-z0-9-]{1,116}$/.test(stackName) || stackName.length > 128) throw new Error("Disposable stack names must start with phz-parity- and contain at most 128 letters, digits, or hyphens.");
  const directory = newArtifactDirectory(dependencies.repositoryRoot ?? REPOSITORY_ROOT, id);
  writeJsonExclusive(path.join(directory, OWNER_FILE), { schemaVersion: 1, owner: PARITY_FIXTURE_OWNER, id, createdAt: new Date().toISOString() });
  try {
    const built = createPrivateDnsParityAwsFixture({ directory, mode, zoneName: options.zoneName, probeArchitecture: options.probeArchitecture, target: { account: identity.Account!, region, stackName } });
    const assembly = built.app.synth();
    if (assembly.stacks.length !== 1 || assembly.stacks[0]!.environment.account !== identity.Account || assembly.stacks[0]!.environment.region !== region) throw new Error("Synthesized fixture target differs from verified STS identity.");
    if (snapshot().sha256 !== sources.sha256) throw new Error("Fixture inputs changed during synthesis; this artifact is invalid and must not be used.");
    const template = assembly.stacks[0]!.template;
    const inventory = Object.entries(template.Resources ?? {}).map(([logicalId, resource]) => {
      const value = resource as { Type: string; DeletionPolicy?: string; UpdateReplacePolicy?: string };
      return { logicalId, type: value.Type, deletionPolicy: value.DeletionPolicy ?? "Delete", updateReplacePolicy: value.UpdateReplacePolicy ?? "Delete" };
    }).sort((a, b) => a.logicalId.localeCompare(b.logicalId));
    const resourceCounts = inventory.reduce<Record<string, number>>((counts, resource) => { counts[resource.type] = (counts[resource.type] ?? 0) + 1; return counts; }, {});
    const plan = {
      schemaVersion: 1, kind: "private-dns-parity-aws-preparation", id,
      deploymentReady: false, releaseAuthorized: false, cloudMutationsPerformed: false,
      target: { profile: options.profile, account: identity.Account, region, stackName, principalArn: identity.Arn, stsEndpoint: endpoint, verifiedAt: new Date().toISOString(), liveStackId: null },
      mode, privateZoneName: built.fixture.zoneName, publicDomainOwnershipRequired: false,
      sources, probeSha256: built.probeHash, installedCdkVersion: JSON.parse(readFileSync(require.resolve("aws-cdk-lib/package.json"), "utf8")).version,
      inventory, resourceCounts,
      missingGates: [
        "Explicit cloud mutation authorization for this account, region and disposable stack; this preparation is not authorization.",
        "Cost review: ALBs, Fargate tasks/public IPv4, Lambda, logs, asset storage and startup dependencies have not been priced.",
        "Least-privilege deployment permissions and IAM/PassRole review; no deployment role or policy was created.",
        "Real availability-zone, image availability, bootstrap and asset-publication checks; synthetic AZ names are offline assumptions.",
        "Deployment and live health evidence, verified Lambda invocation/fixture provenance, and local/AWS differential results.",
        "Explicit authorization covering teardown and verified cleanup/cost-cessation evidence; no cleanup of AWS resources was attempted.",
      ],
      teardownRequirements: {
        expectedOwner: PARITY_FIXTURE_OWNER, expectedStackName: stackName,
        requireReviewedLiveStackId: true, requireOwnershipAndDependencyRecheck: true,
        requireResourceInventoryBeforeAndAfter: true,
        preservePreexistingBootstrapResources: true,
        note: "Delete only the explicitly authorized disposable stack/resources after reviewing its actual deployed identity. Never purge the account, bootstrap bucket, or unrelated resources.",
      },
      unverifiedBehavior: ["Actual AWS DNS flags/negative SOA values", "Positive/negative cache aging and updates", "HTTP failure/health/timing behavior", "Controlled positive public fallback (separate optional extension; no public zone is required for this private-only specimen)"],
    };
    writeJsonExclusive(path.join(directory, "plan.json"), plan);
    const files = artifactFiles(directory);
    const artifactSha256 = sha256(JSON.stringify(files));
    writeJsonExclusive(path.join(directory, INTEGRITY_FILE), { schemaVersion: 1, sha256: artifactSha256, files });
    const integrity = verifyPrivateDnsParityPlan(directory);
    if (!integrity.valid) throw new Error("New preparation artifact failed its integrity check.");
    return { directory, artifactSha256, plan };
  } catch (error) {
    writeJsonExclusive(path.join(directory, "preparation-failed.json"), { schemaVersion: 1, deploymentReady: false, releaseAuthorized: false, cloudMutationsPerformed: false, reason: error instanceof Error ? error.message : "Preparation failed." });
    throw error;
  }
}

export function parseParityPlanArguments(args: readonly string[]): ParityPlanOptions {
  const allowed = new Set(["--profile", "--region", "--mode", "--stack-name", "--zone-name", "--probe-architecture"]);
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!allowed.has(name) || values[name] !== undefined || !value || value.startsWith("--")) throw new Error("Usage: --profile dev [--region us-east-1] [--mode dev|prod] [--stack-name phz-parity-...] [--zone-name internal.parity.test] [--probe-architecture arm64|x86_64]");
    values[name] = value;
  }
  if (!values["--profile"]) throw new Error("An explicit --profile is required; no AWS default profile is inferred.");
  if (values["--probe-architecture"] !== undefined && !["arm64", "x86_64"].includes(values["--probe-architecture"]!)) throw new Error("Probe architecture must be arm64 or x86_64.");
  return { profile: values["--profile"]!, ...(values["--region"] ? { region: values["--region"] } : {}), ...(values["--mode"] ? { mode: values["--mode"] as "dev" | "prod" } : {}), ...(values["--stack-name"] ? { stackName: values["--stack-name"] } : {}), ...(values["--zone-name"] ? { zoneName: values["--zone-name"] } : {}), ...(values["--probe-architecture"] ? { probeArchitecture: values["--probe-architecture"] as "arm64" | "x86_64" } : {}) };
}

if (require.main === module) {
  Promise.resolve().then(() => preparePrivateDnsParityPlan(parseParityPlanArguments(process.argv.slice(2)))).then(result => {
    process.stdout.write(`${JSON.stringify({ directory: result.directory, artifactSha256: result.artifactSha256, target: result.plan.target, resourceCounts: result.plan.resourceCounts, deploymentReady: false, releaseAuthorized: false, cloudMutationsPerformed: false }, null, 2)}\n`);
  }).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Preparation failed."}\n`); process.exitCode = 1; });
}

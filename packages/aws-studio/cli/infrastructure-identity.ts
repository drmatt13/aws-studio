/**
 * What a synthesized application *is* in CloudFormation's eyes, so a refactor can prove it
 * changed nothing deployed: `npm run infrastructure:identity -- capture|compare`.
 *
 * Three separate questions, reported separately because they have different consequences:
 *
 * - identity: stack names, environments, tags, stack dependencies, logical IDs and their
 *   types, and output export names. A difference here can replace or orphan resources.
 * - properties: a resource's configuration (asset hashes normalized away). A difference is an
 *   in-place update or, for some properties, a replacement that a change set will name.
 * - assets: which built asset a resource points at. A difference is a code or image update.
 *
 * Capture synthesizes offline: it runs cdk-app/bin/app.ts itself with the cdk.json context and
 * the cached lookups in cdk.context.json, credentials removed from its environment, and refuses
 * an assembly that needed a lookup the cache does not hold. Nothing is deployed or read from AWS.
 */
import { frameworkRepositoryRoot } from "../src/config/repository-root";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface StackIdentity {
  readonly environment: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly dependencies: readonly string[];
  readonly resources: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string | null>>;
  readonly properties: Readonly<Record<string, string>>;
  readonly assets: Readonly<Record<string, readonly string[]>>;
}
export interface AssemblyIdentity {
  readonly version: 1;
  readonly stacks: Readonly<Record<string, StackIdentity>>;
}
export interface IdentityComparison {
  readonly identical: boolean;
  readonly identity: readonly string[];
  readonly properties: readonly string[];
  readonly assets: readonly string[];
}

interface Artifact {
  readonly type: string;
  readonly environment?: string;
  readonly properties?: { readonly templateFile?: string; readonly file?: string; readonly stackName?: string; readonly tags?: Record<string, string> };
  readonly dependencies?: readonly string[];
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** Deterministic JSON: object keys sorted, so equal configurations hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const sorted = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

function exportName(output: unknown): string | null {
  const name = (output as { Export?: { Name?: unknown } } | undefined)?.Export?.Name;
  if (name === undefined) return null;
  return typeof name === "string" ? name : canonical(name);
}

/** Every stack in a cloud assembly directory (cdk.out), reduced to its deployed identity. */
export function readAssemblyIdentity(cdkOut: string): AssemblyIdentity {
  const manifestFile = path.join(cdkOut, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`${cdkOut} is not a cloud assembly: it has no manifest.json.`);
  const artifacts = (readJson(manifestFile) as { artifacts?: Record<string, Artifact> }).artifacts ?? {};
  const stackIds = new Set(Object.entries(artifacts).filter(([, artifact]) => artifact.type === "aws:cloudformation:stack").map(([id]) => id));
  const stacks: Record<string, StackIdentity> = {};
  for (const id of stackIds) {
    const artifact = artifacts[id]!;
    const templateFile = artifact.properties?.templateFile;
    if (!templateFile) throw new Error(`Stack ${id} names no template file.`);
    const template = readJson(path.join(cdkOut, templateFile)) as { Resources?: Record<string, Record<string, unknown>>; Outputs?: Record<string, unknown> };
    // Built assets this stack's resources can point at: its asset manifests' files and images,
    // except the template itself, whose hash changes with any edit and is not a resource.
    const assetIds = new Set<string>();
    for (const dependency of artifact.dependencies ?? []) {
      const manifest = artifacts[dependency];
      if (manifest?.type !== "cdk:asset-manifest" || !manifest.properties?.file) continue;
      const assets = readJson(path.join(cdkOut, manifest.properties.file)) as { files?: Record<string, { source?: { path?: string } }>; dockerImages?: Record<string, unknown> };
      for (const [asset, entry] of Object.entries(assets.files ?? {})) if (entry.source?.path !== templateFile) assetIds.add(asset);
      for (const asset of Object.keys(assets.dockerImages ?? {})) assetIds.add(asset);
    }
    const resources: Record<string, string> = {}, properties: Record<string, string> = {}, assets: Record<string, string[]> = {};
    for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
      resources[logicalId] = String(resource.Type);
      const { Metadata: _metadata, Type: _type, ...configuration } = resource;
      let text = canonical(configuration);
      const referenced = [...assetIds].filter(asset => text.includes(asset)).sort();
      for (const asset of referenced) text = text.split(asset).join("<asset>");
      properties[logicalId] = createHash("sha256").update(text).digest("hex");
      if (referenced.length) assets[logicalId] = referenced;
    }
    const outputs: Record<string, string | null> = {};
    for (const [key, output] of Object.entries(template.Outputs ?? {})) outputs[key] = exportName(output);
    stacks[artifact.properties?.stackName ?? id] = {
      environment: artifact.environment ?? "",
      tags: sorted(artifact.properties?.tags ?? {}),
      dependencies: (artifact.dependencies ?? []).filter(dependency => stackIds.has(dependency)).sort(),
      resources: sorted(resources), outputs: sorted(outputs), properties: sorted(properties), assets: sorted(assets),
    };
  }
  return { version: 1, stacks: sorted(stacks) };
}

const list = (values: readonly string[]) => values.length ? values.join(", ") : "(none)";
const short = (assets: readonly string[] | undefined) => assets?.length ? assets.map(asset => asset.slice(0, 12)).join(", ") : "(none)";

/** Differences grouped by consequence; `identical` is about identity alone. */
export function compareAssemblyIdentity(before: AssemblyIdentity, after: AssemblyIdentity): IdentityComparison {
  const identity: string[] = [], properties: string[] = [], assets: string[] = [];
  const names = [...new Set([...Object.keys(before.stacks), ...Object.keys(after.stacks)])].sort();
  for (const name of names) {
    const a = before.stacks[name], b = after.stacks[name];
    if (!a || !b) { identity.push(`${name}: stack ${a ? "removed" : "added"}`); continue; }
    if (canonical(a.dependencies) !== canonical(b.dependencies)) identity.push(`${name}: dependencies ${list(a.dependencies)} → ${list(b.dependencies)}`);
    if (a.environment !== b.environment) identity.push(`${name}: environment ${a.environment} → ${b.environment}`);
    for (const tag of [...new Set([...Object.keys(a.tags), ...Object.keys(b.tags)])].sort()) {
      if (a.tags[tag] !== b.tags[tag]) identity.push(`${name}: tag ${tag} ${a.tags[tag] ?? "(absent)"} → ${b.tags[tag] ?? "(absent)"}`);
    }
    for (const id of [...new Set([...Object.keys(a.resources), ...Object.keys(b.resources)])].sort()) {
      const typeA = a.resources[id], typeB = b.resources[id];
      if (typeA === undefined) identity.push(`${name}: ${id} (${typeB}) added`);
      else if (typeB === undefined) identity.push(`${name}: ${id} (${typeA}) removed`);
      else if (typeA !== typeB) identity.push(`${name}: ${id} changed type ${typeA} → ${typeB}`);
      else {
        if (a.properties[id] !== b.properties[id]) properties.push(`${name}: ${id} (${typeA}) properties changed`);
        if (canonical(a.assets[id] ?? []) !== canonical(b.assets[id] ?? [])) assets.push(`${name}: ${id} asset ${short(a.assets[id])} → ${short(b.assets[id])}`);
      }
    }
    for (const key of [...new Set([...Object.keys(a.outputs), ...Object.keys(b.outputs)])].sort()) {
      if (!(key in b.outputs)) identity.push(`${name}: output ${key} removed`);
      else if (!(key in a.outputs)) identity.push(`${name}: output ${key} added`);
      else if (a.outputs[key] !== b.outputs[key]) identity.push(`${name}: output ${key} export ${a.outputs[key] ?? "(none)"} → ${b.outputs[key] ?? "(none)"}`);
    }
  }
  return { identical: identity.length === 0, identity, properties, assets };
}

export interface OfflineSynthesis {
  readonly repositoryRoot: string;
  readonly mode: "dev" | "prod";
  readonly outdir: string;
  readonly account: string;
  readonly region: string;
  /** False skips asset bundling: logical IDs are unaffected, asset hashes then describe sources. */
  readonly bundling: boolean;
  readonly timeoutMs?: number;
}

const CREDENTIAL_VARIABLES = ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"];

/** The context `cdk synth` would hand the app: cdk.json, then cached lookups, then this run's flags. */
export function offlineContext(repositoryRoot: string, mode: "dev" | "prod", bundling: boolean): Record<string, unknown> {
  const cdkJson = readJson(path.join(repositoryRoot, "cdk-app/cdk.json")) as { context?: Record<string, unknown> };
  const cachedFile = path.join(repositoryRoot, "cdk-app/cdk.context.json");
  const cached = existsSync(cachedFile) ? readJson(cachedFile) as Record<string, unknown> : {};
  return { ...cdkJson.context, ...cached, ...(mode === "prod" ? { prodDeployment: "true" } : {}), ...(bundling ? {} : { "aws:cdk:bundling-stacks": [] }) };
}

/** Runs the application's own CDK entry point into `outdir`, without the CDK CLI or credentials. */
export function synthesizeOffline(request: OfflineSynthesis): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CREDENTIAL_VARIABLES) delete env[name];
  Object.assign(env, {
    AWS_EC2_METADATA_DISABLED: "true",
    CDK_DEFAULT_ACCOUNT: request.account, CDK_DEFAULT_REGION: request.region,
    CDK_OUTDIR: request.outdir, CDK_CONTEXT_JSON: JSON.stringify(offlineContext(request.repositoryRoot, request.mode, request.bundling)),
    FORCE_COLOR: "0", NO_COLOR: "1",
  });
  return new Promise((accept, reject) => {
    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "bin/app.ts"], { cwd: path.join(request.repositoryRoot, "cdk-app"), env, shell: false, windowsHide: true });
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-16_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill(), request.timeoutMs ?? 15 * 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Offline ${request.mode} synthesis failed (exit ${code ?? "signal"}).\n${output.slice(-4000)}`)); return; }
      const missing = (readJson(path.join(request.outdir, "manifest.json")) as { missing?: readonly { key: string }[] }).missing ?? [];
      if (missing.length) { reject(new Error(`Synthesis needed context lookups that cdk-app/cdk.context.json does not hold: ${missing.map(entry => entry.key).join(", ")}. This tool never performs lookups.`)); return; }
      accept();
    });
  });
}

/**
 * Where captures synthesize. NodejsFunction sourcemaps record source paths relative to the
 * output directory, so bundle hashes are comparable only between captures written at the same
 * place, and equal what `cdk synth` produces only at cdk-app/cdk.out's depth below the root.
 * `.cache/` is ignored by Git and by every Docker build context, so the assembly never reaches
 * an image asset of its own.
 */
export function assemblyDirectory(repositoryRoot: string, mode: "dev" | "prod"): string {
  return path.join(repositoryRoot, ".cache", `infrastructure-assembly-${mode}`);
}

/** The account and region a mode is pinned to by its single declared target, if any. */
function targetEnvironment(repositoryRoot: string, mode: "dev" | "prod"): { account?: string; region?: string } {
  const context = (readJson(path.join(repositoryRoot, "cdk-app/cdk.json")) as { context?: Record<string, unknown> }).context ?? {};
  const targets = Object.values((context["framework:targets"] ?? {}) as Record<string, { mode?: string; account?: string; region?: string }>).filter(target => target.mode === mode);
  return targets.length === 1 ? { account: targets[0]!.account, region: targets[0]!.region } : {};
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  const repositoryRoot = frameworkRepositoryRoot();
  if (command === "capture") {
    const mode = option(rest, "--mode");
    if (mode !== "dev" && mode !== "prod") throw new Error("capture needs --mode dev or --mode prod.");
    const out = option(rest, "--out");
    if (!out) throw new Error("capture needs --out <file>.");
    const pinned = targetEnvironment(repositoryRoot, mode);
    const account = option(rest, "--account") ?? pinned.account, region = option(rest, "--region") ?? pinned.region;
    if (!account || !region) throw new Error(`No single ${mode} target pins an account and region in cdk-app/cdk.json. Pass --account and --region.`);
    const requested = option(rest, "--assembly");
    const outdir = requested ? path.resolve(requested) : assemblyDirectory(repositoryRoot, mode);
    rmSync(outdir, { recursive: true, force: true });
    mkdirSync(outdir, { recursive: true });
    await synthesizeOffline({ repositoryRoot, mode, outdir, account, region, bundling: rest.includes("--bundling") });
    const identity = readAssemblyIdentity(outdir);
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, `${JSON.stringify(identity, null, 2)}\n`);
    const stacks = Object.values(identity.stacks);
    process.stdout.write(`${mode}: ${stacks.length} stacks, ${stacks.reduce((sum, stack) => sum + Object.keys(stack.resources).length, 0)} resources → ${out} (assembly kept in ${path.relative(process.cwd(), outdir) || "."})\n`);
    return 0;
  }
  if (command === "compare") {
    const [beforeFile, afterFile] = rest.filter(arg => !arg.startsWith("--"));
    if (!beforeFile || !afterFile) throw new Error("compare needs <before.json> <after.json>.");
    const result = compareAssemblyIdentity(readJson(beforeFile) as AssemblyIdentity, readJson(afterFile) as AssemblyIdentity);
    const section = (title: string, lines: readonly string[]) => process.stdout.write(`${title}: ${lines.length ? `${lines.length}\n${lines.map(line => `  ${line}`).join("\n")}` : "none"}\n`);
    section("Identity changes", result.identity);
    section("Property changes", result.properties);
    section("Asset changes", result.assets);
    return result.identical && (!rest.includes("--strict") || (result.properties.length === 0 && result.assets.length === 0)) ? 0 : 1;
  }
  process.stderr.write("Usage: infrastructure-identity capture --mode dev|prod --out <file> [--account A --region R] [--bundling] [--assembly <dir>]\n       infrastructure-identity compare <before.json> <after.json> [--strict]\n");
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

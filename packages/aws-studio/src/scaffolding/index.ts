/** Node-only, repository-owned implementation templates. Rendering never writes files. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const SCAFFOLD_TEMPLATES = {
  "lambda/event": { kind: "lambda", localReplay: true },
  "lambda/event-result": { kind: "lambda", localReplay: false },
  "lambda/http": { kind: "lambda", localReplay: false },
  "lambda/http-authenticated": { kind: "lambda", localReplay: false },
  "lambda/websocket": { kind: "lambda", localReplay: false },
  "lambda/python": { kind: "lambda", localReplay: false },
  "container-service": { kind: "service", localReplay: false },
  "container-task": { kind: "task", localReplay: false },
  "container-service/legacy-javascript": { kind: "service", localReplay: false },
  "container-task/legacy-javascript": { kind: "task", localReplay: false },
  "agent/respond": { kind: "agent", localReplay: false },
  "agent/model": { kind: "agent", localReplay: false },
  "tool/public": { kind: "tool", localReplay: false },
  "tool/authenticated": { kind: "tool", localReplay: false },
} as const;
export type ScaffoldTemplateId = keyof typeof SCAFFOLD_TEMPLATES;
export interface ScaffoldParameters {
  readonly id: string;
  /** Repository-relative implementation directory, already resolved by the caller. */
  readonly directory: string;
  readonly handler?: string;
  readonly port?: number;
  readonly healthCheckPath?: string;
}
export interface ScaffoldSnapshot {
  readonly id: ScaffoldTemplateId;
  readonly fingerprint: string;
  /** Repository-relative template files and dependency manifests consumed by rendering. */
  readonly inputs: Readonly<Record<string, string>>;
}
export interface ScaffoldResult {
  readonly files: ReadonlyMap<string, string>;
  readonly requirements: { readonly localReplay: boolean };
  readonly snapshot: ScaffoldSnapshot;
}
export class ScaffoldError extends Error {}
const folder = "framework-config/templates";
const workspaceReleaseManifest = "packages/aws-studio/package.json";
const releaseLock = "package-lock.json";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sorted = (inputs: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const fingerprint = (inputs: Readonly<Record<string, string>>) => hash(JSON.stringify(sorted(inputs)));

/** Every component is checked, including dangling links and the template root. */
function sourcePath(root: string, relative: string): string {
  let current = realpathSync(root);
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new ScaffoldError(`Template inputs cannot use symbolic links: ${relative}.`);
  }
  return current;
}
function read(root: string, relative: string, inputs: Record<string, string>): string {
  const file = sourcePath(root, relative);
  const limitKiB = relative === releaseLock ? 8192 : 256;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > limitKiB * 1024) throw new ScaffoldError(`Template input must be a text file smaller than ${limitKiB} KiB: ${relative}.`);
  const text = readFileSync(file, "utf8");
  if (text.includes("\0")) throw new ScaffoldError(`Template input must be text: ${relative}.`);
  inputs[relative] = hash(text);
  return text;
}
function load(root: string, id: ScaffoldTemplateId) {
  if (!Object.hasOwn(SCAFFOLD_TEMPLATES, id)) throw new ScaffoldError("Choose a supported implementation template.");
  const base = `${folder}/${id}`, inputs: Record<string, string> = {};
  const manifest = JSON.parse(read(root, `${base}/template.json`, inputs)) as Record<string, unknown>;
  const expected = SCAFFOLD_TEMPLATES[id];
  if (!manifest || Array.isArray(manifest) || Object.keys(manifest).some(key => !["schemaVersion", "id", "kind", "localReplay"].includes(key)) || manifest.schemaVersion !== 1 || manifest.id !== id || manifest.kind !== expected.kind || manifest.localReplay !== expected.localReplay) throw new ScaffoldError(`Invalid ${base}/template.json. Keep schemaVersion 1, its template identity, kind and localReplay requirement.`);
  const files = new Map<string, string>();
  let total = 0;
  const visit = (relative: string): void => {
    const directory = sourcePath(root, `${base}/files${relative ? `/${relative}` : ""}`);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) throw new ScaffoldError("Template files cannot use symbolic links.");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) throw new ScaffoldError(`Unsupported template directory: ${name}.`);
        visit(name);
      } else {
        if (!entry.isFile() || !/^(?:[A-Za-z0-9_-]+\/)*(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|py|txt|md)|Dockerfile)\.template$/.test(name)) throw new ScaffoldError(`Starter files must use a supported filename and .template suffix: ${name}.`);
        const text = read(root, `${base}/files/${name}`, inputs);
        total += Buffer.byteLength(text);
        if (files.size >= 100 || total > 1024 * 1024) throw new ScaffoldError("A starter may contain at most 100 files and 1 MiB of text.");
        files.set(name.slice(0, -".template".length), text);
      }
    }
  };
  visit("");
  const entry = id === "lambda/python" ? "lambda_function.py" : id.includes("legacy-javascript") ? "index.mjs" : expected.kind === "service" || expected.kind === "task" ? "src/index.ts" : "index.ts";
  const typedContainer = (expected.kind === "service" || expected.kind === "task") && !id.includes("legacy-javascript");
  const required = [entry, ...(["service", "task", "agent"].includes(expected.kind) && id !== "container-task/legacy-javascript" ? ["package.json"] : []), ...(["service", "task"].includes(expected.kind) ? ["Dockerfile"] : []), ...(["agent", "tool"].includes(expected.kind) ? ["contract.ts"] : []), ...(expected.kind === "agent" || typedContainer ? ["tsconfig.json"] : []), ...(typedContainer ? ["scripts/build.mjs"] : [])];
  if (required.some(name => !files.has(name))) throw new ScaffoldError(`${base} is missing required starter files: ${required.filter(name => !files.has(name)).join(", ")}.`);
  return { files, inputs, expected };
}
type DependencySection = "dependencies" | "devDependencies";
type DependencyRanges = Partial<Record<DependencySection, Readonly<Record<string, unknown>>>>;
type DependencyManifest = DependencyRanges & { readonly packages?: Readonly<Record<string, DependencyRanges>> };
type VersionSources = Readonly<Record<string, { readonly file: string; readonly section: DependencySection }>>;
const workspaceVersions: VersionSources = {
  typescript: { file: "package.json", section: "devDependencies" },
  tsx: { file: "package.json", section: "devDependencies" },
  esbuild: { file: "package.json", section: "devDependencies" },
  "@types/node": { file: workspaceReleaseManifest, section: "devDependencies" },
  zod: { file: workspaceReleaseManifest, section: "dependencies" },
  "@langchain/core": { file: "packages/models/package.json", section: "dependencies" },
};

function versionSources(root: string): VersionSources {
  if (lstatSync(path.join(root, workspaceReleaseManifest), { throwIfNoEntry: false })) return workspaceVersions;
  // The app's CDK toolchain specifies its Node target. The actual hoisted types may target a newer major.
  return {
    ...workspaceVersions,
    "@types/node": { file: "cdk-app/package.json", section: "devDependencies" },
    zod: { file: releaseLock, section: "dependencies" },
  };
}

export function renderScaffold(root: string, id: ScaffoldTemplateId, parameters: ScaffoldParameters): ScaffoldResult {
  try {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(parameters.id) || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(parameters.directory) || !/^[A-Za-z_$][\w$]*$/.test(parameters.handler ?? "lambdaHandler")) throw new ScaffoldError("Starter identity, directory or handler is invalid.");
    const port = parameters.port ?? 5000;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ScaffoldError("Starter port must be from 1 to 65535.");
    const { files, inputs, expected } = load(root, id);
    const values: Record<string, string> = { id: parameters.id, directory: parameters.directory, handler: parameters.handler ?? "lambdaHandler", port: String(port), healthCheckPath: JSON.stringify(parameters.healthCheckPath ?? "/health") };
    const versions = versionSources(root);
    const manifests = new Map<string, DependencyManifest>();
    const rendered = new Map<string, string>();
    for (const [name, text] of files) {
      const content = text.replace(/\{\{([^{}\r\n]+)\}\}/g, (_match, token: string) => {
        if (token.startsWith("version:")) {
          const dependency = token.slice("version:".length), source = versions[dependency];
          if (!Object.hasOwn(versions, dependency) || !source) throw new ScaffoldError(`Unknown dependency version token: ${token}.`);
          if (!manifests.has(source.file)) manifests.set(source.file, JSON.parse(read(root, source.file, inputs)));
          const manifest = manifests.get(source.file);
          const owner = source.file === releaseLock ? manifest?.packages?.["node_modules/aws-studio"] : manifest;
          const value = owner?.[source.section]?.[dependency];
          if (typeof value !== "string" || !/^[A-Za-z0-9.^~*+<>=| -]+$/.test(value)) throw new ScaffoldError(`Cannot resolve ${dependency} from ${source.file}.`);
          return value;
        }
        if (!Object.hasOwn(values, token)) throw new ScaffoldError(`Unknown starter token: ${token} in ${name}.`);
        return values[token]!;
      });
      if (content.includes("{{")) throw new ScaffoldError(`Unresolved starter token in ${name}.`);
      if (name.endsWith(".json")) JSON.parse(content);
      rendered.set(name, content);
    }
    return { files: rendered, requirements: { localReplay: expected.localReplay }, snapshot: { id, fingerprint: fingerprint(inputs), inputs: sorted(inputs) } };
  } catch (error) {
    if (error instanceof ScaffoldError) throw error;
    // Filesystem and JSON errors contain template paths, never private inputs.
    throw new ScaffoldError(`Cannot render ${folder}/${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Includes the file inventory: adding a file expires a review, just like editing one. */
export function assertScaffoldUnchanged(root: string, snapshot: ScaffoldSnapshot): void {
  try {
    const { inputs } = load(root, snapshot.id);
    const versions = versionSources(root);
    for (const file of Object.keys(snapshot.inputs)) if (!file.startsWith(`${folder}/${snapshot.id}/`)) {
      if (!Object.values(versions).some(source => source.file === file)) throw new ScaffoldError("Invalid template dependency input.");
      read(root, file, inputs);
    }
    if (fingerprint(inputs) === snapshot.fingerprint) return;
  } catch { /* Missing, renamed, linked or invalid inputs also expire review. */ }
  throw new ScaffoldError(`Template ${snapshot.id} changed after review. Review the latest starter files before applying.`);
}

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AccessGraph, AccessModules } from "./access-graph.js";

/**
 * The versioned Access Graph artifact, src/generated/access-graph.json: the
 * resolved directives, the compiled access policy module and a fingerprint.
 *
 * The fingerprint covers compiled access declarations and excludes source positions.
 * The separate module digest covers TypeScript bindings such as server-owned
 * command effects. Contract Chain verifies both against the working source.
 */

export const ACCESS_POLICY_MODULE = "prisma/access/index.ts";
const MODULE_DIRECTORY = "prisma/access";

function canonical(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, order(entry)])) : item;
  return JSON.stringify(order(value));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** What decides access, hashed; source positions are left out. */
export function accessGraphFingerprint(graph: AccessGraph): string {
  const { provenance: _provenance, ...semantic } = graph;
  return sha256(canonical(semantic));
}

/** The policy module's files, package-relative and sorted. */
export function policyModuleFiles(packageRoot: string): string[] {
  const directory = path.join(packageRoot, MODULE_DIRECTORY);
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.[cm]?ts$/.test(entry)) files.push(path.relative(packageRoot, full).split(path.sep).join("/"));
    }
  };
  visit(directory);
  return files;
}

/** One digest over the policy module's source, so a stale artifact is detected without running it. */
export function policyModuleDigest(packageRoot: string): string {
  return sha256(canonical(Object.fromEntries(policyModuleFiles(packageRoot).map((file) => [file, readFileSync(path.join(packageRoot, file), "utf8").split("\r\n").join("\n")]))));
}

/** The application's compiled policy module, when it has one. */
export async function loadAccessModules(packageRoot: string): Promise<AccessModules | undefined> {
  const file = path.join(packageRoot, ACCESS_POLICY_MODULE);
  if (!existsSync(file)) return undefined;
  const loaded = (await import(pathToFileURL(file).href)) as { default?: AccessModules };
  if (!loaded.default || typeof loaded.default !== "object") throw new Error(`${ACCESS_POLICY_MODULE} must export default defineAccessPolicy({ … }).`);
  return loaded.default;
}

export interface AccessGraphArtifact {
  readonly fingerprint: string;
  readonly graph: AccessGraph;
  /** The compiled policy module, so editors can read the schema exactly as the generator did. */
  readonly modules: AccessModules | null;
  readonly policyModule: { readonly files: readonly string[]; readonly digest: string };
}

/** Verify the full compiled policy and module identity without binding editor line numbers. */
export function accessGraphArtifactSemantics(text: string): string {
  const artifact = JSON.parse(text) as AccessGraphArtifact;
  const { provenance, ...graph } = artifact.graph;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new Error("Access Graph navigation provenance is missing.");
  return canonical({ ...artifact, graph });
}

export function renderAccessGraph(graph: AccessGraph, modules: AccessModules | undefined, packageRoot: string): string {
  const artifact: AccessGraphArtifact & { $comment: string } = {
    $comment: "Generated from prisma/contract.prisma and prisma/access by aws-studio db:generate. Do not edit.",
    fingerprint: accessGraphFingerprint(graph),
    graph,
    modules: modules ? JSON.parse(JSON.stringify(modules)) as AccessModules : null,
    policyModule: { files: policyModuleFiles(packageRoot), digest: policyModuleDigest(packageRoot) },
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

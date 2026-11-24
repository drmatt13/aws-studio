import { realpathSync } from "node:fs";
import path from "node:path";
export { normalizeProjectName as normalizeComposeProjectName, resolveProjectName as composeProjectName } from "../src/local/project-name.mjs";

function canonical(file) {
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

/** Docker emits JSON labels per container; avoid comma-splitting working paths. */
export function parseComposeOwnershipLabels(output, expectedCount) {
  const lines = output.split(/\r?\n/).filter(line => line.trim());
  if (lines.length !== expectedCount) throw new Error("Local Compose container ownership could not be verified. Check Docker before using local runtime.");
  return lines.map(line => {
    let labels;
    try { labels = JSON.parse(line); } catch { /* Fixed diagnostic below. */ }
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) throw new Error("Local Compose container ownership could not be verified. Check Docker before using local runtime.");
    return labels;
  });
}

/** Project names alone are not checkout ownership: two clones can share a basename. */
export function assertComposeContainerOwnership(root, project, labels) {
  const expectedRoot = canonical(root);
  for (const metadata of labels) {
    const workingDirectory = metadata["com.docker.compose.project.working_dir"];
    const configuration = metadata["com.docker.compose.project.config_files"];
    const ownedDirectory = typeof workingDirectory === "string" && canonical(workingDirectory) === expectedRoot;
    // config_files is Compose's comma-joined string, even for paths containing a
    // comma. Match the full expected base path with list boundaries instead of
    // treating every comma as a path separator.
    const bases = [path.join(root, "docker-compose.yml"), path.join(expectedRoot, "docker-compose.yml"),
      ...(ownedDirectory ? [path.join(workingDirectory, "docker-compose.yml")] : [])];
    const ownBase = typeof configuration === "string" && bases.some(base => (`,` + configuration + `,`).includes(`,${base},`));
    if (metadata["com.docker.compose.project"] !== project || !ownedDirectory || !ownBase) {
      throw new Error("This Compose project belongs to another checkout or its ownership is unknown. Choose a unique app name at the top of Studio, or inspect the existing project's provenance. Existing containers and volumes were left unchanged.");
    }
  }
}

/** Legacy volumes carry project/logical-name labels, not a checkout path. Keep
 * legitimate down/up reuse, but never adopt a volume owned by another project.
 */
export function assertComposeVolumeOwnership(project, logicalName, labels) {
  if (!labels || labels["com.docker.compose.project"] !== project || labels["com.docker.compose.volume"] !== logicalName) {
    throw new Error("The configured PostgreSQL volume belongs to another project or its ownership is unknown. Review the Compose volume configuration before starting local runtime. Existing containers and volumes were left unchanged.");
  }
}

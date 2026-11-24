import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertWindowsPrivatePaths } from "aws-studio/cli/windows-security";

export interface AgentRuntimeRelease {
  readonly version: 1;
  readonly protocol: number;
  readonly digest: string;
  readonly directory: string;
  readonly entry: string;
  readonly projector: { readonly file: string; readonly digest: string };
  readonly contractToolchain?: import("./contract-validation").ContractToolchain;
}
export const releaseHash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
export function readAgentRuntimeRelease(directory: string): AgentRuntimeRelease {
  const canonical = realpathSync(directory);
  let ancestor = path.resolve(directory);
  while (ancestor !== path.dirname(ancestor)) {
    const stat = lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Pinned agent runtime contains a linked directory.");
    ancestor = path.dirname(ancestor);
  }
  const stat = lstatSync(canonical);
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new Error("Pinned agent runtime is not private to this user.");
  const manifestFile = path.join(canonical, "release.json"), manifestInfo = lstatSync(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1) throw new Error("Pinned agent runtime manifest is not a regular private file.");
  const manifest = JSON.parse(readFileSync(path.join(canonical, "release.json"), "utf8")) as { version: number; protocol: number; files: Record<string, string>; digest: string };
  const names = Object.keys(manifest.files).sort(), required = ["host.cjs", "projector.cjs", "tether.mjs"];
  // Earlier immutable releases keep their original layout. New releases pin
  // the shared launcher too; Windows always requires its native supervisor.
  const layouts = process.platform === "win32"
    ? [[...required, "windows-job.ps1"], [...required, "windows-job.ps1", "windows-process.cjs"], [...required, "owned-process.cjs", "windows-job.ps1"]]
    : [required, [...required, "windows-job.ps1"], [...required, "windows-process.cjs"], [...required, "windows-job.ps1", "windows-process.cjs"], [...required, "owned-process.cjs"], [...required, "owned-process.cjs", "windows-job.ps1"]];
  const checkerLayouts = [["chain-validator.cjs", "node-test-reporter.cjs"], ["chain-validator.cjs", "node-test-reporter.cjs", "contract-policy.json"],
    ["chain-validator.cjs", "node-test-reporter.cjs", "contract-policy.json", "contract-identity.cjs"]];
  const knownFiles = [...layouts, ...layouts.flatMap(layout => checkerLayouts.map(checker => [...layout, ...checker]))].some(layout => JSON.stringify(names) === JSON.stringify(layout.sort()));
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.protocol) || manifest.protocol < 1 || !knownFiles || manifest.digest !== releaseHash(JSON.stringify({ version: 1, protocol: manifest.protocol, files: manifest.files }))) throw new Error("Pinned agent runtime manifest is invalid.");
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join(canonical, name), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== "win32" && (info.uid !== process.getuid?.() || info.mode & 0o022) || releaseHash(readFileSync(file)) !== expected) throw new Error("Pinned agent runtime bytes changed. Preserve tasks and rebuild the runtime before starting it.");
  }
  if (process.platform === "win32") assertWindowsPrivatePaths([canonical, manifestFile, ...names.map(name => path.join(canonical, name))]);
  const asset = manifest.files["contract-policy.json"] ? JSON.parse(readFileSync(path.join(canonical, "contract-policy.json"), "utf8")) : undefined;
  const envelope = asset && typeof asset === "object" && asset.version === 1;
  const policy = envelope ? asset.policy : asset;
  if (manifest.files["contract-policy.json"] && (!policy || typeof policy !== "object" || Array.isArray(policy) || JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(["digest", "id"]) || policy.id !== "contract-chain/offline-v1" || !/^[a-f0-9]{64}$/.test(policy.digest)
    || envelope && (![JSON.stringify(["dependencyDigest", "policy", "version"]), JSON.stringify(["control", "dependencyDigest", "policy", "version"]), JSON.stringify(["control", "dependencyDigest", "policy", "projectDependencyDigest", "version"])].includes(JSON.stringify(Object.keys(asset).sort())) || typeof asset.dependencyDigest !== "string" || !/^[a-f0-9]{64}$/.test(asset.dependencyDigest)
      || Object.hasOwn(asset, "projectDependencyDigest") && asset.projectDependencyDigest !== null && (typeof asset.projectDependencyDigest !== "string" || !/^[a-f0-9]{64}$/.test(asset.projectDependencyDigest))
      || Object.hasOwn(asset, "control") && (typeof asset.control !== "string" || !/^[a-f0-9]{64}$/.test(asset.control))))) throw new Error("Pinned contract verification policy is invalid.");
  const workerAsset = (file: string) => ({ file: path.join(canonical, file), digest: manifest.files[file]! });
  return { version: 1, protocol: manifest.protocol, digest: manifest.digest, directory: canonical, entry: path.join(canonical, "host.cjs"), projector: workerAsset("projector.cjs"), ...(manifest.files["chain-validator.cjs"] ? { contractToolchain: { worker: workerAsset("chain-validator.cjs"), reporter: workerAsset("node-test-reporter.cjs"), ...(manifest.files["contract-identity.cjs"] ? { identityWorker: workerAsset("contract-identity.cjs") } : {}), ...(policy ? { policy } : {}), ...(envelope ? { controlDependencyDigest: asset.dependencyDigest as string } : {}), ...(envelope && Object.hasOwn(asset, "projectDependencyDigest") ? { projectDependencyDigest: asset.projectDependencyDigest as string | null } : {}), ...(envelope && typeof asset.control === "string" ? { control: asset.control as string } : {}) } } : {}) };
}

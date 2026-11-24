import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { generatedPeerName, generatedPeerPath, platformRoot, readStarterFiles, readStarterSelection, writeStarterFiles } from "./test-project-source.mjs";

/** Seed the platform's ignored file dependency before npm needs to resolve peers. */
export function bootstrapTestPeer(root = platformRoot, env = process.env) {
  const source = readStarterSelection(root, env);
  const files = readStarterFiles(source, generatedPeerPath);
  const manifest = JSON.parse(files.find(file => file.relative === "package.json").bytes);
  if (manifest.name !== generatedPeerName || manifest.private !== true) {
    throw new Error("The recorded starter must provide its private generated framework peer.");
  }
  const base = path.join(realpathSync(root), ".cache");
  const parent = path.join(base, "test-project-bootstrap");
  mkdirSync(parent, { recursive: true });
  if (realpathSync(parent) !== parent) throw new Error("The peer bootstrap cache must be a physical directory.");
  const target = path.join(parent, "framework-generated");
  if (existsSync(target)) {
    if (realpathSync(target) !== target) throw new Error("The peer bootstrap target must be a physical directory.");
    const expected = new Set(files.flatMap(({ relative }) => {
      const segments = relative.split("/");
      return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
    }));
    const entries = readdirSync(target, { recursive: true, withFileTypes: true });
    const installed = entries.length === expected.size && entries.every(entry => {
      const relative = path.relative(target, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
      return (entry.isDirectory() || entry.isFile()) && expected.has(relative);
    }) && files.every(({ relative, bytes, mode }) => {
      const file = path.join(target, relative);
      const stat = lstatSync(file, { throwIfNoEntry: false });
      return stat?.isFile() && realpathSync(file) === file && readFileSync(file).equals(bytes) &&
        (process.platform === "win32" || (stat.mode & 0o111) === (mode & 0o111));
    });
    if (installed) return target;
  }

  const staging = mkdtempSync(path.join(parent, "generated-"));
  try {
    writeStarterFiles(staging, files);
    if (existsSync(target)) rmSync(target, { recursive: true, maxRetries: 5, retryDelay: 100 });
    renameSync(staging, target);
    return target;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { bootstrapTestPeer(); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}

import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFrameworkArchive } from "./framework-archive";
import { frameworkCompatibility, projectProtocol, releaseIsOlder, studioDistribution } from "./release-compatibility";
import { readStarterFiles, readStarterSelection, writeStarterFiles } from "./test-project-source.mjs";
import { vpcEndpointServicesModule } from "../packages/aws-studio/scripts/vpc-endpoint-services";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const npm = process.env.npm_execpath;
if (!npm || process.argv.length > 5) throw new Error("Use npm run pack:studio -- [destination] [framework archive] [Studio metadata JSON].");
const destination = path.resolve(process.argv[2] ?? path.join(root, "release"));
const sourceManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const releaseSettings = JSON.parse(readFileSync(process.argv[4] ?? path.join(root, "scripts/studio-release.json"), "utf8"));
const release = studioDistribution({ ...releaseSettings, version: sourceManifest.version });
const clientManifest = JSON.parse(readFileSync(path.join(root, "client-app/package.json"), "utf8"));
const frameworkName = `aws-studio-${release.frameworkVersion}.tgz`;
const packedName = `aws-studio-${release.version}-distribution.tar.gz`;
const toolsEnvironment = { ...process.env };
const currentPath = Object.entries(toolsEnvironment).find(([name]) => name.toUpperCase() === "PATH")?.[1];
for (const name of Object.keys(toolsEnvironment)) {
  if (/^(?:PATH|npm_config_(?:workspace|workspaces|include_workspace_root|prefix|global))$/i.test(name)) delete toolsEnvironment[name];
}
toolsEnvironment.PATH = [path.dirname(process.execPath), currentPath].filter(Boolean).join(path.delimiter);

function runNpm(cwd: string, args: string[]): void {
  execFileSync(process.execPath, [npm!, ...args], { cwd, env: toolsEnvironment, stdio: "inherit", windowsHide: true });
}

function saveJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function copyReleaseFile(directory: string, relative: string, from = path.join(root, relative)): void {
  if (!lstatSync(from).isFile() || realpathSync(from) !== from) throw new Error(`A Studio package file must be regular and unlinked: ${relative}`);
  const to = path.join(directory, relative);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const stage = mkdtempSync(path.join(realpathSync(os.tmpdir()), "aws-studio-distribution-"));
try {
  const selectedArchive = process.argv[3] ? path.resolve(process.argv[3]) : path.join(stage, frameworkName);
  if (!process.argv[3]) {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/pack.ts", stage], { cwd: root, env: toolsEnvironment, stdio: "inherit", windowsHide: true });
  }
  const framework = readFrameworkArchive(selectedArchive);
  if (framework.manifest?.name !== "aws-studio" || framework.manifest.version !== release.frameworkVersion ||
    release.frameworkIntegrity && framework.integrity !== release.frameworkIntegrity) {
    throw new Error(`The Studio distribution must bundle the exact aws-studio ${release.frameworkVersion} archive.`);
  }
  const compatibility = frameworkCompatibility(release.frameworkVersion, framework.manifest.studioCompatibility);
  if (!compatibility || compatibility.protocol !== projectProtocol || releaseIsOlder(release.version, compatibility.minimumStudio)) {
    throw new Error(`Studio ${release.version} cannot bundle framework ${release.frameworkVersion}.`);
  }

  runNpm(root, ["--workspace", "framework-studio", "run", "build"]);
  const installation = path.join(stage, "aws-studio");
  const gitFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "client-app/server", "client-app/shared", "client-app/src"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  }).split("\0").filter(Boolean);
  for (const file of new Set(gitFiles)) {
    if (!existsSync(path.join(root, file)) || /(?:^|\/)(?:\.[^/]+|node_modules|test|tests|fixtures)(?:\/|$)/.test(file) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || !/\.(?:[cm]?[jt]s|tsx|json|ps1)$/.test(file)) continue;
    copyReleaseFile(installation, file);
  }
  for (const file of [
    "LICENSE", "scripts/framework-archive.ts", "scripts/release-compatibility.ts", "scripts/starters.json", "scripts/test-project-source.mjs",
    "scripts/studio-bootstrap.mjs", "scripts/studio-toolchain.mjs", "scripts/studio-node-archives.json",
    "packages/aws-studio/cli/project-node.mjs",
  ]) {
    copyReleaseFile(installation, file);
  }
  copyReleaseFile(installation, "scripts/studio.mjs", path.join(root, "client-app/launch.mjs"));
  const dist = path.join(root, "client-app/dist");
  for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const from = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dist, from);
    if (relative.split(path.sep).some(segment => segment.startsWith(".")) ||
      entry.name !== "LICENSE" && !/\.(?:css|js|woff2?|svg|ico|html|png|jpe?g|webp|avif|txt|md)$/i.test(relative)) {
      throw new Error(`Unexpected Studio frontend asset: ${relative}`);
    }
    copyReleaseFile(installation, relative === "index.html" ? "client-app/index.html" : path.join("client-app/dist", relative), from);
  }

  const selection = readStarterSelection(root);
  writeStarterFiles(path.join(installation, "release/starter"), readStarterFiles(selection));
  const archiveLocation = `release/${frameworkName}`;
  writeFileSync(path.join(installation, archiveLocation), framework.bytes, { flag: "wx" });
  saveJson(path.join(installation, "scripts/studio-release.json"), { ...release, frameworkIntegrity: framework.integrity });
  saveJson(path.join(installation, "client-app/package.json"), { name: clientManifest.name, private: true });
  // The framework's host-side exports load this peer. The host can use the
  // generic CDK catalog. App-generated target and handler data belong to workers.
  const generatedPeer = path.join(stage, "stub");
  const hostPeerModules = {
    "vpc-endpoint-services": vpcEndpointServicesModule(root),
    "target-ids": [
      "export const LAMBDA_SOURCE_DIRECTORY_BY_ID = {};",
      ...["LAMBDA_TARGET_IDS", "LAMBDA_SOURCE_DIRECTORIES", "EVENT_LAMBDA_IDS", "TOOL_LAMBDA_IDS", "SERVICE_TARGET_IDS", "SERVICE_SOURCE_DIRECTORIES", "TASK_TARGET_IDS", "TASK_SOURCE_DIRECTORIES", "WORKFLOW_TARGET_IDS", "AGENT_TARGET_IDS"]
        .map(name => `export const ${name} = [];`),
    ].join("\n") + "\n",
    agentcore: "export const AGENTCORE_AGENTS = {};\nexport const AGENTCORE_TOOLS = {};\n",
    "event-replay": "export const EVENT_REPLAY_MANIFEST = {};\n",
  };
  saveJson(path.join(generatedPeer, "package.json"), {
    name: "@repo/framework-generated", version: "1.0.0", private: true,
    exports: Object.fromEntries(Object.keys(hostPeerModules).map(name => [`./${name}`, `./${name}.ts`])),
  });
  for (const [name, source] of Object.entries(hostPeerModules)) writeFileSync(path.join(generatedPeer, `${name}.ts`), source);
  runNpm(generatedPeer, ["pack", "--offline", "--ignore-scripts", "--pack-destination", path.join(installation, "release")]);
  const sameMajor = (minimum: string) => `>=${minimum} <${Number(minimum.split(".")[0]) + 1}`;
  saveJson(path.join(installation, "package.json"), {
    name: "aws-studio-distribution", private: true, version: release.version, license: sourceManifest.license,
    engines: { node: sameMajor(release.runtime.node), npm: sameMajor(release.runtime.npm) },
    packageManager: `npm@${release.runtime.npm}`,
    scripts: { studio: "node scripts/studio.mjs" },
    dependencies: {
      ...sourceManifest.dependencies,
      ...clientManifest.dependencies,
      "@repo/framework-generated": "file:release/repo-framework-generated-1.0.0.tgz",
      "aws-studio": `file:${archiveLocation}`,
      tsx: clientManifest.devDependencies.tsx,
      typescript: clientManifest.devDependencies.typescript,
    },
    overrides: sourceManifest.overrides,
    allowScripts: sourceManifest.allowScripts,
  });
  writeFileSync(path.join(installation, ".nvmrc"), release.runtime.node + "\n");

  // Retain the workspace's selected versions as the seed and let npm prune and
  // resolve the actual install tree for the production-only manifest.
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const [entry, value] of Object.entries<{ link?: boolean }>(lock.packages)) {
    if (entry && (!entry.startsWith("node_modules/") || value.link)) delete lock.packages[entry];
  }
  delete lock.packages["node_modules/aws-studio"];
  delete lock.packages["node_modules/@repo/framework-generated"];
  saveJson(path.join(installation, "package-lock.json"), lock);
  runNpm(installation, ["install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const installed = JSON.parse(readFileSync(path.join(installation, "package-lock.json"), "utf8"));
  if (installed.packages["node_modules/aws-studio"]?.integrity !== framework.integrity ||
    Object.keys(installed.packages).some(entry => entry.startsWith("client-app") || entry.startsWith("packages/") || entry.startsWith(".cache"))) {
    throw new Error("The installation lock must pin the embedded framework archive and contain no workspace links.");
  }
  mkdirSync(destination, { recursive: true });
  const archived = path.join(stage, packedName);
  execFileSync("tar", ["-czf", archived, "-C", stage, "aws-studio"], { env: { ...process.env, COPYFILE_DISABLE: "1" }, windowsHide: true });
  copyFileSync(archived, path.join(destination, packedName), constants.COPYFILE_EXCL);
  console.log(JSON.stringify({ archive: path.join(destination, packedName), studio: release.version, framework: release.frameworkVersion, frameworkIntegrity: framework.integrity, runtime: release.runtime }));
} finally {
  rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

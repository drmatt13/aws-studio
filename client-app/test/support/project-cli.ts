import { testProjectRoot } from "../../../scripts/test-project";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const repository = path.resolve(__dirname, "../../..");
const source = path.join(testProjectRoot, "node_modules/aws-studio");
let archive: Buffer | undefined;

/** Install independent release files so project selection and edits exercise a physical package. */
export function installFixtureRelease(root: string): void {
  root = realpathSync(root);
  const modules = path.join(root, "node_modules"), installed = path.join(modules, "aws-studio");
  mkdirSync(modules, { recursive: true });
  if (realpathSync(modules) !== modules) throw new Error("Fixture dependency writes require a physical node_modules directory.");
  mkdirSync(installed, { recursive: true });
  if (realpathSync(installed) !== installed) throw new Error("A fixture release must be installed in its own physical directory.");
  cpSync(source, installed, { recursive: true });
  const packages = path.join(root, "packages");
  const generated = path.join(packages, "framework-generated");
  const scope = path.join(modules, "@repo");
  const peer = path.join(scope, "framework-generated");
  mkdirSync(packages, { recursive: true });
  if (realpathSync(packages) !== packages) throw new Error("Fixture workspace packages must be physically inside the fixture.");
  mkdirSync(generated, { recursive: true });
  mkdirSync(scope, { recursive: true });
  if (realpathSync(generated) !== generated || realpathSync(scope) !== scope) {
    throw new Error("Fixture generated sources must be owned by the writable project.");
  }
  cpSync(path.join(testProjectRoot, "packages/framework-generated"), generated, { recursive: true, force: false });
  if (!existsSync(peer)) symlinkSync(generated, peer, process.platform === "win32" ? "junction" : "dir");
  if (realpathSync(peer) !== generated) throw new Error("The fixture's generated peer must resolve inside its own project.");
  const { version } = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  archive ??= readFileSync(path.join(testProjectRoot, "vendor", "aws-studio-" + version + ".tgz"));
  pinFixtureRelease(root, archive);
}

/** Seed the project-owned metadata and contracts used by the real generator. */
export function installGenerationFixture(root: string): void {
  for (const relative of ["package.json", "package-lock.json", "packages/api-contract/src/generated"]) {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(testProjectRoot, relative), destination, { recursive: true });
  }
  installFixtureRelease(root);
}

/** Pin the exact local package bytes for this synthetic app's npm and Studio checks. */
export function pinFixtureRelease(root: string, packed?: Buffer): Buffer {
  const installed = path.join(root, "node_modules/aws-studio");
  const release = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  const vendor = path.join(root, "vendor"), name = "aws-studio-" + release.version + ".tgz";
  mkdirSync(vendor, { recursive: true });
  if (!packed) {
    const tools = require("aws-studio/cli/project-node.mjs").findProjectToolchain(repository);
    execFileSync(tools.node, [tools.npm, "pack", "--offline", "--ignore-scripts", "--workspaces=false", "--pack-destination", vendor], {
      cwd: installed, stdio: "pipe", windowsHide: true,
    });
    packed = readFileSync(path.join(vendor, name));
  } else writeFileSync(path.join(vendor, name), packed);
  const spec = "file:vendor/" + name;
  const file = path.join(root, "package.json");
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { private: true };
  manifest.packageManager ??= JSON.parse(readFileSync(path.join(testProjectRoot, "package.json"), "utf8")).packageManager;
  manifest.dependencies = { ...manifest.dependencies, "aws-studio": spec };
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  const lockFile = path.join(root, "package-lock.json");
  const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")) : { lockfileVersion: 3, packages: { "": {} } };
  lock.packages[""].dependencies = { ...lock.packages[""].dependencies, "aws-studio": spec };
  lock.packages["node_modules/aws-studio"] = { version: release.version, resolved: spec,
    integrity: "sha512-" + createHash("sha512").update(packed).digest("base64"), dependencies: release.dependencies,
    peerDependencies: release.peerDependencies, bin: release.bin };
  delete lock.packages["packages/aws-studio"];
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
  copyFileSync(path.join(testProjectRoot, ".nvmrc"), path.join(root, ".nvmrc"));
  return packed;
}

/** Fixture CLI with isolated implementations for cancellation and worker tests. */
export function installFixtureCommands(root: string): string {
  const installed = path.join(root, "node_modules/aws-studio");
  mkdirSync(installed, { recursive: true });
  const manifestFile = path.join(root, "package.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};
  manifest.packageManager ??= JSON.parse(readFileSync(path.join(testProjectRoot, "package.json"), "utf8")).packageManager;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  copyFileSync(path.join(testProjectRoot, ".nvmrc"), path.join(root, ".nvmrc"));
  writeFileSync(path.join(installed, "package.json"), JSON.stringify({
    name: "aws-studio", bin: { "aws-studio": "cli.cjs" }, exports: { "./cli": "./cli.cjs" },
  }));
  writeFileSync(path.join(installed, "cli.cjs"), `const verb = process.argv.splice(2, 1)[0];
require("tsx/cjs");
if (verb === "framework:generate") require("./generate-contracts.ts");
else if (verb === "framework:check-local") require("./check-local.ts");
else throw new Error("Unexpected fixture CLI command " + verb);
`);
  return installed;
}

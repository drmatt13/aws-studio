import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { projectCliEntry } from "./project-cli";
import { IncompatibleProjectError } from "./project-errors";
import { readFrameworkArchive } from "../../scripts/framework-archive";
import { frameworkCompatibility, projectProtocol, releaseIsOlder, stableVersion, studioDistribution, type FrameworkCompatibility } from "../../scripts/release-compatibility";
import release from "../../scripts/studio-release.json";
import studioPackage from "../../package.json";

export { projectProtocol, releaseIsOlder, type FrameworkCompatibility };
export const studioDistributionMetadata = studioDistribution({ ...release, version: studioPackage.version });
export const studioRelease = studioDistributionMetadata.version;
export const bundledFrameworkVersion = studioDistributionMetadata.frameworkVersion;

/** The Studio installation running this process, found from its own files rather than a project or the working directory. */
export const studioInstallation = path.resolve(__dirname, "../..");

export interface StudioReleaseArchive {
  readonly file: string;
  readonly integrity: string;
  readonly version: string;
  readonly compatibility: FrameworkCompatibility;
  readonly engines?: { readonly node: string; readonly npm: string };
}

/** The exact framework/CLI archive shipped with this Studio distribution. */
export function studioReleaseArchive(installation: string = studioInstallation): StudioReleaseArchive {
  const relative = `release/aws-studio-${bundledFrameworkVersion}.tgz`, file = path.join(installation, ...relative.split("/"));
  const { manifest, integrity } = readFrameworkArchive(file);
  if (manifest?.name !== "aws-studio" || manifest.version !== bundledFrameworkVersion) {
    throw new Error(`The framework archive at ${relative} contains ${String(manifest?.name)} ${String(manifest?.version)}. Expected aws-studio ${bundledFrameworkVersion}.`);
  }
  if (studioDistributionMetadata.frameworkIntegrity && integrity !== studioDistributionMetadata.frameworkIntegrity) {
    throw new Error(`The framework archive at ${relative} does not match the installed Studio release digest.`);
  }
  const compatibility = assertSupportedProjectRelease({ version: bundledFrameworkVersion, spec: relative }, manifest.studioCompatibility);
  const engines = manifest.engines;
  if (engines !== undefined && (typeof engines?.node !== "string" || typeof engines?.npm !== "string")) {
    throw new Error(`The framework archive at ${relative} has invalid Node or npm engine ranges.`);
  }
  return {
    file, integrity, version: bundledFrameworkVersion, compatibility,
    ...(typeof engines?.node === "string" && typeof engines.npm === "string" ? { engines: { node: engines.node, npm: engines.npm } } : {}),
  };
}

/** One startup line naming the installation's CLI archive, or why release upgrades are unavailable. */
export function describeStudioRelease(installation: string = studioInstallation): string {
  try { return `AWS Studio ${studioRelease} · framework ${bundledFrameworkVersion}: ${studioReleaseArchive(installation).file}`; }
  catch (error) { return `AWS Studio ${studioRelease}: ${error instanceof Error ? error.message : "The framework archive is unavailable."} Projects still open. Framework upgrades require the bundled archive.`; }
}

export interface ProjectRelease {
  readonly version: string;
  readonly spec: string;
  readonly section: "dependencies" | "devDependencies";
}

function parseManifest(root: string, file: string): unknown {
  const source = path.join(root, file), info = lstatSync(source);
  if (!info.isFile() || info.nlink !== 1 || info.size > 24 * 1024 * 1024) throw new Error(`${file} must be a regular project file.`);
  return JSON.parse(readFileSync(source, "utf8"));
}

export function readProjectRelease(root: string): ProjectRelease | undefined {
  const manifest = parseManifest(root, "package.json") as Partial<Record<ProjectRelease["section"], Record<string, unknown>>>;
  const production = manifest.dependencies?.["aws-studio"], development = manifest.devDependencies?.["aws-studio"];
  if (production === undefined && development === undefined) return;
  const spec = production ?? development;
  const tarball = typeof spec === "string" && /^file:(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*aws-studio-([\d.]+)\.tgz$/.exec(spec);
  const version = tarball ? tarball[1] : spec;
  if (production !== undefined && development !== undefined || typeof spec !== "string" || typeof version !== "string" || !stableVersion.test(version)) {
    throw new Error("Pin aws-studio once in package.json using an exact release or a project-local AWS Studio tarball.");
  }
  return { version, spec, section: production !== undefined ? "dependencies" : "devDependencies" };
}

export function assertProjectReleaseLock(root: string, pin: ProjectRelease): void {
  const lock = parseManifest(root, "package-lock.json") as { lockfileVersion?: unknown; packages?: Record<string, { version?: unknown; resolved?: unknown; link?: unknown; integrity?: unknown } & Partial<Record<ProjectRelease["section"], Record<string, unknown>>>> };
  const installed = lock.packages?.["node_modules/aws-studio"];
  if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.[pin.section]?.["aws-studio"] !== pin.spec || installed?.version !== pin.version || installed.link || typeof installed.integrity !== "string" || pin.spec.startsWith("file:") && installed.resolved !== pin.spec) {
    throw new Error("The AWS Studio pin in package.json must match package-lock.json. Restore the project's pinned toolchain using npm.");
  }
}

/** Opening a project and evaluating it use the same installed release and version policy. */
export function assertSupportedProjectRelease(pin: Pick<ProjectRelease, "version" | "spec">, metadata?: unknown, current = studioRelease): FrameworkCompatibility {
  const compatibility = frameworkCompatibility(pin.version, metadata);
  if (!compatibility) {
    throw new IncompatibleProjectError(`AWS Studio ${current} has no compatibility information for framework ${pin.version} (${pin.spec}). Open the project with a Studio release that supports this framework.`);
  }
  if (releaseIsOlder(current, compatibility.minimumStudio)) {
    throw new IncompatibleProjectError(`This project requires AWS Studio version ${compatibility.minimumStudio} or higher. Update AWS Studio ${current} to continue.`);
  }
  if (compatibility.protocol !== projectProtocol) {
    throw new IncompatibleProjectError(`Framework ${pin.version} requires project protocol ${compatibility.protocol}. AWS Studio ${current} supports protocol ${projectProtocol}. Use a Studio release qualified for this framework.`);
  }
  return compatibility;
}

/** Resolve an export from the opened project's direct installation without running its code. */
export function projectExport(root: string, subpath: string): string {
  const specifier = `aws-studio/${subpath}`;
  const installed = path.join(root, "node_modules/aws-studio");
  if (!existsSync(path.join(installed, "package.json"))) {
    throw new IncompatibleProjectError(`${root} does not install aws-studio, which provides ${specifier}. Run npm install in that project first.`);
  }
  let entry: string;
  try { entry = realpathSync(createRequire(path.join(root, "package.json")).resolve(specifier)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && code !== "MODULE_NOT_FOUND" && code !== "ENOENT") throw error;
    throw new IncompatibleProjectError(`${root} installs a framework without ${specifier}. Install AWS Studio's matching release in that project.`);
  }
  const relative = path.relative(realpathSync(installed), entry);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new IncompatibleProjectError(`${specifier} must resolve inside the project's installed aws-studio release.`);
  }
  return entry;
}


/** Resolve Studio's installed framework without reading an application's manifest or release pin. */
export function studioFrameworkPackageDirectory(): string {
  const installed = path.join(studioInstallation, "node_modules/aws-studio");
  if (!existsSync(path.join(installed, "package.json"))) {
    throw new Error("AWS Studio's installed framework is missing. Install the Studio toolchain.");
  }
  const framework = realpathSync(installed);
  const workspace = path.join(realpathSync(studioInstallation), "packages/aws-studio");
  if (path.relative(realpathSync(studioInstallation), framework) !== "node_modules" + path.sep + "aws-studio" &&
      framework !== workspace) {
    throw new Error("AWS Studio must load the framework installed with Studio.");
  }
  const manifest = parseManifest(framework, "package.json") as { name?: unknown; version?: unknown };
  if (manifest.name !== "aws-studio" || manifest.version !== bundledFrameworkVersion) {
    throw new Error(`AWS Studio ${studioRelease} requires its own aws-studio ${bundledFrameworkVersion} framework.`);
  }
  return framework;
}

export function resolveProjectInstallation(root: string): { root: string; framework: string; release: ProjectRelease; compatibility: FrameworkCompatibility } {
  root = realpathSync(root);
  const pin = readProjectRelease(root);
  if (!pin) {
    throw new IncompatibleProjectError("Pin aws-studio once in package.json using an exact release or a project-local AWS Studio tarball.");
  }
  assertProjectReleaseLock(root, pin);
  const installed = path.join(root, "node_modules/aws-studio");
  if (!existsSync(path.join(installed, "package.json"))) throw new IncompatibleProjectError(`${root} does not install aws-studio. Run npm install in that project first.`);
  const framework = realpathSync(installed);
  if (path.relative(installed, framework) !== "") {
    throw new IncompatibleProjectError("The project must install a physical aws-studio package directly in its own node_modules.");
  }
  const manifest = parseManifest(framework, "package.json") as { name?: unknown; version?: unknown; studioCompatibility?: unknown };
  if (manifest.name !== "aws-studio" || manifest.version !== pin.version) {
    throw new IncompatibleProjectError(`The installed package must be aws-studio ${pin.version}. Restore the project's pinned toolchain using npm.`);
  }
  const compatibility = assertSupportedProjectRelease(pin, manifest.studioCompatibility);
  for (const name of ["config", "config/project-declarations", "deploy/stateful-resources", "deploy/stateful-references"]) projectExport(root, name);
  projectCliEntry(root);
  return { root, framework, release: pin, compatibility };
}

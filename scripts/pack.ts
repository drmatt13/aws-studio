import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frameworkCompatibility, stableVersion } from "./release-compatibility";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "packages/aws-studio");
const destination = path.resolve(process.argv[2] ?? path.join(root, "release"));
const npm = process.env.npm_execpath;
if (!npm || process.argv.length > 3) throw new Error("Use npm run pack -- [destination].");
const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
if (manifest.name !== "aws-studio" || !stableVersion.test(manifest.version) ||
  typeof manifest.engines?.node !== "string" || typeof manifest.engines?.npm !== "string" ||
  !frameworkCompatibility(manifest.version, manifest.studioCompatibility)) {
  throw new Error("The framework must declare its own release version, Node/npm engine ranges and Studio compatibility.");
}

const guides = ["FRAMEWORK", "DEV-DEPLOYMENT", "PROD-DEPLOYMENT", "DATABASE", "DATA-FEATURES", "PRISMA-ACCESS", "AGENTCORE"].map(name => `docs/${name}.md`);
const playbooks = ["auth", "feature-build", "prod-deployment", "typed-contract-propagation"].map(name => `docs/playbooks/${name}.md`);
const guidePaths = new Set([...guides, ...playbooks]);
const explicit = new Set(["database/package.json", "cli/database/package.json", "cli/windows-job.ps1", "dev/compose.yml", "dev/Dockerfile", "dev/pgadmin/servers.json"]);
function ships(file: string): boolean {
  if (explicit.has(file)) return true;
  if (!/^(?:src|cdk|cli|scripts|database|local\/(?:api\/(?:src|lib)|invocation\/src|websocket\/(?:src|events)))\//.test(file)) return false;
  if (file.split("/").some(part => part.startsWith(".") || ["node_modules", "test", "tests", "fixtures", "generated"].includes(part))) return false;
  return /\.(?:[cm]?[jt]s|tsx)$/.test(file) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
}
// Build from the working source in the public package directories. Git's ignore rules
// keep local state out; the package allowlist also applies to every tracked file.
const entries = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages/aws-studio"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean).map(name => name.slice("packages/aws-studio/".length)).filter(file => ships(file) && existsSync(path.join(source, file)));
const contents = new Set(entries);
// The platform's client-app/ is Studio source. These paths belong to the installing application.
const appSources = /^(?:cdk-app\/|compute\/|framework-config\/|packages\/(?:database|models|api-contract|framework-generated)\/|\.github\/|QUICKSTART\.md$)/;
function guideForInstallation(guide: string): string {
  const markdown = readFileSync(path.join(root, guide), "utf8");
  return markdown.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (original, label: string, href: string) => {
    if (/^(?:#|[a-z][\w+.-]*:|\/)/i.test(href)) return original;
    const [file, anchor] = href.split("#", 2);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(guide), file));
    let installed: string;
    if (guidePaths.has(target)) installed = target;
    else if (target.startsWith("packages/aws-studio/") && contents.has(target.slice("packages/aws-studio/".length))) installed = target.slice("packages/aws-studio/".length);
    else if (appSources.test(target)) installed = "../../" + target;
    else return `${label} (AWS Studio repository, \`${target}\`)`;
    const link = path.posix.relative(path.posix.dirname(guide), installed) + (anchor ? "#" + anchor : "");
    return `[${label}](${link})`;
  });
}

const staging = mkdtempSync(path.join(os.tmpdir(), "aws-studio-pack-"));
let outputDirectory: string | undefined;
try {
  for (const file of entries) {
    const from = path.join(source, file), to = path.join(staging, file);
    if (!lstatSync(from).isFile() || realpathSync(from) !== path.join(realpathSync(source), file)) throw new Error(`Release source must be a regular package file: ${file}`);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  for (const guide of guidePaths) {
    const to = path.join(staging, guide);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, guideForInstallation(guide));
  }
  const { scripts: _workspaceScripts, devDependencies: _workspaceTypes, ...published } = manifest;
  published.license = "SEE LICENSE IN LICENSE";
  writeFileSync(path.join(staging, "package.json"), JSON.stringify(published, null, 2) + "\n");
  copyFileSync(path.join(root, "LICENSE"), path.join(staging, "LICENSE"));
  chmodSync(path.join(staging, published.bin["aws-studio"]), 0o755);
  mkdirSync(destination, { recursive: true });
  outputDirectory = mkdtempSync(path.join(destination, ".pack-"));
  const output = execFileSync(process.execPath, [npm, "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", outputDirectory], { cwd: staging, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const [archive] = JSON.parse(output);
  const expected = new Set([...entries, ...guidePaths, "package.json", "LICENSE"]);
  const packed = new Set<string>(archive.files.map((file: { path: string }) => file.path));
  if (archive.name !== published.name || archive.version !== published.version || archive.filename !== `aws-studio-${published.version}.tgz` || packed.size !== expected.size || [...expected].some(file => !packed.has(file))) throw new Error("npm packed a different release inventory.");
  renameSync(path.join(outputDirectory, archive.filename), path.join(destination, archive.filename));
  console.log(JSON.stringify({ archive: path.join(destination, archive.filename), files: packed.size, integrity: archive.integrity }));
} finally {
  rmSync(staging, { recursive: true, force: true });
  if (outputDirectory) rmSync(outputDirectory, { recursive: true, force: true });
}

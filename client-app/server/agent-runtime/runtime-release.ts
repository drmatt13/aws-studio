import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { build } from "esbuild";
import { TETHER } from "../deploy/process";
import { buildArchitectureProjector } from "./architecture-preview-runner";
import { AgentTaskStore } from "./store";
import { readSourceManifest } from "aws-studio/source/workspace";
import { readAgentRuntimeRelease, releaseHash, type AgentRuntimeRelease } from "./runtime-release-manifest";
import { ensureWindowsPrivateDirectory } from "aws-studio/cli/windows-security";
import { WINDOWS_JOB } from "aws-studio/cli/owned-process.cjs";
import { buildContractToolchain } from "./contract-validation";
import type { StudioRuntimeTarget } from "./activation";

/** Pin the executable control plane before admitting source changes. No live
 * package symlink or TypeScript loader is retained by the detached host. */
export async function pinAgentRuntime(root: string, state: string): Promise<AgentRuntimeRelease> {
  const store = new AgentTaskStore(state, root); store.close(); // Validates private canonical state and checkout identity.
  const before = readSourceManifest(root).digest;
  const studioRoot = await realpath(path.resolve(__dirname, "../.."));
  const buildRoot = path.dirname(studioRoot), buildBefore = readSourceManifest(buildRoot).digest;
  const protocolSource = await readFile(path.join(studioRoot, "shared/agent-runtime.ts"), "utf8");
  const protocol = Number(/export const AGENT_RUNTIME_VERSION = (\d+) as const;/.exec(protocolSource)?.[1]);
  if (!Number.isSafeInteger(protocol) || protocol < 1) throw new Error("The target agent protocol could not be verified before pinning.");
  const parserEntry = createRequire(path.join(buildRoot, "package.json")).resolve("typescript");
  const entry = path.join(studioRoot, "server/index.ts");
  const loader = await realpath(createRequire(path.join(studioRoot, "package.json")).resolve("tsx"));
  const dependency = path.relative(path.join(buildRoot, "node_modules"), loader);
  if (await realpath(entry) !== entry || !dependency || dependency === ".." || dependency.startsWith(`..${path.sep}`) || path.isAbsolute(dependency)) {
    throw new Error("Resolve Studio's entry and TypeScript loader from this installation before pinning its restart target.");
  }
  // The verified host.cjs release carries this authority with it. Its app root
  // and the observer's registration cannot select an executable or loader.
  const restartTarget: StudioRuntimeTarget = { installation: buildRoot, entry, loader };
  const [host, projector, tether, ownedProcess, windowsJob, contract] = await Promise.all([
    build({ entryPoints: [path.join(__dirname, "host.ts")], bundle: true, platform: "node", format: "cjs", target: "node24", write: false, metafile: true, external: ["esbuild"], logLevel: "silent",
      define: { __STUDIO_RUNTIME_TARGET__: JSON.stringify(restartTarget) },
      plugins: [{ name: "pinned-parser-source-maps", setup(builder) {
        // The host only uses TypeScript's parser. Its optional diagnostic stack
        // helper must not leave an unresolved mutable package import in a release.
        builder.onResolve({ filter: /^source-map-support$/ }, args => path.resolve(args.importer) === path.resolve(parserEntry) ? { path: "source-map-support", namespace: "pinned-parser-source-maps" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "pinned-parser-source-maps" }, () => ({ contents: "exports.install = function () {};", loader: "js" }));
      } }],
    }),
    buildArchitectureProjector(), readFile(TETHER), readFile(createRequire(path.join(buildRoot, "package.json")).resolve("aws-studio/cli/owned-process.cjs")), process.platform === "win32" ? readFile(WINDOWS_JOB) : Promise.resolve(undefined), buildContractToolchain(root),
  ]);
  const imports = Object.values(host.metafile!.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path));
  if (imports.some(name => !name.startsWith("node:") && !builtinModules.includes(name) && name !== "esbuild") || host.outputFiles.length !== 1) throw new Error("The agent host has an unpinned runtime dependency.");
  if (before !== readSourceManifest(root).digest || buildBefore !== readSourceManifest(buildRoot).digest) throw new Error("Studio source changed while pinning its agent runtime. Retry after saved source is stable.");
  const contents = { "host.cjs": Buffer.from(host.outputFiles[0]!.contents), "projector.cjs": projector.bytes, "chain-validator.cjs": contract.worker, "node-test-reporter.cjs": contract.reporter, "contract-policy.json": contract.policy, "contract-identity.cjs": contract.identityWorker, "tether.mjs": tether, "owned-process.cjs": ownedProcess, ...(windowsJob ? { "windows-job.ps1": windowsJob } : {}) };
  const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, releaseHash(bytes)]));
  const digest = releaseHash(JSON.stringify({ version: 1, protocol, files }));
  const releases = path.join(state, "releases");
  if (process.platform === "win32") ensureWindowsPrivateDirectory(releases);
  else await mkdir(releases, { recursive: true, mode: 0o700 });
  const final = path.join(releases, digest);
  try { return readAgentRuntimeRelease(final); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = await mkdtemp(path.join(releases, ".building-"));
  try {
    for (const [name, bytes] of Object.entries(contents)) await writeFile(path.join(temporary, name), bytes, { flag: "wx", mode: 0o400 });
    await writeFile(path.join(temporary, "release.json"), JSON.stringify({ version: 1, protocol, files, digest }), { flag: "wx", mode: 0o400 });
    try { await rename(temporary, final); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    return readAgentRuntimeRelease(final);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

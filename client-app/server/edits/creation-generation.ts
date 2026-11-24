import { projectCliEntry } from "../project-cli";
import { readProjectRelease } from "../project-release";
import { projectRuntime, projectRuntimeEnvironment } from "../project-runtime";
import { lstatSync, realpathSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeModeInputs } from "../inputs";
import { sha256, toRelative } from "../files";
import { EditError } from "aws-studio/source/io";
import { start, stopTree, tethered } from "../deploy/process";

/** Generator-owned output only. Creation runs the real generator; these files
 * are never authored by templates or accepted as HTTP write destinations. */
export function isCreationGeneratedFile(relative: string): boolean {
  return /^packages\/framework-generated\/src\/(?:target-ids|agentcore|event-replay|vpc-endpoint-services)\.ts$/.test(relative)
    || /^packages\/api-contract\/src\/generated\/(?:framework-(?:contracts|routes)|contracts\/[A-Za-z0-9_-]+)\.ts$/.test(relative)
    || relative === "docker-compose.services.yml"
    || /^compute\/(?:services|tasks)\/(?:[A-Za-z0-9_-]+\/)+\.env\.example$/.test(relative)
    || relative === "package-lock.json";
}
/** Fixed internal commands share Studio's owner lifeline and process-tree cleanup. */
export function runCreationCommand(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = start(tethered({ file: command, args, cwd, env, display: `${command} ${args.join(" ")}` }));
    let output = "";
    let stdout = "";
    let failure: Error | undefined;
    let timedOut = false;
    const append = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-6000); };
    child.stdout!.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-6000); append(chunk); }); child.stderr!.on("data", append);
    // Stopping first and settling only on close keeps the preview alive until
    // the command and inherited output pipes have actually been released.
    const timeout = setTimeout(() => { timedOut = true; stopTree(child); }, timeoutMs);
    child.once("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new EditError(422, "Creation artifact generation timed out. Nothing was written."));
      else if (failure) reject(failure);
      else if (code === 0) resolve(stdout);
      else reject(new EditError(422, `Creation artifact generation failed. ${output.trim()}`));
    });
  });
}
/** A private copy contains authored source and manifests, never authored env
 * values, dependencies, database artifacts or deployment outputs. Generation
 * writes there first so its exact results join the same review and journal. */
export async function generateCreationArtifacts(root: string, overrides: ReadonlyMap<string, string>, removedSourceFiles: readonly string[] = []): Promise<{ overrides: Map<string, string>; before: Map<string, string | null>; inputs: Record<string, string>; deletions: Map<string, string> }> {
  const parent = path.join(root, ".cache/framework-studio/previews");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, "creation-"));
  const skip = new Set(["node_modules", ".git", ".cache", ".framework", "cdk.out", "dist", "build", "coverage"]);
  const filter = (source: string): boolean => {
    const name = path.basename(source);
    return path.resolve(source) !== path.join(root, "framework-config/templates") && !skip.has(name) && (!name.startsWith(".env") || name === ".env.example");
  };
  try {
    for (const relative of ["framework.config.ts", "framework-config", "compute", "packages/framework-generated", "packages/api-contract/src/generated", "package.json", "package-lock.json", "docker-compose.yml", "docker-compose.services.yml"]) {
      const source = path.join(root, relative);
      if (existsSync(source)) cpSync(source, path.join(directory, relative), { recursive: true, filter, dereference: false });
    }
    // npm's lockfile generator must see every workspace manifest, including
    // workspaces unrelated to the new resource, so it cannot drop their links.
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { workspaces: string[] };
    for (const relative of globSync(manifest.workspaces.map((pattern) => `${pattern}/package.json`), { cwd: root })) {
      const destination = path.join(directory, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(root, relative), destination);
    }
    const inputs: Record<string, string> = {};
    const baseline = new Map<string, string>();
    const capture = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new EditError(422, "Creation generation cannot read linked source files.");
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) capture(file);
        else if (entry.isFile()) {
          const text = readFileSync(file, "utf8");
          inputs[toRelative(directory, file)] = sha256(text);
          if (isCreationGeneratedFile(toRelative(directory, file))) baseline.set(toRelative(directory, file), text);
        }
      }
    };
    capture(directory);
    for (const file of removedSourceFiles) {
      const removed = path.join(directory, toRelative(root, file)); rmSync(removed, { force: true });
      for (let folder = path.dirname(removed); folder !== directory; folder = path.dirname(folder)) { try { rmdirSync(folder); } catch { break; } }
    }
    for (const [file, text] of overrides) {
      const destination = path.join(directory, toRelative(root, file));
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, text);
    }
    const runtime = projectRuntime(root);
    const env = { ...projectRuntimeEnvironment(runtime), FRAMEWORK_REPOSITORY_ROOT: root, FRAMEWORK_MODE: "dev", FRAMEWORK_INPUTS_FILE: writeModeInputs(directory, "dev") };
    if ([...overrides.keys()].some((file) => path.basename(file) === "package.json")) {
      // npm 10 loses native libc metadata. Refuse it before touching the copy.
      const pin = readProjectRelease(root);
      if (pin?.spec.startsWith("file:")) {
        const relative = pin.spec.slice(5);
        const archive = path.join(root, relative), destination = path.join(directory, relative);
        if (realpathSync(archive) !== path.join(realpathSync(root), relative) || !lstatSync(archive).isFile()) {
          throw new EditError(422, "Creation preview requires the selected project's release archive to be a regular project file.");
        }
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(archive, destination);
      }
      const [major, minor, patch] = runtime.npmVersion.split(".").map(Number);
      if (!(major === 11 && (minor > 19 || minor === 19 && patch >= 1))) throw new EditError(422, "Select project npm 11.19.1 or newer on the 11.x line to preserve native lockfile metadata.");
      await runCreationCommand(runtime.node, [runtime.npm, "install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], directory, env);
    }
    await runCreationCommand(runtime.node, [projectCliEntry(root), "framework:generate", "--repository-root", directory, "--studio-source-preview"], directory, env);
    const result = new Map<string, string>();
    const before = new Map<string, string | null>();
    const visit = (folder: string): void => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (skip.has(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) {
          const relative = toRelative(directory, file);
          if (!isCreationGeneratedFile(relative)) continue;
          const text = readFileSync(file, "utf8");
          const original = baseline.get(relative) ?? null;
          if (original !== text) { result.set(path.join(root, relative), text); before.set(path.join(root, relative), original); }
        }
      }
    };
    visit(directory);
    const deletions = new Map<string, string>();
    for (const [relative, bytes] of baseline) if (!existsSync(path.join(directory, relative))) deletions.set(path.join(root, relative), bytes);
    return { overrides: result, before, inputs, deletions };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

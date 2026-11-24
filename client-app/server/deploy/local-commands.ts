import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { CLIENT_ENVIRONMENT_FILES } from "aws-studio/cli/environment-export";
import type { CommandSpec } from "./process";
import { projectRuntime, projectRuntimeEnvironment } from "../project-runtime";

/**
 * The programs behind local development's persistent processes, started so
 * that they end with their checkout runtime owner.
 *
 * The tether owns a Windows Job Object or POSIX process group so children end
 * with that owner. The client and Compose plugin are launched directly where their
 * declarations permit it, retaining literal argv and avoiding an extra shell.
 */

const SHELL = /[&|;<>`$"'()\\*?{}[\]!~]/;

/** Let Vite read current generated settings instead of inherited deployment outputs. */
export function clientProcessEnvironment(exportDirectory: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const file = path.join(exportDirectory, CLIENT_ENVIRONMENT_FILES.dev);
  if (existsSync(file)) {
    for (const name of Object.keys(parseEnv(readFileSync(file, "utf8")))) {
      if (name.startsWith("VITE_")) delete env[name];
    }
  }
  return env;
}

function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

/** An installed package's executable for a bin name, looked up from a directory as npm does. */
function binEntry(name: string, from: string): string | undefined {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      const bin = readJson(manifest)?.bin;
      const relative = typeof bin === "string" ? bin : bin?.[name];
      return relative ? path.join(path.dirname(manifest), relative) : undefined;
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

/**
 * client-app's dev script, run as `node <program> <args>` in client-app: the
 * script stays the source of truth. A script that needs a shell is not run
 * this way (the caller falls back to npm).
 */
export function clientCommand(root: string, env: NodeJS.ProcessEnv): CommandSpec | undefined {
  const workspace = path.join(root, "client-app");
  const script: unknown = readJson(path.join(workspace, "package.json"))?.scripts?.dev;
  if (typeof script !== "string" || !script.trim() || SHELL.test(script)) return undefined;
  const [program, ...args] = script.trim().split(/\s+/);
  const entry = binEntry(program!, workspace);
  if (!entry || !existsSync(entry) || !/\.(c|m)?js$/.test(entry)) return undefined;
  const runtime = projectRuntime(root);
  return { file: runtime.node, args: [entry, ...args], cwd: workspace, env: projectRuntimeEnvironment(runtime, env), display: `npm --workspace client-app run dev (${script})` };
}

/** Where the Docker CLI looks for its Compose plugin, in its own order. */
/** Where an installed Docker keeps its plugins for every user, after the user's own directory. */
export function systemPluginDirectories(env: NodeJS.ProcessEnv): string[] {
  return process.platform === "win32"
    ? [path.join(env.ProgramFiles ?? "C:\\Program Files", "Docker", "cli-plugins"), path.join(env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "cli-plugins")]
    : ["/usr/local/lib/docker/cli-plugins", "/usr/local/libexec/docker/cli-plugins", "/usr/lib/docker/cli-plugins", "/usr/libexec/docker/cli-plugins", "/Applications/Docker.app/Contents/Resources/cli-plugins"];
}

export function composePlugin(env: NodeJS.ProcessEnv, systemDirectories: readonly string[] = systemPluginDirectories(env)): string | undefined {
  const name = process.platform === "win32" ? "docker-compose.exe" : "docker-compose";
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const directories = [
    env.DOCKER_CONFIG ? path.join(env.DOCKER_CONFIG, "cli-plugins") : path.join(home, ".docker", "cli-plugins"),
    ...systemDirectories,
  ];
  return directories.map((directory) => path.join(directory, name)).find((file) => existsSync(file));
}

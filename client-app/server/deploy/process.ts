import { projectCliEntry } from "../project-cli";
import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { connectionEnvironment } from "aws-studio/cli/aws-connections";
import { COMMAND_NOT_FOUND } from "aws-studio/cli/owned-process.cjs";
import { start, stopTree, tethered, TETHER, type CommandSpec } from "aws-studio/source/process";
export { start, stopTree, tethered, TETHER, type CommandSpec };
import { developmentObservationComposeArgs } from "aws-studio/cli/development-log-compose";
import { composeProjectName } from "aws-studio/cli/compose-project-ownership.mjs";
import { projectRuntime, projectRuntimeEnvironment } from "../project-runtime";

/**
 * How Deploy & Run starts a program: a fixed file and argv, no shell, an
 * explicit working directory and a curated environment.
 *
 * Project commands run through the installed release CLI. The AWS CLI and Docker are started by name, unless
 * FRAMEWORK_AWS_CLI / FRAMEWORK_DOCKER_CLI name a Node script to run in their
 * place (the tests' simulated account and engine).
 */

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the program could not be started at all (ENOENT). */
  readonly missing?: boolean;
}

/** Runs a command to completion and captures its output. Injected in tests. */
export type Runner = (spec: CommandSpec, options?: { timeoutMs?: number }) => Promise<CommandResult>;

/** Credentials a request must never carry into a child: the selected profile decides. */
const DROPPED = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  "AWS_PROFILE", "AWS_DEFAULT_PROFILE",
  // The mode is CDK context, stated per command; a stale variable never decides it.
  "PROD_DEPLOYMENT", "FRAMEWORK_MODE",
  "npm_config_profile",
];

export function studioEnvironment(base: NodeJS.ProcessEnv, options: { readonly profile?: string } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options.profile ? connectionEnvironment(base, options.profile, { validate: false }) : { ...base };
  for (const key of DROPPED) {
    // The selected dependency chain may deliberately use Environment credentials.
    if (options.profile && key.startsWith("AWS_") && !["AWS_PROFILE", "AWS_DEFAULT_PROFILE"].includes(key)) continue;
    delete env[key];
  }
  if (options.profile) env.AWS_PROFILE = options.profile;
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  env.AWS_PAGER = "";
  env.FRAMEWORK_DEPLOY_VIA = "studio";
  return env;
}

export class Tools {
  constructor(readonly root: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Run a fixed release command with the selected app independent of the output cwd. */
  cli(verb: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    const runtime = this.runtime();
    return { file: runtime.node, args: [projectCliEntry(this.root), verb, ...args], cwd,
      env: projectRuntimeEnvironment(runtime, { ...env, FRAMEWORK_REPOSITORY_ROOT: this.root, ...(verb === "export:cdk-outputs" ? { FRAMEWORK_EXPORT_DIRECTORY: cwd } : {}) }), display: ["aws-studio", verb, ...args].join(" ") };
  }

  runtime(installedFramework = true) {
    return projectRuntime(this.root, this.env, { installedFramework });
  }

  docker(args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    if (args[0] === "compose") env = { ...env, COMPOSE_PROJECT_NAME: composeProjectName(cwd, env) };
    args = developmentObservationComposeArgs(cwd, args, env);
    const fake = this.env.FRAMEWORK_DOCKER_CLI;
    return fake
      ? { file: process.execPath, args: [fake, ...args], cwd, env, display: `docker ${args.join(" ")}` }
      : { file: "docker", args, cwd, env, display: `docker ${args.join(" ")}` };
  }

  aws(args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec {
    const fake = this.env.FRAMEWORK_AWS_CLI;
    return fake
      ? { file: process.execPath, args: [fake, ...args], cwd, env, display: `aws ${args.join(" ")}` }
      : { file: "aws", args, cwd, env, display: `aws ${args.join(" ")}` };
  }

  /**
   * npm, by its own entry script: Node refuses to start npm.cmd without a
   * shell on Windows, and a shell is what this module never uses.
   */
  npm(args: readonly string[], env: NodeJS.ProcessEnv, cwd = this.root): CommandSpec | undefined {
    let runtime;
    try { runtime = this.runtime(false); } catch { return undefined; }
    // A parent `npm test --workspaces --if-present` must not change the
    // explicitly selected child target or silently skip its required script.
    const childEnv = projectRuntimeEnvironment(runtime, env);
    for (const key of Object.keys(childEnv)) if (/^npm_config_(?:workspace|workspaces|include_workspace_root|if_present)$/i.test(key)) delete childEnv[key];
    return { file: runtime.node, args: [runtime.npm, ...args], cwd, env: childEnv, display: `npm ${args.join(" ")}` };
  }
}

export function npmCli(env: NodeJS.ProcessEnv = process.env, execPath = process.execPath): string | undefined {
  const bin = path.dirname(execPath);
  const candidates = [
    env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath) ? env.npm_execpath : undefined,
    path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    // Homebrew installs npm outside Node's own directory and links it as bin/npm beside node.
    linkedNpm(bin),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

function linkedNpm(bin: string): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const target = realpathSync(path.join(bin, "npm"));
    return /npm-cli\.js$/.test(target) ? target : undefined;
  } catch {
    return undefined;
  }
}


const OUTPUT_LIMIT = 32 * 1024 * 1024;

export const runCommand: Runner = (spec, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    try {
      child = start(tethered(spec));
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout!.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8"); });
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      stopTree(child, false);
    }, options.timeoutMs) : undefined;
    child.on("error", (error: Error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const missing = code === 127 && stderr.split(/\r?\n/).includes(COMMAND_NOT_FOUND);
      if (timedOut) stderr += `Command timed out after ${options.timeoutMs} ms; its supervised process tree was stopped.\n`;
      resolve({ code: timedOut ? null : code, stdout, stderr, ...(missing ? { missing } : {}) });
    });
  });

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Splits a stream into lines, without colour codes or carriage-return redraws. */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer | string): void; flush(): void } {
  let pending = "";
  const emit = (raw: string) => {
    const text = raw.replace(ANSI, "");
    const last = text.split("\r").filter((part) => part.length > 0).pop() ?? "";
    if (last.trim().length > 0) onLine(last.trimEnd());
  };
  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) emit(line);
    },
    flush() {
      if (pending) emit(pending);
      pending = "";
    },
  };
}

import { projectCliEntry } from "./project-cli";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CommandInfo, CommandResult } from "../shared/api";
import { start, stopTree, tethered } from "./deploy/process";
import { withSourceRead, withSourceWrite } from "aws-studio/source/source-gate";
import { projectRuntime, projectRuntimeEnvironment } from "./project-runtime";

/**
 * The repository commands the studio can run, and no others.
 *
 * Each uses a fixed script and arguments. No shell or request args reach the child, and a
 * command that writes (the generator) runs only when the request says it was
 * confirmed. One command at a time.
 */

export interface CommandDefinition extends CommandInfo {
  /** Each step is a release verb or the Codegen worker with its fixed arguments, run in order until one fails. */
  readonly steps: readonly (readonly string[])[];
}

export const COMMANDS: Readonly<Record<string, CommandDefinition>> = {
  "framework:check": {
    label: "framework:check",
    description: "Checks generated projections are current and runs the framework's local checks. Writes nothing.",
    steps: [
      ["framework:generate", "--check"],
      ["framework:check-local"],
    ],
    writes: false,
  },
  "framework:generate": {
    label: "framework:generate",
    description: "Regenerates target ids, route contracts and docker-compose.services.yml from the config.",
    steps: [["framework:generate"]],
    writes: true,
  },
  "graphql:regenerate": {
    label: "Regenerate GraphQL files",
    description: "Regenerates typed GraphQL documents and schema from saved source, then records the Codegen hashes.",
    steps: [[fileURLToPath(new URL("./graphql-chain/codegen-worker.ts", import.meta.url))]],
    writes: true,
  },
};

const OUTPUT_LIMIT = 256 * 1024;
const TIMEOUT_MS = 5 * 60_000;

export class CommandRunner {
  private running: string | undefined;
  private child: ChildProcess | undefined;
  private pending: Promise<CommandResult> | undefined;
  private closed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly repositoryRoot: string) {}

  get busy(): string | undefined {
    return this.running;
  }

  async run(name: string, confirmed: boolean): Promise<CommandResult> {
    if (this.closed) throw Object.assign(new Error("The Studio command runner is closed."), { status: 503 });
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!command) throw Object.assign(new Error(`${name} is not a command the studio runs.`), { status: 404 });
    if (command.writes && !confirmed) {
      throw Object.assign(new Error(`${name} writes files; confirm it first.`), { status: 428 });
    }
    if (this.running) throw Object.assign(new Error(`${this.running} is still running.`), { status: 409 });
    this.running = name;
    const reserve = command.writes ? withSourceWrite : withSourceRead;
    const pending = reserve(this.repositoryRoot, () => this.execute(name, command));
    this.pending = pending;
    try { return await pending; }
    finally { this.pending = undefined; this.running = undefined; }
  }

  /** Commands and their descendants belong to this Studio lifetime. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    if (this.child) stopTree(this.child);
    this.disposal = (async () => { await this.pending?.catch(() => undefined); })();
    return this.disposal;
  }

  private async execute(name: string, command: CommandDefinition): Promise<CommandResult> {
    const started = Date.now();
    const runtime = projectRuntime(this.repositoryRoot);
    const local = createRequire(path.join(this.repositoryRoot, "package.json"));
    const codegen = name === "graphql:regenerate";
    const loader = codegen ? ["--import", pathToFileURL(local.resolve("tsx")).href] : [projectCliEntry(this.repositoryRoot)];
    let output = "";
    let exitCode: number | null = 0;
    const regeneration = codegen ? (await import("./graphql-chain/regenerate")).prepareCodegenRegeneration(this.repositoryRoot) : undefined;
    try {
      for (const step of command.steps) {
        if (this.closed) { exitCode = null; break; }
        const display = regeneration ? "GraphQL Codegen (saved schema and documents)" : `aws-studio ${step.join(" ")}`;
        output += `$ ${display}\n`;
        exitCode = await new Promise<number | null>((resolve) => {
          const child = start(tethered({
            file: runtime.node,
            args: [...loader, ...step, ...(regeneration ? [regeneration.artifact] : [])],
            cwd: this.repositoryRoot,
            env: projectRuntimeEnvironment(runtime, { ...process.env, FRAMEWORK_REPOSITORY_ROOT: this.repositoryRoot, FORCE_COLOR: "0", NO_COLOR: "1" }),
            display,
          }));
          this.child = child;
          const append = (chunk: Buffer) => {
            if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8");
          };
          child.stdout!.on("data", append);
          child.stderr!.on("data", append);
          const timer = setTimeout(() => stopTree(child), TIMEOUT_MS);
          child.on("error", (error) => {
            output += `${error.message}\n`;
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            this.child = undefined;
            resolve(code);
          });
        });
        if (exitCode !== 0) break;
      }
      if (regeneration && exitCode === 0) {
        if (this.closed) exitCode = null;
        else try { output += `\n${regeneration.publish(output)}\n`; }
        catch (error) { exitCode = 1; output += `\n${error instanceof Error ? error.message : String(error)}\n`; }
      }
    } finally { regeneration?.cleanup(); }
    return { command: name, exitCode, output: output.slice(0, OUTPUT_LIMIT), durationMs: Date.now() - started };
  }
}

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { projectToolchainEnv } from "../packages/aws-studio/cli/project-node.mjs";

export function studioArguments(args, cwd) {
  const named = args.includes("--project") || args.includes("--create-project");
  const result = !named && args[0] && !args[0].startsWith("-") ? ["--project", ...args] : [...args];
  for (const flag of ["--project", "--create-project"]) {
    const index = result.indexOf(flag);
    const value = result[index + 1];
    if (index >= 0 && value && !value.startsWith("--")) result[index + 1] = path.resolve(cwd, value);
  }
  return result;
}

export function runStudioChild(node, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { ...options, windowsHide: true });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}

function localLoader(root, distribution) {
  if (!existsSync(path.join(root, "node_modules/.package-lock.json"))) return;
  const require = createRequire(path.join(root, "package.json"));
  const local = specifier => {
    const file = realpathSync(require.resolve(specifier));
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Missing local Studio dependency ${specifier}.`);
    }
    return file;
  };
  try {
    local("aws-studio/cli/project-node.mjs");
    local("@repo/framework-generated/vpc-endpoint-services");
    local("express");
    if (!distribution) local("vite");
    return local("tsx");
  } catch { return undefined; }
}

// The source lock already points to this local file dependency. Keep a prepared
// test fixture when present. Ordinary launches only need a generic host peer.
function prepareSourcePeer(root) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const directory = path.join(root, lock.packages["node_modules/@repo/framework-generated"].resolved);
  if (existsSync(path.join(directory, "package.json"))) return;
  const parent = path.dirname(directory);
  mkdirSync(parent, { recursive: true });
  const staged = mkdtempSync(path.join(parent, "studio-host-"));
  try {
    const targets = {
      LAMBDA_TARGET_IDS: "LambdaTargetId", LAMBDA_SOURCE_DIRECTORIES: "LambdaSourceDirectory",
      EVENT_LAMBDA_IDS: "EventLambdaId", TOOL_LAMBDA_IDS: "ToolLambdaId", SERVICE_TARGET_IDS: "ServiceTargetId",
      SERVICE_SOURCE_DIRECTORIES: "ServiceSourceDirectory", TASK_TARGET_IDS: "TaskTargetId",
      TASK_SOURCE_DIRECTORIES: "TaskSourceDirectory", WORKFLOW_TARGET_IDS: "WorkflowTargetId", AGENT_TARGET_IDS: "AgentTargetId",
    };
    const modules = {
      "vpc-endpoint-services": [
        'import { InterfaceVpcEndpointAwsService as Service } from "aws-cdk-lib/aws-ec2";',
        "const services = Object.getOwnPropertyNames(Service).map(name => Reflect.get(Service, name) as unknown);",
        "const names = services.flatMap(service => service instanceof Service ? [service.shortName] : []);",
        'export const INTERFACE_ENDPOINT_SERVICES = [...new Set(names)].filter(name => name !== "s3" && name !== "dynamodb").sort();',
      ],
      "target-ids": [
        "export const LAMBDA_SOURCE_DIRECTORY_BY_ID: Readonly<Record<string, string>> = {};",
        ...Object.entries(targets).flatMap(([name, type]) => [`export const ${name}: readonly string[] = [];`, `export type ${type} = string;`]),
      ],
      agentcore: ["export const AGENTCORE_AGENTS = {};", "export const AGENTCORE_TOOLS = {};", "export interface AgentCoreAgents {}", "export interface AgentCoreTools {}"],
      "event-replay": ["export const EVENT_REPLAY_MANIFEST = {} as const;", "export type EventReplayId = string;"],
    };
    const exports = Object.fromEntries(Object.keys(modules).map(name => [`./${name}`, `./${name}.ts`]));
    writeFileSync(path.join(staged, "package.json"), JSON.stringify({ name: "@repo/framework-generated", version: "1.0.0", private: true, exports }));
    for (const [name, source] of Object.entries(modules)) writeFileSync(path.join(staged, `${name}.ts`), source.join("\n") + "\n");
    renameSync(staged, directory);
  } finally {
    rmSync(staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function liveInstaller(name) {
  const match = /^(\d+)-[A-Za-z0-9]+$/.exec(name);
  if (!match) return false;
  try { process.kill(Number(match[1]), 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export async function prepareStudioDependencies(root, distribution, runtime, env) {
  const ready = () => localLoader(root, distribution);
  const loader = ready();
  if (loader) return loader;

  // Publish a process claim before checking for other installers. At most one
  // process can proceed with npm ci, and a dead launcher leaves an ignored claim.
  const installers = path.join(root, ".cache/studio-installers");
  mkdirSync(installers, { recursive: true });
  const claim = mkdtempSync(path.join(installers, `${process.pid}-`));
  try {
    if (readdirSync(installers).some(name => name !== path.basename(claim) && liveInstaller(name))) {
      throw new Error("Another AWS Studio launch is preparing this installation. Run Studio again after that setup finishes.");
    }
    if (!distribution) prepareSourcePeer(root);
    const repaired = ready();
    if (repaired) return repaired;

    process.stderr.write("Installing AWS Studio’s locked dependencies…\n");
    const installEnv = projectToolchainEnv(runtime, env);
    const status = await runStudioChild(runtime.node, [runtime.npm, "ci", "--include=dev", "--no-audit", "--no-fund"], {
      cwd: root, env: installEnv, stdio: ["inherit", 2, 2],
    });
    const installed = status === 0 && ready();
    if (!installed) throw new Error(`AWS Studio dependency setup failed (npm exit ${status}). Run Studio again to retry.`);
    return installed;
  } finally {
    rmSync(claim, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

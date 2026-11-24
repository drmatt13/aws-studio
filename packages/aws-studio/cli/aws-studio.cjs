#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const release = path.resolve(__dirname, "..");
const commands = require("./commands.cjs");

function childExit(node, args, options) {
  const child = spawn(node, args, { ...options, stdio: "inherit", windowsHide: true });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}

async function main([verb, ...args]) {
  if (!verb || ["--help", "-h", "help"].includes(verb)) {
    process.stdout.write("Usage: aws-studio <command> [arguments]\n\n" + Object.keys(commands).sort().join("\n") + "\n");
    return 0;
  }
  if (!Object.hasOwn(commands, verb)) {
    process.stderr.write(`Unknown AWS Studio command: ${verb}. Run aws-studio --help.\n`);
    return 2;
  }
  require("tsx/cjs");
  const { frameworkRepositoryRoot } = require("../src/config/repository-root.ts");
  const { findProjectToolchain, projectToolchainEnv } = await import("./project-node.mjs");
  const root = frameworkRepositoryRoot();
  const tools = findProjectToolchain(root);
  const env = { ...projectToolchainEnv(tools), FRAMEWORK_REPOSITORY_ROOT: root };
  const loader = pathToFileURL(require.resolve("tsx")).href;
  if (verb === "db:copy-configuration-inputs") {
    if (args.length !== 2) throw new Error("db:copy-configuration-inputs requires source and destination directories.");
    args = args.map(directory => path.resolve(directory));
  }
  let cwd = root;
  if (verb === "export:cdk-outputs" && env.FRAMEWORK_EXPORT_DIRECTORY) cwd = path.resolve(env.FRAMEWORK_EXPORT_DIRECTORY);
  if (verb === "framework:generate" && args.includes("--repository-root")) {
    const directory = args[args.indexOf("--repository-root") + 1];
    if (!directory || directory.startsWith("--")) throw new Error("--repository-root requires a directory.");
    cwd = path.resolve(directory);
    env.FRAMEWORK_REPOSITORY_ROOT = cwd;
    args[args.indexOf("--repository-root") + 1] = cwd;
  }
  const steps = commands[verb];
  for (const [index, [entry, ...fixed]] of steps.entries()) {
    let argv;
    if (entry === "npm") argv = [tools.npm, ...fixed];
    else if (entry === "node-test") argv = ["--import", loader, "--test", ...fixed];
    else argv = ["--import", loader, path.resolve(release, entry), ...fixed];
    if (index === steps.length - 1) argv.push(...args);
    const code = await childExit(tools.node, argv, { cwd, env });
    if (code !== 0) return code;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

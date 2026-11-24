import { execFileSync, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeName = process.platform === "win32" ? "node.exe" : "node";
const pathValue = env => Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";

function versionParts(version) {
  return /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
}

function supports(version, minimum) {
  const actual = versionParts(version);
  const required = versionParts(minimum);
  return actual?.[0] === required[0] && (actual[1] > required[1] || actual[1] === required[1] && actual[2] >= required[2]);
}

function npmBesideNode(node, minimum) {
  const bin = path.dirname(node);
  let compatible;
  for (const candidate of [path.join(bin, "node_modules/npm/bin/npm-cli.js"), path.join(bin, "../lib/node_modules/npm/bin/npm-cli.js"), path.join(bin, "npm")]) {
    try {
      const entry = realpathSync(candidate);
      if (path.basename(entry) !== "npm-cli.js") continue;
      const manifest = JSON.parse(readFileSync(path.join(path.dirname(entry), "../package.json"), "utf8"));
      if (manifest.name !== "npm" || !supports(manifest.version, minimum)) continue;
      const result = { npm: entry, npmVersion: manifest.version };
      if (result.npmVersion === minimum) return result;
      compatible ??= result;
    } catch { /* An installation may use a different directory layout. */ }
  }
  return compatible;
}

export function findProjectToolchain(root, env = process.env) {
  const nodePin = readFileSync(path.join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  const npmPin = /^npm@(\d+\.\d+\.\d+)$/.exec(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).packageManager)?.[1];
  if (!versionParts(nodePin) || !versionParts(npmPin)) throw new Error("Studio requires exact Node and npm versions in .nvmrc and package.json.");

  const home = env.HOME || env.USERPROFILE || homedir();
  const data = process.platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const local = path.join(data, "aws-studio", "node", nodePin);
  const nvm = path.join(env.NVM_DIR || path.join(home, ".nvm"), "versions", "node", `v${nodePin}`, "bin");
  const override = env.AWS_STUDIO_NODE;
  const candidates = override !== undefined ? [override] : [process.execPath,
    path.join(local, process.platform === "win32" ? "" : "bin", nodeName), path.join(nvm, nodeName),
    ...(env.NVM_HOME ? [path.join(env.NVM_HOME, `v${nodePin}`, nodeName)] : []),
    ...(process.platform === "darwin" ? ["/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node"] : []),
    ...pathValue(env).split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, nodeName)),
  ];
  const seen = new Set();
  let compatible;
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const node = realpathSync(candidate);
      if (seen.has(node)) continue;
      seen.add(node);
      const npm = npmBesideNode(node, npmPin);
      if (!npm) continue;
      const version = execFileSync(node, ["--version"], { env: { ...env, NODE_OPTIONS: "", NODE_PATH: "" }, encoding: "utf8", timeout: 2_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^v/, "");
      if (!supports(version, nodePin)) continue;
      const result = { node, ...npm, version };
      if (version === nodePin && npm.npmVersion === npmPin || override !== undefined) return result;
      compatible ??= result;
    } catch { /* Try the next installed Node distribution. */ }
  }
  if (compatible) return compatible;
  const problem = override === undefined ? `Running Node ${process.versions.node}. No supported Node and npm pair was found.` : "AWS_STUDIO_NODE must point to an absolute path to a supported Node executable with npm installed beside it.";
  throw new Error(`${problem} Install the official Node ${nodePin} distribution with npm ${npmPin} using your version manager, or set AWS_STUDIO_NODE to its executable.`);
}

export function projectToolchainEnv(toolchain, env = process.env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (/^(?:path|npm_execpath|npm_node_execpath)$/i.test(key)) delete childEnv[key];
  childEnv.PATH = [path.dirname(toolchain.node), pathValue(env)].filter(Boolean).join(path.delimiter);
  childEnv.npm_execpath = toolchain.npm;
  childEnv.npm_node_execpath = toolchain.node;
  return childEnv;
}

export function runProjectCommand(root, [command, ...args]) {
  if (command !== "node" && command !== "npm") throw new Error("Choose node or npm, followed by command arguments.");
  const selected = findProjectToolchain(root);
  const child = spawn(selected.node, command === "npm" ? [selected.npm, ...args] : args, {
    env: projectToolchainEnv(selected), stdio: "inherit", windowsHide: true,
  });
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.once("error", error => process.stderr.write(`${error.message}\n`));
  child.once("close", (code, signal) => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

// The detached Studio host bundles the resolver as CommonJS, where import.meta.url is absent.
if (typeof import.meta.url === "string" && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { runProjectCommand(process.env.FRAMEWORK_REPOSITORY_ROOT ?? process.cwd(), process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

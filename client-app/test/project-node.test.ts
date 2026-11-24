import { installFixtureRelease } from "./support/project-cli";
import { createRequire } from "node:module";
import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { findProjectToolchain, projectToolchainEnv } from "aws-studio/cli/project-node.mjs";

const nodeVersion = "24.22.2", npmVersion = "11.19.1";
const posixTool = { skip: process.platform === "win32" ? "Executable fixture uses a POSIX shell" : false };

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-project-node-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const root = path.join(directory, "project with spaces"), working = path.join(root, "client app");
  mkdirSync(working, { recursive: true });
  writeFileSync(path.join(root, ".nvmrc"), `${nodeVersion}\n`);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: `npm@${npmVersion}` }));
  installFixtureRelease(root);
  const launcher = createRequire(path.join(root, "package.json")).resolve("aws-studio/cli/project-node.mjs");
  return { directory, root, working, launcher };
}

function installedToolchain(directory: string, versions = { node: nodeVersion, npm: npmVersion }) {
  const node = path.join(directory, "bin", "node");
  const npm = path.join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(path.dirname(node), { recursive: true });
  mkdirSync(path.dirname(npm), { recursive: true });
  writeFileSync(node, `#!/bin/sh
if [ "$1" = '--version' ]; then
  printf '%s\n' 'v${versions.node}'
  exit 0
fi
printf '%s\n' "$PATH" "$npm_execpath" "$npm_node_execpath" "$PWD" "$@"
exit 23
`, { mode: 0o700 });
  writeFileSync(npm, "// Disposable npm entry.\n");
  writeFileSync(path.join(path.dirname(npm), "..", "package.json"), JSON.stringify({ name: "npm", version: versions.npm }));
  return { node, npm, version: versions.node, npmVersion: versions.npm };
}

test("invalid explicit Node selection reports the override even on a machine with a supported runtime", t => {
  const { directory, root } = fixture(t);
  assert.throws(() => findProjectToolchain(root, { ...process.env, AWS_STUDIO_NODE: path.join(directory, "missing-node") }), /AWS_STUDIO_NODE/);
});

test("explicit Node selection validates the bundled npm and supported Node versions", posixTool, t => {
  const { directory, root } = fixture(t);
  const compatible = installedToolchain(path.join(directory, "compatible distribution"), { node: "24.23.0", npm: "11.20.0" });
  const selected = findProjectToolchain(root, { ...process.env, AWS_STUDIO_NODE: compatible.node });
  assert.equal(selected.node, compatible.node);
  assert.equal(selected.npm, compatible.npm);
  assert.equal(selected.version, compatible.version);

  const wrongNode = installedToolchain(path.join(directory, "wrong Node"), { node: "26.0.0", npm: npmVersion });
  const wrongNpm = installedToolchain(path.join(directory, "wrong npm"), { node: nodeVersion, npm: "11.19.0" });
  for (const toolchain of [wrongNode, wrongNpm]) {
    assert.throws(() => findProjectToolchain(root, { ...process.env, AWS_STUDIO_NODE: toolchain.node }), /AWS_STUDIO_NODE/);
  }
});

test("automatic selection prefers the managed project pin across bootstrap Node versions", posixTool, t => {
  const { directory, root, launcher } = fixture(t);
  const data = path.join(directory, "managed data");
  const pinned = installedToolchain(path.join(data, "aws-studio", "node", nodeVersion));
  const script = `
    import { pathToFileURL } from "node:url";
    const [launcher, root, bootstrap] = process.argv.slice(2);
    const { findProjectToolchain } = await import(pathToFileURL(launcher).href);
    process.execPath = bootstrap;
    console.log(JSON.stringify(findProjectToolchain(root)));
  `;

  for (const version of ["26.13.0", "24.23.0"]) {
    const bootstrap = installedToolchain(path.join(directory, `bootstrap ${version}`), { node: version, npm: "11.20.0" });
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: data, PATH: path.dirname(bootstrap.node) };
    delete env.AWS_STUDIO_NODE;
    const selected = spawnSync(process.execPath, ["--input-type=module", "--eval", script, "toolchain-selection", launcher, root, bootstrap.node], {
      cwd: root, env, encoding: "utf8", timeout: 5000,
    });
    assert.ifError(selected.error);
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout), pinned);
  }
});

test("runtime selection replaces the parent npm and gives Node priority in child PATH", t => {
  const { directory } = fixture(t);
  const firstPath = path.join(directory, "bootstrap bin");
  const toolchain = {
    node: path.join(directory, "managed runtime", "bin", process.platform === "win32" ? "node.exe" : "node"),
    npm: path.join(directory, "managed runtime", "npm-cli.js"),
    npmVersion,
    version: nodeVersion,
  };
  const parent = { PATH: firstPath, npm_execpath: "bootstrap npm", npm_node_execpath: "bootstrap node", STUDIO_TEST: "retained" };
  const env = projectToolchainEnv(toolchain, parent);
  assert.equal(env.PATH, [path.dirname(toolchain.node), firstPath].join(path.delimiter));
  assert.equal(env.npm_execpath, toolchain.npm);
  assert.equal(env.npm_node_execpath, toolchain.node);
  assert.equal(env.STUDIO_TEST, "retained");
  assert.equal(parent.npm_execpath, "bootstrap npm");
});

test("launcher forwards literal arguments and exit status through the selected toolchain", posixTool, t => {
  const { directory, root, working, launcher } = fixture(t);
  const toolchain = installedToolchain(path.join(directory, "selected Node"));
  const args = ["run", "script with spaces", "--", "$literal", "'quote'"];
  const env = { ...process.env, FRAMEWORK_REPOSITORY_ROOT: root, AWS_STUDIO_NODE: toolchain.node, npm_execpath: "bootstrap npm", npm_node_execpath: "bootstrap node" };

  for (const command of ["node", "npm"]) {
    const launched = spawnSync(process.execPath, [launcher, command, ...args], { cwd: working, env, encoding: "utf8", timeout: 5000 });
    assert.ifError(launched.error);
    assert.equal(launched.status, 23, launched.stderr);
    const [childPath, childNpm, childNode, childCwd, ...forwarded] = launched.stdout.trimEnd().split("\n");
    assert.equal(childPath!.split(path.delimiter)[0], path.dirname(toolchain.node));
    assert.equal(childNpm, toolchain.npm);
    assert.equal(childNode, toolchain.node);
    assert.equal(childCwd, working);
    assert.deepEqual(forwarded, command === "npm" ? [toolchain.npm, ...args] : args);
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findProjectToolchain, projectToolchainEnv } from "../../packages/aws-studio/cli/project-node.mjs";
import { platformRoot, readStarterFiles, readStarterSelection, writeStarterFiles } from "../../scripts/test-project-source.mjs";

const [mode, ...extra] = process.argv.slice(2);
assert.ok((mode === "acquire" || mode === "verify") && !extra.length, "Choose acquire or verify.");
const release = JSON.parse(readFileSync(path.join(platformRoot, "scripts/studio-release.json"), "utf8"));
const { version: studioVersion } = JSON.parse(readFileSync(path.join(platformRoot, "package.json"), "utf8"));
for (const version of [studioVersion, release.frameworkVersion, release.runtime.node, release.runtime.npm]) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
}
const temp = realpathSync(process.env.RUNNER_TEMP ?? tmpdir());
const scratch = mkdtempSync(path.join(temp, "studio-ci-"));
const npm = (toolchain, args, cwd = platformRoot, env = process.env, capture = false) =>
  execFileSync(toolchain.node, [toolchain.npm, ...args], {
    cwd, env: projectToolchainEnv(toolchain, env), encoding: "utf8", windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
const select = (root, node) => findProjectToolchain(root, { ...process.env, AWS_STUDIO_NODE: node });

try {
  if (mode === "acquire") {
    const selection = readStarterSelection();
    const starter = path.join(scratch, "starter");
    writeStarterFiles(starter, readStarterFiles(selection));
    const project = select(starter, process.execPath);
    // Acquire the exact app's locked registry content before the offline proof.
    // This step never executes lifecycle scripts from the starter or packages.
    npm(project, ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], starter);
    const cache = realpathSync(npm(project, ["config", "get", "cache"], platformRoot, process.env, true).trim());
    console.log(`Acquired starter ${selection.commit} with Node ${project.version}, npm ${project.npmVersion} on ${process.platform}/${process.arch}.`);
    if (process.env.GITHUB_OUTPUT) {
      assert.ok(!/[\r\n]/.test(project.node + cache), "CI paths must fit on one line.");
      appendFileSync(process.env.GITHUB_OUTPUT,
        `project_node=${project.node}\nnpm_cache=${cache}\nstudio_node_version=${release.runtime.node}\n`);
    }
  } else {
    const projectNode = process.env.AWS_STUDIO_CI_PROJECT_NODE;
    const cache = process.env.npm_config_cache;
    assert.ok(projectNode && path.isAbsolute(projectNode) && cache && path.isAbsolute(cache),
      "Use the project Node executable and cache from the acquire step.");
    const pins = path.join(scratch, "studio-runtime");
    mkdirSync(pins);
    writeFileSync(path.join(pins, ".nvmrc"), release.runtime.node + "\n");
    writeFileSync(path.join(pins, "package.json"), JSON.stringify({ packageManager: `npm@${release.runtime.npm}` }));
    const studio = select(pins, process.execPath);
    const project = select(platformRoot, projectNode);
    assert.equal(studio.version, release.runtime.node);
    assert.equal(studio.npmVersion, release.runtime.npm);
    const env = { ...process.env, npm_config_offline: "true" };
    const output = path.join(scratch, "release");
    npm(project, ["run", "pack", "--", output], platformRoot, env);
    const framework = path.join(output, `aws-studio-${release.frameworkVersion}.tgz`);
    npm(studio, ["run", "pack:studio", "--", output, framework], platformRoot, env);
    const evidence = path.join(scratch, "evidence");
    try {
      execFileSync(studio.node, [path.join(platformRoot, "scripts/verify-studio-distribution.mjs"),
        path.join(output, `aws-studio-${studioVersion}-distribution.tar.gz`), studio.node, project.node, evidence], {
        cwd: platformRoot, env, stdio: "inherit", windowsHide: true,
      });
    } finally {
      const log = path.join(evidence, "evidence.jsonl");
      if (existsSync(log)) process.stdout.write(readFileSync(log));
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

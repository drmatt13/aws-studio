import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, appendFileSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { findProjectToolchain, projectToolchainEnv } from "../packages/aws-studio/cli/project-node.mjs";

export function readDistributionArchive(input, expectedSha256) {
  const archive = realpathSync(input);
  assert.ok(lstatSync(archive).isFile(), "Provide a regular Studio distribution archive.");
  const bytes = readFileSync(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined) {
    assert.match(expectedSha256, /^[\da-f]{64}$/i, "Provide a SHA-256 digest for the Studio distribution.");
    assert.equal(sha256, expectedSha256.toLowerCase(), `SHA-256 does not match for ${archive}`);
  }
  return { archive, sha256, bytes };
}

export function qualificationCache(input) {
  const cache = realpathSync(input);
  assert.ok(lstatSync(cache).isDirectory(), "Provide a populated npm cache directory.");
  accessSync(cache, constants.W_OK);
  return cache;
}

export function distributionJson(root, file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

export function distributionQualification(evidence, cache) {
  const emptyConfig = path.join(evidence, "empty-config");
  const npmUserConfig = path.join(evidence, "empty-npm-user-config");
  const npmGlobalConfig = path.join(evidence, "empty-npm-global-config");
  const gitTemplates = path.join(evidence, "empty-git-templates");
  mkdirSync(gitTemplates);
  for (const file of [emptyConfig, npmUserConfig, npmGlobalConfig]) writeFileSync(file, "", { flag: "wx" });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:AWS_|CDK_|CHECKPOINT_|FRAMEWORK_|STUDIO_|GIT_|NODE_(?:OPTIONS|PATH)$|NPM_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    AWS_CONFIG_FILE: emptyConfig, AWS_SHARED_CREDENTIALS_FILE: emptyConfig, AWS_EC2_METADATA_DISABLED: "true",
    CDK_DISABLE_VERSION_CHECK: "1", CHECKPOINT_DISABLE: "1", COPYFILE_DISABLE: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_TEMPLATE_DIR: gitTemplates,
    npm_config_cache: cache, npm_config_offline: "true",
    npm_config_userconfig: npmUserConfig, npm_config_globalconfig: npmGlobalConfig,
  });

  function record(name, details) {
    appendFileSync(path.join(evidence, "evidence.jsonl"), JSON.stringify({ name, ...details }) + "\n");
    console.log(name);
  }

  function run(name, binary, args, cwd = evidence, childEnv = env, input) {
    const result = spawnSync(binary, args, {
      cwd, env: childEnv, input, encoding: "utf8", timeout: 25 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    record(name, { binary, args, cwd, exit: result.status, signal: result.signal });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr?.trim().slice(-5000));
    return result.stdout.trim();
  }

  function toolchain(label, root, node) {
    const selected = findProjectToolchain(root, { ...env, AWS_STUDIO_NODE: node });
    const runtime = JSON.parse(run(`probe ${label} Node`, selected.node,
      ["-p", "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})"], root));
    const npmVersion = run(`probe ${label} npm`, selected.node, [selected.npm, "--version"], root, projectToolchainEnv(selected, env));
    assert.equal(runtime.version, selected.version);
    assert.equal(npmVersion, selected.npmVersion);
    return { ...selected, platform: runtime.platform, arch: runtime.arch };
  }

  function install({ archive, sha256, bytes }, studioNode, projectNode, { readStarterPin = false } = {}) {
    const installArea = path.join(evidence, "installation");
    mkdirSync(installArea);
    record("retained distribution", { archive, sha256, platform: process.platform, arch: process.arch });
    // Use the verified bytes for both listing and extraction.
    const tar = (name, args) => run(name, "tar", args, evidence, env, bytes);
    const entries = tar("list distribution entries", ["-tzf", "-"]).split(/\r?\n/);
    const kinds = tar("list distribution entry types", ["-tvzf", "-"]).split(/\r?\n/);
    assert.equal(entries.length, kinds.length);
    assert.ok(entries.every((entry, index) => {
      const segments = entry.replace(/\/$/, "").split("/");
      return /^[d-]/.test(kinds[index]) && segments[0] === "aws-studio" &&
        segments.every(segment => segment && segment !== "." && segment !== ".." && !/[\\:]/.test(segment));
    }), "The distribution must contain only regular files or directories below aws-studio/.");
    tar("extract into a fresh installation", ["-xzf", "-", "-C", installArea]);

    const studio = realpathSync(path.join(installArea, "aws-studio"));
    const release = distributionJson(studio, "scripts/studio-release.json");
    assert.equal(distributionJson(studio, "package.json").version, release.version);
    const starterPin = readStarterPin
      ? distributionJson(path.join(studio, "release", "starter"), "package-lock.json").packages["node_modules/aws-studio"]
      : undefined;
    const bundledFramework = path.join(studio, "release", `aws-studio-${release.frameworkVersion}.tgz`);
    const frameworkSha512 = createHash("sha512").update(readFileSync(bundledFramework)).digest("base64");
    assert.equal(release.frameworkIntegrity, `sha512-${frameworkSha512}`);
    const studioRuntime = toolchain("Studio", studio, studioNode);
    const studioEnv = projectToolchainEnv(studioRuntime, { ...env, AWS_STUDIO_PROJECT_NODE: projectNode });
    run("install Studio offline", studioRuntime.node, [studioRuntime.npm, "ci", "--offline", "--no-audit", "--no-fund"], studio, studioEnv);
    const launcher = path.join(studio, "scripts/studio.mjs");
    const version = run("start the installed launcher", studioRuntime.node, [launcher, "--version"], evidence, studioEnv);
    assert.ok(version.includes(`AWS Studio ${release.version} · framework ${release.frameworkVersion} · Node ${studioRuntime.version}`));
    record("installed Studio release", { studio: release.version, studioRuntime, bundledFramework: release.frameworkVersion, version });
    return { studio, release, bundledFramework, studioRuntime, studioEnv, launcher, starterPin };
  }

  return { env, record, run, toolchain, install };
}

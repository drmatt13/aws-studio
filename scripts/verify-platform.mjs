import { spawnSync } from "node:child_process";
import { findProjectToolchain, projectToolchainEnv } from "../packages/aws-studio/cli/project-node.mjs";
import { preparedTestProject, prepareTestProject } from "./prepare-test-project.mjs";
import { platformRoot } from "./test-project-source.mjs";

const suites = [
  ["npm", "--workspace", "aws-studio", "test"],
  ["npm", "--workspace", "framework-studio", "run", "test:unit"],
  ["npm", "--workspace", "framework-studio", "run", "test:contract-propagation"],
  ["npm", "--workspace", "framework-studio", "run", "test:external-project"],
];
const checks = [
  ["npm", "run", "lockfile:check"],
  ["npm", "run", "build"],
  ["npm", "run", "typecheck"],
  ["node", "docs/aws-studio-knowledge/check.mjs"],
];

async function main(mode) {
  if (mode !== "test" && mode !== "verify") throw new Error("Choose test or verify.");
  const runtime = findProjectToolchain(platformRoot);
  const env = projectToolchainEnv(runtime);
  for (const key of Object.keys(env)) {
    if (/^(?:npm_config_(?:workspace|workspaces|include_workspace_root|prefix|global)|FRAMEWORK_REPOSITORY_ROOT|FRAMEWORK_STUDIO_(?:AGENT_)?STATE_DIRECTORY|FRAMEWORK_EXPORT_DIRECTORY|FRAMEWORK_INPUTS_FILE|STUDIO_PROJECT|STUDIO_REPOSITORY_ROOT|FRAMEWORK_LOCAL_DATABASE_TEST|FRAMEWORK_DEVELOPMENT_LOG_DOCKER_TEST|STUDIO_DATABASE_LIVE|STUDIO_SQL_LIVE)$/i.test(key)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    npm_config_offline: "true", AWS_EC2_METADATA_DISABLED: "true", CHECKPOINT_DISABLE: "1",
  });
  const results = [];
  function run([command, ...args]) {
    const flags = command === "npm" ? [runtime.npm, ...args] : args;
    const executed = spawnSync(runtime.node, flags, {
      cwd: platformRoot, env, stdio: "inherit", windowsHide: true,
    });
    results.push({ command: [command, ...args].join(" "), status: executed.status ?? 1 });
    if (executed.error) throw executed.error;
  }
  if (mode === "verify") checks.forEach(run);

  // Prepare once for all suites. Workspace wrappers validate and reuse this
  // release-specific app. Keep the complete suite results even after a failure.
  const app = await prepareTestProject(platformRoot, env);
  env.AWS_STUDIO_TEST_PROJECT = app;
  env.AWS_STUDIO_TEST_PLATFORM = platformRoot;
  suites.forEach(run);
  preparedTestProject(app);
  for (const result of results) console.log(`[platform] ${result.command} exited ${result.status}`);
  return results.some(result => result.status !== 0) ? 1 : 0;
}

try { process.exitCode = await main(process.argv[2]); }
catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }

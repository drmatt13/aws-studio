import { spawnSync } from "node:child_process";
import { findProjectToolchain, projectToolchainEnv } from "../../packages/aws-studio/cli/project-node.mjs";
import { preparedTestProject, prepareTestProject } from "../../scripts/prepare-test-project.mjs";
import { platformRoot } from "../../scripts/test-project-source.mjs";

// The regular workspace wrapper scrubs this opt-in. Keep the CI-only entry
// point scoped to the existing isolated Compose and PostgreSQL test files.
const tests = [
  "packages/aws-studio/database/test/local-startup-live.test.ts",
  "client-app/test/database-team-lifecycle-live.test.ts",
  "client-app/test/compose-project-ownership-live.test.ts",
];

if (process.env.FRAMEWORK_LOCAL_DATABASE_TEST !== "1") {
  throw new Error("Select the isolated local database CI job to run the Docker fixtures.");
}

const runtime = findProjectToolchain(platformRoot);
const app = await prepareTestProject();
const env = projectToolchainEnv(runtime);
for (const key of Object.keys(env)) {
  if (/^(?:FRAMEWORK_REPOSITORY_ROOT|FRAMEWORK_STUDIO_STATE_DIRECTORY|FRAMEWORK_EXPORT_DIRECTORY|FRAMEWORK_INPUTS_FILE|POSTGRES_HOST_PORT|COMPOSE_FILE|COMPOSE_ENV_FILES|COMPOSE_PROJECT_NAME|STUDIO_PROJECT|STUDIO_DATABASE_LIVE|STUDIO_SQL_LIVE)$/i.test(key)) {
    delete env[key];
  }
}
Object.assign(env, {
  AWS_STUDIO_TEST_PROJECT: app, AWS_STUDIO_TEST_PLATFORM: platformRoot, FRAMEWORK_REPOSITORY_ROOT: app,
  npm_config_offline: "true", AWS_EC2_METADATA_DISABLED: "true", CHECKPOINT_DISABLE: "1",
});
const run = spawnSync(runtime.node, ["--import", "tsx", "--test", ...tests], {
  cwd: platformRoot, env, stdio: "inherit", windowsHide: true,
});
if (run.error) throw run.error;
preparedTestProject(app);
process.exitCode = run.status ?? 1;

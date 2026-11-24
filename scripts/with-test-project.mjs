import { spawn } from "node:child_process";
import { findProjectToolchain, projectToolchainEnv } from "../packages/aws-studio/cli/project-node.mjs";
import { preparedTestProject, prepareTestProject } from "./prepare-test-project.mjs";
import { platformRoot } from "./test-project-source.mjs";

const options = process.argv.slice(2);
const useFrameworkRoot = options[0] === "--framework-root";
if (useFrameworkRoot) options.shift();
const [command, ...args] = options;
if (command !== "node" && command !== "npm") throw new Error("Choose node or npm, followed by command arguments.");
const inherited = process.env.AWS_STUDIO_TEST_PLATFORM === platformRoot
  ? preparedTestProject(process.env.AWS_STUDIO_TEST_PROJECT) : undefined;
const app = inherited ?? await prepareTestProject();
const toolchain = findProjectToolchain(platformRoot);
const env = projectToolchainEnv(toolchain);
for (const key of Object.keys(env)) {
  if (/^(?:npm_config_(?:workspace|workspaces|include_workspace_root|prefix|global)|FRAMEWORK_REPOSITORY_ROOT|FRAMEWORK_STUDIO_(?:AGENT_)?STATE_DIRECTORY|FRAMEWORK_EXPORT_DIRECTORY|FRAMEWORK_INPUTS_FILE|STUDIO_(?:PROJECT|REPOSITORY_ROOT)|FRAMEWORK_LOCAL_DATABASE_TEST|FRAMEWORK_DEVELOPMENT_LOG_DOCKER_TEST|STUDIO_DATABASE_LIVE|STUDIO_SQL_LIVE)$/i.test(key)) {
    delete env[key];
  }
}
const child = spawn(toolchain.node, command === "node" ? args : [toolchain.npm, ...args], {
  env: { ...env, AWS_STUDIO_TEST_PROJECT: app, AWS_STUDIO_TEST_PLATFORM: platformRoot,
    ...(useFrameworkRoot ? { FRAMEWORK_REPOSITORY_ROOT: app } : {}),
    npm_config_offline: "true", AWS_EC2_METADATA_DISABLED: "true", CHECKPOINT_DISABLE: "1" },
  stdio: "inherit",
  windowsHide: true,
});
const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.once("close", (code, signal) => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  try { preparedTestProject(app); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode ||= 1; }
});

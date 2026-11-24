import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectToolchainEnv } from "../packages/aws-studio/cli/project-node.mjs";
import { prepareStudioDependencies, runStudioChild, studioArguments } from "../scripts/studio-bootstrap.mjs";
import { findOrInstallToolchain } from "../scripts/studio-toolchain.mjs";

const installation = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const manifest = JSON.parse(readFileSync(path.join(installation, "package.json"), "utf8"));
const release = JSON.parse(readFileSync(path.join(installation, "scripts/studio-release.json"), "utf8"));
const env = { ...process.env };
const caller = env.npm_lifecycle_event === "studio" && path.isAbsolute(env.INIT_CWD ?? "") ? env.INIT_CWD : process.cwd();
const args = studioArguments(process.argv.slice(2), caller);
// npm may consume --project into its own configuration. The positional path is
// already in args. Keep npm invocation settings out of nested Studio installs.
for (const key of Object.keys(env)) {
  if (/^npm_config_(?:project|workspace|workspaces|include_workspace_root|prefix|global)$/i.test(key)) delete env[key];
}

try {
  if (args.includes("--help")) {
    console.log("Open a project with npm run studio <directory> or npm run studio -- --project <directory>. Paths are relative to where you ran the command.");
    console.log("Forward additional Studio flags after --, such as --print, --port <number>, or --create-project <directory>.");
    console.log("For an interrupted upgrade, use --project <directory> --recover-upgrade [--status | --keep-current <id> <fingerprint>] after --.");
  } else {
    const runtime = await findOrInstallToolchain(installation, env);
    if (args.length === 1 && args[0] === "--version") {
      console.log(`AWS Studio ${manifest.version} · framework ${release.frameworkVersion} · Node ${runtime.version}`);
    } else {
      const loader = await prepareStudioDependencies(installation, manifest.name === "aws-studio-distribution", runtime, env);
      const entry = path.join(installation, "client-app/server/index.ts");
      process.exitCode = await runStudioChild(runtime.node, ["--import", pathToFileURL(loader).href, entry, ...args], {
        env: projectToolchainEnv(runtime, env), stdio: "inherit",
      });
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProjectToolchain } from "aws-studio/cli/project-node.mjs";
import { projectRuntimeEnvironment } from "../project-runtime";

const LOADER = fileURLToPath(new URL("./inspection-loader.cjs", import.meta.url));

/** Trusted application inspection keeps every filesystem write grant disabled. */
export function launchInspection(entry: string, root: string, runtime: ProjectToolchain, env: NodeJS.ProcessEnv = process.env) {
  return fork(entry, [], {
    cwd: root,
    execPath: runtime.node,
    execArgv: ["--permission", "--allow-fs-read=*", "--enable-source-maps", "--require", LOADER],
    env: projectRuntimeEnvironment(runtime, { ...env, STUDIO_REPOSITORY_ROOT: root }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

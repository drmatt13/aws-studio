import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findProjectToolchain, projectToolchainEnv, type ProjectToolchain } from "aws-studio/cli/project-node.mjs";

/**
 * The Studio bootstrap override does not select the app runtime. The app's pins
 * and an optional explicit project override select the pair, before any app code.
 */
export function projectRuntime(root: string, env: NodeJS.ProcessEnv = process.env, options: { readonly installedFramework?: boolean } = {}): ProjectToolchain {
  const selectedEnv = { ...env, AWS_STUDIO_NODE: env.AWS_STUDIO_PROJECT_NODE };
  let runtime: ProjectToolchain;
  try { runtime = findProjectToolchain(root, selectedEnv); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("The project must declare its Node version in .nvmrc and its npm version in package.json.");
    }
    throw new Error(message.replaceAll("AWS_STUDIO_NODE", "AWS_STUDIO_PROJECT_NODE"), { cause: error });
  }
  // The packaged project runner and the framework both declare which versions
  // they can execute under. Test those constraints as data, with no app imports.
  function check(file: string, label: string): void {
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { engines?: Record<string, string> };
    for (const [kind, version] of [["node", runtime.version], ["npm", runtime.npmVersion]] as const) {
      const range = manifest.engines?.[kind];
      if (range && !(createRequire(runtime.npm)("semver") as { satisfies(version: string, range: string): boolean }).satisfies(version, range)) {
        throw new Error(`The ${label} requires ${kind} ${range}, but the selected project runtime provides ${version}. Select a supported project toolchain with AWS_STUDIO_PROJECT_NODE.`);
      }
    }
  }
  check("package.json", "project");
  if (options.installedFramework !== false) check("node_modules/aws-studio/package.json", "project framework");
  return runtime;
}

export function projectRuntimeEnvironment(runtime: ProjectToolchain, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = projectToolchainEnv(runtime, env);
  // A launcher or shell preload belongs to the host. The app's own package
  // scripts may set Node options when the command explicitly runs them.
  for (const key of Object.keys(child)) if (/^node_(?:options|path)$/i.test(key)) delete child[key];
  return { ...child, AWS_STUDIO_NODE: runtime.node, AWS_STUDIO_PROJECT_NODE: runtime.node };
}

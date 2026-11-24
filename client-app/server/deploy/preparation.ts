import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readAwsFiles } from "aws-studio/cli/aws-connections";
import { infrastructureFingerprint } from "../infrastructure";
import type { DeployMode } from "../../shared/deploy";

/** Private source evidence, including handler/assets that the graph revision does not cover. */
export function deploymentPreparationFingerprint(root: string, mode: DeployMode, profile: string | undefined, inputsFile: string | undefined, env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha256");
  hash.update(infrastructureFingerprint(root, mode));
  hash.update(JSON.stringify([mode, profile, readAwsFiles(env).revision]));
  // Match resolveRepositoryTarget: an explicit host input override precedes target defaults.
  const input = path.resolve(root, env.FRAMEWORK_INPUTS_FILE ?? inputsFile ?? `cdk-app/.env.${mode}`);
  hash.update(input);
  hash.update(existsSync(input) ? readFileSync(input) : "missing");
  // These entry-point helpers can affect synthesis without appearing in the source graph.
  for (const name of ["cdk-app/framework-inputs.ts", "cdk-app/tsconfig.json"]) {
    hash.update(name);
    hash.update(existsSync(path.join(root, name)) ? readFileSync(path.join(root, name)) : "missing");
  }
  for (const directory of ["scripts", "node_modules/aws-studio/cli"]) {
    const scripts = path.join(root, directory);
    if (!existsSync(scripts)) continue;
    for (const file of readdirSync(scripts, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !/\.(?:[cm]?ts|[cm]?js|json)$/.test(file.name)) continue;
      hash.update(directory + "/" + file.name); hash.update(readFileSync(path.join(scripts, file.name)));
    }
  }
  return hash.digest("hex");
}

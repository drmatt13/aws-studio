import type { ProjectToolchain } from "../packages/aws-studio/cli/project-node.mjs";

export function findOrInstallToolchain(root: string, env?: NodeJS.ProcessEnv): Promise<ProjectToolchain>;

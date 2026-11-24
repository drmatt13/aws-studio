export interface ProjectToolchain {
  readonly node: string;
  readonly npm: string;
  readonly npmVersion: string;
  readonly version: string;
}

export function findProjectToolchain(root: string, env?: NodeJS.ProcessEnv): ProjectToolchain;
export function projectToolchainEnv(toolchain: ProjectToolchain, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function runProjectCommand(root: string, args: readonly string[]): void;

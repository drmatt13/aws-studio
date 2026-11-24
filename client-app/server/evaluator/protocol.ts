import { projectProtocol as PROJECT_PROTOCOL } from "../../../scripts/release-compatibility";
export { PROJECT_PROTOCOL };
export const PROJECT_CAPABILITIES = ["model", "preflight", "input-metadata"] as const;

interface ProjectHello {
  readonly type: "hello";
  readonly protocol: number;
  readonly capabilities: readonly string[];
  readonly node: string;
  readonly version: string;
}

export function projectHello(): ProjectHello {
  return { type: "hello", protocol: PROJECT_PROTOCOL, capabilities: PROJECT_CAPABILITIES, node: process.execPath, version: process.versions.node };
}

export function assertProjectHello(message: unknown, version: string): asserts message is ProjectHello {
  const hello = message as Partial<ProjectHello> | null;
  if (hello?.type !== "hello" || hello.protocol !== PROJECT_PROTOCOL || !Array.isArray(hello.capabilities) ||
      !PROJECT_CAPABILITIES.every(capability => hello.capabilities!.includes(capability))) {
    throw new Error(`The project evaluator did not negotiate Studio project protocol ${PROJECT_PROTOCOL}. Repair the Studio installation before reopening this project.`);
  }
  if (hello.version !== version || typeof hello.node !== "string") {
    throw new Error(`The project evaluator must run on selected Node ${version}. Check AWS_STUDIO_PROJECT_NODE and reopen this project.`);
  }
}

import { localDeployInputs } from "aws-studio/config/source";
import type { FrameworkConfig } from "aws-studio/config";
import { getLocalTargets, getFrameworkTargets, assertPrivateDnsLocalExecution } from "aws-studio/config";
import { resolveServicePort } from "aws-studio/config/source";

export function getTargetEnvironmentPrefix(targetId: string): string {
  return targetId.replace(/-/g, "_").toUpperCase();
}

/** Config says which routes exist; Compose DNS says where containers live. */
export class LocalServiceRegistry {
  private readonly endpoints = new Map<string, string>();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly guard: (targetId: string) => void;
  constructor(options: {
    config: FrameworkConfig;
    repositoryRoot: string;
    environment?: NodeJS.ProcessEnv;
  }) {
    this.environment = options.environment ?? process.env;
    const targets = options.config.privateHostedZones?.some(zone => zone.enabled) ? getFrameworkTargets(options.config) : [];
    this.guard = id => assertPrivateDnsLocalExecution(options.config, `service:${id}`, targets);
    for (const target of getLocalTargets(options.config, ["service"], localDeployInputs(options.repositoryRoot))) {
      this.endpoints.set(target.id, `http://${target.id}:${resolveServicePort(options.config, target.id, options)}`);
    }
  }
  getEndpoint(targetId: string): string | undefined {
    if (!this.endpoints.has(targetId)) return undefined;
    this.guard(targetId);
    return (this.environment[`${getTargetEnvironmentPrefix(targetId)}_SERVICE_URL`] || this.endpoints.get(targetId))?.replace(/\/+$/, "");
  }
}

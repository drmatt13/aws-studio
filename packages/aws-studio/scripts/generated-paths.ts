import path from "node:path";

/**
 * The application workspace that holds what `framework:generate` derives from one application:
 * its target ids, agent tool schemas, event replay manifest and interface endpoint names. The
 * framework reads them from here by package name, so the framework package itself is the same
 * for every application.
 */
export const GENERATED_PACKAGE = "packages/framework-generated";
export const GENERATED_PACKAGE_NAME = "@repo/framework-generated";

/** Every file `framework:generate` writes beside the application's own source, by role. */
export function generatedOutputs(repositoryRoot: string) {
  const projection = (file: string) => path.join(repositoryRoot, GENERATED_PACKAGE, "src", file);
  const contract = (file: string) => path.join(repositoryRoot, "packages", "api-contract", "src", "generated", file);
  return {
    targetIds: projection("target-ids.ts"),
    /** The interface endpoint names `defineNetwork` completes. See `./vpc-endpoint-services`. */
    vpcEndpointServices: projection("vpc-endpoint-services.ts"),
    /** The replay manifest, projected for the one handler that needs it. */
    eventReplay: projection("event-replay.ts"),
    /** Tool schemas, agent tool lists and their types. See `./agentcore-contracts`. */
    agentCore: projection("agentcore.ts"),
    contracts: contract("framework-contracts.ts"),
    routes: contract("framework-routes.ts"),
    /** One module per target with a payload contract; the directory is fully generator-owned. */
    contractModules: contract("contracts"),
  } as const;
}

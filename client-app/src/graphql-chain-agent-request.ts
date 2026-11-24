import type { ContractStage } from "../shared/contract-propagation";

/** Plain-language starting points for the shared Coding composer. */
export const graphQLCodingDrafts: Readonly<Record<ContractStage | "full", { readonly label: string; readonly prompt: string }>> = {
  api: {
    label: "Draft Pothos task",
    prompt: "Compare the repository and Pothos GraphQL API with the saved Prisma contract. Follow docs/playbooks/typed-contract-propagation.md to repair any drift and run the relevant repository and executable-schema checks. Preserve existing public fields, write behavior and authorization. Ask if a change requires a new exposure or behavior decision.",
  },
  codegen: {
    label: "Draft Codegen task",
    prompt: "Regenerate GraphQL outputs from the saved schema and authored operations using the repository's Codegen workflow. Check that the generated outputs match their source. If generation fails because of a schema or operation error, identify the authored source that needs attention.",
  },
  client: {
    label: "Draft client task",
    prompt: "Check authored client operations and TanStack Query options against the saved GraphQL API. Repair compatibility problems while preserving existing selections, query keys and mutation invalidation. Follow docs/playbooks/typed-contract-propagation.md and run the relevant client and integration checks.",
  },
  full: {
    label: "Draft full contract task",
    prompt: "Check the contract from saved Prisma through repositories, the Pothos GraphQL API, generated documents and TanStack Query operations. Follow docs/playbooks/typed-contract-propagation.md. Repair drift in dependency order and run the relevant checks. Preserve existing exposure, authorization, write behavior, client selections and cache behavior. Ask about any new behavior decisions.",
  },
};

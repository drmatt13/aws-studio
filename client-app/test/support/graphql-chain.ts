import type { ChainConfidence, ChainLink, GraphQLChain } from "aws-studio/contract-chain/graphql-chain";
import { CHAIN_DEPENDENCIES } from "aws-studio/contract-chain/confidence";
import { proofViewFixture } from "./contract-proof";

export type ChainLinkFixture = ChainLink extends infer Link ? Link extends ChainLink ? Omit<Link, "confidence"> & { readonly confidence?: ChainConfidence } : never : never;

/** Fixtures must declare current confidence independently from their local evidence. */
export function chainLinkFixture(link: ChainLinkFixture): ChainLink {
  const status = link.state.status;
  return { ...link, confidence: link.confidence?.status === "verified" && !["reviewed", "current"].includes(status) ? { status: "stale", diagnostics: [], blockedBy: [] } : link.confidence ?? {
    status: status === "reviewed" || status === "current" ? "verified" : status === "unknown" ? "unavailable" : status === "invalid" ? "failed" : "stale",
    diagnostics: [], blockedBy: [],
  } } as ChainLink;
}

export function withChainLink(chain: GraphQLChain, next: ChainLinkFixture): GraphQLChain {
  const links = chain.links.map(link => link.id === next.id ? chainLinkFixture(next) : link);
  for (let index = 1; index < links.length; index++) {
    const previous = links[index - 1]!, current = links[index]!;
    if (previous.confidence.status !== "verified" && current.confidence.status === "verified") links[index] = { ...current, confidence: {
      status: "blocked", blockedBy: [index === 1 ? "repository-pothos" : "codegen"], diagnostics: [{ code: "UPSTREAM_REVIEW_REQUIRED", message: `Waiting for ${index === 1 ? "repository and API" : "Codegen"} reconciliation and passing checks.` }],
    }, actions: current.actions.filter(action => action.kind !== "acknowledge") };
  }
  const proof = { ...chain.proof, stages: chain.proof.stages.map(view => {
    const link = links.find(link => link.id === (view.stage === "api" || view.stage === "database" ? "prisma-pothos" : view.stage === "codegen" ? "pothos-generated" : "generated-client"));
    if (view.stage === "database" || !link || link.confidence.status === "verified") return view;
    return { ...view, status: link.confidence.status, current: null, diagnostics: link.confidence.diagnostics, action: link.confidence.diagnostics[0]?.message ?? "Recheck and renew this stage's proof." };
  }) };
  return { ...chain, links, proof };
}

/** Source-only fixtures; no application source is changed for chain scenarios. */
export function graphqlChainFixture(): GraphQLChain {
  const prisma = "7c1e" + "0".repeat(56) + "a90b", sdl = "9b44" + "0".repeat(56) + "c2d1";
  return {
    version: 3, proof: proofViewFixture(), revision: "chain-fixture-revision", record: "available",
    dependencies: CHAIN_DEPENDENCIES,
    verification: { database: { status: "passed" }, api: { status: "passed" }, client: { status: "passed" }, consumers: { status: "passed" }, integration: { status: "passed" } },
    nodes: [
      { id: "prisma", caption: "Database contract", name: "contract.prisma", source: "packages/database/prisma/contract.prisma", fingerprint: { status: "available", value: prisma }, reviewedAgainst: null },
      { id: "pothos", caption: "Pothos schema", name: "graphql-api", source: "compute/http/graphql-api/", fingerprint: { status: "available", value: sdl }, reviewedAgainst: prisma },
      { id: "generated", caption: "Generated GraphQL", name: "client-app/src/api/generated", source: "client-app/src/api/generated/", fingerprint: { status: "available", value: sdl }, reviewedAgainst: null },
      { id: "client", caption: "Client operations", name: "client-app/src/api", source: "client-app/src/api/", fingerprint: { status: "available", value: sdl }, reviewedAgainst: sdl },
    ],
    links: [
      chainLinkFixture({ id: "prisma-pothos", kind: "reviewed", state: { status: "reviewed", current: prisma, reviewedAgainst: prisma }, models: { Project: { status: "reviewed", current: prisma, reviewedAgainst: prisma }, User: { status: "reviewed", current: prisma, reviewedAgainst: prisma } }, actions: [] }),
      chainLinkFixture({ id: "pothos-generated", kind: "derived", state: { status: "current" }, checks: { schema: { status: "passed" }, documents: { status: "passed" }, "generated-files": { status: "passed" } }, actions: [] }),
      chainLinkFixture({ id: "generated-client", kind: "derived-then-reviewed", state: { status: "reviewed", current: sdl, reviewedAgainst: sdl }, validation: { status: "passed" }, actions: [] }),
    ],
  };
}

import type { ChainLink, ChainNode, ChainNodeId, GraphQLChain, LinkId } from "aws-studio/contract-chain/graphql-chain";

/** What each arrow does: one review, one generator, one review. Node captions name the layers. */
export const chainLinkNames: Readonly<Record<LinkId, string>> = {
  "prisma-pothos": "Pothos review",
  "pothos-generated": "Codegen",
  "generated-client": "Client review",
};

/** A status's shape, drawn by ChainStatusIcon; colour is never the only cue. */
export type ChainStatusShape = "passed" | "failed" | "attention" | "pending" | "unknown" | "checking";
export type ChainStatusTone = "accept" | "caution" | "refuse" | "quiet";
export interface ChainStatus { readonly label: string; readonly shape: ChainStatusShape; readonly tone: ChainStatusTone }

/** Local evidence is inspectable even when its dependency proof is blocked. */
export function localChainStatus(link: ChainLink): ChainStatus {
  switch (link.state.status) {
    case "reviewed": return { label: "Reviewed", shape: "passed", tone: "accept" };
    case "current": return { label: "Current", shape: "passed", tone: "accept" };
    case "no-review": return { label: "No review recorded", shape: "pending", tone: "caution" };
    case "unknown": return { label: "Unknown", shape: "unknown", tone: "quiet" };
    case "invalid": return { label: "Invalid", shape: "failed", tone: "refuse" };
    case "out-of-date": return { label: "Out of date", shape: "attention", tone: "caution" };
    case "changed": {
      if (link.id !== "prisma-pothos") return { label: "Changed since review", shape: "attention", tone: "caution" };
      const models = Object.entries(link.models).filter(([, state]) => state.status === "changed").map(([model]) => model);
      return { label: models.length === 1 ? `${models[0]} changed` : `${models.length} models changed`, shape: "attention", tone: "caution" };
    }
  }
}

/** The rail reports end-to-end confidence, never a locally passing artifact alone. */
export function chainStatus(link: ChainLink): ChainStatus {
  switch (link.confidence?.status) {
    case "verified": {
      if (!["current", "reviewed"].includes(link.state.status)) return { label: "Unavailable", shape: "unknown", tone: "quiet" };
      return { label: "Approved", shape: "passed", tone: "accept" };
    }
    case "blocked": return { label: "Waiting for upstream", shape: "pending", tone: "caution" };
    case "stale": {
      if (link.state.status === "unknown") return { label: "Check required", shape: "attention", tone: "caution" };
      if (["changed", "no-review", "out-of-date"].includes(link.state.status)) return localChainStatus(link);
      return { label: "Needs review", shape: "attention", tone: "caution" };
    }
    case "failed": return { label: "Verification failed", shape: "failed", tone: "refuse" };
    default: return { label: "Unavailable", shape: "unknown", tone: "quiet" };
  }
}

const ledgerNodes: Readonly<Record<LinkId, readonly [ChainNodeId, ChainNodeId]>> = {
  "prisma-pothos": ["prisma", "pothos"],
  "pothos-generated": ["pothos", "generated"],
  "generated-client": ["generated", "client"],
};
const linkOrder = Object.keys(ledgerNodes) as LinkId[];
const regenerationNeeded: ChainStatus = { label: "Regeneration needed", shape: "attention", tone: "caution" };

/** A handoff compares the upstream output with the input this stage recorded. */
function handoffStatus(linkId: LinkId, nodes: readonly ChainNode[] | undefined): ChainStatus | undefined {
  const [fromId, toId] = ledgerNodes[linkId];
  const from = nodes?.find(node => node.id === fromId), to = nodes?.find(node => node.id === toId);
  if (from?.fingerprint.status !== "available" || to?.fingerprint.status !== "available") return undefined;
  if (!to.reviewedAgainst) return { label: "Not recorded", shape: "pending", tone: "caution" };
  if ((to.normalizedReviewedAgainst ?? to.reviewedAgainst) !== from.fingerprint.value) return { label: "Upstream changed", shape: "attention", tone: "caution" };
  return { label: "In sync", shape: "passed", tone: "accept" };
}

/**
 * A link's standing from the hash ledger alone: the downstream stage recorded the upstream hash it was
 * produced from and the output hash it saved. Both still matching current source means the link is in sync.
 */
export function ledgerStatus(linkId: LinkId, nodes: readonly ChainNode[] | undefined): ChainStatus | undefined {
  const handoff = handoffStatus(linkId, nodes);
  if (handoff?.shape !== "passed") return handoff;
  const to = nodes?.find(node => node.id === ledgerNodes[linkId][1]);
  if (to?.fingerprint.status !== "available") return undefined;
  if (!to.recordedOutput) return { label: "Not recorded", shape: "pending", tone: "caution" };
  if (to.recordedOutput !== to.fingerprint.value) return { label: "Output changed", shape: "attention", tone: "caution" };
  return handoff;
}

function codegenNeedsRegeneration(chain: GraphQLChain | undefined): boolean {
  const link = chain?.links.find(item => item.id === "pothos-generated");
  if (link?.id === "pothos-generated") {
    if (link.checks.documents.status === "failed" && link.checks.documents.diagnostics.some(item => item.code === "INVALID_DOCUMENT")) return false;
    if (link.state.status === "out-of-date") return true;
  }
  const output = chain?.nodes.find(node => node.id === "generated");
  if (output?.recordedOutput === undefined) return false;
  const ledger = ledgerStatus("pothos-generated", chain?.nodes);
  return !!ledger && ledger.shape !== "passed"
    || output.fingerprint.status === "unavailable" && output.fingerprint.diagnostics.some(item => item.code === "SOURCE_MISSING");
}

/**
 * The rail follows the handoffs from left to right. Local output drift belongs to the outgoing
 * handoff, and matching inputs farther downstream cannot bypass an earlier divergence.
 */
export function railStatus(chain: GraphQLChain | undefined, linkId: LinkId): ChainStatus | undefined {
  const link = chain?.links.find(item => item.id === linkId);
  const node = chain?.nodes.find(item => item.id === ledgerNodes[linkId][1]);
  const codegenDrift = linkId !== "prisma-pothos" && codegenNeedsRegeneration(chain);
  const needsRegeneration = linkId === "pothos-generated" && codegenDrift;
  if (link && node && node.recordedOutput === undefined) return needsRegeneration ? regenerationNeeded : chainStatus(link);
  if (!needsRegeneration && chain?.inspection?.status === "ready" && link?.confidence.status === "failed") return { label: "Verification failed", shape: "failed", tone: "refuse" };
  const handoff = handoffStatus(linkId, chain?.nodes);
  if (!codegenDrift && (!handoff || handoff.label === "Not recorded")) return handoff;
  for (const upstream of linkOrder.slice(0, linkOrder.indexOf(linkId))) {
    const upstreamLink = chain?.links.find(item => item.id === upstream);
    const failed = chain?.inspection?.status === "ready" && upstreamLink?.confidence.status === "failed";
    if (failed || handoffStatus(upstream, chain?.nodes)?.shape !== "passed" || upstream === "pothos-generated" && codegenDrift) {
      return { label: "Waiting for upstream", shape: "pending", tone: "caution" };
    }
  }
  if (needsRegeneration) return regenerationNeeded;
  if (handoff?.shape !== "passed") return handoff;
  const local = ledgerStatus(linkId, chain?.nodes);
  // The last stage has no outgoing edge on which to show its own unrecorded output.
  if (linkId === "generated-client" && local?.label === "Output changed") return local;
  return node?.approvalRecorded && local?.shape === "passed" ? { ...handoff, label: "Approved" } : handoff;
}

export type ChainAvailability = "loading" | "available" | "failed";
/** The one standing a stage shows. The rail gate and the open card both read it, so they never disagree. */
export function stageStatus(chain: GraphQLChain | undefined, linkId: LinkId, { availability, checking, retained }: { readonly availability: ChainAvailability; readonly checking: boolean; readonly retained: boolean }): ChainStatus {
  if (availability === "loading") return { label: "Reading hashes…", shape: "checking", tone: "quiet" };
  if (availability === "failed") return { label: "Unknown", shape: "unknown", tone: "quiet" };
  if (!retained) return { label: "Checking…", shape: "checking", tone: "quiet" };
  const ledger = railStatus(chain, linkId);
  if (checking && chain?.fingerprints === undefined && ledger?.shape !== "passed") return { label: "Checking…", shape: "checking", tone: "quiet" };
  return ledger ?? { label: "Unknown", shape: "unknown", tone: "quiet" };
}

/** Why a ledger standing reads as it does, for a card whose live check has not run since the last save or restart. */
export function standingExplanation(status: ChainStatus): string | undefined {
  switch (status.label) {
    case "Approved": return "Approved in graphql-chain.review.json for the current saved source. That approval is committed with the source, so it holds across restarts and fresh checkouts. Check again re-runs the independent checks on this machine.";
    case "In sync": return "The current upstream output matches the input recorded for this stage. See Proof lineage for approvals and check results.";
    case "Waiting for upstream": return "An earlier handoff needs attention before this stage can be in sync.";
    case "Regeneration needed": return "Use Regenerate GraphQL to produce files from the current schema and operations.";
    case "Upstream changed": return "The stage before this one changed after this stage was recorded. Use Check again to see what needs updating.";
    case "Output changed": return "This stage's files changed after they were recorded. Use Check again to verify the changes.";
    case "Not recorded": return "No approval covers this stage. Use Check again to read current evidence.";
    default: return undefined;
  }
}

export function firstChainDetail(chain: GraphQLChain): LinkId {
  return chain.links.find(link => link.confidence.status === "failed")?.id
    ?? chain.links.find(link => link.confidence.status !== "verified")?.id
    ?? "prisma-pothos";
}

export function shortFingerprint(value: string): string {
  return value.length > 16 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

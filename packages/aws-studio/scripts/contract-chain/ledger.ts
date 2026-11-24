import type { ChainLedgerEntry, ChainNode, ChainNodeId, GraphQLChainReviewRecordV3, LedgerStage } from "./graphql-chain";
import { writeSourceChange } from "../source/io";
import { withSourceWrite } from "../source/source-gate";
import { currentReviewRecord, parseReviewRecord, serializeReviewRecord } from "./core";
import { recordContents, reviewRecordPath } from "./inspector";
import { sourceFingerprints } from "./source-fingerprints";

/** Each stage reads one node and produces the next. */
export const LEDGER_STAGES: Readonly<Record<LedgerStage, { readonly from: ChainNodeId; readonly to: ChainNodeId }>> = {
  api: { from: "prisma", to: "pothos" },
  codegen: { from: "pothos", to: "generated" },
  client: { from: "generated", to: "client" },
};

function current(nodes: readonly ChainNode[], id: ChainNodeId): string {
  const node = nodes.find(item => item.id === id);
  if (node?.fingerprint.status !== "available") throw new Error(`The ${node?.caption ?? id} hash is unavailable; nothing was recorded.`);
  return node.fingerprint.value;
}

/** Pure merge, so callers and tests share one rule. */
export function withLedgerEntries(record: GraphQLChainReviewRecordV3, nodes: readonly ChainNode[], stages: readonly LedgerStage[], recordedAt: string): GraphQLChainReviewRecordV3 {
  const ledger: Partial<Record<LedgerStage, ChainLedgerEntry>> = { ...record.ledger };
  for (const stage of stages) {
    const { from, to } = LEDGER_STAGES[stage];
    ledger[stage] = { source: current(nodes, from), output: current(nodes, to), recordedAt };
  }
  return { ...record, ledger };
}

/** Record the current saved hashes of the given stages in graphql-chain.review.json.
 * Touches only the ledger; review receipts and bindings are preserved verbatim. */
export async function recordChainLedger(root: string, stages: readonly LedgerStage[]): Promise<{ readonly changed: boolean; readonly nodes: readonly ChainNode[] }> {
  if (!stages.length) return { changed: false, nodes: sourceFingerprints(root) };
  return withSourceWrite(root, async () => {
    const before = recordContents(root);
    const record = currentReviewRecord(before === null ? null : parseReviewRecord(before));
    const nodes = sourceFingerprints(root);
    // Skip a rewrite when the recorded hashes already match, so timestamps do not churn.
    const unchanged = stages.every(stage => {
      const entry = record.ledger?.[stage], { from, to } = LEDGER_STAGES[stage];
      return entry && entry.source === current(nodes, from) && entry.output === current(nodes, to);
    });
    if (unchanged) return { changed: false, nodes };
    const after = serializeReviewRecord(withLedgerEntries(record, nodes, stages, new Date().toISOString()));
    writeSourceChange(root, reviewRecordPath(root), before, after);
    return { changed: true, nodes: sourceFingerprints(root) };
  });
}

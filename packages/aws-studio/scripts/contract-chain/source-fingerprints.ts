import { createHash } from "node:crypto";
import type { ChainLedger, ChainNode, LedgerStage } from "./graphql-chain";
import type { ContractProofReceipts } from "./contract-proof";
import { readSourceManifest } from "../source/workspace";
import { CONTRACT_SOURCE_PATHS, contractFileGroup, contractSourceFileDigest, fixedContractBytes } from "./portable-identity";
import { portableFileDigest } from "./portable-dependencies";
import { parseReviewRecord, REVIEW_RECORD_FILE } from "./core";
import { captureContractSourceProjection, recordedContractStages } from "./source-lease";

const { database: prisma, api, generated, client } = CONTRACT_SOURCE_PATHS;
const fingerprintInput = (name: string): boolean => !!contractFileGroup(name)
  || Object.values(CONTRACT_SOURCE_PATHS).some(target => target === name || target.startsWith(name + "/"));
const hash = /^[a-f0-9]{64}$/;
/** Only exact observed legacy source bytes establish this translation. */
const legacyPrismaFingerprints = new Map<string, string>();
const MAX_LEGACY_PRISMA_FINGERPRINTS = 128;

/** The displayed commitments use the same portable text normalization as proof. */
export function sourceFingerprintsFromFiles(files: Readonly<Record<string, string>>, recorded: ContractProofReceipts = {}, ledger: ChainLedger = {}): readonly ChainNode[] {
  const group = (group: NonNullable<ReturnType<typeof contractFileGroup>>) => {
    const entries = Object.entries(files).filter(([name, value]) => contractFileGroup(name) === group && hash.test(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return entries.length ? { status: "available" as const, value: createHash("sha256").update(JSON.stringify(entries)).digest("hex") }
      : { status: "unavailable" as const, diagnostics: [{ code: "SOURCE_MISSING", message: "No saved source files were found for this stage." }] };
  };
  // The ledger records, per stage, the upstream hash it was produced from and the
  // output hash it produced, in the same units as the displayed node fingerprints.
  // An approval receipt uses the same units and stands in when no ledger entry exists.
  const consumed = (stage: LedgerStage): string | null => {
    const value = ledger[stage]?.source ?? recorded[stage]?.inputs.upstreamContent;
    return value && hash.test(value) ? value : null;
  };
  const produced = (stage: LedgerStage): string | null => {
    const value = ledger[stage]?.output ?? (ledger[stage] ? undefined : recorded[stage]?.outputs.content);
    return value && hash.test(value) ? value : null;
  };
  return [
    { id: "prisma", caption: "Database contract", name: "contract.prisma", source: prisma, fingerprint: files[prisma] && hash.test(files[prisma]) ? { status: "available", value: files[prisma] } : group("database"), reviewedAgainst: null, recordedOutput: null },
    { id: "pothos", caption: "Pothos schema", name: "graphql-api", source: `${api}/`, fingerprint: group("api"), reviewedAgainst: consumed("api"), recordedOutput: produced("api") },
    { id: "generated", caption: "Generated GraphQL", name: generated, source: `${generated}/`, fingerprint: group("generated"), reviewedAgainst: consumed("codegen"), recordedOutput: produced("codegen") },
    { id: "client", caption: "Client operations", name: client, source: `${client}/`, fingerprint: group("client"), reviewedAgainst: consumed("client"), recordedOutput: produced("client") },
  ];
}

/** Saved source and its recorded hash ledger, independent of executable checks. Never writes. */
export function sourceFingerprints(root: string, recorded?: ContractProofReceipts, policyRoot?: string): readonly ChainNode[] {
  const manifest = readSourceManifest(root, fingerprintInput).files;
  const files: Record<string, string> = {};
  let oldPrismaHash: string | undefined;
  for (const [name, entry] of Object.entries(manifest)) if (contractFileGroup(name)) {
    const bytes = fixedContractBytes(root, name)!;
    if (createHash("sha256").update(bytes).digest("hex") !== entry.hash) throw new Error("Source changed while reading displayed contract fingerprints.");
    files[name] = contractSourceFileDigest(name, bytes);
    if (name === prisma) oldPrismaHash = portableFileDigest(name, bytes);
  }
  let ledger: ChainLedger = {};
  let recordDigest: string | undefined;
  try {
    const bytes = fixedContractBytes(root, REVIEW_RECORD_FILE, true);
    if (bytes && bytes.length <= 2 * 1024 * 1024) {
      const record = parseReviewRecord(bytes.toString("utf8"));
      if (record.version === 3) {
        recorded ??= record.proofs;
        ledger = record.ledger ?? {};
        recordDigest = createHash("sha256").update(bytes).digest("hex");
      }
    }
  } catch { /* Missing or invalid records never supply recorded hashes. */ }
  const currentPrismaHash = files[prisma];
  const nodes = sourceFingerprintsFromFiles(files, recorded ?? {}, ledger).map(node => {
    if (node.id !== "pothos" || !node.reviewedAgainst || !oldPrismaHash || !currentPrismaHash || node.reviewedAgainst === currentPrismaHash) return node;
    if (node.reviewedAgainst === oldPrismaHash) {
      legacyPrismaFingerprints.set(oldPrismaHash, currentPrismaHash);
      if (legacyPrismaFingerprints.size > MAX_LEGACY_PRISMA_FINGERPRINTS) legacyPrismaFingerprints.delete(legacyPrismaFingerprints.keys().next().value!);
    }
    return legacyPrismaFingerprints.get(node.reviewedAgainst) === currentPrismaHash ? { ...node, normalizedReviewedAgainst: currentPrismaHash } : node;
  });
  if (!recorded?.api?.inputs.upstreamContent || !recordDigest) return nodes;
  const receipts = recorded;
  try {
    const source = captureContractSourceProjection(root, policyRoot);
    if (source.record !== recordDigest) return nodes;
    const approved = recordedContractStages(receipts, source);
    return nodes.map((node, index) => {
      const stage = (["database", "api", "codegen", "client"] as const)[index]!;
      const receipt = receipts[stage];
      return receipt && approved.includes(stage) && receipt.inputs.upstreamContent === node.reviewedAgainst && receipt.outputs.content === node.recordedOutput
        ? { ...node, approvalRecorded: true } : node;
    });
  } catch { return nodes; }
}

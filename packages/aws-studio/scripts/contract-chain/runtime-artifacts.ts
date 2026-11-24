import { createHash } from "node:crypto";
import { accessGraphArtifactSemantics } from "../../database/access-graph-artifact";
import { portableFileDigest } from "./portable-dependencies";

/** The ignored database outputs used by the executable schema and its independent verification. */
export const RUNTIME_CONTRACT = "packages/database/src/generated/contract.json";
export const RUNTIME_CONTRACT_TYPES = "packages/database/src/generated/contract.d.ts";
export const CLIENT_ACCESS_OUTPUT = "packages/database/src/generated/client-access.ts";
export const ACCESS_GRAPH_OUTPUT = "packages/database/src/generated/access-graph.json";
export const DATABASE_RUNTIME_OUTPUTS = [RUNTIME_CONTRACT, RUNTIME_CONTRACT_TYPES, CLIENT_ACCESS_OUTPUT, ACCESS_GRAPH_OUTPUT] as const;

/** Omit Access Graph navigation positions from receipts, while byte guards still use raw artifacts. */
export function databaseRuntimeArtifactDigest(name: string, bytes: Buffer): string {
  if (name === ACCESS_GRAPH_OUTPUT && !bytes.includes(0)) {
    const text = bytes.toString("utf8");
    if (Buffer.from(text).equals(bytes)) try {
      return createHash("sha256").update(accessGraphArtifactSemantics(text)).digest("hex");
    } catch { /* Invalid artifacts keep separate byte identities and fail verification. */ }
  }
  return portableFileDigest(name, bytes);
}

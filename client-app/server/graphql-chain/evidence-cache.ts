import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChainObservation } from "aws-studio/contract-chain/inspector";
import { isGraphQLChainResponse, isLegacyGraphQLChainResponse } from "aws-studio/contract-chain/graphql-chain-response";
import { unavailableProofView } from "aws-studio/contract-chain/proof";

const LIMIT = 8 * 1024 * 1024;
const relative = ".cache/framework-studio/graphql-chain";

async function cacheDirectory(root: string, create: boolean): Promise<string> {
  let directory = await realpath(root);
  for (const part of relative.split("/")) {
    directory = path.join(directory, part);
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Linked evidence-cache storage is unsupported.");
  }
  return directory;
}

/** Restored evidence is always provisional; it never authorizes acknowledgement. */
export async function readEvidenceCache(root: string): Promise<{ checkedAt: string; observation: ChainObservation } | undefined> {
  let handle;
  try {
    const directory = await cacheDirectory(root, false);
    handle = await open(path.join(directory, "evidence.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT) return;
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    const after = await handle.stat();
    if (count !== info.size || after.size !== info.size || after.nlink !== 1 || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return;
    const value = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (![2, 3].includes(value.version) || value.root !== root || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))
      || !value.observation || typeof value.observation.evaluationRevision !== "string" || !value.observation.chain
      || !(value.version === 3 ? isGraphQLChainResponse(value.observation.chain) : isLegacyGraphQLChainResponse(value.observation.chain)) || !/^[a-f0-9]{64}$/.test(value.observation.chain.revision)
    ) return;
    if (value.version === 2) value.observation.chain = { ...value.observation.chain, version: 3, proof: unavailableProofView("Legacy observations are historical. Run current independent checks and renew proof.") };
    return { checkedAt: value.checkedAt, observation: value.observation };
  } catch { return; }
  finally { await handle?.close(); }
}

export async function writeEvidenceCache(root: string, observation: ChainObservation, checkedAt: string): Promise<void> {
  let temporary: string | undefined;
  try {
    const { proofInput: _capture, proof: _derived, ...history } = observation;
    const bytes = Buffer.from(JSON.stringify({ version: 3, root, checkedAt, observation: history }));
    if (bytes.length > LIMIT) return;
    const directory = await cacheDirectory(root, true), destination = path.join(directory, "evidence.json");
    try { const info = await lstat(destination); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    temporary = path.join(directory, `evidence-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    await rename(temporary, destination); temporary = undefined;
  } catch { /* Cache availability never changes the evidence or source outcome. */ }
  finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
}

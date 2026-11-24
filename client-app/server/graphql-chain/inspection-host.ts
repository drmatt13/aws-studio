import path from "node:path";
import { sandboxedChainEvaluation } from "./sandbox";
import type { InspectionPhase } from "aws-studio/contract-chain/inspection-budget";
import type { GraphQLChainInspector } from "aws-studio/contract-chain/inspector";
import { captureContractSourceProjection, establishContractSourceLease, retainedContractStages, type ContractSourceLease } from "aws-studio/contract-chain/source-lease";
import { sourceFingerprints } from "aws-studio/contract-chain/source-fingerprints";
import { writeEvidenceCache } from "./evidence-cache";
import { GraphQLChainWatchInputs } from "./watch-inputs";
import { DependencyObservationChangedError, dependencyObservationGeneration, withDependencyObservationScope } from "aws-studio/contract-chain/dependencies";
import { watchContractSources, type SourceWatcher } from "./source-watcher";
import { assertContractInspectionNode, ChainInspectionError, inspectionFailure } from "aws-studio/contract-chain/inspection-diagnostics";
import { EditError } from "aws-studio/source/io";

const root = process.argv[2];
if (!root || !path.isAbsolute(root) || !process.send) throw new Error("The fixed inspection host requires its repository and private IPC.");
let inspector: GraphQLChainInspector | undefined;
let loadedDependencyGeneration: number | undefined;
let activeInspectionId: number | undefined;
const progress = (phase: InspectionPhase) => {
  if (!closing && activeInspectionId !== undefined) process.send?.({ type: "progress", id: activeInspectionId, phase });
};
let inputs: GraphQLChainWatchInputs | undefined, lease: ContractSourceLease | undefined;
const publishSources = () => {
  try {
    const source = lease && watcher && inputs ? captureContractSourceProjection(root) : undefined;
    const retained = source ? retainedContractStages(root, lease, source, inputs!.dependencyStamp()) : [];
    process.send?.({ type: "sources", generation, nodes: sourceFingerprints(root), basisRevision: lease?.revision, retained });
  }
  catch { process.send?.({ type: "sources", generation, nodes: null }); }
};
let generation = 0, timer: NodeJS.Timeout | undefined;
const pendingInputs = new Set<string>();
let fullScan = false;
let watcher: SourceWatcher | undefined;
function flushInputs(): void {
  if (timer) clearTimeout(timer); timer = undefined;
  if (!inputs) return;
  try {
    const scan = fullScan, files = [...pendingInputs];
    pendingInputs.clear(); fullScan = false;
    let changed = scan ? inputs.notified(undefined) : false;
    if (!scan) for (const file of files) changed = inputs.notified(file) || changed;
    if (changed) { generation++; process.send?.({ type: "invalidated", generation }); publishSources(); }
  } catch { lease = undefined; watcher?.close(); watcher = undefined; process.send?.({ type: "watch-unavailable" }); }
}
const watching = (async () => { try {
  const failed = () => { lease = undefined; watcher?.close(); watcher = undefined; process.send?.({ type: "watch-unavailable" }); };
  watcher = await watchContractSources(root, filename => {
    if (filename === undefined) fullScan = true; else pendingInputs.add(filename);
    if (!timer) timer = setTimeout(flushInputs, 150);
  }, failed);
  // Notifications are installed first; events arriving during this synchronous
  // inventory are queued and reconciled after it, without an initialization gap.
  publishSources();
  inputs = new GraphQLChainWatchInputs(root);
} catch { process.send?.({ type: "watch-unavailable" }); } })();

process.on("message", async (message: { type?: string; id?: number; fresh?: boolean; cacheOnly?: boolean }) => {
  if (message.type !== "inspect" || !Number.isSafeInteger(message.id)) return;
  if (closing || activeInspectionId !== undefined) return;
  activeInspectionId = message.id;
  progress("starting");
  try {
    assertContractInspectionNode();
    await watching;
    const began = generation;
    if (!inspector) {
      loadedDependencyGeneration = dependencyObservationGeneration(root);
      inspector = new (await import("aws-studio/contract-chain/inspector")).GraphQLChainInspector(root, { onProgress: progress, evaluate: sandboxedChainEvaluation });
    }
    progress("source");
    assertLoadedDependencyGeneration(root);
    let enteredInspector = false;
    let observation = await withDependencyObservationScope(root, undefined, () => {
      enteredInspector = true;
      return inspector!.inspect(message.fresh === true, message.cacheOnly === true);
    }).catch(error => {
      if (enteredInspector || error instanceof DependencyObservationChangedError) throw error;
      throw new ChainInspectionError(422, {
        code: "DEPENDENCY_CAPTURE_FAILED",
        message: "Studio could not capture the installed dependencies. Check for linked or unreadable packages in node_modules and restore the repository's locked installation, then check again.",
      });
    });
    // Let notifications queued during synchronous metadata work arrive. A
    // completed review write may be reported after its new bytes were read.
    await new Promise<void>(resolve => setImmediate(resolve));
    flushInputs();
    assertLoadedDependencyGeneration(root);
    if (began !== generation) observation = await inspector.inspect(false, true);
    progress("publish");
    lease = undefined;
    if (watcher && inputs) try { lease = establishContractSourceLease(root, observation, captureContractSourceProjection(root), inputs.dependencyStamp()); } catch { /* A failed projection cannot preserve old approval. */ }
    const verifiedGeneration = generation;
    const checkedAt = new Date().toISOString();
    if (watcher) await writeEvidenceCache(root, observation, checkedAt);
    assertLoadedDependencyGeneration(root);
    if (verifiedGeneration !== generation) throw new EditError(409, "Saved source changed while publishing inspection. Check again.");
    process.send?.({ type: "result", id: message.id, observation, checkedAt, generation: verifiedGeneration, observed: !!watcher, retained: lease?.verified ?? [] });
  } catch (error) {
    const restartOnDependencyChange = !!watcher && error instanceof DependencyObservationChangedError
      && loadedDependencyGeneration !== undefined && dependencyObservationGeneration(root) !== loadedDependencyGeneration;
    process.send?.({ type: "failed", id: message.id, diagnostic: inspectionFailure(error), ...(restartOnDependencyChange ? { restartOnDependencyChange } : {}) });
  }
  finally { if (activeInspectionId === message.id) activeInspectionId = undefined; }
});
function assertLoadedDependencyGeneration(root: string): void {
  // Control modules were imported under the original generation. Reopening
  // their inspector in this process would reuse those loaded modules.
  if (dependencyObservationGeneration(root) !== loadedDependencyGeneration) throw new DependencyObservationChangedError("Installed dependency observations changed after loading the inspection checker.");
}
let closing = false;
async function close() {
  if (closing) return; closing = true; activeInspectionId = undefined;
  if (timer) clearTimeout(timer);
  watcher?.close(); await inspector?.dispose(); process.exit(0);
}
process.once("disconnect", () => { void close(); });
process.once("SIGTERM", () => { void close(); });

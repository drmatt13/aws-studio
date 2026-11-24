import assert from "./support/assert";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { finalizeContractStages } from "../server/agent-runtime/contract-finalization";
import { dependencyContentIdentity, invalidateDependencyIdentity } from "aws-studio/contract-chain/dependencies";
import { GraphQLChainService } from "../server/graphql-chain/service";
import { GraphQLChainReviews } from "../server/graphql-chain/review";
import { readSourceManifest, type AgentWorkspace, type AgentProposal } from "aws-studio/source/workspace";
import { putRuntimeArtifacts } from "./support/chain-verification";
import type { ContractDecision } from "../shared/contract-propagation";
import type { ChainObservation } from "aws-studio/contract-chain/inspector";

async function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "studio-fresh-finalization-")));
  const entry = path.join(root, "node_modules/example/index.js"); fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"private":true}');
  fs.writeFileSync(path.join(root, "node_modules/example/package.json"), '{"name":"example","version":"1.0.0"}');
  fs.writeFileSync(entry, "export const value = 1;\n"); putRuntimeArtifacts(root);
  const dependencyDigest = await dependencyContentIdentity(root), baseline = readSourceManifest(root);
  const workspace = { repositoryRoot: root, workingDirectory: root, baseline, dependencyDigest } as AgentWorkspace;
  const proposal = { changes: [] } as unknown as AgentProposal;
  const decisions = [{ id: "keep", kind: "exposure", target: "query", status: "established", value: "preserve", evidence: "fixture" }] as ContractDecision[];
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); invalidateDependencyIdentity(root); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, entry, workspace, proposal, decisions };
}
function hooks(t: TestContext, root: string, mutate?: () => void) {
  const events: string[] = []; let inventories = 0, opens = 0;
  const stat = fs.lstatSync, open = fsPromises.open;
  t.mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => {
    if (options?.bigint && path.resolve(String(file)) === path.join(root, "node_modules")) { inventories++; events.push(`inventory:${inventories}`); if (inventories === 3) mutate?.(); }
    return stat(file, options as undefined);
  }) as typeof fs.lstatSync);
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => { if (String(args[0]).startsWith(path.join(root, "node_modules") + path.sep)) opens++; return open(...args); });
  syncBuiltinESMExports();
  t.mock.method(GraphQLChainService.prototype, "inspect", async () => { events.push("inspect"); return { chain: { revision: "fixture-revision" } } as ChainObservation; });
  t.mock.method(GraphQLChainReviews.prototype, "reviewStages", async () => { events.push("plan"); return { reviewId: "fixture-plan", expectedRevision: "fixture-revision" } as never; });
  t.mock.method(GraphQLChainReviews.prototype, "accept", async () => { events.push("accept"); return { status: "recorded", revision: "fixture-recorded", message: "fixture" } as const; });
  return { events, inventories: () => inventories, opens: () => opens };
}

test("saved-source finalization freshly reads package bytes once and closes before accepting the review plan", async t => {
  const f = await fixture(t), h = hooks(t, f.root);
  await finalizeContractStages(f.workspace, f.proposal, ["api"], f.decisions);
  assert.equal(h.opens(), 2); assert.equal(h.inventories(), 3);
  assert.deepEqual(h.events, ["inventory:1", "inventory:2", "inspect", "plan", "inventory:3", "accept"]);
});

test("a dependency drift hidden by equal metadata is rejected before saved-source inspection or review publication", async t => {
  const f = await fixture(t), stamp = fs.lstatSync(f.entry, { bigint: true }), original = fs.lstatSync;
  t.mock.method(fs, "lstatSync", ((file: fs.PathLike, options?: { bigint?: boolean }) => path.resolve(String(file)) === f.entry && options?.bigint ? stamp : original(file, options as undefined)) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  fs.writeFileSync(f.entry, "export const value = 2;\n");
  const h = hooks(t, f.root);
  await assert.rejects(finalizeContractStages(f.workspace, f.proposal, ["api"], f.decisions), /Installed project dependencies changed after candidate validation/);
  assert.equal(h.opens(), 2); assert.deepEqual(h.events, ["inventory:1", "inventory:2"]);
});

test("a failed finalization physical close prevents review receipt publication", async t => {
  const f = await fixture(t), h = hooks(t, f.root, () => fs.writeFileSync(f.entry, "external edit during finalization checks"));
  await assert.rejects(finalizeContractStages(f.workspace, f.proposal, ["api"], f.decisions), /changed during independent contract validation/);
  assert.deepEqual(h.events, ["inventory:1", "inventory:2", "inspect", "plan", "inventory:3"]);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distributionQualification, qualificationCache, readDistributionArchive } from "./distribution-qualification.mjs";

const [oldInput, oldDigest, newInput, newDigest, node24Input, node26Input, evidenceInput, ...extra] = process.argv.slice(2);
if (!evidenceInput || extra.length || !process.env.npm_config_cache) {
  throw new Error("Set npm_config_cache and pass <old archive> <old SHA-256> <new archive> <new SHA-256> <Node 24 executable> <Node 26 executable> <new evidence directory>.");
}

const oldArchive = readDistributionArchive(oldInput, oldDigest);
const newArchive = readDistributionArchive(newInput, newDigest);
assert.notEqual(oldArchive.sha256, newArchive.sha256, "Provide two different retained distributions.");
const cache = qualificationCache(process.env.npm_config_cache);
const node24 = realpathSync(node24Input), node26 = realpathSync(node26Input);
assert.notEqual(node24, node26, "Choose independently installed Node 24 and Node 26 runtimes.");

mkdirSync(path.resolve(evidenceInput), { mode: 0o700 });
const evidence = realpathSync(evidenceInput);
const oldEvidence = path.join(evidence, "old"), newEvidence = path.join(evidence, "current");
mkdirSync(oldEvidence);
mkdirSync(newEvidence);
const old = distributionQualification(oldEvidence, cache).install(oldArchive, node24, node24);
const current = distributionQualification(newEvidence, cache);
const installed = current.install(newArchive, node26, node24);
const qualifier = fileURLToPath(new URL("./qualify-project-compatibility.mjs", import.meta.url));
execFileSync(process.execPath, [qualifier, old.studio, installed.studio, node24, node26, path.join(evidence, "qualification")], {
  cwd: evidence, env: current.env, stdio: "inherit", windowsHide: true,
});

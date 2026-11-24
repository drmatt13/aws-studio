import { writeFile } from "node:fs/promises";
import path from "node:path";
import { assertContractFixtureRuntime } from "./contract-fixture-runtime";

const [root, artifact] = process.argv.slice(2);
if (!root || !artifact || !path.isAbsolute(root) || !path.isAbsolute(artifact)) throw new Error("The fixed contract fixture runner requires absolute fixture inputs.");
assertContractFixtureRuntime();
const began = performance.now();
process.stdout.write(`Contract fixture runtime: Node ${process.versions.node}, pid ${process.pid}.\n`);
void import("./real-contract-propagation").then(({ exerciseRealContractPropagation }) => exerciseRealContractPropagation(root, undefined, message => process.stdout.write(`Contract fixture: ${message} (${Math.round((performance.now() - began) / 1000)}s)\n`)))
  .then(async evidence => {
    await writeFile(artifact, JSON.stringify(evidence) + "\n", { flag: "wx", mode: 0o600 });
    // The complete workflow has awaited its owners' cleanup. Imported tool
    // loaders may retain handles; they must not extend this fixed test's life.
    process.stdout.write("Contract fixture: completed evidence written.\n", () => process.exit(0));
  })
  .catch(error => { process.stderr.write(String(error?.stack ?? error).slice(0, 16_384) + "\n", () => process.exit(1)); });

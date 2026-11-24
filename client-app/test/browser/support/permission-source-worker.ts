import { installFixtureRelease } from "../../support/project-cli";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SnapshotBuilder } from "../../../server/snapshot";
import { EditService } from "../../../server/edits/transaction";
import { generateCreationArtifacts } from "../../../server/edits/creation-generation";

const root = process.argv[2]!;
let builder: SnapshotBuilder | undefined;
async function main() {
  installFixtureRelease(root);
  const generated = await generateCreationArtifacts(root, new Map());
  for (const [file, text] of generated.overrides) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
  for (const file of generated.deletions.keys()) rmSync(file);
  builder = new SnapshotBuilder(root); await builder.refresh();
  const service = new EditService(root, builder);
  process.on("message", async (request: { id: number; method: string; args: any }) => {
    try {
      if (request.method === "dispose") { await builder!.dispose(); process.send?.({ id: request.id, value: true }); process.disconnect(); return; }
      const value = request.method === "plan" ? await service.planBatch(request.args.edits, request.args.revision) : request.method === "apply" ? { applied: await service.applyBatch(request.args.planId), snapshot: builder!.current!.snapshot } : undefined;
      process.send?.({ id: request.id, value });
    } catch (error) { process.send?.({ id: request.id, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  });
  process.send?.({ id: 0, value: builder.current!.snapshot });
}
main().catch(async error => { process.send?.({ id: 0, error: error instanceof Error ? error.stack ?? error.message : String(error) }); await builder?.dispose(); process.exitCode = 1; });
process.on("disconnect", () => { void builder?.dispose().finally(() => { process.exitCode = 0; }); });

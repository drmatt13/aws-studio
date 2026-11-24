import { testProjectRoot } from "../../scripts/test-project";
import { installGenerationFixture } from "./support/project-cli";
import { studioProjectScratch, studioTestScratchRoot } from "./support/source-fixture";
import assert from "./support/assert";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { generateCreationArtifacts } from "../server/edits/creation-generation";
import type { DraftEdit } from "../shared/api";

test("disconnected native access reviews and applies in both graphs with persistent readiness errors and stale guards", async () => {
  const root = studioProjectScratch("resource-access-review-");
  let builder: SnapshotBuilder | undefined;
  try {
    for (const relative of ["framework-config", "cdk-app/lib", "cdk-app/bin", "compute/http/caller"]) mkdirSync(path.join(root, relative), { recursive: true });
    cpSync(path.join(testProjectRoot, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
    writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
    writeFileSync(path.join(root, "cdk-app/cdk.json"), '{"app":"tsx bin/app.ts"}');
    writeFileSync(path.join(root, "compute/http/caller/index.ts"), "export const lambdaHandler = async () => ({ statusCode: 200, body: 'ok' });\n");
    writeFileSync(path.join(root, "framework-config/stacks.ts"), 'import { defineStacks, input, stack, cdk } from "aws-studio/config"; import type { Storage } from "../cdk-app/lib/storage"; export const stacks = defineStacks({ storage: stack<Storage>() });');
    const stackFile = path.join(root, "cdk-app/lib/storage.ts");
    const stackSource = 'import { Stack } from "aws-cdk-lib"; import * as s3 from "aws-cdk-lib/aws-s3"; export class Storage extends Stack { public readonly files: s3.IBucket = new s3.Bucket(this, "Files"); }';
    writeFileSync(stackFile, stackSource);
    writeFileSync(path.join(root, "cdk-app/bin/app.ts"), 'import { App } from "aws-cdk-lib"; new App();');
    const configFile = path.join(root, "framework.config.ts");
    writeFileSync(configFile, 'import { defineFrameworkConfig } from "aws-studio/config"; import { defaults } from "./framework-config/defaults"; import { stacks as resources } from "./framework-config/stacks"; export default defineFrameworkConfig({ defaults, stacks: resources, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], cloud: { bindings: [resources.storage.files.grantRead("legacy/*")] } } }], webSocket: [], services: [], events: [] });');
    installGenerationFixture(root);
    const generated = await generateCreationArtifacts(root, new Map());
    for (const [file, text] of generated.overrides) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
    for (const file of generated.deletions.keys()) rmSync(file);
    builder = new SnapshotBuilder(root);
    await builder.refresh();
    const service = new EditService(root, builder);
    const edit: Extract<DraftEdit, { kind: "connection" }> = { kind: "connection", target: "lambda:caller", connection: "resourceAccess", destination: "resource:storage.files", enabled: true, actions: ["write"], limits: { objectPrefix: "uploads/", requireHttps: true } };
    const before = readFileSync(configFile, "utf8");
    const plan = await service.planBatch([edit], builder.current!.snapshot.revision);
    assert.ok(plan.ok, JSON.stringify(plan.preflight));
    assert.equal(readFileSync(configFile, "utf8"), before, "review does not write source");
    assert.ok(plan.changes.some(change => change.diff.unified.includes("resourceAccess")));
    assert.equal((await service.applyBatch(plan.planId)).status, "applied");
    for (const model of Object.values(builder.current!.snapshot.models)) {
      const grants = model.edges.filter(edge => edge.from === edit.target && edge.to === edit.destination && edge.relation === "grant");
      assert.equal(grants.length, 2);
      assert.equal(model.status, "ok");
      assert.equal(model.resources.find(item => item.id === "resource:storage")?.stackUsage?.status, "unreferenced");
      assert.ok(grants.every(edge => edge.readinessIssues?.some(issue => issue.code === "stack-not-constructed")));
      assert.ok(model.targets.find(item => item.ref === edit.target)?.readinessIssues?.length);
      assert.ok(grants.some(edge => edge.permissionContext?.kind === "native" && edge.permissionContext.method === "grantRead"));
      assert.ok(grants.some(edge => edge.permissionContext?.kind === "resourceAccess" && edge.permissionContext.actions.join() === "write"));
    }
    const update = await service.planBatch([{ ...edit, actions: ["write", "delete"], previous: { actions: edit.actions!, limits: edit.limits } }], builder.current!.snapshot.revision);
    assert.ok(update.ok, JSON.stringify(update.preflight));
    const saved = readFileSync(configFile, "utf8");
    writeFileSync(stackFile, stackSource + "\n// concurrent CDK edit\n");
    await assert.rejects(service.applyBatch(update.planId), /storage\.ts changed after review/);
    assert.equal(readFileSync(configFile, "utf8"), saved);
    await assert.rejects(service.planBatch([edit], builder.current!.snapshot.revision), /storage\.ts changed after review/);
  } finally {
    await builder?.dispose();
    assert.equal(path.dirname(root), path.join(studioTestScratchRoot(), ".cache/framework-studio"));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

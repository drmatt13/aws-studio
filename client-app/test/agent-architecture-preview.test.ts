import assert from "./support/assert";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { defaults } from "../../scripts/test-project-declarations";
import { ARCHITECTURE_PREVIEW_ARTIFACT_MARKER, ARCHITECTURE_PREVIEW_MARKER, compareArchitectureEvaluations, parseArchitectureEvaluation } from "../server/agent-runtime/architecture-preview";
import { readArchitecturePreviewArtifact, runArchitecturePreview } from "../server/agent-runtime/architecture-preview-runner";
import { writeEvaluationArtifact } from "aws-studio/source/result-artifact";
import { freezeAgentProposal, materializeAgentRevision, prepareAgentWorkspace, readSourceManifest } from "aws-studio/source/workspace";
import type { Mode } from "../shared/model";

function output(mode: Mode, changes: Record<string, unknown> = {}, unresolvedConditions = false): string {
  return `${ARCHITECTURE_PREVIEW_MARKER}${JSON.stringify({ version: 1, mode, unresolvedConditions, model: { mode, status: "ok", targets: [], routes: [], resources: [], edges: [], workflows: [], diagnostics: [], ...changes } })}\n`;
}
test("architecture comparison reports semantic changes and avoids deleting an invalid model", () => {
  const before = parseArchitectureEvaluation(output("prod", { targets: [{ ref: "lambda:handler", constructId: "Stable", access: [] }], resources: [{ id: "resource:queue", kind: "stack" }] }), "prod");
  const after = parseArchitectureEvaluation(output("prod", { targets: [{ access: [{ actions: ["sqs:SendMessage"] }], constructId: "Replacement", ref: "lambda:handler" }], routes: [{ id: "route:http:/new" }] }), "prod");
  const result = compareArchitectureEvaluations(before, after);
  assert.equal(result.status, "ready"); assert.equal(result.changes.length, 3);
  const target = result.changes.find(change => change.entity === "target")!;
  assert.deepEqual(target.fields, ["access", "constructId"]);
  assert.match(target.implications.join(" "), /replacement/); assert.match(target.implications.join(" "), /IAM/);
  const failed = parseArchitectureEvaluation(output("prod", { status: "error", diagnostics: [{ severity: "error", message: "Cannot load changed declaration" }] }), "prod");
  assert.deepEqual(compareArchitectureEvaluations(before, failed).changes, []);
  assert.equal(compareArchitectureEvaluations(before, failed).status, "unavailable");
  assert.equal(compareArchitectureEvaluations(before, parseArchitectureEvaluation(output("prod", {}, true), "prod")).status, "partial");
});

test("architecture output validates protocol, identities, bounds and fresh lanes", () => {
  assert.throws(() => parseArchitectureEvaluation(output("dev"), "prod"), /protocol/);
  assert.throws(() => parseArchitectureEvaluation(`${output("dev")}${output("dev")}`, "dev"), /unique result/);
  assert.throws(() => parseArchitectureEvaluation(output("dev", { stale: true }), "dev"), /stale/);
  assert.throws(() => parseArchitectureEvaluation(output("dev", { resources: [{ id: "duplicate" }, { id: "duplicate" }] }), "dev"), /duplicate/);
  assert.throws(() => parseArchitectureEvaluation(output("dev", { resources: [{ id: "invalid\nidentity" }] }), "dev"), /identity/);
  assert.throws(() => parseArchitectureEvaluation(output("dev", { resources: [{ id: "long", value: "x".repeat(128_001) }] }), "dev"), /oversized/);
  const before = parseArchitectureEvaluation(output("dev", { targets: [{ ref: "lambda:a", compute: { memory: 128, runtime: "node" }, implementation: { ready: false } }] }), "dev");
  const after = parseArchitectureEvaluation(output("dev", { targets: [{ implementation: { ready: true }, compute: { runtime: "node", memory: 128 }, ref: "lambda:a" }] }), "dev");
  assert.deepEqual(compareArchitectureEvaluations(before, after).changes, []);
});

test("large architecture models use a verified artifact and a small unique receipt", () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-architecture-artifact-")));
  try {
    const file = path.join(base, "model.json");
    const model = JSON.parse(output("dev", { resources: Array.from({ length: 400 }, (_, at) => ({ id: `resource:${at}`, description: "x".repeat(1000) })) }).slice(ARCHITECTURE_PREVIEW_MARKER.length));
    const receipt = writeEvaluationArtifact(file, model);
    assert.ok(receipt.bytes > 238_782);
    const stdout = `${ARCHITECTURE_PREVIEW_ARTIFACT_MARKER}${JSON.stringify(receipt)}\n`;
    assert.ok(stdout.length < 256);
    assert.equal(readArchitecturePreviewArtifact(stdout, file, "dev").entities.size, 400);
    assert.throws(() => readArchitecturePreviewArtifact(stdout + stdout, file, "dev"), /unique/);
    assert.throws(() => readArchitecturePreviewArtifact(stdout, file, "prod"), /protocol/);
    writeFileSync(file, "corrupted");
    assert.throws(() => readArchitecturePreviewArtifact(stdout, file, "dev"), /bounded regular file/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("frozen preview revisions reconstruct baseline and proposal without reading later source", async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-frozen-revision-")));
  try {
    const root = path.join(base, "project"); mkdirSync(root); writeFileSync(path.join(root, "first.ts"), "baseline");
    const workspace = await prepareAgentWorkspace(root, { storageDirectory: path.join(base, "tasks"), copyDependencies: false });
    writeFileSync(path.join(workspace.workingDirectory, "first.ts"), "proposed"); writeFileSync(path.join(workspace.workingDirectory, "toString"), "new source");
    const proposal = await freezeAgentProposal(workspace);
    writeFileSync(path.join(root, "first.ts"), "later live"); writeFileSync(path.join(workspace.workingDirectory, "first.ts"), "later candidate");
    const baseline = path.join(workspace.directory, "baseline"), candidate = path.join(workspace.directory, "candidate");
    await materializeAgentRevision(workspace, baseline); await materializeAgentRevision(workspace, candidate, proposal);
    assert.equal(readFileSync(path.join(baseline, "first.ts"), "utf8"), "baseline");
    assert.equal(readFileSync(path.join(candidate, "first.ts"), "utf8"), "proposed");
    assert.equal(readSourceManifest(candidate).digest, proposal.candidateDigest);
    await assert.rejects(materializeAgentRevision(workspace, path.join(root, "invalid")), /private task storage/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

async function checkFrameworkAlignment(native: boolean): Promise<void> {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-architecture-worker-")));
  try {
    const root = path.join(base, "project"); mkdirSync(root);
    const write = (name: string, content: string) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
    const api = await build({ entryPoints: [path.resolve(__dirname, "../../packages/aws-studio/src/config/index.ts")], bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" });
    write("package.json", '{"name":"architecture-fixture","packageManager":"npm@11.19.1"}');
    write(".nvmrc", "24.22.2\n");
    write("packages/aws-studio/package.json", '{"name":"aws-studio","exports":{"./config":"./index.cjs"}}');
    write("packages/aws-studio/index.cjs", api.outputFiles![0]!.text);
    write("node_modules/tsx/package.json", '{"name":"tsx","exports":"./loader.mjs"}');
    write("node_modules/tsx/loader.mjs", "// Fixture has no TypeScript syntax; no transform is required.\n");
    symlinkSync(path.join(root, "packages/aws-studio"), path.join(root, "node_modules/aws-studio"), process.platform === "win32" ? "junction" : "dir");
    const sentinel = path.join(base, "private-host-sentinel"); writeFileSync(sentinel, "fixture private bytes");
    const boundary = native ? `const fs = require('node:fs'); for (const attempt of [()=>fs.writeFileSync(__filename,'unexpected source write'),()=>fs.readFileSync(${JSON.stringify(sentinel)})]) { let denied=false; try { attempt(); } catch(error) { denied=['EACCES','EPERM','EROFS'].includes(error.code); } if (!denied) throw new Error('The read-only preview boundary did not deny the fixture probe'); }` : "";
    write("framework.config.ts", `${boundary} if (process.versions.node.split('.')[0] !== '24') throw new Error('Preview must use the project Node'); const f = require('aws-studio/config'); module.exports = f.defineFrameworkConfig({defaults:${JSON.stringify(defaults)}, inputs:f.defineInputs({setting:f.input.value('current')}),http:[],webSocket:[],events:[],services:[],tasks:[],workflows:[],tools:[],agents:[]});`);
    const workspace = await prepareAgentWorkspace(root, { storageDirectory: path.join(base, "tasks") });
    const framework = path.join(workspace.workingDirectory, "packages/aws-studio/index.cjs");
    writeFileSync(framework, `${readFileSync(framework, "utf8")}\nconst original = module.exports; module.exports = {...original, defineFrameworkConfig(input) { return original.defineFrameworkConfig({...input, inputs: original.defineInputs({setting: original.input.value('proposed')})}); }};\n`);
    const proposal = await freezeAgentProposal(workspace), commands: string[][] = [];
    // Executes only this test's known fixture. Production always uses the native
    // sandbox runner; this test proves alignment and command policy, not containment.
    const result = await runArchitecturePreview({ workspace, proposal, signal: new AbortController().signal, run: native ? undefined : async options => {
      assert.equal(options.readOnlyCwd, true); assert.equal(options.readPaths?.length, 1); assert.equal(options.timeoutMs, 30_000);
      assert.equal(options.command.file, options.toolchain?.node); assert.match(options.toolchain?.version ?? "", /^24\./);
      assert.equal(options.cwd.startsWith(workspace.directory), true); commands.push(options.command.args);
      const child = await promisify(execFile)(options.command.file, options.command.args, { cwd: options.cwd, env: { PATH: process.env.PATH, HOME: options.scratchDir, TMPDIR: options.scratchDir }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      return { exitCode: 0, stdout: child.stdout, stderr: child.stderr };
    } });
    assert.equal(result.status, "ready", JSON.stringify(result)); if (!native) assert.equal(commands.length, 4);
    for (const mode of result.modes) assert.ok(mode.changes.some(change => change.entity === "resource" && change.id === "resource:setting" && change.fields.includes("authoredValue")), JSON.stringify(mode));
    assert.equal(readFileSync(path.join(root, "packages/aws-studio/index.cjs"), "utf8"), api.outputFiles![0]!.text);
  } finally { rmSync(base, { recursive: true, force: true }); }
}
test("pinned projector uses each frozen revision's framework instance including framework self edits", () => checkFrameworkAlignment(false));
test("native preview denies source mutation and outside reads for both frozen modes", { skip: process.env.STUDIO_AGENT_NATIVE_PREVIEW !== "1" }, () => checkFrameworkAlignment(true));

import assert from "./support/assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ModelTarget } from "../shared/model";
import { replayHandlerFile, rewriteReplayHandler } from "../server/edits/local-replay";
import { assertWritable } from "../server/files";

const file = "handler.ts";
const plain = '// keep this comment\nimport type { Event } from "aws-lambda";\nexport const lambdaHandler = async (event: Event) => { return event; };\n';

test("replay wrapper edits preserve the body, reuse aliases, and avoid colliding with authored names", () => {
  const enabled = rewriteReplayHandler(file, plain, "lambdaHandler", true);
  assert.match(enabled, /import \{ withLocalReplay \} from "aws-studio\/runtime\/event-replay"/);
  assert.ok(enabled.includes("withLocalReplay(async (event: Event) => { return event; })"));
  assert.ok(enabled.startsWith("// keep this comment"));
  assert.equal(rewriteReplayHandler(file, enabled, "lambdaHandler", true), enabled);
  const disabled = rewriteReplayHandler(file, enabled, "lambdaHandler", false);
  assert.ok(disabled.includes("export const lambdaHandler = async (event: Event) => { return event; };"));
  assert.equal(rewriteReplayHandler(file, disabled, "lambdaHandler", true), enabled);
  const alias = 'import { withLocalReplay as replay } from "aws-studio/runtime/event-replay";\nexport const custom = replay(async (event) => event);';
  assert.ok(rewriteReplayHandler(file, alias, "custom", false).endsWith("export const custom = async (event) => event;"));
  const namespace = 'import * as replay from "aws-studio/runtime/event-replay";\nexport const lambdaHandler = async (event) => event;';
  assert.ok(rewriteReplayHandler(file, namespace, "lambdaHandler", true).includes("replay.withLocalReplay(async"));
  const collision = plain.replace("export const", "const withLocalReplay = 1;\nexport const");
  assert.match(rewriteReplayHandler(file, collision, "lambdaHandler", true), /studioReplay\.withLocalReplay\(async/);
  assert.match(rewriteReplayHandler(file, alias, "custom", true), /studioReplay\.withLocalReplay\(async/);
});

test("replay handler authority rejects noncanonical directories, escaping junctions and linked entry points", () => {
  const root = mkdtempSync(path.resolve(__dirname, "../../.cache/replay-paths-"));
  const directory = path.join(root, "compute/events/example"), outside = path.join(root, "outside");
  mkdirSync(directory, { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "index.ts"), plain);
  const target = { role: "event", directory: "compute/events/example", compute: { kind: "lambda", implementation: "typescript", packaging: "zip", handler: "lambdaHandler" } } as ModelTarget;
  try {
    for (const directory of ["/compute/events/example", "compute/../../outside", "cdk-app/compute/events/example", outside])
      assert.throws(() => replayHandlerFile(root, { ...target, directory }), /directly exported TypeScript handler/);
    symlinkSync(outside, path.join(root, "compute/events/escape"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => replayHandlerFile(root, { ...target, directory: "compute/events/escape" }), /directly exported TypeScript handler/);
    symlinkSync(path.join(outside, "index.ts"), path.join(directory, "index.ts"), "file");
    assert.throws(() => replayHandlerFile(root, target), /directly exported TypeScript handler/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complex capture patterns and comments on the wrapper are refused without rewriting source", () => {
  for (const text of [
    'export function lambdaHandler(event) { return event; }',
    'export { lambdaHandler } from "./implementation";',
    'export const lambdaHandler = async (event) => { captureEventDrivenInvocation(event); };',
    'import { withLocalReplay } from "aws-studio/runtime/event-replay"; export const lambdaHandler = withLocalReplay(/* keep */ async (event) => event);',
  ]) assert.throws(() => rewriteReplayHandler(file, text, "lambdaHandler", false), /directly exported TypeScript handler/);
  assert.throws(() => rewriteReplayHandler(file, 'import { withLocalReplay } from "aws-studio/runtime/event-replay"; export const lambdaHandler = withLocalReplay(handler, options);', "lambdaHandler", true), /directly exported TypeScript handler/);
});

test("handler write permission is restricted to the declared event entry point; the config writer remains restricted", () => {
  const root = mkdtempSync(path.resolve(__dirname, "../../.cache/replay-writes-"));
  const directory = path.join(root, "compute/events/example");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "index.ts"), plain);
  const target = { role: "event", directory: "compute/events/example", compute: { kind: "lambda", implementation: "typescript", packaging: "zip", handler: "lambdaHandler" } } as ModelTarget;
  try {
    assert.equal(replayHandlerFile(root, target).file, path.join(directory, "index.ts"));
    assert.throws(() => assertWritable(root, "compute/events/example/index.ts"), /not a file the studio writes/);
    assert.throws(() => replayHandlerFile(root, { ...target, role: "http" }), /directly exported TypeScript handler/);
    assert.throws(() => replayHandlerFile(root, { ...target, directory: "/../../framework-config" }), /directly exported TypeScript handler/);
    assert.throws(() => replayHandlerFile(root, { ...target, compute: { ...target.compute, handler: "../other.lambdaHandler" } } as ModelTarget), /directly exported TypeScript handler/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { studioTestScratchRoot } from "./support/source-fixture";
import { testProjectRoot } from "../../scripts/test-project";
import { installFixtureRelease } from "./support/project-cli";
import assert from "./support/assert";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { markSourceRecoveryRequired, withSourceRead, withSourceWrite, withSourceWriteSync } from "aws-studio/source/source-gate";

const require = createRequire(import.meta.url);
const atomic = require("aws-studio/cli/atomic-replace.cjs") as typeof import("aws-studio/cli/atomic-replace.cjs");
const cache = path.join(studioTestScratchRoot(), ".cache/framework-studio/snapshot-recovery-tests");
mkdirSync(cache, { recursive: true });
afterEach(() => mock.restoreAll());

function fixture() {
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "framework-config"));
  mkdirSync(path.join(root, "compute/qa"), { recursive: true });
  cpSync(path.join(testProjectRoot, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "package.json"), '{"private":true}');
  writeFileSync(path.join(root, "framework-config/http.ts"), 'export const http = { "/qa": { directory: "compute/qa", methods: ["GET"] } };\n');
  writeFileSync(path.join(root, "compute/qa/index.ts"), 'export const lambdaHandler = async () => ({ statusCode: 200, body: "ready" });\n');
  writeFileSync(path.join(root, "framework.config.ts"), `import { defineFrameworkConfig, defineInputs } from "aws-studio/config";
import { defaults } from "./framework-config/defaults";
import { http } from "./framework-config/http";
export default defineFrameworkConfig({ defaults, inputs: defineInputs({}), http: [http], webSocket: [{}], events: [{}], services: [{}], tasks: [{}], workflows: [{}], tools: [{}], agents: [{}] });
`);
  installFixtureRelease(root);
  return { root, builder: new SnapshotBuilder(root), cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("Studio reloads both configuration modes after an idle checkout folder is renamed", async () => {
  const f = fixture(), relocated = `${f.root}-renamed`;
  let builder: SnapshotBuilder | undefined;
  let moved = false;
  try {
    // The fixture install links this peer to an absolute workspace path.
    // A physical peer makes the disposable installation itself movable.
    const peer = path.join(f.root, "node_modules/@repo/framework-generated");
    unlinkSync(peer);
    cpSync(path.join(f.root, "packages/framework-generated"), peer, { recursive: true });
    const { snapshot: before } = await f.builder.refresh();
    assert.ok(before.models.dev.targets.length > 0);
    await f.builder.dispose();
    renameSync(f.root, relocated); moved = true;
    builder = new SnapshotBuilder(relocated);
    const { snapshot } = await builder.refresh();
    for (const mode of ["dev", "prod"] as const) {
      const model = snapshot.models[mode];
      assert.equal(model.status, "ok", JSON.stringify(model.diagnostics));
      assert.ok(!model.stale);
      assert.deepEqual(model.targets.map(target => target.id), before.models[mode].targets.map(target => target.id));
    }
    assert.equal(builder.publicationState.status, "ready");
  } finally {
    await f.builder.dispose(); await builder?.dispose();
    if (moved) renameSync(relocated, f.root);
    f.cleanup();
  }
});

test("permanent projection failure publishes stale evidence, blocks all edits and recovers only after a successful refresh", async () => {
  const f = fixture();
  const projection = path.join(f.root, ".cache/framework-studio/cdk-links.json");
  try {
    const first = await f.builder.refresh();
    assert.equal(first.snapshot.models.dev.status, "ok", JSON.stringify(first.snapshot.models.dev.diagnostics));
    assert.ok(first.snapshot.models.dev.targets.length > 0);
    const before = readFileSync(projection, "utf8");
    const authored = readFileSync(path.join(f.root, "framework-config/http.ts"), "utf8");
    const original = atomic.replaceFileAtomic;
    const failure = Object.assign(new Error("do-not-copy-authored-exception-values"), { code: "EIO", path: projection });
    const replacement = mock.method(atomic, "replaceFileAtomic", (from: string, to: string, options?: import("aws-studio/cli/atomic-replace.cjs").AtomicReplacementOptions) => {
      if (to === projection) throw failure;
      return original(from, to, options);
    });
    const failed = await f.builder.refresh();
    assert.notEqual(failed.snapshot.revision, first.snapshot.revision);
    assert.equal(f.builder.current, failed);
    assert.deepEqual(failed.snapshot.source, first.snapshot.source);
    for (const mode of ["dev", "prod"] as const) {
      assert.equal(failed.snapshot.models[mode].status, "error");
      assert.equal(failed.snapshot.models[mode].stale, true);
      assert.equal(failed.snapshot.models[mode].diagnostics[0]!.stage, "load");
      assert.deepEqual(failed.snapshot.models[mode].targets, first.snapshot.models[mode].targets);
      assert.match(failed.snapshot.models[mode].diagnostics[0]!.message, /Snapshot refresh failed.*EIO.*cdk-links\.json.*cannot be edited/);
    }
    assert.doesNotMatch(JSON.stringify(failed.snapshot), /do-not-copy-authored-exception-values/);
    const request = { target: "lambda:qa", field: "lambda.memorySize", patch: { origin: 'http["/qa"]', path: ["memorySize"], value: 256 } };
    const preflight = await failed.evaluation.preflight(request);
    assert.equal(preflight.dev.ok, false);
    assert.match(preflight.dev.diagnostics[0]!.message, /Snapshot refresh failed/);
    await assert.rejects(new EditService(f.root, f.builder).plan({ target: "lambda:qa", field: "lambda.memorySize", value: 256 }, failed.snapshot.revision), /stale|configuration|errors/i);
    failure.path = path.join(path.dirname(f.root), "outside-sensitive-path");
    const failedAgain = await f.builder.refresh();
    assert.notEqual(failedAgain.snapshot.revision, failed.snapshot.revision);
    assert.doesNotMatch(JSON.stringify(failedAgain.snapshot.models.dev.diagnostics), /outside-sensitive-path/);
    assert.equal(readFileSync(projection, "utf8"), before, "failed replacement preserves the complete prior projection");
    assert.ok(!readdirSync(path.dirname(projection)).some(file => /^cdk-links-.*\.tmp$/.test(file)), "failed projection cleans only its temporary file");
    assert.equal(readFileSync(path.join(f.root, "framework-config/http.ts"), "utf8"), authored);
    replacement.mock.restore();
    const recovered = await f.builder.refresh();
    assert.equal(recovered.snapshot.models.dev.status, "ok");
    assert.ok(!recovered.snapshot.models.dev.stale);
    const healthy = await recovered.evaluation.preflight(request);
    assert.equal(healthy.dev.ok, true, JSON.stringify(healthy));
    assert.equal(healthy.prod.ok, true, JSON.stringify(healthy));
  } finally { mock.restoreAll(); await f.builder.dispose(); f.cleanup(); }
});

test("initial snapshot I/O failure rejects without publishing a usable graph", async () => {
  const f = fixture();
  const failure = Object.assign(new Error("initial projection failure"), { code: "EIO" });
  mock.method(atomic, "replaceFileAtomic", () => { throw failure; });
  try {
    await assert.rejects(f.builder.refresh(), error => error === failure);
    assert.equal(f.builder.current, undefined);
  } finally { mock.restoreAll(); await f.builder.dispose(); f.cleanup(); }
});

test("an integration epoch invalidates an in-flight graph without publishing mixed or stale evidence", async () => {
  const f = fixture();
  try {
    const first = await f.builder.refresh();
    const cacheBefore = readFileSync(path.join(f.root, ".cache/framework-studio/cdk-links.json"), "utf8");
    const evaluate = f.builder.pool.evaluate.bind(f.builder.pool);
    mock.method(f.builder.pool, "evaluate", async (...args: Parameters<typeof evaluate>) => {
      const result = await evaluate(...args);
      withSourceWriteSync(f.root, () => {
        writeFileSync(path.join(f.root, "framework-config/http.ts"), 'export const http = { "/qa": { directory: "compute/qa", methods: ["GET"], memorySize: 256 } };\n');
      });
      return result;
    });
    await assert.rejects(f.builder.refresh(), /incomplete snapshot was discarded/);
    assert.equal(f.builder.current!.snapshot.revision, first.snapshot.revision, "retain the last complete graph until a clean refresh");
    assert.equal(f.builder.current!.snapshot.models.dev.stale, true, "retained graph is explicitly stale until evaluated at the new epoch");
    assert.equal(f.builder.publicationState.status, "refresh_required");
    assert.equal(readFileSync(path.join(f.root, ".cache/framework-studio/cdk-links.json"), "utf8"), cacheBefore, "an invalidated evaluation cannot publish its disk projection");
    mock.restoreAll();
    const next = await f.builder.refresh();
    assert.notEqual(next.snapshot.revision, first.snapshot.revision);
    assert.equal(next.snapshot.models.dev.status, "ok");
  } finally { mock.restoreAll(); await f.builder.dispose(); f.cleanup(); }
});

test("source ownership cannot promote a snapshot from before an earlier write reservation", async () => {
  const f = fixture();
  try {
    await f.builder.refresh();
    withSourceWriteSync(f.root, () => { assert.equal(f.builder.current!.snapshot.models.dev.status, "ok", "an editor retains its own starting graph"); });
    assert.equal(f.builder.current!.snapshot.models.dev.stale, true);
    withSourceWriteSync(f.root, () => {
      assert.equal(f.builder.current!.snapshot.models.dev.stale, true, "a later owner must refresh rather than promote old evidence");
      assert.notEqual(f.builder.publicationState.status, "ready");
    });
    await f.builder.refresh();
    assert.equal(f.builder.current!.snapshot.models.dev.status, "ok");
  } finally { await f.builder.dispose(); f.cleanup(); }
});

/** A job holds the source from its own async context while the browser reads, so `read` never owns the lease. */
async function whileHeld<T>(hold: typeof withSourceWrite, root: string, read: () => T | Promise<T>): Promise<T> {
  let release!: () => void, entered!: () => void;
  const finish = new Promise<void>(resolve => { release = resolve; }), holding = new Promise<void>(resolve => { entered = resolve; });
  const lease = hold(root, async () => { entered(); await finish; });
  await holding;
  try { return await read(); } finally { release(); await lease; }
}

for (const [name, hold] of [["write", withSourceWrite], ["read", withSourceRead]] as const) {
  test(`a running operation's ${name} hold is ordinary work to the browser, and edits still wait`, async () => {
    const f = fixture();
    try {
      const first = await f.builder.refresh();
      await whileHeld(hold, f.root, async () => {
        assert.equal(f.builder.publicationState.status, "busy");
        assert.equal(f.builder.presented!.snapshot, first.snapshot, "the view stays exactly as it was, with no failure in it");
        assert.equal(f.builder.current!.snapshot.models.dev.stale, true, "the edit authority still refuses the retained graph");
        await assert.rejects(new EditService(f.root, f.builder).plan({ target: "lambda:qa", field: "lambda.memorySize", value: 256 }, first.snapshot.revision), (error: Error) => {
          assert.match(error.message, /operation ends/);
          assert.doesNotMatch(error.message, /does not load/);
          return true;
        });
      });
    } finally { await f.builder.dispose(); f.cleanup(); }
  });
}

test("the refresh after an operation stays quiet, and publishes nothing when nothing changed", async () => {
  const f = fixture();
  try {
    const first = await f.builder.refresh();
    await whileHeld(withSourceWrite, f.root, () => undefined);
    assert.equal(f.builder.publicationState.status, "refresh_required");
    assert.equal(f.builder.presented!.snapshot, first.snapshot);
    const next = await f.builder.refresh();
    assert.equal(f.builder.publicationState.status, "ready");
    assert.equal(next.snapshot, first.snapshot, "a dirty draft and an open review must not read this as a source change");
    assert.notEqual(next.evaluation, first.evaluation, "the replaced evaluators still answer");
    const request = { target: "lambda:qa", field: "lambda.memorySize", patch: { origin: 'http["/qa"]', path: ["memorySize"], value: 256 } };
    assert.equal((await next.evaluation.preflight(request)).dev.ok, true);
    writeFileSync(path.join(f.root, "framework-config/http.ts"), 'export const http = { "/qa": { directory: "compute/qa", methods: ["GET"], memorySize: 256 } };\n');
    assert.notEqual((await f.builder.refresh()).snapshot.revision, first.snapshot.revision, "a real change is still a new revision");
  } finally { await f.builder.dispose(); f.cleanup(); }
});

test("a hold never hides a real load failure", async () => {
  const f = fixture();
  try {
    await f.builder.refresh();
    writeFileSync(path.join(f.root, "framework.config.ts"), "this does not parse (\n");
    const failed = await f.builder.refresh();
    assert.equal(failed.snapshot.models.dev.stale, true);
    await whileHeld(withSourceRead, f.root, () => {
      assert.equal(f.builder.presented!.snapshot, failed.snapshot);
      assert.equal(f.builder.presented!.snapshot.models.dev.stale, true);
    });
  } finally { await f.builder.dispose(); f.cleanup(); }
});

test("source that needs recovery is presented as a failure, not as ordinary work", async () => {
  const f = fixture();
  try {
    await f.builder.refresh();
    await withSourceWrite(f.root, async () => { markSourceRecoveryRequired(f.root, "interrupted-import"); });
    assert.equal(f.builder.publicationState.status, "recovery_required");
    assert.equal(f.builder.presented!.snapshot.models.dev.stale, true);
    assert.equal(f.builder.presented!.snapshot.models.dev.status, "error");
  } finally { await f.builder.dispose(); f.cleanup(); }
});

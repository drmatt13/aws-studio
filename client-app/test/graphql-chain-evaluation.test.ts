import assert from "./support/assert";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, mock, test } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chainInputIdentity } from "aws-studio/contract-chain/inspector";
import { evaluateGraphQLChain, parseChainEvaluation, RUNTIME_CONTRACT, RUNTIME_CONTRACT_TYPES } from "aws-studio/contract-chain/evaluation";
import { CLIENT_ACCESS_OUTPUT, ACCESS_GRAPH_OUTPUT } from "aws-studio/contract-chain/runtime-artifacts";
import { writeEvaluationArtifact } from "aws-studio/source/result-artifact";
import type { ValidationOptions, ValidationResult } from "../server/agent-runtime/providers/validation";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import { readDependencyDigest } from "aws-studio/source/workspace";
import { withSourceRead } from "aws-studio/source/source-gate";
import { setTimeout as delay } from "node:timers/promises";

const roots: string[] = [];
afterEach(() => { mock.restoreAll(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(root: string, file: string, contents: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), contents);
}
function fixture(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-chain-evaluator-fixture-"))); roots.push(root);
  put(root, "package.json", '{"name":"chain-evaluation-fixture","type":"module","private":true}');
  put(root, ".env", "PRIVATE_SENTINEL=excluded-from-source-copy\n");
  put(root, ".framework/private.json", '{"private":"excluded"}');
  put(root, "source.ts", "export const value=1;\n");
  put(root, "graphql-chain.review.json", '{"version":1,"prisma":null,"client":null}\n');
  put(root, "node_modules/tsx/package.json", '{"name":"tsx","version":"0.0.0-fixture","exports":"./index.mjs"}');
  put(root, "node_modules/tsx/index.mjs", "// Resolution-only fixture: no child executes this stub.\n");
  put(root, "node_modules/.vite-temp/vite.config.mts.timestamp-fixture.mjs", "export default {};\n");
  put(root, RUNTIME_CONTRACT_TYPES, "export interface Contract {}\n");
  put(root, RUNTIME_CONTRACT, '{"fixture":true}\n');
  put(root, CLIENT_ACCESS_OUTPUT, "export const clientAccess = {};\n");
  put(root, ACCESS_GRAPH_OUTPUT, '{"fingerprint":"fixture"}\n');
  put(root, "packages/database/src/generated/extra.ts", "// Not an evaluation input.\n");
  put(root, "packages/library/package.json", '{"name":"@repo/library","exports":"./index.ts"}');
  put(root, "packages/library/index.ts", "export const library=1;\n");
  put(root, "packages/library/node_modules/nested/package.json", '{"name":"nested","version":"0.0.0-fixture"}');
  mkdirSync(path.join(root, "node_modules/@repo"));
  symlinkSync(path.join(root, "packages/library"), path.join(root, "node_modules/@repo/library"), process.platform === "win32" ? "junction" : "dir");
  return root;
}
function evidence(): ChainEvaluation {
  const sdl = "type Query { value: String }";
  return { verification: { database: {status:"passed"}, api: {status:"passed"}, client: {status:"passed"}, consumers: {status:"passed"}, integration: {status:"passed"} }, contract: { storageHash:"a".repeat(64), executionHash:null }, sdl, schemaDiagnostics: [], generatedSdl: sdl, generatedDiagnostics: [], documents: [], documentDiagnostics: [], documentSet: "matches",
    codegen: { status: "current", files: [], diagnostics: [] } };
}
function respond(options: ValidationOptions, value: ChainEvaluation = evidence()): ValidationResult {
  const artifact = options.command.args.at(-1)!;
  return { exitCode: 0, stdout: JSON.stringify(writeEvaluationArtifact(artifact, value)), stderr: "" };
}

test("GraphQL evaluation captures public source and only grants installed dependency directories read-only", async () => {
  const root = fixture();
  let captured = "", scratch = "";
  const value = await evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
    captured = options.cwd; scratch = options.scratchDir;
    assert.equal(options.provider, "codex");
    assert.equal(options.readOnlyCwd, true);
    assert.notEqual(options.cwd, root);
    assert.ok(!options.cwd.startsWith(root + path.sep));
    assert.equal(options.command.file, realpathSync(process.execPath));
    assert.equal(options.command.args[0], "--import");
    assert.equal(options.timeoutMs, 300_000);
    assert.equal(options.outputBytesCap, 32_768);
    assert.equal(options.readPaths?.length, 3);
    assert.deepEqual(new Set(options.readPaths?.slice(1)), new Set([path.join(root, "node_modules"), path.join(root, "packages/library/node_modules")]));
    assert.equal(options.readPaths?.includes(root), false, "the live checkout is never granted to the worker");
    assert.ok(options.command.args[1].includes("node_modules/tsx"));
    assert.equal(existsSync(path.join(options.cwd, ".env")), false);
    assert.equal(existsSync(path.join(options.cwd, "graphql-chain.review.json")), false);
    assert.equal(existsSync(path.join(options.cwd, ".framework")), false);
    assert.equal(existsSync(path.join(options.cwd, "node_modules/.vite-temp")), false);
    assert.equal(readFileSync(path.join(options.cwd, RUNTIME_CONTRACT_TYPES), "utf8"), "export interface Contract {}\n");
    assert.equal(readFileSync(path.join(options.cwd, RUNTIME_CONTRACT), "utf8"), '{"fixture":true}\n');
    for (const file of [CLIENT_ACCESS_OUTPUT, ACCESS_GRAPH_OUTPUT]) {
      assert.deepEqual(readFileSync(path.join(options.cwd, file)), readFileSync(path.join(root, file)));
      assert.notEqual(realpathSync(path.join(options.cwd, file)), realpathSync(path.join(root, file)));
    }
    assert.equal(existsSync(path.join(options.cwd, "packages/database/src/generated/extra.ts")), false);
    assert.equal(readFileSync(path.join(options.cwd, "source.ts"), "utf8"), "export const value=1;\n");
    assert.equal(lstatSync(path.join(options.cwd, "node_modules/tsx")).isSymbolicLink(), true);
    assert.equal(realpathSync(path.join(options.cwd, "node_modules/tsx")), path.join(root, "node_modules/tsx"), "installed packages are reused without copying");
    assert.equal(realpathSync(path.join(options.cwd, "node_modules/@repo/library")), path.join(options.cwd, "packages/library"), "workspace imports resolve only captured source");
    return respond(options);
  } });
  assert.deepEqual(value, evidence());
  assert.equal(existsSync(captured), false);
  assert.equal(existsSync(scratch), false);
  assert.equal(readFileSync(path.join(root, "source.ts"), "utf8"), "export const value=1;\n");
  assert.equal(readFileSync(path.join(root, "graphql-chain.review.json"), "utf8"), '{"version":1,"prisma":null,"client":null}\n');
});

test("source capture waits for a live reader, then uses the unchanged guarded capture", async () => {
  const root = fixture();
  let release!: () => void, entered!: () => void, calls = 0, settled = false;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const reservation = withSourceRead(root, () => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  await acquired;
  const checking = evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => { calls++; return respond(options); } });
  void checking.then(() => { settled = true; }, () => { settled = true; });
  try {
    await delay(150);
    assert.equal(settled, false, "contention must not fail a safe check immediately");
    assert.equal(calls, 0, "native execution cannot begin while another reader owns capture");
    release(); await reservation;
    assert.deepEqual(await checking, evidence());
    assert.equal(calls, 1);
  } finally { release(); await reservation; await checking.catch(() => {}); }
});

test("cancelled source contention does not run validation or release another reader's lease", async () => {
  const root = fixture(), controller = new AbortController();
  let release!: () => void, entered!: () => void, calls = 0;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const reservation = withSourceRead(root, () => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  await acquired;
  const checking = evaluateGraphQLChain(root, { signal: controller.signal, run: async options => { calls++; return respond(options); } });
  const rejected = assert.rejects(checking, { code: "GRAPHQL_EVALUATION_CANCELLED" });
  try { await delay(100); controller.abort(); await rejected; assert.equal(calls, 0); }
  finally { release(); await reservation; }
});

test("missing generated contract refuses evaluation without attempting generation or trusted execution", async () => {
  const root = fixture(); rmSync(path.join(root, RUNTIME_CONTRACT));
  let calls = 0;
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => { calls++; return respond(options); } }), { code: "GENERATED_CONTRACT_UNAVAILABLE" });
  assert.equal(calls, 0);
  assert.equal(existsSync(path.join(root, RUNTIME_CONTRACT)), false);
});

test("native capability errors propagate and there is no execution fallback", async () => {
  const root = fixture(), privateFailure = new Error("private native fixture detail"); let calls = 0;
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async () => { calls++; throw privateFailure; } }), error => {
    const value = error as Error & { code: string };
    assert.equal(value.code, "SANDBOX_UNAVAILABLE");
    assert.equal(value.cause, privateFailure, "the host retains its internal failure for diagnosis");
    assert.doesNotMatch(value.message, /private native fixture detail/);
    assert.doesNotMatch(JSON.stringify(value), /private native fixture detail|cause/);
    return true;
  });
  assert.equal(calls, 1);
});

test("a dependency link outside the checkout refuses evaluation before native execution", { skip: process.platform === "win32" }, async () => {
  const root = fixture(), outside = fixture();
  symlinkSync(path.join(outside, "source.ts"), path.join(root, "node_modules/escape"));
  let calls = 0;
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => { calls++; return respond(options); } }), { code: "GRAPHQL_CAPTURE_FAILED" });
  assert.equal(calls, 0);
});

test("truncated, malformed and hash-mismatched receipts cannot establish current evidence", async () => {
  for (const mode of ["truncated", "malformed", "mismatched"] as const) {
    const root = fixture();
    await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
      const response = respond(options);
      if (mode === "truncated") return { ...response, outputTruncated: true };
      if (mode === "malformed") return { ...response, stdout: "not a receipt" };
      return { ...response, stdout: response.stdout.replace(/"hash":"[a-f0-9]{64}"/, `"hash":"${"0".repeat(64)}"`) };
    } }));
  }
});

test("linked output artifacts are refused before the host reads them", { skip: process.platform === "win32" }, async () => {
  const root = fixture();
  const text = JSON.stringify(evidence()), protectedFile = path.join(root, "other.json");
  writeFileSync(protectedFile, text);
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
    symlinkSync(protectedFile, options.command.args.at(-1)!);
    return { exitCode: 0, stderr: "", stdout: JSON.stringify({ version: 1, bytes: Buffer.byteLength(text), hash: createHash("sha256").update(text).digest("hex") }) };
  } }), { code: "GRAPHQL_ARTIFACT_INVALID" });
});

test("source, runtime-contract and installed dependency changes discard the captured result", async () => {
  for (const file of ["source.ts", RUNTIME_CONTRACT, RUNTIME_CONTRACT_TYPES, CLIENT_ACCESS_OUTPUT, ACCESS_GRAPH_OUTPUT, "node_modules/tsx/index.mjs"]) {
    const root = fixture();
    await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
      const response = respond(options); writeFileSync(path.join(root, file), file.endsWith(".json") ? '{"changed":true}' : "export const value=2;"); return response;
    } }), { code: "GRAPHQL_ARTIFACT_INVALID" });
  }
});

test("restored saved or privately captured source cannot renew evidence after changing during execution", async () => {
  for (const location of ["saved", "capture", "saved-runtime", "capture-runtime", "saved-policy", "capture-graph", "toolchain"] as const) {
    const root = fixture(), review = readFileSync(path.join(root, "graphql-chain.review.json"), "utf8");
    await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
      const file = location === "toolchain" ? options.command.args.find(argument => argument.endsWith("inspect.cjs"))!
        : path.join(location.startsWith("saved") ? root : options.cwd, location.endsWith("runtime") ? RUNTIME_CONTRACT_TYPES
          : location.endsWith("policy") ? CLIENT_ACCESS_OUTPUT : location.endsWith("graph") ? ACCESS_GRAPH_OUTPUT : "source.ts");
      const before = readFileSync(file), metadata = lstatSync(file);
      chmodSync(file, 0o600);
      writeFileSync(file, "export const value=2;\n");
      // Restore both bytes and the visible modification time. The execution
      // guard must still notice changed physical metadata, not only a digest.
      await new Promise(resolve => setTimeout(resolve, 5));
      writeFileSync(file, before); chmodSync(file, metadata.mode & 0o7777); utimesSync(file, metadata.atime, metadata.mtime);
      assert.deepEqual(readFileSync(file), before);
      return respond(options);
    } }), { code: "GRAPHQL_ARTIFACT_INVALID" });
    assert.equal(readFileSync(path.join(root, "graphql-chain.review.json"), "utf8"), review);
  }
});

test("restored installed dependency bytes cannot renew evidence after changing during execution", async () => {
  const root = fixture(), review = readFileSync(path.join(root, "graphql-chain.review.json"), "utf8");
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
    const file = path.join(root, "node_modules/tsx/index.mjs"), before = readFileSync(file), metadata = lstatSync(file);
    writeFileSync(file, "// changed loader implementation\n");
    await new Promise(resolve => setTimeout(resolve, 5));
    writeFileSync(file, before); utimesSync(file, metadata.atime, metadata.mtime);
    assert.deepEqual(readFileSync(file), before);
    return respond(options);
  } }), { code: "GRAPHQL_ARTIFACT_INVALID" });
  assert.equal(readFileSync(path.join(root, "graphql-chain.review.json"), "utf8"), review);
});

test("a supplied dependency identity still requires a matching full installed-dependency hash after execution", async () => {
  const root = fixture(), expectedDependencyDigest = await readDependencyDigest(root);
  const value = await evaluateGraphQLChain(root, { signal: new AbortController().signal, expectedDependencyDigest, run: async options => respond(options) });
  assert.deepEqual(value, evidence());
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, expectedDependencyDigest: "0".repeat(64), run: async options => respond(options) }), { code: "GRAPHQL_ARTIFACT_INVALID" });
});

test("cancellation discards output and never attempts another execution", async () => {
  const root = fixture(), controller = new AbortController(); let calls = 0;
  await assert.rejects(evaluateGraphQLChain(root, { signal: controller.signal, run: async options => { calls++; const response = respond(options); controller.abort(); return response; } }), { code: "GRAPHQL_EVALUATION_CANCELLED" });
  assert.equal(calls, 1);
});

test("evaluation artifact validator refuses invalid status, diagnostic and generated output paths", () => {
  assert.deepEqual(parseChainEvaluation(JSON.stringify(evidence())), evidence());
  const blocked = { ...evidence(), verification: { ...evidence().verification, integration: { status: "blocked", diagnostics: [{ code: "UPSTREAM_VALIDATION_REQUIRED", message: "Generate current GraphQL artifacts first." }] } } };
  assert.deepEqual(parseChainEvaluation(JSON.stringify(blocked)), blocked);
  for (const altered of [
    { ...evidence(), documentSet: "looks-current" },
    { ...evidence(), verification: undefined },
    { ...evidence(), verification: { ...evidence().verification, api: {status:"passed-ish"} } },
    { ...evidence(), contract: { storageHash:"not-a-hash", executionHash:null } },
    { ...evidence(), schemaDiagnostics: [{ code: "broken", message: 123 }] },
    { ...evidence(), codegen: { status: "current", files: ["../outside"], diagnostics: [] } },
  ]) assert.throws(() => parseChainEvaluation(JSON.stringify(altered)), /invalid artifact/);
});


test("evaluation cancellation stops dependency capture before another read batch and drains opened handles", async () => {
  const root = fixture(), controller = new AbortController();
  for (let index = 0; index < 24; index++) put(root, `node_modules/example/file-${index}.js`, "export const value = 1;\n");
  const original = fsPromises.open;
  let opened = 0, active = 0, calls = 0;
  mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await original(...args);
    if (String(args[0]).startsWith(path.join(root, "node_modules") + path.sep)) {
      opened++; active++;
      const close = handle.close.bind(handle);
      handle.close = async () => { try { await close(); } finally { active--; } };
      controller.abort(new Error("Stop evaluation dependency capture"));
    }
    return handle;
  });
  syncBuiltinESMExports();
  await assert.rejects(evaluateGraphQLChain(root, { signal: controller.signal, run: async options => { calls++; return respond(options); } }), { code: "GRAPHQL_EVALUATION_CANCELLED" });
  assert.ok(opened > 0 && opened <= 8, "cancellation stops at the current bounded read batch");
  assert.equal(active, 0, "all opened dependency handles are closed before cancellation returns");
  assert.equal(calls, 0);
});

test("evaluation cancellation stops public source copying and releases the source lease", async () => {
  const root = fixture(), controller = new AbortController(), expectedDependencyDigest = await readDependencyDigest(root);
  const original = fsPromises.copyFile;
  let copies = 0, calls = 0, captured = "";
  mock.method(fsPromises, "copyFile", async (...args: Parameters<typeof fsPromises.copyFile>) => {
    await original(...args);
    const destination = String(args[1]), marker = path.sep + "working" + path.sep;
    if (destination.includes(marker)) { copies++; captured = destination.slice(0, destination.indexOf(marker) + marker.length - 1); controller.abort(new Error("Stop evaluation source capture")); }
  });
  syncBuiltinESMExports();
  await assert.rejects(evaluateGraphQLChain(root, { signal: controller.signal, expectedDependencyDigest, run: async options => { calls++; return respond(options); } }), { code: "GRAPHQL_EVALUATION_CANCELLED" });
  assert.equal(copies, 1, "the current copy completes but no next source file is copied");
  assert.equal(calls, 0); assert.equal(existsSync(captured), false);
  await withSourceRead(root, () => Promise.resolve());
  assert.equal(readFileSync(path.join(root, "source.ts"), "utf8"), "export const value=1;\n");
});


test("GraphQL capture refuses Codegen-visible inputs omitted by public source capture", async () => {
  const root = fixture();
  put(root, "client-app/src/api/feature/generated/dist/hidden.ts", 'export const hidden = graphql(`query Hidden { value }`);');
  let ran = false;
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => { ran = true; return respond(options); } }), /Saved source and dependencies could not be captured safely/);
  assert.equal(ran, false);
});

test("GraphQL capture checks nested authored documents and excludes only the root output", async () => {
  const root = fixture(), nested = "client-app/src/api/feature/generated/normal.ts";
  put(root, nested, 'export const nested = graphql(`query Nested { value }`);');
  put(root, "client-app/src/api/generated/dist/ignored.ts", 'export const ignored = graphql(`query Ignored { value }`);');
  await evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
    assert.equal(readFileSync(path.join(options.cwd, nested), "utf8"), readFileSync(path.join(root, nested), "utf8"));
    return respond(options);
  } });
});

test("GraphQL publication refuses an uncaptured document added during evaluation", async () => {
  const root = fixture();
  await assert.rejects(evaluateGraphQLChain(root, { signal: new AbortController().signal, run: async options => {
    put(root, "client-app/src/api/feature/generated/dist/late.ts", 'export const late = graphql(`query Late { value }`);');
    return respond(options);
  } }), /Restricted GraphQL output failed integrity checks/);
});


test("cached inspection identity refuses documents outside public capture", async () => {
  const root = fixture();
  put(root, "client-app/src/api/feature/generated/dist/hidden.ts", 'export const hidden = graphql(`query Hidden { value }`);');
  await assert.rejects(chainInputIdentity(root, Buffer.from("fixed worker")), /excluded from public source capture/);
});

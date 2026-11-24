import { testProjectRoot } from "../../scripts/test-project";
import { installFixtureCommands } from "./support/project-cli";
import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CommandRunner } from "../server/commands";
import { GRAPHQL_GENERATED_FILES } from "../server/graphql-chain/codegen-files";
import { parseReviewRecord, serializeReviewRecord } from "aws-studio/contract-chain/core";
import { sourceFingerprints } from "aws-studio/contract-chain/source-fingerprints";

const root = path.resolve(__dirname, "../..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) { assert.ok(Date.now() < deadline, "campaign-owned command did not reach its expected state"); await wait(10); }
}
function fixture() {
  const directory = path.join(root, ".cache/framework-studio/command-tests");
  mkdirSync(directory, { recursive: true });
  const checkout = mkdtempSync(path.join(directory, "source with spaces-"));
  writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "command-lifetime-test", private: true }));
  installFixtureCommands(checkout);
  return checkout;
}
function hold(checkout: string) {
  const marker = path.join(checkout, "owned-pids.json");
  writeFileSync(path.join(checkout, "node_modules/aws-studio/generate-contracts.ts"), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,process.ppid,child.pid])); setInterval(()=>{},1000);`);
  writeFileSync(path.join(checkout, "node_modules/aws-studio/check-local.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(path.join(checkout, "second-step"))},'unexpected');`);
  return marker;
}
function cleanupOwned(pids: readonly number[]) {
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
}

test("disposing an active command settles it, stops its descendants and refuses future work", async () => {
  const checkout = fixture(), marker = hold(checkout), runner = new CommandRunner(checkout);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  let pids: number[] = [];
  try {
    const command = runner.run("framework:check", false);
    await until(() => existsSync(marker));
    pids = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(runner.busy, "framework:check");
    await assert.rejects(runner.run("framework:check", false), { status: 409 });
    const disposal = runner.dispose();
    assert.equal(runner.dispose(), disposal, "repeated shutdown shares its completion");
    await disposal;
    assert.notEqual((await command).exitCode, 0);
    await until(() => pids.every(pid => !alive(pid)));
    assert.equal(runner.busy, undefined);
    assert.equal(existsSync(path.join(checkout, "second-step")), false);
    assert.equal(alive(unrelated.pid!), true, "shutdown must preserve unrelated processes");
    await assert.rejects(runner.run("framework:generate", true), { status: 503 });
  } finally {
    await runner.dispose(); cleanupOwned(pids); unrelated.kill("SIGKILL"); rmSync(checkout, { recursive: true, force: true });
  }
});

test("fixed command names, confirmation and success preserve sequential execution", async () => {
  const checkout = fixture(), runner = new CommandRunner(checkout);
  const script = path.join(checkout, "node_modules/aws-studio/generate-contracts.ts");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(path.join(checkout, "node_modules/aws-studio/check-local.ts"), "console.log('second step');\n");
  try {
    for (const name of ["unknown", "__proto__", "toString", "framework:check; arbitrary"])
      await assert.rejects(runner.run(name, true), { status: 404 });
    await assert.rejects(runner.run("framework:generate", false), { status: 428 });
    const checked = await runner.run("framework:check", false);
    assert.equal(checked.exitCode, 0); assert.match(checked.output, /\["--check"\]/); assert.match(checked.output, /second step/);
    assert.equal((await runner.run("framework:generate", true)).exitCode, 0);
  } finally { await runner.dispose(); rmSync(checkout, { recursive: true, force: true }); }
});

test("GraphQL regeneration publishes only its outputs and ledger after successful generation", async () => {
  const checkout = fixture(), runner = new CommandRunner(checkout);
  const put = (name: string, text: string) => { const file = path.join(checkout, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  const read = (name: string) => readFileSync(path.join(checkout, name), "utf8");
  const operations = "client-app/src/api/operations.ts", review = "graphql-chain.review.json";
  const record = { version: 3, prisma: null, client: null, bindings: { api: null, client: null }, proofs: {}, ledger: {
    api: { source: "a".repeat(64), output: "b".repeat(64), recordedAt: "2026-01-01T00:00:00.000Z" },
    client: { source: "c".repeat(64), output: "d".repeat(64), recordedAt: "2026-01-01T00:00:00.000Z" },
  } } as const;
  put("codegen.ts", readFileSync(path.join(testProjectRoot, "codegen.ts"), "utf8"));
  put("packages/database/prisma/contract.prisma", "// use prisma-8\nmodel Project {\n id String @id\n}\n");
  put("packages/database/src/generated/contract.json", '{"fixture":true}\n');
  put("packages/database/src/generated/contract.d.ts", 'export interface Contract {}\n');
  put("compute/http/graphql-api/schema/index.ts", 'import { buildSchema } from "graphql"; export const schema = buildSchema("type Query { value: String }");');
  put(review, serializeReviewRecord(record));
  const authored = 'import { gql } from "graphql-tag"; export const query = gql`query Example { value }`;';
  put(operations, authored);
  try {
    await assert.rejects(runner.run("graphql:regenerate", false), { status: 428 });
    const result = await runner.run("graphql:regenerate", true);
    assert.equal(result.exitCode, 0, result.output);
    const generated = GRAPHQL_GENERATED_FILES.map(file => read(file));
    assert.ok(generated.every(text => text.length));
    assert.equal(read(operations), authored);
    const recorded = parseReviewRecord(read(review));
    if (recorded.version !== 3) assert.fail("Codegen must retain a versioned ledger.");
    assert.deepEqual({ ...recorded, ledger: { api: recorded.ledger?.api, client: recorded.ledger?.client } }, record);
    const nodes = sourceFingerprints(checkout);
    assert.equal(recorded.ledger?.codegen?.source, nodes[1]!.fingerprint.status === "available" ? nodes[1]!.fingerprint.value : null);
    assert.equal(recorded.ledger?.codegen?.output, nodes[2]!.fingerprint.status === "available" ? nodes[2]!.fingerprint.value : null);
    const saved = read(review);
    const repeated = await runner.run("graphql:regenerate", true);
    assert.equal(repeated.exitCode, 0, repeated.output);
    assert.equal(read(review), saved);
    put(operations, authored.replace("value }", "unknownField }"));
    const failed = await runner.run("graphql:regenerate", true);
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.output, /unknownField/);
    assert.equal(read(review), saved);
    assert.deepEqual(GRAPHQL_GENERATED_FILES.map(file => read(file)), generated);
  } finally { await runner.dispose(); rmSync(checkout, { recursive: true, force: true }); }
});

test("a command is tethered to its owner even when that owner is killed outright", async () => {
  const checkout = fixture(), marker = hold(checkout);
  const program = `const {CommandRunner}=require(${JSON.stringify(path.join(root, "client-app/server/commands.ts"))}); new CommandRunner(${JSON.stringify(checkout)}).run('framework:check',false).catch(()=>{});`;
  const owner = spawn(process.execPath, ["--import", "tsx", "-e", program], { cwd: root, stdio: "ignore" });
  let pids: number[] = [];
  try {
    await until(() => existsSync(marker)); pids = JSON.parse(readFileSync(marker, "utf8"));
    const exited = new Promise(resolve => owner.once("exit", resolve)); owner.kill("SIGKILL"); await exited;
    await until(() => pids.every(pid => !alive(pid)));
    assert.equal(existsSync(path.join(checkout, "second-step")), false);
  } finally { owner.kill("SIGKILL"); cleanupOwned(pids); rmSync(checkout, { recursive: true, force: true }); }
});

test("shutdown between successful steps cannot report a completed check", async () => {
  const checkout = fixture(), runner = new CommandRunner(checkout);
  const second = path.join(checkout, "second-step");
  writeFileSync(path.join(checkout, "node_modules/aws-studio/generate-contracts.ts"), "console.log('first step');\n");
  writeFileSync(path.join(checkout, "node_modules/aws-studio/check-local.ts"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(second)},'unexpected');`);
  try {
    const command = runner.run("framework:check", false);
    // Inject shutdown at the child-close boundary, before its awaiting
    // continuation can advance to the next allowlisted step.
    const child = (runner as unknown as { child: ChildProcess }).child;
    assert.ok(child);
    child.once("close", () => { void runner.dispose(); });
    const result = await command;
    await runner.dispose();
    assert.equal(result.exitCode, null);
    assert.equal(existsSync(second), false);
  } finally { await runner.dispose(); rmSync(checkout, { recursive: true, force: true }); }
});

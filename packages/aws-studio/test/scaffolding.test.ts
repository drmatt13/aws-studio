import { testProjectRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import ts from "typescript";
import { assertScaffoldUnchanged, renderScaffold, SCAFFOLD_TEMPLATES, type ScaffoldTemplateId } from "../src/scaffolding";
import { assertEventReplayEntry } from "../scripts/check-event-replay";
import { copyLocalTestProject } from "./cdk/support/isolated-project";

const fixture = copyLocalTestProject("scaffolding-tests-");
after(() => rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const root = testProjectRoot;
const parameters = { id: "example-agent", directory: "compute/agents/example-agent", handler: "customHandler", port: 5137 };

function copy(): string {
  const directory = mkdtempSync(path.join(fixture, "source-"));
  for (const name of ["framework-config/templates", "package.json", "package-lock.json", "cdk-app/package.json", "packages/models/package.json"]) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    cpSync(path.join(testProjectRoot, name), path.join(directory, name), { recursive: true });
  }
  return directory;
}

test("every starter renders and typechecks with the actual framework APIs", () => {
  const roots: string[] = [];
  for (const id of Object.keys(SCAFFOLD_TEMPLATES) as ScaffoldTemplateId[]) {
    const result = renderScaffold(root, id, parameters);
    assertScaffoldUnchanged(root, result.snapshot);
    if (id === "agent/respond") {
      const { packages } = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
      assert.equal(JSON.parse(result.files.get("package.json")!).dependencies.zod, packages["node_modules/aws-studio"].dependencies.zod);
    }
    if (id === "container-task") {
      const { devDependencies } = JSON.parse(readFileSync(path.join(root, "cdk-app/package.json"), "utf8"));
      assert.equal(JSON.parse(result.files.get("package.json")!).devDependencies["@types/node"], devDependencies["@types/node"]);
    }
    assert.ok(result.files.size);
    for (const [name, text] of result.files) {
      const destination = path.join(fixture, "typed", id, name);
      mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, text);
      assert.ok(!text.includes("{{"), `${id}/${name}`);
      if (name.endsWith(".json")) JSON.parse(text);
      if (name.endsWith(".ts")) roots.push(destination);
    }
  }
  const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true, types: ["node"] });
  const errors = ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
});

test("repository template edits take effect immediately and fingerprint files, inventory and dependency sources", () => {
  const directory = copy(), file = path.join(directory, "framework-config/templates/lambda/event/files/index.ts.template");
  const original = renderScaffold(directory, "lambda/event", parameters);
  writeFileSync(file, readFileSync(file, "utf8") + "\n// Application-owned event starter.\n");
  assert.throws(() => assertScaffoldUnchanged(directory, original.snapshot), /changed after review/);
  const edited = renderScaffold(directory, "lambda/event", parameters);
  assert.match(edited.files.get("index.ts")!, /Application-owned/);
  const extra = path.join(path.dirname(file), "README.md.template");
  writeFileSync(extra, "Custom starter documentation.\n");
  assert.throws(() => assertScaffoldUnchanged(directory, edited.snapshot), /changed after review/);
  const added = renderScaffold(directory, "lambda/event", parameters);
  unlinkSync(extra);
  assert.throws(() => assertScaffoldUnchanged(directory, added.snapshot), /changed after review/);
  const agent = renderScaffold(directory, "agent/respond", parameters);
  const lockfile = path.join(directory, "package-lock.json");
  writeFileSync(lockfile, readFileSync(lockfile, "utf8") + "\n");
  assert.throws(() => assertScaffoldUnchanged(directory, agent.snapshot), /changed after review/);
  const container = renderScaffold(directory, "container-task", parameters);
  const cdk = path.join(directory, "cdk-app/package.json");
  writeFileSync(cdk, readFileSync(cdk, "utf8") + "\n");
  assert.throws(() => assertScaffoldUnchanged(directory, container.snapshot), /changed after review/);
  assertScaffoldUnchanged(root, renderScaffold(root, "lambda/event", parameters).snapshot);
});

test("templates reject invalid manifests, unknown tokens, missing entries and linked inputs", () => {
  const directory = copy(), base = path.join(directory, "framework-config/templates/lambda/event");
  const manifest = path.join(base, "template.json"), source = readFileSync(manifest, "utf8");
  writeFileSync(manifest, source.replace('"schemaVersion": 1', '"schemaVersion": 2'));
  assert.throws(() => renderScaffold(directory, "lambda/event", parameters), /Invalid.*template.json/);
  writeFileSync(manifest, source);
  const entry = path.join(base, "files/index.ts.template"), code = readFileSync(entry, "utf8");
  writeFileSync(entry, code + "\n{{unsupported}}\n");
  assert.throws(() => renderScaffold(directory, "lambda/event", parameters), /Unknown starter token/);
  unlinkSync(entry);
  assert.throws(() => renderScaffold(directory, "lambda/event", parameters), /missing required starter files/);
  symlinkSync(path.join(testProjectRoot, "framework-config/templates/lambda/event/files/index.ts.template"), entry);
  assert.throws(() => renderScaffold(directory, "lambda/event", parameters), /symbolic links/);
  unlinkSync(entry); writeFileSync(entry, code);
  assert.throws(() => renderScaffold(directory, "lambda/event", { ...parameters, directory: "../outside" }), /invalid/);
  assert.throws(() => renderScaffold(directory, "lambda/event", { ...parameters, handler: "bad.name" }), /invalid/);
  const packageTemplate = path.join(directory, "framework-config/templates/container-service/files/package.json.template");
  writeFileSync(packageTemplate, JSON.stringify(JSON.parse(readFileSync(packageTemplate, "utf8"))));
  assert.doesNotThrow(() => renderScaffold(directory, "container-service", parameters), "nested closing JSON braces are ordinary source, not unresolved tokens");
});

test("replay pairing validates declarations independently of active execution lanes", () => {
  const replay = renderScaffold(root, "lambda/event", parameters);
  assert.equal(replay.requirements.localReplay, true);
  assert.doesNotThrow(() => assertEventReplayEntry("disabled-event", true, replay.files.get("index.ts")!));
  const result = renderScaffold(root, "lambda/event-result", parameters);
  assert.equal(result.requirements.localReplay, false);
  assert.throws(() => assertEventReplayEntry("event", true, result.files.get("index.ts")!), /does not use withLocalReplay/);
  assert.throws(() => assertEventReplayEntry("event", false, replay.files.get("index.ts")!), /does not declare localReplay/);
  assert.doesNotThrow(() => assertEventReplayEntry("event", true, replay.files.get("index.ts")!.replace("{ withLocalReplay }", "{ withLocalReplay as replay }").replace("= withLocalReplay(", "= replay(")));
  assert.throws(() => assertEventReplayEntry("event", true, '// withLocalReplay(async () => {});\nexport const lambdaHandler = async () => {};'), /does not use withLocalReplay/);
});

test("TypeScript container starters build and execute their service and task contracts", async () => {
  const directories: string[] = [];
  for (const id of ["container-service", "container-task"] as const) {
    const directory = path.join(fixture, "runtime", id); directories.push(directory);
    for (const [name, text] of renderScaffold(root, id, parameters).files) {
      const file = path.join(directory, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text);
    }
    const built = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: directory, encoding: "utf8", timeout: 30_000 });
    assert.equal(built.status, 0, built.stderr);
  }
  const task = (input: string) => spawnSync(process.execPath, ["dist/index.js"], { cwd: directories[1], env: { ...process.env, FRAMEWORK_TASK_INPUT: input }, encoding: "utf8", timeout: 10_000 });
  assert.equal(task('{"message":"test"}').status, 0);
  const invalid = task("[]"); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Task input must be an object/);
  // Reserve a host port rather than assuming the template's default is free.
  const { createServer } = await import("node:net");
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address === "object");
  const port = address.port; await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const service = spawn(process.execPath, ["dist/index.js"], { cwd: directories[0], env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(response, "service becomes ready"); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: "ok" });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/`)).json(), { message: "Ready" });
  } finally {
    const exited = new Promise<void>(resolve => service.once("exit", () => resolve()));
    service.kill(); await exited;
  }
});

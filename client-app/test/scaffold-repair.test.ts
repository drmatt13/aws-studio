import { testProjectRoot } from "../../scripts/test-project";
import { loadFrameworkConfig as loadStarterConfig } from "aws-studio/config/source";
import { installFixtureRelease } from "./support/project-cli";
import { studioProjectScratch } from "./support/source-fixture";
import assert from "./support/assert";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { renderScaffold } from "aws-studio/scaffolding";
const framework = loadStarterConfig(testProjectRoot);
import { projectModel } from "../server/model/project";
import { planImplementation } from "../server/edits/implementation-scaffold";
import { editableFiles } from "../server/files";

const fixtures: string[] = [];
after(() => { for (const root of fixtures) rmSync(root, { recursive: true, force: true }); });
const inputs = { holds: () => true };
const model = projectModel(framework, { mode: "dev", inputs: { dev: inputs, prod: inputs } });
function fixture() {
  const root = studioProjectScratch("scaffold-repair-");
  fixtures.push(root);
  for (const name of ["framework-config/templates", "package.json", "package-lock.json", "cdk-app/package.json", "packages/models/package.json"]) {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(testProjectRoot, name), destination, { recursive: true });
  }
  installFixtureRelease(root);
  return root;
}

test("existing JavaScript containers repair through the compatibility template without replacing their code", () => {
  const root = fixture(), target = model.targets.find(target => target.ref === "service:example-service")!;
  const directory = target.directory!, entry = path.join(root, directory, "index.mjs");
  mkdirSync(path.dirname(entry), { recursive: true }); writeFileSync(entry, "// Authored service implementation.\n");
  const plan = planImplementation(root, target);
  assert.equal(plan.templates[0]!.id, "container-service/legacy-javascript");
  assert.equal(plan.files.has(entry), false);
  assert.match(plan.files.get(path.join(root, directory, "Dockerfile"))!, /index.mjs/);
  assert.equal(readFileSync(entry, "utf8"), "// Authored service implementation.\n");
  for (const [file, text] of plan.files) writeFileSync(file, text);
  rmSync(entry);
  const missingEntry = planImplementation(root, target);
  assert.equal(missingEntry.templates[0]!.id, "container-service/legacy-javascript");
  assert.deepEqual([...missingEntry.files.keys()], [entry]);
});

test("repair recognizes an existing lowercase Dockerfile and does not create a second one", () => {
  const root = fixture(), target = model.targets.find(target => target.ref === "service:example-service")!;
  const directory = target.directory!;
  for (const [name, text] of renderScaffold(root, "container-service", { id: target.id, directory }).files) {
    const file = path.join(root, directory, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text);
  }
  renameSync(path.join(root, directory, "Dockerfile"), path.join(root, directory, "dockerfile"));
  assert.throws(() => planImplementation(root, target), /All starter files already exist/);
});

test("repair preserves an existing task workspace when its launch contract needs a custom Dockerfile", () => {
  const root = fixture(), target = model.targets.find(target => target.ref === "task:invocation-test-task")!;
  const directory = path.join(root, target.directory!); mkdirSync(directory, { recursive: true });
  const manifest = JSON.stringify({ name: "@repo/invocation-test-task", scripts: { start: "tsx src/index.ts" } });
  writeFileSync(path.join(directory, "package.json"), manifest);
  assert.throws(() => planImplementation(root, target), /no build script/);
  assert.equal(readFileSync(path.join(directory, "package.json"), "utf8"), manifest);
  assert.equal(existsSync(path.join(directory, "Dockerfile")), false);
});

test("templates remain outside the configuration declaration inventory", () => {
  const root = fixture();
  // Even an accidentally added .ts helper is not a declaration or a writable config entry.
  writeFileSync(path.join(root, "framework-config/templates/helper.ts"), "export const helper = {};\n");
  assert.ok(editableFiles(root).every(name => !name.startsWith("framework-config/templates/")));
});

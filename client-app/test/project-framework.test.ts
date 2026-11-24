import assert from "./support/assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { studioFrameworkPackageDirectory } from "../server/project-release";
import { frameworkPackageDirectory, installFrameworkRedirect } from "../server/evaluator/project-framework";

/** A stand-in aws-studio whose config entry reports which copy it is. */
function frameworkCopy(directory: string, marker: string, extra: readonly string[] = []): string {
  mkdirSync(path.join(directory, "src/config"), { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "aws-studio", exports: { "./config": "./src/config/index.js" } }));
  writeFileSync(path.join(directory, "src/config/index.js"), `module.exports = { marker: ${JSON.stringify(marker)} };\n`);
  for (const file of extra) writeFileSync(path.join(directory, file), `module.exports = ${JSON.stringify(marker)};\n`);
  return realpathSync(directory);
}

/** A directory whose node_modules/aws-studio links to `framework`, as a workspace install does. */
function consumer(directory: string, framework: string): string {
  mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: path.basename(directory), private: true }));
  symlinkSync(framework, path.join(directory, "node_modules/aws-studio"), process.platform === "win32" ? "junction" : "dir");
  return realpathSync(directory);
}

function fixture<T>(use: (root: string) => T): T {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-project-framework-"));
  try { return use(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const forget = (prefix: string) => { for (const key of Object.keys(require.cache)) if (key.startsWith(prefix)) delete require.cache[key]; };

test("the evaluator resolves Studio's framework through the host installation", () => {
  const checkout = path.resolve(__dirname, "../..");
  assert.equal(studioFrameworkPackageDirectory(), realpathSync(path.join(checkout, "packages/aws-studio")));
});

test("frameworkPackageDirectory checks the project's pin before evaluation", () => fixture((root) => {
  mkdirSync(path.join(root, "empty"));
  writeFileSync(path.join(root, "empty/package.json"), "{}");
  assert.throws(() => frameworkPackageDirectory(path.join(root, "empty")), /pin aws-studio once/i);
}));

test("a module resolved inside Studio's framework loads from the project's framework instead", () => fixture((root) => {
  const studio = frameworkCopy(path.join(root, "studio-framework"), "studio");
  const project = frameworkCopy(path.join(root, "project-framework"), "project");
  const studioConsumer = consumer(path.join(root, "studio"), studio);
  const uninstall = installFrameworkRedirect({ from: studio, to: project });
  try {
    const bare = createRequire(path.join(studioConsumer, "package.json"))("aws-studio/config") as { marker: string };
    assert.equal(bare.marker, "project", "a bare specifier resolved through Studio's own install");
    const relative = require(path.join(studio, "src/config/index.js")) as { marker: string };
    assert.equal(relative.marker, "project", "a path into Studio's framework source");
  } finally { uninstall(); forget(root); }
  const restored = require(path.join(studio, "src/config/index.js")) as { marker: string };
  assert.equal(restored.marker, "studio", "uninstalling restores ordinary resolution");
  forget(root);
}));

test("modules outside Studio's framework are not redirected", () => fixture((root) => {
  const studio = frameworkCopy(path.join(root, "studio-framework"), "studio");
  const project = frameworkCopy(path.join(root, "project-framework"), "project");
  writeFileSync(path.join(root, "unrelated.js"), "module.exports = 'unrelated';\n");
  const uninstall = installFrameworkRedirect({ from: studio, to: project });
  try { assert.equal(require(path.join(root, "unrelated.js")), "unrelated"); }
  finally { uninstall(); forget(root); }
}));

test("a framework module the project's version lacks is refused by name", () => fixture((root) => {
  const studio = frameworkCopy(path.join(root, "studio-framework"), "studio", ["newer.js"]);
  const project = frameworkCopy(path.join(root, "project-framework"), "project");
  const uninstall = installFrameworkRedirect({ from: studio, to: project });
  try { assert.throws(() => require(path.join(studio, "newer.js")), /needs newer\.js from aws-studio, which the project's framework .* does not provide/); }
  finally { uninstall(); forget(root); }
}));

test("the same framework on both sides installs nothing", () => fixture((root) => {
  const framework = frameworkCopy(path.join(root, "framework"), "shared");
  const loader = Module as unknown as { _resolveFilename: unknown };
  const before = loader._resolveFilename;
  const uninstall = installFrameworkRedirect({ from: framework, to: path.join(root, "framework") });
  assert.equal(loader._resolveFilename, before);
  uninstall();
}));

test("the evaluator selects the project's framework before anything imports one", async () => {
  const { readFileSync } = await import("node:fs");
  const ts = (await import("typescript")).default;
  const file = path.join(__dirname, "../server/evaluator/evaluate.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const first = source.statements.find(ts.isImportDeclaration);
  assert.equal(first && ts.isStringLiteral(first.moduleSpecifier) ? first.moduleSpecifier.text : undefined, "./use-project-framework");
});

test("the sandboxed evaluator bundle keeps its own single framework instance and omits the redirect", async () => {
  const { restrictedEvaluatorBundle } = await import("../server/evaluator/restricted");
  const bundle = Buffer.from(await restrictedEvaluatorBundle()).toString("utf8");
  assert.ok(bundle.includes("candidate-framework") || bundle.includes("createRequire"), "the bundle still resolves the candidate's framework");
  assert.ok(!bundle.includes("Evaluating with the project's framework"), "a bundle runs from the sandbox, where Studio's own framework path does not exist");
});

test("the framework's own installed dependencies are not redirected: each copy resolves its own", () => fixture((root) => {
  const studio = frameworkCopy(path.join(root, "studio-framework"), "studio");
  const project = frameworkCopy(path.join(root, "project-framework"), "project");
  mkdirSync(path.join(studio, "node_modules/nested-dependency"), { recursive: true });
  writeFileSync(path.join(studio, "node_modules/nested-dependency/index.js"), "module.exports = 'studio dependency';\n");
  const uninstall = installFrameworkRedirect({ from: studio, to: project });
  try { assert.equal(require(path.join(studio, "node_modules/nested-dependency/index.js")), "studio dependency"); }
  finally { uninstall(); forget(root); }
}));

test("bare evaluator imports follow the selected package's own export map", () => fixture((root) => {
  const studio = frameworkCopy(path.join(root, "studio-package"), "studio");
  const other = frameworkCopy(path.join(root, "selected-package"), "external");
  writeFileSync(path.join(other, "config.cjs"), `module.exports = "selected-export";`);
  writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "aws-studio", exports: { "./config": "./config.cjs" } }));
  const issuer = consumer(path.join(root, "studio"), studio);
  const uninstall = installFrameworkRedirect({ from: studio, to: other });
  try { assert.equal(createRequire(path.join(issuer, "package.json"))("aws-studio/config"), "selected-export"); }
  finally { uninstall(); forget(root); }
}));

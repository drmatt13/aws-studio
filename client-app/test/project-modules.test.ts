import assert from "./support/assert";
import { installFixtureFramework } from "./support/project-layout";
import { studioProjectScratch } from "./support/source-fixture";
import { testProjectRoot } from "../../scripts/test-project";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PROJECT_LAYOUT, projectModules } from "../server/project-modules";
import { IncompatibleProjectError } from "../server/project";
import { frameworkSettingOwnership } from "../server/deployment-inputs";
import { projectInputMetadata } from "../server/evaluator/input-metadata";

/**
 * A project unlike this checkout: its own sign-in catalog and framework settings, with the
 * framework linked in as a workspace install would. Its modules import nothing else.
 */
function project(root: string): string {
  const write = (relative: string, text: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), text); };
  write("package.json", JSON.stringify({ name: "fixture-project", private: true }));
  write(PROJECT_LAYOUT.signInCatalog, `export const SIGN_IN_PROVIDERS = { fixture: { title: "Fixture", cognitoName: "Fixture", settings: {}, secret: "fixtureSecret" } } as const;\nexport const signInProviderKeys = () => ["fixtureSecret"];\n`);
  write(PROJECT_LAYOUT.deploymentInputs, `import { defineInputs, input } from "aws-studio/config";\nexport const deploymentInputs = () => defineInputs({ fixtureOnlySetting: input.fromEnv("FIXTURE_ONLY_SETTING").default("x") });\n`);
  write(PROJECT_LAYOUT.frameworkInputs, `import { defineInputs, input } from "aws-studio/config";\nexport const localInputs = () => defineInputs({ fixtureLocalPort: input.fromEnv("FIXTURE_LOCAL_PORT") });\nexport const REQUIRED_FRAMEWORK_INPUTS = { dev: [], prod: [] };\n`);
  installFixtureFramework(root);
  return realpathSync(root);
}

function fixture<T>(use: (root: string) => T): T {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-project-modules-"));
  try { return use(project(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("application modules come from the opened project, not from this checkout", () => fixture((root) => {
  assert.deepEqual(Object.keys(projectModules(root).signInCatalog().SIGN_IN_PROVIDERS), ["fixture"]);
  assert.ok(Object.keys(projectModules(testProjectRoot).signInCatalog().SIGN_IN_PROVIDERS).includes("google"), "the reference application declares its own Google provider");
}));

test("one project's modules are loaded once and shared by every path that names it", () => fixture((root) => {
  const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.equal(projectModules(link), projectModules(root));
    assert.equal(projectModules(root).signInCatalog(), projectModules(root).signInCatalog());
  } finally { rmSync(link, { force: true }); }
}));

test("the framework a project's modules use is the one the project installs", () => fixture((root) => {
  assert.equal(typeof projectModules(root).framework().defineInputs, "function");
  const bare = mkdtempSync(path.join(os.tmpdir(), "studio-project-bare-"));
  try {
    writeFileSync(path.join(bare, "package.json"), "{}");
    assert.throws(() => projectModules(bare).framework(), /does not install aws-studio/);
  } finally { rmSync(bare, { recursive: true, force: true }); }
}));

test("framework setting ownership lists the opened project's settings", () => fixture((root) => {
  const ids = Object.keys(frameworkSettingOwnership(projectInputMetadata(root, "dev")));
  assert.ok(ids.some(id => id.endsWith(".fixtureOnlySetting")), `the project's deployment input is listed: ${ids.join(", ")}`);
  assert.ok(ids.some(id => id.endsWith(".fixtureLocalPort")), "the project's local tooling input is listed");
  assert.ok(!ids.some(id => id.endsWith(".localDevUrl")), "this checkout's deployment inputs are not");
}));

test("a project without a declaration module declares nothing there, instead of borrowing this checkout's", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-project-partial-")));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    const modules = projectModules(root);
    assert.deepEqual(modules.signInCatalog().SIGN_IN_PROVIDERS, {});
    assert.deepEqual(modules.signInCatalog().signInProviderKeys("google" as never), []);
    assert.deepEqual(modules.signInInputs().signInProviders, {});
    assert.deepEqual(modules.deploymentInputs().deploymentInputs("dev"), {});
    assert.deepEqual(modules.frameworkInputs().localInputs(), {});
    assert.deepEqual(modules.frameworkInputs().REQUIRED_FRAMEWORK_INPUTS, { dev: [], prod: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project without a framework implementation module is refused by file, never filled from this checkout", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-project-partial-")));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    for (const [access, module] of [
      [() => projectModules(root).statefulResources(), "deploy/stateful-resources"],
      [() => projectModules(root).databaseLifecycle(), "deploy/stateful-references"],
      [() => projectModules(root).cognitoLifecycle(), "deploy/stateful-references"],
    ] as const) {
      assert.throws(access, (error: unknown) => error instanceof IncompatibleProjectError && (error as Error).message.includes(`does not install aws-studio, which provides aws-studio/${module}.`));
    }
    assert.deepEqual(Object.keys(PROJECT_LAYOUT).sort(), ["deploymentInputs", "frameworkInputs", "signInCatalog", "signInInputs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project whose framework lacks a stateful-reference export is refused by name", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-project-old-framework-")));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    mkdirSync(path.join(root, "node_modules/aws-studio"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/aws-studio/package.json"), JSON.stringify({ name: "aws-studio", version: "1.0.0", exports: { "./config": "./config.js" } }));
    for (const access of [() => projectModules(root).databaseLifecycle(), () => projectModules(root).cognitoLifecycle()]) {
      assert.throws(access, (error: unknown) => error instanceof IncompatibleProjectError
        && (error as Error).message === `${root} installs a framework without aws-studio/deploy/stateful-references. Install AWS Studio's matching release in that project.`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a nested project without an installed framework cannot load this checkout's stateful exports", () => {
  const root = studioProjectScratch("studio-project-bare-");
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    assert.throws(() => projectModules(root).statefulResources(), (error: unknown) =>
      error instanceof IncompatibleProjectError && error.message.includes("aws-studio/deploy/stateful-resources"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an installed framework export reports its missing dependency", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-project-broken-framework-"));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    const framework = path.join(root, "node_modules/aws-studio");
    mkdirSync(framework, { recursive: true });
    writeFileSync(path.join(framework, "package.json"), JSON.stringify({
      name: "aws-studio",
      exports: { "./deploy/stateful-resources": "./stateful-resources.cjs" },
    }));
    writeFileSync(path.join(framework, "stateful-resources.cjs"), 'require("missing-stateful-resource-dependency");');
    assert.throws(() => projectModules(root).statefulResources(), (error: unknown) =>
      error instanceof Error && !(error instanceof IncompatibleProjectError) && error.message.includes("missing-stateful-resource-dependency"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

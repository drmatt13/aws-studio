import { testProjectRoot, testProjectScratch } from "../../../../scripts/test-project";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defineInputs, input } from "aws-studio/config";
import { DEPLOYMENT_SETTING_KEYS, PROJECT_DECLARATIONS, projectDeclarations, requireDeploymentSettings } from "aws-studio/config/project-declarations";

const checkout = testProjectRoot;

/** Use the installed release projected into the prepared app’s scratch parent. */
function project(): string {
  const root = testProjectScratch("project-declarations-");
  const write = (relative: string, text: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), text); };
  write("package.json", JSON.stringify({ name: "fixture-project", private: true }));
  write(PROJECT_DECLARATIONS.signInCatalog, `export const SIGN_IN_PROVIDERS = { fixture: { title: "Fixture", cognitoName: "Fixture", settings: { clientId: "fixtureClientId" }, secret: "fixtureSecret" } } as const;\nexport const signInProviderKeys = () => ["fixtureClientId", "fixtureSecret"];\n`);
  write(PROJECT_DECLARATIONS.signInInputs, `import { input } from "aws-studio/config";\nexport const signInProviders = { fixtureClientId: input.fromEnv("FIXTURE_CLIENT_ID"), fixtureSecret: input.secret("FIXTURE_SECRET") };\n`);
  write(PROJECT_DECLARATIONS.deploymentInputs, `import { defineInputs, input } from "aws-studio/config";\nexport const deploymentInputs = () => defineInputs({ fixtureOnlySetting: input.fromEnv("FIXTURE_ONLY_SETTING").default("x") });\n`);
  return root;
}

test("deployment reads the app's declaration modules from the project root", () => {
  const root = project();
  try {
    const declarations = projectDeclarations(root);
    assert.deepEqual(Object.keys(declarations.signInCatalog().SIGN_IN_PROVIDERS), ["fixture"]);
    assert.deepEqual(Object.keys(declarations.signInInputs().signInProviders), ["fixtureClientId", "fixtureSecret"]);
    assert.deepEqual(Object.keys(declarations.deploymentInputs().deploymentInputs("dev")), ["fixtureOnlySetting"]);
    assert.ok(Object.keys(projectDeclarations(checkout).signInCatalog().SIGN_IN_PROVIDERS).includes("google"), "the pinned starter still reads its own catalog");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project without a declaration module declares nothing there", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "project-declarations-empty-")));
  try {
    writeFileSync(path.join(root, "package.json"), "{}");
    const declarations = projectDeclarations(root);
    assert.deepEqual(declarations.signInCatalog().SIGN_IN_PROVIDERS, {});
    assert.deepEqual(declarations.signInInputs().signInProviders, {});
    assert.deepEqual(declarations.deploymentInputs().deploymentInputs("dev"), {});
    assert.deepEqual(declarations.frameworkInputs().REQUIRED_FRAMEWORK_INPUTS, { dev: [], prod: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a deployment declaration missing a read key is refused by name", () => {
  assert.equal(DEPLOYMENT_SETTING_KEYS.length, 14);
  assert.throws(() => requireDeploymentSettings(defineInputs({ localDevUrl: input.fromEnv("LOCAL_DEV_URL") })),
    { message: "framework-config/inputs/deployment.ts does not declare cognitoDomainCertificateArn, which deployment reads." });
});

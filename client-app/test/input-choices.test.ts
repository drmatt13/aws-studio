import { studioTestScratchRoot } from "./support/source-fixture";
import { testProjectRoot } from "../../scripts/test-project";
import { installFixtureRelease } from "./support/project-cli";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "./support/assert";
import { inputChoicesError, inputModeIntents, type ResourceIntent } from "../shared/resources";
import { SnapshotBuilder } from "../server/snapshot";
import { readResourceIntent, ResourceService } from "../server/resources";
import { frameworkInputChoices } from "../server/input-choices-source";

const cache = path.join(studioTestScratchRoot(), ".cache/framework-studio/input-choice-tests");
async function fixture() {
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "case-"));
  mkdirSync(path.join(root, "framework-config/inputs"), { recursive: true }); mkdirSync(path.join(root, "cdk-app"));
  cpSync(path.join(testProjectRoot, "framework-config/defaults.ts"), path.join(root, "framework-config/defaults.ts"));
  writeFileSync(path.join(root, "framework.config.ts"), 'import { defineFrameworkConfig } from "aws-studio/config"; import { defaults } from "./framework-config/defaults"; import { resources } from "./framework-config/inputs"; export default defineFrameworkConfig({ inputs: resources, defaults, http: [], webSocket: [], events: [], services: [] });\n');
  writeFileSync(path.join(root, "framework-config/inputs.ts"), 'import { defineInputs, input, stack, cdk } from "aws-studio/config"; export const resources = defineInputs({ setting: input.fromEnv("SETTING").default("initial") });\n');
  const file = path.join(root, "framework-config/inputs/deployment.ts");
  writeFileSync(file, `import { defineInputs, input, stack, cdk, type CloudMode } from "aws-studio/config";
export const deploymentInputs = (mode: CloudMode) => defineInputs({
  // Keep this declaration and its reader stable.
  skipEmailVerification: input.fromEnv(/* input name */ "SKIP_EMAIL_VERIFICATION")
    .enum("true", "false").default("false").note("Keep this note."),
}, { mode });\n`);
  const local = path.join(root, "cdk-app/framework-inputs.ts");
  writeFileSync(local, `import { defineInputs, input } from "aws-studio/config";
export const localInputs = () => defineInputs({
  localTestUserEmail: input.fromEnv("LOCAL_TEST_USER_EMAIL").note("Keep this test account note."),
  localTestUserPassword: input.fromEnv("LOCAL_TEST_USER_PASSWORD"),
});
export const REQUIRED_FRAMEWORK_INPUTS = { dev: ["LOCAL_TEST_USER_EMAIL", /* Password line */ "LOCAL_TEST_USER_PASSWORD"], prod: [] };
export const localTestAccountInputs = (values: Record<string, string>) => values;
`);
  const env = "SKIP_EMAIL_VERIFICATION=false\nLOCAL_TEST_USER_PASSWORD=private-not-for-source\n";
  for (const mode of ["dev", "prod"]) writeFileSync(path.join(root, `cdk-app/.env.${mode}`), env);
  installFixtureRelease(root);
  const builder = new SnapshotBuilder(root); await builder.refresh();
  for (const model of Object.values(builder.current!.snapshot.models)) if (model.status !== "ok") {
    await builder.dispose(); rmSync(root, { recursive: true });
    throw new Error(JSON.stringify(model.diagnostics));
  }
  const service = new ResourceService(root, builder);
  const resource = () => builder.current!.snapshot.models.dev.resources.find(item => item.id === "framework:deployment.skipEmailVerification")!;
  const intent = (choices: readonly string[]): ResourceIntent => ({ resource: resource().id, kind: "input", fromEnv: resource().fromEnv, group: "Deployment settings", modes: inputModeIntents(resource()), requirements: {}, choices });
  const plan = (choices: readonly string[]) => service.plan(intent(choices), builder.current!.snapshot.revision, "dev");
  const dispose = async () => { await builder.dispose(); assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); };
  return { root, file, local, env, builder, service, resource, intent, plan, dispose };
}

test("framework enum edits review source, preserve values and comments, and refresh without module reload", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.resource().values, ["true", "false"]);
    assert.deepEqual(f.resource().inputChoices?.defaults, ["false"]);
    for (const choices of [["true", "false", "preview"], [], ["true", "false"]]) {
      const before = readFileSync(f.file, "utf8");
      const plan = await f.plan(choices);
      assert.ok(plan.ok, JSON.stringify(plan.diagnostics));
      assert.equal(readFileSync(f.file, "utf8"), before, "review never writes");
      assert.equal(plan.changes.length, 1);
      assert.equal(plan.changes[0]!.file, "framework-config/inputs/deployment.ts");
      assert.ok(!JSON.stringify(plan).includes("private-not-for-source"));
      assert.equal((await f.service.apply(plan.planId)).status, "applied");
      assert.deepEqual(f.resource().values ?? [], choices);
      const after = readFileSync(f.file, "utf8");
      assert.ok(after.includes('/* input name */ "SKIP_EMAIL_VERIFICATION"'));
      assert.ok(after.includes('.default("false").note("Keep this note.")'));
      for (const mode of ["dev", "prod"]) assert.equal(readFileSync(path.join(f.root, `cdk-app/.env.${mode}`), "utf8"), f.env);
    }
  } finally { await f.dispose(); }
});

test("framework input editing rejects invalid choices, changed identity, and stale source", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.plan(["true"]), /default must remain|default.*allowed values/);
    assert.match(inputChoicesError(["false", "FALSE"])!, /unique/);
    assert.match(inputChoicesError([""])!, /non-blank/);
    assert.throws(() => readResourceIntent({ intent: f.intent(["false", "FALSE"]) }), /unique/);
    await assert.rejects(f.service.plan({ ...f.intent(["true", "false", "extra"]), fromEnv: "OTHER" }, f.builder.current!.snapshot.revision, "dev"), /preserve the reader/);
    const plan = await f.plan(["true", "false", "extra"]);
    writeFileSync(f.file, readFileSync(f.file, "utf8") + "// intervening edit\n");
    await assert.rejects(f.service.apply(plan.planId), /changed/);
    assert.ok(readFileSync(f.file, "utf8").endsWith("// intervening edit\n"));
    writeFileSync(f.file, readFileSync(f.file, "utf8").replace('.enum("true", "false")', '.enum(...["true", "false"])'));
    assert.equal(frameworkInputChoices(f.root, "deployment", "skipEmailVerification", "SKIP_EMAIL_VERIFICATION"), undefined, "computed enums are never rewritten");
    assert.equal(frameworkInputChoices(f.root, "database", "multiAz", "DATABASE_MULTI_AZ"), undefined, "inferred database types have no enum authority");
  } finally { await f.dispose(); }
});

test("local test credentials can change development policy without putting the password in source", async () => {
  const f = await fixture();
  const find = (key: string) => f.builder.current!.snapshot.models.dev.resources.find(item => item.id === `framework:local.${key}`)!;
  const intent = (resource: ReturnType<typeof find>, dev: Partial<ResourceIntent["modes"]["dev"]>): ResourceIntent => {
    const modes = inputModeIntents(resource);
    return { resource: resource.id, kind: "input", fromEnv: resource.fromEnv, group: "Local development",
      modes: { dev: { ...modes.dev, ...dev }, prod: modes.prod }, requirements: {} };
  };
  const plan = (edit: ResourceIntent) => f.service.plan(edit, f.builder.current!.snapshot.revision, "dev");
  const apply = async (edit: ResourceIntent) => {
    const reviewed = await plan(edit);
    assert.ok(reviewed.ok, JSON.stringify(reviewed.diagnostics));
    assert.ok(reviewed.changes.every(change => change.file === "cdk-app/framework-inputs.ts"));
    assert.ok(!JSON.stringify(reviewed).includes("private-not-for-source"));
    assert.equal((await f.service.apply(reviewed.planId)).status, "applied");
  };
  try {
    const email = () => find("localTestUserEmail");
    const password = () => find("localTestUserPassword");
    assert.equal(email().inputRequirement?.status, "missing");
    await apply(intent(email(), { required: false, default: "local@example.test" }));
    assert.equal(email().default, "local@example.test");
    assert.equal(email().inputRequirement?.status, "default");
    assert.equal(email().modes?.dev.required, false);
    assert.equal(password().inputChoices?.sensitive, true);
    await assert.rejects(plan(intent(password(), { default: "in-source-password" })), /public default/);
    const unsafe = intent(password(), {});
    await assert.rejects(plan({ ...unsafe, modes: { ...unsafe.modes, prod: { ...unsafe.modes.prod, present: true } } }), /where the input is available/);
    await apply(intent(password(), { present: false, required: false }));
    assert.equal(password().absent, true);
    assert.match(readFileSync(f.local, "utf8"), /\/\* Password line \*\//);
    await apply(intent(password(), { present: true, required: true }));
    assert.equal(password().inputRequirement?.status, "configured");
    assert.equal(password().modes?.dev.required, true);
    assert.equal(password().modes?.prod.present, false);
    assert.equal(readFileSync(path.join(f.root, "cdk-app/.env.dev"), "utf8"), f.env);
  } finally { await f.dispose(); }
});

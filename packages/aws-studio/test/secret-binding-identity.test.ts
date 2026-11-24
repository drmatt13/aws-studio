import assert from "node:assert/strict";
import test from "node:test";
import {
  defineFrameworkConfig, defineInputs, defineStacks, input, stack, cdk, resourceAttributeKey, secretBindingPath,
  type FrameworkConfig, type ResourceDeclarationGroup, type ResourceManifest, type ResourceReference,
} from "../src/config";
import { resolveLocalWorkloadEnvironment } from "../src/local/environment";
import { defaults } from "../../../scripts/test-project-declarations";

const bindingPath = ["providers", "apiKey"] as const;
const arn = "arn:aws:secretsmanager:eu-west-2:111122223333:secret:fixture-AbCdEf";

test("managed secret pins retain their original identity through chains, projections and repeated catalog renames", () => {
  const before = defineInputs({ providers: { apiKey: input.secret("API_KEY") } });
  const options = { bindingPath, tags: { area: "examples" } };
  const declaration = input.secret("API_KEY", options).required("prod").note("Fixture metadata");
  for (const mode of ["dev", "prod"] as const) {
    for (const catalog of [defineInputs({ renamedKey: declaration }, { mode }), defineInputs({ anotherGroup: { finalKey: declaration } }, { mode })]) {
      const secret = "renamedKey" in catalog ? catalog.renamedKey : catalog.anotherGroup.finalKey;
      assert.notDeepEqual(secret.path, bindingPath);
      assert.deepEqual(secretBindingPath(secret), bindingPath);
      assert.deepEqual(secret.bindingPath, bindingPath);
      assert.deepEqual(secret.arn.bindingPath, bindingPath);
      assert.deepEqual(secret.value.bindingPath, bindingPath);
      assert.equal(secret.fromEnv, "API_KEY");
      assert.equal(secret.required, mode === "prod" ? true : undefined);
      assert.equal(secret.note, "Fixture metadata");
      assert.equal(resourceAttributeKey(secret.arn), resourceAttributeKey(before.providers.apiKey.arn));
      assert.equal(resourceAttributeKey(secret.value), resourceAttributeKey(before.providers.apiKey.value));
    }
  }
});

test("pins are copied and remain dormant on ordinary environment and standalone inputs", () => {
  const original = ["originalKey"];
  const options = { bindingPath: original };
  const secret = input.secret("API_KEY", options);
  original[0] = "laterMutation";
  const catalog = defineInputs({ renamed: secret, dormant: input.value("true", { bindingPath: ["formerSecret"] }).enum("true", "false").note("Keep identity"),
    environment: input.fromEnv("EXISTING_NAME", { bindingPath: ["formerInput"] }).default("fallback") });
  assert.deepEqual(catalog.renamed.bindingPath, ["originalKey"]);
  assert.equal(Object.isFrozen(catalog.renamed.bindingPath), true);
  assert.deepEqual(catalog.dormant.bindingPath, ["formerSecret"]);
  assert.deepEqual(catalog.environment.bindingPath, ["formerInput"]);
  assert.deepEqual(secretBindingPath(catalog.dormant), ["dormant"]);
  assert.deepEqual(secretBindingPath(catalog.environment), ["environment"]);
  assert.equal(resourceAttributeKey(catalog.environment), JSON.stringify([["environment"], "value"]));
  const restored = defineInputs({ restored: input.secret("API_KEY", { bindingPath: catalog.dormant.bindingPath }) });
  assert.deepEqual(secretBindingPath(restored.restored.arn), ["formerSecret"]);
});

test("invalid pins and collisions fail before a catalog can claim another managed binding", () => {
  for (const invalid of [null, "legacyKey", [], new Array(1), [""], ["bad-key"], ["../escape"], [1]]) {
    for (const declare of [() => input.secret("API_KEY", { bindingPath: invalid } as never), () => input.fromEnv("INPUT", { bindingPath: invalid } as never), () => input.value("value", { bindingPath: invalid } as never)]) {
      assert.throws(declare, /bindingPath.*non-empty array/i);
    }
  }
  assert.throws(() => defineInputs({ renamed: input.secret("API_KEY", { bindingPath: ["legacy"] }), legacy: input.secret("OTHER_KEY") }), /claimed by inputs.renamed and inputs.legacy/);
  assert.throws(() => defineInputs({ dormant: input.value("public", { bindingPath: ["legacy"] }), legacy: input.secret("OTHER_KEY") }), /claimed/);
  assert.throws(() => defineInputs({ dormant: input.fromEnv("PUBLIC", { bindingPath: ["legacy"] }), active: input.secret("PRIVATE", { bindingPath: ["legacy"] }) }), /claimed/);
  for (const mode of ["dev", "prod"] as const) {
    assert.throws(() => defineInputs({ dev: input.secret("DEV_KEY", { bindingPath }).only("dev"), prod: input.secret("PROD_KEY", { bindingPath }).only("prod") }, { mode }), /claimed/);
  }
  const valid = defineInputs({ first: input.secret("FIRST_KEY"), second: input.secret("SECOND_KEY"), plain: input.value("true") });
  assert.equal(valid.first.bindingPath, undefined);
  assert.equal(valid.plain.bindingPath, undefined);
});

test("native references retain their own catalog identity instead of synthesizing a secret pin", () => {
  interface Vault { readonly secret: { readonly secretArn: string; grantRead(...args: never[]): unknown } }
  const catalog = defineStacks({ vault: stack<Vault>() });
  assert.equal((catalog.vault.secret as unknown as ResourceReference).bindingPath, undefined);
  assert.deepEqual(secretBindingPath(catalog.vault.secret.arn), ["vault", "secret"]);
  assert.equal(resourceAttributeKey(catalog.vault.secret.arn), JSON.stringify([["vault", "secret"], "secretArn"]));
  if (false) {
    // @ts-expect-error A native construct does not accept input binding metadata.
    cdk<{}>({ bindingPath: ["native"] });
  }
});

function workload(catalog: ResourceDeclarationGroup, secret: ResourceReference<"string">): FrameworkConfig {
  return defineFrameworkConfig({ inputs: catalog, defaults,
    http: [{ "/worker": { directory: "compute/http/worker", methods: ["POST"], auth: false, environment: { API_KEY_ARN: secret } } }],
    webSocket: [], services: [], tasks: [], events: [], workflows: [],
  } as never);
}

test("renamed secret ARN consumers keep reading an existing development manifest without export or fetch", async () => {
  const before = defineInputs({ providers: { apiKey: input.secret("API_KEY") } });
  const renamed = defineInputs({ renamedKey: input.secret("API_KEY", { bindingPath }) });
  const renamedAgain = defineInputs({ group: { finalKey: input.secret("API_KEY", { bindingPath: renamed.renamedKey.bindingPath }) } });
  const dormant = defineInputs({ ordinaryInput: input.fromEnv("API_KEY", { bindingPath: renamedAgain.group.finalKey.bindingPath }) });
  const restored = defineInputs({ restoredKey: input.secret("API_KEY", { bindingPath: dormant.ordinaryInput.bindingPath }) });
  const manifest: ResourceManifest = { version: 1, mode: "dev", deployment: "fixture", account: "111122223333", region: "eu-west-2",
    attributes: { [resourceAttributeKey(before.providers.apiKey.arn)]: arn }, integrations: {} };
  for (const [catalog, reference] of [[before, before.providers.apiKey.arn], [renamed, renamed.renamedKey.arn], [renamedAgain, renamedAgain.group.finalKey.arn], [restored, restored.restoredKey.arn]] as const) {
    const environment = await resolveLocalWorkloadEnvironment(workload(catalog, reference), "lambda:worker", { repositoryRoot: ".", manifest, authored: { API_KEY: "private-fixture-value" }, environment: {},
      readSecret: async () => { throw new Error("ARN delivery does not fetch secret contents"); } });
    assert.equal(environment.API_KEY_ARN, arn);
    assert.equal(environment.API_KEY, undefined);
  }
});

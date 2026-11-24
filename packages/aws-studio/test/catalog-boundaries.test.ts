import assert from "node:assert/strict";
import test from "node:test";
import {
  cdk, defineFrameworkConfig, defineInputs, defineStacks, input, stack,
  formatResourceReference, resourceAttributeKey, resourceOutputEnvironmentName, secretBindingPath,
  type FrameworkHttp, type FrameworkServices,
} from "../src/config";

interface NativeStack {
  readonly bucket: { readonly node: { readonly id: string; readonly path: string }; readonly bucketName: string };
  readonly endpoint: string;
  readonly secret: { readonly secretArn: string; grantRead(...args: never[]): unknown };
}

const base = {
  defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } },
  http: [], webSocket: [], events: [], services: [],
} as const;

test("authored catalogs preserve flat paths, mode policy and managed secret identities", () => {
  for (const mode of ["dev", "prod"] as const) {
    const inputs = defineInputs({
      enabled: input.value({ dev: "no", prod: "yes" }).enum("yes", "no"),
      providers: { renamedKey: input.secret("API_KEY", { bindingPath: ["providers", "apiKey"] }).required("prod") },
      devOnly: input.fromEnv("DEV_ONLY").only("dev"),
    }, { mode });
    const stacks = defineStacks({ data: mode === "prod" ? stack<NativeStack>() : undefined });
    const config = defineFrameworkConfig({ ...base, inputs, stacks });
    assert.equal(config.inputs, inputs);
    assert.equal(config.stacks, stacks);
    assert.equal(config.resources.enabled, inputs.enabled);
    assert.equal(config.resources.data, stacks.data);
    assert.deepEqual(inputs.enabled.path, ["enabled"]);
    assert.equal(inputs.enabled.authoredValue, mode === "prod" ? "yes" : "no");
    assert.equal(inputs.devOnly.absent, mode === "dev" ? undefined : true);
    assert.equal(inputs.providers.renamedKey.required, mode === "prod" ? true : undefined);
    assert.deepEqual(secretBindingPath(inputs.providers.renamedKey.arn), ["providers", "apiKey"]);
    assert.equal(resourceAttributeKey(inputs.providers.renamedKey.arn), JSON.stringify([["providers", "apiKey"], "secretArn"]));
    assert.equal(resourceOutputEnvironmentName(inputs.providers.renamedKey), "PROVIDERS_RENAMED_KEY");
    assert.deepEqual(stacks.data.bucket.path, ["data", "bucket"]);
    assert.deepEqual(stacks.data.secret.arn.path, ["data", "secret"]);
    assert.equal(stacks.data.absent === true, mode === "dev");
  }
});

test("reference diagnostics name the authored catalog without changing reference identities", () => {
  const inputs = defineInputs({
    setting: input.value("value"), optional: input.fromEnv("OPTIONAL"),
    devOnly: input.value({ dev: "local" }).only("dev"),
    token: input.secret("TOKEN", { bindingPath: ["oldToken"] }),
  }, { mode: "prod" });
  const stacks = defineStacks({ data: stack<NativeStack>(), absent: undefined, bucket: cdk<NativeStack["bucket"]>() });
  for (const [reference, expected] of [
    [inputs.setting, "inputs.setting"], [inputs.optional, "inputs.optional"], [inputs.devOnly, "inputs.devOnly"],
    [inputs.token.value, "inputs.token"], [inputs.token.arn, "inputs.token.arn"],
    [stacks.data.endpoint, "stacks.data.endpoint"], [stacks.data.secret.value, "stacks.data.secret"],
    [stacks.data.secret.arn, "stacks.data.secret.arn"], [stacks.data.secret.field("key"), 'stacks.data.secret.field("key")'],
    [stacks.data.bucket.bucketName, "stacks.data.bucket.bucketName"], [stacks.bucket.bucketName, "stacks.bucket.bucketName"],
    [(stacks.absent as typeof stacks.data).endpoint, "stacks.absent.endpoint"],
  ] as const) {
    const before = JSON.stringify(reference), identity = resourceAttributeKey(reference);
    assert.equal(formatResourceReference(reference), expected);
    assert.equal(JSON.stringify(reference), before);
    assert.equal(resourceAttributeKey(reference), identity);
  }
  assert.deepEqual(secretBindingPath(inputs.token.arn), ["oldToken"]);
});

test("catalog factories and composition reject the wrong declaration categories", () => {
  for (const catalog of [{ native: cdk<{}>() }, { nested: { native: cdk<{}>() } }, { data: stack<NativeStack>() }]) {
    assert.throws(() => defineInputs(catalog as never), /native.*defineStacks/);
  }
  for (const declaration of [input.value("value"), input.fromEnv("SETTING"), input.secret("KEY")]) {
    assert.throws(() => defineStacks({ setting: declaration } as never), /authored input.*defineInputs/);
    assert.throws(() => defineStacks({ group: { setting: declaration } } as never), /authored input.*defineInputs/);
  }
  assert.throws(() => defineInputs({ missing: undefined } as never), /input declaration/);
  assert.throws(() => defineInputs({ missing: null } as never), /input declaration/);
  assert.throws(() => defineStacks({ missing: null } as never), /native declaration/);
  const inputs = defineInputs({ setting: input.value("value") });
  const stacks = defineStacks({ data: stack<NativeStack>() });
  assert.throws(() => defineFrameworkConfig({ ...base, inputs: stacks } as never), /belongs to the stacks catalog/);
  assert.throws(() => defineFrameworkConfig({ ...base, stacks: inputs } as never), /belongs to the inputs catalog/);
  assert.throws(() => defineFrameworkConfig({ ...base, inputs: { data: { endpoint: stacks.data.endpoint } } } as never), /belongs to the stacks catalog/);
  assert.throws(() => defineFrameworkConfig({ ...base, inputs: { renamed: inputs.setting } } as never), /different catalog path/);
  assert.throws(() => defineFrameworkConfig({ ...base, inputs: { setting: input.value("unfinished") } } as never), /not a finalized/);
});

test("catalog collisions and legacy root authoring fail before normalization", () => {
  const inputs = defineInputs({ shared: { setting: input.value("value") } });
  const stacks = defineStacks({ shared: { native: cdk<{}>() } });
  assert.throws(() => defineFrameworkConfig({ ...base, inputs, stacks }), /inputs.shared and stacks.shared claim the same catalog path/);
  assert.throws(() => defineFrameworkConfig({ ...base, resources: {} } as never), /resources catalog is derived/);
  assert.throws(() => defineInputs({ oldKey: input.secret("OLD"), renamed: input.secret("NEW", { bindingPath: ["oldKey"] }) }), /Secret binding identity oldKey is claimed/);
  assert.throws(() => defineFrameworkConfig({ ...base, stackTags: { Native: { tags: { area: "data" }, other: true } } } as never), /stackTags.Native declares other/);
  assert.equal(defineFrameworkConfig({ ...base, stackTags: { Native: { tags: { area: "data" } } } }).stackTags.Native.tags.area, "data");
});

/** Typechecked but never run: both authored catalogs constrain workload references. */
function authoringTypes() {
  const inputs = defineInputs({ setting: input.value("value"), secret: input.secret("KEY") });
  const stacks = defineStacks({ data: stack<NativeStack>() });
  const other = defineInputs({ elsewhere: input.value("elsewhere") });
  type Catalog = typeof inputs & typeof stacks;
  const http = { "/read": { directory: "compute/http/read", methods: ["GET"], environment: { SETTING: inputs.setting, BUCKET: stacks.data.bucket.bucketName, SECRET_ARN: inputs.secret.arn } } } satisfies FrameworkHttp<Catalog>;
  const services = { "/service/*": { directory: "compute/services/service", methods: "*", port: 8000, secrets: { AUTHORED: inputs.secret.value, NATIVE: stacks.data.secret.field("token") } } } satisfies FrameworkServices<Catalog>;
  // @ts-expect-error An input catalog cannot declare native stacks.
  defineInputs({ native: stack<NativeStack>() });
  // @ts-expect-error A stack catalog cannot declare authored inputs.
  defineStacks({ setting: input.value("value") });
  // @ts-expect-error The unified catalog is derived by defineFrameworkConfig.
  defineFrameworkConfig({ ...base, resources: inputs });
  // @ts-expect-error The selected catalogs exclude this unrelated input.
  const wrong: FrameworkHttp<Catalog> = { "/wrong": { directory: "compute/http/wrong", methods: ["GET"], environment: { VALUE: other.elsewhere } } };
  return { http, services, wrong };
}
void authoringTypes;

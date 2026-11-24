import assert from "./support/assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { declaredSecretNames, privateEnvValues } from "../server/operations/adapter";
import { StreamingRedactor, redactText } from "../server/operations/redaction";

const directories: string[] = [];
after(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });
function checkout(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "private-values-"));
  directories.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("every literal catalog secret is found, wherever its module lives", () => {
  const root = checkout({
    "framework-config/inputs/webhook.ts": 'export const a = input.secret("STRIPE_WEBHOOK", { tags: {} });',
    "framework-config/inputs/deep/more.ts": "export const b = input\n  .secret('PLAIN_NAMED');",
    "framework-config/inputs/aliases.ts": 'import { input as parameter } from "aws-studio/config"; export const c = parameter.secret("ORDINARY_NAME");',
    "framework-config/inputs/namespace.ts": 'import * as config from "aws-studio/config"; export const d = config.input.secret("ALSO_ORDINARY");',
  });
  assert.deepEqual([...declaredSecretNames(root)!].sort(), ["ALSO_ORDINARY", "ORDINARY_NAME", "PLAIN_NAMED", "STRIPE_WEBHOOK"]);
});

test("declarations that cannot be read completely leave classification unknown", () => {
  assert.equal(declaredSecretNames(checkout({ "package.json": "{}" })), undefined, "no declarations to read");
  assert.equal(declaredSecretNames(checkout({ "framework-config/inputs.ts": 'input.secret("KNOWN"); input.secret(computedName);' })), undefined, "a computed name could be any variable");
});

test("declared secrets and credential keys are private, including values with ordinary names", () => {
  assert.deepEqual(privateEnvValues({ STRIPE_WEBHOOK: "whsec-value", OPENAI_API_KEY: "sk-value", LOCAL_TEST_USER_PASSWORD: "fixture-pass", DEPLOY_SIGNING_KEY: "signing-value" }, new Set(["STRIPE_WEBHOOK"])).sort(),
    ["fixture-pass", "signing-value", "sk-value", "whsec-value"]);
});

test("account ids, regions and operational settings stay readable", () => {
  assert.deepEqual(privateEnvValues({
    LOCAL_FRAMEWORK_ACCOUNT: "123456789012", LOCAL_AWS_REGION: "us-east-1", LOCAL_FRAMEWORK_DEPLOYMENT: "studio-test-dev",
    DATABASE_READ_REPLICA_COUNT: "0", DATABASE_ENGINE_VERSION: "16", USE_COGNITO_CUSTOM_DOMAIN: "false", PRISMA_LOCAL_SCHEMA_SYNC: "migrate",
  }, new Set(["OPENAI_API_KEY"])), []);
});

test("a credential-shaped name holding a flag cannot shred every true in a log", () => {
  assert.deepEqual(privateEnvValues({ SKIP_TOKEN_CHECK: "true", ROTATE_SECRET: "off", API_TOKEN: "t0ken-value" }, new Set()), ["t0ken-value"]);
});

test("a value too short to protect anything is not scrubbed from every line", () => {
  assert.deepEqual(privateEnvValues({ DECLARED_SECRET: "abc", API_TOKEN: "x" }, new Set(["DECLARED_SECRET"])), []);
});

test("unknown classification falls back to every meaningful value, never to none", () => {
  assert.deepEqual(privateEnvValues({ ANYTHING: "looks-public", PORT: "5432", FLAG: "true", COUNT: "0" }, undefined), ["looks-public", "5432"]);
});

test("a password inside a connection URL is private whatever the variable is called", () => {
  assert.deepEqual(privateEnvValues({ DATABASE_URL: "postgres://admin:hunter22@db.internal:5432/app" }, new Set()), ["hunter22"]);
});

test("connection URL passwords are withheld even when no value was known in advance", () => {
  assert.equal(redactText("connecting postgres://admin:hunter22@db.internal:5432/app ok", []), "connecting postgres://admin:[redacted]@db.internal:5432/app ok");
  const emitted: string[] = [];
  const redactor = new StreamingRedactor([], text => emitted.push(text));
  redactor.push("Fetching https://user:tok3n@github.com/acme/app.git\n");
  redactor.flush();
  assert.equal(emitted.join(""), "Fetching https://user:[redacted]@github.com/acme/app.git\n");
});

test("ordinary output around a secret survives intact", () => {
  const secret = privateEnvValues({ OPENAI_API_KEY: "sk-live-secret" }, new Set(["OPENAI_API_KEY"]));
  const line = "Plan plan-mw5mrw3o for studio-test-dev (dev, 123456789012/us-east-1): 16 add, 0 modify, key sk-live-secret";
  assert.equal(redactText(line, secret), "Plan plan-mw5mrw3o for studio-test-dev (dev, 123456789012/us-east-1): 16 add, 0 modify, key [redacted]");
});

import assert from "./support/assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { defineFrameworkConfig } from "aws-studio/config";
import { locateConfigSource } from "aws-studio/source-index";
import { projectModel } from "../server/model/project";
import { discoverPolicyRules } from "../server/source/permission-rules";
import { planIamPolicy } from "../server/edits/iam-policy";
import { SourceFiles } from "../server/source";
import { readIamPolicyEdit, readPermissionStatement, permissionStatementInput, permissionStatementKey } from "../shared/permission-rules";
import type { StudioState } from "../server/snapshot";
import type { ModeModel } from "../shared/model";
import { withCommentReview, reviewedComments } from "../server/edits/comments";

const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const original = { actions: ["cognito-idp:ListUsers"], resources: ["arn:aws:cognito-idp:*:*:userpool/*"] } as const;
function fixture(run: (root: string, model: ModeModel) => void) {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio"); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, "permission-rules-"));
  mkdirSync(path.join(root, "framework-config"));
  writeFileSync(path.join(root, "framework-config/shared.ts"), `export const shared={access:[${JSON.stringify(original)}]};`);
  writeFileSync(path.join(root, "framework-config/stacks.ts"), 'import {defineStacks,stack} from "aws-studio/config"; import type {Stack} from "aws-cdk-lib"; export const ignored=defineStacks({unused:stack<Stack>()}); export const stacks=defineStacks({example:stack<Stack>()});');
  writeFileSync(path.join(root, "framework.config.ts"), 'import {defineFrameworkConfig} from "aws-studio/config"; import {shared} from "./framework-config/shared"; import {stacks} from "./framework-config/stacks"; export default defineFrameworkConfig({stacks,http:[{"/caller":{directory:"compute/http/caller",methods:["GET"],cloud:{access:shared.access}}},{"/other":{directory:"compute/http/other",methods:["GET"],cloud:{access:[...shared.access]}}}],webSocket:[],events:[],services:[]});');
  const model = projectModel(defineFrameworkConfig({ defaults, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], cloud: { access: [original] } } }, { "/other": { directory: "compute/http/other", methods: ["GET"], cloud: { access: [original] } } }], webSocket: [], events: [], services: [] }), { mode: "prod" });
  try { run(root, model); } finally { assert.ok(path.resolve(root).startsWith(parent + path.sep)); rmSync(root, { recursive: true }); }
}
function state(root: string, model: ModeModel): StudioState {
  const rules = discoverPolicyRules(root, model, locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root }));
  return { snapshot: { models: { dev: { ...model, mode: "dev" }, prod: model }, source: { policyRules: rules, permissionCapabilities: [{ resource: "resource:example.bucket", category: "resource", canonicalTypes: ["aws-s3:IBucket"], attributes: ["bucketArn"] }] } } } as unknown as StudioState;
}
test("shared IAM statements retain source ownership and every consuming workload", () => fixture((root, model) => {
  const current = state(root, model), rule = current.snapshot.source.policyRules![0]!;
  assert.equal(current.snapshot.source.policyRules!.length, 1);
  assert.equal(rule.writable, true); assert.equal(rule.shared, true);
  assert.deepEqual(rule.consumers, ["lambda:caller", "lambda:other"]);
  assert.equal(rule.location?.file, "framework-config/shared.ts");
  const overrides = new Map<string, string>();
  planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "update", rule: rule.id, statement: { actions: ["s3:GetObject"], resources: [{ kind: "catalog", resource: "resource:example.bucket", attribute: "bucketArn", suffix: "/*" }], effect: "Deny", conditions: { Bool: { "aws:SecureTransport": false } } } }, overrides);
  const changed = overrides.get(path.join(root, "framework-config/shared.ts"))!;
  assert.ok(changed.includes('import { stacks } from "./stacks"'));
  assert.ok(changed.includes('stacks["example"]["bucket"]["bucketArn"]'));
  assert.ok(changed.includes('effect: "Deny"'));
  assert.equal(readFileSync(path.join(root, "framework-config/shared.ts"), "utf8").includes("Deny"), false, "review leaves source untouched");
  assert.equal(overrides.has(path.join(root, "framework.config.ts")), false, "shared owner is edited once");
  const removed = new Map<string, string>(); planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:other", operation: "remove", rule: rule.id }, removed);
  assert.equal(removed.get(path.join(root, "framework-config/shared.ts")), "export const shared={access:[]};");
}));
test("adding IAM preserves shared lists and uses canonical workload references", () => fixture((root, model) => {
  const overrides = new Map<string, string>();
  planIamPolicy(root, state(root, model), { kind: "iamPolicy", target: "lambda:caller", operation: "add", statement: { actions: ["lambda:InvokeFunction"], resources: [{ kind: "target", target: "lambda:other" }] } }, overrides);
  const changed = overrides.get(path.join(root, "framework.config.ts"))!;
  assert.ok(changed.includes("access:[...shared.access,"));
  assert.ok(changed.includes('studioTargetArn("lambda:other")'));
  assert.equal(overrides.has(path.join(root, "framework-config/shared.ts")), false);
  const statement = { actions: ["lambda:InvokeFunction"], resources: [{ kind: "target" as const, target: "lambda:other" }] };
  Object.assign(model.targets[0]!, { access: [...model.targets[0]!.access, { actions: statement.actions, resources: ["lambda:other"], statement }] });
  const discovered = discoverPolicyRules(root, model, locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root, host: new SourceFiles(overrides).host() }), file => overrides.get(file) ?? readFileSync(file, "utf8"));
  assert.ok(discovered.some(rule => rule.writable && rule.statement.resources.some(resource => resource.kind === "target" && resource.target === "lambda:other")), "generated target helper aliases are discoverable");
}));
test("computed policies retain a source link and cannot be replaced as literals", () => fixture((root, model) => {
  writeFileSync(path.join(root, "framework-config/shared.ts"), `function buildAccess(){return [${JSON.stringify(original)}];} export const shared={access:buildAccess()};`);
  const current = state(root, model), rule = current.snapshot.source.policyRules![0]!;
  assert.equal(rule.writable, false); assert.equal(rule.shared, true); assert.equal(rule.location?.file, "framework-config/shared.ts");
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "remove", rule: rule.id }, new Map()), /computed/);
}));
test("shared IAM owners follow namespace imports and named barrel reexports", () => fixture((root, model) => {
  writeFileSync(path.join(root, "framework-config/barrel.ts"), 'export {shared as provider} from "./shared";');
  const file = path.join(root, "framework.config.ts"), text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace('import {shared} from "./framework-config/shared";', 'import * as providers from "./framework-config/barrel";').replaceAll("shared.access", "providers.provider.access"));
  const rules = state(root, model).snapshot.source.policyRules!;
  assert.equal(rules.length, 1); assert.equal(rules[0]!.writable, true); assert.equal(rules[0]!.consumers.length, 2);
  assert.equal(rules[0]!.location?.file, "framework-config/shared.ts");
}));
test("IAM writes refuse stale, foreign, and forged resource owners", () => fixture((root, model) => {
  const current = state(root, model), rule = current.snapshot.source.policyRules![0]!;
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "add", statement: { actions: ["s3:GetObject"], resources: [{ kind: "catalog", resource: "resource:example.bucket", attribute: "forgedArn" }] } }, new Map()), /public typed ARN/);
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:missing", operation: "remove", rule: rule.id }, new Map()), /compute workload/);
  writeFileSync(path.join(root, "framework-config/shared.ts"), "export const shared={access:[]};");
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "remove", rule: rule.id }, new Map()), /owning IAM rule changed/);
}));
test("duplicate IAM statements are rejected across existing and pending shared access", () => fixture((root, model) => {
  const current = state(root, model), existing = permissionStatementInput(original);
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "add", statement: existing }, new Map()), /already exists/);
  const added = { actions: ["s3:GetObject"], resources: [{ kind: "literal" as const, value: "*" }] }, overrides = new Map<string, string>();
  planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "add", statement: added }, overrides);
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "add", statement: added }, overrides), /already exists/);
  assert.throws(() => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:other", operation: "update", rule: current.snapshot.source.policyRules![0]!.id, statement: added }, overrides), /already exists/, "a shared update cannot duplicate another affected consumer's pending grant");
}));
test("source ownership compares condition keys canonically and parent comments remain reviewable", () => fixture((root, model) => {
  const conditions = { StringEquals: { z: "last", a: "first" }, Bool: { "aws:SecureTransport": false } };
  const input = { ...permissionStatementInput(original), conditions };
  writeFileSync(path.join(root, "framework-config/shared.ts"), `export const shared={access:[${JSON.stringify({ ...original, conditions })}]};`);
  for (const target of model.targets) Object.assign(target, { access: [{ ...original, statement: { ...input, conditions: { Bool: { "aws:SecureTransport": false }, StringEquals: { a: "first", z: "last" } } } }] });
  assert.ok(state(root, model).snapshot.source.policyRules![0]!.writable);
  assert.equal(permissionStatementKey(input), permissionStatementKey({ ...input, effect: "Allow", conditions: { Bool: { "aws:SecureTransport": false }, StringEquals: { a: "first", z: "last" } } }));
  writeFileSync(path.join(root, "framework-config/shared.ts"), `export const shared={access:[/* preserve owner context */${JSON.stringify({ ...original, conditions })}]};`);
  assert.equal(state(root, model).snapshot.source.policyRules![0]!.writable, true);
}));
test("commented shared IAM owners preserve or explicitly remove interior explanations", () => fixture((root, model) => {
  const file = path.join(root, "framework-config/shared.ts");
  writeFileSync(file, `export const shared={access:[{ actions:["cognito-idp:ListUsers"], resources:[\n// scope explanation\n"arn:aws:cognito-idp:*:*:userpool/*" /* deliberate scope */] }, {actions:["s3:ListBucket"],resources:["*"]}]};`);
  const current = state(root, model), rule = current.snapshot.source.policyRules!.find(rule => rule.writable)!;
  assert.ok(rule.shared);
  const intent = { kind: "iamPolicy" as const, target: "lambda:caller", operation: "update" as const, rule: rule.id, statement: { ...permissionStatementInput(original), effect: "Deny" as const } };
  const overrides = new Map<string, string>();
  const comments = withCommentReview(root, {}, () => { planIamPolicy(root, current, intent, overrides); return reviewedComments(); });
  assert.equal(comments.length, 2); assert.ok(comments.every(comment => comment.resolution === "keep"));
  assert.ok(overrides.get(file)!.includes("// scope explanation")); assert.ok(overrides.get(file)!.includes("/* deliberate scope */")); assert.ok(overrides.get(file)!.includes('effect: "Deny"'));
  assert.ok(overrides.get(file)!.includes('{actions:["s3:ListBucket"],resources:["*"]}'), "other literal statements stay byte-for-byte intact");
  const removed = new Map<string, string>();
  withCommentReview(root, { comments: Object.fromEntries(comments.map(comment => [comment.id, "remove" as const])) }, () => planIamPolicy(root, current, intent, removed));
  assert.ok(!removed.get(file)!.includes("scope explanation")); assert.ok(!removed.get(file)!.includes("deliberate scope"));
  const removal = new Map<string, string>();
  withCommentReview(root, {}, () => planIamPolicy(root, current, { kind: "iamPolicy", target: "lambda:caller", operation: "remove", rule: rule.id }, removal));
  assert.ok(!removal.get(file)!.includes("cognito-idp:ListUsers")); assert.ok(removal.get(file)!.includes("scope explanation")); assert.ok(removal.get(file)!.includes("s3:ListBucket"));
}));
test("IAM request boundary rejects expressions and retains explicit deny conditions", () => {
  assert.throws(() => readIamPolicyEdit({ kind: "iamPolicy", target: "lambda:a", operation: "remove", rule: "source", statement: {} }), /required/);
  assert.throws(() => readPermissionStatement({ actions: ["s3:GetObject"], resources: [{ kind: "catalog", resource: "resource:x", attribute: "arn; process.exit()" }] }), /IAM actions/);
  assert.throws(() => readPermissionStatement({ actions: ["s3:GetObject"], resources: [{ kind: "literal", value: "*" }], conditions: { StringEquals: { key: { nested: "invalid" } } } }), /IAM actions/);
  assert.deepEqual(permissionStatementInput({ actions: ["lambda:InvokeFunction"], resources: [{ $targetArn: "lambda:other" }], effect: "Deny", conditions: { Bool: { "aws:SecureTransport": false } } }), { actions: ["lambda:InvokeFunction"], resources: [{ kind: "target", target: "lambda:other" }], effect: "Deny", conditions: { Bool: { "aws:SecureTransport": false } } });
});

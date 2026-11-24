import assert from "./support/assert";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineFrameworkConfig } from "aws-studio/config";
import { projectModel } from "../server/model/project";
import { planConnection } from "../server/edits/connections";
import type { StudioState } from "../server/snapshot";
import type { DraftEdit } from "../shared/api";

const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const parent = path.resolve(__dirname, "../../.cache/framework-studio");
function fixture(run: (root: string, file: string, state: StudioState) => void) {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "native-binding-")), file = path.join(root, "framework.config.ts");
  mkdirSync(path.join(root, "framework-config"));
  writeFileSync(path.join(root, "framework-config/stacks.ts"), 'import { defineStacks, stack } from "aws-studio/config"; export const stacks=defineStacks({auth:stack<unknown>()});');
  const model = projectModel(defineFrameworkConfig({ defaults, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"] } }], webSocket: [], events: [], services: [] }), { mode: "prod" });
  const resources = [{ id: "resource:auth", path: ["auth"], kind: "stack", stackUsage: { status: "unreferenced" }, absent: false }, ...["pool", "reader"].map(name => ({ id: `resource:auth.${name}`, path: ["auth", name], parent: "resource:auth", kind: "member", absent: false }))];
  const state = { snapshot: { models: { dev: { ...model, mode: "dev", resources }, prod: { ...model, resources } }, source: { permissionCapabilities: [
    { resource: "resource:auth.pool", category: "resource", canonicalTypes: ["aws-cognito:IUserPool"], grants: [{ method: "grant", parameters: [{ name: "actions", type: "string[]", rest: true, optional: true }] }, { method: "grantWithConstruct", parameters: [], reason: "Needs a construct." }] },
    { resource: "resource:auth.reader", category: "policy", canonicalTypes: ["aws-iam:IManagedPolicy"], grants: [] },
  ] } } } as unknown as StudioState;
  try { run(root, file, state); } finally { assert.ok(path.resolve(root).startsWith(parent + path.sep)); rmSync(root, { recursive: true }); }
}
const source = (bindings: string, helper = "") => `import { defineFrameworkConfig${helper} } from "aws-studio/config"; import { stacks as native } from "./framework-config/stacks"; export default defineFrameworkConfig({stacks:native,http:[{"/caller":{directory:"compute/http/caller",methods:["GET"],cloud:{bindings:[${bindings}]}}}],webSocket:[],events:[],services:[]});`;
const edit: Extract<DraftEdit, { kind: "connection" }> = { kind: "connection", target: "lambda:caller", connection: "grant", destination: "resource:auth.pool", grant: "grant", grantArguments: ["cognito-idp:ListUsers"], enabled: true };

test("discovered native grants replace exact arguments and preserve independent grants on disconnected stacks", () => fixture((root, file, state) => {
  writeFileSync(file, source('native.auth.pool.grant("cognito-idp:ListUsers"),native.auth.pool.grant("cognito-idp:AdminGetUser")'));
  const overrides = new Map<string, string>();
  planConnection(root, state, { ...edit, grantArguments: ["cognito-idp:ListUsers", "cognito-idp:ListIdentityProviders"], previousGrant: { method: "grant", arguments: edit.grantArguments! } }, overrides);
  assert.match(overrides.get(file)!, /ListUsers", "cognito-idp:ListIdentityProviders/);
  assert.match(overrides.get(file)!, /AdminGetUser/);
  assert.throws(() => planConnection(root, state, { ...edit, enabled: false }, overrides), /exact permission changed/);
  assert.throws(() => planConnection(root, state, { ...edit, grantArguments: ["cognito-idp:AdminGetUser"], previousGrant: { method: "grant", arguments: ["cognito-idp:ListUsers", "cognito-idp:ListIdentityProviders"] } }, overrides), /replacement native grant already exists/);
  planConnection(root, state, { ...edit, enabled: false, grantArguments: ["cognito-idp:ListUsers", "cognito-idp:ListIdentityProviders"] }, overrides);
  assert.doesNotMatch(overrides.get(file)!, /ListIdentityProviders/);
  assert.match(overrides.get(file)!, /AdminGetUser/);
}));

test("native writer refuses undiscovered, construct-argument, duplicate and ambiguous grants", () => fixture((root, file, state) => {
  writeFileSync(file, source(""));
  assert.throws(() => planConnection(root, state, { ...edit, grant: "grantMadeUp" }, new Map()), /discovered grant/);
  assert.throws(() => planConnection(root, state, { ...edit, grant: "grantWithConstruct" }, new Map()), /Needs a construct/);
  writeFileSync(file, source('native.auth.pool.grant("cognito-idp:ListUsers"),native.auth.pool.grant("cognito-idp:ListUsers")'));
  assert.throws(() => planConnection(root, state, edit, new Map()), /already exists/);
  assert.throws(() => planConnection(root, state, { ...edit, enabled: false }, new Map()), /ambiguous/);
  writeFileSync(file, source('native.auth.pool.grant(...actions)'));
  assert.throws(() => planConnection(root, state, { ...edit, enabled: false }, new Map()), /exact permission changed/);
}));

test("managed policy writer recognizes official helper aliases and keeps native policy documents source-owned", () => fixture((root, file, state) => {
  const intent = { ...edit, connection: "managedPolicy", destination: "resource:auth.reader" } as const;
  writeFileSync(file, source(""));
  const overrides = new Map<string, string>();
  planConnection(root, state, intent, overrides);
  assert.match(overrides.get(file)!, /managedPolicy as studioManagedPolicy/);
  assert.match(overrides.get(file)!, /studioManagedPolicy\(native\["auth"\]\["reader"\]\)/);
  assert.throws(() => planConnection(root, state, intent, overrides), /already exists/);
  planConnection(root, state, { ...intent, enabled: false }, overrides);
  assert.match(overrides.get(file)!, /bindings:\[\]/);
  writeFileSync(file, source("attach(native.auth.reader)", ", managedPolicy as attach"));
  const remove = new Map<string, string>();
  planConnection(root, state, { ...intent, enabled: false }, remove);
  assert.match(remove.get(file)!, /bindings:\[\]/);
  assert.throws(() => planConnection(root, state, { ...intent, destination: "resource:auth.pool" }, new Map()), /IManagedPolicy/);
}));

test("invocation bindings reuse namespace imports and remove exactly one declared helper", () => fixture((root, file, state) => {
  for (const model of Object.values(state.snapshot.models)) Object.assign(model, { targets: [...model.targets, { ...model.targets[0]!, ref: "task:worker", id: "worker", kind: "task", role: "task" }] });
  writeFileSync(file, 'import * as fw from "aws-studio/config";\n' + source('fw.runsTask("worker")'));
  const intent: Extract<DraftEdit, { kind: "connection" }> = { kind: "connection", target: "lambda:caller", connection: "runsTask", destination: "task:worker", enabled: false };
  const overrides = new Map<string, string>();
  planConnection(root, state, intent, overrides);
  assert.match(overrides.get(file)!, /bindings:\[\]/);
  planConnection(root, state, { ...intent, enabled: true }, overrides);
  assert.match(overrides.get(file)!, /fw.runsTask\("worker"\)/);
  assert.doesNotMatch(overrides.get(file)!, /runsTask as studio/);
}));

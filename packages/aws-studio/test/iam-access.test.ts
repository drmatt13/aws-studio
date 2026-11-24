import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stack } from "aws-cdk-lib";
import type { IManagedPolicy } from "aws-cdk-lib/aws-iam";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import {
  cdk, stack, defineStacks, defineFrameworkConfig, getFrameworkTargets, canonicalizeCloudTarget,
  managedPolicy, normalizeCloudAccessStatement, targetArn, type CloudAccessStatement,
} from "../src/config";

declare class SecurityStack extends Stack { readonly reader: IManagedPolicy }

test("custom IAM preserves catalog/workload references, effects and scalar conditions as data", () => {
  const stacks = defineStacks({ files: cdk<IBucket>(), security: stack<SecurityStack>() });
  const statement = normalizeCloudAccessStatement({ actions: ["s3:GetObject"], resources: [{ resource: stacks.files.bucketArn, suffix: "/uploads/*" }, targetArn("lambda:worker"), "*"], effect: "Deny", conditions: { Bool: { "aws:SecureTransport": false }, StringEquals: { "aws:PrincipalTag/team": ["one", "two"] } } });
  assert.equal(statement.effect, "Deny");
  assert.deepEqual(statement.resources[1], { $targetArn: "lambda:worker" });
  assert.deepEqual(statement.conditions, { Bool: { "aws:SecureTransport": false }, StringEquals: { "aws:PrincipalTag/team": ["one", "two"] } });
  assert.deepEqual(JSON.parse(JSON.stringify(managedPolicy(stacks.security.reader))), { capability: "managedPolicy", resource: JSON.parse(JSON.stringify(stacks.security.reader)) });
  assert.deepEqual(stacks.security.reader.managedPolicyArn.path, ["security", "reader"]);
});

test("custom IAM refuses invalid references, objects, effects and condition shapes", () => {
  assert.throws(() => targetArn("service:server" as never), /target/);
  assert.throws(() => managedPolicy({} as never), /catalog/);
  const base = { actions: ["s3:GetObject"], resources: ["*"] };
  for (const patch of [{ actions: [] }, { resources: [] }, { effect: "Maybe" }, { conditions: {} }, { conditions: { Bool: { "aws:SecureTransport": { value: false } } } }, { resources: [{ resource: { $targetArn: "service:server" } }] }, { conditions: { StringEquals: { x: [] } } }, { conditions: { StringEquals: { x: Number.NaN } } }, { extra: true }]) {
    assert.throws(() => normalizeCloudAccessStatement({ ...base, ...patch } as never));
  }
});

test("normalization validates declared IAM references and includes scopes/effects/conditions in compute equality", () => {
  const stacks = defineStacks({ files: cdk<IBucket>(), reader: cdk<IManagedPolicy>() });
  const build = (access: readonly CloudAccessStatement[]) => defineFrameworkConfig({ stacks, defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], cloud: { access, bindings: [managedPolicy(stacks.reader)] } }, "/worker": { directory: "compute/http/worker", methods: ["GET"] } }], webSocket: [], events: [], services: [] });
  const access = { actions: ["s3:GetObject"], resources: [stacks.files.bucketArn, targetArn("lambda:worker")], conditions: { Bool: { "aws:SecureTransport": true } } } as const;
  const cloud = getFrameworkTargets(build([access]))[0]!.cloud;
  assert.equal(cloud.bindings[0]!.capability, "managedPolicy");
  assert.deepEqual(canonicalizeCloudTarget(cloud), canonicalizeCloudTarget(getFrameworkTargets(build([{ ...access, resources: [access.resources[1], access.resources[0]], effect: "Allow" }]))[0]!.cloud));
  assert.notDeepEqual(canonicalizeCloudTarget(cloud), canonicalizeCloudTarget(getFrameworkTargets(build([{ ...access, effect: "Deny" }]))[0]!.cloud));
  assert.throws(() => getFrameworkTargets(build([{ actions: ["lambda:InvokeFunction"], resources: [targetArn("lambda:missing")] }])), /undeclared target/);
});

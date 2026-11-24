import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { defineInputs, defineStacks, input, stack, cdk, resourceAccess, normalizeResourceAccess, resourceAccessDefinition, getFrameworkTargets, defineFrameworkConfig, canonicalizeCloudTarget } from "../src/config";

test("resource access is canonical, serializable and restricted to catalog references", () => {
  const resources = defineStacks({ files: cdk<IBucket>() });
  const binding = resourceAccess(resources.files, { actions: ["write", "read"], limits: { objectPrefix: "uploads/", requireHttps: true } });
  assert.deepEqual(binding.actions, ["read", "write"]);
  assert.equal(binding.resource.path.join("."), "files");
  assert.doesNotThrow(() => JSON.stringify(binding));
  assert.throws(() => resourceAccess({} as never, { actions: ["read"] }), /catalog/);
  for (const invalid of [{ actions: [] }, { actions: ["read", "read"] }, { actions: ["admin"] }, { actions: ["read"], extra: true }, { actions: ["read"], limits: { arbitrary: true } }]) assert.throws(() => normalizeResourceAccess(invalid as never));
  for (const objectPrefix of ["*", "a?b", "${aws:username}/", "line\nbreak", ""]) assert.throws(() => normalizeResourceAccess({ actions: ["read"], limits: { objectPrefix } }), /prefix/);
  assert.deepEqual(normalizeResourceAccess({ actions: ["read"], limits: { requireHttps: false } }), { actions: ["read"] });
  assert.deepEqual(normalizeResourceAccess({ actions: ["read"], limits: {} }), { actions: ["read"] });
  assert.throws(() => normalizeResourceAccess({ actions: ["publish"] }, resourceAccessDefinition(["aws-s3:IBucket"])), /s3 actions/);
  assert.throws(() => normalizeResourceAccess({ actions: ["read"], limits: { requireHttps: true } }, resourceAccessDefinition(["aws-dynamodb:ITable"])), /limits/);
});

test("resource access participates in target normalization and shared-compute equality", () => {
  const resources = defineStacks({ files: cdk<IBucket>() });
  const config = (actions: ("read" | "write")[]) => defineFrameworkConfig({ stacks: resources, defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } }, http: [{ "/read": { directory: "compute/http/reader", methods: ["GET"], cloud: { bindings: [resourceAccess(resources.files, { actions })] } } }], webSocket: [], events: [], services: [] });
  const left = getFrameworkTargets(config(["read", "write"]))[0]!;
  const right = getFrameworkTargets(config(["write", "read"]))[0]!;
  assert.equal(left.cloud.bindings[0]?.capability, "resourceAccess");
  assert.deepEqual(canonicalizeCloudTarget(left.cloud), canonicalizeCloudTarget(right.cloud));
});

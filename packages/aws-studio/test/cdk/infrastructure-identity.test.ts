import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assemblyDirectory, compareAssemblyIdentity, readAssemblyIdentity } from "../../cli/infrastructure-identity";

const ASSET = "a".repeat(64);
const OTHER_ASSET = "b".repeat(64);

interface FixtureStack {
  readonly name: string;
  readonly resources: Record<string, { Type: string; Properties?: unknown }>;
  readonly outputs?: Record<string, { Value: unknown; Export?: { Name: unknown } }>;
  readonly dependsOn?: readonly string[];
  readonly assets?: readonly string[];
  readonly tags?: Record<string, string>;
}

/** A minimal cloud assembly: manifest.json, one template and one asset manifest per stack. */
function assembly(stacks: readonly FixtureStack[]): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "identity-assembly-"));
  const artifacts: Record<string, unknown> = {};
  for (const stack of stacks) {
    const templateFile = `${stack.name}.template.json`;
    writeFileSync(path.join(directory, templateFile), JSON.stringify({ Resources: stack.resources, ...(stack.outputs ? { Outputs: stack.outputs } : {}) }));
    const files: Record<string, unknown> = { ["f".repeat(64)]: { source: { path: templateFile, packaging: "file" } } };
    for (const asset of stack.assets ?? []) files[asset] = { source: { path: `asset.${asset}`, packaging: "zip" } };
    writeFileSync(path.join(directory, `${stack.name}.assets.json`), JSON.stringify({ version: "48.0.0", files, dockerImages: {} }));
    artifacts[`${stack.name}.assets`] = { type: "cdk:asset-manifest", properties: { file: `${stack.name}.assets.json` } };
    artifacts[stack.name] = {
      type: "aws:cloudformation:stack",
      environment: "aws://111111111111/us-east-1",
      properties: { templateFile, tags: stack.tags ?? { "framework:owner": "matts-aws-framework" } },
      dependencies: [`${stack.name}.assets`, ...(stack.dependsOn ?? [])],
    };
  }
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ version: "48.0.0", artifacts }));
  return directory;
}

const base: FixtureStack[] = [
  { name: "app-dev-Foundation", resources: { Bucket83908E77: { Type: "AWS::S3::Bucket", Properties: { BucketEncryption: "AES256" } } }, outputs: { BucketName: { Value: "x", Export: { Name: "app-dev-Foundation:BucketName" } } } },
  {
    name: "app-dev-Workloads",
    dependsOn: ["app-dev-Foundation"],
    assets: [ASSET],
    resources: {
      SignInFunction1A2B3C4D: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-assets", S3Key: `${ASSET}.zip` }, MemorySize: 512 } },
      SignInRole5E6F7A8B: { Type: "AWS::IAM::Role" },
    },
  },
];

function withAssembly<T>(stacks: readonly FixtureStack[], use: (directory: string) => T): T {
  const directory = assembly(stacks);
  try { return use(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("reads each stack's resources, outputs, dependencies, tags and referenced assets", () => {
  const identity = withAssembly(base, readAssemblyIdentity);
  const workloads = identity.stacks["app-dev-Workloads"]!;
  assert.deepEqual(workloads.resources, { SignInFunction1A2B3C4D: "AWS::Lambda::Function", SignInRole5E6F7A8B: "AWS::IAM::Role" });
  assert.deepEqual(workloads.dependencies, ["app-dev-Foundation"], "asset manifests are not stack dependencies");
  assert.deepEqual(workloads.assets, { SignInFunction1A2B3C4D: [ASSET] }, "the template's own file asset is not a resource asset");
  assert.deepEqual(identity.stacks["app-dev-Foundation"]!.outputs, { BucketName: "app-dev-Foundation:BucketName" });
  assert.deepEqual(identity.stacks["app-dev-Foundation"]!.tags, { "framework:owner": "matts-aws-framework" });
  assert.equal(identity.stacks["app-dev-Foundation"]!.environment, "aws://111111111111/us-east-1");
});

test("an unchanged assembly compares identical in identity, properties and assets", () => {
  const before = withAssembly(base, readAssemblyIdentity), after = withAssembly(base, readAssemblyIdentity);
  assert.deepEqual(compareAssemblyIdentity(before, after), { identical: true, identity: [], properties: [], assets: [] });
});

test("identity differences name the stack and logical id: removal, type change, export rename and dependency change", () => {
  const before = withAssembly(base, readAssemblyIdentity);
  const changed: FixtureStack[] = [
    { ...base[0]!, resources: { Bucket83908E77: { Type: "AWS::S3::BucketPolicy" } }, outputs: { BucketName: { Value: "x", Export: { Name: "renamed:BucketName" } } } },
    { ...base[1]!, dependsOn: [], resources: { SignInFunction1A2B3C4D: base[1]!.resources.SignInFunction1A2B3C4D! } },
  ];
  const result = compareAssemblyIdentity(before, withAssembly(changed, readAssemblyIdentity));
  assert.equal(result.identical, false);
  assert.deepEqual(result.identity, [
    "app-dev-Foundation: Bucket83908E77 changed type AWS::S3::Bucket → AWS::S3::BucketPolicy",
    "app-dev-Foundation: output BucketName export app-dev-Foundation:BucketName → renamed:BucketName",
    "app-dev-Workloads: dependencies app-dev-Foundation → (none)",
    "app-dev-Workloads: SignInRole5E6F7A8B (AWS::IAM::Role) removed",
  ]);
});

test("stacks added or removed are identity differences", () => {
  const before = withAssembly(base, readAssemblyIdentity), after = withAssembly([base[0]!], readAssemblyIdentity);
  assert.deepEqual(compareAssemblyIdentity(before, after).identity, ["app-dev-Workloads: stack removed"]);
  assert.deepEqual(compareAssemblyIdentity(after, before).identity, ["app-dev-Workloads: stack added"]);
});

test("a rebuilt asset is an asset change only, and a configuration change is a property change only", () => {
  const before = withAssembly(base, readAssemblyIdentity);
  const rebuilt = withAssembly([base[0]!, { ...base[1]!, assets: [OTHER_ASSET], resources: { ...base[1]!.resources, SignInFunction1A2B3C4D: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-assets", S3Key: `${OTHER_ASSET}.zip` }, MemorySize: 512 } } } }], readAssemblyIdentity);
  assert.deepEqual(compareAssemblyIdentity(before, rebuilt), { identical: true, identity: [], properties: [], assets: ["app-dev-Workloads: SignInFunction1A2B3C4D asset aaaaaaaaaaaa → bbbbbbbbbbbb"] });
  const resized = withAssembly([base[0]!, { ...base[1]!, resources: { ...base[1]!.resources, SignInFunction1A2B3C4D: { Type: "AWS::Lambda::Function", Properties: { Code: { S3Bucket: "cdk-assets", S3Key: `${ASSET}.zip` }, MemorySize: 1024 } } } }], readAssemblyIdentity);
  assert.deepEqual(compareAssemblyIdentity(before, resized), { identical: true, identity: [], properties: ["app-dev-Workloads: SignInFunction1A2B3C4D (AWS::Lambda::Function) properties changed"], assets: [] });
});

test("an assembly directory without a manifest is refused", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "identity-empty-"));
  try {
    mkdirSync(path.join(directory, "nested"));
    assert.throws(() => readAssemblyIdentity(directory), /manifest\.json/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("captures synthesize into one fixed directory per mode, at the depth of cdk-app/cdk.out", () => {
  // Sourcemaps record source paths relative to the output directory, so bundle hashes are
  // comparable only between captures written at the same place, and match `cdk synth` only at
  // cdk.out's depth. The directory is ignored by Git and by every Docker build context.
  const root = path.resolve("/application");
  assert.equal(assemblyDirectory(root, "prod"), path.join(root, ".cache", "infrastructure-assembly-prod"));
  assert.equal(assemblyDirectory(root, "dev"), assemblyDirectory(root, "dev"));
  assert.equal(path.relative(root, assemblyDirectory(root, "dev")).split(path.sep).length, path.relative(root, path.join(root, "cdk-app", "cdk.out")).split(path.sep).length);
});

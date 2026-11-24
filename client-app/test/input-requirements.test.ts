import assert from "./support/assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ModeModel, ModelTarget } from "../shared/model";
import { inputRequirements } from "../server/input-requirements";
import { withDeploymentInputs } from "../server/deployment-inputs";
import { connectionMidpoint } from "../src/scene/routing";
import { resourceIssues, targetIssues } from "../src/issues";

const model: ModeModel = { mode: "dev", status: "ok", targets: [], routes: [], workflows: [], diagnostics: [], fields: {}, evaluatedInMs: 0, edges: [], resources: [
  { id: "resource:choice", path: ["choice"], kind: "input", fromEnv: "CHOICE", default: "bedrock", values: ["openai", "bedrock"], absent: false },
  { id: "resource:key", path: ["key"], kind: "secret", fromEnv: "KEY", absent: false },
  { id: "resource:region", path: ["region"], kind: "input", fromEnv: "REGION", required: true, absent: false },
] };
const consumer = { ref: "lambda:example", title: "Example", environment: [], secrets: [], lanes: { local: true, dev: false, prod: false }, requirementRules: [{ when: { resource: "resource:choice", equals: "openai" }, require: ["resource:key"] }] } as unknown as ModelTarget;

test("required presence respects non-blank values, defaults, conditional consumers, disabled lanes and unknown reads", () => {
  const current = { ...model, targets: [consumer] };
  const check = (values: Record<string, string>) => inputRequirements(current, values, "dev", "cdk-app/.env.dev");
  assert.equal(check({ REGION: "   " }).get("resource:region")!.status, "missing");
  assert.equal(check({ REGION: "provided" }).get("resource:region")!.status, "configured");
  assert.equal(check({}).get("resource:choice")!.status, "default");
  assert.equal(check({}).get("resource:key")!.required, false);
  assert.equal(check({ CHOICE: "OpenAI", KEY: "  " }).get("resource:key")!.status, "missing");
  const result = check({ CHOICE: "OPENAI", KEY: "private-sentinel" });
  assert.equal(result.get("resource:key")!.status, "configured");
  assert.ok(!JSON.stringify([...result]).includes("private-sentinel"));
  assert.equal(inputRequirements(current, { CHOICE: "openai" }, "prod", "x").get("resource:key")!.required, false);
  assert.equal(inputRequirements({ ...current, stale: true }, {}, "dev", "x").get("resource:region")!.status, "unknown");
  assert.equal(inputRequirements(current, {}, "dev", "x", false).get("resource:region")!.status, "unknown");
  const noDefault = { ...current, resources: model.resources.map((item) => item.id === "resource:choice" ? { ...item, default: undefined } : item) };
  assert.equal(inputRequirements(noDefault, {}, "dev", "x").get("resource:choice")!.status, "missing", "an unset conditional selector needs a value");
});

test("missing assignments get actionable connections which retain identity after values or defaults resolve them", () => {
  const cache = path.resolve(__dirname, "../../.cache/framework-studio"); mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, "required-input-")); mkdirSync(path.join(root, "cdk-app"));
  try {
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "CHOICE=openai\nKEY=\nREGION=\n");
    writeFileSync(path.join(root, "cdk-app/.env.prod"), "REGION=prod-private-sentinel\n");
    const dev = { ...model, targets: [consumer], edges: [
      { id: "required-read", from: consumer.ref, to: "resource:key", relation: "env" as const, provenance: "declared" as const, label: "KEY_ARN" },
      { id: "optional-read", from: "lambda:optional", to: "resource:key", relation: "env" as const, provenance: "declared" as const, label: "KEY_ARN" },
    ] }, prod = { ...model, mode: "prod" as const };
    const project = (current = dev) => withDeploymentInputs(root, current, { dev: current, prod });
    const missing = project();
    const region = missing.edges.find((edge) => edge.from === "envfile:dev" && edge.to === "resource:region")!;
    assert.equal(region.inputRequirement!.status, "missing");
    assert.equal(missing.edges.find((edge) => edge.id === "required-read")!.inputRequirement!.status, "missing");
    assert.equal(missing.edges.find((edge) => edge.id === "optional-read")!.inputRequirement, undefined, "optional consumers do not inherit another consumer's failure");
    const key = missing.resources.find(resource => resource.id === "resource:key")!;
    assert.equal(key.inputRequirement!.status, "optional", "the input is not itself required");
    assert.deepEqual(resourceIssues(key), []);
    assert.equal(missing.edges.find(edge => edge.from === "envfile:dev" && edge.to === key.id)!.inputRequirement!.status, "optional", "the file-to-input supply connection owns only declaration requirements");
    assert.ok(targetIssues(missing.targets[0]!).some(issue => issue.title === "Required inputs missing"), "the requiring workload owns its error");
    assert.equal(withDeploymentInputs(root, { ...missing, stale: true }).edges.find((edge) => edge.id === "required-read")!.inputRequirement, undefined, "stale evaluations do not retain a false missing marker");
    assert.deepEqual(targetIssues(withDeploymentInputs(root, { ...missing, stale: true }).targets[0]!), [], "stale target requirements do not retain an error");
    assert.deepEqual(targetIssues(withDeploymentInputs(root, { ...missing, targets: [{ ...consumer, requirementRules: [] }] }).targets[0]!), [], "removing a workload requirement clears its previous error");
    assert.equal(missing.edges.find((edge) => edge.from === "envfile:prod" && edge.to === "resource:region")!.inputRequirement!.status, "configured");
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "CHOICE=openai\nKEY=secret-private-sentinel\nREGION=filled-private-sentinel\n");
    assert.equal(project().edges.find((edge) => edge.id === region.id)!.inputRequirement!.status, "configured");
    for (const sentinel of ["secret-private-sentinel", "filled-private-sentinel", "prod-private-sentinel"]) assert.ok(!JSON.stringify(project()).includes(sentinel));
    writeFileSync(path.join(root, "cdk-app/.env.dev"), "");
    assert.equal(project().edges.find((edge) => edge.id === region.id)!.inputRequirement!.status, "missing", "missing key still has a link");
    const defaulted = { ...dev, resources: dev.resources.map((item) => item.id === "resource:region" ? { ...item, default: "fallback" } : item) };
    assert.equal(project(defaulted).edges.find((edge) => edge.id === region.id)!.inputRequirement!.status, "default");
    rmSync(path.join(root, "cdk-app/.env.dev"));
    // A leftover cdk-app/.env is never consulted: the missing .env.dev leaves the input missing.
    writeFileSync(path.join(root, "cdk-app/.env"), "REGION=legacy-private-sentinel\n");
    assert.equal(project().resources.find((resource) => resource.id === "resource:region")!.inputRequirement!.status, "missing");
    assert.equal(project().resources.find((resource) => resource.id === "resource:region")!.inputRequirement!.file, "cdk-app/.env.dev");
  } finally { assert.ok(root.startsWith(cache + path.sep)); rmSync(root, { recursive: true }); }
});

test("consumer requirements stay with their own workload and graph", () => {
  const required = { ...consumer, requirementRules: [{ require: ["resource:key"] }] };
  const optional = { ...consumer, ref: "lambda:optional", requirementRules: [] };
  const current = { ...model, targets: [required, optional] };
  assert.equal(inputRequirements(current, {}, "dev", "dev", true, { declarationOnly: true }).get("resource:key")!.status, "optional");
  assert.equal(inputRequirements(current, {}, "dev", "dev", true, { target: required.ref }).get("resource:key")!.status, "missing");
  assert.equal(inputRequirements(current, {}, "dev", "dev", true, { target: optional.ref }).get("resource:key")!.status, "optional");
  assert.equal(inputRequirements(current, {}, "prod", "prod", true, { target: required.ref }).get("resource:key")!.status, "optional", "a disabled workload requires nothing");
});

test("the error marker uses the arc-length midpoint rather than a sample index", () => {
  assert.deepEqual(connectionMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 }]), { x: 50, y: 0 });
});

import assert from "./support/assert";
import { test } from "node:test";
import type { ModeModel, ModelResource } from "../shared/model";
import { frameworkManagedIds, isFrameworkManaged, ownershipConsequence, ownershipOf, ownershipReason } from "../shared/framework-management";
import { mergeDeclaredOwnership, withOwnership } from "../server/model/ownership";
import { buildIconShape } from "../src/scene/shapes";

const resource = (id: string, extra: Partial<ModelResource> = {}): ModelResource => ({ id, path: [id], kind: "member", absent: false, ...extra });
const graph = (resources: readonly ModelResource[], ownership: ModeModel["ownership"] = {}, extra: Partial<ModeModel> = {}): ModeModel => ({
  mode: "dev", status: "ok", targets: [], routes: [], resources, edges: [], workflows: [], fields: {}, diagnostics: [], evaluatedInMs: 0, ownership, ...extra,
});

test("views read ownership from the projection; an entity without a record is unresolved, never developer owned", () => {
  const model = graph([], { "resource:a": { managedBy: "framework", basis: "declared" } });
  assert.equal(isFrameworkManaged(model, "resource:a"), true);
  assert.equal(isFrameworkManaged(model, "resource:missing"), false);
  assert.equal(ownershipOf(model, "resource:missing").managedBy, "unresolved");
  assert.deepEqual([...frameworkManagedIds(model)], ["resource:a"]);
  assert.match(ownershipReason(ownershipOf(model, "resource:a")), /AWS Studio platform maintains its definition/);
  assert.match(ownershipConsequence(ownershipOf(model, "resource:missing")), /does not change any definition it can locate/);
});

test("names, kinds and flags never decide ownership: only declarations and single structural owners do", () => {
  // A catalog stack named like a framework stack, and one exporting root .env values, stay as declared.
  const named = resource("resource:http", { kind: "stack", stackClass: "HttpApiGatewayStack", frameworkManaged: "outputs" });
  const namedMember = resource("resource:http.api", { parent: named.id });
  // A stack Studio finds only through its exported outputs has no declaration: unresolved, not framework.
  const uncataloged = resource("framework-stack:CognitoStack", { kind: "stack", stackClass: "CognitoStack", frameworkStack: true });
  const uncatalogedMember = resource("framework-stack:CognitoStack.userPool", { parent: uncataloged.id });
  const file = resource("envfile:dev", { kind: "envFile", deploymentFile: { mode: "dev", path: "cdk-app/.env.dev", template: "cdk-app/.env.dev.template", exists: false, entries: [] } });
  const group = resource("resource:providers", { kind: "group" });
  const entries = [resource("resource:providers.a", { kind: "input", parent: group.id }), resource("resource:providers.b", { kind: "secret", parent: group.id })];
  const mixed = resource("resource:mixed", { kind: "group" });
  const mixedEntries = [resource("resource:mixed.a", { kind: "input", parent: mixed.id }), resource("resource:mixed.b", { kind: "input", parent: mixed.id })];
  const setting = resource("framework:database.instanceClass", { kind: "input", frameworkInput: "database" });
  const loop = resource("resource:loop", { parent: "resource:loop" });
  const declared = {
    "resource:http": { managedBy: "developer", basis: "default" },
    "resource:providers.a": { managedBy: "framework", basis: "declared" },
    "resource:providers.b": { managedBy: "framework", basis: "declared" },
    "resource:mixed.a": { managedBy: "framework", basis: "declared" },
    "resource:mixed.b": { managedBy: "developer", basis: "default" },
    "database:app": { managedBy: "developer", basis: "default" },
  } as const;
  const projected = withOwnership(graph([named, namedMember, uncataloged, uncatalogedMember, file, group, ...entries, mixed, ...mixedEntries, setting, loop], {}, {
    managedDatabase: { id: "app", resource: "resource:rds" } as ModeModel["managedDatabase"],
    localServices: [{ id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image: "postgres", volumes: [], enabled: true }] as unknown as ModeModel["localServices"],
  }), declared);
  assert.deepEqual(ownershipOf(projected, named.id), { managedBy: "developer", basis: "default" });
  assert.deepEqual(ownershipOf(projected, namedMember.id), { managedBy: "developer", basis: "inherited", from: named.id });
  assert.equal(ownershipOf(projected, uncataloged.id).managedBy, "unresolved");
  assert.match(ownershipOf(projected, uncataloged.id).note ?? "", /no stack\(\) declaration names it/);
  assert.deepEqual(ownershipOf(projected, uncatalogedMember.id), { managedBy: "unresolved", basis: "inherited", from: uncataloged.id });
  assert.equal(ownershipOf(projected, file.id).managedBy, "unresolved", "an inputs file has no declared owner");
  assert.deepEqual(ownershipOf(projected, group.id), { managedBy: "framework", basis: "entries" });
  assert.deepEqual(ownershipOf(projected, mixed.id), { managedBy: "unresolved", basis: "conflict", conflicts: [{ where: "resource:mixed.a", managedBy: "framework" }, { where: "resource:mixed.b", managedBy: "developer" }] });
  const { integrations: settingIntegrations, ...settingOwner } = ownershipOf(projected, setting.id);
  assert.deepEqual(settingOwner, { managedBy: "developer", basis: "inherited", from: "database:app" }, "a database override follows the database declaration");
  assert.match((settingIntegrations ?? []).join(" "), /Read by the production database declaration/, "and states its framework reader without changing its owner");
  // The local Compose service runs the database, but implementing it is not owning it.
  assert.equal(ownershipOf(projected, "local:postgres").managedBy, "unresolved");
  assert.match((ownershipOf(projected, "local:postgres").integrations ?? []).join(" "), /Runs the database:app declaration locally/);
  assert.equal(ownershipOf(projected, loop.id).managedBy, "unresolved", "a malformed parent cycle terminates, unresolved");
});

test("declarations that disagree between graphs are unresolved, and agreement keeps the explicit record", () => {
  const merged = mergeDeclaredOwnership([
    ["dev", { "lambda:a": { managedBy: "developer", basis: "default" }, "lambda:b": { managedBy: "developer", basis: "default" }, "resource:only": { managedBy: "framework", basis: "declared" } }],
    ["prod", { "lambda:a": { managedBy: "framework", basis: "declared" }, "lambda:b": { managedBy: "developer", basis: "declared" } }],
  ]);
  assert.deepEqual(merged["lambda:a"], { managedBy: "unresolved", basis: "conflict", conflicts: [{ where: "dev", managedBy: "developer" }, { where: "prod", managedBy: "framework" }] });
  assert.deepEqual(merged["lambda:b"], { managedBy: "developer", basis: "declared" });
  assert.deepEqual(merged["resource:only"], { managedBy: "framework", basis: "declared" }, "a declaration absent from one graph keeps the other's");
});

test("integrations come from the framework's explicit references and never change ownership", () => {
  const stack = resource("resource:auth", { kind: "stack" });
  const projected = withOwnership(graph([stack]), { "resource:auth": { managedBy: "developer", basis: "default" } }, { stackFiles: { "resource:auth": "cdk-app/lib/app/cognito-stack.ts" } });
  assert.equal(ownershipOf(projected, stack.id).managedBy, "developer");
  assert.match((ownershipOf(projected, stack.id).integrations ?? []).join(" "), /Authentication workspace reads cdk-app\/lib\/app\/cognito-stack\.ts/);
});

test("an inputs file keeps its ownership badge geometry", () => {
  const xs = (shape: ReturnType<typeof buildIconShape>) => shape.hull.filter((_, at) => at % 2 === 0);
  assert.ok(Math.max(...xs(buildIconShape(0, 0, true, false))) >= 39 && Math.min(...xs(buildIconShape(0, 0, true, false))) > -39, "one right badge reserves only its own corner");
  assert.ok(Math.min(...xs(buildIconShape(0, 0, true, true))) <= -39, "a role badge displaced to the left keeps its corner too");
});

test("a graph's placeholder for a declaration it leaves out records no owner, and a stack's proxy cannot fake one", async () => {
  const { cdkResourceGroup } = await import("aws-studio/config");
  const { projectDeclaredOwnership } = await import("../server/model/ownership");
  const config = { resources: { kept: cdkResourceGroup(["kept"], false, { managedBy: "framework" }), plain: cdkResourceGroup(["plain"], false), gone: cdkResourceGroup(["gone"], true) } } as unknown as Parameters<typeof projectDeclaredOwnership>[0];
  const records = projectDeclaredOwnership(config, []);
  assert.deepEqual(records["resource:kept"], { managedBy: "framework", basis: "declared" });
  assert.deepEqual(records["resource:plain"], { managedBy: "developer", basis: "default" }, "an ordinary stack answers `absent` with a member reference, not true");
  assert.equal(records["resource:gone"], undefined);
});

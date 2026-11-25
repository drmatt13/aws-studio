import assert from "./support/assert";
import { test } from "node:test";
import type { ModeModel, ModelResource } from "../shared/model";
import { frameworkManagedIds, isFrameworkManaged, ownershipConsequence, ownershipOf, ownershipReason } from "../shared/framework-management";
import { mergeDeclaredOwnership, withOwnership } from "../server/model/ownership";
import { frameworkResourceOwnership } from "../server/model/framework-resource-catalog";
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

test("catalog identities use defining sources, project declarations and structural owners", () => {
  // A catalog stack named like a framework stack, and one exporting root .env values, stay as declared.
  const named = resource("resource:http", { kind: "stack", stackClass: "HttpApiGatewayStack", frameworkManaged: "outputs" });
  const namedMember = resource("resource:http.api", { parent: named.id });
  // An application can export the same outputs as a framework stack from a class it owns.
  const uncataloged = resource("framework-stack:CognitoStack", { kind: "stack", stackClass: "CognitoStack", stackFile: "cdk-app/lib/custom/cognito.ts", frameworkStack: true });
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
  const model = graph([named, namedMember, uncataloged, uncatalogedMember, file, group, ...entries, mixed, ...mixedEntries, setting, loop], {}, {
    managedDatabase: { id: "app", resource: "resource:rds" } as ModeModel["managedDatabase"],
    localServices: [{ id: "local:postgres", title: "Local PostgreSQL", service: "postgres", image: "postgres", volumes: [], enabled: true }] as unknown as ModeModel["localServices"],
  });
  const projected = withOwnership(model, frameworkResourceOwnership(model, declared));
  assert.deepEqual(ownershipOf(projected, named.id), { managedBy: "developer", basis: "default" });
  assert.deepEqual(ownershipOf(projected, namedMember.id), { managedBy: "developer", basis: "inherited", from: named.id });
  assert.equal(ownershipOf(projected, uncataloged.id).managedBy, "developer");
  assert.match(ownershipOf(projected, uncataloged.id).note ?? "", /cdk-app\/lib\/custom\/cognito.ts/);
  assert.deepEqual(ownershipOf(projected, uncatalogedMember.id), { managedBy: "developer", basis: "inherited", from: uncataloged.id });
  assert.equal(ownershipOf(projected, file.id).managedBy, "developer");
  assert.deepEqual(ownershipOf(projected, group.id), { managedBy: "framework", basis: "entries" });
  assert.equal(ownershipOf(projected, mixed.id).basis, "project");
  const { integrations: settingIntegrations, ...settingOwner } = ownershipOf(projected, setting.id);
  assert.deepEqual(settingOwner, { managedBy: "framework", basis: "inherited", from: "database:app" }, "a database override follows the database declaration");
  assert.match((settingIntegrations ?? []).join(" "), /Read by the production database declaration/, "and states its framework reader without changing its owner");
  assert.equal(ownershipOf(projected, "local:postgres").managedBy, "developer");
  assert.match((ownershipOf(projected, "local:postgres").integrations ?? []).join(" "), /Runs the database:app declaration locally/);
  assert.equal(ownershipOf(projected, loop.id).managedBy, "unresolved", "a malformed parent cycle terminates, unresolved");
});

test("database override placeholders retain the production declaration's owner in development", () => {
  const override = resource("framework:database.instanceClass", { kind: "input", frameworkInput: "database" });
  const db = "database:production";
  const production = graph([override], {}, { mode: "prod", managedDatabase: { id: "production", resource: "resource:db.primary" } as ModeModel["managedDatabase"] });
  const development = graph([{ ...override, absent: true }]);
  for (const managedBy of ["developer", "framework"] as const) {
    const declarations = frameworkResourceOwnership(production, { [db]: { managedBy, basis: "declared" } });
    const result = withOwnership(development, declarations, { databaseOverrideOwner: db });
    assert.equal(result.ownership?.[db], undefined, "development has no database declaration of its own");
    const facts = ownershipOf(result, override.id);
    assert.deepEqual([facts.managedBy, facts.basis, facts.from], [managedBy, "inherited", db]);
  }
});

test("mode disagreement preserves both owners and protects the shared definition", () => {
  const merged = mergeDeclaredOwnership([
    ["dev", { "lambda:a": { managedBy: "developer", basis: "default" }, "lambda:b": { managedBy: "developer", basis: "default" }, "resource:only": { managedBy: "framework", basis: "declared" } }],
    ["prod", { "lambda:a": { managedBy: "framework", basis: "declared" }, "lambda:b": { managedBy: "developer", basis: "declared" } }],
  ]);
  assert.deepEqual(merged["lambda:a"], { managedBy: "framework", basis: "conflict", conflicts: [{ where: "dev", managedBy: "developer" }, { where: "prod", managedBy: "framework" }] });
  assert.deepEqual(merged["lambda:b"], { managedBy: "developer", basis: "declared" });
  assert.deepEqual(merged["resource:only"], { managedBy: "framework", basis: "declared" }, "a declaration absent from one graph keeps the other's");
});

test("the catalog recognizes new packaged stack classes and only registered starter implementations", () => {
  const stack = (id: string, stackClass: string, stackFile: string) => resource(id, { kind: "stack", stackClass, stackFile });
  const packaged = stack("resource:new", "NewStack", "node_modules/aws-studio/cdk/new-stack.ts");
  const website = stack("resource:frontend", "FrontendWebsiteS3Stack", "cdk-app/lib/app/frontend-website-s3-stack.ts");
  const other = stack("resource:custom", "FrontendWebsiteS3Stack", "cdk-app/lib/other/website.ts");
  const member = resource("resource:new.bucket", { parent: packaged.id });
  const graphOfStacks = graph([packaged, website, other, member]);
  const declarations = Object.fromEntries([packaged, website, other].map(item => [item.id, { managedBy: "developer", basis: "default" } as const]));
  const owners = frameworkResourceOwnership(graphOfStacks, declarations);
  assert.equal(owners[packaged.id]?.basis, "catalog");
  assert.equal(owners[packaged.id]?.projectOverride, undefined);
  assert.equal(owners[website.id]?.projectOverride, true);
  assert.equal(owners[other.id]?.managedBy, "developer");
  assert.deepEqual(ownershipOf(withOwnership(graphOfStacks, owners), member.id), { managedBy: "framework", basis: "inherited", from: packaged.id });
  for (const managedBy of ["developer", "framework"] as const) {
    const explicit = { managedBy, basis: "declared" } as const;
    const overridden = frameworkResourceOwnership(graphOfStacks, { ...declarations, [website.id]: explicit, [packaged.id]: explicit });
    assert.deepEqual(overridden[website.id], { ...explicit, projectOverride: true });
    assert.equal(overridden[packaged.id]?.managedBy, "framework");
  }
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

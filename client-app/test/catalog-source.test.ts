import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { locateConfigSource } from "aws-studio/source-index";
import { readConfiguredCatalog, readLinkSites, readResourceLinks } from "../server/source/catalog";
import { SourceFiles } from "../server/source";
import { resourceAlias, addResourceImport } from "../server/edits/resource-alias";

test("repository catalogs retain definition links to input and native stack leaf modules", () => {
const root = testProjectRoot;
  const files = new SourceFiles();
  const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root });
  const catalog = readConfiguredCatalog(root, located, file => files.text(file));
  assert.equal(catalog.get("client")?.key.file, "framework-config/inputs/index.ts");
  assert.equal(catalog.get("client")?.value.file, "framework-config/inputs/client.ts");
  assert.equal(catalog.get("client.apiPort")?.value.file, "framework-config/inputs/client.ts");
  assert.equal(catalog.get("cognito")?.key.file, "framework-config/stacks/index.ts");
  assert.equal(catalog.get("cognito")?.value.file, "framework-config/stacks/cognito.ts");
  assert.ok(catalog.get("cognito")?.stack?.members.some(member => member.name === "userPool"));
});

test("native link evidence follows named, namespace and re-export aliases only for the configured catalog", () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "catalog-links-"));
  const save = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  try {
    save("framework.config.ts", 'import { defineFrameworkConfig } from "aws-studio/config"; import { stacks } from "./framework-config/stacks"; export default defineFrameworkConfig({ stacks, http: [], webSocket: [], events: [], services: [] });');
    save("framework-config/stacks/index.ts", 'import { defineStacks, cdk, stack } from "aws-studio/config"; export const other = defineStacks({ wrong: stack<unknown>() }); export const stacks = defineStacks({ storage: stack<unknown>(), jobs: cdk<unknown>(), dynamic: cdk<unknown>(), custom: cdk<unknown>() });');

    save("cdk-app/lib/link-barrel.ts", 'export { linkResource as attach } from "aws-studio/cdk/framework-resources";');
    save("cdk-app/lib/application.ts", 'import * as resources from "aws-studio/cdk/framework-resources"; import { attach } from "./link-barrel"; import * as native from "../../framework-config/stacks"; const group = native.stacks.storage; const link = resources.linkResources; link(this, group); attach(this, native.stacks.jobs, queue); resources.linkResources(this, native.other.wrong); resources.linkResource(this, native.stacks[which], value); customLink(this, native.stacks.custom);');
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root });
    const result = readResourceLinks(root, undefined, located.properties.stacks);
    assert.deepEqual([...result.sites.keys()], ["storage", "jobs"]);
    assert.deepEqual(result.analysis.groups, ["storage"]);
    assert.equal(result.analysis.complete, true);
    assert.ok(result.analysis.unknown.some(item => item.path === "custom" && /custom code/.test(item.reason)));
    assert.ok(result.analysis.unknown.some(item => item.path === undefined && /computed catalog/.test(item.reason)));
    assert.equal(result.sites.has("wrong"), false, "another defineStacks export cannot establish a configured catalog link");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("link scanning reports unresolved custom helpers and unreadable source without inventing direct links", () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "catalog-link-unknown-"));
  const save = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  try {

    save("cdk-app/lib/custom.ts", 'import { linkResource as attach } from "aws-studio/cdk/framework-resources"; export function custom(scope, ref, resource) { attach(scope, ref, resource); }');
    save("cdk-app/lib/unreadable.ts", 'export const unavailable = true;');
    const result = readResourceLinks(root, file => {
      if (file.endsWith("unreadable.ts")) throw new Error("fixture read failure");
      return new SourceFiles().text(file);
    });
    assert.equal(result.sites.size, 0);
    assert.equal(result.analysis.complete, false);
    assert.ok(result.analysis.unknown.some(item => item.source?.file === "cdk-app/lib/custom.ts" && /custom helper/.test(item.reason)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("split catalogs locate aliased factories and descriptor owners without prefixing identities", () => {
  const parent = path.resolve(__dirname, "../../.cache/framework-studio");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "catalog-source-"));
  const save = (file: string, text: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  try {
    save("framework.config.ts", 'import { defineFrameworkConfig as configure } from "aws-studio/config"; import { inputs as parameters } from "./framework-config/inputs"; import * as native from "./framework-config/stacks"; const values = parameters; export default configure({ inputs: values, stacks: native.stacks, http: [], webSocket: [], events: [], services: [] });');
    save("framework-config/inputs/index.ts", 'import { defineInputs as compose } from "aws-studio/config"; import { region as selected } from "./region"; export const inputs = compose({ region: selected });');
    save("framework-config/inputs/region.ts", 'import { input as parameter } from "aws-studio/config"; export const region = parameter.fromEnv("REGION");');
    save("framework-config/stacks/index.ts", 'import * as framework from "aws-studio/config"; import { storage as data } from "./storage"; export const stacks = framework.defineStacks({ storage: data });');
    save("framework-config/stacks/storage.ts", 'import { stack as native } from "aws-studio/config"; import type { Storage as Store } from "../../cdk-app/lib/app/storage"; export const storage = native<Store>();');
    save("cdk-app/lib/app/storage.ts", 'export class Storage { public readonly bucketName!: string; }');

    save("cdk-app/lib/application.ts", 'import { linkResources as link } from "aws-studio/cdk/framework-resources"; import { stacks as native } from "../../framework-config/stacks"; link(this, native.storage);');
    const files = new SourceFiles();
    const located = locateConfigSource(path.join(root, "framework.config.ts"), { repositoryRoot: root });
    const catalog = readConfiguredCatalog(root, located, file => files.text(file));
    assert.deepEqual([...catalog.keys()], ["region", "storage"]);
    assert.equal(catalog.get("region")?.value.file, "framework-config/inputs/region.ts");
    assert.equal(catalog.get("storage")?.value.file, "framework-config/stacks/storage.ts");
    assert.equal(catalog.get("storage")?.stack?.className, "Storage");
    assert.equal(catalog.get("storage")?.stack?.members[0]?.name, "bucketName");
    assert.equal(readLinkSites(root).get("storage")?.[0]?.file, "cdk-app/lib/application.ts");
    const target = path.join(root, "framework-config/workloads/http.ts");
    save("framework-config/workloads/http.ts", 'import { inputs as parameters } from "../inputs/index.js"; import * as native from "../stacks";');
    const source = files.get(target);
    assert.deepEqual(resourceAlias(root, target, source, files.text(target), "inputs", located), { alias: "parameters", imported: true });
    assert.deepEqual(resourceAlias(root, target, source, files.text(target), "stacks", located), { alias: "native.stacks", imported: true });
    assert.match(addResourceImport(root, target, "", "values", "inputs", located), /import \{ inputs as values \} from "\.\.\/inputs"/);
    assert.match(addResourceImport(root, target, "", "native", "stacks", located), /import \{ stacks as native \} from "\.\.\/stacks"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

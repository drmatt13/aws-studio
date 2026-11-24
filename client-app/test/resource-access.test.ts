import assert from "./support/assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { projectModel } from "../server/model/project";
import { planConnection } from "../server/edits/connections";
import { discoverCapabilities } from "../server/source/capabilities";
import type { CatalogEntrySource } from "../server/source/catalog";
import type { StudioState } from "../server/snapshot";
import type { DraftEdit } from "../shared/api";
import type { SourceIndex } from "../shared/model";
import { readWorkloadOperation } from "../shared/workload-operations";
import { configuredAccessOptions, accessConnectionExists } from "../src/access-options";
import { targetAccess } from "../src/access";
import { permissionRuleCoveredBy } from "../shared/grants";
import { defineFrameworkConfig, defineStacks, input, stack, cdk, resourceAccess } from "aws-studio/config";
import type { IBucket } from "aws-cdk-lib/aws-s3";

const defaults = { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} } } as const;
const base = () => projectModel(defineFrameworkConfig({ defaults, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"] } }], webSocket: [], events: [], services: [] }), { mode: "prod" });
const parent = path.resolve(__dirname, "../../.cache/framework-studio");
function fixture(run: (root: string) => void) {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "resource-access-"));
  mkdirSync(path.join(root, "framework-config"), { recursive: true });
  writeFileSync(path.join(root, "framework-config/stacks.ts"), 'import { defineStacks, stack } from "aws-studio/config"; import type { Stack } from "aws-cdk-lib"; export const stacks=defineStacks({storage:stack<Stack>()});');
  try { run(root); } finally { assert.ok(path.resolve(root).startsWith(parent + path.sep)); rmSync(root, { recursive: true }); }
}
function state(): StudioState {
  const model = { ...base(), resources: [{ id: "resource:storage.files", path: ["storage", "files"], kind: "member" as const, absent: false }] };
  return { snapshot: { models: { dev: { ...model, mode: "dev" }, prod: model }, source: { permissionCapabilities: [{ resource: "resource:storage.files", category: "resource", canonicalTypes: ["aws-s3:IBucket"] }] } } } as unknown as StudioState;
}
const source = (bindings = "", helper = "resourceAccess as allow") => `import { defineFrameworkConfig, ${helper} } from "aws-studio/config"; import { stacks as catalog } from "./framework-config/stacks"; export default defineFrameworkConfig({ stacks: catalog, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], cloud: { bindings: [${bindings}] } } }], webSocket: [], events: [], services: [] });`;
const edit: Extract<DraftEdit, { kind: "connection" }> = { kind: "connection", target: "lambda:caller", connection: "resourceAccess", destination: "resource:storage.files", enabled: true, actions: ["write"] };

test("permission discovery is independent of triggers and resolves public aliases, secrets and standalone CDK resources", () => fixture(root => {
  mkdirSync(path.join(root, "cdk-app/lib/app"), { recursive: true });
  const declaration = 'import { stack as typedStack, cdk } from "aws-studio/config"; import * as fw from "aws-studio/config"; import type { DataStack as Store } from "../cdk-app/lib/app/data"; import type { IQueue } from "aws-cdk-lib/aws-sqs"; import type {ISecret} from "aws-cdk-lib/aws-secretsmanager"; function stack<T>() { throw new Error("unrelated local factory"); } export const stacks={storage:typedStack<Store>(),jobs:cdk<IQueue>(),standaloneSecret:cdk<ISecret>(),namespaced:fw.stack<Store>(),namespacedQueue:fw.cdk<IQueue>(),forged:stack<Store>()};';
  writeFileSync(path.join(root, "framework-config/stacks.ts"), declaration);
  writeFileSync(path.join(root, "cdk-app/lib/app/data.ts"), `import { Stack } from "aws-cdk-lib"; import * as s3 from "aws-cdk-lib/aws-s3"; import type { ISecret } from "aws-cdk-lib/aws-secretsmanager"; import type { IFunction } from "aws-cdk-lib/aws-lambda"; import type {IUserPool} from "aws-cdk-lib/aws-cognito"; import type {IManagedPolicy,IGrantable} from "aws-cdk-lib/aws-iam"; import type {IConstruct,Construct} from "constructs";
throw new Error("must never execute discovery");
const props: s3.BucketProps = {enforceSSL:false};
interface Custom extends IConstruct { grantCustom(grantee:IGrantable,scope:Construct):unknown; grantCustom(grantee:IGrantable,scope:string):unknown; }
type BucketAlias = s3.IBucket;
class BaseStack extends Stack { public readonly inherited!: BucketAlias; protected basePrivate!:s3.IBucket; }
export class DataStack extends BaseStack {
  constructor(public readonly parameter: BucketAlias) { super(); }
  public static staticBucket:s3.IBucket;
  public readonly unknownResource!:unknown;
  public readonly untypedResource!:any;
  get publicGetter():BucketAlias { throw new Error("do not execute"); }
  public readonly files:s3.IBucket=new s3.Bucket(this,"Files",{enforceSSL:true});
  public readonly overriddenSSL:s3.IBucket=new s3.Bucket(this,"Overridden",{enforceSSL:true,...props});
  public readonly explicitSSL:s3.IBucket=new s3.Bucket(this,"Explicit",{...props,enforceSSL:true});
  public readonly key!:ISecret;
  public readonly worker!:IFunction;
  public readonly pool!:IUserPool;
  public readonly policy!:IManagedPolicy;
  public readonly custom!:Custom;
  public readonly optional?:s3.IBucket;
  public readonly absent!:null|undefined;
  private hidden!:s3.IBucket;
  #hiddenHash!:s3.IBucket;
  protected internal!:s3.IBucket;
  public readonly looksLikeBucket!: {bucketArn:string};
}
`);
  const catalog = new Map<string, CatalogEntrySource>();
  for (const [name, expression] of [["storage", "typedStack<Store>()"], ["jobs", "cdk<IQueue>()"], ["standaloneSecret", "cdk<ISecret>()"], ["namespaced", "fw.stack<Store>()"], ["namespacedQueue", "fw.cdk<IQueue>()"], ["forged", "stack<Store>()"]]) {
    const start = declaration.indexOf(`${name}:`) + name!.length + 1, location = { file: "framework-config/stacks.ts", line: 1, column: start + 1, start, end: start + expression!.length };
    catalog.set(name!, { key: location, value: location });
  }
  const discovered = discoverCapabilities(root, catalog, []);
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.files")?.canonicalTypes.includes("aws-s3:IBucket"));
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.files")?.requireHttps, true);
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.overriddenSSL")?.requireHttps, undefined);
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.explicitSSL")?.requireHttps, true);
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.key")?.category, "secret");
  assert.deepEqual(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.key")?.attributes, ["arn"], "stack secret ARNs use the catalog's SecretProjections API");
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:standaloneSecret")?.attributes?.includes("secretArn"), "standalone cdk<ISecret> preserves its native attribute API");
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.worker")?.canonicalTypes.includes("aws-lambda:IFunction"));
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:jobs")?.canonicalTypes.includes("aws-sqs:IQueue"));
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.files")?.attributes?.includes("bucketArn"));
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.files")?.grants?.some(grant => grant.method === "grantRead" && !grant.reason));
  const generic = discovered.permissionCapabilities.find(item => item.resource === "resource:storage.pool")?.grants?.find(grant => grant.method === "grant");
  assert.ok(generic && !generic.reason && generic.parameters[0]?.rest, "native Cognito grants are discovered without a service allowlist");
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.policy")?.category, "policy");
  const custom = discovered.permissionCapabilities.find(item => item.resource === "resource:storage.custom")?.grants?.find(grant => grant.method === "grantCustom");
  assert.equal(custom?.parameters[0]?.type, "string", "serializable overloads are preferred over construct-argument overloads");
  assert.equal(custom?.reason, undefined);
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:namespaced.files")?.canonicalTypes.includes("aws-s3:IBucket"));
  assert.ok(discovered.permissionCapabilities.find(item => item.resource === "resource:namespacedQueue")?.canonicalTypes.includes("aws-sqs:IQueue"));
  assert.ok(!discovered.permissionCapabilities.some(item => item.resource.startsWith("resource:forged")));
  assert.match(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.optional")!.reason!, /absent/);
  assert.ok(!discovered.permissionCapabilities.some(item => /hidden|internal/.test(item.resource)));
  assert.ok(!discovered.catalog.get("storage")!.stack!.members.some(item => /hidden|internal/.test(item.name)));
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.looksLikeBucket"), undefined);
  assert.equal(discovered.permissionCapabilities.find(item => item.resource === "resource:storage.absent"), undefined);
  for (const name of ["parameter", "publicGetter", "inherited"]) assert.ok(discovered.permissionCapabilities.find(item => item.resource === `resource:storage.${name}`)?.canonicalTypes.includes("aws-s3:IBucket"), name);
  for (const name of ["staticBucket", "basePrivate", "unknownResource", "untypedResource"]) assert.ok(!discovered.catalog.get("storage")!.stack!.members.some(member => member.name === name), name);
  assert.ok(!JSON.stringify(discovered.permissionCapabilities).includes("must never execute"));
}));

test("source rules add, update and remove exact options while preserving unrelated grants and import aliases", () => fixture(root => {
  const file = path.join(root, "framework.config.ts");
  writeFileSync(file, source('catalog.storage.files.grantRead("legacy/*")'));
  const overrides = new Map<string, string>();
  const current = state();
  planConnection(root, current, edit, overrides);
  assert.match(overrides.get(file)!, /allow\(catalog\["storage"\]\["files"\], \{"actions":\["write"\]\}\)/);
  assert.match(overrides.get(file)!, /grantRead\("legacy\/\*"\)/);
  assert.throws(() => planConnection(root, current, edit, overrides), /already exists/);
  planConnection(root, current, { ...edit, actions: ["read", "write"], limits: { objectPrefix: "reports/", requireHttps: true }, previous: { actions: ["write"] } }, overrides);
  assert.match(overrides.get(file)!, /"objectPrefix":"reports\/"/);
  assert.match(overrides.get(file)!, /"requireHttps":true/);
  const reviewed = overrides.get(file);
  assert.throws(() => planConnection(root, current, { ...edit, previous: { actions: ["write"] }, actions: ["delete"] }, overrides), /changed|ambiguous/);
  assert.equal(overrides.get(file), reviewed);
  planConnection(root, current, { ...edit, enabled: false, actions: ["write", "read"], limits: { objectPrefix: "reports/", requireHttps: true } }, overrides);
  assert.match(overrides.get(file)!, /grantRead\("legacy\/\*"\)/);
  assert.ok(!overrides.get(file)!.includes('"objectPrefix"'));
}));

test("source authoring rejects ambiguity, computed source, forged helpers and incompatible limits", () => fixture(root => {
  const file = path.join(root, "framework.config.ts"), current = state();
  const rule = 'allow(catalog.storage.files,{actions:["write"]})';
  for (const bindings of [`${rule},${rule}`, "...sharedBindings", `/* keep this comment */ ${rule}`, 'allow(catalog.storage.files,{...options,actions:["write"]})', 'allow(catalog.storage.files,{actions:someActions})']) {
    const original = source(bindings); writeFileSync(file, original);
    const overrides = new Map<string, string>();
    assert.throws(() => planConnection(root, current, { ...edit, enabled: false }, overrides), /ambiguous|computed|commented/);
    assert.equal(overrides.size, 0);
  }
  writeFileSync(file, source(rule).replace('from "aws-studio/config"', 'from "untrusted-helper"'));
  assert.throws(() => planConnection(root, current, { ...edit, enabled: false }, new Map()), /changed|ambiguous/);
  writeFileSync(file, source());
  assert.throws(() => planConnection(root, current, { ...edit, actions: ["publish"] }, new Map()), /s3 actions/);
  assert.throws(() => planConnection(root, current, { ...edit, limits: { objectPrefix: "a*" } }, new Map()), /prefix/);
  assert.throws(() => readWorkloadOperation({ ...edit, limits: { arbitrary: true } }), /supported/);
  assert.throws(() => readWorkloadOperation({ ...edit, previous: { actions: ["read"], arbitrary: true } }), /supported/);
  assert.throws(() => readWorkloadOperation({ ...edit, scope: "*" }), /supported/);
}));

test("optional native fields refuse new guided grants while existing exact rules remain removable", () => fixture(root => {
  const file = path.join(root, "framework.config.ts"), current = state();
  const rule = 'allow(catalog.storage.files,{actions:["write"]})';
  writeFileSync(file, source(rule));
  Object.assign(current.snapshot.source.permissionCapabilities![0]!, { reason: "This field may be absent. Configure it in source." });
  const overrides = new Map<string, string>();
  assert.throws(() => planConnection(root, current, { ...edit, actions: ["read"] }, overrides), /may be absent/);
  assert.equal(overrides.size, 0);
  planConnection(root, current, { ...edit, enabled: false }, overrides);
  assert.match(overrides.get(file)!, /bindings: \[\]/);
  assert.ok(!overrides.get(file)!.includes(rule));
}));

test("namespace helper imports round-trip without replacing source-owned native bindings", () => fixture(root => {
  const file = path.join(root, "framework.config.ts");
  const code = source('fw.resourceAccess(catalog.storage.files,{actions:["read"]})').replace('import { defineFrameworkConfig, resourceAccess as allow } from "aws-studio/config";', 'import { defineFrameworkConfig } from "aws-studio/config"; import * as fw from "aws-studio/config";');
  writeFileSync(file, code);
  const overrides = new Map<string, string>();
  planConnection(root, state(), { ...edit, previous: { actions: ["read"] } }, overrides);
  assert.match(overrides.get(file)!, /fw\.resourceAccess\(catalog\["storage"\]\["files"\]/);
}));

test("uninstantiated stacks remain authorable while optional fields refuse unsafe access", () => fixture(root => {
  const file = path.join(root, "framework.config.ts");
  writeFileSync(file, source());
  const current = state();
  const capability = current.snapshot.source.permissionCapabilities![0]!;
  Object.assign(capability, { stack: "resource:storage" });
  for (const model of Object.values(current.snapshot.models)) Object.assign(model, { resources: [...model.resources, { id: "resource:storage", path: ["storage"], kind: "stack", absent: false, stackUsage: { status: "unreferenced", sites: [] } }] });
  const overrides = new Map<string, string>();
  planConnection(root, current, edit, overrides);
  assert.ok(overrides.size > 0);
  overrides.clear();
  Object.assign(capability, { category: "secret", canonicalTypes: ["aws-secretsmanager:ISecret"] });
  const secretEdit = { ...edit, connection: "resource" as const, actions: undefined, variable: "FILES_SECRET_ARN" };
  planConnection(root, current, secretEdit, overrides);
  assert.ok(overrides.size > 0);
  overrides.clear();
  Object.assign(capability, { reason: "This field may be absent. Configure it in source." });
  assert.throws(() => planConnection(root, current, secretEdit, overrides), /may be absent/);
  assert.equal(overrides.size, 0);
  Object.assign(capability, { reason: undefined });
  for (const model of Object.values(current.snapshot.models)) Object.assign(model.resources.find(item => item.id === "resource:storage")!, { stackUsage: { status: "referenced", sites: [] } });
  planConnection(root, current, secretEdit, overrides);
  assert.match(overrides.get(file)!, /FILES_SECRET_ARN: catalog\["storage"\]\["files"\]\.arn/);
}));

test("native source access can reference resources absent from a deployed lane", () => fixture(root => {
  writeFileSync(path.join(root, "framework.config.ts"), source());
  for (const mode of ["dev", "prod"] as const) {
    const current = state();
    for (const model of Object.values(current.snapshot.models)) Object.assign(model.targets[0]!, { lanes: { local: true, dev: true, prod: true } });
    Object.assign(current.snapshot.models[mode], { resources: current.snapshot.models[mode].resources.map(resource => ({ ...resource, absent: true })) });
    const overrides = new Map<string, string>();
    planConnection(root, current, edit, overrides);
    assert.equal(configuredAccessOptions(current.snapshot.models.prod.targets[0]!, current.snapshot, edit.destination)[0]!.reason, undefined);
    assert.ok(overrides.size > 0);
  }
}));

test("projection, picker and exact removal share actions, limits and source principal ownership", () => {
  const resources = defineStacks({ files: cdk<IBucket>() });
  const config = defineFrameworkConfig({ stacks: resources, defaults, http: [{ "/caller": { directory: "compute/http/caller", methods: ["GET"], cloud: { bindings: [resourceAccess(resources.files, { actions: ["write"], limits: { objectPrefix: "uploads/", requireHttps: true } })] } } }], webSocket: [], events: [], services: [] });
  const prod = projectModel(config, { mode: "prod" }), dev = projectModel(config, { mode: "dev" });
  const location = { file: "framework.config.ts", line: 1, column: 1, start: 0, end: 1 };
  const sourceIndex: SourceIndex = { entities: { "lambda:caller": { origin: 'http["/caller"]', key: location, value: location } }, editability: {}, catalog: {}, links: {}, problems: [], cdkLinks: { version: 2, files: {}, edges: [], notes: [], manualWiring: [] }, permissionCapabilities: [{ resource: "resource:files", category: "resource" as const, canonicalTypes: ["aws-s3:IBucket"] }] };
  const snapshot = { models: { dev, prod }, source: sourceIndex };
  const target = prod.targets[0]!;
  const entry = targetAccess(target, prod, sourceIndex).owned[0]!;
  assert.equal(entry.operation, "Write objects");
  assert.equal(entry.remove?.connection, "resourceAccess");
  assert.equal(accessConnectionExists({ ...entry.remove!, enabled: true }, snapshot), true);
  assert.equal(accessConnectionExists({ ...entry.remove!, enabled: true, limits: { objectPrefix: "elsewhere/" } }, snapshot), false);
  assert.equal(accessConnectionExists({ ...entry.remove!, enabled: true, limits: { objectPrefix: "" } }, snapshot), false, "intermediate prefix text cannot crash the editor");
  assert.deepEqual(configuredAccessOptions(target, snapshot, "resource:files")[0]!.definition!.actions.map(item => item.id), ["read", "write", "delete"]);
  assert.ok(entry.authorization.grants[0]!.conditions?.includes("Requires HTTPS"));
  const rule = { actions: ["write"] as const, limits: { objectPrefix: "uploads/", requireHttps: true } };
  assert.ok(permissionRuleCoveredBy(rule, { method: "grantReadWrite", arguments: [] }));
  assert.ok(!permissionRuleCoveredBy(rule, { method: "grantRead", arguments: [] }));
  assert.ok(!permissionRuleCoveredBy(rule, { method: "grantWrite", arguments: ["private/*"] }));
  assert.ok(!permissionRuleCoveredBy({ actions: ["write"] }, rule));
});

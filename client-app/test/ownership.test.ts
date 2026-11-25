import { testProjectRoot } from "../../scripts/test-project";
import { installFixtureRelease } from "./support/project-cli";
import { sourceFixtureCheckpoint, studioTestScratchRoot } from "./support/source-fixture";
import assert from "./support/assert";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { EditService } from "../server/edits/transaction";
import { installSourceWriteGuard, writeSourceChange } from "aws-studio/source/io";
import { assessOwnership, assertOwnershipAllows, assertStackSourceWritable, declarationSignature, declaredOwner } from "../server/edits/ownership-guard";
import { applySourceDiff, reviewProposalOwnership } from "../server/edits/proposal-ownership";
import { parse } from "../server/source/syntax";
import { sourceDiff } from "../shared/source-diff";
import { idsOwnedBy, ownershipOf } from "../shared/framework-management";
import type { StudioState } from "../server/snapshot";

const fixture = path.join(studioTestScratchRoot(), ".cache/framework-studio", `ownership-${randomUUID()}`);
const workloads = path.join(fixture, "framework-config/features/accounts.ts");
const parameters = path.join(fixture, "framework-config/inputs/parameters.ts");
const originalWorkloads = `import { PROD_DEPLOYMENT } from "aws-studio/config/source";
export const accountRoutes = {
  // Maintained by the platform; Studio must not change it.
  "/platform": { directory: "compute/http/platform", methods: ["GET"], managedBy: "framework", memorySize: 256 },
  "/mine": { directory: "compute/http/mine", methods: ["GET"], memorySize: 256 },
  "/split": { directory: "compute/http/split", methods: ["GET"], managedBy: PROD_DEPLOYMENT ? "framework" : "developer", memorySize: 256 },
} as const;
`;
const originalParameters = `import { input } from "aws-studio/config";
export const fixed = input.fromEnv("FIXED", { managedBy: "framework" }).default("one");
export const mine = input.fromEnv("MINE").default("two");
export const providers = {
  first: input.fromEnv("FIRST", { tags: { area: "auth" }, managedBy: "framework" }),
  second: input.secret("SECOND", { managedBy: "framework" }),
};
export const mixed = {
  platform: input.fromEnv("MIXED_PLATFORM", { managedBy: "framework" }),
  app: input.fromEnv("MIXED_APP"),
};
`;
let builder: SnapshotBuilder;
let edits: EditService;
before(async () => {
  for (const directory of ["framework-config/features", "framework-config/inputs", "framework-config/stacks", "compute/http/platform", "compute/http/mine", "compute/http/split"]) mkdirSync(path.join(fixture, directory), { recursive: true });
  cpSync(path.join(testProjectRoot, "framework-config/defaults.ts"), path.join(fixture, "framework-config/defaults.ts"));
  cpSync(path.join(testProjectRoot, "framework-config/templates"), path.join(fixture, "framework-config/templates"), { recursive: true });
  for (const name of ["platform", "mine", "split"]) writeFileSync(path.join(fixture, `compute/http/${name}/index.ts`), "export const lambdaHandler = async () => ({ statusCode: 200 });\n");
  writeFileSync(workloads, originalWorkloads);
  writeFileSync(parameters, originalParameters);
  writeFileSync(path.join(fixture, "framework-config/inputs/index.ts"), 'import { defineInputs } from "aws-studio/config";\nimport { fixed, mine, mixed, providers } from "./parameters";\nexport const inputs = defineInputs({ fixed, mine, providers, mixed });\n');
  writeFileSync(path.join(fixture, "framework-config/stacks/index.ts"), 'import { defineStacks } from "aws-studio/config"; export const stacks = defineStacks({});\n');
  writeFileSync(path.join(fixture, "framework.config.ts"), 'import { defineFrameworkConfig } from "aws-studio/config";\nimport { defaults } from "./framework-config/defaults";\nimport { inputs } from "./framework-config/inputs";\nimport { stacks } from "./framework-config/stacks";\nimport { accountRoutes } from "./framework-config/features/accounts";\nexport default defineFrameworkConfig({ inputs, stacks, defaults, http: [accountRoutes], webSocket: [], events: [], services: [] });\n');
  installFixtureRelease(fixture);
  builder = new SnapshotBuilder(fixture);
  edits = new EditService(fixture, builder);
  await builder.refresh();
  assert.equal(builder.current!.snapshot.models.dev.status, "ok", JSON.stringify(builder.current!.snapshot.models.dev.diagnostics));
});
let restoreSource: () => Promise<void>;
beforeEach(() => { restoreSource = sourceFixtureCheckpoint(fixture, builder); });
afterEach(async () => { await restoreSource(); });
after(async () => { await builder?.dispose(); rmSync(fixture, { recursive: true, force: true }); });
const state = () => builder.current!;
const revision = () => state().snapshot.revision;
const model = () => state().snapshot.models.dev;
/** A proposed change to one route's declaration line, as any writer would produce it. */
const routeChange = (route: string, change: (line: string) => string) => {
  const before = readFileSync(workloads, "utf8");
  const line = before.split("\n").find(text => text.includes(`"${route}"`))!;
  return { file: workloads, before, after: before.replace(line, change(line)) };
};
const memory = (route: string) => routeChange(route, line => line.replace("memorySize: 256", "memorySize: 512"));

test("Studio assigns catalog, declared and structural ownership in both modes", () => {
  for (const mode of ["dev", "prod"] as const) {
    const graph = state().snapshot.models[mode];
    assert.deepEqual(ownershipOf(graph, "lambda:platform"), { managedBy: "framework", basis: "declared" });
    assert.deepEqual(ownershipOf(graph, "route:http:/platform"), { managedBy: "framework", basis: "inherited", from: "lambda:platform" });
    // A workload the framework builds from its own constructs is still the developer's.
    assert.deepEqual(ownershipOf(graph, "lambda:mine"), { managedBy: "developer", basis: "default" });
    assert.deepEqual(ownershipOf(graph, "route:http:/mine"), { managedBy: "developer", basis: "inherited", from: "lambda:mine" });
    assert.deepEqual(ownershipOf(graph, "resource:fixed"), { managedBy: "framework", basis: "declared" });
    assert.deepEqual(ownershipOf(graph, "resource:mine"), { managedBy: "developer", basis: "default" });
    assert.deepEqual(ownershipOf(graph, "resource:providers"), { managedBy: "framework", basis: "entries" });
    // One source definition must satisfy the framework guard if either mode is framework owned.
    assert.deepEqual(ownershipOf(graph, "lambda:split"), { managedBy: "framework", basis: "conflict", conflicts: [{ where: "dev", managedBy: "developer" }, { where: "prod", managedBy: "framework" }] });
    assert.equal(ownershipOf(graph, "route:http:/split").managedBy, "framework");
    assert.equal(ownershipOf(graph, "resource:mixed").basis, "project");
    // Studio defines the HTTP API independently of the owners of its routes.
    assert.equal(ownershipOf(graph, "gateway:http").managedBy, "framework");
    assert.equal(ownershipOf(graph, "gateway:http").basis, "catalog");
    // Every graph entity has an answer, and none is silently developer owned.
    for (const id of [...graph.targets.map(target => target.ref), ...graph.routes.map(route => route.id), ...graph.resources.map(resource => resource.id)]) assert.ok(graph.ownership?.[id], `${mode}: ${id} has an owner record`);
    for (const [id, facts] of Object.entries(graph.ownership ?? {})) if (facts.managedBy === "developer") assert.ok(["project", "default", "declared", "inherited", "entries"].includes(facts.basis), `${id}: developer only from evidence`);
  }
  assert.ok(idsOwnedBy(model(), "framework").has("lambda:split"));
});

test("the server refuses changes to definitions Studio does not own, and allows developer-owned ones", async () => {
  await assert.rejects(edits.planBatch([{ kind: "field", intent: { target: "lambda:platform", field: "lambda.memorySize", value: 512 } }], revision()), /lambda:platform: the AWS Studio platform maintains it/);
  await assert.rejects(edits.planBatch([{ kind: "removeWorkload", target: "lambda:platform" }], revision()), /platform maintains it/);
  await assert.rejects(edits.planBatch([{ kind: "route", route: "route:http:/platform", value: "/moved" }], revision()), /platform maintains it/);
  await assert.rejects(edits.planBatch([{ kind: "resourceConfig", intent: { resource: "resource:fixed", kind: "input", fromEnv: "RENAMED", group: "", requirements: {}, modes: { dev: { present: true, required: false, default: "one" }, prod: { present: true, required: false, default: "one" } } } }], revision()), /platform maintains it/);
  // The shared definition stays protected when either mode assigns it to the framework.
  assert.throws(() => assertOwnershipAllows(fixture, state(), [memory("/split")]), /lambda:split: the AWS Studio platform maintains it/);
  // Developer-owned declarations in the same file stay editable, as do the platform one's tags.
  const mine = await edits.planBatch([{ kind: "resourceConfig", intent: { resource: "resource:mine", kind: "input", fromEnv: "MINE", group: "", requirements: {}, modes: { dev: { present: true, required: false, default: "three" }, prod: { present: true, required: false, default: "three" } } } }], revision());
  assert.ok(mine.ok, JSON.stringify(mine.preflight));
  assert.doesNotThrow(() => assertOwnershipAllows(fixture, state(), [memory("/mine")]));
  const tags = await edits.planBatch([{ kind: "tags", entity: "lambda:platform", tags: { area: "platform" } }], revision());
  assert.ok(tags.ok, JSON.stringify(tags.preflight));
  assert.equal(readFileSync(workloads, "utf8"), originalWorkloads, "review writes nothing");
});

test("an ownership change is its own transition: explicit, reviewed alone, and never combined with a definition change", async () => {
  await assert.rejects(edits.planBatch([{ kind: "ownership", entity: "lambda:platform", managedBy: "developer" }, { kind: "tags", entity: "lambda:mine", tags: { area: "x" } }], revision()), /reviewed on its own/);
  // One change set that both releases ownership and edits the definition is refused, whoever proposes it.
  assert.throws(() => assertOwnershipAllows(fixture, state(), [routeChange("/platform", line => line.replace('managedBy: "framework", memorySize: 256', 'managedBy: "developer", memorySize: 512'))]), /both its ownership \(framework → developer\) and its definition/);
  assert.deepEqual(assessOwnership(fixture, state(), [routeChange("/mine", line => line.replace("memorySize: 256", 'memorySize: 256, managedBy: "framework"'))]).map(item => [item.entity, item.from, item.to]), [["lambda:mine", "developer", "framework"]]);

  const release = await edits.planBatch([{ kind: "ownership", entity: "lambda:platform", managedBy: "developer" }], revision());
  assert.ok(release.ok, JSON.stringify(release.preflight));
  assert.match(release.summaries.join("\n"), /lambda:platform — ownership aws studio platform → application developer\. Studio may change its definition/);
  assert.equal((await edits.applyBatch(release.planId)).status, "applied");
  assert.match(readFileSync(workloads, "utf8"), /"\/platform": \{[^}]*managedBy: "developer"/, "the decision is recorded explicitly");
  assert.match(readFileSync(workloads, "utf8"), /Maintained by the platform/, "comments survive");
  assert.deepEqual(ownershipOf(model(), "lambda:platform"), { managedBy: "developer", basis: "declared" });
  assert.doesNotThrow(() => assertOwnershipAllows(fixture, state(), [memory("/platform")]), "a developer-owned declaration may change");

  const hand = await edits.planBatch([{ kind: "ownership", entity: "lambda:mine", managedBy: "framework" }], revision());
  assert.equal((await edits.applyBatch(hand.planId)).status, "applied");
  assert.equal(ownershipOf(model(), "route:http:/mine").managedBy, "framework");
  await assert.rejects(edits.planBatch([{ kind: "field", intent: { target: "lambda:mine", field: "lambda.memorySize", value: 512 } }], revision()), /lambda:mine: the AWS Studio platform maintains it/);
});

test("a group transition writes each entry, and entities without their own declaration cannot transition", async () => {
  const plan = await edits.planBatch([{ kind: "ownership", entity: "resource:providers", managedBy: "developer" }], revision());
  assert.equal((await edits.applyBatch(plan.planId)).status, "applied");
  const text = readFileSync(parameters, "utf8");
  assert.match(text, /input\.fromEnv\("FIRST", \{ tags: \{ area: "auth" \}, managedBy: "developer" \}\)/, "tags remain");
  assert.match(text, /input\.secret\("SECOND", \{ managedBy: "developer" \}\)/);
  assert.match(text, /input\.fromEnv\("FIXED", \{ managedBy: "framework" \}\)/, "other declarations are untouched");
  assert.equal(ownershipOf(model(), "resource:providers").managedBy, "developer");
  await assert.rejects(edits.planBatch([{ kind: "ownership", entity: "gateway:http", managedBy: "developer" }], revision()), /no declaration that can name an owner/);
  await assert.rejects(edits.planBatch([{ kind: "ownership", entity: "route:http:/mine", managedBy: "framework" }], revision()), /follows lambda:mine/);
  // A conflicting computed owner can be recorded only in source.
  await assert.rejects(edits.planBatch([{ kind: "ownership", entity: "lambda:split", managedBy: "developer" }], revision()), /computed here/);
});

test("every Studio source write passes the ownership guard, and recovery restores bypass it", () => {
  const restore = installSourceWriteGuard((guardRoot, file, before, after) => assertOwnershipAllows(guardRoot, state(), [{ file, before, after }]));
  try {
    const change = memory("/platform");
    assert.throws(() => writeSourceChange(fixture, workloads, change.before, change.after), /platform maintains it/);
    assert.equal(readFileSync(workloads, "utf8"), originalWorkloads);
    const mine = memory("/mine");
    writeSourceChange(fixture, workloads, mine.before, mine.after);
    writeSourceChange(fixture, workloads, mine.after, mine.before, { restoring: true });
    assert.equal(readFileSync(workloads, "utf8"), originalWorkloads);
  } finally { restore(); }
});

test("Coding-task proposals get the same ownership check, from proposals rebuilt and verified by hash", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const proposal = (change: { before: string; after: string }) => ({ changes: [{ path: path.relative(fixture, workloads), kind: "modify" as const, beforeHash: sha(change.before), afterHash: sha(change.after), beforeMode: 0o644, afterMode: 0o644, binary: false, diff: sourceDiff("x", change.before, change.after).unified }] });
  const refused = reviewProposalOwnership(fixture, state(), proposal(memory("/platform")));
  assert.match(refused.refusal ?? "", /lambda:platform: the AWS Studio platform maintains it/);
  assert.deepEqual(reviewProposalOwnership(fixture, state(), proposal(memory("/mine"))), { checked: true, transitions: [] });
  const claim = reviewProposalOwnership(fixture, state(), proposal(routeChange("/mine", line => line.replace("memorySize: 256", 'memorySize: 256, managedBy: "framework"'))));
  assert.equal(claim.refusal, undefined);
  assert.deepEqual(claim.transitions.map(item => [item.entity, item.to]), [["lambda:mine", "framework"]]);
  // A diff that does not reproduce the proposal's bytes cannot be checked, so a relevant file is refused.
  const forged = { changes: [{ ...proposal(memory("/mine")).changes[0]!, afterHash: sha("something else") }] };
  assert.match(reviewProposalOwnership(fixture, state(), forged).refusal ?? "", /could not rebuild the proposed/);
  assert.match(reviewProposalOwnership(fixture, undefined, proposal(memory("/mine"))).refusal ?? "", /no evaluated graph/);
});

test("proposed files are rebuilt exactly from their unified diffs", () => {
  const cases: [string, string][] = [["a\nb\nc\n", "a\nB\nc\n"], ["", "new\n"], ["one\ntwo", "one\ntwo\n"], ["x\n", ""], ["1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "0\n1\n2\n3\n4\n5\n6\n7\n8\nnine\n10\n11\n"]];
  for (const [before, after] of cases) assert.ok(applySourceDiff(before, sourceDiff("f", before, after).unified)?.includes(after), JSON.stringify([before, after]));
  assert.equal(applySourceDiff("other\n", sourceDiff("f", "a\n", "b\n").unified), undefined, "a diff for different content is rejected");
});

test("declaration signatures ignore metadata, comments and formatting, and nothing else", () => {
  const signature = (text: string) => { const source = parse("x.ts", `const x = ${text};`); return declarationSignature(source, 10, source.text.length - 1); };
  const base = signature('input.fromEnv("X", { tags: { a: "b" }, managedBy: "framework" }).default("1")');
  assert.equal(signature('input.fromEnv("X") /* note */ .default("1")'), base);
  assert.equal(signature('input.fromEnv("X", {},).default("1")'), base);
  assert.equal(signature('input.fromEnv(\n  "X",\n  { managedBy: "developer" },\n).default("1")'), base);
  assert.notEqual(signature('input.fromEnv("Y").default("1")'), base);
  assert.notEqual(signature('input.fromEnv("X").default("2")'), base);
  assert.notEqual(signature('input.fromEnv("X", { bindingPath: ["x"] }).default("1")'), base);
  const owner = (text: string) => { const source = parse("x.ts", `const x = ${text};`); return declaredOwner(source, 10, source.text.length - 1); };
  assert.equal(owner('input.fromEnv("X")'), undefined);
  assert.equal(owner('input.fromEnv("X", { managedBy: "framework" })'), "framework");
  assert.equal(owner('input.fromEnv("X", { managedBy: OWNER })'), "unresolved", "a computed owner is not readable evidence");
});

test("stack source is refused when its stack is platform maintained or unresolved, never by class name", () => {
  const fake = {
    snapshot: { models: {
      dev: { ownership: { "resource:auth": { managedBy: "framework", basis: "declared" }, "resource:mine": { managedBy: "developer", basis: "default" }, "resource:cognitoNamed": { managedBy: "developer", basis: "default" }, "framework-stack:ExportOnlyStack": { managedBy: "unresolved", basis: "undeclared" } }, resources: [] },
      prod: { ownership: { "framework-stack:FrontendWebsiteS3Stack": { managedBy: "framework", basis: "catalog" }, "resource:extra": { managedBy: "developer", basis: "default" } }, resources: [] },
    } },
    built: {
      catalog: new Map([
        ["auth", { stack: { className: "AuthStack", location: { file: "cdk-app/lib/app/auth-stack.ts" }, members: [] } }],
        ["mine", { stack: { className: "MineStack", location: { file: "cdk-app/lib/app/mine-stack.ts" }, members: [] } }],
        // A developer stack named like a framework stack is still the developer's.
        ["cognitoNamed", { stack: { className: "HttpApiGatewayStack", location: { file: "cdk-app/lib/app/http-api-gateway-stack.ts" }, members: [] } }],
        ["extra", { stack: { className: "ProjectStack", location: { file: "cdk-app/lib/app/frontend-website-s3-stack.ts" }, members: [] } }],
      ]),
      exportStacks: [
        { className: "ExportOnlyStack", location: { file: "node_modules/aws-studio/cdk/export-only-stack.ts" } },
        { className: "FrontendWebsiteS3Stack", location: { file: "cdk-app/lib/app/frontend-website-s3-stack.ts" } },
      ],
    },
  } as unknown as StudioState;
  assert.throws(() => assertStackSourceWritable(fake, "cdk-app/lib/app/auth-stack.ts"), /resource:auth, which the AWS Studio platform maintains/);
  assert.throws(() => assertStackSourceWritable(fake, "node_modules/aws-studio/cdk/export-only-stack.ts"), /could not verify the owner of framework-stack:ExportOnlyStack/);
  assert.doesNotThrow(() => assertStackSourceWritable(fake, "cdk-app/lib/app/mine-stack.ts"));
  assert.doesNotThrow(() => assertStackSourceWritable(fake, "cdk-app/lib/app/http-api-gateway-stack.ts"));
  assert.throws(() => assertStackSourceWritable(fake, "cdk-app/lib/app/frontend-website-s3-stack.ts"), /framework-stack:FrontendWebsiteS3Stack/, "a project class in the same file cannot release the managed implementation");
});

test("Studio refuses approval before the agent host is asked, and settled proposals keep their retry path", async () => {
  const { default: express } = await import("express");
  const { agentTaskRouter } = await import("../server/agent-runtime/router");
  type Client = Parameters<typeof agentTaskRouter>[0];
  const calls: string[] = [];
  let status = "awaiting_approval";
  const client = { get: async () => ({ status }), proposal: async () => ({ digest: "d", changes: [] }), action: async (_id: string, action: string) => { calls.push(action); return { status }; } } as unknown as Client;
  let refusal: string | undefined = "lambda:platform: the AWS Studio platform maintains it";
  const app = express(); app.use(express.json()); app.use(agentTaskRouter(client, () => ({ checked: true, transitions: [], ...(refusal ? { refusal } : {}) })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const approve = (digest = "d") => fetch(`${url}/task/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ digest }) });
  try {
    const refused = await approve();
    assert.equal(refused.status, 422);
    assert.match((await refused.json() as { error: string }).error, /Studio did not approve this proposal: lambda:platform/);
    assert.equal((await approve("other")).status, 409, "only the reviewed digest is checked and approved");
    assert.deepEqual(calls, [], "the host never saw a refused approval");
    const shown = await (await fetch(`${url}/task/proposal`)).json() as { ownership?: { refusal?: string } };
    assert.match(shown.ownership?.refusal ?? "", /platform maintains it/, "the review shows the refusal before approval");
    refusal = undefined;
    assert.equal((await approve()).status, 200);
    status = "completed"; refusal = "would refuse";
    assert.equal((await approve()).status, 200, "an already-approved proposal's retry is not re-checked against changed source");
    assert.deepEqual(calls, ["approve", "approve"]);
  } finally { server.close(); }
});

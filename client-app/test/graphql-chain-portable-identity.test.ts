import assert from "./support/assert";
import { chmodSync, cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { CONTRACT_PROOF_POLICY_FILES, portableFileDigest, portableProofIdentity, portableProofPolicy } from "aws-studio/contract-chain/portable-identity";

const policy = { id: "fixture-contract-policy", digest: "1".repeat(64) };
const tools = ["typescript", "tsx", "esbuild", "@graphql-codegen/cli", "@graphql-codegen/client-preset", "@graphql-codegen/schema-ast", "graphql", "@pothos/core", "zod", "@prisma/orm-toolchain", "@prisma/orm-framework", "@prisma/orm-postgres", "@prisma/cli-engine", "vitest", "@tanstack/react-query"];
const put = (root: string, file: string, contents: string) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, contents); };
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-portable-proof-")), root = path.join(directory, "checkout"); mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  put(root, "package.json", JSON.stringify({ name: "portable-fixture", private: true }));
  const packages: Record<string, unknown> = { "": { name: "portable-fixture" } };
  for (const name of tools) {
    const relative = `node_modules/${name}`;
    put(root, `${relative}/package.json`, JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    // The inventory uses TypeScript's actual parser, without invoking application code.
    put(root, `${relative}/index.js`, name === "typescript" ? `module.exports = require(${JSON.stringify(createRequire(import.meta.url).resolve("typescript"))});\n` : "module.exports = {};\n");
    packages[relative] = { version: "1.0.0" };
  }
  put(root, "package-lock.json", JSON.stringify({ name: "portable-fixture", lockfileVersion: 3, packages }));
  for (const relative of ["packages/database", "client-app", "compute/http/graphql-api"]) put(root, `${relative}/package.json`, JSON.stringify({ name: relative, private: true }));
  put(root, "packages/database/prisma/contract.prisma", "// use prisma-8\nmodel Project {\n id String @id\n}\n");
  put(root, "packages/database/prisma.config.ts", 'import { target } from "./target";\nexport default target;\n');
  put(root, "packages/database/target.ts", "export const target = {};\n");
  put(root, "packages/database/src/projects.ts", "export const owner = true;\n");
  put(root, "compute/http/graphql-api/schema/project.ts", "export const name = true;\n");
  put(root, "client-app/src/api/projects/operations.ts", "export const cache = ['projects'];\n");
  put(root, "codegen.ts", "export default {};\n");
  put(root, "client-app/src/api/generated/gql.ts", "export const generated = true;\n");
  put(root, "packages/database/src/generated/contract.json", '{"storageHash":"fixture"}\n');
  put(root, "packages/database/src/generated/contract.d.ts", "export type Fixture = true;\n");
  return { root, directory };
}

test("portable evidence is independent of checkout paths, text line endings and filesystem modes", async t => {
  const f = fixture(t), other = path.join(f.directory, "AWS Studio é"); cpSync(f.root, other, { recursive: true });
  put(other, "client-app/src/api/projects/operations.ts", "export const cache = ['projects'];\r\n");
  chmodSync(path.join(other, "packages/database/src/projects.ts"), 0o600);
  const [first, second] = await Promise.all([portableProofIdentity(f.root, { policy }), portableProofIdentity(other, { policy })]);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first).includes(f.directory), false);
});

test("compute implementation stays API-owned even when imported by codegen", async t => {
  const f = fixture(t), implementation = "compute/http/graphql-api/schema/project.ts";
  const helper = "scripts/codegen-options.ts", repository = "packages/database/src/projects.ts";
  put(f.root, implementation, 'export { owner as name } from "../../../../packages/database/src/projects";\n');
  put(f.root, helper, "export const options = {};\n");
  put(f.root, "codegen.ts", 'import { name } from "./compute/http/graphql-api/schema/project";\nimport { options } from "./scripts/codegen-options";\nexport default { schema: name, ...options };\n');
  const first = await portableProofIdentity(f.root, { policy });
  assert.ok(Object.hasOwn(first.files.api, implementation));
  assert.equal(Object.hasOwn(first.files.client, implementation), false);
  assert.equal(Object.hasOwn(first.files.codegen, implementation), false);
  assert.equal(Object.hasOwn(first.files.codegen, repository), false);
  assert.equal(Object.hasOwn(first.files.codegen, "compute/http/graphql-api/package.json"), false);
  assert.ok(Object.hasOwn(first.files.codegen, helper));
  put(f.root, implementation, "export const name = 'new resolver behavior';\n");
  const second = await portableProofIdentity(f.root, { policy });
  assert.notEqual(first.inputs.api, second.inputs.api);
  assert.equal(first.inputs.database, second.inputs.database);
  assert.equal(first.inputs.codegen, second.inputs.codegen);
  assert.equal(first.inputs.client, second.inputs.client);
  assert.deepEqual(first.outputs, second.outputs);
  put(f.root, helper, "export const options = { overwrite: true };\n");
  const configured = await portableProofIdentity(f.root, { policy });
  assert.notEqual(configured.inputs.codegen, second.inputs.codegen);
  assert.deepEqual(configured.inputs, { ...second.inputs, codegen: configured.inputs.codegen });
});

test("editing a contract input or generated output changes only its own source identity", async t => {
  const f = fixture(t);
  let previous = await portableProofIdentity(f.root, { policy });
  assert.deepEqual(Object.keys(previous.files.database), ["packages/database/prisma/contract.prisma"]);
  for (const [stage, file] of [
    ["database", "packages/database/prisma/contract.prisma"],
    ["api", "compute/http/graphql-api/index.ts"],
    ["codegen", "codegen.ts"],
    ["client", "client-app/src/api/projects/operations.ts"],
  ] as const) {
    put(f.root, file, `// changed ${stage} source\n`);
    const current = await portableProofIdentity(f.root, { policy });
    assert.notEqual(current.inputs[stage], previous.inputs[stage], file);
    assert.deepEqual(current.inputs, { ...previous.inputs, [stage]: current.inputs[stage] }, file);
    assert.deepEqual(current.outputs, previous.outputs, file);
    previous = current;
  }
  const output = "client-app/src/api/generated/gql.ts";
  put(f.root, output, "export const generated = false;\n");
  const current = await portableProofIdentity(f.root, { policy });
  assert.notEqual(current.outputs.generated, previous.outputs.generated);
  assert.equal(current.outputs.database, previous.outputs.database);
  assert.deepEqual(current.inputs, previous.inputs);
});

test("unrelated Lambda and configuration changes affect checkout identity but preserve all contract inputs and outputs", async t => {
  const f = fixture(t), first = await portableProofIdentity(f.root, { policy });
  const lambda = "compute/http/graphql-api-extra";
  put(f.root, `${lambda}/index.ts`, "export const handler = () => 'new Lambda';\n");
  put(f.root, `${lambda}/package.json`, '{"name":"new-lambda","private":true}\n');
  put(f.root, "framework-config/workloads/http.ts", "export const routes = ['new-lambda'];\n");
  const added = await portableProofIdentity(f.root, { policy });
  put(f.root, `${lambda}/index.ts`, "export const handler = () => 'edited Lambda';\n");
  put(f.root, "framework-config/inputs/index.ts", "export const timeout = 30;\n");
  put(f.root, "packages/database/target.ts", "export const target = { mappings: true };\n");
  put(f.root, "packages/database/src/projects.ts", "export const owner = false;\n");
  put(f.root, "client-app/src/routes/projects.tsx", "export const page = 'project list';\n");
  const edited = await portableProofIdentity(f.root, { policy });
  rmSync(path.join(f.root, lambda), { recursive: true });
  const removed = await portableProofIdentity(f.root, { policy });
  assert.equal(new Set([first, added, edited, removed].map(identity => identity.sourceRevision)).size, 4);
  for (const current of [added, edited, removed]) {
    assert.deepEqual(current.files, first.files);
    assert.deepEqual(current.inputs, first.inputs);
    assert.deepEqual(current.outputs, first.outputs);
    assert.deepEqual(current.toolchain, first.toolchain);
  }
});

test("ordinary Prisma documentation preserves portable proof while an access rule changes its database input", async t => {
  const f = fixture(t), first = await portableProofIdentity(f.root, { policy });
  const file = "packages/database/prisma/contract.prisma";
  const prose = "// use prisma-8\n/// Project details\nmodel Project {\n id String @id // Primary key\n}\n";
  put(f.root, file, prose);
  assert.deepEqual(await portableProofIdentity(f.root, { policy }), first);
  put(f.root, file, prose.replace("model Project", "/// @access(read)\nmodel Project"));
  const current = await portableProofIdentity(f.root, { policy });
  assert.notEqual(current.inputs.database, first.inputs.database);
  assert.deepEqual(current.inputs, { ...first.inputs, database: current.inputs.database });
});

test("review writes, documentation and pure appearance changes cannot invalidate implementation review bindings", async t => {
  const f = fixture(t), first = await portableProofIdentity(f.root, { policy });
  put(f.root, "graphql-chain.review.json", '{"version":3}\n');
  const review = await portableProofIdentity(f.root, { policy }); assert.deepEqual(first, review);
  put(f.root, "docs/guide.md", "Developer documentation\n");
  put(f.root, "client-app/src/styles.css", "body { color: red; }\n");
  const documentation = await portableProofIdentity(f.root, { policy });
  assert.notEqual(first.sourceRevision, documentation.sourceRevision);
  assert.deepEqual(first.inputs, documentation.inputs); assert.deepEqual(first.outputs, documentation.outputs);
});

test("installed versions must match the committed lockfile and policy edits change semantic policy", async t => {
  const f = fixture(t);
  const policyRoot = path.join(f.root, "node_modules/aws-studio");
  for (const name of CONTRACT_PROOF_POLICY_FILES) put(policyRoot, name, "// fixed validator source\n");
  const before = portableProofPolicy(policyRoot);
  put(policyRoot, CONTRACT_PROOF_POLICY_FILES[0], "// updated validator policy\n");
  assert.notEqual(portableProofPolicy(policyRoot).digest, before.digest);
  const manifest = JSON.parse(readFileSync(path.join(f.root, "node_modules/graphql/package.json"), "utf8"));
  put(f.root, "node_modules/graphql/package.json", JSON.stringify({ ...manifest, version: "2.0.0" }));
  await assert.rejects(portableProofIdentity(f.root, { policy }), /does not match.*lockfile/);
});

test("linked public and generated evidence never supplies a portable proof", async t => {
  const f = fixture(t);
  rmSync(path.join(f.root, "packages/database/src/generated/contract.json"));
  linkSync(path.join(f.root, "packages/database/target.ts"), path.join(f.root, "packages/database/src/generated/contract.json"));
  await assert.rejects(portableProofIdentity(f.root, { policy }), /linked|regular/);
  assert.notEqual(portableFileDigest("image.bin", Buffer.from("x\r\ny")), portableFileDigest("image.bin", Buffer.from("x\ny")));
});

test("unsupported Node cannot establish evidence and the exact supported patch is content-bound", async t => {
  const f = fixture(t), version = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  try {
    Object.defineProperty(process.versions, "node", { ...version, value: "26.0.0" });
    await assert.rejects(portableProofIdentity(f.root, { policy }), /requires supported Node 24/);
    Object.defineProperty(process.versions, "node", { ...version, value: "24.22.1" });
    await assert.rejects(portableProofIdentity(f.root, { policy }), /requires supported Node 24/);
    Object.defineProperty(process.versions, "node", { ...version, value: "24.22.2" });
    const first = await portableProofIdentity(f.root, { policy });
    Object.defineProperty(process.versions, "node", { ...version, value: "24.22.3" });
    const second = await portableProofIdentity(f.root, { policy });
    assert.equal(first.toolchain.node, "24.22.2"); assert.equal(second.toolchain.node, "24.22.3");
    assert.deepEqual(first.inputs, second.inputs, "patch differences belong to toolchain identity, not source identity");
  } finally { Object.defineProperty(process.versions, "node", version); }
});

test("same-version common dependency, nested source and shadow-file edits change portable toolchain evidence", async t => {
  const f = fixture(t), lock = JSON.parse(readFileSync(path.join(f.root, "package-lock.json"), "utf8"));
  const nested = "node_modules/graphql/node_modules/transitive";
  put(f.root, `${nested}/package.json`, JSON.stringify({ name: "transitive", version: "1.0.0" }));
  put(f.root, `${nested}/index.js`, "module.exports = 'original';\n");
  lock.packages[nested] = { version: "1.0.0" }; put(f.root, "package-lock.json", JSON.stringify(lock));
  const first = await portableProofIdentity(f.root, { policy });
  put(f.root, "node_modules/graphql/index.js", "module.exports = { changedResolverBehavior: true };\n");
  const modified = await portableProofIdentity(f.root, { policy });
  assert.notEqual(first.toolchain.dependencyDigest, modified.toolchain.dependencyDigest);
  assert.deepEqual(first.toolchain.packages, modified.toolchain.packages);
  assert.equal(first.toolchain.lockfileDigest, modified.toolchain.lockfileDigest);
  put(f.root, `${nested}/index.js`, "module.exports = 'different transitive behavior';\n");
  const transitive = await portableProofIdentity(f.root, { policy });
  assert.notEqual(modified.toolchain.dependencyDigest, transitive.toolchain.dependencyDigest);
  put(f.root, "node_modules/shadow.js", "module.exports = 'new package-resolution candidate';\n");
  const shadow = await portableProofIdentity(f.root, { policy });
  assert.notEqual(transitive.toolchain.dependencyDigest, shadow.toolchain.dependencyDigest);
  assert.deepEqual(first.inputs, shadow.inputs, "dependency changes are distinct from authored source identity");
});

test("platform packages, native installer outputs and shims retain portable parity while common WASM stays byte-bound", async t => {
  const f = fixture(t), other = path.join(f.directory, "Linux checkout"), lock = JSON.parse(readFileSync(path.join(f.root, "package-lock.json"), "utf8"));
  for (const name of ["darwin-native", "linux-native"]) lock.packages[`node_modules/${name}`] = { version: "1.0.0", os: [name.startsWith("darwin") ? "darwin" : "linux"], cpu: ["arm64"] };
  put(f.root, "package-lock.json", JSON.stringify(lock)); cpSync(f.root, other, { recursive: true });
  for (const [root, platform] of [[f.root, "darwin-native"], [other, "linux-native"]]) {
    put(root!, `node_modules/${platform}/package.json`, JSON.stringify({ name: platform, version: "1.0.0" }));
    put(root!, `node_modules/${platform}/index.js`, `module.exports=${JSON.stringify(platform)};\n`);
    put(root!, "node_modules/esbuild/bin/esbuild", platform!);
    put(root!, "node_modules/.bin/esbuild", platform!);
    put(root!, "node_modules/graphql/engine.node", platform!);
    put(root!, "node_modules/.cache/runner/cache.js", platform!);
  }
  const [first, second] = await Promise.all([portableProofIdentity(f.root, { policy }), portableProofIdentity(other, { policy })]);
  assert.equal(first.toolchain.dependencyDigest, second.toolchain.dependencyDigest);
  mkdirSync(path.join(other, "node_modules/graphql"), { recursive: true });
  writeFileSync(path.join(other, "node_modules/graphql/engine.wasm"), Buffer.from([0, 97, 115, 109, 1]));
  assert.notEqual((await portableProofIdentity(other, { policy })).toolchain.dependencyDigest, second.toolchain.dependencyDigest);
});

test("unlocked package overrides and changed workspace resolutions cannot establish dependency evidence", async t => {
  const f = fixture(t);
  put(f.root, "node_modules/untracked/package.json", '{"name":"untracked","version":"1.0.0"}');
  await assert.rejects(portableProofIdentity(f.root, { policy }), /overrides.*dependency resolution/);
  rmSync(path.join(f.root, "node_modules/untracked"), { recursive: true });
  put(f.root, "packages/shared/package.json", '{"name":"@fixture/shared","version":"1.0.0"}');
  put(f.root, "packages/override/package.json", '{"name":"@fixture/shared","version":"1.0.0"}');
  const lock = JSON.parse(readFileSync(path.join(f.root, "package-lock.json"), "utf8"));
  lock.packages["node_modules/@fixture/shared"] = { resolved: "packages/shared", link: true }; put(f.root, "package-lock.json", JSON.stringify(lock));
  mkdirSync(path.join(f.root, "node_modules/@fixture"), { recursive: true });
  const link = path.join(f.root, "node_modules/@fixture/shared");
  symlinkSync(path.relative(path.dirname(link), path.join(f.root, "packages/shared")), link, process.platform === "win32" ? "junction" : "dir");
  await portableProofIdentity(f.root, { policy });
  rmSync(link); symlinkSync(path.relative(path.dirname(link), path.join(f.root, "packages/override")), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(portableProofIdentity(f.root, { policy }), /workspace resolution differs/);
  rmSync(link); symlinkSync(path.relative(path.dirname(link), path.join(f.root, "packages/shared")), link, process.platform === "win32" ? "junction" : "dir");
  put(f.root, "docs/linked-helper/index.js", "module.exports = 'not an installed dependency';\n");
  const sourceLink = path.join(f.root, "node_modules/graphql/linked-helper");
  symlinkSync(path.relative(path.dirname(sourceLink), path.join(f.root, "docs/linked-helper")), sourceLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(portableProofIdentity(f.root, { policy }), /Non-workspace dependency source links/);
});

test("streamed dependency text preserves UTF-8 and CRLF normalization across buffer boundaries", async t => {
  const f = fixture(t), other = path.join(f.directory, "Normalized dependency checkout");
  const prefix = "a".repeat(65_535), source = `${prefix}\r\né\r\n${"b".repeat(70_000)}\r`;
  put(f.root, "node_modules/graphql/boundary.js", source); cpSync(f.root, other, { recursive: true });
  put(other, "node_modules/graphql/boundary.js", source.replaceAll("\r\n", "\n"));
  const [first, second] = await Promise.all([portableProofIdentity(f.root, { policy }), portableProofIdentity(other, { policy })]);
  assert.equal(first.toolchain.dependencyDigest, second.toolchain.dependencyDigest);
  writeFileSync(path.join(other, "node_modules/graphql/boundary.js"), Buffer.from([0xff, 0x2f, 0x2f, 0x61]));
  const invalidUTF8 = await portableProofIdentity(other, { policy });
  writeFileSync(path.join(other, "node_modules/graphql/boundary.js"), Buffer.from([0xff, 0x2f, 0x2f, 0x62]));
  assert.notEqual((await portableProofIdentity(other, { policy })).toolchain.dependencyDigest, invalidUTF8.toolchain.dependencyDigest, "code bytes remain bound even when decoding is invalid");
});

test("hoisted helpers exclusive to platform branches are normalized while shared optional JavaScript stays bound", async t => {
  const f = fixture(t), other = path.join(f.directory, "Other platform"), lock = JSON.parse(readFileSync(path.join(f.root, "package-lock.json"), "utf8"));
  lock.packages[""].optionalDependencies = { shared: "1.0.0", "platform-native": "1.0.0" };
  lock.packages["node_modules/platform-native"] = { version: "1.0.0", os: ["freebsd"], dependencies: { "hoisted-helper": "1.0.0", shared: "1.0.0" } };
  lock.packages["node_modules/hoisted-helper"] = { version: "1.0.0", optional: true, dependencies: { "helper-cycle": "1.0.0" } };
  lock.packages["node_modules/helper-cycle"] = { version: "1.0.0", optional: true, dependencies: { "hoisted-helper": "1.0.0" } };
  lock.packages["node_modules/shared"] = { version: "1.0.0", optional: true };
  put(f.root, "package-lock.json", JSON.stringify(lock));
  put(f.root, "node_modules/shared/package.json", '{"name":"shared","version":"1.0.0"}');
  put(f.root, "node_modules/shared/index.js", "module.exports = 'shared common behavior';\n");
  cpSync(f.root, other, { recursive: true });
  for (const name of ["platform-native", "hoisted-helper", "helper-cycle"]) {
    put(f.root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0" }));
    put(f.root, `node_modules/${name}/index.js`, "module.exports = 'platform-only helper';\n");
  }
  const [first, second] = await Promise.all([portableProofIdentity(f.root, { policy }), portableProofIdentity(other, { policy })]);
  assert.equal(first.toolchain.dependencyDigest, second.toolchain.dependencyDigest);
  put(other, "node_modules/shared/index.js", "module.exports = 'changed shared optional behavior';\n");
  assert.notEqual((await portableProofIdentity(other, { policy })).toolchain.dependencyDigest, second.toolchain.dependencyDigest);
  rmSync(path.join(other, "node_modules/shared"), { recursive: true });
  await assert.rejects(portableProofIdentity(other, { policy }), /common dependency.*missing/);
});

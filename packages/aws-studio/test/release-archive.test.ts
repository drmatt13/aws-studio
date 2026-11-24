import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTRACT_PROOF_POLICY_FILES, contractPolicySnapshot } from "../scripts/contract-chain/portable-identity";

test("the offline release archive contains the public runtime, verifier and application guides", async t => {
  const workspace = path.resolve(__dirname, ".."), checkout = path.resolve(workspace, "../..");
  const destination = mkdtempSync(path.join(os.tmpdir(), "aws studio release "));
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const { findProjectToolchain } = await import("../cli/project-node.mjs");
  const tools = findProjectToolchain(checkout);
  const env = { ...process.env, npm_config_offline: "true" };
  const output = execFileSync(tools.node, [tools.npm, "run", "pack", "--", destination], { cwd: checkout, env, encoding: "utf8" });
  const source = JSON.parse(readFileSync(path.join(workspace, "package.json"), "utf8"));
  const { version } = source;
  const archive = path.join(destination, `aws-studio-${version}.tgz`);
  const list = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
  assert.ok(list.every(entry => entry.startsWith("package/") && !entry.split("/").includes("..")));
  const contents = new Set(list.map(entry => entry.slice("package/".length)));
  const reported = JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
  assert.equal(reported.archive, archive);
  assert.equal(reported.files, contents.size);
  assert.match(reported.integrity, /^sha512-/);
  execFileSync("tar", ["-xzf", archive, "-C", destination]);
  const modules = path.join(destination, "node_modules");
  mkdirSync(modules);
  const installed = path.join(modules, "aws-studio");
  renameSync(path.join(destination, "package"), installed);
  const entry = (file: string) => readFileSync(path.join(installed, file), "utf8");
  const manifest = JSON.parse(entry("package.json"));
  assert.equal(manifest.version, version);
  assert.equal(manifest.name, "aws-studio");
  assert.deepEqual(manifest.engines, source.engines);
  assert.deepEqual(manifest.studioCompatibility, source.studioCompatibility);
  assert.deepEqual(Object.keys(manifest.bin), ["aws-studio"]);
  assert.ok(contents.has(manifest.bin["aws-studio"].replace(/^\.\//, "")));
  assert.equal(typeof manifest.dependencies["@types/cookie"], "string");
  assert.deepEqual(Object.keys(manifest.peerDependencies).sort(), ["@repo/framework-generated", "aws-cdk-lib", "constructs"]);
  for (const peer of Object.keys(manifest.peerDependencies)) assert.equal(manifest.dependencies[peer], undefined);
  for (const exported of Object.values<string>(manifest.exports)) {
    const target = exported.slice(2);
    if (target.includes("*")) {
      const [start, end] = target.split("*");
      assert.ok([...contents].some(name => name.startsWith(start) && name.endsWith(end)), exported);
    } else assert.ok(contents.has(target), target);
  }
  assert.equal(JSON.parse(entry("database/package.json")).type, "module");
  for (const file of [...CONTRACT_PROOF_POLICY_FILES, "LICENSE", "dev/Dockerfile", "dev/compose.yml", "dev/pgadmin/servers.json",
    "cli/local-client.d.mts",
    ...["auth", "feature-build", "prod-deployment", "typed-contract-propagation"].map(name => `docs/playbooks/${name}.md`),
    ...["FRAMEWORK", "DEV-DEPLOYMENT", "PROD-DEPLOYMENT", "DATABASE", "DATA-FEATURES", "PRISMA-ACCESS", "AGENTCORE"].map(name => `docs/${name}.md`)])
    assert.ok(contents.has(file), file);
  assert.ok(entry("docs/AGENTCORE.md").includes("Studio creation guide (AWS Studio repository, `client-app/README.md`)"));
  assert.deepEqual(contractPolicySnapshot(installed), contractPolicySnapshot(workspace), "packed policy and exact verifier bytes");
  // Vite can leave external configuration imports to native Node without a TypeScript loader.
  execFileSync(tools.node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { localClientPort, localClientUrl, readLocalClientUrl } from "aws-studio/cli/local-client.mts";
    assert.equal(localClientPort(localClientUrl("https://localhost")), 443);
    assert.equal(readLocalClientUrl(process.cwd(), {}).origin, "http://localhost:3000");
  `], { cwd: destination, env: { ...env, NODE_OPTIONS: "" }, stdio: "pipe" });
  const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|\.git|\.cache|\.framework|\.secret-bindings\.json|node_modules|cdk\.out|cdk\.context\.json|framework\.config\.ts|framework-config|compute|framework-studio|client-app|cdk-app|prisma|test|tests|fixtures|generated|headless\.cjs)(?:\/|$)|\.(?:pem|key|sqlite|tgz)$/;
  assert.deepEqual([...contents].filter(name => forbidden.test(name)), []);
  for (const file of [...contents].filter(name => name.startsWith("docs/") && name.endsWith(".md"))) {
    for (const link of entry(file).matchAll(/\[([^\]\n]+)\]\(([^\s)]+)\)/g)) {
      const href = link[2]!;
      if (/^(?:#|[a-z][\w+.-]*:|\/)/i.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href.split("#")[0]!));
      // Paths that leave the installed package should point to the app's tracked layout.
      if (target.startsWith("../../")) {
        assert.match(target.slice("../../".length), /^(?:cdk-app\/|compute\/|framework-config\/|packages\/(?:database|models|api-contract|framework-generated)\/|\.github\/|QUICKSTART\.md$)/, `${file}: ${href}`);
      } else {
        assert.ok(contents.has(target) || [...contents].some(name => name.startsWith(target + "/")), `${file}: ${href}`);
      }
    }
  }
});

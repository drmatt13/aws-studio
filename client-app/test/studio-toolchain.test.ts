import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findOrInstallToolchain } from "../../scripts/studio-toolchain.mjs";
import assert from "./support/assert";

test("a runtime download with the wrong digest is discarded before activation", async t => {
  if (process.versions.node.startsWith("26.") || !["darwin", "linux", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
    return t.skip("requires a host that can provision the Node 26 archive");
  }
  const root = mkdtempSync(path.join(tmpdir(), "studio-toolchain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, ".nvmrc"), "26.13.0\n");
  writeFileSync(path.join(root, "package.json"), '{"packageManager":"npm@11.20.0"}');
  const env = { PATH: "", HOME: root, XDG_DATA_HOME: root, LOCALAPPDATA: root };
  const request = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /^https:\/\/nodejs\.org\/dist\/v26\.13\.0\/node-v26\.13\.0-/);
    return new Response("corrupt archive");
  });

  await assert.rejects(findOrInstallToolchain(root, { ...env, npm_config_offline: "true" }), /unavailable locally/);
  assert.equal(request.mock.callCount(), 0);
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(findOrInstallToolchain(root, env), /SHA-256 checksum/);
    assert.deepEqual(readdirSync(path.join(root, "aws-studio", "node")), []);
  }
  assert.equal(request.mock.callCount(), 2);
});

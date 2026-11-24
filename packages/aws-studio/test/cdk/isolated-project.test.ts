import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDeploymentLock } from "../../cli/deployment-workspace";
import { copyIsolatedProject } from "./support/isolated-project";

test("copied command fixtures preserve source bytes and isolate retained locks, private inputs and workspace dependencies", () => {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "deployment-project-test-"));
  const source = path.join(directory, "source"), copy = path.join(directory, "copy");
  const write = (name: string, value: string) => { const file = path.join(source, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, value); };
  try {
    write("scripts/deploy.ts", "// current uncommitted source bytes\n");
    write("packages/aws-studio/package.json", '{"name":"aws-studio"}\n');
    write("packages/aws-studio/current.ts", "export const current = true;\n");
    write(".cache/deploy/test-prod.lock", '{"pid":1,"token":"retained"}\n');
    write(".framework/local/resources.json", '{"retained":true}\n');
    write("cdk-app/.env.prod", "PRIVATE_INPUT=fixture-only\n");
    write("cdk-app/.env.prod.template", "PUBLIC_TEMPLATE=\n");
    write("node_modules/installed/package.json", '{"name":"installed"}\n');
    mkdirSync(path.join(source, "node_modules"), { recursive: true });
    symlinkSync(path.join(source, "packages/aws-studio"), path.join(source, "node_modules/aws-studio"), process.platform === "win32" ? "junction" : "dir");

    copyIsolatedProject(source, copy);

    assert.equal(readFileSync(path.join(copy, "scripts/deploy.ts"), "utf8"), readFileSync(path.join(source, "scripts/deploy.ts"), "utf8"));
    for (const name of [".cache", ".framework", "cdk-app/.env.prod"]) assert.equal(existsSync(path.join(copy, name)), false, `${name} stays outside the command fixture`);
    assert.equal(readFileSync(path.join(copy, "cdk-app/.env.prod.template"), "utf8"), "PUBLIC_TEMPLATE=\n");
    assert.equal(realpathSync(path.join(copy, "node_modules/aws-studio")), realpathSync(path.join(copy, "packages/aws-studio")));
    assert.equal(realpathSync(path.join(copy, "node_modules/installed")), realpathSync(path.join(source, "node_modules/installed")));

    const release = acquireDeploymentLock(path.join(copy, ".cache/deploy"), "test-prod");
    try { assert.equal(existsSync(path.join(copy, ".cache/deploy/test-prod.lock")), true); }
    finally { release(); }
    assert.equal(readFileSync(path.join(source, ".cache/deploy/test-prod.lock"), "utf8"), '{"pid":1,"token":"retained"}\n', "fixture acquisition/release cannot alter retained checkout evidence");
    assert.equal(existsSync(path.join(copy, ".cache/deploy/test-prod.lock")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

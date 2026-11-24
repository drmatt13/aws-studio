import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SnapshotBuilder } from "../server/snapshot";
import { projectRuntime, projectRuntimeEnvironment } from "../server/project-runtime";
import { assertProjectHello, projectHello, PROJECT_PROTOCOL } from "../server/evaluator/protocol";
import assert from "./support/assert";
import { createSnapshotFixture } from "./support/source-fixture";

test("Studio selects the project executable independently from its bootstrap override", () => {
  const fixture = createSnapshotFixture();
  try {
    const host = { ...process.env, AWS_STUDIO_NODE: path.join(fixture.root, "unavailable-host-override"), NODE_OPTIONS: "--trace-warnings" };
    const runtime = projectRuntime(fixture.root, host);
    assert.equal(runtime.version, readFileSync(path.join(fixture.root, ".nvmrc"), "utf8").trim());
    const child = projectRuntimeEnvironment(runtime, host);
    assert.equal(child.AWS_STUDIO_NODE, runtime.node);
    assert.equal(child.NODE_OPTIONS, undefined);
    assert.equal(child.npm_execpath, runtime.npm);
    assert.equal(child.npm_node_execpath, runtime.node);
    assert.throws(() => projectRuntime(fixture.root, { ...host, AWS_STUDIO_PROJECT_NODE: host.AWS_STUDIO_NODE }), /AWS_STUDIO_PROJECT_NODE.*supported Node/);
  } finally { fixture.dispose(); }
});

test("the evaluator rejects a different process protocol or runtime", () => {
  assert.throws(() => assertProjectHello({ ...projectHello(), protocol: PROJECT_PROTOCOL + 1 }, process.versions.node), /negotiate Studio project protocol/);
  assert.throws(() => assertProjectHello(projectHello(), "0.0.0"), /must run on selected Node/);
});

test("opening evaluates configuration and settings on project Node with protected files read-only", async () => {
  const fixture = createSnapshotFixture();
  const logs: string[] = [];
  const builder = new SnapshotBuilder(fixture.root, message => logs.push(message));
  try {
    const runtime = projectRuntime(fixture.root);
    const expected = readFileSync(path.join(fixture.root, ".nvmrc"), "utf8").trim();
    const inspect = (name: string) => `
      import { writeFileSync } from "node:fs";
      import { spawnSync } from "node:child_process";
      if (process.versions.node !== ${JSON.stringify(expected)}) throw new Error("Unexpected Node runtime");
      for (const file of ["package.json", "package-lock.json", "cdk-app/.env.dev", "new-file", "node_modules/aws-studio/package.json"]) {
        try { writeFileSync(file, "unexpected write"); throw new Error("Inspection allowed a write"); }
        catch (error) { if (error.code !== "ERR_ACCESS_DENIED") throw error; }
      }
      try { spawnSync(process.execPath, ["--version"]); throw new Error("Inspection allowed a child process"); }
      catch (error) { if (error.code !== "ERR_ACCESS_DENIED") throw error; }
      console.log(${JSON.stringify(name)} + " ran on " + process.versions.node);
    `;
    for (const [name, label] of [["framework.config.ts", "config"], ["cdk-app/framework-inputs.ts", "input settings"]] as const) {
      const file = path.join(fixture.root, name);
      writeFileSync(file, inspect(label) + "\n" + readFileSync(file, "utf8"));
    }
    const protectedFiles = ["framework.config.ts", "cdk-app/framework-inputs.ts", "package.json", "package-lock.json", "cdk-app/.env.dev", "cdk-app/.env.prod", "node_modules/aws-studio/package.json"];
    const before = protectedFiles.map(file => readFileSync(path.join(fixture.root, file)));
    const { snapshot } = await builder.refresh();
    for (const mode of ["dev", "prod"] as const) {
      assert.equal(snapshot.models[mode].status, "ok", JSON.stringify(snapshot.models[mode].diagnostics));
      assert.ok(logs.includes(`[${mode}] Project evaluator protocol ${PROJECT_PROTOCOL} running Node ${expected} (${runtime.node}).`));
      assert.ok(logs.includes(`[${mode}] config ran on ${expected}`));
      assert.ok(logs.includes(`[${mode}] input settings ran on ${expected}`));
    }
    assert.deepEqual(protectedFiles.map(file => readFileSync(path.join(fixture.root, file))), before);
    assert.equal(existsSync(path.join(fixture.root, "new-file")), false);
  } finally {
    await builder.dispose();
    fixture.dispose();
  }
});

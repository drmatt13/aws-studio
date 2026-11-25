import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { readSourceManifest } from "aws-studio/source/workspace";
import { copyIsolatedProject } from "../../packages/aws-studio/test/cdk/support/isolated-project";
import type { Snapshot } from "../shared/model";

/**
 * Proof that this checkout's Studio opens and evaluates a separate project directory.
 *
 * The project is a writable copy of the recorded starter with its own installed release,
 * changed so that each way Studio reads a project is observable:
 *   - its deployment inputs gain PROOF_SETTING (read in Studio's own process);
 *   - its database gets a project-specific ID (recognized through its framework role);
 *   - its app is renamed in cdk-app/cdk.json (read from the project root);
 *   - its framework installation is its own copy (the evaluator must use it).
 * STUDIO_UNDER_TEST points the test at another Studio checkout, such as one before this support.
 */

const checkout = path.resolve(__dirname, "../..");
const studio = path.resolve(process.env.STUDIO_UNDER_TEST ?? checkout);

function run(args: readonly string[], cwd: string, env = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const status = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: checkout, encoding: "utf8" });

test("Studio opens a separate project and reads that project, not its own checkout", { timeout: 10 * 60_000 }, async () => {
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "studio-external-project-")));
  const project = path.join(parent, "external app é");
  const before = status();
  try {
    copyIsolatedProject(testProjectRoot, project, { physicalRelease: true });
    const inputs = path.join(project, "framework-config/inputs/deployment.ts");
    const source = readFileSync(inputs, "utf8");
    assert.ok(source.includes("      localDevUrl: input"), "the copy's deployment inputs have the expected shape");
    writeFileSync(inputs, source.replace("      localDevUrl: input", '      proofSetting: input.fromEnv("PROOF_SETTING").default("external").note("Declared only in the external project."),\n      localDevUrl: input'));
    const cdkJson = path.join(project, "cdk-app/cdk.json");
    const cdk = JSON.parse(readFileSync(cdkJson, "utf8")) as { context: Record<string, unknown> };
    cdk.context["framework:app"] = "external-proof";
    writeFileSync(cdkJson, `${JSON.stringify(cdk, null, 2)}\n`);
    const database = path.join(project, "framework-config/databases/application.ts");
    const databaseSource = readFileSync(database, "utf8");
    assert.ok(databaseSource.includes('id: "application"'));
    writeFileSync(database, databaseSource.replace('id: "application"', 'id: "external"'));
    const projectSource = readSourceManifest(project).digest;

    // The direct entry point also works when the caller belongs to no package.
    const loader = pathToFileURL(createRequire(path.join(studio, "client-app/package.json")).resolve("tsx")).href;
    const server = ["--import", loader, path.join(studio, "client-app/server/index.ts")];
    const npm = process.env.npm_execpath;
    assert.ok(npm, "the workspace test runs through npm");
    const env = { ...process.env };
    delete env.AWS_STUDIO_NODE;
    delete env.AWS_STUDIO_PROJECT_NODE;
    delete env.STUDIO_PROJECT;
    const subdirectory = path.join(studio, "scripts");
    for (const [label, cwd, args] of [
      ["direct --project", parent, [...server, "--print", "--project", project]],
      ["discovered", project, [...server, "--print"]],
      ["npm 11 --project", studio, [npm, "run", "--silent", "studio", "--project", path.relative(studio, project), "--", "--print"]],
      ["npm positional path from a subdirectory", subdirectory, [npm, "run", "--silent", "studio", path.relative(subdirectory, project), "--", "--print"]],
    ] as const) {
      const result = await run(args, cwd, env);
      assert.equal(result.code, 0, `${label}: Studio exited ${result.code}:\n${result.stderr.slice(-3000)}`);
      const snapshot = JSON.parse(result.stdout) as Snapshot;
      assert.equal(snapshot.repositoryRoot, realpathSync(project), `${label}: the snapshot is the external project's`);
      for (const model of Object.values(snapshot.models)) {
        assert.equal(model.status, "ok", `${label}: ${model.mode} evaluates`);
        for (const [id, facts] of Object.entries(model.ownership ?? {})) {
          assert.ok(["developer", "framework"].includes(facts.managedBy), `${label}: ${id} needs an owner in ${model.mode}`);
        }
        for (const id of ["framework-stack:DevLambdaReplayStack", "framework-stack:FrontendWebsiteS3Stack",
          "gateway:http", "gateway:websocket", "database:external", "resource:rds.database",
          "framework:deployment.localDevUrl"]) {
          assert.equal(model.ownership?.[id]?.managedBy, "framework", `${label}: Studio recognizes ${id} in ${model.mode}`);
        }
        for (const id of ["framework:deployment.proofSetting", "resource:referenceExamples", "lambda:sign-in"]) {
          assert.equal(model.ownership?.[id]?.managedBy, "developer", `${label}: ${id} belongs to the project in ${model.mode}`);
        }
      }
      assert.equal(snapshot.application?.name, "external-proof", `${label}: the app identity is the project's`);
      assert.ok(result.stdout.includes("PROOF_SETTING"), `${label}: deployment inputs are the project's own, not this checkout's`);
      assert.ok(result.stderr.includes(`Evaluating with the project's framework at ${realpathSync(path.join(project, "node_modules/aws-studio"))}`), `${label}: the evaluator uses the project's framework:\n${result.stderr.slice(-2000)}`);
    }
    assert.equal(readSourceManifest(project).digest, projectSource, "opening projects applies Studio's catalog without rewriting app source or pins");
    assert.ok(existsSync(path.join(project, ".cache/framework-studio")), "Studio's per-project scratch state is written into the project");
    assert.equal(status(), before, "nothing in this checkout changed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

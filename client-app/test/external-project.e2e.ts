import { testProjectRoot } from "../../scripts/test-project";
import assert from "./support/assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { copyIsolatedProject } from "../../packages/aws-studio/test/cdk/support/isolated-project";

/**
 * Proof that this checkout's Studio opens and evaluates a separate project directory.
 *
 * The project is a writable copy of the recorded starter with its own installed release,
 * changed so that each way Studio reads a project is observable:
 *   - its deployment inputs gain PROOF_SETTING (read in Studio's own process);
 *   - its app is renamed in cdk-app/cdk.json (read from the project root);
 *   - its framework installation is its own copy (the evaluator must use it).
 * STUDIO_UNDER_TEST points the test at another Studio checkout, such as one before this support.
 */

const checkout = path.resolve(__dirname, "../..");
const studio = path.resolve(process.env.STUDIO_UNDER_TEST ?? checkout);

function run(file: string, args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // The loader comes from Studio's own installation: the working directory may belong to no project.
    const loader = pathToFileURL(createRequire(path.join(studio, "client-app/package.json")).resolve("tsx")).href;
    const child = spawn(process.execPath, ["--import", loader, file, ...args], { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
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
  const project = path.join(parent, "external-app");
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

    // Both ways a project is opened: named with --project from a directory that belongs to no
    // project, and discovered from inside it, as `npm run studio` in a checkout does.
    for (const [label, cwd, args] of [["--project", parent, ["--print", "--project", project]], ["discovered", project, ["--print"]]] as const) {
      const result = await run(path.join(studio, "client-app/server/index.ts"), args, cwd);
      assert.equal(result.code, 0, `${label}: Studio exited ${result.code}:\n${result.stderr.slice(-3000)}`);
      const snapshot = JSON.parse(result.stdout) as { repositoryRoot: string; application?: { name?: string }; models: Record<"dev" | "prod", { status: string }> };
      assert.equal(snapshot.repositoryRoot, realpathSync(project), `${label}: the snapshot is the external project's`);
      assert.equal(snapshot.models.dev.status, "ok", `${label}: development evaluates`);
      assert.equal(snapshot.models.prod.status, "ok", `${label}: production evaluates`);
      assert.equal(snapshot.application?.name, "external-proof", `${label}: the app identity is the project's`);
      assert.ok(result.stdout.includes("PROOF_SETTING"), `${label}: deployment inputs are the project's own, not this checkout's`);
      assert.ok(result.stderr.includes(`Evaluating with the project's framework at ${realpathSync(path.join(project, "node_modules/aws-studio"))}`), `${label}: the evaluator uses the project's framework:\n${result.stderr.slice(-2000)}`);
    }
    assert.ok(existsSync(path.join(project, ".cache/framework-studio")), "Studio's per-project scratch state is written into the project");
    assert.equal(status(), before, "nothing in this checkout changed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

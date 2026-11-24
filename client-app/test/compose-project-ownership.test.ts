import assert from "./support/assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertComposeContainerOwnership, assertComposeVolumeOwnership, composeProjectName, parseComposeOwnershipLabels } from "aws-studio/cli/compose-project-ownership.mjs";
import { LocalEnvironment } from "../server/deploy/local";
import { Tools } from "../server/deploy/process";
import { resolveProjectName } from "aws-studio/local/paths";

const checkout = path.resolve(__dirname, "../..");
const metadata = (root: string, project: string) => ({
  "com.docker.compose.project": project,
  "com.docker.compose.project.working_dir": root,
  "com.docker.compose.project.config_files": path.join(root, "docker-compose.yml"),
});

function nameApp(root: string, name: string) {
  mkdirSync(path.join(root, "cdk-app"), { recursive: true });
  writeFileSync(path.join(root, "cdk-app/cdk.json"), JSON.stringify({ context: { "framework:app": name } }));
}

test("named apps use the navbar name before export and ignore stale shell and generated names", () => {
  const f = fixture();
  try {
    nameApp(f.root, "sample-app");
    writeFileSync(path.join(f.exportDirectory, ".env"), "COMPOSE_PROJECT_NAME=old-export\n");
    assert.equal(composeProjectName(f.root, f.env, f.exportDirectory), "sample-app");
    assert.equal(resolveProjectName(f.root, f.env), "sample-app");
    assert.equal(f.local.configuredProject, "sample-app");
    const command = new Tools(checkout).docker(["compose", "config"], f.env, f.root);
    assert.equal(command.env.COMPOSE_PROJECT_NAME, "sample-app");
    nameApp(f.root, "renamed-app");
    assert.equal(f.local.configuredProject, "renamed-app", "no Studio restart or export required");
    nameApp(f.root, "Invalid Name");
    assert.throws(() => composeProjectName(f.root, f.env), /valid app name/);
    writeFileSync(path.join(f.root, "cdk-app/cdk.json"), "{");
    assert.throws(() => composeProjectName(f.root, f.env), /not valid JSON/);
  } finally { f.close(); }
});

test("Compose project controls honor exported settings, shell precedence and native directory naming", () => {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-project-name-"));
  try {
    writeFileSync(path.join(root, ".env"), "COMPOSE_PROJECT_NAME=developer-alice\nOTHER_CONTROL=not-read\n");
    assert.equal(composeProjectName(root, {}), "developer-alice");
    assert.equal(composeProjectName(root, { COMPOSE_PROJECT_NAME: "developer-bob" }), "developer-bob");
    assert.equal(composeProjectName(root, { COMPOSE_PROJECT_NAME: "" }), path.basename(root).toLowerCase());
    assert.equal(composeProjectName(root, { COMPOSE_DISABLE_ENV_FILE: "1" }), path.basename(root).toLowerCase());
    assert.equal(composeProjectName(path.join(root, "AWS Studio.test"), {}), "awsstudiotest");
    assert.throws(() => composeProjectName(root, { COMPOSE_PROJECT_NAME: "Developer Alice" }), /COMPOSE_PROJECT_NAME/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("container provenance accepts this checkout including comma paths and rejects another or unknown origin", () => {
  const root = path.join(realpathSync(os.tmpdir()), "studio,comma-path");
  const own = metadata(root, "project");
  assert.doesNotThrow(() => assertComposeContainerOwnership(root, "project", [own]));
  assert.doesNotThrow(() => assertComposeContainerOwnership(root, "project", [{ ...own, "com.docker.compose.project.config_files": `${own["com.docker.compose.project.config_files"]},${path.join(root, "docker-compose.override.yml")}` }]));
  assert.throws(() => assertComposeContainerOwnership(root, "project", [metadata(path.join(root, "other"), "project")]), /another checkout|ownership is unknown/);
  assert.throws(() => assertComposeContainerOwnership(root, "project", [{ ...own, "com.docker.compose.project.config_files": path.join(root, "other", "docker-compose.yml") }]), /another checkout|ownership is unknown/);
  assert.throws(() => assertComposeContainerOwnership(root, "project", [{ "com.docker.compose.project": "project" }]), /ownership is unknown/);
  assert.throws(() => parseComposeOwnershipLabels("private-provider-text", 1), /could not be verified/);
  assert.throws(() => parseComposeOwnershipLabels(JSON.stringify(own), 2), /could not be verified/);
  assert.throws(() => assertComposeVolumeOwnership("project", "postgres_data", { "com.docker.compose.project": "other", "com.docker.compose.volume": "postgres_data" }), /volume belongs to another project/);
  assert.doesNotThrow(() => assertComposeVolumeOwnership("project", "postgres_data", { "com.docker.compose.project": "project", "com.docker.compose.volume": "postgres_data" }));
});

function fixture() {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-owner-"));
  mkdirSync(path.join(root, "export"));
  const exportDirectory = path.join(root, "export");
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROJECT_NAME: "owner-fixture" };
  const calls: string[][] = [];
  let origin = root;
  let composePresent = true;
  let runnerPresent = false;
  const local: LocalEnvironment = new LocalEnvironment(root, new Tools(checkout, env), async spec => {
    calls.push([...spec.args]);
    if (spec.args[0] === "inspect") return { code: 0, stdout: JSON.stringify(metadata(origin, local.project)), stderr: "" };
    const runner = spec.args.some(arg => arg.includes("com.matts-aws-framework.project="));
    return { code: 0, stdout: (runner ? runnerPresent : composePresent) ? JSON.stringify({ ID: runner ? "runner-task" : "compose-api", Names: "api", State: "running", Status: "Up" }) : "", stderr: "" };
  }, env, exportDirectory, path.join(root, "state"));
  return { root, local, env, calls, exportDirectory,
    origin(value: string) { origin = value; }, compose(value: boolean) { composePresent = value; }, runner(value: boolean) { runnerPresent = value; },
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test("Studio refuses another checkout before returning any container IDs for stop", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.local.containerIds(), ["compose-api"]);
    f.origin(path.join(f.root, "other-clone"));
    await assert.rejects(() => f.local.services(), /another checkout/);
    await assert.rejects(() => f.local.containerIds(), /another checkout/);
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.readiness?.state, "blocked");
    assert.match(view.observationProblem!, /another checkout/);
    assert.ok(f.calls.every(args => ["ps", "inspect"].includes(args[0]!)), "ownership validation never changes containers or storage");
  } finally { f.close(); }
});

test("orphan runner work remains active but cannot be stopped without checkout provenance", async () => {
  const f = fixture();
  try {
    f.compose(false); f.runner(true);
    assert.deepEqual(await f.local.activeContainers(), [{ id: "runner-task", state: "running" }]);
    await assert.rejects(() => f.local.containerIds(), /Runner work is active without Compose checkout provenance/);
    f.compose(true);
    assert.deepEqual(await f.local.containerIds(), ["compose-api", "runner-task"]);
  } finally { f.close(); }
});

test("Studio recomputes the project after an export without restarting its host", () => {
  const f = fixture();
  try {
    delete f.env.COMPOSE_PROJECT_NAME;
    writeFileSync(path.join(f.exportDirectory, ".env"), "COMPOSE_PROJECT_NAME=before-export\n");
    assert.equal(f.local.project, "before-export");
    writeFileSync(path.join(f.exportDirectory, ".env"), "COMPOSE_PROJECT_NAME=after-export\n");
    assert.equal(f.local.project, "after-export");
  } finally { f.close(); }
});

test("a captured project remains observable and stoppable until explicit stop releases it", async () => {
  const f = fixture();
  try {
    nameApp(f.root, "owner-fixture");
    f.local.writeRunRecord({ deployment: "example-dev", profile: "developer", startedAt: "before" });
    assert.equal(f.local.runRecord()?.project, "owner-fixture");
    nameApp(f.root, "new-project");
    assert.equal(f.local.configuredProject, "new-project");
    assert.equal(f.local.project, "owner-fixture");
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.project, "owner-fixture");
    assert.equal(view.activeContainerCount, 1);
    assert.equal(view.readiness?.state, "blocked");
    assert.match(view.readiness?.message ?? "", /App name changed.*Stop local runtime/);
    assert.deepEqual(await f.local.containerIds(), ["compose-api"]);
    f.local.clearRunRecord();
    assert.equal(f.local.project, "new-project");
  } finally { f.close(); }
});

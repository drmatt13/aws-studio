import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectToolchain, projectToolchainEnv } from "../../packages/aws-studio/cli/project-node.mjs";
import { preparedTestProject, prepareTestProject } from "../../scripts/prepare-test-project.mjs";
import { platformRoot, publicStarterPath } from "../../scripts/test-project-source.mjs";

// Test the same Dockerfile, Compose prerequisite and host startup command Studio
// uses. No exports, AWS credentials, authored dotenv files or user volumes enter
// this fixture. --cleanup is also run by CI's always() step after cancellation.
const runtime = findProjectToolchain(platformRoot);
const probe = path.join(platformRoot, ".github/scripts/local-database-readiness-probe.mjs");
const cleanupOnly = process.argv.slice(2).includes("--cleanup");
const workflow = /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "");
assert.ok(!cleanupOnly || workflow, "Standalone cleanup requires the workflow's exact run ID and attempt.");
const project = `aws-studio-db-smoke-${workflow ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` : `local-${randomUUID().replaceAll("-", "").slice(0, 12)}`}`;
const temporary = realpathSync(process.env.RUNNER_TEMP ?? os.tmpdir());
const directory = path.join(temporary, project);
const root = path.join(directory, "project");
const ownershipFile = path.join(directory, "fixture.json");
const volume = `${project}_postgres_data`;
const env = {
  ...projectToolchainEnv(runtime),
  FRAMEWORK_REPOSITORY_ROOT: root,
  FRAMEWORK_STUDIO_STATE_DIRECTORY: path.join(directory, "studio-state"),
  AWS_EC2_METADATA_DISABLED: "true",
  npm_config_offline: "true",
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: path.join(root, "docker-compose.yml"),
  COMPOSE_DISABLE_ENV_FILE: "1",
  COMPOSE_PROFILES: "",
  LOCAL_AWS_CONFIG_DIR: path.join(directory, "empty-aws"),
  LOCAL_AWS_PROFILE: "database-smoke-no-aws",
  POSTGRES_HOST_PORT: "0",
  LOCAL_INVOCATION_RUNNER_HOST_PORT: "0",
  LOCAL_API_DEV_SERVER_HOST_PORT: "0",
  LOCAL_WS_DEV_SERVER_HOST_PORT: "0",
  PGADMIN_HOST_PORT: "0",
  USER_POOL_ID: "",
  USER_POOL_CLIENT_ID: "",
  COGNITO_DOMAIN_URL: "",
  LOCAL_BROWSER_ORIGINS: "",
  LOCAL_FRAMEWORK_DEPLOYMENT: "",
  LOCAL_FRAMEWORK_ACCOUNT: "",
};
delete env.COMPOSE_ENV_FILES;
delete env.COMPOSE_PATH_SEPARATOR;
delete env.FRAMEWORK_DOCKER_CLI;
delete env.FRAMEWORK_INPUTS_FILE;
delete env.FRAMEWORK_EXPORT_DIRECTORY;
delete env.STUDIO_PROJECT;
for (const key of Object.keys(env)) {
  if (/^npm_config_(?:workspace|workspaces|include_workspace_root|prefix|global)$/i.test(key)) delete env[key];
}

function run(file, args, { inherited = false, allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(file, args, { cwd: root, env, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024, ...(inherited ? { stdio: "inherit" } : {}) });
  if (!allowFailure) assert.equal(result.status, 0, `${file} ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? "see output above"}`);
  return result;
}
const compose = (...args) => run("docker", ["compose", "-p", project, "-f", env.COMPOSE_FILE, ...args]);
const container = service => {
  const id = compose("ps", "--all", "--quiet", service).stdout.trim();
  assert.match(id, /^[a-f0-9]{12,64}$/);
  const inspected = JSON.parse(run("docker", ["inspect", "--format", "{{json .}}", id]).stdout);
  assert.equal(inspected.Config.Labels["com.docker.compose.project"], project);
  assert.equal(inspected.Config.Labels["com.docker.compose.service"], service);
  return { id, inspected };
};
function readiness(source = root) {
  const postgres = container("postgres"), verifier = container("prisma-verify");
  const result = run(runtime.node, ["--import", import.meta.resolve("tsx"), probe, "problem", source, root, postgres.id, verifier.id]);
  return JSON.parse(result.stdout).problem;
}
function prepare(expected) {
  run(runtime.node, ["node_modules/aws-studio/cli/aws-studio.cjs", "dev", "--prepare-database", "--skip-generation", "--profile", "database-smoke-no-aws"], { inherited: true, timeout: 10 * 60_000 });
  const logs = compose("logs", "--no-color", "--no-log-prefix", "--tail", "80", "prisma-verify").stdout;
  const records = logs.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = records.filter(record => record.kind === "result" && record.commandId === "db.prepare-local").at(-1);
  assert.ok(result, "the image must emit the local database preparation result");
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.exitCode, 0);
  assert.equal(result.envelope.result.status, expected, "fresh storage initializes and retained storage only verifies");
  assert.match(result.envelope.result.inputsDigest, /^[a-f0-9]{64}$/);
  assert.equal(readiness(), null, "Studio must accept the real source and database generation just verified");
  console.log(JSON.stringify({ composeDatabaseSmoke: { project, status: expected, readiness: "ready" } }));
}
function cleanup() {
  if (!existsSync(ownershipFile)) return;
  assert.equal(realpathSync(directory), directory, "cleanup requires this run's physical temporary directory");
  const marker = JSON.parse(readFileSync(ownershipFile, "utf8"));
  assert.equal(marker.project, project, "cleanup requires this run's ownership marker");
  if (!marker.composeReady) {
    rmSync(directory, { recursive: true, force: true });
    return;
  }
  assert.equal(realpathSync(root), root, "cleanup requires this run's physical application directory");
  compose("down", "--remove-orphans", "--timeout", "5");
  const inspected = run("docker", ["volume", "inspect", "--format", "{{json .Labels}}", volume], { allowFailure: true });
  if (inspected.status === 0) {
    const labels = JSON.parse(inspected.stdout);
    assert.equal(labels["com.docker.compose.project"], project, "cleanup requires fixture project ownership");
    assert.equal(labels["com.docker.compose.volume"], "postgres_data", "cleanup removes only the fixture's PostgreSQL volume");
    run("docker", ["volume", "rm", volume]);
  }
  const image = `${project}-prisma-verify`;
  const built = run("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", image], { allowFailure: true });
  if (built.status === 0) {
    const labels = JSON.parse(built.stdout);
    assert.equal(labels["com.docker.compose.project"], project, "image cleanup requires fixture project ownership");
    assert.equal(labels["com.docker.compose.service"], "prisma-verify");
    run("docker", ["image", "rm", image]);
  }
  rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ composeDatabaseSmoke: { project, cleanup: "owned containers, network, PostgreSQL volume and image removed" } }));
}

function copySmokeSource(source) {
  cpSync(source, root, { recursive: true, filter(file) {
    const relative = path.relative(source, file).split(path.sep).join("/");
    if (!relative) return true;
    if (path.posix.basename(relative) === "node_modules") return false;
    const stat = lstatSync(file);
    assert.ok(publicStarterPath(relative) && (stat.isDirectory() || stat.isFile()),
      "the smoke project uses ordinary public files from the prepared starter");
    return true;
  } });
}

if (cleanupOnly) {
  cleanup();
} else {
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(ownershipFile, JSON.stringify({ project }));
  mkdirSync(env.LOCAL_AWS_CONFIG_DIR);
  try {
    const source = await prepareTestProject();
    copySmokeSource(source);
    run(runtime.node, [runtime.npm, "ci", "--offline", "--no-audit", "--no-fund"], { inherited: true, timeout: 10 * 60_000 });
    preparedTestProject(source);
    const existing = run("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]);
    assert.equal(existing.stdout.trim(), "", "the smoke test requires a fresh dedicated Compose project");
    assert.notEqual(run("docker", ["volume", "inspect", volume], { allowFailure: true }).status, 0, "the smoke test requires a new PostgreSQL volume");
    const config = JSON.parse(compose("config", "--format", "json").stdout);
    assert.equal(config.name, project);
    writeFileSync(ownershipFile, JSON.stringify({ project, composeReady: true }));
    for (const expected of ["initialized", "verified"]) prepare(expected);

    const sourceProof = path.join(directory, "source-proof");
    run(runtime.node, ["--import", import.meta.resolve("tsx"), probe, "copy-source", sourceProof, root]);
    assert.equal(readiness(sourceProof), null);
    const fixtureContract = path.join(sourceProof, "packages/database/prisma/contract.prisma");
    writeFileSync(fixtureContract, `${readFileSync(fixtureContract, "utf8")}\n// Simulated pulled database source; the actual checkout stays unchanged.\n`);
    assert.match(readiness(sourceProof), /source, migration history or dependencies changed/);
    console.log(JSON.stringify({ composeDatabaseSmoke: { project, changedCheckoutInputs: "blocked" } }));

    // A restart invalidates an exited verifier even when the volume is retained.
    const beforeRestart = container("postgres"), verifierBeforeRestart = container("prisma-verify");
    compose("stop", "--timeout", "2", "postgres");
    compose("up", "--detach", "--wait", "--no-build", "postgres");
    assert.equal(container("postgres").id, beforeRestart.id);
    assert.equal(container("prisma-verify").inspected.State.FinishedAt, verifierBeforeRestart.inspected.State.FinishedAt);
    assert.match(readiness(), /restarted or was recreated/);
    console.log(JSON.stringify({ composeDatabaseSmoke: { project, restartedDatabaseWithOldVerifier: "blocked" } }));
    prepare("verified");

    // Remove only this independently owned fixture's database and volume. Keep
    // its successful verifier so readiness must reject stale proof for new data.
    const previousPostgres = container("postgres"), previousVerifier = container("prisma-verify");
    assert.ok(previousPostgres.inspected.Mounts.some(mount => mount.Type === "volume" && mount.Name === volume));
    const volumeLabels = JSON.parse(run("docker", ["volume", "inspect", "--format", "{{json .Labels}}", volume]).stdout);
    assert.equal(volumeLabels["com.docker.compose.project"], project);
    assert.equal(volumeLabels["com.docker.compose.volume"], "postgres_data");
    run("docker", ["stop", "--time", "2", previousPostgres.id]);
    run("docker", ["rm", previousPostgres.id]);
    run("docker", ["volume", "rm", volume]);
    assert.notEqual(run("docker", ["volume", "inspect", volume], { allowFailure: true }).status, 0);
    compose("up", "--detach", "--wait", "--no-build", "postgres");
    assert.notEqual(container("postgres").id, previousPostgres.id);
    assert.equal(container("prisma-verify").id, previousVerifier.id);
    assert.equal(container("prisma-verify").inspected.State.FinishedAt, previousVerifier.inspected.State.FinishedAt);
    assert.match(readiness(), /restarted or was recreated/);
    console.log(JSON.stringify({ composeDatabaseSmoke: { project, replacedVolumeWithOldVerifier: "blocked" } }));
    prepare("initialized");
    const services = run("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", '{{.Label "com.docker.compose.service"}}']).stdout.trim().split(/\r?\n/).sort();
    assert.deepEqual(services, ["postgres", "prisma-verify"], "database preflight must not launch application or maintenance services");
  } finally {
    cleanup();
  }
}

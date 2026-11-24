import { testProjectScratchRoot } from "../../../../scripts/test-project";
import { copyLocalTestProject } from "./support/isolated-project";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { databaseStartupProblem } from "../../cli/local-startup-diagnostics.mjs";
import { composeProjectName } from "../../cli/compose-project-ownership.mjs";

/**
 * npm run dev:containers, with a simulated Docker: --detach starts the stack in
 * the background (what Studio's Start development runs), from the repository
 * root whatever the caller's directory, with the profile handed to Compose.
 */

let root: string;
before(() => { root = copyLocalTestProject("compose-start-"); });
after(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const FAKE_DOCKER = path.resolve(__dirname, "../../../../client-app/test/support/fake-docker.mjs");

function engine(state: Record<string, unknown>) {
  mkdirSync(path.join(testProjectScratchRoot, ".cache"), { recursive: true });
  const directory = mkdtempSync(path.join(testProjectScratchRoot, ".cache", "fake-docker-"));
  const statePath = path.join(directory, "state.json");
  writeFileSync(statePath, JSON.stringify({ engine: "running", desktop: true, compose: "5.1.0", project: composeProjectName(root), services: [{ name: "postgres" }, { name: "seed-test-user", oneShot: true }], ...state }));
  const dev = (...args: string[]) => {
    const run = spawnSync(process.execPath, [path.join(root, "node_modules/aws-studio/cli/aws-studio.cjs"), "dev", ...args], {
      cwd: directory, encoding: "utf8", timeout: 180_000,
      env: { ...process.env, FRAMEWORK_REPOSITORY_ROOT: root, FRAMEWORK_DOCKER_CLI: FAKE_DOCKER, FAKE_DOCKER_STATE: statePath, AWS_PROFILE: "", COMPOSE_PROFILES: "database-write,identity-setup,identity-cleanup" },
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  const calls = () => readFileSync(`${statePath}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return { dev, calls, read: () => JSON.parse(readFileSync(statePath, "utf8")), dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

test("--detach starts the stack in the background from the repository root, with the profile", () => {
  const docker = engine({});
  try {
    const result = docker.dev("--detach", "--profile", "dev");
    assert.equal(result.status, 0, result.output);
    const up = docker.calls().find((call: any) => call.args[0] === "compose" && call.args[1] === "up");
    assert.deepEqual(up.args, ["compose", "up", "--detach", "--build", "--remove-orphans"]);
    assert.equal(up.profile, "dev");
    assert.ok(docker.calls().every((call: any) => call.composeProfiles === ""), "inherited maintenance profiles cannot turn startup into database or identity writes");
    assert.equal(path.resolve(up.cwd), root, "Compose runs where docker-compose.yml is");
    assert.ok(docker.read().containers.some((container: any) => container.Names.endsWith("postgres-1") && container.State === "running"));
  } finally { docker.dispose(); }
});

test("--detach fails, naming the engine, when Docker is not running", () => {
  const docker = engine({ engine: "stopped" });
  try {
    const result = docker.dev("--detach", "--profile", "dev");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /dockerDesktopLinuxEngine|Docker/);
  } finally { docker.dispose(); }
});

const verification = (code: string, extra = {}) => JSON.stringify({ kind: "result", commandId: "db.verify", envelope: {
  ok: true, result: { ok: false }, diagnostics: [{ code, ...extra }],
} });

test("a legacy unsigned local database failure reports recovery instead of the Compose wrapper", () => {
  const docker = engine({ upFailure: 'service "prisma-verify" did not complete successfully: exit 4', logs: {
    "prisma-verify": `> prisma db verify\n${verification("CONTRACT.MARKER_MISSING", { why: "private-connection-value", nextActions: [{ command: "prisma db sign --db private-url" }] })}\n`,
  } });
  try {
    const result = docker.dev("--detach", "--profile", "dev");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Error: Local database needs initialization.*Database status.*review initialization/);
    assert.doesNotMatch(result.output, /private-connection-value|private-url|prisma db sign/);
    assert.ok(docker.read().containers.some((container: any) => container.Names.endsWith("postgres-1") && container.State === "running"), "database remains available for a separate reviewed action");
    const logs = docker.calls().find((call: any) => call.args.slice(0, 2).join(" ") === "compose logs");
    assert.deepEqual(logs.args.slice(0, 5), ["compose", "logs", "--no-color", "--no-log-prefix", "--since"]);
    assert.ok(Number.isFinite(Date.parse(logs.args[5])), "old failed verification logs are excluded");
    assert.deepEqual(logs.args.slice(6), ["--tail", "80", "prisma-verify"]);
    assert.ok(docker.calls().every((call: any) => !call.args.includes("run")), "startup never invokes the separately authorized migration service");
  } finally { docker.dispose(); }
});

test("verification diagnostics use only the database result envelope and fixed remedies", () => {
  assert.match(databaseStartupProblem(`prisma-verify | ${verification("CONTRACT.MARKER_MISMATCH")}`)!, /review a matching migration path.*branch/);
  assert.match(databaseStartupProblem(verification("CONTRACT.SCHEMA_VERIFICATION_FAILED"))!, /schema differences/);
  assert.match(databaseStartupProblem(verification("CONNECTION.PRIVATE_DETAIL"))!, /verification failed/);
  assert.equal(databaseStartupProblem('{"kind":"result","commandId":"other","envelope":{"diagnostics":[{"code":"CONTRACT.MARKER_MISSING"}]}}'), undefined);
  assert.equal(databaseStartupProblem("not JSON\n{}\n"), undefined);
});

test("preparation diagnostics preserve occupied storage and never expose provider advice", () => {
  const preparation = (code: string) => JSON.stringify({ kind: "result", commandId: "db.prepare-local", envelope: {
    ok: false, diagnostics: [{ code, message: "private-provider-url prisma db sign --db private-url" }],
  } });
  assert.match(databaseStartupProblem(preparation("LOCAL_DATABASE_NOT_EMPTY"))!, /existing objects.*cannot adopt or reset/);
  assert.match(databaseStartupProblem(preparation("CONTRACT.MARKER_MISMATCH"))!, /matching migration path/);
  assert.match(databaseStartupProblem(preparation("CONTRACT.SCHEMA_VERIFICATION_FAILED"))!, /schema differences/);
  assert.match(databaseStartupProblem(preparation("LOCAL_DATABASE_TARGET_REFUSED"))!, /destination outside/);
  assert.match(databaseStartupProblem(preparation("LOCAL_DATABASE_INITIALIZATION_FAILED"))!, /could not be confirmed/);
  for (const code of ["LOCAL_DATABASE_NOT_EMPTY", "LOCAL_DATABASE_PREPARATION_FAILED", "LOCAL_DATABASE_SOURCE_CHANGED"]) {
    assert.doesNotMatch(databaseStartupProblem(preparation(code))!, /private-provider-url|prisma db sign|private-url/);
  }
  assert.equal(databaseStartupProblem(JSON.stringify({ kind: "result", commandId: "db.prepare-local", envelope: { ok: true } })), undefined);
});

test("database preflight waits for preparation before any application services start", () => {
  for (const exitCode of [0, 4]) {
    const docker = engine({ services: [{ name: "postgres" }, { name: "prisma-verify", oneShot: true, exitCode }, { name: "api" }], logs: {
      "prisma-verify": verification("CONTRACT.MARKER_MISSING"),
    } });
    try {
      const result = docker.dev("--prepare-database", "--profile", "developer");
      assert.equal(result.status, exitCode, result.output);
      const compose = docker.calls().filter((call: any) => call.args[0] === "compose");
      assert.deepEqual(compose.find((call: any) => call.args[1] === "up").args, ["compose", "up", "--detach", "--build", "postgres", "prisma-verify"]);
      assert.ok(compose.some((call: any) => call.args.join(" ") === "compose ps --all --quiet prisma-verify"));
      assert.ok(docker.calls().some((call: any) => call.args[0] === "wait" && call.args[1] === docker.read().containers.find((container: any) => container.Names.endsWith("prisma-verify-1")).ID), "Engine wait observes even an already-exited verification container");
      assert.ok(docker.read().containers.every((container: any) => !container.Names.endsWith("api-1")));
      assert.ok(docker.read().containers.some((container: any) => container.Names.endsWith("postgres-1") && container.State === "running"));
      assert.ok(compose.every((call: any) => call.profile === "developer"));
      if (exitCode) assert.match(result.output, /Local database needs initialization/);
    } finally { docker.dispose(); }
  }
});

test("the previous database preflight flag remains compatible with recorded startup operations", () => {
  const docker = engine({ services: [{ name: "postgres" }, { name: "prisma-verify", oneShot: true }] });
  try {
    const result = docker.dev("--verify-database", "--skip-generation", "--profile", "developer");
    assert.equal(result.status, 0, result.output);
    assert.ok(docker.calls().some((call: any) => call.args.join(" ") === "compose up --detach --build postgres prisma-verify"));
  } finally { docker.dispose(); }
});

test("same-name checkout ownership prevents generation, image cleanup and Compose startup", () => {
  const project = composeProjectName(root);
  const docker = engine({ containers: [{ ID: "abc123abc123", Names: `${project}-postgres-1`, State: "exited", Status: "Exited (0)", Ports: "",
    Labels: `com.docker.compose.project=${project},com.docker.compose.service=postgres`, WorkingDir: path.join(root, "another-clone") }] });
  try {
    const result = docker.dev("--prepare-database", "--profile", "dev");
    assert.notEqual(result.status, 0);
    assert.match(result.output, /another checkout|ownership is unknown/);
    assert.ok(docker.calls().every((call: any) => call.args[0] !== "image" && call.args[1] !== "up"), "a foreign stopped container still protects its project and volume");
    assert.equal(docker.read().containers[0].State, "exited");
  } finally { docker.dispose(); }
});

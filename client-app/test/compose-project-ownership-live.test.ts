import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertComposeContainerOwnership, composeProjectName, parseComposeOwnershipLabels } from "aws-studio/cli/compose-project-ownership.mjs";
import { LocalEnvironment } from "../server/deploy/local";
import { Tools } from "../server/deploy/process";

const checkout = path.resolve(__dirname, "../..");

test("two real checkouts cannot observe or stop each other's Compose project", {
  skip: process.env.FRAMEWORK_LOCAL_DATABASE_TEST !== "1", timeout: 90_000,
}, async () => {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), "studio-compose-ownership-"));
  const first = path.join(directory, "alice", "AWS Studio.test"), second = path.join(directory, "bob", "AWS Studio.test");
  mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true });
  const project = `studio-owner-${randomUUID().slice(0, 12)}`;
  const volume = `${project}_postgres_data`;
  const ownerLabel = "com.matts-aws-framework.checkout-isolation-test";
  const composeFile = path.join(first, "docker-compose.yml");
  writeFileSync(composeFile, JSON.stringify({ services: { postgres: { image: "postgres:16", labels: { [ownerLabel]: project },
    environment: { POSTGRES_USER: "admin", POSTGRES_PASSWORD: "isolation-fixture", POSTGRES_DB: "app_db" },
    volumes: ["postgres_data:/var/lib/postgresql/data"],
  } }, volumes: { postgres_data: { labels: { [ownerLabel]: project } } } }));
  writeFileSync(path.join(second, "docker-compose.yml"), JSON.stringify({ services: { postgres: { image: "postgres:16" } } }));
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROJECT_NAME: project, COMPOSE_DISABLE_ENV_FILE: "1" };
  delete env.FRAMEWORK_DOCKER_CLI; delete env.COMPOSE_FILE; delete env.COMPOSE_ENV_FILES;
  const calls: string[][] = [];
  function docker(args: string[], allowFailure = false) {
    const result = spawnSync("docker", args, { cwd: first, env, encoding: "utf8", timeout: 45_000 });
    if (!allowFailure) assert.equal(result.status, 0, result.stderr);
    return result;
  }
  const compose = (...args: string[]) => docker(["compose", "-p", project, "-f", composeFile, ...args]);
  try {
    assert.equal(docker(["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]).stdout.trim(), "");
    assert.notEqual(docker(["volume", "inspect", volume], true).status, 0);
    // Native Compose, including whitespace/punctuation directory names, is the authority.
    const nativeDefault = spawnSync("docker", ["compose", "-f", composeFile, "config", "--format", "json"], { cwd: first, env: { ...env, COMPOSE_PROJECT_NAME: "" }, encoding: "utf8" });
    assert.equal(nativeDefault.status, 0, nativeDefault.stderr);
    assert.equal(JSON.parse(nativeDefault.stdout).name, composeProjectName(first, { COMPOSE_DISABLE_ENV_FILE: "1" }));
    compose("up", "--detach", "postgres");
    const id = compose("ps", "--all", "--quiet", "postgres").stdout.trim();
    assert.ok(/^[a-f0-9]{12,64}$/.test(id));
    const labels = parseComposeOwnershipLabels(docker(["inspect", "--format", "{{json .Config.Labels}}", id]).stdout, 1);
    assertComposeContainerOwnership(first, project, labels);
    assert.throws(() => assertComposeContainerOwnership(second, project, labels), /another checkout/);
    const local = new LocalEnvironment(second, new Tools(checkout, env), async spec => {
      calls.push([...spec.args]);
      const result = spawnSync(spec.file, [...spec.args], { cwd: spec.cwd, env: spec.env, encoding: "utf8", timeout: 15_000 });
      return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }, env, second, path.join(second, "state"));
    await assert.rejects(() => local.services(), /another checkout/);
    await assert.rejects(() => local.containerIds(), /another checkout/);
    assert.ok(calls.every(args => ["ps", "inspect"].includes(args[0]!)), "foreign checkout checks never issue a Docker mutation");
    assert.equal(compose("ps", "--all", "--quiet", "postgres").stdout.trim(), id, "the original container is retained");
    assert.equal(docker(["inspect", "--format", "{{.State.Running}}", id]).stdout.trim(), "true");
    assert.equal(docker(["volume", "inspect", "--format", `{{index .Labels "${ownerLabel}"}}`, volume]).stdout.trim(), project);
    console.log(JSON.stringify({ composeCheckoutOwnership: { project, conflict: "refused", originalContainer: "running", volume: "retained" } }));
  } finally {
    const owned = docker(["ps", "--all", "--quiet", "--filter", `label=${ownerLabel}=${project}`], true).stdout.trim();
    if (owned) compose("down", "--timeout", "2");
    const labels = docker(["volume", "inspect", "--format", `{{index .Labels "${ownerLabel}"}}`, volume], true);
    if (labels.status === 0 && labels.stdout.trim() === project) docker(["volume", "rm", volume]);
    rmSync(directory, { recursive: true, force: true });
  }
});

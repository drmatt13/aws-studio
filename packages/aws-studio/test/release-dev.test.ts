import { testProjectRoot } from "../../../scripts/test-project";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as compose from "aws-studio/compose-services";

const release = path.resolve(__dirname, "..");
const checkout = path.resolve(release, "../..");
const base = "node_modules/aws-studio/dev/compose.yml";
const include = `include:\n  - path: ./${base}\n    project_directory: .\n  - docker-compose.services.yml\n`;

test("the app includes the installed development base and its generated services from the app directory", () => {
  const app = compose.parseCompose(readFileSync(path.join(testProjectRoot, "docker-compose.yml"), "utf8"));
  assert.ok(app.include?.some(item => typeof item === "object" && item !== null &&
    "path" in item && item.path === "./" + base && "project_directory" in item && item.project_directory === "."));
  assert.ok(app.include?.includes("docker-compose.services.yml"));
  const packaged = compose.parseCompose(readFileSync(path.join(release, "dev/compose.yml"), "utf8"));
  for (const name of ["postgres", "prisma-verify", "local-api-dev-server", "local-invocation-runner", "local-ws-dev-server", "pgadmin"]) {
    assert.ok(packaged.services?.[name], name);
    assert.equal(app.services?.[name], undefined, `${name} is defined by the release`);
  }
  assert.ok(packaged["x-framework-service"]);
  assert.ok(Object.hasOwn(packaged.volumes as object, "postgres_data"));
  assert.ok(existsSync(path.join(release, "dev/Dockerfile")));
});

test("Compose readers preserve app-owned services and derive the service template from the project's own base", t => {
  const project = mkdtempSync(path.join(os.tmpdir(), "app compose "));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.dirname(path.join(project, base)), { recursive: true });
  writeFileSync(path.join(project, base), [
    "x-framework-service: { init: true }",
    "services:",
    "  postgres: { image: fixture/base-postgres }",
  ].join("\n"));
  writeFileSync(path.join(project, "docker-compose.yml"), include + "services:\n  app-owned: { image: fixture/app }\n");
  const source = compose.readProjectCompose(project);
  assert.equal(source.services?.postgres?.image, "fixture/base-postgres");
  assert.equal(source.services?.["app-owned"]?.image, "fixture/app");
  assert.deepEqual(source["x-framework-service"], { init: true });
});

test("dev --print reports only the project, Compose files and command before invoking Docker", t => {
  const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), "print dev app ")));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(path.join(project, "package.json"), "{}");
  writeFileSync(path.join(project, "framework.config.ts"), 'throw new Error("should not evaluate config");');
  writeFileSync(path.join(project, "docker-compose.yml"), "services: {}\n");
  const docker = path.join(project, "fake-docker.cjs");
  writeFileSync(docker, 'require("node:fs").writeFileSync("docker-called", "called"); process.exit(99);');
  const output = execFileSync(process.execPath, [path.join(release, "cli/dev.mjs"), "--print"], {
    cwd: project, env: { ...process.env, FRAMEWORK_REPOSITORY_ROOT: project, FRAMEWORK_DOCKER_CLI: docker,
      AWS_PROFILE: "PRIVATE_PROFILE_CANARY", LOCAL_TEST_USER_PASSWORD: "PRIVATE_TEST_CANARY" }, encoding: "utf8",
  });
  assert.equal(existsSync(path.join(project, "docker-called")), false);
  assert.doesNotMatch(output, /PRIVATE_(?:PROFILE|TEST)_CANARY/);
  const plan = JSON.parse(output);
  assert.deepEqual(Object.keys(plan).sort(), ["command", "composeFiles", "projectRoot"]);
  assert.equal(plan.projectRoot, project);
  assert.ok(plan.composeFiles.includes("docker-compose.yml"));
  assert.deepEqual(plan.command, ["docker", "compose", "up", "--build", "--watch", "--remove-orphans"]);
});

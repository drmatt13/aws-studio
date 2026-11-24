import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDevelopmentObservation } from "../../../cli/dev-observation";
import { developmentObservationComposeArgs } from "../../../cli/development-log-compose";
import type { DevelopmentLogControl } from "aws-studio/development-logs";

const execute = promisify(execFile);
interface ComposeService {
  environment: Record<string, string>;
  volumes?: {
    type: string;
    source: string;
    target: string;
    read_only?: boolean;
    bind?: { create_host_path?: boolean };
  }[];
}

test(
  "real Compose config merges prepared diagnostic overlay with includes and preserves private mount boundaries",
  {
    skip: process.env.FRAMEWORK_DEVELOPMENT_LOG_COMPOSE_TEST !== "1",
    timeout: 30_000,
  },
  async () => {
    const fixture = await mkdtemp(
      path.join(realpathSync(tmpdir()), "studio-log-compose-"),
    );
    const project = `studio-log-config-${randomUUID().slice(0, 8)}`;
    const previous = process.env.COMPOSE_PROJECT_NAME;
    process.env.COMPOSE_PROJECT_NAME = project;
    try {
      await mkdir(path.join(fixture, "cdk-app"));
      await writeFile(
        path.join(fixture, "framework.config.ts"),
        "export default {};\n",
      );
      await writeFile(
        path.join(fixture, "cdk-app/.env.dev"),
        "# Disposable fixture; no credentials.\n",
      );
      await writeFile(
        path.join(fixture, "docker-compose.yml"),
        `include:\n  - docker-compose.services.yml\nservices:\n  local-invocation-runner:\n    image: fixture:local\n    environment:\n      PRESERVED_RUNTIME_ENV: fixture-value\n    volumes:\n      - type: bind\n        source: ./.framework/local\n        target: /workspace/.framework/local\n        read_only: true\n      - type: bind\n        source: ./cdk-app/.env.dev\n        target: /workspace/cdk-app/.env.dev\n        read_only: true\n  local-api-dev-server:\n    image: fixture:local\n  local-ws-dev-server:\n    image: fixture:local\n  postgres:\n    image: fixture:local\n`,
      );
      await writeFile(
        path.join(fixture, "docker-compose.services.yml"),
        "services:\n  generated-fixture:\n    image: fixture:local\n    environment:\n      PRESERVED_GENERATED_ENV: generated-value\n",
      );
      await writeFile(
        path.join(fixture, "docker-compose.override.yml"),
        "services:\n  generated-fixture:\n    environment:\n      PRESERVED_OVERRIDE_ENV: override-value\n",
      );
      const database = await prepareDevelopmentObservation(fixture, "database");
      assert.equal(database.enabled, true);
      const first = JSON.parse(
        await readFile(
          path.join(fixture, ".framework/local/development-logs.json"),
          "utf8",
        ),
      ) as DevelopmentLogControl;
      const prepared = await prepareDevelopmentObservation(fixture, "compute");
      assert.equal(prepared.enabled, true);
      assert.ok(prepared.directory?.startsWith(fixture + path.sep));
      assert.ok(prepared.overlay?.startsWith(fixture + path.sep));
      const control = JSON.parse(
        await readFile(
          path.join(fixture, ".framework/local/development-logs.json"),
          "utf8",
        ),
      ) as DevelopmentLogControl;
      assert.equal(
        control.runtimeSessionId,
        first.runtimeSessionId,
        "database and compute preparation belong to one runtime session",
      );
      assert.equal(control.hostRepositoryRoot, realpathSync(fixture));
      const environment = {
        ...process.env,
        COMPOSE_PROJECT_NAME: project,
        COMPOSE_DISABLE_ENV_FILE: "1",
      };
      const args = developmentObservationComposeArgs(
        fixture,
        ["compose", "config", "--format", "json"],
        environment,
      );
      assert.ok(args.includes(prepared.overlay!));
      const result = await execute("docker", [...args], {
        cwd: fixture,
        env: environment,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
      });
      const configuration = JSON.parse(result.stdout) as {
        services: Record<string, ComposeService>;
      };
      for (const name of [
        "local-invocation-runner",
        "local-api-dev-server",
        "local-ws-dev-server",
        "generated-fixture",
      ]) {
        assert.equal(
          configuration.services[name]?.environment.FRAMEWORK_DEVELOPMENT_LOGS,
          "1",
        );
        assert.equal(
          configuration.services[name]?.environment
            .FRAMEWORK_DEVELOPMENT_LOG_SESSION,
          control.runtimeSessionId,
        );
      }
      assert.equal(
        configuration.services.postgres?.environment
          ?.FRAMEWORK_DEVELOPMENT_LOGS,
        undefined,
      );
      const runner = configuration.services["local-invocation-runner"]!;
      assert.equal(runner.environment.PRESERVED_RUNTIME_ENV, "fixture-value");
      assert.equal(
        configuration.services["generated-fixture"]?.environment
          .PRESERVED_GENERATED_ENV,
        "generated-value",
      );
      assert.equal(
        configuration.services["generated-fixture"]?.environment
          .PRESERVED_OVERRIDE_ENV,
        "override-value",
      );
      const cacheMounts = Object.entries(configuration.services).flatMap(
        ([service, value]) =>
          (value.volumes ?? [])
            .filter((mount) => mount.source === prepared.directory)
            .map((mount) => ({ service, mount })),
      );
      assert.equal(cacheMounts.length, 1);
      assert.equal(cacheMounts[0]?.service, "local-invocation-runner");
      assert.equal(cacheMounts[0]?.mount.target, "/development-logs");
      assert.notEqual(cacheMounts[0]?.mount.read_only, true);
      assert.equal(cacheMounts[0]?.mount.bind?.create_host_path, false);
      for (const target of [
        "/workspace/.framework/local",
        "/workspace/cdk-app/.env.dev",
      ])
        assert.equal(
          runner.volumes?.find((mount) => mount.target === target)?.read_only,
          true,
        );
      assert.ok(
        !JSON.stringify(configuration).includes(control.token),
        "private collector capability never enters Compose configuration",
      );
      console.log(
        "Compose config smoke: generated include + override + prepared JSON overlay merged; session retained; runner-only writable cache and existing read-only mounts preserved. No workloads started.",
      );
    } finally {
      if (previous === undefined) delete process.env.COMPOSE_PROJECT_NAME;
      else process.env.COMPOSE_PROJECT_NAME = previous;
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

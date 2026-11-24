import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { defineFrameworkConfig } from "aws-studio/config";
import {
  type DevelopmentLogControl,
  type DevelopmentObservationInput,
} from "aws-studio/development-logs";
import {
  readLogFile,
  writeLogJson,
} from "aws-studio/local/development-logs";
import {
  followDevelopmentComposeOutput,
  ownsDevelopmentComposeContainer,
  postgresDevelopmentLifecycle,
} from "../src/development-logs/compose-output";
import { validateDevelopmentFollowerCheckpoint } from "../src/development-logs/checkpoint";
import { developmentWriterIdentity } from "../src/development-logs/writer-identity";
import { applicationVpc } from "../../../../../scripts/test-project-declarations";
import { defaults } from "../../../../../scripts/test-project-declarations";
import { ensurePrivateDirectory } from "../../../cli/private-files";

const config = defineFrameworkConfig({
  networks: [applicationVpc],
  defaults,
  http: [],
  webSocket: [],
  events: [],
  services: [
    {
      "/fixture/*": {
        directory: "compute/services/fixture",
        methods: "*",
        port: 5000,
        deploy: "local-only",
        cloud: { vpc: applicationVpc },
      },
    },
  ],
});
const root = "/fixture,comma/repository";
const control: DevelopmentLogControl = {
  version: 1,
  repositoryKey: "repo",
  composeProject: "fixture-project",
  runtimeSessionId: randomUUID(),
  bindingId: "binding",
  declarationDigest: "digest",
  startedAt: "2026-01-01T00:00:00.000Z",
  token: "0".repeat(64),
  endpoint: "http://local-invocation-runner:8090",
  binding: {},
  hostRepositoryRoot: root,
  hostUid: process.getuid?.(),
};
const labels = {
  "com.docker.compose.project": control.composeProject,
  "com.docker.compose.project.working_dir": root,
  "com.docker.compose.project.config_files": `${root}/docker-compose.yml,${root}/docker-compose.override.yml`,
  "com.docker.compose.service": "fixture",
};
const id = "a".repeat(64);

test("writer identity follows verified Docker Desktop projection and preserves native host ownership", () => {
  const input = {
    platform: "linux",
    processUid: 0,
    ownerUid: 0,
    mode: 0o700,
    isDirectory: true,
    isSymbolicLink: false,
    control: { hostUid: 501, hostGid: 20 },
  };
  assert.deepEqual(
    developmentWriterIdentity({
      ...input,
      daemonOperatingSystem: "Docker Desktop",
    }),
    { uid: 0, gid: 0 },
  );
  assert.equal(
    developmentWriterIdentity({
      ...input,
      daemonOperatingSystem: "Debian GNU/Linux",
    }),
    undefined,
  );
  assert.deepEqual(
    developmentWriterIdentity({
      ...input,
      ownerUid: 501,
      daemonOperatingSystem: "Debian GNU/Linux",
    }),
    { uid: 501, gid: 20 },
  );
  assert.equal(
    developmentWriterIdentity({
      ...input,
      daemonOperatingSystem: "Docker Desktop",
      mode: 0o755,
    }),
    undefined,
  );
  assert.equal(
    developmentWriterIdentity({
      ...input,
      daemonOperatingSystem: "Docker Desktop",
      isSymbolicLink: true,
    }),
    undefined,
  );
  assert.deepEqual(
    developmentWriterIdentity({
      ...input,
      daemonOperatingSystem: "Docker Desktop",
      control: {},
    }),
    { uid: 0, gid: 0 },
  );
  assert.equal(developmentWriterIdentity({ ...input, control: {} }), undefined);
});
function child() {
  const value = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): boolean;
  };
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.kill = () => {
    value.stdout.end();
    value.stderr.end();
    value.emit("close", 0);
    return true;
  };
  return value;
}

test("Compose output requires exact checkout/project provenance, including comma-containing paths", () => {
  assert.equal(ownsDevelopmentComposeContainer(labels, control), true);
  assert.equal(
    ownsDevelopmentComposeContainer(
      {
        ...labels,
        "com.docker.compose.project.working_dir": "/other/repository",
      },
      control,
    ),
    false,
  );
  assert.equal(
    ownsDevelopmentComposeContainer(
      {
        ...labels,
        "com.docker.compose.project.config_files": "/other/docker-compose.yml",
      },
      control,
    ),
    false,
  );
  assert.equal(
    ownsDevelopmentComposeContainer(
      { ...labels, "com.docker.compose.project": "another-project" },
      control,
    ),
    false,
  );
  assert.equal(
    ownsDevelopmentComposeContainer(labels, {
      ...control,
      hostRepositoryRoot: undefined,
    }),
    false,
  );
});

test("PostgreSQL recognizer retains fixed lifecycle summaries and refuses SQL/row/error context", () => {
  assert.equal(
    postgresDevelopmentLifecycle(
      "2026-01-01 00:00:00.000 UTC [1] LOG:  database system is ready to accept connections\n",
    ),
    "database system is ready to accept connections",
  );
  assert.equal(
    postgresDevelopmentLifecycle(
      "2026-01-01 00:00:00.000 UTC [1] LOG:  starting PostgreSQL 16.4 on aarch64\n",
    ),
    "starting PostgreSQL",
  );
  for (const message of [
    "[1] STATEMENT: select secret from users",
    "[1] ERROR: database system is ready to accept connections",
    "[1] DETAIL: row=(secret)",
    "[1] LOG: select 'database system is ready to accept connections'",
    "[1] LOG: database system is ready to accept connections; SQL=secret",
    "database system is ready to accept connections",
  ])
    assert.equal(postgresDevelopmentLifecycle(message), undefined);
});

test("checkpoint RPC accepts only bounded identity-bound metadata and strips unknown payloads", () => {
  const value = {
    version: 1,
    repositoryKey: control.repositoryKey,
    composeProject: control.composeProject,
    runtimeSessionId: control.runtimeSessionId,
    bindingId: control.bindingId,
    containers: {
      [id]: {
        startedAt: control.startedAt,
        password: "private-payload-must-not-persist",
        stdout: { at: control.startedAt, counts: { ["b".repeat(64)]: 1 } },
      },
    },
  };
  const checked = validateDevelopmentFollowerCheckpoint(value, control);
  assert.ok(checked);
  assert.doesNotMatch(JSON.stringify(checked), /private-payload|password/);
  assert.equal(
    validateDevelopmentFollowerCheckpoint(
      { ...value, repositoryKey: "foreign-repo" },
      control,
    ),
    undefined,
  );
  assert.equal(
    validateDevelopmentFollowerCheckpoint(
      { ...value, runtimeSessionId: randomUUID() },
      control,
    ),
    undefined,
  );
  assert.equal(
    validateDevelopmentFollowerCheckpoint(
      { ...value, containers: { "../../file": value.containers[id] } },
      control,
    ),
    undefined,
  );
});

test("a failed service start produces lifecycle evidence before any stdout exists", async () => {
  const events: DevelopmentObservationInput[] = [];
  const source = child();
  const follower = followDevelopmentComposeOutput(
    { repositoryRoot: root, projectName: control.composeProject, config },
    control,
    {
      autoPoll: false,
      emit: (event) => events.push(event),
      command: async (args) =>
        args[0] === "ps"
          ? JSON.stringify({ ID: id })
          : JSON.stringify({
              Config: {
                Labels: labels,
                Cmd: [
                  "node",
                  "node_modules/aws-studio/scripts/run-service.ts",
                  "fixture",
                ],
              },
              State: {
                Status: "created",
                Running: false,
                StartedAt: control.startedAt,
                ExitCode: 128,
                Error: "fixture mount unavailable",
                OOMKilled: false,
              },
            }),
      follow: () => source as unknown as ChildProcess,
    },
  );
  try {
    await follower.inspect();
    const event = events.find((value) => value.kind === "container.lifecycle");
    assert.equal(event?.resourceId, "service:fixture");
    assert.equal(event?.level, "error");
    assert.equal((event?.details as { exitCode: number }).exitCode, 128);
    assert.ok(!events.some((value) => value.kind === "process.output"));
  } finally {
    await follower.close();
  }
});

test("a service from another known runtime session is not recaptured and its environment stays private", async () => {
  const events: DevelopmentObservationInput[] = [];
  let started = 0;
  const follower = followDevelopmentComposeOutput(
    { repositoryRoot: root, projectName: control.composeProject, config },
    control,
    {
      autoPoll: false,
      emit: (event) => events.push(event),
      command: async (args) =>
        args[0] === "ps"
          ? JSON.stringify({ ID: id })
          : JSON.stringify({
              Config: {
                Labels: labels,
                Cmd: [
                  "node",
                  "node_modules/aws-studio/scripts/run-service.ts",
                  "fixture",
                ],
                Env: [
                  `FRAMEWORK_DEVELOPMENT_LOG_SESSION=${randomUUID()}`,
                  "AWS_SECRET_ACCESS_KEY=private-fixture-value",
                ],
              },
              State: { Running: true, StartedAt: control.startedAt },
            }),
      follow: () => {
        started++;
        return child() as unknown as ChildProcess;
      },
    },
  );
  try {
    await follower.inspect();
    await follower.inspect();
    assert.equal(started, 0);
    assert.equal(
      events.filter(
        (event) => event.kind === "collector.source_session_unavailable",
      ).length,
      1,
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /AWS_SECRET|private-fixture-value/,
    );
  } finally {
    await follower.close();
  }
});

test("same-container restart reattaches; persisted checkpoints deduplicate bounded backfill and retain repeated lines", async () => {
  const directory = await mkdtemp(
    path.join(realpathSync(tmpdir()), "studio-log-followers-"),
  );
  ensurePrivateDirectory(directory);
  const events: DevelopmentObservationInput[] = [];
  const children: ReturnType<typeof child>[] = [];
  const args: readonly string[][] = [];
  let startedAt = control.startedAt;
  const dependencies = {
    checkpoint: {
      load: async () => {
        try {
          return JSON.parse(
            await readLogFile(
              path.join(directory, "followers.json"),
              256 * 1024,
            ),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      },
      save: (value: unknown) =>
        writeLogJson(path.join(directory, "followers.json"), value),
    },
    autoPoll: false,
    now: () => Date.parse("2026-01-02T00:00:00Z"),
    emit: (event: DevelopmentObservationInput) => events.push(event),
    command: async (command: readonly string[]) =>
      command[0] === "ps"
        ? JSON.stringify({ ID: id })
        : JSON.stringify({
            Config: {
              Labels: labels,
              Cmd: [
                "node",
                "node_modules/aws-studio/scripts/run-service.ts",
                "fixture",
                "--",
                "node",
                "index.js",
              ],
            },
            State: { Running: true, StartedAt: startedAt },
          }),
    follow: (command: readonly string[]) => {
      (args as string[][]).push([...command]);
      const process = child();
      children.push(process);
      return process as unknown as ChildProcess;
    },
  };
  let follower = followDevelopmentComposeOutput(
    { repositoryRoot: root, projectName: control.composeProject, config },
    control,
    dependencies,
  );
  try {
    await follower.inspect();
    assert.equal(children.length, 1);
    children[0]!.stdout.write("2026-01-01T01:00:00.000000001Z useful line\n");
    children[0]!.stdout.write("2026-01-01T01:00:00.000000001Z useful line\n");
    children[0]!.kill();
    startedAt = "2026-01-01T02:00:00.000Z";
    await follower.inspect();
    assert.equal(children.length, 2);
    children[1]!.stdout.write(
      "2026-01-01T01:00:00.000000001Z useful line\n2026-01-01T01:00:00.000000001Z useful line\n",
    );
    children[1]!.stderr.write("2026-01-01T02:00:01.000000001Z final partial");
    await follower.close();
    assert.equal(
      events.filter(
        (event) =>
          event.kind === "process.output" &&
          event.message?.includes("useful line"),
      ).length,
      2,
      "real repeated lines survive; replay copies do not",
    );
    assert.ok(events.some((event) => event.message === "final partial"));
    const checkpoint = await readFile(
      path.join(directory, "followers.json"),
      "utf8",
    );
    assert.doesNotMatch(checkpoint, /useful line|final partial/);
    follower = followDevelopmentComposeOutput(
      { repositoryRoot: root, projectName: control.composeProject, config },
      control,
      dependencies,
    );
    await follower.inspect();
    assert.equal(children.length, 3);
    children[2]!.stdout.write(
      "2026-01-01T01:00:00.000000001Z useful line\n2026-01-01T01:00:00.000000001Z useful line\n",
    );
    children[2]!.stderr.write(
      "2026-01-01T02:00:01.000000001Z final partial\n2026-01-01T02:00:02.000000001Z new line\n",
    );
    assert.equal(
      events.filter((event) => event.kind === "process.output").length,
      4,
    );
    assert.ok(events.some((event) => event.kind === "collector.source_gap"));
    assert.ok(
      args.every(
        (command) => command.includes("2000") && command[0] === "logs",
      ),
    );
  } finally {
    await follower.close();
    await rm(directory, { recursive: true, force: true });
  }
});

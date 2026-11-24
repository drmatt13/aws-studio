import { testProjectRoot } from "./support/test-project";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  prepareDevelopmentObservation,
  developmentObservationComposeArgs,
  developmentComposeSummary,
} from "../../cli/dev-observation";
import {
  CombinedDevelopmentLogReader,
  readDevelopmentLogControl,
  DevelopmentLogStore,
} from "aws-studio/local/development-logs";
import { refreshDevelopmentObservation } from "../../cli/dev-observation-lifecycle.mjs";

async function fixture() {
  const root = await mkdtemp(
    path.join(realpathSync(tmpdir()), "studio-log-startup-"),
  );
  await mkdir(path.join(root, "cdk-app"));
  await writeFile(
    path.join(root, ".env"),
    "LOCAL_FRAMEWORK_DEPLOYMENT=fixture-dev\nLOCAL_FRAMEWORK_ACCOUNT=000000000000\nLOCAL_AWS_REGION=us-east-1\n",
  );
  await writeFile(
    path.join(root, "cdk-app/.env.dev"),
    "FIXTURE_PASSWORD=startup-secret-canary\n",
  );
  await writeFile(
    path.join(root, "docker-compose.yml"),
    "include: [docker-compose.services.yml]\nservices:\n  local-invocation-runner: { image: fixture }\n  local-api-dev-server: { image: fixture }\n",
  );
  await writeFile(
    path.join(root, "docker-compose.services.yml"),
    "services:\n  fixture-service: { image: fixture }\n",
  );
  await writeFile(
    path.join(root, "framework.config.ts"),
    "export default {};\n",
  );
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("diagnostics preparation binds runtime phases and adds only its dedicated cache mount", async () => {
  const f = await fixture();
  try {
    const initial = await prepareDevelopmentObservation(f.root, "database");
    assert.equal(initial.enabled, true);
    const first = readDevelopmentLogControl(f.root)!;
    assert.equal(first.binding.deployment, "fixture-dev");
    await prepareDevelopmentObservation(f.root, "refresh");
    assert.equal(
      readDevelopmentLogControl(f.root)!.runtimeSessionId,
      first.runtimeSessionId,
    );
    await prepareDevelopmentObservation(f.root, "compute");
    assert.equal(
      readDevelopmentLogControl(f.root)!.runtimeSessionId,
      first.runtimeSessionId,
    );
    const overlay = JSON.parse(await readFile(initial.overlay!, "utf8"));
    assert.equal(
      overlay.services["fixture-service"].environment
        .FRAMEWORK_DEVELOPMENT_LOG_SESSION,
      first.runtimeSessionId,
    );
    assert.equal(
      overlay.services["fixture-service"].environment
        .FRAMEWORK_DEVELOPMENT_LOGS,
      "1",
    );
    assert.equal(
      overlay.services["local-invocation-runner"].volumes[0].source,
      initial.directory,
    );
    assert.equal(
      overlay.services["local-invocation-runner"].volumes[0].target,
      "/development-logs",
    );
    assert.doesNotMatch(JSON.stringify(overlay), /startup-secret-canary|token/);
    const args = developmentObservationComposeArgs(
      f.root,
      ["compose", "watch", "--no-up"],
      {},
    );
    assert.deepEqual(args.slice(-2), ["watch", "--no-up"]);
    assert.ok(args.includes(initial.overlay!));
    assert.deepEqual(
      developmentObservationComposeArgs(f.root, ["compose", "up"], {
        COMPOSE_FILE: "custom.yml",
      }),
      ["compose", "up"],
    );
    await prepareDevelopmentObservation(f.root, "compute");
    assert.notEqual(
      readDevelopmentLogControl(f.root)!.runtimeSessionId,
      first.runtimeSessionId,
      "a fresh attempt gets a new run when no collector owns the prior one",
    );
  } finally {
    await f.dispose();
  }
});

test("development observation binds the installed Compose base and checks its declaration size", async t => {
  const f = await fixture();
  t.after(f.dispose);
  const relative = "node_modules/aws-studio/dev/compose.yml";
  const base = path.join(f.root, relative);
  await mkdir(path.dirname(base), { recursive: true });
  await writeFile(path.join(f.root, "docker-compose.yml"), `include: [${relative}, docker-compose.services.yml]\n`);
  const service = "services:\n  local-ws-dev-server: { image: fixture/base }\n";
  await writeFile(base, service);
  const first = await prepareDevelopmentObservation(f.root, "database");
  assert.equal(first.enabled, true);
  const overlay = JSON.parse(await readFile(first.overlay!, "utf8"));
  assert.equal(overlay.services["local-ws-dev-server"].environment.FRAMEWORK_DEVELOPMENT_LOG_SESSION, first.runtimeSessionId);
  await writeFile(base, service + "# updated release base\n");
  const changed = await prepareDevelopmentObservation(f.root, "refresh");
  assert.equal(changed.enabled, true);
  assert.notEqual(changed.runtimeSessionId, first.runtimeSessionId);
  await writeFile(base, "#".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await prepareDevelopmentObservation(f.root, "refresh")).enabled, false);
});

test("startup spool survives a failed startup and sanitizes split output before persistence", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareDevelopmentObservation(f.root);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(__dirname, "../../cli/dev-observation.ts"),
        "capture",
        f.root,
      ],
      {
        cwd: testProjectRoot,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk).slice(0, 2000);
    });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.write(
      JSON.stringify({
        stream: "stderr",
        chunk: Buffer.from("failure startup-secret-").toString("base64"),
      }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        stream: "stderr",
        chunk: Buffer.from(
          "canary\nAuthorization: Bearer credential-canary\n",
        ).toString("base64"),
      }) + "\n",
    );
    child.stdin.end(
      JSON.stringify({
        kind: "startup.failed",
        message: "Fixture build failed before runner startup.",
      }) + "\n",
    );
    assert.equal(await done, 0, error);
    const reader = new CombinedDevelopmentLogReader(prepared.directory!);
    const page = await reader.entries();
    assert.equal(page.collection, "stopped");
    assert.ok(page.entries.some((e) => e.kind === "startup.failed"));
    assert.doesNotMatch(
      JSON.stringify(page),
      /startup-secret-canary|credential-canary/,
    );
    assert.match(JSON.stringify(page), /redacted/);
    const control = readDevelopmentLogControl(f.root)!;
    const main = new DevelopmentLogStore(prepared.directory!, control);
    await main.initialize();
    await main.close();
    const transition = await reader.entries({
      cursor: page.nextCursor,
      direction: "newer",
    });
    assert.ok(
      transition.gaps.some((g) => g.message.includes("page was refreshed")),
    );
  } finally {
    await f.dispose();
  }
});

test("separate checkout roots isolate diagnostics even with identical Compose project names", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    for (const f of [a, b])
      await writeFile(
        path.join(f.root, ".env"),
        "COMPOSE_PROJECT_NAME=shared-name\n",
      );
    const one = await prepareDevelopmentObservation(a.root),
      two = await prepareDevelopmentObservation(b.root);
    assert.notEqual(one.directory, two.directory);
    assert.notEqual(
      readDevelopmentLogControl(a.root)!.repositoryKey,
      readDevelopmentLogControl(b.root)!.repositoryKey,
    );
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("runtime binding follows actual exported/process inputs and declaration refresh starts a new source generation", async () => {
  const f = await fixture(),
    previous = process.env.LOCAL_FRAMEWORK_DEPLOYMENT;
  let store: DevelopmentLogStore | undefined;
  try {
    process.env.LOCAL_FRAMEWORK_DEPLOYMENT = "actual-env-override";
    await writeFile(
      path.join(f.root, "cdk-app/.env.dev"),
      "LOCAL_FRAMEWORK_DEPLOYMENT=not-the-exported-binding\n",
    );
    const prepared = await prepareDevelopmentObservation(f.root);
    const first = readDevelopmentLogControl(f.root)!;
    assert.equal(first.binding.deployment, "actual-env-override");
    store = new DevelopmentLogStore(prepared.directory!, first);
    await store.initialize();
    await writeFile(
      path.join(f.root, "framework.config.ts"),
      "export default { changed: true };\n",
    );
    await prepareDevelopmentObservation(f.root, "refresh");
    const next = readDevelopmentLogControl(f.root)!;
    assert.notEqual(next.runtimeSessionId, first.runtimeSessionId);
    assert.notEqual(next.declarationDigest, first.declarationDigest);
    const overlay = JSON.parse(await readFile(prepared.overlay!, "utf8"));
    assert.equal(
      overlay.services["local-invocation-runner"].environment
        .FRAMEWORK_DEVELOPMENT_LOG_SESSION,
      next.runtimeSessionId,
    );
    assert.equal(
      (await new CombinedDevelopmentLogReader(prepared.directory!).runs()).find(
        (run) => run.runtimeSessionId === first.runtimeSessionId,
      )?.declarationDigest,
      first.declarationDigest,
    );
  } finally {
    if (previous === undefined) delete process.env.LOCAL_FRAMEWORK_DEPLOYMENT;
    else process.env.LOCAL_FRAMEWORK_DEPLOYMENT = previous;
    await store?.close();
    await f.dispose();
  }
});

test("copied recent control files cannot reuse another checkout's runtime identity", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    await prepareDevelopmentObservation(a.root, "database");
    const first = readDevelopmentLogControl(a.root)!;
    await mkdir(path.join(b.root, ".framework/local"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      path.join(b.root, ".framework/local/development-logs.json"),
      JSON.stringify(first),
      { mode: 0o600 },
    );
    await prepareDevelopmentObservation(b.root, "refresh");
    const next = readDevelopmentLogControl(b.root)!;
    assert.notEqual(next.runtimeSessionId, first.runtimeSessionId);
    assert.notEqual(next.repositoryKey, first.repositoryKey);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("startup capture reports unavailable storage through its bounded parent status pipe", async () => {
  const f = await fixture();
  let owner: DevelopmentLogStore | undefined;
  try {
    const prepared = await prepareDevelopmentObservation(f.root),
      binding = readDevelopmentLogControl(f.root)!;
    owner = new DevelopmentLogStore(
      path.join(prepared.directory!, "bootstrap"),
      binding,
    );
    await owner.initialize();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(__dirname, "../../cli/dev-observation.ts"),
        "capture",
        f.root,
      ],
      {
        cwd: testProjectRoot,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let status = "";
    child.stdout.on("data", (chunk) => {
      status += String(chunk);
    });
    child.stdin.end();
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exit, 0);
    assert.equal(status, "unavailable\n");
    assert.doesNotMatch(status, /token|startup-secret-canary|\.cache/);
  } finally {
    await owner?.close();
    await f.dispose();
  }
});

test("a declaration change during generation rotates the bootstrap pipe before later startup output", async () => {
  const f = await fixture();
  const start = () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(__dirname, "../../cli/dev-observation.ts"),
        "capture",
        f.root,
      ],
      {
        cwd: testProjectRoot,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const ready = new Promise<void>((resolve, reject) => {
      let status = "";
      child.stdout.on("data", (chunk) => {
        status += String(chunk);
        if (status.includes("ready\n")) resolve();
        else if (status.includes("unavailable\n"))
          reject(new Error("Bootstrap fixture unavailable"));
      });
      child.once("error", reject);
      child.once("close", () => {
        if (!status.includes("ready\n"))
          reject(new Error("Bootstrap fixture closed before readiness"));
      });
    });
    return { child, done, ready };
  };
  let capture: ReturnType<typeof start> | undefined;
  try {
    const initial = await prepareDevelopmentObservation(f.root),
      firstId = initial.runtimeSessionId!;
    capture = start();
    await capture.ready;
    capture.child.stdin.write(
      JSON.stringify({
        kind: "startup.generated",
        message: "Initial generation output",
      }) + "\n",
    );
    await writeFile(
      path.join(f.root, "framework.config.ts"),
      "export default { changedDuringStartup: true };\n",
    );
    const changed = await refreshDevelopmentObservation({
      previousRunId: firstId,
      prepare: () => prepareDevelopmentObservation(f.root, "refresh"),
      record: (event) => {
        capture!.child.stdin.write(JSON.stringify(event) + "\n");
      },
      close: async () => {
        capture!.child.stdin.end();
        assert.equal(await capture!.done, 0);
        capture = undefined;
      },
      start: async () => {
        capture = start();
        await capture.ready;
      },
    });
    assert.equal(changed, true);
    const secondId = readDevelopmentLogControl(f.root)!.runtimeSessionId;
    assert.notEqual(secondId, firstId);
    capture!.child.stdin.end(
      JSON.stringify({
        kind: "startup.failed",
        message: "Later Compose failure belongs to the new source generation",
      }) + "\n",
    );
    assert.equal(await capture!.done, 0);
    capture = undefined;
    const reader = new CombinedDevelopmentLogReader(initial.directory!);
    const first = await reader.entries({ runId: firstId }),
      second = await reader.entries({ runId: secondId });
    assert.ok(
      first.entries.some((event) => event.kind === "startup.source-changed"),
    );
    assert.ok(!first.entries.some((event) => event.kind === "startup.failed"));
    assert.ok(second.entries.some((event) => event.kind === "startup.failed"));
  } finally {
    if (capture) {
      capture.child.stdin.end();
      await capture.done;
    }
    await f.dispose();
  }
});

test("failed optional overlay preparation preserves the previous runtime capability", async () => {
  const f = await fixture();
  try {
    await prepareDevelopmentObservation(f.root);
    const previous = readDevelopmentLogControl(f.root)!;
    await writeFile(
      path.join(f.root, "docker-compose.override.yml"),
      "services: [invalid: [\n",
    );
    assert.equal(
      (await prepareDevelopmentObservation(f.root, "refresh")).enabled,
      false,
    );
    assert.equal(
      readDevelopmentLogControl(f.root)!.runtimeSessionId,
      previous.runtimeSessionId,
    );
  } finally {
    await f.dispose();
  }
});

test("Compose bootstrap framing omits application payloads and keeps only fixed engine summaries", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareDevelopmentObservation(f.root);
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(__dirname, "../../cli/dev-observation.ts"),
        "capture",
        f.root,
      ],
      {
        cwd: testProjectRoot,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    for (const chunk of [
      "api-1 | auth-body raw-password-",
      "canary\napi-1 | Authorization: Bearer opaque-credential\n",
      "#12 DO",
      "NE 0.1s\nContainer project-api-1 Started\nUnclassified engine detail secret-canary\n",
      "Error response from daemon: opaque-secret-canary\n",
    ])
      child.stdin.write(
        JSON.stringify({
          phase: "compose",
          stream: "stdout",
          chunk: Buffer.from(chunk).toString("base64"),
        }) + "\n",
      );
    child.stdin.end();
    assert.equal(await done, 0);
    const page = await new CombinedDevelopmentLogReader(
      prepared.directory!,
    ).entries();
    const output = JSON.stringify(page);
    assert.doesNotMatch(
      output,
      /raw-password|opaque-credential|Unclassified engine detail|secret-canary|api-1/,
    );
    assert.ok(
      page.entries.some(
        (event) => event.kind === "startup.compose.output-omitted",
      ),
    );
    assert.ok(
      page.entries.some(
        (event) => event.kind === "startup.compose.build-progress",
      ),
    );
    assert.ok(
      page.entries.some((event) => event.kind === "startup.compose.lifecycle"),
    );
    assert.equal(
      page.entries.find((event) => event.kind === "startup.compose.failed")
        ?.level,
      "error",
    );
    assert.equal(
      developmentComposeSummary(
        "api-1 | Error response from daemon: password-canary",
      ),
      undefined,
    );
    assert.ok(
      !JSON.stringify(
        developmentComposeSummary(
          "Error response from daemon: password-canary",
        ),
      ).includes("password-canary"),
    );
  } finally {
    await f.dispose();
  }
});

test("overlay publication failure preserves the capability and mismatched pairs are never applied", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareDevelopmentObservation(f.root),
      previous = readDevelopmentLogControl(f.root)!;
    const original = await readFile(prepared.overlay!, "utf8"),
      invalid = JSON.parse(original);
    invalid.services[
      "local-invocation-runner"
    ].environment.FRAMEWORK_DEVELOPMENT_LOG_SESSION = "mismatched-session";
    await writeFile(prepared.overlay!, JSON.stringify(invalid));
    assert.deepEqual(
      developmentObservationComposeArgs(f.root, ["compose", "up"], {}),
      ["compose", "up"],
    );
    await rm(prepared.overlay!);
    await mkdir(prepared.overlay!);
    await writeFile(
      path.join(f.root, "framework.config.ts"),
      "export default { changesControl: true };\n",
    );
    assert.equal(
      (await prepareDevelopmentObservation(f.root, "refresh")).enabled,
      false,
    );
    assert.equal(
      readDevelopmentLogControl(f.root)!.runtimeSessionId,
      previous.runtimeSessionId,
    );
  } finally {
    await f.dispose();
  }
});

test("prepared diagnostics never alter host Compose version/help probes", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareDevelopmentObservation(f.root);
    assert.equal(prepared.enabled, true);
    for (const args of [
      ["compose", "version", "--short"],
      ["compose", "--version"],
      ["compose", "help"],
      ["compose", "--help"],
      ["compose", "watch", "--help"],
      ["compose", "config", "--help"],
    ]) assert.deepEqual(developmentObservationComposeArgs(f.root, args, {}), args);
    for (const args of [
      ["compose", "config", "--format", "json"],
      ["compose", "watch", "--no-up"],
      ["compose", "up", "--detach"],
      ["compose", "run", "--rm", "fixture-service", "tool", "--help"],
      ["compose", "exec", "fixture-service", "tool", "-h"],
    ]) {
      const actual = developmentObservationComposeArgs(f.root, args, {});
      assert.ok(actual.includes(prepared.overlay!));
      assert.deepEqual(actual.slice(-args.length + 1), args.slice(1));
    }
  } finally { await f.dispose(); }
});

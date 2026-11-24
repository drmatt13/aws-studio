import { copyStudioTestProject, studioTestScratchRoot } from "./support/source-fixture";
import { installFixtureRelease } from "./support/project-cli";
import assert from "./support/assert";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalEnvironment } from "../server/deploy/local";
import { Tools, type Runner } from "../server/deploy/process";
import { DeployService } from "../server/deploy/service";
import type { OperationContext } from "../server/deploy/registry";

function fixture(base = os.tmpdir()) {
  const root = realpathSync(mkdtempSync(path.join(base, "studio-runtime-recovery-")));
  const env = { ...process.env, COMPOSE_PROJECT_NAME: "recovery-fixture" };
  const calls: string[][] = [];
  let owner = root;
  let missingLabels = false;
  let running = true;
  let startedAt = "2099-01-01T00:00:00.000Z";
  let expected = ["api"];
  let emptyProject: string | undefined;
  let staleInfrastructure = false;
  const id = "a".repeat(12);
  // Docker revives restart-policy infrastructure (postgres, pgadmin) on its own after the engine restarts.
  const infrastructureIds = { postgres: "b".repeat(12), pgadmin: "c".repeat(12) };
  let dockerRestarted = false;
  let retainedInfrastructure = false;
  writeFileSync(path.join(root, "docker-compose.yml"), "services:\n  api: {}\n");
  writeFileSync(path.join(root, ".env"), "LOCAL_FRAMEWORK_DEPLOYMENT=example-dev\nLOCAL_FRAMEWORK_ACCOUNT=123456789012\nLOCAL_AWS_REGION=us-east-1\n");
  mkdirSync(path.join(root, "client-app"));
  writeFileSync(path.join(root, "client-app", ".env.development.local"), "");
  mkdirSync(path.join(root, ".framework/local"), { recursive: true });
  writeFileSync(path.join(root, ".framework/local/resources.json"), "{}");
  const run: Runner = async command => {
    const args = [...command.args]; calls.push(args);
    let stdout = "";
    if (args[0] === "ps" && !args.some(arg => arg.startsWith("label=com.matts-aws-framework"))) {
      const row = (ID: string, name: string, state: string, status: string) => JSON.stringify({ ID, Names: `recovery-fixture-${name}-1`, State: state, Status: status, Labels: `com.docker.compose.service=${name}` });
      const capturedProject = args.some(arg => emptyProject && arg === `label=com.docker.compose.project=${emptyProject}`);
      stdout = capturedProject ? staleInfrastructure ? [row(infrastructureIds.postgres, "postgres", "running", "Up (healthy)"), row(infrastructureIds.pgadmin, "pgadmin", "running", "Up")].join("\n") : ""
        : [dockerRestarted ? row(id, "api", "exited", "Exited (255) 3 minutes ago") : row(id, "api", running ? "running" : "exited", running ? "Up (healthy)" : "Exited (0)"),
        ...(dockerRestarted || retainedInfrastructure ? [row(infrastructureIds.postgres, "postgres", "running", "Up 3 minutes (healthy)"), row(infrastructureIds.pgadmin, "pgadmin", "running", "Up 3 minutes")] : [])].join("\n");
    }
    if (args[0] === "inspect") {
      const targets = args.slice(args.findIndex(arg => arg.startsWith("{{")) + 1);
      stdout = targets.map(target => args.includes("{{json .Config.Labels}}") ? JSON.stringify(missingLabels ? {} : {
        "com.docker.compose.project": staleInfrastructure && Object.values(infrastructureIds).includes(target) ? emptyProject : "recovery-fixture", "com.docker.compose.project.working_dir": owner,
        "com.docker.compose.project.config_files": path.join(owner, "docker-compose.yml"),
      }) : `${target}|${retainedInfrastructure && Object.values(infrastructureIds).includes(target) ? "2000-01-01T00:00:00.000Z" : startedAt}`).join("\n");
    }
    if (args.includes("compose") && args.includes("config")) stdout = JSON.stringify({ services: Object.fromEntries(expected.map(name => [name, {}])) });
    return { code: 0, stdout, stderr: "" };
  };
  const local = new LocalEnvironment(root, new Tools(path.resolve(__dirname, "../.."), env), run, env, root, path.join(root, "state"), undefined, true);
  return { root, local, calls, fresh: () => new LocalEnvironment(root, new Tools(path.resolve(__dirname, "../.."), env), run, env, root, path.join(root, "state")),
    setForeign: () => { owner = path.dirname(root); }, setUnknown: () => { missingLabels = true; },
    setStopped: () => { running = false; }, setDockerRestarted: () => { dockerRestarted = true; }, infrastructureIds, setExpected: (names: string[]) => { expected = names; },
    setOldContainers: () => { startedAt = "2000-01-01T00:00:00.000Z"; },
    retainInfrastructure: () => { retainedInfrastructure = true; expected = ["api", "postgres", "pgadmin"]; },
    setStaleProject: (stopped = false, infrastructure = false) => { emptyProject = "stale-project"; staleInfrastructure = infrastructure; local.writeRunRecord({ project: emptyProject, profile: "old-profile", deployment: "old-dev", startedAt: "old", ...(stopped ? { stopped: true } : {}) }); },
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("owned Compose services reconnect without a Studio run record or an AWS profile", async () => {
  const f = fixture(); try {
    await f.local.assertRecoverable();
    assert.equal(f.local.runRecord(), undefined, "discovery must not invent persistent deployment state");
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every(args => ["ps", "inspect", "compose"].includes(args[0]!)));
    assert.ok(f.calls.every(args => !args.some(arg => ["up", "start", "build", "stop", "down", "volume", "run"].includes(arg))), "reconnection only reads existing compute");
  } finally { f.dispose(); }
});

for (const missing of [".env", ".framework/local/resources.json", "client-app/.env.development.local"]) test(`live compute with missing ${missing} cannot be reconnected, so it needs attention and can be stopped`, async () => {
  const f = fixture(); try {
    rmSync(path.join(f.root, missing));
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.activeContainerCount, 1, "retained compute must remain visible and stoppable");
    assert.equal(view.observationProblem, undefined);
    assert.equal(view.readiness?.state, "blocked", "there is no separate setup state: live compute that cannot be managed is a runtime that needs attention");
    assert.match(view.readiness!.message, /Stop local runtime, then start it again/);
    assert.match(view.readiness!.message, /database data is preserved/);
    await assert.rejects(() => f.local.assertRecoverable(), /needs local development settings/);
    assert.ok(f.calls.every(args => ["ps", "inspect"].includes(args[0]!)), "missing exports are detected before Compose or process startup");
    f.setStopped();
    const stopped = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(stopped.readiness?.state, "stopped", "missing ignored files are normal when compute is stopped");
  } finally { f.dispose(); }
});

test("Docker-revived infrastructure alone is not a session: the runtime is off and Docker is never asked to reconnect", async () => {
  const f = fixture(); try {
    f.setDockerRestarted();
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.activeContainerCount, 0, "postgres and pgadmin come back by restart policy; they are not application compute");
    assert.equal(view.readiness?.state, "stopped");
    assert.equal(view.startedBy, "none", "nothing is running somewhere else");
    assert.equal(view.binding, undefined);
    assert.equal(view.appUrl, undefined);
    assert.deepEqual(view.restartNeeded, []);
    assert.ok(view.services.some(service => service.name === "postgres" && service.state === "running"), "the containers stay observable");
    assert.ok(f.calls.every(args => ["ps", "inspect"].includes(args[0]!)), "an idle runtime never reads Compose configuration");
    await assert.rejects(() => f.local.assertRecoverable(), /no active (Compose services|application compute)/);
    // The development-resource guard agrees with the switch: off means off.
    await f.local.assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    // Stopping an engaged runtime still takes everything Docker holds, infrastructure included.
    assert.deepEqual((await f.local.activeContainers()).map(container => container.id).sort(), [f.infrastructureIds.pgadmin, f.infrastructureIds.postgres].sort());
    assert.deepEqual(await f.local.activeCompute(), []);
  } finally { f.dispose(); }
});

test("live compute still counts when infrastructure is also running", async () => {
  const f = fixture(); try {
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.activeContainerCount, 1);
    assert.equal(view.readiness?.state, "starting", "compute is up and support processes are not yet reattached");
    assert.equal(view.readiness?.progressing, true, "the host reattaches them: starting, not stalled");
    await assert.rejects(() => f.local.assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), /Stop local runtime/);
  } finally { f.dispose(); }
});

test("a fresh application session can reuse database infrastructure older than its exports", async () => {
  const f = fixture(); try {
    f.retainInfrastructure();
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.activeContainerCount, 1);
    assert.deepEqual(view.restartNeeded, [], "retained postgres and pgadmin do not consume refreshed AWS outputs");
    assert.equal(view.readiness?.state, "starting");
    assert.equal(view.readiness?.waiting, "support", "fresh compute can reconnect its watcher and client");
    await f.local.assertRecoverable();

    f.setOldContainers();
    const stale = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.deepEqual(stale.restartNeeded, ["api"], "stale application compute still requires a restart");
    assert.equal(stale.readiness?.state, "blocked");
    await assert.rejects(() => f.local.assertRecoverable(), /Local settings changed/);
  } finally { f.dispose(); }
});

test("missing or never-started compute is a stalled startup, not progress", async () => {
  const f = fixture(); try {
    f.setExpected(["api", "required-service"]);
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: true }, client: { running: true } });
    assert.equal(view.readiness?.state, "starting");
    assert.equal(view.readiness?.progressing, false);
  } finally { f.dispose(); }
});

test("a durable intentional stop survives a new runtime observer and does not change settings", async () => {
  const f = fixture(); try {
    const settings = readFileSync(path.join(f.root, ".env"), "utf8");
    f.local.markStopped();
    const next = new LocalEnvironment(f.root, {} as any, async () => { throw new Error("A stopped runtime must not spawn Docker."); }, {}, f.root, path.join(f.root, "state"));
    assert.equal(next.runRecord()?.stopped, true);
    await assert.rejects(() => next.assertRecoverable(), /intentionally stopped/);
    assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), settings);
    assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test("positive foreign-checkout labels are distinct from missing ownership evidence", async () => {
  for (const known of [true, false]) {
    const f = fixture(); try {
      if (known) f.setForeign(); else f.setUnknown();
      const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
      assert.equal(Boolean(view.ownershipConflict), known);
      assert.equal(view.readiness?.state, "blocked");
      assert.ok(view.observationProblem);
      assert.ok(f.calls.every(args => ["ps", "inspect"].includes(args[0]!)));
    } finally { f.dispose(); }
  }
});

test("partial startup and stopped containers never trigger implicit compute repair", async () => {
  const f = fixture(); try {
    f.setExpected(["api", "required-service"]);
    await assert.rejects(() => f.local.assertRecoverable(), /Startup is incomplete/);
    f.setStopped();
    await assert.rejects(() => f.local.assertRecoverable(), /no active Compose services/);
    assert.ok(f.calls.every(args => !args.some(arg => ["up", "start", "build", "stop", "down", "volume", "run"].includes(arg))));
  } finally { f.dispose(); }
});

test("captured destination mismatches block backend health independently of browser selection", async () => {
  const f = fixture(); try {
    f.local.writeRunRecord({ profile: "old-profile", deployment: "different-dev", account: "123456789012", region: "us-east-1", startedAt: "earlier" });
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: true }, client: { running: true } });
    assert.equal(view.readiness?.state, "blocked");
    assert.match(view.readiness!.message, /captured destination/);
    await assert.rejects(() => f.local.assertRecoverable(), /captured destination/);
  } finally { f.dispose(); }
});

test("a support process exit fails readiness promptly instead of holding recovery open", async () => {
  const f = fixture(); try {
    await assert.rejects(() => f.local.waitUntilReady(new AbortController().signal, () => ({ watch: { running: false }, client: { running: true } })), /support process stopped/);
    assert.deepEqual(f.calls, []);
  } finally { f.dispose(); }
});

test("settings written after container creation block reconnection even with the same destination", async () => {
  const f = fixture(); try {
    f.setOldContainers();
    await assert.rejects(() => f.local.assertRecoverable(), /settings changed after these containers/);
    assert.ok(f.calls.every(args => !args.some(arg => ["up", "start", "build", "stop", "down", "volume", "run"].includes(arg))));
  } finally { f.dispose(); }
});

test("intentional stop preempts startup and restores stop intent after late startup writes", async t => {
  const project = copyStudioTestProject("runtime-stop-");
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const kind of ["local-start", "local-restart"] as const) {
    const f = fixture();
    const service = new DeployService(project, () => {}, {
      stateDirectory: path.join(f.root, "owner"), env: { ...process.env, FRAMEWORK_EXPORT_DIRECTORY: f.root },
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    try {
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const startup = service.jobs.start({ kind, title: "Fixture startup", params: {}, locks: ["local"], steps: [{ label: "Paused startup", run: async step => {
        entered();
        await new Promise<void>(resolve => step.signal.addEventListener("abort", () => resolve(), { once: true }));
        service.local.writeRunRecord({ profile: "developer", deployment: "example-dev", startedAt: "late startup" });
      } }] });
      await ready;
      const stopped = await service.perform({ kind: "local-stop", params: {} });
      assert.equal((await service.jobs.wait(startup.id)).status, "cancelled");
      assert.equal((await service.jobs.wait(stopped.id)).status, "succeeded");
      assert.equal(service.local.runRecord()?.stopped, true, "late startup state cannot erase accepted stop intent");
      assert.equal(service.jobs.running().length, 0);
    } finally { await service.dispose(); f.dispose(); }
  }
});

for (const recovery of ["start", "observed-off-start", "late-http"] as const) test(recovery === "late-http"
  ? "HTTP that recovers after a reconnect timeout clears failure without reopening immediate retry"
  : `a failed reconnect does not poison a new explicit start (${recovery === "observed-off-start" ? "with" : "without"} an intervening off observation)`, async () => {
  // Resolve installed tooling through the checkout, with source coordination
  // isolated from any live or interrupted Studio session in that checkout.
  const cache = path.resolve(__dirname, "../../.cache");
  mkdirSync(cache, { recursive: true });
  const f = fixture(cache);
  let active = true;
  let answersHttp = false;
  const service = new DeployService(f.root, () => {}, {
    stateDirectory: path.join(f.root, "owner"),
    env: { ...process.env, FRAMEWORK_EXPORT_DIRECTORY: f.root, COMPOSE_PROJECT_NAME: "recovery-fixture", AWS_CONFIG_FILE: path.join(f.root, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(f.root, "credentials") },
    run: async command => {
      if (command.args[0] === "stop") active = false;
      return { code: 0, stdout: command.args[0] === "version" ? JSON.stringify({ Server: { Version: "29.0", Os: "linux" } }) : "", stderr: "" };
    },
  });
  try {
    // Keep the real admission, job, cancellation and lifecycle paths. AWS/Docker observations
    // are fixtures, and every startup command is an inert child rather than a repository script.
    const context = (service as unknown as { context: OperationContext }).context;
    const account = "123456789012", region = "us-east-1", deployment = "example-dev", profile = "developer";
    const target = { name: deployment, mode: "dev" as const, origin: "implicit" as const, account, region };
    context.targets = () => [target];
    context.profiles = async () => [{ name: profile, kind: "static" }];
    context.observer.status = async () => ({ ok: true, value: { context: { profile, account, region }, detail: {
      ...target, state: { kind: "ready" }, local: { compatible: true },
      stacks: [{ name: "fixture", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment, mode: "dev" } }],
    } } } as any);
    context.changed = () => {};
    service.tools.cli = () => ({ file: process.execPath, args: ["-e", ""], cwd: f.root, env: process.env, display: "inert startup fixture" });
    context.startManaged = kind => service.jobs.holder(kind) ?? service.jobs.start({ kind, title: kind, params: {}, locks: [kind], steps: [{ label: "Owned fixture process", run: async step => {
      await new Promise<void>(resolve => step.signal.addEventListener("abort", () => resolve(), { once: true }));
    } }] });
    service.local.services = async () => [{ id: "api", name: "api", container: "fixture-api", state: active ? "running" : "exited", oneShot: false, ports: "" }];
    service.local.activeContainers = service.local.activeCompute = async () => active ? [{ id: "api", state: "running" }] : [];
    service.local.view = async (docker, managed) => ({ project: "recovery-fixture", docker, services: await service.local.services(), ...managed,
      exported: service.local.exported(), startedBy: active ? "studio" : "none", activeContainerCount: active ? 1 : 0, restartNeeded: [],
      readiness: { state: !active ? "stopped" : managed.watch.running && managed.client.running && answersHttp ? "ready" : "starting", progressing: true, waiting: "support", observedAt: new Date().toISOString(), message: "Fixture observation" } });
    service.local.assertRecoverable = async () => { if (recovery !== "late-http") throw new Error("Fixture reconnect failed"); };
    service.local.waitUntilReady = async () => {
      if (recovery === "late-http") throw new Error("Fixture client HTTP readiness timed out");
      active = true; answersHttp = true;
    };
    Object.defineProperty(service, "observeExistingContainers", { value: true });
    await service.localStatus();
    const reconnect = service.jobs.list().find(job => job.kind === "local-attach-watch")!;
    assert.equal((await service.jobs.wait(reconnect.id)).status, "failed");
    assert.equal((await service.localStatus()).lifecycle, "attention");
    if (recovery === "late-http") {
      answersHttp = true;
      const healthy = await service.localStatus();
      assert.equal(healthy.readiness?.state, "ready");
      assert.equal(healthy.lifecycle, "running", "confirmed HTTP readiness supersedes a past timeout");
      assert.equal(healthy.recovery, undefined);
      const watcher = service.jobs.holder("local-watch")!;
      service.jobs.cancel(watcher.id);
      await service.jobs.wait(watcher.id);
      assert.equal((await service.localStatus()).lifecycle, "attention", "a watcher that immediately exits still cannot restart in a loop");
      assert.equal(service.jobs.list().filter(job => job.kind === "local-attach-watch").length, 1);
      return;
    }
    if (recovery === "observed-off-start") {
      active = false; // Docker ended the session independently; no intentional-stop flag hides its failure.
      const off = await service.localStatus();
      assert.equal(off.lifecycle, "off");
      assert.equal(off.recovery, undefined, "an ended session cannot retain a failed recovery");
    }
    const stop = await service.perform({ kind: "local-stop", params: {} });
    assert.equal((await service.jobs.wait(stop.id)).status, "succeeded");
    const start = await service.perform({ kind: "local-start", params: { deployment, profile, account, region, mode: "dev" } });
    assert.equal((await service.jobs.wait(start.id)).status, "succeeded");
    const running = await service.localStatus();
    assert.equal(running.readiness?.state, "ready");
    assert.equal(running.lifecycle, "running", "a healthy new start cannot inherit the previous session's failure");
    assert.equal(running.recovery, undefined);
    assert.equal(service.jobs.list().filter(job => job.kind === "local-attach-watch").length, 1, "the old failed generation is not retried automatically");
  } finally { await service.dispose(); f.dispose(); }
});

test("only source-disabled framework launchers may count as successfully exited services", async () => {
  const f = fixture(studioTestScratchRoot());
  try {
    f.setStopped();
    mkdirSync(path.join(f.root, "compute"), { recursive: true });
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "disabled-launcher-fixture", private: true, workspaces: [] }));
    installFixtureRelease(f.root);
    writeFileSync(path.join(f.root, "docker-compose.services.yml"), "services:\n  api:\n    command: [node, --import, tsx, node_modules/aws-studio/scripts/run-service.ts, api]\n");
    const config = `import { defineFrameworkConfig, defineNetwork } from "aws-studio/config";
const vpc = defineNetwork({ id: "application", cidr: "10.0.0.0/16", zones: 2 });
export default defineFrameworkConfig({ networks: [vpc], defaults: { lambda: { runtime: "nodejs24", packaging: "zip", architecture: "arm64", memorySize: 128, timeoutSeconds: 10, bundling: {} }, container: { architecture: "x86_64", subnet: "public" } }, http: [], webSocket: [], events: [],
services: [{ "/api/*": { id: "api", directory: "compute/services/api", methods: "*", port: 5000, deploy: "none", cloud: { vpc, subnet: "public" } } }] });
`;
    writeFileSync(path.join(f.root, "framework.config.ts"), config);
    assert.equal((await f.local.services())[0]?.disabledByDeploy, true);
    writeFileSync(path.join(f.root, "framework.config.ts"), config.replace('deploy: "none"', 'deploy: "local-only"'));
    assert.equal((await f.local.services())[0]?.disabledByDeploy, undefined, "source changes invalidate the disabled-service cache");
    assert.ok(f.calls.every(args => ["ps", "inspect"].includes(args[0]!)));
  } finally { f.dispose(); }
});

test("stale inactive capture is repaired once for every reader without retaining its AWS binding", async () => {
  const f = fixture(); try {
    f.setStaleProject();
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.project, "recovery-fixture");
    assert.equal(view.activeContainerCount, 1);
    assert.equal(view.binding, undefined);
    assert.equal(view.profile, undefined);
    assert.equal(view.startedBy, "outside");
    await f.local.assertRecoverable();
    const repaired = readFileSync(path.join(f.root, "state/local/run.json"), "utf8");
    const independent = f.fresh();
    assert.equal(independent.project, "recovery-fixture");
    assert.equal(independent.runRecord()?.deployment, "");
    assert.equal(independent.runRecord()?.profile, "");
    assert.equal(independent.runRecord()?.account, undefined);
    assert.equal(independent.runRecord()?.region, undefined);
    await assert.rejects(() => independent.assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), /Stop local runtime/);
    await independent.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(readFileSync(path.join(f.root, "state/local/run.json"), "utf8"), repaired, "ordinary observations never repeat the repair");
  } finally { f.dispose(); }
});

test("an independent mutation guard discovers active current containers before the owner observes them", async () => {
  const f = fixture(); try {
    f.setStaleProject();
    const stale = readFileSync(path.join(f.root, "state/local/run.json"), "utf8");
    const independent = f.fresh();
    await assert.rejects(() => independent.assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), /runtime is active/);
    assert.equal(readFileSync(path.join(f.root, "state/local/run.json"), "utf8"), stale, "an independent worker cannot race the owner's stop intent by rewriting metadata");
    await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(f.local.project, "recovery-fixture", "the original observer shares the repaired checkout identity");
    assert.equal(f.local.runRecord()?.deployment, "");
  } finally { f.dispose(); }
});

test("revived infrastructure in a captured project cannot hide the configured project's live compute", async () => {
  const f = fixture(); try {
    f.setStaleProject(false, true);
    const captured = readFileSync(path.join(f.root, "state/local/run.json"), "utf8");
    await assert.rejects(() => f.fresh().assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), /runtime is active/);
    assert.equal(readFileSync(path.join(f.root, "state/local/run.json"), "utf8"), captured, "the independent guard refuses without adopting a project");
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.project, "recovery-fixture");
    assert.equal(view.activeContainerCount, 1);
    assert.equal(view.readiness?.state, "starting");
    assert.equal(f.local.runRecord()?.deployment, "", "discovery drops the obsolete AWS binding");
    assert.equal(f.calls.some(args => args[0] === "stop"), false, "the old project's infrastructure is preserved");
  } finally { f.dispose(); }
});

test("revived infrastructure in a captured project does not let discovery erase an intentional stop", async () => {
  const f = fixture(); try {
    f.setStaleProject(true, true);
    const captured = readFileSync(path.join(f.root, "state/local/run.json"), "utf8");
    await assert.rejects(() => f.fresh().assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), /intentionally stopped.*active containers/);
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.activeContainerCount, undefined);
    assert.match(view.observationProblem!, /intentionally stopped.*active containers/);
    assert.equal(readFileSync(path.join(f.root, "state/local/run.json"), "utf8"), captured);
  } finally { f.dispose(); }
});

test("direct startup inventory discovers active current containers before admission", async () => {
  const f = fixture(); try {
    f.setStaleProject();
    assert.equal((await f.local.activeContainers()).length, 1);
    assert.equal(f.local.project, "recovery-fixture");
    assert.equal(f.local.runRecord()?.deployment, "");
  } finally { f.dispose(); }
});

test("a stale project's intentional stop cannot be bypassed by discovering another project", async () => {
  const f = fixture(); try {
    f.setStaleProject(true);
    const captured = readFileSync(path.join(f.root, "state/local/run.json"), "utf8");
    const view = await f.local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.equal(view.project, "stale-project");
    assert.equal(view.activeContainerCount, undefined);
    assert.match(view.observationProblem!, /intentionally stopped.*active containers/);
    assert.equal(f.local.runRecord()?.stopped, true);
    assert.equal(readFileSync(path.join(f.root, "state/local/run.json"), "utf8"), captured);
    await assert.rejects(() => f.fresh().assertStopped({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } }), /intentionally stopped.*active containers/);
    assert.equal(readFileSync(path.join(f.root, "state/local/run.json"), "utf8"), captured, "independent guards refuse the active project without erasing stop intent");
  } finally { f.dispose(); }
});

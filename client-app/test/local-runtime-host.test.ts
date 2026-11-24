import { copyStudioTestProject } from "./support/source-fixture";
import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { OperationsClient } from "../server/operations/client";
import { startCoordinator } from "../server/operations/coordinator";
import { privateEndpoint } from "../server/operations/ipc";
import type { CommandSpec, Runner } from "../server/deploy/process";
import type { DeployServiceOptions } from "../server/deploy/service";
import type { LocalProcessKind } from "../shared/operations";

let root: string;
before(() => { root = copyStudioTestProject("runtime-host-app-"); });
after(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const kinds = ["local-watch", "local-client", "local-logs"] as const;

async function eventually<T>(read: () => Promise<T> | T, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value: T;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Runtime host did not settle: ${JSON.stringify(value!)}`);
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Real IPC and real supervised child processes; Docker/AWS are never invoked. */
async function fixture(options: { readonly staleJobs?: boolean; readonly warming?: boolean; readonly controlledWatchExit?: boolean; readonly missingExports?: boolean; readonly dockerRestarted?: boolean; readonly warmupLimitMs?: number; readonly exitingLogs?: boolean } = {}) {
  const project = JSON.parse(readFileSync(path.join(root, "cdk-app", "cdk.json"), "utf8")).context?.["framework:app"];
  assert.ok(typeof project === "string" && project, "The prepared project must author its Compose name.");
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "studio-runtime-host-")));
  const state = path.join(directory, "state"), exported = path.join(directory, "exported");
  const pidLog = path.join(directory, "processes.jsonl"), inputs = path.join(directory, "inputs");
  const watchExitFile = path.join(directory, "exit-watcher");
  const port = await unusedPort();
  mkdirSync(path.join(state, "local"), { recursive: true });
  mkdirSync(path.join(exported, "client-app"), { recursive: true });
  writeFileSync(path.join(exported, ".env"), `COMPOSE_PROJECT_NAME=${project}\nLOCAL_FRAMEWORK_DEPLOYMENT=runtime-dev\nLOCAL_FRAMEWORK_ACCOUNT=123456789012\nLOCAL_AWS_REGION=us-east-1\n`);
  writeFileSync(path.join(exported, "client-app", ".env.development.local"), "VITE_FIXTURE=ready\n");
  mkdirSync(path.join(exported, ".framework/local"), { recursive: true });
  writeFileSync(path.join(exported, ".framework/local/resources.json"), "{}");
  if (options.missingExports) for (const file of [".env", "client-app/.env.development.local", ".framework/local/resources.json"]) rmSync(path.join(exported, file));
  writeFileSync(inputs, `LOCAL_DEV_URL=http://127.0.0.1:${port}\n`);
  const record = { project, profile: "unavailable-runtime-profile", deployment: "runtime-dev", account: "123456789012", region: "us-east-1", startedAt: "2020-01-01T00:00:00.000Z" };
  writeFileSync(path.join(state, "local", "run.json"), JSON.stringify(record));
  if (options.missingExports) rmSync(path.join(state, "local", "run.json"));
  if (options.staleJobs) {
    mkdirSync(path.join(state, "jobs"), { recursive: true });
    for (const kind of kinds) writeFileSync(path.join(state, "jobs", `stale-${kind}.json`), JSON.stringify({
      id: `stale-${kind}`, kind, title: "Stale fixture process", params: {}, status: "running", startedAt: record.startedAt, lastSeq: 0,
    }));
  }
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project, FRAMEWORK_EXPORT_DIRECTORY: exported, FRAMEWORK_INPUTS_FILE: inputs,
    ...(options.warmupLimitMs ? { FRAMEWORK_LOCAL_WARMUP_LIMIT_MS: String(options.warmupLimitMs) } : {}),
    AWS_CONFIG_FILE: path.join(directory, "no-aws-config"), AWS_SHARED_CREDENTIALS_FILE: path.join(directory, "no-credentials") };
  // Docker restart: the engine took the compute down (exit 255) and revived restart-policy infrastructure.
  let dockerRestarted = options.dockerRestarted === true;
  let active = !dockerRestarted;
  let warming = options.warming === true;
  let failStop = false;
  let stopGate: Promise<void> | undefined, releaseStop = () => {};
  let exitDuringObservation: OperationsClient | undefined;
  const commands: string[][] = [];
  const container = { id: "a123456789ab", createdAt: "2099-01-01T00:00:00.000Z", volume: "retained-fixture-volume" };
  const run: Runner = async command => {
    const args = [...command.args];
    commands.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "version") return ok(JSON.stringify({ Server: { Version: "29.0", Os: "linux" } }));
    if (args[0] === "context") return ok("fixture\n");
    if (args[0] === "desktop") return { code: 1, stdout: "", stderr: "No desktop" };
    if (args.includes("watch") && args.includes("--help")) return ok("--no-up\n");
    if (args[0] === "compose" && args.includes("version")) return ok("5.0.0\n");
    if (args[0] === "compose" && args.includes("config")) return ok(JSON.stringify({ services: { api: {} } }));
    if (args[0] === "ps") {
      if (!args.some(arg => arg === `label=com.docker.compose.project=${project}`)) return ok();
      const row = (ID: string, name: string, State: string, Status: string) => JSON.stringify({ ID, Names: `${project}-${name}-1`, State, Status, Labels: `com.docker.compose.service=${name}` });
      return ok([row(container.id, "api", active ? "running" : "exited", active ? warming ? "Up 1 second (health: starting)" : "Up 1 hour (healthy)" : dockerRestarted ? "Exited (255) 3 minutes ago" : "Exited (0)"),
        ...(dockerRestarted ? [row("b123456789ab", "postgres", "running", "Up 3 minutes (healthy)"), row("c123456789ab", "pgadmin", "running", "Up 3 minutes")] : [])].join("\n"));
    }
    if (args[0] === "inspect" && args.includes("{{json .Config.Labels}}")) return ok(args.slice(args.indexOf("{{json .Config.Labels}}") + 1).map(() => JSON.stringify({
      "com.docker.compose.project": project, "com.docker.compose.project.working_dir": root,
      "com.docker.compose.project.config_files": path.join(root, "docker-compose.yml"),
    })).join("\n"));
    if (args[0] === "inspect" && args.some(arg => arg.includes(".State.StartedAt"))) {
      if (exitDuringObservation) {
        const observer = exitDuringObservation;
        exitDuringObservation = undefined;
        writeFileSync(watchExitFile, "stop fixture watcher\n");
        // The local read already captured its process snapshot. Wait until the
        // real child exits before completing Docker's asynchronous observation.
        await eventually(() => observer.list(), jobs => !jobs.some(job => job.kind === "local-watch" && job.status === "running"));
      }
      return ok(`${container.id}|${container.createdAt}\n`);
    }
    if (args[0] === "stop") {
      if (stopGate) await stopGate;
      if (failStop) return { code: 1, stdout: "", stderr: "Fixture stop failed" };
      active = false; return ok();
    }
    throw new Error(`Unexpected runtime command: ${command.display}`);
  };
  const program = "const fs=require('node:fs');const [kind,file,port,exitFile,exitNow]=process.argv.slice(1);const ready=()=>{fs.appendFileSync(file,JSON.stringify({kind,pid:process.pid})+'\\n');console.log('runtime fixture '+kind);};if(kind==='local-logs'&&exitNow==='1'){ready();process.exit(0);}if(kind==='local-client'){require('node:http').createServer((req,res)=>res.end('ready')).listen(Number(port),'127.0.0.1',ready);}else{ready();setInterval(()=>{if(kind==='local-watch'&&exitFile&&fs.existsSync(exitFile))process.exit(1);},20);}";
  const managed = Object.fromEntries(kinds.map(kind => [kind, (environment: NodeJS.ProcessEnv): CommandSpec => ({
    file: process.execPath, args: ["-e", program, kind, pidLog, String(port), options.controlledWatchExit ? watchExitFile : "", options.exitingLogs ? "1" : "0"], cwd: directory, env: environment, display: `runtime fixture ${kind}`,
  })]));
  const runtime: DeployServiceOptions = { env, run, managed };
  let coordinator = await startCoordinator(root, state, { runtime });
  const clients: OperationsClient[] = [];
  const client = () => { const observer = new OperationsClient(root, state, env); clients.push(observer); return observer; };
  const processes = () => existsSync(pidLog) ? readFileSync(pidLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { kind: LocalProcessKind; pid: number }) : [];
  const managedJobs = async (observer: OperationsClient) => (await observer.list()).filter(job => kinds.includes(job.kind as typeof kinds[number]) && job.status === "running")
    .map(job => ({ kind: job.kind, id: job.id })).sort((a, b) => a.kind.localeCompare(b.kind));
  return { state, directory, exported, commands, container, client, processes, managedJobs,
    async restart() { await coordinator.close(); coordinator = await startCoordinator(root, state, { runtime }); },
    failStop() { failStop = true; },
    /** Docker restarted: compute exited 255, postgres/pgadmin came back by restart policy. */
    dockerRestart() { active = false; dockerRestarted = true; },
    holdStop() { stopGate = new Promise<void>(resolve => { releaseStop = resolve; }); },
    releaseStop() { releaseStop(); },
    finishWarming() { warming = false; },
    exitWatcherDuringObservation(observer: OperationsClient) { exitDuringObservation = observer; },
    async dispose() {
      clients.forEach(observer => observer.close());
      await coordinator.close();
      rmSync(privateEndpoint(root, state).directory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a recloned checkout with surviving compute needs attention without a failed automatic recovery, and can be stopped", { timeout: 45_000 }, async () => {
  const f = await fixture({ missingExports: true });
  try {
    const observer = f.client();
    for (const force of [false, false, true]) {
      const view = await observer.localStatus(force);
      assert.equal(view.lifecycle, "attention", "live compute that cannot be reconnected is not running, starting or off");
      assert.equal(view.readiness?.state, "blocked");
      assert.match(view.readiness!.message, /needs local development settings/);
      assert.equal(view.activeContainerCount, 1);
      assert.equal(view.recovery, undefined, "polling and Check again must not attempt recovery without settings");
    }
    assert.deepEqual(await observer.list(), []);
    assert.deepEqual(f.processes(), []);
    await f.restart();
    assert.equal((await observer.localStatus(true)).lifecycle, "attention");
    assert.deepEqual(await observer.list(), [], "a host restart must not reintroduce failed recovery jobs");
    const stopped = await observer.localPerform({ kind: "local-stop", params: {} });
    await eventually(() => observer.list(), jobs => jobs.some(job => job.id === stopped.id && job.status === "succeeded"));
    const off = await observer.localStatus(true);
    assert.equal(off.lifecycle, "off", "stop remains available without Compose exports and ends in a clean off");
    assert.equal(off.readiness?.state, "stopped");
    assert.equal(f.commands.some(args => args[0] === "compose" && args.includes("config")
      || args.some(arg => ["up", "build", "down", "rm", "volume", "prune", "sts", "cloudformation"].includes(arg))), false);
  } finally { await f.dispose(); }
});

test("checkout host reconnects simultaneous observers without replacing healthy processes or containers", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.client(), second = f.client();
    await Promise.all([first.localStatus(true), second.localStatus(true)]);
    const local = await eventually(() => first.localStatus(), value => value.readiness?.state === "ready");
    assert.equal(local.binding?.profile, "unavailable-runtime-profile", "recovery requires no selectable or valid AWS profile");
    const original = await f.managedJobs(first);
    assert.equal(original.length, 3);
    const processes = await eventually(f.processes, value => value.length === 3);
    assert.equal(new Set(processes.map(value => value.pid)).size, 3);
    assert.deepEqual(await f.managedJobs(second), original);
    first.close(); second.close();
    const reopened = f.client();
    await reopened.localStatus(true);
    assert.deepEqual(await f.managedJobs(reopened), original, "closing Studio observers does not cancel the checkout's processes");
    assert.deepEqual(f.processes(), processes, "reopening does not launch duplicate support processes");
    assert.ok((await reopened.log(original[0]!.id)).lines.some(line => line.text.includes("runtime fixture")), "logs remain observable after reconnecting");
    assert.deepEqual(f.container, { id: "a123456789ab", createdAt: "2099-01-01T00:00:00.000Z", volume: "retained-fixture-volume" });
    assert.equal(f.commands.some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume", "prune"].includes(arg))), false, "reconnection uses observation only, never container or storage mutations");
    assert.equal(f.commands.some(args => args.includes("sts") || args.includes("cloudformation") || args.some(arg => arg.endsWith("dev.mjs"))), false);
  } finally { await f.dispose(); }
});

test("checkout host restart reconciles stale jobs and resumes only missing support processes", { timeout: 45_000 }, async () => {
  const f = await fixture({ staleJobs: true });
  try {
    const observer = f.client();
    await eventually(() => observer.localStatus(), value => value.readiness?.state === "ready");
    const original = await f.managedJobs(observer);
    const stale = (await observer.list()).filter(job => job.id.startsWith("stale-"));
    assert.equal(stale.length, 3);
    assert.equal(stale.every(job => job.status === "interrupted"), true, "saved running flags are historical evidence, never current process ownership");
    await eventually(f.processes, value => value.length === 3);
    await f.restart();
    await eventually(() => observer.localStatus(true), value => value.readiness?.state === "ready");
    const recovered = await f.managedJobs(observer);
    assert.equal(recovered.length, 3);
    assert.equal(recovered.some(job => original.some(previous => previous.id === job.id)), false);
    const processes = await eventually(f.processes, value => value.length === 6);
    for (const kind of kinds) assert.equal(processes.filter(value => value.kind === kind).length, 2);
    assert.equal(f.commands.some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume"].includes(arg))), false, "host recovery never restarts containers or prepares a database");
  } finally { await f.dispose(); }
});

test("late duplicate starts from other tabs attach without exporting or recreating an active runtime", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.client(), second = f.client();
    await eventually(() => first.localStatus(), value => value.readiness?.state === "ready");
    await eventually(() => first.list(), jobs => jobs.some(job => job.kind === "local-attach-watch" && job.status === "succeeded"));
    const original = await f.managedJobs(first);
    const processes = await eventually(f.processes, value => value.length === 3);
    const starts = await Promise.all([first.localPerform({ kind: "local-start", params: {} }), second.localPerform({ kind: "local-start", params: {} })]);
    assert.equal(starts.every(job => job.kind === "local-attach-watch"), true, "an active checkout uses attach even when a stale tab submits Start");
    await eventually(() => first.list(), jobs => starts.every(start => jobs.some(job => job.id === start.id && job.status === "succeeded")));
    await first.localPerform({ kind: "local-start", params: {} });
    await assert.rejects(second.localPerform({ kind: "local-start", params: { deployment: "another-dev" } }), /another destination/);
    assert.deepEqual(await f.managedJobs(first), original);
    assert.deepEqual(f.processes(), processes);
    assert.equal(f.commands.some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume", "sts", "cloudformation"].includes(arg)) || args.some(arg => arg.endsWith("dev.mjs"))), false);
  } finally { await f.dispose(); }
});

test("unexpected watcher termination replaces only that component", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const observer = f.client();
    await eventually(() => observer.localStatus(), value => value.readiness?.state === "ready");
    await eventually(() => observer.list(), jobs => jobs.some(job => job.kind === "local-attach-watch" && job.status === "succeeded"));
    await delay(5100);
    await observer.localStatus();
    const original = await f.managedJobs(observer);
    const processes = await eventually(f.processes, value => value.length === 3);
    process.kill(processes.find(value => value.kind === "local-watch")!.pid, "SIGTERM");
    await eventually(() => f.managedJobs(observer), jobs => !jobs.some(job => job.id === original.find(value => value.kind === "local-watch")!.id));
    await eventually(() => observer.localStatus(), value => value.readiness?.state === "ready");
    const recovered = await f.managedJobs(observer);
    for (const kind of ["local-client", "local-logs"]) assert.equal(recovered.find(job => job.kind === kind)?.id, original.find(job => job.kind === kind)?.id);
    const after = await eventually(f.processes, value => value.length === 4);
    assert.equal(after.filter(value => value.kind === "local-watch").length, 2);
    assert.equal(after.filter(value => value.kind === "local-client").length, 1);
    assert.equal(after.filter(value => value.kind === "local-logs").length, 1);
    assert.equal(f.commands.some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume"].includes(arg))), false);
  } finally { await f.dispose(); }
});

test("a watcher that exits just after successful recovery cannot cause an automatic restart loop", { timeout: 45_000 }, async () => {
  const f = await fixture({ controlledWatchExit: true });
  try {
    const observer = f.client();
    await eventually(() => observer.list(), jobs => jobs.some(job => job.kind === "local-attach-watch" && job.status === "succeeded"));
    await eventually(f.processes, value => value.length === 3);
    f.exitWatcherDuringObservation(observer);
    const failed = await eventually(() => observer.localStatus(), value => value.recovery?.state === "failed");
    assert.match(failed.recovery!.message, /stopped just after reconnecting/);
    for (let index = 0; index < 3; index++) { await delay(500); await observer.localStatus(); }
    assert.equal((await observer.list()).filter(job => job.kind === "local-watch").length, 1);
    assert.equal(f.processes().filter(value => value.kind === "local-watch").length, 1);
    assert.equal(f.commands.some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume"].includes(arg))), false);
  } finally { await f.dispose(); }
});

test("warming containers are observed as starting, not 'recovered'; support reconnects when their health becomes ready", { timeout: 45_000 }, async () => {
  const f = await fixture({ warming: true });
  try {
    const observer = f.client();
    // Compute is still warming, so no reconnect can succeed: none is attempted and Activity stays clean.
    const warming = await eventually(() => observer.localStatus(), value => value.services[0]?.health === "starting");
    assert.equal(warming.lifecycle, "starting");
    assert.equal(warming.recovery, undefined);
    assert.equal(warming.watch.running, false);
    assert.equal(warming.client.running, false);
    await delay(400); await observer.localStatus();
    assert.equal((await observer.list()).some(job => job.kind === "local-attach-watch"), false, "no failed 'Reconnect local runtime' entry for compute that is merely warming");
    // Provenance is verified, so its output is followed read-only even before readiness.
    assert.deepEqual((await f.managedJobs(observer)).map(job => job.kind), ["local-logs"]);
    f.finishWarming();
    const ready = await eventually(() => observer.localStatus(), value => value.lifecycle === "running");
    assert.equal(ready.readiness?.state, "ready");
    assert.equal((await f.managedJobs(observer)).length, 3);
    const processes = await eventually(f.processes, value => value.length === 3);
    assert.equal(new Set(processes.map(value => value.kind)).size, 3);
    assert.equal(f.commands.some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume"].includes(arg))), false, "a health transition resumes support without rebuilding or restarting containers");
  } finally { await f.dispose(); }
});

test("a warm-up that never finishes is attention, not an eternal Starting", { timeout: 45_000 }, async () => {
  const f = await fixture({ warming: true, warmupLimitMs: 400 });
  try {
    const observer = f.client();
    assert.equal((await eventually(() => observer.localStatus(), value => value.services[0]?.health === "starting")).lifecycle, "starting");
    const stalled = await eventually(() => observer.localStatus(), value => value.lifecycle === "attention");
    assert.match(stalled.readiness!.message, /Waiting for local services/);
    f.finishWarming();
    assert.equal((await eventually(() => observer.localStatus(), value => value.lifecycle === "running")).readiness?.state, "ready", "and it recovers on its own once compute is healthy");
  } finally { await f.dispose(); }
});

test("intentional runtime stop remains stopped across observers and checkout host restart", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const observer = f.client();
    await eventually(() => observer.localStatus(), value => value.readiness?.state === "ready");
    const before = await eventually(f.processes, value => value.length === 3);
    const stop = await observer.localPerform({ kind: "local-stop", params: {} });
    await eventually(() => observer.list(), jobs => jobs.find(job => job.id === stop.id)?.status === "succeeded");
    assert.equal((await observer.localStatus(true)).watch.running, false);
    await f.restart();
    const after = await observer.localStatus(true);
    assert.equal(after.activeContainerCount, 0);
    assert.equal(after.watch.running, false);
    assert.equal(after.client.running, false);
    assert.deepEqual(f.processes(), before);
    assert.equal(f.commands.filter(args => args[0] === "stop").length, 1);
  } finally { await f.dispose(); }
});

test("a failed intentional stop cannot be undone by automatic recovery after host restart", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const observer = f.client();
    await eventually(() => observer.localStatus(), value => value.readiness?.state === "ready");
    const before = await eventually(f.processes, value => value.length === 3);
    f.failStop();
    const stop = await observer.localPerform({ kind: "local-stop", params: {} });
    await eventually(() => observer.list(), jobs => jobs.find(job => job.id === stop.id)?.status === "failed");
    await f.restart();
    const local = await observer.localStatus(true);
    assert.equal(local.activeContainerCount, 1, "a Docker stop failure remains honestly visible");
    assert.equal(local.lifecycle, "attention", "compute that refused to stop is on, not starting, and must not be reconnected");
    assert.equal(local.watch.running, false);
    assert.equal(local.client.running, false);
    assert.deepEqual(f.processes(), before, "persisted stop intent wins over active-container discovery");
    assert.equal(JSON.parse(readFileSync(path.join(f.state, "local", "run.json"), "utf8")).stopped, true);
  } finally { await f.dispose(); }
});

test("a Docker restart ends the session: off at once, the stranded support processes are reaped, nothing is restarted", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const observer = f.client();
    const running = await eventually(() => observer.localStatus(), value => value.lifecycle === "running");
    assert.equal(running.readiness?.state, "ready");
    assert.equal((await eventually(() => f.managedJobs(observer), jobs => jobs.length === 3)).length, 3);
    const attach = (await observer.list()).filter(job => job.kind === "local-attach-watch").length;
    const before = f.commands.length;

    f.dockerRestart();
    const off = await observer.localStatus(true);
    assert.equal(off.lifecycle, "off", "Docker restarting is off, not 'needs attention' or 'setup needed'");
    assert.equal(off.activeContainerCount, 0);
    assert.equal(off.startedBy, "none", "postgres and pgadmin are not a runtime running somewhere else");
    assert.equal(off.recovery, undefined);

    // The watcher, web client and log follower belong to a session that no longer exists.
    await eventually(async () => { await observer.localStatus(); return f.managedJobs(observer); }, jobs => jobs.length === 0);
    const settled = await observer.localStatus(true);
    assert.equal(settled.lifecycle, "off");
    assert.equal(settled.watch.running, false);
    assert.equal(settled.client.running, false);

    // ...and it stays off: no automatic reconnect is attempted against infrastructure.
    for (let poll = 0; poll < 4; poll++) { await delay(300); assert.equal((await observer.localStatus()).lifecycle, "off"); }
    assert.equal((await observer.list()).filter(job => job.kind === "local-attach-watch").length, attach, "no recovery job is created for leftover infrastructure");
    assert.equal(f.processes().length, 3, "no support process is relaunched");
    assert.equal(f.commands.slice(before).some(args => args.some(arg => ["stop", "up", "build", "down", "rm", "volume", "prune"].includes(arg))), false, "observing a Docker restart mutates no container");
    assert.equal(f.commands.slice(before).some(args => args[0] === "compose" && args.includes("config")), false, "an idle runtime never reads Compose configuration");
  } finally { await f.dispose(); }
});

test("a fresh Studio after a Docker restart reads off without ever having seen the session", { timeout: 45_000 }, async () => {
  const f = await fixture({ dockerRestarted: true });
  try {
    const observer = f.client();
    const view = await observer.localStatus(true);
    assert.equal(view.lifecycle, "off");
    assert.equal(view.activeContainerCount, 0);
    for (let poll = 0; poll < 3; poll++) { await delay(200); assert.equal((await observer.localStatus()).lifecycle, "off"); }
    assert.deepEqual(await observer.list(), [], "no failed 'Reconnect local runtime' job appears in Activity");
    assert.deepEqual(f.processes(), []);
  } finally { await f.dispose(); }
});

test("Start over Docker-revived infrastructure is a real start, never a doomed reconnect", { timeout: 45_000 }, async () => {
  const f = await fixture({ dockerRestarted: true });
  try {
    const observer = f.client();
    assert.equal((await observer.localStatus(true)).lifecycle, "off");
    // The fixture declares no deployment, so a real start is refused by its own validation. Under the old
    // behavior admission converted Start into a reconnect first, which created a job instead of this refusal.
    await assert.rejects(observer.localPerform({ kind: "local-start", params: { deployment: "runtime-dev", profile: "unavailable-runtime-profile", mode: "dev" } }),
      /is not a deployment this repository declares/);
    assert.equal((await observer.list()).some(job => job.kind === "local-attach-watch"), false);
  } finally { await f.dispose(); }
});

test("every tab sees the same stopping, then off, however it opened", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.client(), second = f.client();
    await eventually(() => first.localStatus(), value => value.lifecycle === "running");
    f.holdStop();
    const stop = await first.localPerform({ kind: "local-stop", params: {} });
    const seen = await eventually(() => second.localStatus(true), value => value.lifecycle === "stopping");
    assert.equal(seen.operation?.kind, "local-stop");
    assert.equal(seen.operation?.id, stop.id);
    const opened = f.client();   // a tab opened mid-stop
    const late = await opened.localStatus(true);
    assert.equal(late.lifecycle, "stopping");
    assert.equal(late.operation?.id, stop.id);
    f.releaseStop();
    for (const tab of [first, second, opened]) assert.equal((await eventually(() => tab.localStatus(true), value => value.lifecycle === "off")).operation, undefined);
  } finally { f.releaseStop(); await f.dispose(); }
});

test("a reopened tab or second window reads a running session as running without a start", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.client();
    await eventually(() => first.localStatus(), value => value.lifecycle === "running");
    first.close();
    for (const tab of [f.client(), f.client()]) {
      const view = await tab.localStatus(true);
      assert.equal(view.lifecycle, "running");
      assert.equal(view.operation, undefined);
    }
  } finally { await f.dispose(); }
});

test("a log follower that exits at once is bounded to each Docker container identity", { timeout: 45_000 }, async () => {
  const f = await fixture({ warming: true, exitingLogs: true });
  try {
    const observer = f.client();
    const before = await eventually(() => observer.localStatus(), value => value.services[0]?.health === "starting");
    assert.equal(before.services[0]?.containerId, f.container.id);
    await eventually(f.processes, value => value.filter(entry => entry.kind === "local-logs").length === 1);
    for (let poll = 0; poll < 8; poll++) { await delay(150); await observer.localStatus(); }
    assert.equal(f.processes().filter(entry => entry.kind === "local-logs").length, 1, "one start per observed container generation");
    f.container.id = "d123456789ab";
    const recreated = await observer.localStatus();
    assert.equal(recreated.services[0]?.container, before.services[0]?.container, "Compose reuses the display name");
    assert.equal(recreated.services[0]?.containerId, f.container.id, "the actual container identity changes");
    await eventually(f.processes, value => value.filter(entry => entry.kind === "local-logs").length === 2);
    for (let poll = 0; poll < 8; poll++) { await delay(150); await observer.localStatus(); }
    assert.equal(f.processes().filter(entry => entry.kind === "local-logs").length, 2, "a recreated container permits one new attempt without reopening a restart loop");
  } finally { await f.dispose(); }
});

test("compute started outside Studio after an intentional stop is not adopted, and says so", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const observer = f.client();
    await eventually(() => observer.localStatus(), value => value.lifecycle === "running");
    f.failStop();                                              // the stop leaves compute running, as a manual `docker compose up` would
    const stop = await observer.localPerform({ kind: "local-stop", params: {} });
    await eventually(() => observer.list(), jobs => jobs.find(job => job.id === stop.id)?.status === "failed");
    const view = await observer.localStatus(true);
    assert.equal(view.lifecycle, "attention");
    assert.match(view.readiness!.message, /intentionally stopped/);
    assert.equal(view.recovery, undefined);
  } finally { await f.dispose(); }
});

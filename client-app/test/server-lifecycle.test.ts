import { studioTestScratchRoot } from "./support/source-fixture";
import { testProjectRoot } from "../../scripts/test-project";
import { installFixtureRelease } from "./support/project-cli";
import assert from "./support/assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { callIpc, closeIpcAuthentication, privateEndpoint, type CoordinatorInfo } from "../server/operations/ipc";
import { identityAlive, inspectProcess, sameUser } from "aws-studio/source/identity";
import { withSourceWrite } from "aws-studio/source/source-gate";
import type { JobView } from "../shared/operations";
import { awaitFixturePhase } from "./support/child-readiness";

const root = path.resolve(__dirname, "../..");
const entry = pathToFileURL(path.join(root, "client-app/server/server.ts")).href;
const fixtures = path.join(studioTestScratchRoot(), ".cache/framework-studio/server-lifecycle-tests");
const coordinatorEntry = path.join(root, "client-app/server/operations/coordinator.ts");
type FixtureCoordinator = { pid: number; identity: ReturnType<typeof inspectProcess> };
const fixtureCoordinators = new Map<string, FixtureCoordinator[]>();

function fixture() {
  mkdirSync(fixtures, { recursive: true });
  return mkdtempSync(path.join(fixtures, "case-"));
}

async function removeFixture(directory: string): Promise<void> {
  const relative = path.relative(fixtures, path.resolve(directory));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "cleanup stays inside the owned fixture directory");
  const state = path.join(directory, "state");
  const coordinators = fixtureCoordinators.get(directory) ?? [];
  if (coordinators.length) {
    const endpoint = privateEndpoint(directory, state);
    for (const coordinator of coordinators) {
      assert.notEqual(coordinator.identity, undefined, `native identity of fixture coordinator ${coordinator.pid} was available at spawn`);
      if (coordinator.identity === null) continue; // Confirmed gone before the parent observed the spawn.
      assert.ok(coordinator.identity && sameUser(coordinator.identity), "the fixture coordinator belongs to this test user");
      const observed = { ...coordinator.identity!, token: "fixture-cleanup" };
      // A detached coordinator can still be importing when Studio exits, before
      // it creates any database. Await the exact spawned process's ready/dead
      // evidence, with the same bounded import budget as awaitFixturePhase.
      const readinessDeadline = Date.now() + 120_000;
      while (identityAlive(observed) !== false) {
        assert.ok(Date.now() < readinessDeadline, `fixture coordinator ${coordinator.pid} neither exited nor exposed its authenticated endpoint; retained ${directory}`);
        let info: CoordinatorInfo | undefined;
        try { info = await callIpc<CoordinatorInfo>(endpoint.socket, "/ping", undefined, 1000); }
        catch (error) { if (!["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        if (info) {
          assert.equal(info.root, directory); assert.equal(info.state, state);
          assert.ok(coordinators.some(owned => owned.pid === info!.pid), "cleanup refuses an untracked coordinator owner");
          if (info.pid === coordinator.pid) {
            assert.deepEqual(await callIpc<JobView[]>(endpoint.socket, "/operations"), [], "fixture cleanup never stops a coordinator with accepted operations");
            const alive = identityAlive(observed);
            assert.notEqual(alive, undefined, "native fixture coordinator ownership remains verifiable");
            if (alive) {
              // Production observers intentionally leave this host running. The
              // test owns this exact empty process and its disposable state.
              process.kill(coordinator.pid, "SIGTERM");
              const deadline = Date.now() + 10_000;
              while (identityAlive(observed) !== false && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
              assert.equal(identityAlive(observed), false, "the owned coordinator stopped before removing its state");
            }
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    closeIpcAuthentication(endpoint.socket);
    await rm(endpoint.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  fixtureCoordinators.delete(directory);
  // Windows may release file handles just after the child streams have closed.
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function inputTemplates(directory: string): void {
  mkdirSync(path.join(directory, "compute"), { recursive: true });
  mkdirSync(path.join(directory, "cdk-app"), { recursive: true });
  writeFileSync(path.join(directory, "cdk-app/.env.dev.template"), "SETTING=development\nTOKEN=private-template-dev\n");
  writeFileSync(path.join(directory, "cdk-app/.env.prod.template"), "SETTING=production\nTOKEN=private-template-prod\n");
}

async function studioSession(running: ReturnType<typeof start>, port: number) {
  await running.loaded;
  const deadline = Date.now() + 30_000;
  while (!running.output().includes("Framework Studio is running")) {
    assert.ok(Date.now() < deadline, running.output());
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const base = `http://127.0.0.1:${port}`, page = await (await fetch(base)).text();
  const headers = { "x-studio-token": page.match(/name="studio-token" content="([^"]+)"/)![1]!, "x-studio-protocol": page.match(/name="studio-protocol" content="([^"]+)"/)![1]!, origin: base, "content-type": "application/json" };
  return { base, headers };
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return (server.address() as { port: number }).port;
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function start(directory: string, port: number, options: { reviewPidLog?: string; waitForReviewEvaluatorsOnClose?: boolean; skipDependencyOptimization?: boolean } = {}): { child: ChildProcess; loaded: Promise<void>; waitForExit: () => Promise<number | null>; shutdown: () => Promise<number | null>; output: () => string } {
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() && !existsSync(path.join(directory, ".nvmrc"))) installFixtureRelease(directory);
  const { reviewPidLog, waitForReviewEvaluatorsOnClose, skipDependencyOptimization } = options;
  const vite = pathToFileURL(require.resolve("vite")).href;
  const gatedVite = `export * from ${JSON.stringify(vite)};
import { createServer as createVite } from ${JSON.stringify(vite)};
import { readFileSync } from 'node:fs';
export async function createServer(options) {
  const server = await createVite(${skipDependencyOptimization ? "{ ...options, optimizeDeps: { noDiscovery: true, include: [] } }" : "options"});
  if (${!waitForReviewEvaluatorsOnClose}) return server;
  const close = server.close.bind(server);
  server.close = async () => {
    try {
      const alive = () => readFileSync(${JSON.stringify(reviewPidLog)}, 'utf8').trim().split('\\n').map(Number).some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      const deadline = Date.now() + 5000;
      while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (alive()) throw new Error('Frontend cleanup waited for blocked review evaluators.');
    } finally { await close(); }
  };
  return server;
}`;
  const program = `import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, argv, options) {
  const child = originalSpawn.apply(this, arguments);
  if (command === process.execPath && Array.isArray(argv) && argv.includes(${JSON.stringify(coordinatorEntry)})
      && argv.at(-2) === ${JSON.stringify(directory)} && argv.at(-1) === ${JSON.stringify(path.join(directory, "state"))}
      && options?.cwd === ${JSON.stringify(directory)} && child.pid) {
    process.send({ phase: 'fixture-coordinator-spawn', pid: child.pid, root: ${JSON.stringify(directory)}, state: ${JSON.stringify(path.join(directory, "state"))} });
  }
  return child;
};
syncBuiltinESMExports();
${reviewPidLog ? `const originalFork = childProcess.fork;
childProcess.fork = function(...args) {
  const child = originalFork.apply(this, args);
  child.stdout?.on("data", chunk => {
    const fixturePid = /^FIXTURE_EVALUATOR_(?:dev|prod):(\\d+)$/m.exec(chunk.toString())?.[1];
    if (fixturePid) appendFileSync(${JSON.stringify(reviewPidLog)}, fixturePid + "\\n");
  });
  return child;
};
syncBuiltinESMExports();` : ""}
const { startServer } = await import(${JSON.stringify(entry)});
process.send({ phase: "modules-loaded" });
${reviewPidLog || skipDependencyOptimization ? `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { return specifier === 'vite' ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(gatedVite)}`)}, shortCircuit: true } : next(specifier, context); } });` : ""}
process.on("message", message => { if (message === "shutdown") process.emit("SIGTERM"); });
process.channel.unref();
startServer(${JSON.stringify(directory)}, ["--port", ${JSON.stringify(String(port))}]).catch(error => {
  process.stderr.write(String(error) + "\\n"); process.exitCode = 1; process.disconnect();
});`;
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", program], {
    cwd: root,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, AWS_CONFIG_FILE: path.join(directory, "aws-config"), AWS_SHARED_CREDENTIALS_FILE: path.join(directory, "aws-credentials"), AWS_LOGIN_CACHE_DIRECTORY: path.join(directory, "login-cache"), FRAMEWORK_STUDIO_STATE_DIRECTORY: path.join(directory, "state") },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const coordinators: FixtureCoordinator[] = [];
  fixtureCoordinators.set(directory, coordinators);
  child.on("message", value => {
    const message = value as { phase?: string; pid?: number; root?: string; state?: string } | null;
    if (message?.phase !== "fixture-coordinator-spawn") return;
    assert.equal(message.root, directory); assert.equal(message.state, path.join(directory, "state"));
    assert.ok(Number.isSafeInteger(message.pid) && message.pid! > 0, "fixture spawn reports a native PID");
    coordinators.push({ pid: message.pid!, identity: inspectProcess(message.pid!) });
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  let closed = false;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { closed = true; resolve(code); });
  });
  void exited.catch(() => {});
  const waitForClosed = () => new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Studio did not release its resources:\n${output}`)); }, 20_000);
    exited.then(code => { clearTimeout(timer); resolve(code); }, error => { clearTimeout(timer); reject(error); });
  });
  const loaded = awaitFixturePhase(child, "modules-loaded", () => output);
  void loaded.catch(() => {});
  const waitForExit = async () => { await loaded; return waitForClosed(); };
  const shutdown = async () => {
    await loaded.catch(() => {});
    if (!closed) {
      // Windows child.kill uses TerminateProcess; IPC dispatches the registered
      // handler. Native console Ctrl+C and forced parent death are separate checks.
      if (process.platform === "win32") { if (child.connected) child.send("shutdown"); }
      else child.kill("SIGTERM");
    }
    return waitForClosed();
  };
  return { child, loaded, waitForExit, shutdown, output: () => output };
}

test("an occupied Studio port fails before creating services or evaluator state and exits naturally", async () => {
  const directory = fixture();
  inputTemplates(directory);
  const blocker = createServer();
  const port = await listen(blocker);
  const process = start(directory, port);
  try {
    assert.equal(await process.waitForExit(), 1, process.output());
    assert.match(process.output(), /EADDRINUSE/);
    assert.equal(existsSync(path.join(directory, "state")), false);
    assert.equal(existsSync(path.join(directory, ".cache")), false);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.dev")), false);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.prod")), false);
    assert.equal(blocker.listening, true, "the caller's listener stays owned by the caller");
  } finally {
    await process.shutdown();
    await stop(blocker);
    await removeFixture(directory);
  }
});

test("interactive opening leaves missing inputs untouched and creates only the explicitly selected file", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const response = await fetch(`${base}/api/snapshot`, { headers });
    const text = await response.text();
    const state = JSON.parse(text) as { snapshot: { models: Record<string, { resources: { id: string; deploymentFile?: { exists: boolean; setupProblem?: string } }[] }> } };
    for (const mode of ["dev", "prod"]) {
      assert.equal(existsSync(path.join(directory, `cdk-app/.env.${mode}`)), false);
      const file = state.snapshot.models.dev!.resources.find(resource => resource.id === `envfile:${mode}`)!.deploymentFile!;
      assert.equal(file.exists, false);
      assert.equal(file.setupProblem, undefined);
    }
    assert.ok(state.snapshot.models.dev!.resources.some(resource => resource.id === "envfile:cdk"));
    assert.ok(!text.includes("private-template") && !running.output().includes("private-template"));
    const setup = await fetch(`${base}/api/deployment-inputs/create`, { method: "POST", headers, body: JSON.stringify({ mode: "dev" }) });
    assert.equal(setup.status, 200, await setup.text());
    assert.equal(readFileSync(path.join(directory, "cdk-app/.env.dev"), "utf8"), readFileSync(path.join(directory, "cdk-app/.env.dev.template"), "utf8"));
    const refreshed = await fetch(`${base}/api/snapshot/refresh`, { method: "POST", headers, body: "{}" });
    assert.equal(refreshed.status, 200);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.prod")), false, "refresh preserves a missing Production file");
  } finally {
    await running.shutdown();
    await removeFixture(directory);
  }
});

test("a failed first snapshot reports a terminal error instead of claiming evaluation is still running", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const coordination = path.join(directory, ".cache/framework-studio/source-gate");
  mkdirSync(coordination, { recursive: true });
  writeFileSync(path.join(coordination, "coordination.sqlite"), "invalid database", { mode: 0o600 });
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const response = await fetch(`${base}/api/snapshot`, { headers });
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string };
    assert.match(body.error, /first evaluation failed.*restart npm run studio/s);
    assert.doesNotMatch(body.error, /still running/);
    assert.equal(readFileSync(path.join(coordination, "coordination.sqlite"), "utf8"), "invalid database", "failure preserves evidence");
  } finally {
    await running.shutdown();
    await removeFixture(directory);
  }
});

test("startup releases a stopped reader and publishes its first snapshot without discarding coordination records", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const module = pathToFileURL(path.join(root, "packages/aws-studio/scripts/source/source-gate.ts")).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `import { withSourceRead } from ${JSON.stringify(module)}; await withSourceRead(${JSON.stringify(directory)}, async () => { process.exit(0); });`],
  { cwd: root, encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const { sourceCoordinationState } = await import("aws-studio/source/source-gate");
  const before = sourceCoordinationState(directory);
  assert.equal(before.status, "recovery_required");
  assert.equal(before.mode, "read");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const response = await fetch(`${base}/api/snapshot`, { headers });
    assert.equal(response.status, 200, running.output());
    const body = await response.json() as { sourcePublication: { status: string; epoch: string }; snapshot: unknown };
    assert.ok(body.snapshot);
    assert.deepEqual(body.sourcePublication, { status: "ready", epoch: before.epoch });
    assert.ok(existsSync(path.join(directory, ".cache/framework-studio/source-gate/coordination.sqlite")));
    assert.doesNotMatch(running.output(), /Refresh failed/);
  } finally {
    await running.shutdown();
    await removeFixture(directory);
  }
});

test("a warm reload held by a live source owner retains its prior graph without claiming evaluation failed", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const before = await (await fetch(`${base}/api/snapshot`, { headers })).json() as { snapshot: unknown };
    await withSourceWrite(directory, async () => {
      const refreshed = await fetch(`${base}/api/snapshot/refresh`, { method: "POST", headers, body: "{}" });
      assert.equal(refreshed.status, 200);
      const response = await fetch(`${base}/api/snapshot`, { headers });
      assert.equal(response.status, 200, "a live source hold preserves the mounted graph");
      const held = await response.json() as { snapshot: unknown; sourcePublication: { status: string }; error?: string };
      assert.deepEqual(held.snapshot, before.snapshot);
      assert.equal(held.sourcePublication.status, "busy");
      assert.equal(held.error, undefined);
    });
    assert.equal((await fetch(`${base}/api/snapshot/refresh`, { method: "POST", headers, body: "{}" })).status, 200);
    const resumed = await (await fetch(`${base}/api/snapshot`, { headers })).json() as { sourcePublication: { status: string } };
    assert.equal(resumed.sourcePublication.status, "ready");
  } finally { await running.shutdown(); await removeFixture(directory); }
});

test("a failed warm refresh invalidates clients, reports an explicit error and preserves recovery evidence", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port), controller = new AbortController();
  let listening: Promise<void> | undefined;
  try {
    const { base, headers } = await studioSession(running, port);
    assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 200);
    const stream = await fetch(`${base}/api/events`, { headers, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let events = "";
    listening = (async () => {
      for (;;) { const { done, value } = await reader.read(); if (done) return; events += decoder.decode(value, { stream: true }); }
    })();
    void listening.catch(() => {});
    const coordination = path.join(directory, ".cache/framework-studio/source-gate"), marker = path.join(coordination, "write.lock");
    mkdirSync(coordination, { recursive: true });
    writeFileSync(marker, "PRIVATE_RECOVERY_SENTINEL", { mode: 0o600 });
    assert.equal((await fetch(`${base}/api/snapshot/refresh`, { method: "POST", headers, body: "{}" })).status, 503);
    const invalidated = () => [...events.matchAll(/^event: snapshot\ndata: ([^\n]+)\n/gm)].some(match => {
      const event = JSON.parse(match[1]!); return event.revision === "" && Array.isArray(event.external) && event.external.length === 0;
    });
    const deadline = Date.now() + 5000;
    while (!invalidated() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(invalidated(), "the failed refresh invalidates the browser's cached snapshot");
    const failed = await fetch(`${base}/api/snapshot`, { headers });
    assert.equal(failed.status, 500, "a prior successful graph cannot hide evaluation failure");
    const body = await failed.json() as { error: string };
    assert.match(body.error, /Configuration evaluation failed.*Studio terminal.*restart npm run studio/s);
    assert.doesNotMatch(body.error, /PRIVATE_RECOVERY_SENTINEL|older source coordination|still running/);
    assert.equal(readFileSync(marker, "utf8"), "PRIVATE_RECOVERY_SENTINEL");
    rmSync(marker);
    assert.equal((await fetch(`${base}/api/snapshot/refresh`, { method: "POST", headers, body: "{}" })).status, 200);
    assert.equal((await fetch(`${base}/api/snapshot`, { headers })).status, 200, "a successful refresh clears the failure state");
  } finally {
    controller.abort(); await listening?.catch(() => {});
    await running.shutdown(); await removeFixture(directory);
  }
});

test("an explicit setup failure stays recoverable in Studio and retry preserves the other file", async () => {
  const directory = fixture();
  inputTemplates(directory);
  rmSync(path.join(directory, "cdk-app/.env.prod.template"));
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    const { base, headers } = await studioSession(running, port);
    const files = async () => {
      const state = await (await fetch(`${base}/api/snapshot`, { headers })).json() as { snapshot: { models: { dev: { resources: { id: string; deploymentFile?: { exists: boolean; setupProblem?: string } }[] } } } };
      return state.snapshot.models.dev.resources;
    };
    const initial = await files();
    assert.equal(initial.find(resource => resource.id === "envfile:dev")!.deploymentFile!.exists, false);
    assert.equal(initial.find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem, undefined);
    const failed = await fetch(`${base}/api/deployment-inputs/create`, { method: "POST", headers, body: JSON.stringify({ mode: "prod" }) });
    assert.equal(failed.status, 422);
    assert.match(await failed.text(), /retry setup/);
    assert.match((await files()).find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem!, /could not initialize.*\.env\.prod/);
    writeFileSync(path.join(directory, "cdk-app/.env.dev"), "TOKEN=private-user-authored\n");
    writeFileSync(path.join(directory, "cdk-app/.env.prod.template"), "SETTING=production\n");
    const repaired = await fetch(`${base}/api/deployment-inputs/create`, { method: "POST", headers, body: JSON.stringify({ mode: "prod" }) });
    assert.equal(repaired.status, 200);
    assert.deepEqual(await repaired.json(), { file: "cdk-app/.env.prod", created: true });
    assert.equal((await files()).find(resource => resource.id === "envfile:prod")!.deploymentFile!.setupProblem, undefined);
    assert.equal(readFileSync(path.join(directory, "cdk-app/.env.dev"), "utf8"), "TOKEN=private-user-authored\n");
    assert.ok(!running.output().includes("private-user-authored"));
  } finally {
    await running.shutdown();
    await removeFixture(directory);
  }
});

test("the print command observes missing inputs without initializing them", async () => {
  const directory = fixture();
  inputTemplates(directory);
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  writeFileSync(path.join(directory, "package.json"), '{"name":"studio-print-fixture","private":true}\n');
  installFixtureRelease(directory);
  try {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", path.join(root, "client-app/server/index.ts"), "--print"], {
      cwd: directory, env: { ...process.env, FRAMEWORK_STUDIO_STATE_DIRECTORY: path.join(directory, "state") }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr }));
    const printed = JSON.parse(result.stdout) as { models: Record<string, { targets: unknown[] }> };
    assert.deepEqual(printed.models.dev!.targets, [], "print evaluates the empty fixture, not its parent checkout");
    assert.deepEqual(printed.models.prod!.targets, []);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.dev")), false);
    assert.equal(existsSync(path.join(directory, "cdk-app/.env.prod")), false);
    assert.ok(!result.stdout.includes("private-template"));
  } finally { await removeFixture(directory); }
});

test("an initialization failure after binding releases the port and exits naturally", async () => {
  const directory = fixture();
  const invalidRoot = path.join(directory, "file-instead-of-checkout");
  writeFileSync(invalidRoot, "fixture");
  const reservation = createServer();
  const port = await listen(reservation);
  await stop(reservation);
  const process = start(invalidRoot, port);
  try {
    assert.equal(await process.waitForExit(), 1, process.output());
    assert.match(process.output(), /ENOTDIR/);
    const replacement = createServer();
    await listen(replacement, port);
    await stop(replacement);
  } finally {
    await process.shutdown();
    await removeFixture(directory);
  }
});

for (const { queued, ignoreTerm } of [{ queued: false, ignoreTerm: false }, { queued: true, ignoreTerm: false }, { queued: false, ignoreTerm: true }]) test(`${process.platform === "win32" ? "IPC-dispatched SIGTERM" : "SIGTERM"} during startup stops blocked evaluators${queued ? " and refuses a queued refresh" : ignoreTerm ? " even when they register SIGTERM handlers" : ""} before reporting readiness`, async () => {
  const directory = fixture();
  installFixtureRelease(directory);
  const source = `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""} console.log('FIXTURE_EVALUATOR_'+process.env.FRAMEWORK_MODE+':'+process.pid); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); export default {};`;
  writeFileSync(path.join(directory, "framework.config.ts"), source);
  const reservation = createServer(), port = await listen(reservation);
  await stop(reservation);
  const running = start(directory, port, { skipDependencyOptimization: true });
  const owned: number[] = [];
  const evaluatorPids = () => [...running.output().matchAll(/FIXTURE_EVALUATOR_(?:dev|prod):(\d+)/g)].map(match => Number(match[1]));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
  try {
    await running.loaded;
    const deadline = Date.now() + 30_000;
    while (evaluatorPids().length < 2) {
      assert.ok(Date.now() < deadline, running.output());
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    owned.push(...evaluatorPids());
    assert.ok(owned.every(alive), "both evaluators must be blocked before interruption");
    assert.ok(!running.output().includes("Framework Studio is running"));
    if (queued) {
      writeFileSync(path.join(directory, "framework.config.ts"), `${source}\n// controlled queued refresh\n`);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    assert.equal(await running.shutdown(), 0, running.output());
    assert.ok(owned.every(pid => !alive(pid)), `Owned evaluator PIDs must exit before Studio: ${owned}`);
    assert.ok(!running.output().includes("Framework Studio is running"));
    assert.equal(evaluatorPids().length, 2, "shutdown cannot launch a follow-up evaluator pair");
    const replacement = createServer(); await listen(replacement, port); await stop(replacement);
  } finally {
    running.child.kill("SIGKILL");
    await running.shutdown();
    owned.push(...evaluatorPids());
    for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
    await removeFixture(directory);
  }
});

for (const delayedFrontend of [false, true]) test(`shutdown owns blocked source-review evaluators independently of the snapshot pair${delayedFrontend ? " before frontend cleanup waits" : ""}`, async () => {
  const directory = fixture(), flag = path.join(directory, "private-review-control"), pidLog = path.join(directory, "review-owned-pids");
  installFixtureRelease(directory);
  mkdirSync(path.join(directory, "framework-config"));
  mkdirSync(path.join(directory, "compute/http/fixture"), { recursive: true });
  copyFileSync(path.join(testProjectRoot, "framework-config/defaults.ts"), path.join(directory, "framework-config/defaults.ts"));
  const source = `import{defineFrameworkConfig}from'aws-studio/config';import{defaults}from'./framework-config/defaults';import{existsSync}from'node:fs';if(existsSync(${JSON.stringify(flag)})){console.log('FIXTURE_EVALUATOR_'+process.env.FRAMEWORK_MODE+':'+process.pid);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}export default defineFrameworkConfig({defaults,http:[{'/fixture':{directory:'compute/http/fixture',methods:['GET']}}],webSocket:[],events:[],services:[]});`;
  writeFileSync(path.join(directory, "framework.config.ts"), source);
  writeFileSync(path.join(directory, "compute/http/fixture/index.ts"), 'export const lambdaHandler=async()=>({statusCode:200,body:"fixture"});');
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port, { skipDependencyOptimization: true, reviewPidLog: pidLog, waitForReviewEvaluatorsOnClose: delayedFrontend }), owned: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 30_000;
    while (!condition()) { assert.ok(Date.now() < deadline, running.output()); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await running.loaded;
    await until(() => running.output().includes("Framework Studio is running"));
    const base = `http://127.0.0.1:${port}`, page = await (await fetch(base)).text();
    const headers = { "x-studio-token": page.match(/name="studio-token" content="([^"]+)"/)![1]!, "x-studio-protocol": page.match(/name="studio-protocol" content="([^"]+)"/)![1]!, origin: base, "content-type": "application/json" };
    const state = await (await fetch(`${base}/api/snapshot`, { headers })).json() as { snapshot: { revision: string } };
    writeFileSync(flag, "block review only");
    let prematureResponse: string | undefined;
    const request = fetch(`${base}/api/edits/batch/plan`, { method: "POST", headers, body: JSON.stringify({ revision: state.snapshot.revision, edits: [{ kind: "tags", entity: "lambda:fixture", tags: { qa: "review" } }] }) })
      .then(async response => { prematureResponse = `HTTP ${response.status} ${await response.text()}`; })
      .catch(() => undefined);
    const evaluatorPids = () => existsSync(pidLog) ? readFileSync(pidLog, "utf8").trim().split("\n").map(Number) : [];
    await until(() => {
      assert.equal(prematureResponse, undefined, prematureResponse);
      return evaluatorPids().length === 2;
    });
    owned.push(...evaluatorPids());
    assert.ok(owned.every(alive));
    assert.equal(await running.shutdown(), 0, running.output());
    assert.ok(owned.every(pid => !alive(pid)), "all independently created review evaluators must exit with Studio");
    assert.equal(readFileSync(path.join(directory, "framework.config.ts"), "utf8"), source);
    await request;
  } finally {
    running.child.kill("SIGKILL");
    await running.shutdown();
    for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
    await removeFixture(directory);
  }
});


test("source history endpoints are removed and snapshots omit their history state", async () => {
  const directory = fixture();
  writeFileSync(path.join(directory, "framework.config.ts"), "export default {};\n");
  const reservation = createServer(), port = await listen(reservation); await stop(reservation);
  const running = start(directory, port);
  try {
    await running.loaded;
    const deadline = Date.now() + 30_000;
    while (!running.output().includes("Framework Studio is running")) {
      assert.ok(Date.now() < deadline, running.output());
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const base = `http://127.0.0.1:${port}`, page = await (await fetch(base)).text();
    const headers = { "x-studio-token": page.match(/name="studio-token" content="([^"]+)"/)![1]!, "x-studio-protocol": page.match(/name="studio-protocol" content="([^"]+)"/)![1]!, origin: base, "content-type": "application/json" };
    const state = await (await fetch(`${base}/api/snapshot`, { headers })).json();
    assert.equal(Object.hasOwn(state, "history"), false);
    for (const route of ["edits/undo", "edits/redo", "resources/undo", "resources/redo"]) {
      const response = await fetch(`${base}/api/${route}`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 404, `${route} must not remain a source-writing API`);
    }
  } finally {
    await running.shutdown();
    await removeFixture(directory);
  }
});

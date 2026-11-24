import assert from "./support/assert";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { StudioRuntimeActivation } from "../server/agent-runtime/activation";
import { AgentTaskService } from "../server/agent-runtime/service";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import { withSourceWriteSync } from "aws-studio/source/source-gate";
import { identityAlive, inspectProcess, sameUser } from "aws-studio/source/identity";
import type { ExecutionIdentity } from "../shared/operations";

test("managed activation restarts the pinned installation with the selected external project", async t => {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-runtime-activation-"));
  const root = path.join(base, "project"), installation = path.join(base, "installation");
  const entry = path.join(installation, "client-app/server/index.ts"), loader = path.join(installation, "node_modules/tsx/loader.mjs");
  const appEntry = path.join(root, "client-app/server/index.ts"), appLoader = path.join(root, "node_modules/tsx/loader.mjs");
  mkdirSync(path.dirname(appEntry), { recursive: true });
  mkdirSync(path.dirname(appLoader), { recursive: true });
  writeFileSync(appEntry, "export {};\n");
  writeFileSync(appLoader, "export {};\n");
  mkdirSync(path.dirname(entry), { recursive: true }); mkdirSync(path.dirname(loader), { recursive: true }); writeFileSync(loader, "export {};\n");
  const token = randomBytes(24).toString("hex"), restartKey = randomBytes(24).toString("hex");
  writeFileSync(entry, `const http=require('node:http'); const arg=flag=>process.argv[process.argv.indexOf(flag)+1]; const port=Number(arg('--port')); const server=http.createServer((req,res)=>{if(req.url==='/api/agent-runtime/restart'){if(req.headers['x-studio-token']!==${JSON.stringify(token)}||req.headers['x-studio-agent-restart']!==${JSON.stringify(restartKey)}){res.writeHead(403);res.end();return;}res.writeHead(202);res.end('{}');setTimeout(()=>server.close(()=>process.exit(0)),20);return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,activation:process.env.FRAMEWORK_STUDIO_ACTIVATION_NONCE??null,project:arg('--project'),cwd:process.cwd()}));});server.listen(port,'127.0.0.1',()=>process.stdout.write('ready'));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const first = spawn(process.execPath, [entry, "--project", root, "--port", String(port)], { cwd: installation, stdio: ["ignore", "pipe", "pipe"] });
  let nextPid: number | undefined;
  let nextIdentity: ExecutionIdentity | undefined;
  t.after(async () => {
    if (first.exitCode === null && first.signalCode === null) { const closed = new Promise(resolve => first.once("close", resolve)); first.kill("SIGTERM"); await closed; }
    if (nextIdentity && identityAlive(nextIdentity) === true && sameUser(nextIdentity)) {
      process.kill(nextIdentity.pid, "SIGTERM");
      for (let attempt = 0; attempt < 50 && identityAlive(nextIdentity) !== false; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(identityAlive(nextIdentity), false, "the owned replacement stopped before fixture cleanup");
    }
    rmSync(base, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { first.once("error", reject); first.once("exit", code => reject(new Error(`Fixture startup ${code}`))); first.stdout!.once("data", () => resolve()); });
  const identity = inspectProcess(first.pid!);
  if (!identity || !sameUser(identity)) throw new Error("The fixture process owner and creation time could not be verified.");
  const activation = new StudioRuntimeActivation(root, { installation, entry, loader }), id = randomUUID();
  const registration = { id, identity: { ...identity, token: randomUUID() }, port, token, restartKey, protocol: "fixture", entry, loader };
  assert.throws(() => activation.register({ ...registration, entry: appEntry }), /pinned Studio installation/);
  assert.throws(() => activation.register({ ...registration, loader: appLoader }), /pinned Studio installation/);
  activation.register(registration);
  await assert.rejects(activation.restart(randomUUID()), /Reconnect/);
  await activation.restart(id);
  const ready = await (await fetch(`http://127.0.0.1:${port}/_studio/runtime-ready`)).json() as { pid: number; activation: string; project: string; cwd: string };
  nextPid = ready.pid;
  const next = inspectProcess(nextPid);
  if (!next || !sameUser(next)) throw new Error("The owned replacement identity could not be verified.");
  nextIdentity = { ...next, token: randomUUID() };
  assert.notEqual(nextPid, first.pid); assert.match(ready.activation, /^[a-f0-9-]{36}$/);
  assert.equal(ready.project, root);
  assert.equal(realpathSync(ready.cwd), installation);
  await assert.rejects(activation.restart(id), /Reconnect/);
});

test("activation holds cooperative source writers and reports external drift without overwriting it", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-runtime-race-")), root = path.join(directory, "project");
  mkdirSync(path.join(root, "client-app/server"), { recursive: true });
  const file = path.join(root, "client-app/server/example.ts");
  writeFileSync(file, "export const value = 1;\n"); writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"fixture"}}');
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), completing = new Promise<void>(resolve => { finish = resolve; });
  const service = new AgentTaskService(root, path.join(directory, "state"), { canApplyRuntimeChanges: true, ownsStudioSource: true, copyDependencies: false,
    runProvider: async input => { writeFileSync(path.join(input.cwd, "client-app/server/example.ts"), "export const value = 2;\n"); return { status: "completed" }; },
    validate: async () => ({ exitCode: 0 }), integrate: async (_workspace, proposal, digest) => integrateAgentProposal(proposal, digest),
    restartStudio: async () => { started(); await completing; },
  });
  t.after(async () => { finish(); await service.close(); rmSync(directory, { recursive: true, force: true }); }); service.start();
  const task = service.submit({ provider: "codex", requestKey: "self-modification-race-fixture", prompt: "Change fixture runtime." });
  const until = async (predicate: () => boolean) => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(service.get(task.id).summary); };
  await until(() => service.get(task.id).status === "awaiting_review"); const proposal = service.proposal(task.id);
  await service.approve(task.id, proposal.digest); await until(() => service.get(task.id).status === "completed");
  service.activate(task.id, proposal.digest, "registered-instance"); await entered;
  assert.throws(() => withSourceWriteSync(root, () => writeFileSync(file, "wrong")), /active|ownership/);
  // External editors do not participate in the shared lease. Detect their edit
  // after readiness; never claim the approved bytes started or restore over it.
  writeFileSync(file, "export const value = 3; // user's later edit\n"); finish();
  await until(() => service.get(task.id).runtimeActivation?.status === "failed");
  assert.match(service.get(task.id).runtimeActivation!.detail, /source changed/);
});

test("Studio source approval and explicit runtime activation remain separate durable outcomes", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-runtime-source-")), root = path.join(directory, "project"); mkdirSync(path.join(root, "client-app/server"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"scripts":{"test":"fixture"}}'); writeFileSync(path.join(root, "client-app/server/example.ts"), "export const value = 1;\n");
  let restarts = 0;
  const service = new AgentTaskService(root, path.join(directory, "state"), { canApplyRuntimeChanges: true, ownsStudioSource: true, copyDependencies: false,
    runProvider: async input => { writeFileSync(path.join(input.cwd, "client-app/server/example.ts"), "export const value = 2;\n"); return { status: "completed" }; }, validate: async () => ({ exitCode: 0 }),
    integrate: async (_workspace, proposal, digest) => integrateAgentProposal(proposal, digest), restartStudio: async id => { assert.equal(id, "registered-instance"); restarts++; },
  });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); }); service.start();
  const task = service.submit({ provider: "codex", requestKey: "self-modification-fixture", prompt: "Change Studio fixture value." });
  const wait = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(service.get(task.id).summary); };
  await wait(() => service.get(task.id).status === "awaiting_review"); const proposal = service.proposal(task.id);
  assert.equal(proposal.activation, "restart_required"); assert.throws(() => service.activate(task.id, proposal.digest, "registered-instance"), /Only an applied/);
  await service.approve(task.id, proposal.digest); await wait(() => service.get(task.id).status === "completed"); assert.equal(restarts, 0);
  assert.equal(service.activate(task.id, proposal.digest, "registered-instance").runtimeActivation?.status, "starting");
  await wait(() => service.get(task.id).runtimeActivation?.status === "ready"); service.activate(task.id, proposal.digest, "registered-instance"); assert.equal(restarts, 1);
});

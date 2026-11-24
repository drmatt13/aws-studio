import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pinAgentRuntime } from "../server/agent-runtime/runtime-release";
import { readAgentRuntimeRelease, releaseHash } from "../server/agent-runtime/runtime-release-manifest";
import { agentEndpoint, callAgentHost, type AgentHostInfo } from "../server/agent-runtime/ipc";
import { AgentTaskClient } from "../server/agent-runtime/client";
import { processIdentity } from "aws-studio/source/identity";
import { portableProofPolicy } from "aws-studio/contract-chain/portable-identity";

test("pinned host starts with no source loader/dependencies and refuses a modified release", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-pinned-runtime-")), root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), '{"name":"disposable"}');
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child!.once("close", resolve)); child.kill("SIGTERM"); await done; }
    rmSync(directory, { recursive: true, force: true });
  });
  const release = await pinAgentRuntime(root, state);
  assert.equal(readAgentRuntimeRelease(release.directory).digest, release.digest);
  assert.deepEqual(release.contractToolchain?.policy, portableProofPolicy(), "the immutable release pins the policy actually bundled with the host");
  assert.match(release.contractToolchain?.controlDependencyDigest ?? "", /^[a-f0-9]{64}$/, "the release also pins the installed control implementation");
  assert.equal(release.contractToolchain?.projectDependencyDigest, null, "a generic host with no project lock cannot attribute proof to an installation");
  assert.ok(!release.directory.startsWith(root + path.sep));
  const command = spawn(process.execPath, [path.join(release.directory, "tether.mjs"), process.execPath, "-e", "console.log('pinned process tree')"], { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let commandOutput = "", commandError = "";
  command.stdout.on("data", chunk => { commandOutput += chunk; }); command.stderr.on("data", chunk => { commandError += chunk; });
  assert.equal(await new Promise(resolve => command.once("close", resolve)), 0, commandError);
  assert.match(commandOutput, /pinned process tree/, "the captured tether and shared native launcher run without source dependencies");
  // This source could now be replaced by an approved self-edit. The host must
  // execute its captured bundle, not consult a checkout loader at startup.
  mkdirSync(path.join(root, "client-app/server/agent-runtime"), { recursive: true });
  writeFileSync(path.join(root, "client-app/server/agent-runtime/host.ts"), 'throw new Error("changed live host");');
  const appEntry = path.join(root, "client-app/server/index.ts");
  writeFileSync(appEntry, "export {};\n");
  child = spawn(process.execPath, [release.entry, root, state, release.directory], { cwd: directory, env: { PATH: process.env.PATH, HOME: process.env.HOME,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data; });
  let info: AgentHostInfo | undefined;
  let lastError: unknown;
  const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 5000);
  while (Date.now() < deadline) {
    try { info = await callAgentHost<AgentHostInfo>(agentEndpoint(root, state), "/ping", undefined, process.platform === "win32" ? 2000 : 200); break; } catch (error) { lastError = error; }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(info, `Pinned host failed (exit=${child.exitCode}, last=${String(lastError)}): ${stderr}`); assert.equal(info.pid, child.pid);
  assert.ok(info.capabilities?.includes("contract-proof-v1"));
  assert.ok(info.capabilities?.includes("studio-restart-target-v1"));
  const workspace = realpathSync(path.resolve(__dirname, ".."));
  const id = randomUUID();
  const registration = {
    id, identity: processIdentity(id), port: 1024, protocol: "fixture",
    token: randomBytes(24).toString("hex"), restartKey: randomBytes(24).toString("hex"),
    entry: path.join(workspace, "server/index.ts"),
    loader: createRequire(path.join(workspace, "package.json")).resolve("tsx"),
  };
  await assert.rejects(callAgentHost(agentEndpoint(root, state), "/runtime/register", { ...registration, entry: appEntry }), /pinned Studio installation/);
  const client = new AgentTaskClient(root, state, () => registration);
  try { assert.deepEqual(await client.list(), { tasks: [] }); }
  finally { client.close(); }
  await assert.rejects(callAgentHost(agentEndpoint(root, state), "/not-an-agent-action", {}, 5000), /not found/);
  const closed = new Promise(resolve => child!.once("close", resolve));
  await callAgentHost(agentEndpoint(root, state), "/runtime/drain", { requestId: randomUUID(), targetDigest: release.digest, expectedToken: info.identity.token }, 5000);
  await closed;
  chmodSync(release.projector.file, 0o600); writeFileSync(release.projector.file, `${readFileSync(release.projector.file, "utf8")}\n// tampered`);
  assert.throws(() => readAgentRuntimeRelease(release.directory), /bytes changed/);
});

test("a pinned contract policy cannot be modified without invalidating the release", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-pinned-policy-")), root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), '{"name":"disposable-policy"}');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = await pinAgentRuntime(root, state), file = path.join(release.directory, "contract-policy.json");
  chmodSync(file, 0o600); writeFileSync(file, JSON.stringify({ id: "contract-chain/offline-v1", digest: "0".repeat(64) }));
  assert.throws(() => readAgentRuntimeRelease(release.directory), /bytes changed/);
});

test("policy-only legacy assets remain readable without versioned proof capability", async t => {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-legacy-contract-policy-")), root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), '{"name":"legacy-policy-fixture"}');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = await pinAgentRuntime(root, state), file = path.join(release.directory, "contract-policy.json"), manifestFile = path.join(release.directory, "release.json");
  const policy = release.contractToolchain!.policy!, bytes = JSON.stringify(policy), manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  chmodSync(file, 0o600); writeFileSync(file, bytes); manifest.files["contract-policy.json"] = releaseHash(bytes);
  manifest.digest = releaseHash(JSON.stringify({ version: 1, protocol: manifest.protocol, files: manifest.files }));
  chmodSync(manifestFile, 0o600); writeFileSync(manifestFile, JSON.stringify(manifest));
  const legacy = readAgentRuntimeRelease(release.directory);
  assert.deepEqual(legacy.contractToolchain?.policy, policy); assert.equal(legacy.contractToolchain?.controlDependencyDigest, undefined);
});

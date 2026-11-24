import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { awaitFixturePhase } from "./support/child-readiness";

test("an exit event cannot release a fixture while child handles remain open", async () => {
  // Node can emit exit before close when inherited pipes remain open. Control
  // that ordering explicitly, without leaving another process holding a pipe.
  const child = Object.assign(new EventEmitter(), {
    exitCode: 7,
    signalCode: null,
    kill: () => { throw new Error("an exited process must not be terminated again"); },
  });
  let settled = false;
  const readiness = awaitFixturePhase(child as unknown as ChildProcess, "modules-loaded", () => "import failed");
  const rejection = assert.rejects(readiness, /Fixture exited 7.*import failed/);
  void readiness.catch(() => { settled = true; });
  child.emit("exit", 7, null);
  try {
    await setImmediate();
    assert.equal(settled, false, "exit alone must not authorize fixture removal");
  } finally {
    child.emit("close", 7, null);
  }
  await rejection;
  assert.equal(settled, true);
});

test("a readiness failure releases child streams before fixture cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "process.stderr.write('fixture import failed');process.exit(7)"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let closed = false, output = "";
  child.once("close", () => { closed = true; });
  child.stdout!.resume(); child.stderr!.on("data", data => { output += data; });
  await assert.rejects(awaitFixturePhase(child, "modules-loaded", () => output), /Fixture exited 7.*fixture import failed/);
  assert.equal(closed, true, "readiness rejection cannot authorize removal before close");
});

test("a readiness deadline terminates and releases only its owned child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let closed = false;
  child.once("close", () => { closed = true; });
  child.stdout!.resume(); child.stderr!.resume();
  await assert.rejects(awaitFixturePhase(child, "modules-loaded", () => "", 100), /did not reach modules-loaded/);
  assert.equal(closed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

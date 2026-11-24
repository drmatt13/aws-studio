import assert from "./support/assert";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { currentUserSid, identityAlive, inspectProcess, isExecutionIdentity, observeExecutions, processIdentity, sameUser } from "aws-studio/source/identity";

test("retained identities distinguish POSIX owners from complete Windows SID owners", () => {
  const identity = { pid: 123, uid: 501, started: "fixture-start", token: "dispatch-token" };
  assert.equal(isExecutionIdentity(identity), true);
  assert.equal(isExecutionIdentity({ ...identity, uid: -1, userSid: "S-1-5-21-1-2-3-1001" }), true);
  for (const invalid of [
    { ...identity, uid: -1 }, { ...identity, uid: -1, userSid: "username" },
    { ...identity, userSid: "S-1-5-21-1-2-3-1001" }, { ...identity, pid: 0 },
    { ...identity, token: "" }, { ...identity, started: "" },
  ]) {
    assert.equal(isExecutionIdentity(invalid), false);
    assert.equal(identityAlive(invalid), undefined, "malformed ownership is uncertain, never proof of death");
  }
  assert.equal(inspectProcess(-1), undefined);
  assert.equal(inspectProcess(Number.NaN), undefined);
});

test("native process identity verifies owner and rejects creation-time and owner substitutions", { timeout: 30_000 }, context => {
  let identity;
  try { identity = processIdentity("native-identity-test"); }
  catch { context.skip("Host process inspection is restricted in this environment."); return; }
  assert.equal(sameUser(identity), true);
  assert.equal(identityAlive(identity), true);
  assert.equal(identityAlive({ ...identity, started: `${identity.started}-another-process` }), false);
  if (process.platform === "win32") {
    assert.equal(identity.uid, -1);
    assert.equal(identity.userSid, currentUserSid());
    assert.equal(identityAlive({ ...identity, userSid: `${identity.userSid}0` }), false);
    const systemRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = `${process.cwd()}\\.cache\\missing-identity-probe-system-root`;
      assert.equal(identityAlive(identity), undefined, "a failed native probe cannot establish death or permit a takeover");
    } finally {
      if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
    }
  } else {
    assert.equal(identity.userSid, undefined);
    assert.equal(identityAlive({ ...identity, uid: identity.uid + 1 }), false);
  }
});

test("a native child identity becomes dead only after the owned process exits", { timeout: 30_000 }, async context => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const observed = inspectProcess(child.pid!);
    if (!observed) { context.skip("Host process inspection is restricted in this environment."); return; }
    const identity = { ...observed, token: "owned-child-test" };
    assert.equal(sameUser(identity), true);
    assert.equal(identityAlive(identity), true);
    child.kill();
    await exited;
    assert.equal(identityAlive(identity), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
});

test("reconciliation observes a fresh batch without blocking timers or caching process liveness", { timeout: 30_000 }, async context => {
  let identity;
  try { identity = processIdentity("batch-observation-test"); }
  catch { context.skip("Host process inspection is restricted in this environment."); return; }
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  try {
    const observe = await observeExecutions([identity, { ...identity, token: "same-process-other-operation" }]);
    assert.equal(timerRan, true, "native process inspection leaves IPC and cancellation timers responsive");
    assert.equal(observe(identity), true);
    assert.equal(observe({ ...identity, started: "another-creation-time" }), false);
    assert.equal(observe({ ...identity, pid: identity.pid + 100000 }), undefined, "an unobserved owner is uncertain");
    assert.equal(observe({ ...identity, uid: -5 }), undefined);
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot;
      try {
        process.env.SystemRoot = `${process.cwd()}\\.cache\\missing-batch-probe-system-root`;
        assert.equal((await observeExecutions([identity]))(identity), undefined, "new failed probes do not reuse previous liveness");
      } finally {
        if (systemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = systemRoot;
      }
    }
  } finally { clearTimeout(timer); }
});

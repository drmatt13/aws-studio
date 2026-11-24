import assert from "./support/assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { JobManager } from "../server/deploy/jobs";
import type { CommandSpec } from "../server/deploy/process";
import { sourceCoordinationState, withSourceWriteSync } from "aws-studio/source/source-gate";

/**
 * The job manager over real child processes: numbered logs, steps, locks,
 * cancellation of a process tree, and what a restarted Studio reports.
 */

const scratchRoot = path.resolve(__dirname, "..", "..", ".cache");

function scratch(): string {
  mkdirSync(scratchRoot, { recursive: true });
  return mkdtempSync(path.join(scratchRoot, "studio-jobs-"));
}

function node(code: string): CommandSpec {
  return { file: process.execPath, args: ["-e", code], cwd: process.cwd(), env: process.env, display: "node -e …" };
}

test("container output is sanitized across chunks before events and disk, and stopping its follower leaves other work alone", async () => {
  const directory = scratch();
  const events: string[] = [];
  const jobs = new JobManager({ directory, emit: (event, data) => { if (event === "deploy-log") events.push(JSON.stringify(data)); } });
  try {
    const output = jobs.start({ kind: "local-logs", title: "Container logs", params: {}, locks: ["local-logs"], outputSecrets: () => ["private-value-fixture"],
      steps: [{ label: "follow", command: () => node("process.stdout.write('api | private-val'); setTimeout(()=>process.stdout.write('ue-fixture café\\n'),30); setInterval(()=>{},1000)") }] });
    const deadline = Date.now() + 5000;
    while (!jobs.log(output.id).lines.some(line => line.text.includes("café")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(jobs.log(output.id).lines.some(line => line.text === "api | [redacted] café"));
    const tooling = jobs.start({ kind: "deps-install", title: "fixture tooling", params: {}, exclusive: true, locks: [],
      steps: [{ label: "check", command: () => node("console.log('tooling complete')") }] });
    assert.equal((await jobs.wait(tooling.id)).status, "succeeded", "a read-only log follower does not hold the tooling guard");
    assert.equal(jobs.get(output.id)?.status, "running");
    jobs.cancel(output.id); await jobs.wait(output.id);
    assert.doesNotMatch(readFileSync(path.join(directory, `${output.id}.log`), "utf8"), /private-value-fixture/);
    assert.doesNotMatch(events.join("\n"), /private-value-fixture/);
    assert.equal(jobs.get(output.id)?.status, "cancelled");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("restart preserves and exposes old job history and interrupted evidence beyond former retention limits", async () => {
  const directory = scratch();
  for (let index = 0; index < 105; index++) {
    const id = `history-${index}`;
    writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ id, kind: "local-start", title: "Saved runtime", params: {},
      status: index === 0 ? "running" : "succeeded", startedAt: new Date(index * 1000).toISOString(), lastSeq: 1 }));
    writeFileSync(path.join(directory, `${id}.log`), JSON.stringify({ seq: 1, at: "saved", stream: "err", text: `retained output ${index}` }) + "\n");
  }
  const jobs = new JobManager({ directory, emit() {} });
  try {
    assert.equal(jobs.list().length, 105);
    assert.equal(jobs.get("history-0")?.status, "interrupted");
    assert.equal(jobs.log("history-0").lines[0]?.text, "retained output 0");
    for (let index = 0; index < 105; index++) {
      assert.ok(existsSync(path.join(directory, `history-${index}.json`)));
      assert.ok(existsSync(path.join(directory, `history-${index}.log`)));
    }
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("a job runs its steps in order, numbers its log and records the outcome", async () => {
  const directory = scratch();
  const events: string[] = [];
  const jobs = new JobManager({ directory, emit: (event) => events.push(event) });
  try {
    const started = jobs.start({
      kind: "export", title: "Export", params: { deployment: "my-aws-app" }, locks: ["deployment:my-aws-app"],
      steps: [
        { label: "First", command: () => node("console.log('one'); console.error('warning: two')") },
        { label: "Second", command: () => node("console.log('three')") },
      ],
    });
    assert.equal(started.status, "running");
    const done = await jobs.wait(started.id);
    assert.equal(done.status, "succeeded");
    assert.deepEqual(done.steps?.map((step) => step.status), ["done", "done"]);
    const { lines } = jobs.log(started.id);
    const texts = lines.map((line) => line.text);
    assert.ok(texts.includes("one") && texts.includes("warning: two") && texts.includes("three"), texts.join("|"));
    assert.ok(texts.indexOf("one") < texts.indexOf("three"), "step order is kept");
    assert.deepEqual(lines.map((line) => line.seq), lines.map((_line, index) => index + 1), "lines are numbered from one");
    assert.equal(lines.find((line) => line.text === "warning: two")?.stream, "err");
    assert.deepEqual(jobs.log(started.id, lines.at(-2)!.seq).lines.map((line) => line.seq), [lines.at(-1)!.seq], "a reader resumes after the last line it saw");
    assert.ok(events.includes("deploy-job") && events.includes("deploy-log"));
    assert.equal(JSON.parse(readFileSync(path.join(directory, `${started.id}.json`), "utf8")).status, "succeeded", "the record on disk follows");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("a failing step fails the job, names why and skips what follows", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const job = jobs.start({
      kind: "export", title: "Export", params: {}, locks: [],
      steps: [
        { label: "Fails", command: () => node("console.log('working'); console.error('Unable to read the stacks.'); process.exit(3)") },
        { label: "Never", command: () => node("console.log('unreachable')") },
      ],
    });
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.exitCode, 3);
    assert.equal(done.summary, "Unable to read the stacks.");
    assert.deepEqual(done.steps?.map((step) => step.status), ["failed", "skipped"]);
    assert.ok(!jobs.log(job.id).lines.some((line) => line.text === "unreachable"));
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("one change per deployment at a time: a held lock refuses a second job", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const first = jobs.start({ kind: "deploy-apply", title: "Apply", params: {}, locks: ["deployment:my-aws-app"], steps: [{ label: "Wait", command: () => node("setTimeout(() => {}, 1500)") }] });
    assert.throws(
      () => jobs.start({ kind: "destroy", title: "Delete", params: {}, locks: ["deployment:my-aws-app"], steps: [] }),
      (error: Error & { status?: number }) => error.status === 409 && /Apply is still running/.test(error.message),
    );
    const other = jobs.start({ kind: "export", title: "Other", params: {}, locks: ["deployment:my-aws-app-prod"], steps: [{ label: "Quick", command: () => node("") }] });
    assert.equal((await jobs.wait(other.id)).status, "succeeded", "another deployment is not held");
    await jobs.wait(first.id);
    const after = jobs.start({ kind: "destroy", title: "Delete", params: {}, locks: ["deployment:my-aws-app"], steps: [{ label: "Quick", command: () => node("") }] });
    assert.equal((await jobs.wait(after.id)).status, "succeeded", "the lock is released when the job ends");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("cancelling stops the running process and everything it started", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const marker = path.join(directory, "grandchild.pid");
    const parent = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(child.pid)); console.log("started"); setInterval(() => {}, 1000);`;
    const job = jobs.start({ kind: "deploy-apply", title: "Apply", params: {}, locks: ["deployment:x"], cancelNote: "A CloudFormation operation already started continues in AWS.", steps: [{ label: "Long", command: () => node(parent) }] });
    for (let attempt = 0; attempt < 100 && !jobs.log(job.id).lines.some((line) => line.text === "started"); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    const grandchild = Number(readFileSync(marker, "utf8"));
    jobs.cancel(job.id);
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "cancelled");
    assert.ok(jobs.log(job.id).lines.some((line) => /continues in AWS/.test(line.text)), "the log says what cancelling cannot stop");
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      try { process.kill(grandchild, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false, "the grandchild is gone too");
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("a job a previous Studio left running is reported interrupted, with its log", async () => {
  const directory = scratch();
  try {
    writeFileSync(path.join(directory, "old.json"), JSON.stringify({ id: "old", kind: "deploy-apply", title: "Apply my-aws-app", params: {}, status: "running", startedAt: "2026-10-17T10:00:00.000Z", lastSeq: 1, deployment: "my-aws-app" }));
    writeFileSync(path.join(directory, "old.log"), `${JSON.stringify({ seq: 1, at: "2026-10-17T10:00:01.000Z", stream: "out", text: "Deploying…" })}\n`);
    const jobs = new JobManager({ directory, emit: () => {} });
    try {
      const old = jobs.get("old");
      assert.equal(old?.status, "interrupted");
      assert.match(old?.summary ?? "", /Studio stopped while this ran/);
      assert.deepEqual(jobs.log("old").lines.map((line) => line.text), ["Deploying…"]);
      assert.equal(jobs.list()[0]?.id, "old");
    } finally { await jobs.dispose(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("in-process steps share the job's log and can skip with a reason", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const job = jobs.start({
      kind: "deploy-plan", title: "Plan", params: {}, locks: [],
      steps: [
        { label: "Check", run: async (context) => { context.log("checked", "info"); context.setPlanId("p1"); } },
        { label: "Apply", run: async () => "Review needed: production" },
      ],
    });
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.planId, "p1");
    assert.deepEqual(done.steps?.map((step) => step.status), ["done", "skipped"]);
    assert.ok(jobs.log(job.id).lines.some((line) => line.text === "Apply skipped: Review needed: production"));
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("an exclusive job (installing dependencies) runs alone, whichever starts first", async () => {
  const directory = scratch();
  const jobs = new JobManager({ directory, emit: () => {} });
  try {
    const deploy = jobs.start({ kind: "deploy-apply", title: "Apply", params: {}, locks: ["deployment:a"], steps: [{ label: "Wait", command: () => node("setTimeout(() => {}, 800)") }] });
    assert.throws(() => jobs.start({ kind: "deps-install", title: "Install dependencies", params: {}, locks: ["deps"], exclusive: true, steps: [] }), (error: Error & { status?: number }) => error.status === 409 && /Apply is still running/.test(error.message));
    await jobs.wait(deploy.id);
    const install = jobs.start({ kind: "deps-install", title: "Install dependencies", params: {}, locks: ["deps"], exclusive: true, steps: [{ label: "Wait", command: () => node("setTimeout(() => {}, 800)") }] });
    assert.throws(() => jobs.start({ kind: "export", title: "Export", params: {}, locks: ["exports"], steps: [] }), (error: Error & { status?: number }) => error.status === 409 && /Install dependencies is still running/.test(error.message));
    await jobs.wait(install.id);
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("job disposal owns and clears its bounded shutdown timeout without creating idle timers", async context => {
  const directory = scratch(), jobs = new JobManager({ directory, emit() {} });
  const set = context.mock.method(globalThis, "setTimeout"), clear = context.mock.method(globalThis, "clearTimeout");
  let finish!: () => void;
  const work = new Promise<void>(resolve => { finish = resolve; });
  try {
    await jobs.dispose();
    assert.equal(set.mock.callCount(), 0, "idle disposal needs no timeout");
    jobs.start({ kind: "export", title: "In-process fixture", params: {}, locks: [], steps: [{ label: "Work", run: () => work }] });
    const disposing = jobs.dispose();
    const timeout = set.mock.calls.find(call => call.arguments[1] === 5000)?.result;
    assert.ok(timeout, "running work has one bounded shutdown deadline");
    finish(); await disposing;
    assert.ok(clear.mock.calls.some(call => call.arguments[0] === timeout), "settled work releases its shutdown timer");
  } finally { finish(); await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ["read", "write"] as const) test(`a ${mode}-reserved job releases source before terminal events, listeners and waiters`, async () => {
  const directory = scratch(), root = path.join(directory, "source");
  mkdirSync(root);
  const observed: [string, string][] = [], acquired: string[] = [];
  const observe = (stage: string) => {
    const status = sourceCoordinationState(root).status;
    observed.push([stage, status]);
    if (status === "ready") withSourceWriteSync(root, () => { acquired.push(stage); });
  };
  const jobs = new JobManager({ directory: path.join(directory, "jobs"), emit(event, view) {
    if (event === "deploy-job" && (view as { status: string }).status !== "running") observe("terminal");
  } });
  try {
    const job = jobs.start({ kind: "export", title: "Source reservation fixture", params: {}, locks: ["source"], sourceReservation: { root, mode },
      steps: [{ label: "Read source", run: async () => {} }], onSettled: () => observe("settled") });
    assert.equal((await jobs.wait(job.id)).status, "succeeded");
    observe("wait");
    assert.deepEqual(observed, [["terminal", "ready"], ["settled", "ready"], ["wait", "ready"]]);
    assert.deepEqual(acquired, ["terminal", "settled", "wait"]);
  } finally {
    await jobs.dispose();
    await new Promise(resolve => setImmediate(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source admission failures survive a racing cancellation and listener failures do not change settlement", async () => {
  const directory = scratch(), jobs = new JobManager({ directory: path.join(directory, "jobs"), emit() {} });
  let settled = 0;
  try {
    const job = jobs.start({ kind: "export", title: "Admission failure fixture", params: {}, locks: [],
      sourceReservation: { root: path.join(directory, "missing source"), mode: "read" }, steps: [],
      onSettled: () => { settled++; throw new Error("Observer failed"); } });
    jobs.cancel(job.id);
    const done = await jobs.wait(job.id);
    assert.equal(done.status, "cancelled");
    assert.match(done.summary!, /ENOENT/);
    assert.equal(settled, 1);
    assert.equal(jobs.running().length, 0);
  } finally { await jobs.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

for (const ending of ["completion", "cancellation"] as const) test(`attached job descendants release inherited output after ${ending}`, { timeout: 20000 }, async () => {
  const directory = scratch(), marker = path.join(directory, "descendant.pid");
  const jobs = new JobManager({ directory, emit() {} });
  const descendant = `console.log('owned descendant');require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit'],windowsHide:true});process.on('SIGTERM',()=>{});setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(marker)})&&${ending === "completion"})process.exit(0)},25)`;
  let pid: number | undefined;
  try {
    const job = jobs.start({ kind: "deps-install", title: "Attached command fixture", params: {}, locks: [], steps: [{ label: "Command", command: () => node(parent) }] });
    for (let attempt = 0; attempt < 150 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    pid = Number(readFileSync(marker, "utf8"));
    if (ending === "cancellation") jobs.cancel(job.id);
    assert.equal((await jobs.wait(job.id)).status, ending === "completion" ? "succeeded" : "cancelled");
    assert.ok(jobs.log(job.id).lines.some(line => line.text === "owned descendant"));
    let alive = true;
    for (let attempt = 0; attempt < 80 && alive; attempt++) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch { alive = false; }
    }
    assert.equal(alive, false);
  } finally {
    await jobs.dispose();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Docker Desktop startup deliberately leaves its launched application independent", { timeout: 15000 }, async () => {
  const directory = scratch(), marker = path.join(directory, "desktop-fixture.pid");
  const jobs = new JobManager({ directory, emit() {} });
  const application = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const launch = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(application)}],{stdio:'ignore',windowsHide:true,detached:true}).unref();setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(marker)}))process.exit(0)},25)`;
  let pid: number | undefined;
  try {
    const job = jobs.start({ kind: "docker-start", title: "Independent application fixture", params: {}, locks: [], steps: [{ label: "Launch", command: () => node(launch) }] });
    assert.equal((await jobs.wait(job.id)).status, "succeeded");
    pid = Number(readFileSync(marker, "utf8"));
    assert.doesNotThrow(() => process.kill(pid!, 0));
    await jobs.dispose();
    assert.doesNotThrow(() => process.kill(pid!, 0), "Studio does not own an already-started Desktop application");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
    await jobs.dispose(); rmSync(directory, { recursive: true, force: true });
  }
});

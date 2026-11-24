import assert from "./support/assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCommand, start, stopTree, tethered, TETHER } from "../server/deploy/process";
import { spawnOwnedProcess, spawnWindowsJob, WINDOWS_JOB } from "aws-studio/cli/owned-process.cjs";

/**
 * The watch and the web client must not outlive Studio, however it ends: a
 * tethered program is stopped when the pipe from Studio closes, which the
 * operating system does even when Studio is killed outright.
 *
 * The program here is shaped like `npm run dev`: a process that keeps writing
 * output and has started a long-lived child of its own (Vite).
 */

const scratchRoot = path.resolve(__dirname, "..", "..", ".cache");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const forwardInput of [false, true]) test(`a tethered program and what it started stop when Studio is killed outright (forward input: ${forwardInput})`, async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-tether-"));
  const pids: number[] = [];
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    const marker = path.join(directory, "grandchild.pid");
    // Vite: started by the program, writes nothing, never exits on its own.
    const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
    // npm: starts Vite, then keeps writing to its output, which reaches Studio.
    const program = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setInterval(() => process.stdout.write("tick\\n"), 50);`;
    // Studio: reads the tether's output through a pipe, as the job manager does.
    const studio = `const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(TETHER)}, ...${JSON.stringify(forwardInput ? ["--forward-input"] : [])}, process.execPath, "-e", ${JSON.stringify(program)}], { stdio: ["pipe", "pipe", "pipe"] }); child.stdout.resume(); child.stderr.resume(); setInterval(() => {}, 1000);`;
    parent = spawn(process.execPath, ["-e", studio], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(marker, "utf8"));
    pids.push(pid);
    assert.ok(alive(pid), "the program's own child runs");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Killed outright: no handler of Studio's runs.
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(parent.pid), "/F"], { stdio: "ignore" });
    else parent.kill("SIGKILL");
    let gone = false;
    for (let attempt = 0; attempt < 80 && !gone; attempt++) {
      gone = !alive(pid);
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(gone, "what the program started stopped with Studio");
  } finally {
    if (parent?.pid && alive(parent.pid)) parent.kill("SIGKILL");
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tether preserves argument boundaries and shell metacharacters as data", async () => {
  const values = ["", "space in argument", 'embedded"quote', "trailing\\", 'slash\\\"quote', "$value;$(ignored)&|<>%PATH%!`", "unicode-☃"];
  const result = await runCommand(tethered({ file: process.execPath, args: ["-e", "console.log(JSON.stringify({args:process.argv.slice(1),transport:process.env.FRAMEWORK_STUDIO_WINDOWS_JOB_COMMAND??null}))", ...values], cwd: process.cwd(), env: process.env, display: "fixture command" }));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: values, transport: null });
});

test("a supervised executable that cannot start fails explicitly instead of hanging", async () => {
  const result = await runCommand(tethered({ file: path.join(process.cwd(), "missing-supervised-executable"), args: [], cwd: process.cwd(), env: process.env, display: "missing fixture command" }), { timeoutMs: 15000 });
  assert.equal(result.code, 127);
  assert.match(result.stderr, /could not start|ENOENT/);
});

test("Windows supervisor preserves Node's hermetic command environment and required OS defaults", { skip: process.platform !== "win32" }, async () => {
  const env = { PATH: process.env.PATH, HOME: "isolated-home", USERPROFILE: "isolated-profile" };
  const native = spawn(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let expected = "", nativeError = "";
  native.stdout.on("data", chunk => { expected += chunk; }); native.stderr.on("data", chunk => { nativeError += chunk; });
  assert.equal(await new Promise(resolve => native.once("close", resolve)), 0, nativeError);
  const child = spawnWindowsJob(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { error += chunk; });
  assert.equal(await new Promise(resolve => child.once("close", resolve)), 0, error);
  const windowsKeys = (text: string) => Object.fromEntries(Object.entries(JSON.parse(text)).map(([name, value]) => [name.toUpperCase(), value]));
  assert.deepEqual(windowsKeys(output), windowsKeys(expected), "supervisor-only values never reach the declared command");
});

test("Windows supervisor accepts an isolated process home without creating its native cache directories", { skip: process.platform !== "win32" }, async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-job-isolated-profile-")), home = path.join(directory, "empty home");
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let child: ReturnType<typeof spawnOwnedProcess> | undefined;
  let closed: Promise<number | null> | undefined;
  try {
    process.env.HOME = home; process.env.USERPROFILE = home;
    child = spawnOwnedProcess(process.execPath, ["-e", "console.log(JSON.stringify({home:process.env.HOME,profile:process.env.USERPROFILE}))"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { error += chunk; });
    closed = new Promise(resolve => child!.once("close", resolve));
    assert.equal(await closed, 0, error);
    assert.deepEqual(JSON.parse(output), { home, profile: home });
    assert.equal(existsSync(path.join(home, "AppData/Local/Temp")), false, "compiler setup must not create an authentication test home's native cache tree");
  } finally {
    for (const name of ["HOME", "USERPROFILE"] as const) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    child?.kill("SIGTERM"); if (closed) await closed;
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

for (const forwardInput of [false, true]) test(`owned commands close their descendant tree after hard parent death (input: ${forwardInput})`, { timeout: 20000 }, async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-owned-parent-"));
  const marker = path.join(directory, "descendant.pid");
  const helper = require.resolve("aws-studio/cli/owned-process.cjs");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const command = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const parentProgram = `const {spawnOwnedProcess}=require(${JSON.stringify(helper)});const child=spawnOwnedProcess(process.execPath,['-e',${JSON.stringify(command)}],{stdio:['pipe','pipe','pipe']},{forwardInput:${forwardInput}});child.stdout.resume();child.stderr.resume();setInterval(()=>{},1000)`;
  const parent = spawn(process.execPath, ["-e", parentProgram], { windowsHide: true, stdio: "ignore" });
  const parentClosed = new Promise(resolve => parent.once("close", resolve));
  let pid: number | undefined;
  try {
    for (let attempt = 0; attempt < 150 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    pid = Number(readFileSync(marker, "utf8"));
    assert.ok(alive(pid));
    parent.kill("SIGKILL"); await parentClosed;
    for (let attempt = 0; attempt < 80 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "ephemeral credential/authentication command descendants stop after owner loss");
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await parentClosed;
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owned command cancellation and input forwarding complete after the process tree closes", async () => {
  const child = spawnOwnedProcess(process.execPath, ["-e", "process.stdin.once('data',value=>console.log(value.toString().trim()));setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }, { forwardInput: true });
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.resume();
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stdin!.write("owned protocol input\n");
  try {
    for (let attempt = 0; attempt < 150 && !output.includes("owned protocol input"); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /owned protocol input/);
  } finally { child.kill("SIGTERM"); await closed; }
});

test("tether launches from Unicode working and temporary directories", async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-job spaces-λ-"));
  try {
    const result = await runCommand(tethered({ file: process.execPath, args: ["-e", "console.log(JSON.stringify(process.cwd()))"], cwd: directory,
      env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory }, display: "fixture Unicode directory" }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows supervision keeps the native compiler independent of deeply nested provider TEMP", { skip: process.platform !== "win32" }, async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-job-long-temp-"));
  const temporary = path.join(directory, ...Array.from({ length: 4 }, (_value, index) => `${index}-${"nested".repeat(8)}`));
  mkdirSync(temporary, { recursive: true });
  assert.ok(temporary.length > 260);
  try {
    const result = await runCommand(tethered({ file: process.execPath, args: ["-e", "console.log(JSON.stringify(process.env.TEMP))"], cwd: directory,
      env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }, display: "fixture deep temporary directory" }), { timeoutMs: 15_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), temporary, "the supervised command retains its declared scratch environment");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("tether forwards native protocol input without consuming or quoting it", async () => {
  const child = start(tethered({ file: process.execPath, args: ["-e", "process.stdin.once('data',value=>{console.log(JSON.stringify(value.toString()));process.exit(0)})"], cwd: process.cwd(), env: process.env, display: "fixture protocol" }, { forwardInput: true }));
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  const input = '{"text":"space $value & \\\"quote\\\""}\n';
  child.stdin!.write(input);
  const timer = setTimeout(() => stopTree(child, false), 10_000);
  try {
    assert.equal(await closed, 0, stderr);
    assert.equal(JSON.parse(stdout), input);
  } finally { clearTimeout(timer); stopTree(child, false); }
});

for (const phase of ["startup", "assignment"] as const) test(`Windows job refuses command launch when its held parent exits during ${phase}`, { skip: process.platform !== "win32", timeout: 20_000 }, async context => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-job-parent-exit-λ-"));
  const barrier = path.join(directory, "parent-handle-ready"), release = path.join(directory, "parent-handle-release");
  const command = path.join(directory, "command-started"), copiedSupervisor = path.join(directory, "windows-job.ps1");
  const supervisor = readFileSync(WINDOWS_JOB, "utf8");
  // Hold a real kernel parent handle, then end that process at either launch
  // boundary. Keep the barrier in a disposable copy, outside production code.
  const pause = `
      System.IO.File.WriteAllText(${JSON.stringify(barrier)}, "ready");
      DateTime deadline = DateTime.UtcNow.AddSeconds(10);
      while (!System.IO.File.Exists(${JSON.stringify(release)})) {
        if (DateTime.UtcNow > deadline) throw new InvalidOperationException("Test parent barrier timed out.");
        System.Threading.Thread.Sleep(10);
      }
`;
  const boundary = phase === "startup"
    ? "      // Assignment happens while suspended:"
    : "      Check(AssignProcessToJobObject(job, process.Process));";
  assert.ok(supervisor.includes(boundary));
  // PowerShell 5 needs the BOM to preserve Unicode fixture paths in this copy.
  writeFileSync(copiedSupervisor, "\ufeff" + supervisor.replace(boundary, phase === "startup" ? pause + boundary : boundary + pause));
  const parent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const parentClosed = new Promise<void>(resolve => parent.once("close", () => resolve()));
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", copiedSupervisor], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FRAMEWORK_STUDIO_WINDOWS_JOB_COMMAND: JSON.stringify({ parentPid: parent.pid, file: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(command)},'started')`] }) },
  });
  let stderr = "", didClose = false;
  child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number | null>(resolve => child.once("close", code => { didClose = true; resolve(code); }));
  try {
    for (let attempt = 0; attempt < 150 && !existsSync(barrier) && !didClose; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(existsSync(barrier), stderr || "the supervisor held its parent handle before launch");
    const cancelledAt = performance.now();
    parent.kill("SIGKILL");
    await parentClosed;
    writeFileSync(release, "release");
    assert.equal(await closed, 127, "the supervisor refused its exited parent");
    context.diagnostic(`Exited-parent refusal and teardown took ${Math.round(performance.now() - cancelledAt)} ms.`);
    assert.equal(existsSync(command), false, "the command never ran after its parent exited");
  } finally {
    writeFileSync(release, "release");
    stopTree(child, false);
    await closed;
    parent.kill("SIGKILL");
    await parentClosed;
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const ending of ["normal-exit", "cancel", "tether-death"] as const) test(`Windows job owns descendants through ${ending}`, { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-job-"));
  const marker = path.join(directory, "descendant.pid");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
  const program = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})&&${ending === "normal-exit"}){clearInterval(timer);process.exit(0)}},25)`;
  const child = start(tethered({ file: process.execPath, args: ["-e", program], cwd: directory, env: process.env, display: "fixture process tree" }));
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  child.stdout!.resume(); child.stderr!.resume();
  let pid: number | undefined;
  try {
    for (let attempt = 0; attempt < 150 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    pid = Number(readFileSync(marker, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    if (ending === "cancel") stopTree(child, false);
    if (ending === "tether-death") child.kill("SIGKILL");
    await closed;
    for (let attempt = 0; attempt < 80 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(alive(pid), false, "the job owns descendants even after their immediate parent or tether exits");
  } finally {
    stopTree(child, false);
    await closed;
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

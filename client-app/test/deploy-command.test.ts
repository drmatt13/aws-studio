import assert from "./support/assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runCommand, start, stopTree, tethered, Tools, type CommandSpec } from "../server/deploy/process";
import { engineState } from "../server/deploy/prereqs";
import { spawnOwnedProcess, spawnWindowsJob } from "aws-studio/cli/owned-process.cjs";
import { testProjectRoot } from "../../scripts/test-project";

const scratchRoot = path.resolve(__dirname, "..", "..", ".cache");
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
const specification = (args: string[], cwd = process.cwd()): CommandSpec => ({ file: process.execPath, args, cwd, env: process.env, display: "supervised probe fixture" });
async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 150 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(predicate(), "the fixture reached its expected process boundary");
}

test("nested npm commands retain their explicit target and require their script despite parent batch flags", () => {
  const inherited = { npm_config_workspace: "unrelated", NPM_CONFIG_WORKSPACES: "true", npm_config_include_workspace_root: "true", npm_config_if_present: "true", npm_config_registry: "https://registry.invalid" };
  const command = new Tools(testProjectRoot, process.env).npm(["run", "build", "--workspace", "client-app"], inherited);
  assert.ok(command, "the supported Node distribution includes npm");
  assert.deepEqual(command.args.slice(1), ["run", "build", "--workspace", "client-app"]);
  assert.equal(command.cwd, testProjectRoot);
  assert.equal(command.env.npm_config_registry, "https://registry.invalid");
  assert.equal(command.env.npm_node_execpath, command.file);
  assert.equal(command.env.npm_execpath, command.args[0]);
  assert.ok(Object.keys(command.env).every(key => !/^npm_config_(?:workspace|workspaces|include_workspace_root|if_present)$/i.test(key)));
  assert.equal(inherited.NPM_CONFIG_WORKSPACES, "true", "launching a child does not mutate the caller environment");
});

test("missing supervised probes retain the prerequisite missing classification", async () => {
  const result = await runCommand({ ...specification([]), file: path.join(process.cwd(), "missing-probe-executable") }, { timeoutMs: 15000 });
  assert.equal(result.code, 127, result.stderr);
  assert.equal(result.missing, true);
  assert.equal(engineState(result).engine, "missing");
});

test("native and owned commands reject NUL bytes before launching an executable", async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-probe-nul-")), marker = path.join(directory, "command-started");
  const command = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`];
  const cases = [
    { file: process.execPath + "\0private suffix", args: command, env: process.env },
    { file: process.execPath, args: [...command, "private\0argument"], env: process.env },
    { file: process.execPath, args: command, env: { ...process.env, ["private\0key"]: "value" } },
    // TEMP is rewritten for the supervisor and restored only in its native child.
    { file: process.execPath, args: command, env: { ...process.env, TEMP: "private\0value" } },
  ];
  const children: ChildProcess[] = [];
  try {
    for (const fixture of cases) {
      assert.throws(() => { children.push(spawn(fixture.file, fixture.args, { env: fixture.env, stdio: "ignore" })); }, TypeError);
      for (const launch of [spawnWindowsJob, spawnOwnedProcess]) {
        assert.throws(() => { children.push(launch(fixture.file, fixture.args, { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] })); },
          error => error instanceof TypeError && (process.platform !== "win32" && launch === spawnOwnedProcess || !/private/.test(error.message)));
      }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 0, "every launch rejected synchronously before returning a child");
    assert.equal(existsSync(marker), false);
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => { child.once("close", resolve); child.kill("SIGTERM"); })));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an application exit code 127 alone never means its executable is missing", async () => {
  const result = await runCommand(specification(["-e", "console.error('application failed');process.exit(127)"]), { timeoutMs: 15000 });
  assert.equal(result.code, 127);
  assert.equal(result.missing, undefined);
});

test("a Windows supervisor launch failure is not a missing application executable", { skip: process.platform !== "win32" }, async () => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-probe-no-runtime-"));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "systemroot"));
    env.SystemRoot = path.join(directory, "missing Windows runtime");
    const result = await runCommand({ ...specification([]), env }, { timeoutMs: 15000 });
    assert.notEqual(result.code, 0);
    assert.equal(result.missing, undefined);
    assert.equal(engineState(result).engine, "unknown");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("tethered starts directly supervise the original command and remain idempotent", async () => {
  const spec = tethered(specification(["-e", "console.log(JSON.stringify({parent:process.ppid,args:process.argv.slice(1),value:process.env.STUDIO_PROBE_VALUE}))", "space and λ", '$value;$(ignored)&|<>%PATH%!`']));
  assert.equal(tethered(spec), spec);
  const child = start({ ...spec, env: { ...spec.env, STUDIO_PROBE_VALUE: "declared value λ" } });
  let stdout = "", stderr = "";
  child.stdout!.on("data", value => { stdout += value; }); child.stderr!.on("data", value => { stderr += value; });
  assert.equal(await new Promise(resolve => child.once("close", resolve)), 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { parent: child.pid, args: ["space and λ", '$value;$(ignored)&|<>%PATH%!`'], value: "declared value λ" });
});

for (const ending of ["completion", "timeout", "cancellation"] as const) test(`supervised probes close inherited output and descendants after ${ending}`, { timeout: 25000 }, async context => {
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(path.join(scratchRoot, "studio-probe-"));
  const marker = path.join(directory, "descendant.pid");
  const descendant = `process.stdout.write('descendant output\\n');require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100)`;
  const program = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit'],windowsHide:true});process.on('SIGTERM',()=>{});setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})&&${ending === "completion"})process.exit(0)},25)`;
  let pid: number | undefined, child: ChildProcess | undefined;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const unrelatedClosed = new Promise(resolve => unrelated.once("close", resolve));
  const began = performance.now();
  try {
    if (ending === "cancellation") {
      child = start(tethered(specification(["-e", program], directory)));
      child.stdout!.resume(); child.stderr!.resume();
      const closed = new Promise(resolve => child!.once("close", resolve));
      await waitFor(() => existsSync(marker));
      pid = Number(readFileSync(marker, "utf8"));
      stopTree(child, false);
      await closed;
    } else {
      const result = await runCommand(specification(["-e", program], directory), { timeoutMs: ending === "timeout" ? 5000 : 15000 });
      assert.equal(result.code, ending === "timeout" ? null : 0, result.stderr);
      if (ending === "timeout") assert.match(result.stderr, /timed out.*supervised process tree was stopped/);
      assert.match(result.stdout, /descendant output/);
      pid = Number(readFileSync(marker, "utf8"));
    }
    await waitFor(() => !alive(pid!));
    assert.ok(alive(unrelated.pid!), "cleanup leaves an unrelated process running");
    context.diagnostic(`${ending} settled with its output closed in ${Math.round(performance.now() - began)} ms.`);
  } finally {
    if (child) stopTree(child, false);
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    unrelated.kill("SIGKILL"); await unrelatedClosed;
    rmSync(directory, { recursive: true, force: true });
  }
});

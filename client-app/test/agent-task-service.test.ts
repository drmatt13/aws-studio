import assert from "./support/assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentTaskService, type AgentServiceOptions } from "../server/agent-runtime/service";
import { integrateAgentProposal } from "../server/agent-runtime/integration";
import { readSourceManifest } from "aws-studio/source/workspace";
import type { CodingTask, CodingTaskStatus } from "../shared/agent-runtime";

function fixture(t: TestContext, options: Partial<AgentServiceOptions> = {}) {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "studio-agent-service-"));
  const root = path.join(directory, "project"), state = path.join(directory, "state"); mkdirSync(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "disposable", scripts: { test: "node --test" } }));
  writeFileSync(path.join(root, "math.ts"), "export const sum = (a: number, b: number) => a - b;\n");
  writeFileSync(path.join(root, "untracked.txt"), "saved developer work\n");
  let imports = 0;
  const service = new AgentTaskService(root, state, {
    copyDependencies: false,
    runProvider: async input => {
      assert.notEqual(input.cwd, root);
      assert.equal(readFileSync(path.join(input.cwd, "untracked.txt"), "utf8"), "saved developer work\n");
      writeFileSync(path.join(input.cwd, "math.ts"), "export const sum = (a: number, b: number) => a + b;\n");
      writeFileSync(path.join(input.cwd, "new.test.ts"), "// candidate-owned test\n");
      await input.onEvent({ type: "command", data: { command: "fixture validation", exitCode: 0 } });
      return { status: "completed", sessionId: "exact-fixture-session", summary: "Fixed addition and added a regression test." };
    },
    validate: async input => { assert.notEqual(input.cwd, root); assert.deepEqual(input.command.args, ["test"]); return { exitCode: 0 }; },
    integrate: async (_workspace, proposal, digest) => { imports++; return integrateAgentProposal(proposal, digest); },
    ...options,
  });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  service.start();
  const submit = () => service.submit({ requestKey: "fixture-request-key", provider: "codex", prompt: "Repair sum and add a focused test." });
  return { root, state, service, submit, imports: () => imports };
}
async function until(service: AgentTaskService, id: string, expected: CodingTaskStatus): Promise<CodingTask> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const task = service.get(id);
    if (task.status === expected) return task;
    if (["failed", "recovery_required"].includes(task.status)) assert.fail(`Expected ${expected}, received ${task.status}: ${task.summary}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Task did not reach ${expected}: ${JSON.stringify(service.get(id))}`);
}

test("native adapter seam produces an immutable multi-file review and only explicit approval imports exact bytes", async t => {
  const f = fixture(t), task = f.submit();
  assert.equal(f.submit().id, task.id);
  const reviewed = await until(f.service, task.id, "awaiting_review");
  assert.equal(reviewed.agentSummary, "Fixed addition and added a regression test.");
  assert.deepEqual(f.service.events(task.id).events.filter(event => event.data.code === "WORKSPACE_PREPARATION").map(event => event.data.phase), ["source-scan", "storage-check", "source-copy"]);
  assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /a - b/);
  const proposal = f.service.proposal(task.id);
  assert.equal(proposal.validation[0]?.status, "passed");
  assert.deepEqual(proposal.changes.map(change => change.path), ["math.ts", "new.test.ts"]);
  const workspace = f.service.store.get(task.id)!.workspaceDirectory!;
  writeFileSync(path.join(workspace, "working", "math.ts"), "// later candidate mutation\n");
  await assert.rejects(f.service.approve(task.id, "wrong"), /current proposal/);
  assert.equal((await f.service.approve(task.id, proposal.digest)).status, "integrating");
  await until(f.service, task.id, "completed");
  assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /a \+ b/);
  assert.equal(readFileSync(path.join(f.root, "untracked.txt"), "utf8"), "saved developer work\n");
  assert.equal((await f.service.approve(task.id, proposal.digest)).status, "completed");
  assert.equal(f.imports(), 1);
  assert.ok(f.service.events(task.id, 0).events.some(event => event.type === "validation"));
});

test("cancellation from a preparation progress event stops before provider execution or workspace publication", async t => {
  let executions = 0;
  const f = fixture(t, { runProvider: async () => { executions++; return { status: "completed" }; } });
  const phases: string[] = [];
  f.service.subscribe(event => {
    if (event.type !== "diagnostic" || event.data.code !== "WORKSPACE_PREPARATION") return;
    phases.push(String(event.data.phase));
    assert.equal(f.service.get(event.taskId).summary, event.data.message);
    f.service.cancel(event.taskId);
  });
  const task = f.submit(); await until(f.service, task.id, "cancelled");
  assert.deepEqual(phases, ["source-scan"]);
  assert.equal(executions, 0);
  assert.equal(existsSync(path.join(f.state, "workspaces", task.id, "workspace.json")), false);
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, undefined);
  assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /a - b/);
});

test("explicit resume after incomplete capture preserves it and captures a fresh private attempt", async t => {
  const f = fixture(t);
  symlinkSync("math.ts", path.join(f.root, "linked.ts"));
  const task = f.submit(); await until(f.service, task.id, "failed");
  assert.match(f.service.get(task.id).summary!, /Linked or special source/);
  assert.equal(f.service.store.get(task.id)!.workspaceDirectory, undefined);
  const retained = path.join(f.state, "workspaces", task.id);
  assert.equal(existsSync(retained), true);
  unlinkSync(path.join(f.root, "linked.ts")); // Developer repairs the capture input.
  f.service.resume(task.id); await until(f.service, task.id, "awaiting_review");
  assert.notEqual(f.service.store.get(task.id)!.workspaceDirectory, retained);
  assert.equal(existsSync(retained), true);
  assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /a - b/);
  assert.equal(f.imports(), 0);
});

test("shared-package changes require a pinned control plane before source approval", async t => {
  const f = fixture(t, { runProvider: async input => {
    const directory = path.join(input.cwd, "packages/aws-studio/database"); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "studio-migrations.ts"), "export const fixture = 2;\n"); return { status: "completed" };
  } });
  const task = f.submit(); await until(f.service, task.id, "awaiting_review");
  const proposal = f.service.proposal(task.id); assert.equal(proposal.activation, "restart_required");
  await assert.rejects(f.service.approve(task.id, proposal.digest), /pinned runtime/);
  assert.equal(f.imports(), 0);
});

test("app input declarations and frontend files keep their own activation requirements", async t => {
  for (const [file, expected] of [
    ["framework-config/inputs/deployment.ts", "restart_required"],
    ["framework-config/auth/sign-in-providers.ts", "restart_required"],
    ["cdk-app/framework-inputs.ts", "restart_required"],
    ["framework-config/inputs/settings.ts", "none"],
    ["client-app/src/index.ts", "none"],
    ["client-app/server/index.ts", "none"],
  ] as const) await t.test(file, async child => {
    const f = fixture(child, { runProvider: async input => {
      const destination = path.join(input.cwd, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, "export const fixture = true;\n");
      return { status: "completed" };
    } });
    const task = f.submit();
    await until(f.service, task.id, "awaiting_review");
    const proposal = f.service.proposal(task.id);
    assert.equal(proposal.activation, expected);
    if (expected === "restart_required") await assert.rejects(f.service.approve(task.id, proposal.digest), /pinned runtime/);
    assert.equal(existsSync(path.join(f.root, file)), false, "activation assessment never imports source");
    assert.equal(f.imports(), 0);
  });
});

test("framework checks validate the complete regenerated candidate in order and stop at a failed check", async t => {
  const { pinFixtureRelease } = await import("./support/project-cli");
  for (const failing of [false, true]) await t.test(failing ? "failure refuses approval" : "generated source reruns the complete sequence", async child => {
    const generated = "export const generated = true;\n";
    const checked: { digest: string; generated: string | null }[] = [];
    const f = fixture(child, { copyDependencies: true, validate: async input => {
      const cli = path.join(input.cwd, "node_modules/aws-studio/cli.cjs");
      assert.deepEqual(input.command, { file: "node", args: [cli, "framework:check"] });
      assert.equal(realpathSync(cli), cli);
      const output = path.join(input.cwd, "generated.ts");
      checked.push({ digest: readSourceManifest(input.cwd).digest, generated: existsSync(output) ? readFileSync(output, "utf8") : null });
      const result = spawnSync(process.execPath, [...input.command.args], { cwd: input.cwd, encoding: "utf8", windowsHide: true, timeout: 5_000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return { exitCode: result.status };
    } });
    const installed = path.join(f.root, "node_modules/aws-studio");
    mkdirSync(installed, { recursive: true });
    writeFileSync(path.join(installed, "package.json"), JSON.stringify({
      name: "aws-studio", version: "2.0.0", bin: { "aws-studio": "cli.cjs" }, exports: { "./cli": "./cli.cjs" },
    }));
    writeFileSync(path.join(installed, "cli.cjs"), `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "framework:check") throw new Error("Unexpected fixture framework-check arguments.");
if (${failing}) process.exit(7);
const generated = ${JSON.stringify(generated)};
if (existsSync("generated.ts")) {
  if (readFileSync("generated.ts", "utf8") !== generated) throw new Error("Fixture generated bytes changed.");
} else {
  writeFileSync("generated.ts", generated, { flag: "wx" });
}
`);
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: { "framework:check": "aws-studio framework:check" } }));
    pinFixtureRelease(f.root);
    const task = f.service.submit({ requestKey: "framework-sequence", provider: "codex", prompt: "Repair sum.", validation: { kind: "framework" } });
    await until(f.service, task.id, "awaiting_review"); const proposal = f.service.proposal(task.id);
    assert.deepEqual(checked.map(check => check.generated), failing ? [null] : [null, generated]);
    assert.equal(checked.at(-1)?.digest, proposal.candidateDigest);
    assert.equal(proposal.validation.length, 1);
    assert.equal(proposal.validation[0]?.candidateDigest, proposal.candidateDigest);
    assert.equal(proposal.validation[0]?.status, failing ? "failed" : "passed");
    assert.equal(proposal.validation[0]?.exitCode, failing ? 7 : 0);
    assert.equal(f.imports(), 0);
    assert.equal(existsSync(path.join(f.root, "generated.ts")), false);
    if (failing) {
      await assert.rejects(f.service.approve(task.id, proposal.digest), /validation must pass/);
      assert.equal(f.imports(), 0);
    } else {
      assert.notEqual(checked[0]?.digest, proposal.candidateDigest);
      assert.equal(proposal.changes.find(change => change.path === "generated.ts")?.afterHash, createHash("sha256").update(generated).digest("hex"));
      await f.service.approve(task.id, proposal.digest);
      await until(f.service, task.id, "completed");
      assert.equal(readFileSync(path.join(f.root, "generated.ts"), "utf8"), generated);
    }
  });
});

test("automatic checks use the candidate changes and retain evidence for the exact reviewed bytes", async t => {
  for (const scenario of [
    { name: "unchanged", files: {}, invoked: [], status: "completed" },
    { name: "documentation", files: { "docs/example.md": "# Example\n" }, invoked: [], check: "Markdown text check", status: "awaiting_review" },
    { name: "documentation conflict", files: { "docs/example.md": "<<<<<<< HEAD\nFirst\n=======\nSecond\n>>>>>>> branch\n" }, invoked: [], check: "Markdown text check", status: "awaiting_review", failed: true },
    { name: "framework only", files: { "framework-config/example.ts": "export {};\n" }, invoked: ["npm run framework:check"], check: "npm run framework:check", status: "awaiting_review" },
    { name: "framework and implementation", files: { "framework.config.ts": "export {};\n", "math.ts": "export const next = 2;\n" }, invoked: ["npm run verify"], check: "npm run verify", status: "awaiting_review" },
  ] as const) await t.test(scenario.name, async child => {
    const invoked: string[] = [];
    const f = fixture(child, { runProvider: async input => {
      assert.match(input.prompt, /selects independent checks from the changed files/);
      for (const [name, contents] of Object.entries(scenario.files)) {
        const file = path.join(input.cwd, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, String(contents));
      }
      return { status: "completed" };
    }, validate: async input => {
      invoked.push([input.command.file, ...input.command.args].join(" "));
      return { exitCode: 0 };
    } });
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ scripts: { "framework:check": "node framework-check.js", verify: "node verify.js", test: "node --test" } }));
    const task = f.submit();
    await until(f.service, task.id, scenario.status);
    assert.deepEqual(invoked, scenario.invoked);
    if ("check" in scenario) {
      const proposal = f.service.proposal(task.id);
      assert.equal(proposal.validation[0]?.command, scenario.check);
      assert.equal(proposal.validation[0]?.candidateDigest, proposal.candidateDigest);
      assert.equal(proposal.validation[0]?.status, "failed" in scenario ? "failed" : "passed");
      if ("failed" in scenario) await assert.rejects(f.service.approve(task.id, proposal.digest), /validation must pass/);
    } else {
      assert.equal(f.service.get(task.id).sourceOutcome, "unchanged");
      assert.ok(f.service.events(task.id).events.some(event => event.type === "validation" && event.data.message === "No files changed. No source checks were needed."));
    }
  });
});

test("a change outside the proposed paths invalidates validation before any source import", async t => {
  const f = fixture(t), task = f.submit(); await until(f.service, task.id, "awaiting_review");
  writeFileSync(path.join(f.root, "untracked.txt"), "newer developer work\n");
  await assert.rejects(f.service.approve(task.id, f.service.proposal(task.id).digest), /changed/);
  assert.equal(f.service.get(task.id).status, "conflicted");
  assert.equal(f.imports(), 0);
  assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /a - b/);
});

test("failed final validation leaves a reviewable proposal that cannot be approved", async t => {
  const f = fixture(t, { validate: async () => ({ exitCode: 1 }) }), task = f.submit();
  await until(f.service, task.id, "awaiting_review");
  assert.equal(f.service.proposal(task.id).validation[0]?.status, "failed");
  await assert.rejects(f.service.approve(task.id, f.service.proposal(task.id).digest), /validation must pass/);
  f.service.reject(task.id); assert.equal(f.service.get(task.id).status, "rejected");
  assert.equal(f.imports(), 0);
});

test("explicit validation repair resumes the exact native session and requires a new validated approval", async t => {
  let turns = 0, validations = 0, retained: string | undefined;
  const f = fixture(t, { runProvider: async input => {
    turns++;
    if (turns === 1) retained = input.cwd;
    else {
      assert.equal(input.cwd, retained); assert.equal(input.sessionId, "retained-native-session");
      assert.match(input.prompt, /Independent host validation failed/); assert.match(input.prompt, /assert expected seven/);
      assert.match(readFileSync(path.join(input.cwd, "math.ts"), "utf8"), /a \+ b/);
    }
    writeFileSync(path.join(input.cwd, "math.ts"), `export const sum = (a: number, b: number) => a + b; // repair ${turns}\n`);
    return { status: "completed", sessionId: "retained-native-session", summary: `Result after turn ${turns}.` };
  }, validate: async input => { validations++; input.onOutput("assert expected seven"); return { exitCode: validations === 1 ? 1 : 0 }; } });
  const task = f.submit(); await until(f.service, task.id, "awaiting_review");
  const previous = f.service.proposal(task.id);
  assert.equal(f.service.get(task.id).canResumeValidation, true);
  assert.equal(f.service.get(task.id).agentSummary, "Result after turn 1.");
  await assert.rejects(f.service.approve(task.id, previous.digest), /validation must pass/);
  assert.equal(f.service.resume(task.id).agentSummary, undefined);
  assert.equal((await until(f.service, task.id, "awaiting_review")).agentSummary, "Result after turn 2.");
  const next = f.service.proposal(task.id); assert.notEqual(next.digest, previous.digest);
  assert.equal(f.service.get(task.id).canResumeValidation, false); assert.equal(next.validation[0]!.status, "passed");
  assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /a - b/);
  await assert.rejects(f.service.approve(task.id, previous.digest), /current proposal/);
  await f.service.approve(task.id, next.digest); await until(f.service, task.id, "completed");
  assert.equal(turns, 2); assert.match(readFileSync(path.join(f.root, "math.ts"), "utf8"), /repair 2/);
});

test("explicit resume clears cancellation and retains exact workspace and provider session", async t => {
  let runs = 0, firstDirectory = "";
  const f = fixture(t, { runProvider: async input => {
    runs++; await input.onEvent({ type: "session", data: { sessionId: "retained-session" } });
    if (runs === 1) {
      firstDirectory = input.cwd;
      writeFileSync(path.join(input.cwd, "partial.txt"), "retained partial work");
      await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled", sessionId: "retained-session" };
    }
    assert.equal(input.cwd, firstDirectory); assert.equal(input.sessionId, "retained-session");
    assert.equal(readFileSync(path.join(input.cwd, "partial.txt"), "utf8"), "retained partial work");
    return { status: "completed", sessionId: "retained-session" };
  } });
  const task = f.submit(); await until(f.service, task.id, "running");
  f.service.cancel(task.id); await until(f.service, task.id, "cancelled");
  f.service.resume(task.id); await until(f.service, task.id, "awaiting_review");
  assert.equal(runs, 2); assert.equal(f.service.get(task.id).cancelRequested, false);
  assert.equal(f.imports(), 0);
});

test("a restored importer outcome cannot be reported as completed", async t => {
  const f = fixture(t, { integrate: async (_workspace, proposal) => ({ journalId: "fixture", proposalDigest: proposal.digest, status: "restored", paths: [], message: "Restored fixture after injected failure." }) });
  const task = f.submit(); await until(f.service, task.id, "awaiting_review");
  await f.service.approve(task.id, f.service.proposal(task.id).digest);
  await until(f.service, task.id, "failed");
  assert.match(f.service.get(task.id).summary!, /Restored fixture/);
});

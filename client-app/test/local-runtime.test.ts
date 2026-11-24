import { projectCliEntry } from "../server/project-cli";
import assert from "./support/assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildOperation, managedSpec, type OperationContext } from "../server/deploy/registry";
import type { JobSpec, StepContext } from "../server/deploy/jobs";
import type { OperationRequest } from "../shared/deploy";
import { Tools } from "../server/deploy/process";
import { LocalEnvironment } from "../server/deploy/local";
import { DeployService } from "../server/deploy/service";

const account = "123456789012";
const destination = { deployment: "example-dev", profile: "developer", mode: "dev", account, region: "us-east-1" };
const step = { signal: new AbortController().signal, log() {}, setSummary() {}, setPlanId() {} } as unknown as StepContext;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "studio-runtime-"));
  const env = { ...process.env, AWS_CONFIG_FILE: path.join(root, "config"), AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials") };
  const exported = { deployment: "example-dev", account, region: "us-east-1", client: true };
  const status: any = { context: { profile: "developer", account, region: "us-east-1", arn: `arn:aws:iam::${account}:role/developer` }, detail: {
    name: "example-dev", mode: "dev", account, region: "us-east-1", state: { kind: "ready" }, stacks: [{ name: "example-dev-CognitoStack", status: "CREATE_COMPLETE", health: "complete", evidence: "tags", identity: { deployment: "example-dev", mode: "dev" } }], local: { compatible: true, exported: { fresh: true } },
  } };
  const target = { name: "example-dev", mode: "dev", origin: "implicit", account, region: "us-east-1" };
  let active = false;
  let record: any;
  let docker: any = { engine: "running" };
  let observed = 0;
  let recorded: any;
  let configuredProject = "runtime-fixture";
  const managed: string[] = [];
  const changes: [string | undefined, string | undefined][] = [];
  const context = {
    root, env, tools: new Tools(path.resolve(__dirname, "../.."), env), exportDirectory: root, managed: {},
    startManaged: (kind: string) => { managed.push(kind); },
    changed: (profile: string | undefined, deployment: string | undefined) => { changes.push([profile, deployment]); },
    profiles: async () => [{ name: "developer", kind: "static" }], targets: () => [target],
    probeDocker: async () => docker,
    jobs: { holder: () => undefined },
    observer: { status: async (profile: string, name: string, region: string, force: boolean) => {
      observed++; assert.deepEqual([profile, name, region, force], ["developer", "example-dev", "us-east-1", true]);
      return { ok: true, value: status };
    } },
    local: { get project() { return record?.project ?? configuredProject; }, get configuredProject() { return configuredProject; }, exported: () => exported, services: async () => active ? [{ name: "api", state: "running", oneShot: false }] : [],
      activeContainers: async () => active ? [{ id: "api", state: "running" }] : [],
      activeCompute: async () => active ? [{ id: "api", state: "running" }] : [],
      runRecord: () => record, writeRunRecord: (value: any) => { recorded = value; record = { ...value, project: configuredProject }; }, clearRunRecord: () => { record = undefined; },
      markStopped: () => { record = { ...record, stopped: true }; },
      assertRecoverable: async () => { if (!active || record?.stopped) throw new Error("No active runtime to reconnect."); },
      waitUntilReady: async () => {} },
  } as unknown as OperationContext;
  return { root, context, status, exported, target, setActive: (value: boolean, binding?: unknown) => { active = value; record = binding; }, setDocker: (value: unknown) => { docker = value; },
    managed, changes, observed: () => observed, recorded: () => recorded, binding: () => record, setProject: (name: string) => { configuredProject = name; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
const prepare = (f: ReturnType<typeof fixture>, params: OperationRequest["params"] = destination) => buildOperation(f.context, { kind: "local-start", params });
const verify = (spec: JobSpec) => spec.steps[0]!.run!(step);

test("local startup validates fresh exact development destination before exports or containers", async () => {
  const f = fixture(); try {
    const spec = await prepare(f);
    await verify(spec);
    assert.equal(f.observed(), 1);
    assert.deepEqual(spec.locks, ["local", "exports"]);
    assert.equal(await spec.steps[1]!.run!(step), undefined, "every startup regenerates local settings");
    await spec.steps[2]!.run!(step);
    const generation = await spec.steps[2]!.command!(step);
    assert.equal(spec.steps[2]!.label, "Generate source projections");
    assert.deepEqual(generation.args, [projectCliEntry(f.context.tools.root), "framework:generate"]);
    await spec.steps[3]!.run!(step);
    assert.deepEqual({ ...f.recorded(), startedAt: "captured" }, { profile: "developer", deployment: "example-dev", account, region: "us-east-1", startedAt: "captured" });
    const command = await spec.steps[3]!.command!(step);
    assert.equal(command.env.COMPOSE_PROFILES, "", "compute startup never opts into data or identity setup profiles");
    assert.equal(spec.steps[3]!.label, "Prepare local database");
    assert.deepEqual(command.args, [projectCliEntry(f.context.tools.root), "dev", "--prepare-database", "--skip-generation", "--profile", "developer"]);
    const application = await spec.steps[4]!.command!(step);
    await spec.steps[4]!.run!(step);
    assert.deepEqual(f.managed, ["local-logs"], "follow output before application containers start");
    assert.deepEqual(application.args, [projectCliEntry(f.context.tools.root), "dev", "--detach", "--skip-generation", "--profile", "developer"]);
    assert.equal(application.env.COMPOSE_PROFILES, "");
  } finally { f.dispose(); }
});

test("container logs use a fixed project-scoped read-only follower without AWS credentials or maintenance profiles", async () => {
  const f = fixture(); try {
    Object.assign(f.context.env, { AWS_PROFILE: "unrelated", AWS_ACCESS_KEY_ID: "private", AWS_SECRET_ACCESS_KEY: "private", COMPOSE_PROFILES: "database-write" });
    const spec = managedSpec(f.context, "local-logs", "developer");
    assert.equal(spec.title, "Container logs");
    assert.deepEqual(spec.locks, ["local-logs"]);
    const command = await spec.steps[0]!.command!(step);
    assert.match(command.display, /compose .*--project-name runtime-fixture logs --follow --tail 200 --no-color --timestamps/);
    assert.equal(command.env.COMPOSE_PROFILES, "");
    assert.equal(command.env.AWS_PROFILE, undefined);
    assert.equal(command.env.AWS_ACCESS_KEY_ID, undefined);
    assert.doesNotMatch(command.display, /\b(up|build|down|start|migrate)\b/);
    assert.match(spec.cancelNote!, /Containers keep running/);
  } finally { f.dispose(); }
});

test("startup exports outputs for both fresh map settings and stale legacy settings", async () => {
  for (const explicit of [true, false]) {
    const f = fixture(); try {
      f.status.detail.local.exported.fresh = explicit;
      const spec = await prepare(f, { ...destination, ...(explicit ? { export: true } : {}) });
      await verify(spec);
      assert.equal(await spec.steps[1]!.run!(step), undefined);
      const command = await spec.steps[1]!.command!(step);
      assert.ok(command.args.includes("--expected-mode"));
      assert.deepEqual(command.args.slice(-4), ["--profile", "developer", "--region", "us-east-1"]);
    } finally { f.dispose(); }
  }
});

test("startup refreshes deployment observations immediately after its exported destination is verified", async () => {
  const f = fixture(); try {
    const spec = await prepare(f);
    await verify(spec);
    await spec.steps[1]!.run!(step);
    assert.deepEqual(f.changes, [], "pre-export observations must not announce changed settings");

    await spec.steps[1]!.after!({ code: 0, stdout: "" }, step);
    assert.deepEqual(f.changes, [["developer", "example-dev"]], "refresh before source generation or compute startup finishes");
    assert.equal(f.recorded(), undefined);
  } finally { f.dispose(); }
});

test("startup does not announce settings whose exported destination fails validation", async () => {
  const f = fixture(); try {
    const spec = await prepare(f);
    await verify(spec);
    f.exported.account = "999999999999";

    await assert.rejects(async () => spec.steps[1]!.after!({ code: 0, stdout: "" }, step), /exported settings/);
    assert.deepEqual(f.changes, []);
    assert.equal(f.recorded(), undefined);
  } finally { f.dispose(); }
});

test("local startup refuses production, declared pin mismatch and malformed account", async () => {
  const f = fixture(); try {
    await assert.rejects(() => prepare(f, { ...destination, mode: "prod" }), /development deployment/);
    await assert.rejects(() => prepare(f, { ...destination, account: "999999999999" }), /differs/);
    await assert.rejects(() => prepare(f, { ...destination, region: "us-west-2" }), /differs/);
    await assert.rejects(() => prepare(f, { ...destination, account: "invalid" }), /valid AWS account/);
    f.target.mode = "prod";
    await assert.rejects(() => prepare(f), /development deployment/);
    assert.equal(f.observed(), 0);
  } finally { f.dispose(); }
});

test("stopped Docker fails startup before reading AWS", async () => {
  const f = fixture(); try {
    f.setDocker({ engine: "stopped" });
    await assert.rejects(() => prepare(f).then(verify), /Docker is not running/);
    assert.equal(f.observed(), 0);
  } finally { f.dispose(); }
});

test("Docker startup refuses unavailable, unobservable and native Engine-only hosts before any command", async () => {
  const f = fixture(); try {
    for (const docker of [{ engine: "missing", desktop: false }, { engine: "stopped", desktop: false },
      { engine: "unknown", desktop: true, problem: "Docker denied access to its engine." }]) {
      f.setDocker(docker);
      const spec = await buildOperation(f.context, { kind: "docker-start", params: {} });
      await assert.rejects(() => verify(spec), /Install Docker|Docker Desktop|system service manager|denied access/);
    }
    f.setDocker({ engine: "stopped", desktop: true });
    const desktop = await buildOperation(f.context, { kind: "docker-start", params: {} });
    assert.equal(await verify(desktop), undefined);
    assert.deepEqual((await desktop.steps[0]!.command!(step)).args, [projectCliEntry(f.context.tools.root), "dev:docker-desktop"]);
    assert.match(desktop.cancelNote!, /may still finish starting.*check its status/);
    f.setDocker({ engine: "running", desktop: false });
    assert.match(String(await verify(desktop)), /already running/);
    assert.equal(f.observed(), 0);
  } finally { f.dispose(); }
});

test("a Docker launcher exit never establishes readiness while the engine remains stopped", async () => {
  const f = fixture(); try {
    f.setDocker({ engine: "stopped", desktop: true });
    f.context.env.FRAMEWORK_POLL_MS = "0";
    const spec = await buildOperation(f.context, { kind: "docker-start", params: {} });
    await verify(spec);
    await assert.rejects(() => spec.steps[1]!.run!(step), /Docker did not start/);
    f.setDocker({ engine: "running", desktop: true });
    await spec.steps[1]!.run!(step);
  } finally { f.dispose(); }
});

test("restart retains the verified development startup boundary", async () => {
  const f = fixture(); try {
      const spec = await buildOperation(f.context, { kind: "local-restart", params: { profile: "developer" } });
      assert.equal(spec.kind, "local-restart");
      await verify(spec);
      f.status.detail.local.compatible = false;
      await assert.rejects(() => verify(spec), /not compatible/);
      f.status.detail.local.compatible = true;
  } finally { f.dispose(); }
});

test("reconnection resumes support processes without AWS, exports, containers or database work", async () => {
  const f = fixture(); try {
    f.setActive(true, { ...destination, startedAt: "earlier" });
    f.context.profiles = async () => { throw new Error("Recovery must not read AWS profiles."); };
    const spec = await buildOperation(f.context, { kind: "local-attach-watch", params: {} });
    assert.deepEqual(spec.locks, ["local"]);
    assert.equal(spec.sourceReservation, undefined);
    assert.equal(spec.steps.length, 1);
    assert.equal(spec.steps[0]!.command, undefined);
    await spec.steps[0]!.run!(step);
    assert.deepEqual(f.managed, ["local-logs", "local-watch", "local-client"]);
    assert.equal(f.observed(), 0);
    assert.equal(f.recorded(), undefined);
  } finally { f.dispose(); }
});

test("an intentional stop wins over accepted but not yet executed reconnection", async () => {
  const f = fixture(); try {
    f.setActive(true, { ...destination, startedAt: "earlier" });
    const recovery = await buildOperation(f.context, { kind: "local-attach-watch", params: {} });
    await buildOperation(f.context, { kind: "local-stop", params: {} });
    assert.equal(f.binding().stopped, true);
    await assert.rejects(() => recovery.steps[0]!.run!(step), /No active runtime/);
    assert.deepEqual(f.managed, []);
  } finally { f.dispose(); }
});

test("ready stack status does not bypass compatibility or an unexpected AWS identity", async () => {
  for (const scenario of ["account", "absent", "incompatible", "failed"] as const) {
    const f = fixture(); try {
      if (scenario === "account") f.status.context.account = "999999999999";
      if (scenario === "absent") f.status.detail = undefined;
      if (scenario === "failed") f.status.detail.state.kind = "failed";
      if (scenario === "incompatible") f.status.detail.local = { compatible: false, problem: "The replay queue is missing." };
      await assert.rejects(() => prepare(f).then(verify), /changed|Fully deploy the development|replay queue/);
      assert.equal(f.recorded(), undefined);
    } finally { f.dispose(); }
  }
});

test("startup requires a nonempty owned fully completed stack set and always generates local settings", async () => {
  for (const variant of ["empty", "in-progress", "rolled-back", "unowned", "wrong-mode"]) {
    const f = fixture(); try {
      const stack = f.status.detail.stacks[0];
      if (variant === "empty") f.status.detail.stacks = [];
      if (variant === "in-progress") stack.status = "CREATE_IN_PROGRESS";
      if (variant === "rolled-back") stack.status = "UPDATE_ROLLBACK_COMPLETE";
      if (variant === "unowned") stack.evidence = "none";
      if (variant === "wrong-mode") stack.identity.mode = "prod";
      await assert.rejects(() => prepare(f).then(verify), /Fully deploy/);
      assert.equal(f.recorded(), undefined);
    } finally { f.dispose(); }
  }
  const f = fixture(); try {
    const spec = await prepare(f, { ...destination, export: false });
    await verify(spec);
    assert.equal(await spec.steps[1]!.run!(step), undefined, "a legacy false flag cannot skip automatic local settings generation");
    assert.equal(spec.params.export, true);
  } finally { f.dispose(); }
});

test("active runtime cannot be silently pointed at another or unverified profile", async () => {
  const f = fixture(); try {
    f.setActive(true);
    await assert.rejects(() => prepare(f).then(verify), /Stop local runtime/);
    f.setActive(true, { ...destination, profile: "other", startedAt: "earlier" });
    await assert.rejects(() => prepare(f).then(verify), /Stop local runtime/);
    f.setActive(true, { ...destination, startedAt: "earlier" });
    await prepare(f).then(verify);
  } finally { f.dispose(); }
});

test("active local runtime retains its captured project and refuses a newly configured project before export", async () => {
  const f = fixture(); try {
    f.setActive(true, { ...destination, startedAt: "earlier", project: "runtime-fixture" });
    f.setProject("second-checkout");
    await assert.rejects(() => prepare(f).then(verify), /App name changed.*Stop local runtime/);
    assert.equal(f.context.local.project, "runtime-fixture");
    assert.equal(f.recorded(), undefined);
  } finally { f.dispose(); }
});

test("an export cannot move active compute into another project and upgrades legacy binding first", async () => {
  const f = fixture(); try {
    f.setActive(true, { ...destination, startedAt: "earlier" });
    const spec = await prepare(f); await verify(spec);
    assert.equal(f.binding().project, "runtime-fixture", "a positively owned legacy binding captures its project before export");
    f.setProject("second-checkout");
    await assert.rejects(async () => spec.steps[1]!.after!({ code: 0, stdout: "" }, step), /App name changed during startup/);
    assert.equal(f.context.local.project, "runtime-fixture");
    assert.deepEqual(f.managed, []);
  } finally { f.dispose(); }
});

test("positively stopped compute releases a stale project binding before the next startup", async () => {
  const f = fixture(); try {
    f.setActive(false, { ...destination, startedAt: "earlier", project: "runtime-fixture" });
    f.setProject("second-checkout");
    const spec = await prepare(f); await verify(spec);
    assert.equal(f.binding(), undefined);
    assert.equal(f.context.local.project, "second-checkout");
    await spec.steps[3]!.run!(step);
    assert.equal(f.binding().project, "second-checkout");
  } finally { f.dispose(); }
});

test("profile changes during startup and wrong exported account stop before compute", async () => {
  const f = fixture(); try {
    const changed = await prepare(f); await verify(changed);
    writeFileSync(f.context.env.AWS_CONFIG_FILE!, "[profile changed]\nregion=us-west-2\n");
    await assert.rejects(() => changed.steps[1]!.run!(step), /connection changed/);
    const mismatch = await prepare(f); await verify(mismatch);
    f.exported.account = "999999999999";
    await assert.rejects(() => mismatch.steps[2]!.run!(step), /exported settings/);
    assert.equal(f.recorded(), undefined);
  } finally { f.dispose(); }
});

test("lightweight local status observes Docker and processes without AWS or tooling probes", async () => {
  let forced: boolean | undefined;
  const managed: string[] = [];
  const service = { dockerStatus: { read: async (force: boolean) => { forced = force; return { docker: { engine: "running" } }; } },
    managed: (kind: string) => { managed.push(kind); return { running: false }; },
    local: { view: async (docker: unknown, processes: unknown) => ({ docker, processes }) } };
  Object.setPrototypeOf(service, DeployService.prototype);
  const result = await DeployService.prototype.localStatus.call(service as any, true);
  assert.equal(forced, true);
  assert.deepEqual(managed, ["local-watch", "local-client"]);
  assert.deepEqual(result, { docker: { engine: "running" }, processes: { watch: { running: false }, client: { running: false } } });
});

test("container observation failure is retained as an error and cannot clear a stop record", async () => {
  const f = fixture(); try {
    const local = new LocalEnvironment(f.root, f.context.tools, async () => ({ code: 1, stdout: "", stderr: "private-provider-output" }), f.context.env, f.root, f.root);
    local.writeRunRecord({ profile: "developer", deployment: "example-dev", account, region: "us-east-1", startedAt: "earlier" });
    const view = await local.view({ engine: "running", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.match(view.observationProblem!, /Could not read/);
    assert.equal(view.readiness?.state, "blocked");
    await assert.rejects(() => local.containerIds(), /Could not inspect/);
    assert.ok(local.runRecord());
    assert.doesNotMatch(JSON.stringify(view), /private-provider/);
  } finally { f.dispose(); }
});

test("unknown Docker engine state never establishes that local runtime stopped", async () => {
  const f = fixture(); try {
    let called = false;
    const local = new LocalEnvironment(f.root, f.context.tools, async () => { called = true; throw new Error("Unexpected Docker command"); }, f.context.env, f.root, f.root);
    const view = await local.view({ engine: "unknown", desktop: true }, { watch: { running: false }, client: { running: false } });
    assert.match(view.observationProblem!, /determine whether Docker/);
    assert.equal(view.readiness?.state, "blocked");
    assert.equal(called, false);
  } finally { f.dispose(); }
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, constants, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hash, protectedTree } from "./qualification-evidence.mjs";

const [oldInput, newInput, node24Input, node26Input, evidenceInput, option] = process.argv.slice(2);
const reuseCreated = option === "--reuse-created";
if (!evidenceInput || !process.env.npm_config_cache) {
  throw new Error("Pass <old Studio installation> <new Studio installation> <Node 24 executable> <Node 26 executable> <new evidence directory> and set npm_config_cache to a populated offline cache.");
}
if (!reuseCreated) mkdirSync(evidenceInput, { mode: 0o700 });
const evidence = realpathSync(evidenceInput);
const old = realpathSync(oldInput), current = realpathSync(newInput);
const node24 = realpathSync(node24Input), node26 = realpathSync(node26Input);
const projects = { a: path.join(evidence, "app-a"), b: path.join(evidence, "app-b"), saved: path.join(evidence, "app-a-saved") };
const log = path.join(evidence, "evidence.jsonl");
if (reuseCreated && readFileSync(log, "utf8").split("\n").filter(line => line.includes('"name":"create independent app"') && line.includes('"exit":0')).length !== 2) {
  throw new Error("--reuse-created needs the two successful Create records from a stopped qualification run.");
}
const manifest = (directory, file = "package.json") => JSON.parse(readFileSync(path.join(directory, file), "utf8"));
const node24Home = path.resolve(node24, process.platform === "win32" ? ".." : "../..");
const npm24Relative = process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js";
const runtimes = Object.fromEntries(["a", "b"].map(key => {
  const home = path.join(evidence, `node-project-${key}`);
  if (!existsSync(home)) cpSync(node24Home, home, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  const node = realpathSync(path.join(home, path.relative(node24Home, node24)));
  assert.notEqual(node, node24);
  return [key, { node, npm: path.join(home, npm24Relative) }];
}));
const runtimeFor = project => project === projects.b ? runtimes.b : runtimes.a;
function record(name, value) {
  appendFileSync(log, JSON.stringify({ name, ...value }) + "\n");
  console.log(name);
}

const windowsRoot = process.platform === "win32" ? process.env.SystemRoot ?? process.env.WINDIR : undefined;
if (process.platform === "win32") assert.ok(windowsRoot && path.isAbsolute(windowsRoot), "The Windows qualifier needs SystemRoot.");
const systemDirectory = windowsRoot && path.join(windowsRoot, "System32");
const toolDirectories = systemDirectory ? [systemDirectory, windowsRoot] : ["/usr/bin", "/bin"];
if (systemDirectory) {
  const git = spawnSync(path.join(systemDirectory, "where.exe"), ["git.exe"], {
    cwd: evidence, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  if (git.error) throw git.error;
  assert.equal(git.status, 0, "Install native Git and put git.exe on PATH before qualifying Windows.");
  toolDirectories.push(path.dirname(realpathSync(git.stdout.trim().split(/\r?\n/)[0])));
}

const env = {
  ...process.env,
  AWS_CONFIG_FILE: path.join(evidence, "no-aws-config"),
  AWS_SHARED_CREDENTIALS_FILE: path.join(evidence, "no-aws-credentials"),
  AWS_EC2_METADATA_DISABLED: "true", CDK_DISABLE_VERSION_CHECK: "1", npm_config_offline: "true", CHECKPOINT_DISABLE: "1",
};
for (const key of Object.keys(env)) {
  if (/^(?:PATH|AWS_(?:PROFILE|DEFAULT_PROFILE|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|CONTAINER_CREDENTIALS.*)|CDK_DEFAULT_(?:ACCOUNT|REGION)|FRAMEWORK_.*|STUDIO_.*|NODE_OPTIONS|NODE_PATH|npm_config_(?:workspace|workspaces|prefix|global))$/i.test(key)) delete env[key];
}
env.PATH = toolDirectories.join(path.delimiter);
function projectEnv(project) {
  const node = runtimeFor(project).node;
  return { ...env, AWS_STUDIO_PROJECT_NODE: node, PATH: [path.dirname(node), env.PATH].join(path.delimiter) };
}
function run(name, binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: options.cwd ?? evidence, env: options.project ? projectEnv(options.project) : env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60_000, windowsHide: true });
  record(name, { binary, args, cwd: options.cwd ?? evidence, exit: result.status, stderr: result.stderr?.slice(-2500) });
  if (result.error) throw result.error;
  assert.equal(result.status, options.exit ?? 0, result.stderr?.slice(-5000));
  return result.stdout;
}
const launcher = (studio) => path.join(studio, "scripts/studio.mjs");
const appNpm = (name, project, args) => {
  const { node, npm } = runtimeFor(project);
  return run(name, node, [npm, ...args], { cwd: project, project });
};
const git = (name, project, args) => run(name, "git", args, { cwd: project }).trim();
function saveRevision(project, label) {
  git(`stage ${label}`, project, ["add", "."]);
  const archive = pin(project).slice("file:".length);
  git(`check tracked framework archive for ${label}`, project, ["ls-files", "--error-unmatch", "--", archive]);
  if (git(`check staged files for ${label}`, project, ["diff", "--cached", "--name-only"])) {
    git(label, project, ["-c", "user.name=AWS Studio compatibility", "-c", "user.email=compatibility@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", label]);
  }
  return git(`record ${label}`, project, ["rev-parse", "HEAD"]);
}
function pin(project) { return manifest(project).dependencies["aws-studio"]; }
function model(name, studio, executable, project) {
  const snapshot = JSON.parse(run(name, executable, [launcher(studio), "--print", "--project", project], { project }));
  assert.equal(snapshot.repositoryRoot, project);
  for (const mode of ["dev", "prod"]) assert.equal(snapshot.models[mode].status, "ok", JSON.stringify(snapshot.models[mode].diagnostics));
  return snapshot;
}

function requestJson(address, headers, value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const request = httpRequest(address, {
      method: body === undefined ? "GET" : "POST", agent: false,
      headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body), "content-type": "application/json" }) },
      signal: AbortSignal.timeout(30 * 60_000),
    }, response => {
      const chunks = [];
      response.on("error", reject);
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function interactive(studio, project, use, extraEnv = {}) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const args = [launcher(studio), "--project", project, "--port", String(port)];
  const executable = studio === old ? node24 : node26;
  const child = spawn(executable, args, { cwd: evidence, env: { ...projectEnv(project), ...extraEnv }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const stopped = once(child, "close");
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-10000); });
  try {
    let html = "";
    for (let i = 0; i < 480 && child.exitCode === null; i++) {
      const response = await fetch(origin, { headers: { connection: "close" }, signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (response?.ok) { html = await response.text(); break; }
      await delay(250);
    }
    const token = /name="studio-token" content="([^"]+)"/.exec(html)?.[1];
    const protocol = /name="studio-protocol" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(token && protocol, stderr);
    const api = (pathname, body) => requestJson(origin + "/api" + pathname,
      { origin, "x-studio-token": token, "x-studio-protocol": protocol }, body);
    await use(api);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (systemDirectory) {
        spawnSync(path.join(systemDirectory, "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
          env, timeout: 15_000, windowsHide: true,
        });
      } else child.kill("SIGTERM");
    }
    const closed = await Promise.race([stopped, delay(30_000, undefined, { ref: false })]);
    assert.ok(closed, "The qualifier could not stop its Studio process tree.");
    const [exit, signal] = closed;
    record("interactive", { executable, args, exit, signal, stderr });
  }
}

const oldMetadata = manifest(old, "scripts/studio-release.json");
const newMetadata = manifest(current, "scripts/studio-release.json");
assert.notEqual(oldMetadata.version, newMetadata.version);
assert.notEqual(newMetadata.version, newMetadata.frameworkVersion);
assert.match(run("Studio S0", node24, [launcher(old), "--version"]), /Node 24\./);
assert.match(run("Studio S1", node26, [launcher(current), "--version"]), /Node 26\./);
record("artifacts", { platform: process.platform, arch: process.arch, old: oldMetadata, current: newMetadata,
  starter: manifest(current, "scripts/starters.json"),
  oldFrameworkSha256: hash(path.join(old, "release", `aws-studio-${oldMetadata.frameworkVersion}.tgz`)),
  newFrameworkSha256: hash(path.join(current, "release", `aws-studio-${newMetadata.frameworkVersion}.tgz`)),
  runtimes: Object.fromEntries(Object.entries(runtimes).map(([key, { node, npm }]) => [key, {
    node, npm, nodeVersion: run(`project ${key} Node`, node, ["--version"]).trim(),
    npmVersion: run(`project ${key} npm`, node, [npm, "--version"]).trim(),
  }])),
});
for (const project of [projects.a, projects.b]) {
  if (!reuseCreated) run("create independent app", node26, [launcher(current), "--create-project", project, "--print"], { project });
  assert.equal(pin(project), `file:vendor/aws-studio-${oldMetadata.frameworkVersion}.tgz`, "fixture starts at the historical framework");
}
assert.notEqual(manifest(projects.a, "cdk-app/cdk.json").context["framework:appId"], manifest(projects.b, "cdk-app/cdk.json").context["framework:appId"]);
const syntheticAccount = "111111111111", syntheticRegion = "us-east-1";
const cdk = manifest(projects.a, "cdk-app/cdk.json");
const synthTargets = { prod: { account: syntheticAccount, region: syntheticRegion, mode: "prod" } };
assert.deepEqual(cdk.context["framework:targets"], reuseCreated && cdk.context["framework:targets"] ? synthTargets : undefined, "a new app has no inherited production account");
cdk.context["framework:targets"] = synthTargets;
cdk.context[`availability-zones:account=${syntheticAccount}:region=${syntheticRegion}`] = ["us-east-1a", "us-east-1b", "us-east-1c"];
writeFileSync(path.join(projects.a, "cdk-app/cdk.json"), JSON.stringify(cdk, null, 2) + "\n");
const handler = "compute/http/compatibility-status/index.ts";
mkdirSync(path.dirname(path.join(projects.a, handler)), { recursive: true });
writeFileSync(path.join(projects.a, handler), `export async function lambdaHandler(event: { requestContext: { http: { method: string } } }) {
  return { statusCode: 200, headers: { "content-type": "text/plain", "x-application-method": event.requestContext.http.method }, body: "developer-owned compatibility report" };
}
`);
const config = path.join(projects.a, "framework.config.ts");
const runtimeGuard = '\nif (process.versions.node.split(".")[0] !== "24") throw new Error("Expected project Node 24 in framework.config.ts");\n';
if (!readFileSync(config, "utf8").includes(runtimeGuard)) appendFileSync(config, runtimeGuard);
for (const mode of ["dev", "prod"]) writeFileSync(path.join(projects.b, `cdk-app/.env.${mode}`), "# Protected authored fixture input\n", { mode: 0o600 });
const controlHandler = path.join(projects.b, "compute/http/sign-out/index.ts");
const controlMarker = "\n// Control app owns this implementation.\n";
if (!readFileSync(controlHandler, "utf8").includes(controlMarker)) appendFileSync(controlHandler, controlMarker);
const receipt = "graphql-chain.review.json";
const aReceipt = hash(path.join(projects.a, receipt)), bReceipt = hash(path.join(projects.b, receipt));
const initialRevisions = { a: saveRevision(projects.a, "Fixture A at the historical framework"), b: saveRevision(projects.b, "Fixture B at the historical framework") };
const initial = { a: protectedTree(projects.a), b: protectedTree(projects.b) };
const prior = {};
for (const [key, project] of Object.entries({ a: projects.a, b: projects.b })) {
  model(`S0 opens ${key}`, old, node24, project);
  prior[key] = model(`S1 opens ${key}`, current, node26, project);
  await interactive(old, project, async api => {
    assert.equal((await api("/snapshot")).value.snapshot.models.dev.status, "ok");
  });
  const after = protectedTree(project);
  assert.deepEqual(after, initial[key]);
  record(`protected bytes on open ${key}`, { revision: initialRevisions[key], before: initial[key], after, pin: pin(project) });
}

const request = { kind: "route", id: "compatibility-status", path: "/compatibility-status", category: "http", method: "GET",
  head: true, auth: false, implementation: "existing", directory: path.dirname(handler) };
const approvals = path.join(evidence, "feature-review.json");
const handlerDigest = hash(path.join(projects.a, handler));
const feature = [{ kind: "create", request }];
await interactive(current, projects.a, async api => {
  const snapshot = (await api("/snapshot")).value.snapshot;
  const failed = await api("/edits/batch/plan", { revision: snapshot.revision, edits: feature });
  assert.equal(failed.status, 422, JSON.stringify(failed.value));
  assert.match(failed.value.error, /offline|lock the framework/);
  assert.deepEqual(protectedTree(projects.a), initial.a);
  record("offline cache miss keeps the old project and installation", { exit: failed.status, explanation: failed.value.error });
}, { npm_config_cache: path.join(evidence, "empty-npm-cache") });
const routineDescription = readFileSync(path.join(projects.a, "framework-config/studio/descriptions.ts"), "utf8").includes("Reviewed on the old framework pin")
  ? "Routine source review retained the installed framework"
  : "Reviewed on the old framework pin";
const routine = [{ kind: "description", entity: "lambda:sign-out", value: routineDescription }];
await interactive(current, projects.a, async api => {
  assert.deepEqual(protectedTree(projects.a), initial.a);
  const reviewedRoutine = await api("/edits/batch/plan", { revision: (await api("/snapshot")).value.snapshot.revision, edits: routine });
  assert.ok(reviewedRoutine.value.ok, JSON.stringify(reviewedRoutine.value));
  const concurrent = "\n// External edit after review.\n";
  const original = readFileSync(config, "utf8");
  try {
    appendFileSync(config, concurrent);
    const staleSource = await api("/edits/batch/apply", { planId: reviewedRoutine.value.planId });
    assert.ok([409, 410].includes(staleSource.status), JSON.stringify(staleSource.value));
    assert.equal(readFileSync(config, "utf8"), original + concurrent);
    record("external source kept and stale review refused", { refusal: staleSource.status });
  } finally { writeFileSync(config, original); }
});
await interactive(current, projects.a, async api => {
  assert.deepEqual(protectedTree(projects.a), initial.a);
  const reviewed = await api("/edits/batch/plan", { revision: (await api("/snapshot")).value.snapshot.revision, edits: routine });
  assert.ok(reviewed.value.ok, JSON.stringify(reviewed.value));
  assert.equal(reviewed.value.changes.some(change => /^vendor\/|package(?:-lock)?\.json/.test(change.file)), false);
  const saved = await api("/edits/batch/apply", { planId: reviewed.value.planId });
  assert.equal(saved.value.status, "applied", JSON.stringify(saved.value));
  assert.equal(pin(projects.a), `file:vendor/aws-studio-${oldMetadata.frameworkVersion}.tgz`);
  const revision = saveRevision(projects.a, "Save independently installed app before feature adoption");
  record("routine edit keeps project pin", { revision, pin: pin(projects.a) });
  const snap = (await api("/snapshot")).value.snapshot;
  const prepared = protectedTree(projects.a);
  const collision = path.join(projects.a, "vendor", `aws-studio-${newMetadata.frameworkVersion}.tgz`);
  try {
    writeFileSync(collision, "wrong framework artifact", { flag: "wx" });
    const conflict = await api("/edits/batch/plan", { revision: snap.revision, edits: feature });
    assert.equal(conflict.status, 422, JSON.stringify(conflict.value));
    assert.match(conflict.value.error, /different bytes/);
    record("framework archive integrity collision refused", { exit: conflict.status });
  } finally { unlinkSync(collision); }
  const review = await api("/edits/batch/plan", { revision: snap.revision, edits: feature });
  assert.ok(review.value.ok, JSON.stringify(review.value));
  assert.deepEqual(protectedTree(projects.a), prepared);
  record("unapplied plan preserves protected bytes", { prepared, pin: pin(projects.a) });
  let staleArchive;
  try {
    writeFileSync(collision, "external framework artifact after review", { flag: "wx" });
    staleArchive = await api("/edits/batch/apply", { planId: review.value.planId });
    assert.equal(staleArchive.status, 409, JSON.stringify(staleArchive.value));
    assert.equal(readFileSync(collision, "utf8"), "external framework artifact after review");
  } finally { unlinkSync(collision); }
  assert.ok(review.value.changes.some(change => change.file === `vendor/aws-studio-${newMetadata.frameworkVersion}.tgz`));
  assert.ok(review.value.changes.some(change => change.file === ".gitignore"));
  assert.ok(review.value.changes.some(change => change.file === "framework-config/workloads/http.ts"));
  assert.ok(!review.value.changes.some(change => change.file === handler));
  writeFileSync(approvals, JSON.stringify({ ...review.value, planId: undefined }, null, 2));
  const applied = await api("/edits/batch/apply", { planId: review.value.planId });
  assert.equal(applied.value.status, "applied", JSON.stringify(applied.value));
  assert.equal(hash(path.join(projects.a, handler)), handlerDigest);
  assert.equal(hash(path.join(projects.a, receipt)), aReceipt);
  const retried = await api("/edits/batch/plan", { revision: applied.value.revision, edits: feature });
  assert.match(retried.value.error, /already exists/);
  record("review, stale archive, activation, and idempotent retry", { stale: staleArchive.status, applied: applied.value.status, retry: retried.status, handlerDigest });
});

const upgraded = model("S1 reopens upgraded A", current, node26, projects.a);
for (const mode of ["dev", "prod"]) {
  const route = upgraded.models[mode].routes.filter(route => route.path === request.path);
  assert.equal(route.length, 1);
  assert.deepEqual(route[0].methods, ["GET", "HEAD"]);
  assert.equal(route[0].target, "lambda:compatibility-status");
  for (const previous of prior.a.models[mode].targets) {
    assert.equal(upgraded.models[mode].targets.find(target => target.ref === previous.ref)?.constructId, previous.constructId);
  }
}
assert.deepEqual(protectedTree(projects.b), initial.b);
assert.equal(hash(path.join(projects.b, receipt)), bReceipt);
model("S0 reopens unchanged B", old, node24, projects.b);
model("S1 reopens unchanged B", current, node26, projects.b);
const source = readFileSync(config, "utf8");
try {
  writeFileSync(config, source + '\nthrow new Error("INCOMPATIBLE_PROJECT_CODE_RAN");\n');
  const refusal = spawnSync(node24, [launcher(old), "--print", "--project", projects.a], { cwd: evidence, env: projectEnv(projects.a), encoding: "utf8" });
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, new RegExp(`requires AWS Studio version ${newMetadata.version.replaceAll(".", "\\.")} or higher`));
  assert.doesNotMatch(refusal.stderr, /INCOMPATIBLE_PROJECT_CODE_RAN|Evaluating with/);
  record("S0 refuses upgraded A before execution", { exit: refusal.status, stderr: refusal.stderr.trim() });
} finally { writeFileSync(config, source); }
git("clone saved A revision", evidence, ["clone", "--local", projects.a, projects.saved]);
appNpm("install saved A independently", projects.saved, ["ci", "--no-audit", "--no-fund"]);
model("S0 opens saved A revision", old, node24, projects.saved);
const upgradedRevision = saveRevision(projects.a, "Save the approved framework and route change");
const reconstructed = path.join(evidence, "app-a-reconstructed");
git("clone upgraded A revision", evidence, ["clone", "--local", projects.a, reconstructed]);
appNpm("install upgraded A independently", reconstructed, ["ci", "--no-audit", "--no-fund"]);
model("S1 opens the clean rebuilt A revision", current, node26, reconstructed);
record("reproduced upgraded project", { revision: upgradedRevision, pin: pin(reconstructed), handlerDigest: hash(path.join(reconstructed, handler)) });
appNpm("upgraded A generated source check", projects.a, ["run", "framework:check"]);
appNpm("upgraded A typecheck", projects.a, ["run", "typecheck"]);
assert.equal(manifest(projects.a, "node_modules/aws-studio/package.json").version, newMetadata.frameworkVersion);
const verifier = JSON.parse(run("upgraded A Contract Chain", runtimes.a.node, [path.join(projects.a, "node_modules/aws-studio/cli/aws-studio.cjs"), "verify", "--json"], { cwd: projects.a, project: projects.a, exit: 1 }));
assert.equal(verifier.outcome, "pending");
assert.equal(verifier.stages.flatMap(stage => stage.checks).length, 6);
assert.ok(verifier.stages.flatMap(stage => stage.checks).every(check => check.outcome === "passed"));
record("app-owned verification", { outcome: verifier.outcome, checks: verifier.stages.map(stage => stage.checks.map(check => ({ id: check.id, outcome: check.outcome }))) });

for (const mode of ["dev", "prod"]) {
  for (const bundling of [false, true]) {
    const name = mode + (bundling ? "-bundled" : "");
    const captures = ["before", "after"].map((when, i) => {
      const out = path.join(evidence, `${name}-${when}.json`);
      const assembly = path.join(evidence, `${name}-${when}-assembly`);
      appNpm(`${name} synth ${when}`, i ? projects.a : projects.saved, [
        "run", "infrastructure:identity", "--", "capture", "--mode", mode, "--account", syntheticAccount, "--region", syntheticRegion, "--out", out, "--assembly", assembly,
        ...(bundling ? ["--bundling"] : []),
      ]);
      return { stacks: JSON.parse(readFileSync(out, "utf8")).stacks, assembly };
    });
    const [before, after] = captures.map(capture => capture.stacks);
    const additions = [], assets = [], addedDependencies = [], addedOutputs = [];
    for (const [stack, baseline] of Object.entries(before)) {
      assert.ok(after[stack], `Lost stack ${stack}`);
      for (const [name, value] of Object.entries(baseline.outputs)) assert.equal(after[stack].outputs[name], value, `${stack} / ${name} output`);
      for (const [name, value] of Object.entries(after[stack].outputs)) {
        if (name in baseline.outputs) continue;
        const template = JSON.parse(readFileSync(path.join(captures[1].assembly, `${stack}.template.json`), "utf8"));
        const output = template.Outputs[name];
        const [target, attribute] = output.Value["Fn::GetAtt"];
        assert.equal(attribute, "Arn");
        assert.equal(baseline.resources[target], undefined);
        assert.equal(after[stack].resources[target], "AWS::Lambda::Function");
        assert.equal(output.Export.Name, value);
        addedOutputs.push({ stack, name, target });
      }
      for (const [id, type] of Object.entries(baseline.resources)) {
        assert.equal(after[stack].resources[id], type, `${stack} / ${id}`);
        if (type === "Custom::FrontendRouting" && mode === "prod" && after[stack].properties[id] !== baseline.properties[id]) {
          const [priorResources, currentResources] = captures.map(({ assembly }) => JSON.parse(readFileSync(path.join(assembly, `${stack}.template.json`), "utf8")).Resources);
          const prior = priorResources[id], current = currentResources[id];
          const added = current.DependsOn.filter(dependency => !prior.DependsOn.includes(dependency));
          assert.deepEqual({ ...current, DependsOn: current.DependsOn.filter(dependency => !added.includes(dependency)) }, prior);
          const routeDependencies = Object.entries(after[stack].resources)
            .filter(([name, kind]) => !baseline.resources[name] && ["AWS::ApiGatewayV2::Integration", "AWS::ApiGatewayV2::Route"].includes(kind))
            .map(([name]) => name);
          assert.equal(routeDependencies.length, 3);
          assert.deepEqual(added.sort(), routeDependencies.sort());
          const routeKeys = added.filter(name => currentResources[name].Type === "AWS::ApiGatewayV2::Route").map(name => currentResources[name].Properties.RouteKey).sort();
          assert.deepEqual(routeKeys, [`GET ${request.path}`, `HEAD ${request.path}`]);
          addedDependencies.push({ stack, id, dependencies: added });
        } else {
          assert.equal(after[stack].properties[id], baseline.properties[id], `${stack} / ${id} properties`);
        }
        if (JSON.stringify(after[stack].assets[id]) !== JSON.stringify(baseline.assets[id])) assets.push({ stack, id, before: baseline.assets[id], after: after[stack].assets[id] });
      }
    }
    for (const [stack, value] of Object.entries(after)) {
      for (const [id, type] of Object.entries(value.resources)) if (!before[stack]?.resources[id]) additions.push({ stack, id, type });
    }
    assert.equal(additions.filter(resource => resource.type === "AWS::ApiGatewayV2::Route").length, mode === "prod" ? 2 : 0);
    assert.equal(additions.filter(resource => resource.type === "AWS::Lambda::Function").length, mode === "prod" ? 1 : 0);
    assert.equal(addedOutputs.length, mode === "prod" ? 1 : 0);
    assert.equal(addedDependencies.length, mode === "prod" ? 1 : 0);
    record(`${name} identity, property, and asset comparison`, { additions, addedDependencies, addedOutputs, assets });
  }
}

const httpProbe = path.join(evidence, "http-probe.cjs");
writeFileSync(httpProbe, `const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { once } = require("node:events");
const { createServer } = require("node:http");
const fromApp = createRequire(resolve("package.json"));
const express = fromApp("express");
const { loadFrameworkConfig } = fromApp("aws-studio/config/source");
const { getAllHttpRoutes } = fromApp("aws-studio/config");
const { LocalLambdaExecutor } = fromApp("aws-studio/local");
const { installDevelopmentHttpIngress } = fromApp(resolve("node_modules/aws-studio/local/api/lib/developmentLogs.ts"));
const { registerLambdaRoute, registerUnmatchedRouteHandler, registerApiGatewayErrorHandler } = fromApp(resolve("node_modules/aws-studio/local/api/lib/routeProxyHelpers.ts"));
async function probe() {
  const config = loadFrameworkConfig(process.cwd());
  const route = getAllHttpRoutes(config).find(route => route.path === "/compatibility-status");
  const executor = new LocalLambdaExecutor({ config, repositoryRoot: process.cwd(), pool: null });
  const app = express(), api = express();
  installDevelopmentHttpIngress(app);
  registerLambdaRoute(api, route, "lambda:" + route.target, executor);
  registerUnmatchedRouteHandler(api, [route]);
  registerApiGatewayErrorHandler(api);
  app.use("/api", api);
  const server = createServer(app).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const url = "http://127.0.0.1:" + server.address().port + "/api/compatibility-status";
    const get = await fetch(url);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("x-application-method"), "GET");
    assert.equal(await get.text(), "developer-owned compatibility report");
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("x-application-method"), "HEAD");
    assert.equal(await head.text(), "");
    assert.equal((await fetch(url, { method: "POST" })).status, 404);
    console.log(JSON.stringify({ GET: get.status, HEAD: head.status, headBodyBytes: 0, node: process.version }));
  } finally {
    await executor.close();
    await new Promise(resolve => server.close(resolve));
  }
}
probe().catch(error => { console.error(error); process.exitCode = 1; });
`);
const appHttp = JSON.parse(run("upgraded A GET and HEAD through installed local router", runtimes.a.node, ["--import", "tsx", httpProbe], { cwd: projects.a, project: projects.a }));
record("live loopback handler response", appHttp);
record("mixed-runtime qualification complete", { a: protectedTree(projects.a), b: protectedTree(projects.b), pin: pin(projects.a), receipt: aReceipt });

import { copyStudioTestProject } from "./support/source-fixture";
import assert from "./support/assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import type { AccountContext, AwsProfileInfo, DeployOverview, DiscoveryView, JobView, PlanView, StatusView, TeardownPlanView } from "../shared/deploy";
import { composeProjectName } from "../server/deploy/local";
import { deployRouter } from "../server/deploy/routes";
import { DeployService } from "../server/deploy/service";
import { DEV_DEPLOYMENT, PROD_DEPLOYMENT, fakeAccount, frameworkStack, READ_VERB, REGION, type FakeAccount } from "../../packages/aws-studio/test/cdk/support/fake-aws-state";

/**
 * Deploy & Run's routes end to end on a simulated machine: the real repository
 * scripts run against fake-aws (AWS), fake-cdk (the CDK CLI) and fake-docker
 * (the engine), so every path from a request to AWS and back is the real one.
 * Source, generated projections and Studio state live in disposable directories.
 */

const repository = path.resolve(__dirname, "..", "..");
const FAKE_CDK = path.join(repository, "packages", "aws-studio", "test", "cdk", "support", "fake-cdk.mjs");
const FAKE_DOCKER = path.join(__dirname, "support", "fake-docker.mjs");
const SECRET_VALUE = "sentinel-openai-value-never-shown";

let account: FakeAccount;
let root: string;
let service: DeployService;
let server: Server;
let base: string;
const events: { event: string; data: any }[] = [];
let dockerState: string;
let exportDirectory: string;
let applicationServer: Server;
let clientEnvironment: NodeJS.ProcessEnv | undefined;
let localEnvironment: NodeJS.ProcessEnv;

before(async () => {
  root = copyStudioTestProject("source with spaces-Δ-");
  applicationServer = express().get("/", (_request, response) => response.send("fixture client ready")).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => applicationServer.once("listening", resolve));
  const applicationPort = (applicationServer.address() as AddressInfo).port;
  account = fakeAccount({
    allowWrites: true,
    outputValues: {
      UserPoolId: "us-east-1_fakepool", UserPoolClientId: "fakeclient", UserPoolDomainUrl: "https://my-aws-app-dev.auth.us-east-1.amazoncognito.com",
      ReplayBucketName: "fake-replay-bucket", ReplayQueueUrl: "https://sqs.us-east-1.amazonaws.com/222233334444/fake-replay", ReplayQueueArn: "arn:aws:sqs:us-east-1:222233334444:fake-replay",
    },
    regions: { [REGION]: { stacks: [frameworkStack("alex-dev", "CognitoStack", "dev")] } },
  });
  exportDirectory = path.join(account.directory, "export");
  mkdirSync(path.join(exportDirectory, "client-app"), { recursive: true });
  const inputs = path.join(account.directory, "inputs.env");
  writeFileSync(inputs, [
    `LOCAL_DEV_URL=http://127.0.0.1:${applicationPort}`, "LOCAL_AWS_REGION=us-east-1",
    "LOCAL_API_DEV_SERVER_HOST_PORT=8080", "LOCAL_WS_DEV_SERVER_HOST_PORT=8081", "LOCAL_INVOCATION_RUNNER_HOST_PORT=8090",
    "POSTGRES_HOST_PORT=5432", "PGADMIN_HOST_PORT=5050",
    "USE_FRONTEND_CUSTOM_DOMAIN=false", "USE_COGNITO_CUSTOM_DOMAIN=false", `OPENAI_API_KEY=${SECRET_VALUE}`, "",
  ].join("\n"));
  dockerState = path.join(account.directory, "docker.json");
  const env: NodeJS.ProcessEnv = {
    ...account.env,
    FRAMEWORK_INPUTS_FILE: inputs,
    FRAMEWORK_CDK_CLI: FAKE_CDK,
    FRAMEWORK_DOCKER_CLI: FAKE_DOCKER,
    FAKE_DOCKER_STATE: dockerState,
    FRAMEWORK_EXPORT_DIRECTORY: exportDirectory,
    FRAMEWORK_POLL_MS: "20",
    VITE_USER_POOL_CLIENT_ID: "deleted-client-from-previous-deployment",
  };
  localEnvironment = env;
  // The project Studio names from this checkout's directory (or COMPOSE_PROJECT_NAME), whatever the checkout is called.
  writeFileSync(dockerState, JSON.stringify({ engine: "stopped", desktop: true, compose: "5.1.0", project: composeProjectName(root, env), services: [{ name: "postgres", health: "healthy" }, { name: "prisma-verify", oneShot: true }, { name: "api-dev-server" }] }));
  const idle = { file: process.execPath, args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], cwd: root, display: "idle" };
  service = new DeployService(root, (event, data) => events.push({ event, data }), {
    env, stateDirectory: path.join(account.directory, "studio"),
    managed: { "local-client": (childEnv) => {
      clientEnvironment = childEnv;
      return { ...idle, env: childEnv, display: "npm --workspace client-app run dev" };
    } },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/deploy", deployRouter(service));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/deploy`;
});

after(async () => {
  await service?.dispose();
  await Promise.all([server, applicationServer].filter(Boolean).map(listener => new Promise<void>(resolve => listener.close(() => resolve()))));
  account?.dispose();
  // Keep process/stream closure and bounded filesystem retries progressing.
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function get<T>(route: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${route}`);
  return { status: response.status, body: await response.json() as T };
}

async function post<T>(route: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as T };
}

async function operate(kind: string, params: Record<string, unknown>): Promise<JobView> {
  const started = await post<JobView & { error?: string }>("/operations", { kind, params });
  assert.equal(started.status, 200, started.body.error);
  return service.jobs.wait(started.body.id);
}

function logOf(job: JobView): string {
  return service.jobs.log(job.id).lines.map((line) => line.text).join("\n");
}

test("the overview names this repository's targets, this machine's tools and the profiles, never a credential", async () => {
  const { status, body } = await get<DeployOverview>("/overview");
  assert.equal(status, 200);
  assert.deepEqual(body.targets.map((entry) => [entry.name, entry.mode, entry.origin]), [[DEV_DEPLOYMENT, "dev", "implicit"], [PROD_DEPLOYMENT, "prod", "declared"]]);
  assert.deepEqual(body.profiles.map((profile) => profile.name).sort(), ["default", "dev"]);
  assert.equal(body.prerequisites.find((item) => item.id === "docker")?.status, "warn");
  assert.equal(body.local.docker.engine, "stopped");
  assert.equal(body.local.startedBy, "none");
  assert.doesNotMatch(JSON.stringify(body), /sentinel/);
});

test("a fresh shared Docker observation overrides cached prerequisites and redundant starts are skipped", async () => {
  const original = readFileSync(dockerState, "utf8");
  try {
    writeFileSync(dockerState, JSON.stringify({ ...JSON.parse(original), engine: "running" }));
    const machine = await service.dockerStatus.read(true);
    assert.equal(machine.docker.engine, "running");
    const overview = (await get<DeployOverview>("/overview")).body;
    assert.equal(overview.local.docker.engine, "running");
    assert.equal(overview.prerequisites.find(item => item.id === "docker")?.status, "ok");
    const calls = () => readFileSync(`${dockerState}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const launches = calls().filter(call => call.args.slice(0, 2).join(" ") === "desktop start").length;
    const first = await service.perform({ kind: "docker-start", params: {} });
    const second = await service.perform({ kind: "docker-start", params: {} });
    assert.equal(first.id, second.id, "both entry points adopt the same running host operation");
    const completed = await service.jobs.wait(first.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.steps?.[0]?.status, "skipped");
    assert.equal(calls().filter(call => call.args.slice(0, 2).join(" ") === "desktop start").length, launches);
  } finally {
    writeFileSync(dockerState, original);
    service.dockerStatus.invalidate();
    await service.dockerStatus.read(true);
  }
});

test("a Docker Desktop launcher failure is recovered when the engine really starts", async () => {
  const original = readFileSync(dockerState, "utf8");
  try {
    writeFileSync(dockerState, JSON.stringify({ ...JSON.parse(original), engine: "stopped", desktopStartExit: 1 }));
    service.dockerStatus.invalidate();
    const started = await operate("docker-start", {});
    assert.equal(started.status, "succeeded", logOf(started));
    assert.match(logOf(started), /launcher exited with status 1.*Checking whether the engine finishes starting/);
    assert.equal(JSON.parse(readFileSync(dockerState, "utf8")).engine, "running");
  } finally {
    writeFileSync(dockerState, original);
    service.dockerStatus.invalidate();
    await service.dockerStatus.read(true);
  }
});

test("discovery resolves the profile's account and finds every deployment by its own records, reading only", async () => {
  const { body } = await get<{ ok: boolean; value: DiscoveryView }>("/discover?profile=dev");
  assert.equal(body.ok, true);
  assert.deepEqual([body.value.context.account, body.value.context.region], ["222233334444", REGION]);
  assert.deepEqual(body.value.deployments.map((entry) => [entry.name, entry.mode]), [["alex-dev", "dev"]]);
  assert.deepEqual(body.value.targets.map((entry) => [entry.name, entry.status]), [[DEV_DEPLOYMENT, "absent"], [PROD_DEPLOYMENT, "absent"]]);
  assert.deepEqual(account.calls().map((call) => call.key).filter((key) => !READ_VERB.test(key)), []);
});

test("global profile reads list safe metadata and resolve identity without deployment discovery", async () => {
  const profiles = await get<AwsProfileInfo[]>("/profiles");
  assert.equal(profiles.status, 200);
  assert.deepEqual(profiles.body.map(entry => entry.name).sort(), ["default", "dev"]);
  assert.doesNotMatch(JSON.stringify(profiles.body), /sentinel/);
  const offset = account.calls().length;
  const identity = await get<{ ok: true; value: { context: AccountContext } }>("/identity?profile=dev&force=1");
  assert.equal(identity.status, 200);
  assert.equal(identity.body.ok, true);
  assert.equal(identity.body.value.context.profile, "dev");
  assert.equal(identity.body.value.context.region, REGION);
  assert.deepEqual(account.calls().slice(offset).map(entry => entry.key), ["sts get-caller-identity"]);
  assert.equal((await get("/identity?profile=missing")).status, 400);
  const configFile = account.env.AWS_CONFIG_FILE!, original = readFileSync(configFile, "utf8");
  try {
    writeFileSync(configFile, original + `\n[profile "team developer"]\nregion = ${REGION}\nrole_arn = arn:aws:iam::222233334444:role/Team\nsource_profile = dev\n`);
    const spaced = await get<{ ok: true; value: { context: AccountContext } }>("/identity?profile=team%20developer&force=1");
    assert.equal(spaced.status, 200); assert.equal(spaced.body.value.context.profile, "team developer");
    assert.equal(account.calls().at(-1)?.options.profile, "team developer");
  } finally { writeFileSync(configFile, original); }
});

test("an expired session is a classified problem the page can act on", async () => {
  const state = account.read();
  account.write({ ...state, failures: { "sts get-caller-identity": "expired" } });
  try {
    const { body } = await get<{ ok: boolean; problem: { kind: string } }>("/discover?profile=dev&force=1");
    assert.deepEqual([body.ok, body.problem.kind], [false, "expired"]);
  } finally {
    account.write({ ...account.read(), failures: {} });
  }
});

test("operations are validated before anything runs", async () => {
  assert.equal((await post("/operations", { kind: "deploy-plan", params: { deployment: DEV_DEPLOYMENT, profile: "nobody" } })).status, 400);
  assert.match((await post<{ error: string }>("/operations", { kind: "deploy-plan", params: { deployment: "alex-dev", profile: "dev" } })).body.error, /not a deployment this repository declares/);
  assert.match((await post<{ error: string }>("/operations", { kind: "deploy-plan", params: { deployment: PROD_DEPLOYMENT, profile: "dev", autoApply: true } })).body.error, /applied only after its review/);
  assert.equal((await post("/operations", { kind: "destroy", params: { deployment: "alex-dev", mode: "dev", profile: "dev", confirm: "alex" } })).status, 428);
  assert.equal((await post("/operations", { kind: "rm -rf", params: {} })).status, 404);
  for (const kind of ["constructor", "toString", "__proto__"]) assert.equal((await post("/operations", { kind, params: {} })).status, 404, kind);
  assert.equal((await post("/operations", { kind: "local-start", params: { deployment: PROD_DEPLOYMENT, profile: "dev" } })).status, 400);
});

test("Development waits for explicit review, then applies, verifies and exports", async () => {
  const planned = await operate("deploy-plan", { deployment: DEV_DEPLOYMENT, profile: "dev" });
  assert.equal(planned.status, "succeeded", logOf(planned));
  const reviewed = (await get<PlanView>(`/plans/${planned.planId}`)).body;
  assert.equal(reviewed.confirmation.level, "click");
  assert.equal(reviewed.result, undefined);
  const job = await operate("deploy-apply", { plan: planned.planId, profile: "dev" });
  assert.equal(job.status, "succeeded", logOf(job));
  assert.deepEqual(job.steps?.map((step) => step.status), ["done"]);
  assert.match(job.summary ?? "", /deployed and verified/);
  const plan = await get<PlanView>(`/plans/${job.planId}`);
  assert.equal(plan.body.result?.status, "succeeded");
  assert.ok(plan.body.secrets.some((secret) => secret.name.endsWith("OPENAI_API_KEY")), "secrets are named");
  assert.doesNotMatch(JSON.stringify(plan.body), new RegExp(SECRET_VALUE), "and never valued");
  assert.doesNotMatch(logOf(job), new RegExp(SECRET_VALUE));
  assert.match(readFileSync(path.join(exportDirectory, ".env"), "utf8"), new RegExp(String.raw`LOCAL_FRAMEWORK_DEPLOYMENT=${DEV_DEPLOYMENT}`));
  assert.ok(events.some((entry) => entry.event === "deploy-changed" && entry.data.deployment === DEV_DEPLOYMENT));

  const status = await get<{ ok: boolean; value: StatusView }>(`/status?profile=dev&deployment=${DEV_DEPLOYMENT}&force=1`);
  assert.equal(status.body.value.detail?.state.kind, "ready");
  assert.equal(status.body.value.detail?.local?.exported.fresh, true);
});

test("a production plan waits for review, and applying it needs the typed name", async () => {
  // A change set can reference only a secret that exists: creating it is asked for, not assumed.
  const first = await operate("deploy-plan", { deployment: PROD_DEPLOYMENT, profile: "dev" });
  assert.equal(first.status, "succeeded", logOf(first));
  const waiting = (await get<PlanView>(`/plans/${first.planId}`)).body;
  assert.equal(waiting.status, "needs-secrets");
  assert.equal((await post("/operations", { kind: "deploy-apply", params: { plan: waiting.key, profile: "dev" } })).status, 409);
  assert.equal((await operate("deploy-discard", { plan: waiting.key, profile: "dev" })).status, "succeeded");

  const job = await operate("deploy-plan", { deployment: PROD_DEPLOYMENT, profile: "dev", createSecrets: true });
  assert.equal(job.status, "succeeded", logOf(job));
  const plan = (await get<PlanView>(`/plans/${job.planId}`)).body;
  assert.deepEqual([plan.status, plan.review, plan.identity.mode, plan.confirmation.level], ["ready", "change-set", "prod", "name"]);
  assert.ok(plan.uncertainties.some((line) => /Created before review/.test(line)), "the secret it created is disclosed");
  const refused = await post<{ error: string }>("/operations", { kind: "deploy-apply", params: { plan: plan.key, profile: "dev" } });
  assert.equal(refused.status, 428);
  assert.match(refused.body.error, new RegExp(String.raw`Type ${PROD_DEPLOYMENT}`));
  const discarded = await operate("deploy-discard", { plan: plan.key, profile: "dev" });
  assert.equal(discarded.status, "succeeded", logOf(discarded));
  assert.equal((await get(`/plans/${plan.key}`)).status, 404);
});

test("a production plan that fails part-way stays listed, unfinished, until it is discarded", async () => {
  account.write({ ...account.read(), fakeCdk: { failPrepare: [`${PROD_DEPLOYMENT}-NetworkStack`] } });
  try {
    const job = await operate("deploy-plan", { deployment: PROD_DEPLOYMENT, profile: "dev" });
    assert.equal(job.status, "failed");
    const plans = (await get<{ key: string; status: string }[]>("/plans")).body;
    const unfinished = plans.find((plan) => plan.key === job.planId);
    assert.equal(unfinished?.status, "unfinished", "what it prepared in AWS is not forgotten");
    assert.ok(account.read().regions[REGION].stacks.some((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS"));
    const discarded = await operate("deploy-discard", { plan: job.planId, profile: "dev" });
    assert.equal(discarded.status, "succeeded", logOf(discarded));
    assert.equal((await get<{ key: string }[]>("/plans")).body.some((plan) => plan.key === job.planId), false);
    assert.equal(account.read().regions[REGION].stacks.some((stack: any) => stack.StackStatus === "REVIEW_IN_PROGRESS"), false, "the empty stacks it created are gone");
  } finally {
    account.write({ ...account.read(), fakeCdk: {} });
  }
});

test("starting development needs Docker, starts the stack detached, then watches it; stopping stops all of it", async () => {
  const refused = await operate("local-start", { deployment: DEV_DEPLOYMENT, profile: "dev" });
  assert.equal(refused.status, "failed");
  assert.match(refused.summary ?? "", /Docker is not running/);

  const started = await operate("docker-start", {});
  assert.equal(started.status, "succeeded", logOf(started));

  const generatedFiles = [".env", "client-app/.env.development.local", ".framework/local/resources.json"];
  for (const file of generatedFiles) rmSync(path.join(exportDirectory, file), { force: true });
  const observedFiles = generatedFiles.map(file => path.join(exportDirectory, file));
  writeFileSync(dockerState, JSON.stringify({ ...JSON.parse(readFileSync(dockerState, "utf8")), observeFiles: observedFiles }));
  const callsBeforeStart = readFileSync(`${dockerState}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).length;

  const job = await operate("local-start", { deployment: DEV_DEPLOYMENT, profile: "dev" });
  assert.equal(job.status, "succeeded", logOf(job));
  for (const file of generatedFiles) assert.equal(existsSync(path.join(exportDirectory, file)), true, `${file} is generated by startup`);
  assert.ok(clientEnvironment);
  assert.equal(clientEnvironment.VITE_USER_POOL_CLIENT_ID, undefined, "the fresh client export is not shadowed by Studio's inherited outputs");
  assert.match(readFileSync(path.join(exportDirectory, "client-app/.env.development.local"), "utf8"), /VITE_USER_POOL_CLIENT_ID=fakeclient/);
  const expectedExports = Object.fromEntries(observedFiles.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
  const startupCalls = readFileSync(`${dockerState}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).slice(callsBeforeStart).map(line => JSON.parse(line));
  const composeStarts = startupCalls.filter(call => call.args[0] === "compose" && call.args[1] === "up");
  assert.equal(composeStarts.length, 2, "startup first verifies PostgreSQL, then starts application services");
  for (const call of composeStarts) assert.deepEqual(call.files, expectedExports, "the current client environment, Compose settings and resource manifest exist before any Compose startup");
  const overview = (await get<DeployOverview>("/overview?force=1")).body;
  assert.equal(overview.local.startedBy, "studio");
  assert.equal(overview.local.watch.running, true);
  assert.equal(overview.local.client.running, true);
  assert.equal(overview.local.exported.deployment, DEV_DEPLOYMENT);
  assert.deepEqual(overview.local.services.map((entry) => [entry.name, entry.state, entry.oneShot]), [["api-dev-server", "running", false], ["postgres", "running", false], ["prisma-verify", "exited", true]]);
  assert.equal(overview.local.readiness?.state, "ready");
  assert.match(logOf(job), /initializes only proven empty local storage/);
  assert.match(logOf(job), /database migrations, orphan cleanup and test identity setup remain separate/);
  assert.equal(overview.local.services.find((entry) => entry.name === "postgres")?.health, "healthy");
  const up = readFileSync(`${dockerState}.calls.jsonl`, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((call: any) => call.args.join(" ") === "compose up --detach --build --remove-orphans");
  assert.equal(up.profile, "dev");

  const logs = await get<{ text: string }>("/local/logs?service=postgres");
  assert.match(logs.body.text, /listening/);

  const output = service.jobs.list().find(entry => entry.kind === "local-logs" && entry.status === "running");
  assert.ok(output, "runtime exposes a persistent Container logs entry");
  const state = JSON.parse(readFileSync(dockerState, "utf8"));
  writeFileSync(dockerState, JSON.stringify({ ...state, logs: { ...state.logs,
    "api-dev-server": `Lambda invocation fixture: first\n${SECRET_VALUE}\n`,
    "example-service": "service fixture: ready\n",
  } }));
  const deadline = Date.now() + 5000;
  while ((!logOf(output!).includes("Lambda invocation fixture: first") || !logOf(output!).includes("example-service | service fixture: ready")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(logOf(output!), /api-dev-server \| Lambda invocation fixture: first/);
  assert.match(logOf(output!), /example-service \| service fixture: ready/);
  assert.doesNotMatch(logOf(output!), new RegExp(SECRET_VALUE), "private values never reach replay or durable output");
  assert.match(logOf(output!), /\[redacted\]/);
  const updated = JSON.parse(readFileSync(dockerState, "utf8"));
  writeFileSync(dockerState, JSON.stringify({ ...updated, logs: { ...updated.logs,
    "api-dev-server": `${updated.logs["api-dev-server"]}Lambda invocation fixture: next\n`,
  } }));
  while (!logOf(output!).includes("Lambda invocation fixture: next") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.match(logOf(output!), /Lambda invocation fixture: next/, "new invocation output streams without another startup");

  const callsBeforeReattach = readFileSync(`${dockerState}.calls.jsonl`, "utf8").trim().split(/\r?\n/).length;
  const observerState = path.join(account.directory, "log-observer");
  mkdirSync(path.join(observerState, "local"), { recursive: true });
  writeFileSync(path.join(observerState, "local/run.json"), JSON.stringify(service.local.runRecord()));
  const observer = new DeployService(root, () => {}, { env: { ...localEnvironment, LOCAL_AWS_PROFILE: "read-only-log-observer" },
    stateDirectory: observerState, observeExistingContainers: true });
  try {
    const deadline = Date.now() + 10_000;
    while (!observer.jobs.list().some(job => job.kind === "local-logs" && observer.jobs.log(job.id).lines.some(line => line.text.includes("Lambda invocation fixture: next"))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const follower = observer.jobs.list().find(job => job.kind === "local-logs");
    assert.equal(follower?.status, "running", "interactive startup reattaches logs to existing containers");
    assert.match(observer.jobs.log(follower!.id).lines.map(line => line.text).join("\n"), /Lambda invocation fixture: next/);
    const commands = readFileSync(`${dockerState}.calls.jsonl`, "utf8").trim().split(/\r?\n/).slice(callsBeforeReattach)
      .map(line => JSON.parse(line)).filter(call => call.profile === "read-only-log-observer").map(call => call.args as string[]);
    assert.ok(commands.some(args => args.includes("logs") && args.includes("--follow")));
    assert.ok(commands.every(args => args.includes("--help") || !args.some(arg => ["up", "start", "stop", "watch", "build"].includes(arg))), "reattachment only observes output or reads command capabilities");
  } finally { await observer.dispose(); }

  const synthesized = await operate("deploy-plan", { deployment: DEV_DEPLOYMENT, profile: "dev", review: "template" });
  assert.equal(synthesized.status, "succeeded", logOf(synthesized));
  const teardown = await get<{ ok: boolean; value: TeardownPlanView }>(`/teardown?profile=dev&deployment=${DEV_DEPLOYMENT}&mode=dev`);
  assert.equal(teardown.body.ok, true, "read-only deletion review remains available");
  const writesBefore = account.calls().filter(call => !READ_VERB.test(call.key)).length;
  for (const request of [
    { kind: "deploy-apply", params: { plan: synthesized.planId, profile: "dev" } },
    { kind: "export", params: { deployment: DEV_DEPLOYMENT, profile: "dev" } },
    { kind: "destroy", params: { deployment: DEV_DEPLOYMENT, mode: "dev", profile: "dev", confirm: DEV_DEPLOYMENT, review: teardown.body.value.key } },
  ]) {
    const refused = await post<{ error: string }>("/operations", request);
    assert.equal(refused.status, 409); assert.match(refused.body.error, /Stop local runtime/);
  }
  assert.equal(account.calls().filter(call => !READ_VERB.test(call.key)).length, writesBefore, "refused live-runtime mutations make no AWS writes");

  const stopped = await operate("local-stop", {});
  assert.equal(stopped.status, "succeeded", logOf(stopped));
  assert.equal(service.jobs.get(output!.id)?.status, "cancelled", "stopping runtime releases its log follower too");
  const after = (await get<DeployOverview>("/overview?force=1")).body;
  assert.deepEqual([after.local.startedBy, after.local.watch.running, after.local.client.running], ["none", false, false]);
});

test("deleting needs the typed name; the teardown plan reads only, and the deletion follows it", async () => {
  const writesBefore = account.calls().filter((call) => !READ_VERB.test(call.key)).length;
  const teardown = await get<{ ok: boolean; value: TeardownPlanView }>(`/teardown?profile=dev&deployment=${DEV_DEPLOYMENT}&mode=dev`);
  assert.equal(teardown.body.ok, true);
  assert.ok(teardown.body.value.stacks.length >= 3);
  assert.equal(account.calls().filter((call) => !READ_VERB.test(call.key)).length, writesBefore, "the teardown plan wrote nothing");

  const job = await operate("destroy", { deployment: DEV_DEPLOYMENT, mode: "dev", profile: "dev", confirm: DEV_DEPLOYMENT, review: teardown.body.value.key });
  assert.equal(job.status, "succeeded", logOf(job));
  const remaining = account.read().regions[REGION].stacks.filter((stack: any) => stack.StackStatus !== "DELETE_COMPLETE").map((stack: any) => stack.StackName);
  assert.deepEqual(remaining.filter((name: string) => name.startsWith(`${DEV_DEPLOYMENT}-`)), [], "no development stack remains");
  assert.ok(remaining.includes("alex-dev-CognitoStack"), "another deployment is untouched");
});

test("a job's log is replayable from any line, and preferences remember the profile per deployment", async () => {
  const job = service.jobs.list().find((entry) => entry.kind === "destroy")!;
  const all = (await get<{ lines: { seq: number }[] }>(`/jobs/${job.id}/log`)).body.lines;
  const rest = (await get<{ lines: { seq: number }[] }>(`/jobs/${job.id}/log?after=${all[2]!.seq}`)).body.lines;
  assert.deepEqual(rest.map((line) => line.seq), all.slice(3).map((line) => line.seq));
  const saved = await post<{ profiles: Record<string, string> }>("/preferences", { deployment: PROD_DEPLOYMENT, profile: "dev" });
  assert.equal(saved.body.profiles[PROD_DEPLOYMENT], "dev");
  assert.equal((await post("/preferences", { profile: "../../etc" })).status, 400);
});

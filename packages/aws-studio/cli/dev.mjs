import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { databaseStartupProblem } from "./local-startup-diagnostics.mjs";
import { assertComposeContainerOwnership, assertComposeVolumeOwnership, composeProjectName, parseComposeOwnershipLabels } from "./compose-project-ownership.mjs";
import { refreshDevelopmentObservation } from "./dev-observation-lifecycle.mjs";

let flagProfile;
let detach = false;
let prepareDatabase = false;
let print = false;
let skipGeneration = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--print") { print = true; continue; }
  if (arg === "--skip-generation") {
    // Studio already completed its separate Generate source projections step.
    // Ordinary dev:containers still always generates before starting Compose.
    skipGeneration = true;
    continue;
  }
  if (arg === "--prepare-database" || arg === "--verify-database") {
    // Keep the previous flag working for persisted Studio operations. Prepare
    // only empty local storage; existing storage is verified without changes.
    prepareDatabase = true;
    continue;
  }
  if (arg === "--detach") {
    // Start the stack in the background and return: Framework Studio runs it
    // this way, then watches the running stack with docker compose watch --no-up.
    detach = true;
    continue;
  }
  if (arg === "--profile") {
    flagProfile = args[++index];
  } else if (arg.startsWith("--profile=")) {
    flagProfile = arg.slice("--profile=".length);
  } else {
    console.error(`Unknown dev option: ${arg}`);
    process.exit(1);
  }
  if (!flagProfile?.trim()) {
    console.error("--profile needs a nonempty AWS profile name.");
    process.exit(1);
  }
}

// npm 11 treats `npm run dev:containers --profile=name` as an npm config option instead
// of passing it to this script. Support it alongside the standard `--` form.
const profile = flagProfile ?? process.env.npm_config_profile ?? process.env.AWS_PROFILE ?? "default";
if (!profile.trim()) {
  console.error("AWS profile must be nonempty.");
  process.exit(1);
}

// FRAMEWORK_DOCKER_CLI names a Node script to run in place of docker: the
// tests' simulated engine. Everything here runs from the repository root, where
// docker-compose.yml is, whatever directory the command was started in.
const dockerCommand = process.env.FRAMEWORK_DOCKER_CLI
  ? { file: process.execPath, prefix: [process.env.FRAMEWORK_DOCKER_CLI] }
  : { file: "docker", prefix: [] };
const cliDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(process.env.FRAMEWORK_REPOSITORY_ROOT ?? process.cwd());
const compose = prepareDatabase ? ["compose", "up", "--detach", "--build", "postgres", "prisma-verify"]
  : detach ? ["compose", "up", "--detach", "--build", "--remove-orphans"] : ["compose", "up", "--build", "--watch", "--remove-orphans"];
if (print) {
  const composeFiles = ["docker-compose.yml"];
  if (existsSync(path.join(repositoryRoot, "docker-compose.override.yml"))) composeFiles.push("docker-compose.override.yml");
  console.log(JSON.stringify({ projectRoot: repositoryRoot, composeFiles, command: ["docker", ...compose] }));
  process.exit(0);
}
const observationHelper = path.join(cliDirectory, "dev-observation.ts");
let observation;
let observationChild;
let observationDrops = 0;
let observationWarning = false;
const observationClosing = new WeakSet();
function observationUnavailable() {
  if (!observationWarning) console.warn("Development log capture is unavailable; application execution continues without new startup diagnostic evidence.");
  observationWarning = true;
}
function prepareObservation(environment, refresh = false) {
  // A simulated engine is not a development runtime and must not create a real run binding.
  if (!existsSync(observationHelper) || environment.COMPOSE_FILE || environment.FRAMEWORK_DOCKER_CLI) return;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", observationHelper, "prepare", repositoryRoot, refresh ? "refresh" : prepareDatabase ? "database" : "compute"], {
      cwd: repositoryRoot, env: environment, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true,
    });
    const prepared = result.status === 0 ? JSON.parse(result.stdout) : undefined;
    if (prepared?.enabled && typeof prepared.overlay === "string") observation = prepared;
    else { observation = undefined; observationUnavailable(); }
  } catch { observation = undefined; observationUnavailable(); }
}
function composeArguments(args) {
  if (!observation || args[0] !== "compose") return args;
  return ["compose", "-f", path.join(repositoryRoot, "docker-compose.yml"),
    ...(existsSync(path.join(repositoryRoot, "docker-compose.override.yml")) ? ["-f", path.join(repositoryRoot, "docker-compose.override.yml")] : []),
    "-f", observation.overlay, ...args.slice(1)];
}
function recordObservation(value) {
  const input = observationChild?.stdin;
  if (!input || input.destroyed || input.writableEnded) return;
  if (input.writableLength > 256 * 1024) { observationDrops++; return; }
  if (observationDrops) {
    input.write(JSON.stringify({ kind: "startup.gap", message: `${observationDrops} startup output chunks omitted because capture was busy.` }) + "\n");
    observationDrops = 0;
  }
  input.write(JSON.stringify(value) + "\n");
}
function teeOutput(child, phase = "generator") {
  for (const stream of ["stdout", "stderr"]) child[stream]?.on("data", chunk => {
    if (!process[stream].write(chunk)) { child[stream].pause(); process[stream].once("drain", () => child[stream]?.resume()); }
    for (let offset = 0; offset < chunk.length; offset += 8192) recordObservation({ stream, phase, chunk: chunk.subarray(offset, offset + 8192).toString("base64") });
  });
}
function startObservation(environment) {
  if (!observation) return Promise.resolve();
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", "tsx", observationHelper, "capture", repositoryRoot], {
      cwd: repositoryRoot, env: { ...environment, FRAMEWORK_DEVELOPMENT_LOG_SESSION: observation.runtimeSessionId }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    observationChild = child;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { observationUnavailable(); observationClosing.add(child); child.kill(); if (observationChild === child) observationChild = undefined; finish(); }, 2000);
    child.on("error", () => { observationUnavailable(); finish(); });
    child.on("close", () => { if (!observationClosing.has(child)) observationUnavailable(); finish(); });
    let status = "";
    child.stdout.on("data", chunk => {
      status = (status + String(chunk)).slice(-128);
      if (status.includes("unavailable\n")) { observationUnavailable(); finish(); }
      else if (status.includes("ready\n")) finish();
    });
    child.stdin.on("error", () => {});
  });
}
async function closeObservation() {
  const child = observationChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) { if (observationChild === child) observationChild = undefined; return; }
  observationClosing.add(child);
  child.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
  if (observationChild === child) observationChild = undefined;
}

/**
 * Removes the development images this Compose project no longer runs.
 *
 * `up --build` tags a new image for each service whenever the source changed,
 * and the image the tag named before is left untagged. Those, and the images of
 * services this file no longer declares, are what this removes; the invocation
 * runner reclaims the task and container-Lambda images it builds itself.
 *
 * It runs before Compose builds, so the previous start's images are still held
 * by that start's stopped containers and survive until the next start: the
 * debt is bounded at one generation, without hooking into a running `up`.
 * Nothing is forced, so an image any container uses is skipped. Build cache is
 * left alone: it is what keeps the next build fast. Best effort: nothing here
 * stops the stack from starting.
 */
function reclaimComposeImages(env) {
  const docker = (...args) => {
    const result = spawnSync(dockerCommand.file, [...dockerCommand.prefix, ...composeArguments(args)], { cwd: repositoryRoot, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
  };
  const lines = (output) => (output ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let project;
  let services;
  try {
    const config = JSON.parse(docker("compose", "config", "--format", "json") ?? "null");
    project = config?.name;
    services = new Set(Object.keys(config?.services ?? {}));
  } catch {
    // `up` reports a configuration problem in its own words.
  }
  if (!project) return;
  const ownImages = `label=com.docker.compose.project=${project}`;

  let removed = 0;
  const tagged = [...new Set(lines(docker("image", "ls", "--quiet", "--no-trunc", "--filter", ownImages)))];
  const inspected = tagged.length > 0
    ? docker("image", "inspect", "--format", '{{json .RepoTags}}\t{{index .Config.Labels "com.docker.compose.service"}}', ...tagged)
    : undefined;
  for (const line of lines(inspected)) {
    const [tags, service] = line.split("\t");
    if (!service || services.has(service)) continue;
    for (const tag of JSON.parse(tags) ?? []) {
      if (docker("image", "rm", tag) !== undefined) removed += 1;
    }
  }

  let pruned = 0;
  let reclaimed;
  // Listed explicitly: `image ls` leaves untagged images out unless asked.
  const superseded = new Set(lines(docker("image", "ls", "--quiet", "--no-trunc", "--filter", "dangling=true", "--filter", ownImages)));
  if (superseded.size > 0) {
    const output = docker("image", "prune", "--force", "--filter", ownImages);
    // The output lists each image's layers too; count only the images.
    const deleted = new Set(lines(output).filter((line) => line.startsWith("deleted:")).map((line) => line.slice("deleted:".length).trim()));
    pruned = [...superseded].filter((id) => deleted.has(id)).length;
    reclaimed = /Total reclaimed space:\s*(\S+)/.exec(output ?? "")?.[1];
  }

  if (removed > 0 || pruned > 0) {
    const parts = [];
    if (pruned > 0) parts.push(`${pruned} superseded development image(s)${reclaimed ? ` (${reclaimed})` : ""}`);
    if (removed > 0) parts.push(`${removed} image(s) of services no longer in docker-compose.yml`);
    console.log(`Removed ${parts.join(" and ")}.`);
  }
}

// A shell's maintenance profiles must never turn ordinary startup into a
// migration, identity setup or orphan-cleanup operation.
const env = { ...process.env, LOCAL_AWS_PROFILE: profile, COMPOSE_PROFILES: "", COMPOSE_PROJECT_NAME: composeProjectName(repositoryRoot) };

/** A project basename is not ownership: a second checkout can have the same
 * name. Inspect provenance before any source generation, image cleanup or up.
 */
function assertProjectOwnership(resolveConfiguration = true) {
  const read = (...args) => {
    const result = spawnSync(dockerCommand.file, [...dockerCommand.prefix, ...composeArguments(args)], { cwd: repositoryRoot, env, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0) throw new Error("Local Compose project ownership could not be checked. Check Docker and exported development settings before starting local runtime.");
    return result.stdout;
  };
  let configuration;
  if (resolveConfiguration) {
    try { configuration = JSON.parse(read("compose", "config", "--format", "json")); }
    catch { throw new Error("Local Compose configuration could not be read. Export development settings and resolve Docker Compose errors before starting local runtime."); }
  }
  const project = composeProjectName(repositoryRoot, env);
  if (resolveConfiguration && configuration?.name !== project) throw new Error("The effective Compose project differs from the app name. Export local settings again before starting runtime.");
  const inventory = read("ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{json .}}");
  let ids;
  try { ids = inventory.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).ID); }
  catch { throw new Error("Local Compose container ownership could not be verified. Check Docker before starting local runtime."); }
  if (!ids.every(id => typeof id === "string" && /^[a-f0-9]{12,64}$/.test(id))) throw new Error("Local Compose container ownership could not be verified. Check Docker before starting local runtime.");
  if (ids.length) assertComposeContainerOwnership(repositoryRoot, project, parseComposeOwnershipLabels(read("inspect", "--format", "{{json .Config.Labels}}", ...ids), ids.length));
  const postgresVolume = configuration?.services?.postgres?.volumes?.find(volume => volume?.type === "volume" && volume.target === "/var/lib/postgresql/data");
  const declared = postgresVolume && configuration?.volumes?.[postgresVolume.source];
  if (declared?.name) {
    const escaped = declared.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existing = read("volume", "ls", "--filter", `name=^${escaped}$`, "--format", "{{.Name}}").split(/\r?\n/).filter(Boolean);
    if (existing.includes(declared.name)) {
      let labels;
      try { labels = JSON.parse(read("volume", "inspect", "--format", "{{json .Labels}}", declared.name)); }
      catch { throw new Error("Local PostgreSQL volume ownership could not be verified. Existing storage was left unchanged."); }
      assertComposeVolumeOwnership(project, postgresVolume.source, labels);
    }
  }
}

try { assertProjectOwnership(false); }
catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Local Compose ownership could not be verified."}`);
  process.exit(1);
}

// Generated files follow framework.config.ts before anything starts, among
// them docker-compose.services.yml, the container of each declared service. A
// config that cannot boot, or a service with no container, stops here with its
// own message rather than in every container at once.
prepareObservation(env);
await startObservation(env);
const generation = skipGeneration ? { status: 0 } : await new Promise(resolve => {
  const generator = spawn(process.execPath, ["--import", "tsx", path.join(cliDirectory, "../scripts/generate-contracts.ts")],
    { cwd: repositoryRoot, env, stdio: observation ? ["inherit", "pipe", "pipe"] : "inherit" });
  if (observation) teeOutput(generator);
  generator.once("error", () => resolve({ status: 1 }));
  generator.once("close", status => resolve({ status }));
});
if (generation.status !== 0) {
  console.error("npm run framework:generate failed, so Compose was not started.");
  recordObservation({ kind: "startup.failed", message: "Framework generation failed; Compose was not started." });
  await closeObservation();
  process.exit(generation.status ?? 1);
}
// Include newly generated service identities in the optional diagnostics overlay.
await refreshDevelopmentObservation({
  previousRunId: observation?.runtimeSessionId,
  prepare: () => { prepareObservation(env, true); return observation; },
  record: recordObservation,
  close: closeObservation,
  start: () => startObservation(env),
});

// The generated include can be missing on a clean or interrupted checkout.
// Resolve the full native graph only after its source generator can repair it.
try { assertProjectOwnership(); }
catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Local Compose ownership could not be verified."}`);
  recordObservation({ kind: "startup.failed", message: "Local Compose ownership could not be verified." });
  await closeObservation();
  process.exit(1);
}

try {
  reclaimComposeImages(env);
} catch (error) {
  console.warn(`Skipped development image cleanup: ${error instanceof Error ? error.message : String(error)}`);
}

// Generation and image reconciliation take time. A second checkout may have
// claimed the same project meanwhile; recheck at the actual Compose boundary.
try { assertProjectOwnership(); }
catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : "Local Compose ownership could not be verified."}`);
  recordObservation({ kind: "startup.failed", message: "Local Compose ownership could not be verified." });
  await closeObservation();
  process.exit(1);
}

// --remove-orphans: a container of a service this file no longer declares is
// removed rather than left running beside the stack. The runner's own task and
// Lambda containers carry no Compose labels, so Compose never counts them.
// The default graph initializes provably empty local storage and verifies it.
// Existing database migrations and identity changes remain explicit operations.
// --detach returns after creation; Studio separately verifies application readiness.
const startupAt = new Date().toISOString();
const child = spawn(dockerCommand.file, [...dockerCommand.prefix, ...composeArguments(compose)], {
  cwd: repositoryRoot,
  stdio: observation ? ["inherit", "pipe", "pipe"] : "inherit",
  env,
});
if (observation) teeOutput(child, "compose");
child.on("error", (error) => {
  console.error(`Unable to start Docker Compose: ${error.message}`);
  process.exitCode = 1;
});
child.on("close", async (upCode, upSignal) => {
  let code = upCode;
  let signal = upSignal;
  if (prepareDatabase && code === 0 && !signal) {
    // Older Compose `wait` versions exclude containers that have already
    // exited. Resolve this service's exact IDs including stopped containers,
    // then use Engine wait, which returns their recorded exits even for a
    // fast verification. Neither command starts/stops or removes anything.
    const inventory = spawnSync(dockerCommand.file, [...dockerCommand.prefix, ...composeArguments(["compose", "ps", "--all", "--quiet", "prisma-verify"])], {
      cwd: repositoryRoot, env, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    const ids = (inventory.stdout ?? "").trim().split(/\s+/).filter(Boolean);
    if (inventory.status !== 0 || !ids.length || !ids.every(id => /^[a-f0-9]{12,64}$/.test(id))) {
      console.error("The database preparation container could not be observed. Check Docker before retrying local runtime.");
      code = 1;
    } else {
      const verification = spawnSync(dockerCommand.file, [...dockerCommand.prefix, "wait", ...ids], {
        cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", windowsHide: true,
      });
      const exits = (verification.stdout ?? "").trim().split(/\s+/).filter(Boolean);
      code = verification.status === 0 && exits.length === ids.length && exits.every(exit => /^\d+$/.test(exit))
        ? Math.max(...exits.map(Number)) : verification.status || 1;
      signal = verification.signal;
    }
  }
  if (code !== 0 && !signal) {
    // Detached Compose reports only that its prerequisite exited. Read the
    // bounded verification log to recover the cause without starting anything
    // or exposing raw connection values, SQL or Prisma's unsafe adoption advice.
    const verification = spawnSync(dockerCommand.file, [...dockerCommand.prefix, ...composeArguments(["compose", "logs", "--no-color", "--no-log-prefix", "--since", startupAt, "--tail", "80", "prisma-verify"])], {
      cwd: repositoryRoot, env, encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    const problem = verification.status === 0 ? databaseStartupProblem(verification.stdout) : undefined;
    console.error("Local startup is incomplete. Containers already started and their data are preserved. No migrations or identity changes were requested.");
    console.error(`Error: ${problem ?? "Local containers could not start. Inspect the failed service's container logs, resolve its reported prerequisite, then retry local runtime."}`);
  }
  recordObservation({ kind: code === 0 && !signal ? "startup.completed" : "startup.failed", message: code === 0 && !signal ? "Development Compose startup completed. Application readiness is checked separately." : "Development Compose exited before successful startup." });
  await closeObservation();
  process.exitCode = code ?? 1;
});

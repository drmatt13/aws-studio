#!/usr/bin/env node
/**
 * A simulated Docker CLI for tests: FRAMEWORK_DOCKER_CLI points Studio and
 * dev.mjs here, and FAKE_DOCKER_STATE names a JSON file holding the engine.
 *
 * state.engine is "running" or "stopped"; state.desktop says whether the
 * Desktop plugin exists; state.services lists what `compose up` creates (a
 * name, and oneShot for a service that runs to completion). Every call is
 * appended to <state>.calls.jsonl with its arguments, LOCAL_AWS_PROFILE and cwd.
 * Optional state.observeFiles adds content hashes at each call boundary, so
 * startup tests can verify generated files precede Compose without logging values.
 * `compose watch` and an attached `compose up` stay alive until killed. Only a
 * command that changes the engine rewrites the state file, and whole.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const statePath = process.env.FAKE_DOCKER_STATE;
if (!statePath) { process.stderr.write("FAKE_DOCKER_STATE is not set\n"); process.exit(2); }
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const state = load();
const args = process.argv.slice(2);
appendFileSync(`${statePath}.calls.jsonl`, `${JSON.stringify({ args, profile: process.env.LOCAL_AWS_PROFILE ?? null, composeProfiles: process.env.COMPOSE_PROFILES ?? null, cwd: process.cwd(),
  ...(state.observeFiles ? { files: Object.fromEntries(state.observeFiles.map(file => [file,
    existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null])) } : {}),
})}\n`);
let dirty = false;
const save = () => {
  if (!dirty) return;
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, statePath); return; } catch (error) {
      if (attempt > 100 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
};
const out = (text, code = 0) => { save(); if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`); process.exit(code); };
const fail = (text, code = 1) => { save(); process.stderr.write(`${text}\n`); process.exit(code); };
const project = state.project ?? "aws-studio-new";
const DOWN = "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.";
const running = () => state.engine === "running";
state.containers ??= [];

const filterLabel = () => {
  const index = args.indexOf("--filter");
  const value = index >= 0 ? args[index + 1] : undefined;
  return value?.startsWith("label=") ? value.slice("label=".length) : undefined;
};
const matches = (container, label) => !label || container.Labels.split(",").includes(label);

function up() {
  if (!running()) fail(DOWN);
  dirty = true;
  const now = new Date().toISOString();
  const selected = args.filter(arg => state.services?.some(service => service.name === arg));
  for (const service of (state.services ?? []).filter(service => !selected.length || selected.includes(service.name))) {
    const id = createHash("sha256").update(`${project}-${service.name}`).digest("hex").slice(0, 12);
    const existing = state.containers.find((container) => container.ID === id);
    const container = {
      ID: id, Names: `${project}-${service.name}-1`,
      State: service.oneShot ? "exited" : "running",
      Status: service.oneShot ? `Exited (${service.exitCode ?? 0}) 1 second ago` : `Up 1 second${service.health ? ` (${service.health})` : ""}`,
      Ports: service.ports ?? "",
      Labels: `com.docker.compose.project=${project},com.docker.compose.service=${service.name}`,
      StartedAt: now,
      FinishedAt: service.oneShot ? new Date(Date.now() + 1).toISOString() : "0001-01-01T00:00:00Z",
    };
    if (existing) Object.assign(existing, container); else state.containers.push(container);
    if (service.name === "prisma-verify" && !service.exitCode && (!state.logs?.[service.name] || state.generatedDatabaseLog)) {
      const digest = state.databaseInputsDigest ?? spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {databaseInputsDigest}=await import(process.argv[1]);process.stdout.write(databaseInputsDigest(process.argv[2]));", import.meta.resolve("aws-studio/database/studio-migrations"), process.cwd()], { encoding: "utf8", timeout: 15000 }).stdout?.trim();
      state.logs ??= {};
      state.logs[service.name] = JSON.stringify({ kind: "result", commandId: "db.prepare-local", envelope: { ok: true, result: { ok: true, status: "verified", inputsDigest: digest } } });
      state.generatedDatabaseLog = true;
    }
  }
}

// `docker compose` takes global options before its subcommand (--project-directory <dir>, -p, -f).
const composeGlobals = new Set(["--project-directory", "-p", "--project-name", "-f", "--file"]);
const subcommand = (rest) => { for (let index = 0; index < rest.length; index++) { if (composeGlobals.has(rest[index])) { index++; continue; } return rest[index]; } return undefined; };
const first = args[0];
const second = first === "compose" ? subcommand(args.slice(1)) : args[1];
if (first === "version") {
  if (running()) out(JSON.stringify({ Client: { Version: "29.0.1" }, Server: { Version: "29.0.1", Os: "linux", Platform: { Name: "Docker Desktop 4.50.0" } } }));
  save();
  process.stdout.write(`${JSON.stringify({ Client: { Version: "29.0.1" }, Server: null })}\n`);
  process.stderr.write(`${DOWN}\n`);
  process.exit(1);
}
if (first === "context" && second === "show") out("desktop-linux");
if (first === "desktop") {
  if (!state.desktop) fail("docker: unknown command: docker desktop");
  if (second === "version") out("Docker Desktop 4.50.0");
  if (second === "start") {
    dirty = true;
    state.engine = state.desktopStartEngine ?? "running";
    if (state.desktopStartExit) fail("Docker Desktop launcher reported a startup failure", state.desktopStartExit);
    out("Docker Desktop is running");
  }
  fail(`fake-docker: desktop ${second} is not simulated`);
}
if (first === "ps") {
  if (!running()) fail(DOWN);
  const label = filterLabel();
  const list = state.containers.filter((container) => matches(container, label));
  if (args.includes("-q")) out(list.filter((container) => container.State === "running").map((container) => container.ID).join("\n"));
  out(list.map(({ StartedAt, ...container }) => JSON.stringify(container)).join("\n"));
}
if (first === "inspect") {
  const ids = args.slice(args.indexOf("--format") + 2);
  const format = args[args.indexOf("--format") + 1];
  if (args[args.indexOf("--format") + 1] === "{{json .Config.Labels}}") out(ids.map(id => {
    const container = state.containers.find(entry => entry.ID === id);
    return JSON.stringify(container?.ConfigLabels ?? { ...Object.fromEntries((container?.Labels ?? "").split(",").filter(Boolean).map(label => { const split = label.indexOf("="); return [label.slice(0, split), label.slice(split + 1)]; })),
      "com.docker.compose.project.working_dir": container?.WorkingDir ?? process.cwd(),
      "com.docker.compose.project.config_files": container?.ConfigFiles ?? path.join(process.cwd(), "docker-compose.yml"),
    });
  }).join("\n"));
  if (format.includes('"startedAt"')) out(ids.map(id => {
    const container = state.containers.find(entry => entry.ID === id || entry.Names === id);
    return container ? JSON.stringify({ id: container.ID.padEnd(64, "0"), startedAt: container.StartedAt, finishedAt: container.FinishedAt }) : "";
  }).join("\n"));
  out(ids.map((id) => { const container = state.containers.find((entry) => entry.ID === id); return container ? `${container.ID}0000|${container.StartedAt}` : ""; }).join("\n"));
}
if (first === "stop") {
  dirty = true;
  for (const id of args.slice(1)) {
    const container = state.containers.find((entry) => entry.ID === id);
    if (container) Object.assign(container, { State: "exited", Status: "Exited (0) 1 second ago" });
  }
  out(args.slice(1).join("\n"));
}
if (first === "unpause") {
  dirty = true;
  for (const id of args.slice(1)) {
    const container = state.containers.find((entry) => entry.ID === id);
    if (container?.State === "paused") Object.assign(container, { State: "running", Status: "Up 1 second" });
  }
  out(args.slice(1).join("\n"));
}
if (first === "logs") {
  const id = args.at(-1);
  const container = state.containers.find(entry => entry.ID === id || entry.Names === id);
  const service = container?.Names?.slice(project.length + 1, -2);
  out(state.logs?.[id] ?? state.logs?.[service] ?? `2026-10-17T10:00:00.000000000Z ${id} listening`);
}
if (first === "wait") out(args.slice(1).map(id => {
  const container = state.containers.find(entry => entry.ID === id);
  return /Exited \((\d+)\)/.exec(container?.Status ?? "")?.[1] ?? "0";
}).join("\n"));
if (first === "image") out("");
if (first === "compose") {
  if (second === "version") state.compose ? out(state.compose) : fail("docker: unknown command: docker compose");
  if (second === "config") out(JSON.stringify({ name: project, services: Object.fromEntries((state.services ?? []).map((service) => [service.name, {
    ...(service.profiles ? { profiles: service.profiles } : {}),
    ...(!service.oneShot ? { depends_on: Object.fromEntries((state.services ?? []).filter(entry => entry.oneShot && !entry.profiles?.length).map(entry => [entry.name, { condition: "service_completed_successfully" }])) } : {}),
  }])) }));
  if (second === "watch" && args.includes("--help")) out(`Usage: docker compose watch [SERVICE...]\n${state.noUp === false ? "" : "      --no-up     Do not build & start services before watching\n"}`);
  if (second === "logs") {
    if (!args.includes("--follow")) out(state.logs?.[args.at(-1)] ?? "");
    if (!running()) fail(DOWN);
    save();
    const emitted = new Map();
    const flush = () => {
      const current = load();
      for (const [service, text] of Object.entries(current.logs ?? {})) {
        const start = emitted.get(service) ?? 0;
        if (text.length > start) process.stdout.write(text.slice(start).split(/\r?\n/).filter(Boolean).map(line => `${service} | ${line}\n`).join(""));
        emitted.set(service, text.length);
      }
    };
    flush(); setInterval(flush, 50);
    await new Promise(() => {});
  }
  if (second === "ps") out(state.containers.filter(container => container.Names === `${project}-${args.at(-1)}-1`).map(container => container.ID).join("\n"));
  if (second === "watch") {
    if (!running()) fail(DOWN);
    save();
    process.stdout.write("Watch enabled\n");
    setInterval(() => {}, 1000);
  } else if (second === "up") {
    up();
    if (state.upFailure) fail(state.upFailure);
    if (args.includes("-d") || args.includes("--detach")) out(`Container ${project}-started`);
    save();
    process.stdout.write("Attaching to containers\n");
    setInterval(() => {}, 1000);
  } else {
    fail(`fake-docker: compose ${second} is not simulated`);
  }
} else {
  fail(`fake-docker: ${args.join(" ")} is not simulated`);
}

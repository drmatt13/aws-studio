import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline";
import { parse as parseYaml } from "yaml";
import { COMPOSE_FILE, includesComposeFile, parseCompose, RELEASE_COMPOSE_FILE } from "aws-studio/compose-services";
import { ensurePrivateDirectory, writePrivateFileSync } from "./private-files";
import { renameSync, unlinkSync } from "node:fs";
import { composeProjectName } from "./compose-project-ownership.mjs";
import {
  developmentLogCacheDirectory,
  developmentLogRepositoryKey,
  DevelopmentLogReader,
  DevelopmentLogStore,
  readDevelopmentLogControl,
} from "aws-studio/local/development-logs";
import {
  DevelopmentTextFramer,
  sanitizeDevelopmentObservation,
  registerDevelopmentSecrets,
  type DevelopmentLogControl,
} from "aws-studio/development-logs";

import {
  DEVELOPMENT_LOG_CONTROL as CONTROL,
  DEVELOPMENT_LOG_OVERLAY as OVERLAY,
} from "./development-log-compose";
export { developmentObservationComposeArgs } from "./development-log-compose";
function atomicPrivate(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writePrivateFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
function privateInputs(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of [
    path.join(root, ".env"),
    path.join(root, "cdk-app/.env.dev"),
  ])
    try {
      const info = lstatSync(file);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024)
        Object.assign(result, parseEnv(readFileSync(file, "utf8")));
    } catch {
      /* Export/startup owns missing inputs. */
    }
  return result;
}
function exportedInputs(root: string): Record<string, string> {
  try {
    const file = path.join(root, ".env"),
      info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024
      ? Object.fromEntries(
          Object.entries(parseEnv(readFileSync(file, "utf8"))).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
const ownControl = (
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  readDevelopmentLogControl(root, {
    ...environment,
    FRAMEWORK_DEVELOPMENT_LOG_CONTROL: path.join(root, CONTROL),
  });
function fingerprintDeclarations(root: string) {
  const digest = createHash("sha256");
  const composeFiles: string[] = [];
  let bytes = 0,
    files = 0;
  const add = (relative: string) => {
    const file = path.join(root, relative),
      info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 2 * 1024 * 1024 ||
      ++files > 4096 ||
      (bytes += info.size) > 32 * 1024 * 1024
    )
      throw new Error("Declaration fingerprint exceeds its bound.");
    digest.update(relative.replaceAll("\\", "/"));
    const contents = readFileSync(file);
    digest.update(contents);
    return contents;
  };
  const walk = (relative: string, depth: number) => {
    if (depth > 16) throw new Error("Declaration tree exceeds its bound.");
    for (const entry of readdirSync(path.join(root, relative), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Declaration fingerprints cannot follow links.");
      if (entry.isDirectory()) walk(name, depth + 1);
      else if (/\.(?:ts|json)$/.test(entry.name)) add(name);
    }
  };
  // Generated service YAML is a projection; hash its declarations and template instead.
  if (existsSync(path.join(root, "framework.config.ts"))) add("framework.config.ts");
  if (existsSync(path.join(root, COMPOSE_FILE))) {
    const contents = add(COMPOSE_FILE);
    if (includesComposeFile(parseCompose(contents.toString("utf8")), RELEASE_COMPOSE_FILE)) {
      add(RELEASE_COMPOSE_FILE);
      composeFiles.push(RELEASE_COMPOSE_FILE);
    }
    composeFiles.push(COMPOSE_FILE);
  }
  if (existsSync(path.join(root, "docker-compose.override.yml"))) add("docker-compose.override.yml");
  if (existsSync(path.join(root, "framework-config")))
    walk("framework-config", 0);
  return { digest: digest.digest("hex"), composeFiles };
}
/** Local diagnostics setup only: no configuration evaluation, AWS lookup or Docker command. */
export async function prepareDevelopmentObservation(
  root: string,
  phase: "database" | "compute" | "refresh" = "compute",
): Promise<{
  enabled: boolean;
  overlay?: string;
  directory?: string;
  runtimeSessionId?: string;
}> {
  try {
    const project = composeProjectName(root, process.env),
      directory = developmentLogCacheDirectory(root, project),
      inputs = exportedInputs(root),
      repositoryKey = developmentLogRepositoryKey(root),
      { digest, composeFiles } = fingerprintDeclarations(root);
    ensurePrivateDirectory(directory);
    ensurePrivateDirectory(path.join(root, ".framework/local"));
    const binding = {
      deployment:
        process.env.LOCAL_FRAMEWORK_DEPLOYMENT ??
        inputs.LOCAL_FRAMEWORK_DEPLOYMENT,
      account:
        process.env.LOCAL_FRAMEWORK_ACCOUNT ?? inputs.LOCAL_FRAMEWORK_ACCOUNT,
      region: process.env.LOCAL_AWS_REGION ?? inputs.LOCAL_AWS_REGION,
    };
    const bindingId = createHash("sha256")
      .update(JSON.stringify({ project, binding }))
      .digest("hex");
    const previous = ownControl(root),
      runs = await new DevelopmentLogReader(directory).runs();
    const priorRun = runs.find(
      (run) => run.runtimeSessionId === previous?.runtimeSessionId,
    );
    const active =
      priorRun?.status === "collecting" &&
      Date.parse(priorRun.heartbeatAt ?? "") > Date.now() - 15_000;
    const preparing =
      previous &&
      !priorRun &&
      Date.parse(previous.startedAt) > Date.now() - 15 * 60_000;
    const reuse =
      previous?.composeProject === project &&
      previous.repositoryKey === repositoryKey &&
      previous.declarationDigest === digest &&
      previous.bindingId === bindingId &&
      (active ||
        (preparing &&
          (phase === "refresh" ||
            (phase === "compute" && previous.startupPhase === "database"))));
    const control: DevelopmentLogControl = reuse
      ? {
          ...previous!,
          startupPhase: phase === "refresh" ? previous!.startupPhase : phase,
        }
      : {
          version: 1,
          repositoryKey,
          composeProject: project,
          runtimeSessionId: randomUUID(),
          bindingId,
          declarationDigest: digest,
          startedAt: new Date().toISOString(),
          token: randomBytes(32).toString("hex"),
          endpoint: "http://local-invocation-runner:8090",
          binding,
          hostUid: process.getuid?.(),
          hostGid: process.getgid?.(),
          hostRepositoryRoot: realpathSync(root),
          startupPhase: phase === "database" ? "database" : "compute",
        };
    const services: Record<string, unknown> = {};
    for (const file of [
      ...composeFiles,
      "docker-compose.services.yml",
      "docker-compose.override.yml",
    ]) {
      if (!existsSync(path.join(root, file))) continue;
      const document = parseYaml(readFileSync(path.join(root, file), "utf8"), {
        merge: true,
        maxAliasCount: 200,
      }) as { services?: Record<string, unknown> };
      for (const name of Object.keys(document.services ?? {}))
        if (
          [
            "local-api-dev-server",
            "local-ws-dev-server",
            "local-invocation-runner",
          ].includes(name) ||
          file === "docker-compose.services.yml"
        )
          services[name] = {
            environment: {
              FRAMEWORK_DEVELOPMENT_LOGS: "1",
              FRAMEWORK_DEVELOPMENT_LOG_SESSION: control.runtimeSessionId,
            },
          };
    }
    services["local-invocation-runner"] = {
      environment: {
        FRAMEWORK_DEVELOPMENT_LOGS: "1",
        FRAMEWORK_DEVELOPMENT_LOG_SESSION: control.runtimeSessionId,
        FRAMEWORK_DEVELOPMENT_LOG_DIRECTORY: "/development-logs",
      },
      volumes: [
        {
          type: "bind",
          source: directory,
          target: "/development-logs",
          bind: { create_host_path: false },
        },
      ],
    };
    atomicPrivate(path.join(root, OVERLAY), { services });
    atomicPrivate(path.join(root, CONTROL), control);
    return {
      enabled: true,
      overlay: path.join(root, OVERLAY),
      directory,
      runtimeSessionId: control.runtimeSessionId,
    };
  } catch {
    return { enabled: false };
  }
}
/** Arbitrary Compose output belongs to resource producers, never the startup spool. */
export function developmentComposeSummary(
  input: string,
): { kind: string; message: string } | undefined {
  const line = input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  if (
    /^#\d+\s+(?:\[[^\]\r\n]{1,200}\]\s+)?(?:ERROR|CANCELED)\b/.test(line) ||
    /^(?:failed to solve:|Error response from daemon:|unable to get image\b)/i.test(
      line,
    )
  )
    return {
      kind: "startup.compose.failed",
      message:
        "Compose reported a build or engine failure. Detailed diagnostic text remains in Activity.",
    };
  if (/^#\d+\s+(?:\[[^\]\r\n]{1,200}\]\s+)?(?:DONE|CACHED)\b/.test(line))
    return {
      kind: "startup.compose.build-progress",
      message: "Compose reported a completed or cached build step.",
    };
  if (
    /^(?:[✔✓]\s*)?(?:Container|Network|Volume|Image)\s+[A-Za-z0-9_.-]{1,128}\s+(?:Creating|Created|Starting|Started|Running|Building|Built|Pulling|Pulled|Waiting|Healthy|Stopped|Removed)(?:\s+[0-9.]+s)?\s*$/i.test(
      line,
    )
  )
    return {
      kind: "startup.compose.lifecycle",
      message: "Compose reported an engine resource lifecycle transition.",
    };
  return undefined;
}

async function capture(root: string): Promise<void> {
  const control = ownControl(root);
  if (
    !control ||
    (process.env.FRAMEWORK_DEVELOPMENT_LOG_SESSION &&
      process.env.FRAMEWORK_DEVELOPMENT_LOG_SESSION !==
        control.runtimeSessionId)
  ) {
    process.stdout.write("unavailable\n");
    return;
  }
  const directory = path.join(
    developmentLogCacheDirectory(root, control.composeProject),
    "bootstrap",
  );
  registerDevelopmentSecrets("runtime:bootstrap", [
    control.token,
    ...Object.values(privateInputs(root)).filter(Boolean),
  ]);
  const store = new DevelopmentLogStore(directory, control, {
    limits: {
      bytes: 8 * 1024 * 1024,
      resourceBytes: 8 * 1024 * 1024,
      records: 5000,
      resourceRecords: 5000,
      metadataBytes: 2 * 1024 * 1024,
    },
  });
  try {
    await store.initialize();
  } catch {
    process.stdout.write("unavailable\n");
    return;
  }
  process.stdout.write("ready\n");
  const instanceId = randomUUID();
  let sequence = 0,
    pending = 0,
    dropped = 0,
    reportedFailure = false,
    chain = Promise.resolve();
  const emit = (
    kind: string,
    message: string,
    stream: "stdout" | "stderr" | "event" = "event",
  ) => {
    if (pending >= 128) {
      dropped++;
      return;
    }
    pending++;
    const observation = sanitizeDevelopmentObservation({
      resourceId: "runtime:development",
      kind,
      message,
      stream,
      level: kind.endsWith("failed")
        ? "error"
        : stream === "stderr"
          ? "warn"
          : "info",
    });
    const entry = {
      observation,
      eventId: `${instanceId}:${++sequence}`,
      producer: { component: "bootstrap", instanceId },
    };
    chain = chain
      .then(async () => {
        if (dropped) {
          store.drop(dropped);
          dropped = 0;
        }
        await store.append([entry]);
      })
      .catch(() => {
        dropped++;
        if (!reportedFailure) {
          reportedFailure = true;
          process.stdout.write("unavailable\n");
        }
      })
      .finally(() => {
        pending--;
      });
  };
  const secrets = [control.token, ...Object.values(privateInputs(root))];
  const frames = {
    stdout: new DevelopmentTextFramer(
      (line) => emit("startup.output", line, "stdout"),
      secrets,
    ),
    stderr: new DevelopmentTextFramer(
      (line) => emit("startup.output", line, "stderr"),
      secrets,
    ),
  };
  let composeOmitted = false;
  const composeLine = (line: string) => {
    const summary = developmentComposeSummary(line);
    if (summary) emit(summary.kind, summary.message);
    else if (line.trim() && !composeOmitted) {
      composeOmitted = true;
      emit(
        "startup.compose.output-omitted",
        "Application and unclassified Compose output is omitted from bootstrap capture. Resource producers own application log evidence.",
      );
    }
  };
  const composeFrames = {
    stdout: new DevelopmentTextFramer(composeLine, secrets),
    stderr: new DevelopmentTextFramer(composeLine, secrets),
  };
  emit("startup.started", "Development startup began.");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length > 32 * 1024) {
      dropped++;
      continue;
    }
    try {
      const value = JSON.parse(line);
      if (value.stream === "stdout" || value.stream === "stderr") {
        if (typeof value.chunk === "string" && value.chunk.length <= 16 * 1024)
          (value.phase === "compose" ? composeFrames : frames)[
            value.stream as "stdout" | "stderr"
          ].push(Buffer.from(value.chunk, "base64"));
      } else if (
        typeof value.kind === "string" &&
        typeof value.message === "string"
      )
        emit(value.kind, value.message);
    } catch {
      dropped++;
    }
  }
  frames.stdout.flush();
  frames.stderr.flush();
  composeFrames.stdout.flush();
  composeFrames.stderr.flush();
  await chain;
  if (dropped) store.drop(dropped);
  await store.close().catch(() => {});
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/dev-observation.ts")) {
  const root = path.resolve(process.argv[3] ?? process.cwd());
  if (process.argv[2] === "prepare")
    void prepareDevelopmentObservation(
      root,
      process.argv[4] === "database"
        ? "database"
        : process.argv[4] === "refresh"
          ? "refresh"
          : "compute",
    ).then((result) => process.stdout.write(JSON.stringify(result)));
  else if (process.argv[2] === "capture")
    void capture(root).catch(() => {
      process.stdout.write("unavailable\n");
    });
}

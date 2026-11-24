import path from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { readDevelopmentLogControl } from "aws-studio/local/development-logs/producer";
import { composeProjectName } from "./compose-project-ownership.mjs";

export const DEVELOPMENT_LOG_CONTROL = ".framework/local/development-logs.json";
export const DEVELOPMENT_LOG_OVERLAY =
  ".framework/local/development-logs.compose.json";

/** Keep this helper dependency-light: Studio's pinned agent host also owns Tools. */
export function developmentObservationComposeArgs(
  root: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (
    args[0] !== "compose" ||
    // Host capability/help probes do not need (or validate) a project config.
    ["version", "help", "--version", "--help", "-h"].includes(args[1] ?? "") ||
    (args.length === 3 &&
      ["watch", "config"].includes(args[1] ?? "") &&
      ["--help", "-h"].includes(args[2] ?? "")) ||
    args.includes("-f") ||
    args.includes("--file") ||
    environment.COMPOSE_FILE ||
    environment.FRAMEWORK_DOCKER_CLI
  )
    return args;
  const overlay = path.join(root, DEVELOPMENT_LOG_OVERLAY);
  const control = readDevelopmentLogControl(root, {
    ...environment,
    FRAMEWORK_DEVELOPMENT_LOG_CONTROL: path.join(root, DEVELOPMENT_LOG_CONTROL),
  });
  if (!control || !existsSync(overlay)) return args;
  try {
    const stat = lstatSync(overlay);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 256 * 1024 ||
      control.composeProject !== composeProjectName(root, environment) ||
      control.hostRepositoryRoot !== realpathSync(root)
    )
      return args;
    const parsed = JSON.parse(readFileSync(overlay, "utf8")) as {
      services?: Record<string, { environment?: Record<string, unknown> }>;
    };
    if (
      !parsed.services ||
      !parsed.services["local-invocation-runner"] ||
      Object.keys(parsed.services).length > 512 ||
      !Object.values(parsed.services).every(
        (service) =>
          service?.environment?.FRAMEWORK_DEVELOPMENT_LOGS === "1" &&
          service.environment.FRAMEWORK_DEVELOPMENT_LOG_SESSION ===
            control.runtimeSessionId,
      )
    )
      return args;
  } catch {
    return args;
  }
  return [
    "compose",
    "-f",
    path.join(root, "docker-compose.yml"),
    ...(existsSync(path.join(root, "docker-compose.override.yml"))
      ? ["-f", path.join(root, "docker-compose.override.yml")]
      : []),
    "-f",
    overlay,
    ...args.slice(1),
  ];
}

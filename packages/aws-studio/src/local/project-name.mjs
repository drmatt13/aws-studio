import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** The navbar's app name is also the local Compose namespace. */
export function repositoryAppName(root) {
  const file = path.join(root, "cdk-app", "cdk.json");
  if (!existsSync(file)) return undefined;
  let name;
  try { name = JSON.parse(readFileSync(file, "utf8")).context?.["framework:app"]; }
  catch { throw new Error("cdk-app/cdk.json is not valid JSON. Fix it before using local runtime."); }
  if (name === undefined || name === null || name === "") return undefined;
  if (typeof name !== "string" || !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error("Choose a valid app name in Studio: lowercase letters, numbers and hyphens, starting with a letter and not ending with a hyphen.");
  }
  return name;
}

export function normalizeProjectName(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+/, "");
}

export function resolveProjectName(root, environment = process.env, exportDirectory = root) {
  const app = repositoryAppName(root);
  if (app) return app;
  // Compatibility for unnamed repositories and standalone Compose fixtures.
  // Named apps never read stale generated settings or shell naming overrides.
  let configured;
  if (Object.hasOwn(environment, "COMPOSE_PROJECT_NAME") && environment.COMPOSE_PROJECT_NAME !== undefined) {
    configured = environment.COMPOSE_PROJECT_NAME;
  } else if (environment.COMPOSE_DISABLE_ENV_FILE !== "1" && environment.COMPOSE_DISABLE_ENV_FILE !== "true") {
    const file = path.join(exportDirectory, ".env");
    if (existsSync(file)) configured = parseEnv(readFileSync(file, "utf8")).COMPOSE_PROJECT_NAME;
  }
  if (configured) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(configured)) throw new Error("COMPOSE_PROJECT_NAME must be a valid lowercase Compose project name.");
    return configured;
  }
  const name = normalizeProjectName(path.basename(root));
  if (!name) throw new Error("Name this app in Studio before starting local runtime.");
  return name;
}

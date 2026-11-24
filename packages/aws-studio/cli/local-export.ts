import os from "node:os";
import path from "node:path";
import { getFrameworkTargets, isTargetEnabled, listResourceDeclarations, referenceForGraph, resolveInput } from "aws-studio/config";
import { loadFrameworkConfig } from "aws-studio/config/source";
import { localClientUrl } from "./local-client.mjs";
import { composeProjectName } from "./compose-project-ownership.mjs";

// The project this runs for, loaded by root: see loadFrameworkConfig.
const framework = loadFrameworkConfig();

/**
 * Every host port Docker Compose publishes, supplied by cdk-app/.env.dev or a declared input default.
 *
 * Compose interpolates these by name, and packages/aws-studio/scripts/check-local.ts
 * asserts the two lists agree, so a service that publishes a port nobody can move
 * fails the check rather than reaching a developer whose machine already uses it.
 */
export const LOCAL_HOST_PORT_NAMES = [
  "LOCAL_API_DEV_SERVER_HOST_PORT",
  "LOCAL_WS_DEV_SERVER_HOST_PORT",
  "LOCAL_INVOCATION_RUNNER_HOST_PORT",
  "POSTGRES_HOST_PORT",
  "PGADMIN_HOST_PORT",
] as const;

/** Export only declared local reads and explicit development controls. */
export function localExportValues(
  authored: Readonly<Record<string, string>>,
  options: { profile?: string; region?: string; repositoryRoot: string },
): Map<string, string> {
  const values = new Map<string, string>();
  // Resource attributes and authored workload inputs have dedicated readers.
  // Root .env contains Compose controls, never application secret values.
  for (const target of getFrameworkTargets(framework)) {
    if (target.kind !== "service" || !isTargetEnabled(framework, target.kind, target.id, "local", "unconditioned")) continue;
    const override = `${target.id.replace(/-/g, "_").toUpperCase()}_SERVICE_URL`;
    if (authored[override]) values.set(override, authored[override]);
  }
  if (authored.LOCAL_BROWSER_ORIGINS !== undefined) {
    throw new Error("LOCAL_BROWSER_ORIGINS in cdk-app/.env.dev is no longer read: the local allowlist is derived from LOCAL_DEV_URL and STUDIO_URL. Remove it, and configure those origins instead.");
  }

  // Use the catalog's own resolver for declared port inputs so Compose and client URL
  // recipes agree on blank/missing overrides. Framework-owned ports still require an
  // authored value. Container listen ports and Compose-DNS addresses remain fixed.
  const publicInputs = new Map(listResourceDeclarations(framework.resources ?? {}).flatMap(reference =>
    reference.fromEnv && !reference.secretArn ? [[reference.fromEnv, reference] as const] : []));
  const inputValue = (name: string): string | undefined => {
    const reference = publicInputs.get(name);
    const resolved = reference && resolveInput(referenceForGraph(reference, "dev"), { env: authored });
    return resolved ? resolved.state === "supplied" || resolved.state === "fallback" ? resolved.value : undefined : authored[name];
  };
  const claimedBy = new Map<string, string>();
  for (const name of LOCAL_HOST_PORT_NAMES) {
    const port = inputValue(name);
    if (port === undefined) {
      throw new Error(`${name} is missing from cdk-app/.env.dev and has no input default. Set it using cdk-app/.env.dev.template.`);
    }
    if (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535) {
      throw new Error(`${name}=${port} in cdk-app/.env.dev is not a port number between 1 and 65535.`);
    }
    const first = claimedBy.get(port);
    if (first) {
      throw new Error(`${name} and ${first} are both ${port}. Two Compose services cannot publish one host port.`);
    }
    claimedBy.set(port, name);
    values.set(name, port);
  }
  const hostPort = (name: string): string => values.get(name)!;
  let studio: URL;
  try {
    studio = new URL(inputValue("STUDIO_URL") ?? "");
    if (studio.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(studio.hostname) ||
        studio.username || studio.password || studio.pathname !== "/" || studio.search || studio.hash) throw new Error();
  } catch {
    throw new Error("STUDIO_URL in cdk-app/.env.dev must be an HTTP loopback origin without credentials, path, query or fragment.");
  }
  values.set("STUDIO_URL", studio.origin);

  const controls: Record<string, string> = {
    LOCAL_AWS_PROFILE: options.profile ?? "default",
    LOCAL_AWS_REGION: options.region ?? "us-east-1",
    LOCAL_AWS_CONFIG_DIR: path.join(os.homedir(), ".aws"),
    PRISMA_LOCAL_SCHEMA_SYNC: "migrate",
    LOCAL_CONTAINER_LAMBDA_TIMEOUT_MS: "10000",
    // Warm Node handler processes in the dev servers: at most this many, each
    // stopped after this many idle seconds. LOCAL_LAMBDA_WARM=false starts
    // every invocation cold.
    LOCAL_LAMBDA_WARM: "true",
    LOCAL_LAMBDA_WARM_MAX: "6",
    LOCAL_LAMBDA_WARM_IDLE_SECONDS: "120",
    LOCAL_INVOCATION_RUNNER_PUBLIC_URL: `http://localhost:${hostPort("LOCAL_INVOCATION_RUNNER_HOST_PORT")}`,
  };
  for (const [name, fallback] of Object.entries(controls)) {
    values.set(name, authored[name] ?? fallback);
  }
  values.set("LOCAL_AWS_CONFIG_DIR", path.resolve(options.repositoryRoot, values.get("LOCAL_AWS_CONFIG_DIR")!).replace(/\\/g, "/"));
  values.set("COMPOSE_PROJECT_NAME", composeProjectName(options.repositoryRoot, {}));

  // Studio owns the WebSocket panels. Trust its configured origin and its
  // equivalent loopback hostname, along with the application's frontend origin.
  // Custom Studio ports remain explicit; arbitrary local sites are not trusted.
  const studioOrigins = [studio.origin];
  if (studio.hostname === "127.0.0.1" || studio.hostname === "localhost") {
    const alias = new URL(studio.origin);
    alias.hostname = studio.hostname === "localhost" ? "127.0.0.1" : "localhost";
    studioOrigins.push(alias.origin);
  }
  const origins = [...new Set([
    localClientUrl(authored.LOCAL_DEV_URL).origin,
    ...studioOrigins,
  ])].join(",");
  // One name, because one thing reads it: the local dev servers. The auth
  // lambdas' TRUSTED_FRONTEND_ORIGINS is derived from this by the API server,
  // not exported alongside it, so there is no second copy to drift.
  values.set("LOCAL_BROWSER_ORIGINS", origins);
  return values;
}

/**
 * client-app's endpoints for a development deployment: the servers Compose
 * publishes on the host ports localExportValues has already validated.
 *
 * VITE_API_GATEWAY_URL is the target of client-app's HTTP and explicit agent
 * route proxies, read from the repository root by client-app/vite.config.ts.
 *
 * Compose publishes the local WebSocket server at its configured host port.
 * The AWS WebSocket API URL is read from deployment outputs, not from here.
 */
export function localClientEndpoints(
  values: ReadonlyMap<string, string>,
): { apiUrl: string; localWebSocketUrl: string; studioUrl: string } {
  const hostPort = (name: (typeof LOCAL_HOST_PORT_NAMES)[number]): string => {
    const port = values.get(name);
    if (!port) throw new Error(`${name} was not exported. Build the endpoints from localExportValues.`);
    return port;
  };
  const studioUrl = values.get("STUDIO_URL");
  if (!studioUrl) throw new Error("STUDIO_URL was not exported. Build the endpoints from localExportValues.");
  return {
    apiUrl: `http://localhost:${hostPort("LOCAL_API_DEV_SERVER_HOST_PORT")}`,
    localWebSocketUrl: `ws://localhost:${hostPort("LOCAL_WS_DEV_SERVER_HOST_PORT")}`,
    studioUrl,
  };
}

/** Replace owned output only. Conflicts name keys, never their values. */
export function replaceGeneratedEnvironment(existing: string, block: string, names: readonly string[]): string {
  const start = "# BEGIN GENERATED CDK OUTPUTS";
  const end = "# END GENERATED CDK OUTPUTS";
  const first = existing.indexOf(start);
  const last = existing.indexOf(end);
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first) ||
      (first >= 0 && existing.indexOf(start, first + start.length) >= 0) ||
      (last >= 0 && existing.indexOf(end, last + end.length) >= 0)) {
    throw new Error("Root .env has an incomplete generated block. Repair its BEGIN/END markers before exporting.");
  }
  const before = first < 0 ? existing : existing.slice(0, first);
  const after = first < 0 ? "" : existing.slice(last + end.length).replace(/^\r?\n/, "");
  const keys = new Set(names);
  const collisions = [...(before + after).matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)]
    .map((match) => match[1]).filter((key) => keys.has(key));
  if (collisions.length) {
    throw new Error(`Root .env contains authored keys now owned by export: ${[...new Set(collisions)].join(", ")}. Move local settings into cdk-app/.env.dev and remove these root assignments before exporting.`);
  }
  return before + (before && !before.endsWith("\n") ? "\n" : "") + block + after;
}

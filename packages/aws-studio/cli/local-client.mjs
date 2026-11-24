import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Keep the fallback in step with localDevUrl in framework-config/inputs/deployment.ts. */
export function localClientUrl(value) {
  try {
    const url = new URL(value?.trim() || "http://localhost:3000");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || url.port === "0") throw new Error();
    return url;
  } catch {
    throw new Error("LOCAL_DEV_URL in the development inputs file must be an HTTP or HTTPS origin with a port between 1 and 65535, without credentials, path, query or fragment.");
  }
}

/** Read authored development inputs, never shell values or generated root .env. */
export function readLocalClientUrl(root, env = process.env) {
  const file = env.FRAMEWORK_INPUTS_FILE ?? join(root, "cdk-app", ".env.dev");
  const inputs = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return localClientUrl(inputs.LOCAL_DEV_URL);
}

export function localClientPort(url) {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

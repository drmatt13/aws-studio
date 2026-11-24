import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { WebSocketDefaults } from "../shared/websockets";

/**
 * The WebSockets workspace's starting URLs, one per Source mode.
 *
 * Development connects to local-ws-dev-server, whose published port is
 * LOCAL_WS_DEV_SERVER_HOST_PORT in the exported root .env. Production connects
 * to the deployed API Gateway stage, which only a production deployment builds:
 * its WEBSOCKET_API_URL is in .framework/prod/outputs.json, written by a
 * production export. Only those two values are read; nothing else in either
 * file reaches the response.
 */
export function webSocketDefaults(repositoryRoot: string): WebSocketDefaults {
  const file = path.join(repositoryRoot, ".env");
  const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const port = values.LOCAL_WS_DEV_SERVER_HOST_PORT?.trim();
  return {
    local: port && /^[1-9][0-9]*$/.test(port) ? `ws://localhost:${port}?token=` : "",
    apiGateway: productionWebSocketUrl(repositoryRoot),
  };
}

/** The production export's WebSocket stage, or empty before one has recorded a ws(s): URL. */
function productionWebSocketUrl(repositoryRoot: string): string {
  const file = path.join(repositoryRoot, ".framework", "prod", "outputs.json");
  if (!existsSync(file)) return "";
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as { outputs?: Record<string, unknown> }).outputs?.WEBSOCKET_API_URL;
    const url = typeof value === "string" ? value.trim() : "";
    return url && ["ws:", "wss:"].includes(new URL(url).protocol) ? url : "";
  } catch {
    // An unreadable export leaves the panel empty for a URL to be entered.
    return "";
  }
}

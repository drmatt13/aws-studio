import type { AgentLabProvider } from "./agent-lab-api";

const KEY = "aws-studio:agent-preferences:v1";

export interface AgentPreferences {
  readonly provider: AgentLabProvider;
  readonly models: Readonly<Record<AgentLabProvider, string>>;
}

/** Only provider/model choices belong in browser storage; conversations stay in memory. */
export function readAgentPreferences(): AgentPreferences {
  const defaults: AgentPreferences = { provider: "codex", models: { codex: "", claude: "" } };
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return defaults;
    const value = stored as Record<string, unknown>;
    const models = value.models && typeof value.models === "object" && !Array.isArray(value.models)
      ? value.models as Record<string, unknown> : {};
    return {
      provider: value.provider === "claude" ? "claude" : "codex",
      models: {
        codex: typeof models.codex === "string" ? models.codex : "",
        claude: typeof models.claude === "string" ? models.claude : "",
      },
    };
  } catch { return defaults; }
}

export function saveAgentPreferences(preferences: AgentPreferences): void {
  try { localStorage.setItem(KEY, JSON.stringify(preferences)); }
  catch { /* Keep the current session usable when browser storage is unavailable. */ }
}

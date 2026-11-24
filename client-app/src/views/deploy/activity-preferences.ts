import type { AgentView } from "../agent/AgentViewTabs";

const KEY = "aws-studio:activity:v1";
export type ActivityMode = "activity" | "agent";

export interface ActivityPreferences {
  readonly open?: boolean;
  readonly mode?: ActivityMode;
  readonly agentView?: AgentView;
  readonly height?: number;
  readonly wrap?: boolean;
  readonly times?: boolean;
}

/** Per-browser conveniences: an unavailable or corrupt store simply means the defaults. */
export function readActivityPreferences(): ActivityPreferences {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    const value = stored as Record<string, unknown>;
    return {
      ...(typeof value.open === "boolean" ? { open: value.open } : {}),
      ...(value.mode === "activity" || value.mode === "agent" ? { mode: value.mode } : {}),
      ...(value.agentView === "conversation" || value.agentView === "sightline" || value.agentView === "coding" ? { agentView: value.agentView } : {}),
      ...(typeof value.height === "number" && Number.isFinite(value.height) ? { height: value.height } : {}),
      ...(typeof value.wrap === "boolean" ? { wrap: value.wrap } : {}),
      ...(typeof value.times === "boolean" ? { times: value.times } : {}),
    };
  } catch { return {}; }
}

export function saveActivityPreferences(patch: ActivityPreferences): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readActivityPreferences(), ...patch })); }
  catch { /* The tray works without persistence. */ }
}

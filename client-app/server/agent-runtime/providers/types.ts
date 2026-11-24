import type { ExecutionIdentity } from "../../../shared/operations";
export type AgentProvider = "codex" | "claude";
export interface ProviderEvent {
  type: "status" | "message" | "command" | "file" | "permission" | "session" | "diagnostic";
  data: Record<string, unknown>;
}
export interface ProviderApproval {
  id: string;
  kind: "command" | "file";
  description: string;
  /** Approvals never expand the launch-time filesystem or network boundary. */
  input: Record<string, unknown>;
}
export interface ProviderOptions {
  provider: AgentProvider;
  cwd: string;
  scratchDir?: string;
  prompt: string;
  model?: string;
  sessionId?: string;
  signal: AbortSignal;
  onEvent: (event: ProviderEvent) => void | Promise<void>;
  approve?: (request: ProviderApproval) => Promise<boolean>;
  /** Awaited add notification before each tether's first request. A provider may
   * own multiple tethers; retain every identity until the provider call returns.
   */
  onExecution?: (identity: ExecutionIdentity) => void | Promise<void>;
}
export interface ProviderResult {
  sessionId?: string;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  /** Final answer from the acknowledged coding turn. */
  summary?: string;
}

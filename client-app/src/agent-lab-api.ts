import { call } from "./http";
import type { AgentLabModels, AgentLabProvider } from "../shared/agent-lab";

export type { AgentLabModel, AgentLabModels, AgentLabProvider } from "../shared/agent-lab";

export interface AgentLabStatus {
  readonly providers: readonly {
    readonly id: AgentLabProvider;
    readonly label: string;
    readonly available: boolean;
    readonly detail: string;
  }[];
  readonly busy: boolean;
}

export const agentLabApi = {
  status: () => call<AgentLabStatus>("/agent-lab/status"),
  models: (provider: AgentLabProvider, signal?: AbortSignal, refresh = false) =>
    call<AgentLabModels>(`/agent-lab/models?provider=${provider}${refresh ? "&refresh=1" : ""}`, undefined, signal),
};

export const OPEN_ACTIVITY_EVENT = "studio:activity";

/** Reveal a job in the persistent shell tray without coupling it to a route. */
export function openActivity(job: string) {
  window.dispatchEvent(new window.CustomEvent(OPEN_ACTIVITY_EVENT, { detail: job }));
}

export const ASK_AGENT_EVENT = "studio:ask-agent";

/** Open the Agent with an editable prompt in its composer. Nothing sends it. */
export function prepareAgentPrompt(prompt: string) {
  window.dispatchEvent(new window.CustomEvent(ASK_AGENT_EVENT, { detail: prompt }));
}

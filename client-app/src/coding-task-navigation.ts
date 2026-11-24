import type { CodingTask } from "../shared/agent-runtime";

export const OPEN_CODING_TASK_EVENT = "studio:coding-task";
export const PREPARE_CODING_TASK_EVENT = "studio:prepare-coding-task";
export const CODING_PROMPT_LIMIT = 16_000;
export const codingTaskSelectionKey = (repository: string) => `aws-studio:coding-task:v1:${repository}`;
export interface CodingTaskNavigation { readonly repository: string; readonly task: CodingTask }
export interface PreparedCodingTask {
  readonly id: string;
  readonly prompt: string;
}
export interface CodingTaskPreparation { readonly repository: string; readonly request: PreparedCodingTask }

/** Reveal an editable request. The persistent tray retains it until its lazy composer accepts it. */
export function prepareCodingTask(repository: string, request: PreparedCodingTask) {
  if (!repository || !request.id || !request.prompt.trim() || request.prompt.length > CODING_PROMPT_LIMIT) throw new Error("A prepared coding request must contain at most 16,000 characters.");
  window.dispatchEvent(new window.CustomEvent<CodingTaskPreparation>(PREPARE_CODING_TASK_EVENT, { detail: { repository, request } }));
}

/** Reveal an accepted task; this browser event grants no source-write authority. */
export function openCodingTask(repository: string, task: CodingTask) {
  try { localStorage.setItem(codingTaskSelectionKey(repository), task.id); } catch { /* The event still selects this task for the mounted session. */ }
  window.dispatchEvent(new window.CustomEvent<CodingTaskNavigation>(OPEN_CODING_TASK_EVENT, { detail: { repository, task } }));
}

import type { DiffLine } from "../shared/api";
import type { CodingContractProgress, CodingEvent, CodingProposal, CodingTask, CodingTaskStatus, CodingValidationPlan, ContractCheckpoint } from "../shared/agent-runtime";
import { isContractProofReceipt, sameProofToolchain } from "aws-studio/contract-chain/contract-proof-response";
import { PROOF_PREDECESSORS } from "aws-studio/contract-chain/contract-proof";
import type { ContractProofReceipt } from "aws-studio/contract-chain/contract-proof";

export function codingValidationChoice(kind: CodingValidationPlan["kind"] | "automatic", text: string): { plan?: CodingValidationPlan; problem?: string } {
  if (kind === "automatic") return {};
  if (kind !== "tests") return { plan: { kind } };
  const paths = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
  if (!paths.length || paths.length > 20) return { problem: "Enter 1–20 repository-relative test paths, one per line." };
  if (paths.some(name => name.length > 1000 || /^[-/\\]/.test(name) || /[\x00-\x1f\\:]/.test(name) || name.split("/").some(part => !part || part === "." || part === ".."))) return { problem: "Test paths must stay inside this project and identify source files." };
  return { plan: { kind, paths } };
}

export const codingStatusLabel: Record<CodingTaskStatus, string> = {
  queued: "Queued", preparing: "Preparing workspace", running: "Coding", validating: "Validating", waiting_for_permission: "Permission required",
  awaiting_review: "Ready for review", conflicted: "Source changed", integrating: "Applying approved files", completed: "Completed",
  interrupted: "Interrupted", failed: "Failed", cancelled: "Cancelled", rejected: "Rejected", recovery_required: "Source recovery required",
};
/** Presentation eligibility only; the host independently revalidates before application. */
export function codingCheckpointReceipt(contract: CodingContractProgress, checkpoint: ContractCheckpoint) {
  const receipt = contract.proofs?.[checkpoint.stage];
  return receipt && isContractProofReceipt(receipt) && receipt.scope === "candidate" && receipt.stage === checkpoint.stage && receipt.id === checkpoint.receiptId
    && PROOF_PREDECESSORS[receipt.stage].every(stage => {
      const predecessor = contract.proofs?.[stage];
      return predecessor && isContractProofReceipt(predecessor) && predecessor.scope === "candidate" && predecessor.stage === stage && predecessor.id === receipt.predecessors[stage] && sameProofToolchain(predecessor.toolchain, receipt.toolchain);
    }) ? receipt : undefined;
}
function candidateLineagePassed(contract: CodingContractProgress, receipt: ContractProofReceipt): boolean {
  return receipt.checks.length > 0 && receipt.checks.every(check => check.outcome === "passed") && PROOF_PREDECESSORS[receipt.stage].every(stage => {
    const predecessor = contract.proofs?.[stage];
    return !!predecessor && isContractProofReceipt(predecessor) && predecessor.stage === stage && predecessor.scope === "candidate" && predecessor.id === receipt.predecessors[stage] && sameProofToolchain(predecessor.toolchain, receipt.toolchain) && candidateLineagePassed(contract, predecessor);
  });
}
export function codingCheckpointPassed(contract: CodingContractProgress, checkpoint: ContractCheckpoint): boolean {
  const receipt = codingCheckpointReceipt(contract, checkpoint);
  return checkpoint.status === "passed" && !!receipt && candidateLineagePassed(contract, receipt) && checkpoint.checks.length > 0 && checkpoint.checks.every(check => check.status === "passed" && check.candidateDigest === checkpoint.candidateDigest);
}
export function codingContractProofProblem(task: CodingTask, proposal?: CodingProposal): string | undefined {
  const contract = task.contract;
  if (!contract) return undefined;
  if (contract.checkpoints.some(checkpoint => {
    if (checkpoint.status !== "passed") return false;
    return !codingCheckpointPassed(contract, checkpoint);
  })) return "Versioned candidate proof is missing or no longer matches these checkpoints. Refresh and independently validate before continuing.";
  if (contract.status === "ready") {
    const checkpoint = [...contract.checkpoints].reverse().find(checkpoint => checkpoint.stage === contract.stage), receipt = checkpoint && codingCheckpointReceipt(contract, checkpoint);
    if (!checkpoint || checkpoint.status !== "passed" || !receipt || !receipt.checks.length || receipt.checks.some(check => check.outcome !== "passed") || proposal && checkpoint.candidateDigest !== proposal.candidateDigest) return "Current independently validated client proof is required before this candidate is ready for application.";
  }
  return undefined;
}
export function codingApprovalProblem(task: CodingTask, proposal: CodingProposal): string | undefined {
  if (task.id !== proposal.taskId || task.proposalDigest !== proposal.digest) return "The reviewed proposal no longer matches this task. Refresh before applying.";
  if (task.status !== "awaiting_review") return "This task is not awaiting source approval.";
  if (task.contract && task.contract.status !== "ready") return task.contract.gateReason ?? "Complete the required contract stages and review decisions before applying.";
  const proofProblem = codingContractProofProblem(task, proposal);
  if (proofProblem) return proofProblem;
  if (!proposal.changes.length && task.contract?.status !== "ready") return "There are no source changes to apply.";
  if (proposal.activation === "dependency_install_required") return "Dependency changes need a separate installation before this proposal can be applied.";
  if (proposal.ownership?.refusal) return `Ownership: ${proposal.ownership.refusal}`;
  if (!proposal.validation.length || proposal.validation.some(check => check.status !== "passed" || check.candidateDigest !== proposal.candidateDigest)) return "Checks must pass for this version before you can apply it.";
  return undefined;
}
export function codingActivationProblem(task: CodingTask, proposal: CodingProposal): string | undefined {
  if (task.id !== proposal.taskId || task.proposalDigest !== proposal.digest) return "Refresh the applied proposal before restarting Studio.";
  if (task.status !== "completed" || task.sourceOutcome !== "applied" || task.activation !== "restart_required" || proposal.activation !== "restart_required") return "Apply the reviewed Studio source changes before requesting restart.";
  if (task.runtimeActivation?.status === "starting") return "Studio restart is already in progress.";
  if (task.runtimeActivation?.status === "ready") return "Studio has restarted. Reload this page to reconnect.";
  return undefined;
}
export function mergeCodingEvents(before: readonly CodingEvent[], next: readonly CodingEvent[]): readonly CodingEvent[] {
  const events = new Map(before.map(event => [event.seq, event]));
  for (const event of next) events.set(event.seq, event);
  return [...events.values()].sort((a, b) => a.seq - b.seq).slice(-1000);
}
export interface CodingProgressItem { readonly seq: number; readonly type: CodingEvent["type"]; readonly text: string }
/** Provider message events are text deltas. Keep their exact whitespace and item boundaries. */
export function codingProgressItems(events: readonly CodingEvent[]): readonly CodingProgressItem[] {
  const rows: CodingProgressItem[] = [];
  let previous: CodingEvent | undefined;
  for (const event of events) {
    const text = codingEventText(event), last = rows.at(-1);
    if (last && event.type === "message" && previous?.type === "message" && event.taskId === previous.taskId && event.data.itemId === previous.data.itemId && typeof event.data.text === "string" && typeof previous.data.text === "string") {
      const joined = last.text + text;
      rows[rows.length - 1] = { ...last, text: joined.length > 32_000 ? `…${joined.slice(-31_999)}` : joined };
    } else rows.push({ seq: event.seq, type: event.type, text });
    previous = event;
  }
  return rows.slice(-100);
}

function latestEvent(events: readonly CodingEvent[], matches: (event: CodingEvent) => boolean): CodingEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (matches(event)) return event;
  }
}

function currentAttempt(events: readonly CodingEvent[]): readonly CodingEvent[] {
  const queued = latestEvent(events, event => event.type === "state" && event.data.status === "queued");
  return queued ? events.filter(event => event.seq > queued.seq) : events;
}

function commandLabel(command: unknown): string | undefined {
  const text = typeof command === "string" ? command : Array.isArray(command) ? command.filter(value => typeof value === "string").join(" ") : undefined;
  return text?.trim() || undefined;
}

function fileActivityPaths(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap(change => {
    if (typeof change?.path !== "string") return [];
    const path = change.path.replaceAll("\\", "/");
    // Native clients can report absolute paths in older task logs.
    const name = /^(?:\/|[a-z]:\/)/i.test(path) ? path.split("/").at(-1) : path;
    return name ? [name] : [];
  });
}

export function codingLiveStatus(task: CodingTask, events: readonly CodingEvent[]): string {
  if (task.cancelRequested) return "Stopping the task and retaining its work so far.";
  if (task.contract?.approval?.status === "checking") return "Checking saved project files before recording the approvals.";
  const attempt = currentAttempt(events);
  const provider = task.provider === "codex" ? "Codex" : "Claude";
  switch (task.status) {
    case "queued": return "Waiting for an available coding slot.";
    case "preparing": return task.summary || "Setting up a private copy of the project.";
    case "running":
      if (task.contract?.stage === "codegen") return "Setting up GraphQL generation.";
      if (task.summary === "Staging the changes you reviewed.") return task.summary;
      if (attempt.some(event => event.data.phase === "agent_turn_started" || event.type === "message" || event.type === "file" || event.type === "command" && event.data.validation !== true)) return `${provider} is working in the private copy.`;
      if (attempt.some(event => event.data.phase === "sandbox_verified")) return `Workspace permissions verified. Sending your request to ${provider}.`;
      return `Starting ${provider} and checking its workspace permissions.`;
    case "validating": {
      const start = latestEvent(attempt, event => event.type === "state" && event.data.status === "validating");
      const phase = latestEvent(attempt, event => event.seq > (start?.seq ?? 0) && event.data.code === "REVIEW_PREPARATION" && typeof event.data.message === "string");
      return (phase?.data.message as string | undefined) ?? task.summary ?? "Running independent checks in the private copy.";
    }
    case "waiting_for_permission": return "The task pauses until you answer the permission request.";
    case "integrating": return "Writing the approved files to the project.";
    default: return "";
  }
}

interface CodingActivityRow { readonly seq: number; readonly label: string; readonly text: string; readonly code?: true }
function shortActivity(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 220 ? line : `${line.slice(0, 219)}…`;
}

/** Live activity highlights real work. Output frames and session bookkeeping stay in the log. */
export function codingRecentActivity(events: readonly CodingEvent[]): readonly CodingActivityRow[] {
  const attempt = currentAttempt(events).filter(event => event.type === "message" || event.type === "file"
    || event.type === "validation" && !!event.data.command
    || event.type === "command" && (event.data.phase === undefined || event.data.phase === "started" || event.data.phase === "completed"));
  const bySeq = new Map(attempt.map(event => [event.seq, event]));
  const rows = new Map<string | number, CodingActivityRow>();
  for (const item of codingProgressItems(attempt)) {
    const event = bySeq.get(item.seq)!;
    const { phase, status, itemId, exitCode, command, changes } = event.data;
    if (item.type === "message") {
      if (item.text.trim()) rows.set(item.seq, { seq: item.seq, label: "Agent update", text: shortActivity(item.text) });
    } else if (item.type === "file" && phase !== "started") {
      const paths = fileActivityPaths(changes);
      if (paths.length) rows.set(item.seq, { seq: item.seq, label: paths.length === 1 ? "File updated" : "Files updated", text: shortActivity(paths.join(", ")), code: true });
    } else if (item.type === "command" || item.type === "validation") {
      const key = item.type === "validation" && typeof command === "string" ? `check:${command}` : typeof itemId === "string" ? itemId : item.seq;
      const prior = rows.get(key);
      const label = commandLabel(command) ?? prior?.text;
      if (!label) continue;
      let outcome = "Running command";
      if (item.type === "validation") outcome = status === "passed" ? "Check passed" : status === "failed" ? "Check failed" : status === "unavailable" ? "Check unavailable" : "Running project check";
      else if (typeof exitCode === "number") outcome = exitCode === 0 ? "Command finished" : `Command exited with code ${exitCode}`;
      else if (phase === "completed") outcome = status === "failed" ? "Command failed" : "Command finished";
      rows.set(key, { seq: item.seq, label: outcome, text: shortActivity(label), code: true });
    }
  }
  return [...rows.values()].sort((a, b) => b.seq - a.seq).slice(0, 3);
}

/** The host owns diff generation; the browser only presents its unified hunks. */
export function codingDiffLines(unified: string): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0, newLine = 0, hunk: string | undefined, inHunk = false;
  for (const text of unified.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); hunk = text; inHunk = true; continue; }
    if (!inHunk) continue;
    if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), newLine: newLine++, ...(hunk ? { hunk } : {}) });
    else if (text.startsWith("-")) lines.push({ kind: "remove", text: text.slice(1), oldLine: oldLine++, ...(hunk ? { hunk } : {}) });
    else if (text.startsWith(" ")) lines.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++, ...(hunk ? { hunk } : {}) });
    else if (text.startsWith("\\")) lines.push({ kind: "context", text });
    else continue;
    hunk = undefined;
  }
  return lines;
}
export function codingEventText(event: CodingEvent): string {
  const { text, message, summary, output, stdout, stderr, description, status, command, reason, phase, exitCode } = event.data;
  const commandText = commandLabel(command);
  const files = event.type === "file" ? fileActivityPaths(event.data.changes).join("\n") : "";
  const stream = [stdout, stderr].filter(value => typeof value === "string" && value).join("\n");
  const contents = typeof text === "string" ? text : typeof message === "string" ? message : typeof output === "string" ? output : typeof summary === "string" ? summary : files ? files : stream ? [commandText, stream].filter(Boolean).join("\n") : commandText ?? (typeof description === "string" ? description : typeof reason === "string" ? reason : typeof phase === "string" ? phase.replaceAll("_", " ") : typeof status === "string" ? status.replaceAll("_", " ") : event.type);
  return `${contents}${typeof exitCode === "number" ? ` (exit ${exitCode})` : ""}`.slice(0, 8000);
}

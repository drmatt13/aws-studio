import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { ContractDecision } from "../../shared/contract-propagation";

export const contractDecisionReportPath = (scratch: string) => path.join(scratch, "contract-decision-report.json");
const limit = 32 * 1024;
type DecisionReport = { readonly status: "resolved" } | { readonly status: "needs-decision"; readonly decisions: readonly { readonly id: string; readonly reason: string }[] };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Every native turn must produce new evidence; a previous turn's report cannot satisfy it. */
export function clearContractDecisionReport(file: string): void {
  try {
    if (realpathSync(path.dirname(file)) !== path.resolve(path.dirname(file))) throw new Error("Linked scratch directory");
    unlinkSync(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not clear the previous contract decision report. Preserve the candidate and inspect its scratch file before resuming."); }
}

/** Conservative agent blockers can remove readiness, never establish application decisions. */
export function readContractDecisionReport(file: string, decisions: readonly ContractDecision[]): DecisionReport {
  const problem = "The coding agent must write a valid contract decision report for this turn. Resume the retained candidate to report resolved intent or the specific developer decisions required.";
  let fd: number | undefined;
  try {
    if (realpathSync(path.dirname(file)) !== path.resolve(path.dirname(file))) throw new Error(problem);
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error(problem);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(problem);
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const read = readSync(fd, bytes, length, bytes.length - length, length); if (!read) break; length += read; }
    const after = fstatSync(fd), current = lstatSync(file);
    if (length > limit || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) throw new Error(problem);
    const report: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!plain(report)) throw new Error(problem);
    if (report.status === "resolved" && Object.keys(report).length === 1) return { status: "resolved" };
    if (report.status !== "needs-decision" || Object.keys(report).length !== 2 || !Array.isArray(report.decisions) || !report.decisions.length || report.decisions.length > 256) throw new Error(problem);
    const known = new Set(decisions.map(item => item.id)), ids = new Set<string>();
    for (const decision of report.decisions) {
      if (!plain(decision) || Object.keys(decision).length !== 2 || typeof decision.id !== "string" || !known.has(decision.id) || ids.has(decision.id) || typeof decision.reason !== "string" || !decision.reason.trim() || decision.reason.length > 2000 || decision.reason.includes("\0")) throw new Error(problem);
      ids.add(decision.id);
    }
    return report as DecisionReport;
  } catch { throw new Error(problem); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function contractDecisionReportPrompt(file: string, decisions: readonly ContractDecision[]): string {
  return `\nBefore completing this contract stage, write a fresh JSON file at this exact scratch path: ${JSON.stringify(file)}. This report is mandatory even for a no-op. Use exactly {"status":"resolved"} only when the established preservation instructions resolve every application decision you need. If compatibility needs missing, contradictory or new developer intent, do not invent a policy: write {"status":"needs-decision","decisions":[{"id":"an exact allowed decision id","reason":"the concrete question the developer must resolve"}]}. Allowed IDs owned by this stage: ${JSON.stringify(decisions.map(item => item.id))}. Report a dependency ambiguity against this stage's affected decision and explain its upstream dependency in the reason; do not rewrite earlier-stage decisions. Use at most 256 entries and 2000 characters per reason; the file must be at most 32768 bytes. Do not include secrets. A resolved report cannot establish any decision still marked unresolved. This conservative report is separate from source, tests, review acceptance and final application approval.\n`;
}

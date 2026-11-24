import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CodingOwnershipReview, CodingProposal } from "../../shared/agent-runtime";
import type { StudioState } from "../snapshot";
import { EditError } from "aws-studio/source/io";
import { assessOwnership, ownershipRelevantFile, type ProposedChange } from "./ownership-guard";

/**
 * Ownership review of a Coding-task proposal, in the Studio server, which holds the snapshot
 * the agent host never evaluates. It runs when the proposal is shown and again when it is
 * approved; the host applies an approved proposal only to the exact baseline it was made
 * from, so the approval-time check holds for the bytes written.
 *
 * Proposed file contents are rebuilt from each change's complete diff and accepted only when
 * they match the proposal's own SHA-256. A change Studio cannot rebuild is refused only when
 * it touches a file that matters to ownership.
 */

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const lines = (text: string) => text === "" ? [] : text.replace(/\n$/, "").split("\n");

/** Candidate results of applying one `sourceDiff` unified diff; the caller selects by hash. */
export function applySourceDiff(before: string, unified: string): readonly string[] | undefined {
  const source = lines(before), out: string[] = [];
  let cursor = 0;
  const body = unified.split("\n").slice(2);
  for (let at = 0; at < body.length; at++) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(body[at]!);
    if (!header) { if (body[at] === "" && at === body.length - 1) continue; return undefined; }
    const start = Number(header[2]) ? Number(header[1]) - 1 : Number(header[1]);
    if (start < cursor || start > source.length) return undefined;
    out.push(...source.slice(cursor, start)); cursor = start;
    for (at++; at < body.length && !body[at]!.startsWith("@@ "); at++) {
      const line = body[at]!, text = line.slice(1);
      if (line.startsWith("\\")) continue;
      if (line.startsWith("+")) out.push(text);
      else if (line.startsWith(" ") || line.startsWith("-")) {
        if (source[cursor] !== text) return undefined;
        if (line.startsWith(" ")) out.push(text);
        cursor++;
      } else if (line === "" && at === body.length - 1) continue;
      else return undefined;
    }
    at--;
  }
  out.push(...source.slice(cursor));
  const joined = out.join("\n");
  return joined === "" ? [""] : [`${joined}\n`, joined];
}

function read(file: string): Buffer | null {
  try { return readFileSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function reviewProposalOwnership(root: string, state: StudioState | undefined, proposal: Pick<CodingProposal, "changes">): CodingOwnershipReview {
  if (!state) return { checked: false, transitions: [], refusal: "Studio has no evaluated graph yet, so it cannot check this proposal against ownership. Wait for the graph to load, then review again." };
  const changes: ProposedChange[] = [];
  for (const change of proposal.changes) {
    const file = path.join(root, change.path);
    const current = read(file);
    if ((current === null ? null : sha256(current)) !== change.beforeHash) return { checked: false, transitions: [], refusal: `${change.path} changed since this proposal was made. Refresh the task before approving it.` };
    const before = current === null ? null : current.toString("utf8");
    let after: string | null | undefined = null;
    if (change.afterHash !== null) after = change.binary ? undefined : applySourceDiff(before ?? "", change.diff)?.find(candidate => sha256(candidate) === change.afterHash);
    if (after === undefined) {
      if (ownershipRelevantFile(root, state, file)) return { checked: false, transitions: [], refusal: `Studio could not rebuild the proposed ${change.path} exactly, and that file holds declarations or stack source whose ownership it must check. The proposal cannot be approved here.` };
      continue;
    }
    changes.push({ file, before, after });
  }
  try { return { checked: true, transitions: assessOwnership(root, state, changes) }; }
  catch (error) {
    if (error instanceof EditError) return { checked: true, transitions: [], refusal: error.message };
    throw error;
  }
}

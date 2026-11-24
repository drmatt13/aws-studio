import type { JobLogLine } from "../../shared/operations";
import { editorLink } from "../lookup";

export type LineSeverity = "error" | "warning" | "command" | "note" | "plain";

// Tools write ordinary progress to stderr, so a stream alone never makes a line a problem.
const STDERR_FAILURE = /\b(error|failed|failure|refus\w*|denied|cannot|could not|unable|not allowed|not authorized|exception)\b|AccessDenied|exited with (?:status|code) [1-9]|✖|❌/i;
const STDERR_WARNING = /\b(warn(?:ing)?s?|deprecat\w*)\b|⚠/i;
// Elsewhere a line must be unmistakable: "0 errors" and ErrorBoundary are not problems.
const OUTPUT_FAILURE = /^\s*(?:error|fatal)\b|npm ERR!|✖|❌/i;
const OUTPUT_FAILED_STATUS = /[A-Z]_FAILED\b/;
const OUTPUT_WARNING = /^\s*\[?warn(?:ing)?\b|npm WARN|ROLLBACK_(?:IN_PROGRESS|COMPLETE)|⚠/i;

/** esbuild's per-asset output during `cdk synth`: real, and rarely what a developer came to read. */
const BUNDLING_START = /^Bundling asset /;
const BUNDLING = /^(?:Bundling asset |\s+\S+\s+\d[\d.]*\s?(?:b|kb|mb)\s*$|⚡\s*Done in |\s*$)/i;
const MINIMUM_FOLD = 4;

interface LineFacts { readonly severity: LineSeverity; readonly noise: boolean }
/** Lines are immutable and live as long as the store keeps them: each is classified once. */
const classified = new WeakMap<JobLogLine, LineFacts>();

function severity({ stream, text }: JobLogLine): LineSeverity {
  if (stream === "info" && text.startsWith("$ ")) return "command";
  if (stream === "err") return STDERR_FAILURE.test(text) ? "error" : STDERR_WARNING.test(text) ? "warning" : "plain";
  if (OUTPUT_FAILURE.test(text) || OUTPUT_FAILED_STATUS.test(text)) return "error";
  if (OUTPUT_WARNING.test(text)) return "warning";
  return stream === "info" ? "note" : "plain";
}

function facts(line: JobLogLine): LineFacts {
  let known = classified.get(line);
  if (!known) {
    const level = severity(line);
    known = { severity: level, noise: level === "plain" && BUNDLING.test(line.text) };
    classified.set(line, known);
  }
  return known;
}

export const severityOf = (line: JobLogLine): LineSeverity => facts(line).severity;
const isProblem = (line: JobLogLine) => { const level = severityOf(line); return level === "error" || level === "warning"; };
export const problemCount = (lines: readonly JobLogLine[]) => lines.reduce((count, line) => count + (isProblem(line) ? 1 : 0), 0);
export const firstError = (lines: readonly JobLogLine[]) => lines.find(line => severityOf(line) === "error");

export interface LogView { readonly query: string; readonly problemsOnly: boolean; readonly opened: ReadonlySet<number> }
export type LogRow =
  | { readonly kind: "line"; readonly line: JobLogLine }
  | { readonly kind: "fold"; readonly id: number; readonly label: string; readonly lines: readonly JobLogLine[]; readonly open: boolean };

/** Filtering shows every match, so folds exist only in the unfiltered reading order. */
export function visibleLines(lines: readonly JobLogLine[], { query, problemsOnly }: Pick<LogView, "query" | "problemsOnly">): readonly JobLogLine[] {
  const needle = query.trim().toLowerCase();
  if (!needle && !problemsOnly) return lines;
  return lines.filter(line => (!problemsOnly || isProblem(line)) && (!needle || line.text.toLowerCase().includes(needle)));
}

export function logRows(lines: readonly JobLogLine[], view: LogView): readonly LogRow[] {
  if (view.query.trim() || view.problemsOnly) return visibleLines(lines, view).map(line => ({ kind: "line", line }));
  const rows: LogRow[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index;
    while (end < lines.length && facts(lines[end]!).noise) end++;
    const run = lines.slice(index, end);
    const assets = run.filter(line => BUNDLING_START.test(line.text)).length;
    if (assets && run.length >= MINIMUM_FOLD) {
      const id = run[0]!.seq, open = view.opened.has(id);
      rows.push({ kind: "fold", id, label: `Bundled ${assets} ${assets === 1 ? "asset" : "assets"}`, lines: run, open });
      if (open) for (const line of run) rows.push({ kind: "line", line });
      index = end;
    } else {
      for (const line of run) rows.push({ kind: "line", line });
      index = end;
      if (index < lines.length && !facts(lines[index]!).noise) rows.push({ kind: "line", line: lines[index++]! });
    }
  }
  return rows;
}

export type LinkPart = string | { readonly text: string; readonly href: string };

const DESTINATION = /https?:\/\/[^\s"'<>)\]]+|arn:aws:cloudformation:[a-z0-9-]+:\d{12}:stack\/[^\s"'<>)\]]+|(?<![\w/.:-])(?:\/?[\w.@-]+\/)+[\w.@-]+\.\w+(?::\d+(?::\d+)?|\(\d+,\d+\))/g;

function destination(text: string, root: string | undefined): string | undefined {
  if (/^https?:/.test(text)) return text;
  const stack = /^arn:aws:cloudformation:([a-z0-9-]+):/.exec(text);
  if (stack) return `https://${stack[1]}.console.aws.amazon.com/cloudformation/home?region=${stack[1]}#/stacks/stackinfo?stackId=${encodeURIComponent(text)}`;
  const place = /^(.+?)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))$/.exec(text);
  if (!root || !place) return undefined;
  const base = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const path = place[1]!;
  if (path.startsWith("/") && !path.startsWith(`${base}/`)) return undefined;
  return editorLink(base, { file: path.startsWith("/") ? path.slice(base.length + 1) : path, line: Number(place[2] ?? place[4]), column: Number(place[3] ?? place[5] ?? 1), start: 0, end: 0 });
}

/** A log line's text with its web, stack and source destinations as links. */
export function linkParts(text: string, root: string | undefined): readonly LinkPart[] {
  const parts: LinkPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(DESTINATION)) {
    const found = match[0].replace(/[.,;:]+$/, "");
    const href = destination(found, root);
    if (!href) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push({ text: found, href });
    cursor = match.index + found.length;
  }
  if (!parts.length) return [text];
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

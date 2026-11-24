import type { ReactNode } from "react";
import { categorize, parseRule, type AccessCategory, type Placement } from "aws-studio/database/access-syntax";

/** The same colours as the editor: what each part of a rule is about. */
const TONES: Readonly<Record<AccessCategory, string>> = {
  identity: "text-access-identity",
  role: "text-access-role",
  path: "text-access-path",
  state: "text-access-state",
  limit: "text-access-limit font-semibold",
  action: "text-ink font-semibold",
  column: "text-ink underline decoration-dotted underline-offset-2",
  punctuation: "",
};

/** One access rule as code, coloured by category; unparseable text is shown as written. */
export function AccessCode({ text, placement, className }: { readonly text: string; readonly placement: Placement; readonly className?: string }) {
  let parts: ReactNode[] = [text];
  try {
    const spans = categorize(parseRule(text, placement));
    parts = [];
    let at = 0;
    for (const [index, span] of spans.entries()) {
      if (span.from > at) parts.push(text.slice(at, span.from));
      parts.push(<span key={index} className={TONES[span.category]}>{text.slice(span.from, span.to)}</span>);
      at = span.to;
    }
    if (at < text.length) parts.push(text.slice(at));
  } catch { /* Shown as written: the editor underlines the problem. */ }
  return <code data-ui="access-code" className={`font-mono text-caption wrap-anywhere text-graphite ${className ?? ""}`}>{parts}</code>;
}

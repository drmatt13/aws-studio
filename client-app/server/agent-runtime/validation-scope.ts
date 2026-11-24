import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CodingValidation, CodingValidationPlan } from "../../shared/agent-runtime";
import { frameworkValidationCommands } from "./providers/validation";
import { AgentRuntimeError } from "./store";
import { AgentWorkspaceError, type AgentFileChange, type SourceManifest } from "aws-studio/source/workspace";

export function isCodingDocumentation(change: AgentFileChange): boolean {
  return /^(?:docs\/.+|(?:[^.\/][^/]*\/)*(?:README|QUICKSTART|CHANGELOG|CONTRIBUTING))\.md$/.test(change.path)
    && !((change.before?.mode ?? 0) & 0o111) && !((change.after?.mode ?? 0) & 0o111);
}

const isDeclaration = (name: string) => name === "framework.config.ts" || /^framework-config\/.+\.ts$/.test(name);
const isFrameworkProjection = (name: string) => name === "docker-compose.services.yml" || /^(?:packages\/aws-studio|packages\/api-contract)\/src\/generated\//.test(name);

function isDeclarationOnlyChange(changes: readonly AgentFileChange[]): boolean {
  return changes.some(change => isDeclaration(change.path))
    && changes.every(change => isDeclaration(change.path) || isFrameworkProjection(change.path) || isCodingDocumentation(change));
}

export function codingValidationCommands(cwd: string, candidate: SourceManifest, changes: readonly AgentFileChange[], plan?: CodingValidationPlan) {
  if (plan?.kind === "tests") {
    if (plan.paths.some(name => !Object.hasOwn(candidate.files, name))) throw new AgentRuntimeError(422, "A selected test file is absent from the candidate.");
    const loader = Object.keys(candidate.files).some(name => name.endsWith(".ts") || name.endsWith(".tsx")) ? ["--import", "tsx"] : [];
    return [{ file: "node", args: ["--conditions=development", ...loader, "--test", "--", ...plan.paths] }];
  }
  let scripts: Record<string, unknown> | undefined;
  if (Object.hasOwn(candidate.files, "package.json")) {
    try { scripts = (JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> } | null)?.scripts; }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  const hasScript = (name: string) => {
    const command = scripts?.[name];
    return typeof command === "string" && command.trim().length > 0;
  };
  if (hasScript("framework:check") && (plan?.kind === "framework" || !plan && isDeclarationOnlyChange(changes))) {
    return frameworkValidationCommands(scripts, cwd) ?? [{ file: "npm", args: ["run", "framework:check"] }];
  }
  if (plan?.kind === "framework") return [];
  if (hasScript("verify")) return [{ file: "npm", args: ["run", "verify"] }];
  if (hasScript("test")) return [{ file: "npm", args: ["test"] }];
  return [];
}

/** Report the actual static checks on changed Markdown without evaluating candidate code. */
export function checkCodingDocumentation(cwd: string, changes: readonly AgentFileChange[], candidateDigest: string): CodingValidation {
  const command = "Markdown text check";
  let checked = 0;
  for (const { path: name, after } of changes) {
    if (!after) continue;
    const bytes = readFileSync(path.join(cwd, name));
    if (createHash("sha256").update(bytes).digest("hex") !== after.hash) throw new AgentWorkspaceError(409, "Documentation changed while checks were running. Check the current files again.");
    if (!isUtf8(bytes) || bytes.includes(0)) return { command, status: "failed", candidateDigest, detail: `${name} must contain UTF-8 text.` };
    let opened = false, separated = false;
    for (const [marker] of bytes.toString("utf8").matchAll(/^(?:<{7} |={7}(?=\r?$)|>{7} )/gm)) {
      if (marker.startsWith("<")) { opened = true; separated = false; }
      else if (marker.startsWith("=")) separated = opened;
      else if (separated) return { command, status: "failed", candidateDigest, detail: `${name} contains an unresolved merge conflict.` };
    }
    checked++;
  }
  return { command, status: "passed", candidateDigest, detail: checked ? `Checked ${checked} changed Markdown ${checked === 1 ? "file" : "files"} for valid UTF-8 and merge conflicts.` : "The documentation changes only removed files." };
}

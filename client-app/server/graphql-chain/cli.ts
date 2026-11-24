import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerStage, ReviewScope } from "aws-studio/contract-chain/graphql-chain";
import type { ReviewDecisions } from "aws-studio/contract-chain/contract-proof";
import { EditError } from "aws-studio/source/io";
import { findRepositoryRoot } from "../inputs";
import { GraphQLChainReviews } from "./review";
import { GraphQLChainService } from "./service";
import { readReviewDecision, readReviewDecisions } from "aws-studio/contract-chain/proof-core";
import { contractGateExitCode } from "aws-studio/contract-chain/ci";
import { runFrameworkChainCli } from "aws-studio/contract-chain/cli";

/** Explicit local CLI input only; it cannot select a writer, command or output path. */
export function readCliReviewDecisions(root: string, scope: ReviewScope, input: { readonly statement?: string; readonly evidence?: string; readonly file?: string }): ReviewDecisions | undefined {
  if (input.file && (input.statement !== undefined || input.evidence !== undefined)) throw new EditError(400, "Choose a decision/evidence pair or one decisions JSON file.");
  if (input.file) {
    const selected = path.resolve(root, input.file);
    if (lstatSync(selected).isSymbolicLink()) throw new EditError(422, "Review decisions must be a regular JSON file without links.");
    const file = realpathSync(selected), descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let decisions: ReviewDecisions;
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1 || before.size > 32 * 1024) throw new EditError(422, "Review decisions must be bounded JSON smaller than 32 KiB.");
      const bytes = Buffer.alloc(before.size + 1); let count = 0;
      while (count < bytes.length) { const read = readSync(descriptor, bytes, count, bytes.length - count, count); if (!read) break; count += read; }
      const after = fstatSync(descriptor);
      if (count !== before.size || after.size !== before.size || after.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new EditError(409, "Review decisions changed while reading. Review them again.");
      decisions = readReviewDecisions(JSON.parse(bytes.subarray(0, count).toString("utf8")));
    } finally { closeSync(descriptor); }
    if (scope.kind === "baseline") {
      if (!decisions.api || !decisions.client) throw new EditError(400, "A baseline requires separate explicit API and client decisions.");
      return decisions;
    }
    if (scope.kind === "model") throw new EditError(400, "Model acknowledgement does not accept API or client decisions.");
    const selectedDecision = decisions[scope.kind];
    if (!selectedDecision) throw new EditError(400, `The decisions file has no ${scope.kind} review declaration.`);
    return { [scope.kind]: selectedDecision };
  }
  if (input.statement === undefined && input.evidence === undefined) return undefined;
  if (scope.kind !== "api" && scope.kind !== "client") throw new EditError(400, "Use a decisions JSON file with separate API and client decisions for a baseline.");
  return { [scope.kind]: readReviewDecision({ statement: input.statement, evidence: input.evidence }) };
}

/** Fixed verbs only. No command strings, arbitrary paths or application actions. */
export async function runChainCli(args: readonly string[], root: string, emit: (value: unknown) => void, service = new GraphQLChainService(root)): Promise<number> {
  try {
    // The application's own verbs run the framework's implementation unchanged.
    if (args[0] === "verify" || args[0] === "record" || args.length === 1 && args[0] === "init") return await runFrameworkChainCli(args, root, emit);
    if (!args.length || args[0] === "status" || args[0] === "--check") {
      if (args.some(value => !["status", "--json", "--check"].includes(value))) throw new EditError(400, "Use status --json or --check.");
      const chain = await service.load(true); emit(chain);
      if (!args.includes("--check")) return 0;
      return contractGateExitCode(chain);
    }
    if (args[0] !== "accept") throw new EditError(400, "Use status --json, --check, verify, init, or accept with a review scope and --expected revision.");
    let scope: ReviewScope | undefined, expectedRevision: string | undefined, statement: string | undefined, evidence: string | undefined, decisionsFile: string | undefined;
    for (let index = 1; index < args.length; index++) {
      const flag = args[index];
      if (flag === "--expected" && !expectedRevision) expectedRevision = args[++index];
      else if (flag === "--decision" && statement === undefined && args[index + 1] !== undefined) statement = args[++index];
      else if (flag === "--evidence" && evidence === undefined && args[index + 1] !== undefined) evidence = args[++index];
      else if (flag === "--decisions-file" && decisionsFile === undefined && args[index + 1] !== undefined) decisionsFile = args[++index];
      else if (flag === "--baseline" && !scope) scope = { kind: "baseline" };
      else if (flag === "--api" && !scope) scope = { kind: "api" };
      else if (flag === "--client" && !scope) scope = { kind: "client" };
      else if (flag === "--model" && !scope && args[index + 1]) scope = { kind: "model", model: args[++index]! };
      else throw new EditError(400, "Choose exactly one acceptance scope and --expected revision.");
    }
    if (!scope || !expectedRevision) throw new EditError(400, "Acceptance requires one scope and the current --expected revision from status.");
    const decisions = readCliReviewDecisions(root, scope, { statement, evidence, file: decisionsFile });
    const reviews = new GraphQLChainReviews(service), plan = await reviews.review({ scope, expectedRevision, ...(decisions ? { decisions } : {}) });
    emit(await reviews.accept({ reviewId: plan.reviewId, expectedRevision })); return 0;
  } catch (error) { emit({ error: error instanceof Error ? error.message : "GraphQL chain command failed." }); return 2; }
  finally { await service.dispose(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    void runChainCli(process.argv.slice(2), realpathSync(findRepositoryRoot(process.cwd())), value => process.stdout.write(JSON.stringify(value, null, 2) + "\n")).then(code => { process.exitCode = code; });
  } catch {
    process.stdout.write(JSON.stringify({ error: "Run this command inside the framework repository." }) + "\n"); process.exitCode = 2;
  }
}

import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LedgerStage } from "./graphql-chain";
import { writeSourceChange, EditError } from "../source/io";
import { withSourceWrite } from "../source/source-gate";
import { frameworkRepositoryRoot } from "../../src/config/repository-root";
import { serializeReviewRecord } from "./core";
import { recordContents, reviewRecordPath } from "./inspector";
import { runContractGate } from "./ci";
import { recordChainLedger } from "./ledger";

/**
 * The application's contract commands, which need no Studio: `verify` (npm run contract:check)
 * independently re-runs the fixed checks and compares them with the committed receipts; `record`
 * (npm run contract:record) writes the current stage hashes into the ledger; `init` creates an
 * unreviewed record. Reviewing and accepting receipts inspects source in Studio's native sandbox
 * and stays in Studio's CLI. Fixed verbs only: no command strings, arbitrary paths or actions.
 */
export const FRAMEWORK_CHAIN_VERBS = ["verify", "record", "init"] as const;

export async function runFrameworkChainCli(args: readonly string[], root: string, emit: (value: unknown) => void, proofPolicyRoot?: string): Promise<number> {
  try {
    if (args[0] === "verify") {
      if (args.length > 2 || args.length === 2 && args[1] !== "--json") throw new EditError(400, "Use verify or verify --json for independent checkout verification.");
      return await runContractGate(root, emit, { authority: process.env.GITHUB_ACTIONS === "true" ? "ci" : "checkout", proofPolicyRoot });
    }
    if (args[0] === "record") {
      const flags: Readonly<Record<string, LedgerStage>> = { "--api": "api", "--codegen": "codegen", "--client": "client" };
      const chosen: (LedgerStage | undefined)[] = args.slice(1).map(flag => Object.hasOwn(flags, flag) ? flags[flag] : undefined);
      if (chosen.some(stage => !stage)) throw new EditError(400, "Use record, or record with any of --api, --codegen, --client.");
      const stages = chosen.length ? (["api", "codegen", "client"] as const).filter(stage => chosen.includes(stage)) : (["api", "codegen", "client"] as const);
      const result = await recordChainLedger(root, stages);
      emit({ status: result.changed ? "recorded" : "unchanged", stages, nodes: result.nodes.map(node => ({ id: node.id, source: node.reviewedAgainst, output: node.fingerprint.status === "available" ? node.fingerprint.value : null })) });
      return 0;
    }
    if (args.length === 1 && args[0] === "init") {
      await withSourceWrite(root, async () => {
        if (recordContents(root) !== null) throw new EditError(409, "A review record already exists. It was preserved.");
        writeSourceChange(root, reviewRecordPath(root), null, serializeReviewRecord({ version: 3, prisma: null, client: null, bindings: { api: null, client: null }, proofs: {} }));
      });
      emit({ status: "initialized", message: "Created an unreviewed record. No baseline was acknowledged." }); return 0;
    }
    throw new EditError(400, "Use verify, record or init. Review status and acceptance run in AWS Studio.");
  } catch (error) { emit({ error: error instanceof Error ? error.message : "GraphQL chain command failed." }); return 2; }
}

export async function runFrameworkChainMain(args: readonly string[], proofPolicyRoot?: string): Promise<number> {
  const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  let root: string;
  try { root = realpathSync(frameworkRepositoryRoot(process.cwd())); }
  catch { emit({ error: "Run this command inside the application project or set FRAMEWORK_REPOSITORY_ROOT." }); return 2; }
  return runFrameworkChainCli(args, root, emit, proofPolicyRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runFrameworkChainMain(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

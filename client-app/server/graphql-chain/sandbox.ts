import { evaluateGraphQLChain, type EvaluationOptions } from "aws-studio/contract-chain/evaluation";
import type { ChainEvaluation } from "aws-studio/contract-chain/worker";
import { runValidation } from "../agent-runtime/providers/validation";
import { projectRuntime } from "../project-runtime";

/** Studio inspects saved source with the framework's fixed worker inside its native Codex command
 * sandbox. Every Studio inspection (service, forked host, Coding validation and finalization)
 * evaluates through here; the framework itself has no default runner. */
export function sandboxedChainEvaluation(root: string, signal: AbortSignal, toolchain?: EvaluationOptions["toolchain"]): Promise<ChainEvaluation> {
  const runtime = projectRuntime(root);
  return evaluateGraphQLChain(root, { signal, run: options => runValidation({
    ...options, command: { file: runtime.node, args: options.command.args }, toolchain: runtime,
  }), ...(toolchain ? { toolchain } : {}) });
}

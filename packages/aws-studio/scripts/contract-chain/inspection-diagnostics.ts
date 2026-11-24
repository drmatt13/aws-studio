import type { Diagnostic } from "./graphql-chain";
import { EditError } from "../source/errors";
import { DependencyObservationChangedError } from "./dependencies";
import { ChainEvaluationError } from "./evaluation";
import { contractProofNodeProblem } from "./portable-identity";

/** Public failure detail is selected by the host, never copied from arbitrary stderr. */
export class ChainInspectionError extends EditError {
  constructor(status: number, readonly diagnostic: Diagnostic) { super(status, diagnostic.message); }
}

export function assertContractInspectionNode(): void {
  const problem = contractProofNodeProblem();
  if (problem) throw new ChainEvaluationError("CONTRACT_NODE_UNSUPPORTED", problem);
}

export function inspectionFailure(error: unknown): Diagnostic {
  if (error instanceof ChainInspectionError) return error.diagnostic;
  if (error instanceof DependencyObservationChangedError) return {
    code: "DEPENDENCIES_CHANGED_DURING_CHECK", message: "Installed dependencies changed or file notifications were lost while checking. Wait for installation or build activity to finish, then check again. Previous evidence is historical.",
  };
  if (error instanceof ChainEvaluationError) return { code: error.code, message: error.message.slice(0, 4000) };
  if (error instanceof EditError && error.status === 409 && /source changed|saved source changed/i.test(error.message)) return {
    code: "SOURCE_CHANGED_DURING_CHECK", message: "Saved source changed while checking. Wait for the edit to finish, then check again; previous evidence is historical.",
  };
  return { code: "INSPECTION_FAILED", message: "Contract inspection could not finish. Check installed dependencies and the inspection capability, then check again; previous evidence is historical." };
}

export function readInspectionDiagnostic(value: unknown): Diagnostic | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Partial<Diagnostic>;
  if (typeof item.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(item.code)
    || typeof item.message !== "string" || !item.message.length || item.message.length > 4000) return;
  return { code: item.code, message: item.message };
}

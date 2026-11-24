// A full application captures more dependency/source bytes than the starter.
// Keep the operation bounded while allowing capture plus the independent checks.
export const CONTRACT_EVALUATION_TIMEOUT_MS = 15 * 60_000;
export const CONTRACT_INSPECTION_TIMEOUT_MS = 20 * 60_000;


// Only the fixed inspection host reports these phases; project output is never
// interpreted as progress. This does not establish any verification evidence.
export const INSPECTION_PHASES = {
  starting: "Starting the saved-source inspection",
  source: "Capturing source and dependency identities",
  checks: "Running independent contract checks",
  proof: "Hashing portable proof inputs",
  recheck: "Rechecking source and dependency identities",
  publish: "Reconciling source changes and publishing evidence",
} as const;
export type InspectionPhase = keyof typeof INSPECTION_PHASES;
export function isInspectionPhase(value: unknown): value is InspectionPhase {
  return typeof value === "string" && Object.hasOwn(INSPECTION_PHASES, value);
}
export function inspectionProgressMessage(phase: InspectionPhase, startedAt: number, phaseStartedAt: number, now: number): string {
  const duration = (start: number) => {
    const seconds = Math.max(0, Math.floor((now - start) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  return `${INSPECTION_PHASES[phase]} · ${duration(startedAt)} elapsed · ${duration(phaseStartedAt)} in this phase.`;
}

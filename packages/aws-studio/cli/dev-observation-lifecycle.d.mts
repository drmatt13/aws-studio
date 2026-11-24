export interface DevelopmentObservationPreparation {
  readonly enabled: boolean;
  readonly runtimeSessionId?: string;
}
export function refreshDevelopmentObservation(options: {
  readonly previousRunId?: string;
  readonly prepare: () =>
    | DevelopmentObservationPreparation
    | undefined
    | Promise<DevelopmentObservationPreparation | undefined>;
  readonly record: (event: {
    readonly kind: string;
    readonly message: string;
  }) => void;
  readonly close: () => void | Promise<void>;
  readonly start: () => void | Promise<void>;
}): Promise<boolean>;

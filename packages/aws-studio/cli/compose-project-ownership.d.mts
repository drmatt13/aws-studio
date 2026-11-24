export function normalizeComposeProjectName(value: string): string;
export function composeProjectName(root: string, environment?: NodeJS.ProcessEnv, exportDirectory?: string): string;
export function parseComposeOwnershipLabels(output: string, expectedCount: number): readonly Record<string, unknown>[];
export function assertComposeContainerOwnership(root: string, project: string, labels: readonly Record<string, unknown>[]): void;
export function assertComposeVolumeOwnership(project: string, logicalName: string, labels: Readonly<Record<string, unknown>> | undefined | null): void;

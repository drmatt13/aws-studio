export interface StarterSelection {
  readonly root: string;
  readonly commit: string;
  readonly app: string;
}

export interface StarterFile {
  readonly relative: string;
  readonly mode: number;
  readonly bytes: Buffer;
}

export const platformRoot: string;
export const generatedPeerPath: string;
export const generatedPeerName: string;
export function readStarterSelection(installation?: string, env?: NodeJS.ProcessEnv): StarterSelection;
export function publicStarterPath(name: string): boolean;
export function readStarterFiles(selection: StarterSelection, subtree?: string): StarterFile[];
export function writeStarterFiles(destination: string, files: readonly StarterFile[]): void;

import type { DevelopmentLogControl } from "aws-studio/development-logs";

export interface DevelopmentWriterIdentity {
  readonly uid?: number;
  readonly gid?: number;
}
/** Select the writer's existing filesystem namespace; never relax private-file checks. */
export function developmentWriterIdentity(input: {
  readonly platform: string;
  readonly processUid?: number;
  readonly ownerUid: number;
  readonly mode: number;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly daemonOperatingSystem?: string;
  readonly control: Pick<DevelopmentLogControl, "hostUid" | "hostGid">;
}): DevelopmentWriterIdentity | undefined {
  if (!input.isDirectory || input.isSymbolicLink || input.mode & 0o077)
    return undefined;
  if (input.platform !== "linux" || input.processUid !== 0)
    return input.ownerUid === input.processUid ? {} : undefined;
  if (
    /\bDocker Desktop\b/i.test(input.daemonOperatingSystem ?? "") &&
    input.ownerUid === 0
  )
    return { uid: 0, gid: 0 };
  if (
    input.control.hostUid !== undefined &&
    input.ownerUid === input.control.hostUid
  )
    return {
      uid: input.control.hostUid,
      ...(input.control.hostGid === undefined
        ? {}
        : { gid: input.control.hostGid }),
    };
  return undefined;
}

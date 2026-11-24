import type { ChildProcess, SpawnOptions } from "node:child_process";
export const WINDOWS_JOB: string;
export const TETHER: string;
export const COMMAND_NOT_FOUND: string;
/** Cancel with child.kill("SIGTERM"); the owner tears down descendants before close. */
export function spawnOwnedProcess(file: string, args: readonly string[], options?: SpawnOptions, ownership?: { forwardInput?: boolean }): ChildProcess;
/** Cancel with child.kill() and await close before releasing private inputs. */
export function spawnWindowsJob(file: string, args: readonly string[], options?: SpawnOptions): ChildProcess;

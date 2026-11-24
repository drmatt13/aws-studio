import assert from "./assert";
import { statSync } from "node:fs";
import { captureWindowsSecurityDescriptor } from "aws-studio/cli/windows-security";

/** Assert the permission authority the host actually enforces. */
export function filePermissions(file: string): number | string {
  return process.platform === "win32" ? captureWindowsSecurityDescriptor(file) : statSync(file).mode & 0o777;
}

export function assertFilePermissions(file: string, expected: number | string): void {
  assert.equal(filePermissions(file), expected);
}

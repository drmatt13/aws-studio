/** Check before importing the large fixture or copying installed dependencies. */
export function assertContractFixtureRuntime(version = process.versions.node): void {
  const [major, minor, patch] = version.split(".").map(Number);
  if (major !== 24 || !Number.isInteger(minor) || !Number.isInteger(patch) || minor! < 22 || minor === 22 && patch! < 2) throw new Error("Contract propagation verification requires Node 24.22.2 or newer within Node 24. Select the repository-supported runtime before starting the fixture.");
}

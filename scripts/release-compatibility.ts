export const stableVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
export const projectProtocol = 1;

export interface FrameworkCompatibility {
  readonly minimumStudio: string;
  readonly protocol: number;
  readonly capabilities: readonly string[];
}

export interface StudioDistribution {
  readonly version: string;
  readonly frameworkVersion: string;
  readonly runtime: { readonly node: string; readonly npm: string };
  readonly frameworkIntegrity?: string;
}

export function studioDistribution(value: unknown): StudioDistribution {
  const data = value as Partial<StudioDistribution> | null;
  if (!data || !isVersion(data.version) || !isVersion(data.frameworkVersion) ||
    !isVersion(data.runtime?.node) || !isVersion(data.runtime?.npm) ||
    (data.frameworkIntegrity !== undefined && !/^sha512-[A-Za-z0-9+/]{86}==$/.test(data.frameworkIntegrity))) {
    throw new Error("Invalid AWS Studio distribution metadata.");
  }
  return data as StudioDistribution;
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && stableVersion.test(value);
}

export function releaseIsOlder(version: string, required: string): boolean {
  const current = version.split(".").map(Number), minimum = required.split(".").map(Number);
  const component = current.findIndex((value, index) => value !== minimum[index]);
  return component >= 0 && current[component]! < minimum[component]!;
}

// Retained historical fixtures can predate the static compatibility contract.
const legacyFrameworks: ReadonlyMap<string, FrameworkCompatibility> = new Map([
  ["2.0.0", { minimumStudio: "2.0.0", protocol: 1, capabilities: [] }],
]);

export function frameworkCompatibility(version: string, metadata: unknown): FrameworkCompatibility | undefined {
  if (metadata === undefined) return legacyFrameworks.get(version);
  const data = metadata as Partial<FrameworkCompatibility> | null;
  if (!data || !isVersion(data.minimumStudio) || typeof data.protocol !== "number" ||
    !Number.isSafeInteger(data.protocol) || data.protocol < 1 ||
    !Array.isArray(data.capabilities) || data.capabilities.length > 128 ||
    data.capabilities.some(value => typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) ||
    new Set(data.capabilities).size !== data.capabilities.length) {
    throw new Error(`Framework ${version} has invalid AWS Studio compatibility metadata.`);
  }
  return { minimumStudio: data.minimumStudio, protocol: data.protocol, capabilities: data.capabilities };
}

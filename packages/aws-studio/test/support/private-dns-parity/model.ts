/** Disposable Phase 0 inputs, shared by the local and AWS experiments.
 * This is deliberately not an application declaration or a production API. */
export type FixtureVpc = "a" | "b";
export type FixtureEndpoint = "alb-a" | "alb-b";
export type FixtureAddressRole = "resolver" | "caller" | "deniedCaller" | "isolatedCaller" | "alb" | "backend" | "externalFixture";

export interface FixtureZone {
  readonly id: string;
  readonly name: string;
  readonly associations: readonly FixtureVpc[];
  readonly records: readonly { readonly name: string; readonly endpoint: FixtureEndpoint; readonly ttl: 60 }[];
}

export interface PrivateDnsParityFixture {
  readonly version: 1;
  readonly zoneName: string;
  readonly networks: readonly FixtureVpc[];
  readonly zones: readonly FixtureZone[];
  readonly ports: { readonly dns: 53; readonly http: 80; readonly backend: 5000 };
  /** AWS PHZ defaults are modeled, but observed AWS values remain a Phase 0 gate. */
  readonly soa: {
    readonly ttl: 900; readonly minimum: 86400; readonly refresh: 7200;
    readonly retry: 900; readonly expire: 1209600; readonly serial: 1;
    readonly awsCalibration: "required";
  };
  readonly names: {
    readonly api: string;
    readonly apex: string;
    readonly missing: string;
    readonly childApi: string;
    readonly childMissing: string;
    readonly emptyNonterminal: string;
    readonly sharedApi: string;
    /** Exists in the parent zone, but the associated child zone must hide it. */
    readonly shadowedParent: string;
    readonly external: "example.com";
  };
  readonly dnsScenarios: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: "A" | "AAAA" | "TXT";
    readonly outcome: "alias" | "NXDOMAIN" | "NODATA";
    readonly endpoint?: FixtureEndpoint;
  }[];
}

export function fixtureZoneName(value: string): string {
  const name = value.toLowerCase().replace(/\.$/, "");
  // Reserve room for the longest fixture record prefix and its trailing dot.
  if (name.length > 230 || !name.includes(".") || name.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("The parity fixture needs a literal DNS suffix with valid labels.");
  }
  return name;
}

export function createPrivateDnsParityFixture(zoneName = "internal.parity.test"): PrivateDnsParityFixture {
  const parent = fixtureZoneName(zoneName);
  const child = `child.${parent}`;
  const names = Object.freeze({
    api: `api.${parent}`, apex: parent, missing: `missing.${parent}`,
    childApi: `api.${child}`, childMissing: `missing.${child}`,
    emptyNonterminal: `branch.${parent}`,
    sharedApi: `api.shared.${parent}`,
    shadowedParent: `parent-only.${child}`, external: "example.com" as const,
  });
  const zones: FixtureZone[] = (["a", "b"] as const).flatMap(vpc => {
    const endpoint: FixtureEndpoint = `alb-${vpc}`;
    return [
      { id: `${vpc}-parent`, name: parent, associations: [vpc], records: [names.apex, names.api, names.shadowedParent, `leaf.${names.emptyNonterminal}`].map(name => Object.freeze({ name, endpoint, ttl: 60 as const })) },
      { id: `${vpc}-child`, name: child, associations: [vpc], records: [Object.freeze({ name: names.childApi, endpoint, ttl: 60 as const })] },
    ];
  });
  zones.push({ id: "shared", name: `shared.${parent}`, associations: ["a", "b"], records: [Object.freeze({ name: names.sharedApi, endpoint: "alb-a", ttl: 60 })] });
  return Object.freeze({
    version: 1, zoneName: parent, networks: Object.freeze(["a", "b"] as const),
    zones: Object.freeze(zones.map(zone => Object.freeze({ ...zone, associations: Object.freeze(zone.associations), records: Object.freeze(zone.records) }))),
    ports: Object.freeze({ dns: 53, http: 80, backend: 5000 }), names,
    soa: Object.freeze({ ttl: 900, minimum: 86400, refresh: 7200, retry: 900, expire: 1209600, serial: 1, awsCalibration: "required" }),
    dnsScenarios: Object.freeze([
      { id: "alias", name: names.api, type: "A", outcome: "alias" },
      { id: "alias-apex", name: names.apex, type: "A", outcome: "alias" },
      { id: "existing-name-aaaa", name: names.api, type: "AAAA", outcome: "NODATA" },
      { id: "existing-name-txt", name: names.api, type: "TXT", outcome: "NODATA" },
      { id: "empty-nonterminal", name: names.emptyNonterminal, type: "A", outcome: "NODATA" },
      { id: "missing-name", name: names.missing, type: "A", outcome: "NXDOMAIN" },
      { id: "child-alias", name: names.childApi, type: "A", outcome: "alias" },
      { id: "child-missing", name: names.childMissing, type: "A", outcome: "NXDOMAIN" },
      { id: "child-hides-parent", name: names.shadowedParent, type: "A", outcome: "NXDOMAIN" },
      { id: "shared-alias", name: names.sharedApi, type: "A", outcome: "alias", endpoint: "alb-a" },
    ].map(scenario => Object.freeze(scenario))) as PrivateDnsParityFixture["dnsScenarios"],
  });
}

export const PRIVATE_DNS_PARITY_FIXTURE = createPrivateDnsParityFixture();

/** An address allocator for an already inspected, task-owned /24 Docker subnet. */
export function fixtureAddress(subnetCidr: string, role: FixtureAddressRole): string {
  const match = /^(\d+)\.(\d+)\.(\d+)\.0\/24$/.exec(subnetCidr);
  if (!match || match.slice(1).some(octet => Number(octet) > 255 || String(Number(octet)) !== octet)) throw new Error("Fixture addresses require a canonical IPv4 /24 network.");
  const offset: Record<FixtureAddressRole, number> = { resolver: 53, caller: 30, deniedCaller: 31, isolatedCaller: 32, alb: 10, backend: 20, externalFixture: 40 };
  if (!Object.hasOwn(offset, role)) throw new Error("Unknown fixture address role.");
  return `${match[1]}.${match[2]}.${match[3]}.${offset[role]}`;
}

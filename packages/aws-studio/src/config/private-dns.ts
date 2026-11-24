import type { FrameworkConfig, NormalizedTarget, TargetReference } from "./index";
import { isFrameworkNetwork, resolveNetwork, type FrameworkNetwork } from "./network";

export const PRIVATE_ZONE_BRAND = "aws-studio/private-hosted-zone" as const;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CALLER = /^(lambda|service|task):[a-z][a-z0-9-]*$/;

/** An endpoint capability, not a DNS name, container IP or local URL. */
export interface PrivateDnsEndpoint {
  readonly kind: "ecs-internal-alb";
  readonly service: string;
}
export interface PrivateDnsRecord {
  readonly id: string;
  /** Relative label, @ for the apex, or the fully qualified name within this zone. */
  readonly name: string;
  readonly type: "A";
  readonly target: PrivateDnsEndpoint;
  readonly enabled?: boolean;
  /** Explicit HTTP/80 ingress grants to this endpoint, independent of DNS visibility.
   * A grant also admits requests using another name or the ALB's address. */
  readonly allowFrom?: readonly TargetReference[];
}
export interface PrivateHostedZoneDeclaration {
  readonly id: string;
  readonly name: string;
  readonly vpcs: readonly FrameworkNetwork[];
  readonly records?: readonly PrivateDnsRecord[];
  readonly enabled?: boolean;
  readonly cloud?: { readonly constructId?: string };
}
export interface FrameworkPrivateHostedZone {
  readonly $privateHostedZone: typeof PRIVATE_ZONE_BRAND;
  readonly id: string;
  readonly name: string;
  readonly vpcs: readonly FrameworkNetwork[];
  readonly records: readonly PrivateDnsRecord[];
  readonly enabled: boolean;
  readonly cloud: { readonly constructId: string };
}

function plain(value: unknown, keys: readonly string[], context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${context} requires a literal declaration with ${keys.join(", ")}.`);
}
/** ASCII DNS names, including unregistered suffixes. Public ownership is not required. */
export function privateDnsName(value: string): string {
  if (typeof value !== "string") throw new Error("Enter a private DNS domain name.");
  const name = value.toLowerCase().replace(/\.$/, "");
  if (name.length > 253 || !name.includes(".") || name.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("Use a DNS name such as internal.example.test, without a URL, port, wildcard or path. Encode international names as punycode.");
  return name;
}
export function privateRecordName(zone: string, record: string): string {
  if (typeof record !== "string" || !record) throw new Error("Enter a record name, or @ for the zone apex.");
  const absolute = record.endsWith(".") || record.toLowerCase() === zone || record.toLowerCase().endsWith(`.${zone}`);
  const name = record === "@" ? zone : absolute ? privateDnsName(record) : privateDnsName(`${record}.${zone}`);
  if (name !== zone && !name.endsWith(`.${zone}`)) throw new Error(`Record ${record} is outside private zone ${zone}.`);
  return name;
}

export function definePrivateHostedZone(declaration: PrivateHostedZoneDeclaration): FrameworkPrivateHostedZone {
  plain(declaration, ["id", "name", "vpcs", "records", "enabled", "cloud"], "definePrivateHostedZone()");
  if (typeof declaration.id !== "string" || !ID.test(declaration.id)) throw new Error("A private hosted zone requires a stable kebab-case id.");
  const name = privateDnsName(declaration.name as string);
  if (!Array.isArray(declaration.vpcs) || !declaration.vpcs.length || declaration.vpcs.some(vpc => !isFrameworkNetwork(vpc)) || new Set(declaration.vpcs.map(vpc => vpc.id)).size !== declaration.vpcs.length) throw new Error("Associate at least one distinct imported VPC with a private hosted zone.");
  if (declaration.enabled !== undefined && typeof declaration.enabled !== "boolean") throw new Error("A private zone's enabled setting must be a boolean.");
  const cloud = declaration.cloud ?? {};
  plain(cloud, ["constructId"], "Private zone cloud settings");
  const constructId = cloud.constructId ?? `${declaration.id.split("-").map(part => part[0]!.toUpperCase() + part.slice(1)).join("")}PrivateHostedZoneStack`;
  if (typeof constructId !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(constructId)) throw new Error("A private zone cloud.constructId must be a stable alphanumeric stack identity.");
  if (declaration.records !== undefined && !Array.isArray(declaration.records)) throw new Error("Private zone records must be a literal array.");
  const ids = new Set<string>(), names = new Set<string>();
  const records = (declaration.records as readonly PrivateDnsRecord[] | undefined ?? []).map(record => {
    plain(record, ["id", "name", "type", "target", "enabled", "allowFrom"], "Private DNS record");
    if (typeof record.id !== "string" || !ID.test(record.id) || ids.has(record.id)) throw new Error("Private DNS records require distinct stable kebab-case ids within their zone.");
    ids.add(record.id);
    if (record.type !== "A") throw new Error("The supported private DNS record is an A alias to an internal ECS ALB.");
    const fqdn = privateRecordName(name, record.name as string);
    if (names.has(fqdn)) throw new Error(`Private zone ${name} declares duplicate A record ${fqdn}.`);
    names.add(fqdn);
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") throw new Error("A private record's enabled setting must be a boolean.");
    plain(record.target, ["kind", "service"], "Private DNS endpoint");
    if (record.target.kind !== "ecs-internal-alb" || typeof record.target.service !== "string" || !ID.test(record.target.service)) throw new Error("Select an ECS service's internal ALB endpoint capability.");
    const allowFrom = record.allowFrom ?? [];
    if (!Array.isArray(allowFrom) || allowFrom.some(caller => typeof caller !== "string" || !CALLER.test(caller)) || new Set(allowFrom).size !== allowFrom.length) throw new Error("Connectivity grants require distinct declared Lambda, service or task references.");
    return Object.freeze({ id: record.id, name: record.name as string, type: "A" as const, target: Object.freeze({ kind: "ecs-internal-alb" as const, service: record.target.service }), enabled: record.enabled !== false, allowFrom: Object.freeze([...allowFrom]) as readonly TargetReference[] });
  });
  return Object.freeze({ $privateHostedZone: PRIVATE_ZONE_BRAND, id: declaration.id, name, vpcs: Object.freeze([...declaration.vpcs]) as readonly FrameworkNetwork[], records: Object.freeze(records), enabled: declaration.enabled !== false, cloud: Object.freeze({ constructId }) });
}

/** Structural checks are separate from production deployment eligibility. */
export function validatePrivateHostedZones(config: Pick<FrameworkConfig, "networks" | "privateHostedZones" | "services">, targets: ReadonlyMap<string, NormalizedTarget>): void {
  if (config.privateHostedZones !== undefined && !Array.isArray(config.privateHostedZones)) throw new Error("privateHostedZones must be a literal array of imported definePrivateHostedZone declarations.");
  if (!config.privateHostedZones?.length) return;
  const ids = new Set<string>(), constructs = new Set<string>(), associations = new Set<string>();
  for (const zone of (config.privateHostedZones ?? []) as readonly FrameworkPrivateHostedZone[]) {
    if (!zone || zone.$privateHostedZone !== PRIVATE_ZONE_BRAND) throw new Error("privateHostedZones takes imported definePrivateHostedZone declarations.");
    if (ids.has(zone.id) || constructs.has(zone.cloud.constructId)) throw new Error(`Duplicate private zone id or construct identity: ${zone.id}.`);
    ids.add(zone.id); constructs.add(zone.cloud.constructId);
    for (const vpc of zone.vpcs) {
      resolveNetwork(config, vpc);
      const key = `${vpc.id}/${zone.name}`;
      if (zone.enabled && associations.has(key)) throw new Error(`VPC ${vpc.id} cannot associate two enabled private zones named ${zone.name}.`);
      if (zone.enabled) associations.add(key);
    }
    for (const record of zone.records) {
      const target = targets.get(`service:${record.target.service}`);
      if (!target || target.kind !== "service" || !target.cloud.service || target.cloud.service.publicLoadBalancer) throw new Error(`Private DNS ${zone.id}/${record.id} requires a declared ECS service with an internal ALB endpoint.`);
      if (target.cloud.service.desiredCount < 1 && zone.enabled && record.enabled !== false) throw new Error(`Private DNS ${zone.id}/${record.id} targets a service with no desired tasks.`);
      if (!target.vpc || !zone.vpcs.some(vpc => vpc === target.vpc)) throw new Error(`Private DNS ${zone.id}/${record.id}: associate the endpoint's VPC ${target.vpc?.id ?? "(missing)"} with the zone.`);
      for (const caller of record.allowFrom ?? []) {
        const from = targets.get(caller);
        if (!from || !["lambda", "service", "task"].includes(from.kind) || !from.vpc || from.vpc !== target.vpc) throw new Error(`Private DNS grant ${caller} → service:${record.target.service} requires declared workloads in the same VPC; no automatic peering exists.`);
        if (Object.entries(config.services).some(([key, service]) => service.auth && target.origins.includes(`services[${JSON.stringify(key)}]`))) throw new Error(`Private DNS grant to service:${record.target.service} would bypass its API Gateway authorizer. Direct grants require service-owned authentication; remove the gateway's auth: true declaration only after implementing those checks in the service.`);
      }
    }
  }
}

export function privateDnsRecordsForService(config: Pick<FrameworkConfig, "privateHostedZones">, id: string): readonly PrivateDnsRecord[] {
  return (config.privateHostedZones ?? []).filter(zone => zone.enabled).flatMap(zone => zone.records.filter(record => record.enabled !== false && record.target.service === id));
}

/** Until the real scoped runtime is qualified, never manufacture local DNS success. */
export function assertPrivateDnsLocalExecution(config: FrameworkConfig, reference: string, targets: readonly NormalizedTarget[]): void {
  const target = targets.find(target => target.reference === reference);
  if (target?.vpc && config.privateHostedZones?.some(zone => zone.enabled && zone.vpcs.includes(target.vpc!))) throw new Error(`${reference}: private DNS local execution is not available yet for VPC ${target.vpc.id}. The zone declaration is saved, but scoped DNS/network parity has not been qualified. Disable the zone explicitly to use the existing local runtime; no host-network fallback is used.`);
}

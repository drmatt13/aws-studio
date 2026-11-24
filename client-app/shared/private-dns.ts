import { privateDnsName, privateRecordName, type PrivateDnsRecord } from "aws-studio/config/private-dns";

export interface PrivateZoneSettings {
  readonly name: string;
  readonly enabled: boolean;
  readonly vpcIds: readonly string[];
  readonly records: readonly PrivateDnsRecord[];
}
export interface PrivateZoneModel extends PrivateZoneSettings {
  readonly id: string;
  readonly constructId: string;
  readonly deploymentProblems: readonly string[];
  readonly localStatus: "unsupported";
}
export interface PrivateDnsEndpointModel {
  readonly kind: "ecs-internal-alb";
  readonly service: string;
  readonly title: string;
  readonly vpcId: string;
  readonly productionEnabled: boolean;
  readonly gatewayAuth: boolean;
}
export type PrivateZoneEdit = { readonly kind: "privateZone"; readonly operation: "create" | "update"; readonly id: string; readonly settings: PrivateZoneSettings }
  | { readonly kind: "privateZone"; readonly operation: "remove"; readonly id: string };

const id = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Private DNS edits accept declared identities and settings only, never paths or source expressions.");
}

/** Bounded transport validation. Framework evaluation remains the semantic authority. */
export function readPrivateZoneEdit(raw: unknown): PrivateZoneEdit {
  object(raw, ["kind", "operation", "id", "settings"]);
  if (raw.kind !== "privateZone" || !id(raw.id)) throw new Error("Choose a stable kebab-case private zone identity.");
  if (raw.operation === "remove") {
    if ("settings" in raw) throw new Error("A zone removal takes only its identity.");
    return { kind: "privateZone", operation: "remove", id: raw.id };
  }
  if (raw.operation !== "create" && raw.operation !== "update") throw new Error("Choose create, update or remove for the private zone.");
  const settings = raw.settings;
  object(settings, ["name", "enabled", "vpcIds", "records"]);
  const name = privateDnsName(settings.name as string);
  if (typeof settings.enabled !== "boolean" || !Array.isArray(settings.vpcIds) || !settings.vpcIds.length || settings.vpcIds.length > 100 || !settings.vpcIds.every(id) || new Set(settings.vpcIds).size !== settings.vpcIds.length) throw new Error("Associate at least one distinct declared VPC and choose whether the zone is enabled.");
  if (!Array.isArray(settings.records) || settings.records.length > 100) throw new Error("A zone editor supports up to 100 records.");
  const ids = new Set<string>(), names = new Set<string>();
  const records = settings.records.map((record: unknown): PrivateDnsRecord => {
    object(record, ["id", "name", "type", "target", "enabled", "allowFrom"]);
    if (!id(record.id) || ids.has(record.id)) throw new Error("Records require distinct stable kebab-case identities.");
    ids.add(record.id);
    if (record.type !== "A" || typeof record.name !== "string" || record.enabled !== undefined && typeof record.enabled !== "boolean") throw new Error("Select an A alias and enter a record name (or @ for the apex).");
    const fqdn = privateRecordName(name, record.name);
    if (names.has(fqdn)) throw new Error(`Duplicate A record ${fqdn}.`);
    names.add(fqdn);
    object(record.target, ["kind", "service"]);
    if (record.target.kind !== "ecs-internal-alb" || !id(record.target.service)) throw new Error("Select a declared ECS internal ALB endpoint.");
    const callers = record.allowFrom ?? [];
    if (!Array.isArray(callers) || callers.length > 100 || callers.some(value => typeof value !== "string" || !/^(lambda|service|task):[a-z][a-z0-9-]*$/.test(value)) || new Set(callers).size !== callers.length) throw new Error("Connectivity grants require distinct declared caller identities.");
    return { id: record.id, name: record.name, type: "A", target: { kind: "ecs-internal-alb", service: record.target.service }, enabled: record.enabled !== false, allowFrom: [...callers] };
  });
  return { kind: "privateZone", operation: raw.operation, id: raw.id, settings: { name, enabled: settings.enabled, vpcIds: [...settings.vpcIds], records } };
}

export const privateZoneSettings = ({ name, enabled, vpcIds, records }: PrivateZoneSettings): PrivateZoneSettings => ({ name, enabled, vpcIds, records });

import { isIP } from "node:net";
import { PRIVATE_DNS_PARITY_FIXTURE, type PrivateDnsParityFixture } from "./model";

export interface NftPolicyOptions {
  readonly role: "caller" | "backend" | "alb";
  readonly address: string;
  readonly subnetCidr: string;
  readonly resolver: string;
  readonly alb: string;
  readonly backend: string;
  readonly callerAddresses: readonly string[];
  readonly allowedCallerAddresses: readonly string[];
  readonly blockedCidrs: readonly string[];
  readonly ipv4Egress: boolean;
  readonly managementPorts?: readonly {
    readonly address: string;
    readonly port: number;
    readonly protocol?: "tcp" | "udp";
    readonly direction?: "input" | "output";
  }[];
}

/** Explicit private endpoints are admitted before these external-egress denials. */
export const NON_PUBLIC_IPV4_CIDRS = Object.freeze([
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4",
]);

function ipv4(value: string): string {
  if (typeof value !== "string" || isIP(value) !== 4) throw new Error("Policy addresses must be literal IPv4 addresses.");
  return value;
}
function addressNumber(value: string): number {
  return ipv4(value).split(".").reduce((number, octet) => number * 256 + Number(octet), 0);
}
function cidr(value: string): string {
  if (typeof value !== "string") throw new Error("Policy blocks require literal IPv4 CIDRs.");
  const parts = value.split("/");
  const prefix = Number(parts[1]);
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]!) || prefix < 0 || prefix > 32) throw new Error("Policy blocks require literal IPv4 CIDRs.");
  const address = addressNumber(parts[0]!);
  const size = 2 ** (32 - prefix);
  if (address % size !== 0) throw new Error("Policy CIDRs must use their network address.");
  return `${parts[0]}/${prefix}`;
}
function inside(address: string, network: string): boolean {
  const [base, prefix] = cidr(network).split("/");
  const size = 2 ** (32 - Number(prefix));
  return Math.floor(addressNumber(address) / size) === Math.floor(addressNumber(base!) / size);
}
const set = (values: readonly string[]) => `{ ${[...new Set(values)].sort().join(", ")} }`;
function minimalCidrs(values: readonly string[]): string[] {
  const sorted = [...new Set(values)].sort((a, b) => Number(a.split("/")[1]) - Number(b.split("/")[1]) || addressNumber(a.split("/")[0]!) - addressNumber(b.split("/")[0]!));
  const result: string[] = [];
  for (const value of sorted) if (!result.some(parent => inside(value.split("/")[0]!, parent))) result.push(value);
  return result;
}

/** A fresh task-owned network namespace is required; this never flushes host rules. */
export function compileNftPolicy(options: NftPolicyOptions): string {
  if (!["caller", "backend", "alb"].includes(options.role)) throw new Error("Unknown fixture network role.");
  if (typeof options.ipv4Egress !== "boolean") throw new Error("IPv4 egress must be an explicit boolean.");
  const network = cidr(options.subnetCidr);
  const own = ipv4(options.address);
  const resolver = ipv4(options.resolver);
  const alb = ipv4(options.alb);
  const backend = ipv4(options.backend);
  const callers = [...new Set(options.callerAddresses.map(ipv4))];
  const allowed = [...new Set(options.allowedCallerAddresses.map(ipv4))];
  for (const address of [own, resolver, alb, backend, ...callers]) {
    if (!inside(address, network)) throw new Error("Fixture endpoints and callers must belong to their selected subnet.");
  }
  if (new Set([resolver, alb, backend, ...callers]).size !== 3 + callers.length) throw new Error("Fixture endpoint and caller identities must use distinct addresses.");
  if (allowed.some(address => !callers.includes(address))) throw new Error("An ALB grant must name a known caller address.");
  if (options.role === "alb" && own !== alb || options.role === "backend" && own !== backend || options.role === "caller" && !callers.includes(own)) throw new Error("The policy address must match its declared role.");
  const blocked = minimalCidrs([...NON_PUBLIC_IPV4_CIDRS, network, ...options.blockedCidrs.map(cidr)]);
  const input = [
    "ct state invalid drop", 'iifname "lo" accept', "meta nfproto ipv6 drop",
    `ip daddr != ${own} drop`, "ct state established,related accept",
  ];
  const output = [
    "ct state invalid drop", 'oifname "lo" accept', "meta nfproto ipv6 drop",
    `ip saddr != ${own} drop`, "ct state established,related accept",
    `ip daddr ${resolver} udp dport 53 accept`, `ip daddr ${resolver} tcp dport 53 accept`,
  ];
  if (options.role === "caller") output.push(`ip daddr ${alb} tcp dport 80 accept`);
  if (options.role === "alb") {
    if (allowed.length) input.push(`ip saddr ${set(allowed)} tcp dport 80 accept`);
    output.push(`ip daddr ${backend} tcp dport 5000 accept`);
  }
  if (options.role === "backend") input.push(`ip saddr ${alb} tcp dport 5000 accept`);
  for (const permission of options.managementPorts ?? []) {
    const address = ipv4(permission.address);
    if (!Number.isInteger(permission.port) || permission.port < 1 || permission.port > 65535) throw new Error("Management permissions require a valid port.");
    const protocol = permission.protocol ?? "tcp";
    const direction = permission.direction ?? "output";
    if (!["tcp", "udp"].includes(protocol) || !["input", "output"].includes(direction)) throw new Error("Invalid management permission protocol or direction.");
    (direction === "input" ? input : output).push(`ip ${direction === "input" ? "saddr" : "daddr"} ${address} ${protocol} dport ${permission.port} accept`);
  }
  output.push(`ip daddr ${set(blocked)} drop`);
  if (options.ipv4Egress) output.push("meta nfproto ipv4 meta l4proto tcp accept", "meta nfproto ipv4 meta l4proto udp accept");
  const chain = (name: string, rules: readonly string[]) => `  chain ${name} {\n    type filter hook ${name} priority 0; policy drop;\n${rules.map(rule => `    ${rule}`).join("\n")}\n  }`;
  return `# Phase 0 disposable namespace policy; application capabilities must be dropped.\ntable inet private_dns_parity {\n${chain("input", input)}\n${chain("output", output)}\n}\n`;
}

export interface CoreDnsOptions {
  readonly view: "a" | "b" | "outside";
  readonly addresses: { readonly albA: string; readonly albB: string; readonly resolver?: string };
  readonly upstream: string;
  readonly fixture?: PrivateDnsParityFixture;
  readonly zoneDirectory?: string;
}
export interface CoreDnsConfiguration {
  readonly corefile: string;
  /** Basenames, to be materialized in zoneDirectory by the disposable runner. */
  readonly zoneFiles: Readonly<Record<string, string>>;
}

/** Real zone files preserve authoritative NXDOMAIN, NODATA and empty nonterminals.
 * The outside view has no PHZ authority: only explicit upstream forwarding. */
export function renderCoreDns(options: CoreDnsOptions): CoreDnsConfiguration {
  if (!["a", "b", "outside"].includes(options.view)) throw new Error("Unknown resolver fixture view.");
  ipv4(options.addresses.albA); ipv4(options.addresses.albB);
  if (options.addresses.resolver !== undefined) ipv4(options.addresses.resolver);
  if (!/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(options.upstream)) throw new Error("The DNS upstream must be an explicit IPv4 address and optional port.");
  const [upstreamAddress, upstreamPort] = options.upstream.split(":");
  ipv4(upstreamAddress!);
  if (upstreamPort !== undefined && (!Number.isInteger(Number(upstreamPort)) || Number(upstreamPort) < 1 || Number(upstreamPort) > 65535)) throw new Error("Invalid DNS upstream port.");
  const directory = options.zoneDirectory ?? "/zones";
  if (!/^\/[A-Za-z0-9_./-]+$/.test(directory) || directory.split("/").includes("..")) throw new Error("Zone directory must be an absolute path without traversal.");
  const fixture = options.fixture ?? PRIVATE_DNS_PARITY_FIXTURE;
  const zones = options.view === "outside" ? [] : fixture.zones.filter(zone => zone.associations.includes(options.view as "a" | "b"));
  const zoneFiles: Record<string, string> = {};
  const blocks = zones.map(zone => {
    const basename = `${zone.id}.zone`;
    zoneFiles[basename] = [
      `$ORIGIN ${zone.name}.`, "$TTL 60",
      `@ ${fixture.soa.ttl} IN SOA ns.${zone.name}. hostmaster.${zone.name}. ( ${fixture.soa.serial} ${fixture.soa.refresh} ${fixture.soa.retry} ${fixture.soa.expire} ${fixture.soa.minimum} )`,
      `@ 172800 IN NS ns.${zone.name}.`,
      ...zone.records.map(record => `${record.name}. ${record.ttl} IN A ${record.endpoint === "alb-a" ? options.addresses.albA : options.addresses.albB}`),
      "",
    ].join("\n");
    return `${zone.name}:53 {\n  errors\n  file ${directory}/${basename} ${zone.name}\n}\n`;
  });
  blocks.push(`.:53 {\n  errors\n  forward . ${options.upstream}\n}\n`);
  return { corefile: blocks.join("\n"), zoneFiles };
}

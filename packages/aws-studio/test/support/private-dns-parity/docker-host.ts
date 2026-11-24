import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);
type DockerRead = (args: readonly string[]) => Promise<string>;
export interface Ipv4RouteInventory {
  readonly routeCidrs: string[];
  readonly gatewayCidrs: string[];
}

const unique = (values: readonly string[]) => [...new Set(values)].sort();
const ipNumber = (address: string) => address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
const numberIp = (address: number) => [24, 16, 8, 0].map(shift => Math.floor(address / 2 ** shift) % 256).join(".");

/** netstat abbreviates network destinations: 10, 10.253 and 10.253/16. */
export function canonicalRouteCidr(value: string, abbreviated = false): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error("Host route inventory contains an invalid IPv4 destination.");
  const [raw, mask, ...extra] = value.split("/");
  const octets = raw!.split(".");
  if (extra.length || octets.length < (abbreviated ? 1 : 4) || octets.length > 4 || octets.some(octet => !/^(0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255)) throw new Error("Host route inventory contains an invalid IPv4 destination.");
  const prefix = mask === undefined ? octets.length * 8 : /^\d{1,2}$/.test(mask) ? Number(mask) : -1;
  if (prefix < 0 || prefix > 32) throw new Error("Host route inventory contains an invalid IPv4 prefix.");
  const address = [...octets, ...Array(4 - octets.length).fill("0")].join(".");
  const size = 2 ** (32 - prefix);
  return `${numberIp(Math.floor(ipNumber(address) / size) * size)}/${prefix}`;
}

function gateway(value: unknown): string | undefined {
  if (typeof value !== "string" || isIP(value) !== 4) throw new Error("Host route inventory contains an invalid IPv4 gateway.");
  return value === "0.0.0.0" ? undefined : `${value}/32`;
}

function finish(routes: readonly string[], gateways: readonly string[], count: number): Ipv4RouteInventory {
  if (count === 0) throw new Error("Host IPv4 route inventory is empty; subnet safety cannot be established.");
  return { routeCidrs: unique(routes.filter(value => value !== "0.0.0.0/0")), gatewayCidrs: unique(gateways) };
}

export function parseMacOsIpv4Routes(text: string): Ipv4RouteInventory {
  if (!/^Destination\s+Gateway\s+Flags\s+/m.test(text)) throw new Error("macOS IPv4 route inventory has an unrecognized table format.");
  const routes: string[] = [], gateways: string[] = [];
  let count = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "Routing tables" || line === "Internet:" || line.startsWith("Destination ")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 4) throw new Error("macOS IPv4 route inventory contains an incomplete row.");
    const destination = fields[0] === "default" ? "0.0.0.0/0" : canonicalRouteCidr(fields[0]!, true);
    const next = fields[1]!;
    if (isIP(next) === 4) gateways.push(gateway(next)!);
    else if (!/^link#\d+$/.test(next) && !/^(?:[a-f0-9]{1,2}:){5}[a-f0-9]{1,2}$/i.test(next)) throw new Error("macOS IPv4 route inventory has an unsupported gateway representation.");
    routes.push(destination); count++;
  }
  return finish(routes, gateways.filter(Boolean), count);
}

function jsonRows(text: string, platform: string): Record<string, unknown>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error(`${platform} IPv4 route inventory did not return JSON.`); }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  if (rows.some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new Error(`${platform} IPv4 route inventory contains an invalid row.`);
  return rows as Record<string, unknown>[];
}

export function parseLinuxIpv4Routes(text: string): Ipv4RouteInventory {
  const rows = jsonRows(text, "Linux");
  const routes: string[] = [], gateways: string[] = [];
  for (const row of rows) {
    if (typeof row.dst !== "string") throw new Error("Linux IPv4 route inventory lacks a destination.");
    routes.push(row.dst === "default" ? "0.0.0.0/0" : canonicalRouteCidr(row.dst));
    if (row.gateway !== undefined) { const value = gateway(row.gateway); if (value) gateways.push(value); }
    if (row.nexthops !== undefined) {
      if (!Array.isArray(row.nexthops)) throw new Error("Linux multipath route inventory is ambiguous.");
      for (const hop of row.nexthops) {
        if (!hop || typeof hop !== "object" || Array.isArray(hop)) throw new Error("Linux multipath route inventory contains an invalid nexthop.");
        if (hop.via !== undefined || hop.encap !== undefined) throw new Error("Linux multipath route inventory includes unsupported inter-family or encapsulated routing.");
        if (hop.gateway !== undefined) { const value = gateway(hop.gateway); if (value) gateways.push(value); }
      }
    }
    // Inter-family via/encapsulation requires a different route model; do not
    // silently drop that information when selecting host-safe fixture subnets.
    if (row.via !== undefined || row.encap !== undefined) throw new Error("Linux route inventory includes unsupported inter-family or encapsulated routing.");
  }
  return finish(routes, gateways, rows.length);
}

export function parseWindowsIpv4Routes(text: string): Ipv4RouteInventory {
  const rows = jsonRows(text, "Windows");
  const routes: string[] = [], gateways: string[] = [];
  for (const row of rows) {
    if (typeof row.DestinationPrefix !== "string" || typeof row.NextHop !== "string") throw new Error("Windows IPv4 route inventory lacks its prefix or next hop.");
    routes.push(canonicalRouteCidr(row.DestinationPrefix));
    const next = gateway(row.NextHop); if (next) gateways.push(next);
  }
  return finish(routes, gateways, rows.length);
}

/** Read-only Docker context inspection; never changes a context or contacts its daemon.
 * DOCKER_CONTEXT overrides DOCKER_HOST, which overrides the stored context.
 * https://docs.docker.com/reference/cli/docker/#environment-variables */
async function resolveLocalDockerSelection(
  docker: DockerRead,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ transport: "unix" | "npipe"; endpoint: string }> {
  const contextOverride = environment.DOCKER_CONTEXT || undefined;
  const hostOverride = environment.DOCKER_HOST || undefined;
  for (const value of [contextOverride, hostOverride]) if (value !== undefined && (value !== value.trim() || /[\x00-\x1f\x7f]/.test(value))) throw new Error("Docker endpoint selection contains ambiguous whitespace or control characters.");
  const shown = (await docker(["context", "show"])).trim();
  if (!shown || /[\r\n\x00]/.test(shown) || contextOverride && shown !== contextOverride) throw new Error("Docker's active context could not be resolved unambiguously.");
  const name = contextOverride ?? shown;
  let contexts: unknown;
  try { contexts = JSON.parse(await docker(["context", "inspect", name])); } catch { throw new Error("Docker context metadata could not be inspected safely."); }
  if (!Array.isArray(contexts) || contexts.length !== 1 || contexts[0]?.Name !== name || typeof contexts[0]?.Endpoints?.docker?.Host !== "string") throw new Error("Docker context metadata lacks one unambiguous daemon endpoint.");
  const endpoint: string = !contextOverride && hostOverride ? hostOverride : contexts[0].Endpoints.docker.Host;
  if (endpoint.startsWith("unix:///")) {
    if (platform !== "darwin" && platform !== "linux") throw new Error("Unix Docker endpoints are unsupported on this host platform.");
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new Error("Docker Unix endpoint is malformed."); }
    if (parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname === "/" || /[\x00-\x1f]/.test(endpoint)) throw new Error("Docker Unix endpoint is not an explicit local socket path.");
    return { transport: "unix", endpoint };
  }
  if (/^npipe:\/{2,4}\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint)) {
    if (platform !== "win32") throw new Error("Named-pipe Docker endpoints require a Windows host.");
    return { transport: "npipe", endpoint };
  }
  throw new Error("The parity spike requires a local Unix socket or local Windows named pipe. TCP, SSH and other remote Docker endpoints are refused before fixture changes.");
}

export async function resolveLocalDockerEndpoint(
  docker: DockerRead,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<"unix" | "npipe"> {
  return (await resolveLocalDockerSelection(docker, environment, platform)).transport;
}

async function readRoutes(platform: NodeJS.Platform): Promise<Ipv4RouteInventory> {
  const command = platform === "darwin" ? { executable: "netstat", args: ["-rn", "-f", "inet"], parse: parseMacOsIpv4Routes }
    : platform === "linux" ? { executable: "ip", args: ["-4", "-j", "route", "show", "table", "all"], parse: parseLinuxIpv4Routes }
      : platform === "win32" ? { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Get-NetRoute -AddressFamily IPv4 | Select-Object DestinationPrefix,NextHop | ConvertTo-Json -Compress"], parse: parseWindowsIpv4Routes }
        : undefined;
  if (!command) throw new Error("Host route inventory is unsupported on this platform; no fixture changes were made.");
  let output: string;
  try { output = (await execute(command.executable, command.args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout; }
  catch { throw new Error(`Read-only ${platform} IPv4 route inspection failed. The spike cannot safely allocate subnets without its native route inventory.`); }
  return command.parse(output);
}

/** Platform capability inspection only. Success is not a Windows/Linux runtime
 * certification, and returned addresses must stay in the private spike report. */
export async function inspectLocalDockerHost(docker: DockerRead): Promise<{ hostBlockedCidrs: string[]; routeCidrs: string[]; platform: string; dockerEndpoint: string }> {
  const selection = await resolveLocalDockerSelection(docker);
  const routes = await readRoutes(process.platform);
  const addresses = Object.values(networkInterfaces()).flatMap(values => values?.filter(value => value.family === "IPv4" && isIP(value.address) === 4).map(value => `${value.address}/32`) ?? []);
  if (!addresses.length) throw new Error("Host IPv4 interfaces could not be inventoried safely.");
  return { hostBlockedCidrs: unique([...addresses, ...routes.gatewayCidrs]), routeCidrs: routes.routeCidrs, platform: process.platform, dockerEndpoint: selection.endpoint };
}

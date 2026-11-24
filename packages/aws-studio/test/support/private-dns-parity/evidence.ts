import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PRIVATE_DNS_PARITY_FIXTURE } from "./model";

/** Characterization data only; this module never authorizes a release or AWS action. */
export interface ProbeContext {
  readonly contractHash: string;
  readonly fixtureHash: string;
  readonly probeHash: string;
}

export interface ProbeScenario {
  readonly id: string;
  readonly kind: "dns" | "tcp" | "http";
  readonly host: string;
  readonly port?: number;
  readonly path?: string;
  readonly method?: "GET" | "HEAD";
  readonly timeoutMs?: number;
  readonly dnsType?: "A" | "AAAA" | "CNAME" | "TXT" | "SOA" | "NS";
  readonly transport?: "udp" | "tcp";
  readonly resolver?: { readonly host: string; readonly port?: number };
  readonly fresh?: true;
}

export interface ProbeInput {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly environment: "local" | "aws";
  readonly context: ProbeContext;
  readonly runtime: "docker" | "lambda" | "host";
  readonly scenarios: readonly ProbeScenario[];
}

export interface DnsRecord {
  readonly name: string;
  readonly type: string;
  readonly class: number;
  readonly ttl: number;
  readonly data: unknown;
}

export interface ScenarioEvidence {
  readonly id: string;
  readonly kind: ProbeScenario["kind"];
  readonly request: ProbeScenario;
  readonly status: "observed" | "error" | "unsupported" | "skipped";
  readonly durationMs: number;
  readonly dns?: {
    readonly transport: "udp" | "tcp";
    readonly rcode: string;
    readonly flags: Readonly<Record<"aa" | "tc" | "rd" | "ra" | "ad" | "cd", boolean>>;
    readonly questions: readonly { readonly name: string; readonly type: string; readonly class: number }[];
    readonly answers: readonly DnsRecord[];
    readonly authority: readonly DnsRecord[];
  };
  readonly tcp?: { readonly outcome: "connected" | "timeout" | "refused" | "error"; readonly remoteAddress?: string };
  readonly http?: { readonly outcome: "response" | "error"; readonly statusCode?: number; readonly endpointId?: string; readonly json?: Readonly<Record<string, unknown>>; readonly headers?: Readonly<Record<string, unknown>> };
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ProbeRunEvidence {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly environment: "local" | "aws";
  readonly context: ProbeContext;
  readonly runtime: { readonly execution: "docker" | "lambda" | "host"; readonly node: string; readonly platform: string; readonly arch: string };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scenarios: readonly ScenarioEvidence[];
}

export interface ScenarioExpectation {
  readonly id: string;
  readonly kind: ProbeScenario["kind"];
  /** Intent excludes environment-specific resolver addresses and endpoint IPs. */
  readonly request: Omit<Pick<ProbeScenario, "host" | "port" | "path" | "method" | "dnsType" | "transport">, "host"> & { readonly host?: string };
  /** Direct endpoint IPs differ between Docker and AWS; normalize only when
   * this explicit target identity replaces a literal request hostname. */
  readonly requestEndpointId?: string;
  readonly dns?: {
    readonly rcode: string;
    readonly answerTypes: readonly string[];
    readonly endpointId?: string;
    readonly ttl?: { readonly min: number; readonly max: number };
    readonly flags?: Partial<Record<"aa" | "tc" | "rd" | "ra" | "ad" | "cd", boolean>>;
    readonly negativeSoa?: boolean;
  };
  readonly tcp?: { readonly outcome: "connected" | "timeout" };
  readonly http?: { readonly statusCode: number; readonly endpointId?: string; readonly json?: Readonly<Record<string, unknown>> };
}

export interface ParityEvidenceContract {
  readonly schemaVersion: 1;
  readonly scope: "phase-0-characterization";
  readonly context: ProbeContext;
  readonly scenarios: readonly ScenarioExpectation[];
}

export interface ParityAssessment {
  readonly status: "no-go" | "evidence-matches";
  readonly releaseAuthorized: false;
  readonly reasons: readonly string[];
  readonly comparedScenarios: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function parityHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

const unique = (values: readonly string[]) => [...new Set(values)].sort();
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const validContext = (context: ProbeContext | undefined) => context && [context.contractHash, context.fixtureHash, context.probeHash].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isInteger(value) && Number.isFinite(value);

function validContract(contract: ParityEvidenceContract): boolean {
  if (!object(contract) || contract.schemaVersion !== 1 || contract.scope !== "phase-0-characterization" || !validContext(contract.context) || !Array.isArray(contract.scenarios) || !contract.scenarios.length) return false;
  return contract.scenarios.every((expectation: unknown) => {
    if (!object(expectation) || typeof expectation.id !== "string" || !expectation.id || !object(expectation.request) || !["dns", "tcp", "http"].includes(String(expectation.kind))) return false;
    if (expectation.requestEndpointId !== undefined && (typeof expectation.requestEndpointId !== "string" || !expectation.requestEndpointId)) return false;
    if (expectation.request.host !== undefined && (typeof expectation.request.host !== "string" || !expectation.request.host)) return false;
    if (!expectation.request.host && !expectation.requestEndpointId || expectation.kind === "dns" && !expectation.request.host) return false;
    if (expectation.kind === "dns") {
      const dns = expectation.dns;
      if (!object(dns) || typeof dns.rcode !== "string" || !Array.isArray(dns.answerTypes) || dns.answerTypes.some(type => typeof type !== "string")) return false;
      if (dns.ttl !== undefined && (!object(dns.ttl) || !integer(dns.ttl.min) || !integer(dns.ttl.max) || dns.ttl.min < 0 || dns.ttl.max < dns.ttl.min)) return false;
      if (dns.flags !== undefined && (!object(dns.flags) || Object.values(dns.flags).some(value => typeof value !== "boolean"))) return false;
      if (dns.endpointId !== undefined && (typeof dns.endpointId !== "string" || !dns.endpointId)) return false;
      return dns.negativeSoa === undefined || typeof dns.negativeSoa === "boolean";
    }
    if (expectation.kind === "tcp") return object(expectation.tcp) && ["connected", "timeout"].includes(String(expectation.tcp.outcome));
    return object(expectation.http) && integer(expectation.http.statusCode) && expectation.http.statusCode >= 100 && expectation.http.statusCode <= 599;
  });
}

function validDnsRecord(record: unknown): record is DnsRecord {
  return object(record) && typeof record.name === "string" && typeof record.type === "string" && integer(record.class) && integer(record.ttl) && record.ttl >= 0;
}

export function createPhaseZeroDnsExpectations(vpc: "a" | "b", transport: "udp" | "tcp", fixture = PRIVATE_DNS_PARITY_FIXTURE): ScenarioExpectation[] {
  return fixture.dnsScenarios.map(scenario => ({
    id: `${vpc}-${transport}-${scenario.id}`,
    kind: "dns",
    request: { host: scenario.name, dnsType: scenario.type, transport },
    dns: scenario.outcome === "alias"
      ? { rcode: "NOERROR", answerTypes: ["A"], endpointId: scenario.endpoint ?? `alb-${vpc}`, ttl: { min: 0, max: 60 } }
      : { rcode: scenario.outcome === "NODATA" ? "NOERROR" : "NXDOMAIN", answerTypes: [], negativeSoa: true },
  }));
}

/**
 * Fail closed on missing AWS data, stale contexts, incomplete suites and unsupported
 * observations. Endpoint maps bind different IPs to declared fixture endpoints;
 * literal AWS and Docker addresses are intentionally never compared for equality.
 */
export function evaluateCharacterizationRun(
  contract: ParityEvidenceContract,
  run: ProbeRunEvidence | undefined,
  endpointMap: Readonly<Record<string, string>>,
): { readonly status: "observations-match" | "incomplete"; readonly releaseAuthorized: false; readonly reasons: readonly string[]; readonly observedScenarios: number } {
  const reasons: string[] = [];
  if (!validContract(contract)) return { status: "incomplete", releaseAuthorized: false, reasons: ["Invalid characterization contract/scenarios."], observedScenarios: 0 };
  if (contract.schemaVersion !== 1 || contract.scope !== "phase-0-characterization" || !validContext(contract.context)) reasons.push("Invalid characterization contract/context.");
  const expectedIds = contract.scenarios.map(scenario => scenario.id);
  if (!expectedIds.length || unique(expectedIds).length !== expectedIds.length) reasons.push("The contract requires nonempty, unique scenario IDs.");
  for (const expectation of contract.scenarios) {
    if (!expectation.id || (!expectation.request?.host && !expectation.requestEndpointId) || (expectation.kind === "dns" && !expectation.request?.host) || !["dns", "tcp", "http"].includes(expectation.kind) || !expectation[expectation.kind]) reasons.push(`Incomplete expectation: ${expectation.id}.`);
  }
  let observedScenarios = 0;
  if (!run) reasons.push("Characterization run evidence is missing.");
  else {
    const environment = run.environment;
    const execution = environment === "local" ? "docker" : "lambda";
    if (run.schemaVersion !== 1 || !["local", "aws"].includes(environment) || run.runtime?.execution !== execution || !run.runId) reasons.push(`${environment}: evidence provenance must identify ${execution}.`);
    if (!same(run.context, contract.context) || !validContext(run.context)) reasons.push(`${environment}: contract, fixture, or probe hash differs.`);
    if (!run.runtime?.node || run.runtime.platform !== "linux" || !["arm64", "x64"].includes(run.runtime.arch)) reasons.push(`${environment}: runtime version/platform/architecture is incomplete or unsupported.`);
    if (typeof run.startedAt !== "string" || typeof run.completedAt !== "string" || !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.completedAt)) || Date.parse(run.completedAt) < Date.parse(run.startedAt)) reasons.push(`${environment}: invalid evidence timestamps.`);
    const candidates: readonly unknown[] = Array.isArray(run.scenarios) ? run.scenarios : [];
    if (candidates.some(result => !object(result) || typeof result.id !== "string")) reasons.push(`${environment}: malformed scenario evidence.`);
    const results = candidates.filter(result => object(result) && typeof result.id === "string") as unknown as readonly ScenarioEvidence[];
    const actualIds = results.map(scenario => scenario.id);
    if (!same(unique(actualIds), unique(expectedIds)) || unique(actualIds).length !== actualIds.length) reasons.push(`${environment}: scenario set is incomplete, duplicated, or contains unexpected results.`);
    for (const expectation of contract.scenarios) {
      const result = results.find(scenario => scenario.id === expectation.id);
      if (!result) continue;
      if (result.status !== "observed" || result.kind !== expectation.kind || !Number.isFinite(result.durationMs) || result.durationMs < 0) { reasons.push(`${environment}/${expectation.id}: result is not a complete observation.`); continue; }
      for (const [key, value] of Object.entries(expectation.request)) if (value !== undefined && !same((result.request as unknown as Record<string, unknown>)?.[key], value)) reasons.push(`${environment}/${expectation.id}: request ${key} differs from contract.`);
      const fail = (message: string) => reasons.push(`${environment}/${expectation.id}: ${message}`);
      if (expectation.requestEndpointId && (typeof result.request?.host !== "string" || endpointMap[result.request.host] !== expectation.requestEndpointId)) fail("Request address does not map to the expected endpoint identity.");
      if (expectation.dns) {
        const actual = result.dns, expected = expectation.dns;
        if (!actual || !Array.isArray(actual.answers) || !Array.isArray(actual.authority) || !actual.answers.every(validDnsRecord) || !actual.authority.every(validDnsRecord)) { fail("DNS evidence is missing or malformed."); continue; }
        if (actual.rcode !== expected.rcode || !same(unique(actual.answers.map((record: DnsRecord) => record.type)), unique(expected.answerTypes))) fail("DNS RCODE/answer types differ.");
        const queryName = `${(expectation.request.host ?? "").replace(/\.$/, "").toLowerCase()}.`;
        if (!Array.isArray(actual.questions) || actual.questions.length !== 1 || !object(actual.questions[0]) || actual.questions[0]?.name !== queryName || actual.questions[0]?.type !== expectation.request.dnsType || actual.questions[0]?.class !== 1) fail("DNS question name/type/class differs.");
        if (actual.answers.some((record: DnsRecord) => record.class !== 1 || record.name !== queryName)) fail("DNS answer owner/class differs from the contracted alias query.");
        if (actual.transport !== expectation.request.transport) fail("DNS transport differs.");
        if (!actual.flags || ["aa", "tc", "rd", "ra", "ad", "cd"].some(flag => typeof actual.flags[flag as keyof typeof actual.flags] !== "boolean") || actual.flags.tc) fail("DNS flags are missing, invalid, or truncated.");
        for (const [flag, value] of Object.entries(expected.flags ?? {})) if (actual.flags?.[flag as keyof typeof actual.flags] !== value) fail(`DNS flag ${flag} differs.`);
        if (expected.negativeSoa && !actual.authority.some((record: DnsRecord) => record.type === "SOA" && record.class === 1 && object(record.data) && ["serial", "refresh", "retry", "expire", "minimum"].every(field => integer(record.data && (record.data as Record<string, unknown>)[field]) && Number((record.data as Record<string, unknown>)[field]) >= 0))) fail("Negative response lacks well-formed IN-class SOA evidence.");
        if (expected.endpointId && (!actual.answers.length || actual.answers.some((record: DnsRecord) => record.type !== "A" || typeof record.data !== "string" || endpointMap[record.data] !== expected.endpointId))) fail("DNS answers do not all map to the expected endpoint.");
        if (expected.ttl && actual.answers.some((record: DnsRecord) => !Number.isInteger(record.ttl) || record.ttl < expected.ttl!.min || record.ttl > expected.ttl!.max)) fail("DNS TTL is outside the contracted bounds.");
      }
      if (expectation.tcp && result.tcp?.outcome !== expectation.tcp.outcome) fail(`Expected TCP ${expectation.tcp.outcome}; an arbitrary error is not evidence of SG denial.`);
      if (expectation.http) {
        if (result.http?.outcome !== "response" || result.http.statusCode !== expectation.http.statusCode) fail("HTTP outcome/status differs.");
        if (expectation.http.endpointId && result.http?.endpointId !== expectation.http.endpointId) fail("HTTP endpoint identity differs.");
        for (const [key, value] of Object.entries(expectation.http.json ?? {})) if (!same(result.http?.json?.[key], value)) fail(`HTTP body field ${key} differs.`);
      }
      observedScenarios++;
    }
  }
  return { status: reasons.length ? "incomplete" : "observations-match", releaseAuthorized: false, reasons, observedScenarios };
}

function compareWellFormedEvidence(
  contract: ParityEvidenceContract,
  local: ProbeRunEvidence | undefined,
  aws: ProbeRunEvidence | undefined,
  endpointMaps: { readonly local: Readonly<Record<string, string>>; readonly aws: Readonly<Record<string, string>> },
): ParityAssessment {
  const localResult = evaluateCharacterizationRun(contract, local, endpointMaps.local);
  const awsResult = evaluateCharacterizationRun(contract, aws, endpointMaps.aws);
  const reasons = [...localResult.reasons, ...awsResult.reasons];
  if (!local || local.environment !== "local") reasons.push("Local Docker evidence is missing or misidentified.");
  if (!aws || aws.environment !== "aws") reasons.push("Real AWS Lambda evidence is missing; local-only observations cannot qualify.");
  if (local && aws && !same({ node: local.runtime?.node, platform: local.runtime?.platform, arch: local.runtime?.arch }, { node: aws.runtime?.node, platform: aws.runtime?.platform, arch: aws.runtime?.arch })) reasons.push("Local/AWS Node version, platform, or architecture differs.");
  if (reasons.length) return { status: "no-go", releaseAuthorized: false, reasons, comparedScenarios: Math.min(localResult.observedScenarios, awsResult.observedScenarios) };
  for (const expectation of contract.scenarios) {
    if (!expectation.dns) continue;
    const localDns = local?.scenarios.find(result => result.id === expectation.id)?.dns;
    const awsDns = aws?.scenarios.find(result => result.id === expectation.id)?.dns;
    if (!localDns || !awsDns) continue;
    if (!same(localDns.flags, awsDns.flags)) reasons.push(`${expectation.id}: local/AWS DNS response flags differ; calibration is required.`);
    if (expectation.dns.answerTypes.length) {
      const positiveTtls = (records: readonly DnsRecord[], endpoints: Readonly<Record<string, string>>) => {
        const groups = new Map<string, { min: number; max: number }>();
        for (const record of records) {
          const endpoint = record.type === "A" ? endpoints[String(record.data)] ?? record.data : record.data;
          const key = JSON.stringify([record.name, record.type, record.class, endpoint]);
          const previous = groups.get(key);
          groups.set(key, { min: Math.min(previous?.min ?? record.ttl, record.ttl), max: Math.max(previous?.max ?? record.ttl, record.ttl) });
        }
        return groups;
      };
      const localTtls = positiveTtls(localDns.answers, endpointMaps.local), awsTtls = positiveTtls(awsDns.answers, endpointMaps.aws);
      if (!same([...localTtls.keys()].sort(), [...awsTtls.keys()].sort()) || [...localTtls].some(([key, ttl]) => !awsTtls.has(key) || Math.abs(ttl.min - awsTtls.get(key)!.min) > 2 || Math.abs(ttl.max - awsTtls.get(key)!.max) > 2)) reasons.push(`${expectation.id}: observed positive DNS TTL differs by more than two seconds for the logical record/endpoint.`);
      // Different physical ALB address counts are permitted. This compares only
      // fresh observation TTLs; it does not certify cache aging or invalidation.
    }
    if (expectation.dns.negativeSoa) {
      const localSoa = localDns.authority.find(record => record.type === "SOA"), awsSoa = awsDns.authority.find(record => record.type === "SOA");
      const metadata = (record: DnsRecord | undefined) => {
        if (!record || !record.data || typeof record.data !== "object") return undefined;
        const data = record.data as Record<string, unknown>;
        // MNAME and RNAME identify the DNS provider's nameserver/mailbox and
        // intentionally differ between the local fixture and AWS. Only owner,
        // class and the numeric SOA semantics below participate in comparison.
        return { name: record.name, class: record.class, serial: data.serial, refresh: data.refresh, retry: data.retry, expire: data.expire, minimum: data.minimum };
      };
      if (!same(metadata(localSoa), metadata(awsSoa))) reasons.push(`${expectation.id}: local/AWS negative SOA metadata differs.`);
      const negativeTtl = (record: DnsRecord | undefined) => record && record.data && typeof record.data === "object" ? Math.min(record.ttl, Number((record.data as Record<string, unknown>).minimum)) : NaN;
      // This only compares fresh observations, not cache aging or invalidation.
      // The separate timing/cache release gate remains unimplemented in Phase 0.
      if (!Number.isFinite(negativeTtl(localSoa)) || !Number.isFinite(negativeTtl(awsSoa)) || Math.abs(negativeTtl(localSoa) - negativeTtl(awsSoa)) > 2) reasons.push(`${expectation.id}: observed negative cache TTL differs by more than two seconds.`);
    }
  }
  return { status: reasons.length ? "no-go" : "evidence-matches", releaseAuthorized: false, reasons, comparedScenarios: Math.min(localResult.observedScenarios, awsResult.observedScenarios) };
}

export function assessParityEvidence(
  contract: ParityEvidenceContract,
  local: ProbeRunEvidence | undefined,
  aws: ProbeRunEvidence | undefined,
  endpointMaps: { readonly local: Readonly<Record<string, string>>; readonly aws: Readonly<Record<string, string>> },
): ParityAssessment {
  try {
    if (!validContract(contract)) return { status: "no-go", releaseAuthorized: false, reasons: ["Invalid characterization contract/scenarios."], comparedScenarios: 0 };
    if (!object(endpointMaps) || ![endpointMaps.local, endpointMaps.aws].every(map => object(map) && Object.entries(map).every(([address, endpoint]) => isIP(address) === 4 && typeof endpoint === "string" && endpoint.length > 0))) return { status: "no-go", releaseAuthorized: false, reasons: ["Invalid comparison endpoint maps; explicit IPv4-to-endpoint identities are required."], comparedScenarios: 0 };
    return compareWellFormedEvidence(contract, local, aws, endpointMaps);
  } catch {
    return { status: "no-go", releaseAuthorized: false, reasons: ["Malformed comparison evidence; imported JSON did not satisfy the characterization shape."], comparedScenarios: 0 };
  }
}

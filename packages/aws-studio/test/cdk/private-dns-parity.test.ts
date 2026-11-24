import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Template } from "aws-cdk-lib/assertions";
import { assessParityEvidence, createPhaseZeroDnsExpectations, evaluateCharacterizationRun, parityHash, type ParityEvidenceContract, type ProbeRunEvidence, type ScenarioEvidence } from "../support/private-dns-parity/evidence";
import { createPrivateDnsParityAwsFixture, PARITY_FIXTURE_ACCOUNT, PARITY_FIXTURE_OWNER } from "./support/private-dns-parity-fixture";

const probePath = path.resolve(__dirname, "../support/private-dns-parity/probe.mjs");

test("Phase 0 AWS fixture synthesizes in explicit dev/prod modes without account lookups, Docker builds, or application resources", () => {
  for (const mode of ["dev", "prod"] as const) {
    const directory = mkdtempSync(path.join(tmpdir(), `private-dns-parity-${mode}-`));
    try {
      const built = createPrivateDnsParityAwsFixture({ directory, mode, ...(mode === "prod" ? { probeArchitecture: "x86_64" } : {}) });
      const assembly = built.app.synth();
      const template = Template.fromStack(built.stack);
      template.resourceCountIs("AWS::EC2::VPC", 2);
      template.resourceCountIs("AWS::EC2::NatGateway", 0);
      template.resourceCountIs("AWS::EC2::EgressOnlyInternetGateway", 0);
      template.resourceCountIs("AWS::Route53Resolver::ResolverEndpoint", 0);
      template.resourceCountIs("AWS::Route53::HostedZone", built.fixture.zones.length);
      template.resourceCountIs("AWS::Route53::RecordSet", built.fixture.zones.reduce((count, zone) => count + zone.records.length, 0));
      template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 2);
      template.resourceCountIs("AWS::ECS::Service", 2);
      template.resourceCountIs("AWS::Lambda::Function", 5);
      assert.equal(assembly.stacks.length, 1);
      assert.equal(assembly.stacks[0]!.environment.account, PARITY_FIXTURE_ACCOUNT);
      assert.deepEqual(readdirSync(built.assetDirectory).sort(), ["index.mjs", "probe.mjs"]);
      assert.deepEqual(readFileSync(path.join(built.assetDirectory, "probe.mjs")), readFileSync(probePath), "Lambda asset contains the exact shared local probe bytes");
      for (const resource of Object.values(template.findResources("AWS::EC2::VPC"))) {
        assert.equal(resource.Properties.EnableDnsSupport, true);
        assert.equal(resource.Properties.EnableDnsHostnames, true);
      }
      for (const resource of Object.values(template.findResources("AWS::ElasticLoadBalancingV2::LoadBalancer"))) {
        assert.equal(resource.Properties.Scheme, "internal");
        assert.equal(resource.Properties.IpAddressType, "ipv4");
      }
      for (const resource of Object.values(template.findResources("AWS::Route53::RecordSet"))) {
        assert.equal(resource.Properties.Type, "A");
        assert.ok(resource.Properties.AliasTarget);
        assert.equal(resource.Properties.AliasTarget.EvaluateTargetHealth, false);
        assert.equal(resource.Properties.TTL, undefined, "ALB aliases inherit target TTL");
      }
      const sharedAlias = Object.values(template.findResources("AWS::Route53::RecordSet")).find(resource => String(resource.Properties.Name).replace(/\.$/, "") === built.fixture.names.sharedApi)!;
      assert.match(JSON.stringify(sharedAlias.Properties.AliasTarget.DNSName), /AlbA/, "shared DNS points to A's ALB from both associated VPCs");
      const hostedZoneAssociations = Object.values(template.findResources("AWS::Route53::HostedZone")).map(resource => resource.Properties.VPCs);
      assert.deepEqual(hostedZoneAssociations.map(vpcs => vpcs.length).sort(), [1, 1, 1, 1, 2], "one physical shared PHZ associates both VPCs");
      assert.equal(new Set(hostedZoneAssociations.find(vpcs => vpcs.length === 2)!.map((vpc: any) => JSON.stringify(vpc.VPCId))).size, 2, "shared associations reference distinct VPCs");
      const ingress = [
        ...Object.values(template.findResources("AWS::EC2::SecurityGroup")).flatMap(resource => resource.Properties.SecurityGroupIngress ?? []),
        ...Object.values(template.findResources("AWS::EC2::SecurityGroupIngress")).map(resource => resource.Properties),
      ];
      const httpIngress = ingress.filter(rule => rule.FromPort === 80);
      assert.equal(httpIngress.length, 2, "one explicit caller SG grant per ALB");
      assert.ok(httpIngress.every(rule => rule.SourceSecurityGroupId && !rule.CidrIp && !rule.CidrIpv6), "DNS creates no broad HTTP ingress");
      const probes = Object.values(template.findResources("AWS::Lambda::Function"));
      assert.deepEqual(probes.filter(resource => resource.Properties.VpcConfig).map(resource => resource.Properties.VpcConfig.SecurityGroupIds.length).sort(), [1, 1, 2, 2]);
      assert.equal(probes.filter(resource => !resource.Properties.VpcConfig).length, 1, "one real outside probe has no customer VPC association");
      assert.ok(probes.every(resource => resource.Properties.Runtime === "nodejs24.x" && resource.Properties.Environment.Variables.PRIVATE_DNS_PARITY_OWNER === PARITY_FIXTURE_OWNER));
      assert.ok(probes.every(resource => resource.Properties.Architectures[0] === (mode === "prod" ? "x86_64" : process.arch === "arm64" ? "arm64" : "x86_64")), "architecture defaults to host or uses the explicit override");
      assert.equal((template.toJSON().Metadata as any).privateDnsParity.deploymentReady, false);
      assert.equal((template.toJSON().Metadata as any).privateDnsParity.realAwsEvidence, false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

const dnsFlags = { aa: false, tc: false, rd: true, ra: true, ad: false, cd: false };
const context = { contractHash: parityHash("test-contract"), fixtureHash: parityHash("test-topology"), probeHash: parityHash("test-probe") };
const contract: ParityEvidenceContract = {
  schemaVersion: 1, scope: "phase-0-characterization", context,
  scenarios: [
    { id: "alias", kind: "dns", request: { host: "api.internal.parity.test", dnsType: "A", transport: "udp" }, dns: { rcode: "NOERROR", answerTypes: ["A"], endpointId: "alb-a", ttl: { min: 0, max: 60 } } },
    { id: "aaaa-nodata", kind: "dns", request: { host: "api.internal.parity.test", dnsType: "AAAA", transport: "tcp" }, dns: { rcode: "NOERROR", answerTypes: [], negativeSoa: true } },
    { id: "denied", kind: "tcp", request: { host: "api.internal.parity.test", port: 80 }, tcp: { outcome: "timeout" } },
    { id: "identity", kind: "http", request: { host: "api.internal.parity.test", port: 80, path: "/identity" }, http: { statusCode: 200, endpointId: "alb-a" } },
    { id: "denied-direct-backend", kind: "tcp", request: { port: 5000 }, requestEndpointId: "backend-a", tcp: { outcome: "timeout" } },
  ],
};

/** Synthetic snapshots exercise gate rejection; they are never saved as AWS proof. */
function snapshot(environment: "local" | "aws"): ProbeRunEvidence {
  const address = environment === "local" ? "172.28.0.20" : "10.70.1.15";
  const backendAddress = environment === "local" ? "172.28.0.30" : "10.70.1.25";
  const scenarios: ScenarioEvidence[] = contract.scenarios.map(expectation => ({
    id: expectation.id, kind: expectation.kind, request: { id: expectation.id, kind: expectation.kind, ...expectation.request, host: expectation.request.host ?? backendAddress }, status: "observed", durationMs: 1,
    ...(expectation.dns ? { dns: {
      transport: expectation.request.transport!, rcode: expectation.dns.rcode, flags: dnsFlags,
      questions: [{ name: "api.internal.parity.test.", type: expectation.request.dnsType!, class: 1 }],
      answers: expectation.id === "alias" ? [{ name: "api.internal.parity.test.", type: "A", class: 1, ttl: 60, data: address }] : [],
      authority: expectation.id === "aaaa-nodata" ? [{ name: "internal.parity.test.", type: "SOA", class: 1, ttl: 60, data: { primaryNameServer: "ns.internal.parity.test.", responsibleMailbox: "hostmaster.internal.parity.test.", serial: 1, refresh: 60, retry: 60, expire: 60, minimum: 60 } }] : [],
    } } : {}),
    ...(expectation.tcp ? { tcp: { outcome: "timeout" as const } } : {}),
    ...(expectation.http ? { http: { outcome: "response" as const, statusCode: 200, endpointId: "alb-a" } } : {}),
  }));
  return { schemaVersion: 1, runId: `synthetic-${environment}`, environment, context, runtime: { execution: environment === "local" ? "docker" : "lambda", node: "v24.22.2", platform: "linux", arch: "x64" }, startedAt: "2026-11-12T00:00:00.000Z", completedAt: "2026-11-12T00:00:01.000Z", scenarios };
}
const endpointMaps = { local: { "172.28.0.20": "alb-a", "172.28.0.30": "backend-a" }, aws: { "10.70.1.15": "alb-a", "10.70.1.25": "backend-a" } };

test("Phase 0 gate maps endpoint identity across different IPs and never authorizes a release", () => {
  assert.equal(createPhaseZeroDnsExpectations("b", "udp").find(scenario => scenario.id === "b-udp-shared-alias")?.dns?.endpointId, "alb-a");
  const assessed = assessParityEvidence(contract, snapshot("local"), snapshot("aws"), endpointMaps);
  assert.equal(assessed.status, "evidence-matches", assessed.reasons.join("\n"));
  assert.equal(assessed.releaseAuthorized, false);
  assert.equal(evaluateCharacterizationRun(contract, snapshot("local"), endpointMaps.local).status, "observations-match");
  const localOnly = assessParityEvidence(contract, snapshot("local"), undefined, endpointMaps);
  assert.equal(localOnly.status, "no-go");
  assert.match(localOnly.reasons.join("\n"), /Real AWS Lambda evidence is missing/);
});

test("Phase 0 compares fresh positive TTLs by logical endpoint without equating ALB address counts", () => {
  const local: any = structuredClone(snapshot("local"));
  const aws: any = structuredClone(snapshot("aws"));
  local.scenarios[0].dns.answers[0].ttl = 0;
  assert.equal(assessParityEvidence(contract, local, aws, endpointMaps).status, "no-go", "independently valid TTL bounds do not establish matching observations");
  local.scenarios[0].dns.answers[0].ttl = 58;
  assert.equal(assessParityEvidence(contract, local, aws, endpointMaps).status, "evidence-matches", "fresh observation tolerance is two seconds");
  local.scenarios[0].dns.answers[0].ttl = 57;
  assert.equal(assessParityEvidence(contract, local, aws, endpointMaps).status, "no-go");
  local.scenarios[0].dns.answers[0].ttl = 60;
  aws.scenarios[0].dns.answers.push({ ...aws.scenarios[0].dns.answers[0], data: "10.70.1.16" });
  const multipleAddresses = { ...endpointMaps, aws: { ...endpointMaps.aws, "10.70.1.16": "alb-a" } };
  assert.equal(assessParityEvidence(contract, local, aws, multipleAddresses).status, "evidence-matches", "one local address and multiple AWS nodes represent the same endpoint");
  aws.scenarios[0].dns.answers[1].ttl = 57;
  assert.equal(assessParityEvidence(contract, local, aws, multipleAddresses).status, "no-go", "all TTLs in a logical record group are compared");
});

test("Phase 0 returns structured no-go for malformed imported contracts and evidence", () => {
  const invalidContracts = [null, {}, { ...contract, scenarios: null }, { ...contract, scenarios: [null] }, { ...contract, scenarios: [{ ...contract.scenarios[0], dns: { ...contract.scenarios[0]!.dns, ttl: { min: "zero", max: 60 } } }] }];
  for (const invalid of invalidContracts) {
    const result = assessParityEvidence(invalid as any, snapshot("local"), snapshot("aws"), endpointMaps);
    assert.equal(result.status, "no-go");
    assert.equal(result.releaseAuthorized, false);
    assert.ok(result.reasons.length);
  }
  for (const invalid of [null, {}, { local: null, aws: endpointMaps.aws }, { local: endpointMaps.local, aws: [] }, { ...endpointMaps, aws: { "not-an-address": "alb-a" } }, { ...endpointMaps, aws: { "10.70.1.15": 42 } }]) {
    const result = assessParityEvidence(contract, snapshot("local"), snapshot("aws"), invalid as any);
    assert.equal(result.status, "no-go");
    assert.equal(result.releaseAuthorized, false);
    assert.ok(result.reasons.length);
  }
  for (const mutate of [
    (run: any) => { run.scenarios = null; },
    (run: any) => { run.scenarios = {}; },
    (run: any) => { run.scenarios[0] = null; },
    (run: any) => { run.scenarios[0].dns.answers = null; },
    (run: any) => { run.scenarios[0].dns.answers[0] = null; },
    (run: any) => { run.scenarios[0].dns.answers[0].ttl = NaN; },
    (run: any) => { run.scenarios[0].dns.questions[0] = null; },
    (run: any) => { run.scenarios[1].dns.authority = null; },
    (run: any) => { run.scenarios[1].dns.authority[0].data = { minimum: 60 }; },
    (run: any) => { run.runtime = null; },
  ]) {
    const aws: any = structuredClone(snapshot("aws")); mutate(aws);
    const result = assessParityEvidence(contract, snapshot("local"), aws, endpointMaps);
    assert.equal(result.status, "no-go");
    assert.equal(result.releaseAuthorized, false);
    assert.ok(result.reasons.length);
  }
});

test("Phase 0 gate rejects stale, skipped, incomplete and semantically different evidence", () => {
  for (const mutate of [
    (run: any) => { run.context.probeHash = "0".repeat(64); },
    (run: any) => { run.scenarios.pop(); },
    (run: any) => { run.scenarios.push(run.scenarios[0]); },
    (run: any) => { run.scenarios[0].status = "skipped"; },
    (run: any) => { run.scenarios[0].dns.answers[0].data = "10.70.1.99"; },
    (run: any) => { run.scenarios[0].dns.questions[0].class = 3; },
    (run: any) => { run.scenarios[0].dns.answers[0].name = "other.internal.parity.test."; },
    (run: any) => { run.scenarios[0].dns.answers[0].ttl = 600; },
    (run: any) => { run.scenarios[0].dns.flags.aa = true; },
    (run: any) => { run.scenarios[1].dns.rcode = "NXDOMAIN"; },
    (run: any) => { run.scenarios[1].dns.authority[0].data.minimum = 86400; },
    (run: any) => { run.scenarios[1].dns.authority[0].ttl = 10; },
    (run: any) => { run.scenarios[2].tcp.outcome = "error"; },
    (run: any) => { run.runtime.execution = "host"; },
    (run: any) => { run.runtime.node = "v24.1.0"; },
    (run: any) => { run.scenarios[4].request.host = "10.70.1.15"; },
    (run: any) => { run.scenarios[4].request.port = 5001; },
  ]) {
    const aws = structuredClone(snapshot("aws")); mutate(aws);
    assert.equal(assessParityEvidence(contract, snapshot("local"), aws, endpointMaps).status, "no-go");
  }
});

function dnsAnswer() {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x1234); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 4); header.writeUInt16BE(1, 6);
  const name = Buffer.concat([Buffer.from([3]), Buffer.from("api"), Buffer.from([8]), Buffer.from("internal"), Buffer.from([6]), Buffer.from("parity"), Buffer.from([4]), Buffer.from("test"), Buffer.from([0])]);
  const question = Buffer.from([0, 1, 0, 1]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 10, 70, 0, 20]);
  return Buffer.concat([header, name, question, answer]);
}

test("shared raw DNS probe parses compressed answers and rejects malformed packet bounds", async () => {
  const { decodeDnsPacket } = await import(pathToFileURL(probePath).href);
  const packet = dnsAnswer();
  const parsed = decodeDnsPacket(packet, 0x1234);
  assert.equal(parsed.rcode, "NOERROR");
  assert.deepEqual(parsed.flags, dnsFlags);
  assert.deepEqual(parsed.answers, [{ name: "api.internal.parity.test.", type: "A", class: 1, ttl: 60, data: "10.70.0.20" }]);
  assert.throws(() => decodeDnsPacket(Buffer.alloc(2), 0x1234), /header/);
  assert.throws(() => decodeDnsPacket(packet, 0x9999), /transaction/);
  assert.throws(() => decodeDnsPacket(packet.subarray(0, packet.length - 1), 0x1234), /Truncated DNS record data/);
  const loop = Buffer.from(packet); loop[12] = 0xc0; loop[13] = 12;
  assert.throws(() => decodeDnsPacket(loop, 0x1234), /compression/);
  const excessive = Buffer.from(packet); excessive.writeUInt16BE(65535, 6);
  assert.throws(() => decodeDnsPacket(excessive, 0x1234), /record count/);
});

test("shared probe refuses source-hash and runtime relabeling and marks unsupported scenarios", async () => {
  const { runProbe } = await import(pathToFileURL(probePath).href);
  const actualHash = createHash("sha256").update(readFileSync(probePath)).digest("hex");
  const runtime = existsSync("/.dockerenv") ? "docker" : "host";
  const input = { schemaVersion: 1, runId: "host-only-negative-test", environment: "local", context: { ...context, probeHash: actualHash }, runtime, scenarios: [{ id: "unsupported", kind: "inspect", host: "api.internal.parity.test" }] };
  const observed = await runProbe(input);
  assert.equal(observed.scenarios[0].status, "unsupported");
  await assert.rejects(runProbe({ ...input, context }), /source bytes/);
  await assert.rejects(runProbe({ ...input, runtime: "lambda" }), /does not match detected/);
});

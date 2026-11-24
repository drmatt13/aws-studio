import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateDnsParityFixture, fixtureAddress, PRIVATE_DNS_PARITY_FIXTURE } from "./support/private-dns-parity/model";
import { compileNftPolicy, renderCoreDns, type NftPolicyOptions } from "./support/private-dns-parity/policy";

const subnet = "10.231.42.0/24";
const ip = (role: Parameters<typeof fixtureAddress>[1]) => fixtureAddress(subnet, role);
const base: NftPolicyOptions = {
  role: "caller", address: ip("caller"), subnetCidr: subnet,
  resolver: ip("resolver"), alb: ip("alb"), backend: ip("backend"),
  callerAddresses: [ip("caller"), ip("deniedCaller"), ip("isolatedCaller")],
  allowedCallerAddresses: [ip("caller"), ip("isolatedCaller")],
  blockedCidrs: ["10.232.0.0/16", "145.1.2.3/32"], ipv4Egress: false,
};

interface Packet {
  readonly direction: "input" | "output";
  readonly source: string;
  readonly destination: string;
  readonly protocol: "tcp" | "udp" | "icmp";
  readonly port?: number;
  readonly family?: 4 | 6;
  readonly state?: "new" | "established" | "related" | "invalid";
  readonly interface?: "lo" | "eth0";
}

/** Independent, deliberately small interpreter of emitted nft predicates. Tests
 * assert packet outcomes, including negative paths, rather than compiler text. */
function verdict(policy: string, packet: Packet): "accept" | "drop" {
  const body = new RegExp(`chain ${packet.direction} \\{([\\s\\S]*?)\\n  \\}`).exec(policy)?.[1];
  assert.ok(body, "emitted policy must contain the requested chain");
  assert.match(body, /policy drop;/);
  const number = (address: string) => address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
  const matchesAddress = (address: string, item: string) => {
    if (!item.includes("/")) return address === item;
    const [network, prefix] = item.split("/");
    return Math.floor(number(address) / 2 ** (32 - Number(prefix))) === Math.floor(number(network!) / 2 ** (32 - Number(prefix)));
  };
  for (const line of body.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("type "))) {
    const action = / (accept|drop)$/.exec(line)?.[1] as "accept" | "drop" | undefined;
    assert.ok(action, `unrecognized action: ${line}`);
    let matches = false;
    if (line.startsWith("ct state ")) {
      matches = line.split(" ")[2]!.split(",").includes(packet.state ?? "new");
    } else if (/^[io]ifname /.test(line)) {
      matches = /"([^"]+)"/.exec(line)?.[1] === (packet.interface ?? "eth0");
    } else if (line.startsWith("meta nfproto ")) {
      matches = line.split(" ")[2] === `ipv${packet.family ?? 4}` && (!line.includes("meta l4proto") || line.split(" ")[5] === packet.protocol);
    } else {
      const match = /^ip (saddr|daddr) (!= )?(\{[^}]+\}|[^ ]+)(?: (tcp|udp) dport (\d+))? (accept|drop)$/.exec(line);
      assert.ok(match, `unrecognized policy predicate: ${line}`);
      if ((packet.family ?? 4) !== 4) continue;
      const address = match[1] === "saddr" ? packet.source : packet.destination;
      const choices = match[3]!.replace(/[{}]/g, "").split(",").map(value => value.trim());
      const included = choices.some(choice => matchesAddress(address, choice));
      matches = (match[2] ? !included : included) && (!match[4] || packet.protocol === match[4] && packet.port === Number(match[5]));
    }
    if (matches) return action;
  }
  return "drop";
}

const output = (destination: string, port = 80, extra: Partial<Packet> = {}): Packet => ({ direction: "output", source: base.address, destination, protocol: "tcp", port, ...extra });
const input = (source: string, port: number, extra: Partial<Packet> = {}): Packet => ({ direction: "input", source, destination: base.alb, protocol: "tcp", port, ...extra });

test("an isolated caller can resolve and attempt its ALB, but cannot reach peers, backends or internet", () => {
  const policy = compileNftPolicy(base);
  for (const protocol of ["tcp", "udp"] as const) assert.equal(verdict(policy, output(base.resolver, 53, { protocol })), "accept");
  assert.equal(verdict(policy, output(base.alb)), "accept");
  for (const [address, port] of [[base.alb, 5000], [base.backend, 5000], [ip("deniedCaller"), 80], [base.resolver, 80], ["8.8.8.8", 53], ["1.1.1.1", 443]] as const) {
    assert.equal(verdict(policy, output(address, port)), "drop", `${address}:${port}`);
  }
  assert.equal(verdict(policy, input(base.alb, 80, { destination: base.address })), "drop", "a caller is not a data listener");
});

test("only individually granted callers enter ALB HTTP; a denied caller can still resolve and attempt", () => {
  const policy = compileNftPolicy({ ...base, role: "alb", address: base.alb });
  for (const caller of base.allowedCallerAddresses) assert.equal(verdict(policy, input(caller, 80)), "accept");
  for (const source of [ip("deniedCaller"), base.backend, "10.232.0.30", "1.1.1.1"]) assert.equal(verdict(policy, input(source, 80)), "drop", source);
  assert.equal(verdict(policy, input(base.address, 443)), "drop");
  assert.equal(verdict(policy, input(base.address, 80, { destination: base.backend })), "drop", "wrong local address");
  const denied = compileNftPolicy({ ...base, address: ip("deniedCaller") });
  assert.equal(verdict(denied, output(base.resolver, 53, { source: ip("deniedCaller"), protocol: "udp" })), "accept");
  assert.equal(verdict(denied, output(base.alb, 80, { source: ip("deniedCaller") })), "accept");
  assert.equal(verdict(compileNftPolicy({ ...base, role: "alb", address: base.alb, allowedCallerAddresses: [] }), input(base.address, 80)), "drop");
});

test("ALB reaches only its backend port and the backend accepts only that ALB", () => {
  const alb = compileNftPolicy({ ...base, role: "alb", address: base.alb });
  assert.equal(verdict(alb, output(base.backend, 5000, { source: base.alb })), "accept");
  assert.equal(verdict(alb, output(base.backend, 80, { source: base.alb })), "drop");
  const backend = compileNftPolicy({ ...base, role: "backend", address: base.backend });
  assert.equal(verdict(backend, input(base.alb, 5000, { destination: base.backend })), "accept");
  for (const source of base.callerAddresses) assert.equal(verdict(backend, input(source, 5000, { destination: base.backend })), "drop");
  assert.equal(verdict(backend, input(base.alb, 80, { destination: base.backend })), "drop");
});

test("stateful replies and loopback work without opening new inbound flows or IPv6 egress", () => {
  const policy = compileNftPolicy(base);
  for (const state of ["established", "related"] as const) assert.equal(verdict(policy, input("1.1.1.1", 40123, { destination: base.address, state })), "accept");
  assert.equal(verdict(policy, output(base.alb, 80, { state: "invalid" })), "drop");
  assert.equal(verdict(policy, output("127.0.0.1", 8090, { interface: "lo" })), "accept");
  assert.equal(verdict(policy, input("127.0.0.1", 8090, { interface: "lo", destination: "127.0.0.1" })), "accept");
  assert.equal(verdict(policy, output("2001:4860:4860::8888", 53, { family: 6, state: "established" })), "drop");
  assert.equal(verdict(policy, output(base.alb, 80, { source: ip("deniedCaller") })), "drop", "incorrect local source");
});

test("IPv4 internet permission never opens private, host/control, reserved, or other-VPC destinations", () => {
  const policy = compileNftPolicy({ ...base, ipv4Egress: true });
  for (const destination of ["1.1.1.1", "8.8.8.8", "145.1.2.4"]) assert.equal(verdict(policy, output(destination, 443)), "accept");
  assert.equal(verdict(policy, output("1.1.1.1", undefined, { protocol: "icmp" })), "drop", "new ICMP is outside the fixture contract");
  assert.equal(verdict(policy, output("1.1.1.1", 53, { protocol: "udp" })), "accept");
  for (const destination of ["0.0.0.0", "10.232.0.30", "100.100.100.100", "127.0.0.1", "169.254.169.254", "172.17.0.1", "192.168.65.254", "198.19.0.1", "224.0.0.1", "255.255.255.255", "145.1.2.3", ip("externalFixture")]) {
    assert.equal(verdict(policy, output(destination, 80)), "drop", destination);
  }
  assert.equal(verdict(policy, output(base.alb)), "accept", "explicit private service survives private-range blocking");
  assert.equal(verdict(policy, output(base.resolver, 53)), "accept", "explicit resolver survives private-range blocking");
});

test("management exceptions are exact endpoints, and generated policies do not flush other tables", () => {
  const policy = compileNftPolicy({ ...base, managementPorts: [{ address: "10.250.0.5", port: 8090 }] });
  assert.equal(verdict(policy, output("10.250.0.5", 8090)), "accept");
  assert.equal(verdict(policy, output("10.250.0.5", 8091)), "drop");
  assert.equal(verdict(policy, output("10.250.0.6", 8090)), "drop");
  assert.doesNotMatch(policy, /flush|delete|table ip nat/);
  // Overlapping anonymous nft sets are invalid: specific host blocks under
  // existing private supernets must be removed before rendering.
  const withOverlap = compileNftPolicy({ ...base, blockedCidrs: [subnet, `${base.backend}/32`, "10.0.0.0/8"] });
  assert.doesNotMatch(withOverlap, /10\.231\.42\.0\/24/);
  assert.doesNotMatch(withOverlap, /10\.231\.42\.20\/32/);
});

test("invalid identities, CIDRs and policy text are rejected before interpolation", () => {
  for (const changed of [
    { address: "10.231.42.30\naccept" }, { resolver: "::1" }, { subnetCidr: "10.231.42.1/24" },
    { allowedCallerAddresses: [base.backend] }, { blockedCidrs: ["0.0.0.0/0\naccept"] },
    { role: "backend", address: base.address }, { ipv4Egress: "true" },
    { managementPorts: [{ address: "1.1.1.1", port: 0 }] },
  ]) assert.throws(() => compileNftPolicy({ ...base, ...changed } as NftPolicyOptions));
  assert.throws(() => fixtureAddress("010.1.2.0/24", "alb"));
});

test("CoreDNS views derive real zone files from one immutable fixture, including shadowed parent data", () => {
  const fixture = PRIVATE_DNS_PARITY_FIXTURE;
  const addresses = { albA: "10.231.42.10", albB: "10.232.42.10", resolver: "10.231.42.53" };
  for (const view of ["a", "b"] as const) {
    const rendered = renderCoreDns({ view, addresses, upstream: "1.1.1.1" });
    assert.equal(Object.keys(rendered.zoneFiles).length, 3);
    for (const zone of fixture.zones.filter(zone => zone.associations.includes(view))) {
      const text = rendered.zoneFiles[`${zone.id}.zone`]!;
      assert.match(text, /IN SOA/); assert.match(text, /IN NS/);
      assert.ok(text.includes(`@ 900 IN SOA ns.${zone.name}. hostmaster.${zone.name}. ( 1 7200 900 1209600 86400 )`));
      assert.doesNotMatch(text, /^ns IN A/m, "provider NS identity must not invent an address record");
      for (const record of zone.records) assert.ok(text.includes(`${record.name}. 60 IN A ${record.endpoint === "alb-a" ? addresses.albA : addresses.albB}`));
      assert.ok(rendered.corefile.includes(`file /zones/${zone.id}.zone ${zone.name}`));
    }
    assert.ok(rendered.zoneFiles[`${view}-parent.zone`]!.includes(`${fixture.names.shadowedParent}.`));
    assert.ok(!rendered.zoneFiles[`${view}-child.zone`]!.includes(`${fixture.names.shadowedParent}.`));
    assert.doesNotMatch(rendered.corefile, /fallthrough|hosts|template/);
    assert.ok(rendered.zoneFiles["shared.zone"]!.includes(`${fixture.names.sharedApi}. 60 IN A ${addresses.albA}`), "shared DNS visibility does not fabricate a VPC-local target");
  }
  const outside = renderCoreDns({ view: "outside", addresses, upstream: "1.1.1.1:5353" });
  assert.deepEqual(outside.zoneFiles, {});
  assert.doesNotMatch(outside.corefile, /internal\.parity\.test|file /);
  assert.match(outside.corefile, /forward \. 1\.1\.1\.1:5353/);
  assert.ok(Object.isFrozen(fixture.zones[0]!.records));
  assert.ok(Object.isFrozen(fixture.zones[0]!.associations));
  assert.equal(fixture.zones.filter(zone => zone.id === "shared").length, 1, "multiple VPC associations do not duplicate the owned zone");
  assert.deepEqual(fixture.zones.find(zone => zone.id === "shared")!.associations, ["a", "b"]);
});

test("the same fixture can use an owned AWS suffix and rejects path/Corefile injection", () => {
  const fixture = createPrivateDnsParityFixture("PHZ.Example.org.");
  assert.equal(fixture.zoneName, "phz.example.org");
  assert.ok(fixture.zones.every(zone => zone.name.endsWith(fixture.zoneName)));
  assert.ok(fixture.dnsScenarios.some(probe => probe.type === "TXT" && probe.outcome === "NODATA"));
  for (const value of ["localhost", "a..test", "a.test\nforward . 1.1.1.1"]) assert.throws(() => createPrivateDnsParityFixture(value));
  const options = { view: "a", addresses: { albA: base.alb, albB: "10.232.0.10" }, upstream: "1.1.1.1" } as const;
  assert.throws(() => renderCoreDns({ ...options, zoneDirectory: "/zones/../secret" }));
  assert.throws(() => renderCoreDns({ ...options, upstream: "1.1.1.1\nreload" }));
});

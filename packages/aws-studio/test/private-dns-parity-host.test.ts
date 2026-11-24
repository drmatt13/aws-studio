import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRouteCidr, parseMacOsIpv4Routes, parseLinuxIpv4Routes, parseWindowsIpv4Routes, resolveLocalDockerEndpoint } from "./support/private-dns-parity/docker-host";

test("macOS network abbreviations become canonical CIDRs, including non-octet masks", () => {
  const expected: Record<string, string> = {
    "10": "10.0.0.0/8", "10.253": "10.253.0.0/16", "10.253/16": "10.253.0.0/16",
    "192.168.4/22": "192.168.4.0/22", "192.168.5.90/22": "192.168.4.0/22",
    "127.0.0.1": "127.0.0.1/32", "0/0": "0.0.0.0/0", "10/12": "10.0.0.0/12",
  };
  for (const [source, target] of Object.entries(expected)) assert.equal(canonicalRouteCidr(source, true), target);
  for (const source of ["010.253", "256.1/16", "10.1/33", "10.1/-1", "10.1/24\naccept", "a.internal", "1.2.3.4.5", ""]) assert.throws(() => canonicalRouteCidr(source, true));
  assert.throws(() => canonicalRouteCidr("10.253/16"), "non-macOS parsers cannot assume abbreviated destination semantics");
});

test("macOS route parsing excludes default occupancy but blocks observed gateways", () => {
  const inventory = parseMacOsIpv4Routes(`Routing tables\n\nInternet:\nDestination Gateway Flags Netif Expire\ndefault 192.0.2.1 UGScg en0\n127 127.0.0.1 UCS lo0\n10.253/16 link#18 UCS utun4\n192.0.2/24 link#14 UCS en0 !\n192.0.2.5 aa:b:cc:d:ee:f UHLWI en0 1182\n`);
  assert.deepEqual(inventory.routeCidrs, ["10.253.0.0/16", "127.0.0.0/8", "192.0.2.0/24", "192.0.2.5/32"]);
  assert.deepEqual(inventory.gatewayCidrs, ["127.0.0.1/32", "192.0.2.1/32"]);
  assert.throws(() => parseMacOsIpv4Routes("Destination Gateway Flags Netif\n10.0/16 unresolved-host UGSc en0"));
  assert.throws(() => parseMacOsIpv4Routes("Destination Gateway Flags Netif\n"));
  assert.throws(() => parseMacOsIpv4Routes("a future unsupported format"));
});

test("Linux all-table routes include VPN ranges, local hosts, and multipath gateways", () => {
  const inventory = parseLinuxIpv4Routes(JSON.stringify([
    { dst: "default", gateway: "192.0.2.1", dev: "eth0" },
    { dst: "10.253.0.0/16", dev: "tun0", table: 200 },
    { dst: "127.0.0.1", type: "local", table: "local" },
    { dst: "198.51.100.0/24", nexthops: [{ gateway: "192.0.2.2" }, { gateway: "192.0.2.3" }] },
  ]));
  assert.deepEqual(inventory.routeCidrs, ["10.253.0.0/16", "127.0.0.1/32", "198.51.100.0/24"]);
  assert.deepEqual(inventory.gatewayCidrs, ["192.0.2.1/32", "192.0.2.2/32", "192.0.2.3/32"]);
  for (const value of ["[]", "not-json", '[{"gateway":"192.0.2.1"}]', '[{"dst":"10/8"}]', '[{"dst":"10.0.0.0/8","via":{"family":"inet6","host":"::1"}}]', '[{"dst":"10.0.0.0/8","nexthops":[{"via":{"family":"inet6","host":"::1"}}]}]']) assert.throws(() => parseLinuxIpv4Routes(value));
});

test("Windows PowerShell arrays and singleton route objects are parsed without assuming real Windows proof", () => {
  const inventory = parseWindowsIpv4Routes(JSON.stringify([
    { DestinationPrefix: "0.0.0.0/0", NextHop: "192.0.2.1" },
    { DestinationPrefix: "10.253.0.0/16", NextHop: "0.0.0.0" },
    { DestinationPrefix: "127.0.0.0/8", NextHop: "0.0.0.0" },
  ]));
  assert.deepEqual(inventory.routeCidrs, ["10.253.0.0/16", "127.0.0.0/8"]);
  assert.deepEqual(inventory.gatewayCidrs, ["192.0.2.1/32"]);
  assert.deepEqual(parseWindowsIpv4Routes('\uFEFF{"DestinationPrefix":"10.253.0.0/16","NextHop":"0.0.0.0"}').routeCidrs, ["10.253.0.0/16"]);
  for (const value of ["null", "[]", "", '[{"DestinationPrefix":"10.0.0.0/8"}]', '[{"DestinationPrefix":"::/0","NextHop":"::"}]']) assert.throws(() => parseWindowsIpv4Routes(value));
});

function dockerMetadata(context: string, endpoint: string, calls: string[][] = []) {
  return async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "context" && args[1] === "show") return context;
    if (args[0] === "context" && args[1] === "inspect" && args[2] === context) return JSON.stringify([{ Name: context, Endpoints: { docker: { Host: endpoint } } }]);
    throw new Error("Only read-only context metadata calls are expected.");
  };
}

test("Docker context precedence honors DOCKER_CONTEXT above DOCKER_HOST, then stored context", async () => {
  assert.equal(await resolveLocalDockerEndpoint(dockerMetadata("desktop-linux", "unix:///tmp/docker.sock"), { DOCKER_CONTEXT: "desktop-linux", DOCKER_HOST: "ssh://remote.invalid" }, "darwin"), "unix");
  assert.equal(await resolveLocalDockerEndpoint(dockerMetadata("remote", "ssh://remote.invalid"), { DOCKER_HOST: "unix:///tmp/docker.sock" }, "linux"), "unix");
  assert.equal(await resolveLocalDockerEndpoint(dockerMetadata("default", "unix:///var/run/docker.sock"), {}, "linux"), "unix");
  await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("desktop-linux", "unix:///tmp/docker.sock"), { DOCKER_HOST: "tcp://127.0.0.1:2375" }, "darwin"), /remote Docker endpoints/);
  await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("remote", "ssh://remote.invalid"), { DOCKER_CONTEXT: "remote", DOCKER_HOST: "unix:///tmp/docker.sock" }, "linux"), /remote Docker endpoints/);
});

test("only local endpoint transports are admitted and no context mutation or daemon operation occurs", async () => {
  const calls: string[][] = [];
  assert.equal(await resolveLocalDockerEndpoint(dockerMetadata("desktop-linux", "npipe:////./pipe/dockerDesktopLinuxEngine", calls), {}, "win32"), "npipe");
  assert.deepEqual(calls, [["context", "show"], ["context", "inspect", "desktop-linux"]]);
  for (const endpoint of ["tcp://localhost:2375", "ssh://localhost", "npipe:////server/pipe/docker_engine", "unix://remote/tmp/docker.sock", "fd://3", "unix:///", "unix:///tmp/docker.sock?forward=remote"]) {
    await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("default", endpoint), {}, "linux"));
  }
  await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("default", "unix:///tmp/docker.sock"), {}, "win32"));
  await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("default", "npipe:////./pipe/docker_engine"), {}, "darwin"));
  await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("default", "unix:///tmp/docker.sock"), { DOCKER_CONTEXT: "other" }, "darwin"));
  await assert.rejects(resolveLocalDockerEndpoint(dockerMetadata("default", "unix:///tmp/docker.sock"), { DOCKER_HOST: " unix:///tmp/docker.sock" }, "darwin"));
});

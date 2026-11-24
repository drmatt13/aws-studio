import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { PRIVATE_DNS_PARITY_FIXTURE, fixtureAddress } from "./model";
import { compileNftPolicy, renderCoreDns, NON_PUBLIC_IPV4_CIDRS } from "./policy";
import { inspectLocalDockerHost, resolveLocalDockerEndpoint } from "./docker-host";
import {
  assessParityEvidence, createPhaseZeroDnsExpectations, evaluateCharacterizationRun,
  parityHash, type ParityEvidenceContract, type ProbeInput, type ProbeRunEvidence,
  type ProbeScenario, type ScenarioExpectation,
} from "./evidence";

const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, "../../../../..");
const CORE_DNS_IMAGE = "coredns/coredns:1.14.0@sha256:4fbdd8fb53c5d1748aeb98f0799798fb073bb11128c13e8415aa254ad1ae0203";
const LABEL = "com.matts-aws-framework";
const KIND = "private-dns-parity-spike";
const ASSET = "assets/fixture.mjs";

interface Resource { kind: "container" | "network" | "volume"; name: string }
interface DockerInspect { Id?: string; Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string>; IPAM?: { Config?: { Subnet?: string }[] } }
type Json = Record<string, any>; // Bounded JSON from the disposable fixture, never application configuration.
type DockerCommand = (args: readonly string[], timeout?: number) => Promise<string>;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function contains(cidr: string, address: string): boolean {
  const [base, bits] = cidr.split("/");
  if (isIP(base!) !== 4 || isIP(address) !== 4) return false;
  const number = (ip: string) => ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
  return Math.floor(number(base!) / 2 ** (32 - Number(bits))) === Math.floor(number(address) / 2 ** (32 - Number(bits)));
}

async function treeHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(folder: string): Promise<void> {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) { hash.update(path.relative(directory, file)); hash.update(await readFile(file)); }
      else throw new Error("The spike build context cannot contain symlinks or special files.");
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

/** Native argument arrays only: no shell commands, Docker socket mount, or Compose mutation. */
async function dockerCommand(args: readonly string[], timeout = 120_000, signal?: AbortSignal, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const result = await execute("docker", [...args], { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal, env: environment });
    return result.stdout.trim();
  } catch (error) {
    const result = error as { code?: string | number; stderr?: string; stdout?: string };
    // execFile's default message includes every argument, including private
    // registration nonces. Preserve diagnostics without echoing the command.
    throw new Error(`Docker ${args[0]} failed (${result.code ?? "unknown"}): ${(result.stderr || result.stdout || "No diagnostics available").trim().slice(-5000)}`);
  }
}
const labels = (project: string, target: string) => [
  "--label", `${LABEL}.kind=${KIND}`, "--label", `${LABEL}.project=${project}`,
  "--label", `${LABEL}.target=${target}`,
];

async function reconcileHelperImages(current: string, docker: DockerCommand = dockerCommand): Promise<void> {
  const currentId = JSON.parse(await docker(["image", "inspect", current]))[0].Id;
  const ids = [...new Set((await docker(["image", "ls", "--quiet", "--no-trunc", "--filter", `label=${LABEL}.kind=${KIND}`, "--filter", `label=${LABEL}.project=phz-parity-tooling`])).split(/\s+/).filter(Boolean))];
  for (const id of ids) {
    if (id === currentId) continue;
    const image = JSON.parse(await docker(["image", "inspect", id]))[0];
    const metadata = image.Config?.Labels;
    if (metadata?.[`${LABEL}.kind`] !== KIND || metadata[`${LABEL}.project`] !== "phz-parity-tooling" || metadata[`${LABEL}.target`] !== "namespace-helper") continue;
    if ((await docker(["ps", "--all", "--quiet", "--filter", `ancestor=${id}`])).trim()) continue;
    const tags = image.RepoTags as string[] | null;
    // Preserve retagged images; concurrent consumers remain protected by Docker.
    if (!tags?.length || tags.some(tag => !tag.startsWith("matts-framework-phz-spike:"))) continue;
    try { await docker(["image", "rm", ...tags]); } catch { /* Never force in-use removal. */ }
  }
}

async function inspect(resource: Resource, docker: DockerCommand = dockerCommand): Promise<DockerInspect | undefined> {
  try { return JSON.parse(await docker([resource.kind, "inspect", resource.name]))[0]; }
  catch (error) {
    if (/No such (?:container|network|volume|object)|not found/i.test(String((error as { stderr?: string }).stderr ?? error))) return undefined;
    throw error;
  }
}

async function cleanup(project: string, resources: readonly Resource[], docker: DockerCommand = dockerCommand): Promise<string[]> {
  const failures: string[] = [];
  for (const resource of [...resources].reverse()) {
    try {
      const state = await inspect(resource, docker);
      if (!state) continue;
      const metadata = state.Config?.Labels ?? state.Labels;
      if (metadata?.[`${LABEL}.project`] !== project || metadata[`${LABEL}.kind`] !== KIND) throw new Error("Ownership labels differ; removal refused.");
      if (resource.kind === "container") {
        await docker(["stop", "--time", "3", resource.name]);
        await docker(["container", "rm", resource.name]);
      } else await docker([resource.kind, "rm", resource.name]);
    } catch (error) { failures.push(`${resource.kind} ${resource.name}: ${String(error)}`); }
  }
  return failures;
}

async function availableSubnets(count: number, routeCidrs: readonly string[], docker: DockerCommand = dockerCommand): Promise<string[]> {
  const ids = (await docker(["network", "ls", "--format", "{{.ID}}"])).split(/\s+/).filter(Boolean);
  const existing = ids.length ? JSON.parse(await docker(["network", "inspect", ...ids])) as DockerInspect[] : [];
  const occupied = [...routeCidrs, ...existing.flatMap(value => value.IPAM?.Config?.flatMap(value => value.Subnet ? [value.Subnet] : []) ?? [])];
  const hosts = Object.values(networkInterfaces()).flatMap(values => values?.filter(value => value.family === "IPv4").map(value => value.address) ?? []);
  const selected: string[] = [];
  const start = randomBytes(1)[0]!;
  for (let n = 0; n < 768 && selected.length < count; n++) {
    const range = ["10.253", "172.30", "192.168"][Math.floor(n / 256)]!;
    const candidate = `${range}.${(start + n) % 256}.0/24`;
    const base = candidate.split("/")[0]!;
    if (occupied.some(other => contains(other, base) || contains(candidate, other.split("/")[0]!)) || hosts.some(host => contains(candidate, host))) continue;
    selected.push(candidate);
  }
  if (selected.length !== count) throw new Error("No non-overlapping fixture subnets are available; no existing network was changed.");
  return selected;
}

async function fixtureJson(container: string, args: readonly string[], user = "1000:1000", docker: DockerCommand = dockerCommand): Promise<Json> {
  return JSON.parse(await docker(["exec", "--user", user, container, "node", ASSET, ...args], 60_000));
}

async function fixtureWait(container: string, port: number, endpoint = "/health", user = "1000:1000", docker: DockerCommand = dockerCommand): Promise<Json> {
  const deadline = Date.now() + 25_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return await fixtureJson(container, ["control", "--port", String(port), "--path", endpoint], user, docker); }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw new Error(`Fixture ${container} did not become ready: ${String(last)}`);
}

export async function runLocalSpike(args: readonly string[]): Promise<Json> {
  const project = `phz-spike-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const directory = path.resolve(option(args, "--output") ?? path.join(ROOT, ".framework/artifacts/private-dns-parity", project));
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("The evidence output directory already exists; choose a new directory to preserve previous evidence and recovery journals.");
    throw error;
  }
  const resources: Resource[] = [];
  const operations: Json[] = [];
  const observations: ProbeRunEvidence[] = [];
  const expectations: ScenarioExpectation[] = [];
  const checks: Json[] = [];
  const endpoints: Record<string, string> = {};
  let failure: string | undefined;
  let cleanupFailures: string[] = [];
  let inspectedDockerEndpoint: string | undefined;
  const event = (message: string) => { operations.push({ at: new Date().toISOString(), message }); process.stdout.write(`${message}\n`); };
  const cancellation = new AbortController();
  const dockerEnvironment = { ...process.env };
  const pinnedDocker: DockerCommand = (args, timeout) => dockerCommand(args, timeout, undefined, dockerEnvironment);
  const jsonCommand = (container: string, args: readonly string[], user?: string) => fixtureJson(container, args, user, pinnedDocker);
  const waitControl = (container: string, port: number, endpoint?: string, user?: string) => fixtureWait(container, port, endpoint, user, pinnedDocker);
  const onSignal = () => { if (!cancellation.signal.aborted) { event("Cancellation requested; stopping admission and cleaning only this fixture."); cancellation.abort(); } };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const docker = (args: readonly string[], timeout?: number) => {
    cancellation.signal.throwIfAborted();
    // Let short create calls settle so the ownership journal can reconcile
    // their outcome. Long image operations create no application resources.
    return dockerCommand(args, timeout, ["build", "pull"].includes(args[0]!) ? cancellation.signal : undefined, dockerEnvironment);
  };
  const reserve = async (resource: Resource) => {
    cancellation.signal.throwIfAborted();
    resources.push(resource);
    const pending = path.join(directory, "resources.pending.json");
    await writeFile(pending, JSON.stringify({ schemaVersion: 1, project, startedAt, dockerEndpoint: inspectedDockerEndpoint, resources }, null, 2) + "\n", { mode: 0o600 });
    await rename(pending, path.join(directory, "resources.json"));
  };
  const record = (condition: boolean, name: string, detail?: unknown) => {
    checks.push({ name, passed: condition, ...(detail === undefined ? {} : { detail }) });
    if (!condition) throw new Error(`Local characterization failed: ${name}`);
  };
  const probeHash = createHash("sha256").update(await readFile(path.join(__dirname, "probe.mjs"))).digest("hex");
  const implementationHash = parityHash({ assets: await treeHash(path.join(__dirname, "assets")), source: await Promise.all(["model.ts", "policy.ts", "docker-host.ts", "evidence.ts", "cli.ts"].map(async name => ({ name, hash: createHash("sha256").update(await readFile(path.join(__dirname, name))).digest("hex") }))), coreDnsImage: CORE_DNS_IMAGE });
  const context = { contractHash: parityHash({ version: 1, scope: "phase-0-characterization", fixture: PRIVATE_DNS_PARITY_FIXTURE, implementationHash }), fixtureHash: parityHash(PRIVATE_DNS_PARITY_FIXTURE), probeHash };
  const revision = context.contractHash;
  let contract: ParityEvidenceContract | undefined;
  let local: ProbeRunEvidence | undefined;
  let qualification: unknown;
  try {
    const host = await inspectLocalDockerHost(docker);
    inspectedDockerEndpoint = host.dockerEndpoint;
    dockerEnvironment.DOCKER_HOST = host.dockerEndpoint;
    delete dockerEnvironment.DOCKER_CONTEXT;
    record(true, "Docker uses a local endpoint and host routes were inventoried before mutations", { platform: host.platform, observedRoutes: host.routeCidrs.length });
    const version = JSON.parse(await docker(["version", "--format", "{{json .Server}}"]));
    record(version?.Os === "linux", "Docker is running Linux containers", { version: version.Version, arch: version.Arch });
    const imageHash = parityHash({ assets: await treeHash(path.join(__dirname, "assets")), probeHash });
    const image = `matts-framework-phz-spike:${imageHash.slice(0, 16)}`;
    if (args.includes("--build")) {
      event("Building the isolated namespace helper; application images and containers are untouched.");
      await docker(["build", "--file", path.join(__dirname, "assets/Dockerfile"), "--tag", image, ...labels("phz-parity-tooling", "namespace-helper"), __dirname], 600_000);
      await docker(["pull", CORE_DNS_IMAGE], 180_000);
    }
    await docker(["image", "inspect", image]);
    await docker(["image", "inspect", CORE_DNS_IMAGE]);
    await reconcileHelperImages(image, pinnedDocker);
    const subnets = await availableSubnets(4, host.routeCidrs, pinnedDocker);
    const networks: Record<string, { name: string; subnet: string }> = {};
    for (const [index, view] of ["a", "b", "outside", "control"].entries()) {
      const name = `${project}-${view}`;
      await reserve({ kind: "network", name });
      await docker(["network", "create", "--driver", "bridge", "--subnet", subnets[index]!, ...labels(project, `network-${view}`), name]);
      networks[view] = { name, subnet: subnets[index]! };
    }
    const volume = `${project}-management`;
    await reserve({ kind: "volume", name: volume });
    await docker(["volume", "create", ...labels(project, "management"), volume]);
    const address = (view: string, role: Parameters<typeof fixtureAddress>[1]) => fixtureAddress(networks[view]!.subnet, role);
    const hostAddresses = Object.values(networkInterfaces()).flatMap(values => values?.filter(value => value.family === "IPv4").map(value => `${value.address}/32`) ?? []);
    const blocked = [...subnets, ...hostAddresses, ...host.hostBlockedCidrs];
    const envs = [
      { id: "a-caller", view: "a", ip: address("a", "caller"), egress: true },
      { id: "a-denied", view: "a", ip: address("a", "deniedCaller"), egress: false },
      { id: "a-isolated", view: "a", ip: address("a", "isolatedCaller"), egress: false },
      { id: "b-caller", view: "b", ip: address("b", "caller"), egress: false },
      { id: "outside-caller", view: "outside", ip: address("outside", "caller"), egress: false },
    ].map(value => ({ ...value, nonce: randomBytes(32).toString("hex"), targetId: `lambda:${value.id}`, environmentId: value.id, project, revision }));
    const run = async (target: string, extra: readonly string[], role: string): Promise<string> => {
      const name = `matts-lambda-${project}-${target}`;
      await reserve({ kind: "container", name });
      await docker(["run", "--detach", "--name", name, ...labels(project, target), "--security-opt", "no-new-privileges", "--cap-drop", "ALL", ...extra, image, role]);
      return name;
    };
    const manager = await run("manager", ["--user", "0:0", "--network", networks.control!.name,
      "--mount", `type=volume,source=${volume},target=/management`,
      "--env", "MANAGEMENT_SOCKET=/management/runtime.sock", "--env", "PORT=7070",
      "--env", `EXPECTED_IDENTITIES_JSON=${JSON.stringify(envs.map(({ project, targetId, environmentId, revision, nonce }) => ({ project, targetId, environmentId, revision, nonce })))}`], "manager");
    await waitControl(manager, 7070, "/health", "0:0");

    event("Starting per-VPC real DNS views and per-service endpoint identities.");
    for (const view of ["a", "b", "outside"] as const) {
      const folder = path.join(directory, `dns-${view}`);
      await mkdir(folder, { recursive: true, mode: 0o755 });
      const dns = renderCoreDns({ view, addresses: { albA: address("a", "alb"), albB: address("b", "alb") }, upstream: "127.0.0.11" });
      await writeFile(path.join(folder, "Corefile"), dns.corefile, { mode: 0o644 });
      for (const [name, text] of Object.entries(dns.zoneFiles)) await writeFile(path.join(folder, name), text, { mode: 0o644 });
      const name = `${project}-dns-${view}`;
      await reserve({ kind: "container", name });
      await docker(["run", "--detach", "--name", name, ...labels(project, `dns-${view}`), "--network", networks[view]!.name, "--ip", address(view, "resolver"), "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE", "--security-opt", "no-new-privileges", "--mount", `type=bind,source=${folder},target=/zones,readonly`, CORE_DNS_IMAGE, "-conf", "/zones/Corefile"]);
    }

    const anchors: Record<string, string> = {};
    const applications: Record<string, string> = {};
    async function initialize(anchor: string, policy: string): Promise<Json> {
      const name = `matts-lambda-${project}-init-${resources.length}`;
      await reserve({ kind: "container", name });
      const text = await docker(["run", "--name", name, "--network", `container:${anchor}`, ...labels(project, "initializer"), "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges", "--user", "0:0", "--env", `NFT_RULESET_B64=${Buffer.from(policy).toString("base64")}`, "--env", `POLICY_REVISION=${revision}`, image, "init"]);
      return JSON.parse(text);
    }
    const policyFor = (view: string, role: "caller" | "backend" | "alb", own: string, egress: boolean) => compileNftPolicy({ role, address: own, subnetCidr: networks[view]!.subnet, resolver: address(view, "resolver"), alb: address(view, "alb"), backend: address(view, "backend"), callerAddresses: envs.filter(value => value.view === view).map(value => value.ip), allowedCallerAddresses: envs.filter(value => value.view === view && value.id !== "a-denied").map(value => value.ip), blockedCidrs: blocked, ipv4Egress: egress });
    for (const view of ["a", "b"] as const) {
      for (const role of ["backend", "alb"] as const) {
        const target = `${view}-${role}`;
        const own = address(view, role);
        const anchor = await run(`${target}-anchor`, ["--network", networks[view]!.name, "--ip", own], "anchor");
        await initialize(anchor, policyFor(view, role, own, false));
        anchors[target] = anchor;
        applications[target] = await run(target, ["--network", `container:${anchor}`, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--env", `ENDPOINT_ID=alb-${view}`, ...(role === "alb" ? ["--env", `BACKEND_URL=http://${address(view, "backend")}:5000`, "--env", "UPSTREAM_TIMEOUT_MS=10000"] : [])], role === "alb" ? "gateway" : "backend");
      }
      endpoints[address(view, "alb")] = `alb-${view}`;
      endpoints[address(view, "backend")] = `backend-${view}`;
    }

    event("Installing default-deny policy before starting isolated ZIP-worker supervisors.");
    for (const env of envs) {
      const folder = path.join(directory, `worker-${env.id}`);
      await mkdir(folder, { recursive: true, mode: 0o755 });
      const resolverFile = path.join(folder, "resolv.conf");
      await writeFile(resolverFile, `nameserver ${address(env.view, "resolver")}\noptions timeout:1 attempts:1\n`, { mode: 0o644 });
      const identityEnv = ["--env", `FIXTURE_PROJECT=${project}`, "--env", `TARGET_ID=${env.targetId}`, "--env", `ENVIRONMENT_ID=${env.id}`, "--env", `POLICY_REVISION=${revision}`];
      const anchor = await run(`${env.id}-anchor`, ["--user", "1001:1001", "--network", networks[env.view]!.name, "--ip", env.ip,
        "--mount", `type=volume,source=${volume},target=/management`, "--env", "MANAGEMENT_SOCKET=/management/runtime.sock", "--env", `REGISTRATION_NONCE=${env.nonce}`, ...identityEnv], "broker");
      anchors[env.id] = anchor;
      const receipt = await initialize(anchor, policyFor(env.view, "caller", env.ip, env.egress));
      applications[env.id] = await run(env.id, ["--network", `container:${anchor}`, "--user", "1000:1000", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
        "--mount", `type=bind,source=${resolverFile},target=/etc/resolv.conf,readonly`, ...identityEnv, "--env", `POLICY_RECEIPT_JSON=${JSON.stringify(receipt)}`], "supervisor");
      const identity = await waitControl(applications[env.id]!, 8080, "/identity");
      record(identity.networkNamespace === receipt.networkNamespace || identity.process?.networkNamespace === receipt.networkNamespace, `${env.id}: initializer and application share the verified namespace`, identity);
      record(identity.process?.uid === 1000 && identity.process?.credentials?.CapEff === "0000000000000000" && identity.process?.credentials?.CapPrm === "0000000000000000" && identity.process?.credentials?.NoNewPrivs === "1", `${env.id}: application actually runs unprivileged`, identity.process);
      const state = JSON.parse(await docker(["container", "inspect", applications[env.id]!]))[0];
      record(state.HostConfig.CapDrop?.includes("ALL") && state.Config.User === "1000:1000" && state.HostConfig.NetworkMode === `container:${(await inspect({ kind: "container", name: anchor }, pinnedDocker))!.Id}`, `${env.id}: launch drops capabilities and uses only the selected namespace`);
      record(!state.HostConfig.Privileged && !state.Mounts.some((mount: { Destination: string }) => mount.Destination === "/management" || mount.Destination.endsWith("docker.sock")) && !state.Config.Env.some((value: string) => /^(REGISTRATION_NONCE|EXPECTED_IDENTITIES_JSON)=/.test(value)), `${env.id}: application has no management socket or launch credentials`);
      const runtime = await jsonCommand(applications[env.id]!, ["control", "--port", "8099", "--path", "/runtime", "--input", JSON.stringify({ operation: "identity" })]);
      record(runtime.identity?.environmentId === env.id && runtime.identity?.targetId === env.targetId && runtime.identity?.project === project, `${env.id}: application runtime identity is bound by the UDS channel`);
      let rejected = false;
      try { await jsonCommand(applications[env.id]!, ["control", "--port", "8099", "--path", "/runtime", "--input", JSON.stringify({ operation: "identity", caller: "lambda:another-caller" })]); }
      catch (error) { rejected = /own-identity|overrides are forbidden/.test(String(error)); }
      record(rejected, `${env.id}: broker rejects application-supplied caller identity`);
    }

    const invoke = async (id: string, scenarios: readonly ProbeScenario[], expected: readonly ScenarioExpectation[]): Promise<Json> => {
      cancellation.signal.throwIfAborted();
      const input: ProbeInput = { schemaVersion: 1, runId: project, environment: "local", runtime: "docker", context, scenarios };
      const wrapper = await jsonCommand(manager, ["control", "--port", "7070", "--path", `/invoke?environmentId=${id}`, "--input", JSON.stringify(input)], "0:0");
      const result = wrapper.result ?? wrapper.value?.result ?? wrapper.value ?? wrapper;
      if (!result || result.schemaVersion !== 1 || !Array.isArray(result.scenarios)) throw new Error(`Unexpected probe result for ${id}.`);
      observations.push(result as ProbeRunEvidence);
      expectations.push(...expected);
      return wrapper;
    };
    const tcp = (id: string, host: string, port: number): ProbeScenario => ({ id, kind: "tcp", host, port, timeoutMs: 900, fresh: true });
    const expectedTcp = (scenario: ProbeScenario, outcome: "connected" | "timeout"): ScenarioExpectation => ({ id: scenario.id, kind: "tcp", request: { ...(endpoints[scenario.host] ? {} : { host: scenario.host }), port: scenario.port }, ...(endpoints[scenario.host] ? { requestEndpointId: endpoints[scenario.host] } : {}), tcp: { outcome } });
    const names = PRIVATE_DNS_PARITY_FIXTURE.names;
    for (const view of ["a", "b"] as const) {
      const expectedDns = (["udp", "tcp"] as const).flatMap(transport => createPhaseZeroDnsExpectations(view, transport));
      const dnsScenarios: ProbeScenario[] = expectedDns.map(expected => ({ id: expected.id, kind: "dns", ...expected.request, host: expected.request.host!, transport: expected.request.transport, dnsType: expected.request.dnsType, resolver: { host: address(view, "resolver") }, timeoutMs: 2000 }));
      const http: ProbeScenario = { id: `${view}-http`, kind: "http", host: names.api, port: 80, path: "/health?parity=1", fresh: true, timeoutMs: 4000 };
      const backend = tcp(`${view}-backend-denied`, address(view, "backend"), 5000);
      const wrongPort = tcp(`${view}-wrong-port`, address(view, "alb"), 5000);
      const first = await invoke(`${view}-caller`, [...dnsScenarios, http, backend, wrongPort], [...expectedDns,
        { id: http.id, kind: "http", request: { host: http.host, port: 80, path: http.path }, http: { statusCode: 200, endpointId: `alb-${view}`, json: { path: http.path } } }, expectedTcp(backend, "timeout"), expectedTcp(wrongPort, "timeout")]);
      const warm: ProbeScenario = { ...http, id: `${view}-warm-http` };
      const second = await invoke(`${view}-caller`, [warm], [{ id: warm.id, kind: "http", request: { host: warm.host, port: 80, path: warm.path }, http: { statusCode: 200, endpointId: `alb-${view}` } }]);
      record(first.worker?.id === second.worker?.id && first.worker?.id !== undefined, `${view}: warm invocation reuses the isolated worker`);
      const fetched = await jsonCommand(applications[`${view}-caller`]!, ["control", "--port", "8080", "--path", "/invoke-native-fetch", "--input", JSON.stringify({ url: `http://${names.api}/health?client=fetch`, timeoutMs: 4000 })]);
      record(fetched.worker?.id === first.worker.id && fetched.result?.status === "observed" && fetched.result?.http?.statusCode === 200 && fetched.result?.http?.endpointId === `alb-${view}`, `${view}: unmodified fetch runs inside the same warm child and DNS namespace`, fetched);
      const curl = JSON.parse(await docker(["exec", "--user", "1000:1000", applications[`${view}-caller`]!, "curl", "--silent", "--show-error", "--fail", "--max-time", "4", `http://${names.api}/health?client=curl`]));
      record(curl.endpointId === `alb-${view}`, `${view}: ordinary curl subprocess uses the VPC-scoped OS resolver`);
    }
    const denied = tcp("same-vpc-no-grant", address("a", "alb"), 80);
    await invoke("a-denied", [{ id: "denied-dns", kind: "dns", host: names.api, dnsType: "A", transport: "udp", resolver: { host: address("a", "resolver") } }, denied], [
      { id: "denied-dns", kind: "dns", request: { host: names.api, dnsType: "A", transport: "udp" }, dns: { rcode: "NOERROR", answerTypes: ["A"], endpointId: "alb-a", ttl: { min: 0, max: 60 } } }, expectedTcp(denied, "timeout")]);
    const cross = tcp("cross-vpc-no-route", address("a", "alb"), 80);
    const shared = tcp("shared-zone-does-not-grant-routing", names.sharedApi, 80);
    await invoke("b-caller", [cross, shared], [expectedTcp(cross, "timeout"), expectedTcp(shared, "timeout")]);
    const outside = tcp("outside-no-route", address("a", "alb"), 80);
    await invoke("outside-caller", [{ id: "outside-public-negative", kind: "dns", host: names.api, dnsType: "A", transport: "udp", resolver: { host: address("outside", "resolver") }, timeoutMs: 4000 }, outside], [
      { id: "outside-public-negative", kind: "dns", request: { host: names.api, dnsType: "A", transport: "udp" }, dns: { rcode: "NXDOMAIN", answerTypes: [] } }, expectedTcp(outside, "timeout")]);
    const hostGateway = networks.a!.subnet.replace(/\.0\/24$/, ".1");
    const bypass = tcp("host-gateway-denied", hostGateway, 8090);
    await invoke("a-caller", [bypass], [expectedTcp(bypass, "timeout")]);

    event("Characterizing backend failure independently from DNS.");
    await docker(["stop", "--time", "3", applications["a-backend"]!]);
    const dnsFailure: ProbeScenario = { id: "backend-down-dns", kind: "dns", host: names.api, dnsType: "A", transport: "tcp", resolver: { host: address("a", "resolver") } };
    const httpFailure: ProbeScenario = { id: "backend-down-http", kind: "http", host: names.api, port: 80, path: "/health", timeoutMs: 4000, fresh: true };
    await invoke("a-caller", [dnsFailure, httpFailure], [
      { id: dnsFailure.id, kind: "dns", request: { host: names.api, dnsType: "A", transport: "tcp" }, dns: { rcode: "NOERROR", answerTypes: ["A"], endpointId: "alb-a", ttl: { min: 0, max: 60 } } },
      { id: httpFailure.id, kind: "http", request: { host: names.api, port: 80, path: "/health" }, http: { statusCode: 502, endpointId: "alb-a" } },
    ]);
    await docker(["start", applications["a-backend"]!]);

    const external = option(args, "--external-ipv4");
    if (external) {
      if (isIP(external) !== 4 || NON_PUBLIC_IPV4_CIDRS.some(cidr => contains(cidr, external)) || blocked.some(cidr => contains(cidr, external))) throw new Error("--external-ipv4 must identify an explicitly selected public IPv4 test endpoint.");
      const port = Number(option(args, "--external-port") ?? "443");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid external test port.");
      for (const [id, allowed] of [["a-caller", true], ["a-isolated", false], ["b-caller", false]] as const) {
        const scenario = tcp(`${id}-external-ipv4`, external, port);
        await invoke(id, [scenario], [expectedTcp(scenario, allowed ? "connected" : "timeout")]);
      }
    }
    const registrations = await jsonCommand(manager, ["control", "--port", "7070", "--path", "/registrations"], "0:0");
    record(Array.isArray(registrations.registered) && registrations.registered.length === envs.length && envs.every(env => registrations.registered.some((entry: Json) => entry.identity?.environmentId === env.id && entry.identity?.targetId === env.targetId && entry.identity?.project === project && entry.identity?.revision === revision)), "caller-bound UDS broker registrations match the complete expected inventory", registrations);
    local = { schemaVersion: 1, runId: project, environment: "local", context, runtime: observations[0]!.runtime, startedAt, completedAt: new Date().toISOString(), scenarios: observations.flatMap(run => run.scenarios) };
    contract = { schemaVersion: 1, scope: "phase-0-characterization", context, scenarios: expectations };
    const characterization = evaluateCharacterizationRun(contract, local, endpoints);
    record(characterization.status === "observations-match", "local observations match independently specified expectations", characterization);
    qualification = assessParityEvidence(contract, local, undefined, { local: endpoints, aws: {} });
    event("Local characterization completed. AWS equivalence remains NO-GO without real AWS evidence.");
  } catch (error) {
    failure = String(error);
    event(`Fixture stopped: ${failure}`);
    for (const resource of resources.filter(resource => resource.kind === "container")) {
      try { await writeFile(path.join(directory, `${resource.name}.log`), await docker(["logs", "--tail", "35", resource.name]), { mode: 0o600 }); } catch { /* Original failure remains authoritative. */ }
    }
  } finally {
    if (cancellation.signal.aborted && !failure) failure = "The fixture was cancelled; observations are not complete qualification evidence.";
    cleanupFailures = await cleanup(project, resources, pinnedDocker);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    const report = { schemaVersion: 1, phase: 0, project, startedAt, completedAt: new Date().toISOString(), status: failure || cleanupFailures.length ? "failed" : "local-characterized", releaseAuthorized: false, qualification: qualification ?? { status: "no-go", reasons: ["Local characterization incomplete; real AWS evidence missing."] }, checks, operations, failure, cleanupFailures, resources, endpointMap: endpoints, context, implementationHash,
      remainingGates: ["Actual AWS differential execution", "Windows Docker Desktop isolation", "Full supported-surface scenarios beyond this spike", ...(option(args, "--external-ipv4") ? [] : ["Controlled public IPv4 egress fixture not selected"])],
    };
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    if (local) await writeFile(path.join(directory, "local-evidence.json"), JSON.stringify(local, null, 2) + "\n", { mode: 0o600 });
    if (contract) await writeFile(path.join(directory, "contract.json"), JSON.stringify(contract, null, 2) + "\n", { mode: 0o600 });
    if (local && contract) {
      // Host-gateway isolation is local safety evidence, not an AWS resource
      // identity. Keep it out of the future cross-environment comparison set.
      const scenarios = contract.scenarios.filter(value => value.id !== "host-gateway-denied");
      const ids = new Set(scenarios.map(value => value.id));
      await writeFile(path.join(directory, "comparison-contract.json"), JSON.stringify({ ...contract, scenarios }, null, 2) + "\n", { mode: 0o600 });
      await writeFile(path.join(directory, "comparison-local-evidence.json"), JSON.stringify({ ...local, scenarios: local.scenarios.filter(value => ids.has(value.id)) }, null, 2) + "\n", { mode: 0o600 });
    }
    process.stdout.write(`Evidence: ${path.join(directory, "report.json")}\n`);
  }
  if (failure || cleanupFailures.length) throw new Error(failure ?? `Fixture cleanup incomplete: ${cleanupFailures.join("; ")}`);
  return { project, directory, status: "local-characterized", releaseAuthorized: false };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "local") { await runLocalSpike(args.slice(1)); return; }
  if (args[0] === "compare") {
    const load = async (name: string) => { const file = option(args, name); if (!file) throw new Error(`${name} is required.`); return JSON.parse(await readFile(file, "utf8")); };
    const result = assessParityEvidence(await load("--contract"), await load("--local"), await load("--aws"), await load("--endpoint-maps"));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== "evidence-matches") process.exitCode = 1;
    return;
  }
  if (args[0] === "cleanup") {
    const file = option(args, "--manifest");
    if (!file) throw new Error("cleanup requires --manifest <resources.json>.");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (manifest.schemaVersion !== 1 || !/^phz-spike-[a-z0-9]+-[a-f0-9]{8}$/.test(manifest.project) || !Array.isArray(manifest.resources) || manifest.resources.some((resource: Resource) => !["container", "network", "volume"].includes(resource.kind) || typeof resource.name !== "string" || !resource.name.includes(manifest.project) || resource.name.startsWith("-"))) throw new Error("Invalid task-owned resource manifest.");
    if (typeof manifest.dockerEndpoint !== "string") throw new Error("The fixture journal lacks its pinned Docker endpoint; automatic cleanup is refused.");
    const environment: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: manifest.dockerEndpoint };
    delete environment.DOCKER_CONTEXT;
    const command: DockerCommand = (args, timeout) => dockerCommand(args, timeout, undefined, environment);
    await resolveLocalDockerEndpoint(command, environment);
    const failures = await cleanup(manifest.project, manifest.resources, command);
    process.stdout.write(JSON.stringify({ cleanupFailures: failures }, null, 2) + "\n");
    if (failures.length) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: private-dns:spike local [--build] [--output directory] [--external-ipv4 address --external-port port] | compare --contract file --local file --aws file --endpoint-maps file | cleanup --manifest resources.json. No AWS deployment is performed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) main().catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });

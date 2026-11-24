import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseParityPlanArguments, preparePrivateDnsParityPlan, verifyPrivateDnsParityPlan, type PlanPreparationDependencies } from "./support/private-dns-parity-plan";

/** These STS/config responses are test doubles; no test calls an AWS account. */
const account = "222233334444";
const region = "us-east-1";
const identity = { Account: account, Arn: `arn:aws:sts::${account}:assumed-role/OfflineTest/fixture` };

function mockedAws(calls: { args: readonly string[]; environment: NodeJS.ProcessEnv }[]): NonNullable<PlanPreparationDependencies["runAws"]> {
  return async (args, environment) => {
    calls.push({ args, environment });
    if (args[0] === "configure" && args[1] === "get" && args[2] === "region") return `${region}\n`;
    assert.deepEqual(args.slice(0, 2), ["sts", "get-caller-identity"], "the preparation path has no AWS write commands");
    return JSON.stringify(identity);
  };
}

test("AWS preparation verifies a pinned regional STS target and writes an account-bound private-only offline artifact", async () => {
  const repositoryRoot = mkdtempSync(path.join(tmpdir(), "parity-aws-plan-"));
  const calls: { args: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
  const previous = process.env.AWS_ENDPOINT_URL_STS;
  process.env.AWS_ENDPOINT_URL_STS = "http://untrusted-endpoint.invalid";
  try {
    const prepared = await preparePrivateDnsParityPlan({ profile: "dev" }, { repositoryRoot, runAws: mockedAws(calls) });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.args, ["configure", "get", "region", "--profile", "dev"]);
    assert.equal(calls[1]!.args[calls[1]!.args.indexOf("--endpoint-url") + 1], "https://sts.us-east-1.amazonaws.com");
    assert.ok(calls.every(call => call.environment.AWS_ENDPOINT_URL_STS === undefined && call.environment.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS === "true"));
    assert.equal(prepared.plan.target.account, account);
    assert.equal(prepared.plan.target.region, region);
    assert.match(prepared.plan.target.stackName, /^phz-parity-dev-/);
    assert.equal(prepared.plan.target.liveStackId, null);
    assert.equal(prepared.plan.deploymentReady, false);
    assert.equal(prepared.plan.releaseAuthorized, false);
    assert.equal(prepared.plan.cloudMutationsPerformed, false);
    assert.equal(prepared.plan.publicDomainOwnershipRequired, false);
    assert.equal(prepared.plan.resourceCounts["AWS::Lambda::Function"], 5);
    assert.equal(prepared.plan.resourceCounts["AWS::EC2::NatGateway"], undefined);
    assert.equal(prepared.plan.resourceCounts["AWS::Route53::HostedZone"], 5);
    assert.ok(prepared.plan.missingGates.some(gate => /Cost review/.test(gate)));
    assert.ok(prepared.plan.missingGates.some(gate => /permissions/.test(gate)));
    assert.equal(prepared.plan.teardownRequirements.requireReviewedLiveStackId, true);
    assert.ok(prepared.directory.startsWith(path.join(realpathSync(repositoryRoot), ".framework", "artifacts", "private-dns-parity")));
    assert.deepEqual(verifyPrivateDnsParityPlan(prepared.directory), { valid: true, sha256: prepared.artifactSha256 });
    const manifest = JSON.parse(readFileSync(path.join(prepared.directory, "assembly", "manifest.json"), "utf8"));
    const artifact = Object.values<any>(manifest.artifacts).find(value => value.type === "aws:cloudformation:stack")!;
    const template = JSON.parse(readFileSync(path.join(prepared.directory, "assembly", artifact.properties.templateFile), "utf8"));
    const zones = Object.values<any>(template.Resources).filter(resource => resource.Type === "AWS::Route53::HostedZone");
    assert.ok(zones.every(zone => zone.Properties.VPCs.length >= 1), "private-only preparation creates no public hosted zone");
    writeFileSync(path.join(prepared.directory, "unexpected-file.txt"), "changed");
    assert.equal(verifyPrivateDnsParityPlan(prepared.directory).valid, false, "extra files invalidate the exact reviewed artifact set");
  } finally {
    if (previous === undefined) delete process.env.AWS_ENDPOINT_URL_STS; else process.env.AWS_ENDPOINT_URL_STS = previous;
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("preparation refuses inconsistent STS identity, unsafe stack targets and output symlink traversal", async () => {
  for (const scenario of ["identity", "stack", "symlink"] as const) {
    const repositoryRoot = mkdtempSync(path.join(tmpdir(), "parity-aws-plan-invalid-"));
    const outside = mkdtempSync(path.join(tmpdir(), "parity-aws-plan-outside-"));
    try {
      if (scenario === "symlink") symlinkSync(outside, path.join(repositoryRoot, ".framework"), "dir");
      const calls: { args: readonly string[]; environment: NodeJS.ProcessEnv }[] = [];
      const runAws = mockedAws(calls);
      await assert.rejects(preparePrivateDnsParityPlan({ profile: "dev", ...(scenario === "stack" ? { stackName: "ExistingApplicationStack" } : {}) }, {
        repositoryRoot,
        runAws: scenario === "identity" ? async args => args[0] === "configure" ? region : JSON.stringify({ ...identity, Arn: "arn:aws:sts::111122223333:assumed-role/Other/fixture" }) : runAws,
      }), scenario === "identity" ? /inconsistent/ : scenario === "stack" ? /Disposable stack names/ : /symlinks/);
      assert.deepEqual(readdirSync(outside), [], "a symlink destination is never written");
    } finally { rmSync(repositoryRoot, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  }
});

test("source interference aborts before writing a plan and leaves only an invalid owned artifact after synth", async () => {
  for (const changedAt of [2, 3]) {
    const repositoryRoot = mkdtempSync(path.join(tmpdir(), "parity-aws-plan-source-"));
    let reads = 0;
    try {
      await assert.rejects(preparePrivateDnsParityPlan({ profile: "dev" }, {
        repositoryRoot, runAws: mockedAws([]),
        captureSources: () => ({ sha256: (++reads >= changedAt ? "b" : "a").repeat(64), files: [] }),
      }), /inputs changed/);
      const parent = path.join(repositoryRoot, ".framework", "artifacts", "private-dns-parity");
      if (changedAt === 2) assert.equal(existsSync(parent), false);
      else {
        const directory = path.join(parent, readdirSync(parent)[0]!);
        assert.equal(existsSync(path.join(directory, "plan.json")), false);
        assert.equal(JSON.parse(readFileSync(path.join(directory, "preparation-failed.json"), "utf8")).deploymentReady, false);
        assert.equal(verifyPrivateDnsParityPlan(directory).valid, false);
      }
    } finally { rmSync(repositoryRoot, { recursive: true, force: true }); }
  }
});

test("preparation arguments require an explicit profile and expose no deploy or output-overwrite option", () => {
  assert.deepEqual(parseParityPlanArguments(["--profile", "dev", "--region", region]), { profile: "dev", region });
  for (const args of [[], ["--deploy"], ["--profile", "dev", "--output", "/tmp/reuse"], ["--profile", "dev", "--profile", "other"], ["--profile", "dev", "--probe-architecture", "unknown"]]) assert.throws(() => parseParityPlanArguments(args));
});

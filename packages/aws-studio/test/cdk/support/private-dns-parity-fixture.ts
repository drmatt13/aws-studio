import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { createPrivateDnsParityFixture, type FixtureVpc } from "../../support/private-dns-parity/model";

export const PARITY_FIXTURE_ACCOUNT = "111122223333";
export const PARITY_FIXTURE_REGION = "us-east-1";
export const PARITY_FIXTURE_OWNER = "private-dns-parity-phase-0";

export interface AwsParityFixtureOptions {
  /** Task-owned temporary directory. This function never writes the checkout. */
  readonly directory: string;
  readonly mode: "dev" | "prod";
  readonly zoneName?: string;
  readonly probeArchitecture?: "arm64" | "x86_64";
  /** The preparation CLI resolves this with read-only regional STS. Omitted
   * targets keep offline tests pinned to the fake account above. */
  readonly target?: { readonly account: string; readonly region: string; readonly stackName?: string };
}

/**
 * Offline synthesis specimen, defaulting to a fake account. It is not
 * imported by the application or supplied to any deployment command. A future
 * real-AWS runner needs separately reviewed target, ownership and cleanup gates.
 */
export function createPrivateDnsParityAwsFixture(options: AwsParityFixtureOptions) {
  if (!["dev", "prod"].includes(options.mode) || !path.isAbsolute(options.directory)) throw new Error("Fixture needs an explicit mode and absolute temporary directory.");
  const probeArchitecture = options.probeArchitecture ?? (process.arch === "arm64" ? "arm64" : "x86_64");
  if (!["arm64", "x86_64"].includes(probeArchitecture)) throw new Error("Unsupported fixture probe architecture.");
  const account = options.target?.account ?? PARITY_FIXTURE_ACCOUNT;
  const region = options.target?.region ?? PARITY_FIXTURE_REGION;
  const stackName = options.target?.stackName ?? `PrivateDnsParity-${options.mode}`;
  if (!/^\d{12}$/.test(account) || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region) || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) throw new Error("Invalid explicit fixture account, region, or stack name.");
  const fixture = createPrivateDnsParityFixture(options.zoneName);
  const probePath = path.resolve(__dirname, "../../support/private-dns-parity/probe.mjs");
  const probeBytes = readFileSync(probePath);
  const probeHash = createHash("sha256").update(probeBytes).digest("hex");
  const assetDirectory = path.join(options.directory, "probe-code");
  mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(path.join(assetDirectory, "probe.mjs"), probeBytes);
  writeFileSync(path.join(assetDirectory, "index.mjs"), 'export { handler } from "./probe.mjs";\n');

  const app = new cdk.App({
    outdir: path.join(options.directory, "assembly"),
    context: {
      [`availability-zones:account=${account}:region=${region}`]: [`${region}a`, `${region}b`],
      "@aws-cdk/aws-ecs-patterns:secGroupsDisablesImplicitOpenListener": true,
    },
  });
  const stack = new cdk.Stack(app, `PrivateDnsParity-${options.mode}`, { stackName, env: { account, region } });
  cdk.Tags.of(stack).add("framework:owner", PARITY_FIXTURE_OWNER);
  cdk.Tags.of(stack).add("framework:parity-phase", "0");
  stack.templateOptions.metadata = { privateDnsParity: { owner: PARITY_FIXTURE_OWNER, mode: options.mode, probeArchitecture, deploymentReady: false, realAwsEvidence: false, probeHash, pending: ["authorized-real-account-target", "controlled-public-fallback", "deployed-probes", "verified-cleanup"] } };
  const networks = {} as Record<FixtureVpc, ec2.Vpc>;
  const loadBalancers = {} as Record<FixtureVpc, elbv2.ApplicationLoadBalancer>;
  const functions = {} as Record<FixtureVpc, { readonly granted: lambda.Function; readonly denied: lambda.Function }>;

  for (const vpcId of fixture.networks) {
    const suffix = vpcId.toUpperCase();
    const vpc = new ec2.Vpc(stack, `Vpc${suffix}`, {
      ipAddresses: ec2.IpAddresses.cidr(vpcId === "a" ? "10.70.0.0/16" : "10.71.0.0/16"),
      ipProtocol: ec2.IpProtocol.IPV4_ONLY,
      maxAzs: 2,
      natGateways: 0,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [{ name: "TaskImagePull", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }, { name: "PrivateProbe", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    networks[vpcId] = vpc;
    // Preserve an ordinary shared Lambda group, then add identity only to the
    // granted caller. The identity group does not remove shared egress rules.
    const sharedCallerGroup = new ec2.SecurityGroup(stack, `SharedCaller${suffix}`, { vpc, description: "Fixture shared caller egress", allowAllOutbound: true });
    const admittedCallerGroup = new ec2.SecurityGroup(stack, `AdmittedCaller${suffix}`, { vpc, description: "Fixture caller identity for an explicit ALB grant", allowAllOutbound: false });
    const albGroup = new ec2.SecurityGroup(stack, `AlbGroup${suffix}`, { vpc, description: "Fixture internal HTTP ingress", allowAllOutbound: false });
    albGroup.addIngressRule(admittedCallerGroup, ec2.Port.tcp(80), "Explicit caller to service grant");
    const alb = new elbv2.ApplicationLoadBalancer(stack, `Alb${suffix}`, { vpc, internetFacing: false, ipAddressType: elbv2.IpAddressType.IPV4, securityGroup: albGroup, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, idleTimeout: cdk.Duration.seconds(60) });
    loadBalancers[vpcId] = alb;
    const cluster = new ecs.Cluster(stack, `Cluster${suffix}`, { vpc });
    const endpointId = `alb-${vpcId}`;
    const backend = `const http=require('node:http');http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({fixture:'private-dns-parity',endpointId:${JSON.stringify(endpointId)},method:req.method,path:req.url,hostHeader:req.headers.host,remoteAddress:req.socket.remoteAddress,forwardedFor:req.headers['x-forwarded-for']??null,forwardedPort:req.headers['x-forwarded-port']??null,forwardedProto:req.headers['x-forwarded-proto']??null}));}).listen(5000,'0.0.0.0');`;
    new ecsPatterns.ApplicationLoadBalancedFargateService(stack, `Service${suffix}`, {
      cluster, loadBalancer: alb, openListener: false,
      cpu: 256, memoryLimitMiB: 512, desiredCount: 1,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC }, assignPublicIp: true,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
      taskImageOptions: {
        // Registry reference only: no Docker build, asset bundling, or image pull
        // happens during synth. Public task subnets are for image-pull startup;
        // the probe and the ALB themselves have no NAT or public route.
        image: ecs.ContainerImage.fromRegistry("public.ecr.aws/docker/library/node:24.22.2-alpine"),
        containerPort: fixture.ports.backend,
        command: ["node", "-e", backend],
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: `parity-${vpcId}`, logGroup: new logs.LogGroup(stack, `ServiceLogs${suffix}`, { retention: logs.RetentionDays.ONE_DAY, removalPolicy: cdk.RemovalPolicy.DESTROY }) }),
      },
      healthCheckGracePeriod: cdk.Duration.seconds(10),
    }).targetGroup.configureHealthCheck({ path: "/health" });

    const makeProbe = (kind: "granted" | "denied") => new lambda.Function(stack, `Probe${suffix}${kind === "granted" ? "Granted" : "Denied"}`, {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: probeArchitecture === "arm64" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(assetDirectory),
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sharedCallerGroup, ...(kind === "granted" ? [admittedCallerGroup] : [])],
      environment: { PRIVATE_DNS_PARITY_OWNER: PARITY_FIXTURE_OWNER, PRIVATE_DNS_PARITY_PROBE_SHA256: probeHash },
      loggingFormat: lambda.LoggingFormat.JSON,
      logGroup: new logs.LogGroup(stack, `ProbeLogs${suffix}${kind}`, { retention: logs.RetentionDays.ONE_DAY, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    functions[vpcId] = { granted: makeProbe("granted"), denied: makeProbe("denied") };
    new cdk.CfnOutput(stack, `AlbDns${suffix}`, { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(stack, `GrantedProbe${suffix}`, { value: functions[vpcId].granted.functionName });
    new cdk.CfnOutput(stack, `DeniedProbe${suffix}`, { value: functions[vpcId].denied.functionName });
  }
  const outsideProbe = new lambda.Function(stack, "ProbeOutsideVpc", {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: probeArchitecture === "arm64" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
    handler: "index.handler", code: lambda.Code.fromAsset(assetDirectory),
    timeout: cdk.Duration.seconds(120), memorySize: 256,
    environment: { PRIVATE_DNS_PARITY_OWNER: PARITY_FIXTURE_OWNER, PRIVATE_DNS_PARITY_PROBE_SHA256: probeHash },
    loggingFormat: lambda.LoggingFormat.JSON,
    logGroup: new logs.LogGroup(stack, "ProbeLogsOutsideVpc", { retention: logs.RetentionDays.ONE_DAY, removalPolicy: cdk.RemovalPolicy.DESTROY }),
  });
  new cdk.CfnOutput(stack, "OutsideProbe", { value: outsideProbe.functionName });
  for (const zone of fixture.zones) {
    const [firstVpc, ...additionalVpcs] = zone.associations;
    if (!firstVpc) throw new Error(`Fixture zone ${zone.id} requires at least one VPC association.`);
    const hostedZone = new route53.PrivateHostedZone(stack, `Zone-${zone.id}`, { zoneName: zone.name, vpc: networks[firstVpc], comment: "Disposable Phase 0 DNS characterization specimen" });
    for (const vpcId of additionalVpcs) hostedZone.addVpc(networks[vpcId]);
    for (const [index, record] of zone.records.entries()) {
      const endpointVpc = record.endpoint === "alb-a" ? "a" : "b";
      new route53.ARecord(stack, `Record-${zone.id}-${index}`, { zone: hostedZone, recordName: record.name, target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancers[endpointVpc], { evaluateTargetHealth: false })), comment: `Fixture endpoint ${record.endpoint}` });
    }
  }
  new cdk.CfnOutput(stack, "ProbeSourceSha256", { value: probeHash });
  return { app, stack, fixture, functions, outsideProbe, loadBalancers, probeHash, assetDirectory };
}

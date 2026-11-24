import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type { Construct } from "constructs";
import { createTargetAvailability, getFrameworkTargets, privateRecordName, type FrameworkConfig, type FrameworkPrivateHostedZone, type DeployLane } from "aws-studio/config";
import { frameworkVpc } from "./framework-network";
import { FrameworkTargetRegistry } from "./framework-target-registry";
import { markInfrastructure } from "./framework-inventory";

export function assertPrivateDnsDeployment(config: FrameworkConfig, inputs?: DeployLane): void {
  const availability = createTargetAvailability(config);
  const all = getFrameworkTargets(config);
  for (const zone of config.privateHostedZones ?? []) if (zone.enabled) for (const record of zone.records) if (record.enabled !== false) {
    if (!availability.deployed("service", record.target.service, "prod", { inputs })) throw new Error(`Private zone ${zone.id}, record ${record.id}: service:${record.target.service} is not deployed in this production scope. Disable the record or enable the service.`);
    for (const caller of record.allowFrom ?? []) {
      const target = all.find(target => target.reference === caller);
      if (!target || !availability.deployed(target.kind, target.id, "prod", { inputs })) throw new Error(`Private zone ${zone.id}, record ${record.id}: caller ${caller} is not deployed in this production scope.`);
    }
  }
}

/** One owned zone and its records share a stack. The stack depends on VPCs and
 * endpoint producers; neither endpoint nor network stacks depend on DNS. */
export class PrivateHostedZoneStack extends cdk.Stack {
  public readonly zone: route53.PrivateHostedZone;
  constructor(scope: Construct, id: string, props: cdk.StackProps & { readonly declaration: FrameworkPrivateHostedZone; readonly targets: FrameworkTargetRegistry }) {
    super(scope, id, props);
    const declaration = props.declaration;
    const [first, ...additional] = declaration.vpcs;
    if (!first) throw new Error("A private hosted zone requires at least one VPC.");
    this.zone = new route53.PrivateHostedZone(this, "Zone", { zoneName: declaration.name, vpc: frameworkVpc(this, first), comment: `Framework private zone ${declaration.id}` });
    for (const vpc of additional) this.zone.addVpc(frameworkVpc(this, vpc));
    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    markInfrastructure(this, `private-zone:${declaration.id}`, "supporting");
    markInfrastructure(this.zone, `private-zone:${declaration.id}`);
    for (const record of declaration.records) if (record.enabled !== false) {
      const service = props.targets.requireService(`service:${record.target.service}`);
      if (!service.listener) throw new Error(`Private DNS ${declaration.id}/${record.id} requires an internal ALB endpoint, not a public URL.`);
      const alias = new route53.ARecord(this, `Record-${record.id}`, { zone: this.zone, recordName: `${privateRecordName(declaration.name, record.name)}.`, target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(service.listener.loadBalancer, { evaluateTargetHealth: false })) });
      markInfrastructure(alias, `private-zone:${declaration.id}`, "supporting");
    }
    new cdk.CfnOutput(this, "HostedZoneId", { value: this.zone.hostedZoneId, exportName: `${this.stackName}:HostedZoneId` });
  }
}

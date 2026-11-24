import type { DeployLane } from "aws-studio/config";
import { networkConstructId, privateDnsRecordsForService, getFrameworkTargets } from "aws-studio/config";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as path from "path";
import { FrameworkTargetRegistry } from "./framework-target-registry";
import { markInfrastructure } from "./framework-inventory";
import { containerPlacement, frameworkVpc, networkSubnets, privateDnsApiLinkGroup, privateDnsCallerGroup } from "./framework-network";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {
  attachContainerResources,
  emitCloudOutputs,
  type CloudBuildContext,
} from "./framework-cloud";
import {
  getCloudTargets,
  isSourcedTarget,
  resolveServiceTarget,
  type ContainerArchitecture,
  type FrameworkConfig,
  type NormalizedTarget,
} from "aws-studio/config";
import {
  findDockerfile,
  frameworkRepositoryRoot,
  readDockerfileStages,
  resolveFrameworkDirectory,
  resolveServicePort,
} from "aws-studio/config/source";

export interface EcsServicesStackProps extends cdk.StackProps {
  readonly config: FrameworkConfig;
  /** Which CDK graph this is. */
  readonly cloud: { readonly mode: "dev" | "prod"; readonly inputs?: DeployLane };
  /**
   * The targets to build, when the composition factory has already selected
   * and validated them. Omitted, the same selection is derived from the config
   * here, which is what a fixture constructing this stack directly does.
   */
  readonly targets?: readonly NormalizedTarget[];
}


function taskArchitecture(architecture: ContainerArchitecture): ecs.CpuArchitecture {
  return architecture === "arm64"
    ? ecs.CpuArchitecture.ARM64
    : ecs.CpuArchitecture.X86_64;
}

function imagePlatform(architecture: ContainerArchitecture): ecrAssets.Platform {
  return architecture === "arm64"
    ? ecrAssets.Platform.LINUX_ARM64
    : ecrAssets.Platform.LINUX_AMD64;
}

/**
 * Container services on Fargate, built from their declarations.
 *
 * framework.config.ts decides *which* services reach the cloud — declare fifty
 * and enable three — and how each one is sized, networked and configured. This
 * stack owns the shared VPC and cluster and one generic factory: a second
 * service using the same pattern is a config entry and an implementation, with
 * no builder to register here.
 */
export class EcsServicesStack extends cdk.Stack {
  public readonly targets = new FrameworkTargetRegistry();

  constructor(scope: Construct, id: string, props: EcsServicesStackProps) {
    super(scope, id, props);

    // Each service is independently toggleable from framework.config.ts. The
    // app skips this whole stack when no service is cloud-enabled, and this
    // guard keeps the VPC lookup below out of an empty stack either way.
    const services =
      props.targets ?? getCloudTargets(props.config, ["service"], props.cloud.mode, { inputs: props.cloud.inputs });
    if (services.length === 0) {
      return;
    }

    const context: CloudBuildContext = {
      config: props.config,
      mode: props.cloud.mode,
    };

    const clusters = new Map<string, ecs.Cluster>();
    for (const target of services) {
      const network = target.vpc!;
      let cluster = clusters.get(network.id);
      if (!cluster) {
        cluster = new ecs.Cluster(this, networkConstructId(network, "EcsCluster"), { vpc: frameworkVpc(this, network) });
        markInfrastructure(cluster, `island:vpc:${network.id}`, "supporting");
        clusters.set(network.id, cluster);
      }
      this.addService(cluster, target, context);
    }
  }

  /**
   * One load-balanced Fargate service, from one declaration.
   *
   * The load balancer is internal unless the declaration says otherwise: the
   * HTTP API reaches it over a VPC link, so the route's authorizer is the only
   * way in and the token never crosses the internet unencrypted. Configuration
   * refuses `auth: true` on a service with a public load balancer.
   */
  private addService(
    cluster: ecs.Cluster,
    target: NormalizedTarget,
    context: CloudBuildContext,
  ): void {
    const settings = target.cloud.service;
    if (!settings) {
      throw new Error(
        `Framework target "${target.reference}" is not a service declaration.`,
      );
    }

    // One port policy for both sides: the container listens on the number the
    // config resolves, and local Compose generation reads the same resolver.
    const containerPort = resolveServicePort(context.config, target.id, {
      repositoryRoot: frameworkRepositoryRoot(),
    });

    // An internal load balancer sits in the private subnets, where the HTTP
    // API's VPC link reaches it; a public one goes in the public subnets.
    const placement = containerPlacement(this, target, settings.subnet);
    const privateRecords = privateDnsRecordsForService(context.config, target.id);
    const loadBalancer = settings.publicLoadBalancer
      ? undefined
      : new elbv2.ApplicationLoadBalancer(this, `${target.cloud.constructId}InternalLoadBalancer`, {
          vpc: cluster.vpc,
          internetFacing: false,
          vpcSubnets: networkSubnets("private"),
        });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      target.cloud.constructId,
      {
        cluster,
        cpu: settings.cpu,
        memoryLimitMiB: settings.memoryMiB,
        desiredCount: settings.desiredCount,
        ...(privateRecords.length ? { openListener: false } : {}),
        propagateTags: ecs.PropagatedTagSource.SERVICE,
        ...(loadBalancer ? { loadBalancer } : { publicLoadBalancer: true }),
        taskSubnets: placement.subnets,
        assignPublicIp: placement.assignPublicIp,
        runtimePlatform: {
          cpuArchitecture: taskArchitecture(settings.architecture),
        },
        taskImageOptions: {
          image: this.serviceImage(target, settings),
          containerPort,
          environment: {
            // Lambda is told its region; a task is not, and the container's
            // port has one owner. Both are the framework's to set, which is
            // why a declaration may not name them.
            AWS_REGION: cdk.Stack.of(this).region,
            PORT: String(containerPort),
          },
        },
      },
    );

    markInfrastructure(service, `service:${target.id}`, "supporting");
    markInfrastructure(loadBalancer, `service:${target.id}`, "supporting");
    markInfrastructure(service.service, `service:${target.id}`);
    if (privateRecords.length) {
      const apiLink = privateDnsApiLinkGroup(this, target.vpc!);
      if (apiLink) service.listener.connections.allowFrom(apiLink, ec2.Port.tcp(80), "API Gateway private service route");
      const targets = getFrameworkTargets(context.config);
      for (const caller of new Set(privateRecords.flatMap(record => record.allowFrom ?? []))) {
        const from = targets.find(target => target.reference === caller);
        if (!from) throw new Error(`Private DNS caller ${caller} is not declared.`);
        service.listener.connections.allowFrom(privateDnsCallerGroup(this, from), ec2.Port.tcp(80), `Explicit private endpoint grant for ${caller}`);
      }
    }

    // A service with no `/` route — which is what the pattern health-checks by
    // default — would flap unhealthy and recycle its tasks.
    const healthCheckPath = resolveServiceTarget(
      context.config,
      target.id,
    ).healthCheckPath;
    if (healthCheckPath) {
      service.targetGroup.configureHealthCheck({ path: healthCheckPath });
    }

    // The task role is otherwise empty, so anything the container calls has to
    // be declared. `secrets` above is read by the *execution* role instead:
    // AWS separates what starts a task from what the application then does.
    // The groups of what the service connects to join its network
    // configuration directly. Adding them to the service's connections would
    // let the load balancer's ingress rule reach every other member of those
    // shared groups.
    if (placement.connectionGroups.length > 0 || placement.identityGroups?.length) {
      const ownGroups = service.service.connections.securityGroups.map((group) => group.securityGroupId);
      (service.service.node.defaultChild as ecs.CfnService).addPropertyOverride(
        "NetworkConfiguration.AwsvpcConfiguration.SecurityGroups",
        [...ownGroups, ...placement.connectionGroups.map((group) => group.securityGroupId), ...(placement.identityGroups ?? []).map(group => group.securityGroupId)],
      );
    }

    attachContainerResources(this, service.taskDefinition.defaultContainer!, service.taskDefinition.taskRole, target, context);

    const url = this.targets.service(
      target.id,
      `http://${service.loadBalancer.loadBalancerDnsName}`,
      loadBalancer ? service.listener : undefined,
    );
    emitCloudOutputs(this, target, { url });
  }

  /**
   * The service's image, built from its own Dockerfile.
   *
   * The build context is the repository root because the Dockerfile copies the
   * whole monorepo and installs from the root lockfile so npm workspaces can
   * resolve `@repo/*` packages. Pointing it at the service directory instead
   * breaks every `--workspace` line.
   */
  private serviceImage(
    target: NormalizedTarget,
    settings: NonNullable<NormalizedTarget["cloud"]["service"]>,
  ): ecs.ContainerImage {
    if (!isSourcedTarget(target)) {
      throw new Error(
        `Framework target "${target.reference}" has no source directory to build.`,
      );
    }
    const repositoryRoot = frameworkRepositoryRoot();
    const directory = resolveFrameworkDirectory(target.directory, target.reference, { repositoryRoot });
    const dockerfile = findDockerfile(directory);
    if (!dockerfile) {
      throw new Error(
        `Service "${target.id}" is cloud-enabled, but ${directory} has no Dockerfile.`,
      );
    }
    if (settings.buildTarget) {
      const stages = readDockerfileStages(dockerfile);
      if (!stages.includes(settings.buildTarget)) {
        throw new Error(
          `Service "${target.id}" declares cloud.buildTarget "${settings.buildTarget}", which ${dockerfile} does not define. It has ${stages.length > 0 ? stages.join(", ") : "no named stages"}.`,
        );
      }
    }

    return ecs.ContainerImage.fromAsset(repositoryRoot, {
      // Relative to the build context above, and derived from the declared
      // directory so moving the service moves its Dockerfile.
      file: path.relative(repositoryRoot, dockerfile),
      ...(settings.buildTarget ? { target: settings.buildTarget } : {}),
      // The image always matches the resolved task runtime, independent of host.
      platform: imagePlatform(settings.architecture),
    });
  }


}

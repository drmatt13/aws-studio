import type { IUserPool } from "aws-cdk-lib/aws-cognito";

/**
 * Stateful references: the offline contracts a deployment uses to reference an existing database or
 * Cognito user pool without taking CloudFormation ownership of it. Deploy, teardown and Studio all
 * validate references with these, for whichever project they serve.
 */

/** Public, non-secret deployment evidence for explicitly referencing retained PostgreSQL. */
export interface RetainedDatabaseNetwork {
  readonly vpcId: string;
  readonly vpcCidrBlock: string;
  readonly availabilityZones: readonly string[];
  readonly publicSubnetIds: readonly string[];
  readonly privateSubnetIds: readonly string[];
  readonly isolatedSubnetIds: readonly string[];
  readonly publicSubnetRouteTableIds: readonly string[];
  readonly privateSubnetRouteTableIds: readonly string[];
  readonly isolatedSubnetRouteTableIds: readonly string[];
}

/** A reference grants no CloudFormation ownership of the database or its existing network. */
export interface DatabaseReference {
  readonly strategy: "reference";
  readonly account: string;
  readonly region: string;
  readonly sourceDeployment: string;
  readonly sourceMode: "prod";
  readonly sourceStackId: string;
  readonly instanceIdentifier: string;
  /** Required for a narrow rds-db:connect grant; the display identifier cannot replace it. */
  readonly instanceResourceId: string;
  readonly endpoint: string;
  readonly port: number;
  readonly databaseName: string;
  readonly engine: "postgres";
  readonly engineVersion: string;
  readonly iamAuthentication: true;
  readonly storageEncrypted: true;
  readonly kmsKeyArn: string;
  /** Identity only. Reference mode never fetches or emits its contents. */
  readonly masterSecretArn: string;
  readonly securityGroupIds: readonly string[];
  readonly iamLogin: "app_user";
  readonly network: RetainedDatabaseNetwork;
}

const id = (value: unknown, expression: RegExp, name: string): void => {
  if (typeof value !== "string" || !expression.test(value)) throw new Error(`Retained database ${name} is missing or invalid. Reinspect the selected physical resource.`);
};

/** Offline structural checks supplement, never replace, current AWS inspection at deployment review. */
export function assertDatabaseReference(value: unknown, destination?: { readonly account: string; readonly region: string; readonly mode?: string }): asserts value is DatabaseReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Retained database reference must be an explicit inspected resource object.");
  const reference = value as DatabaseReference;
  const fields = new Set(["strategy", "account", "region", "sourceDeployment", "sourceMode", "sourceStackId", "instanceIdentifier", "instanceResourceId", "endpoint", "port", "databaseName", "engine", "engineVersion", "iamAuthentication", "storageEncrypted", "kmsKeyArn", "masterSecretArn", "securityGroupIds", "iamLogin", "network"]);
  if (Object.keys(value).some(field => !fields.has(field))) throw new Error("Retained database reference contains unsupported fields. Use the inspected non-secret identity descriptor; credentials never belong in source.");
  if (reference.strategy !== "reference") throw new Error("Database recovery supports explicit reference only; CloudFormation import and snapshot restore are separate operations.");
  id(reference.account, /^\d{12}$/, "account");
  id(reference.region, /^[a-z]{2}(?:-[a-z]+)+-\d$/, "region");
  if (destination && (reference.account !== destination.account || reference.region !== destination.region || destination.mode === "dev")) throw new Error("Retained RDS reference must use its original account and region in a production-mode deployment. Development uses the independent Compose database.");
  id(reference.sourceDeployment, /^[A-Za-z][A-Za-z0-9-]{0,127}$/, "source deployment");
  if (reference.sourceMode !== "prod") throw new Error("A retained RDS reference requires production-mode ownership evidence.");
  id(reference.sourceStackId, new RegExp(`^arn:(?:aws|aws-us-gov|aws-cn):cloudformation:${reference.region}:${reference.account}:stack/[A-Za-z][A-Za-z0-9-]*/[A-Za-z0-9-]+$`), "source StackId");
  id(reference.instanceIdentifier, /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/, "instance identifier");
  id(reference.instanceResourceId, /^db-[A-Za-z0-9]+$/, "immutable resource ID");
  id(reference.endpoint, /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.rds\.amazonaws\.com(?:\.cn)?$/, "endpoint");
  if (!reference.endpoint.includes(`.${reference.region}.`)) throw new Error("Retained database endpoint does not match its selected region.");
  if (!Number.isInteger(reference.port) || reference.port < 1 || reference.port > 65535) throw new Error("Retained database port must be between 1 and 65535.");
  id(reference.databaseName, /^[A-Za-z][A-Za-z0-9_]{0,62}$/, "database name");
  if (reference.engine !== "postgres" || !/^\d+(?:\.\d+)*$/.test(reference.engineVersion)) throw new Error("Retained database must be an RDS PostgreSQL instance with an explicit engine version; clusters are unsupported.");
  if (reference.iamAuthentication !== true || reference.iamLogin !== "app_user") throw new Error("Retained database requires IAM authentication and the existing app_user login. Reconnection never creates or repairs SQL identities.");
  if (reference.storageEncrypted !== true) throw new Error("Retained database must be encrypted at rest.");
  id(reference.kmsKeyArn, new RegExp(`^arn:(?:aws|aws-us-gov|aws-cn):kms:${reference.region}:${reference.account}:key/[A-Za-z0-9-]+$`), "KMS key ARN");
  id(reference.masterSecretArn, new RegExp(`^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:${reference.region}:${reference.account}:secret:[A-Za-z0-9/_+=.@-]+$`), "master secret ARN");
  if (!Array.isArray(reference.securityGroupIds) || reference.securityGroupIds.length === 0 || new Set(reference.securityGroupIds).size !== reference.securityGroupIds.length) throw new Error("Retained database requires its distinct existing security group IDs.");
  for (const group of reference.securityGroupIds) id(group, /^sg-[a-f0-9]+$/, "security group ID");
  assertRetainedDatabaseNetwork(reference.network);
}

export function assertRetainedDatabaseNetwork(value: unknown): asserts value is RetainedDatabaseNetwork {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Retained database VPC/subnet evidence is required; a new VPC cannot reconnect to an isolated retained instance.");
  const network = value as RetainedDatabaseNetwork;
  const fields = new Set(["vpcId", "vpcCidrBlock", "availabilityZones", "publicSubnetIds", "privateSubnetIds", "isolatedSubnetIds", "publicSubnetRouteTableIds", "privateSubnetRouteTableIds", "isolatedSubnetRouteTableIds"]);
  if (Object.keys(value).some(field => !fields.has(field))) throw new Error("Retained database network contains unsupported fields. Reinspect the original VPC.");
  id(network.vpcId, /^vpc-[a-f0-9]+$/, "VPC ID");
  id(network.vpcCidrBlock, /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, "VPC CIDR");
  const [address, prefix] = network.vpcCidrBlock.split("/");
  if (address!.split(".").some(part => Number(part) > 255) || Number(prefix) < 16 || Number(prefix) > 28) throw new Error("Retained database VPC CIDR must be an inspected IPv4 VPC range with a /16 to /28 prefix.");
  if (!Array.isArray(network.availabilityZones) || network.availabilityZones.length < 2 || new Set(network.availabilityZones).size !== network.availabilityZones.length || network.availabilityZones.some(zone => typeof zone !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d[a-z]$/.test(zone))) throw new Error("Retained database VPC requires at least two distinct, inspected availability zones.");
  const seen = new Set<string>();
  for (const tier of ["public", "private", "isolated"] as const) {
    const subnets = network[`${tier}SubnetIds`];
    const routes = network[`${tier}SubnetRouteTableIds`];
    if (!Array.isArray(subnets) || !Array.isArray(routes) || subnets.length !== network.availabilityZones.length || routes.length !== subnets.length) throw new Error(`Retained database ${tier} subnet and route-table IDs must match availability zones in the same order.`);
    for (const subnet of subnets) {
      id(subnet, /^subnet-[a-f0-9]+$/, `${tier} subnet ID`);
      if (seen.has(subnet)) throw new Error("Retained database subnet IDs cannot appear in multiple tiers or availability zones.");
      seen.add(subnet);
    }
    for (const route of routes) id(route, /^rtb-[a-f0-9]+$/, `${tier} route-table ID`);
  }
}


/**
 * Reference existing identities without transferring CloudFormation ownership.
 * The client and domain must already exist on the selected pool. No credentials
 * or provider secrets belong in this declaration.
 */
export interface CognitoReference {
  readonly account: string;
  readonly region: string;
  readonly originalDeployment: string;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly userPoolDomainUrl: string;
  readonly userPoolDomainCloudFrontEndpoint?: string;
}

/** Static validation is offline; availability, ownership and auth settings need live inspection. */
export function validateCognitoReference(reference: CognitoReference, target: { readonly account: string; readonly region: string }): void {
  const required = ["account", "region", "originalDeployment", "userPoolId", "userPoolClientId", "userPoolDomainUrl"] as const;
  const allowed: readonly string[] = [...required, "userPoolDomainCloudFrontEndpoint"];
  if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.keys(reference).some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(reference, key) || typeof reference[key] !== "string") || (reference.userPoolDomainCloudFrontEndpoint !== undefined && typeof reference.userPoolDomainCloudFrontEndpoint !== "string")) {
    throw new Error("Cognito reference must contain only the required public identity fields and optional observed CloudFront endpoint. Missing fields, credentials, secrets and unknown fields are refused.");
  }
  if (!/^\d{12}$/.test(reference.account) || reference.account !== target.account) {
    throw new Error("Cognito reference account must match the explicit deployment account. Cross-account pool reuse is unsupported.");
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(reference.region) || reference.region !== target.region) {
    throw new Error("Cognito reference region must match the deployment region. Cross-region pool reuse is unsupported.");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(reference.originalDeployment)) {
    throw new Error("Cognito reference originalDeployment must identify the verified original framework deployment.");
  }
  const poolPrefix = `${reference.region}_`;
  if (!reference.userPoolId.startsWith(poolPrefix) || !/^[A-Za-z0-9]+$/.test(reference.userPoolId.slice(poolPrefix.length)) || reference.userPoolId.length > 55) {
    throw new Error("Cognito reference userPoolId must be a literal pool ID in the selected region.");
  }
  if (!/^[a-z0-9]{1,128}$/.test(reference.userPoolClientId)) {
    throw new Error("Cognito reference userPoolClientId must identify one existing public app client, without a secret.");
  }
  let domain: URL;
  try { domain = new URL(reference.userPoolDomainUrl); }
  catch { throw new Error("Cognito reference userPoolDomainUrl must be the existing pool's HTTPS domain origin."); }
  if (domain.protocol !== "https:" || domain.username || domain.password || domain.search || domain.hash || domain.port || domain.pathname !== "/" || /^(localhost|.*\.localhost|.*\.local|\[.*\]|[\d.]+)$/.test(domain.hostname) || !domain.hostname.includes(".") || reference.userPoolDomainUrl.endsWith("/")) {
    throw new Error("Cognito reference userPoolDomainUrl must be a public HTTPS domain origin without a path, port, credentials or trailing slash.");
  }
  if (reference.userPoolDomainCloudFrontEndpoint !== undefined && !/^[a-z0-9-]+\.cloudfront\.net$/.test(reference.userPoolDomainCloudFrontEndpoint)) {
    throw new Error("Cognito reference userPoolDomainCloudFrontEndpoint must be the observed CloudFront hostname, without a URL or path.");
  }
}

// Mark only the framework's explicitly selected external references. Native
// applications using their own imported constructs retain their existing API.
const externalPools = new WeakSet<IUserPool>();
export function markExternalCognitoReference(pool: IUserPool): void { externalPools.add(pool); }
export function isExternalCognitoReference(pool: IUserPool): boolean { return externalPools.has(pool); }

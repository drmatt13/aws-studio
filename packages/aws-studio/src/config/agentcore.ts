/**
 * AgentCore agents, Gateway APIs and Lambda tools, as three ordinary sections.
 *
 * A tool is a Lambda a Gateway invokes. An agent is an application AgentCore
 * Runtime hosts. Explicit Gateways own their tools; an agent selects the
 * Gateways it can invoke. IAM enforces those gateway boundaries.
 *
 * A tool's arguments, result and description live beside its handler in
 * `contract.ts`, as an HTTP payload contract does; this module only says what
 * exists, who may call it, and where it runs.
 */
import type {
  AnyResourceCatalog,
  DeploySetting,
  FrameworkConfig,
  FrameworkDirectory,
  HttpCloudSettings,
  LambdaTargetDefinition,
  NodeLambdaRuntime,
  SuggestedLambdaDirectory,
  TargetEnvironment,
  CloudMode,
  DeployLane,
  DeclarationTags,
} from "./index";
import { getDefaultConstructId } from "./index";
import { defaultComputeDirectory, TOOL_SOURCE_ROOT } from "./conventions";
import { isDeploySettingEnabled, assertDeploySetting, deployKey, deployFits } from "./deploy";
import { validateTags, validateManagedBy, type ManagedBy } from "./tags";
import { COGNITO_VERIFIER_ENVIRONMENT, USER_POOL_DECLARATION_EXAMPLE, userPoolDelivery } from "./user-pool";
import { LAMBDA_SOURCE_DIRECTORY_BY_ID } from "@repo/framework-generated/target-ids";
import type { ToolLambdaId } from "@repo/framework-generated/target-ids";

/** The committed projection of every tool contract: what each Gateway target registers in AWS. */
export { AGENTCORE_AGENTS, AGENTCORE_TOOLS } from "@repo/framework-generated/agentcore";
export { gatewayInputSchema, type GatewaySchema, type GatewayToolEntry, type GatewayToolManifest } from "../protocol/tool-schema";

/** Tool ids autocomplete; a tool added in the same edit as its agent is still accepted. */
export type SuggestedToolId = ToolLambdaId | (string & {});
export type SuggestedGatewayId = string;

export interface AgentCoreGatewayDefinition {
  readonly tools?: readonly SuggestedToolId[];
  readonly deploy?: DeploySetting;
  readonly cloud?: { readonly constructId?: string };
  readonly tags?: DeclarationTags;
  /** "framework" keeps AWS Studio from changing this declaration; absent means developer managed. */
  readonly managedBy?: ManagedBy;
}
export type FrameworkGateways = Readonly<Record<string, AgentCoreGatewayDefinition>>;
export interface NormalizedGateway {
  readonly id: string;
  readonly tools: readonly string[];
  readonly deploy: DeploySetting;
  readonly cloud: { readonly constructId: string };
  readonly tags: DeclarationTags;
  readonly managedBy?: ManagedBy;
}

export function getGatewayDeploySetting(config: FrameworkConfig, id: string): DeploySetting {
  return config.gateways?.[id]?.deploy ?? "both";
}

/** Gateways are APIs, not executable workload targets. */
export function getGateways(config: FrameworkConfig): readonly NormalizedGateway[] {
  return Object.entries(config.gateways ?? {}).map(([id, gateway]) => ({
    id, tools: gateway.tools ?? [], deploy: getGatewayDeploySetting(config, id),
    cloud: { constructId: gateway.cloud?.constructId ?? getDefaultConstructId(id) },
    tags: gateway.tags ?? {},
    ...(gateway.managedBy === undefined ? {} : { managedBy: gateway.managedBy }),
  }));
}
export function getCloudGateways(config: FrameworkConfig, mode: CloudMode, inputs?: DeployLane): readonly NormalizedGateway[] {
  return mode === "dev" ? [] : getGateways(config).filter(gateway => isDeploySettingEnabled(gateway.deploy, "cloud", inputs, `gateways["${gateway.id}"]`));
}
export function getLocalGateways(config: FrameworkConfig, inputs?: DeployLane): readonly NormalizedGateway[] {
  return getGateways(config).filter(gateway => isDeploySettingEnabled(gateway.deploy, "local", inputs, `gateways["${gateway.id}"]`));
}
export function getAgentGateways(config: FrameworkConfig, agentId: string): readonly NormalizedGateway[] {
  const agent = config.agents?.[agentId];
  if (!agent) throw new Error(`agent:${agentId} is not declared under agents.`);
  const gateways = new Map(getGateways(config).map(gateway => [gateway.id, gateway]));
  return (agent.gateways ?? []).map(id => {
    const gateway = gateways.get(id);
    if (!gateway) throw new Error(`agents["${agentId}"] gateways("${id}") is not declared under gateways.`);
    return gateway;
  });
}

/** Build settings for the Node ZIP Lambdas supported by tool() and authenticatedTool(). */
export interface ToolLambdaTargetDefinition extends Omit<LambdaTargetDefinition, "runtime" | "packaging"> {
  /** A tool contract is executed by the framework's Node runtime adapter. */
  readonly runtime?: NodeLambdaRuntime;
  /** Tools are bundled Node handlers; container packaging is not supported. */
  readonly packaging?: "zip";
}

/** A Lambda an agent calls through its Gateway. */
export type ToolTargetDefinition<Catalog = AnyResourceCatalog> = ToolLambdaTargetDefinition &
  TargetEnvironment<Catalog> & {
    /** Defaults to `compute/tools/<id>`. */
    readonly directory?: SuggestedLambdaDirectory;
    /**
     * The tool acts as the signed-in user. Its handler is written with
     * `authenticatedTool`, which verifies the user's Cognito token itself — the
     * model never sees the token and cannot supply one.
     */
    readonly auth?: true;
    /** Overrides the default union of consuming agents' deployment lanes. */
    readonly deploy?: DeploySetting;
    readonly cloud?: HttpCloudSettings<Catalog>;
  };

/** AgentCore deployment settings and the session lifecycle applied in both execution lanes. */
export interface AgentCloudSettings<Catalog = AnyResourceCatalog>
  extends HttpCloudSettings<Catalog> {
  /** Seconds an idle session keeps its microVM, 60 to 28800. Both lanes honour it. */
  readonly idleSeconds?: number;
  /** Seconds a session may live at all, 60 to 28800. Both lanes honour it. */
  readonly maxLifetimeSeconds?: number;
}

/** An agent: an application AgentCore Runtime hosts, and the tools it may call. */
export type AgentTargetDefinition<Catalog = AnyResourceCatalog> = Omit<TargetEnvironment<Catalog>, "database"> & {
  /** Agents run outside the application VPC; put database access on a declared tool. */
  readonly database?: never;
  /** Defaults to `compute/agents/<id>`, relative to the repository. */
  readonly directory?: FrameworkDirectory;
  /**
   * Calls use the user's Cognito session. A declared `route` exposes it to
   * the browser. AgentCore checks the token before the agent runs, and
   * the agent checks it again — as an `auth: true` route and `authenticated`
   * handler do.
   */
  readonly auth?: true;
  /** Full same-origin browser path, e.g. `/chat/support`. No prefix is added.
   * Requires auth: true. Omit it for workload-only invocation. */
  readonly route?: `/${string}`;
  /** Every selected Gateway's tools are available to this agent. Order chooses a route for shared tools. */
  readonly gateways?: readonly SuggestedGatewayId[];
  readonly deploy?: DeploySetting;
  readonly cloud?: AgentCloudSettings<Catalog>;
};

export type FrameworkTools<Catalog = AnyResourceCatalog> = Readonly<
  Record<string, ToolTargetDefinition<Catalog>>
>;
export type FrameworkAgents<Catalog = AnyResourceCatalog> = Readonly<
  Record<string, AgentTargetDefinition<Catalog>>
>;

/** One tool and the selected Gateway that exposes it. */
export interface AgentTool {
  readonly id: string;
  readonly gatewayId: string;
  readonly auth: boolean;
  /**
   * The name on the wire. Gateway prefixes every tool with its target's name,
   * and a tool is its own target, so this is `<id>___<id>`. Agent code never
   * spells it: the runtime maps ids to wire names in both directions.
   */
  readonly wireName: string;
}

/** Explicit browser routes; workload identity and source directory stay independent. */
export function getAgentBrowserRoutes(config: FrameworkConfig): readonly { readonly id: string; readonly path: string }[] {
  return Object.entries(config.agents ?? {})
    .filter(([, agent]) => agent.auth === true && agent.route !== undefined)
    .map(([id, agent]) => ({ id, path: agent.route! }));
}

export const AGENT_LIFECYCLE_BOUNDS = { min: 60, max: 28_800 } as const;

/** AgentCore's own defaults, used locally when an agent declares none. */
export const AGENT_LIFECYCLE_DEFAULTS = { idleSeconds: 900, maxLifetimeSeconds: 28_800 } as const;

/**
 * Where a `tools` entry that declares no `directory` lives. A handler filed
 * anywhere under the tool grouping is found by its id, as an event's is.
 */
export function getDefaultToolDirectory(id: string): FrameworkDirectory {
  const filed = (LAMBDA_SOURCE_DIRECTORY_BY_ID as Readonly<Record<string, string | undefined>>)[id];
  return filed?.startsWith(`${TOOL_SOURCE_ROOT}/`)
    ? (filed as FrameworkDirectory)
    : defaultComputeDirectory("tool", id);
}

export function getDefaultAgentDirectory(id: string): FrameworkDirectory {
  return defaultComputeDirectory("agent", id);
}

/** Internal deployment projection: shared tools run in every consuming Gateway's lane. */
export function getToolDeploySetting(config: FrameworkConfig, toolId: string): DeploySetting {
  return config.tools?.[toolId]?.deploy ?? getInheritedToolDeploySetting(config, toolId);
}

/** Default policy when a tool has no authored override. */
export function getInheritedToolDeploySetting(config: FrameworkConfig, toolId: string): DeploySetting {
  const consumers = Object.values(config.gateways ?? {}).filter(gateway => gateway.tools?.includes(toolId));
  const first = consumers[0]?.deploy ?? "both";
  if (typeof first !== "string" && consumers.every(gateway => deployKey(gateway.deploy ?? "both") === deployKey(first))) return first;
  let cloud = false;
  let local = false;
  for (const gateway of consumers) {
    const deploy = gateway.deploy ?? "both";
    cloud ||= isDeploySettingEnabled(deploy, "cloud", "unconditioned");
    local ||= isDeploySettingEnabled(deploy, "local", "unconditioned");
  }
  return cloud ? (local ? "both" : "cloud-only") : (local ? "local-only" : "none");
}

export function getGatewayTools(config: FrameworkConfig, gatewayId: string): readonly AgentTool[] {
  const gateway = config.gateways?.[gatewayId];
  if (!gateway) throw new Error(`gateway:${gatewayId} is not declared under gateways.`);
  return (gateway.tools ?? []).map(id => ({ id, gatewayId, auth: config.tools?.[id]?.auth === true, wireName: `${id}___${id}` }));
}

/** Unique tools in selection order; the first selected Gateway supplies a shared tool's route. */
export function getAgentTools(config: FrameworkConfig, agentId: string): readonly AgentTool[] {
  const tools = new Map<string, AgentTool>();
  for (const gateway of getAgentGateways(config, agentId)) {
    for (const tool of getGatewayTools(config, gateway.id)) if (!tools.has(tool.id)) tools.set(tool.id, tool);
  }
  return [...tools.values()];
}

/** The lifecycle both lanes apply to an agent's sessions. */
export function getAgentLifecycle(
  config: FrameworkConfig,
  agentId: string,
): { readonly idleSeconds: number; readonly maxLifetimeSeconds: number } {
  const cloud = config.agents?.[agentId]?.cloud;
  return {
    idleSeconds: cloud?.idleSeconds ?? AGENT_LIFECYCLE_DEFAULTS.idleSeconds,
    maxLifetimeSeconds: cloud?.maxLifetimeSeconds ?? AGENT_LIFECYCLE_DEFAULTS.maxLifetimeSeconds,
  };
}

/**
 * An `auth: true` tool or agent verifies its caller's token, so it needs the
 * pool: handed over from the config's `userPool`, or declared by the workload
 * itself, both names together.
 */
function assertCognitoInputs(
  config: FrameworkConfig,
  role: "tool" | "agent",
  origin: string,
  declaration: { readonly auth?: true; readonly userPool?: true; readonly environment?: Readonly<Record<string, unknown>> },
): void {
  if (userPoolDelivery(role, declaration, config.userPool) !== undefined) return;
  const missing = COGNITO_VERIFIER_ENVIRONMENT.filter((name) => declaration.environment?.[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      config.userPool === undefined
        ? `${origin} declares auth: true without environment ${missing.join(", ")}. Its token verifier reads them: name the application's pool once in framework.config.ts, as ${USER_POOL_DECLARATION_EXAMPLE}, and every auth: true tool and agent is handed it.`
        : `${origin} declares auth: true without environment ${missing.join(", ")}. Its token verifier reads both: declare both to name a different pool, or neither to be handed the config's userPool.`,
    );
  }
}

function assertLifecycleSeconds(origin: string, name: string, value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < AGENT_LIFECYCLE_BOUNDS.min ||
    value > AGENT_LIFECYCLE_BOUNDS.max
  ) {
    throw new Error(
      `${origin} cloud.${name} must be a whole number from ${AGENT_LIFECYCLE_BOUNDS.min} to ${AGENT_LIFECYCLE_BOUNDS.max}, the range AgentCore Runtime accepts.`,
    );
  }
}

/**
 * Declaration-level rules for tools and agents. Edges — whether a listed tool
 * exists, is a tool, and runs in the agent's lanes — are checked with every
 * other invocation edge, so a cycle through an agent is found like any other.
 */
export function validateAgentCoreConfig(config: FrameworkConfig): void {
  const identities = new Map<string, string>();
  for (const gateway of getGateways(config)) {
    const origin = `gateways["${gateway.id}"]`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gateway.id)) throw new Error(`${origin} must have a kebab-case gateway id.`);
    assertDeploySetting(gateway.deploy, origin);
    validateTags(gateway.tags, origin);
    validateManagedBy(gateway.managedBy, origin);
    if (typeof gateway.cloud.constructId !== "string" || !gateway.cloud.constructId.trim()) throw new Error(`${origin} declares an empty cloud.constructId.`);
    const existing = identities.get(gateway.cloud.constructId);
    if (existing) throw new Error(`${origin} and gateways["${existing}"] both resolve to construct id "${gateway.cloud.constructId}".`);
    identities.set(gateway.cloud.constructId, gateway.id);
    if (new Set(gateway.tools).size !== gateway.tools.length) throw new Error(`${origin} lists a tool twice.`);
    for (const id of gateway.tools) {
      const tool = config.tools?.[id];
      if (!tool) throw new Error(`${origin} tools("${id}") is not declared under tools. A Gateway calls Lambdas declared under tools.`);
      if (!deployFits(gateway.deploy, getToolDeploySetting(config, id))) throw new Error(`${origin} tools("${id}") requires the tool in the same deployment lanes and an identical condition when conditional.`);
    }
  }
  for (const [id, tool] of Object.entries(config.tools ?? {})) {
    const origin = `tools["${id}"]`;
    const packaging = tool.packaging ?? config.defaults.tools?.packaging ?? config.defaults.lambda.packaging;
    const runtime = tool.runtime ?? config.defaults.tools?.runtime ?? config.defaults.lambda.runtime;
    if (packaging !== "zip" || !runtime.startsWith("nodejs")) {
      throw new Error(
        `${origin} must be a Node zip Lambda. Its handler is written with tool() or authenticatedTool(), which validate against its contract in both lanes.`,
      );
    }
    if (tool.auth === true) assertCognitoInputs(config, "tool", origin, tool);
  }

  for (const [id, agent] of Object.entries(config.agents ?? {})) {
    const origin = `agents["${id}"]`;
    if ("tools" in agent) throw new Error(`${origin}.tools has been replaced by gateways. Declare the tools on gateways.<id>.tools and select agents.<id>.gateways.`);
    if (agent.route !== undefined && agent.auth !== true) {
      throw new Error(`${origin}.route requires auth: true. Browser agent routes use the signed-in user's session.`);
    }
    if ("secrets" in agent) {
      throw new Error(
        `${origin} declares secrets. AgentCore Runtime has no startup secret injection; write environment: { NAME: resources.<secret>.arn } and read the secret in the agent, which also grants the read.`,
      );
    }
    if (agent.auth === true) assertCognitoInputs(config, "agent", origin, agent);
    if (Object.prototype.hasOwnProperty.call(agent.environment ?? {}, "PORT")) {
      throw new Error(`${origin} declares environment "PORT", which AgentCore Runtime owns. Remove it.`);
    }

    assertLifecycleSeconds(origin, "idleSeconds", agent.cloud?.idleSeconds);
    assertLifecycleSeconds(origin, "maxLifetimeSeconds", agent.cloud?.maxLifetimeSeconds);
    const lifecycle = getAgentLifecycle(config, id);
    if (lifecycle.maxLifetimeSeconds < lifecycle.idleSeconds) {
      throw new Error(
        `${origin} cloud.maxLifetimeSeconds is shorter than cloud.idleSeconds, so no session could ever go idle.`,
      );
    }

    const listed = agent.gateways ?? [];
    if (new Set(listed).size !== listed.length) {
      throw new Error(`${origin} lists a Gateway twice.`);
    }
    for (const gateway of getAgentGateways(config, id)) {
      if (!deployFits(agent.deploy ?? "both", gateway.deploy)) throw new Error(`${origin} gateways("${gateway.id}") requires the Gateway in the same deployment lanes and an identical condition when conditional.`);
    }
    for (const { id: toolId } of getAgentTools(config, id)) {
      if (config.tools?.[toolId]?.auth === true && agent.auth !== true) {
        throw new Error(
          `${origin} lists tools("${toolId}"), which declares auth: true. Only an agent with auth: true has a signed-in user to act as; add auth: true to the agent, or give the tool service authority.`,
        );
      }
    }
  }
}
